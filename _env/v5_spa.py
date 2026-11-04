"""V5: controlled proof — dsh-style raw HTML->text vs Scrapling on a JS-rendered shell.

Serves a local SPA shell whose content exists ONLY after JS runs, then compares:
  (a) raw HTML -> text  (what dsh web_fetch can produce: no JS execution)
  (b) Scrapling Fetcher  (curl_cffi, still no JS)
  (c) Scrapling StealthySession (patchright Chromium, JS runs)

Scrapling 0.5 removed `DynamicFetcher`; the dynamic leg is a session. The render leg waits
on `wait_selector` for the node the timer inserts, because `network_idle` alone can settle
before a 50 ms `setTimeout` fires — this page issues no subresources, so an idle network
says nothing about the DOM.
"""

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
disconnects = {"count": 0}


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


# `socketserver.TCPServer.allow_reuse_address = True` 会改掉同进程里所有 TCPServer 子类的行为；
# 复用端口是这一个服务实例要的事，就写在这个子类上。
class ReuseTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

    def handle_error(self, request: object, client_address: tuple[str, int]) -> None:
        # curl_cffi 与 Chromium 都会在拿到完整响应前关掉连接（导航取消、页面提前 close），断连异常
        # 于是从 stdlib 里抛出（实测帧：`http/server.py` 的 `flush_headers` → `socketserver.py` 的
        # `write` → BrokenPipeError），包在 `do_GET` 里接不住。`handle_error` 是每个 handler 线程
        # 出事的必经口，所以只在这里吞这两类断连并计数，其余异常照常打 traceback。
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError)):
            disconnects["count"] += 1
            return
        super().handle_error(request, client_address)


srv = ReuseTCPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/"
print(f"local SPA shell served at {URL}\n")

try:
    print("== [a] dsh-equivalent: raw HTTP -> text (NO JS) ==")
    r = Fetcher.get(URL, timeout=20)
    doc = LH.fromstring(r.html_content)
    for bad in doc.xpath("//script|//noscript|//template|//style"):
        bad.getparent().remove(bad)

    def plain_text() -> str:
        return "\n".join(t.strip() for t in doc.itertext() if t.strip())

    check("text", plain_text)
    check("markdown(body)", lambda: repr(r.markdown(main_content_only=True).strip()))
    expect("no-JS text lacks the rendered mark", lambda: MARK not in plain_text())

    print("\n== [b] Scrapling Fetcher (curl_cffi, still no JS) ==")
    check(".get_all_text()", lambda: repr(r.get_all_text(strip=True)))
    check("title", lambda: r.css("title::text").get())
    expect("Fetcher without JS also lacks it", lambda: MARK not in r.get_all_text(strip=True))

    print("\n== [c] Scrapling StealthySession (patchright Chromium — JS runs) ==")
    started = time.time()
    session = StealthySession(headless=True)
    try:
        session.start()
        # wait_selector is a fetch-level key and it waits on the very node the timer appends.
        r2 = session.fetch(URL, timeout=30000, wait_selector="#app h1")
        print(f"   {time.time() - started:.1f}s status={r2.status}")
        check("title", lambda: r2.css("title::text").get())
        check(".get_all_text()", lambda: repr(r2.get_all_text(strip=True)))
        check("total records", lambda: r2.css("p::text").re_first(r"([0-9,]+)"))
        check("table row", lambda: r2.css("table tr:nth-child(2) td::text").getall())
        expect("rendered DOM carries the mark", lambda: MARK in r2.get_all_text(strip=True))
    finally:
        session.close()
finally:
    # shutdown() 只停 serve_forever；监听套接字要 server_close() 才释放。放在 finally 里是因为
    # 上面任何一步抛错都不该把端口留给下一个进程。
    srv.shutdown()
    srv.server_close()

print(f"\nclient disconnects      : {disconnects['count']}")
print("failed expectations     :", ", ".join(FAILED) if FAILED else "none")
print("DONE")
raise SystemExit(1 if FAILED else 0)
