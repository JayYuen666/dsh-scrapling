"""V2: runtime fetch comparison — Scrapling Fetcher vs what dsh's web_fetch can see."""

import time, sys, traceback

URL = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"

print(f"### target: {URL}\n")

# --- 1. Scrapling static Fetcher (curl_cffi) ---
print("== [1] Scrapling Fetcher (curl_cffi, TLS impersonation) ==")
t = time.time()
try:
    from scrapling.fetchers import Fetcher
    r = Fetcher.get(URL, timeout=30, stealthy_headers=True, impersonate="chrome")
    print(f"   status={r.status} reason={r.reason} elapsed={time.time()-t:.2f}s")
    print(f"   body bytes={len(r.body)} | .text len={len(r.get_all_text(strip=True))}")
    print(f"   request UA={r.request_headers.get('user-agent','?')[:70]}")
    print(f"   request hdr keys={sorted(r.request_headers.keys())}")
    print(f"   title={r.css('title::text').get()!r}")
    try:
        md = r.markdown(main_content_only=True)
        print(f"   markdown(body) len={len(md)}")
    except Exception as e:
        print(f"   markdown failed: {e}")
except Exception as e:
    print(f"   FAILED after {time.time()-t:.2f}s: {type(e).__name__}: {e}")
    traceback.print_exc(limit=2)

# --- 2. dsh-equivalent: raw HTML->text with no JS execution ---
print("\n== [2] dsh-equivalent: raw HTML -> text (NO JS execution) ==")
try:
    from lxml import html as LH
    raw = r2.html_content if False else None
except Exception:
    pass
try:
    r2 = Fetcher.get(URL, timeout=30, stealthy_headers=True, impersonate="chrome")
    raw = r2.html_content
    doc = LH.fromstring(raw)
    for bad in doc.xpath("//script|//noscript|//template"):
        bad.getparent().remove(bad)
    txt = "\n".join(t.strip() for t in doc.itertext() if t.strip())
    print(f"   raw html len={len(raw)} -> text len={len(txt)}")
    print(f"   visible text sample: {txt[:200]!r}")
except Exception as e:
    print(f"   FAILED: {type(e).__name__}: {e}")