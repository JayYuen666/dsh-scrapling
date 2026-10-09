"""py/adapters.py —— Scrapling 各引擎的薄封装。

只做三件事：把协议里的参数映射到 Scrapling 的调用、把 ``Response`` 归一成一份可
JSON 序列化的字典、把 Scrapling 的异常翻译成协议错误码。**不掺策略判断** —— URL 的
安全判定由 Host 侧与 guard.py 各做一遍，这里只负责「按调度好的方式把请求打出去」。

引擎对照（``scrapling/fetchers/``）::

    Fetcher             curl_cffi 静态抓取，只有 get/post/put/delete，没有 fetch()
    DynamicFetcher      Playwright Chromium
    StealthyFetcher     patchright Chromium

三者的返回都是 ``Response``，而 ``Response`` 继承 ``Selector``，所以抓完可以直接
css/xpath。所有浏览器引擎都是**一次性 session**：每次调用开进程、结束即关。会话复用
必须走 ``*Session`` 类（``scrapling.fetchers`` 导出），不能靠本模块复用。
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

import guard

# Scrapling 缺失时不要让整个 sidecar 起不来：桥接层会把它报成能力缺失，
# 而不是让 Host 侧只看到一个「进程崩了」。
try:  # pragma: no cover —— 取决于运行环境是否装了 scrapling
    from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher
except ImportError:  # pragma: no cover
    Fetcher = DynamicFetcher = StealthyFetcher = None  # type: ignore[assignment]

SCRAPLING_AVAILABLE = Fetcher is not None

DEFAULT_EXTRACTION = "markdown"
DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_MAX_CONTENT_CHARS = 200_000
EXTRACTION_TYPES = ("markdown", "html", "text")


class AdapterError(RuntimeError):
    """带机器可读错误码的抓取失败。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _require(engine: object) -> None:
    """引擎不可用时给出可执行的提示，而不是抛一个裸 AttributeError。"""
    if engine is None:
        raise AdapterError(
            "SCRAPLING_MISSING",
            'Scrapling is not importable in this Python environment. '
            'Install it with: pip install "scrapling[rag]"',
        )


def _positive_int(value: Any, field: str, default: int) -> int:
    """取一个正整数；类型不对就报错，而不是静默用默认值。"""
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise AdapterError("BAD_ARGS", f"{field} must be a positive integer")
    return value


def _positive_number(value: Any, field: str, default: float) -> float:
    """取一个正数。"""
    if value is None:
        return default
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise AdapterError("BAD_ARGS", f"{field} must be a positive number")
    return float(value)


def _string_map(value: Any, field: str) -> dict[str, str] | None:
    """把一个对象参数字典压成 ``dict[str, str]``；不是对象则报错。"""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise AdapterError("BAD_ARGS", f"{field} must be an object or null")
    return {str(key): str(item) for key, item in value.items()}


def clip(text: str, limit: int) -> tuple[str, bool]:
    """按字符数截断，返回 (文本, 是否被截断)。

    截在代理对中间会产生孤立高代理，进会话日志后会让后续 Messages 请求整体失败，
    所以末尾的孤立高代理要丢掉。
    """
    if len(text) <= limit:
        return text, False
    cut = text[:limit]
    if 0xD800 <= ord(cut[-1]) <= 0xDBFF:
        cut = cut[:-1]
    return cut, True


def _jsonable(value: Any) -> Any:
    """把 Scrapling 返回的对象归一成可 JSON 序列化的结构。"""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return str(value)


def _xhr_summary(responses: Any) -> list[dict[str, Any]]:
    """把 ``captured_xhr`` 压成轻量摘要。

    XHR 响应体可能很大，全量塞回 Host 会把模型上下文撑爆；这里只给 URL、状态码与
    字节数，模型自己决定要不要再对其中某个 URL 发一次抓取。
    """
    summary: list[dict[str, Any]] = []
    for item in responses or ():
        try:
            summary.append({"url": item.url, "status": item.status, "bytes": len(item.body)})
        except Exception:  # noqa: BLE001 —— 单条摘要失败不该拖垮整次抓取
            continue
    return summary


def _extraction(args: dict[str, Any]) -> tuple[str, str | None, bool, int]:
    """抽出四个抽取相关参数并校验。

    :param args: 协议参数
    :returns: (extraction_type, css_selector, main_content_only, max_content_chars)
    """
    extraction_type = str(args.get("extractionType", DEFAULT_EXTRACTION))
    if extraction_type not in EXTRACTION_TYPES:
        raise AdapterError("BAD_ARGS", f"unknown extractionType: {extraction_type}")
    css_selector = args.get("cssSelector")
    if css_selector is not None and not isinstance(css_selector, str):
        raise AdapterError("BAD_ARGS", "cssSelector must be a string or null")
    return (
        extraction_type,
        css_selector,
        bool(args.get("mainContentOnly", True)),
        _positive_int(args.get("maxContentChars"), "maxContentChars", DEFAULT_MAX_CONTENT_CHARS),
    )


def _sanitized_page(response: Any, *, main_content_only: bool) -> Any:
    """按 ``Response.markdown()`` 的口径拿到清洗过的树。

    markdown 那条路径走的是 ``Convertor._sanitize_for_ai(Convertor._strip_noise_tags(page))``，
    与 ``main_content_only`` 无关、无条件执行。直接取 ``response.html_content`` /
    ``get_all_text`` 就绕开了它，于是 script、display:none、aria-hidden、template、
    noscript 的内容会原样进模型上下文。这里对齐 markdown 的口径，顺带让 main_content_only
    对三条路径含义一致。
    """
    from scrapling.core.shell import Convertor

    page = (response.css("body").first or response) if main_content_only else response
    return Convertor._sanitize_for_ai(Convertor._strip_noise_tags(page))


def _strip_active_content(page: Any) -> None:
    """剥掉元素上的可执行残留，让清洗后的 HTML 真的只剩内容。

    ``_strip_noise_tags`` / ``_sanitize_for_ai`` 只处理元素与文本，**不碰属性**。实测
    清洗后 ``onclick`` 照样在，``<meta http-equiv=refresh>`` 与 ``srcdoc`` 也照样在 ——
    那些是事件处理器与跳转指令，直接把内网地址带进模型上下文。html 那条路径还回传
    完整标签，所以得在这里补一刀；text 路径取的是文本，不受属性影响。
    """
    root = getattr(page, "_root", None)
    if root is None or not hasattr(root, "iter"):
        return
    for element in list(root.iter()):
        tag = str(getattr(element, "tag", "") or "").lower()
        # lxml 的 attrib 是 _Attrib，不是 dict 子类 —— 这里只能鸭子类型判断。
        attrib = getattr(element, "attrib", None)
        if attrib is None or not hasattr(attrib, "keys"):
            continue
        # meta refresh 能把浏览器导航到内网地址；base 同样只影响解析、不贡献内容。
        if tag in ("meta", "base") and "http-equiv" in attrib:
            attrib.clear()
            continue
        for name in [
            key
            for key in list(attrib.keys())
            if key.lower().startswith("on") or key.lower() in ("srcdoc", "formaction")
        ]:
            del attrib[name]


# Markdown 里的一行内嵌 data URI 图片：![alt](data:...)。base64 的字母表是 A-Za-z0-9+/=
# （百分号编码形式则多出 %），两者都不含右括号，所以这个非贪婪匹配不会提前截断。
_MD_DATA_IMAGE = re.compile(r"!\[([^\]]*)\]\(\s*data:[^)]*\)", re.IGNORECASE)
# HTML 路径：<img src="data:..."> 与 <source srcset="data:...">。
_HTML_DATA_ATTR = re.compile(r"""(data:[^"'\s>]+)""", re.IGNORECASE)
# 代码围栏的分隔行。围栏**内部**的 data URI 必须原样保留 —— 那可能是教程里教的示例代码，
# 剥掉它等于把文档本身改了。
_FENCE = re.compile(r"\A\s*(?:```|~~~)")


def drop_data_uris(text: str, *, html: bool = False) -> str:
    """把内嵌的 data: URI 图片换成占位，代码围栏内原样保留。

    为什么值得做：这类图片对模型是**纯 token 噪音**。一段 base64 SVG 编码进上下文要按字符
    计费，而模型从里面读不出任何图形信息。不含内联图的页面逐字节不变；含内联的页面省掉的量
    取决于内联图有多少 —— 站点要么一个都不内联，要么就是一整面 logo 墙，中间态很少。

    为什么在文本层做而不是 DOM 层：markdown / html / text 三条路径的转换器各不相同
    （``Response.markdown`` 内部自己复制一棵树），改原树不保证影响 markdown 那条；而文本
    出口只有一个。代价是要自己避开代码围栏，用一个逐行的开关处理即可。

    保留 alt 文本：那是图片**唯一**携带的可读信息，剥成空等于连作者写的说明一起丢了。

    ``html=True`` 走属性形态那条规则，**只**对 html 路径用：对 markdown 文本无差别地跑它，
    会把代码围栏里 ``![x](data:image/png;base64,QQ==)`` 吃到右括号为止、把地址缩成
    ``data:…`` —— 围栏保护就此失效，而围栏里恰恰是最该原样保留的内容。

    :param text: 三条路径之一产出的正文
    :param html: 正文是不是 html 形态
    :returns: 剥掉内嵌图片后的正文
    """
    if html:
        # html 路径没有「围栏」概念，代码示例会以 <pre><code> 的形态出现；那种情况同样不该
        # 动，但 html 文本里判断「在不在代码块里」要解析标签，得不偿失 —— html 路径本身就
        # 是给「要看原始结构」用的，这条路径上少一层保护是可接受的取舍。
        return _HTML_DATA_ATTR.sub("data:…", text)
    out: list[str] = []
    in_fence = False
    for line in text.split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
            out.append(line)
        elif in_fence:
            out.append(line)
        else:
            out.append(_MD_DATA_IMAGE.sub(lambda m: f"[{m.group(1)}]", line))
    return "\n".join(out)


def to_payload(
    response: Any,
    *,
    extraction_type: str,
    css_selector: str | None,
    main_content_only: bool,
    max_content_chars: int,
    strip_inline_images: bool = True,
) -> dict[str, Any]:
    """把 Scrapling 的 ``Response`` 归一成协议载荷。

    反注入清洗对三条提取路径都无条件发生（``Convertor._strip_noise_tags`` +
    ``_sanitize_for_ai``）—— 这里**不提供关闭它的开关**。官方 MCP server 在
    ``main_content_only=False`` 时会绕过清洗，本插件不重复这个错。
    """
    if extraction_type == "html":
        page = _sanitized_page(response, main_content_only=main_content_only)
        _strip_active_content(page)
        content = page.html_content
    elif extraction_type == "text":
        page = _sanitized_page(response, main_content_only=main_content_only)
        content = page.get_all_text(
            strip=True,
            ignore_tags=("script", "style", "noscript", "svg", "iframe"),
        )
    else:
        content = response.markdown(css_selector=css_selector, main_content_only=main_content_only)

    clipped, truncated = clip(str(content), max_content_chars)
    # 先剥再封顶：被剥掉的那几十 KB 不该占 max_content_chars 的额度，否则一页内联图就能把
    # 真正文挤出预算 —— 顺序反了等于白剥。
    if strip_inline_images:
        clipped = drop_data_uris(clipped, html=extraction_type == "html")
    payload: dict[str, Any] = {
        "url": response.url,
        "status": response.status,
        "extractionType": extraction_type,
        "content": clipped,
        "truncated": truncated,
        "redirects": len(getattr(response, "history", ()) or ()),
    }
    captured = _xhr_summary(getattr(response, "captured_xhr", None))
    if captured:
        payload["xhr"] = captured
    return payload


def _strip_inline_images(args: dict[str, Any]) -> bool:
    """读部署命名空间里的输出形态开关；没给就按「剥」处理。

    只从 ``deployment`` 读、不看顶层：顶层是模型可传的透传表，而「所有抓取要不要剥内嵌图」
    是部署级的取舍。缺省为真 —— 噪声进上下文没有好处，要原始 data URI 的场景是例外。

    :param args: 协议参数
    :returns: 是否剥掉内嵌 data URI 图片
    """
    deployment = args.get("deployment")
    if isinstance(deployment, dict):
        value = deployment.get("stripInlineImages")
        if isinstance(value, bool):
            return value
    return True


def _static_params(args: dict[str, Any], url: str) -> dict[str, Any]:
    """静态抓取的公共参数。

    ``follow_redirects="safe"`` 是关键：curl_cffi 会拒绝跳向私网的重定向，
    这是 Host 侧预校验之外的第二道防线（两者之间仍有 TOCTOU 窗口，见 README）。

    ``proxies`` 只在用户配了代理或绕过清单时才出现（guard 那边返回 None 表示
    「本包不表态」），那时由本包决定走哪个出口；否则一个字都不传，让 curl_cffi
    按自己的 trust_env 读环境 —— 与本包不介入时逐字节一致。
    """
    params: dict[str, Any] = {
        "timeout": _positive_number(
            args.get("timeoutSeconds"), "timeoutSeconds", DEFAULT_TIMEOUT_SECONDS
        ),
        "follow_redirects": "safe",
        "retries": _positive_int(args.get("retries"), "retries", 3),
    }
    proxies = guard.proxies_for(url)
    if proxies is not None:
        params["proxies"] = proxies
    headers = _string_map(args.get("headers"), "headers")
    if headers is not None:
        params["headers"] = headers
    return params


def _url(args: dict[str, Any]) -> str:
    """取必填的 url 参数。"""
    url = args.get("url")
    if not isinstance(url, str) or not url:
        raise AdapterError("BAD_ARGS", "url is required")
    return url


def fetch(args: dict[str, Any]) -> dict[str, Any]:
    """静态抓取（curl_cffi）。不需要浏览器。

    :param args: 协议参数
    :returns: 归一后的载荷
    """
    _require(Fetcher)
    url = _url(args)
    extraction_type, css_selector, main_content_only, limit = _extraction(args)
    params = _static_params(args, url)

    cookies = _string_map(args.get("cookies"), "cookies")
    if cookies is not None:
        params["cookies"] = cookies
    impersonate = args.get("impersonate")
    if isinstance(impersonate, str) and impersonate:
        params["impersonate"] = impersonate

    method = str(args.get("method", "GET")).upper()
    if method not in ("GET", "POST", "PUT", "DELETE"):
        raise AdapterError("BAD_ARGS", f"unsupported method: {method}")
    if method != "GET":
        body = args.get("body")
        if isinstance(body, dict):
            params["json"] = _jsonable(body)
        elif isinstance(body, str):
            params["data"] = body

    response = getattr(Fetcher, method.lower())(url, **params)
    return to_payload(
        response,
        extraction_type=extraction_type,
        css_selector=css_selector,
        main_content_only=main_content_only,
        max_content_chars=limit,
        strip_inline_images=_strip_inline_images(args),
    )


def _browser_params(args: dict[str, Any], url: str) -> dict[str, Any]:
    """浏览器抓取的公共参数。

    ``block_ads`` 由部署设置决定，可以打开：它并不会与 SSRF 守卫抢 handler。
    上游把 ``block_ads`` 折进**同一个** ``blocked_domains``（engines/_browsers/
    _validators.py），交给 engines/_browsers/_base.py 里那一个
    ``create_intercept_handler``；而那个 handler 是在 ``page_setup`` **之前**注册的，
    守卫在 ``page_setup`` 里后注册、因而先跑。守卫放行时走 ``route.fallback()``
    （不是 ``continue_()``），所以上游的拦截能叠加在守卫判定之上，SSRF 那一道不受影响。

    ``blocked_domains`` / ``disable_resources`` 仍固定关闭：本包没有对应的部署设置，
    而打开它们同样只是给上游那个 handler 加料，不会削弱守卫。

    代理在这里显式交给引擎，是三条抓取路径里唯一必须这么做的一条：Chromium 不读
    ``HTTP_PROXY``/``ALL_PROXY``，只读系统代理设置，于是一台只在 shell 里 export 过代理
    的机器上静态抓取走代理、浏览器抓取却直连。传 ``proxy`` 给 ``DynamicFetcher.fetch`` /
    ``StealthyFetcher.fetch`` 时它落进**会话**配置（fetchers/*.py 里是
    ``DynamicSession(**kwargs)``），进 ``launch_persistent_context`` 的 context 选项 ——
    所以是一次抓取一个 context，与一次性会话的既有形态一致，且不会丢 cookie。
    """
    params: dict[str, Any] = {
        "headless": bool(args.get("headless", True)),
        "timeout": _positive_int(args.get("timeoutMs"), "timeoutMs", DEFAULT_TIMEOUT_MS),
        "block_ads": bool(args.get("blockAds", False)),
        "blocked_domains": None,
        "disable_resources": False,
    }
    proxy = guard.browser_proxy(url)
    if proxy is not None:
        params["proxy"] = proxy
        # WebRTC 能绕过代理直接发 UDP，页面里一句 STUN 就能问出访客的真实出口 IP。
        # 走代理时那条信息本就不该泄露，所以两套引擎都上对应的开关：patchright 有
        # block_webrtc，Playwright 没有，只能用 Chromium 的启动 flag。
        params["extra_flags"] = [guard.WEBRTC_NO_LEAK_FLAG]
    if args.get("networkIdle"):
        params["network_idle"] = True
    for key, name in (
        ("waitSelector", "wait_selector"),
        ("waitSelectorState", "wait_selector_state"),
        ("useragent", "useragent"),
        ("locale", "locale"),
        ("timezoneId", "timezone_id"),
        ("captureXhrPattern", "capture_xhr"),
    ):
        value = args.get(key)
        if isinstance(value, str) and value:
            params[name] = value
    # 浏览器二进制路径与 CDP 端点只从 deployment 命名空间取，不在上面的模型可见透传表里：
    # executable_path 等于「让 Chromium 去执行这个文件」，cdp_url 等于「把浏览器交给这个
    # 调试端点」，两者都是部署级的强能力，但绝不能由模型入参驱动。Host 侧对应的两枚设置
    # 同样是非 volatile 的部署级字段（不进设置卡）。
    deployment = args.get("deployment")
    if isinstance(deployment, dict):
        for source, target in (
            ("browserExecutablePath", "executable_path"),
            ("browserCdpUrl", "cdp_url"),
        ):
            value = deployment.get(source)
            if isinstance(value, str) and value:
                params[target] = value
    wait_ms = args.get("waitMs")
    if isinstance(wait_ms, (int, float)) and not isinstance(wait_ms, bool) and wait_ms > 0:
        params["wait"] = wait_ms
    extra_headers = _string_map(args.get("extraHeaders"), "extraHeaders")
    if extra_headers is not None:
        params["extra_headers"] = extra_headers
    return params


def render(args: dict[str, Any], *, stealth: bool) -> dict[str, Any]:
    """浏览器抓取。``stealth`` 为真时走 patchright 引擎。

    :param args: 协议参数
    :param stealth: 是否用 StealthyFetcher
    :returns: 归一后的载荷
    """
    engine = StealthyFetcher if stealth else DynamicFetcher
    _require(engine)
    url = _url(args)
    extraction_type, css_selector, main_content_only, limit = _extraction(args)

    params = _browser_params(args, url)
    params["page_setup"] = page_setup
    if stealth:
        params["solve_cloudflare"] = bool(args.get("solveCloudflare", False))
        params["hide_canvas"] = bool(args.get("hideCanvas", False))
        # 走代理时强制为真，不看模型入参：WebRTC 泄露的是访客的真实出口 IP，而访客用这个
        # 插件正是为了不泄露它。
        params["block_webrtc"] = bool(args.get("blockWebrtc", False)) or "proxy" in params
        params["allow_webgl"] = bool(args.get("allowWebgl", True))

    response = engine.fetch(url, **params)
    return to_payload(
        response,
        extraction_type=extraction_type,
        css_selector=css_selector,
        main_content_only=main_content_only,
        max_content_chars=limit,
        strip_inline_images=_strip_inline_images(args),
    )


def _fake_response(html: str, url: str, status: int) -> Any:
    """造一个不带网络的 ``Response``，给离线抽取用。"""
    from scrapling.engines.toolbelt.custom import Response

    return Response(
        url=url,
        content=html,
        status=status,
        reason="",
        cookies={},
        headers={},
        request_headers={},
    )


def extract(args: dict[str, Any]) -> dict[str, Any]:
    """对一段已有 HTML 做抽取，不发任何网络请求。

    :param args: 协议参数
    :returns: 归一后的载荷
    """
    html = args.get("html")
    if not isinstance(html, str):
        raise AdapterError("BAD_ARGS", "html must be a string")
    extraction_type, css_selector, main_content_only, limit = _extraction(args)
    status = args.get("status", 200)
    if not isinstance(status, int) or isinstance(status, bool):
        raise AdapterError("BAD_ARGS", "status must be an integer")
    response = _fake_response(html, str(args.get("url") or "about:blank"), status)
    return to_payload(
        response,
        extraction_type=extraction_type,
        css_selector=css_selector,
        main_content_only=main_content_only,
        max_content_chars=limit,
        strip_inline_images=_strip_inline_images(args),
    )


def select(args: dict[str, Any]) -> dict[str, Any]:
    """对已有 HTML 做 CSS/XPath 选择，返回命中的文本与少量属性。

    这正是 dsh 内置 ``web_fetch`` 结构上做不到的那部分：它只能给一整块 Markdown，
    这里给的是选择器命中的具体内容。
    """
    from scrapling.parser import Selector

    html = args.get("html")
    if not isinstance(html, str):
        raise AdapterError("BAD_ARGS", "html must be a string")
    selector = args.get("selector")
    if not isinstance(selector, str) or not selector:
        raise AdapterError("BAD_ARGS", "selector is required")
    attribute = args.get("attribute")
    if attribute is not None and not isinstance(attribute, str):
        raise AdapterError("BAD_ARGS", "attribute must be a string or null")

    page = Selector(html)
    nodes = page.xpath(selector) if bool(args.get("useXpath", False)) else page.css(selector)
    limit = _positive_int(args.get("limit"), "limit", 200)
    include_attributes = bool(args.get("includeAttributes", False))

    matches: list[dict[str, Any]] = []
    for node in nodes[:limit]:
        item: dict[str, Any] = {"tag": node.tag}
        if attribute:
            item["value"] = str(node.attrib.get(attribute, ""))
        else:
            item["text"] = str(node.get_all_text(strip=True))
        if include_attributes:
            item["attributes"] = {str(key): str(value) for key, value in node.attrib.items()}
        matches.append(item)
    return {
        "count": len(nodes),
        "truncated": len(nodes) > len(matches),
        "matches": _jsonable(matches),
    }


def page_setup(page: object) -> None:
    """Scrapling ``page_setup`` 回调：装上网络守卫。

    绝不能把这个回调本身暴露成模型可传的参数 —— 那等于给被 prompt 注入的模型一个
    任意代码执行入口。Scrapling 官方 MCP 的 ``_EXCLUDED_FETCH_KEYS`` 是同一个道理。
    """
    from guard import install

    install(page)


def _scrapling_version() -> str:
    """读 Scrapling 版本号；读不到给空串，不让能力探测整体失败。"""
    try:
        import scrapling

        return str(scrapling.__version__)
    except Exception:  # noqa: BLE001
        return ""


def _probe_browser(module_name: str) -> bool:
    """起一次浏览器再关掉，确认浏览器二进制真的可用。

    为什么直接用 Playwright/patchright 而不走 ``engine.fetch``：Scrapling 的 fetch 会在
    ``page.goto`` 返回 None 时抛 "Failed to get response"，而 ``data:`` 与 ``about:blank``
    这类 URL 恰好不产生 response。拿它们当探针 URL 会稳定地假失败，还会被 ``retries``
    放大成几秒钟的重试风暴。

    要验的其实只有一件事：**浏览器二进制装没装**。``playwright install chromium`` 与
    patchright 各自管理浏览器，少任一个都会在真正调用时才炸，所以两个引擎都要单独探。

    :param module_name - ``"playwright.sync_api"`` 或 ``"patchright.sync_api"``
    :returns: 浏览器能否启动
    """
    import importlib

    try:
        sync_playwright = importlib.import_module(module_name).sync_playwright
        with sync_playwright() as driver:
            browser = driver.chromium.launch(headless=True)
            browser.close()
    except Exception:  # noqa: BLE001 —— 探针只关心起没起得来，细节由 Host 侧提示用户
        return False
    return True


def capabilities() -> dict[str, Any]:
    """报告本进程当前具备的能力，供 Host 侧决定注册哪些工具。"""
    report: dict[str, Any] = {
        "scrapling": SCRAPLING_AVAILABLE,
        "static": SCRAPLING_AVAILABLE,
        "extract": SCRAPLING_AVAILABLE,
        "browser": False,
        "stealth": False,
    }
    if not SCRAPLING_AVAILABLE:
        return report
    report["version"] = _scrapling_version()
    report["browser"] = _probe_browser("playwright.sync_api")
    report["stealth"] = _probe_browser("patchright.sync_api")
    # 出口如实上报：用户得能一眼看出抓取会从哪里出去、以及本包到底有没有在管这件事。
    # server 只含 scheme://host:port，凭据不出现（见 guard.proxy_settings）。
    report["proxy"] = guard.proxy_settings()
    return report


METHODS = {
    "ping": lambda _args: {"pong": True},
    "capabilities": lambda _args: capabilities(),
    "fetch": fetch,
    "render": lambda args: render(args, stealth=False),
    "stealth_fetch": lambda args: render(args, stealth=True),
    "extract": extract,
    "select": select,
}


# ---------------------------------------------------------------------------
# 会话
#
# 一次性抓取每次都新开进程/新会话，cookie、登录态、浏览器实例全部丢失。
# 会话把这份状态留在 sidecar 进程里跨请求复用 —— 这是 Scrapling 相对
# 「每次调用都重新来」最实用的一块。
#
# 三种类型与 Scrapling 的一一对应：
#   static  -> FetcherSession（curl_cffi）
#   browser -> DynamicSession（Playwright）
#   stealth -> StealthySession（patchright）
# ---------------------------------------------------------------------------

_SESSION_CLASSES = {
    "static": "FetcherSession",
    "browser": "DynamicSession",
    "stealth": "StealthySession",
}

# 会话注册表。sidecar 是常驻进程，这里就是它的内存；进程退出时全部随之消失。
# 值里存 {"session": <对象>, "type": <str>, "created_at": <iso8601>}
_SESSIONS: dict[str, dict[str, Any]] = {}

# 同开几个会话。browser/stealth 每开一个就是一个真实的 Chromium 进程，而 sessionType 是
# **模型可选**的参数 —— 不设上限的话，「开 → 不关」重复几次就能把机器的内存吃光。
# 因此在登记之前就判，而不是指望模型记得调 session_close。
MAX_SESSIONS = 8
# 其中最多几个可以是吃内存的那两种。static 只是连接池，便宜得多。
MAX_BROWSER_SESSIONS = 3


def _new_session_id() -> str:
    """生成一个短的会话 id。

    :returns: 会话 id
    """
    return uuid.uuid4().hex[:12]


def _make_session(kind: str, args: dict[str, Any]) -> Any:
    """按类型造一个**已启动**的会话对象。

    代理在浏览器会话上是**开的时候定一次**而不是每次 fetch 定：Playwright 的代理挂在
    BrowserContext 上，中途换代理只能新建 context，而新建就等于丢掉这个会话攒下来的
    cookie 与登录态 —— 那是会话存在的理由。绕过清单因此对浏览器会话不逐 URL 生效（对
    静态会话生效，那边是每次请求各自的参数，换代理不丢任何东西）。

    :param kind: static / browser / stealth
    :param args: 创建参数
    :returns: 已 start（或已进入上下文）的会话对象
    :raises AdapterError: 类型不认识，或构造/启动失败
    """
    if kind not in _SESSION_CLASSES:
        raise AdapterError("BAD_ARGS", f"unknown session type: {kind}")

    if kind == "static":
        from scrapling.fetchers import FetcherSession

        wrapper = FetcherSession(
            impersonate=args.get("impersonate") or "chrome",
            timeout=args.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS),
        )
        # FetcherSession 自己没有 get/post —— 那些方法在 __enter__ 返回的
        # _SyncSessionLogic 上。存错对象的话，调用时会报 'no attribute get'。
        logic = wrapper.__enter__()
        # wrapper 要留在登记条目里，close 时才能 __exit__。
        return logic, wrapper

    from scrapling.fetchers import DynamicSession, StealthySession

    headless = bool(args.get("headless", True))
    timeout_ms = _positive_int(args.get("timeoutMs"), "timeoutMs", DEFAULT_TIMEOUT_MS)
    common: dict[str, Any] = {"headless": headless, "timeout": timeout_ms}
    # 会话开的时候还不知道要访问哪个主机，所以按「配了代理就用代理」定档；显式填过
    # proxyBypass 的主机在会话里也跟着走代理 —— 见上面的取舍说明。
    proxy = guard.split_proxy(guard.default_proxy())
    if proxy is not None:
        common["proxy"] = proxy
        common["extra_flags"] = [guard.WEBRTC_NO_LEAK_FLAG]
    if kind == "browser":
        session = DynamicSession(**common)
    else:
        session = StealthySession(
            **common,
            solve_cloudflare=bool(args.get("solveCloudflare", False)),
            hide_canvas=bool(args.get("hideCanvas", False)),
            block_webrtc=bool(args.get("blockWebrtc", False)) or proxy is not None,
            allow_webgl=bool(args.get("allowWebgl", True)),
        )
    session.start()
    return session, session


def _enforce_session_limits(kind: str) -> None:
    """在开新会话之前判一下名额，超了就明确报错而不是让机器被吃光。

    判否而不是自动关掉最旧的那个：关一个模型还握着的会话，会让它的下一次请求莫名断掉，
    而「到上限了，请先 close 一个」是模型自己能纠正的。

    :param kind: 即将开的会话类型
    :raises AdapterError: 总数或浏览器类会话数已到上限
    """
    from adapters import AdapterError

    if len(_SESSIONS) >= MAX_SESSIONS:
        raise AdapterError(
            "SESSION_LIMIT",
            f"{len(_SESSIONS)} sessions are already open (limit {MAX_SESSIONS}); "
            "close one with session.close before opening another",
        )
    if kind in ("browser", "stealth"):
        browsers = sum(1 for entry in _SESSIONS.values() if entry["type"] in ("browser", "stealth"))
        if browsers >= MAX_BROWSER_SESSIONS:
            raise AdapterError(
                "SESSION_LIMIT",
                f"{browsers} browser sessions are already open "
                f"(limit {MAX_BROWSER_SESSIONS}); close one before opening another",
            )


def session_open(args: dict[str, Any]) -> dict[str, Any]:
    """开一个会话并登记。

    :param args: 协议参数
    :returns: 会话信息
    :raises AdapterError: 类型不认识 / id 重复 / 构造失败
    """
    kind = str(args.get("sessionType", "static"))
    session_id = args.get("sessionId") or _new_session_id()
    if not isinstance(session_id, str) or not session_id:
        raise AdapterError("BAD_ARGS", "sessionId must be a string")
    if session_id in _SESSIONS:
        raise AdapterError("BAD_ARGS", f"session already exists: {session_id}")
    _enforce_session_limits(kind)

    try:
        usable, closer = _make_session(kind, args)
    except AdapterError:
        raise
    except Exception as error:  # noqa: BLE001
        raise AdapterError("SESSION_OPEN_FAILED", f"{type(error).__name__}: {error}") from error

    _SESSIONS[session_id] = {
        "session": usable,  # 真正发请求的对象
        "closer": closer,  # 关它用的对象（static 是 wrapper，浏览器是自身）
        "type": kind,
        # 浏览器会话是否带着代理；stealth 的 block_webrtc 要在每次 fetch 时跟着它走。
        "proxied": kind != "static" and guard.default_proxy() != "",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    return {
        "sessionId": session_id,
        "sessionType": kind,
        "createdAt": _SESSIONS[session_id]["created_at"],
    }


def _get_session(session_id: Any) -> dict[str, Any]:
    """按 id 取已登记的会话。

    :param session_id: 会话 id
    :returns: 登记条目
    :raises AdapterError: id 缺失或不存在
    """
    if not isinstance(session_id, str) or not session_id:
        raise AdapterError("BAD_ARGS", "sessionId is required")
    entry = _SESSIONS.get(session_id)
    if entry is None:
        raise AdapterError("NO_SUCH_SESSION", f"no such session: {session_id}")
    return entry


def session_fetch(args: dict[str, Any]) -> dict[str, Any]:
    """用已开好的会话抓一个 URL。

    :param args: 协议参数
    :returns: 归一后的载荷
    :raises AdapterError: 会话不存在 / 类型不支持 / 抓取失败
    """
    entry = _get_session(args.get("sessionId"))
    session = entry["session"]
    extraction_type, css_selector, main_content_only, limit = _extraction(args)
    url = _url(args)

    try:
        if entry["type"] == "static":
            response = session.get(url, **_static_params(args, url))
        else:
            # 浏览器会话的代理在开场时就定死了（见 _make_session），这里不再逐 URL 覆盖 ——
            # 覆盖的做法是新建 context，cookie 与登录态会随之清空。
            params = _browser_params(args, url)
            params.pop("proxy", None)
            params.pop("extra_flags", None)
            params["page_setup"] = page_setup
            if entry["type"] == "stealth":
                params["solve_cloudflare"] = bool(args.get("solveCloudflare", False))
                params["hide_canvas"] = bool(args.get("hideCanvas", False))
                params["block_webrtc"] = bool(args.get("blockWebrtc", False)) or bool(
                    entry["proxied"]
                )
                params["allow_webgl"] = bool(args.get("allowWebgl", True))
            response = session.fetch(url, **params)
    except AdapterError:
        raise
    except Exception as error:  # noqa: BLE001
        raise AdapterError("FETCH_FAILED", f"{type(error).__name__}: {error}") from error

    payload = to_payload(
        response,
        extraction_type=extraction_type,
        css_selector=css_selector,
        main_content_only=main_content_only,
        max_content_chars=limit,
        strip_inline_images=_strip_inline_images(args),
    )
    payload["sessionId"] = args.get("sessionId")
    return payload


def session_list(_args: dict[str, Any]) -> dict[str, Any]:
    """列出当前所有会话（不含任何凭据）。

    :param _args: 协议参数，本方法不用
    :returns: 会话列表
    """
    return {
        "sessions": [
            {
                "sessionId": session_id,
                "sessionType": entry["type"],
                "createdAt": entry["created_at"],
            }
            for session_id, entry in _SESSIONS.items()
        ]
    }


def _close_entry(session_id: str) -> None:
    """关掉一个会话并从注册表移除。

    :param session_id: 会话 id
    """
    entry = _SESSIONS.pop(session_id, None)
    if entry is None:
        return
    try:
        entry["closer"].close() if entry["type"] != "static" else entry["closer"].__exit__(None, None, None)
    except Exception:  # noqa: BLE001 —— 关不掉也不能让桥接层挂掉
        pass


def session_close(args: dict[str, Any]) -> dict[str, Any]:
    """关掉一个会话。

    :param args: 协议参数
    :returns: 关闭结果
    """
    session_id = args.get("sessionId")
    _get_session(session_id)
    _close_entry(session_id)
    return {"sessionId": session_id, "closed": True}


def close_all_sessions() -> None:
    """关掉全部会话。进程退出与 sidecar 重启时调用。

    浏览器会话留着不管的话，Chromium 进程会活过 sidecar 本身。
    """
    for session_id in list(_SESSIONS):
        _close_entry(session_id)


# 爬虫放在独立模块：它要 import 本模块的 AdapterError，放进来就得绕开循环依赖。
from crawl import METHODS as CRAWL_METHODS  # noqa: E402

METHODS.update(
    {
        "session.open": session_open,
        "session.fetch": session_fetch,
        "session.list": session_list,
        "session.close": session_close,
    }
)
METHODS.update(CRAWL_METHODS)
