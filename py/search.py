"""检索层：Tavily / Bing / Brave / Serper / DuckDuckGo / SearXNG 六条发现路径。

Scrapling 本身不是搜索引擎；这里只负责拿 URL 列表，正文渲染仍由 Host 侧的
search provider 交给本 sidecar 的 fetch/render。每条后端都按各家**文档里的**
请求与响应形状实现；真实端点与真实 key 的行为未在本机验证，夹具只钉形状与错误面。
"""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any, cast
from urllib.parse import parse_qs, urlparse

import guard
from curl_cffi.requests import ProxySpec

DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/search"
DEFAULT_BING_ENDPOINT = "https://www.bing.com/search"
DEFAULT_BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
DEFAULT_SERPER_ENDPOINT = "https://google.serper.dev/search"
DEFAULT_DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/"
BACKENDS = ("auto", "tavily", "bing", "brave", "serper", "duckduckgo", "searxng")
DEFAULT_SEARCH_RESULTS = 8
DEFAULT_SEARCH_TIMEOUT_SECONDS = 30.0
# Brave Web Search API 的 `count` 与 Tavily 的 `max_results` 都是 1..20（上游文档口径）。
# 上层 `lib/search-provider.ts` 的 MAX_SOURCES 是 100，会把这个值一路放到 100 ——
# 那两条后端拿到 100 只会判参数错，回执里看不到「被夹到 20」这件事。
BRAVE_MAX_COUNT = 20
TAVILY_MAX_RESULTS = 20
# 每条后端自己只发一次请求，重试交给协议层（`lib/search-provider.ts` 的 timeoutMs 是
# 整次调用的预算）。上游 Fetcher 默认 retries=3、retry_delay=1，一次慢后端最坏要花
# `3 × timeout + 2s`，比协议层先到期的超时还长 —— 于是 SEARCH_TIMEOUT 永远走不到，
# 模型看到的是一条含义更模糊的协议层超时。显式传 1 让两层的预算对齐。
SEARCH_RETRIES = 1
_CJK_QUERY = re.compile(r"[\u3400-\u9fff]")


def _proxies(url: str) -> "ProxySpec | None":
    return cast("ProxySpec | None", guard.proxies_for(url))


class SearchError(ValueError):
    """带机器可读错误码的检索失败。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _positive_int(value: Any, field: str, default: int) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise SearchError("BAD_ARGS", f"{field} must be a positive integer")
    return value


def _offset(value: Any) -> int:
    if value is None:
        return 0
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise SearchError("BAD_ARGS", "offset must be a non-negative integer")
    return value


def _timeout(value: Any) -> float:
    if value is None:
        return DEFAULT_SEARCH_TIMEOUT_SECONDS
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise SearchError("BAD_ARGS", "timeoutSeconds must be a positive number")
    return float(value)


def _endpoint(value: Any, default: str, field: str) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or not value:
        raise SearchError("BAD_ARGS", f"{field} must be a non-empty string")
    return value


def _status_error(status: int, backend: str) -> SearchError | None:
    if status in (401, 403):
        # SearXNG 没有 API key 这回事：它的 401/403 几乎总是「实例没开 json 输出格式」
        # （`search.formats` 默认只有 html）。对这条后端说「检查 API key」会把人指到
        # 一个根本不存在的配置项上。
        if backend == "searxng":
            return SearchError(
                "SEARCH_AUTH",
                "searxng answered 401/403; most instances ship with the json format disabled — "
                "enable it in the instance's settings.yml (search.formats: [html, json])",
            )
        return SearchError(
            "SEARCH_AUTH",
            f"{backend} rejected the credentials; check the configured API key",
        )
    if status == 429:
        return SearchError("SEARCH_RATE_LIMIT", f"{backend} rate limit reached")
    if status >= 400:
        return SearchError("SEARCH_FAILED", f"{backend} answered HTTP {status}")
    return None


def _tavily(args: dict[str, Any], query: str, limit: int, offset: int, timeout: float) -> dict[str, Any]:
    key = args.get("apiKey")
    if not isinstance(key, str) or not key:
        raise SearchError(
            "SEARCH_AUTH",
            "tavily needs an API key; configure tavilyApiKey or switch searchBackend to bing",
        )
    endpoint = _endpoint(args.get("apiEndpoint"), DEFAULT_TAVILY_ENDPOINT, "apiEndpoint")
    from scrapling.fetchers import Fetcher

    try:
        response = Fetcher.post(
            endpoint,
            json={
                "api_key": key,
                "query": query,
                "max_results": min(limit + offset, TAVILY_MAX_RESULTS),
                "search_depth": "basic",
            },
            timeout=timeout,
            retries=SEARCH_RETRIES,
            proxies=_proxies(endpoint),
        )
    except Exception as error:  # noqa: BLE001 —— 只翻译成带码的失败，不回显请求体
        raise _translate(error, "tavily") from None
    failed = _status_error(int(getattr(response, "status", 0)), "tavily")
    if failed is not None:
        raise failed
    payload = _json_body(response, "tavily")
    # 走与另外五条后端同一个收集器：`{}`（没有 results 键）与 `{"results": "x"}` 都收成空表，
    # 而非对象回包已经在 _json_body 那里判成 SEARCH_FAILED 了。
    hits = _collect(
        payload.get("results"),
        limit=limit + offset,
        url_key="url",
        title_key="title",
        snippet_key="content",
        summary_key="summary",
        date_key="published_date",
    )
    return {"backend": "tavily", "hits": hits[offset : offset + limit]}


def _bing_target(href: str) -> str:
    """解包 Bing 的 ck/a 跳板；只接受 Bing 自家主机与 http(s) 目标。"""
    parts = urlparse(href)
    host = (parts.hostname or "").lower()
    if not (host == "bing.com" or host.endswith(".bing.com")) or parts.path != "/ck/a":
        return href
    token = parse_qs(parts.query).get("u", [""])[0]
    if not token.startswith("a1"):
        return href
    encoded = token[2:]
    try:
        target = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4),
            altchars=b"-_",
            validate=True,
        ).decode("utf-8")
    except ValueError, binascii.Error, UnicodeDecodeError:
        return href
    parsed = urlparse(target)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
        return href
    return target


def _bing(args: dict[str, Any], query: str, limit: int, offset: int, timeout: float) -> dict[str, Any]:
    endpoint = _endpoint(args.get("bingEndpoint"), DEFAULT_BING_ENDPOINT, "bingEndpoint")
    from scrapling.fetchers import Fetcher

    params = {
        "q": query,
        "first": offset + 1,
        "count": limit,
        "setlang": "zh-hans" if _CJK_QUERY.search(query) else "en",
    }
    try:
        response = Fetcher.get(
            endpoint,
            params=params,
            timeout=timeout,
            retries=SEARCH_RETRIES,
            proxies=_proxies(endpoint),
        )
    except Exception as error:  # noqa: BLE001
        raise _translate(error, "bing") from None
    failed = _status_error(int(getattr(response, "status", 0)), "bing")
    if failed is not None:
        raise failed

    from scrapling import Selector

    page = Selector(content=response.html_content)
    hits: list[dict[str, str]] = []
    for node in page.css("li.b_algo"):
        link = node.css("h2 a").first
        if link is None:
            continue
        href = link.attrib.get("href")
        if not isinstance(href, str) or not href:
            continue
        snippet_node = node.css(".b_caption p").first or node.css("p").first
        hits.append(
            {
                "url": _bing_target(href),
                "title": link.get_all_text(strip=True),
                "snippet": snippet_node.get_all_text(strip=True) if snippet_node is not None else "",
            }
        )
        if len(hits) >= limit:
            break
    result: dict[str, Any] = {"backend": "bing", "hits": hits}
    if not hits:
        result["note"] = "bing returned no li.b_algo results; the page layout may have changed"
    return result


def _require_key(args: dict[str, Any], backend: str) -> str:
    """取这条后端的 API key；缺了就报 `SEARCH_AUTH` 并点名该配哪一个设置。"""
    key = args.get("apiKey")
    if not isinstance(key, str) or not key:
        raise SearchError(
            "SEARCH_AUTH",
            f"{backend} needs an API key; configure the matching key setting or switch searchBackend",
        )
    return key


def _json_body(response: Any, backend: str) -> dict[str, Any]:
    """读回一份 JSON 对象；解析不了就是这条后端的失败，不是空结果。"""
    try:
        payload = response.json()
    except Exception as error:  # 各家解析器的异常类型不同
        raise SearchError("SEARCH_FAILED", f"{backend} answered with invalid JSON") from error
    if not isinstance(payload, dict):
        raise SearchError("SEARCH_FAILED", f"{backend} answered with a non-object JSON body")
    return payload


def _collect(
    items: Any,
    *,
    limit: int,
    url_key: str,
    title_key: str,
    snippet_key: str,
    summary_key: str | None = None,
    date_key: str | None = None,
) -> list[dict[str, Any]]:
    """把各家形状不同的结果表收成同一份 hits。"""
    hits: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return hits
    for item in items:
        if not isinstance(item, dict):
            continue
        url = item.get(url_key)
        if not isinstance(url, str) or not url:
            continue
        title = item.get(title_key)
        snippet = item.get(snippet_key)
        summary = item.get(summary_key) if summary_key is not None else None
        published = item.get(date_key) if date_key is not None else None
        hits.append(
            {
                "url": url,
                "title": title if isinstance(title, str) else "",
                "snippet": snippet if isinstance(snippet, str) else "",
                **({"summary": summary} if isinstance(summary, str) and summary else {}),
                **({"publishedAt": published} if isinstance(published, str) and published else {}),
            }
        )
        if len(hits) >= limit:
            break
    return hits


def _nested(payload: dict[str, Any], *keys: str) -> Any:
    """按路径取一层嵌套对象；中间不是对象就给 None。"""
    current: Any = payload
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _brave(args: dict[str, Any], query: str, limit: int, offset: int, timeout: float) -> dict[str, Any]:
    key = _require_key(args, "brave")
    endpoint = _endpoint(args.get("braveEndpoint"), DEFAULT_BRAVE_ENDPOINT, "braveEndpoint")
    from scrapling.fetchers import Fetcher

    # Brave 的 `count` 上限是 20（文档口径）。传更大的值不会报错，只会被上游截断，
    # 回执里少掉的那几条看不出原因 —— 这里夹到上限，超出的部分由调用方自己翻页。
    try:
        response = Fetcher.get(
            endpoint,
            params={"q": query, "count": min(limit, BRAVE_MAX_COUNT), "offset": offset},
            headers={"X-Subscription-Token": key, "Accept": "application/json"},
            timeout=timeout,
            retries=SEARCH_RETRIES,
            proxies=_proxies(endpoint),
        )
    except Exception as error:  # noqa: BLE001
        raise _translate(error, "brave") from None
    failed = _status_error(int(getattr(response, "status", 0)), "brave")
    if failed is not None:
        raise failed
    payload = _json_body(response, "brave")
    hits = _collect(
        _nested(payload, "web", "results"),
        limit=limit,
        url_key="url",
        title_key="title",
        snippet_key="description",
    )
    return {"backend": "brave", "hits": hits}


def _serper(args: dict[str, Any], query: str, limit: int, offset: int, timeout: float) -> dict[str, Any]:
    key = _require_key(args, "serper")
    endpoint = _endpoint(args.get("serperEndpoint"), DEFAULT_SERPER_ENDPOINT, "serperEndpoint")
    from scrapling.fetchers import Fetcher

    page = offset // limit + 1
    skip = offset % limit
    try:
        response = Fetcher.post(
            endpoint,
            json={"q": query, "num": limit + skip, "page": page},
            headers={"X-API-KEY": key, "Content-Type": "application/json"},
            timeout=timeout,
            retries=SEARCH_RETRIES,
            proxies=_proxies(endpoint),
        )
    except Exception as error:  # noqa: BLE001
        raise _translate(error, "serper") from None
    failed = _status_error(int(getattr(response, "status", 0)), "serper")
    if failed is not None:
        raise failed
    payload = _json_body(response, "serper")
    hits = _collect(
        payload.get("organic"),
        limit=limit + skip,
        url_key="link",
        title_key="title",
        snippet_key="snippet",
        date_key="date",
    )
    return {"backend": "serper", "hits": hits[skip : skip + limit]}


def _duckduckgo_target(href: str) -> str:
    """DuckDuckGo 的结果链接是 `/l/?uddg=<enc>` 跳板；取出真正的目标。"""
    from urllib.parse import parse_qs, urlparse, urlunparse

    absolute = f"https:{href}" if href.startswith("//") else href
    parts = urlparse(absolute)
    host = (parts.hostname or "").lower()
    # 跳板可能以相对形式出现（netloc 为空）；主机按 hostname 精确/后缀匹配，
    # 子串判断会把 duckduckgo.com.evil.example 也当成自家跳板。
    is_wrapper = parts.path.startswith("/l/") and (
        host == "" or host == "duckduckgo.com" or host.endswith(".duckduckgo.com")
    )
    if is_wrapper:
        target = parse_qs(parts.query).get("uddg")
        if target:
            return target[0]
    return urlunparse(parts)


def _duckduckgo(args: dict[str, Any], query: str, limit: int, offset: int, timeout: float) -> dict[str, Any]:
    endpoint = _endpoint(args.get("duckduckgoEndpoint"), DEFAULT_DUCKDUCKGO_ENDPOINT, "duckduckgoEndpoint")
    from scrapling.fetchers import Fetcher

    try:
        response = Fetcher.get(
            endpoint,
            params={"q": query, "s": offset},
            timeout=timeout,
            retries=SEARCH_RETRIES,
            proxies=_proxies(endpoint),
        )
    except Exception as error:  # noqa: BLE001
        raise _translate(error, "duckduckgo") from None
    failed = _status_error(int(getattr(response, "status", 0)), "duckduckgo")
    if failed is not None:
        raise failed

    from scrapling import Selector

    page = Selector(content=response.html_content)
    hits: list[dict[str, str]] = []
    for node in page.css("div.result"):
        link = node.css("a.result__a").first
        if link is None:
            continue
        href = link.attrib.get("href")
        if not isinstance(href, str) or not href:
            continue
        snippet_node = node.css(".result__snippet").first
        hits.append(
            {
                "url": _duckduckgo_target(href),
                "title": link.get_all_text(strip=True),
                "snippet": snippet_node.get_all_text(strip=True) if snippet_node is not None else "",
            }
        )
        if len(hits) >= limit:
            break
    result: dict[str, Any] = {"backend": "duckduckgo", "hits": hits}
    if not hits:
        result["note"] = "duckduckgo returned no div.result entries; it may be showing a captcha"
    return result


def _searxng(args: dict[str, Any], query: str, limit: int, offset: int, timeout: float) -> dict[str, Any]:
    endpoint = args.get("searxngEndpoint")
    if not isinstance(endpoint, str) or not endpoint:
        raise SearchError(
            "SEARCH_AUTH",
            "searxng needs an instance URL; configure searxngEndpoint or switch searchBackend",
        )
    base = endpoint.rstrip("/")
    url = base if base.endswith("/search") else f"{base}/search"
    from scrapling.fetchers import Fetcher

    try:
        response = Fetcher.get(
            url,
            params={"q": query, "format": "json", "pageno": offset // limit + 1},
            timeout=timeout,
            retries=SEARCH_RETRIES,
            proxies=_proxies(url),
        )
    except Exception as error:  # noqa: BLE001
        raise _translate(error, "searxng") from None
    failed = _status_error(int(getattr(response, "status", 0)), "searxng")
    if failed is not None:
        raise failed
    payload = _json_body(response, "searxng")
    hits = _collect(
        payload.get("results"),
        limit=limit,
        url_key="url",
        title_key="title",
        snippet_key="content",
        date_key="publishedDate",
    )
    return {"backend": "searxng", "hits": hits}


def _translate(error: Exception, backend: str) -> SearchError:
    name = type(error).__name__.lower()
    text = str(error).lower()
    if "timeout" in name or "timed out" in text or "timeout" in text:
        return SearchError("SEARCH_TIMEOUT", f"{backend} timed out")
    return SearchError("SEARCH_FAILED", f"{backend} request failed: {type(error).__name__}")


def discover(args: dict[str, Any]) -> dict[str, Any]:
    """按 ``backend`` 取回一组搜索结果。"""
    backend = args.get("backend", "auto")
    if backend not in BACKENDS:
        raise SearchError("BAD_ARGS", f"unknown search backend: {backend}")
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        raise SearchError("BAD_ARGS", "query must be a non-empty string")
    limit = _positive_int(args.get("maxResults"), "maxResults", DEFAULT_SEARCH_RESULTS)
    offset = _offset(args.get("offset"))
    timeout = _timeout(args.get("timeoutSeconds"))
    key = args.get("apiKey")
    resolved = backend
    if backend == "auto":
        # spec §6.2/§6.3 + §12.1：auto 只挑「部署真的配好了的」后端。公共引擎回退
        # （Bing）默认关闭，要部署显式打开 searchPublicFallback；否则这里必须报
        # SEARCH_BACKEND_MISSING，而不是擅自把查询发给公共站点。
        searxng_endpoint = args.get("searxngEndpoint")
        searxng_ready = isinstance(searxng_endpoint, str) and bool(searxng_endpoint)
        public_fallback = args.get("publicFallback") is True
        if isinstance(key, str) and key:
            resolved = "tavily"
        elif searxng_ready:
            resolved = "searxng"
        elif public_fallback:
            resolved = "bing"
        else:
            raise SearchError(
                "SEARCH_BACKEND_MISSING",
                "no search backend is configured: set a Tavily API key or a SearXNG endpoint, "
                "or enable searchPublicFallback to allow the public Bing fallback",
            )
    handlers = {
        "tavily": _tavily,
        "bing": _bing,
        "brave": _brave,
        "serper": _serper,
        "duckduckgo": _duckduckgo,
        "searxng": _searxng,
    }
    return handlers[resolved](args, query.strip(), limit, offset, timeout)
