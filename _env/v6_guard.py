"""V6: validate the page_setup SSRF-guard design against real Scrapling + Playwright.

Claim under test: a route handler registered in page_setup SURVIVES Scrapling's
internal page.unroute_all() and can abort requests, so it can enforce an
SSRF allow-policy on the browser path.
"""

import http.server, socketserver, threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
import ipaddress

from scrapling.fetchers import DynamicFetcher

PORT_HOLDER = {}


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            body = (b'<!doctype html><html><head><title>Local</title></head><body>'
                    b'<h1 id="ok">LOCAL_OK</h1>'
                    b'<img src="http://blocked.invalid/x.png">'
                    b'</body></html>')
            ct = "text/html"
        else:
            body = b"IMG"
            ct = "image/png"
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/"
print(f"local server at {URL}\n")

BLOCKED = {"blocked.invalid", "169.254.169.254"}
ALLOWED = {"127.0.0.1", "localhost", "::1"}
seen = {"aborted": [], "allowed": []}


def host_allowed(host: str) -> bool:
    if host in ALLOWED:
        return True
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return host not in BLOCKED  # unresolvable -> treat public unless explicitly blocked


def guard(route):
    host = urlparse(route.request.url).hostname or ""
    if host_allowed(host):
        seen["allowed"].append(host)
        route.continue_()
    else:
        seen["aborted"].append(host)
        route.abort()


def page_setup(page):
    page.route("**/*", guard)


print("== [1] baseline WITHOUT guard ==")
r = DynamicFetcher.fetch(URL, headless=True, timeout=30000)
print(f"   page rendered: {'LOCAL_OK' in r.html_content}")

print("\n== [2] WITH page_setup guard (does it survive unroute_all?) ==")
r2 = DynamicFetcher.fetch(URL, headless=True, timeout=30000, page_setup=page_setup)
print(f"   handler was invoked (allowed): {seen['allowed']}")
print(f"   aborted requests: {seen['aborted']}")
print(f"   page still rendered: {'LOCAL_OK' in r2.html_content}")
print(f"   title: {r2.css('title::text').get()!r}")

print("\n== [3] guard on the MAIN navigation ==")
try:
    r3 = DynamicFetcher.fetch("http://169.254.169.254/latest/meta-data/",
                              headless=True, timeout=10000, page_setup=page_setup)
    print(f"   NOT blocked -> status={r3.status}")
except Exception as e:
    print(f"   blocked -> {type(e).__name__}: {str(e)[:100]}")

print("\n== [4] page_setup errors are swallowed ==")
try:
    r4 = DynamicFetcher.fetch(URL, headless=True, timeout=20000,
                              page_setup=lambda p: (_ for _ in ()).throw(RuntimeError("boom")))
    print(f"   returned normally despite failed setup: status={r4.status}  <- cannot rely on exceptions")
except Exception as e:
    print(f"   raised {type(e).__name__}: {str(e)[:80]}")

srv.shutdown()
print("\nDONE")