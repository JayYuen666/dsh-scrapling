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
"""

import contextlib
import sys
import time
from collections.abc import Callable

URL = sys.argv[1] if len(sys.argv) > 1 else "https://quotes.toscrape.com/"
FAILED: list[str] = []


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


def report_leg(label: str, error: BaseException) -> None:
    """Record a leg-level transport failure under that leg's own name."""
    FAILED.append(label)
    print(f"   {label} FAILED {type(error).__name__}: {error}", flush=True)


print(f"### {URL}", flush=True)

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
try:
    from scrapling.fetchers import StealthySession

    # closing() 保证这一腿怎么出去都会 close；close 自己出错就归给这一腿（它是这条链的一环）。
    with contextlib.closing(StealthySession(headless=True, record_requests=True)) as session:
        session.start()
        r2 = session.fetch(URL, network_idle=True, timeout=45000)
        print(f"   {time.time() - t:.1f}s status={r2.status}", flush=True)
        dynamic_len = report_step("text_len", lambda: len(r2.get_all_text(strip=True)))
        report_step("head", lambda: r2.get_all_text(strip=True)[:150])
        report_step("markdown(body) len", lambda: len(r2.markdown(main_content_only=True)))
        # include_static=False keeps xhr/fetch plus 4xx/5xx; static assets would bury the
        # list. `session.network` 读的是活动会话的缓冲，只能在 close 之前取。
        found = report_step("network entries", lambda: session.network.search(include_static=False))
        records = found if isinstance(found, list) else []
except Exception as error:  # noqa: BLE001
    report_leg("[2] session fetch", error)

# The delta measures something only when both legs produced text. Treating a failed static
# leg as length 0 prints "rendered DOM is N chars richer" out of nothing, and that number is
# the reason this script exists.
if static_len is None or dynamic_len is None:
    print("\n   dynamic vs static: one leg produced no text, delta not comparable.", flush=True)
else:
    print(f"\n   rendered DOM is {dynamic_len - static_len} chars richer than static", flush=True)

print("\n== [3] session network history (0.5's replacement for capture_xhr) ==", flush=True)
if not records:
    print("   no entries (page issued no xhr/fetch, or the session leg above failed)", flush=True)
for x in records[:5]:
    body = x.body if x.body is not None else b""
    print(f"   - {x.status} {x.url[:90]} ({len(body)}B)", flush=True)

print("\nfailed steps           :", ", ".join(FAILED) if FAILED else "none", flush=True)
print("DONE", flush=True)
raise SystemExit(1 if FAILED else 0)
