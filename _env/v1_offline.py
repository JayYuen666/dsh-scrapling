"""V1: offline verification — pure parser capability, zero network/browser.

Every observation is one labelled line. A failing observation prints
`OBSERVE-FAIL <type>: <message>` and the run continues: the point of this probe
is *which* capability stopped behaving, and an unguarded call aborts every
observation after it. (Measured on 0.5.x: `p.css("ul").has_class(...)` raises
`AttributeError: 'Selectors' object has no attribute 'has_class'`, which used to
swallow the whole `Response.markdown` half of this file.)

The exit code is non-zero when any observation failed, so the probe doubles as a
check.
"""

import re
from collections.abc import Callable

from scrapling.parser import Selector, Selectors

HTML = """
<html><body>
  <nav>Site Nav</nav>
  <div id="main">
    <h1 class="title">Hello</h1>
    <ul class="list">
      <li class="item" data-id="1">Alpha</li>
      <li class="item" data-id="2">Beta</li>
      <li class="item" data-id="3">Gamma</li>
    </ul>
    <a href="/rel">rel link</a>
  </div>
  <!-- a comment -->
  <script>var x=1;</script>
  <div style="display:none">HIDDEN INJECTION PAYLOAD</div>
  <div aria-hidden="true">ARIA HIDDEN PAYLOAD</div>
  <template>ZERO WIDTH:</template>
  <footer>Footer</footer>
</body></html>
"""

FAILED: list[str] = []


def check(label: str, value: Callable[[], object]) -> None:
    """Print one observation; a raising `value()` becomes a labelled failure."""
    try:
        print(f"{label:<21}: {value()}")
    except Exception as error:  # noqa: BLE001 — 探针要报任何一类意外，而不是只报它预料到的那种
        FAILED.append(label)
        print(f"{label:<21}: OBSERVE-FAIL {type(error).__name__}: {error}")


def one(adaptors: Selectors, what: str) -> Selector:
    """Take the first match, or name the miss.

    `.first` is `None` when nothing matched, and `None.parent` then reads as a bug in
    this script instead of as a parser-capability result.
    """
    head = adaptors.first
    if head is None:
        raise LookupError(f"{what} 没有匹配（.first 是 None）")
    return head


def parent_of(node: Selector, what: str) -> Selector:
    """Take `.parent`, or say the node already is a root."""
    parent = node.parent
    if parent is None:
        raise LookupError(f"{what} 已经在上层为根（parent 是 None）")
    return parent


def norm(text: str) -> str:
    """Collapse whitespace before matching.

    Markdown reflows its output (line breaks, runs of spaces), so a raw substring test
    can miss a payload that really is present — a false "cleaning works" reading.
    """
    return re.sub(r"\s+", " ", text)


p = Selector(HTML)
items = p.css("li")
lists = p.css("ul")

print("== basic selection ==")
check("css h1.text", lambda: p.css("h1.title::text").get())
check("css all items", lambda: p.css(".item::text").getall())
# `Selectors` is a list subclass, so `.count` on it is `list.count(value)` and not a
# size — `len()` is the number this line means.
check("xpath count", lambda: len(p.xpath("//li[@class='item']")))
check("attrib data-id", lambda: p.css(".item::attr(data-id)").getall())
# `re_first` searches the node's text, not the serialised HTML: the attribute pattern
# below is expected to miss, and the miss itself is the observation.
check("re_first on text", lambda: p.re_first(r'data-id="(\d+)"'))
check("get_all_text", lambda: repr(p.get_all_text(strip=True))[:120])
# `has_class` lives on a single Selector, not on the result list.
check("has_class", lambda: one(lists, 'css("ul")').has_class("list"))
check(
    "parent chain",
    lambda: parent_of(one(items, 'css("li")'), 'css("li")').attrib.get("class"),
)
check("urljoin", lambda: p.urljoin("/abs"))

print("\n== find_similar / similarity ==")
check(
    "similar ids",
    lambda: [
        similar.attrib.get("data-id") for similar in one(items, 'css("li")').find_similar(similarity_threshold=0.5)
    ],
)

print("\n== Response.markdown() injection sanitization ==")
# `Response` has no public re-export in this version (`scrapling.fetchers`,
# `scrapling.core` and `scrapling.parser` all lack it), so this leg reads the private
# path on purpose and names it in the report. If the module moves or the constructor
# changes, the line below says so instead of a bare ImportError.
try:
    from scrapling.engines.toolbelt.custom import Response

    r = Response(
        url="http://example.com",
        content=HTML,
        status=200,
        reason="OK",
        cookies={},
        headers={},
        request_headers={},
    )
    md = r.markdown()
    md_body = r.markdown(main_content_only=True)
except Exception as error:  # 这一段的每一行都要 md，起不来只能整段报失败
    FAILED.append("Response.markdown")
    print(f"{'Response.markdown':<21}: OBSERVE-FAIL {type(error).__name__}: {error}")
    print("\nfailed observations  :", ", ".join(FAILED))
    raise SystemExit(1) from error

check("markdown", lambda: repr(md)[:220])
check("markdown length", lambda: len(md))
check("has HIDDEN payload", lambda: "HIDDEN INJECTION PAYLOAD" in norm(md))
check("has ARIA payload", lambda: "ARIA HIDDEN PAYLOAD" in norm(md))
check("has script var", lambda: "var x=1" in norm(md))
check("has comment", lambda: "a comment" in norm(md))

print("\n== markdown(main_content_only=True) ==")
check("has HIDDEN payload", lambda: "HIDDEN INJECTION PAYLOAD" in norm(md_body))
check("has ARIA payload", lambda: "ARIA HIDDEN PAYLOAD" in norm(md_body))
check("has nav", lambda: "Site Nav" in norm(md_body))
check("has footer", lambda: "Footer" in norm(md_body))

print("\n== markdown(css_selector) ==")
check("css_selector .list", lambda: repr(r.markdown(css_selector=".list"))[:160])

print("\n== Selector public API surface ==")
meths = sorted(m for m in dir(Selector) if not m.startswith("_"))
check("public member count", lambda: len(meths))
check("public members", lambda: meths)

print("\nfailed observations  :", ", ".join(FAILED) if FAILED else "none")
raise SystemExit(1 if FAILED else 0)
