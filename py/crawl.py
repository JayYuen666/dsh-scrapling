"""py/crawl.py —— 爬虫：用 Scrapling 自带的 Spider 框架在后台跑一个站点。

为什么用 Spider 而不是自己写循环：Scrapling 已经实现了并发、限速（AutoThrottle）、
robots.txt 遵守、断点续爬、链接提取与去重 —— 这些我们不想重写一遍。

为什么放到后台：一次爬取是分钟级的，而一次请求-响应撑不了那么久。所以这里**起一个
daemon 线程**跑 spider，主线程立刻返回 crawl id；进度通过「没有 id 的事件帧」推给宿主，
宿主把它接到后台作业的输出环上，模型就能边跑边看，而不是干等一个超时。
"""

from __future__ import annotations

import threading
import uuid
from typing import Any
from urllib.parse import urlparse

from guard import proxies_for, url_allowed

# 正在跑的爬虫：crawl id -> {"thread": Thread, "crawl_id": str, "state": dict}
_CRAWLS: dict[str, dict[str, Any]] = {}

# 同时能跑几个爬虫。爬虫是重量级后台任务且**立刻返回**，因此 bridge 的并发槽位对它无效
# —— 不设上限的话连续几次 crawl.run 就会叠起多个 Spider 线程与 FetcherSession。
MAX_CONCURRENT_CRAWLS = 2

# 登记表最多留几个已结束的爬虫条目。crawl.status 是唯一能读走结果的入口，所以条目不能一
# 结束就删；但全留着就是内存泄漏，所以留一个上限，按最旧的淘汰。
MAX_REMEMBERED_CRAWLS = 16


def _clip_markdown(text: str, budget: int) -> str:
    """把单页正文封顶到 budget 字符。

    ``max_pages`` 限的是**页数**，页内正文长度是另一根轴。一页几 MB 的 HTML 会一路留在
    state 里，而 crawl.status 每次轮询都把它整份序列化回去。

    :param text: 原始正文
    :param budget: 字符上限
    :returns: 封顶后的正文；被截断时带上省略说明
    """
    if budget > 0 and len(text) > budget:
        return text[:budget] + f"\n\n[truncated at {budget} chars]"
    return text


def _emit_event(event: str, **fields: Any) -> None:
    """往 stdout 推一条没有 id 的事件帧。

    stdout 是与宿主的协议通道；事件帧与响应帧走同一条流，靠有没有 ``event`` 字段区分。
    桥接层晚于本模块导入，所以这里在函数体内 import，避免循环依赖。

    :param event: 事件名
    :param fields: 事件字段
    """
    import bridge

    bridge.emit({"event": event, **fields})


def _allowed_domains(url: str) -> set[str]:
    """从起始 URL 推出允许的域名集合，避免爬虫爬去站外。

    :param url: 起始 URL
    :returns: 域名集合；解析不出主机名时给空集
    """
    # 用 netloc（host:port）而不是 hostname：本地/自建站点几乎都带非默认端口，
    # 只给 hostname 会让「同主机不同端口」的链接被判成站外而丢掉 —— 于是只爬到第一页就停。
    # 主机名与 host:port 都放进去：Scrapling 的域过滤可能按 hostname 比，也可能按
    # netloc 比。少放一个的表现是「只爬到第一页就停」，不报错，很难一眼看出原因。
    parsed = urlparse(url)
    domains = {value for value in (parsed.hostname, parsed.netloc) if value}
    return domains


def _make_spider(url: str, limit: int, crawl_id: str, state: dict[str, Any]) -> Any:
    """动态造一个 spider 类。

    Spider 的 ``start_urls`` / ``allowed_domains`` / ``max_pages`` / ``output_dir``
    都是**类属性**而不是 ``__init__`` 参数 —— ``Spider.__init__`` 只收 crawldir 与
    interval，当构造参数传会直接 TypeError。所以只能在类体上写。

    :param url: 起始 URL
    :param limit: 最多爬多少页
    :param crawl_id: 爬虫 id，用于日志
    :param state: 结果槽；爬完写进它
    :returns: spider 实例
    """
    from scrapling.spiders import SiteToMarkdownSpider

    class Collector(SiteToMarkdownSpider):  # type: ignore[misc, valid-type]
        """把页面攒进 state 并向上报进度，不落盘。"""

        name = f"scrapling-{crawl_id}"
        start_urls = [url]
        allowed_domains = _allowed_domains(url)
        max_pages = limit
        output_dir = None

        def configure_sessions(self, manager: Any) -> None:
            """把爬虫的会话换成「只跟安全重定向、走配置里那份代理」的那一份。

            Spider 默认加的是裸 ``FetcherSession()``，重定向按 curl_cffi 的默认走 —— 跳向私网
            不会被拦。Host 闸门只判起点 URL，重定向目标是它看不到的，所以这里必须自己兜住：
            ``follow_redirects="safe"`` 让 curl_cffi 拒绝跳向私网的跳转。

            代理按起点 URL 定档（``allowed_domains`` 已经把爬虫锁在起点所在的域里，所以
            整场爬只有一个出口该选）。``proxies`` 为 None 表示用户没配任何代理相关设置，
            那就不传这个词，让 curl_cffi 照旧读环境 —— 与本包不介入时一致。

            :param manager: SessionManager
            """
            from scrapling.fetchers import FetcherSession

            session_kwargs: dict[str, Any] = {"follow_redirects": "safe"}
            proxies = proxies_for(url)
            if proxies is not None:
                session_kwargs["proxies"] = proxies
            manager.add("default", FetcherSession(**session_kwargs))

        async def on_scraped_item(self, item: dict[str, Any]) -> dict[str, Any] | None:
            """收一页并报进度。

            返回 None 表示「不要把这条当成要写出的结果」—— 我们已经把结果收进
            state 了，再让 spider 落一次盘是白费 IO。

            **必须是 async**：基类是 async 方法，引擎会 await 它。写成同步方法的话
            `await None` 抛 TypeError，会把 parse() 这个生成器**在 yield 出后续链接请求
            之前**打断 —— 表现是「只爬到第一页就停」，而且不报任何错。

            :param item: spider 交来的页面
            :returns: 恒为 None
            """
            pages: list[dict[str, Any]] = state["pages"]
            if len(pages) >= limit:
                return None
            page_url = str(item.get("url", ""))
            # 收页前的最后一道：即使 safe 重定向放行了，这一页的最终 URL 仍可能落在私网上。
            # 判否就不收 —— 内容已经在对端取过了，但至少不把它写进 state 流回模型上下文。
            allowed, reason = url_allowed(page_url)
            if not allowed:
                _emit_event(
                    "crawlSkipped",
                    crawlId=crawl_id,
                    url=page_url,
                    text=f"skipped {page_url}: {reason}",
                )
                return None
            markdown = str(item.get("markdown", ""))
            # 与其余抓取路径同一口径：内嵌 base64 图片是纯 token 噪音，先剥再封顶 ——
            # 顺序反了等于白剥，那几十 KB 早就把 max_content_chars 的额度吃掉了。
            if state["strip_inline_images"]:
                # 函数内导入：本模块顶层已经被 adapters 导入过，再顶层反向导入会成环
                # （adapters 末尾就是 `from crawl import METHODS`）。谁先被 import 决定
                # 这个环会不会炸，所以不赌。
                from adapters import drop_data_uris

                markdown = drop_data_uris(markdown)
            pages.append(
                {
                    "url": page_url,
                    "title": str(item.get("title", "")),
                    "markdown": _clip_markdown(markdown, state["max_content_chars"]),
                }
            )
            _emit_event(
                "progress",
                crawlId=crawl_id,
                done=len(pages),
                limit=limit,
                text=f"{len(pages)}/{limit} {page_url}",
            )
            return None

    return Collector()


def crawl_run(args: dict[str, Any]) -> dict[str, Any]:
    """起一个后台爬虫，立刻返回 crawl id。

    :param args: 协议参数
    :returns: {crawlId}
    :raises adapters.AdapterError: 参数非法、起点 URL 不安全或并发已满
    """
    from adapters import (
        DEFAULT_MAX_CONTENT_CHARS,
        AdapterError,
        _positive_int,
        _strip_inline_images,
        _url,
    )

    url = _url(args)
    max_pages = _positive_int(args.get("maxPages"), "maxPages", 20)
    max_content_chars = _positive_int(
        args.get("maxContentChars"), "maxContentChars", DEFAULT_MAX_CONTENT_CHARS
    )
    strip_inline_images = _strip_inline_images(args)
    crawl_id = uuid.uuid4().hex[:12]

    # Host 闸门判的是这条 URL，但协议层不该假设调用方一定判过：这道复核与浏览器路径上
    # 的 guard.url_allowed 是同一个实现，因此两侧同解。
    allowed, reason = url_allowed(url)
    if not allowed:
        raise AdapterError("URL_BLOCKED", f"{url}: {reason}")

    _evict_finished_crawls()
    running = [entry for entry in _CRAWLS.values() if entry["thread"].is_alive()]
    if len(running) >= MAX_CONCURRENT_CRAWLS:
        raise AdapterError(
            "CRAWL_BUSY",
            f"already {len(running)} crawls running; the limit is {MAX_CONCURRENT_CRAWLS}",
        )

    state: dict[str, Any] = {
        "error": None,
        "pages": [],
        "max_content_chars": max_content_chars,
        "strip_inline_images": strip_inline_images,
    }
    try:
        spider = _make_spider(url, max_pages, crawl_id, state)
    except Exception as error:  # noqa: BLE001
        raise AdapterError("CRAWL_SETUP_FAILED", f"{type(error).__name__}: {error}") from error

    def worker() -> None:
        """后台线程体：跑爬虫并把异常收进 state，不让它悄悄消失。"""
        try:
            spider.start()
        except Exception as error:  # noqa: BLE001
            state["error"] = f"{type(error).__name__}: {error}"
            _emit_event("crawlError", crawlId=crawl_id, text=str(error))

    thread = threading.Thread(target=worker, daemon=True, name=f"crawl-{crawl_id}")
    _CRAWLS[crawl_id] = {"thread": thread, "crawl_id": crawl_id, "state": state}
    thread.start()
    _emit_event("crawlStarted", crawlId=crawl_id, text=f"crawling {url} (max {max_pages} pages)")
    return {"crawlId": crawl_id}


def _evict_finished_crawls() -> None:
    """把已结束且超出留存量上限的爬虫条目从登记表里淘汰。

    爬虫跑在 daemon 线程里，没法优雅中断；但**跑完的**条目只是一份没人再读的历史，
    留久了就是纯内存占用。按插入顺序从最旧的开始丢。
    """
    finished = [key for key, entry in _CRAWLS.items() if not entry["thread"].is_alive()]
    overflow = len(_CRAWLS) - MAX_REMEMBERED_CRAWLS
    for key in finished[: max(0, overflow)]:
        del _CRAWLS[key]


def _get_crawl(crawl_id: Any) -> dict[str, Any]:
    """按 id 取爬虫登记条目。

    :param crawl_id: 爬虫 id
    :returns: 登记条目
    :raises adapters.AdapterError: id 缺失或不存在
    """
    from adapters import AdapterError

    if not isinstance(crawl_id, str) or not crawl_id:
        raise AdapterError("BAD_ARGS", "crawlId is required")
    entry = _CRAWLS.get(crawl_id)
    if entry is None:
        raise AdapterError("NO_SUCH_CRAWL", f"no such crawl: {crawl_id}")
    return entry


def crawl_status(args: dict[str, Any]) -> dict[str, Any]:
    """查一个爬虫的状态与已收结果。

    :param args: 协议参数
    :returns: {crawlId, running, pages, error}
    """
    entry = _get_crawl(args.get("crawlId"))
    thread: threading.Thread = entry["thread"]
    state: dict[str, Any] = entry["state"]
    return {
        "crawlId": entry["crawl_id"],
        "running": thread.is_alive(),
        "pages": state["pages"],
        "error": state["error"],
    }


def close_all_crawls() -> None:
    """清掉爬虫登记表。

    爬虫跑在 daemon 线程里：sidecar 退出时它们跟着退出，所以这里只清登记，
    不需要（也没法）去优雅中断一个正在跑的 spider。
    """
    _CRAWLS.clear()


METHODS = {
    "crawl.run": crawl_run,
    "crawl.status": crawl_status,
}
