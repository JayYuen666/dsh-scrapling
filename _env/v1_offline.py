"""V1: offline verification — pure parser capability, zero network/browser.

Every observation is one labelled line. A failing observation prints
`OBSERVE-FAIL <type>: <message>` and the run continues: the point of this probe
is *which* capability stopped behaving, and an unguarded call aborts every
observation after it. (Measured on 0.5.x: `p.css("ul").has_class(...)` raises
`AttributeError: 'Selectors' object has no attribute 'has_class'`, which used to
swallow the whole `Response.markdown` half of this file.)

Two kinds of observation:
  * `observe(label, fn)` — 只要不抛就算过，用于「这一能力还在不在」。
  * `expect(label, fn, wanted)` — 还要求返回值等于 `wanted`，用于**清洗类**观测：
    清洗坏掉时 `fn` 不抛，只是把 payload 又印了出来，单靠「没崩」判不出来。

The exit code is non-zero when any observation failed, so the probe doubles as a
check.
"""

import re
from collections.abc import Callable
from typing import Never

import scrapling.parser as parser_module

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


def fail(label: str, error: BaseException) -> None:
    """Record and print one failed observation, once, in one shape."""
    FAILED.append(label)
    print(f"{label:<28}: OBSERVE-FAIL {type(error).__name__}: {error}")


def run(label: str, value: Callable[[], object]) -> object | None:
    """Evaluate one observation; return its value, or `None` when it raised.

    Callers that need the value (the two markdown halves below) use this instead
    of a bare `try` so that a failure prints once and the run keeps going — an
    early `SystemExit` here would skip every section that does not depend on it.
    """
    try:
        result = value()
    except Exception as error:  # noqa: BLE001 — 探针要报任何一类意外，而不是只报它预料到的那种
        fail(label, error)
        return None
    print(f"{label:<28}: {result}")
    return result


def observe(label: str, value: Callable[[], object]) -> None:
    """`run` for observations whose single-line print is the whole point."""
    run(label, value)


def expect(label: str, value: Callable[[], object], wanted: object) -> None:
    """Observe, and fail when the value is not `wanted`.

    清洗类观测必须走这条：`"HIDDEN INJECTION PAYLOAD" in md` 为真说明清洗坏了，
    而它**不抛** —— `observe` 只会把它当成一条成功的 `True` 印出来，退出码还是 0。
    """
    try:
        result = value()
    except Exception as error:  # noqa: BLE001
        fail(label, error)
        return
    if result == wanted:
        print(f"{label:<28}: {result!r}")
        return
    FAILED.append(label)
    print(f"{label:<28}: OBSERVE-FAIL expected {wanted!r}, got {result!r}")


def one(adaptors: object, what: str) -> object:
    """Take the first match, or name the miss.

    `.first` is `None` when nothing matched, and `None.parent` then reads as a bug in
    this script instead of as a parser-capability result.
    """
    head = getattr(adaptors, "first", None)
    if head is None:
        raise LookupError(f"{what} 没有匹配（.first 是 None）")
    return head


def parent_of(node: object, what: str) -> object:
    """Take `.parent`, or say the node already is a root."""
    parent = getattr(node, "parent", None)
    if parent is None:
        raise LookupError(f"{what} 已经在上层为根（parent 是 None）")
    return parent


def norm(text: str) -> str:
    """Collapse whitespace before matching.

    Markdown reflows its output (line breaks, runs of spaces), so a raw substring test
    can miss a payload that really is present — a false "cleaning works" reading.
    """
    return re.sub(r"\s+", " ", text)


def fatal(message: str) -> Never:
    """把「脚本自己起不来」与「某个能力坏了」分开报，并以非零码退出。"""
    print(f"{'probe':<28}: OBSERVE-FAIL {message}")
    print("\nfailed observations  :", ", ".join([*FAILED, message]))
    raise SystemExit(1)


# 导入也不再是裸的：`Selectors` 在某版本被改名/移除时，原先连第一行都跑不到，
# 只剩一段 traceback，读不出「是 parser 的导出变了」。
try:
    Selector = parser_module.Selector
    Selectors = parser_module.Selectors
except AttributeError as error:
    fatal(f"scrapling.parser 的导出变了：{type(error).__name__}: {error}")

print("== basic selection ==")
# 解析器构造与两次 css 也走 run：它们是后面每一节的前提，但「前提坏了」应该记成
# 一条点名失败，而不是带着裸 traceback 把整份脚本吞掉。
p = run("Selector(HTML)", lambda: Selector(HTML))
items = None if p is None else run('css("li")', lambda: p.css("li"))
lists = None if p is None else run('css("ul")', lambda: p.css("ul"))

if p is not None:
    observe("css h1.text", lambda: p.css("h1.title::text").get())
    observe("css all items", lambda: p.css(".item::text").getall())
    # `Selectors` is a list subclass, so `.count` on it is `list.count(value)` and not a
    # size — `len()` is the number this line means.
    observe("xpath count", lambda: len(p.xpath("//li[@class='item']")))
    observe("attrib data-id", lambda: p.css(".item::attr(data-id)").getall())
    # `re_first` searches the node's text, not the serialised HTML: the attribute pattern
    # below is expected to miss, and the miss itself is the observation.
    observe("re_first on text", lambda: p.re_first(r'data-id="(\d+)"'))
    observe("get_all_text", lambda: repr(p.get_all_text(strip=True))[:120])
    # `has_class` lives on a single Selector, not on the result list.
    if lists is not None:
        observe("has_class", lambda: one(lists, 'css("ul")').has_class("list"))
    if items is not None:
        observe(
            "parent chain",
            lambda: parent_of(one(items, 'css("li")'), 'css("li")').attrib.get("class"),
        )
    observe("urljoin", lambda: p.urljoin("/abs"))

    print("\n== find_similar / similarity ==")
    if items is not None:
        observe(
            "similar ids",
            lambda: [
                similar.attrib.get("data-id")
                for similar in one(items, 'css("li")').find_similar(similarity_threshold=0.5)
            ],
        )

print("\n== Response.markdown() injection sanitization ==")
# `Response` has no public re-export in this version (`scrapling.fetchers`,
# `scrapling.core` and `scrapling.parser` all lack it), so this leg reads the private
# path on purpose and names it in the report. If the module moves or the constructor
# changes, the line below says so instead of a bare ImportError.
Response = None
try:
    from scrapling.engines.toolbelt.custom import Response as _Response

    Response = _Response
except Exception as error:  # noqa: BLE001
    fail("Response import", error)

r = (
    None
    if Response is None
    else run(
        "Response(...)",
        lambda: Response(
            url="http://example.com",
            content=HTML,
            status=200,
            reason="OK",
            cookies={},
            headers={},
            request_headers={},
        ),
    )
)

# 两次 markdown 分别 run：`markdown()` 成功而 `main_content_only=True` 抛错时，
# 前一半已经拿到的 `md` 不该被丢掉；也不该顺带跳过后面与 Response 无关的 API 段。
md = None if r is None else run("markdown()", r.markdown)
md_body = None if r is None else run("markdown(main_content_only=True)", lambda: r.markdown(main_content_only=True))

if md is not None:
    observe("markdown", lambda: repr(md)[:220])
    observe("markdown length", lambda: len(md))
    expect("has HIDDEN payload", lambda: "HIDDEN INJECTION PAYLOAD" in norm(md), False)
    expect("has ARIA payload", lambda: "ARIA HIDDEN PAYLOAD" in norm(md), False)
    expect("has script var", lambda: "var x=1" in norm(md), False)
    expect("has comment", lambda: "a comment" in norm(md), False)

print("\n== markdown(main_content_only=True) ==")
if md_body is not None:
    # 标签带上 (body)：与上面全量 markdown 的两条同名观测分开 —— 报告末尾只印标签，
    # 同名就分不出「哪一种清洗坏了」。
    expect("has HIDDEN payload (body)", lambda: "HIDDEN INJECTION PAYLOAD" in norm(md_body), False)
    expect("has ARIA payload (body)", lambda: "ARIA HIDDEN PAYLOAD" in norm(md_body), False)
    expect("has nav (body)", lambda: "Site Nav" in norm(md_body), True)
    expect("has footer (body)", lambda: "Footer" in norm(md_body), True)

print("\n== markdown(css_selector) ==")
if r is not None:
    observe("css_selector .list", lambda: repr(r.markdown(css_selector=".list"))[:160])

print("\n== Selector public API surface ==")
meths = sorted(m for m in dir(Selector) if not m.startswith("_"))
observe("public member count", lambda: len(meths))
observe("public members", lambda: meths)

print("\nfailed observations  :", ", ".join(FAILED) if FAILED else "none")
raise SystemExit(1 if FAILED else 0)
