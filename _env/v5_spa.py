"""V5: controlled proof — dsh-style raw HTML->text vs Scrapling on a JS-rendered shell.

Serves a local SPA shell whose content exists ONLY after JS runs, then compares:
  (a) raw HTML -> text  (what dsh web_fetch can produce: no JS execution)
  (b) Scrapling Fetcher  (curl_cffi, still no JS)
  (c) Scrapling DynamicFetcher (Playwright, JS runs)
"""

import http.server, socketserver, threading, time

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


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/"
print(f"local SPA shell served at {URL}\n")

MARK = "Server Price"
from scrapling.fetchers import Fetcher, DynamicFetcher
from lxml import html as LH

print("== [a] dsh-equivalent: raw HTTP -> text (NO JS) ==")
r = Fetcher.get(URL, timeout=20)
doc = LH.fromstring(r.html_content)
for bad in doc.xpath("//script|//noscript|//template|//style"):
    bad.getparent().remove(bad)
txt = "\n".join(t.strip() for t in doc.itertext() if t.strip())
print(f"   text          = {txt!r}")
print(f"   markdown(body)= {r.markdown(main_content_only=True).strip()!r}")
print(f"   contains {MARK!r}? -> {MARK in txt}")

print("\n== [b] Scrapling Fetcher (curl_cffi, still no JS) ==")
print(f"   .get_all_text() = {r.get_all_text(strip=True)!r}")
print(f"   title = {r.css('title::text').get()!r}")
print(f"   contains {MARK!r}? -> {MARK in r.get_all_text(strip=True)}")

print("\n== [c] Scrapling DynamicFetcher (Playwright — JS runs) ==")
t = time.time()
r2 = DynamicFetcher.fetch(URL, headless=True, timeout=30000, network_idle=True)
print(f"   {time.time()-t:.1f}s status={r2.status}")
print(f"   title = {r2.css('title::text').get()!r}")
print(f"   .get_all_text() = {r2.get_all_text(strip=True)!r}")
print(f"   contains {MARK!r}? -> {MARK in r2.get_all_text(strip=True)}")
print(f"\n   markdown(body):\n---\n{r2.markdown(main_content_only=True).strip()}\n---")
print(f"   structured: total records = {r2.css('p::text').re_first(r'([\\d,]+)')}")
print(f"   structured: table row     = {r2.css('table tr:nth-child(2) td::text').getall()}")

srv.shutdown()