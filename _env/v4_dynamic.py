"""V4: dynamic (patchright Chromium) vs static fetch on a JS-rendered page.

Scrapling 0.5 removed `DynamicFetcher` and `capture_xhr`: the dynamic leg is a
`StealthySession`, and XHR/fetch history comes from `session.network` once
`record_requests` is enabled at construction time. Which keys belong to the session
constructor and which to a single `fetch` call is recorded in `py/adapters.py`
(`SESSION_ONLY_KEYS` / `FETCH_LEVEL_KEYS`); a session-only key passed per fetch is
dropped upstream without an error.
"""

import sys
import time

URL = sys.argv[1] if len(sys.argv) > 1 else "https://quotes.toscrape.com/"

print(f"### {URL}", flush=True)

print("\n== [1] static Fetcher (what dsh's web_fetch approximates) ==", flush=True)
static_len = None
t = time.time()
try:
    from scrapling.fetchers import Fetcher

    r = Fetcher.get(URL, timeout=45)
    static_text = r.get_all_text(strip=True)
    static_len = len(static_text)
    print(f"   {time.time()-t:.1f}s status={r.status} text_len={static_len}")
    print(f"   head: {static_text[:150]!r}")
    print(f"   markdown(body) len={len(r.markdown(main_content_only=True))}")
except Exception as e:
    print(f"   FAILED {type(e).__name__}: {e}", flush=True)

print("\n== [2] StealthySession (patchright Chromium — JS runs) ==", flush=True)
dynamic_len = None
records = []
t = time.time()
try:
    from scrapling.fetchers import StealthySession

    session = StealthySession(headless=True, record_requests=True)
    try:
        session.start()
        r2 = session.fetch(URL, network_idle=True, timeout=45000)
        dynamic_text = r2.get_all_text(strip=True)
        dynamic_len = len(dynamic_text)
        print(f"   {time.time()-t:.1f}s status={r2.status} text_len={dynamic_len}")
        print(f"   head: {dynamic_text[:150]!r}")
        print(f"   markdown(body) len={len(r2.markdown(main_content_only=True))}")
        # include_static=False keeps xhr/fetch plus 4xx/5xx; static assets would bury the list.
        records = session.network.search(include_static=False)
    finally:
        session.close()
except Exception as e:
    print(f"   FAILED {type(e).__name__}: {e}", flush=True)

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

print("\nDONE", flush=True)
