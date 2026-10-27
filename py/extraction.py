"""选择器查询与字段抽取的纯函数。

只做 HTML 到 Python 值的转换；不读环境、不发请求、不处理 protocol 帧。
`adapters.select` 负责参数错误码，`locate`/`links` 在后续任务复用这里的查询与序列化。
"""

from __future__ import annotations

import json
from typing import Any, Iterable, cast

_URL_ATTRIBUTES = frozenset({"href", "src", "action"})


def _json_len(value: Any) -> int:
    """按 JSON 序列化后的字符数计预算；与模型看到的形状一致。"""
    return len(json.dumps(value, ensure_ascii=False))


def _resolve_url(page: Any, value: str) -> str:
    """把相对地址拼成绝对地址；空值或拼不出来时保留原值。"""
    if not value:
        return value
    try:
        return str(page.urljoin(value))
    except Exception:  # noqa: BLE001 —— 不是合法 URL 时保留原值比抛错更有用
        return value


def _query_type(selector: str, query_type: str | None, use_xpath: bool) -> str:
    """把旧的 ``useXpath`` 布尔值归一到 queryType。"""
    return query_type or ("xpath" if use_xpath else "css")


def query_nodes(
    page: Any,
    selector: str,
    query_type: str = "css",
    *,
    use_xpath: bool = False,
    partial: bool = False,
    case_sensitive: bool = False,
    clean_match: bool = True,
    similarity_threshold: float = 0.2,
    ignore_attributes: Iterable[str] = ("href", "src"),
    match_text: bool = False,
) -> tuple[list[Any], str]:
    """按 queryType 返回节点列表与一条可读说明。

    ``similar`` 无种子时返回空列表与说明，绝不回退成整页。
    """
    if not isinstance(selector, str) or not selector:
        raise ValueError("selector is required")
    kind = _query_type(selector, query_type, use_xpath)
    if kind == "css":
        return list(page.css(selector)), ""
    if kind == "xpath":
        return list(page.xpath(selector)), ""
    if kind == "text":
        found = page.find_by_text(
            selector,
            first_match=False,
            partial=partial,
            case_sensitive=case_sensitive,
            clean_match=clean_match,
        )
        return list(found or []), ""
    if kind == "regex":
        found = page.find_by_regex(
            selector,
            first_match=False,
            case_sensitive=case_sensitive,
            clean_match=clean_match,
        )
        return list(found or []), ""
    if kind == "similar":
        seeds = list(page.xpath(selector) if use_xpath else page.css(selector))
        if not seeds:
            return [], "similar seed matched nothing"
        found = seeds[0].find_similar(
            similarity_threshold=similarity_threshold,
            ignore_attributes=list(ignore_attributes),
            match_text=match_text,
        )
        return list(found or []), ""
    raise ValueError(f"unknown queryType: {kind}")


def serialize_match(
    node: Any,
    *,
    page: Any,
    attribute: str | None = None,
    include_attributes: bool = False,
    include_html: bool = False,
    resolve_urls: bool = False,
) -> dict[str, Any]:
    """把一条元素/文本节点归一成匹配载荷。"""
    item: dict[str, Any] = {"tag": str(getattr(node, "tag", "") or "")}
    if attribute:
        value = node.attrib.get(attribute, "")
        item["value"] = _resolve_url(page, str(value)) if resolve_urls and attribute in _URL_ATTRIBUTES else str(value)
    else:
        item["text"] = str(node.get_all_text(strip=True))
        if include_html:
            item["html"] = str(node.html_content)
    if include_attributes:
        item["attributes"] = {str(key): str(value) for key, value in node.attrib.items()}
    return item


def _field_spec(spec: Any) -> tuple[str, str, str | None, bool]:
    """把字段描述归一成 (selector, mode, attribute, all)。"""
    selector: str
    mode: str
    attribute: str | None
    many: bool
    if isinstance(spec, str):
        selector, mode, attribute, many = spec, "text", None, False
    elif isinstance(spec, dict):
        raw_selector = spec.get("selector")
        attribute = spec.get("attribute")
        raw_mode = spec.get("mode")
        mode = (
            str(raw_mode)
            if raw_mode is not None
            else ("attribute" if isinstance(attribute, str) and attribute else "text")
        )
        many = bool(spec.get("all", False))
        if not isinstance(raw_selector, str) or not raw_selector:
            raise ValueError("field selector is required")
        selector = raw_selector
        if mode not in ("text", "html", "attribute"):
            raise ValueError(f"unknown field mode: {mode}")
        if mode == "attribute" and (not isinstance(attribute, str) or not attribute):
            raise ValueError("attribute mode requires an attribute name")
    else:
        raise ValueError("field spec must be a string or an object")
    return selector, mode, attribute if isinstance(attribute, str) else None, many


def _select_field_nodes(node: Any, selector: str) -> list[Any]:
    """字段选择器相对记录节点执行；以 .// 或 / 开头时走 XPath。"""
    if selector.startswith(".//") or selector.startswith("/"):
        return list(node.xpath(selector))
    return list(node.css(selector))


def field_value(
    node: Any,
    spec: Any,
    *,
    page: Any,
    resolve_urls: bool = False,
) -> Any:
    """取一个字段的值；缺失给 None，all=true 时给列表。"""
    selector, mode, attribute, many = _field_spec(spec)
    found = _select_field_nodes(node, selector)
    if many:
        values = [_field_scalar(item, mode, attribute, page, resolve_urls) for item in found]
        return [value for value in values if value is not None]
    for item in found:
        value = _field_scalar(item, mode, attribute, page, resolve_urls)
        if value is not None:
            return value
    return None


def _field_scalar(
    item: Any,
    mode: str,
    attribute: str | None,
    page: Any,
    resolve_urls: bool,
) -> Any:
    """从一个命中节点取 text/html/attribute 值。"""
    if mode == "html":
        return str(item.html_content)
    if mode == "attribute":
        value = item.attrib.get(attribute or "")
        if value is None:
            return None
        text = str(value)
        return _resolve_url(page, text) if resolve_urls and (attribute or "") in _URL_ATTRIBUTES else text
    return str(item.get_all_text(strip=True))


def collect_fields(
    nodes: Iterable[Any],
    fields: dict[str, Any],
    *,
    page: Any,
    max_content_chars: int,
    resolve_urls: bool = False,
) -> tuple[list[dict[str, Any]], bool]:
    """把记录节点按字段表收成行；返回 (rows, truncated)。"""
    if not isinstance(fields, dict) or not fields:
        raise ValueError("fields must be a non-empty object")
    rows: list[dict[str, Any]] = []
    spent = 0
    truncated = False
    for node in nodes:
        row: dict[str, Any] = {}
        for name, spec in fields.items():
            value = field_value(node, spec, page=page, resolve_urls=resolve_urls)
            room = max(0, max_content_chars - spent)
            size = _json_len(value)
            if size > room:
                if isinstance(value, str):
                    # JSON 字符串带两个引号；留出它们再把正文裁到剩余预算。
                    value = value[: max(0, room - 2)]
                    size = _json_len(value)
                truncated = True
            spent += size
            row[str(name)] = value
        rows.append(row)
        if spent >= max_content_chars:
            truncated = True
            break
    return rows, truncated


def locate(args: dict[str, Any]) -> dict[str, Any]:
    """定位元素并返回生成选择器；不发网络请求，不写 adaptive 指纹。"""
    from scrapling.parser import Selector

    html = args.get("html")
    if not isinstance(html, str):
        raise ValueError("html must be a string")
    selector = args.get("selector")
    if not isinstance(selector, str) or not selector:
        raise ValueError("selector is required")
    url = args.get("url")
    if url is not None and not isinstance(url, str):
        raise ValueError("url must be a string or null")
    query_type = args.get("queryType")
    if query_type is not None and not isinstance(query_type, str):
        raise ValueError("queryType must be a string")
    query_type = query_type or "css"
    if query_type not in ("css", "xpath", "text", "regex", "similar"):
        raise ValueError(f"unknown queryType: {query_type}")
    limit = _positive_int(args.get("limit"), "limit", 200)
    budget = _positive_int(args.get("maxContentChars"), "maxContentChars", 200_000)
    include_ancestors = bool(args.get("includeAncestors", True))
    generate_selectors = bool(args.get("generateSelectors", True))
    page = Selector(html, url=url or "")
    nodes, notice = query_nodes(
        page,
        selector,
        query_type,
        use_xpath=bool(args.get("useXpath", False)),
        partial=bool(args.get("partial", False)),
        case_sensitive=bool(args.get("caseSensitive", False)),
        clean_match=bool(args.get("cleanMatch", True)),
        similarity_threshold=float(args.get("similarityThreshold", 0.2)),
        ignore_attributes=args.get("ignoreAttributes") or ("href", "src"),
        match_text=bool(args.get("matchText", False)),
    )
    matches: list[dict[str, Any]] = []
    spent = 0
    truncated = False
    for node in nodes:
        if len(matches) >= limit:
            truncated = True
            break
        text = str(node.get_all_text(strip=True))
        room = max(0, budget - spent)
        if len(text) > room:
            text = text[:room]
            truncated = True
        spent += len(text)
        item: dict[str, Any] = {
            "tag": str(getattr(node, "tag", "") or ""),
            "text": text,
            "attributes": {str(key): str(value) for key, value in node.attrib.items()},
            "cssSelector": str(node.generate_css_selector) if generate_selectors else "",
            "xpathSelector": str(node.generate_xpath_selector) if generate_selectors else "",
            "fullCssSelector": str(node.generate_full_css_selector) if generate_selectors else "",
            "fullXpathSelector": str(node.generate_full_xpath_selector) if generate_selectors else "",
            "ancestors": (
                [
                    {
                        "tag": str(getattr(ancestor, "tag", "") or ""),
                        "attributes": {str(key): str(value) for key, value in ancestor.attrib.items()},
                    }
                    for ancestor in node.iterancestors()
                ]
                if include_ancestors
                else []
            ),
        }
        matches.append(item)
        if spent >= budget:
            truncated = True
            break
    return {
        "count": len(nodes),
        "truncated": truncated or len(nodes) > len(matches),
        "matches": matches,
        "notice": notice,
    }


def _next_reason(text: str, url: str) -> str:
    """给分页候选一个可读的原因；没有命中给空串。"""
    lowered = text.lower()
    if "load more" in lowered:
        return "text:load more"
    if "next" in lowered:
        return "text:next"
    if "more" in lowered:
        return "text:more"
    lowered_url = url.lower()
    if "page=" in lowered_url:
        return "url:page"
    if "/page/" in lowered_url:
        return "url:page-path"
    if "offset=" in lowered_url:
        return "url:offset"
    return ""


def links(args: dict[str, Any]) -> dict[str, Any]:
    """对已有 HTML 跑 LinkExtractor，并给出分页候选。"""
    from scrapling.parser import Selector
    from scrapling.spiders import LinkExtractor

    html = args.get("html")
    if not isinstance(html, str):
        raise ValueError("html must be a string")
    base_url = args.get("baseUrl")
    if base_url is not None and not isinstance(base_url, str):
        raise ValueError("baseUrl must be a string or null")
    page = Selector(html, url=base_url or "")
    limit = _positive_int(args.get("limit"), "limit", 200)
    find_next = bool(args.get("findNext", True))
    options: dict[str, Any] = {}
    for source, target in (
        ("allow", "allow"),
        ("deny", "deny"),
        ("allowDomains", "allow_domains"),
        ("denyDomains", "deny_domains"),
        ("restrictCss", "restrict_css"),
        ("restrictXpath", "restrict_xpath"),
        ("tags", "tags"),
        ("attrs", "attrs"),
        ("denyExtensions", "deny_extensions"),
    ):
        value = args.get(source)
        if value is not None:
            options[target] = value
    for source, target in (
        ("canonicalize", "canonicalize"),
        ("strip", "strip"),
        ("keepFragment", "keep_fragment"),
    ):
        value = args.get(source)
        if isinstance(value, bool):
            options[target] = value
    try:
        extractor = LinkExtractor(**options)
    except Exception as error:
        raise ValueError(f"invalid link rule: {error}") from error
    # 上游把注解写成 Response，实际只读 .url 与 .css；Selector 已在 V11 实测可用。
    urls = list(extractor.extract(cast(Any, page)))
    truncated = len(urls) > limit
    kept = urls[:limit]
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    if find_next:
        for element in page.css("a, area"):
            href = element.attrib.get("href")
            if not href:
                continue
            text = str(element.get_all_text(strip=True))
            reason = _next_reason(text, href)
            if not reason:
                continue
            url = str(page.urljoin(href))
            if url in seen:
                continue
            seen.add(url)
            candidates.append({"url": url, "text": text, "reason": reason})
            if len(candidates) >= 20:
                break
    return {
        "count": len(urls),
        "truncated": truncated,
        "links": [{"url": url} for url in kept],
        "nextCandidates": candidates,
    }


def _positive_int(value: Any, field: str, default: int) -> int:
    """取一个正整数；非法值抛 ValueError，由 adapters 转成 BAD_ARGS。"""
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value
