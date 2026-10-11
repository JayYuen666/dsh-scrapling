"""py/crawl.py —— 爬虫：用 Scrapling 自带的 Spider 框架在后台跑一个站点。

为什么用 Spider 而不是自己写循环：Scrapling 已经实现了并发、限速（AutoThrottle）、
robots.txt 遵守、断点续爬、链接提取与去重 —— 这些我们不想重写一遍。

为什么放到后台：一次爬取是分钟级的，而一次请求-响应撑不了那么久。所以这里**起一个
daemon 线程**跑 spider，主线程立刻返回 crawl id；进度通过「没有 id 的事件帧」推给宿主，
宿主把它接到后台作业的输出环上，模型就能边跑边看，而不是干等一个超时。
"""

from __future__ import annotations

import threading
import time
import uuid
from contextlib import suppress
from typing import Any
from urllib.parse import urlparse

from guard import proxies_for, url_allowed

# 正在跑的爬虫：crawl id -> {"thread": Thread, "crawl_id": str, "state": dict}
_CRAWLS: dict[str, dict[str, Any]] = {}

# bridge 有多个 worker 线程，crawl_run 会并发进来。判名额与登记必须原子，否则两个调用
# 各自数到「还没满」再各自起一条 Spider，MAX_CONCURRENT_CRAWLS 就名存实亡。判定与登记
# 之间隔着造 Spider（要建会话、可能要走网络），这个窗口足够宽。
_CRAWL_LOCK = threading.Lock()

# 同时能跑几个爬虫。爬虫是重量级后台任务且**立刻返回**，因此 bridge 的并发槽位对它无效
# —— 不设上限的话连续几次 crawl.run 就会叠起多个 Spider 线程与 FetcherSession。
MAX_CONCURRENT_CRAWLS = 2

# 登记表最多留几个已结束的爬虫条目。crawl.status 是唯一能读走结果的入口，所以条目不能一
# 结束就删；但全留着就是内存泄漏，所以留一个上限，按最旧的淘汰。
MAX_REMEMBERED_CRAWLS = 16

# 一次爬虫的整体截止（毫秒）。页数上限管不了「一页等一分钟」：1000 页的慢站点能跑几个
# 小时，而爬虫跑在没人看的后台线程里，没有任何外部计时器会来叫停它。部署侧可按次调小。
DEFAULT_MAX_RUNTIME_MS = 1_800_000


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
    return {value for value in (parsed.hostname, parsed.netloc) if value}


def _within_allowed_domains(url: str, allowed: set[str]) -> bool:
    """这个地址还在起始域里吗。

    口径与 Scrapling 引擎的 ``_is_domain_allowed`` 逐字一致（netloc 相等，或落在某个
    允许域的子域下）—— 链接发现那一侧本来就这么滤。但**它只管链接发现**：重定向是
    curl_cffi 自己跟的，``follow_redirects="safe"`` 只拒绝跳向私网，站外公网跳转照跟。
    所以最终落在哪个主机上，必须在收页之前自己复判一次。

    :param url: 待判定的地址
    :param allowed: 允许的域集合
    :returns: 是否仍在起始域内
    """
    domain = urlparse(url).netloc.lower()
    if not domain:
        return False
    return any(domain == entry or domain.endswith(f".{entry}") for entry in allowed)


def _make_spider(
    url: str,
    limit: int,
    crawl_id: str,
    state: dict[str, Any],
    domains: set[str],
) -> Any:
    """动态造一个 spider 类。

    Spider 的 ``start_urls`` / ``allowed_domains`` / ``max_pages`` / ``output_dir``
    都是**类属性**而不是 ``__init__`` 参数 —— ``Spider.__init__`` 只收 crawldir 与
    interval，当构造参数传会直接 TypeError。所以只能在类体上写。

    :param url: 起始 URL
    :param limit: 最多爬多少页
    :param crawl_id: 爬虫 id，用于日志
    :param state: 结果槽；爬完写进它
    :param domains: 起始域集合，链接发现与收页复核共用同一份
    :returns: spider 实例
    """
    from scrapling.spiders import SiteToMarkdownSpider

    class Collector(SiteToMarkdownSpider):  # type: ignore[misc, valid-type]
        """把页面攒进 state 并向上报进度，不落盘。"""

        name = f"scrapling-{crawl_id}"
        start_urls = [url]
        allowed_domains = domains
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
            # 收页前的最后两道：
            # 一是即使 safe 重定向放行了，这一页的最终 URL 仍可能落在私网上；
            # 二是它可能被重定向去了**站外另一台公网主机** —— allowed_domains 只参与链接
            # 发现，拦不住 curl_cffi 自己跟的那一跳。判否就不收：内容已经在对端取过了，
            # 但至少不把它写进 state 流回模型上下文。
            allowed, reason = url_allowed(page_url)
            if allowed and not _within_allowed_domains(page_url, domains):
                allowed, reason = False, "left the start domain (redirect)"
            if not allowed:
                _emit_event(
                    "crawlSkipped",
                    crawlId=crawl_id,
                    url=page_url,
                    text=f"skipped {page_url}: {reason}",
                )
                return None
            # 整体截止：页数上限管不了慢站点，而爬虫跑在没人看的后台线程里。到了点就按
            # 引擎自己的停机通道退场 —— pause() 让引擎在在途请求收尾后停，不是撕进程。
            if time.monotonic() >= state["deadline"]:
                state["expired"] = True
                _emit_event(
                    "crawlSkipped",
                    crawlId=crawl_id,
                    url=page_url,
                    text=f"crawl stopped: runtime budget of {state['budget_ms']}ms reached",
                )
                with suppress(RuntimeError):
                    self.pause()
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
    max_content_chars = _positive_int(args.get("maxContentChars"), "maxContentChars", DEFAULT_MAX_CONTENT_CHARS)
    budget_ms = _positive_int(args.get("maxDurationMs"), "maxDurationMs", DEFAULT_MAX_RUNTIME_MS)
    strip_inline_images = _strip_inline_images(args)
    crawl_id = uuid.uuid4().hex[:12]
    state: dict[str, Any] = {
        "error": None,
        "pages": [],
        "max_content_chars": max_content_chars,
        "strip_inline_images": strip_inline_images,
        "budget_ms": budget_ms,
        "deadline": time.monotonic() + budget_ms / 1000,
    }
    domains = _allowed_domains(url)

    # Host 闸门判的是这条 URL，但协议层不该假设调用方一定判过：这道复核与浏览器路径上
    # 的 guard.url_allowed 是同一个实现，因此两侧同解。
    allowed, reason = url_allowed(url)
    if not allowed:
        raise AdapterError("URL_BLOCKED", f"{url}: {reason}")

    with _CRAWL_LOCK:
        _evict_finished_crawls()
        running = [entry for entry in _CRAWLS.values() if _is_running(entry)]
        if len(running) >= MAX_CONCURRENT_CRAWLS:
            raise AdapterError(
                "CRAWL_BUSY",
                f"already {len(running)} crawls running; the limit is {MAX_CONCURRENT_CRAWLS}",
            )
        # 先占位再回去造 Spider。占位条目的 thread 是 None，_is_running 把它算作在跑 ——
        # 名额要在造 spider 的那几百毫秒里一直占着，否则并发调用会各自数到「还没满」。
        # stop_requested 也在占位时就位：那期间到来的叫停不能丢。
        _CRAWLS[crawl_id] = {
            "thread": None,
            "crawl_id": crawl_id,
            "state": state,
            "stop_requested": False,
        }

    try:
        spider = _make_spider(url, max_pages, crawl_id, state, domains)
    except BaseException as error:
        with _CRAWL_LOCK:
            _CRAWLS.pop(crawl_id, None)
        if isinstance(error, AdapterError):
            raise
        raise AdapterError("CRAWL_SETUP_FAILED", f"{type(error).__name__}: {error}") from error

    def worker() -> None:
        """后台线程体：跑爬虫并把异常收进 state，不让它悄悄消失。"""
        with _CRAWL_LOCK:
            if _CRAWLS.get(crawl_id, {}).get("stop_requested") is True:
                # 线程还没跑就被叫停了（crawl_stop 在 spider 登记之前到）：一页都不抓。
                return
        try:
            spider.start()
        except Exception as error:  # noqa: BLE001
            state["error"] = f"{type(error).__name__}: {error}"
            _emit_event("crawlError", crawlId=crawl_id, text=str(error))

    thread = threading.Thread(target=worker, daemon=True, name=f"crawl-{crawl_id}")
    with _CRAWL_LOCK:
        # spider 也要登记：叫停时拿得到它，才调得动引擎的停机通道。
        _CRAWLS[crawl_id]["spider"] = spider
        _CRAWLS[crawl_id]["thread"] = thread
    thread.start()
    _emit_event("crawlStarted", crawlId=crawl_id, text=f"crawling {url} (max {max_pages} pages)")
    return {"crawlId": crawl_id}


def _is_running(entry: dict[str, Any]) -> bool:
    """这个登记条目算不算「正在跑」。

    ``thread`` 为 ``None`` 表示 spider 还在构造中：它已经占了并发名额，所以算在跑。

    :param entry: 登记条目
    :returns: 是否占用名额
    """
    thread = entry.get("thread")
    return thread is None or thread.is_alive()


def _evict_finished_crawls() -> None:
    """把已结束且超出留存量上限的爬虫条目从登记表里淘汰。

    爬虫跑在 daemon 线程里，没法优雅中断；但**跑完的**条目只是一份没人再读的历史，
    留久了就是纯内存占用。按插入顺序从最旧的开始丢。构造中的条目不算已结束。

    :func:`_evict_finished_crawls` 只在 :func:`crawl_run` 持锁时被调用。
    """
    finished = [key for key, entry in _CRAWLS.items() if not _is_running(entry)]
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
    :returns: {crawlId, running, pages, error, expired}
    """
    entry = _get_crawl(args.get("crawlId"))
    state: dict[str, Any] = entry["state"]
    # pages 是 spider 线程边跑边 append 的活列表，而回包要经 json.dumps 序列化。
    # 进锁里复制一份：一边序列化一边追加，结果要么漏一页要么撞上 RuntimeError。
    with _CRAWL_LOCK:
        pages = list(state["pages"])
        running = _is_running(entry)
    return {
        "crawlId": entry["crawl_id"],
        # thread 为 None 表示 spider 还在构造中：没跑起来，但也没结束。
        "running": running,
        "pages": pages,
        "error": state["error"],
        # 截止到点而停的爬虫带这个标记：模型能看出「为什么比 maxPages 少」。
        "expired": state.get("expired") is True,
    }


def crawl_stop(args: dict[str, Any]) -> dict[str, Any]:
    """叫停一个爬虫。

    为什么必须有这条：宿主的作业取消只活在 Node 侧，Python 里的 Spider 跑在自己的
    线程上，看不见它。少了这一条，「作业显示已杀」之后爬虫还在后台跑，Python 进程也
    一直被一个没人管的蜘蛛占着。三条路各管一段：已经在跑的由 ``Spider.pause()`` 立刻
    收尾（引擎留给外部叫停的通道，等在途请求收尾后自己退出）；还没开始跑的把截止提前到
    现在，并在抓到第一页之前退出。

    已经跑完的爬虫叫不停（引擎已拆），那不是错误：调用的意图是「别跑了」，已经停了。

    :param args: 协议参数
    :returns: {crawlId, stopping}
    :raises adapters.AdapterError: id 缺失或不存在
    """
    entry = _get_crawl(args.get("crawlId"))
    state: dict[str, Any] = entry["state"]
    # 截止提前到「现在」：构造中的蜘蛛、刚起线程还没抓到页的蜘蛛，都在收到第一页时停。
    state["deadline"] = time.monotonic()
    with _CRAWL_LOCK:
        spider = entry.get("spider")
        running = _is_running(entry)
        if spider is None:
            # 线程还没起：置个标志，worker 起手看见它就直接退出，一页都不抓。
            entry["stop_requested"] = True
    stopping = False
    if spider is not None and running:
        with suppress(RuntimeError):
            spider.pause()
        stopping = True
    return {"crawlId": entry["crawl_id"], "stopping": stopping}


def close_all_crawls() -> None:
    """清掉爬虫登记表。

    爬虫跑在 daemon 线程里：sidecar 退出时它们跟着退出，所以这里只清登记，
    不需要（也没法）去优雅中断一个正在跑的 spider。
    """
    _CRAWLS.clear()


METHODS = {
    "crawl.run": crawl_run,
    "crawl.status": crawl_status,
    "crawl.stop": crawl_stop,
}
