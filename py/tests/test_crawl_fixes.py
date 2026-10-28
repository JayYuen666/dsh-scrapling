"""crawl 修复回归：sitemap 发现期上限、shopify 非店铺响应的 notice。

两条缺陷的现场都是「作业 completed 而结果没有解释」：一条是 maxPages 拦不住发现期的
sitemap 请求（maxPages=2 也能打出几百请求），一条是把 404 页/HTML 首页当成店铺 JSON
去下标、异常被引擎吞掉。判据不经过引擎：用假 Response 直接驱动 spider 的发现回调，
比真引擎稳，也不依赖任何站点。
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Any

_PY = Path(__file__).resolve().parents[1]
if str(_PY) not in sys.path:
    sys.path.insert(0, str(_PY))

import crawl  # noqa: E402

_INDEX = """<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{children}
</sitemapindex>
"""

_URLSET = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{urls}
</urlset>
"""


class _Request:
    """引擎请求的最小替身：发现期的判据只看 url 与 callback。"""

    def __init__(self, url: str, callback: Any) -> None:
        self.url = url
        self.callback = callback


class _Response:
    """响应替身：带 body/status/headers，以及发现期要用的 follow()/json()。"""

    def __init__(
        self,
        url: str,
        body: bytes = b"",
        status: int = 200,
        headers: dict[str, str] | None = None,
        payload: Any = None,
    ) -> None:
        self.url = url
        self.body = body
        self.status = status
        self.headers = {"content-type": "application/xml"} if headers is None else headers
        self.meta: dict[str, Any] = {}
        self._payload = payload

    def follow(self, url: str, callback: Any = None) -> _Request:
        """按引擎的形状造一条后续请求。"""
        return _Request(url, callback)

    def json(self) -> Any:
        """只在给了 payload 时回 JSON，否则抛异常（模拟 HTML 页）。"""
        if self._payload is None:
            raise ValueError("response body is not JSON")
        return self._payload


def _state(notice: str = "") -> dict[str, Any]:
    """造一份与 crawl_run 同形的作业 state。"""
    return {
        "error": None,
        "mode": "sitemap",
        "pages": [],
        "rows": [],
        "stats": None,
        "max_content_chars": 4000,
        "strip_inline_images": False,
        "budget_ms": 60_000,
        "deadline": time.monotonic() + 60.0,
        "notice": notice,
    }


def _collect(agen: Any) -> list[Any]:
    """把 async generator 收成 list。"""

    async def _run() -> list[Any]:
        return [item async for item in agen]

    return asyncio.run(_run())


def _index(children: int) -> bytes:
    """造一份含 ``children`` 个子 sitemap 的 sitemapindex。"""
    locs = "".join(
        f"<sitemap><loc>https://unit.test/child-{index}.xml</loc></sitemap>" for index in range(1, children + 1)
    )
    return _INDEX.format(children=locs).encode()


def _urlset(urls: int) -> bytes:
    """造一份含 ``urls`` 个页面地址的 urlset。"""
    locs = "".join(f"<url><loc>https://unit.test/page-{index}.html</loc></url>" for index in range(1, urls + 1))
    return _URLSET.format(urls=locs).encode()


def _sitemap_spider(limit: int, state: dict[str, Any]) -> Any:
    """按 crawl_run 的调用形状造一只 SitemapSpider。"""
    return crawl._make_sitemap_spider(
        "https://unit.test/sitemap.xml",
        limit,
        "cap",
        state,
        {"unit.test"},
        crawl._crawl_policy({}),
        {
            "sitemap_url": "https://unit.test/sitemap.xml",
            "sitemap_follow": None,
            "css_selector": None,
            "main_content_only": True,
            "include_patterns": [],
            "exclude_patterns": [],
        },
    )


def _shopify_spider(limit: int, state: dict[str, Any]) -> Any:
    """按 crawl_run 的调用形状造一只 ShopifySpider。"""
    return crawl._make_shopify_spider(
        "https://unit.test/",
        limit,
        "shop",
        state,
        {"unit.test"},
        crawl._crawl_policy({}),
        {"sitemap_url": None},
    )


def run_crawl_fixes(check: Any) -> None:
    """跑两条 crawl 修复的判据。

    :param check: ``test_bridge.check(desc, condition, detail)``
    """
    print("\n== crawl 修复：发现期上限与 shopify notice ==")

    # --- sitemap 发现期：子 sitemap 请求数与页面请求数都不许越过 maxPages ---
    state = _state()
    spider = _sitemap_spider(3, state)
    root = _Response("https://unit.test/sitemap.xml", body=_index(10))
    discovered = _collect(spider._parse_sitemap(root))
    children = [request for request in discovered if request.callback == spider._parse_sitemap]
    pages = [request for request in discovered if request.callback != spider._parse_sitemap]
    check("sitemap 发现期的子 sitemap 请求按 maxPages 封顶", len(children) == 3, f"{len(children)} 条")
    check("sitemapindex 本身不带页面请求", pages == [], repr(pages)[:200])
    check(
        "发现期被截断时结果带 notice",
        "sitemap discovery stopped at maxPages=3" in state["notice"],
        state["notice"],
    )

    leaf = _collect(
        spider._parse_sitemap(_Response("https://unit.test/child-1.xml", body=_urlset(100))),
    )
    leaf_children = [request for request in leaf if request.callback == spider._parse_sitemap]
    leaf_pages = [request for request in leaf if request.callback != spider._parse_sitemap]
    check("子 sitemap 里发现的页面请求同受 maxPages 限制", len(leaf_pages) == 3, f"{len(leaf_pages)} 条")
    check("子 sitemap 自身不再派生新的 sitemap 请求", leaf_children == [], repr(leaf_children)[:200])

    # 未截断时不写 notice：maxPages 富余时不该给结果加噪音。
    generous_state = _state()
    generous = _sitemap_spider(10, generous_state)
    _collect(generous._parse_sitemap(_Response("https://unit.test/sitemap.xml", body=_index(2))))
    check("没截断时不写 notice", generous_state["notice"] == "", generous_state["notice"])

    # --- shopify：非店铺响应要给一句人读的话，而不是 0 行 completed ---
    html_state = _state()
    html_spider = _shopify_spider(5, html_state)
    items = _collect(
        html_spider.parse(
            _Response(
                "https://unit.test/collections.json?page=1",
                body=b"<html>not a store</html>",
                status=404,
                headers={"content-type": "text/html"},
            )
        )
    )
    check("404 页不再产出任何行", items == [], repr(items)[:200])
    check(
        "404 的 notice 点名 HTTP 状态与源",
        "HTTP 404" in html_state["notice"] and "https://unit.test/collections.json" in html_state["notice"],
        html_state["notice"],
    )

    nonjson_state = _state()
    nonjson_spider = _shopify_spider(5, nonjson_state)
    _collect(
        nonjson_spider.parse(
            _Response(
                "https://unit.test/collections.json?page=1",
                body=b"<html>captive portal</html>",
                status=200,
                headers={"content-type": "text/html"},
            )
        )
    )
    check(
        "200 但非 JSON 的响应也给出 notice",
        "non-JSON" in nonjson_state["notice"],
        nonjson_state["notice"],
    )

    shape_state = _state()
    shape_spider = _shopify_spider(5, shape_state)
    _collect(
        shape_spider.parse(
            _Response(
                "https://unit.test/collections.json?page=1",
                payload={"products": []},
                headers={"content-type": "application/json"},
            )
        )
    )
    check(
        "JSON 里没有 collections 列表同样给出 notice",
        "collections" in shape_state["notice"],
        shape_state["notice"],
    )

    ok_state = _state()
    ok_spider = _shopify_spider(5, ok_state)
    _collect(
        ok_spider.parse(
            _Response(
                "https://unit.test/collections.json?page=1",
                payload={"collections": []},
                headers={"content-type": "application/json"},
            )
        )
    )
    check("正常店铺响应（空集合）不写 notice", ok_state["notice"] == "", ok_state["notice"])
