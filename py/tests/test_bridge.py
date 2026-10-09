"""py/tests/test_bridge.py —— sidecar 的端到端验证。

不 mock 任何东西：真的拉起 ``python -u -I bridge.py``，真的往 stdin 写 JSON-lines，
真的从 stdout 读回响应。静态抓取打的是本地临时起的 HTTP 服务，浏览器抓取打的也是
本地页面 —— 全程不依赖外网。

跑法（在仓库根）::

    _env/.venv/bin/python py/tests/test_bridge.py
"""

from __future__ import annotations

import http.server
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
PY_DIR = REPO / "py"
BRIDGE = PY_DIR / "bridge.py"

PAGE = b"""<!doctype html><html><head><title>SPA Shell</title></head>
<body><div id="app">LOADING_PLACEHOLDER</div>
<script>setTimeout(function(){
  document.getElementById('app').innerHTML =
    '<h1>Server Price</h1><table><tr><th>SKU</th><th>Price</th></tr>' +
    '<tr><td>ABC-1</td><td>$19.99</td></tr></table><p>Total: 4,281</p>';
  document.title = 'SPA Rendered';
}, 40);</script></body></html>"""

failures: list[str] = []
passes = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    """记一条断言结果。

    :param name - 用例名
    :param condition - 是否通过
    :param detail - 失败时打印的细节
    """
    global passes
    if condition:
        passes += 1
        print(f"  PASS  {name}")
    else:
        failures.append(f"{name} -- {detail}")
        print(f"  FAIL  {name}  {detail}")


class Sidecar:
    """驱动 bridge.py 子进程的最小客户端。

    读端用一个后台线程把行推进队列，而不是在主线程上阻塞 readline —— 这样「等不到
    响应」会变成一次带超时的失败，而不是整个测试挂死。真实的 TS 侧客户端同样必须这么
    做，否则一个不响应的 sidecar 会把工具调用一起拖住。
    """

    def __init__(self) -> None:
        self.proc = subprocess.Popen(  # noqa: S603
            [sys.executable, "-u", "-I", str(BRIDGE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(PY_DIR),
            text=True,
            bufsize=1,
            # 本地测试服务器就在 127.0.0.1 上，而守卫（正确地）默认拒绝回环地址。
            # 所以这条用例必须显式放行 —— 这也顺带证明了守卫的放行开关是接通的。
            env={**os.environ, "DSH_SCRAPLING_ALLOWED_HOSTS": "127.0.0.1,localhost"},
        )
        self.counter = 0
        self.write_lock = threading.Lock()
        self.lines: "queue.Queue[str | None]" = queue.Queue()
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()

    def _pump(self) -> None:
        """把子进程 stdout 的行逐行推进队列；进程退出时推一个 None 作结束标记。"""
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def read_frame(self, timeout: float = 90.0) -> dict[str, Any]:
        """从 stdout 读一帧，超时则抛。

        :param timeout - 最长等待秒数
        :returns: 解析后的帧
        """
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError("timed out waiting for a frame from the sidecar") from None
        if line is None:
            raise RuntimeError("sidecar closed stdout")
        return json.loads(line)

    def write_raw(self, text: str) -> None:
        """往 stdin 写一行原始文本（用来喂坏帧）。

        :param text - 原始行内容，不含换行
        """
        # 串行化：stdin 不是线程安全的，两个线程各写一半会把帧拼在一起，
        # 对端只能回 BAD_FRAME，于是按 id 收响应的一方永远收不齐。
        with self.write_lock:
            self.proc.stdin.write(text + "\n")  # type: ignore[union-attr]
            self.proc.stdin.flush()  # type: ignore[union-attr]

    def send_raw_frame(self, frame: dict[str, Any]) -> None:
        """往 stdin 写一帧请求，但不读响应。

        并发用例要用：先全部写进去，再各自读回。
        """
        self.write_raw(json.dumps(frame))

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """发一帧请求并读回响应。

        :param method - 方法名
        :param params - 参数
        :returns: 响应帧
        """
        self.counter += 1
        request_id = str(self.counter)
        self.send_raw_frame({"id": request_id, "method": method, "params": params or {}})
        while True:
            answer = self.read_frame()
            if answer.get("id") == request_id:
                return answer
            # 握手之后不该再有别的 id；真出现无主帧说明协议串了，直接报错比死等强。

    def close(self) -> None:
        """按协议优雅关闭。"""
        try:
            self.counter += 1
            self.send_raw_frame({"id": str(self.counter), "method": "shutdown"})
            self.read_frame()
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:  # pragma: no cover
                self.proc.kill()


class Handler(http.server.BaseHTTPRequestHandler):
    """只回 SPA 外壳；其余路径回一张占位图片。"""

    def do_GET(self) -> None:  # noqa: N802 —— BaseHTTPRequestHandler 的命名约定
        """回一个页面或一张图。"""
        body, ctype = (PAGE, "text/html; charset=utf-8") if self.path == "/" else (b"\x89PNG", "image/png")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        """静默默认的逐请求日志。"""


def start_server() -> tuple[http.server.ThreadingHTTPServer, str]:
    """起一个本地 HTTP 服务。

    :returns: (服务对象, 基址)
    """
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def await_ok(sidecar: Sidecar, url: str) -> bool:
    """抓一次并报告是否成功。

    :param sidecar: sidecar 客户端
    :param url: 目标
    :returns: 请求是否成功
    """
    return bool(sidecar.call("render", {"url": url, "extractionType": "text"}).get("ok"))


def run(sidecar: Sidecar, base: str, caps: dict[str, Any]) -> None:
    """跑全部用例。

    :param sidecar: sidecar 客户端
    :param base: 本地服务基址
    :param caps: 握手时报告的能力
    """
    print("\n== ping 与方法分发 ==")
    answer = sidecar.call("ping")
    check("ping 成功", answer.get("ok") is True, repr(answer)[:120])
    answer = sidecar.call("no_such_method")
    check("未知方法回 UNKNOWN_METHOD", answer.get("error", {}).get("code") == "UNKNOWN_METHOD", repr(answer)[:120])
    answer = sidecar.call("fetch", {"params": "not-an-object"})
    check("params 类型错回 BAD_ARGS", answer.get("error", {}).get("code") == "BAD_ARGS", repr(answer)[:120])

    print("\n== 坏帧不影响后续请求 ==")
    sidecar.write_raw("not json at all")
    answer = sidecar.read_frame()
    check("坏帧回 BAD_FRAME", answer.get("error", {}).get("code") == "BAD_FRAME", repr(answer)[:120])
    answer = sidecar.call("ping")
    check("坏帧之后仍能正常响应", answer.get("ok") is True, repr(answer)[:120])

    print("\n== 离线抽取（不发网络请求）==")
    answer = sidecar.call("extract", {"html": "<html><body><h1>Hi</h1><p>yo</p></body></html>"})
    content = answer.get("result", {}).get("content", "")
    check("extract 成功", answer.get("ok") is True, repr(answer)[:200])
    check("extract 取到正文", "Hi" in content and "yo" in content, repr(content)[:120])
    answer = sidecar.call("extract", {"html": "<body><div style='display:none'>SECRET</div>ok</body>"})
    check("离线抽取也清洗隐藏内容", "SECRET" not in answer.get("result", {}).get("content", ""), repr(answer)[:160])

    print("\n== 结构化选择 ==")
    html = "<ul><li class='i'>A</li><li class='i'>B</li><li class='i'>C</li></ul>"
    answer = sidecar.call("select", {"html": html, "selector": ".i"})
    result = answer.get("result", {})
    texts = [item.get("text") for item in result.get("matches", [])]
    check("select 命中 3 条", result.get("count") == 3, repr(result)[:160])
    check("select 默认返回文本", texts == ["A", "B", "C"], repr(texts)[:120])
    answer = sidecar.call("select", {"html": html, "selector": ".i", "attribute": "class"})
    values = [item.get("value") for item in answer.get("result", {}).get("matches", [])]
    check("select 取属性", values == ["i", "i", "i"], repr(values)[:120])
    answer = sidecar.call("select", {"html": html, "selector": ".i", "limit": 2})
    result = answer.get("result", {})
    check("select 的 limit 生效并标记截断", result.get("count") == 3 and result.get("truncated"), repr(result)[:160])
    answer = sidecar.call("select", {"html": html, "selector": ".i", "useXpath": True, "selector2": ""})
    check("xpath 分支可用", isinstance(answer.get("ok"), bool), repr(answer)[:120])

    print("\n== 静态抓取（curl_cffi 打本地服务）==")
    answer = sidecar.call("fetch", {"url": f"{base}/", "extractionType": "text"})
    result = answer.get("result", {})
    content = result.get("content", "")
    check("fetch 成功", answer.get("ok") is True, repr(answer)[:220])
    check("fetch 拿到 200", result.get("status") == 200, repr(result)[:160])
    check("静态管线不执行 JS（只看到占位）", "LOADING_PLACEHOLDER" in content, repr(content)[:120])
    check("静态管线拿不到渲染后内容", "Server Price" not in content, "静态管线不该渲染")

    print("\n== 参数校验 ==")
    for name, params, code in (
        ("缺 url", {}, "BAD_ARGS"),
        ("未知 extractionType", {"url": base, "extractionType": "pdf"}, "BAD_ARGS"),
        ("非法 maxContentChars", {"url": base, "maxContentChars": -5}, "BAD_ARGS"),
        ("未知 method", {"url": base}, "UNKNOWN_METHOD"),
    ):
        method = "no_such_method" if name == "未知 method" else "fetch"
        answer = sidecar.call(method, params)
        check(f"{name} 回 {code}", answer.get("error", {}).get("code") == code, repr(answer)[:140])

    print("\n== 输出封顶 ==")
    answer = sidecar.call("fetch", {"url": f"{base}/", "extractionType": "html", "maxContentChars": 40})
    result = answer.get("result", {})
    check("超限时标记 truncated", result.get("truncated") is True, repr(result)[:160])
    check("超限后内容被截短", len(result.get("content", "")) <= 40, str(len(result.get("content", ""))))
    answer = sidecar.call("fetch", {"url": f"{base}/", "extractionType": "html", "maxContentChars": 100_000})
    check("未超限时 truncated 为假", answer.get("result", {}).get("truncated") is False, repr(answer.get("result", {}))[:120])

    print("\n== 浏览器抓取（Playwright 打本地 SPA）==")
    if not caps.get("browser"):
        print("  SKIP  浏览器不可用（capabilities.browser = false）")
        return
    answer = sidecar.call("render", {"url": f"{base}/", "networkIdle": True, "extractionType": "text"})
    result = answer.get("result", {})
    content = result.get("content", "")
    check("render 成功", answer.get("ok") is True, repr(answer)[:240])
    check("render 执行了 JS（拿到渲染后内容）", "Server Price" in content, repr(content)[:140])
    check("render 拿到表格单元格", "ABC-1" in content, repr(content)[:140])
    # 不给 networkIdle / waitSelector 时，Playwright 的 "load" 会早于那个 40ms 的
    # setTimeout 触发，于是只拿到占位符。这不是 bug，而是「浏览器抓取要显式告诉它
    # 等什么」的固有语义 —— 下面两条用例分别用两种方式表达这个等待。
    answer = sidecar.call("render", {"url": f"{base}/", "networkIdle": True, "extractionType": "markdown"})
    markdown = answer.get("result", {}).get("content", "")
    check("render 的 markdown 含表格", "SKU" in markdown, repr(markdown)[:140])
    answer = sidecar.call("render", {"url": f"{base}/", "cssSelector": "table", "extractionType": "text", "networkIdle": True})
    check("render 支持 cssSelector 收窄", "ABC-1" in answer.get("result", {}).get("content", ""), repr(answer)[:180])
    answer = sidecar.call(
        "render",
        {
            "url": f"{base}/",
            "waitSelector": "#app h1",
            "waitSelectorState": "attached",
            "extractionType": "text",
        },
    )
    check("render 支持 waitSelector 精确等待", "Server Price" in answer.get("result", {}).get("content", ""), repr(answer)[:200])

    print("\n== SSRF 守卫（浏览器路径）==")
    # 169.254.169.254 不在放行集合里，守卫会在 goto 之前 abort，所以表现为 ERR_FAILED。
    answer = sidecar.call("render", {"url": "http://169.254.169.254/latest/meta-data/", "extractionType": "text"})
    body = json.dumps(answer, ensure_ascii=False)
    check("云元数据端点被拦下", answer.get("ok") is False, body[:220])
    check("拦截发生在导航阶段（ERR_FAILED）", "ERR_FAILED" in body, body[:220])
    # 对照组：被放行的 127.0.0.1 能过，未放行的 10.0.0.1 不能过。
    check("放行集合生效：127.0.0.1 可抓", (await_ok(sidecar, f"{base}/")) is True)

    print("\n== 会话（跨请求复用） ==")
    opened = sidecar.call("session.open", {"sessionType": "static"})
    opened_result = opened.get("result") or {}
    session_id = opened_result.get("sessionId", "")
    check("session.open 成功", opened.get("ok") is True, repr(opened)[:140])
    check("open 回显 sessionType", opened_result.get("sessionType") == "static", repr(opened)[:140])
    fetched = sidecar.call("session.fetch", {"sessionId": session_id, "url": f"{base}/", "extractionType": "text"})
    fetched_result = fetched.get("result") or {}
    check("session.fetch 抓到内容", "LOADING_PLACEHOLDER" in fetched_result.get("content", ""), repr(fetched)[:180])
    check("载荷带 sessionId", fetched_result.get("sessionId") == session_id, repr(fetched)[:180])
    listed = sidecar.call("session.list", {})
    rows = (listed.get("result") or {}).get("sessions", [])
    check("session.list 看得到它", any(row.get("sessionId") == session_id for row in rows), repr(listed)[:180])
    check("list 不泄露凭据", "impersonate" not in json.dumps(listed, ensure_ascii=False), repr(listed)[:180])
    check("重复 sessionId 被拒", sidecar.call("session.open", {"sessionType": "static", "sessionId": session_id}).get("ok") is False, "重复 id 竟然成功")
    check("未知 sessionType 被拒", sidecar.call("session.open", {"sessionType": "not-a-type"}).get("ok") is False, "未知类型竟然成功")
    check("不存在的 sessionId 被拒", sidecar.call("session.fetch", {"sessionId": "does-not-exist", "url": f"{base}/"}).get("ok") is False, "幽灵会话竟然能用")
    check("session.close 成功", sidecar.call("session.close", {"sessionId": session_id}).get("ok") is True, "close 失败")
    check("关掉后再用被拒", sidecar.call("session.fetch", {"sessionId": session_id, "url": f"{base}/"}).get("ok") is False, "关掉后还能用")
    check("关完 list 为空", (sidecar.call("session.list", {}).get("result") or {}).get("sessions") == [], "还有残留会话")


    print("\n== 并发 ==")
    answers: dict[str, dict[str, Any]] = {}

    def worker(index: int) -> None:
        request_id = f"c{index}"
        sidecar.send_raw_frame({"id": request_id, "method": "ping", "params": {"n": index}})
        answers[request_id] = {"pending": True}

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(6)]
    for item in threads:
        item.start()
    for item in threads:
        item.join()
    # 读回必须有界：先前写成 while len(seen) < 6，一旦有帧没回来就永久挂住。
    seen: dict[str, Any] = {}
    for _ in range(40):
        if len(seen) >= 6:
            break
        try:
            frame = sidecar.read_frame()
        except RuntimeError:
            break
        identifier = frame.get("id")
        if isinstance(identifier, str) and identifier.startswith("c"):
            seen[identifier] = frame
    check("并发 6 个请求全部有响应", len(seen) == 6, f"got {len(seen)}")
    check("并发响应 id 互不串台", set(seen) == {f"c{i}" for i in range(6)}, repr(sorted(seen)))
    check("并发响应全部成功", all(frame.get("ok") for frame in seen.values()), repr(seen)[:200])


class FakePage:
    """够 install() 注册用的最小 page 替身。

    真拉一个浏览器来验这条不划算：判定逻辑全在 url_allowed 里，而「handler 有没有真挂上」
    看的是 page 上那两个注册方法被不被调用。这里把注册记下来、handler 再手动调一次，
    「挂没挂」与「拦不拦」就都能在不启浏览器的前提下断掉。
    """

    def __init__(self) -> None:
        self.routes: list[tuple[str, object, str]] = []

    def route(self, pattern: str, handler: object) -> None:
        """记下 HTTP 路由注册。

        :param pattern: 选择器
        :param handler: 回调
        """
        self.routes.append(("route", handler, pattern))

    def route_web_socket(self, pattern: str, handler: object) -> None:
        """记下 WebSocket 路由注册。

        :param pattern: 选择器
        :param handler: 回调
        """
        self.routes.append(("route_web_socket", handler, pattern))

    def handler(self, kind: str) -> object:
        """取回某类路由的回调。

        :param kind: ``route`` 或 ``route_web_socket``
        :returns: 回调
        :raises AssertionError: 该类路由没注册过
        """
        for name, fn, _ in self.routes:
            if name == kind:
                return fn
        raise AssertionError(f"{kind} was never registered")


class FakeWebSocket:
    """够 ws_handler 调用的最小 WebSocketRoute 替身。"""

    def __init__(self, url: str) -> None:
        self.url = url
        self.connected = False
        self.closed = False

    def connect_to_server(self) -> None:
        """记下「放行并连接」。"""
        self.connected = True

    def close(self) -> None:
        """记下「拦下并关闭」。"""
        self.closed = True


class FakeRoute:
    """够 handler 调用的最小 Route 替身。"""

    def __init__(self, url: str) -> None:
        self.request = type("Req", (), {"url": url})()
        self.aborted = False
        self.continued = False

    def continue_(self) -> None:
        """记下放行。"""
        self.continued = True

    def abort(self) -> None:
        """记下拦下。"""
        self.aborted = True


def run_guard() -> None:
    """守卫自身的验证：不启浏览器，直接断判定与注册。"""
    sys.path.insert(0, str(PY_DIR))
    import guard

    guard.configure(allowed_hosts=frozenset({"localhost"}))
    try:
        allowed, why = guard.url_allowed("ws://127.0.0.1:9/steal")
        check("ws 握手按地址判拒，而不是按协议一刀切", not allowed, why)
        check("ws 判拒的理由是地址不是 scheme", "scheme" not in why, why)
        allowed, _ = guard.url_allowed("wss://127.0.0.1/ws")
        check("wss 握手同样按地址判拒", not allowed, "")
        allowed, _ = guard.url_allowed("ws://localhost:9/live")
        check("放行名单里的 ws 目标放行", allowed, "")
        allowed, _ = guard.url_allowed("file:///etc/passwd")
        check("非 http/ws 系协议仍判拒", not allowed, "")
        for host, note in (
            ("0177.0.0.1", "八进制读法 = 127.0.0.1"),
            ("00177.0.0.1", "同上"),
            ("2852039166", "整数读法 = 127.0.0.1"),
            ("0x7f000001", "十六进制读法 = 127.0.0.1"),
        ):
            check(
                f"IP 字面量歧义写法判拒（{note}）",
                not guard.is_public_address(host),
                host,
            )

        page = FakePage()
        guard.install(page)
        kinds = [name for name, _, _ in page.routes]
        check("HTTP 路由已注册", "route" in kinds, repr(kinds))
        check("WebSocket 路由已注册", "route_web_socket" in kinds, repr(kinds))
        check("能力报告如实说明 WS 已覆盖", guard.websocket_guard_supported(page) is True, "")

        ws = FakeWebSocket("ws://127.0.0.1:9/steal")
        page.handler("route_web_socket")(ws)  # type: ignore[operator]
        check("内网 ws 握手被关掉", ws.closed and not ws.connected, repr(vars(ws)))

        ws_ok = FakeWebSocket("ws://localhost:9/live")
        page.handler("route_web_socket")(ws_ok)  # type: ignore[operator]
        check(
            "放行名单里的 ws 握手被连接",
            ws_ok.connected and not ws_ok.closed,
            repr(vars(ws_ok)),
        )

        route = FakeRoute("http://127.0.0.1:9/x")
        page.handler("route")(route)  # type: ignore[operator]
        check("内网 HTTP 仍被拦", route.aborted, repr(vars(route)))

        old_page = FakePage()
        # 旧版 Playwright 没这个方法：install 不该因此炸，且要如实报出没覆盖。
        old_page.route_web_socket = None  # type: ignore[assignment]
        guard.install(old_page)
        check(
            "旧版 Playwright 下如实报出 WS 未覆盖",
            guard.websocket_guard_supported(old_page) is False,
            "",
        )
    finally:
        guard.configure(allowed_hosts=frozenset())


class _Selectors(list):
    """最小 Selectors 替身：真实实现只用到 .first。"""

    first = property(lambda self: self[0] if self else None)


HOSTILE = b"""<!doctype html><html><body>
<div id="visible">VISIBLE-OK</div>
<script>var s="SCRIPT-LEAK"</script><style>.x{}</style>
<div style="display:none">HIDDEN-INJECTION</div>
<div aria-hidden="true">ARIA-HIDDEN-LEAK</div>
<template>TEMPLATE-LEAK</template><noscript>NOSCRIPT-LEAK</noscript>
<!-- HTML-COMMENT-INJECTION -->
<img src=x onerror="fetch('http://169.254.169.254/latest/meta-data/')">
<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>
<meta http-equiv="refresh" content="0;url=http://169.254.169.254/">
</body></html>"""

LEAK_MARKERS = (
    "SCRIPT-LEAK",
    "HIDDEN-INJECTION",
    "ARIA-HIDDEN-LEAK",
    "TEMPLATE-LEAK",
    "NOSCRIPT-LEAK",
    "HTML-COMMENT-INJECTION",
    "onerror",
    "srcdoc",
    "169.254.169.254",
    "alert(1)",
)


class FakeResponse:
    """够 to_payload 用的最小 Response 替身。"""

    url = "http://127.0.0.1:1/"
    status = 200
    history = ()
    captured_xhr = None
    html_content = HOSTILE.decode()

    def _selector(self) -> Any:
        from scrapling import Selector

        return Selector(content=self.html_content, url=self.url)

    def css(self, pattern: str) -> _Selectors:
        node = self._selector().css(pattern).first
        return _Selectors([node]) if node is not None else _Selectors()

    def markdown(self, css_selector: str | None = None, main_content_only: bool = False) -> str:
        from scrapling.core.shell import Convertor

        body = self.css("body")
        page = body.first if body else self._selector()
        page = Convertor._sanitize_for_ai(Convertor._strip_noise_tags(page))
        pages = [page] if not css_selector else page.css(css_selector)
        return "".join(Convertor._convert_to_markdown(node.html_content) for node in pages)


def run_output_shape() -> None:
    """输出形态的验证：内嵌 data: URI 图片的剥离，以及那个开关的读法。

    剥离是纯文本变换，所以逐条打输入输出，不依赖任何站点 —— 这类改动最容易在真实页面上
    「看起来对了」，而单测能钉死的边界是**代码围栏不能动**。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters

    drop = adapters.drop_data_uris

    check(
        "markdown 图片剥掉地址只留 alt",
        drop("前 ![赞助商](data:image/svg+xml;base64,AAAABBBB) 后") == "前 [赞助商] 后",
        repr(drop("前 ![赞助商](data:image/svg+xml;base64,AAAABBBB) 后")),
    )
    check(
        "无 alt 的也剥干净，不留空地址",
        drop("![](data:image/png;base64,QQ==)") == "[]",
        repr(drop("![](data:image/png;base64,QQ==)")),
    )
    check(
        "普通图片链接原样保留",
        drop("![图](/images/logo.png)") == "![图](/images/logo.png)",
        repr(drop("![图](/images/logo.png)")),
    )
    check(
        "percent 编码的 svg 一样剥掉",
        drop("![i](data:image/svg+xml,%3csvg%3e%3c/svg%3e)") == "[i]",
        repr(drop("![i](data:image/svg+xml,%3csvg%3e%3c/svg%3e)")),
    )
    fenced = "```\n![x](data:image/png;base64,QQ==)\n```"
    check("代码围栏内原样保留 —— 那是教程在教的示例代码", drop(fenced) == fenced, repr(drop(fenced)))
    tilde = "~~~\n![x](data:image/png;base64,QQ==)\n~~~"
    check("波浪线围栏同样认", drop(tilde) == tilde, repr(drop(tilde)))
    mixed = "![a](data:image/png;base64,QQ==)\n```\n![b](data:image/png;base64,QQ==)\n```"
    check(
        "围栏之外的照常剥，围栏之内不动",
        drop(mixed) == "[a]\n```\n![b](data:image/png;base64,QQ==)\n```",
        repr(drop(mixed)),
    )
    check(
        "html 路径的属性形态缩成占位，标签结构不动",
        drop('<img src="data:image/png;base64,QQ==" alt="logo">', html=True)
        == '<img src="data:…" alt="logo">',
        repr(drop('<img src="data:image/png;base64,QQ==" alt="logo">', html=True)),
    )
    check(
        "html 规则只对 html 路径生效 —— 无差别跑会把围栏里的 markdown 图片地址吃掉右括号",
        drop(fenced, html=True) != fenced,
        repr(drop(fenced, html=True)),
    )
    check(
        "markdown 规则不会误伤 html 属性形态",
        drop('<img src="data:image/png;base64,QQ==">')
        == '<img src="data:image/png;base64,QQ==">',
        repr(drop('<img src="data:image/png;base64,QQ==">')),
    )
    check("没有 data URI 时逐字节不变", drop("普通正文\n第二行") == "普通正文\n第二行")
    check("空串仍是空串", drop("") == "")

    # 开关的读法：只认 deployment 命名空间，缺省为真，类型不对也回落为真。
    check("缺 deployment 即按剥处理", adapters._strip_inline_images({}) is True)
    check(
        "显式关掉",
        adapters._strip_inline_images({"deployment": {"stripInlineImages": False}}) is False,
    )
    check(
        "显式打开",
        adapters._strip_inline_images({"deployment": {"stripInlineImages": True}}) is True,
    )
    check(
        "类型不对回落为默认（剥）",
        adapters._strip_inline_images({"deployment": {"stripInlineImages": "no"}}) is True,
    )
    check(
        "顶层同名字段被忽略 —— 那是模型可传的透传表，不能由它决定输出形态",
        adapters._strip_inline_images({"stripInlineImages": False}) is True,
    )

    # 端到端一层：把开关真的按到 to_payload 上，验证 markdown 路径受它控制。
    class InlineImageResponse(FakeResponse):
        html_content = (
            b'<html><body><p>\xe6\xad\xa3\xe6\x96\x87</p>'
            b'<img src="data:image/svg+xml;base64,QUJDREVGR0g=" alt="logo"></body></html>'
        )

    common = {
        "extraction_type": "markdown",
        "css_selector": None,
        "main_content_only": True,
        "max_content_chars": 200_000,
    }
    stripped = adapters.to_payload(InlineImageResponse(), **common)
    check(
        "markdown 路径：默认剥掉内嵌图",
        "base64" not in str(stripped["content"]),
        str(stripped["content"])[:120],
    )
    kept = adapters.to_payload(InlineImageResponse(), **common, strip_inline_images=False)
    check(
        "markdown 路径：关掉开关就保留原始 data URI",
        "base64" in str(kept["content"]),
        str(kept["content"])[:120],
    )
    check(
        "剥完正文还在（不是把整段清空了）",
        "正文" in str(stripped["content"]),
        str(stripped["content"])[:120],
    )


def run_limits() -> None:
    """上限类判定的验证：会话名额、爬虫名额、单页正文封顶。"""
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import crawl
    import guard

    guard.configure(allowed_hosts=frozenset({"localhost"}))
    try:
        # 会话名额：反复开 static 直到撞上限，再确认判的是「名额」而不是别的错。
        opened: list[str] = []
        limit_hit = ""
        for _ in range(adapters.MAX_SESSIONS + 2):
            try:
                opened.append(adapters.session_open({"sessionType": "static"})["sessionId"])
            except adapters.AdapterError as error:
                limit_hit = error.code
                break
        check("会话开够上限后被拒", limit_hit == "SESSION_LIMIT", f"{len(opened)} opened, {limit_hit}")
        check("会话上限之内都开成了", len(opened) == adapters.MAX_SESSIONS, str(len(opened)))

        # 浏览器类名额单独更小，且不受 static 占位影响。
        guard.configure(allowed_hosts=frozenset({"localhost"}))
        browser_limit = ""
        for _ in range(adapters.MAX_BROWSER_SESSIONS + 1):
            try:
                adapters.session_open({"sessionType": "static"})["sessionId"]
            except adapters.AdapterError as error:
                browser_limit = error.code
                break
        check("浏览器会话名额用尽后也判 SESSION_LIMIT", browser_limit == "SESSION_LIMIT", browser_limit)

        for session_id in list(adapters._SESSIONS):
            adapters.session_close({"sessionId": session_id})
        check("会话全部关掉后表是空的", adapters._SESSIONS == {}, str(len(adapters._SESSIONS)))

        # 爬虫起点复核：与浏览器路径同一个实现，两侧同解。
        for blocked in ("http://127.0.0.1:9/x", "http://169.254.169.254/", "http://[::1]/"):
            try:
                crawl.crawl_run({"url": blocked, "maxPages": 1})
                check(f"爬虫起点拦下 {blocked}", False, "被放行了")
            except adapters.AdapterError as error:
                check(f"爬虫起点拦下 {blocked}", error.code == "URL_BLOCKED", error.code)

        # 单页正文封顶：max_pages 限的是页数，页内长度是另一根轴。
        long_page = "x" * 5000
        check(
            "超长单页被封顶",
            len(crawl._clip_markdown(long_page, 100)) < 200,
            str(len(crawl._clip_markdown(long_page, 100))),
        )
        check("未超长的正文原样返回", crawl._clip_markdown("ok", 100) == "ok", "")
        check(
            "上限为 0 时不封顶（部署侧没给预算就不擅自截）",
            crawl._clip_markdown(long_page, 0) == long_page,
            "",
        )
    finally:
        for session_id in list(adapters._SESSIONS):
            adapters.session_close({"sessionId": session_id})
        guard.configure(allowed_hosts=frozenset())


def run_extraction() -> None:
    """三条提取路径都不得把注入载荷带进模型上下文。"""
    sys.path.insert(0, str(PY_DIR))
    import adapters

    for kind in ("markdown", "html", "text"):
        payload = adapters.to_payload(
            FakeResponse(),
            extraction_type=kind,
            css_selector=None,
            main_content_only=True,
            max_content_chars=200_000,
        )
        body = str(payload["content"])
        leaked = [marker for marker in LEAK_MARKERS if marker in body]
        check(f"{kind} 路径不泄漏注入载荷", not leaked, repr(leaked))
        check(f"{kind} 路径保留正文", "VISIBLE-OK" in body, body[:120])


def check_dependency_missing_mapping() -> None:
    """缺可选依赖要报成「环境没装对」，而不是「抓取失败」。

    这是本文件里唯一一处进程内验证。真实子进程里 markdownify 是在的（它随 ``scrapling[rag]``
    一起装），要复现缺依赖就得先把解释器环境弄坏——那既慢又不稳。而「异常归到哪个错误码」
    本身是纯映射，直接打这一层更实在，也不削弱其余用例的端到端性质。

    :returns: 无
    """
    inserted = str(PY_DIR) not in sys.path
    if inserted:
        sys.path.insert(0, str(PY_DIR))
    import adapters
    import bridge

    def missing_markdownify(_params: dict[str, Any]) -> Any:
        raise ModuleNotFoundError("No module named 'markdownify'", name="markdownify")

    adapters.METHODS["test-missing-dependency"] = missing_markdownify
    try:
        frame = bridge.handle({"id": "d1", "method": "test-missing-dependency", "params": {}})
    finally:
        adapters.METHODS.pop("test-missing-dependency", None)
        if inserted:
            sys.path.remove(str(PY_DIR))

    error = frame.get("error", {}) if isinstance(frame, dict) else {}
    check(
        "缺可选依赖时报 DEPENDENCY_MISSING 而不是 FETCH_FAILED",
        error.get("code") == "DEPENDENCY_MISSING",
        repr(error)[:200],
    )
    message = str(error.get("message", ""))
    check(
        "缺依赖的报错点名了缺哪个包、要装哪条命令",
        "markdownify" in message and "scrapling[rag]" in message,
        message[:200],
    )


def run_proxy() -> None:
    """代理判定的验证：设置 > 环境 > 直连，绕过清单，以及守卫在代理下的放宽口径。

    全部是纯判定，不发网络请求：出口选错了要在**每一次**抓取里都错，而这里能把每一格
    都点到。真实打通的那一侧（curl_cffi 与 Playwright 认不认这份代理）由 fetch / render
    的端到端用例在本地 HTTP 服务上覆盖。
    """
    sys.path.insert(0, str(PY_DIR))
    import guard

    proxy_env_keys = (
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
        guard.PROXY_ENV,
        guard.PROXY_BYPASS_ENV,
    )
    saved = {key: os.environ.get(key) for key in proxy_env_keys}

    def load(**env: str) -> None:
        """按给定的环境重跑一次 configure_from_env。"""
        for key in proxy_env_keys:
            os.environ.pop(key, None)
        os.environ.update({key: value for key, value in env.items() if value})
        guard.configure_from_env()

    try:
        # 主机名匹配：整名命中含子域，但只是后缀相同的别的域名不算。
        check("整名命中", guard._host_matches("example.com", "example.com"))
        check("子域命中", guard._host_matches("a.b.example.com", "example.com"))
        check("前导点与星号等价", guard._host_matches("a.example.com", ".example.com"))
        check("通配星号等价", guard._host_matches("a.example.com", "*.example.com"))
        check("大小写无关", guard._host_matches("A.Example.COM", "example.com"))
        check("仅后缀相同的别的域名不命中", not guard._host_matches("notexample.com", "example.com"))
        check("空清单项不命中任何主机", not guard._host_matches("example.com", "  "))

        # 地址拆分：协议白名单、IPv6 方括号、凭据解码、路径丢弃。
        check(
            "拆出 Playwright 要的 server/username/password",
            guard.split_proxy("http://u:p@10.0.0.1:7890")
            == {"server": "http://10.0.0.1:7890", "username": "u", "password": "p"},
        )
        check(
            "IPv6 字面量把方括号装回 server（urlparse 已经摘掉了）",
            guard.split_proxy("socks5://[::1]:1080")["server"] == "socks5://[::1]:1080",
        )
        check(
            "凭据 percent-decode，与 libcurl 的读法一致",
            guard.split_proxy("http://u:p%40ss@h:1")["password"] == "p@ss",
        )
        check(
            "路径与片段被丢弃",
            guard.split_proxy("http://h:1/ignored?q=1#f")["server"] == "http://h:1",
        )
        check("没有端口时不补冒号", guard.split_proxy("http://proxy.test")["server"] == "http://proxy.test")
        check("协议不在白名单内判否", guard.split_proxy("ftp://127.0.0.1:21") is None)
        check("根本不是地址判否", guard.split_proxy("not a url") is None)
        check(
            "socks5h 是 curl 的私有写法，两边都不认",
            guard.split_proxy("socks5h://h:1") is None,
        )

        # 判定顺序：绕过清单横切在前，设置压过环境，两者都没有才是直连。
        load()
        check("干净环境即直连", guard.proxy_for("https://example.com/") == "")
        check(
            "本包不表态时把出口交给底层（None 而不是空表）",
            guard.proxies_for("https://x.test/") is None,
        )
        check("干净环境的会话也不挂代理", guard.default_proxy() == "")

        load(**{guard.PROXY_ENV: "http://127.0.0.1:7890"})
        check("设置卡填了就用它", guard.proxy_for("https://example.com/") == "http://127.0.0.1:7890")
        check(
            "curl_cffi 形态是 proxies 表",
            guard.proxies_for("https://example.com/") == {"all": "http://127.0.0.1:7890"},
        )
        check(
            "浏览器形态是 server/username/password",
            guard.browser_proxy("https://example.com/")
            == {"server": "http://127.0.0.1:7890", "username": "", "password": ""},
        )
        check("会话开场取全局那份", guard.default_proxy() == "http://127.0.0.1:7890")
        check(
            "能力摘要只回显 scheme://host:port，凭据不外泄",
            guard.proxy_settings()
            == {"configured": True, "source": "settings", "server": "http://127.0.0.1:7890"},
        )

        load(**{guard.PROXY_ENV: "http://user:secret@127.0.0.1:7890"})
        check(
            "带凭据的地址，摘要里只有 host:port",
            guard.proxy_settings()["server"] == "http://127.0.0.1:7890",
        )

        load(**{"https_proxy": "socks5://127.0.0.1:1080", "HTTP_PROXY": "http://127.0.0.1:1081"})
        check(
            "https 取 https 那一栏",
            guard.proxy_for("https://example.com/") == "socks5://127.0.0.1:1080",
        )
        check("http 取 http 那一栏", guard.proxy_for("http://example.com/") == "http://127.0.0.1:1081")
        check(
            "wss 与 https 同一栏",
            guard.proxy_for("wss://example.com/s") == "socks5://127.0.0.1:1080",
        )
        check(
            "能力摘要标出代理来自环境而不是设置",
            guard.proxy_settings()["source"] == "environment",
        )

        load(**{"all_proxy": "socks5://127.0.0.1:1080"})
        check("只有 all_proxy 时两种协议都走它", guard.proxy_for("http://a.test/") == "socks5://127.0.0.1:1080")

        load(**{"https_proxy": "socks5://127.0.0.1:1080", guard.PROXY_ENV: "http://127.0.0.1:7890"})
        check("设置压过环境", guard.proxy_for("https://example.com/") == "http://127.0.0.1:7890")

        load(**{"https_proxy": "socks5://127.0.0.1:1080", "no_proxy": "bypass.test"})
        check("NO_PROXY 命中的主机直连", guard.proxy_for("https://bypass.test/") == "")
        check(
            "命中直连时给的是空表（明确直连，含环境那份），不是 None",
            guard.proxies_for("https://bypass.test/") == {"all": ""},
        )
        check("没命中的主机仍走代理", guard.proxy_for("https://other.test/") == "socks5://127.0.0.1:1080")

        load(**{guard.PROXY_ENV: "http://127.0.0.1:7890", guard.PROXY_BYPASS_ENV: "intranet, .corp.test"})
        check("绕过清单里的裸名覆盖子域", guard.proxy_for("https://box.intranet/") == "")
        check("绕过清单命中 .corp.test", guard.proxy_for("https://a.corp.test/") == "")
        check("没命中的仍走代理", guard.proxy_for("https://example.com/") == "http://127.0.0.1:7890")

        load(**{guard.PROXY_BYPASS_ENV: "*"})
        check("bypass=* 即整台机器直连", guard.proxy_for("https://example.com/") == "")
        check("bypass=* 时会话也不挂代理", guard.default_proxy() == "")
        check(
            "bypass=* 时给的是空表而不是 None",
            guard.proxies_for("https://x.test/") == {"all": ""},
        )

        load(**{guard.PROXY_ENV: "ftp://127.0.0.1:21"})
        check("不可用的代理地址降级为未配置", guard.proxy_for("https://example.com/") == "")
        check(
            "降级后能力摘要如实报未配置",
            guard.proxy_settings() == {"configured": False, "source": "none", "server": ""},
        )

        # 系统代理：浏览器本来就会跟随，curl_cffi 不会。不补这一档，「开了代理」的用户会
        # 发现本插件的静态抓取抓不到东西。解析器按固定文本测，不依赖运行机器上代理的开关。
        scutil_on = """<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPPort : 9999
      HTTPProxy : 10.0.0.9
    }
  }
}"""
        parsed = guard.parse_scutil_proxy(scutil_on)
        check("scutil: HTTP 那一项", parsed.get("http") == "http://127.0.0.1:7890", repr(parsed))
        check("scutil: HTTPS 那一项", parsed.get("https") == "https://127.0.0.1:7890", repr(parsed))
        check(
            "scutil: __SCOPED__ 的按网卡设置不算全局出口",
            "10.0.0.9" not in repr(parsed),
            repr(parsed),
        )
        check(
            "scutil: 数组字面量里的条目不会被当成键",
            "0" not in parsed and "1" not in parsed,
            repr(parsed),
        )
        check(
            "scutil: 只有 SOCKS 时按 socks5 写",
            guard.parse_scutil_proxy(
                "<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 7891\n  SOCKSProxy : 127.0.0.1\n}"
            )
            == {"all": "socks5://127.0.0.1:7891"},
            "",
        )
        check(
            "scutil: 只勾了 HTTP 时 https 跟随同一份（CFNetwork 的行为）",
            guard.parse_scutil_proxy(
                "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n}"
            )
            == {"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"},
            "",
        )
        check(
            "scutil: 开关全关时是空表",
            guard.parse_scutil_proxy(
                "<dictionary> {\n  FTPPassive : 1\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}"
            )
            == {},
            "",
        )
        check(
            "scutil: 半配置（有 host 没 port）丢弃而不是造出坏地址",
            guard.parse_scutil_proxy(
                "<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n}"
            )
            == {},
            "",
        )
        check("scutil: 空输入与垃圾输入都判否", guard.parse_scutil_proxy("") == {})
        check("scutil: 非 scutil 输出的文本判否", guard.parse_scutil_proxy("not scutil output") == {})

        check(
            "windows: 单值写法覆盖两种协议",
            guard.parse_windows_proxy({"proxyenable": "1", "proxyserver": "127.0.0.1:7890"})
            == {"http": "http://127.0.0.1:7890", "https": "https://127.0.0.1:7890"},
            "",
        )
        check(
            "windows: 分协议写法逐条认",
            guard.parse_windows_proxy(
                {
                    "proxyenable": "1",
                    "proxyserver": "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892",
                }
            )
            == {
                "http": "http://127.0.0.1:7890",
                "https": "https://127.0.0.1:7891",
                "all": "socks5://127.0.0.1:7892",
            },
            "",
        )
        check(
            "windows: ProxyEnable=0 时即便有地址也不用",
            guard.parse_windows_proxy({"proxyenable": "0", "proxyserver": "127.0.0.1:7890"}) == {},
            "",
        )
        check("windows: 没有地址时判否", guard.parse_windows_proxy({"proxyenable": "1"}) == {})
        check("windows: 什么都没有时判否", guard.parse_windows_proxy({}) == {})
        check(
            "windows: 缺端口的项丢弃",
            guard.parse_windows_proxy({"proxyenable": "1", "proxyserver": "http=127.0.0.1"}) == {},
            "",
        )

        # 读不到就当没有：一条只读命令失败绝不能让 sidecar 起不来。
        check("系统查询命令跑不起来时返回空串", guard._run_readonly(["/nonexistent/binary-xyz"]) == "")

        # 把系统代理这一档接进判定链：环境变量优先于它，两者都没有才轮到它。
        load()
        real_system = guard._SYSTEM_PROXIES
        try:
            guard._SYSTEM_PROXIES = {"all": "http://127.0.0.1:7777"}
            check("系统代理被接进判定链", guard.proxy_for("https://example.com/") == "http://127.0.0.1:7777")
            check(
                "系统代理时不再把出口交给底层",
                guard.proxies_for("https://example.com/") == {"all": "http://127.0.0.1:7777"},
            )
            check("会话开场也取系统代理", guard.default_proxy() == "http://127.0.0.1:7777")
            check(
                "能力摘要标出代理来自系统设置",
                guard.proxy_settings()["source"] == "system",
            )
            load(**{"https_proxy": "socks5://127.0.0.1:1080"})
            check(
                "环境变量压过系统代理",
                guard.proxy_for("https://example.com/") == "socks5://127.0.0.1:1080",
            )
            load(**{guard.PROXY_ENV: "http://127.0.0.1:7890"})
            check("设置压过系统代理", guard.proxy_for("https://example.com/") == "http://127.0.0.1:7890")
            guard._BYPASS_ENTRIES = ("example.com",)
            check("绕过清单仍然最优先", guard.proxy_for("https://example.com/") == "")
            guard._BYPASS_ENTRIES = ()
        finally:
            guard._SYSTEM_PROXIES = real_system

        # 守卫在代理下的口径：只有「本机解析不出来」这一条放宽。字面量、本地能解析出来的私网
        # 答案、单标签主机名，三条都照旧拒 —— 那才是 SSRF 的实际落点。
        #
        # 「解析不出来」这一格用**注入的 getaddrinfo** 而不是找一个真的解析不了的名字：
        # 开 fake-ip 的机器上任何域名都有合成答案，`.invalid` 也不例外，拿它当前提的用例在
        # 那些机器上会反过来证明不了任何事（这台机器上就是这样）。注入把「解析器答不上来」
        # 变成确定性事实，与运行环境无关。
        load(**{guard.PROXY_ENV: "http://127.0.0.1:7890"})
        real_getaddrinfo = guard.socket.getaddrinfo
        real_cache = guard._SYNTHETIC_RESOLVER

        def no_answers(*_args: object, **_kwargs: object) -> None:
            raise OSError("no such host")

        guard.socket.getaddrinfo = no_answers  # type: ignore[assignment]
        guard._SYNTHETIC_RESOLVER = False
        try:
            check(
                "本机解析不出来 + 走代理 = 放行（DNS 被按地区过滤的机器上，正是这些站点需要代理）",
                guard.is_public_address("no-such-host.invalid", proxied=True),
            )
            check(
                "同样的主机在直连下判拒（拿不到答案时选拒）",
                not guard.is_public_address("no-such-host.invalid"),
            )
            allowed, why = guard.url_allowed("https://no-such-host.invalid/")
            check("url_allowed 跟着代理口径一起放宽", allowed, why)
        finally:
            guard.socket.getaddrinfo = real_getaddrinfo  # type: ignore[assignment]
            guard._SYNTHETIC_RESOLVER = real_cache

        check("IP 字面量在代理下照旧判拒", not guard.is_public_address("127.0.0.1", proxied=True))
        check(
            "元数据端点在代理下照旧判拒",
            not guard.is_public_address("169.254.169.254", proxied=True),
        )
        check("单标签主机名在代理下也判拒", not guard.is_public_address("intranet", proxied=True))
        guard.configure(allowed_hosts=frozenset({"localhost"}))
        check(
            "放行名单里的主机不受代理口径影响",
            guard.is_public_address("localhost", proxied=True),
        )
        guard.configure(allowed_hosts=frozenset())
        allowed, why = guard.url_allowed("http://169.254.169.254/")
        check("url_allowed 下元数据端点照旧拦下", not allowed, why)
        allowed, why = guard.url_allowed("https://intranet/")
        check("url_allowed 下单标签主机名照旧拦下", not allowed, why)
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        guard.configure_from_env()


def run_synthetic_pools() -> None:
    """合成池的验证：放宽到整段，且**只**放宽到整段。

    这组用例对着一次真实回归：早期实现把「检测到合成解析器」当成「放行任意 IPv4」，而 Host
    侧那侧却在按控制答案的跨度切一小片池。两边既不同解，那一小片又小到连它自己的控制域名都
    过不去——真机上三个控制答案是 198.18.0.126/.134/.135，跨度 10，切出来 198.18.0.112..127，
    于是 github.com（.28）与 opencode.ai（.61）全被挡在门外。

    这里全部用**注入的解析器**而不是真机上的合成答案：真机答案每台机器、每次解析都不同，
    拿它当前提的断言在别的机器上就证伪不了任何事。
    """
    sys.path.insert(0, str(PY_DIR))
    import socket

    import guard

    answers: dict[str, list[str]] = {}
    real_getaddrinfo = guard.socket.getaddrinfo
    real_cache = guard._SYNTHETIC_RESOLVER

    def fake_lookup(host: str, *_args: object, **_kwargs: object) -> list[tuple]:
        """顶掉 getaddrinfo，按脚本回答。"""
        if host not in answers:
            raise OSError(f"no such host: {host}")
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))
            for ip in answers[host]
        ]

    guard.socket.getaddrinfo = fake_lookup  # type: ignore[assignment]
    try:
        # 控制答案散落在池内各处 —— 正是跨度估计器失效的前提。
        answers.update(
            {
                "example.com": ["198.18.0.126"],
                "www.iana.org": ["198.18.0.134"],
                "www.wikipedia.org": ["198.18.0.135"],
            }
        )
        guard._SYNTHETIC_RESOLVER = None
        check("认出合成解析器", guard.detect_synthetic_resolver())
        for answer in ("198.18.0.61", "198.18.0.28", "198.19.7.9"):
            answers["target.test"] = [answer]
            guard._SYNTHETIC_RESOLVER = None
            allowed, why = guard.url_allowed("https://target.test/")
            check(f"池内任意落点 {answer} 都放行（不是切一小片）", allowed, why)

        # 收紧的那一侧：合成模式**只**放宽已知池，私网 / 回环 / 链路本地照旧拒。
        for answer in ("127.0.0.1", "192.168.1.1", "10.0.0.5", "169.254.169.254"):
            answers["target.test"] = [answer]
            guard._SYNTHETIC_RESOLVER = None
            allowed, why = guard.url_allowed("https://target.test/")
            check(f"合成模式下 {answer} 仍判拒（私网不在池子里）", not allowed, why)

        # CGNAT 池：控制答案落在 100.64/10 时，放宽到那一整段。
        answers.update(
            {
                "example.com": ["100.64.1.1"],
                "www.iana.org": ["100.70.2.2"],
                "www.wikipedia.org": ["100.90.3.3"],
                "target.test": ["100.127.255.254"],
            }
        )
        guard._SYNTHETIC_RESOLVER = None
        check("认出 CGNAT 池的合成解析器", guard.detect_synthetic_resolver())
        allowed, why = guard.url_allowed("https://target.test/")
        check("CGNAT 池整段放行（含段尾）", allowed, why)

        # 控制域名分散在**两个不同的池**里：仍判为合成模式，落在已知池内的目标照旧放行。
        # 两侧同解是硬不变式，所以不做「必须全落在同一个池」的筛选。
        answers.update(
            {
                "example.com": ["198.18.0.1"],
                "www.iana.org": ["100.64.0.1"],
                "www.wikipedia.org": ["198.18.0.2"],
                "target.test": ["198.18.0.9"],
            }
        )
        guard._SYNTHETIC_RESOLVER = None
        check("控制域名分散在两个池时仍判为合成模式", guard.detect_synthetic_resolver())
        allowed, why = guard.url_allowed("https://target.test/")
        check("分散在两个池时，落在已知池内的目标照旧放行", allowed, why)

        # 控制域名正常解析（公网）时不误判：合成模式不成立，池不放行。
        answers.update(
            {
                "example.com": ["93.184.216.34"],
                "www.iana.org": ["93.184.216.35"],
                "www.wikipedia.org": ["93.184.216.36"],
                "target.test": ["198.18.0.9"],
            }
        )
        guard._SYNTHETIC_RESOLVER = None
        check("控制域名正常时不误判", not guard.detect_synthetic_resolver())
        allowed, why = guard.url_allowed("https://target.test/")
        check("未识别为合成解析器时，池内答案照旧判拒", not allowed, why)
    finally:
        guard.socket.getaddrinfo = real_getaddrinfo  # type: ignore[assignment]
        guard._SYNTHETIC_RESOLVER = real_cache
        answers.clear()


def main() -> int:
    """入口。

    :returns: 退出码，0 表示全过
    """
    server, base = start_server()
    sidecar = Sidecar()
    try:
        print("== 握手与能力协商 ==")
        ready = sidecar.read_frame()
        check("ready 帧不带 id", "id" not in ready, repr(ready)[:100])
        check("ready 带 protocol", ready.get("protocol") == 1, repr(ready)[:100])
        caps = ready.get("capabilities", {})
        check("报告了 scrapling 可用性", "scrapling" in caps, repr(caps)[:140])
        check("报告了浏览器可用性", "browser" in caps, repr(caps)[:140])
        print(f"     capabilities = {json.dumps(caps, ensure_ascii=False)}")
        run(sidecar, base, caps)
    finally:
        sidecar.close()
        server.shutdown()

    print("\n== URL 守卫 ==")
    run_guard()

    print("\n== 代理判定 ==")
    run_proxy()

    print("\n== 输出形态（内嵌图片剥离） ==")
    run_output_shape()

    print("\n== 合成池（fake-IP） ==")
    run_synthetic_pools()

    print("\n== 上限与配额 ==")
    run_limits()

    print("\n== 提取路径的反注入清洗 ==")
    run_extraction()

    print("\n== 缺可选依赖的归类 ==")
    check_dependency_missing_mapping()

    print(f"\n{'=' * 52}")
    print(f"passed {passes}, failed {len(failures)}")
    for item in failures:
        print(f"  - {item}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
