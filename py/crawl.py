"""py/crawl.py —— 爬虫：用 Scrapling 自带的 Spider 框架在后台跑一个站点。

为什么用 Spider 而不是自己写循环：Scrapling 已经实现了并发、限速（AutoThrottle）、
robots.txt 遵守、断点续爬、链接提取与去重 —— 这些我们不想重写一遍。

为什么放到后台：一次爬取是分钟级的，而一次请求-响应撑不了那么久。所以这里**起一个
daemon 线程**跑 spider，主线程立刻返回 crawl id；进度通过「没有 id 的事件帧」推给宿主，
宿主把它接到后台作业的输出环上，模型就能边跑边看，而不是干等一个超时。
"""

from __future__ import annotations

import json
import re
import sys
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

# sidecar 收尾时给每只蜘蛛的等待预算（秒）。宿主那边的优雅关闭只有 sidecarGraceMs（默认
# 5s）那么久，超了就把进程杀掉；这里必须比它小，否则「等蜘蛛停」自己会变成关机卡住的原因。
SHUTDOWN_JOIN_SECONDS = 2.0

# 一次 crawl.status 回包的字节上界。Host 侧按 8 MiB 切帧，而一个快站点能在一个轮询间隔里
# 落下几十页；留一半余量，越过切帧线的那一帧会把整个 sidecar 拆掉。回不完的由 `more` 交接。
MAX_STATUS_BYTES = 4 * 1024 * 1024

# 一次爬虫的整体截止（毫秒）。页数上限管不了「一页等一分钟」：1000 页的慢站点能跑几个
# 小时，而爬虫跑在没人看的后台线程里，没有任何外部计时器会来叫停它。部署侧可按次调小。
DEFAULT_MAX_RUNTIME_MS = 1_800_000

# 爬虫的默认并发。与 Scrapling 的 Spider 默认值一致（spiders/spider.py 的
# ``concurrent_requests = 4``），写在这里是为了让「部署没表态」与「部署表态成 4」在
# 日志里不是同一件事。
DEFAULT_CONCURRENT_REQUESTS = 4

# 只投影这些统计字段：上游 to_dict() 还带 autothrottle / log_count / proxies 等
# 部署内部读数，模型用不上，也不该成为协议面的一部分。
_STATS_KEYS = (
    "requests_count",
    "failed_requests_count",
    "blocked_requests_count",
    "offsite_requests_count",
    "robots_disallowed_count",
    "items_scraped",
    "elapsed_seconds",
    "response_bytes",
    "response_status_count",
)


def _stats_projection(stats: Any) -> dict[str, Any]:
    """把 ``CrawlStats`` 压成协议声明的子集。"""
    data = stats.to_dict()
    return {key: data[key] for key in _STATS_KEYS if key in data}


def _crawl_policy(args: dict[str, Any]) -> dict[str, Any]:
    """读部署命名空间里的爬虫策略旋钮。

    全是部署级（不进设置卡、模型入参到不了这里）：它们决定的是「这台机器怎么对待别人的
    站点」—— 遵不遵守 robots.txt、隔多久发一个请求、同时开几条连接 —— 那是部署方的表态，
    不是某次会话的偏好。取值一律**报错而不夹**：一个写错的 0 被悄悄抬成 1，读日志的人
    只会以为「配的就是这样」。

    :param args: 协议参数
    :returns: 交给 Spider 类属性与构造器的那一份
    :raises adapters.AdapterError: 取值非法
    """
    from adapters import AdapterError, _positive_int

    deployment = args.get("deployment")
    knobs: dict[str, Any] = deployment if isinstance(deployment, dict) else {}
    strategy = knobs.get("crawlStrategy", "bfs")
    if strategy not in ("bfs", "dfs"):
        raise AdapterError("BAD_ARGS", f"crawlStrategy must be 'bfs' or 'dfs', got {strategy!r}")
    delay_ms = knobs.get("crawlDownloadDelayMs", 0)
    if not isinstance(delay_ms, (int, float)) or isinstance(delay_ms, bool) or delay_ms < 0:
        raise AdapterError("BAD_ARGS", "crawlDownloadDelayMs must be a non-negative number")
    checkpoint_dir = knobs.get("crawlCheckpointDir")
    return {
        "strategy": strategy,
        "delay_seconds": float(delay_ms) / 1000.0,
        "concurrency": _positive_int(
            knobs.get("crawlConcurrentRequests"), "crawlConcurrentRequests", DEFAULT_CONCURRENT_REQUESTS
        ),
        "obey_robots": knobs.get("crawlRespectRobots") is True,
        "autothrottle": knobs.get("crawlAutothrottle") is True,
        "checkpoint_dir": checkpoint_dir if isinstance(checkpoint_dir, str) else "",
    }


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


def _crawl_patterns(value: Any, field: str) -> list[str]:
    """校验并编译 crawl 的 include/exclude 正则。"""
    from adapters import AdapterError

    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise AdapterError("BAD_ARGS", f"{field} must be an array of non-empty strings")
    for pattern in value:
        try:
            re.compile(pattern)
        except re.error as error:
            raise AdapterError("BAD_ARGS", f"invalid crawl pattern: {error}") from error
    return value


def _collect_page(
    item: dict[str, Any],
    *,
    state: dict[str, Any],
    limit: int,
    crawl_id: str,
    domains: set[str],
    pause: Any,
) -> None:
    """收一页：域内/截止/清洗/封顶，与 content 模式同一条判据。"""
    pages: list[dict[str, Any]] = state["pages"]
    if len(pages) >= limit:
        return
    page_url = str(item.get("url", ""))
    allowed, reason = url_allowed(page_url)
    if allowed and not _within_allowed_domains(page_url, domains):
        allowed, reason = False, "left the start domain (redirect)"
    if not allowed:
        _emit_event("crawlSkipped", crawlId=crawl_id, url=page_url, text=f"skipped {page_url}: {reason}")
        return
    if time.monotonic() >= state["deadline"]:
        state["expired"] = True
        _emit_event(
            "crawlSkipped",
            crawlId=crawl_id,
            url=page_url,
            text=f"crawl stopped: runtime budget of {state['budget_ms']}ms reached",
        )
        with suppress(RuntimeError):
            pause()
        return
    markdown = str(item.get("markdown", ""))
    if state["strip_inline_images"]:
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


def _collect_row(
    item: dict[str, Any],
    *,
    state: dict[str, Any],
    limit: int,
    crawl_id: str,
    pause: Any,
) -> None:
    """收一行结构化 feed 数据；行本身不再发请求，因此只受页数/时长约束。

    到点时必须像 :func:`_collect_page` 一样把 Spider 叫停：只置 ``expired`` 的话 spider
    会继续翻页，``maxDurationMs`` 对 feed / shopify 这两种模式等于没生效。
    """
    rows: list[dict[str, Any]] = state["rows"]
    if len(rows) >= limit:
        return
    if time.monotonic() >= state["deadline"]:
        state["expired"] = True
        with suppress(RuntimeError):
            pause()
        return
    rows.append(dict(item))
    _emit_event(
        "progress",
        crawlId=crawl_id,
        done=len(rows),
        limit=limit,
        text=f"{len(rows)}/{limit} row",
    )


def _session_config(manager: Any, url: str) -> None:
    """给爬虫换一份安全重定向 + 部署代理的静态会话。"""
    from scrapling.fetchers import FetcherSession

    session_kwargs: dict[str, Any] = {"follow_redirects": "safe"}
    proxies = proxies_for(url)
    if proxies is not None:
        session_kwargs["proxies"] = proxies
    manager.add("default", FetcherSession(**session_kwargs))


def _policy_attrs(policy: dict[str, Any]) -> dict[str, Any]:
    """Spider 类属性上的待站策略（三种模板共用同一份）。"""
    return {
        "robots_txt_obey": policy["obey_robots"],
        "download_delay": policy["delay_seconds"],
        "concurrent_requests": policy["concurrency"],
        "crawl_strategy": policy["strategy"],
        "autothrottle_enabled": policy["autothrottle"],
    }


def _make_spider(
    url: str,
    limit: int,
    crawl_id: str,
    state: dict[str, Any],
    domains: set[str],
    policy: dict[str, Any],
    options: dict[str, Any] | None = None,
) -> Any:
    """动态造一个 spider 类。

    Spider 的 ``start_urls`` / ``allowed_domains`` / ``max_pages`` / ``output_dir``
    都是**类属性**而不是 ``__init__`` 参数 —— ``Spider.__init__`` 只收 crawldir 与
    interval，当构造参数传会直接 TypeError。所以只能在类体上写。待站策略（robots.txt、
    限速、并发、抓取顺序）同理，它们也是 Spider 的类属性。

    :param url: 起始 URL
    :param limit: 最多爬多少页
    :param crawl_id: 爬虫 id，用于日志
    :param state: 结果槽；爬完写进它
    :param domains: 起始域集合，链接发现与收页复核共用同一份
    :param policy: ``_crawl_policy`` 读出的待站策略
    :returns: spider 实例
    """
    from scrapling.spiders import ContentSpider, CrawlRule, LinkExtractor

    settings = options or {}
    content_selector = settings.get("css_selector")
    content_body_only = settings.get("main_content_only", True)
    include_patterns = settings.get("include_patterns") or []
    exclude_patterns = settings.get("exclude_patterns") or []

    class Collector(ContentSpider):
        """把页面攒进 state 并向上报进度，不落盘。"""

        name = f"scrapling-{crawl_id}"
        start_urls = [url]
        allowed_domains = domains
        max_pages = limit
        output_dir = None
        css_selector = content_selector
        main_content_only = content_body_only
        # 待站策略。robots_txt_obey 打开后 0.5 的取数口径是：抓取异常或 5xx → 该域按
        # 全面禁止处理；站点没有 robots.txt（404）→ 视作允许全部。所以这一档要么别开，
        # 要么确认目标站点 robots.txt 取得回来。
        robots_txt_obey = policy["obey_robots"]
        download_delay = policy["delay_seconds"]
        concurrent_requests = policy["concurrency"]
        crawl_strategy = policy["strategy"]
        autothrottle_enabled = policy["autothrottle"]

        def rules(self) -> list[Any]:
            """按模型给的 allow/deny 收窄链接发现；没给就沿用默认。"""
            return [
                CrawlRule(
                    LinkExtractor(
                        allow=include_patterns or (),
                        deny=exclude_patterns or (),
                    )
                )
            ]

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
            _collect_page(
                item,
                state=state,
                limit=limit,
                crawl_id=crawl_id,
                domains=domains,
                pause=self.pause,
            )
            return None

    return Collector(crawldir=policy["checkpoint_dir"] or None)


def _make_sitemap_spider(
    url: str,
    limit: int,
    crawl_id: str,
    state: dict[str, Any],
    domains: set[str],
    policy: dict[str, Any],
    options: dict[str, Any],
) -> Any:
    """SitemapSpider：只抓 sitemap 里的 loc，不跟随页面内链接。

    ``max_pages`` / ``css_selector`` / ``main_content_only`` 不是上游 SitemapSpider 声明的类
    属性（content 模式那一支才认这三个），引擎读不到它们；页数上限与正文范围由下面那个
    ``parse`` 自己取，别把它们当成引擎会执行的旋钮。
    """
    from scrapling.spiders import CrawlRule, LinkExtractor, SitemapSpider

    include = options["include_patterns"]
    exclude = options["exclude_patterns"]
    follow = options["sitemap_follow"]
    content_selector = options["css_selector"]
    body_only = options["main_content_only"]

    # 发现期的账：上游的 ``max_pages`` 只拦 ``parse()``（收页），发现期的 sitemap 请求是
    # 另一条路 —— 一个 sitemapindex 指向几百个子 sitemap 时，``maxPages=2`` 照样能打出
    # 几百次请求。这里给两个发现维度各设同一道上限。
    # 放在类外是必须的：类体里的名字不构成方法的闭包（方法里读不到）。
    discovery = {"sitemaps": 0, "urls": 0}

    def _cap_discovery() -> None:
        """记下「发现期被截断」这件事，让作业结果能说出为什么少。"""
        if not state.get("notice"):
            state["notice"] = (
                f"sitemap discovery stopped at maxPages={limit}: at most {limit} child sitemaps "
                f"and {limit} sitemap URLs are followed"
            )

    class Collector(SitemapSpider):
        name = f"scrapling-{crawl_id}"
        sitemap_urls = [options["sitemap_url"]]
        sitemap_follow = LinkExtractor(allow=follow) if follow else None
        allowed_domains = domains
        max_pages = limit
        css_selector = content_selector
        main_content_only = body_only
        robots_txt_obey = policy["obey_robots"]
        download_delay = policy["delay_seconds"]
        concurrent_requests = policy["concurrency"]
        crawl_strategy = policy["strategy"]
        autothrottle_enabled = policy["autothrottle"]

        def rules(self) -> list[Any]:
            if not include and not exclude:
                return []
            return [
                CrawlRule(
                    LinkExtractor(allow=include or (), deny=exclude or ()),
                    callback=self.parse,
                )
            ]

        def configure_sessions(self, manager: Any) -> None:
            _session_config(manager, url)

        async def _parse_sitemap(self, response: Any) -> Any:
            """把 SitemapSpider 的发现期请求也收进 maxPages 上限。

            判两类请求：回调仍是 ``_parse_sitemap`` 的是子 sitemap 文档，其余是要抓的页面
            URL；两类各自按 ``limit`` 封顶，超出的不再发出，并给作业结果留一条 notice。
            """
            async for request in super()._parse_sitemap(response):
                is_child_sitemap = getattr(request, "callback", None) == self._parse_sitemap
                key = "sitemaps" if is_child_sitemap else "urls"
                if discovery[key] >= limit:
                    _cap_discovery()
                    continue
                discovery[key] += 1
                yield request

        async def parse(self, response: Any) -> Any:
            if self.max_pages and len(state["pages"]) >= self.max_pages:
                return
            yield {
                "url": response.url,
                "title": str(response.css("title::text").get() or "").strip(),
                "markdown": response.markdown(self.css_selector, self.main_content_only),
            }

        async def on_scraped_item(self, item: dict[str, Any]) -> dict[str, Any] | None:
            _collect_page(
                item,
                state=state,
                limit=limit,
                crawl_id=crawl_id,
                domains=domains,
                pause=self.pause,
            )
            return None

    return Collector(crawldir=policy["checkpoint_dir"] or None)


def _make_shopify_spider(
    url: str,
    limit: int,
    crawl_id: str,
    state: dict[str, Any],
    domains: set[str],
    policy: dict[str, Any],
    options: dict[str, Any],
) -> Any:
    """ShopifySpider：走 `/collections.json` 与每个集合的 `/products.json`，按变体出行。

    上游模板把三个 URL 写死成 `https://`，而本地夹具与内网镜像常常是 http；这里按起始
    URL（或 `sitemapUrl`）的 scheme 重写同一组模板，好让「同一个实现」既能打真店也能打夹具。
    """
    from urllib.parse import urlsplit

    from scrapling.spiders import ShopifySpider

    override = options.get("sitemap_url")
    if override is not None and (not isinstance(override, str) or not override):
        from adapters import AdapterError

        raise AdapterError("BAD_ARGS", "sitemapUrl must be a non-empty string or null")
    source = override or url
    parts = urlsplit(source)
    scheme = parts.scheme or "https"
    website = parts.netloc
    if not website:
        raise ValueError("shopify mode needs a host in url or sitemapUrl")

    class Collector(ShopifySpider):
        name = f"scrapling-{crawl_id}"
        target_website = website
        collections_url = f"{scheme}://{{website}}/collections.json?page={{page}}&limit=250"
        products_url = f"{scheme}://{{website}}/collections/{{handle}}/products.json?page={{page}}&limit=250"
        product_url = f"{scheme}://{{website}}/collections/{{handle}}/products/{{product_handle}}"
        allowed_domains = domains
        robots_txt_obey = policy["obey_robots"]
        download_delay = policy["delay_seconds"]
        concurrent_requests = policy["concurrency"]
        autothrottle_enabled = policy["autothrottle"]

        def configure_sessions(self, manager: Any) -> None:
            # 代理判定跟着**真正要打的主机**走：shopify 的 collections/products 是用
            # sitemapUrl（或 url）的 netloc 拼出来的，与 url 可能不是同一台。
            _session_config(manager, source)

        def _not_a_store(self, response: Any, expected: str) -> str | None:
            """判断这次响应是不是「不是 Shopify 店铺」；是则回一条人读的原因。

            上游模板对 ``response.json()["collections"]`` 直接下标：站点回 404 页或一张
            HTML 首页时，异常被引擎吞进日志，作业就这么「completed、0 行」，模型看不出
            是打错了站还是抓早了。这里把三种常见形态折成一句可断言的话。
            """
            status = getattr(response, "status", 200)
            where = str(getattr(response, "url", "") or source)
            if status != 200:
                return (
                    f"shopify source answered HTTP {status} for {where}; "
                    f"the response is not Shopify store JSON (expected {expected}.json)"
                )
            try:
                payload = response.json()
            except Exception:  # noqa: BLE001 —— 上游 json() 的异常类型随响应体变
                return (
                    f"shopify source returned a non-JSON body for {where}; "
                    f"the response is not Shopify store JSON (expected {expected}.json)"
                )
            if not isinstance(payload, dict) or not isinstance(payload.get(expected), list):
                return (
                    f"shopify source returned JSON without a {expected!r} list for {where}; "
                    f"the response is not Shopify store JSON (expected {expected}.json)"
                )
            return None

        def _note(self, notice: str) -> None:
            """只在第一条 notice 上落笔：同一份结果里留最先出现的那个原因。"""
            if not state.get("notice"):
                state["notice"] = notice

        async def parse(self, response: Any) -> Any:
            notice = self._not_a_store(response, "collections")
            if notice is not None:
                self._note(notice)
                return
            async for item in super().parse(response):
                yield item

        async def parse_collection(self, response: Any) -> Any:
            notice = self._not_a_store(response, "products")
            if notice is not None:
                self._note(notice)
                return
            async for item in super().parse_collection(response):
                yield item

        async def on_scraped_item(self, item: dict[str, Any]) -> dict[str, Any] | None:
            _collect_row(item, state=state, limit=limit, crawl_id=crawl_id, pause=self.pause)
            if len(state["rows"]) >= limit:
                # 集合分页对真店是有限的，但没有上限的目录会让作业一直跑下去；到量就叫停。
                with suppress(RuntimeError):
                    self.pause()
            return None

    return Collector(crawldir=policy["checkpoint_dir"] or None)


def _make_feed_spider(
    url: str,
    limit: int,
    crawl_id: str,
    state: dict[str, Any],
    domains: set[str],
    policy: dict[str, Any],
    options: dict[str, Any],
) -> Any:
    """XMLFeedSpider / CSVFeedSpider：按 fields 映射出行，不抓页面。"""
    from scrapling.spiders import CSVFeedSpider, XMLFeedSpider

    feed_type = options["feed_type"]
    fields = options["fields"]
    iter_tag = options["itertag"]
    base = CSVFeedSpider if feed_type == "csv" else XMLFeedSpider

    class Collector(base):  # type: ignore[misc, valid-type]
        name = f"scrapling-{crawl_id}"
        start_urls = [options["feed_url"]]
        allowed_domains = domains
        max_pages = limit
        itertag = iter_tag
        robots_txt_obey = policy["obey_robots"]
        download_delay = policy["delay_seconds"]
        concurrent_requests = policy["concurrency"]
        crawl_strategy = policy["strategy"]
        autothrottle_enabled = policy["autothrottle"]

        def configure_sessions(self, manager: Any) -> None:
            _session_config(manager, url)

        async def parse_node(self, response: Any, node: Any) -> Any:
            yield {name: node.findtext(path) for name, path in fields.items()}

        async def parse_row(self, response: Any, row: dict[str, Any]) -> Any:
            yield {name: row.get(path) for name, path in fields.items()}

        async def on_scraped_item(self, item: dict[str, Any]) -> dict[str, Any] | None:
            _collect_row(item, state=state, limit=limit, crawl_id=crawl_id, pause=self.pause)
            return None

    return Collector(crawldir=policy["checkpoint_dir"] or None)


def _shopify_sitemap_arg(mode: str, value: Any) -> Any:
    """shopify 的 sitemapUrl 只收非空字符串或 null（与 _make_shopify_spider 同一条判据）。

    提前到这里判，是因为后面的 url_allowed 复核要拿它当字符串处理：先判干净，才不会把
    类型错误翻成 CRAWL_SETUP_FAILED。拆成函数也顺手把 crawl_run 的分支数压回去。

    :param mode: 爬取模式
    :param value: 协议参数 sitemapUrl
    :returns: 原值
    """
    if mode == "shopify" and value is not None and (not isinstance(value, str) or not value):
        from adapters import AdapterError

        raise AdapterError("BAD_ARGS", "sitemapUrl must be a non-empty string or null")
    return value


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
    css_selector = args.get("cssSelector")
    if css_selector is not None and not isinstance(css_selector, str):
        raise AdapterError("BAD_ARGS", "cssSelector must be a string or null")
    main_content_only = args.get("mainContentOnly", True)
    if not isinstance(main_content_only, bool):
        raise AdapterError("BAD_ARGS", "mainContentOnly must be a boolean")
    include_patterns = _crawl_patterns(args.get("includePatterns"), "includePatterns")
    exclude_patterns = _crawl_patterns(args.get("excludePatterns"), "excludePatterns")
    mode = args.get("mode", "content")
    if mode not in ("content", "sitemap", "feed", "shopify"):
        raise AdapterError("BAD_ARGS", f"mode must be content, sitemap, feed or shopify, got {mode!r}")
    sitemap_url = args.get("sitemapUrl")
    sitemap_follow = args.get("sitemapFollow")
    feed_url = args.get("feedUrl")
    feed_type = args.get("feedType")
    itertag = args.get("itertag", "item")
    fields = args.get("fields")
    if mode == "sitemap":
        if not isinstance(sitemap_url, str) or not sitemap_url:
            raise AdapterError("BAD_ARGS", "sitemap mode requires sitemapUrl")
        if sitemap_follow is not None:
            if not isinstance(sitemap_follow, str):
                raise AdapterError("BAD_ARGS", "sitemapFollow must be a string or null")
            try:
                re.compile(sitemap_follow)
            except re.error as error:
                raise AdapterError("BAD_ARGS", f"invalid sitemapFollow: {error}") from error
    if mode == "feed":
        if not isinstance(feed_url, str) or not feed_url:
            raise AdapterError("BAD_ARGS", "feed mode requires feedUrl")
        if feed_type not in ("xml", "csv"):
            raise AdapterError("BAD_ARGS", "feedType must be 'xml' or 'csv'")
        if not isinstance(itertag, str) or not itertag:
            raise AdapterError("BAD_ARGS", "itertag must be a non-empty string")
        if (
            not isinstance(fields, dict)
            or not fields
            or any(not isinstance(key, str) or not isinstance(value, str) for key, value in fields.items())
        ):
            raise AdapterError("BAD_ARGS", "fields must be a non-empty {output: path} mapping of strings")
    sitemap_url = _shopify_sitemap_arg(mode, sitemap_url)
    policy = _crawl_policy(args)
    crawl_id = uuid.uuid4().hex[:12]
    state: dict[str, Any] = {
        "error": None,
        "mode": mode,
        "pages": [],
        "rows": [],
        "stats": None,
        "max_content_chars": max_content_chars,
        "strip_inline_images": strip_inline_images,
        "budget_ms": budget_ms,
        "deadline": time.monotonic() + budget_ms / 1000,
        "notice": "",
    }
    # shopify 模式真正抓的主机可以来自 sitemapUrl：_make_shopify_spider 用它的 netloc 拼
    # collections/products 两个 URL。而站内判定用的是 allowed_domains —— 两处取不同来源时
    # spider 发出的每个请求都会被判成站外，一页都收不到。所以主机以真正要打的那一个为准。
    domain_source = sitemap_url if mode == "shopify" and sitemap_url else url
    domains = _allowed_domains(domain_source)

    # Host 闸门判的是这条 URL，但协议层不该假设调用方一定判过：这道复核与浏览器路径上
    # 的 guard.url_allowed 是同一个实现，因此两侧同解。
    allowed, reason = url_allowed(url)
    if not allowed:
        raise AdapterError("URL_BLOCKED", f"{url}: {reason}")
    # sitemap / shopify 的 sitemapUrl、feed 的 feedUrl 都是 spider 会真去请求的地址，
    # 每一个都要在这里复判：只判起点的 url 等于给 sitemapUrl 留了一条不过闸的门。
    for target in (
        sitemap_url if mode in ("sitemap", "shopify") else None,
        feed_url if mode == "feed" else None,
    ):
        if target is None:
            continue
        allowed, reason = url_allowed(target)
        if not allowed:
            raise AdapterError("URL_BLOCKED", f"{target}: {reason}")

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
        if mode == "sitemap":
            spider = _make_sitemap_spider(
                url,
                max_pages,
                crawl_id,
                state,
                domains,
                policy,
                {
                    "sitemap_url": sitemap_url,
                    "sitemap_follow": sitemap_follow,
                    "css_selector": css_selector,
                    "main_content_only": main_content_only,
                    "include_patterns": include_patterns,
                    "exclude_patterns": exclude_patterns,
                },
            )
        elif mode == "shopify":
            spider = _make_shopify_spider(
                url,
                max_pages,
                crawl_id,
                state,
                domains,
                policy,
                {"sitemap_url": sitemap_url},
            )
        elif mode == "feed":
            spider = _make_feed_spider(
                url,
                max_pages,
                crawl_id,
                state,
                domains,
                policy,
                {
                    "feed_url": feed_url,
                    "feed_type": feed_type,
                    "itertag": itertag,
                    "fields": fields,
                },
            )
        else:
            spider = _make_spider(
                url,
                max_pages,
                crawl_id,
                state,
                domains,
                policy,
                {
                    "css_selector": css_selector,
                    "main_content_only": main_content_only,
                    "include_patterns": include_patterns,
                    "exclude_patterns": exclude_patterns,
                },
            )
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
            result = spider.start()
            state["stats"] = _stats_projection(result.stats)
        except Exception as error:  # noqa: BLE001
            state["error"] = f"{type(error).__name__}: {error}"
            _emit_event("crawlError", crawlId=crawl_id, text=str(error))

    thread = threading.Thread(target=worker, daemon=True, name=f"crawl-{crawl_id}")
    with _CRAWL_LOCK:
        # spider 也要登记：叫停时拿得到它，才调得动引擎的停机通道。
        _CRAWLS[crawl_id]["spider"] = spider
        _CRAWLS[crawl_id]["thread"] = thread
    # crawlStarted 必须在 start() **之前**发。反过来有两处会出错：一是快蜘蛛可能在这一帧落地
    # 之前就先推了 progress，宿主侧「第一条是 crawlStarted」的读法于是变成随缘；二是万一这一帧
    # 发不出去（stdout 断了、序列化炸了），异常抛给调用方时蜘蛛已经在跑 —— 调用方拿不到
    # crawlId，就叫不停它，那个名额要一直占到进程退出。
    _emit_event(
        "crawlStarted",
        crawlId=crawl_id,
        text=f"crawling {url} in {mode} mode (max {max_pages} items)",
    )
    try:
        thread.start()
    except RuntimeError:
        # 起不了线程（资源耗尽）：把占位摘掉，名额立刻还回去，别留一条永远不跑的登记。
        with _CRAWL_LOCK:
            _CRAWLS.pop(crawl_id, None)
        raise
    return {"crawlId": crawl_id}


def _is_running(entry: dict[str, Any]) -> bool:
    """这个登记条目算不算「正在跑」。

    ``thread`` 为 ``None`` 表示 spider 还在构造中：它已经占了并发名额，所以算在跑。
    ``thread.ident`` 为 ``None`` 是另一段窗口——线程对象已登记但还没 ``start()``。只按
    ``is_alive()`` 判会在这段窗口里把条目当成已结束：并发的 :func:`crawl_run` 少算一个名额
    （突破并发上限）、:func:`_evict_finished_crawls` 把它当历史淘汰（之后那次 ``start()``
    就跑在没有登记项的蜘蛛上，叫不停）、:func:`crawl_stop` 判成不在跑。

    :param entry: 登记条目
    :returns: 是否占用名额
    """
    thread = entry.get("thread")
    if thread is None:
        return True
    return thread.ident is None or thread.is_alive()


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

    ``since`` 是本轮之前已经读走多少页（按下标，不是 URL）。带上它只回新增的那一段：
    整份 pages 每轮重发，流量是 O(n²)。但增量本身也可能很大 —— 一个快站点能在一个轮询
    间隔里落下几十页，每页又按 ``max_content_chars`` 封顶 —— 而 Host 侧是按 8 MiB 切帧的：
    超了就是一帧坏帧，整个 sidecar 连同正在跑的会话一起被拆掉。所以回包再按**字节**分片：
    回不完就置 ``more``，调用方拿新的 ``since`` 立刻接着取，一页都不丢。

    :param args: 协议参数
    :returns: {crawlId, running, pages, total, error, expired, more}
    """
    from adapters import AdapterError

    since = args.get("since", 0)
    if not isinstance(since, int) or isinstance(since, bool) or since < 0:
        raise AdapterError("BAD_ARGS", "since must be a non-negative integer")
    entry = _get_crawl(args.get("crawlId"))
    state: dict[str, Any] = entry["state"]
    # pages 是 spider 线程边跑边 append 的活列表，而回包要经 json.dumps 序列化。
    # 进锁里取一段：一边序列化一边追加，结果要么漏一页要么撞上 RuntimeError。
    with _CRAWL_LOCK:
        feed_rows = state.get("mode") in ("feed", "shopify")
        source = state["rows"] if feed_rows else state["pages"]
        total = len(source)
        taken, more = _take_pages(source, since)
        running = _is_running(entry)
    pages = [] if feed_rows else taken
    rows = taken if feed_rows else []
    return {
        "crawlId": entry["crawl_id"],
        "mode": state.get("mode", "content"),
        # thread 为 None 表示 spider 还在构造中：没跑起来，但也没结束。
        "running": running,
        "pages": pages,
        "rows": rows,
        "total": total,
        "more": more,
        "error": state["error"],
        # 作业自己知道的可读原因（sitemap 发现期被截断、shopify 源不是店铺 JSON 等）：
        # 缺了它，「0 条结果」与「站点不是那个形态」在模型眼里长得一样。
        "notice": state.get("notice", ""),
        # 截止到点而停的爬虫带这个标记：模型能看出「为什么比 maxPages 少」。
        "expired": state.get("expired") is True,
        # 只有 spider.start() 返回之后才完整；运行中为 null，不把「还没量到」报成 0。
        "stats": state.get("stats"),
    }


def _shrink_page(page: dict[str, Any], budget: int) -> dict[str, Any]:
    """把单页压到 ``budget`` 字节以内。

    ``maxContentChars`` 没有上界（部署侧的 ``fetchMaxOutputChars`` 只声明了 ``min(1)``），
    所以「一页就超过回包预算」是可达的：这时 :func:`_take_pages` 若照原样把它交出去，那一帧
    会顶过 Host 的 8 MiB 切帧线，整个 sidecar 连同正在跑的会话一起被判成坏帧拆掉。宁可回
    一页被截断的正文，也不要拆进程。

    截断量按**序列化之后**的剩余空间算：先量出除 markdown 以外的固定开销，再把 markdown
    砍到剩下的额度。CJK 一个字在 UTF-8 里三字节，所以按字符砍之后还要复查一次字节数，
    复查不过就继续砍，直到装得下或已砍空。

    :param page: 原始页
    :param budget: 这一页的字节预算
    :returns: 压过的新页（不就地改原对象，state 里留全量）
    """
    if "markdown" not in page:
        return page
    overhead = len(json.dumps({**page, "markdown": ""}, ensure_ascii=False).encode("utf-8"))
    room = max(0, budget - overhead)
    markdown = str(page.get("markdown", ""))
    clipped = markdown[:room] + "\n\n[truncated to fit the status frame budget]"
    while len(clipped.encode("utf-8")) > room and clipped:
        clipped = clipped[: max(0, len(clipped) - max(1, len(clipped) // 4))]
    return {**page, "markdown": clipped, "truncated": True}


def _take_pages(all_pages: list[dict[str, Any]], since: int) -> tuple[list[dict[str, Any]], bool]:
    """从 ``since`` 起取一段页，按 :data:`MAX_STATUS_BYTES` 封顶。

    回包条数与 ``since`` 的推进是同一件事：调用方按 ``len(pages)`` 推进 ``since``，所以
    这一轮回了哪几页，下一轮就必须从紧接着的下一页开始 —— 回包里的页得是**连续**的一段。
    早先碰到单页超预算就直接 ``return [_shrink_page(...)]``，把已经收下的前几页一起丢掉，
    而调用方只按回包条数推进一页，于是那些页下一轮被**重复**发出、更后面的页永远轮不到。

    现在：已经收下的页一起回，当前这页压到预算内再回；当前页若挤不进本轮余量就留给下一轮
    （下一轮的 ``since`` 正好落在它身上，且那一轮 ``taken`` 为空、只走截断分支），既不重复
    也不永久跳过。

    :param all_pages: 活页表
    :param since: 已经读走多少页
    :returns: (这一段的页, 后面还有没有)
    """
    if since >= len(all_pages):
        return [], False
    taken: list[dict[str, Any]] = []
    spent = 0
    for index in range(since, len(all_pages)):
        size = len(json.dumps(all_pages[index], ensure_ascii=False).encode("utf-8"))
        if size > MAX_STATUS_BYTES:
            # 当前页压到预算内，但已经收下的页必须一起回：这一轮回了 k 页，since 就前进
            # k 页，缺一页就会在下一轮重发它、更后面的页则被跳过。
            if taken:
                return taken, True
            return [_shrink_page(all_pages[index], MAX_STATUS_BYTES)], index + 1 < len(all_pages)
        if taken and spent + size > MAX_STATUS_BYTES:
            return taken, True
        taken.append(all_pages[index])
        spent += size
    return taken, False


def _request_stop(entry: dict[str, Any]) -> bool:
    """叫停一个登记条目：在跑的让引擎收尾，还没开跑的置标志。

    :param entry: 登记条目
    :returns: 是否真有一只蜘蛛在跑（因而被叫停）
    """
    state: dict[str, Any] = entry["state"]
    # 截止提前到「现在」：构造中的蜘蛛、刚起线程还没抓到页的蜘蛛，都在收到第一页时停。
    state["deadline"] = time.monotonic()
    with _CRAWL_LOCK:
        spider = entry.get("spider")
        running = _is_running(entry)
        if spider is None:
            # 线程还没起：置个标志，worker 起手看见它就直接退出，一页都不抓。
            entry["stop_requested"] = True
    if spider is not None and running:
        with suppress(RuntimeError):
            spider.pause()
        return True
    return False


def crawl_stop(args: dict[str, Any]) -> dict[str, Any]:
    """叫停一个爬虫。

    为什么必须有这条：宿主的作业取消只活在 Node 侧，Python 里的 Spider 跑在自己的线程上，
    看不见它。少了这一条，「作业显示已杀」之后爬虫还在后台跑，Python 进程也被一只没人管的
    蜘蛛占着。已经跑完的叫不停（引擎已拆），那不是错误：调用的意图是「别跑了」，已经停了。

    :param args: 协议参数
    :returns: {crawlId, stopping}
    :raises adapters.AdapterError: id 缺失或不存在
    """
    entry = _get_crawl(args.get("crawlId"))
    return {"crawlId": entry["crawl_id"], "stopping": _request_stop(entry)}


def close_all_crawls() -> None:
    """叫停全部爬虫，有界地等线程退出，再清登记表。

    sidecar 的两条收尾路径都走这里。等是**有界**的：宿主的优雅关闭只有 ``sidecarGraceMs``
    那么久（默认 5s），拖过它只会换来一次强杀，反而更看不清是谁停的。等不到的那几只记一行
    stderr —— stdout 是与 Host 的协议通道，那里不能写。
    """
    with _CRAWL_LOCK:
        entries = list(_CRAWLS.values())
    threads: list[Any] = []
    for entry in entries:
        _request_stop(entry)
        worker = entry.get("thread")
        if worker is not None:
            threads.append(worker)
    deadline = time.monotonic() + SHUTDOWN_JOIN_SECONDS
    for worker in threads:
        # 还没 start() 的线程 join 会抛 RuntimeError；那一段窗口里本来就没有可等的东西。
        with suppress(RuntimeError):
            worker.join(timeout=max(0.0, deadline - time.monotonic()))
    stuck = sum(1 for worker in threads if worker.is_alive())
    if stuck:
        print(f"[crawl] {stuck} spider thread(s) still running at shutdown", file=sys.stderr)
    _CRAWLS.clear()


METHODS = {
    "crawl.run": crawl_run,
    "crawl.status": crawl_status,
    "crawl.stop": crawl_stop,
}
