"""py/adapters.py —— Scrapling 各引擎的薄封装。

只做三件事：把协议里的参数映射到 Scrapling 的调用、把 ``Response`` 归一成一份可
JSON 序列化的字典、把 Scrapling 的异常翻译成协议错误码。**不掺策略判断** —— URL 的
安全判定由 Host 侧与 guard.py 各做一遍，这里只负责「按调度好的方式把请求打出去」。

引擎对照（``scrapling/fetchers/``）::

    Fetcher             curl_cffi 静态抓取，只有 get/post/put/delete，没有 fetch()
    StealthyFetcher     patchright Chromium

Scrapling 0.5 删掉了纯 Playwright 后端（``DynamicFetcher``/``DynamicSession``），
浏览器抓取只剩上面那一套，所以本模块不再有「普通浏览器 / 反检测浏览器」两档。

两者的返回都是 ``Response``，而 ``Response`` 继承 ``Selector``，所以抓完可以直接
css/xpath。浏览器引擎是**一次性 session**：每次调用开进程、结束即关。会话复用
必须走 ``*Session`` 类（``scrapling.fetchers`` 导出），不能靠本模块复用。
"""

from __future__ import annotations

import concurrent.futures
import contextlib
import queue
import re
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import guard

# Scrapling 缺失时不要让整个 sidecar 起不来：桥接层会把它报成能力缺失，
# 而不是让 Host 侧只看到一个「进程崩了」。
try:  # pragma: no cover —— 取决于运行环境是否装了 scrapling
    from scrapling.fetchers import Fetcher, StealthyFetcher
except ImportError:  # pragma: no cover
    # 两个 ignore 各管一件事：misc 是「不能给类型赋值」，assignment 是「None 不是类」。
    Fetcher = StealthyFetcher = None  # type: ignore[misc,assignment]

SCRAPLING_AVAILABLE = Fetcher is not None

DEFAULT_EXTRACTION = "markdown"
DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_MAX_CONTENT_CHARS = 200_000
# 一次读网络历史最多回多少条、单条正文最多回多少字符。上游为每条响应体存下的是 1 MiB
# 量级，而这份摘要是给模型看的 —— 两个预算都由本包定，不由上游存了多少决定。
DEFAULT_NETWORK_ENTRIES = 50
DEFAULT_NETWORK_BODY_CHARS = 20_000
EXTRACTION_TYPES = ("markdown", "html", "text")
# adaptive 指纹库的文件名。**相对路径**：bridge 由宿主以部署侧的 dataDir 为工作目录拉起
# （见 host.ts 的 sidecar env），相对路径正好把库落进 dataDir —— Scrapling 自己的默认值
# 是包目录内的绝对路径，那在只读的 site-packages 里写不了，也不是用户该找的地方。
ADAPTIVE_STORAGE_FILE = "elements_storage.db"


class AdapterError(RuntimeError):
    """带机器可读错误码的抓取失败。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _require(engine: object) -> None:
    """引擎不可用时给出可执行的提示，而不是抛一个裸 AttributeError。"""
    if engine is None:
        # 带上解释器路径：装在哪份 Python 里是这条错误的全部信息量，而用户手上通常不止一份。
        raise AdapterError(
            "SCRAPLING_MISSING",
            f'Scrapling is not importable in {sys.executable}. Install it with: pip install "scrapling[rag]"',
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


# 查询串里这些名字的参数装的是凭据而不是筛选条件。XHR 摘要是**给模型看的**——它进会话
# 上下文、进日志、进第三方 provider——而真实站点把 access token、会话 id、签名都放在
# 查询串里。抓到一条就等于把凭据抄进上下文，而模型既用不上它、也拦不住它被复述出来。
# 值的部分一律换成固定占位符：定位接口靠的是路径与参数名，不是那个 token。
_SECRET_QUERY_KEYS = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "auth",
        "auth_token",
        "authorization",
        "code",
        "credential",
        "id_token",
        "key",
        "password",
        "pwd",
        "refresh_token",
        "secret",
        "session",
        "sessionid",
        "session_id",
        "sig",
        "signature",
        "sign",
        "token",
    }
)


def _redacted_query(text: str) -> str:
    """把一段查询串里像凭据的参数值换成占位符；没有命中时原样返回。

    与 :func:`redact_url_secrets` 同一套参数名判据，片段也复用它 —— OAuth2 隐式流程把
    令牌放在 ``#access_token=`` 里，那同样是「给模型看就等于抄进上下文」的凭据。

    :param text: 查询串（或片段的查询部分）
    :returns: 脱敏后的文本
    """
    if not text:
        return text
    pairs: list[tuple[str, str]] = []
    changed = False
    for name, value in parse_qsl(text, keep_blank_values=True):
        if name.strip().lower() in _SECRET_QUERY_KEYS:
            pairs.append((name, "<redacted>"))
            changed = True
        else:
            pairs.append((name, value))
    if not changed:
        return text
    return urlencode(pairs)


def _redacted_fragment(fragment: str) -> str:
    """把片段里像查询串的那一段脱敏；没有命中时原样返回。

    片段有两种藏令牌的写法：OAuth2 隐式流程把整个片段当查询串（``#access_token=…``），
    单页应用的路由则是先路径后查询（``#!/list?token=…``）。两种都要覆盖。

    :param fragment: URL 的 fragment 段
    :returns: 脱敏后的 fragment
    """
    head, separator, query = fragment.partition("?")
    if separator:
        return f"{head}?{_redacted_query(query)}"
    return _redacted_query(fragment)


def redact_url_secrets(raw: str) -> str:
    """把 URL 里像凭据的部分替换成占位符。

    三处各藏一类凭据：查询串与片段的查询部分按**参数名**判（真实站点把 access token、
    会话 id、签名放在那里），authority 里的 ``user:pass@`` 整段丢掉（代理与 Basic 认证
    的接口都爱这么写）。值的部分一律换成固定占位符：定位接口靠的是路径与参数名，不是
    那个 token。

    只按参数名判断、不看值 —— 值本身无法可靠判定（短 token 与普通 id 长得一样）。
    认不出来的参数原样保留：把 ``?page=2`` 也涂掉只会让摘要失去意义，而那不是凭据。

    :param raw: 原始 URL
    :returns: 已脱敏的 URL；解析不出或没有可脱敏的部分时原样返回
    """
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return raw
    # rpartition 取最后一段：IPv6 字面量与端口都留在主机那一侧，只把用户信息摘掉。
    netloc = parsed.netloc.rpartition("@")[2]
    query = _redacted_query(parsed.query)
    fragment = _redacted_fragment(parsed.fragment)
    if netloc == parsed.netloc and query == parsed.query and fragment == parsed.fragment:
        return raw
    return urlunsplit((parsed.scheme, netloc, parsed.path, query, fragment))


def _network_summary(
    network: Any,  # noqa: ANN401 —— 上游的 NetworkRecorder
    *,
    pattern: str | None,
    limit: int,
    include_body: bool,
    max_body_chars: int,
) -> list[dict[str, Any]]:
    """把会话网络历史压成给模型看的条目。

    只取 XHR/fetch 与 HTTP 错误（``include_static=False``）：这条路径的用途是「页面数据来自
    接口而不是 DOM 时，找到那个接口」，静态资源只会把列表淹掉。

    正文只在显式要求时回传，并按 ``max_body_chars`` 逐条截断 —— 上游为每条响应体设了
    1 MiB、会话总量 20 MiB 的硬上限，那几十倍于模型预算的量级不该由「上游记了什么」决定
    「模型看见什么」。没存下正文时上游会在 ``meta['body_note']`` 里写原因，一并带出去，
    这样「这条接口没正文」与「这个接口本来就空」不是同一件事。

    URL 里的凭据型查询参数在这一层就脱敏：这份摘要是给模型看的，而模型用不上一个
    access token 却会把整条 URL 原样复述出去。
    """
    summary: list[dict[str, Any]] = []
    try:
        records = network.search(url_pattern=pattern, limit=limit, include_static=False)
    except Exception:  # noqa: BLE001 —— 记录器未启用或上游改了口径：当成「没有历史」
        return summary
    for item in records:
        try:
            meta = item.meta if isinstance(item.meta, dict) else {}
            body = item.body
            entry: dict[str, Any] = {
                "url": redact_url_secrets(str(item.url)),
                "status": item.status,
                "bytes": len(body),
                "method": str(meta.get("method") or item.request_headers.get("method") or "GET"),
                "resourceType": str(meta.get("resource_type") or ""),
            }
            if not body:
                note = meta.get("body_note")
                if isinstance(note, str) and note:
                    entry["bodyNote"] = note
            elif include_body:
                text = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body)
                clipped, truncated = clip(text, max_body_chars)
                entry["body"] = clipped
                if truncated:
                    entry["bodyTruncated"] = True
            summary.append(entry)
        except Exception:  # noqa: BLE001 —— 单条摘要失败不该拖垮整次读取
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
        # meta refresh 能把浏览器导航到内网地址；base 的 href 指挥相对地址怎么解析、
        # 同样只影响解析而不贡献内容，两者都整段清掉属性。meta 只清带了 http-equiv 的
        # （charset 声明无害且有用），base 不看属性名 —— <base href> 没有 http-equiv，
        # 按属性名判它就永远清不到。
        if tag == "base" or (tag == "meta" and "http-equiv" in attrib):
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


def _scoped_pages(page: Any, css_selector: str | None) -> list[Any]:  # noqa: ANN401 —— 同上
    """按 ``css_selector`` 把清洗过的树收窄成若干棵子树；没给选择器就是整棵。

    口径与 Scrapling 自家 ``Convertor._extract_content`` 一致：命中 0 个元素就是空表，
    三条提取路径都据此产出空正文 —— **不回退成整页**。此前只有 markdown 那条路径
    （``Response.markdown``）吃选择器，html/text 拿到它却悄悄忽略、返回整页，模型无从
    发现自己要的东西没被收窄。

    :param page: 已清洗的页面树
    :param css_selector: 收窄用的 CSS 选择器；None 或空串表示不收窄
    :returns: 待提取的元素列表
    """
    if not css_selector:
        return [page]
    return list(page.css(css_selector))


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
        content = "\n".join(element.html_content for element in _scoped_pages(page, css_selector))
    elif extraction_type == "text":
        page = _sanitized_page(response, main_content_only=main_content_only)
        content = "\n".join(
            element.get_all_text(
                strip=True,
                ignore_tags=("script", "style", "noscript", "svg", "iframe"),
            )
            for element in _scoped_pages(page, css_selector)
        )
    else:
        content = response.markdown(css_selector=css_selector, main_content_only=main_content_only)

    text = str(content)
    # 先剥再封顶：被剥掉的那几十 KB 不该占 max_content_chars 的额度，否则一页内联图就能把
    # 真正文挤出预算 —— 顺序反了等于白剥。
    if strip_inline_images:
        text = drop_data_uris(text, html=extraction_type == "html")
    clipped, truncated = clip(text, max_content_chars)
    payload: dict[str, Any] = {
        "url": response.url,
        "status": response.status,
        "extractionType": extraction_type,
        "content": clipped,
        "truncated": truncated,
        "redirects": len(getattr(response, "history", ()) or ()),
    }
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
        "timeout": _positive_number(args.get("timeoutSeconds"), "timeoutSeconds", DEFAULT_TIMEOUT_SECONDS),
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
    :raises AdapterError: 方法不支持、部署未开放写方法，或抓取失败
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
    if method != "GET" and not guard.ALLOW_WRITE_METHODS:
        # 这一侧是硬拒，不依赖 Host 有没有把入参摆出来：手搓一帧 stdin 也写不出去。
        raise AdapterError(
            "WRITE_DISABLED",
            f"{method} changes state on the remote side; the deployment must set "
            f"allowWriteMethods (env {guard.ALLOW_WRITE_METHODS_ENV}) to allow it",
        )
    if method != "GET":
        body = args.get("body")
        if isinstance(body, str):
            params["data"] = body
        elif body is not None:
            # 数组、数字、布尔也是合法的 JSON 请求体（curl_cffi 的 ``json=`` 照收）。此前只有
            # dict 走 json、str 走 data，其余**静默丢弃** —— 模型发一个 `body: [1, 2]`，请求照
            # 发、对端收到空体，而回包上没有一行能看出这件事。
            params["json"] = _jsonable(body)

    # Host 侧闸门判过之后到 curl_cffi 真解析、真建连之间隔着一个进程边界（TOCTOU），
    # 所以这里在发车之前用同一份 guard 复判一次 —— 浏览器路径由 page.route 逐请求兜住，
    # 静态路径没有那一层，不在这里补就是「两道防线」只说了一半。判在写方法之后：那一条是
    # 部署表态（非 GET 一律拒），与目标地址无关，不该被一条 URL_BLOCKED 盖掉。
    allowed, reason = guard.url_allowed(url)
    if not allowed:
        raise AdapterError("URL_BLOCKED", f"{url}: {reason}")
    response = getattr(Fetcher, method.lower())(url, **params)
    return to_payload(
        response,
        extraction_type=extraction_type,
        css_selector=css_selector,
        main_content_only=main_content_only,
        max_content_chars=limit,
        strip_inline_images=_strip_inline_images(args),
    )


def _url_pattern(args: dict[str, Any]) -> str | None:
    """取网络历史的 URL 过滤正则，并确认它编译得过。

    上游 ``NetworkRecorder.search`` 拿它做 ``re.compile``，编译不过会抛 ValueError；那一层
    报的是「Invalid URL pattern: ...」，读的人看不出根因是自己正则写错了。所以在读历史
    之前就地判。

    :param args: 协议参数
    :returns: 正则文本；没给或为空串时给 None（上游据此不过滤）
    :raises AdapterError: 正则编译不过
    """
    raw = args.get("urlPattern")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        re.compile(raw)
    except re.error as error:
        raise AdapterError("BAD_ARGS", f"urlPattern is not a valid regex: {error}") from error
    return raw


# ``StealthySession.fetch`` 只认这份名单（上游 ``engines/_browsers/_validators.py`` 的
# ``_fetch_params`` 字段，外加实现自己 ``pop`` 出来的 ``proxy``）。名单之外的键**不报错、
# 不生效**：``validate_fetch`` 只从 kwargs 里挑认识的字段，其余原样丢掉。
#
# 所以会话路径上必须按层级分家：这些键在 fetch 层传了等于没传，唯一生效的地方是会话构造
# （``StealthySession(...)``）。``py/tests/contract_probe.py`` 会拿真实上游校验这张表与
# ``_fetch_params`` 是否仍然一致。
FETCH_LEVEL_KEYS = frozenset(
    {
        "blocked_domains",
        "disable_resources",
        "extra_headers",
        "google_search",
        "load_dom",
        "network_idle",
        "page_action",
        "page_setup",
        "pierce_shadow",
        "proxy",
        "selector_config",
        "solve_cloudflare",
        "timeout",
        "wait",
        "wait_selector",
        "wait_selector_state",
    }
)

# 只有会话构造才吃的那些键：从 fetch 层传过去必然被静默丢弃，因此要么在这里进会话，
# 要么就根本别发。
#
# 这张表是**上游的事实**而不是本包的透传清单：`max_pages` / `retries` / `retry_delay` 上游
# 确实是构造期参数，但本包一个都不发（各自没有对应的部署设置），所以它们在
# `_browser_params` 的产物里根本不出现 —— 过滤器对它们是无操作，留着是为了让
# `py/tests/contract_probe.py` 能拿整张表与上游字段面比对，而不是只比对我们用到的那几项。
#
# `record_requests` / `max_recorded_requests` 是 0.5 用会话网络历史替代 `capture_xhr` 之后
# 新增的两枚：它们**只**在构造期生效，逐次 fetch 传等于没传（这正是那个替代方案的核心）。
SESSION_ONLY_KEYS = frozenset(
    {
        "allow_webgl",
        "block_ads",
        "block_webrtc",
        "cdp_url",
        "dns_over_https",
        "executable_path",
        "headless",
        "hide_canvas",
        "init_script",
        "locale",
        "max_pages",
        "max_recorded_requests",
        "real_chrome",
        "record_requests",
        "retries",
        "retry_delay",
        "timezone_id",
        "useragent",
        "user_data_dir",
    }
)


# 部署命名空间里的浏览器旋钮：源键 → 引擎参数名 → 期望类型。类型逐项写死，是因为这一层
# 与模型入参走同一条通道而它承载的是**部署表态**：类型错了静默生效比报错更糟（例如
# maxRecordedRequests 收到字符串，上游会拿它当容量直接炸会话构造）。
_DEPLOYMENT_KNOBS: tuple[tuple[str, str, type], ...] = (
    ("browserExecutablePath", "executable_path", str),
    ("browserCdpUrl", "cdp_url", str),
    ("browserInitScript", "init_script", str),
    ("browserRealChrome", "real_chrome", bool),
    ("browserDnsOverHttps", "dns_over_https", bool),
    ("recordRequests", "record_requests", bool),
    ("maxRecordedRequests", "max_recorded_requests", int),
)


def _knob_value(kind: type, value: Any) -> Any:  # noqa: ANN401 —— 收的是部署载荷里的任意 JSON 值
    """按声明的类型收下一枚部署旋钮值；类型不符给 None。

    类型必须真的对得上：这一层承载的是部署表态，把字符串塞进一个整数旋钮（或反过来）时
    静默生效比报错更糟 —— 上游会拿它当参数，直接把会话构造炸掉。
    """
    if kind is str:
        return value if isinstance(value, str) and value else None
    if kind is bool:
        return value if isinstance(value, bool) else None
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def _browser_params(args: dict[str, Any], url: str, *, level: str = "session") -> dict[str, Any]:
    """浏览器抓取的公共参数。

    ``level`` 决定这份参数**送给哪一层**：一次性抓取（``StealthyFetcher.fetch``）与会话构造
    收的是完整的会话级参数面；而会话内每次 fetch 只认 ``FETCH_LEVEL_KEYS`` 那十几个键，其余
    一律被上游静默丢弃（见上面那张表的注释）。所以 ``level="fetch"`` 时按名单过滤 ——
    宁可少发一个键，也不要发一个「看起来在生效其实没生效」的键：后者的排查成本是整条链路。

    WebRTC 防泄露只走 ``block_webrtc`` 开关本身。0.4.15 时代这里还要往启动参数里塞两条
    flag，因为那时的 ``config.extra_flags`` 会**顶掉**内建那套反检测 flag；0.5 把它改成
    叠加（上游 PR #430），而浏览器抓取也只剩 patchright 一套，``block_webrtc`` 一条开关
    两件事都覆盖，于是那条绕行路径连同它要回避的坑一起消失。

    ``block_ads`` 由部署设置决定，可以打开：它并不会与 SSRF 守卫抢 handler。
    上游把 ``block_ads`` 折进**同一个** ``blocked_domains``（engines/_browsers/
    _validators.py），交给 engines/_browsers/_base.py 里那一个
    ``create_intercept_handler``；而那个 handler 是在 ``page_setup`` **之前**注册的，
    守卫在 ``page_setup`` 里后注册、因而先跑。守卫放行时走 ``route.fallback()``
    （不是 ``continue_()``），所以上游的拦截能叠加在守卫判定之上，SSRF 那一道不受影响。

    ``blocked_domains`` / ``disable_resources`` 仍固定关闭：本包没有对应的部署设置，
    而打开它们同样只是给上游那个 handler 加料，不会削弱守卫。

    代理在这里显式交给引擎，是浏览器这条路径上唯一必须这么做的地方：Chromium 不读
    ``HTTP_PROXY``/``ALL_PROXY``，只读系统代理设置，于是一台只在 shell 里 export 过代理
    的机器上静态抓取走代理、浏览器抓取却直连。传 ``proxy`` 给 ``StealthyFetcher.fetch``
    时它落进**会话**配置（fetchers/stealth_chrome.py 里是 ``StealthySession(**kwargs)``），
    进 ``launch_persistent_context`` 的 context 选项 —— 所以是一次抓取一个 context，
    与一次性会话的既有形态一致，且不会丢 cookie。

    :param args: 协议参数
    :param url: 本次抓取的地址，用来定代理
    :param level: ``session``（会话级全量）或 ``fetch``（只发 fetch 层认得的键）
    :returns: 引擎参数
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
    if args.get("networkIdle"):
        params["network_idle"] = True
    for key, name in (
        ("waitSelector", "wait_selector"),
        ("waitSelectorState", "wait_selector_state"),
        ("useragent", "useragent"),
        ("locale", "locale"),
        ("timezoneId", "timezone_id"),
    ):
        value = args.get(key)
        if isinstance(value, str) and value:
            params[name] = value
    # open shadow root 里的内容默认不进正文 —— 页面把那部分内容藏在 shadow 里时，
    # 不打开这个开关在 HTML 里根本看不到它。
    if args.get("pierceShadow"):
        params["pierce_shadow"] = True
    deployment = args.get("deployment")
    if isinstance(deployment, dict):
        for source, target, kind in _DEPLOYMENT_KNOBS:
            value = _knob_value(kind, deployment.get(source))
            if value is not None:
                params[target] = value
    wait_ms = args.get("waitMs")
    if isinstance(wait_ms, (int, float)) and not isinstance(wait_ms, bool) and wait_ms > 0:
        params["wait"] = wait_ms
    extra_headers = _string_map(args.get("extraHeaders"), "extraHeaders")
    if extra_headers is not None:
        params["extra_headers"] = extra_headers
    # 四条反检测参数只在浏览器那套的参数面里。solve_cloudflare 逐次 fetch 也认，其余三条
    # 只有会话构造认 —— 两层的分家由上面那两张名单做。
    params["solve_cloudflare"] = bool(args.get("solveCloudflare", False))
    params["hide_canvas"] = bool(args.get("hideCanvas", False))
    # 走代理时强制为真，不看模型入参：WebRTC 泄露的是访客的真实出口 IP，而访客用这个
    # 插件正是为了不泄露它。
    params["block_webrtc"] = bool(args.get("blockWebrtc", False)) or "proxy" in params
    params["allow_webgl"] = bool(args.get("allowWebgl", True))
    if level == "fetch":
        return {key: value for key, value in params.items() if key in FETCH_LEVEL_KEYS}
    return params


def _session_browser_params(args: dict[str, Any]) -> dict[str, Any]:
    """会话构造期的浏览器参数：只收**只有开场才生效**的那些键。

    会话内每次 fetch 传 ``block_ads`` / ``record_requests`` / ``executable_path`` /
    ``cdp_url`` / ``locale`` / ``timezone_id`` / ``useragent`` / ``headless`` 都会被
    ``validate_fetch`` 丢掉，于是设置卡上这些旋钮对会话路径完全不生效 —— 而且不报错。
    这里把它们挪到唯一生效的位置。

    代理不在这张表里：会话的代理在开场时按 ``default_proxy()`` 定一次（中途换代理要新建
    context，等于丢掉 cookie 与登录态，而那正是会话存在的理由），见 :func:`_make_session`。

    :param args: 协议参数
    :returns: 会话构造参数
    """
    # url 只用来定代理，而会话级代理另在 _make_session 里定，这里给空串即可。
    full = _browser_params(args, "")
    # timeout 在两层都认，会话构造必须带上它，否则整个会话回落到上游的 30s 页面超时。
    keep = SESSION_ONLY_KEYS | {"timeout"}
    return {key: value for key, value in full.items() if key in keep}


def render(args: dict[str, Any]) -> dict[str, Any]:
    """浏览器抓取（patchright）。0.5 起这是唯一的浏览器引擎。

    :param args: 协议参数
    :returns: 归一后的载荷
    """
    _require(StealthyFetcher)
    url = _url(args)
    extraction_type, css_selector, main_content_only, limit = _extraction(args)

    params = _browser_params(args, url)
    params["page_setup"] = page_setup
    response = StealthyFetcher.fetch(url, **params)
    return to_payload(
        response,
        extraction_type=extraction_type,
        css_selector=css_selector,
        main_content_only=main_content_only,
        max_content_chars=limit,
        strip_inline_images=_strip_inline_images(args),
    )


def _network_read(args: dict[str, Any]) -> tuple[str | None, int, bool, int]:
    """抽出「读网络历史」的四个参数并校验。

    :param args: 协议参数
    :returns: (URL 过滤正则, 条数上限, 是否回传正文, 单条正文预算)
    """
    return (
        _url_pattern(args),
        _positive_int(args.get("networkLimit"), "networkLimit", DEFAULT_NETWORK_ENTRIES),
        bool(args.get("includeBody", False)),
        _positive_int(args.get("maxBodyChars"), "maxBodyChars", DEFAULT_NETWORK_BODY_CHARS),
    )


def _capture_once(
    args: dict[str, Any],
    *,
    url: str,
    pattern: str | None,
    entries: int,
    include_body: bool,
    body_chars: int,
) -> tuple[Any, list[dict[str, Any]]]:
    """在一个临时会话里抓一次，并把这次抓取记下的网络条目一起读出来。

    记录开关在这条路径上**不跟随部署设置**：这个方法的全部意义就是那份历史，不开记录
    等于白抓一次。容量（``max_recorded_requests``）仍由部署设置决定。

    :param args: 协议参数
    :param url: 要抓的地址
    :param pattern: URL 过滤正则
    :param entries: 最多回多少条
    :param include_body: 是否回传响应体
    :param body_chars: 单条正文的字符预算
    :returns: (response, 网络条目)
    """
    from scrapling.fetchers import StealthySession

    session_params = _session_browser_params(args)
    session_params["record_requests"] = True
    fetch_params = _browser_params(args, url, level="fetch")
    # 会话的代理在构造期就定死了，逐次 fetch 再给一次只会被上游丢掉。
    fetch_params.pop("proxy", None)
    fetch_params["page_setup"] = page_setup
    session = StealthySession(**session_params)
    try:
        session.start()
        response = session.fetch(url, **fetch_params)
        records = _network_summary(
            session.network,
            pattern=pattern,
            limit=entries,
            include_body=include_body,
            max_body_chars=body_chars,
        )
    finally:
        # 这条会话不进注册表，所以没有别人会替它收尸 —— 成败都要在这里关掉。
        with contextlib.suppress(Exception):
            session.close()
    return response, records


def capture(args: dict[str, Any]) -> dict[str, Any]:
    """抓一个 URL，并把这次抓取记下的 XHR/fetch 一起交回去。

    0.5 删掉了 ``capture_xhr``：一次性 fetch 的响应上不再挂 XHR 列表，替代方案是「会话
    构造期打开 ``record_requests``，之后读 ``session.network``」。所以这条路径自己起一个
    会话 —— 但对模型仍然是一次动作：就地开、就地关，不进会话注册表，既不占会话名额，
    也不会把 cookie 留到下一次调用。

    :param args: 协议参数
    :returns: 页面载荷，外加这次抓取记下的网络条目
    :raises AdapterError: 参数非法，或抓取失败
    """
    _require(StealthyFetcher)
    url = _url(args)
    extraction_type, css_selector, main_content_only, limit = _extraction(args)
    pattern, entries, include_body, body_chars = _network_read(args)

    # 整条链路投到一条专属线程上：patchright 的同步 API 与创建它的线程绑定（greenlet），
    # 而 bridge 的 worker 线程是「谁抢到帧谁处理」，所以这里建一条自己的、用完就收。
    worker = _SessionWorker()
    try:
        response, records = worker.run(
            lambda: _capture_once(
                args,
                url=url,
                pattern=pattern,
                entries=entries,
                include_body=include_body,
                body_chars=body_chars,
            )
        )
    finally:
        worker.stop()

    payload = to_payload(
        response,
        extraction_type=extraction_type,
        css_selector=css_selector,
        main_content_only=main_content_only,
        max_content_chars=limit,
        strip_inline_images=_strip_inline_images(args),
    )
    payload["xhr"] = records
    return payload


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

    ``adaptive`` 打开时走 Scrapling 的自愈选择器：命中成功就把首个元素的指纹存库，
    站点改版后同一个选择器直接命中失败时，按指纹重定位。存储文件固定在 sidecar 的
    工作目录（部署侧的 ``dataDir``），键按 ``url`` 的注册域分桶 —— 所以重定位还要求
    给 ``url``；不给就全落在 ``default`` 桶里，跨站点共用一份指纹。

    ``maxContentChars`` 是这条路径的预算，与抓取类工具同源：``limit`` 数的是**条数**，
    而十条十万字的正文照样能把模型上下文撑爆。所以逐条累计字符，超了就地截断并置
    ``truncated`` —— 总条数与单条长度是两根独立的轴，只压一根等于没压。
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
    adaptive = bool(args.get("adaptive", False))
    url = args.get("url")
    if url is not None and not isinstance(url, str):
        raise AdapterError("BAD_ARGS", "url must be a string or null")

    if adaptive:
        # storage_args 必须把 url 一起带上：Scrapling 对「给了部分 storage_args」是整体
        # 替换而不是补齐，漏了 url 全部指纹都会落进 default 桶。url 为空时也显式传空串，
        # 存储层把它归入 default 桶（StorageSystemMixin 对空值有兜底）。
        page = Selector(
            html,
            url=url or "",
            adaptive=True,
            storage_args={"storage_file": ADAPTIVE_STORAGE_FILE, "url": url or ""},
        )
    else:
        page = Selector(html)

    # 命中成功时 auto_save 存指纹，命中失败且 adaptive 打开时按存过的指纹重定位 ——
    # 两个开关都必须在**调用**上再打开一次：Scrapling 的 adaptive 是构造器与调用两级
    # 开关，只开构造器的话，重定位会被静默跳过。
    use_xpath = bool(args.get("useXpath", False))
    if use_xpath:
        nodes = page.xpath(selector, adaptive=adaptive, auto_save=adaptive)
    else:
        nodes = page.css(selector, adaptive=adaptive, auto_save=adaptive)
    limit = _positive_int(args.get("limit"), "limit", 200)
    budget = _positive_int(args.get("maxContentChars"), "maxContentChars", DEFAULT_MAX_CONTENT_CHARS)
    include_attributes = bool(args.get("includeAttributes", False))

    matches: list[dict[str, Any]] = []
    spent = 0
    clipped = False
    for node in nodes:
        if len(matches) >= limit:
            break
        item: dict[str, Any] = {"tag": node.tag}
        field = "value" if attribute else "text"
        item[field] = str(node.attrib.get(attribute, "")) if attribute else str(node.get_all_text(strip=True))
        if include_attributes:
            item["attributes"] = {str(key): str(value) for key, value in node.attrib.items()}
        # 先按剩余额度截再计入已花：一条超长正文不该把整份预算吃光，也不该在预算只剩
        # 一位时还能整条通过。
        room = max(0, budget - spent)
        if len(item[field]) > room:
            item[field] = item[field][:room]
            clipped = True
        spent += len(item[field])
        matches.append(item)
        if spent >= budget:
            clipped = True
            break
    return {
        "count": len(nodes),
        "truncated": clipped or len(nodes) > len(matches),
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

    为什么直接用引擎而不走 ``engine.fetch``：Scrapling 的 fetch 会在 ``page.goto`` 返回
    None 时抛 "Failed to get response"，而 ``data:`` 与 ``about:blank`` 这类 URL 恰好不
    产生 response。拿它们当探针 URL 会稳定地假失败，还会被 ``retries`` 放大成几秒钟的重试
    风暴。

    要验的其实只有一件事：**浏览器二进制装没装**。``patchright install chromium`` 装的是
    patchright 自己那一份，缺了它会在真正调用时才炸。

    :param module_name - 要探的引擎模块名，目前只有 ``"patchright.sync_api"``
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
        # 写方法这一档**与 scrapling 在不在无关**：它是部署表态，而排障的人得能一眼看出
        # 「这台到底许不许写」，而不是等到发 POST 被拒才发现环境里少一个变量。
        "writeMethods": guard.ALLOW_WRITE_METHODS,
    }
    if not SCRAPLING_AVAILABLE:
        return report
    report["version"] = _scrapling_version()
    # 0.5 只剩 patchright 那一套浏览器，所以这一项就是「浏览器抓取能不能用」的全部答案 ——
    # 0.4.15 时代那两个「普通浏览器 / 反检测浏览器」各自探测的口径已经没有第二个引擎可标。
    report["browser"] = _probe_browser("patchright.sync_api")
    # 出口如实上报：用户得能一眼看出抓取会从哪里出去、以及本包到底有没有在管这件事。
    # server 只含 scheme://host:port，凭据不出现（见 guard.proxy_settings）。
    report["proxy"] = guard.proxy_settings()
    return report


METHODS = {
    "ping": lambda _args: {"pong": True},
    "capabilities": lambda _args: capabilities(),
    "fetch": fetch,
    "render": render,
    "capture": capture,
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
# 两种类型与 Scrapling 的一一对应：
#   static  -> FetcherSession（curl_cffi）
#   stealth -> StealthySession（patchright，0.5 起唯一的浏览器引擎）
# ---------------------------------------------------------------------------

_SESSION_CLASSES = {
    "static": "FetcherSession",
    "stealth": "StealthySession",
}

# 吃内存的那几类（每个都是一个真实浏览器进程）：名额与专属执行线程都按它判。
_BROWSER_KINDS = frozenset({"stealth"})

# 会话注册表。sidecar 是常驻进程，这里就是它的内存；进程退出时全部随之消失。
# 值里存 {"session": <对象>, "type": <str>, "created_at": <iso8601>, "lock": Lock,
# "worker": _SessionWorker | None}；正在构造中的条目只有
# {"pending": True, "type": <str>, "lock": Lock}，那样它就已经占了名额。
# lock 从占位那一刻就存在，所以构造期与使用期是同一把锁；worker 只在 browser/stealth
# 上出现（见下），static 为 None。
_SESSIONS: dict[str, dict[str, Any]] = {}

# bridge 有多个 worker 线程，注册表从它们手里并发读写。判重与判名额必须原子，否则并发
# 的 session_open 会各自判完再各自开出一个会话 —— id 重复时后者覆盖前者（漏一个已经在
# 跑的 Chromium），名额判完再开等于没判。
_SESSION_LOCK = threading.Lock()

# 同开几个会话。浏览器会话每开一个就是一个真实的 Chromium 进程，而 sessionType 是
# **模型可选**的参数 —— 不设上限的话，「开 → 不关」重复几次就能把机器的内存吃光。
# 因此在登记之前就判，而不是指望模型记得调 session_close。
MAX_SESSIONS = 8
# 其中最多几个可以是吃内存的浏览器会话。static 只是连接池，便宜得多。
MAX_BROWSER_SESSIONS = 3


class _SessionWorker:
    """一个会话的**专属执行线程**：这份会话上的全部远端调用都在它上面排队执行。

    为什么必须有它：Playwright 的同步 API 靠 greenlet 与创建线程绑定 —— sync 对象上
    任何一次远端调用都必须发生在 ``sync_playwright()`` 所在的那个 OS 线程，换线程直接
    ``greenlet.error: cannot switch to a different thread``。而 bridge 的 worker 是
    「谁抢到帧谁处理」，还会空闲 50ms 就退出换新线程：会话在 A 线程里开、下一个请求
    几乎必然落在 B 线程。按会话加锁只能保证「不同时用」，保证不了「同一线程用」——
    所以每个 browser/stealth 会话配一条专用线程，open/fetch/close 全部投递到它，
    串行执行；调用线程原地等结果。static（curl_cffi）没有线程亲和，不走这套。
    """

    def __init__(self) -> None:
        self._jobs: "queue.SimpleQueue[tuple[Callable[[], Any], concurrent.futures.Future[Any]] | None]"
        self._jobs = queue.SimpleQueue()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="session-worker")
        self._thread.start()

    def _loop(self) -> None:
        """取任务、执行、回填结果；收到哨兵就退出。

        每个任务的异常原样塞回 Future：调用方在 ``run`` 里等到的就是它自己那次调用的错。
        """
        while True:
            job = self._jobs.get()
            if job is None:
                return
            fn, done = job
            try:
                done.set_result(fn())
            except BaseException as error:  # noqa: BLE001 —— 任务异常必须回到调用方线程
                done.set_exception(error)

    def run(self, fn: Callable[[], Any]) -> Any:  # noqa: ANN401 —— 会话调用的返回形态由引擎定
        """把 fn 投递到属主线程执行，并阻塞调用线程直到它结束。

        :param fn: 要在属主线程上执行的调用
        :returns: fn 的返回值
        :raises BaseException: fn 抛什么这里就抛什么
        """
        done: concurrent.futures.Future[Any] = concurrent.futures.Future()
        self._jobs.put((fn, done))
        return done.result()

    def stop(self) -> None:
        """发哨兵收线程。队列里的任务会先跑完，所以 close 之后 stop 是安全的。"""
        self._jobs.put(None)
        self._thread.join(timeout=5.0)


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

    from scrapling.fetchers import StealthySession

    # 只有开场才生效的那些设置（block_ads / record_requests / headless / locale /
    # timezone_id / useragent / executable_path / cdp_url / timeout）必须在这里进会话：
    # fetch 层传过去会被 validate_fetch 静默丢掉（见 FETCH_LEVEL_KEYS）。
    common: dict[str, Any] = _session_browser_params(args)
    # 每会话的记录开关：模型可以为这一次会话打开记录（部署侧那枚是默认值）。记录不改变
    # 请求行为，只是把已经发生的流量留在内存里，所以它不是部署级强能力。
    if args.get("recordNetwork") is True:
        common["record_requests"] = True
    # 会话开的时候还不知道要访问哪个主机，所以按「配了代理就用代理」定档；显式填过
    # proxyBypass 的主机在会话里也跟着走代理 —— 见上面的取舍说明。
    proxy = guard.split_proxy(guard.default_proxy())
    if proxy is not None:
        common["proxy"] = proxy
    # 走代理时强制为真，不看模型入参：WebRTC 泄露的是访客的真实出口 IP，而访客用这个
    # 插件正是为了不泄露它。
    #
    # 判据**只能**是这里算出的那份 proxy：`_session_browser_params` 里那条是按
    # `browser_proxy("")` 定的，而空 URL 没有主机名，绕过清单里的任何主机名条目都命中
    # 不了它 —— 只有 `default_proxy()` 认的那个「整台机器直连」的 `*` 例外。于是
    # `proxyBypass=*` 时上面那条会算出「有代理」并把 block_webrtc 钉成真，而会话其实
    # 是直连的：模型明确填了 blockWebrtc=false 也会被静默盖掉。
    # 这里整体重写，不继承那份结论。
    common["block_webrtc"] = bool(args.get("blockWebrtc")) or proxy is not None
    session = StealthySession(**common)
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
    if kind in _BROWSER_KINDS:
        browsers = sum(1 for entry in _SESSIONS.values() if entry["type"] in _BROWSER_KINDS)
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

    # 「判重复 + 判名额 + 占位」三步必须原子。sidecar 有多个 worker 线程：并发的
    # session_open 各自判完再各自开 —— 于是 id 重复时后者覆盖前者（漏一个已经在跑的
    # Chromium），名额判完再开等于没判（开满 8 个之后还能继续开）。开一个浏览器要几百
    # 毫秒，这个窗口足够宽。所以先在锁里占位，真正的构造放在锁外。
    with _SESSION_LOCK:
        if session_id in _SESSIONS:
            raise AdapterError("BAD_ARGS", f"session already exists: {session_id}")
        _enforce_session_limits(kind)
        # 锁在占位时就建好：构造期占用的也是它，所以「造到一半」与「用着」互斥。
        placeholder = {"pending": True, "type": kind, "lock": threading.Lock()}
        _SESSIONS[session_id] = placeholder
    entry_lock = placeholder["lock"]

    # browser/stealth 先起属主线程，构造（含 sync_playwright 的启动）整个发生在它上面
    # —— greenlet 绑定从此指向这条线程，之后每次 fetch/close 都投递回来。static 没有
    # 线程亲和，留在调用线程即可。
    worker: _SessionWorker | None = None
    try:
        if kind == "static":
            usable, closer = _make_session(kind, args)
        else:
            worker = _SessionWorker()
            usable, closer = worker.run(lambda: _make_session(kind, args))
    except BaseException as error:
        if worker is not None:
            worker.stop()
        with _SESSION_LOCK:
            _SESSIONS.pop(session_id, None)
        if isinstance(error, AdapterError):
            raise
        raise AdapterError("SESSION_OPEN_FAILED", f"{type(error).__name__}: {error}") from error

    with _SESSION_LOCK:
        abandoned = placeholder.get("closed_while_pending") is True
        if abandoned:
            created_at = ""
        else:
            _SESSIONS[session_id] = {
                "session": usable,  # 真正发请求的对象
                "closer": closer,  # 关它用的对象（static 是 wrapper，浏览器是自身）
                "type": kind,
                "created_at": datetime.now(timezone.utc).isoformat(),
                # 同一把锁：占位时建的那把，盖回来而不是新建 —— 新建会让构造期与使用期各锁各的。
                "lock": entry_lock,
                # browser/stealth 的专属执行线程；static 为 None（见 _SessionWorker 的说明）。
                "worker": worker,
            }
            created_at = _SESSIONS[session_id]["created_at"]
    if abandoned:
        # 构造期间已经被要求关闭（sidecar 关机走的就是 close_all_sessions）：这一份刚建好的
        # 会话绝不能登记 —— 登记了就没有任何人会再去关它，浏览器进程会活过 sidecar 自己。
        _release_entry({"closer": closer, "type": kind, "lock": entry_lock})
        if worker is not None:
            worker.stop()
    return {
        "sessionId": session_id,
        "sessionType": kind,
        "createdAt": created_at,
    }


def _get_session(session_id: Any) -> dict[str, Any]:
    """按 id 取已登记的会话。

    正在构造中的条目也占着 id，所以「存在」不等于「可用」：拿到这种条目时明确报错，
    而不是让调用方在 entry["session"] 上撞 KeyError。

    :param session_id: 会话 id
    :returns: 登记条目
    :raises AdapterError: id 缺失、不存在，或该 id 还在构造中
    """
    if not isinstance(session_id, str) or not session_id:
        raise AdapterError("BAD_ARGS", "sessionId is required")
    with _SESSION_LOCK:
        entry = _SESSIONS.get(session_id)
        if entry is None:
            raise AdapterError("NO_SUCH_SESSION", f"no such session: {session_id}")
        if entry.get("pending") is True:
            raise AdapterError("NO_SUCH_SESSION", f"session {session_id} is still being created; retry shortly")
    return entry


def session_fetch(args: dict[str, Any]) -> dict[str, Any]:
    """用已开好的会话抓一个 URL。

    :param args: 协议参数
    :returns: 归一后的载荷
    :raises AdapterError: 会话不存在 / 类型不支持 / 抓取失败 / 把 static 专属的键给了浏览器会话
    """
    entry = _get_session(args.get("sessionId"))
    session = entry["session"]
    extraction_type, css_selector, main_content_only, limit = _extraction(args)
    url = _url(args)

    # 一份会话同一时刻只服务一个请求：static 靠 entry 锁，浏览器会话靠属主线程天然串行。
    # 两种实现也都对「多线程同时用同一份会话」零容忍 —— Playwright 的同步 API 靠 greenlet
    # 一次只服务一个线程，curl_cffi 的 Session 文档原话是「一个时刻一个会话」。表现是看不懂
    # 的崩溃，甚至是上下文串台 —— 所以在结构上就不给这个可能。
    try:
        if entry["type"] == "static":
            with entry["lock"]:
                # 与一次性 fetch 同一条复判：static 会话的请求不经过浏览器的 page.route，
                # 少了这一道，「Host 判完 → curl_cffi 自己再解析」之间就是敞开的。
                allowed, reason = guard.url_allowed(url)
                if not allowed:
                    raise AdapterError("URL_BLOCKED", f"{url}: {reason}")
                response = session.get(url, **_static_params(args, url))
        else:
            # 浏览器会话的代理在开场时就定死了（见 _make_session），这里不再逐 URL
            # 覆盖 —— 覆盖的做法是新建 context，cookie 与登录态会随之清空。
            #
            # level="fetch" 是这条路径的关键：会话内每次 fetch 只认 FETCH_LEVEL_KEYS，
            # 其余键（block_ads / record_requests / headless / locale / timezone_id /
            # useragent / executable_path / cdp_url，以及 hide_canvas / block_webrtc /
            # allow_webgl）会被 validate_fetch **静默丢掉**。那些设置已经在 session.open
            # 时经 _session_browser_params 进过会话了，这里再发一遍只会制造「拧了没反应」
            # 的假象。
            params = _browser_params(args, url, level="fetch")
            params.pop("proxy", None)
            params["page_setup"] = page_setup
            # headers / retries 只有 static 那条路读得懂（_static_params）：浏览器会话的请求头
            # 是 extra_headers，重试则是会话构造期的 config.retries。传错了不生效，而上游连
            # 一声都不抱怨 —— 这里替它抱怨，因为「拧了没反应」正是本包在消灭的那类故障，而
            # 一句 "use extraHeaders" 是模型自己能纠正的。判在参数算完之后再抛：那个顺序让
            # py/tests/contract_probe.py 的读取记录保持完整（它按「读过哪些键」出结论）。
            #
            # 空的没给（`{}` / `[]` / null）不算写意图：模型「不带任何请求头」时传的就是空表，
            # 为它报一条错等于把一个无害的调用说成非法。
            for key, hint in (("headers", "extraHeaders"), ("retries", "scrapling_session_open")):
                if args.get(key) not in (None, {}, []):
                    raise AdapterError(
                        "BAD_ARGS",
                        f"{key} only applies to static sessions; use {hint} for a {entry['type']} session",
                    )
            # 投递到属主线程执行：greenlet 绑定在那里（见 _SessionWorker）。排队期间调用
            # 线程原地等 —— 并发的 fetch 因此天然串行，entry 锁对浏览器会话是多余的。
            worker: _SessionWorker | None = entry["worker"]
            if worker is None:  # pragma: no cover —— 浏览器条目必有属主线程
                raise AdapterError("NO_SUCH_SESSION", "session has no owner thread")
            response = worker.run(lambda: session.fetch(url, **params))
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
    # 字典遍历期间被别的线程插入/删除会抛 RuntimeError，而那正是 bridge 多 worker 下的
    # 常态。进锁里把清单复制出来，遍历就与并发改写无关。
    with _SESSION_LOCK:
        rows = [
            {
                "sessionId": session_id,
                "sessionType": entry["type"],
                # 构造中的条目还没有创建时间；报空串而不是 KeyError。
                "createdAt": entry.get("created_at", ""),
            }
            for session_id, entry in _SESSIONS.items()
        ]
    return {"sessions": rows}


def _release_entry(entry: dict[str, Any]) -> None:
    """把一个已构造好的会话条目关掉。

    :param entry: 登记条目
    """
    # suppress 而不是 try/except/pass：关不掉也不能让桥接层挂掉，而那正是 suppress 的
    # 既有语义 —— 少一层缩进，意图也一样清楚。
    with contextlib.suppress(Exception):
        entry["closer"].close() if entry["type"] != "static" else entry["closer"].__exit__(None, None, None)


def _close_entry(session_id: Any) -> None:
    """关掉一个会话并从注册表移除。

    :param session_id: 会话 id；JSON 载荷里来的，也可能是登记表的键
    """
    with _SESSION_LOCK:
        entry = _SESSIONS.pop(session_id, None)
    if entry is None:
        return
    if entry.get("pending") is True:
        # 还没构造完：构造方自己会在成功时覆盖这一条，或在失败时把它摘掉。这里不能碰
        # closer —— 它还不存在。但必须留下墓碑：构造方一会儿会把建好的会话登记回来，
        # 那一步要看见这次关闭，否则刚建好的浏览器没有任何人会再去关它。
        entry["closed_while_pending"] = True
        return
    worker: _SessionWorker | None = entry.get("worker")
    if worker is not None:
        # 浏览器会话的 close 是一次 Playwright 远端调用，必须在属主线程上做；投递进去
        # 还天然排在在途 fetch 之后 —— 「抓取进行中收到 close」会等抓取落地再关，而
        # 不是把一次正在跑的抓取从底下抽走。
        worker.run(lambda: _release_entry(entry))
        worker.stop()
        return
    # static 没有属主线程，用 entry 锁：否则「抓取进行中收到 close」会把一次正在跑的
    # 抓取从底下抽走，而 close 那一侧看到的是一个已经拆掉的会话。
    with entry["lock"]:
        _release_entry(entry)


def session_close(args: dict[str, Any]) -> dict[str, Any]:
    """关掉一个会话。

    :param args: 协议参数
    :returns: 关闭结果
    """
    session_id = args.get("sessionId")
    # _get_session 已确认它是非空字符串；这里直接用它，而 _close_entry 的入参标 Any 是因为
    # 两个调用来源不同 —— 本条路径来自 JSON 载荷，close_all_sessions 来自登记表的键。
    _get_session(session_id)
    _close_entry(session_id)
    return {"sessionId": session_id, "closed": True}


def session_network(args: dict[str, Any]) -> dict[str, Any]:
    """读一个已开会话记下的网络历史。

    记录是**会话构造期**的开关：部署侧那枚是默认值，模型可以在 ``session.open`` 时用
    ``recordNetwork`` 为本会话打开。逐次 fetch 传不上去（见 SESSION_ONLY_KEYS）。所以没开
    记录时报一句可读的错，而不是回一个空列表 —— 「没开记录」与「这次没抓到接口」是两件
    要采取不同行动的事。

    :param args: 协议参数
    :returns: 命中的网络条目
    :raises AdapterError: 会话不存在 / 静态会话没有网络历史 / 这个会话没开记录
    """
    session_id = args.get("sessionId")
    entry = _get_session(session_id)
    if entry["type"] == "static":
        raise AdapterError("BAD_ARGS", "static sessions keep no network history")
    pattern, entries, include_body, body_chars = _network_read(args)
    recorder = getattr(entry["session"], "network", None)
    if recorder is None or not getattr(recorder, "enabled", False):
        raise AdapterError(
            "NETWORK_NOT_RECORDED",
            "this session is not recording requests; open it with recordNetwork:true "
            "(or set the deployment knob recordRequests) to keep its history",
        )
    worker: _SessionWorker | None = entry["worker"]
    if worker is None:  # pragma: no cover —— 浏览器条目必有属主线程
        raise AdapterError("NO_SUCH_SESSION", "session has no owner thread")
    matches = worker.run(
        lambda: _network_summary(
            recorder,
            pattern=pattern,
            limit=entries,
            include_body=include_body,
            max_body_chars=body_chars,
        )
    )
    return {"sessionId": session_id, "count": len(matches), "matches": matches}


def _state_path(args: dict[str, Any]) -> str:
    """解析会话状态文件的落点。

    目录**只从部署命名空间取**，因为这是**写文件**的能力：让模型选路径等于给它一个任意文件
    写入口（写到某个被 source 的脚本里就够了）。模型只能给这个名字，且必须是那个目录下的
    直接子项。

    :param args: 协议参数
    :returns: 状态文件的绝对路径
    :raises AdapterError: 部署没配目录，或名字不是纯文件名
    """
    deployment = args.get("deployment")
    directory = deployment.get("sessionStateDir") if isinstance(deployment, dict) else None
    if not isinstance(directory, str) or not directory:
        raise AdapterError(
            "STATE_DISABLED",
            "this deployment has no sessionStateDir configured; browser login state cannot be saved or loaded",
        )
    name = args.get("name")
    if not isinstance(name, str) or not name:
        raise AdapterError("BAD_ARGS", "name is required")
    # NUL 让 `Path(name).name` 仍然等于 name，却能进到后面的文件调用里：那一层会以一条
    # 语焉不详的错误收场，而不是在这里点名说清。
    if name != Path(name).name or name.startswith(".") or "\x00" in name:
        raise AdapterError("BAD_ARGS", f"name must be a plain file name, got {name!r}")
    stem = name[:-5] if name.lower().endswith(".json") else name
    return str(Path(directory) / f"{stem}.json")


def _session_state(args: dict[str, Any], *, saving: bool) -> dict[str, Any]:
    """存取浏览器会话的登录态。

    0.5 起上游提供 ``save_state`` / ``load_state``（Playwright 兼容的 JSON：cookie、
    localStorage、IndexedDB），于是「登录一次、下次复用」不必再让模型把站点爬两遍。

    :param args: 协议参数
    :param saving: True 存、False 取
    :returns: 落点与结果
    :raises AdapterError: 会话不存在 / 静态会话没有浏览器状态 / 落点非法 / 上游报错
    """
    session_id = args.get("sessionId")
    entry = _get_session(session_id)
    if entry["type"] == "static":
        raise AdapterError("BAD_ARGS", "static sessions have no browser state")
    target = _state_path(args)
    worker: _SessionWorker | None = entry["worker"]
    if worker is None:  # pragma: no cover —— 浏览器条目必有属主线程
        raise AdapterError("NO_SUCH_SESSION", "session has no owner thread")
    session = entry["session"]
    try:
        if saving:
            worker.run(lambda: session.save_state(target))
        else:
            worker.run(lambda: session.load_state(target))
    except Exception as error:  # noqa: BLE001 —— 上游的文件/JSON 错误一律翻成可路由的码
        raise AdapterError("STATE_FAILED", f"{type(error).__name__}: {error}") from error
    return {"sessionId": session_id, "path": target, "saved": saving}


def session_state_save(args: dict[str, Any]) -> dict[str, Any]:
    """把会话的登录态存成一个文件。

    :param args: 协议参数
    :returns: 落点与结果
    """
    return _session_state(args, saving=True)


def session_state_load(args: dict[str, Any]) -> dict[str, Any]:
    """把一个状态文件载入会话（载入后要重新抓一次页面才用上它）。

    :param args: 协议参数
    :returns: 落点与结果
    """
    return _session_state(args, saving=False)


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
        "session.network": session_network,
        "session.state_save": session_state_save,
        "session.state_load": session_state_load,
    }
)
METHODS.update(CRAWL_METHODS)
