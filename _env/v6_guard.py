"""V6: validate the page_setup SSRF-guard design against real Scrapling + patchright.

Claims under test:
  · a route handler registered in `page_setup` SURVIVES Scrapling's internal
    `page.unroute_all()` and can abort requests, so it can enforce an allow-policy on the
    browser path;
  · an exception thrown by `page_setup` does not fail the fetch, so the guard cannot rely
    on exceptions to report its own failure.

Scrapling 0.5 removed `DynamicFetcher`: the browser leg is a `StealthySession` and
`page_setup` is a fetch-level key (`py/adapters.py` `FETCH_LEVEL_KEYS`).

The policy below is deliberately deny-by-default. A hostname allow-list cannot be
approve-by-default: `localhost.evil.com` and `127.0.0.1.nip.io` are public names that
RESOLVE privately, so the only two sound rules are "named in the allow-list" or "literal
address that is global". Name-vs-address confusion is what `py/guard.py` closes by
resolving before deciding; this probe reuses neither that code nor its assumptions.
"""

import http.server, socketserver, threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
import ipaddress

from scrapling.fetchers import StealthySession

BLOCKED = {"blocked.invalid", "169.254.169.254"}
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}


def host_allowed(host: str) -> bool:
    """Allow only an allow-listed name or a literal global address; deny everything else."""
    if host in BLOCKED:
        return False
    if host in ALLOWED_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        # A name that is neither allow-listed nor an address says nothing about where it
        # resolves, so it is not evidence of a public destination.
        return False


seen = {"aborted": [], "allowed": []}


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            body = (b'<!doctype html><html><head><title>Local</title></head><body>'
                    b'<h1 id="ok">LOCAL_OK</h1>'
                    b'<img src="http://blocked.invalid/x.png">'
                    b'<img src="http://localhost.evil.com/x.png">'
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


def browser_fetch(url: str, **kwargs):
    """One browser navigation on a fresh session; page_setup goes in at fetch time."""
    session = StealthySession(headless=True)
    try:
        session.start()
        return session.fetch(url, **kwargs)
    finally:
        session.close()


socketserver.TCPServer.allow_reuse_address = True
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/"
print(f"local server at {URL}\n")

print("== [1] baseline WITHOUT guard ==")
r = browser_fetch(URL, timeout=30000)
print(f"   page rendered: {'LOCAL_OK' in r.html_content}")

print("\n== [2] WITH page_setup guard (does it survive unroute_all?) ==")
r2 = browser_fetch(URL, timeout=30000, page_setup=page_setup)
print(f"   handler was invoked (allowed): {seen['allowed']}")
print(f"   aborted requests: {seen['aborted']}")
print(f"   page still rendered: {'LOCAL_OK' in r2.html_content}")
print(f"   title: {r2.css('title::text').get()!r}")

print("\n== [3] guard on the MAIN navigation ==")
try:
    r3 = browser_fetch("http://169.254.169.254/latest/meta-data/", timeout=10000, page_setup=page_setup)
    print(f"   NOT blocked -> status={r3.status}")
except Exception as e:
    print(f"   blocked -> {type(e).__name__}: {str(e)[:100]}")

print("\n== [4] page_setup errors are swallowed ==")


def exploding_setup(page):
    raise RuntimeError("boom")


try:
    r4 = browser_fetch(URL, timeout=20000, page_setup=exploding_setup)
    print(f"   returned normally despite failed setup: status={r4.status}  <- cannot rely on exceptions")
except Exception as e:
    print(f"   raised {type(e).__name__}: {str(e)[:80]}")

srv.shutdown()
print("\nDONE")
