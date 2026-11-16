"""V2: runtime fetch comparison — Scrapling Fetcher vs what dsh's web_fetch can see.

Failure reporting is one shape for both legs: the class, the message and a short
traceback, plus which kind of failure it is. `type(e).__name__` alone cannot tell
「缺依赖」apart from「抓取失败」apart from「本探针自己写错」, and the two need
different fixes. 因此每条腿的 `try` **只包住它自己的传输**（import / 抓取），
展示与后处理放在外面：那些语句里的异常是本探针自己写错，不该被记成抓取失败。
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
except ImportError as error:
    # 两条腿都要这个 import；报一次并停下，好过打第二条其实是同一个缺包的 FAILED。
    # 只捕 ImportError：包在、但导入期抛 SyntaxError/AttributeError 是**环境损坏**，
    # 说成「缺依赖」会把人支去 pip install。
    print(f"   [1] 缺依赖（scrapling 装不上）：{type(error).__name__}: {error}")
    print("   [2] 也跑不了，跳过")
    raise SystemExit(1) from error
except Exception as error:
    report("环境损坏", "[1] import scrapling", error)
    raise SystemExit(1) from error

r = None
try:
    r = Fetcher.get(URL, timeout=30, stealthy_headers=True, impersonate="chrome")
except Exception as error:  # noqa: BLE001
    report("抓取失败", "[1] fetch", error)

# 展示与后处理在 try 之外：这里任何一处抛错都是本探针自己写错（非 str 的 header 键、
# stdout 编码、属性形状漂移），归成「抓取失败」会把排查引向网络。
if r is not None:
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
        report("解析失败", "[1] markdown", error)

# --- 2. raw HTML -> text with no JS execution (dsh 的上界，不是 dsh 的实际口径) ---
# 标题刻意不写「dsh-equivalent」：这一腿只删 script/noscript/template，而 dsh 的静态路径
# （py/adapters.py 的 _sanitized_page + _strip_active_content）还会清掉 display:none /
# aria-hidden 的节点、onclick、meta refresh、srcdoc 等。所以这里量到的是**上界**：
# dsh 实际回给模型的正文字数只会比它少。据此可以说「dsh 看不到 JS 内容」，不能反过来说
# 「dsh 看到的和这里一样多」。
print("\n== [2] raw HTML -> text, script tags dropped (NO JS execution; upper bound) ==")
extract = None
try:
    from lxml import html as LH

    extract = LH.fromstring
except ImportError as error:
    report("缺依赖", "[2] import lxml", error)

if extract is not None:
    # 复用第 1 腿已经取到的那份响应：同一个 URL 再发一次完全相同的请求只会把耗时翻倍，
    # 而且两条腿拿到的可能是不同快照，text/markdown 的长度对比也就不成立了。
    # 只有第 1 腿自己抓失败（r is None）时才补发一次。
    r2 = r
    if r2 is None:
        try:
            r2 = Fetcher.get(URL, timeout=30, stealthy_headers=True, impersonate="chrome")
        except Exception as error:  # noqa: BLE001
            report("抓取失败", "[2] fetch", error)
    if r2 is not None:
        raw = r2.html_content
        try:
            doc = extract(raw)
            for bad in doc.xpath("//script|//noscript|//template"):
                bad.getparent().remove(bad)
            txt = "\n".join(t.strip() for t in doc.itertext() if t.strip())
            print(f"   raw html len={len(raw)} -> text len={len(txt)}")
            print(f"   visible text sample: {txt[:200]!r}")
        except Exception as error:  # noqa: BLE001
            report("解析失败", "[2] text extract", error)

print("\nfailed legs          :", ", ".join(FAILED) if FAILED else "none")
raise SystemExit(1 if FAILED else 0)
