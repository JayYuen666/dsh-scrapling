"""V4: dynamic (patchright Chromium) vs static fetch on a JS-rendered page.

Scrapling 0.5 removed `DynamicFetcher` and `capture_xhr`: the dynamic leg is a
`StealthySession`, and XHR/fetch history comes from `session.network` once
`record_requests` is enabled at construction time. Which keys belong to the session
constructor and which to a single `fetch` call is recorded in `py/adapters.py`
(`SESSION_ONLY_KEYS` / `FETCH_LEVEL_KEYS`); a session-only key passed per fetch is
dropped upstream without an error.

Attribution rule for this probe: the `try` around a leg covers only that leg's own
transport (import / start / fetch). Text extraction, markdown rendering and printing
are each reported under their own label, so a failure in post-processing says which
step broke instead of naming the fetch.

**The default target is a server-rendered page**, so `dynamic_len - static_len` on it
proves only that both legs run — it does not prove anything about JS rendering. Pass a
JS-rendered URL (and `--wait <selector>` when its content lands after load) to make the
delta mean something:

    _env/v4_dynamic.py https://example.com/spa --wait '#price'

V5 (`_env/v5_spa.py`) 起一个只有 JS 才填内容的本地页，是这条判据真正的对照。
`network_idle` alone can settle before a late `setTimeout` fires — 静默的网络并不代表
DOM 定稿，所以等待条件由 `--wait` 显式给出，而不是靠 network_idle 猜。
"""

import sys
import time
from collections.abc import Callable

DEFAULT_URL = "https://quotes.toscrape.com/"
FAILED: list[str] = []


def parse_args(argv: list[str]) -> tuple[str, dict[str, str]]:
    """Split positional vs `--flag value`; a flag without a value keeps an empty string."""
    positional: list[str] = []
    options: dict[str, str] = {}
    index = 0
    while index < len(argv):
        item = argv[index]
        if item.startswith("--"):
            options[item] = argv[index + 1] if index + 1 < len(argv) else ""
            index += 2
            continue
        positional.append(item)
        index += 1
    return (positional[0] if positional else DEFAULT_URL), options


URL, OPTIONS = parse_args(sys.argv[1:])
WAIT_SELECTOR = OPTIONS.get("--wait") or None
WAIT_STATE = OPTIONS.get("--wait-state") or "attached"


def report_step(label: str, value: Callable[[], object]) -> object | None:
    """Print one post-fetch step; a raising step returns None and is recorded."""
    try:
        result = value()
    except Exception as error:  # noqa: BLE001 — 这一步失败要说出自己是谁，不能冒名成抓取失败
        FAILED.append(label)
        print(f"   {label} = OBSERVE-FAIL {type(error).__name__}: {error}", flush=True)
        return None
    print(f"   {label} = {result!r}", flush=True)
    return result


def report_count(label: str, value: Callable[[], int]) -> None:
    """Print a step's **count only**; the value itself can be megabytes across 100 entries.

    `report_step` 会 `repr()` 整个结果，对 `session.network.search()` 那样的完整条目
    列表等于把每条响应体都写进 stdout（上游给每条响应体 1 MiB、会话总量 20 MiB 的硬上限）。
    下一步只打前 5 条正是为了不被埋掉，所以这一次只报条数。
    """
    report_step(label, lambda: f"{value()} entries")


def report_leg(label: str, error: BaseException) -> None:
    """Record a leg-level transport failure under that leg's own name."""
    FAILED.append(label)
    print(f"   {label} FAILED {type(error).__name__}: {error}", flush=True)


def entry_line(entry: object) -> str:
    """One line per network entry, read through getattr so a shape change is one bad line.

    `py/adapters.py` 处理同一批上游对象时也是逐条 `try` + `getattr`：一条 entry 少了
    `body` 或 `url` 不是 str 时，整份探针不该以 AttributeError 收场、连 `failed steps`
    汇总都打不出来。
    """
    status = getattr(entry, "status", "?")
    url = getattr(entry, "url", "")
    body = getattr(entry, "body", None)
    shown = url[:90] if isinstance(url, str) else repr(url)
    if body is None:
        size = 0
    elif isinstance(body, bytes | bytearray):
        size = len(body)
    else:
        size = len(str(body))
    return f"   - {status} {shown} ({size}B)"


print(f"### {URL}", flush=True)
if WAIT_SELECTOR is not None:
    print(f"### waiting for {WAIT_SELECTOR!r} ({WAIT_STATE})", flush=True)

print("\n== [1] static Fetcher (what dsh's web_fetch approximates) ==")
t = time.time()
static_len = None
try:
    from scrapling.fetchers import Fetcher

    r = Fetcher.get(URL, timeout=45)
except Exception as error:  # noqa: BLE001
    report_leg("[1] static fetch", error)
    r = None
if r is not None:
    print(f"   {time.time() - t:.1f}s status={r.status}", flush=True)
    static_len = report_step("text_len", lambda: len(r.get_all_text(strip=True)))
    report_step("head", lambda: r.get_all_text(strip=True)[:150])
    report_step("markdown(body) len", lambda: len(r.markdown(main_content_only=True)))

print("\n== [2] StealthySession (patchright Chromium — JS runs) ==", flush=True)
dynamic_len = None
records: list[object] = []
t = time.time()
r2 = None
session = None
wait_params: dict[str, str] = {}
if WAIT_SELECTOR is not None:
    wait_params["wait_selector"] = WAIT_SELECTOR
    wait_params["wait_selector_state"] = WAIT_STATE
try:
    from scrapling.fetchers import StealthySession

    session = StealthySession(headless=True, record_requests=True)
    session.start()
    r2 = session.fetch(URL, network_idle=True, timeout=45000, **wait_params)
except Exception as error:  # noqa: BLE001 — 传输这一段自己的失败，记在这一腿名下
    report_leg("[2] session fetch", error)
    r2 = None

if session is not None:
    # 后处理与打印都在 `try` 之外：stdout 被管道提前关掉（BrokenPipeError）不该被
    # 记成「抓取失败」。同一原则见第 1 腿的 `if r is not None:`。
    try:
        if r2 is not None:
            print(f"   {time.time() - t:.1f}s status={r2.status}", flush=True)
            dynamic_len = report_step("text_len", lambda: len(r2.get_all_text(strip=True)))
            report_step("head", lambda: r2.get_all_text(strip=True)[:150])
            report_step("markdown(body) len", lambda: len(r2.markdown(main_content_only=True)))
            # include_static=False keeps xhr/fetch plus 4xx/5xx; static assets would bury the
            # list. `session.network` 读的是活动会话的缓冲，只能在 close 之前取。
            found = session.network.search(include_static=False)
            records = found if isinstance(found, list) else []
            report_count("network entries", lambda: len(records))
    finally:
        # closing() 的语义在这里显式写出来：怎么出去都要 close，close 自己出错也归给这一腿。
        try:
            session.close()
        except Exception as error:  # noqa: BLE001
            report_leg("[2] session close", error)

# The delta measures something only when both legs produced text. Treating a failed static
# leg as length 0 prints "rendered DOM is N chars richer" out of nothing, and that number is
# the reason this script exists.
if static_len is None or dynamic_len is None:
    print("\n   dynamic vs static: one leg produced no text, delta not comparable.", flush=True)
else:
    print(f"\n   rendered DOM is {dynamic_len - static_len} chars richer than static", flush=True)
    if WAIT_SELECTOR is None:
        print(
            "   （没给 --wait：network_idle 在 load 之后才灌内容的页面上会提前返回，差值偏小；"
            "默认目标本身是服务端直出，这个数字只证两条腿跑得通）",
            flush=True,
        )

print("\n== [3] session network history (0.5's replacement for capture_xhr) ==", flush=True)
if not records:
    print("   no entries (page issued no xhr/fetch, or the session leg above failed)", flush=True)

for index, entry in enumerate(records[:5]):
    report_step(f"entry {index}", lambda entry=entry: entry_line(entry))

print("\nfailed steps           :", ", ".join(FAILED) if FAILED else "none", flush=True)
print("DONE", flush=True)
raise SystemExit(1 if FAILED else 0)
