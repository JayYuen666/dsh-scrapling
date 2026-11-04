"""V2: runtime fetch comparison — Scrapling Fetcher vs what dsh's web_fetch can see.

Failure reporting is one shape for both legs: the class, the message and a short
traceback, plus which kind of failure it is. `type(e).__name__` alone cannot tell
「缺依赖」apart from「抓取失败」apart from「本探针自己写错」, and the two need
different fixes.
"""

import sys
import time
import traceback

URL = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"


FAILED: list[str] = []


def report(kind: str, label: str, error: BaseException) -> None:
    """Print one failure as `kind / label / type / message` plus a short traceback."""
    FAILED.append(f"{label}（{kind}）")
    print(f"   {label}: {kind} — {type(error).__name__}: {error}")
    traceback.print_exc(limit=2)


print(f"### target: {URL}\n")

# --- 1. Scrapling static Fetcher (curl_cffi) ---
print("== [1] Scrapling Fetcher (curl_cffi, TLS impersonation) ==")
t = time.time()
try:
    from scrapling.fetchers import Fetcher
except Exception as error:
    # Both legs need this import; reporting it once and stopping beats printing a
    # second FAILED that is really the same missing package.
    print(f"   scrapling 不可用（缺依赖）：{type(error).__name__}: {error}")
    print("   [2] 也跑不了，跳过")
    raise SystemExit(1) from error

try:
    r = Fetcher.get(URL, timeout=30, stealthy_headers=True, impersonate="chrome")
    print(f"   status={r.status} reason={r.reason} elapsed={time.time() - t:.2f}s")
    print(f"   body bytes={len(r.body)} | .text len={len(r.get_all_text(strip=True))}")
    # `.get(key, default)` 只在键缺席时用默认值：键在而值是 None 时，`[:70]` 会抛
    # `TypeError: 'NoneType' object is not subscriptable`，把前面已经取到的
    # status/body 一起折成一段 FAILED。所以先 `or`，并把整个字典也兜住。
    request_headers = r.request_headers or {}
    print(f"   request UA={(request_headers.get('user-agent') or '?')[:70]}")
    print(f"   request hdr keys={sorted(request_headers.keys())}")
    print(f"   title={r.css('title::text').get()!r}")
    try:
        md = r.markdown(main_content_only=True)
        print(f"   markdown(body) len={len(md)}")
    except Exception as error:  # noqa: BLE001
        report("解析失败", "markdown", error)
except Exception as error:  # noqa: BLE001
    report("抓取失败", "FAILED", error)

# --- 2. dsh-equivalent: raw HTML->text with no JS execution ---
print("\n== [2] dsh-equivalent: raw HTML -> text (NO JS execution) ==")
try:
    from lxml import html as LH

    r2 = Fetcher.get(URL, timeout=30, stealthy_headers=True, impersonate="chrome")
    raw = r2.html_content
    doc = LH.fromstring(raw)
    for bad in doc.xpath("//script|//noscript|//template"):
        bad.getparent().remove(bad)
    txt = "\n".join(t.strip() for t in doc.itertext() if t.strip())
    print(f"   raw html len={len(raw)} -> text len={len(txt)}")
    print(f"   visible text sample: {txt[:200]!r}")
except ImportError as error:
    report("缺依赖", "FAILED", error)
except Exception as error:  # noqa: BLE001
    report("抓取或抽取失败", "FAILED", error)

print("\nfailed legs          :", ", ".join(FAILED) if FAILED else "none")
raise SystemExit(1 if FAILED else 0)
