"""V4: dynamic (Playwright) vs static fetch on a JS-rendered page."""

import sys, time

URL = sys.argv[1] if len(sys.argv) > 1 else "https://quotes.toscrape.com/"
from scrapling.fetchers import Fetcher, DynamicFetcher

print(f"### {URL}", flush=True)

print("\n== [1] static Fetcher (what dsh's web_fetch approximates) ==", flush=True)
t = time.time()
STATIC_LEN = 0
try:
    r = Fetcher.get(URL, timeout=45)
    txt = r.get_all_text(strip=True)
    STATIC_LEN = len(txt)
    print(f"   {time.time()-t:.1f}s status={r.status} text_len={STATIC_LEN}")
    print(f"   head: {txt[:150]!r}")
except Exception as e:
    print(f"   FAILED {type(e).__name__}: {e}", flush=True)

print("\n== [2] DynamicFetcher (Playwright Chromium) ==", flush=True)
t = time.time()
try:
    r2 = DynamicFetcher.fetch(URL, headless=True, network_idle=True, timeout=45000)
    txt2 = r2.get_all_text(strip=True)
    print(f"   {time.time()-t:.1f}s status={r2.status} text_len={len(txt2)}")
    print(f"   head: {txt2[:150]!r}")
    print(f"   rendered DOM is {len(txt2)-STATIC_LEN} chars richer than static")
    print(f"   markdown(body) len={len(r2.markdown(main_content_only=True))}")
except Exception as e:
    print(f"   FAILED {type(e).__name__}: {e}", flush=True)

print("\n== [3] capture_xhr probe ==", flush=True)
t = time.time()
try:
    r3 = DynamicFetcher.fetch(URL, headless=True, timeout=45000, network_idle=True,
                              capture_xhr="*")
    print(f"   {time.time()-t:.1f}s captured_xhr entries={len(r3.captured_xhr)}")
    for x in r3.captured_xhr[:5]:
        print(f"     - {x.status} {x.url[:90]} ({len(x.body)}B)")
except Exception as e:
    print(f"   capture_xhr FAILED {type(e).__name__}: {e}", flush=True)
print("\nDONE", flush=True)