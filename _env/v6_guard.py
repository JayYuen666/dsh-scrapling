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

Why there is a guarded *path* as well as a guarded host: `blocked.invalid` never resolves,
so an abort for it cannot be told apart from a request that would have died in DNS anyway.
The only target that proves the handler actually stopped something is one the server can
see — so `/guarded-…` is served like anything else, and the guard is the only thing between
the page and that byte. Stage [1] (no guard) must show the hit, stage [2] (guard on) must
not.
"""

import ipaddress
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from scrapling.fetchers import StealthySession

BLOCKED = {"blocked.invalid", "169.254.169.254"}
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}
# 探针自定的规则，不是本插件的策略：它只为造出一个「可达但被守卫拒绝」的目标。
GUARDED_PATH = "/guarded-"

seen = {"aborted": [], "allowed": []}
hits = {"guarded": 0}
FAILURES: list[str] = []


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


class H(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith(GUARDED_PATH):
            # 这个计数就是「目标可达」的证据：守卫在位时它不该被加过。
            hits["guarded"] += 1
        if self.path == "/":
            guarded = f'<img src="http://127.0.0.1:{PORT}{GUARDED_PATH}x.png">'.encode()
            body = (
                b"<!doctype html><html><head><title>Local</title></head><body>"
                b'<h1 id="ok">LOCAL_OK</h1>'
                b'<img src="http://blocked.invalid/x.png">'
                b'<img src="http://localhost.evil.com/x.png">' + guarded + b"</body></html>"
            )
            ct = "text/html"
        else:
            body = b"IMG"
            ct = "image/png"
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


def guard(route: Any) -> None:
    parsed = urlparse(route.request.url)
    host = parsed.hostname or ""
    # 空 host 也走 deny：`urlparse` 给不出主机名时不能当成公网目的地。
    if parsed.path.startswith(GUARDED_PATH) or not host_allowed(host):
        seen["aborted"].append(f"{host}{parsed.path}")
        route.abort()
    else:
        seen["allowed"].append(host)
        route.continue_()


def page_setup(page: Any) -> None:
    page.route("**/*", guard)


def browser_fetch(url: str, **kwargs: object) -> Any:
    """One browser navigation on a fresh session; page_setup goes in at fetch time."""
    session = StealthySession(headless=True)
    try:
        session.start()
        return session.fetch(url, **kwargs)
    finally:
        session.close()


def start_stage(title: str) -> None:
    """Clear the per-stage counters so one stage never reads another's bookkeeping."""
    seen["aborted"].clear()
    seen["allowed"].clear()
    hits["guarded"] = 0
    print(f"\n== {title} ==")


def expect(label: str, ok: Callable[[], bool]) -> None:
    """Print one expectation; `False` is a recorded failure, not just a line."""
    try:
        holds = ok()
    except Exception as error:  # noqa: BLE001 — 探针要报任何一类意外
        FAILURES.append(label)
        print(f"   {label:<44} -> OBSERVE-FAIL {type(error).__name__}: {error}")
        return
    if not holds:
        FAILURES.append(label)
    print(f"   {label:<44} -> {'OK' if holds else 'FAIL'}")


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/"
print(f"local server at {URL}")

try:
    start_stage("[1] baseline WITHOUT guard (is the guarded target reachable?)")
    r = browser_fetch(URL, timeout=30000)
    print(f"   page rendered: {'LOCAL_OK' in r.html_content}")
    print(f"   guarded hits: {hits['guarded']}")
    expect("guarded target reaches the server", lambda: hits["guarded"] >= 1)

    start_stage("[2] WITH page_setup guard (does it survive unroute_all?)")
    r2 = browser_fetch(URL, timeout=30000, page_setup=page_setup)
    print(f"   handler was invoked (allowed): {seen['allowed']}")
    print(f"   aborted requests: {seen['aborted']}")
    print(f"   guarded hits: {hits['guarded']}")
    print(f"   page still rendered: {'LOCAL_OK' in r2.html_content}")
    print(f"   title: {r2.css('title::text').get()!r}")
    # 回调有记录 = 路由还在；可达目标没落到服务端 = 拦的是守卫，不是 DNS。
    expect("handler still invoked after unroute_all", lambda: len(seen["allowed"]) > 0)
    expect("guard aborts a reachable target", lambda: hits["guarded"] == 0)
    expect("guarded host shows up in aborted", lambda: any(GUARDED_PATH in h for h in seen["aborted"]))

    start_stage("[3] guard on the MAIN navigation")
    blocked_navigation = False
    try:
        r3 = browser_fetch("http://169.254.169.254/latest/meta-data/", timeout=10000, page_setup=page_setup)
        print(f"   NOT blocked -> status={r3.status}")
    except Exception as error:  # noqa: BLE001
        blocked_navigation = True
        print(f"   blocked -> {type(error).__name__}: {str(error)[:100]}")
    expect("main navigation to a blocked address fails", lambda: blocked_navigation)

    start_stage("[4] page_setup errors are swallowed")

    def exploding_setup(page: Any) -> None:
        raise RuntimeError("boom")

    returned_despite_error = False
    try:
        r4 = browser_fetch(URL, timeout=20000, page_setup=exploding_setup)
        returned_despite_error = True
        print(f"   returned normally despite failed setup: status={r4.status}")
    except Exception as error:  # noqa: BLE001
        print(f"   raised {type(error).__name__}: {str(error)[:80]}")
    # 这条要证的正是「守卫自己起不来时不会以异常报告」，所以期望就是它照常返回。
    expect("page_setup exception does not fail the fetch", lambda: returned_despite_error)
finally:
    # shutdown() 只管停 serve_forever，监听套接字要 server_close() 才释放；
    # 放在 finally 里是因为前面任何一次 fetch/import 抛错都不能把端口留给下一个进程。
    srv.shutdown()
    srv.server_close()

print("\nfailed expectations    :", ", ".join(FAILURES) if FAILURES else "none")
print("DONE")
raise SystemExit(1 if FAILURES else 0)
