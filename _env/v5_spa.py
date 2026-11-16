"""V5: controlled proof — dsh-style raw HTML->text vs Scrapling on a JS-rendered shell.

Serves a local SPA shell whose content exists ONLY after JS runs, then compares:
  (a) raw HTML -> text  (what dsh web_fetch can produce: no JS execution)
  (b) Scrapling Fetcher  (curl_cffi, still no JS)
  (c) Scrapling StealthySession (patchright Chromium, JS runs)

Scrapling 0.5 removed `DynamicFetcher`; the dynamic leg is a session. The render leg waits
on `wait_selector` for the node the timer inserts, because `network_idle` alone can settle
before a 50 ms `setTimeout` fires — this page issues no subresources, so an idle network
says nothing about the DOM.

归因规矩：一条腿的 `try` 只包住它自己的传输（import / get / fromstring），抽出、渲染与
打印各报自己的标签。第 [a] 腿原先连 `Fetcher.get` 与 `LH.fromstring` 都裸写在最外层
`try` 里 —— 那两处一抛，控制流直接跳到 `finally`，`DONE` 与 `failed expectations` 汇总
一行都不打，[b]、[c] 两腿也连跑都跑不到。
"""

import itertools
import socketserver
import sys
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler

from lxml import html as LH
from scrapling.fetchers import Fetcher, StealthySession

PAGE = """<!doctype html>
<html><head><title>SPA Shell</title></head>
<body>
<div id="app">LOADING_PLACEHOLDER</div>
<script>
  setTimeout(function () {
    document.getElementById('app').innerHTML =
      '<h1>Server Price</h1>' +
      '<table><tr><th>SKU</th><th>Price</th></tr>' +
      '<tr><td>ABC-1</td><td>$19.99</td></tr></table>' +
      '<p>Total records: 4,281</p>';
    document.title = 'SPA Rendered';
  }, 50);
</script>
</body></html>"""

MARK = "Server Price"
FAILED: list[str] = []


class H(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


def check(label: str, value: Callable[[], object]) -> None:
    """Print one observation; a raising `value()` becomes a labelled failure."""
    try:
        print(f"   {label:<24} = {value()}")
    except Exception as error:  # noqa: BLE001 — 探针要报任何一类意外
        FAILED.append(label)
        print(f"   {label:<24} = OBSERVE-FAIL {type(error).__name__}: {error}")


def expect(label: str, ok: Callable[[], bool]) -> None:
    """Print one expectation; `False` is a recorded failure, not just a line."""
    try:
        holds = ok()
    except Exception as error:  # noqa: BLE001
        FAILED.append(label)
        print(f"   {label:<40} -> OBSERVE-FAIL {type(error).__name__}: {error}")
        return
    if not holds:
        FAILED.append(label)
    print(f"   {label:<40} -> {'OK' if holds else 'FAIL'}")


def report_leg(label: str, error: BaseException) -> None:
    """Record a leg-level transport failure under that leg's own name."""
    FAILED.append(label)
    print(f"   {label} FAILED {type(error).__name__}: {error}")


# `socketserver.TCPServer.allow_reuse_address = True` 会改掉同进程里所有 TCPServer 子类的行为；
# 复用端口是这一个服务实例要的事，就写在这个子类上。
class ReuseTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request: object, client_address: tuple[str, int]) -> None:
        # curl_cffi 与 Chromium 都会在拿到完整响应前关掉连接（导航取消、页面提前 close），断连异常
        # 于是从 stdlib 里抛出（实测帧：`http/server.py` 的 `flush_headers` → `socketserver.py` 的
        # `write` → BrokenPipeError），包在 `do_GET` 里接不住。`handle_error` 是每个 handler 线程
        # 出事的必经口，所以只在这里吞这两类断连并计数，其余异常照常打 traceback。
        #
        # 计数用 `itertools.count` 而不是 `+= 1`：`ThreadingMixIn` 下每个请求一个线程，
        # `count += 1` 是读-改-写三步、会在多个断连同时收尾时丢计数。`next(count)` 是
        # 单次原子推进，读到值再减一即可（只用于打印一行，不需要精确序号）。
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError)):
            next(DISCONNECTS)
            return
        super().handle_error(request, client_address)


DISCONNECTS = itertools.count(1)
srv = ReuseTCPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/"
print(f"local SPA shell served at {URL}\n")

try:
    print("== [a] dsh-equivalent: raw HTTP -> text (NO JS) ==")
    # 只包住这一腿自己的传输：`Fetcher.get` 与 `LH.fromstring` 抛错要归到 [a] 名下，
    # 而不是让控制流直接跳出最外层 try、把后面两腿和汇总一起吞掉。
    r = None
    doc = None
    try:
        r = Fetcher.get(URL, timeout=20)
        doc = LH.fromstring(r.html_content)
    except Exception as error:  # noqa: BLE001
        report_leg("[a] static transport", error)

    if doc is not None:
        for bad in doc.xpath("//script|//noscript|//template|//style"):
            bad.getparent().remove(bad)

        def plain_text() -> str:
            return "\n".join(t.strip() for t in doc.itertext() if t.strip())

        check("text", plain_text)
        check("markdown(body)", lambda: repr(r.markdown(main_content_only=True).strip()))
        expect("no-JS text lacks the rendered mark", lambda: MARK not in plain_text())

    print("\n== [b] Scrapling Fetcher (curl_cffi, still no JS) ==")
    if r is not None:
        check(".get_all_text()", lambda: repr(r.get_all_text(strip=True)))
        check("title", lambda: r.css("title::text").get())
        expect("Fetcher without JS also lacks it", lambda: MARK not in r.get_all_text(strip=True))

    print("\n== [c] Scrapling StealthySession (patchright Chromium — JS runs) ==")
    started = time.time()
    session = None
    r2 = None
    try:
        session = StealthySession(headless=True)
        session.start()
        # wait_selector is a fetch-level key and it waits on the very node the timer appends.
        r2 = session.fetch(URL, timeout=30000, wait_selector="#app h1")
    except Exception as error:  # noqa: BLE001 — 同样只包传输，记在 [c] 名下
        report_leg("[c] session fetch", error)
        r2 = None

    if r2 is not None:
        print(f"   {time.time() - started:.1f}s status={r2.status}")
        check("title", lambda: r2.css("title::text").get())
        check(".get_all_text()", lambda: repr(r2.get_all_text(strip=True)))
        check("total records", lambda: r2.css("p::text").re_first(r"([0-9,]+)"))
        check("table row", lambda: r2.css("table tr:nth-child(2) td::text").getall())
        # script/style 默认就在 `get_all_text` 的 ignore_tags 里（实测签名
        # `ignore_tags=('script','style')`），所以这个 MARK 只可能来自 JS 真正改动过的 DOM，
        # 不是「脚本标签还留在文档里」的自证。
        expect("rendered DOM carries the mark", lambda: MARK in r2.get_all_text(strip=True))
    if session is not None:
        try:
            session.close()
        except Exception as error:  # noqa: BLE001
            report_leg("[c] session close", error)
finally:
    # shutdown() 只停 serve_forever；监听套接字要 server_close() 才释放。放在 finally 里是因为
    # 上面任何一步抛错都不该把端口留给下一个进程。
    srv.shutdown()
    srv.server_close()

print(f"\nclient disconnects      : {next(DISCONNECTS) - 1}")
print("failed expectations     :", ", ".join(FAILED) if FAILED else "none")
print("DONE")
raise SystemExit(1 if FAILED else 0)
