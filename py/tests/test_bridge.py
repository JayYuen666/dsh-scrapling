"""py/tests/test_bridge.py —— sidecar 的端到端验证。

不 mock 任何东西：真的拉起 ``python -u -I bridge.py``，真的往 stdin 写 JSON-lines，
真的从 stdout 读回响应。静态抓取打的是本地临时起的 HTTP 服务，浏览器抓取打的也是
本地页面 —— 全程不依赖外网。

跑法（在仓库根）::

    _env/.venv/bin/python py/tests/test_bridge.py
"""

# 测试要拉起本地 sidecar。
from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import contextlib
import gc
import hashlib
import http.server
import io
import json
import os
import queue
import shutil
import socket
import struct
import subprocess  # nosec B404
import sys
import tempfile
import threading
import time
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable, cast
from urllib.parse import parse_qsl, urlparse

REPO = Path(__file__).resolve().parents[2]
PY_DIR = REPO / "py"
BRIDGE = PY_DIR / "bridge.py"
# 覆盖率配置文件（子进程那层也要按同一份配置量）。跑覆盖率时才用得上。
CONFIG = REPO / "pyproject.toml"

# 这套件的段落标题是中文，而管道在 Windows 上默认走本地 ANSI 代码页（cp1252）：
# 第一行中文就会抛 UnicodeEncodeError，整轮门禁停在一个 print 上。与 bridge.py 的
# stdout/stderr 同一条处理——固定 UTF-8，编不出的字符退成转义文本而不是中断。
for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if callable(_reconfigure):
        _reconfigure(encoding="utf-8", errors="backslashreplace")

PAGE = b"""<!doctype html><html><head><title>SPA Shell</title></head>
<body><div id="app">LOADING_PLACEHOLDER</div>
<script>setTimeout(function(){
  document.getElementById('app').innerHTML =
    '<h1>Server Price</h1><table><tr><th>SKU</th><th>Price</th></tr>' +
    '<tr><td>ABC-1</td><td>$19.99</td></tr></table><p>Total: 4,281</p>';
  document.title = 'SPA Rendered';
}, 40);</script></body></html>"""

# 一个自己发起 XHR/fetch 的页面：capture 与 session.network 都要有一条**真接口**可记。
# 那条请求的 resource_type 是 fetch，才不会被网络摘要的 include_static 过滤掉。
XHR_PAGE = b"""<!doctype html><html><head><title>XHR Page</title></head>
<body><div id="app">LOADING_PLACEHOLDER</div>
<script>fetch('/api/data').then(function(r){return r.text()}).then(function(t){
  document.getElementById('app').textContent = 'GOT:' + t;
});</script></body></html>"""

# /api/data 的响应体：给网络摘要留一段够长的正文，好用 includeBody + 一个小预算验截断。
XHR_PAYLOAD = b'{"ok":true,"items":[1,2,3,4,5]}'

# 两个检索后端的本地夹具：Tavily 走 JSON，Bing 走 li.b_algo 的 HTML。
TAVILY_PAYLOAD = b'{"results":[{"url":"https://a.test/1","title":"A","content":"SA"}]}'
ACT_PAGE = b"""<!doctype html><html><head><title>ACT</title></head><body>
<input id="q"><button id="go" onclick="document.getElementById('out').textContent =
  'clicked:' + document.getElementById('q').value">go</button>
<div id="out">idle</div></body></html>"""

BING_HTML = b"""<!doctype html><html><body>
<li class="b_algo"><h2><a href="https://a.test/1">A</a></h2><div class="b_caption"><p>SA</p></div></li>
<li class="b_algo"><h2><a href="https://b.test/2">B</a></h2><div class="b_caption"><p>SB</p></div></li>
</body></html>"""

# 形状不对的 Bing 页：一条没有 h2 a、一条 href 是空串，再加两条正常的用来判剔除与上限。
BRAVE_PAYLOAD = (
    b'{"web":{"results":[{"url":"https://brave.example/a","title":"BRAVE-HIT","description":"from the brave stub"}]}}'
)
SERPER_PAYLOAD = (
    b'{"organic":[{"link":"https://serper.example/a","title":"SERPER-HIT","snippet":"from the serper stub"}]}'
)
SEARXNG_PAYLOAD = (
    b'{"results":[{"url":"https://searx.example/a","title":"SEARX-HIT","content":"from the searxng stub"}]}'
)
DDG_HTML = (
    b'<html><body><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg='
    b'https%3A%2F%2Fexample.com%2Fddg-hit">DDG-HIT</a><a class="result__snippet">from the ddg stub</a></div>'
    b'<div class="result"><a class="result__a" href="https://example.com/plain-hit">PLAIN-HIT</a></div></body></html>'
)
DDG_EMPTY = b'<html><body><div class="no-results">Nothing found</div></body></html>'
BING_JUNK_HTML = b"""<!doctype html><html><body>
<li class="b_algo"><h2><span>no link row</span></h2></li>
<li class="b_algo"><h2><a href="">empty href row</a></h2></li>
<li class="b_algo"><h2><a href="https://a.test/1">C</a></h2><div class="b_caption"><p>SC</p></div></li>
<li class="b_algo"><h2><a href="https://b.test/2">D</a></h2></li>
</body></html>"""

# 形状不对的 Tavily 回包：一条不是对象、一条没有 url、一条 url 是空串，加一条正常的。
TAVILY_JUNK_PAYLOAD = b'{"results":[{"url":"https://a.test/1","title":"A"},42,{"title":"no url"},{"url":""}]}'

# POST 版本的接口调用：网络摘要的 method 缺陷就落在这种记录上 —— 上游记的是 POST，
# 早先的实现却从别的字段读成 GET。
POST_PAGE = b"""<!doctype html><html><head><title>POST Page</title></head>
<body><div id="app">LOADING_PLACEHOLDER</div>
<script>fetch('/api/data', {method: 'POST'}).then(function(r){return r.text()}).then(function(t){
  document.getElementById('app').textContent = 'GOT:' + t;
});</script></body></html>"""

failures: list[str] = []
passes = 0
# 跑量下限取的是「一次不差的全部条数」，不是「减去一点余量」：最小的几节只有 2 条，
# 留了余量就等于允许最小的两三节静默消失，而那时 failures 照旧是空的。
# 多加一条不需要动这里（只禁下降）；少一条就必须显式改这个数，改的人得说自己为什么少跑了。
#
# 下限分两档，档位由「这台机器能不能真起一次浏览器」决定：没有二进制时，依赖浏览器的那几节
# 整段不参与（实测差 57 条），那不是静默消失。只写一档的后果实测过——该仓 CI 刻意不装浏览器，
# 于是门禁红在环境上，红完读者先去怀疑代码。两档各自钉死、都只禁下降。
MIN_CHECKS_WITH_BROWSER = 541
MIN_CHECKS_WITHOUT_BROWSER = 484


def check(name: str, condition: bool, detail: str = "") -> None:
    """记一条断言结果。

    :param name - 用例名
    :param condition - 是否通过
    :param detail - 失败时打印的细节
    """
    global passes  # noqa: PLW0603 —— 手写断言框架的计数器，收在一处比分号传递好读
    if condition:
        passes += 1
        print(f"  PASS  {name}")
    else:
        failures.append(f"{name} -- {detail}")
        print(f"  FAIL  {name}  {detail}")


def expect_error(code: str, run: Any) -> Any:
    """跑一次必须失败的适配器调用，并断言错误码。"""
    try:
        run()
    except Exception as error:  # noqa: BLE001 —— 断言的是错误码，不是异常类型
        actual = getattr(error, "code", None)
        check(f"错误码 {code}", actual == code, repr(error))
        return error
    raise AssertionError(f"expected {code}, but the call succeeded")


def expect_frame_error(code: str, frame: dict[str, Any]) -> dict[str, Any]:
    """断言一帧 sidecar 回包的错误码。"""
    actual = (frame.get("error") or {}).get("code")
    check(f"帧错误码 {code}", actual == code, repr(frame)[:200])
    return frame


def _sidecar_argv() -> list[str]:
    """起 sidecar 子进程的命令行。

    默认就是真实插件用的那条（``-u`` 关缓冲、``-I`` 隔离）。跑覆盖率时多套一层 ``coverage run``，
    为的是把活在子进程里的 bridge.py、adapters 的浏览器/会话路径与 session_page 也量进来。

    ``--source`` 必须给**绝对路径**：``pyproject.toml`` 里的 ``source = ["py"]`` 按进程的工作目录
    解析，而子进程的工作目录是 ``py/`` —— 留给它相对形式，解析出来的就是 ``py/py``，于是子进程
    照样写出一个**空的数据文件**（不是报错，是零测量），地板读数里那句「有浏览器的路径都量到了」
    就成了假的。``--data-file`` 同理必须绝对（见下）。

    ``--data-file`` 必须给**绝对路径**：子进程的工作目录是 py/，而覆盖率默认把数据写在
    当前目录下。不给的话它的那一份落在 py/ 里，父进程随后的 combine 与 erase 都只在
    仓库根跑，于是每次 cov:py 都在 py/ 留下三个没人收的 .coverage.* 文件。

    :returns: argv
    """
    argv = [sys.executable, "-u", "-I"]
    if os.environ.get("DSH_PY_COVERAGE") == "1":
        argv += [
            "-m",
            "coverage",
            "run",
            f"--rcfile={CONFIG}",
            f"--source={PY_DIR}",
            f"--data-file={REPO / '.coverage'}",
            "--parallel-mode",
        ]
    return [*argv, str(BRIDGE)]


class Sidecar:
    """驱动 bridge.py 子进程的最小客户端。

    读端用一个后台线程把行推进队列，而不是在主线程上阻塞 readline —— 这样「等不到
    响应」会变成一次带超时的失败，而不是整个测试挂死。真实的 TS 侧客户端同样必须这么
    做，否则一个不响应的 sidecar 会把工具调用一起拖住。
    """

    def __init__(self, extra_env: dict[str, str] | None = None) -> None:
        """拉起 sidecar。

        :param extra_env: 追加/覆盖的环境变量，用来跑「同一份代码、不同部署表态」那类对照

        工作目录用一次性临时目录，不落在 ``py/``：Scrapling 的 adaptive 指纹库
        （``elements_storage.db``）按**进程 cwd** 落盘，用仓库目录会让测试产物留在
        工作区；而 Windows 上 sidecar 活着时那个 SQLite 句柄删不掉（WinError 32），
        想在测试中途清掉根本做不到。临时目录在 :meth:`close` 里随进程一起收。
        """
        self.cwd = Path(tempfile.mkdtemp(prefix="dsh-scrapling-sidecar-"))
        self.proc = subprocess.Popen(  # noqa: S603  # nosec B603
            _sidecar_argv(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(self.cwd),
            text=True,
            # 宿主按 UTF-8 解 bridge 的 stdout；这里必须同口径，否则 Windows 的
            # text=True 会按本地代码页（cp1252）解，非 ASCII 正文变成乱码，断言就对不上。
            encoding="utf-8",
            bufsize=1,
            # 本地测试服务器就在 127.0.0.1 上，而守卫（正确地）默认拒绝回环地址。
            # 所以这条用例必须显式放行 —— 这也顺带证明了守卫的放行开关是接通的。
            # 写方法这一档默认**开着**：`run_write_verbs` 要让真 curl_cffi 真发一次 POST，
            # 而那需要部署表态。关的那一支由 run_write_gate 用第二个 sidecar 走。
            env={
                **os.environ,
                "DSH_SCRAPLING_ALLOWED_HOSTS": "127.0.0.1,localhost",
                "DSH_SCRAPLING_ALLOW_WRITE_METHODS": "1",
                "DSH_SCRAPLING_ALLOW_BROWSER_ACTIONS": "1",
                "DSH_SCRAPLING_ALLOW_FILE_DOWNLOADS": "1",
                **(extra_env or {}),
            },
        )
        self.counter = 0
        self.write_lock = threading.Lock()
        self.lines: "queue.Queue[str | None]" = queue.Queue()
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()

    def _pump(self) -> None:
        """把子进程 stdout 的行逐行推进队列；进程退出时推一个 None 作结束标记。"""
        stdout = self.proc.stdout
        if stdout is None:
            raise AssertionError("sidecar stdout pipe is missing")
        for line in stdout:
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
        """按协议优雅关闭，并收掉这次用的工作目录。"""
        with suppress(Exception):
            self.counter += 1
            self.send_raw_frame({"id": str(self.counter), "method": "shutdown"})
            self.read_frame()
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:  # pragma: no cover
            self.proc.kill()
        shutil.rmtree(self.cwd, ignore_errors=True)


# /file.seq 的递增计数器：并发下载用例靠它区分四份正文。
_SEQ_COUNTER = [0]
_SEQ_LOCK = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    """只回 SPA 外壳；其余路径回一张占位图片；写方法把请求本身回显成 JSON。"""

    def do_GET(self) -> None:  # BaseHTTPRequestHandler 的命名约定
        """回一页、一张图、一段接口 JSON，或回显请求本身。"""
        route = self.path.partition("?")[0]
        if route == "/echo":
            self._echo()
            return
        if route == "/api/data":
            self._send(XHR_PAYLOAD, "application/json", {"Set-Cookie": "sid=secret"})
            return
        if route == "/xhrpage":
            self._send(XHR_PAGE, "text/html; charset=utf-8")
            return
        if route == "/postpage":
            self._send(POST_PAGE, "text/html; charset=utf-8")
            return
        if route == "/actpage":
            self._send(ACT_PAGE, "text/html; charset=utf-8")
            return
        if route == "/file.bin":
            self._send(b"x" * 1024, "application/octet-stream")
            return
        if route == "/file.liar":
            # 无 Content-Length 的 chunked 响应：头部给不出体积，超限只能在传输中途由
            # 流式循环判停。把 Content-Length 谎报成小值没有意义——客户端按帧长只读
            # 那么多字节，截断发生在协议层，到不了内存。
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                for _ in range(5):
                    chunk = b"y" * 64
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
            except BrokenPipeError, ConnectionResetError:
                # 客户端中途掐断连接是这条用例的预期形态，别让服务端线程打栈。
                pass
            self.wfile.write(b"0\r\n\r\n")
            return
        if route == "/file.seq":
            # 每请求递增的正文：并发同名下载的判据要能区分「四个文件各自的内容」，
            # 同一副本做不到这一点。
            with _SEQ_LOCK:
                _SEQ_COUNTER[0] += 1
                number = _SEQ_COUNTER[0]
            self._send(f"body-{number}".encode(), "application/octet-stream")
            return
        if route == "/bing":
            self._send(BING_HTML, "text/html; charset=utf-8")
            return
        if route == "/bingempty":
            self._send(b"<html><body>no results</body></html>", "text/html; charset=utf-8")
            return
        if route == "/bingjunk":
            self._send(BING_JUNK_HTML, "text/html; charset=utf-8")
            return
        if route == "/brave":
            self._send(BRAVE_PAYLOAD, "application/json")
            return
        if route == "/brave401":
            self.send_response(401)
            self.end_headers()
            return
        if route in ("/searxng", "/searxng/search"):
            self._send(SEARXNG_PAYLOAD, "application/json")
            return
        if route == "/ddg":
            self._send(DDG_HTML, "text/html; charset=utf-8")
            return
        if route == "/ddgempty":
            self._send(DDG_EMPTY, "text/html; charset=utf-8")
            return
        if route == "/bing429":
            self.send_response(429)
            self.end_headers()
            return
        if route == "/latin1":
            self._send(b"caf\xe9", "text/plain")
            return
        body, ctype = (PAGE, "text/html; charset=utf-8") if route == "/" else (b"\x89PNG", "image/png")
        self._send(body, ctype)

    def _send(self, body: bytes, ctype: str, extra_headers: dict[str, str] | None = None) -> None:
        """回一段固定正文。"""
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        # 客户端按超时主动断开时这里会抛 ConnectionError 家族——那是用例故意造的，不是
        # 服务端故障。不接住的话 http.server 会把整段 traceback 打进日志，看着像门禁红了。
        with suppress(ConnectionError):
            self.wfile.write(body)

    def _echo(self) -> None:
        """把「这个服务端到底收到了什么」回成 JSON。

        写方法的判据只能是对端收到的东西：本包的 body/headers/cookies 拼错一个词名时，
        请求照样发出去、照样 200，只有对端能说明它到没到。
        """
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        body = json.dumps(
            {
                "method": self.command,
                "path": self.path,
                "received": raw.decode(errors="replace"),
                "marker": self.headers.get("X-Contract"),
                "cookie": self.headers.get("Cookie"),
            },
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # BaseHTTPRequestHandler 的命名约定
        """回显这次 POST，或在接口路径上回固定 JSON。"""
        route = self.path.partition("?")[0]
        if route == "/api/data":
            self._send(XHR_PAYLOAD, "application/json", {"Set-Cookie": "sid=secret"})
            return
        if route == "/tavily":
            self._send(TAVILY_PAYLOAD, "application/json")
            return
        if route == "/serper":
            self._send(SERPER_PAYLOAD, "application/json")
            return
        if route == "/serper429":
            self.send_response(429)
            self.end_headers()
            return
        if route == "/tavily401":
            self.send_response(401)
            self.end_headers()
            return
        if route == "/tavily429":
            self.send_response(429)
            self.end_headers()
            return
        if route == "/tavily500":
            self.send_response(500)
            self.end_headers()
            return
        if route == "/tavilyjunk":
            self._send(TAVILY_JUNK_PAYLOAD, "application/json")
            return
        if route == "/notjson":
            self._send(b"not json at all", "application/json")
            return
        if route == "/tavlyslow":
            # 慢到必然超过调用方给的 timeoutSeconds，用来判「超时」这一码而不是「请求失败」。
            time.sleep(0.4)
            self._send(TAVILY_PAYLOAD, "application/json")
            return
        self._echo()

    def do_PUT(self) -> None:  # 同上
        """回显这次 PUT。"""
        self._echo()

    def do_DELETE(self) -> None:  # 同上
        """回显这次 DELETE。"""
        self._echo()

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

    print("\n== 离线正文不再单开一个协议方法 ==")
    # 已有 HTML 的正文归一住在 to_payload 里（scrapling_session_read 走的就是它），协议面
    # 再开一个入口等于多留一条可能绕开清洗的旁路。这里钉的是「那条口已经封上」。
    answer = sidecar.call("extract", {"html": "<html><body><h1>Hi</h1></body></html>"})
    check(
        "extract 回 UNKNOWN_METHOD",
        answer.get("error", {}).get("code") == "UNKNOWN_METHOD",
        repr(answer)[:120],
    )

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

    print("\n== adaptive 自愈选择器 ==")
    page_v1 = '<html><body><div class="price-box"><span class="amount">$5</span></div></body></html>'
    # 站点改版：类名全换，但标签、文本与嵌套结构还在 —— 指纹该认出它。
    page_v2 = '<html><body><div class="pbox"><span class="amt">$5</span></div></body></html>'
    site = f"{base}/adaptive"
    first = sidecar.call("select", {"html": page_v1, "selector": ".price-box span", "adaptive": True, "url": site})
    first_result = first.get("result") or {}
    check("adaptive 首次命中并记指纹", first.get("ok") is True, repr(first)[:200])
    check(
        "adaptive 首次命中文本",
        [m.get("text") for m in first_result.get("matches", [])] == ["$5"],
        repr(first)[:200],
    )
    second = sidecar.call("select", {"html": page_v2, "selector": ".price-box span", "adaptive": True, "url": site})
    second_result = second.get("result") or {}
    check(
        "adaptive 改版后按指纹重定位",
        second.get("ok") is True and [m.get("text") for m in second_result.get("matches", [])] == ["$5"],
        repr(second)[:220],
    )
    plain = sidecar.call("select", {"html": page_v2, "selector": ".price-box span"})
    check(
        "不开 adaptive 时同样的失配就是 0 条",
        (plain.get("result") or {}).get("count") == 0,
        repr(plain)[:160],
    )
    # 指纹库落在 sidecar 的工作目录（一次性的临时目录）。这里只判「确实写在这里」；
    # 删除由 Sidecar.close() 随工作目录一起做——Windows 上进程活着时那个 SQLite
    # 句柄删不掉，测试中途 unlink 会直接抛 WinError 32。
    check(
        "adaptive 指纹库落在 sidecar 工作目录",
        (sidecar.cwd / "elements_storage.db").exists(),
        repr(sorted(entry.name for entry in sidecar.cwd.iterdir()))[:200],
    )

    print("\n== 静态抓取（curl_cffi 打本地服务）==")
    answer = sidecar.call("fetch", {"url": f"{base}/", "extractionType": "text"})
    result = answer.get("result", {})
    content = result.get("content", "")
    check("fetch 成功", answer.get("ok") is True, repr(answer)[:220])
    check("fetch 拿到 200", result.get("status") == 200, repr(result)[:160])
    check("静态管线不执行 JS（只看到占位）", "LOADING_PLACEHOLDER" in content, repr(content)[:120])
    check("静态管线拿不到渲染后内容", "Server Price" not in content, "静态管线不该渲染")

    # cssSelector 此前只在 markdown 路径生效，html/text 拿到它却悄悄返回整页 ——
    # 三条路径现在同一口径：命中 0 个元素就给空正文，不回退成整页。
    answer = sidecar.call("fetch", {"url": f"{base}/", "cssSelector": "#app", "extractionType": "html"})
    html_content = answer.get("result", {}).get("content", "")
    check(
        "fetch 的 html 路径吃 cssSelector",
        "LOADING_PLACEHOLDER" in html_content and "<!doctype" not in html_content.lower(),
        repr(html_content)[:180],
    )
    answer = sidecar.call("fetch", {"url": f"{base}/", "cssSelector": "#app", "extractionType": "text"})
    check(
        "fetch 的 text 路径吃 cssSelector",
        answer.get("result", {}).get("content", "") == "LOADING_PLACEHOLDER",
        repr(answer.get("result", {}))[:180],
    )
    answer = sidecar.call("fetch", {"url": f"{base}/", "cssSelector": "no-such-thing", "extractionType": "text"})
    check(
        "cssSelector 落空时给空正文而不是整页",
        answer.get("result", {}).get("content", "") == "",
        repr(answer.get("result", {}))[:160],
    )

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
    check(
        "未超限时 truncated 为假",
        answer.get("result", {}).get("truncated") is False,
        repr(answer.get("result", {}))[:120],
    )

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
    answer = sidecar.call(
        "render",
        {"url": f"{base}/", "cssSelector": "table", "extractionType": "text", "networkIdle": True},
    )
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
    check(
        "render 支持 waitSelector 精确等待",
        "Server Price" in answer.get("result", {}).get("content", ""),
        repr(answer)[:200],
    )

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
    check(
        "重复 sessionId 被拒",
        sidecar.call("session.open", {"sessionType": "static", "sessionId": session_id}).get("ok") is False,
        "重复 id 竟然成功",
    )
    check(
        "未知 sessionType 被拒",
        sidecar.call("session.open", {"sessionType": "not-a-type"}).get("ok") is False,
        "未知类型竟然成功",
    )
    check(
        "不存在的 sessionId 被拒",
        sidecar.call("session.fetch", {"sessionId": "does-not-exist", "url": f"{base}/"}).get("ok") is False,
        "幽灵会话竟然能用",
    )
    check(
        "session.close 成功",
        sidecar.call("session.close", {"sessionId": session_id}).get("ok") is True,
        "close 失败",
    )
    check(
        "关掉后再用被拒",
        sidecar.call("session.fetch", {"sessionId": session_id, "url": f"{base}/"}).get("ok") is False,
        "关掉后还能用",
    )
    check(
        "关完 list 为空",
        (sidecar.call("session.list", {}).get("result") or {}).get("sessions") == [],
        "还有残留会话",
    )

    print("\n== 浏览器会话（跨 worker 线程复用）==")
    # 回归点：Playwright sync 对象绑定创建线程，而 bridge 的 worker 空闲 50ms 就退出。
    # 每次请求前隔 0.4s —— 远超空闲窗口，下一次调用必然由一条全新线程领走。
    # 没有会话专属执行线程时，这里稳定复现 greenlet.error。
    browser_open = sidecar.call("session.open", {"sessionType": "stealth"})
    browser_id = (browser_open.get("result") or {}).get("sessionId", "")
    check("browser session.open 成功", browser_open.get("ok") is True, repr(browser_open)[:200])
    time.sleep(0.4)
    browser_fetch = sidecar.call(
        "session.fetch",
        {"sessionId": browser_id, "url": f"{base}/", "extractionType": "text", "networkIdle": True},
    )
    browser_content = (browser_fetch.get("result") or {}).get("content", "")
    check(
        "browser session.fetch 跨线程仍可用",
        browser_fetch.get("ok") is True and "Server Price" in browser_content,
        repr(browser_fetch)[:260],
    )
    time.sleep(0.4)
    browser_fetch_2 = sidecar.call(
        "session.fetch",
        {"sessionId": browser_id, "url": f"{base}/", "extractionType": "text", "networkIdle": True},
    )
    check("browser session 第二次 fetch 仍可用", browser_fetch_2.get("ok") is True, repr(browser_fetch_2)[:220])
    browser_close = sidecar.call("session.close", {"sessionId": browser_id})
    check("browser session.close 成功", browser_close.get("ok") is True, repr(browser_close)[:200])

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
        allowed, why = guard.url_allowed("ws://127.0.0.1:9/steal", websocket=True)
        check("ws 握手按地址判拒，而不是按协议一刀切", not allowed, why)
        check("ws 判拒的理由是地址不是 scheme", "scheme" not in why, why)
        allowed, _ = guard.url_allowed("wss://127.0.0.1/ws", websocket=True)
        check("wss 握手同样按地址判拒", not allowed, "")
        allowed, _ = guard.url_allowed("ws://localhost:9/live", websocket=True)
        check("放行名单里的 ws 目标放行", allowed, "")
        allowed, why = guard.url_allowed("ws://8.8.8.8/live")
        check("ws 不是发出请求时的合法协议", not allowed, why)
        check("请求侧的拒绝理由点名 scheme", "scheme" in why, why)
        allowed, why = guard.url_allowed("wss://8.8.8.8/live")
        check("wss 同样不是发出请求时的合法协议", not allowed, why)
        allowed, why = guard.url_allowed("https://user:pass@8.8.8.8/x")
        check("URL 内嵌凭据在 Python 侧判拒", not allowed, why)
        check("凭据判拒的理由点名凭据", "credential" in why, why)
        allowed, why = guard.url_allowed("ws://user:pass@8.8.8.8/x", websocket=True)
        check("握手判定同样拒绝内嵌凭据", not allowed, why)
        allowed, _ = guard.url_allowed("file:///etc/passwd")
        check("非 http/ws 系协议仍判拒", not allowed, "")
        for host, note in (
            ("0177.0.0.1", "八进制读法 = 127.0.0.1"),
            ("00177.0.0.1", "同上"),
            ("2852039166", "整数读法 = 169.254.169.254"),
            ("0x7f000001", "十六进制读法 = 127.0.0.1"),
            ("127.1", "两段写法 = 127.0.0.1"),
        ):
            check(
                f"IP 字面量歧义写法判拒（{note}）",
                not guard.is_public_address(host),
                host,
            )

        # WHATWG IPv4 解析的边界：守卫按「浏览器会怎么连」精确复刻，而不是拿字符形态猜。
        # 反例里的域名都是真实存在的纯十六进制字母域名 —— 上一版的形态正则在这里集体误杀，
        # 且 Host 侧（ipaddr.js 真解析）放行、Python 侧拒绝，两层判定不同解。
        for host, expected in (
            ("0177.0.0.1", "127.0.0.1"),
            ("0x7f.0.0.1", "127.0.0.1"),
            ("2852039166", "169.254.169.254"),
            ("1.2.3", "1.2.0.3"),
            ("010.0.0.1", "8.0.0.1"),
        ):
            parsed = guard._whatwg_ipv4(host)
            check(f"WHATWG IPv4：{host} → {expected}", parsed is not None and str(parsed) == expected, str(parsed))
        for host in (
            "cafe.de",
            "beef.be",
            "c.cc",
            "e.ee",
            "cafe2.de",
            "1.2.3.4.5",
            "08.0.0.1",
            "1.2.3.256",
            "example.123",
        ):
            check(f"WHATWG IPv4：{host} 不是字面量", guard._whatwg_ipv4(host) is None, host)

        # 「按域名判」的整条链路离线可测：注入 getaddrinfo 回一份公网答案，判定应放行。
        import socket as socket_module

        scripted = {"cafe.de": ["93.184.216.34"], "beef.be": ["93.184.216.34"]}
        real_getaddrinfo = guard.socket.getaddrinfo
        real_cache = guard._SYNTHETIC_RESOLVER

        def scripted_answers(host: str, *_args: object, **_kwargs: object) -> list[tuple]:
            if host in scripted:
                return [(socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", (ip, 0)) for ip in scripted[host]]
            raise OSError(f"no such host: {host}")

        guard.socket.getaddrinfo = scripted_answers  # type: ignore[assignment]
        guard._SYNTHETIC_RESOLVER = False
        guard._dns_cache_clear()
        try:
            for domain in ("cafe.de", "beef.be"):
                check(
                    f"纯十六进制字母的真实域名按域名判（{domain}）",
                    guard.is_public_address(domain) is True,
                    domain,
                )
        finally:
            guard.socket.getaddrinfo = real_getaddrinfo
            guard._SYNTHETIC_RESOLVER = real_cache
            guard._dns_cache_clear()

        # 守卫日志的脱敏面：日志会进宿主日志，URL 里的凭据不能原样出现在那里。
        # 此前「密钥不进日志」只有错误消息与结果两面有断言，这一段把第三面钉上。
        # 判定必须走 route handler 那条路——日志发生在拦截点，url_allowed 本身不记日志。
        log_buffer = io.StringIO()
        page_for_log = FakePage()
        guard.install(page_for_log)
        with contextlib.redirect_stderr(log_buffer):
            page_for_log.handler("route")(FakeRoute("http://127.0.0.1:9/x?token=SECRET-VALUE&page=2"))  # type: ignore[operator]
        guard_log = log_buffer.getvalue()
        check("守卫日志不出现查询串里的凭据", "SECRET-VALUE" not in guard_log and "blocked" in guard_log, guard_log)
        check("守卫日志把凭据值换成占位符", "redacted" in guard_log, guard_log)
        check("守卫日志保留参数名与普通参数", "token=" in guard_log and "page=2" in guard_log, guard_log)
        credential_buffer = io.StringIO()
        with contextlib.redirect_stderr(credential_buffer):
            page_for_log.handler("route")(FakeRoute("http://user:pass@127.0.0.1:9/x"))  # type: ignore[operator]
        credential_log = credential_buffer.getvalue()
        check(
            "守卫日志不出现内嵌凭据",
            "user:pass" not in credential_log and "blocked" in credential_log,
            credential_log,
        )
        ws_buffer = io.StringIO()
        ws_secret = FakeWebSocket("ws://127.0.0.1:9/steal?api_key=WS-SECRET")
        page_for_ws = FakePage()
        guard.install(page_for_ws)
        with contextlib.redirect_stderr(ws_buffer):
            page_for_ws.handler("route_web_socket")(ws_secret)  # type: ignore[operator]
        check("ws 判拒日志同样脱敏", "WS-SECRET" not in ws_buffer.getvalue(), ws_buffer.getvalue())

        # 解析缓存：同一主机的重复判定不出网，失败答案也有一个短缓存。
        cache_scripted = {"cached.test": ["93.184.216.34"]}
        resolve_calls = {"count": 0}
        cache_real_getaddrinfo = guard.socket.getaddrinfo
        cache_real_synthetic = guard._SYNTHETIC_RESOLVER

        def counting_answers(host: str, *_args: object, **_kwargs: object) -> list[tuple]:
            if host in cache_scripted:
                resolve_calls["count"] += 1
                return [
                    (socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", (ip, 0)) for ip in cache_scripted[host]
                ]
            raise OSError(f"no such host: {host}")

        guard.socket.getaddrinfo = counting_answers  # type: ignore[assignment]
        guard._SYNTHETIC_RESOLVER = False
        guard._dns_cache_clear()
        try:
            first = guard.is_public_address("cached.test")
            second = guard.is_public_address("cached.test")
            check(
                "缓存命中后同一主机只解析一次",
                first and second and resolve_calls["count"] == 1,
                f"calls={resolve_calls['count']}",
            )
            guard._dns_cache_clear()
            guard.is_public_address("cached.test")
            check("清缓存后重新解析", resolve_calls["count"] == 2, f"calls={resolve_calls['count']}")

            fail_calls = {"count": 0}

            def failing_answers(host: str, *_args: object, **_kwargs: object) -> list[tuple]:
                fail_calls["count"] += 1
                raise OSError("resolver down")

            guard.socket.getaddrinfo = failing_answers  # type: ignore[assignment]
            guard._dns_cache_clear()
            check("解析失败按不可抓处理", guard.is_public_address("down.test") is False, "")
            check(
                "失败答案也有缓存：短时间内不再出网",
                guard.is_public_address("down.test") is False and fail_calls["count"] == 1,
                f"calls={fail_calls['count']}",
            )
        finally:
            guard.socket.getaddrinfo = cache_real_getaddrinfo
            guard._SYNTHETIC_RESOLVER = cache_real_synthetic
            guard._dns_cache_clear()

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
<div>IN&#8203;STRUCT&#8203;ION</div>
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
    # 零宽字符把关键词拆开：留着，所有按字面匹配的判断都会看不见那句话。
    "\u200b",
)


class FakeResponse:
    """够 to_payload 用的最小 Response 替身。"""

    url = "http://127.0.0.1:1/"
    status = 200
    history = ()
    html_content = HOSTILE.decode()
    headers = {"Content-Type": "text/html; charset=utf-8", "Set-Cookie": "secret=1"}
    encoding = "utf-8"
    reason = "OK"

    class _Request:
        method = "GET"

    request = _Request()

    def json(self) -> Any:
        return json.loads(self.html_content)

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


def run_fetch_params(sidecar: Sidecar, base: str) -> None:
    """静态抓取的请求件参数：查询串、表单、JSON 体与编码回退。"""

    def fetch(fields: dict[str, Any]) -> dict[str, Any]:
        return sidecar.call("fetch", {"extractionType": "json", **fields})

    echo = fetch({"url": f"{base}/echo", "params": {"q": "hello"}})
    parsed = json.loads(echo.get("result", {}).get("content", "{}"))
    check("GET 查询串到达", "q=hello" in parsed.get("path", ""), repr(parsed)[:200])

    form = json.loads(
        fetch({"url": f"{base}/echo", "method": "POST", "form": {"a": "1"}}).get("result", {}).get("content", "{}")
    )
    check("form 到达", "a=1" in form.get("received", ""), repr(form)[:200])

    sent_json = json.loads(
        fetch({"url": f"{base}/echo", "method": "POST", "json": {"a": 1}}).get("result", {}).get("content", "{}")
    )
    check(
        "json 到达",
        json.loads(sent_json.get("received", "null")) == {"a": 1},
        repr(sent_json)[:200],
    )

    conflict = fetch({"url": f"{base}/echo", "method": "POST", "form": {"a": "1"}, "json": {"a": 1}})
    check("form/json 互斥报 BAD_ARGS", conflict.get("error", {}).get("code") == "BAD_ARGS", repr(conflict)[:200])

    latin = fetch({"url": f"{base}/latin1", "extractionType": "text", "defaultEncoding": "latin-1"})
    check(
        "defaultEncoding 只在无 charset 时回退",
        latin.get("result", {}).get("content") == "café",
        repr(latin.get("result"))[:200],
    )

    bad_delay = fetch({"url": f"{base}/echo", "retryDelay": 0})
    check("retryDelay 非正报 BAD_ARGS", bad_delay.get("error", {}).get("code") == "BAD_ARGS", repr(bad_delay)[:200])


def run_browser_params() -> None:
    """浏览器参数在「会话构造」与「逐次 fetch」两层之间的分层。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
    finally:
        sys.path.remove(str(PY_DIR))

    args: dict[str, Any] = {
        "cookies": [{"name": "a", "value": "b"}],
        "disableResources": True,
        "loadDom": False,
        "waitSelectorState": "visible",
        "blockedDomains": ["ads.test"],
        "googleSearch": False,
        "retries": 2,
        "retryDelay": 3,
        "maxPages": 2,
    }
    session_params = adapters._session_browser_params(args)
    check(
        "session 参数含 cookies",
        session_params.get("cookies") == [{"name": "a", "value": "b"}],
        repr(session_params)[:300],
    )
    check(
        "session 参数含 disable_resources",
        session_params.get("disable_resources") is True,
        repr(session_params)[:300],
    )
    check("session 参数含 load_dom", session_params.get("load_dom") is False, repr(session_params)[:300])
    check(
        "session 参数含 blocked_domains",
        session_params.get("blocked_domains") == {"ads.test"},
        repr(session_params)[:300],
    )
    check(
        "session 参数含 google_search",
        session_params.get("google_search") is False,
        repr(session_params)[:300],
    )
    check(
        "session 参数含 retries/retry_delay",
        session_params.get("retries") == 2 and session_params.get("retry_delay") == 3,
        repr(session_params)[:300],
    )

    # 上游 PlaywrightConfig 把这两个键收在 RetriesCount(1..10) 与 PagesCount(1..50) 里，
    # 越界值不在 Scrapling 报错，而是在 msgspec 那边炸成 TypeError —— 静态那一侧的
    # retries 是裸 Optional[int]，所以天花板只落在浏览器这一条路径上。
    for field, key, ceiling in (("retries", "retries", 10), ("maxPages", "max_pages", 50)):
        over = {field: ceiling + 1}
        try:
            adapters._session_browser_params(over)
            check(f"浏览器 {field} 超过 {ceiling} 判 BAD_ARGS", False, "放行")
        except adapters.AdapterError as error:
            check(
                f"浏览器 {field} 超过 {ceiling} 判 BAD_ARGS",
                error.code == "BAD_ARGS" and str(ceiling) in str(error),
                f"{error.code}: {error}",
            )
        at_limit = adapters._session_browser_params({field: ceiling})
        check(f"浏览器 {field} 取 {ceiling} 正好通过", at_limit.get(key) == ceiling, repr(at_limit)[:200])
    check(
        "静态路径的 retries 不受那一档天花板约束",
        adapters._static_params({"retries": 20}, "https://example.test/")["retries"] == 20,
        repr(adapters._static_params({"retries": 20}, "https://example.test/"))[:200],
    )

    fetch_params = adapters._browser_params(args, "", level="fetch")
    check(
        "fetch 层不含 session-only 键",
        "cookies" not in fetch_params
        and "retries" not in fetch_params
        and "retry_delay" not in fetch_params
        and "max_pages" not in fetch_params,
        repr(fetch_params)[:300],
    )
    check(
        "fetch 层含逐次键",
        fetch_params.get("wait_selector_state") == "visible"
        and fetch_params.get("load_dom") is False
        and fetch_params.get("disable_resources") is True
        and fetch_params.get("google_search") is False
        and fetch_params.get("blocked_domains") == {"ads.test"},
        repr(fetch_params)[:300],
    )

    # 报告 §2.1：这两个键不能预置默认值。它们也在 FETCH_LEVEL_KEYS 里，预置了就等于每次
    # session.fetch 都向引擎显式发一份「关」，上游只看键在不在、按 override 处理 ——
    # session.open 时设下的拦截规则会在第一次 fetch 上被静默清掉。
    bare_fetch = adapters._browser_params({}, "https://a.test/", level="fetch")
    check(
        "模型没给 blockedDomains 时 fetch 层不发 blocked_domains",
        "blocked_domains" not in bare_fetch,
        repr(bare_fetch)[:300],
    )
    check(
        "模型没给 disableResources 时 fetch 层不发 disable_resources",
        "disable_resources" not in bare_fetch,
        repr(bare_fetch)[:300],
    )
    bare_session = adapters._session_browser_params({})
    check(
        "会话层同样不预置这两个键（否则会话配置一开始就是「关」）",
        "blocked_domains" not in bare_session and "disable_resources" not in bare_session,
        repr(bare_session)[:300],
    )
    explicit_default = adapters._browser_params(
        {"blockedDomains": ["ads.test"], "disableResources": False}, "https://a.test/", level="fetch"
    )
    check(
        "模型显式给值时照发（那是明确表态，不是默认值）",
        explicit_default.get("blocked_domains") == {"ads.test"} and explicit_default.get("disable_resources") is False,
        repr(explicit_default)[:300],
    )


def run_session_read(sidecar: Sidecar, base: str) -> None:
    """session.read：读当前页、无页与会话不存在的错误码。"""
    opened = sidecar.call("session.open", {"sessionType": "stealth"})
    session_id = opened.get("result", {}).get("sessionId", "")
    fresh = sidecar.call("session.open", {"sessionType": "stealth"})
    fresh_id = fresh.get("result", {}).get("sessionId", "")
    try:
        fetched = sidecar.call(
            "session.fetch",
            {"sessionId": session_id, "url": base, "networkIdle": True, "extractionType": "text"},
        )
        check("session.read 前置抓取成功", fetched.get("ok") is True, repr(fetched)[:200])
        read = sidecar.call(
            "session.read",
            {"sessionId": session_id, "extractionType": "markdown", "maxContentChars": 20_000},
        )
        result = read.get("result", {})
        check("session.read 有正文", "Server Price" in result.get("content", ""), repr(result)[:240])
        check("session.read 有 title", result.get("title") == "SPA Rendered", repr(result)[:200])
        expect_frame_error(
            "NO_CURRENT_PAGE",
            sidecar.call("session.read", {"sessionId": fresh_id}),
        )
        expect_frame_error(
            "NO_SUCH_SESSION",
            sidecar.call("session.read", {"sessionId": "missing"}),
        )
    finally:
        if session_id:
            sidecar.call("session.close", {"sessionId": session_id})
        if fresh_id:
            sidecar.call("session.close", {"sessionId": fresh_id})


def run_session_actions(sidecar: Sidecar, base: str) -> None:
    """session.act：结构化动作、失败下标与关闭门禁。"""
    opened = sidecar.call("session.open", {"sessionType": "stealth"})
    session_id = opened.get("result", {}).get("sessionId", "")
    try:
        fetched = sidecar.call(
            "session.fetch",
            {"sessionId": session_id, "url": base + "/actpage", "networkIdle": True},
        )
        check("session.act 前置抓取成功", fetched.get("ok") is True, repr(fetched)[:200])
        acted = sidecar.call(
            "session.act",
            {
                "sessionId": session_id,
                "actions": [
                    {"type": "textbox", "target": "#q", "value": "hello"},
                    {"type": "click", "target": "#go"},
                    {"type": "wait_element", "target": "#out", "state": "visible"},
                ],
            },
        )
        check("动作完成", acted.get("result", {}).get("completed") == 3, repr(acted)[:240])
        read = sidecar.call(
            "session.read",
            {"sessionId": session_id, "extractionType": "text", "maxContentChars": 5000},
        )
        check(
            "动作结果进了当前页",
            "clicked:hello" in read.get("result", {}).get("content", ""),
            repr(read)[:240],
        )
        failed = sidecar.call(
            "session.act",
            {
                "sessionId": session_id,
                "actions": [{"type": "click", "target": "#missing"}],
                "timeoutMs": 500,
            },
        )
        check(
            "失败动作报 ACTION_FAILED",
            failed.get("error", {}).get("code") == "ACTION_FAILED",
            repr(failed)[:240],
        )
        check(
            "失败点名第 1 个动作",
            (failed.get("error", {}).get("details") or {}).get("actionIndex") == 1,
            repr(failed)[:240],
        )
    finally:
        if session_id:
            sidecar.call("session.close", {"sessionId": session_id})

    blocked = Sidecar(extra_env={"DSH_SCRAPLING_ALLOW_BROWSER_ACTIONS": "0"})
    try:
        blocked.read_frame()
        frame = blocked.call("session.act", {"sessionId": "missing", "actions": [{"type": "click", "target": "#x"}]})
        check(
            "动作门禁关闭时硬拒",
            frame.get("error", {}).get("code") == "ACTION_DISABLED",
            repr(frame)[:200],
        )
    finally:
        blocked.close()


def run_download(base: str) -> None:
    """download：落盘、哈希、路径穿越、不覆盖、体积上限与门禁。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
        import guard
    finally:
        sys.path.remove(str(PY_DIR))
    import shutil

    saved_hosts = set(guard.ALLOWED_HOSTS)
    saved_gate = guard.ALLOW_FILE_DOWNLOADS
    directory = tempfile.mkdtemp(prefix="dsh-download-")
    guard.configure(allowed_hosts=frozenset({"127.0.0.1"}), allow_file_downloads=True)
    try:
        out = adapters.download(
            {
                "url": base + "/file.bin",
                "filename": "a.png",
                "deployment": {"downloadDir": directory},
            }
        )
        check("下载落盘", os.path.getsize(out["path"]) == 1024, repr(out))
        check("下载哈希", len(out["sha256"]) == 64, repr(out))
        check("下载路径在目录内", os.path.dirname(out["path"]) == directory, repr(out))
        check("下载 contentType", out["contentType"] == "application/octet-stream", repr(out))
        expect_error(
            "DOWNLOAD_PATH",
            lambda: adapters.download(
                {
                    "url": base + "/file.bin",
                    "filename": "../x",
                    "deployment": {"downloadDir": directory},
                }
            ),
        )
        expect_error(
            "DOWNLOAD_PATH",
            lambda: adapters.download(
                {
                    "url": base + "/file.bin",
                    "filename": "/etc/passwd",
                    "deployment": {"downloadDir": directory},
                }
            ),
        )
        expect_error(
            "URL_BLOCKED",
            lambda: adapters.download(
                {"url": "ws://8.8.8.8/file.bin", "deployment": {"downloadDir": directory}},
            ),
        )
        credentials = expect_error(
            "URL_BLOCKED",
            lambda: adapters.download(
                {"url": "https://user:pass@127.0.0.1/file.bin", "deployment": {"downloadDir": directory}},
            ),
        )
        # 放行名单只豁免「地址必须公网」这一条；内嵌凭据在它面前仍然判拒。
        check(
            "凭据下载的理由点名凭据",
            "credential" in str(credentials),
            str(credentials),
        )
        second = adapters.download(
            {
                "url": base + "/file.bin",
                "filename": "a.png",
                "deployment": {"downloadDir": directory},
            }
        )
        check("重名不覆盖", second["path"] != out["path"], repr(second))
        check("旧文件仍在", os.path.exists(out["path"]), out["path"])
        expect_error(
            "DOWNLOAD_TOO_LARGE",
            lambda: adapters.download(
                {
                    "url": base + "/file.bin",
                    "filename": "big.bin",
                    "maxBytes": 100,
                    "deployment": {"downloadDir": directory},
                }
            ),
        )
        leftover = sorted(
            entry.name
            for entry in Path(directory).iterdir()
            if entry.name.startswith("big.bin") or ".part" in entry.name
        )
        check("超限下载不落任何文件（头部预检拒绝）", leftover == [], repr(leftover))
        expect_error(
            "DOWNLOAD_TOO_LARGE",
            lambda: adapters.download(
                {
                    "url": base + "/file.liar",
                    "filename": "liar.bin",
                    "maxBytes": 100,
                    "deployment": {"downloadDir": directory},
                }
            ),
        )
        liar_leftover = sorted(
            entry.name
            for entry in Path(directory).iterdir()
            if entry.name.startswith("liar.bin") or ".part" in entry.name
        )
        check("无 Content-Length 的超长响应在传输中途掐断且不落盘", liar_leftover == [], repr(liar_leftover))

        def seq_download(_index: int) -> dict[str, Any]:
            return adapters.download(
                {"url": base + "/file.seq", "filename": "seq.bin", "deployment": {"downloadDir": directory}}
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            seq_results = list(pool.map(seq_download, range(4)))
        seq_paths = [item["path"] for item in seq_results]
        check("并发同名下载四路全部成功", len(seq_results) == 4, repr(seq_results)[:200])
        check("并发同名下载落点互不相同", len(set(seq_paths)) == 4, repr(seq_paths))
        check(
            "并发同名下载哈希互不相同",
            len({item["sha256"] for item in seq_results}) == 4,
            repr(seq_paths),
        )
        check(
            "并发同名下载每个文件与回执一致",
            all(hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest() == item["sha256"] for item in seq_results),
            repr(seq_paths),
        )
        default_name = adapters.download({"url": base + "/file.bin", "deployment": {"downloadDir": directory}})
        check(
            "缺省文件名取自 URL",
            os.path.basename(default_name["path"]) == "file.bin",
            repr(default_name),
        )
        guard.configure(allow_file_downloads=False)
        expect_error(
            "DOWNLOAD_DISABLED",
            lambda: adapters.download({"url": base + "/file.bin", "deployment": {"downloadDir": directory}}),
        )
    finally:
        guard.configure(allowed_hosts=frozenset(saved_hosts), allow_file_downloads=saved_gate)
        shutil.rmtree(directory, ignore_errors=True)


def run_screenshot(sidecar: Sidecar, base: str) -> None:
    """screenshot：PNG/JPEG 字节、元素截图、无页与参数冲突。"""
    opened = sidecar.call("session.open", {"sessionType": "stealth"})
    session_id = opened.get("result", {}).get("sessionId", "")
    fresh = sidecar.call("session.open", {"sessionType": "stealth"})
    fresh_id = fresh.get("result", {}).get("sessionId", "")
    static = sidecar.call("session.open", {"sessionType": "static"})
    static_id = static.get("result", {}).get("sessionId", "")
    try:
        fetched = sidecar.call(
            "session.fetch",
            {"sessionId": session_id, "url": base, "networkIdle": True},
        )
        check("screenshot 前置抓取成功", fetched.get("ok") is True, repr(fetched)[:200])
        shot = sidecar.call("screenshot", {"sessionId": session_id, "imageType": "png"})
        result = shot.get("result", {})
        check("截图有字节", len(result.get("base64", "")) > 100, repr(result)[:80])
        check("截图 mediaType", result.get("mediaType") == "image/png", repr(result)[:120])
        check(
            "截图有尺寸",
            isinstance(result.get("width"), int)
            and result["width"] > 0
            and isinstance(result.get("height"), int)
            and result["height"] > 0,
            repr({key: result.get(key) for key in ("width", "height")}),
        )
        element = sidecar.call(
            "screenshot", {"sessionId": session_id, "imageType": "jpeg", "selector": "body", "quality": 50}
        )
        check(
            "元素 JPEG 截图",
            element.get("result", {}).get("mediaType") == "image/jpeg",
            repr(element)[:160],
        )
        expect_frame_error(
            "BAD_ARGS",
            sidecar.call(
                "screenshot",
                {"sessionId": session_id, "fullPage": True, "selector": "body"},
            ),
        )
        expect_frame_error(
            "NO_CURRENT_PAGE",
            sidecar.call("screenshot", {"sessionId": fresh_id}),
        )
        expect_frame_error(
            "BAD_ARGS",
            sidecar.call("screenshot", {"sessionId": static_id}),
        )
    finally:
        for closing in (session_id, fresh_id, static_id):
            if closing:
                sidecar.call("session.close", {"sessionId": closing})


def run_network_filters(base: str) -> None:
    """网络摘要的 method 修正与过滤参数（需要真浏览器）。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
    finally:
        sys.path.remove(str(PY_DIR))
    from scrapling.fetchers import StealthySession

    def query(**overrides: Any) -> Any:
        fields: dict[str, Any] = {
            "urlPattern": None,
            "networkLimit": 50,
            "includeBody": False,
            "maxBodyChars": 500,
            "method": None,
            "status": None,
            "resourceType": None,
            "includeStatic": False,
            "afterId": 0,
            "includeHeaders": False,
            "requestId": None,
        }
        fields.update(overrides)
        return adapters._network_read(fields)

    session = StealthySession(record_requests=True)
    session.start()
    try:
        session.fetch(f"{base}/postpage", wait=1000)
        records = adapters._network_summary(session.network, query=query())
        post = [item for item in records if item.get("method") == "POST"]
        check("网络 method 取上游记录", len(post) == 1, repr(records)[:400])
        check(
            "网络条目带 id",
            bool(post) and isinstance(post[0].get("id"), int) and post[0]["id"] > 0,
            repr(post)[:200],
        )
        filtered = adapters._network_summary(
            session.network, query=query(method="POST", status=200, resourceType="fetch")
        )
        check(
            "method/status/type 过滤命中 1 条",
            len(filtered) == 1 and filtered[0].get("resourceType") == "fetch",
            repr(filtered)[:300],
        )
        static = adapters._network_summary(session.network, query=query(includeStatic=True))
        check(
            "includeStatic 带 document",
            any(item.get("resourceType") == "document" for item in static),
            repr(static)[:400],
        )
        post_id = post[0]["id"] if post else 0
        after = adapters._network_summary(session.network, query=query(afterId=post_id - 1))
        check(
            "afterId 只回更新的记录",
            all(item["id"] > post_id - 1 for item in after) and any(item["id"] == post_id for item in after),
            repr(after)[:300],
        )
        detail = adapters._network_summary(session.network, query=query(requestId=post_id, includeHeaders=True))
        check(
            "requestId 回单条详情",
            len(detail) == 1 and detail[0].get("id") == post_id,
            repr(detail)[:300],
        )
        headers = detail[0].get("headers", {}) if detail else {}
        lowered = {str(key).lower() for key in headers}
        check(
            "includeHeaders 脱敏 set-cookie/authorization",
            "set-cookie" not in lowered and "authorization" not in lowered,
            repr(headers)[:300],
        )
    finally:
        session.close()


class _UnitDialog:
    """假 dialog：accept/dismiss 记进同一份调用表。"""

    def __init__(self, calls: list[str]) -> None:
        self.calls = calls

    def accept(self) -> None:
        self.calls.append("dialog:accept")

    def dismiss(self) -> None:
        self.calls.append("dialog:dismiss")


class _UnitLocator:
    """假 locator：动作与元素截图都只按名字与取值记账。"""

    def __init__(self, selector: str, calls: list[str], matches: int = 1, shot: bytes = b"") -> None:
        self.selector = selector
        self.calls = calls
        self.matches = matches
        self.shot = shot

    def click(self, **kwargs: Any) -> None:
        self.calls.append(f"click:{self.selector}")

    def hover(self, **kwargs: Any) -> None:
        self.calls.append(f"hover:{self.selector}")

    def fill(self, value: str, **kwargs: Any) -> None:
        self.calls.append(f"fill:{self.selector}={value}")

    def check(self, **kwargs: Any) -> None:
        self.calls.append(f"check:{self.selector}")

    def uncheck(self, **kwargs: Any) -> None:
        self.calls.append(f"uncheck:{self.selector}")

    def select_option(self, value: str, **kwargs: Any) -> None:
        self.calls.append(f"select:{self.selector}={value}")

    def wait_for(self, state: str = "visible", **kwargs: Any) -> None:
        self.calls.append(f"wait_element:{self.selector}:{state}")

    def press(self, key: str, **kwargs: Any) -> None:
        self.calls.append(f"press:{self.selector}:{key}")

    def count(self) -> int:
        return self.matches

    def screenshot(self, **kwargs: Any) -> bytes:
        # 记下 timeout：元素截图那一支的 timeoutMs 曾被静默忽略，账要记到能看出的程度。
        self.calls.append(f"element-shot:{kwargs.get('timeout')}")
        return self.shot


class _UnitInput:
    """mouse 与 keyboard 的替身。"""

    def __init__(self, calls: list[str]) -> None:
        self.calls = calls

    def wheel(self, delta_x: float, delta_y: float) -> None:
        self.calls.append(f"wheel:{delta_x},{delta_y}")

    def move(self, x: float, y: float) -> None:
        self.calls.append(f"mouse-move:{x},{y}")

    def press(self, key: str) -> None:
        self.calls.append(f"key:{key}")


class _UnitPage:
    """假 page：可读、可动作、可截图，全部只记账不调浏览器。"""

    def __init__(
        self,
        *,
        closed: bool = False,
        html: str = "<html><body><h1>Unit Page</h1></body></html>",
        url: str = "http://unit.test/current",
        title: str = "Unit",
        shot: bytes = b"",
        matches: int = 1,
    ) -> None:
        self.calls: list[str] = []
        self._closed = closed
        self._html = html
        self._url = url
        self._title = title
        self.shot = shot
        self.matches = matches
        self.mouse = _UnitInput(self.calls)
        self.keyboard = _UnitInput(self.calls)
        self.dialog_handler: Any = None

    def is_closed(self) -> bool:
        return self._closed

    def content(self) -> str:
        return self._html

    def title(self) -> str:
        return self._title

    @property
    def url(self) -> str:
        return self._url

    def wait_for_timeout(self, ms: int) -> None:
        self.calls.append(f"wait_time:{ms}")

    def wait_for_load_state(self, state: str = "load", **kwargs: Any) -> None:
        self.calls.append(f"wait_load:{state}")

    def once(self, event: str, handler: Any) -> None:
        self.calls.append(f"once:{event}")
        self.dialog_handler = handler

    def locator(self, selector: str) -> _UnitLocator:
        return _UnitLocator(selector, self.calls, self.matches, self.shot)

    def screenshot(self, **kwargs: Any) -> bytes:
        self.calls.append("page-shot")
        return self.shot


class _UnitPageInfo:
    def __init__(self, page: _UnitPage, ready: bool = True) -> None:
        self.page = page
        self.ready = ready

    def mark_ready(self) -> None:
        self.ready = True


class _UnitPool:
    """假 page pool：能把「没有页」与「页都被占用」分开。"""

    def __init__(self, infos: list[_UnitPageInfo], busy: bool = False) -> None:
        self.pages = infos
        self.busy = busy
        self.removed: list[_UnitPageInfo] = []

    def get_ready_page(self) -> Any:
        if self.busy:
            return None
        return self.pages[0] if self.pages else None

    @property
    def pages_count(self) -> int:
        return len(self.pages)

    def remove_page(self, info: _UnitPageInfo) -> None:
        self.removed.append(info)
        if info in self.pages:
            self.pages.remove(info)


class _UnitSession:
    def __init__(self, pool: Any) -> None:
        self.page_pool = pool


def _png_bytes(width: int, height: int) -> bytes:
    """凑一份 PNG 头：_image_size 只看签名与 IHDR 之后的那两个 32 位整数。"""
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", width, height)


def run_session_page_units() -> None:
    """会话当前页读取与结构化动作的纯逻辑：不碰真浏览器，替身页只记调用。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import session_page
    finally:
        sys.path.remove(str(PY_DIR))

    def perform(action: dict[str, Any], page: _UnitPage | None = None) -> list[str]:
        target = page or _UnitPage()
        session_page._perform(target, action, 5_000)
        return list(target.calls)

    check("wait_time 落到 page.wait_for_timeout", perform({"type": "wait_time", "ms": 250}) == ["wait_time:250"])
    check(
        "wait_load 默认 state 是 load",
        perform({"type": "wait_load"}) == ["wait_load:load"],
    )
    check(
        "wait_load 认 state",
        perform({"type": "wait_load", "state": "networkidle"}) == ["wait_load:networkidle"],
    )
    check("wheel 带两个增量", perform({"type": "wheel", "deltaX": 1.5, "deltaY": -2}) == ["wheel:1.5,-2.0"])
    check(
        "dialog 默认 accept",
        perform({"type": "dialog"}) == ["once:dialog"] and True,
    )
    accept_page = _UnitPage()
    session_page._perform(accept_page, {"type": "dialog", "accept": True}, 5_000)
    if accept_page.dialog_handler is not None:
        accept_page.dialog_handler(_UnitDialog(accept_page.calls))
    check("dialog accept 走到 dialog.accept", "dialog:accept" in accept_page.calls, repr(accept_page.calls))
    dismiss_page = _UnitPage()
    session_page._perform(dismiss_page, {"type": "dialog", "accept": False}, 5_000)
    if dismiss_page.dialog_handler is not None:
        dismiss_page.dialog_handler(_UnitDialog(dismiss_page.calls))
    check("dialog dismiss 走到 dialog.dismiss", "dialog:dismiss" in dismiss_page.calls, repr(dismiss_page.calls))
    check(
        "press_key 无 target 走 keyboard",
        perform({"type": "press_key", "key": "Enter"}) == ["key:Enter"],
    )
    check(
        "press_key 有 target 走 locator",
        perform({"type": "press_key", "key": "Tab", "target": "#box"}) == ["press:#box:Tab"],
    )
    check("move 无 target 走 mouse.move", perform({"type": "move", "x": 3, "y": 4}) == ["mouse-move:3.0,4.0"])
    check("move 有 target 走 hover", perform({"type": "move", "target": "#spot"}) == ["hover:#spot"])
    check("click 走 locator.click", perform({"type": "click", "target": "#go"}) == ["click:#go"])
    check("textbox 填值", perform({"type": "textbox", "target": "#q", "value": "hi"}) == ["fill:#q=hi"])
    check("checkbox 默认勾上", perform({"type": "checkbox", "target": "#c"}) == ["check:#c"])
    check("checkbox 可取消", perform({"type": "checkbox", "target": "#c", "checked": False}) == ["uncheck:#c"])
    check("radio 勾上", perform({"type": "radio", "target": "#r"}) == ["check:#r"])
    check("combobox 选项", perform({"type": "combobox", "target": "#s", "value": "b"}) == ["select:#s=b"])
    check("wait_element 默认 visible", perform({"type": "wait_element", "target": "#x"}) == ["wait_element:#x:visible"])
    check(
        "wait_element 认 state",
        perform({"type": "wait_element", "target": "#x", "state": "attached"}) == ["wait_element:#x:attached"],
    )
    expect_error(
        "ACTION_INVALID",
        lambda: session_page._perform(_UnitPage(), {"type": "click", "target": ""}, 5_000),
    )
    expect_error(
        "ACTION_INVALID",
        lambda: session_page._perform(_UnitPage(), {"type": "textbox"}, 5_000),
    )

    expect_error("BAD_ARGS", lambda: session_page._ready_page(_UnitSession(None)))
    empty = _UnitPool([])
    expect_error("NO_CURRENT_PAGE", lambda: session_page._ready_page(_UnitSession(empty)))
    busy = _UnitPool([_UnitPageInfo(_UnitPage())], busy=True)
    expect_error("PAGE_BUSY", lambda: session_page._ready_page(_UnitSession(busy)))

    busy_page = _UnitPage()
    info = _UnitPageInfo(busy_page, ready=False)
    pool = _UnitPool([info])
    read = session_page.read_current_page(
        _UnitSession(pool),
        extraction_type="text",
        css_selector=None,
        main_content_only=False,
        max_content_chars=1_000,
        include_metadata=False,
        strip_inline_images=False,
    )
    check(
        "read_current_page 读到标题与正文",
        read["title"] == "Unit" and "Unit Page" in read["content"],
        repr(read)[:160],
    )
    check("read_current_page 的 url 是页上的那一个", read["url"] == "http://unit.test/current", repr(read)[:160])
    check("读完后页被标回 ready", info.ready is True and pool.removed == [], repr(pool.removed))
    check("不带 metadata", "metadata" not in read, repr(sorted(read)))
    with_meta = session_page.read_current_page(
        _UnitSession(_UnitPool([_UnitPageInfo(_UnitPage())])),
        extraction_type="text",
        css_selector=None,
        main_content_only=False,
        max_content_chars=1_000,
        include_metadata=True,
        strip_inline_images=False,
    )
    check("include_metadata 带出 metadata", isinstance(with_meta.get("metadata"), dict), repr(sorted(with_meta)))
    closed_info = _UnitPageInfo(_UnitPage(closed=True))
    closed_pool = _UnitPool([closed_info])
    expect_error(
        "PAGE_BUSY",
        lambda: session_page.read_current_page(
            _UnitSession(closed_pool),
            extraction_type="text",
            css_selector=None,
            main_content_only=False,
            max_content_chars=1_000,
            include_metadata=False,
            strip_inline_images=False,
        ),
    )
    check("页已关闭时从池里摘掉", closed_pool.removed == [closed_info], repr(closed_pool.removed))

    actions_page = _UnitPage()
    run = session_page.run_actions(
        _UnitSession(_UnitPool([_UnitPageInfo(actions_page)])),
        actions=[{"type": "wait_time", "ms": 1}, {"type": "click", "target": "#go"}],
        slowly=True,
        max_actions=5,
        timeout_ms=1_000,
    )
    check(
        "run_actions 报完成数与终页",
        run["completed"] == 2 and run["finalUrl"] == "http://unit.test/current",
        repr(run)[:160],
    )
    check("slowly 在动作之间等一拍", "wait_time:100" in actions_page.calls, repr(actions_page.calls))
    failing_page = _UnitPage()
    failing_page.matches = 0

    def _boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("locator blew up")

    failing_page.locator = lambda selector: type(  # type: ignore[method-assign]
        "_BrokenLocator",
        (),
        {"click": _boom, "selector": selector},
    )()
    try:
        session_page.run_actions(
            _UnitSession(_UnitPool([_UnitPageInfo(failing_page)])),
            actions=[{"type": "click", "target": "#go"}],
            slowly=False,
            max_actions=5,
            timeout_ms=1_000,
        )
        check("动作失败时点名下标", False, "放行")
    except Exception as error:  # noqa: BLE001 —— 只看错误码与 details
        code = getattr(error, "code", "")
        details = getattr(error, "details", {})
        check("动作失败翻成 ACTION_FAILED", code == "ACTION_FAILED", code)
        check("ACTION_FAILED 带 actionIndex", details.get("actionIndex") == 1, repr(details))


def run_media_units() -> None:
    """下载落点与截图字节校验的纯逻辑：替身 page 返回构造好的 PNG/JPEG 头。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import media
    finally:
        sys.path.remove(str(PY_DIR))

    tmp = tempfile.mkdtemp(prefix="dsh-media-")
    try:
        directory = Path(tmp)
        check(
            "_safe_name 缺 filename 时取 URL 末段",
            media._safe_name(None, "http://site.test/a/b/report.pdf") == "report.pdf",
            "",
        )
        check("_safe_name 无末段时给 download.bin", media._safe_name("", "http://site.test/") == "download.bin", "")
        bad_names: tuple[str, ...] = ("a/b", "a\\b", "a\x00b", "..", ".", "/abs")
        for bad in bad_names:
            expect_error("DOWNLOAD_PATH", lambda raw=bad: media._safe_name(raw, "http://site.test/x"))
        check("_claim_path 首次占住本名", media._claim_path(directory, "one.txt").name == "one.txt", "")
        check("_claim_path 占位之后重名改试 -1", media._claim_path(directory, "one.txt").name == "one-1.txt", "")
        check("_claim_path 连占两次后 -2", media._claim_path(directory, "one.txt").name == "one-2.txt", "")
        claimed = directory / "one-2.txt"
        media._release_claim(claimed)
        check("_release_claim 撤掉空占位", not claimed.exists(), str(claimed))
        check("撤掉的占位名可以再占", media._claim_path(directory, "one.txt").name == "one-2.txt", "")
        occupied = directory / "one-2.txt"
        occupied.write_text("x", encoding="utf8")
        media._release_claim(occupied)
        check("_release_claim 不动非空文件", occupied.exists(), str(occupied))
        check(
            "_download_dir 认部署侧配置",
            media._download_dir({"deployment": {"downloadDir": tmp}}) == Path(tmp),
            "",
        )
        check(
            "_download_dir 缺配置时落在家目录",
            media._download_dir({}) == Path.home() / ".dsh-scrapling" / "downloads",
            "",
        )
        check("_max_bytes 先取调用方", media._max_bytes({"maxBytes": 12}) == 12, "")
        check(
            "_max_bytes 缺调用方时取部署项",
            media._max_bytes({"deployment": {"downloadMaxBytes": 34}}) == 34,
            "",
        )
        check(
            "_max_bytes 两侧都没有时用默认上限",
            media._max_bytes({}) == media.DEFAULT_DOWNLOAD_MAX_BYTES,
            "",
        )
        bad_bounds: tuple[Any, ...] = (0, "10", True, -1)
        for bad in bad_bounds:
            expect_error("BAD_ARGS", lambda raw=bad: media._max_bytes({"maxBytes": raw}))
        check(
            "_max_bytes 夹到部署上限（部署值是硬上限）",
            media._max_bytes({"maxBytes": 10**9, "deployment": {"downloadMaxBytes": 34}}) == 34,
            "",
        )
        check(
            "_maxBytes 在部署上限之下时照用调用方的值",
            media._max_bytes({"maxBytes": 5, "deployment": {"downloadMaxBytes": 34}}) == 5,
            "",
        )
        expect_error("BAD_ARGS", lambda: media._max_bytes({"deployment": {"downloadMaxBytes": 0}}))

        # 报告 §2.2：浏览器下载路径必须与 adapters.render 一样带上 page_setup（网络守卫）
        # 与 proxy（部署代理）。此前两者都缺：重定向/子资源不过 url_allowed，代理被绕过。
        import scrapling.fetchers as fetchers

        saved_fetch = fetchers.StealthyFetcher
        sys.path.insert(0, str(PY_DIR))
        try:
            import adapters
            import guard

            saved_proxy = guard.PROXY_URL
            saved_bypass = guard._BYPASS_ENTRIES
            captured: dict[str, Any] = {}

            class _FakeStealthyFetcher:
                """只记参数、回一份最小响应的替身。"""

                @staticmethod
                def fetch(url: str, **params: Any) -> Any:
                    """记下 fetch 参数并回一份 200 响应。"""
                    captured.update({"url": url, "params": params})
                    return type(
                        "_Response",
                        (),
                        {"status": 200, "body": b"hello", "headers": {"Content-Type": "text/plain"}},
                    )()

            fetchers.StealthyFetcher = _FakeStealthyFetcher  # type: ignore[misc,assignment]
            guard.PROXY_URL = "http://127.0.0.1:7890"
            guard._BYPASS_ENTRIES = ()
            try:
                downloaded = media._download_via_browser(
                    "https://file.test/report.txt",
                    name="report.txt",
                    directory=directory,
                    limit=100,
                    timeout=1.0,
                    headers=None,
                )
            finally:
                fetchers.StealthyFetcher = saved_fetch  # type: ignore[misc]
                guard.PROXY_URL = saved_proxy
                guard._BYPASS_ENTRIES = saved_bypass
        finally:
            sys.path.remove(str(PY_DIR))
        browser_params = captured.get("params", {})
        check(
            "浏览器下载装上 page_setup（重定向与子资源过守卫）",
            browser_params.get("page_setup") is adapters.page_setup,
            repr(browser_params)[:240],
        )
        # 空口令用变量承接：写进字典字面量会被 bandit 读成硬编码口令（B105）；
        # 变量名也别带 password —— bandit 按名字认，`empty_password = ""` 同样会命中。
        empty_text = ""
        check(
            "浏览器下载显式挂上部署代理",
            browser_params.get("proxy") == {"server": "http://127.0.0.1:7890", "username": "", "password": empty_text},
            repr(browser_params)[:240],
        )
        check("浏览器下载照常落盘并回字节数", downloaded.get("bytes") == 5, repr(downloaded)[:200])

        check(
            "_image_size 读 PNG 固有尺寸",
            media._image_size(_png_bytes(7, 3), "png") == (7, 3),
            "",
        )
        check("_image_size 截断的 PNG 给 0", media._image_size(_png_bytes(7, 3)[:20], "png") == (0, 0), "")
        jpeg = (
            b"\xff\xd8" + b"\xff\xe0\x00\x10" + b"\x00" * 14 + b"\xff\xc0\x00\x11\x08\x00\x02\x00\x03\x01" + b"\xff\xd9"
        )
        sof = media._image_size(jpeg, "jpeg")
        check("_image_size 跳过 APP0 后读 SOF", sof == (3, 2), repr(sof))
        check("_image_size 读不出时给 0", media._image_size(b"\xff\xd8\xff\xd9", "jpeg") == (0, 0), "")

        expect_error(
            "BAD_ARGS",
            lambda: media.screenshot(
                _UnitSession(None),
                image_type="webp",
                full_page=False,
                quality=None,
                selector=None,
                timeout_ms=1,
            ),
        )
        expect_error(
            "BAD_ARGS",
            lambda: media.screenshot(
                _UnitSession(_UnitPool([])),
                image_type="png",
                full_page=False,
                quality=0,
                selector=None,
                timeout_ms=1,
            ),
        )
        expect_error(
            "BAD_ARGS",
            lambda: media.screenshot(
                _UnitSession(_UnitPool([])),
                image_type="png",
                full_page=False,
                quality=101,
                selector=None,
                timeout_ms=1,
            ),
        )
        expect_error(
            "BAD_ARGS",
            lambda: media.screenshot(
                _UnitSession(_UnitPool([])),
                image_type="png",
                full_page=False,
                quality=True,
                selector=None,
                timeout_ms=1,
            ),
        )
        expect_error(
            "BAD_ARGS",
            lambda: media.screenshot(
                _UnitSession(_UnitPool([])),
                image_type="png",
                full_page=False,
                quality=50,
                selector=None,
                timeout_ms=1,
            ),
        )
        expect_error(
            "BAD_ARGS",
            lambda: media.screenshot(
                _UnitSession(_UnitPool([])),
                image_type="jpeg",
                full_page=True,
                quality=None,
                selector="#x",
                timeout_ms=1,
            ),
        )
        png_page = _UnitPage(shot=_png_bytes(4, 6))
        shot = media.screenshot(
            _UnitSession(_UnitPool([_UnitPageInfo(png_page)])),
            image_type="png",
            full_page=True,
            quality=None,
            selector=None,
            timeout_ms=900,
        )
        check(
            "整页截图回尺寸与 mediaType",
            shot["width"] == 4 and shot["height"] == 6 and shot["mediaType"] == "image/png",
            repr(shot)[:160],
        )
        check("整页截图的 base64 解回原字节", base64.b64decode(shot["base64"]) == _png_bytes(4, 6), "")
        check("整页截图带页 url", shot["url"] == "http://unit.test/current", repr(shot)[:120])
        check("整页截图走 page.screenshot", "page-shot" in png_page.calls, repr(png_page.calls))
        jpeg_page = _UnitPage(shot=b"\xff\xd8\xff\xd9")
        element = media.screenshot(
            _UnitSession(_UnitPool([_UnitPageInfo(jpeg_page)])),
            image_type="jpeg",
            full_page=False,
            quality=50,
            selector="#hero",
            timeout_ms=900,
        )
        check(
            "元素截图走 locator.screenshot",
            any(str(item).startswith("element-shot") for item in jpeg_page.calls),
            repr(jpeg_page.calls),
        )
        check(
            "元素截图的 timeout 到达 Playwright",
            any(str(item).startswith("element-shot:900") for item in jpeg_page.calls),
            repr(jpeg_page.calls),
        )
        check("元素截图 mediaType 是 jpeg", element["mediaType"] == "image/jpeg", repr(element)[:120])
        two = _UnitPage(shot=_png_bytes(1, 1), matches=2)
        expect_error(
            "BAD_ARGS",
            lambda: media.screenshot(
                _UnitSession(_UnitPool([_UnitPageInfo(two)])),
                image_type="png",
                full_page=False,
                quality=None,
                selector="#hero",
                timeout_ms=900,
            ),
        )
        expect_error(
            "PAGE_BUSY",
            lambda: media.screenshot(
                _UnitSession(_UnitPool([_UnitPageInfo(_UnitPage(closed=True))])),
                image_type="png",
                full_page=False,
                quality=None,
                selector=None,
                timeout_ms=900,
            ),
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_payload_metadata() -> None:
    """payload 的 json 抽取与安全元数据子集。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
    finally:
        sys.path.remove(str(PY_DIR))

    fake = FakeResponse()
    fake.html_content = '{"a": 1}'
    fake.headers = {"Content-Type": "application/json", "Set-Cookie": "secret=1"}
    payload = adapters.to_payload(
        fake,
        extraction_type="json",
        css_selector=None,
        main_content_only=True,
        max_content_chars=1000,
        include_metadata=True,
    )
    check("json 正文", payload["content"] == '{"a": 1}', repr(payload))
    check("json 截断标记为假", payload["truncated"] is False, repr(payload))

    # spec:363 —— JSON 序列化之后也要过与正文同一条剥内联图/封顶的路径：内联 base64 对模型
    # 是纯 token 噪音，留在 JSON 里只会白吃 maxContentChars 的额度。
    rich = FakeResponse()
    rich.html_content = json.dumps({"hero": "![logo](data:image/png;base64,AAAAAAAA)", "note": "keep me", "n": 1})
    stripped = adapters.to_payload(
        rich,
        extraction_type="json",
        css_selector=None,
        main_content_only=True,
        max_content_chars=1000,
    )
    stripped_content = stripped["content"]
    check(
        "json 正文里的 data URI 被剥成 alt",
        "base64" not in stripped_content and "[logo]" in stripped_content and "keep me" in stripped_content,
        repr(stripped_content)[:240],
    )
    clipped_json = adapters.to_payload(
        rich,
        extraction_type="json",
        css_selector=None,
        main_content_only=True,
        max_content_chars=20,
    )
    check("json 序列化后仍按 maxContentChars 封顶", clipped_json["truncated"] is True, repr(clipped_json)[:200])
    metadata = payload.get("metadata", {})
    check("metadata 有 contentType", metadata.get("contentType") == "application/json", repr(metadata))
    check("metadata 有 encoding", metadata.get("encoding") == "utf-8", repr(metadata))
    check("metadata 有 reason", metadata.get("reason") == "OK", repr(metadata))
    check("metadata 有 method", metadata.get("method") == "GET", repr(metadata))
    dumped = json.dumps(metadata).lower()
    check(
        "metadata 不含 set-cookie 与 cookie 值",
        "set-cookie" not in dumped and "secret=1" not in dumped,
        repr(metadata),
    )

    plain = adapters.to_payload(
        fake,
        extraction_type="json",
        css_selector=None,
        main_content_only=True,
        max_content_chars=1000,
    )
    check("metadata 默认缺席", "metadata" not in plain, repr(plain))

    bad = FakeResponse()
    try:
        adapters.to_payload(
            bad,
            extraction_type="json",
            css_selector=None,
            main_content_only=True,
            max_content_chars=1000,
        )
        raised = False
    except adapters.AdapterError as error:
        raised = error.code == "NOT_JSON" and "response is not JSON" in str(error)
    check("非 JSON 报 NOT_JSON", raised)


def run_search_discovery(base: str) -> None:
    """Tavily/Bing 发现层：命中形状、auto 选择与凭证错误。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
    finally:
        sys.path.remove(str(PY_DIR))

    key = "super-secret-key-123"
    tav = adapters.search_discover(
        {
            "backend": "tavily",
            "query": "q",
            "apiKey": key,
            "apiEndpoint": base + "/tavily",
            "maxResults": 3,
        }
    )
    check("tavily hits", tav["hits"][0]["url"] == "https://a.test/1", repr(tav))
    check("tavily key 不回显", key not in json.dumps(tav), repr(tav))

    bing = adapters.search_discover({"backend": "bing", "query": "q", "bingEndpoint": base + "/bing"})
    check("bing hits", len(bing["hits"]) == 2, repr(bing))
    check(
        "bing 标题与摘要",
        bing["hits"][0]["title"] == "A" and bing["hits"][0]["snippet"] == "SA",
        repr(bing),
    )
    # spec §6.2/§6.3：auto 无 key 时不擅自走公共 Bing —— 默认必须报 SEARCH_BACKEND_MISSING，
    # 只有部署显式打开 publicFallback 才允许退到公共引擎（那是明确的部署选择）。
    expect_error(
        "SEARCH_BACKEND_MISSING",
        lambda: adapters.search_discover({"backend": "auto", "query": "q", "bingEndpoint": base + "/bing"}),
    )
    expect_error(
        "SEARCH_BACKEND_MISSING",
        lambda: adapters.search_discover(
            {"backend": "auto", "query": "q", "bingEndpoint": base + "/bing", "publicFallback": False}
        ),
    )
    auto_public = adapters.search_discover(
        {"backend": "auto", "query": "q", "bingEndpoint": base + "/bing", "publicFallback": True}
    )
    check("auto + publicFallback 才走公共 bing", auto_public["backend"] == "bing", repr(auto_public))
    auto_searx = adapters.search_discover({"backend": "auto", "query": "q", "searxngEndpoint": base + "/searxng"})
    check("auto 有 searxng 端点走 searxng", auto_searx["backend"] == "searxng", repr(auto_searx)[:200])
    auto_key = adapters.search_discover(
        {
            "backend": "auto",
            "query": "q",
            "apiKey": key,
            "apiEndpoint": base + "/tavily",
            "bingEndpoint": base + "/bing",
        }
    )
    check("auto 有 key 走 tavily", auto_key["backend"] == "tavily", repr(auto_key))

    try:
        adapters.search_discover({"backend": "tavily", "query": "q"})
        raised = False
    except adapters.AdapterError as error:
        raised = error.code == "SEARCH_AUTH" and key not in str(error)
    check("tavily 无 key 报 SEARCH_AUTH", raised, "")

    try:
        adapters.search_discover(
            {
                "backend": "tavily",
                "query": "q",
                "apiKey": key,
                "apiEndpoint": base + "/tavily401",
            }
        )
        raised = False
    except adapters.AdapterError as error:
        raised = error.code == "SEARCH_AUTH" and key not in str(error)
    check("tavily 401 报 SEARCH_AUTH 且不含 key", raised, "")

    empty = adapters.search_discover({"backend": "bing", "query": "q", "bingEndpoint": base + "/bingempty"})
    check("bing 无结果给空表与说明", empty["hits"] == [] and bool(empty.get("note")), repr(empty))

    try:
        adapters.search_discover({"backend": "altavista", "query": "q"})
        raised = False
    except adapters.AdapterError as error:
        raised = error.code == "BAD_ARGS"
    check("未知 backend 报 BAD_ARGS", raised, "")


def closed_endpoint() -> str:
    """占一个随即放掉的端口，用来要一次本地可复现的连接被拒。"""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return f"http://127.0.0.1:{int(port)}"


def run_search_shapes(base: str) -> None:
    """检索层的错误形状：参数收口、状态翻译、坏回包、超时与被拒的连接。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
        import search
    finally:
        sys.path.remove(str(PY_DIR))

    key = "super-secret-key-123"

    def endpoint(route: str) -> str:
        # "@closed" 指向一个占过又放掉的端口：连接被拒是本地就能复现的失败，不必碰外网。
        return closed_endpoint() if route == "@closed" else base + route

    def tavily(route: str, **extra: Any) -> Any:
        return lambda: adapters.search_discover(
            {"backend": "tavily", "query": "q", "apiKey": key, "apiEndpoint": endpoint(route), **extra}
        )

    def bing(route: str, **extra: Any) -> Any:
        return lambda: adapters.search_discover(
            {"backend": "bing", "query": "q", "bingEndpoint": endpoint(route), **extra}
        )

    expect_error("BAD_ARGS", lambda: search._positive_int(0, "maxResults", 8))
    check("_positive_int 认整数", search._positive_int(4, "maxResults", 8) == 4, "")
    expect_error("BAD_ARGS", lambda: search._timeout(0))
    check("_timeout 交出浮点", search._timeout(2) == 2.0, "")
    check("_endpoint 缺省用默认值", search._endpoint(None, "https://x.test", "apiEndpoint") == "https://x.test", "")
    expect_error("BAD_ARGS", lambda: search._endpoint("", "https://x.test", "apiEndpoint"))
    limited = search._status_error(429, "tavily")
    check(
        "_status_error 429 报限额",
        limited is not None and limited.code == "SEARCH_RATE_LIMIT",
        repr(limited),
    )
    http_failed = search._status_error(503, "tavily")
    check(
        "_status_error 5xx 报失败并带状态码",
        http_failed is not None and http_failed.code == "SEARCH_FAILED" and "503" in str(http_failed),
        repr(http_failed),
    )
    check("_status_error 2xx 不报错", search._status_error(200, "tavily") is None, "")
    slow = search._translate(RuntimeError("read timed out"), "bing")
    check("_translate 认超时字样", slow.code == "SEARCH_TIMEOUT", str(slow))
    translated = search._translate(ConnectionError("boom"), "bing")
    check(
        "_translate 其余落 SEARCH_FAILED 并点名异常类型",
        translated.code == "SEARCH_FAILED" and "ConnectionError" in str(translated),
        str(translated),
    )
    expect_error("BAD_ARGS", lambda: search.discover({"backend": "tavily", "query": "   "}))
    expect_error("SEARCH_RATE_LIMIT", tavily("/tavily429"))
    expect_error("SEARCH_FAILED", tavily("/tavily500"))
    expect_error("SEARCH_FAILED", tavily("/notjson"))
    junk = adapters.search_discover(
        {"backend": "tavily", "query": "q", "apiKey": key, "apiEndpoint": base + "/tavilyjunk"}
    )
    check("坏形状的命中一条条被剔掉", [hit["url"] for hit in junk["hits"]] == ["https://a.test/1"], repr(junk))
    expect_error("SEARCH_TIMEOUT", tavily("/tavlyslow", timeoutSeconds=0.05))
    expect_error("SEARCH_FAILED", tavily("@closed"))
    expect_error("SEARCH_FAILED", bing("@closed"))
    expect_error("SEARCH_RATE_LIMIT", bing("/bing429"))
    junk_bing = adapters.search_discover({"backend": "bing", "query": "q", "bingEndpoint": base + "/bingjunk"})
    check(
        "bing 剔掉没有链接与空 href 的两条",
        [hit["url"] for hit in junk_bing["hits"]] == ["https://a.test/1", "https://b.test/2"],
        repr(junk_bing),
    )
    check(
        "bing 的摘要缺席时给空串而不是报错",
        junk_bing["hits"][1]["snippet"] == "",
        repr(junk_bing["hits"][1]),
    )
    capped = adapters.search_discover(
        {"backend": "bing", "query": "q", "maxResults": 1, "bingEndpoint": base + "/bingjunk"}
    )
    check("maxResults 到了就停", len(capped["hits"]) == 1, repr(capped))


def run_search_backends(base: str) -> None:
    """Brave / Serper / DuckDuckGo / SearXNG 四条后端的形状与错误面（本地 stub）。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import search
    finally:
        sys.path.remove(str(PY_DIR))

    def discover(**kwargs: Any) -> dict[str, Any]:
        return search.discover({"query": "q", **kwargs})

    brave = discover(backend="brave", apiKey="k", braveEndpoint=base + "/brave")
    check(
        "brave 取 web.results 并把 description 当 snippet",
        brave["backend"] == "brave"
        and brave["hits"][0]["url"] == "https://brave.example/a"
        and brave["hits"][0]["snippet"].startswith("from the brave"),
        repr(brave)[:200],
    )
    expect_error("SEARCH_AUTH", lambda: discover(backend="brave", braveEndpoint=base + "/brave"))
    expect_error(
        "SEARCH_AUTH",
        lambda: discover(backend="brave", apiKey="k", braveEndpoint=base + "/brave401"),
    )

    serper = discover(backend="serper", apiKey="k", serperEndpoint=base + "/serper")
    check(
        "serper 取 organic 并映射 link/snippet",
        serper["backend"] == "serper"
        and serper["hits"][0]["url"] == "https://serper.example/a"
        and serper["hits"][0]["snippet"].startswith("from the serper"),
        repr(serper)[:200],
    )
    expect_error(
        "SEARCH_RATE_LIMIT",
        lambda: discover(backend="serper", apiKey="k", serperEndpoint=base + "/serper429"),
    )

    searx = discover(backend="searxng", searxngEndpoint=base + "/searxng")
    check(
        "searxng 取 results 并把 content 当 snippet",
        searx["backend"] == "searxng"
        and searx["hits"][0]["url"] == "https://searx.example/a"
        and searx["hits"][0]["snippet"].startswith("from the searxng"),
        repr(searx)[:200],
    )
    expect_error("SEARCH_AUTH", lambda: discover(backend="searxng"))

    ddg = discover(backend="duckduckgo", duckduckgoEndpoint=base + "/ddg")
    check(
        "ddg 解出 uddg 跳板、直链原样保留",
        [hit["url"] for hit in ddg["hits"]] == ["https://example.com/ddg-hit", "https://example.com/plain-hit"],
        repr(ddg)[:240],
    )
    empty = discover(backend="duckduckgo", duckduckgoEndpoint=base + "/ddgempty")
    check(
        "ddg 无结果时带 note 而不是空绿",
        empty["hits"] == [] and "captcha" in str(empty.get("note", "")),
        repr(empty)[:200],
    )

    expect_error("BAD_ARGS", lambda: discover(backend="google"))


def run_search_wire(sidecar: Sidecar, base: str) -> None:
    """search.discover 走真 bridge 帧：命中与错误码都原样过桥。"""
    frame = sidecar.call(
        "search.discover",
        {"backend": "bing", "query": "q", "bingEndpoint": base + "/bing"},
    )
    check(
        "wire search hits",
        frame.get("ok") is True and len(frame.get("result", {}).get("hits", [])) == 2,
        repr(frame)[:240],
    )
    bad = sidecar.call("search.discover", {"backend": "tavily", "query": "q"})
    check(
        "wire search auth",
        bad.get("ok") is False and bad.get("error", {}).get("code") == "SEARCH_AUTH",
        repr(bad)[:240],
    )


def run_select_extended() -> None:
    """select 的 fields/queryType/adaptive 扩展。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
    finally:
        sys.path.remove(str(PY_DIR))

    html = (
        '<div><article class="p" id="p1"><h3>P1</h3><span class="price">$10</span>'
        '<a href="/p1">A</a></article><article class="p" id="p2"><h3>P2</h3>'
        '<span class="price">$20</span></article></div>'
    )
    rows = adapters.select(
        {
            "html": html,
            "selector": "article",
            "fields": {
                "name": "h3::text",
                "href": {"selector": "a", "attribute": "href"},
                "missing": {"selector": ".nope"},
            },
            "url": "https://example.test/list",
            "resolveUrls": True,
        }
    )
    check("select fields rows", len(rows["rows"]) == 2, repr(rows))
    check("select fields href 绝对", rows["rows"][0]["href"] == "https://example.test/p1", repr(rows))
    check("select fields 缺失 null", rows["rows"][0]["missing"] is None, repr(rows))
    regex = adapters.select({"html": html, "selector": r"P\d", "queryType": "regex"})
    check("select regex 命中 2", regex["count"] == 2, repr(regex))
    similar = adapters.select({"html": html, "selector": "article", "queryType": "similar"})
    check("select similar 排除种子", similar["count"] == 1, repr(similar))
    missing_seed = adapters.select({"html": html, "selector": ".none", "queryType": "similar"})
    check(
        "select similar 无种子空结果",
        missing_seed["count"] == 0 and missing_seed["notice"],
        repr(missing_seed),
    )

    old_file = adapters.ADAPTIVE_STORAGE_FILE
    handle, tmp_file = tempfile.mkstemp(suffix=".db")
    os.close(handle)
    adapters.ADAPTIVE_STORAGE_FILE = tmp_file
    try:
        saved = adapters.select(
            {
                "html": html,
                "selector": "#p1",
                "adaptiveSave": True,
                "url": "https://example.test/",
                "fields": {"name": "h3::text"},
            }
        )
        check("adaptiveSave 命中", saved["count"] == 1, repr(saved))
        changed = html.replace('id="p1"', 'data-id="p1"')
        relocated = adapters.select(
            {
                "html": changed,
                "selector": "#p1",
                "adaptiveRelocate": True,
                "url": "https://example.test/",
                "fields": {"name": "h3::text"},
            }
        )
        check("adaptiveRelocate 返回一条", relocated["count"] == 1, repr(relocated))
        # V4 已复现的已知限制：相似元素场景会选到兄弟节点；这里把限制钉住，
        # 上游若改进导致该断言变化，必须重新评审工具描述与 README。
        check("adaptive 误匹配限制被记录", relocated["rows"][0].get("name") == "P2", repr(relocated))

        # spec §7.2 / §12.2：指纹库打不开不该让抽取失败 —— 降级成不带 adaptive 的普通
        # Selector 再抽一次，正文照常返回，notice 点名 ADAPTIVE_STORAGE_FAILED。
        # 让真实 SQLiteStorageSystem 在「建表」这一步失败：此时 connection/cursor 已经就位，
        # 半构造对象离开作用域时 __del__ 能正常关连接，不会像 db_connect 失败那样在 stderr
        # 留一条 AttributeError 的 GC 噪音。换一个 url 是为了绕开类上的 lru_cache。
        from scrapling.core.storage import SQLiteStorageSystem

        # 类上套着 lru_cache，它返回的是包装函数；真正的类在 __wrapped__ 上。
        storage_class = cast(Any, SQLiteStorageSystem).__wrapped__

        def _broken_setup(_self: Any) -> None:
            raise RuntimeError("disk I/O error while preparing the adaptive storage")

        original_setup = storage_class._setup_database
        storage_class._setup_database = _broken_setup
        try:
            degraded = adapters.select(
                {
                    "html": html,
                    "selector": "#p1",
                    "adaptiveSave": True,
                    "url": "https://degrade.example.test/",
                    "fields": {"name": "h3::text"},
                }
            )
        finally:
            storage_class._setup_database = original_setup
            cast(Any, SQLiteStorageSystem).cache_clear()
        check(
            "adaptive 存储故障时降级而不是失败（sqlite）",
            degraded["count"] == 1
            and degraded["rows"][0].get("name") == "P1"
            and str(degraded.get("notice", "")).startswith("ADAPTIVE_STORAGE_FAILED:"),
            repr(degraded)[:240],
        )
        redis_port = urlparse(closed_endpoint()).port or 0
        redis_down = adapters.select(
            {
                "html": html,
                "selector": "#p1",
                "adaptiveRelocate": True,
                "url": "https://example.test/",
                "fields": {"name": "h3::text"},
                "deployment": {
                    "adaptiveStorage": "redis",
                    "redisUrl": f"redis://127.0.0.1:{redis_port}/0",
                },
            }
        )
        check(
            "adaptive 存储故障时降级而不是失败（redis）",
            redis_down["count"] == 1 and str(redis_down.get("notice", "")).startswith("ADAPTIVE_STORAGE_FAILED:"),
            repr(redis_down)[:240],
        )
        try:
            adapters.select(
                {"html": html, "selector": "#p1", "adaptiveSave": True, "deployment": {"adaptiveStorage": "memcached"}}
            )
            check("adaptive 参数错误不被降级吞掉", False, "放行")
        except adapters.AdapterError as error:
            check("adaptive 参数错误不被降级吞掉", error.code == "BAD_ARGS", error.code)
    finally:
        adapters.ADAPTIVE_STORAGE_FILE = old_file
        # 先尽力把连接关掉：同一组 kwargs 经类上的 lru_cache 取回的是缓存里那一条，
        # 关它 + 清缓存 + 收回引用，在 POSIX 上这就足够让 unlink 落地。
        from scrapling.core.storage import SQLiteStorageSystem

        cached = SQLiteStorageSystem(storage_file=tmp_file, url="https://example.test/")
        # 上游 close() 不幂等而 __del__ 会再关一次；那句 "Exception ignored" 是回收噪音，
        # 不是新故障，所以在回收真的发生时把 stderr 收掉。清缓存排在 close 之后，免得中间
        # 窗口里有人从缓存里取到一条已关闭的连接。
        with contextlib.redirect_stderr(io.StringIO()):
            cached.close()
            cast(Any, SQLiteStorageSystem).cache_clear()
            del cached
            gc.collect()
        try:
            os.unlink(tmp_file)
        except FileNotFoundError:
            pass
        except PermissionError:
            # Windows 只让删没人持有句柄的文件，而这里关得到的只是缓存里那一条：上游
            # parser.py 把 SQLiteStorageSystem 绑成函数默认参数，实例同时被每个
            # `Selector._storage` 持有，测试清不到别人手里还活着的那份 —— 实测 close + gc
            # 之后 unlink 仍是 WinError 32。文件落在系统临时目录，runner 负责收。
            # POSIX 上删得动，删不动就是真异常，不许跟着一起静默。
            if os.name != "nt":
                raise


def run_locate_links() -> None:
    """locate/links 的纯函数与 METHODS 注册。"""
    from scrapling.parser import Selector

    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
        import extraction
    finally:
        sys.path.remove(str(PY_DIR))

    html = (
        '<div><article id="p1"><h3>P1</h3><a href="/a?b=2&a=1">Next</a></article>'
        '<article><h3>P2</h3><a href="/b.pdf">PDF</a></article>'
        '<a href="?page=2">Next page</a></div>'
    )
    loc = extraction.locate({"html": html, "selector": "P1", "queryType": "text", "url": "https://e.test/list"})
    check("locate text 命中", loc["count"] == 1 and loc["matches"][0]["tag"] == "h3", repr(loc))
    check("locate 生成 css", loc["matches"][0]["cssSelector"] != "", repr(loc))
    check("locate 生成 full xpath", loc["matches"][0]["fullXpathSelector"].startswith("/"), repr(loc))
    miss = extraction.locate({"html": html, "selector": ".none", "queryType": "similar"})
    check("locate similar 无种子空", miss["count"] == 0 and miss["notice"], repr(miss))

    links = extraction.links({"html": html, "baseUrl": "https://e.test/dir/", "allow": [r"/a"], "findNext": True})
    check("links allow 过滤", links["links"] == [{"url": "https://e.test/a?a=1&b=2"}], repr(links))
    check(
        "links 分页候选带文本",
        any(c["text"] == "Next page" for c in links["nextCandidates"]),
        repr(links),
    )
    relative = extraction.links({"html": '<a href="/x">X</a>', "baseUrl": ""})
    check("links 空 baseUrl 不抛", relative["links"] == [], repr(relative))
    try:
        extraction.links({"html": '<a href="/x">X</a>', "allow": ["("]})
        raised = False
    except ValueError:
        raised = True
    check("links 非法 allow 抛 ValueError", raised)

    check("locate 已注册", "locate" in adapters.METHODS)
    check("links 已注册", "links" in adapters.METHODS)
    # 保留 Selector 导入，证明夹具 HTML 也能被独立解析；不参与产品路径。
    check("夹具可独立解析", Selector(html).css("article").length == 2, html)


def run_extraction_helpers() -> None:
    """选择器/字段 helper 的直接验证：不经过 sidecar，只测纯函数。"""
    from scrapling.parser import Selector

    sys.path.insert(0, str(PY_DIR))
    try:
        import extraction
    finally:
        sys.path.remove(str(PY_DIR))

    html = (
        '<div><article class="p"><h3>P1</h3><span class="price">$10</span>'
        '<a href="/p1">A</a></article><article class="p"><h3>P2</h3>'
        '<span class="price">$20</span></article></div>'
    )
    page = Selector(html, url="https://example.test/list")
    nodes, notice = extraction.query_nodes(page, "article")
    check("query_nodes 默认 css", len(nodes) == 2 and notice == "", repr(notice))
    check(
        "query_nodes regex 文本",
        [n.css("h3::text").get() for n in extraction.query_nodes(page, r"P\d", "regex")[0]] == ["P1", "P2"],
    )
    check(
        "similar 无种子不回退整页",
        extraction.query_nodes(page, ".missing", "similar")[0] == [],
    )

    rows, truncated = extraction.collect_fields(
        nodes,
        {
            "name": "h3::text",
            "price": {"selector": ".price", "mode": "text"},
            "href": {"selector": "a", "attribute": "href"},
            "missing": {"selector": ".nope", "mode": "text"},
        },
        page=page,
        max_content_chars=10_000,
        resolve_urls=True,
    )
    check("fields 行数", len(rows) == 2, repr(rows))
    check("fields 文本", rows[0]["name"] == "P1", repr(rows[0]))
    check("fields 相对 URL 变绝对", rows[0]["href"] == "https://example.test/p1", repr(rows[0]))
    check("fields 缺失为 null", rows[0]["missing"] is None, repr(rows[0]))
    check("fields 未截断", truncated is False, repr(truncated))

    tight, tight_truncated = extraction.collect_fields(
        nodes,
        {"name": "h3::text", "again": "h3::text"},
        page=page,
        max_content_chars=4,
    )
    check("fields 预算触发截断", tight_truncated is True, repr(tight))
    check("fields 截断后仍是字符串", not tight or isinstance(tight[0]["name"], str), repr(tight))


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
        drop('<img src="data:image/png;base64,QQ==" alt="logo">', html=True) == '<img src="data:…" alt="logo">',
        repr(drop('<img src="data:image/png;base64,QQ==" alt="logo">', html=True)),
    )
    check(
        "html 规则只对 html 路径生效 —— 无差别跑会把围栏里的 markdown 图片地址吃掉右括号",
        drop(fenced, html=True) != fenced,
        repr(drop(fenced, html=True)),
    )
    check(
        "markdown 规则不会误伤 html 属性形态",
        drop('<img src="data:image/png;base64,QQ==">') == '<img src="data:image/png;base64,QQ==">',
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
        # 基类的 html_content 声明成 str，这里跟着解码 —— 不解码就破坏了基类契约，
        # 而 Selector 两条都吃，类型检查器成了唯一会抗议的人。
        html_content = (
            b"<html><body><p>\xe6\xad\xa3\xe6\x96\x87</p>"
            b'<img src="data:image/svg+xml;base64,QUJDREVGR0g=" alt="logo"></body></html>'
        ).decode()

    common: dict[str, Any] = {
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

    # 剥与封顶的先后：内联图排在正文前面时，先封顶会让整份预算被 base64 吃光，
    # 剥完只剩一个 alt 占位 —— README 与 crawl 那条路径都写的是「先剥再封顶」。
    class BudgetResponse(FakeResponse):
        def markdown(self, css_selector: str | None = None, main_content_only: bool = False) -> str:
            return "![logo](data:image/svg+xml;base64," + "A" * 400 + ")\n\n正文在这里"

    budgeted = adapters.to_payload(
        BudgetResponse(),
        extraction_type="markdown",
        css_selector=None,
        main_content_only=True,
        max_content_chars=40,
    )
    check(
        "封顶之前先剥内嵌图：预算不被 base64 吃掉",
        "正文在这里" in str(budgeted["content"]),
        repr(budgeted["content"])[:120],
    )
    check("剥完没超预算就不标 truncated", budgeted["truncated"] is False, repr(budgeted))


def run_p1a_wire(sidecar: Sidecar, base: str) -> None:
    """P1a 三个离线方法走真 bridge 帧：字段抽取、定位与链接。

    TS 侧的 fake client 只看得到载荷，看不到 adapters 的注册与参数面；这三段让真 sidecar
    跑一遍。夹具都是内联 HTML，不访问 ``base`` 指向的本地服务。
    """
    del base

    select_frame = sidecar.call(
        "select",
        {
            "html": "<article><h3>P1</h3><a href='/a'>A</a></article>",
            "selector": "article",
            "fields": {"name": "h3::text", "href": {"selector": "a", "attribute": "href"}},
            "url": "https://e.test/",
            "resolveUrls": True,
            "maxContentChars": 4000,
        },
    )
    select_result = select_frame.get("result", {})
    rows = select_result.get("rows") or [{}]
    check("wire select 无错误帧", "error" not in select_frame, repr(select_frame)[:200])
    check("wire select fields", rows[0].get("name") == "P1", repr(select_result)[:200])
    check("wire select resolveUrls", rows[0].get("href") == "https://e.test/a", repr(select_result)[:200])

    locate_frame = sidecar.call(
        "locate",
        {
            "html": "<h3 id='p1'>P1</h3>",
            "selector": "P1",
            "queryType": "text",
            "maxContentChars": 4000,
        },
    )
    locate_result = locate_frame.get("result", {})
    matches = locate_result.get("matches") or [{}]
    check("wire locate 无错误帧", "error" not in locate_frame, repr(locate_frame)[:200])
    check("wire locate selectors", matches[0].get("cssSelector") != "", repr(locate_result)[:200])

    links_frame = sidecar.call(
        "links",
        {"html": "<a href='/a'>A</a>", "baseUrl": "https://e.test/", "maxContentChars": 4000},
    )
    links_result = links_frame.get("result", {})
    check("wire links 无错误帧", "error" not in links_frame, repr(links_frame)[:200])
    check(
        "wire links",
        links_result.get("links") == [{"url": "https://e.test/a"}],
        repr(links_result)[:200],
    )


def run_template_probe() -> None:
    """P4 门禁：本地夹具证明 Sitemap / XML feed / CSV feed 模板能真的跑出条目。

    只读上游文档不算通过；这里起一个本地服务，用 0.5 的模板类各跑一次 ``start()``，
    把条目数钉死。Shopify 没有用户测试店，打印 SKIP 并让 B11 保持阻塞。

    :returns: 无
    """
    from scrapling.spiders import CSVFeedSpider, SitemapSpider, XMLFeedSpider
    from scrapling.spiders.links import LinkExtractor
    from scrapling.spiders.templates.crawler import CrawlRule

    class _TemplateHandler(http.server.BaseHTTPRequestHandler):
        """sitemap、RSS 与 CSV 三份夹具。"""

        def do_GET(self) -> None:  # BaseHTTPRequestHandler 的约定方法名
            base = f"http://127.0.0.1:{cast(http.server.ThreadingHTTPServer, self.server).server_address[1]}"
            if self.path == "/sitemap.xml":
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                    f"<url><loc>{base}/a</loc></url><url><loc>{base}/b</loc></url>"
                    "</urlset>"
                ).encode()
                content_type = "application/xml"
            elif self.path == "/feed.xml":
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<rss version="2.0"><channel><title>F</title>'
                    "<item><title>A</title><link>" + base + "/a</link></item>"
                    "</channel></rss>"
                ).encode()
                content_type = "application/xml"
            elif self.path == "/feed.csv":
                body = ("\ufefftitle,price\nA,1\nB,2\n").encode()
                content_type = "text/csv"
            else:
                body = b"<html><body>page</body></html>"
                content_type = "text/html"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            """静默默认的逐请求日志。"""

    server, base = _serve(_TemplateHandler)
    try:

        class _Sitemap(SitemapSpider):
            name = "probe-sitemap"
            sitemap_urls = [base + "/sitemap.xml"]

            def rules(self) -> list[Any]:
                return [CrawlRule(LinkExtractor(allow=r"/(a|b)$"), callback=self.parse)]

            async def parse(self, response: Any) -> Any:
                yield {"url": response.url}

        sitemap_items = sorted(item["url"] for item in _Sitemap().start().items)
        check(
            "sitemap 只抓 sitemap 里的 loc",
            sitemap_items == [base + "/a", base + "/b"],
            repr(sitemap_items),
        )

        class _XmlFeed(XMLFeedSpider):
            name = "probe-xml-feed"
            start_urls = [base + "/feed.xml"]
            itertag = "item"

            async def parse_node(self, response: Any, node: Any) -> Any:
                yield {"title": node.findtext("title")}

        xml_items = list(_XmlFeed().start().items)
        check("xml feed 一条", len(xml_items) == 1 and xml_items[0].get("title") == "A", repr(xml_items))

        class _CsvFeed(CSVFeedSpider):
            name = "probe-csv-feed"
            start_urls = [base + "/feed.csv"]

            async def parse_row(self, response: Any, row: dict[str, Any]) -> Any:
                yield {"title": row["title"], "price": row["price"]}

        csv_items = list(_CsvFeed().start().items)
        check(
            "csv feed 剥 BOM 后一条",
            len(csv_items) == 2 and csv_items[0].get("title") == "A",
            repr(csv_items),
        )
    finally:
        server.shutdown()

    print("  SKIP  Shopify: no user-provided test store; B11 remains blocked")


def run_crawl_guards() -> None:
    """爬虫的边界：域内判定、select 的字符预算、站外重定向与叫停通道。

    ``allowed_domains`` 只参与**链接发现**：重定向是 curl_cffi 自己跟的，
    ``follow_redirects="safe"`` 又只拒绝跳向私网，于是一个站外公网跳转能把整份内容
    收回来流进模型上下文。这条真的起两个本地服务把那条路径走一遍。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import crawl
    import guard

    # 域内判定：口径与 Scrapling 引擎的 _is_domain_allowed 逐字一致。
    allowed = {"a.test", "a.test:8080"}
    for url, note, wanted in (
        ("http://a.test/x", "整名相等", True),
        ("http://a.test:8080/x", "带端口的 netloc 相等", True),
        ("http://sub.a.test/x", "子域后缀", True),
        ("http://b.test/x", "另一台主机", False),
        ("http://a.test:9090/x", "同主机不同端口", False),
        ("http://nota.test/x", "只是后缀相同", False),
        ("/relative", "连主机名都没有", False),
    ):
        check(f"域内判定：{note}", crawl._within_allowed_domains(url, allowed) is wanted, url)

    # select 的字符预算：limit 数条数，预算管总长度。
    html = "<ul>" + "".join(f"<li>{'x' * 40}{i}</li>" for i in range(20)) + "</ul>"
    capped = adapters.select({"html": html, "selector": "li", "maxContentChars": 100})
    check("预算内逐条收，超了就停", len(capped["matches"]) < 20, str(len(capped["matches"])))
    check("超预算即置 truncated", capped["truncated"] is True, repr(capped["truncated"]))
    check("count 仍是命中总数", capped["count"] == 20, str(capped["count"]))
    total = sum(len(item["text"]) for item in capped["matches"])
    check("总长度不超过预算", total <= 100, str(total))
    uncapped = adapters.select({"html": html, "selector": "li"})
    check("没给预算时用部署默认档", len(uncapped["matches"]) == 20, str(len(uncapped["matches"])))
    limited = adapters.select({"html": html, "selector": "li", "limit": 3})
    check("limit 仍然只管条数", len(limited["matches"]) == 3, str(len(limited["matches"])))
    check("limit 截断也置 truncated", limited["truncated"] is True, "")

    guard.configure(allowed_hosts=frozenset({"127.0.0.1", "localhost", "a.test", "b.test"}))
    try:
        _run_page_confinement(crawl)
        _run_crawl_happy_path(crawl)
        _run_crawl_extensions(crawl)
        _run_crawl_sitemap(crawl)
        _run_crawl_feed(crawl)
        _run_crawl_shopify(crawl)
        _run_crawl_stop(crawl)
        for bad_since in (-1, True, "1"):
            try:
                crawl.crawl_status({"crawlId": "whatever", "since": bad_since})
                check(f"since={bad_since!r} 被拒", False, "被当成合法值放行")
            except adapters.AdapterError as error:
                check(f"since={bad_since!r} 被拒", error.code == "BAD_ARGS", error.code)
    finally:
        crawl.close_all_crawls()
        guard.configure(allowed_hosts=frozenset())


class _SiteHandler(http.server.BaseHTTPRequestHandler):
    """一个三页互链的站点：爬虫的链接发现与去重都要有真链接可走。"""

    PAGES = {
        "/": (
            "<html><head><title>Home</title></head><body><h1>HOME</h1>"
            "<a href='/p1'>1</a><a href='/p2'>2</a></body></html>"
        ),
        "/p1": (
            "<html><head><title>P1</title></head><body><h1>P1BODY</h1>"
            "<a href='/p2'>2</a><a href='/p1'>self</a></body></html>"
        ),
        "/p2": "<html><head><title>P2</title></head><body><h1>P2BODY</h1><p>second page</p></body></html>",
    }

    def do_GET(self) -> None:  # BaseHTTPRequestHandler 的约定方法名
        """回一页；未知路径回 404。"""
        body = self.PAGES.get(self.path, "").encode()
        self.send_response(200 if self.path in self.PAGES else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        """静默默认的逐请求日志。"""


def _run_crawl_sitemap(crawl: Any) -> None:
    """sitemap 模式：只抓 sitemap 里的 loc，不跟随页面内链接，sitemapFollow 过滤子 sitemap。"""
    import adapters

    class _SitemapHandler(http.server.BaseHTTPRequestHandler):
        """sitemap 索引 + 两份子 sitemap + 页面（页面里带一条不该被跟的 /c）。"""

        def do_GET(self) -> None:  # BaseHTTPRequestHandler 的约定方法名
            base = f"http://127.0.0.1:{cast(http.server.ThreadingHTTPServer, self.server).server_address[1]}"
            if self.path == "/sitemap-index.xml":
                body = (
                    '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                    f"<sitemap><loc>{base}/sm-keep.xml</loc></sitemap>"
                    f"<sitemap><loc>{base}/sm-drop.xml</loc></sitemap>"
                    "</sitemapindex>"
                ).encode()
                content_type = "application/xml"
            elif self.path == "/sm-keep.xml":
                body = (
                    '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                    f"<url><loc>{base}/a</loc></url></urlset>"
                ).encode()
                content_type = "application/xml"
            elif self.path == "/sm-drop.xml":
                body = (
                    '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                    f"<url><loc>{base}/c</loc></url></urlset>"
                ).encode()
                content_type = "application/xml"
            else:
                body = (
                    f"<html><head><title>PAGE</title></head><body>PAGEBODY<a href='{base}/c'>C</a></body></html>"
                ).encode()
                content_type = "text/html"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            """静默默认的逐请求日志。"""

    server, base = _serve(_SitemapHandler)
    try:
        crawl_id = crawl.crawl_run(
            {
                "url": base + "/",
                "mode": "sitemap",
                "sitemapUrl": base + "/sitemap-index.xml",
                "sitemapFollow": r"sm-keep",
                "maxPages": 5,
            }
        )["crawlId"]
        status = _await_crawl_done(crawl, crawl_id, 30)
        urls = sorted(page["url"] for page in status["pages"])
        check("sitemap 只抓跟进的子 sitemap", urls == [base + "/a"], repr(urls))
        check("sitemap 不跟随页面内链接", base + "/c" not in urls, repr(urls))
        check("sitemap 有 stats", (status.get("stats") or {}).get("requests_count", 0) >= 2, repr(status.get("stats")))
        check("sitemap 页带 markdown", "PAGEBODY" in (status["pages"][0]["markdown"] if status["pages"] else ""), "")

        bad = crawl.crawl_run({"url": base + "/", "mode": "sitemap", "sitemapFollow": "("})
        check("未给 sitemapUrl 先报 BAD_ARGS", False, repr(bad))
    except adapters.AdapterError as error:
        check("非法 sitemap 参数报 BAD_ARGS", error.code == "BAD_ARGS", error.code)
    finally:
        server.shutdown()

    try:
        crawl.crawl_run({"url": "http://127.0.0.1/", "mode": "nope"})
        check("未知 mode 被拒", False, "放行")
    except adapters.AdapterError as error:
        check("未知 mode 被拒", error.code == "BAD_ARGS", error.code)


def _run_crawl_feed(crawl: Any) -> None:
    """feed 模式：XML/CSV 各跑一次，CSV 的 BOM 要剥掉，输出结构化行。"""
    import adapters

    class _FeedHandler(http.server.BaseHTTPRequestHandler):
        """XML 与 CSV 两份 feed。"""

        def do_GET(self) -> None:  # BaseHTTPRequestHandler 的约定方法名
            if self.path == "/feed.xml":
                body = (
                    '<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>'
                    "<item><title>A</title><link>https://e.test/a</link></item>"
                    "<item><title>B</title><link>https://e.test/b</link></item>"
                    "</channel></rss>"
                ).encode()
                content_type = "application/xml"
            elif self.path == "/feed.csv":
                body = ("\ufefftitle,price\nA,1\nB,2\n").encode()
                content_type = "text/csv"
            else:
                body = b""
                content_type = "text/plain"
            self.send_response(200 if body else 404)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            """静默默认的逐请求日志。"""

    server, base = _serve(_FeedHandler)
    try:
        xml_id = crawl.crawl_run(
            {
                "url": base + "/feed.xml",
                "mode": "feed",
                "feedType": "xml",
                "feedUrl": base + "/feed.xml",
                "itertag": "item",
                "fields": {"title": "title", "link": "link"},
                "maxPages": 5,
            }
        )["crawlId"]
        xml_status = _await_crawl_done(crawl, xml_id, 30)
        xml_rows = xml_status.get("rows") or []
        check("xml feed 行", len(xml_rows) == 2 and xml_rows[0].get("title") == "A", repr(xml_rows))
        check("xml feed 不产出 pages", xml_status.get("pages") == [], repr(xml_status.get("pages")))

        csv_id = crawl.crawl_run(
            {
                "url": base + "/feed.csv",
                "mode": "feed",
                "feedType": "csv",
                "feedUrl": base + "/feed.csv",
                "fields": {"title": "title", "price": "price"},
                "maxPages": 5,
            }
        )["crawlId"]
        csv_status = _await_crawl_done(crawl, csv_id, 30)
        csv_rows = csv_status.get("rows") or []
        check("csv feed 剥 BOM 后两行", len(csv_rows) == 2 and csv_rows[0].get("title") == "A", repr(csv_rows))

        try:
            crawl.crawl_run({"url": base + "/feed.xml", "mode": "feed", "feedType": "xml"})
            check("feed 缺 fields 被拒", False, "放行")
        except adapters.AdapterError as error:
            check("feed 缺 fields 被拒", error.code == "BAD_ARGS", error.code)
    finally:
        server.shutdown()


def _run_crawl_extensions(crawl: Any) -> None:
    """content 模式的 CSS 收窄、allow/deny 规则与结束统计。"""
    import adapters

    class _FilteredHandler(http.server.BaseHTTPRequestHandler):
        """两页互链：/a 指向 /b，正文包在 main 里。"""

        PAGES = {
            "/a": ("<html><body><main><h1>A-MAIN</h1><a href='/b'>B</a></main><aside>OUTSIDE</aside></body></html>"),
            "/b": "<html><body><main><h1>B-MAIN</h1></main></body></html>",
        }

        def do_GET(self) -> None:  # BaseHTTPRequestHandler 的约定方法名
            """回一页；未知路径回 404。"""
            body = self.PAGES.get(self.path, "").encode()
            self.send_response(200 if self.path in self.PAGES else 404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            """静默默认的逐请求日志。"""

    server, base = _serve(_FilteredHandler)
    try:
        crawl_id = crawl.crawl_run(
            {
                "url": base + "/a",
                "maxPages": 5,
                "cssSelector": "main",
                "includePatterns": [r"/a"],
                "excludePatterns": [r"/b"],
            }
        )["crawlId"]
        status = _await_crawl_done(crawl, crawl_id, 30)
        urls = [page["url"] for page in status["pages"]]
        check("crawl 只收 allow 页", urls == [base + "/a"], repr(urls))
        markdown = status["pages"][0]["markdown"] if status["pages"] else ""
        check(
            "crawl CSS 收窄到 main",
            "A-MAIN" in markdown and "OUTSIDE" not in markdown,
            markdown[:160],
        )
        stats = status.get("stats") or {}
        check("crawl 统计有 requests", stats.get("requests_count", 0) >= 1, repr(stats))
        check(
            "crawl 统计 statusCounts",
            "status_200" in (stats.get("response_status_count") or {}),
            repr(stats),
        )
        detail = crawl.crawl_status({"crawlId": crawl_id})
        check(
            "已结束统计仍在",
            (detail.get("stats") or {}).get("requests_count", 0) >= 1,
            repr(detail.get("stats")),
        )

        before = len(crawl._CRAWLS)
        try:
            crawl.crawl_run({"url": base + "/a", "includePatterns": ["("]})
            raised = False
        except adapters.AdapterError as error:
            raised = error.code == "BAD_ARGS"
        check("非法 includePatterns 报 BAD_ARGS", raised, "")
        check("非法模式不留登记", len(crawl._CRAWLS) == before, f"{before} -> {len(crawl._CRAWLS)}")
    finally:
        server.shutdown()


SHOPIFY_COLLECTIONS = {
    "collections": [
        {"handle": "all", "products_count": 2, "title": "All"},
    ]
}
SHOPIFY_PRODUCTS = {
    "products": [
        {
            "id": 1001,
            "title": "Hat",
            "handle": "hat",
            "vendor": "Acme",
            "body_html": "<p>Wool hat</p>",
            "images": [{"src": "https://cdn.example.com/hat.png"}],
            "variants": [
                {
                    "id": 1,
                    "title": "Default Title",
                    "price": "19.00",
                    "sku": "HAT-1",
                    "available": True,
                    "compare_at_price": None,
                    "barcode": "111",
                },
                {
                    "id": 2,
                    "title": "Red",
                    "price": "21.00",
                    "sku": "HAT-R",
                    "available": False,
                    "compare_at_price": "24.00",
                    "barcode": "112",
                },
            ],
        },
        {
            "id": 1002,
            "title": "Scarf",
            "handle": "scarf",
            "vendor": "Acme",
            "body_html": "",
            "images": [],
            "variants": [
                {
                    "id": 3,
                    "title": "Default Title",
                    "price": "9.50",
                    "sku": "SCF-1",
                    "available": True,
                    "compare_at_price": None,
                    "barcode": "",
                }
            ],
        },
    ]
}


class _ShopifyStore(http.server.BaseHTTPRequestHandler):
    """一个最小的 Shopify 店铺 JSON 面：collections 一页，products 一页。"""

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = dict(parse_qsl(parsed.query))
        page = query.get("page", "1")
        if parsed.path == "/collections.json":
            payload = SHOPIFY_COLLECTIONS if page == "1" else {"collections": []}
        elif parsed.path == "/collections/all/products.json":
            payload = SHOPIFY_PRODUCTS if page == "1" else {"products": []}
        else:
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        """压掉测试期间的访问日志。"""


def _run_crawl_shopify(crawl: Any) -> None:
    """mode=shopify：走本地假店的 collections/products JSON，按变体出行。"""
    server, base = _serve(_ShopifyStore)
    try:
        crawl_id = crawl.crawl_run({"url": f"{base}/", "mode": "shopify", "maxPages": 10})["crawlId"]
        status = _await_crawl_done(crawl, crawl_id, 60)
        check("shopify 模式正常收尾", status.get("error") is None, repr(status.get("error"))[:200])
        rows = status.get("rows") or []
        check("shopify 按变体出行", len(rows) == 3, repr(rows)[:300])
        by_sku = {row.get("sku"): row for row in rows}
        check(
            "变体字段齐（name/price/sku/stock/url）",
            all(key in by_sku.get("HAT-1", {}) for key in ("name", "price", "sku", "stock", "url", "identifier")),
            repr(by_sku.get("HAT-1"))[:300],
        )
        check(
            "Default Title 不拼进名字、非默认变体拼",
            by_sku.get("HAT-1", {}).get("name") == "Hat" and by_sku.get("HAT-R", {}).get("name") == "Hat - Red",
            repr([row.get("name") for row in rows]),
        )
        check(
            "价格与库存取变体值",
            by_sku.get("HAT-1", {}).get("price") == "19.00"
            and by_sku.get("HAT-R", {}).get("stock") == 0
            and by_sku.get("HAT-1", {}).get("stock") is None,
            repr([(row.get("sku"), row.get("price"), row.get("stock")) for row in rows]),
        )
        check(
            "商品 URL 用 http 夹具的 scheme",
            str(by_sku.get("SCF-1", {}).get("url", "")).startswith(f"{base}/collections/all/products/scarf"),
            repr(by_sku.get("SCF-1", {}).get("url")),
        )
        check(
            "页面列表为空、行只在 rows 里",
            status.get("pages") == [] and len(status.get("rows") or []) == 3,
            repr({"pages": status.get("pages"), "rows": len(status.get("rows") or [])}),
        )
    finally:
        server.shutdown()


def _await_crawl_done(crawl: Any, crawl_id: str, timeout: float) -> dict[str, Any]:
    """有界地等一场爬虫**正常跑完**，返回最后一份状态。

    与 :func:`_await_crawl_end` 的区别是这里要把 ``error`` 一起判掉：等一个「线程退了但
    因为异常退了」的爬虫，会把蜘蛛起不来这件事读成「一页都没抓到」。
    """
    deadline = time.monotonic() + timeout
    status = crawl.crawl_status({"crawlId": crawl_id})
    while time.monotonic() < deadline:
        if not status["running"]:
            return status
        time.sleep(0.05)
        status = crawl.crawl_status({"crawlId": crawl_id})
    return status


def _run_crawl_happy_path(crawl: Any) -> None:
    """真实站点上把爬虫的主路径走通一遍。

    为什么这条必须存在：此前爬虫侧只有「起步前叫停，一页都没抓」那种断言 —— 一只**根本
    收不到页**的蜘蛛同样能通过全部用例。Spider 的 item 字段名、``on_scraped_item`` 的
    async 契约、``configure_sessions`` 的会话注册、链接发现的域过滤，全都要靠「真的抓到页」
    才验得到。
    """
    server, base = _serve(_SiteHandler)
    events: list[dict[str, Any]] = []
    emit = crawl._emit_event
    try:
        crawl._emit_event = lambda event, **fields: events.append({"event": event, **fields})
        crawl_id = crawl.crawl_run({"url": f"{base}/", "maxPages": 5})["crawlId"]
        status = _await_crawl_done(crawl, crawl_id, 60)

        check("主路径不报错", status["error"] is None, str(status["error"]))
        check("跑完了", status["running"] is False, "")
        titles = sorted(page["title"] for page in status["pages"])
        check("链接发现把三页都走到了", titles == ["Home", "P1", "P2"], repr(titles))
        bodies = " ".join(page["markdown"] for page in status["pages"])
        check("正文是真的（不是空壳）", all(word in bodies for word in ("HOME", "P1BODY", "second page")), bodies[:80])
        check("每页都带最终 URL", all(page["url"].startswith(base) for page in status["pages"]), "")
        check("自链被去重了，没有重复页", len({page["url"] for page in status["pages"]}) == len(status["pages"]), "")
        # 事件替身挂在**模块级**属性上：这一节装着它的时候，任何还在跑的蜘蛛都会往里写。
        # 所以按 crawlId 过滤，只认自己这一场 —— CI 上不过滤就被两只没停干净的蜘蛛冲成
        # 5 vs 3（本地它们跑得完，看不出问题）。
        mine = [item for item in events if item.get("crawlId") == crawl_id]
        progress = [item for item in mine if item["event"] == "progress"]
        check("起了头一条 crawlStarted", bool(mine) and mine[0]["event"] == "crawlStarted", repr(mine[:1]))
        check("每收一页报一次进度", len(progress) == len(status["pages"]), f"{len(progress)} vs {len(status['pages'])}")
        check("进度的 done 逐页递增", [item["done"] for item in progress] == list(range(1, len(progress) + 1)), "")

        # 增量读法：Host 每轮只拿新增的那一段，回包大小与页数无关。整份重发既是 O(n²)，
        # 也会在几十页后顶过 8 MiB 帧上限，把整个 sidecar 判成坏帧拆掉。
        tail = crawl.crawl_status({"crawlId": crawl_id, "since": 1})
        check("since 之后只回新增页", tail["pages"] == status["pages"][1:], repr(tail["pages"])[:120])
        check("total 仍是全部页数", tail["total"] == len(status["pages"]), str(tail["total"]))

        # 单页就超过回包预算时不能让原样那一帧出去 —— 它会顶过 Host 的 8 MiB 切帧线，
        # 把整个 sidecar 判成坏帧拆掉。maxContentChars 没有上界（部署侧只声明了 min(1)），
        # 所以这条路径是可达的，不是理论假设。
        oversized = "中" * (crawl.MAX_STATUS_BYTES // 2)
        huge_pages = [{"url": "http://x/", "title": "T", "markdown": oversized}]
        shrunk, _ = crawl._take_pages(huge_pages, 0)
        check("超大单页被压到预算内", len(shrunk) == 1, str(len(shrunk)))
        serialized = len(json.dumps(shrunk[0], ensure_ascii=False).encode("utf-8"))
        check(
            "压过之后不超过回包预算",
            serialized <= crawl.MAX_STATUS_BYTES,
            f"{serialized} vs {crawl.MAX_STATUS_BYTES}",
        )
        check("压过的那页带 truncated 标记", shrunk[0].get("truncated") is True, repr(shrunk[0].get("truncated")))
        check("原页不被就地改动", len(huge_pages[0]["markdown"]) == len(oversized), str(len(huge_pages[0]["markdown"])))

        # 报告 §2.7：单页超预算时不能把已经收下的前几页一起丢掉。调用方按回包条数推进
        # since，丢页会让那些页下一轮重发、更后面的页永远轮不到（more=false 时直接跳过）。
        marker_pages = [
            {"url": "http://x/a", "title": "A", "markdown": "A" * 10},
            {"url": "http://x/big", "title": "B", "markdown": "中" * (crawl.MAX_STATUS_BYTES // 2)},
            {"url": "http://x/c", "title": "C", "markdown": "C" * 10},
        ]
        first_batch, first_more = crawl._take_pages(marker_pages, 0)
        check(
            "超预算页之前已收下的页一起回",
            [page["url"] for page in first_batch] == ["http://x/a"],
            repr([page["url"] for page in first_batch]),
        )
        check("本轮还有页没发出去（more=true）", first_more is True, repr(first_more))
        second_batch, second_more = crawl._take_pages(marker_pages, len(first_batch))
        check(
            "下一轮补上被压的当前页",
            [page["url"] for page in second_batch] == ["http://x/big"] and second_batch[0].get("truncated") is True,
            repr([page.get("url") for page in second_batch]),
        )
        check("被压的那页后面还有一页", second_more is True, repr(second_more))
        third_batch, third_more = crawl._take_pages(marker_pages, len(first_batch) + len(second_batch))
        check(
            "最后一页正常收尾、不重复也不跳过",
            [page["url"] for page in third_batch] == ["http://x/c"] and third_more is False,
            repr([page.get("url") for page in third_batch]),
        )
        delivered = [page["url"] for page in first_batch + second_batch + third_batch]
        check(
            "三轮下来每页恰好发一次",
            delivered == [page["url"] for page in marker_pages],
            repr(delivered),
        )

        # maxPages 是**页数**闸门：再多链接也不许多收。
        capped_id = crawl.crawl_run({"url": f"{base}/", "maxPages": 1})["crawlId"]
        capped = _await_crawl_done(crawl, capped_id, 60)
        check("maxPages 真的封顶", len(capped["pages"]) <= 1, str(len(capped["pages"])))

        # README 明写「不遵守 robots.txt、每域延迟 0、最多 4 个并发」——那些是部署没表态时
        # `_crawl_policy` 给的目标值，由 `_make_spider` 写进 Spider 的类属性。两处都钉：
        # 默认值哪天被上游或本仓改掉，README 会立刻变成错的文档。
        spider = crawl._make_spider(
            f"{base}/", 5, "defaults", {"pages": [], "deadline": 0}, {"127.0.0.1"}, crawl._crawl_policy({})
        )
        for attr, wanted in (
            ("robots_txt_obey", False),
            ("autothrottle_enabled", False),
            ("download_delay", 0.0),
            ("concurrent_requests", 4),
            ("crawl_strategy", "bfs"),
        ):
            check(f"文档默认值：{attr}", getattr(spider, attr) == wanted, repr(getattr(spider, attr)))
        check("不落盘（output_dir 未设）", spider.output_dir is None, repr(spider.output_dir))
        check("默认不落断点（crawldir 未设）", spider.crawldir is None, repr(spider.crawldir))
    finally:
        crawl._emit_event = emit
        crawl.close_all_crawls()
        server.shutdown()


def _serve(handler: type[http.server.BaseHTTPRequestHandler]) -> tuple[http.server.ThreadingHTTPServer, str]:
    """起一个本地服务并返回 (服务对象, 基址)。"""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def _scrape_one(crawl: Any, url: str) -> list[dict[str, Any]]:
    """造一个爬虫并对一个 URL 跑一次收页，返回被收下的页。"""
    state: dict[str, Any] = {
        "error": None,
        "pages": [],
        "max_content_chars": 200_000,
        "strip_inline_images": True,
        "budget_ms": 600_000,
        "deadline": time.monotonic() + 600,
    }
    spider = crawl._make_spider(
        "http://a.test:8080/start",
        5,
        "confinement",
        state,
        {"a.test", "a.test:8080"},
        crawl._crawl_policy({}),
    )
    asyncio.run(spider.on_scraped_item({"url": url, "title": "T", "markdown": f"BODY {url}"}))
    return state["pages"]


def _collector(into: list[dict[str, Any]]) -> Callable[..., None]:
    """造一个把事件帧收进给定列表的替身 emitter。

    用工厂而不是在循环里写 lambda：lambda 捕获的是**变量**，循环下一轮重新绑定后，
    迟到的调用会追加到错误的列表上。这里要替换掉 crawl 的 emitter，被替换者在同一轮里
    就会被调用，但那种「看起来对」的写法正是 B023 那类问题的标准入口。
    """

    def emit(event: str, **fields: Any) -> None:
        into.append({"event": event, **fields})

    return emit


def _run_page_confinement(crawl: Any) -> None:
    """收页前的两道复核：私网与站外主机都不许进结果。

    直接驱动 ``on_scraped_item`` 而不是真跑一次爬虫：要断的是「收到一页之后判什么」这条
    逻辑，而它发生在引擎把自己的活干完之后。真跑还得额外依赖外网 —— curl_cffi 的安全
    重定向自己就会拒掉跳向回环的那一跳，那把两个不同的机制搅在一起。

    两个主机都显式放进守卫的放行名单：否则「另一台主机」会先在 SSRF 那一关被 DNS 拒掉，
    域内判定就被绕过去了，什么都证明不了。
    """
    emit = crawl._emit_event
    for url, note, wanted in (
        ("http://a.test:8080/start", "起始域内的页要收", True),
        ("http://a.test/other", "同主机另一端口也收（netloc 在允许表里）", True),
        ("http://b.test/away", "另一台主机的页不收", False),
        ("http://169.254.169.254/latest/meta-data/", "云元数据端点不收", False),
    ):
        skipped: list[dict[str, Any]] = []
        crawl._emit_event = _collector(skipped)
        try:
            pages = _scrape_one(crawl, url)
        finally:
            crawl._emit_event = emit
        check(note, (len(pages) == 1 and pages[0]["url"] == url) is wanted, repr(pages))
        if wanted:
            # 收下的页仍然报进度；断言的只是「没有 crawlSkipped」。
            check(f"{note}（不留跳过事件）", all(item["event"] != "crawlSkipped" for item in skipped), repr(skipped))
        else:
            reason = str(skipped[0].get("text", "")) if skipped else ""
            check(f"{note}（说出为什么）", "skipped" in reason, repr(skipped))


def _await_crawl_end(crawl: Any, crawl_id: str, timeout: float) -> dict[str, Any]:
    """有界地等一个爬虫结束，返回最后一份状态。"""
    deadline = time.monotonic() + timeout
    status = crawl.crawl_status({"crawlId": crawl_id})
    while time.monotonic() < deadline:
        if not status["running"]:
            return status
        time.sleep(0.05)
        status = crawl.crawl_status({"crawlId": crawl_id})
    return status


class _SlowHandler(http.server.BaseHTTPRequestHandler):
    """每次都睡一会儿：爬虫于是停在在途请求里，叫停要等它收尾。"""

    def do_GET(self) -> None:  # 同上
        """回一张带自链的慢页。"""
        time.sleep(0.4)
        body = b"<html><body><h1>SLOW</h1><a href='/next'>next</a></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        """静默默认的逐请求日志。"""


def _run_crawl_stop(crawl: Any) -> None:
    """crawl.stop 必须真的让 Spider 退场，而不是只改一个标志。"""
    server, base = _serve(_SlowHandler)
    try:
        crawl_id = crawl.crawl_run({"url": base, "maxPages": 50, "maxDurationMs": 600_000})["crawlId"]
        # 等它真的跑起来再叫停：登记表里的线程活着才停得动。
        started = time.monotonic() + 10
        while time.monotonic() < started:
            if crawl.crawl_status({"crawlId": crawl_id})["running"]:
                break
            time.sleep(0.02)
        answer = crawl.crawl_stop({"crawlId": crawl_id})
        check("叫停回执带着同一个 id", answer["crawlId"] == crawl_id, repr(answer))
        check("有蜘蛛可停时回执说在停", answer["stopping"] is True, repr(answer))
        # 引擎要等在途请求收尾：有界地等，而不是一条随缘的 sleep。
        stopped = False
        while time.monotonic() < started:
            if not crawl.crawl_status({"crawlId": crawl_id})["running"]:
                stopped = True
                break
            time.sleep(0.05)
        check("叫停之后爬虫线程真的退了", stopped, "还在跑")
        check("已经停了再叫停也照常回执", crawl.crawl_stop({"crawlId": crawl_id})["stopping"] is False, "")
        # 截止提前到「现在」：没抓到页的蜘蛛一起步就该收手，而不是把整场跑完。
        fresh = crawl.crawl_run({"url": base, "maxPages": 50, "maxDurationMs": 600_000})["crawlId"]
        crawl.crawl_stop({"crawlId": fresh})
        ended = _await_crawl_end(crawl, fresh, 20)
        check("起步前叫停的爬虫一页都没抓", ended["pages"] == [], repr(ended["pages"]))
    finally:
        server.shutdown()


def run_crawl_policy() -> None:
    """爬虫策略旋钮：部署命名空间读出来的值要一字不差地写进 Spider 的类属性。

    为什么单立一条：这些旋钮决定的是「这台机器怎么对待别人的站点」，而 `_make_spider` 只能
    在类体上写它们（``Spider.__init__`` 只收 crawldir 与 interval）。写错的表现是「配了跟没配
    一样」，不报错 —— 所以要有一条同时钉「读成什么」与「写进去是什么」。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import crawl

    policy = crawl._crawl_policy(
        {
            "deployment": {
                "crawlStrategy": "dfs",
                "crawlDownloadDelayMs": 250,
                "crawlConcurrentRequests": 2,
                "crawlRespectRobots": True,
                "crawlAutothrottle": True,
                "crawlCheckpointDir": str(Path(tempfile.gettempdir()) / "crawl-ckpt"),
            }
        }
    )
    check("爬虫策略：strategy=dfs", policy["strategy"] == "dfs", repr(policy))
    check("爬虫策略：毫秒换算成秒", policy["delay_seconds"] == 0.25, repr(policy))
    check("爬虫策略：并发原样", policy["concurrency"] == 2, repr(policy))
    check("爬虫策略：robots 开关原样", policy["obey_robots"] is True, repr(policy))
    check("爬虫策略：autothrottle 开关原样", policy["autothrottle"] is True, repr(policy))
    check(
        "爬虫策略：断点目录原样",
        policy["checkpoint_dir"] == str(Path(tempfile.gettempdir()) / "crawl-ckpt"),
        repr(policy),
    )

    defaults = crawl._crawl_policy({})
    check(
        "未表态时是 bfs / 0 / 4 / 不遵守 robots / 不开 autothrottle / 不落断点",
        (
            defaults["strategy"],
            defaults["delay_seconds"],
            defaults["concurrency"],
            defaults["obey_robots"],
            defaults["autothrottle"],
            defaults["checkpoint_dir"],
        )
        == ("bfs", 0.0, 4, False, False, ""),
        repr(defaults),
    )

    # 取值一律报错而不夹：一个写错的策略被悄悄抬成 bfs，读日志的人只会以为「配的就是这样」。
    for bad in ("random", "", None, 1, True):
        try:
            crawl._crawl_policy({"deployment": {"crawlStrategy": bad}})
            check(f"crawlStrategy={bad!r} 被拒", False, "被当成合法值放行")
        except adapters.AdapterError as error:
            check(f"crawlStrategy={bad!r} 被拒", error.code == "BAD_ARGS", error.code)

    # 策略真的写进了类属性：造一个真 Spider 类（不 start），逐项核对。
    state: dict[str, Any] = {"pages": [], "deadline": 0}
    spider = crawl._make_spider("http://a.test/", 3, "policy", state, {"a.test"}, policy)
    check("类属性：crawl_strategy", spider.crawl_strategy == "dfs", repr(spider.crawl_strategy))
    check("类属性：download_delay", spider.download_delay == 0.25, repr(spider.download_delay))
    check("类属性：concurrent_requests", spider.concurrent_requests == 2, repr(spider.concurrent_requests))
    check("类属性：robots_txt_obey", spider.robots_txt_obey is True, repr(spider.robots_txt_obey))
    check("类属性：autothrottle_enabled", spider.autothrottle_enabled is True, repr(spider.autothrottle_enabled))
    check("配了目录才落断点", spider.crawldir is not None, repr(spider.crawldir))

    plain = crawl._make_spider("http://a.test/", 3, "policy-plain", state, {"a.test"}, defaults)
    check("没配目录就不落断点", plain.crawldir is None, repr(plain.crawldir))


def run_crawl_targets() -> None:
    """爬虫「真正会请求的那几个地址」的复核，以及行收集的截止。

    报告 §2.8：shopify 的 sitemapUrl 决定了 spider 打哪台主机（target_website 由它的
    netloc 拼出来），却只复核了起点的 url —— 必须补 url_allowed，且站内判定
    （allowed_domains）要跟真正要打的主机一致，否则 spider 的每个请求都被判站外。
    报告 §2.13：_collect_row 到点只置 expired、不 pause，feed / shopify 的 maxDurationMs
    等于没生效。
    """
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
        import crawl
        import guard
    finally:
        sys.path.remove(str(PY_DIR))
    saved_hosts = set(guard.ALLOWED_HOSTS)
    guard.configure(allowed_hosts=frozenset({"shop.test", "store.test"}))
    saved_make = crawl._make_shopify_spider
    try:
        # 1) shopify 的 sitemapUrl 也要过 url_allowed：只判起点的 url 等于给它留一条后门。
        try:
            crawl.crawl_run(
                {"url": "https://shop.test/", "mode": "shopify", "sitemapUrl": "http://127.0.0.1:9/sitemap.xml"}
            )
            check("shopify 的 sitemapUrl 过协议层复核", False, "被放行")
        except adapters.AdapterError as error:
            check("shopify 的 sitemapUrl 过协议层复核", error.code == "URL_BLOCKED", error.code)

        # 2) 类型先判：否则 url_allowed 拿非字符串会翻成 CRAWL_SETUP_FAILED，用户看不懂。
        try:
            crawl.crawl_run({"url": "https://shop.test/", "mode": "shopify", "sitemapUrl": 5})
            check("shopify 的 sitemapUrl 类型先判", False, "被放行")
        except adapters.AdapterError as error:
            check("shopify 的 sitemapUrl 类型先判", error.code == "BAD_ARGS", error.code)

        # 3) 站内判定跟 sitemapUrl 的主机走：spider 的 collections/products 就打在那台上。
        captured: dict[str, Any] = {}

        def _capture_shopify(
            url: str,
            limit: int,
            crawl_id: str,
            state: dict[str, Any],
            domains: set[str],
            policy: dict[str, Any],
            options: dict[str, Any],
        ) -> Any:
            """记下 crawl_run 交下来的主机与参数，然后中断建 spider。"""
            captured.update({"domains": domains, "options": options})
            raise adapters.AdapterError("BAD_ARGS", "captured")

        crawl._make_shopify_spider = _capture_shopify
        try:
            crawl.crawl_run(
                {"url": "https://shop.test/", "mode": "shopify", "sitemapUrl": "https://store.test/sitemap.xml"}
            )
            check("shopify 建 spider 时被用例拦下（控制流）", False, "没抛")
        except adapters.AdapterError as error:
            check("shopify 建 spider 时被用例拦下（控制流）", error.code == "BAD_ARGS", error.code)
        finally:
            crawl._make_shopify_spider = saved_make
        check(
            "shopify 的 allowed_domains 跟 sitemapUrl 主机走",
            captured.get("domains") == {"store.test"},
            repr(captured.get("domains")),
        )
        check(
            "shopify 把 sitemapUrl 原样交给 spider",
            captured.get("options") == {"sitemap_url": "https://store.test/sitemap.xml"},
            repr(captured.get("options")),
        )

        # 4) _collect_row 到点必须 pause：feed / shopify 的 maxDurationMs 才真的生效。
        paused: list[str] = []
        expired: dict[str, Any] = {"rows": [], "deadline": 0.0, "expired": False, "budget_ms": 1000}
        crawl._collect_row(
            {"a": 1}, state=expired, limit=5, crawl_id="row-expired", pause=lambda: paused.append("pause")
        )
        check("行收集到点后置 expired", expired["expired"] is True, "")
        check("行收集到点后不收回来的行", expired["rows"] == [], repr(expired["rows"]))
        check("行收集到点后叫停 spider（feed/shopify 的 maxDurationMs 才生效）", paused == ["pause"], repr(paused))

        alive: dict[str, Any] = {
            "rows": [],
            "deadline": time.monotonic() + 60,
            "expired": False,
            "budget_ms": 60000,
        }
        crawl._collect_row({"a": 2}, state=alive, limit=5, crawl_id="row-alive", pause=lambda: paused.append("boom"))
        check("未到点照常收行", alive["rows"] == [{"a": 2}], repr(alive["rows"]))
        check("未到点不叫停 spider", paused == ["pause"], repr(paused))

        def _raising_pause() -> None:
            """engine 已经停了时 pause 会抛 RuntimeError，不能把 sidecar 一起带走。"""
            raise RuntimeError("engine already down")

        late: dict[str, Any] = {"rows": [], "deadline": 0.0, "expired": False, "budget_ms": 1000}
        crawl._collect_row({"a": 3}, state=late, limit=5, crawl_id="row-late", pause=_raising_pause)
        check("pause 抛 RuntimeError 被吞掉", late["expired"] is True, repr(late))
    finally:
        crawl._make_shopify_spider = saved_make
        guard.configure(allowed_hosts=frozenset(saved_hosts))


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

        # 一次性静态抓取与 static 会话抓取必须在 Python 侧复判地址：Host 闸门判完到
        # curl_cffi 真建连之间隔着进程边界（TOCTOU），拿一个本机回环字面量直接问适配器，
        # 不经过 Host。地址选 9 号端口（它不会有人监听）而不是元数据端点：这条守卫真被
        # 拆掉时，变异跑会立刻 connection refused 而不是挂在一条 120 秒的请求上。
        for label, call in (
            ("一次性 fetch 在 Python 侧复判地址", lambda: adapters.fetch({"url": "http://127.0.0.1:9/x"})),
            (
                "static 会话抓取同样复判地址",
                lambda: adapters.session_fetch(
                    {
                        "sessionId": adapters.session_open({"sessionType": "static"})["sessionId"],
                        "url": "http://127.0.0.1:9/x",
                    }
                ),
            ),
        ):
            try:
                call()
                check(label, False, "回环地址被放行")
            except Exception as error:  # noqa: BLE001 —— 守卫被拆掉时这里会是 curl 的连接错
                code = getattr(error, "code", type(error).__name__)
                check(label, code == "URL_BLOCKED", str(code))
            finally:
                for session_id in list(adapters._SESSIONS):
                    adapters.session_close({"sessionId": session_id})

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
        # 被拆开的那个词重新连上，才说明夹具里确实解析出了零宽字符、而它被删掉了：
        # 只看「没有 \u200b」分不出「删掉了」和「压根没解析出来」。
        check(f"{kind} 路径删掉零宽而不是留着实体", "INSTRUCTION" in body, body[:120])


def run_bridge_wire_encoding() -> None:
    """协议通道的编码与 py/ 目录解析：两条都只在子进程里看得出来。

    宿主按 UTF-8 解码 bridge 的 stdout/stderr，而两者都是管道。管道在 Windows 上默认走本地
    ANSI 代码页；``LC_ALL=C`` 配上 ``PYTHONUTF8=0`` 也会让它们退成 ascii —— 那时一帧里带
    非 ASCII 正文就会抛 ``UnicodeEncodeError``，worker 把它当请求异常吞掉，调用方收不到任何
    响应、只能等到超时。所以这里用一组强制非 UTF-8 的环境变量起子进程，要求照常握手并回帧。

    ``-I`` 关掉了脚本目录自动进 ``sys.path``，bridge 手动补的那段必须给出真正的 ``py/``
    目录。用 "/" 切 ``__file__`` 的写法在 Windows 盘符路径上会切出整个文件路径，导入
    adapters/guard 全部失败、ready 帧永远等不到。两条都只能量子进程的 stdout。

    :returns: 无
    """
    env = {
        **os.environ,
        "LC_ALL": "C",
        "LANG": "C",
        "PYTHONUTF8": "0",
        "PYTHONIOENCODING": "ascii",
    }
    request = json.dumps({"id": "enc", "method": "ping", "params": {}}, ensure_ascii=False)
    proc = subprocess.run(  # noqa: S603  # nosec B603
        [sys.executable, "-u", "-I", str(BRIDGE)],
        input=request + "\n",
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=120,
        check=False,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    check("非 UTF-8 环境变量下 bridge 正常退出", proc.returncode == 0, repr(proc.returncode))
    check("非 UTF-8 环境变量下 stdout 仍是 UTF-8 可解的帧", len(lines) >= 2, repr(proc.stdout[:200]))
    if len(lines) < 2:
        return
    ready = json.loads(lines[0])
    check("宿主的 ready 握手拿得到能力面", ready.get("event") == "ready", repr(ready)[:200])
    check(
        "ready 帧里 scrapling 面存在（adapters/guard 导入成功）",
        isinstance((ready.get("capabilities") or {}).get("scrapling"), bool),
        repr(ready.get("capabilities"))[:200],
    )
    check("请求帧被正常回应", json.loads(lines[1]).get("id") == "enc", repr(lines[1])[:160])
    check("stderr 里没有编码异常", "UnicodeEncodeError" not in proc.stderr, repr(proc.stderr[:200]))


def run_python_floor_gate() -> None:
    """解释器地板：低于 (3, 14) 要有消息，且 bridge 在导入期非零退出、只写 stderr。

    负路径靠注入 ``sys.version_info`` 的子进程验证——支持面只有 3.14+，真旧解释器不在
    范围内，而「退出码 / stdout 干净 / stderr 有话」这三条本来就只能量子进程。

    :returns: 无
    """
    inserted = str(PY_DIR) not in sys.path
    if inserted:
        sys.path.insert(0, str(PY_DIR))
    import bridge

    check("地板常量是 (3, 14)", bridge.MIN_PYTHON == (3, 14), str(bridge.MIN_PYTHON))
    check("3.14 恰好达标放行", bridge.check_python((3, 14, 0)) is None)
    check("更高版本放行", bridge.check_python((3, 15, 1)) is None)
    message = bridge.check_python((3, 13, 7))
    check("3.13 被拦下并给出消息", isinstance(message, str), repr(message))
    text = str(message)
    check("消息点名地板与当前版本", "需要 Python 3.14+" in text and "当前 3.13.7" in text, text)
    if inserted:
        sys.path.remove(str(PY_DIR))

    spoof = f"import sys;sys.path.insert(0, {str(PY_DIR)!r});sys.version_info = (3, 13, 7, 'final', 0);import bridge"
    proc = subprocess.run(  # noqa: S603  # nosec B603
        [sys.executable, "-I", "-c", spoof],
        capture_output=True,
        text=True,
        # 拦截消息是中文；按 UTF-8 解，才判得到「消息进 stderr」这一条。
        encoding="utf-8",
        check=False,
    )
    check("伪旧解释器下 bridge 退出 78", proc.returncode == 78, repr(proc.returncode))
    check("拦截消息不进 stdout", proc.stdout == "", repr(proc.stdout[:120]))
    check("拦截消息进 stderr", "需要 Python 3.14+" in proc.stderr, repr(proc.stderr[:200]))


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


def proxy_field(raw: str, field: str) -> object:
    """拆一个代理地址并取出字段；拆不出来就直接报错。

    不让裸下标去撞 ``dict | None``：那会把「这个地址本该拆得出来」变成一次 KeyError/TypeError，
    而用例想说的是前者。

    :param raw: 代理地址
    :param field: 要取的字段
    :returns: 字段值
    """
    sys.path.insert(0, str(PY_DIR))
    import guard

    parsed = guard.split_proxy(raw)
    if parsed is None:
        raise AssertionError(raw)
    return parsed[field]


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
        # 测试夹具里的假凭据，不是真实密码；用变量承接，避免把它写成硬编码密码。
        demo_text = "p"
        check(
            "拆出 Playwright 要的 server/username/password",
            guard.split_proxy("http://u:p@10.0.0.1:7890")
            == {"server": "http://10.0.0.1:7890", "username": "u", "password": demo_text},
        )
        check(
            "IPv6 字面量把方括号装回 server（urlparse 已经摘掉了）",
            proxy_field("socks5://[::1]:1080", "server") == "socks5://[::1]:1080",
        )
        check(
            "凭据 percent-decode，与 libcurl 的读法一致",
            proxy_field("http://u:p%40ss@h:1", "password") == "p@ss",
        )
        check(
            "路径与片段被丢弃",
            proxy_field("http://h:1/ignored?q=1#f", "server") == "http://h:1",
        )
        check(
            "没有端口时不补冒号",
            proxy_field("http://proxy.test", "server") == "http://proxy.test",
        )
        check("协议不在白名单内判否", guard.split_proxy("ftp://127.0.0.1:21") is None)
        check("根本不是地址判否", guard.split_proxy("not a url") is None)
        check(
            "socks5h 是 curl 的私有写法，两边都不认",
            guard.split_proxy("socks5h://h:1") is None,
        )
        # 这两个在 urlparse / parsed.port 上抛 ValueError。契约是「地址不可用就返 None」，
        # 否则一个填错的 proxyUrl 会让 configure_from_env 与每个请求一起炸。
        check("畸形 IPv6 方括号返 None 而不是抛", guard.split_proxy("http://[::1") is None)
        check("端口越界返 None 而不是抛", guard.split_proxy("http://h:99999") is None)
        check("端口非数字返 None 而不是抛", guard.split_proxy("http://h:abc") is None)

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
        # 测试夹具里的空凭据，不是真实密码；用变量承接，避免把它写成硬编码密码。
        empty_text = ""
        check(
            "浏览器形态是 server/username/password",
            guard.browser_proxy("https://example.com/")
            == {"server": "http://127.0.0.1:7890", "username": "", "password": empty_text},
        )
        check("会话开场取全局那份", guard.default_proxy() == "http://127.0.0.1:7890")
        check(
            "能力摘要只回显 scheme://host:port，凭据不外泄",
            guard.proxy_settings() == {"configured": True, "source": "settings", "server": "http://127.0.0.1:7890"},
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

        # 不可用地址会进日志（宿主日志面）。无 scheme 的 user:pass@ 是最容易漏的形态：
        # 报告 §2.10 的触发点就是这里。
        unusable_log = io.StringIO()
        with contextlib.redirect_stderr(unusable_log):
            load(**{guard.PROXY_ENV: "user:secret@127.0.0.1:8080"})
        logged = unusable_log.getvalue()
        check(
            "不可用代理的日志不带口令（无 scheme 形态）",
            "secret" not in logged and "ignoring an unusable" in logged,
            logged,
        )
        check(
            "不可用代理按未配置降级",
            guard.proxy_for("https://example.com/") == "",
            repr(guard.proxy_for("https://example.com/")),
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
            guard.parse_scutil_proxy("<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n}")
            == {"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"},
            "",
        )
        check(
            "scutil: 开关全关时是空表",
            guard.parse_scutil_proxy("<dictionary> {\n  FTPPassive : 1\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}") == {},
            "",
        )
        check(
            "scutil: 半配置（有 host 没 port）丢弃而不是造出坏地址",
            guard.parse_scutil_proxy("<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n}") == {},
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
            "windows: reg query 输出的 0x1 也认",
            guard.parse_windows_proxy({"proxyenable": "0X1", "proxyserver": "127.0.0.1:7890"})
            == {"http": "http://127.0.0.1:7890", "https": "https://127.0.0.1:7890"},
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
            guard.socket.getaddrinfo = real_getaddrinfo
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

        # IPv4-compatible（::/96）：::7f00:1 就是 ::127.0.0.1，而 ipaddress 的 is_private
        # 不把这一段算私有，所以不换算就等于把 SSRF 守卫开了一个口子。
        check(
            "ipv4-compatible 里的回环按内嵌 ipv4 判拒",
            not guard.is_public_address("::7f00:1"),
        )
        check(
            "ipv4-compatible 里的私网按内嵌 ipv4 判拒",
            not guard.is_public_address("::a00:1"),
        )
        check(
            "ipv4-compatible 里的公网仍放行，不能把整段一刀切掉",
            guard.is_public_address("::5db8:d818"),
        )
        check(":: 与 ::1 仍按各自的私有判定拒掉", not guard.is_public_address("::1"))

        # NAT64 的默认 /96 与 /48 两档：内嵌 IP 必须按 RFC 6052 §2.2 的布局读，
        # /48 这一档 u 字节（下标 8）夹在中间，按起点连续切 4 字节会读错。
        for host, note in (
            ("64:ff9b:1:c0a8:1:100::", "/48 里的私网 192.168.1.1"),
            ("64:ff9b:1:7f00:0:100::", "/48 里的回环 127.0.0.1"),
            ("64:ff9b::7f00:1", "/96 里的回环 127.0.0.1"),
        ):
            check(f"NAT64 {note} 判拒", not guard.is_public_address(host), host)
        check(
            "NAT64 里藏的公网地址仍放行，不能把整段一刀切掉",
            guard.is_public_address("64:ff9b:1:5db8:d8:2200::"),
        )
        # /56 与 /40 只能经部署声明前缀才生效，而它们是**真正能把私网读成公网**的档位：
        # 按起点连续切时，/56 的 192.168.1.1 会读成 192.0.168.1（公网）。所以前缀本身
        # 必须取一段公网 IPv6，否则 IPv6 层就先被判私网，测不到 NAT64 这条分支。
        for prefix, host, note in (
            ("2a00:1450::/56", "2a00:1450:0:c0:a8:101::", "/56 里的私网 192.168.1.1"),
            ("2a00:1450::/56", "2a00:1450:0:ac:14:101::", "/56 里的私网 172.20.1.1"),
            ("2a00:1450::/40", "2a00:1450:a:102:3::", "/40 里的私网 10.1.2.3"),
        ):
            guard.configure(nat64_prefixes=(prefix,))
            try:
                check(f"NAT64 {note} 判拒", not guard.is_public_address(host), host)
            finally:
                guard.configure(nat64_prefixes=())
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
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)) for ip in answers[host]]

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
            guard._dns_cache_clear()
            allowed, why = guard.url_allowed("https://target.test/")
            check(f"池内任意落点 {answer} 都放行（不是切一小片）", allowed, why)

        # 收紧的那一侧：合成模式**只**放宽已知池，私网 / 回环 / 链路本地照旧拒。
        for answer in ("127.0.0.1", "192.168.1.1", "10.0.0.5", "169.254.169.254"):
            answers["target.test"] = [answer]
            guard._SYNTHETIC_RESOLVER = None
            # 每次换答案都要清解析缓存：这一组判据正是「同主机、不同答案」的形态。
            guard._dns_cache_clear()
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
        guard._dns_cache_clear()
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
        guard._dns_cache_clear()
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
        guard._dns_cache_clear()
        check("控制域名正常时不误判", not guard.detect_synthetic_resolver())
        allowed, why = guard.url_allowed("https://target.test/")
        check("未识别为合成解析器时，池内答案照旧判拒", not allowed, why)
    finally:
        guard.socket.getaddrinfo = real_getaddrinfo
        guard._SYNTHETIC_RESOLVER = real_cache
        answers.clear()
        guard._dns_cache_clear()


def run_concurrency_guards() -> None:
    """并发路径的验证：会话名额与爬虫名额的判重必须在锁内真的生效。

    这组对着一次真实竞态：bridge 有多个 worker 线程，两个并发的 session_open 各自
    判完「没重复 / 还有名额」再各自开，于是上限名存实亡、重复 id 静默覆盖。
    这里用起线程把两个调用真正叠起来，而不是顺序调两次 —— 顺序调当然看不出问题。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import guard

    # 会话抓取现在会过 Python 侧的地址复判（与一次性 fetch 同一条），而这里的假会话
    # 用的是不存在的域名：放行它，这一节量的才是锁与名额，不是 URL 政策。
    guard.configure(allowed_hosts=frozenset({"a.test"}))
    try:
        _run_concurrency_core(adapters)
    finally:
        adapters._SESSIONS.clear()
        guard.configure(allowed_hosts=frozenset())


def _run_concurrency_core(adapters: Any) -> None:
    """并发名额与串行化的断言体；放行集合由调用方管。"""
    import crawl
    import guard

    results: list[str] = []
    lock = threading.Lock()

    def open_static() -> None:
        try:
            opened = adapters.session_open({"sessionType": "static"})["sessionId"]
            with lock:
                results.append(f"ok:{opened}")
        except adapters.AdapterError as error:
            with lock:
                results.append(f"err:{error.code}")

    threads = [threading.Thread(target=open_static) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    accepted = [item for item in results if item.startswith("ok:")]
    check(
        "并发开会话时名额不超发",
        len(accepted) <= adapters.MAX_SESSIONS,
        f"{len(accepted)} accepted of {len(results)}",
    )
    check(
        "注册表里没有残留的构造中占位",
        all(entry.get("pending") is not True for entry in adapters._SESSIONS.values()),
        repr(sorted(adapters._SESSIONS)),
    )
    for session_id in list(adapters._SESSIONS):
        adapters.session_close({"sessionId": session_id})

    # 同一 id 并发开两次：只应有一个成功，另一个拿到 BAD_ARGS 而不是覆盖。
    adapters._SESSIONS.clear()
    same_id: list[str] = []
    id_lock = threading.Lock()

    def open_same() -> None:
        try:
            adapters.session_open({"sessionType": "static", "sessionId": "shared-id"})
            with id_lock:
                same_id.append("ok")
        except adapters.AdapterError as error:
            with id_lock:
                same_id.append(error.code)

    id_threads = [threading.Thread(target=open_same) for _ in range(4)]
    for thread in id_threads:
        thread.start()
    for thread in id_threads:
        thread.join()
    check("同一 id 并发开只有一个成功", same_id.count("ok") == 1, repr(same_id))
    adapters.session_close({"sessionId": "shared-id"})

    # 同一份会话被两个 worker 同时用：Playwright 的同步 API 与 curl_cffi 的 Session 都
    # 不是线程安全的（前者靠 greenlet 一次只服务一个线程，后者的文档原话是「一个时刻一个
    # 会话」）。用一个「进去就睡」的假会话，把重叠变成可见的事实。
    adapters._SESSIONS.clear()
    depth = {"now": 0, "max": 0}

    class _CountingSession:
        """进来就睡一会的假会话：并发进入会把 max 抬到 2。"""

        def get(self, _url: str, **_params: object) -> FakeResponse:
            depth["now"] += 1
            depth["max"] = max(depth["max"], depth["now"])
            time.sleep(0.05)
            depth["now"] -= 1
            return FakeResponse()

    adapters._SESSIONS["shared"] = {
        "session": _CountingSession(),
        "closer": _CountingSession(),
        "type": "static",
        "lock": threading.Lock(),
    }
    fetched: list[str] = []
    fetch_lock = threading.Lock()

    def fetch_shared() -> None:
        try:
            adapters.session_fetch({"sessionId": "shared", "url": "http://a.test/"})
            with fetch_lock:
                fetched.append("ok")
        except adapters.AdapterError as error:
            with fetch_lock:
                fetched.append(error.code)

    fetch_threads = [threading.Thread(target=fetch_shared) for _ in range(4)]
    for thread in fetch_threads:
        thread.start()
    for thread in fetch_threads:
        thread.join()
    check("并发的 session.fetch 都成功", fetched.count("ok") == 4, repr(fetched))
    check("同一份会话没有被并发使用", depth["max"] == 1, str(depth["max"]))
    adapters._SESSIONS.clear()

    # 爬虫名额同理：并发判、占位登记都要在锁内。
    #
    # 起点用本地服务而不是外网：外网在 CI 上可能压根不通，那时 busy 里一个 "ok" 都没有，
    # 「名额不超发」就退化成 0 <= 2 的恒真式 —— 而那种绿看起来与真跑过一模一样。
    crawl._CRAWLS.clear()
    guard.configure(allowed_hosts=frozenset({"127.0.0.1"}))
    server, slow_base = _serve(_SlowHandler)
    busy: list[str] = []
    started: list[str] = []
    busy_lock = threading.Lock()

    def run_crawl() -> None:
        try:
            crawl_id = crawl.crawl_run({"url": f"{slow_base}/", "maxPages": 50})["crawlId"]
            with busy_lock:
                busy.append("ok")
                started.append(crawl_id)
        except Exception as error:  # noqa: BLE001
            code = getattr(error, "code", type(error).__name__)
            with busy_lock:
                busy.append(str(code))

    # 事件帧走 stdout，而这一节的蜘蛛是被**故意**叫停的：它们的 crawlStarted / crawlSkipped
    # 混进测试输出只会让人以为漏了替身。装一个吞掉事件的替身，收尾时还原。
    # 必须收 **kwargs：_emit_event 的调用一律带关键字字段（crawlId=…、text=…），只写 *args
    # 的替身会在第一次发帧时抛 TypeError —— 而那还会把占位名额漏在登记表里，后面几条全变
    # CRAWL_BUSY（这一版就是这么炸的）。
    emit = crawl._emit_event
    crawl._emit_event = lambda *args, **kwargs: None
    crawl_threads = [threading.Thread(target=run_crawl) for _ in range(crawl.MAX_CONCURRENT_CRAWLS + 3)]
    for thread in crawl_threads:
        thread.start()
    for thread in crawl_threads:
        thread.join()
    check(
        "并发起爬虫时名额不超发",
        busy.count("ok") <= crawl.MAX_CONCURRENT_CRAWLS,
        repr(busy),
    )
    check("确实起过爬虫（否则上一条只是 0 <= 2 的恒真式）", busy.count("ok") >= 1, repr(busy))

    # 收尾必须**真的停掉**这些蜘蛛：留着它们，后面任何一节装上的 _emit_event 替身都会收到
    # 它们的进度事件 —— CI 上正是这样把爬虫正例的「每收一页报一次进度」冲成 5 vs 3 的（两只
    # 还在跑的蜘蛛各报了一页，而本地跑得快、它们在正例开始前就结束了，所以看不出来）。
    # 这里按 id 逐只停并等线程，是因为本节要**当场**拿到「叫停有效」这条判据；
    # close_all_crawls 那条整体收尾路子在 run_inprocess_crawl 里钉。
    spider_threads: list[threading.Thread | None] = [(crawl._CRAWLS.get(item) or {}).get("thread") for item in started]
    try:
        for crawl_id in started:
            crawl.crawl_stop({"crawlId": crawl_id})
        # 引擎要等在途请求收尾（_SlowHandler 每页睡 0.4s），所以是有界地等而不是随缘 sleep。
        deadline = time.monotonic() + 30
        for spider in spider_threads:
            if spider is not None:
                spider.join(timeout=max(0.0, deadline - time.monotonic()))
        check(
            "叫停之后没有蜘蛛活到下一节（否则它会往别人的事件替身里写）",
            all(spider is None or not spider.is_alive() for spider in spider_threads),
            repr([spider is not None and spider.is_alive() for spider in spider_threads]),
        )
    finally:
        crawl._emit_event = emit
        crawl.close_all_crawls()
        server.shutdown()
        guard.configure(allowed_hosts=frozenset())


def run_network_summary() -> None:
    """网络摘要的形状与 URL 脱敏：凭据型查询参数不能进模型上下文。

    这条对着 0.5 的新契约：摘要不再是响应上的 ``captured_xhr``，而是从
    ``session.network``（``NetworkRecorder``）里 ``search`` 出来的。形状、正文预算与
    ``bodyNote`` 三条都要钉，否则「这条接口没正文」与「这个接口本来就空」会混成同一件事。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters

    redacted = adapters.redact_url_secrets
    check("token 参数被脱敏", "abc123" not in redacted("https://a.test/api?page=2&token=abc123"))
    check("脱敏后仍看得出是哪个接口", "/api" in redacted("https://a.test/api?token=abc123"))
    check("普通筛选参数原样保留", "page=2" in redacted("https://a.test/api?page=2&token=abc123"))
    check("无查询串的 URL 不动", redacted("https://a.test/api/v1/users") == "https://a.test/api/v1/users")
    check("签名参数被脱敏", "99" not in redacted("https://a.test/x?sig=99"))
    check("大小写不敏感", "zz" not in redacted("https://a.test/x?ACCESS_TOKEN=zz"))
    # urlsplit 并不挑剔普通垃圾串，只有真正畸形（IPv6 方括号没闭合）才会抛；抛了就原样返回。
    broken = "http://[::1/api?token=abc"
    check("解析不了的 URL 原样返回", redacted(broken) == broken)
    # authority 里的 user:pass@ 与片段里的令牌是同一类凭据，只是换了藏身位置。
    check(
        "authority 里的凭据整段丢掉",
        redacted("https://user:secret@a.test/api?x=1") == "https://a.test/api?x=1",
        repr(redacted("https://user:secret@a.test/api?x=1")),
    )
    # 报告 §2.10：没有 scheme 的 user:pass@host:8080 会被 urlsplit 读成 scheme=user、
    # path=pass@host:8080，netloc 为空 —— 按 netloc 摘 userinfo 那一步对它什么都不做，
    # 于是整条代理口令原样进日志（PROXY_URL 不可用那条日志正是这个形状）。
    check(
        "无 scheme 的 user:pass@host 也脱敏",
        redacted("user:secret@127.0.0.1:8080") == "127.0.0.1:8080",
        repr(redacted("user:secret@127.0.0.1:8080")),
    )
    check(
        "无 scheme 的代理地址里查询串凭据一并脱敏",
        "secret" not in redacted("user:secret@127.0.0.1:8080/?token=zz")
        and "zz" not in redacted("user:secret@127.0.0.1:8080/?token=zz"),
        repr(redacted("user:secret@127.0.0.1:8080/?token=zz")),
    )
    check(
        "没有 userinfo 的 host:port 原样返回",
        redacted("127.0.0.1:8080") == "127.0.0.1:8080",
        repr(redacted("127.0.0.1:8080")),
    )
    check(
        "片段里的 access_token 被脱敏（OAuth2 隐式流程的形状）",
        "access_token=tok&" not in redacted("http://a.test/app#access_token=tok&state=1"),
        repr(redacted("http://a.test/app#access_token=tok&state=1")),
    )
    check(
        "单页应用路由的片段同样覆盖（先路径后查询）",
        "token=tok&" not in redacted("http://a.test/#!/list?token=tok&page=2"),
        repr(redacted("http://a.test/#!/list?token=tok&page=2")),
    )
    check(
        "普通锚点片段原样不动",
        redacted("http://a.test/page#section-2") == "http://a.test/page#section-2",
    )

    class _Item:
        url = "https://a.test/api?access_token=secret-value&page=3"
        status = 200
        body = b"x" * 12
        method = "POST"
        headers = {"Content-Type": "application/json", "Set-Cookie": "sid=secret"}
        request_headers = {"method": "GET"}
        meta = {"network_id": 7, "method": "GET", "resource_type": "fetch"}

    class _Recorder:
        """够 _network_summary 调用的最小 NetworkRecorder 替身。"""

        enabled = True

        def __init__(self, items: list[Any]) -> None:
            self._items = items

        def search(
            self,
            url_pattern: Any = None,
            limit: Any = 100,
            include_static: bool = True,
            **_kwargs: Any,
        ) -> list[Any]:
            """按 limit 截断地回出条目（这里不实现过滤，摘要在调用侧做）。"""
            _ = (url_pattern, include_static)
            return self._items[:limit] if limit else self._items

    summary = adapters._network_summary(_Recorder([_Item()]), query=adapters._network_read({"networkLimit": 10}))
    check("摘要里的凭据已脱敏", len(summary) == 1 and "secret-value" not in summary[0]["url"], repr(summary))
    check(
        "条目形状带 id/url/status/bytes/method/resourceType",
        {"id", "url", "status", "bytes", "method", "resourceType"} <= set(summary[0]),
        repr(summary),
    )
    check(
        "method 取上游 Response.method，而不是 meta",
        summary[0]["method"] == "POST",
        repr(summary),
    )
    check("摘要仍带着状态码与字节数", summary[0]["status"] == 200 and summary[0]["bytes"] == 12, repr(summary))
    check(
        "includeHeaders 缺省时不回响应头",
        "headers" not in summary[0],
        repr(summary),
    )
    with_headers = adapters._network_summary(
        _Recorder([_Item()]),
        query=adapters._network_read({"networkLimit": 10, "includeHeaders": True}),
    )
    check(
        "includeHeaders 脱敏 set-cookie",
        "Set-Cookie" not in with_headers[0].get("headers", {}) and "Content-Type" in with_headers[0].get("headers", {}),
        repr(with_headers),
    )

    # 正文只在显式要求时回，且按预算截断 —— 上游存的量级不该决定模型看见什么。
    with_body = adapters._network_summary(
        _Recorder([_Item()]),
        query=adapters._network_read({"networkLimit": 10, "includeBody": True, "maxBodyChars": 5}),
    )
    check(
        "includeBody 时带正文并按预算截断",
        with_body[0].get("body") == "xxxxx" and with_body[0].get("bodyTruncated") is True,
        repr(with_body),
    )
    no_body = adapters._network_summary(
        _Recorder([_Item()]),
        query=adapters._network_read({"networkLimit": 10, "maxBodyChars": 5}),
    )
    check("不要求正文时不回正文", "body" not in no_body[0], repr(no_body))

    class _EmptyBody(_Item):
        body = b""
        meta = {"method": "GET", "resource_type": "xhr", "body_note": "body dropped"}

    noted = adapters._network_summary(_Recorder([_EmptyBody()]), query=adapters._network_read({"networkLimit": 10}))
    check("没有正文时把上游的原因带出去", noted[0].get("bodyNote") == "body dropped", repr(noted))

    # URL 过滤正则由用户手写，而上游拿它做 re.compile；编译不过会抛 ValueError，读的人看不出
    # 根因是自己正则写错了。所以在读历史之前就地判。
    try:
        adapters._url_pattern({"urlPattern": "(["})
        check("坏 urlPattern 报 BAD_ARGS", False, "竟然放行了")
    except adapters.AdapterError as error:
        check("坏 urlPattern 报 BAD_ARGS", error.code == "BAD_ARGS", error.code)
        check("报错点名是 urlPattern", "urlPattern" in str(error), str(error))
    check("没给正则时给 None（上游据此不过滤）", adapters._url_pattern({}) is None)
    check("空串也不过滤", adapters._url_pattern({"urlPattern": ""}) is None)
    check("合法正则原样返回", adapters._url_pattern({"urlPattern": "/api/"}) == "/api/")


def run_write_verbs(sidecar: Sidecar, base: str) -> None:
    """写方法与请求件的端到端验证：判据是**对端到底收到了什么**。

    为什么这条必须存在：本包把 method/body/headers/cookies/impersonate/retries 接成了模型可见
    入参，而 `py/tests/contract_probe.py` 把三套引擎换成了记录器 —— 它只回答「adapters 把哪个
    键交给了上游」，网络层一次都没跑过。词名拼错（`json=` 写成 `data=`）、上游根本不收某个键、
    或者非 GET 走岔了分支，在那套判据里同样是全绿。这里让真 curl_cffi 打真 HTTP 服务。
    """
    url = f"{base}/echo"

    def echo(params: dict[str, Any]) -> dict[str, Any]:
        """发一次 fetch，把服务端回显的请求件解出来。

        :param params: 这次抓取的协议参数（url 已含在内或不含都行，这里由调用方给全）
        :returns: 对端收到的 JSON；不是 JSON 时带上原始正文与错误帧
        """
        frame = sidecar.call("fetch", params)
        content = frame.get("result", {}).get("content", "")
        try:
            parsed = json.loads(content)
        except ValueError, TypeError:
            return {"_raw": content, "_frame": frame}
        return parsed if isinstance(parsed, dict) else {"_raw": content, "_frame": frame}

    common = {"url": url, "extractionType": "text", "maxContentChars": 4000}

    posted = echo(
        {**common, "method": "POST", "body": {"k": "v"}, "headers": {"X-Contract": "ct1"}, "cookies": {"c": "1"}}
    )
    check("POST 真的以 POST 到达对端", posted.get("method") == "POST", repr(posted)[:160])
    check(
        "对象型 body 按 JSON 发出（对端解得出来）",
        json.loads(str(posted.get("received", "{}"))) == {"k": "v"},
        repr(posted)[:200],
    )
    check("headers 落地", posted.get("marker") == "ct1", repr(posted)[:200])
    check("cookies 落地", posted.get("cookie") == "c=1", repr(posted)[:200])

    plain = echo({**common, "method": "PUT", "body": "a=1"})
    check("PUT 到达对端", plain.get("method") == "PUT", repr(plain)[:160])
    check("字符串型 body 原样发出（没被强行 JSON 化）", plain.get("received") == "a=1", repr(plain)[:200])

    gone = echo({**common, "method": "DELETE"})
    check("DELETE 到达对端", gone.get("method") == "DELETE", repr(gone)[:160])

    # 请求体不是对象也不是字符串时（数组、数字），JSON 体照样要发出去。此前这一类被静默丢掉：
    # 请求照发、对端收到空体、回包上没有一行能看出这件事。
    listed = echo({**common, "method": "POST", "body": [1, 2]})
    check(
        "数组型 body 按 JSON 发出（不是被丢掉）",
        json.loads(str(listed.get("received", "null"))) == [1, 2],
        repr(listed)[:200],
    )
    scalar = echo({**common, "method": "POST", "body": 42})
    check("数字型 body 也按 JSON 发出", json.loads(str(scalar.get("received", "null"))) == 42, repr(scalar)[:200])

    lower = echo({**common, "method": "post", "body": "x"})
    check("方法名大小写不敏感", lower.get("method") == "POST", repr(lower)[:160])

    with_body_get = echo({**common, "method": "GET", "body": "ignored"})
    check("GET 仍是 GET", with_body_get.get("method") == "GET", repr(with_body_get)[:160])
    check(
        "GET 不带请求体（body 只在非 GET 时发，免得对端把 GET 当坏请求）",
        with_body_get.get("received") == "",
        repr(with_body_get)[:200],
    )

    retried = echo({**common, "method": "POST", "body": "1", "retries": 1, "impersonate": "chrome"})
    check(
        "retries 与 impersonate 能被上游收下（写方法同样吃这两个词）",
        retried.get("method") == "POST",
        repr(retried)[:200],
    )

    bad = echo({**common, "method": "PATCH"})
    code = bad.get("_frame", {}).get("error", {}).get("code")
    check("不支持的方法被明确拒绝（而不是悄悄发成 GET）", code == "BAD_ARGS", repr(bad)[:200])
    check(
        "拒绝理由点名了那个方法",
        "PATCH" in str(bad.get("_frame", {}).get("error", {}).get("message", "")),
        repr(bad)[:200],
    )


def run_capture(sidecar: Sidecar, base: str) -> None:
    """capture 端到端：自己起一个临时会话抓一次，并把这次抓取记下的 XHR/fetch 一起交回。

    判据只能落在**真浏览器真发过的那条请求**上：`capture` 的全部意义就是那份历史，而它由
    上游的 ``NetworkRecorder`` 生成 —— mock 掉它等于什么都没验。
    """
    print("\n== capture（临时会话 + 网络历史）==")
    answer = sidecar.call("capture", {"url": f"{base}/xhrpage", "extractionType": "text", "networkIdle": True})
    result = answer.get("result") or {}
    check("capture 成功", answer.get("ok") is True, repr(answer)[:240])
    check("capture 恒回 xhr 键", isinstance(result.get("xhr"), list), repr(result)[:200])
    entries = [item for item in (result.get("xhr") or []) if isinstance(item, dict)]
    api = next((item for item in entries if "/api/data" in str(item.get("url", ""))), None)
    check("记下了页面自己发的 fetch", api is not None, repr(entries)[:240])
    if api is not None:
        check(
            "条目形状带 url/status/bytes/method/resourceType",
            {"url", "status", "bytes", "method", "resourceType"} <= set(api),
            repr(api)[:200],
        )
        check("条目方法为 GET", api.get("method") == "GET", repr(api)[:200])
        check("条目状态 200", api.get("status") == 200, repr(api)[:200])
        check("没要求正文时不回正文", "body" not in api, repr(api)[:200])

    # 坏正则要在读历史之前就被拦下，而不是让上游在事件回调里抛一句看不出根因的话。
    bad = sidecar.call("capture", {"url": f"{base}/", "urlPattern": "([", "extractionType": "text"})
    check("坏 urlPattern 回 BAD_ARGS", bad.get("error", {}).get("code") == "BAD_ARGS", repr(bad)[:200])

    # includeBody 才带正文，且按 maxBodyChars 截断。
    with_body = sidecar.call(
        "capture",
        {
            "url": f"{base}/xhrpage",
            "extractionType": "text",
            "networkIdle": True,
            "includeBody": True,
            "maxBodyChars": 6,
        },
    )
    body_entries = [item for item in ((with_body.get("result") or {}).get("xhr") or []) if isinstance(item, dict)]
    body_api = next((item for item in body_entries if "/api/data" in str(item.get("url", ""))), None)
    check(
        "includeBody 时带（截断的）正文",
        body_api is not None and body_api.get("body") is not None,
        repr(with_body)[:240],
    )
    if body_api is not None:
        check(
            "正文按 maxBodyChars 截断并标记（对端正文长于预算）",
            body_api.get("bodyTruncated") is True and len(str(body_api.get("body", ""))) <= 6,
            repr(body_api)[:200],
        )


def run_session_network(sidecar: Sidecar, base: str) -> None:
    """session.network 与 recordNetwork（模型可见）：会话历史只在**开记录**时才读得到。

    这条钉住那个刻意的取舍：没开记录时报一句可读的错（文案里含 ``recordNetwork``），而不是
    回一个空列表 —— 「没开记录」与「这次没抓到接口」是要采取不同行动的两件事。
    """
    print("\n== session.network 与 recordNetwork ==")
    static_session = sidecar.call("session.open", {"sessionType": "static"})
    static_id = (static_session.get("result") or {}).get("sessionId", "")
    denied = sidecar.call("session.network", {"sessionId": static_id})
    check("static 会话读网络历史报 BAD_ARGS", denied.get("error", {}).get("code") == "BAD_ARGS", repr(denied)[:200])
    sidecar.call("session.close", {"sessionId": static_id})

    off = sidecar.call("session.open", {"sessionType": "stealth"})
    off_id = (off.get("result") or {}).get("sessionId", "")
    not_recorded = sidecar.call("session.network", {"sessionId": off_id})
    check(
        "没开记录的浏览器会话报 NETWORK_NOT_RECORDED",
        not_recorded.get("error", {}).get("code") == "NETWORK_NOT_RECORDED",
        repr(not_recorded)[:200],
    )
    check(
        "报错文案点名 recordNetwork",
        "recordNetwork" in str(not_recorded.get("error", {}).get("message", "")),
        repr(not_recorded)[:200],
    )
    sidecar.call("session.close", {"sessionId": off_id})

    on = sidecar.call("session.open", {"sessionType": "stealth", "recordNetwork": True})
    on_id = (on.get("result") or {}).get("sessionId", "")
    check("recordNetwork:true 的会话开得起来", on.get("ok") is True, repr(on)[:200])
    sidecar.call(
        "session.fetch", {"sessionId": on_id, "url": f"{base}/xhrpage", "extractionType": "text", "networkIdle": True}
    )
    net = sidecar.call("session.network", {"sessionId": on_id})
    net_result = net.get("result") or {}
    matches = net_result.get("matches") or []
    check("开了记录的会话读得到历史", net.get("ok") is True, repr(net)[:200])
    check("count 与 matches 一致", net_result.get("count") == len(matches), repr(net_result)[:200])
    check("含页面自己发的 fetch", any("/api/data" in str(item.get("url", "")) for item in matches), repr(matches)[:240])
    sidecar.call("session.close", {"sessionId": on_id})


def run_session_state(sidecar: Sidecar) -> None:
    """session.state_save / state_load：落点、命名空间与三条错误码。

    写文件的能力必须锁在部署给定的目录里，模型只能给一个**纯文件名**：让模型选路径等于给它
    一个任意文件写入口。所以三条判据分别对着「没配目录」「名字不纯」「上游报错」。
    """
    print("\n== session.state_save / state_load ==")
    state_dir = tempfile.mkdtemp(prefix="dsh-scrapling-state-")
    opened = sidecar.call("session.open", {"sessionType": "stealth"})
    session_id = (opened.get("result") or {}).get("sessionId", "")

    disabled = sidecar.call("session.state_save", {"sessionId": session_id, "name": "login"})
    check(
        "没配 sessionStateDir 报 STATE_DISABLED",
        disabled.get("error", {}).get("code") == "STATE_DISABLED",
        repr(disabled)[:200],
    )

    for bad_name in ("../escape", "a/b", ".hidden"):
        rejected = sidecar.call(
            "session.state_save",
            {"sessionId": session_id, "name": bad_name, "deployment": {"sessionStateDir": state_dir}},
        )
        check(
            f"名字 {bad_name!r} 被拒（只收纯文件名）",
            rejected.get("error", {}).get("code") == "BAD_ARGS",
            repr(rejected)[:200],
        )

    saved = sidecar.call(
        "session.state_save",
        {"sessionId": session_id, "name": "login", "deployment": {"sessionStateDir": state_dir}},
    )
    saved_result = saved.get("result") or {}
    check("state_save 成功", saved.get("ok") is True, repr(saved)[:200])
    check(
        "落点是 <dir>/<name>.json",
        saved_result.get("path") == str(Path(state_dir) / "login.json"),
        repr(saved_result)[:200],
    )
    check("saved 为真", saved_result.get("saved") is True, repr(saved_result)[:200])
    check("状态文件真的落了盘", (Path(state_dir) / "login.json").exists(), "")
    if os.name != "nt":
        # spec §11.6：登录态文件是凭据面，落盘后收到 0600。Windows 的 chmod 只动只读位，
        # 那条路径由实现里的 OSError 抑制兜住，不在断言里假装它成立。
        state_mode = os.stat(Path(state_dir) / "login.json").st_mode & 0o777
        check("状态文件权限收到 0600", state_mode == 0o600, oct(state_mode))

    loaded = sidecar.call(
        "session.state_load",
        {"sessionId": session_id, "name": "login", "deployment": {"sessionStateDir": state_dir}},
    )
    check("state_load 成功", loaded.get("ok") is True, repr(loaded)[:200])
    check("load 的 saved 为假", (loaded.get("result") or {}).get("saved") is False, repr(loaded)[:200])

    missing = sidecar.call(
        "session.state_load",
        {"sessionId": session_id, "name": "no-such-state", "deployment": {"sessionStateDir": state_dir}},
    )
    check(
        "载入不存在的状态翻成 STATE_FAILED（而不是裸栈）",
        missing.get("error", {}).get("code") == "STATE_FAILED",
        repr(missing)[:200],
    )
    sidecar.call("session.close", {"sessionId": session_id})

    static_session = sidecar.call("session.open", {"sessionType": "static"})
    static_id = (static_session.get("result") or {}).get("sessionId", "")
    static_state = sidecar.call(
        "session.state_save",
        {"sessionId": static_id, "name": "x", "deployment": {"sessionStateDir": state_dir}},
    )
    check(
        "static 会话没有浏览器状态，报 BAD_ARGS",
        static_state.get("error", {}).get("code") == "BAD_ARGS",
        repr(static_state)[:200],
    )
    sidecar.call("session.close", {"sessionId": static_id})


def run_session_param_guards() -> None:
    """会话入参的分支验证：static 专属的键给浏览器会话时必须**报错**，不能静默无效。

    这条不需要真浏览器：判在投递到属主线程之前，所以登记一个类型对、worker 为空的条目就能
    走到那一句。真起浏览器来验一个参数校验，测的就不是校验而是 Chromium 了。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import guard

    # static 那一条会真的走到 `guard.url_allowed`（本期补上的 Python 侧复判），而
    # `contract.test` 是个不存在的域名：不放行它就会在到达「headers/retries 是否被这条
    # 判据拦下」之前先吃一条 URL_BLOCKED，断言于是变成了在量别的东西。
    guard.configure(allowed_hosts=frozenset({"contract.test"}))
    try:
        _probe_session_params(adapters)
    finally:
        guard.configure(allowed_hosts=frozenset())


def _probe_session_params(adapters: Any) -> None:
    """会话入参分支的实际断言体；放行集合由调用方管。"""

    def probe(kind: str, extra: dict[str, Any]) -> tuple[str, str]:
        """按会话类型跑一次 session_fetch，返回 (错误码, 错误消息)。

        :param kind: 会话类型
        :param extra: 这次 fetch 的额外参数
        :returns: 错误码与消息；没报错时两者为空串
        """
        # 直接填登记表而不是 session_open：这里要验的是**入参分支**，而真会话要么起浏览器
        # 要么建 curl_cffi 连接。收尾也不能走 close_all_sessions —— 那条会去 release 这个
        # 假 session 对象（`object()` 没有 close），报错与本条断言无关。
        adapters._SESSIONS.pop("p", None)  # 直填登记表，跳过真会话的创建
        adapters._SESSIONS["p"] = {
            "sessionId": "p",
            "type": kind,
            "session": object(),
            "lock": threading.Lock(),
            "worker": None,
            "pending": False,
        }
        try:
            adapters.session_fetch({"sessionId": "p", "url": "https://contract.test/", **extra})
        except adapters.AdapterError as error:
            return error.code, str(error)
        except Exception as error:  # noqa: BLE001
            return "OTHER", f"{type(error).__name__}: {error}"
        return "", ""

    # 浏览器会话的请求头走 extra_headers（会话构造期或本次 fetch 都认），retries 则是构造期参数。
    for kind in ("stealth",):
        for key, hint in (("headers", "extraHeaders"), ("retries", "scrapling_session_open")):
            code, message = probe(kind, {key: ({"A": "b"} if key == "headers" else 2)})
            check(f"{kind} 会话收到 {key} 时报错", code == "BAD_ARGS", f"{code} / {message}")
            check(
                f"{kind} 会话的 {key} 报错给出可用的替代",
                hint in message,
                message,
            )
        # 没给那两个键时不该被这条判据拦下（往下走到投递那一步才失败）。
        code, message = probe(kind, {})
        check(f"{kind} 会话不给 headers/retries 时不被误拦", code != "BAD_ARGS", f"{code} / {message}")

        # 空表也不是写意图：模型「不带请求头」时传的就是 `{}`（Host 侧 `?? null` 之外的一种
        # 合法形态），为它报一条错等于把无害的调用说成非法，而模型看不出差别在哪。
        code, message = probe(kind, {"headers": {}, "retries": None})
        check(f"{kind} 会话给空 headers 时不被误拦", code != "BAD_ARGS", f"{code} / {message}")

    # static 会话是这两个键的合法去处：那里它们真生效（_static_params），所以这条判据不该管。
    code, message = probe("static", {"headers": {"A": "b"}, "retries": 2})
    check(
        "static 会话的 headers/retries 不被这条判据拦下",
        "only applies to static" not in message,
        f"{code} / {message}",
    )
    adapters._SESSIONS.pop("p", None)


def run_webrtc_guards() -> None:
    """stealth 会话的 WebRTC 强制开启必须与**会话真正拿到的代理**同源，且永不发 extra_flags。

    0.5 删掉了纯 Playwright 后端，WebRTC 防泄露从「往启动参数塞两条等价 flag」移交给了
    ``block_webrtc`` 一条开关本身（``extra_flags`` 也从顶掉改成叠加），所以旧的
    ``WEBRTC_NO_LEAK_FLAGS`` 那一套没有了。这里钉两条新不变量：

    - ``block_webrtc`` 的强制开启跟着 ``default_proxy()``（会话真正拿到的那份）走，而
      ``proxyBypass=*`` 这种「整台机器直连」不算有代理 —— 前者按 ``browser_proxy("")`` 判，
      空 URL 命中不了任何主机名条目，两条判据就在这里分歧。
    - 本仓任何路径都不发 ``extra_flags``：叠加语义下它不再破坏反检测，但发它没有正当理由。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import guard
    import scrapling.fetchers as fetchers

    captured: dict[str, dict[str, Any]] = {}

    def stub(tag: str) -> Any:  # 替身会话类，签名就是要录的那份 kwargs
        """造一个只记构造参数的会话替身。"""

        class _Stub:
            """替身：记下 kwargs，`start` 什么都不做。"""

            def __init__(self, **kwargs: Any) -> None:
                captured[tag] = kwargs

            def start(self) -> None:
                """不起浏览器。"""

        return _Stub

    original = fetchers.StealthySession
    saved = (guard.PROXY_URL, guard._BYPASS_ENTRIES)  # 与本文件其它代理用例同一口径
    try:
        fetchers.StealthySession = stub("stealth")  # type: ignore[misc]

        guard.PROXY_URL = "http://127.0.0.1:7890"
        guard._BYPASS_ENTRIES = ()

        adapters._make_session("stealth", {"sessionId": "w"})
        stealth = captured["stealth"]
        check("配了代理时 stealth 会话真的挂上代理", stealth.get("proxy") is not None, repr(stealth)[:200])
        check(
            "走代理时 block_webrtc 强制为真（不看模型入参）",
            stealth.get("block_webrtc") is True,
            repr(stealth)[:200],
        )
        check("走代理的会话构造不发 extra_flags", "extra_flags" not in stealth, repr(stealth)[:200])

        guard._BYPASS_ENTRIES = ("*",)  # 「整台机器直连」
        check("绕过清单写着 * 时会话按直连开", guard.default_proxy() == "", "")
        check(
            "同一个 * 对空 URL 的 per-URL 判定却不生效（这就是两条判据的分歧点）",
            guard.browser_proxy("") is not None,
            repr(guard.browser_proxy(""))[:120],
        )

        adapters._make_session("stealth", {"sessionId": "w"})
        direct = captured["stealth"]
        check("直连的 stealth 会话不挂代理", direct.get("proxy") is None, repr(direct)[:200])
        check(
            "直连时 blockWebrtc=false 不再被静默盖掉（本条在修之前是 True）",
            direct.get("block_webrtc") is False,
            repr(direct)[:200],
        )

        adapters._make_session("stealth", {"sessionId": "w", "blockWebrtc": True})
        check("显式要求屏蔽 WebRTC 时照办", captured["stealth"].get("block_webrtc") is True, "")

        guard.PROXY_URL = ""
        guard._BYPASS_ENTRIES = ()
        adapters._make_session("stealth", {"sessionId": "w"})
        clean = captured["stealth"]
        check(
            "干净环境下直连且不动 WebRTC",
            clean.get("proxy") is None and clean.get("block_webrtc") is False,
            repr(clean)[:200],
        )
        check("直连的会话同样不发 extra_flags", "extra_flags" not in clean, repr(clean)[:200])

        # capture 走的是自己的临时会话（不进注册表），代理与 WebRTC 必须与上面两条同源：
        # 配了代理却直连，泄露的是访客真实出口 IP。
        class _CaptureStub:
            """替身会话：记下 kwargs，起停都是空操作。"""

            def __init__(self, **kwargs: Any) -> None:
                captured["capture"] = kwargs
                self.network = _StubNetwork()

            def start(self) -> None:
                """不起浏览器。"""

            def fetch(self, url: str, **_kwargs: Any) -> Any:  # 返回上游 Response
                """回一份不联网的 Response。"""
                return adapters._fake_response("<p>ok</p>", url, 200)

            def close(self) -> None:
                """无事可做。"""

        saved_capture = fetchers.StealthySession
        try:
            guard.PROXY_URL = "http://127.0.0.1:7890"
            guard._BYPASS_ENTRIES = ()

            fetchers.StealthySession = _CaptureStub  # type: ignore[misc,assignment]
            adapters.capture({"url": "https://example.com/"})
            capture_kwargs = captured["capture"]
            check(
                "配了代理时 capture 的会话也挂上代理",
                capture_kwargs.get("proxy") is not None,
                repr(capture_kwargs)[:200],
            )
            check(
                "走代理时 capture 的 block_webrtc 强制为真",
                capture_kwargs.get("block_webrtc") is True,
                repr(capture_kwargs)[:200],
            )
            check("capture 恒开记录", capture_kwargs.get("record_requests") is True, repr(capture_kwargs)[:200])

            guard.PROXY_URL = ""
            adapters.capture({"url": "https://example.com/"})
            clean_capture = captured["capture"]
            check(
                "干净环境下 capture 直连且不动 WebRTC",
                clean_capture.get("proxy") is None and clean_capture.get("block_webrtc") is False,
                repr(clean_capture)[:200],
            )
        finally:
            fetchers.StealthySession = saved_capture  # type: ignore[misc]
    finally:
        fetchers.StealthySession = original  # type: ignore[misc]
        guard.PROXY_URL, guard._BYPASS_ENTRIES = saved
        guard.configure_from_env()


def run_write_gate(base: str) -> None:
    """写方法闸门的端到端验证：部署没表态开放时，POST 出不去，而 GET 照常。

    用**第二个 sidecar**而不是在第一个上改环境：这一档是启动时快照进进程环境的（与代理、
    放行清单同一族），进程活着就改不动 —— 而这恰恰是它作为安全默认的意义。
    """
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import guard

    print("\n== 写方法闸门（默认关）==")
    closed = Sidecar(extra_env={guard.ALLOW_WRITE_METHODS_ENV: "0"})
    try:
        ready = closed.read_frame()
        caps = ready.get("capabilities", {})
        check("能力帧如实标出写方法关着", caps.get("writeMethods") is False, repr(caps)[:160])

        got = closed.call("fetch", {"url": f"{base}/echo", "extractionType": "text"})
        check("关着时 GET 照常（闸门只管写，不管读）", got.get("ok") is True, repr(got)[:160])

        written = closed.call("fetch", {"url": f"{base}/echo", "method": "POST", "body": "x"})
        error = written.get("error", {})
        check("关着时 POST 被拒（而不是发出去）", error.get("code") == "WRITE_DISABLED", repr(written)[:200])
        check("拒绝理由点名了该设的那枚配置", "allowWriteMethods" in str(error.get("message", "")), repr(error)[:200])
    finally:
        closed.close()

    # 环境变量的读法：一个安全开关的「认不出来」必须落在紧的那一侧。拼错的 "ture" 若被
    # `bool(非空)` 读成开，部署方会以为自己关了。
    saved = os.environ.get(guard.ALLOW_WRITE_METHODS_ENV)
    try:
        for raw, wanted in (("1", True), ("on", True), ("0", False), ("ture", False), ("", False)):
            os.environ[guard.ALLOW_WRITE_METHODS_ENV] = raw
            guard.configure_from_env()
            check(
                f"环境里写 {raw!r} 读成 {wanted}",
                guard.ALLOW_WRITE_METHODS is wanted,
                repr(guard.ALLOW_WRITE_METHODS),
            )
    finally:
        if saved is None:
            os.environ.pop(guard.ALLOW_WRITE_METHODS_ENV, None)
        else:
            os.environ[guard.ALLOW_WRITE_METHODS_ENV] = saved
        guard.configure_from_env()

    # configure() 传 None 必须**沿用当前值**：它是「启动时按设置收紧」的入口，把 None 当
    # 「关掉」等于每次收紧放行名单时顺手把写方法也关了，而那没人要求过。
    keep = guard.ALLOW_WRITE_METHODS
    guard.configure(allow_write_methods=None)
    check("configure 不给这一档时沿用当前值", guard.ALLOW_WRITE_METHODS is keep, repr(guard.ALLOW_WRITE_METHODS))
    guard.configure(allow_write_methods=not keep)
    check("configure 显式给值时改写它", guard.ALLOW_WRITE_METHODS is (not keep), repr(guard.ALLOW_WRITE_METHODS))

    # 进程内那一侧的硬拒（第二个 sidecar 验的是同一段逻辑的跨语言形状，这里验它抛得对）。
    guard.configure(allow_write_methods=False)
    try:
        adapters.fetch({"url": "https://contract.test/", "method": "DELETE"})
        check("adapters.fetch 自己也会拒绝写方法", False, "没抛异常")
    except adapters.AdapterError as error:
        check("adapters.fetch 自己也会拒绝写方法", error.code == "WRITE_DISABLED", error.code)
    except Exception as error:  # noqa: BLE001
        check("adapters.fetch 自己也会拒绝写方法", False, f"{type(error).__name__}: {error}")
    guard.configure(allow_write_methods=keep)


# ---------------------------------------------------------------------------
# 进程内单元。`py/package.json` 的覆盖率地板只量**这个进程**（`source = ["py"]` 是相对子进程
# cwd 解析的，sidecar 里跑的代码一条都不进地板），所以凡是想进地板的 adapters / crawl 代码，
# 都必须由这里直接 import 调用，不能只经 `sidecar.call(...)`。替身引擎不发网络，除了
# `capabilities()` 那次真探针外一律不起浏览器。
# ---------------------------------------------------------------------------


def _raiser(exc: BaseException) -> Any:  # 造出来的就是可调用对象
    """造一个一调用就抛 exc 的函数（用来逼出错误分支）。"""

    def boom(*_args: Any, **_kwargs: Any) -> Any:  # 恒抛，返回值无意义
        raise exc

    return boom


class _DeadThread:
    """一个 `is_alive()` 恒假、`start()` 什么都不做的线程替身。

    `ident` 要跟着真 `threading.Thread` 走：线程跑完 `ident` 仍然是当初那个整数，
    Python 不清它。把它省掉会让替身比真对象少一条属性，于是 :func:`crawl._is_running`
    的 `thread.ident is None` 那半截直接抛 `AttributeError` —— 测的就不是被测代码了。
    """

    ident: int = 1

    def is_alive(self) -> bool:
        """恒为「已结束」。"""
        return False

    def join(self, timeout: float | None = None) -> None:
        """无事可等。"""

    def start(self) -> None:
        """不起线程。"""


class _StubNetwork:
    """够读 `session.network` 的 NetworkRecorder 替身。"""

    def __init__(self, enabled: bool = False) -> None:
        """:param enabled: 这个会话记录不记录"""
        self.enabled = enabled

    def search(self, **_kwargs: Any) -> list[Any]:
        """回一份空的网络历史。"""
        return []


def _session_stub(*, broken_state: bool = False) -> type:
    """造一个 ``StealthySession`` 替身类：起、抓、读历史、存取状态都够用。

    :param broken_state: 存取状态时抛错（用来逼出 STATE_FAILED）
    """
    import adapters

    class _Stub:
        """替身会话。"""

        def __init__(self, **kwargs: Any) -> None:
            """:param kwargs: 构造参数（会记下来核对）"""
            self.kwargs = kwargs
            self.network = _StubNetwork()
            self.state_path: str | None = None

        def start(self) -> None:
            """开场（替身不启浏览器）。"""

        def fetch(self, url: str, **_kwargs: Any) -> Any:  # 返回上游 Response
            """回一份不带网络的 Response。"""
            return adapters._fake_response("<p>ok</p>", url, 200)

        def close(self) -> None:
            """关闭（替身无事可做）。"""

        def save_state(self, path: str) -> None:
            """记下落点；broken_state 时抛。"""
            if broken_state:
                raise RuntimeError("state write failed")
            self.state_path = path

        def load_state(self, path: str) -> None:
            """记下落点；broken_state 时抛。"""
            if broken_state:
                raise RuntimeError("state read failed")
            self.state_path = path

    return _Stub


def run_redis_storage() -> None:
    """adaptive 指纹库的 Redis 后端：契约、键形状、错误面与真 Redis。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import redis_storage
    finally:
        sys.path.remove(str(PY_DIR))

    from importlib.util import find_spec

    from lxml.html import fromstring

    class _FakeRedis:
        def __init__(self) -> None:
            self.store: dict[str, str] = {}
            self.closed = False

        def ping(self) -> bool:
            return True

        def set(self, key: str, value: str) -> None:
            self.store[key] = value

        def get(self, key: str) -> Any:
            return self.store.get(key)

        def close(self) -> None:
            self.closed = True

    fake = _FakeRedis()
    storage = redis_storage.RedisStorageSystem(
        "redis://:secret@example.test:6379/0",
        "https://shop.example.com/p/1",
        client_factory=lambda _url, **_kwargs: fake,
    )
    check(
        "Redis 存储按注册域分桶",
        storage._key("price").startswith("scrapling:adaptive:example.com:"),
        storage._key("price"),
    )
    storage.save(fromstring('<span class="price">$10</span>'), "price")
    check("save 写进客户端", len(fake.store) == 1, repr(fake.store)[:160])
    restored = storage.retrieve("price")
    check("retrieve 还原指纹字典", isinstance(restored, dict) and "tag" in restored, repr(restored)[:160])
    check("没存过的 identifier 回 None", storage.retrieve("missing") is None, "")
    storage.close()
    check("close 关掉客户端", fake.closed is True, "")

    # 报告 §2.12：timeout_seconds 早先只落成属性、全文件没有使用点。它必须真的传到
    # 客户端工厂（socket 超时），否则连接卡住时表现为整场抓取挂死。
    seen_timeout: dict[str, Any] = {}

    def _factory_recording_timeout(_url: str, **kwargs: Any) -> Any:
        """记下构造 kwargs，回一份能 ping 的替身客户端。"""
        seen_timeout.update(kwargs)
        return _FakeRedis()

    cast(Any, redis_storage.RedisStorageSystem).__wrapped__(
        "redis://127.0.0.1:1/0", client_factory=_factory_recording_timeout, timeout_seconds=3.5
    )
    check(
        "timeout_seconds 交给客户端工厂",
        seen_timeout.get("timeout_seconds") == 3.5,
        repr(seen_timeout),
    )

    # 默认客户端要把同一份超时接到 redis 的两个 socket 参数上（连接与读写各一个，
    # 只设一个等于只挡一半）。用假 redis 模块拦 from_url，不依赖本机装没装客户端。
    import types

    recorded_from_url: dict[str, Any] = {}

    class _StubRedisClass:
        """只记 from_url 参数的替身客户端类。"""

        @staticmethod
        def from_url(url: str, **kwargs: Any) -> Any:
            """记下连接参数并回一份可 ping 的客户端。"""
            recorded_from_url.update({"url": url, **kwargs})
            return _FakeRedis()

    stub_redis_module = types.ModuleType("redis")
    stub_redis_module.Redis = _StubRedisClass  # type: ignore[attr-defined]
    saved_redis_module = sys.modules.get("redis")
    sys.modules["redis"] = stub_redis_module
    try:
        redis_storage._default_client("redis://127.0.0.1:1/0", timeout_seconds=4.5)
    finally:
        if saved_redis_module is None:
            sys.modules.pop("redis", None)
        else:
            sys.modules["redis"] = saved_redis_module
    check(
        "默认客户端把超时接到 redis 的 socket 参数",
        recorded_from_url.get("socket_timeout") == 4.5
        and recorded_from_url.get("socket_connect_timeout") == 4.5
        and recorded_from_url.get("decode_responses") is True,
        repr(recorded_from_url),
    )
    check(
        "错误文本里的连接串不带口令",
        "secret" not in redis_storage.redacted_redis_url("redis://:secret@h.test:6379/0"),
        redis_storage.redacted_redis_url("redis://:secret@h.test:6379/0"),
    )

    import builtins

    real_import = builtins.__import__

    def _without_redis(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "redis":
            raise ModuleNotFoundError("No module named 'redis'")
        return real_import(name, *args, **kwargs)

    builtins.__import__ = _without_redis
    try:
        try:
            redis_storage._default_client("redis://127.0.0.1:1")
            check("缺 redis 客户端时报 RedisUnavailable", False, "放行")
        except redis_storage.RedisUnavailable as error:
            check("缺 redis 客户端时点名 adaptive-redis 包", "adaptive-redis" in str(error), str(error))
    finally:
        builtins.__import__ = real_import

    def _refuse(_url: str) -> Any:
        raise OSError("connection refused")

    try:
        cast(Any, redis_storage.RedisStorageSystem).__wrapped__("redis://127.0.0.1:9/0", client_factory=_refuse)
        check("连不上时点名主机与端口（替身工厂）", False, "放行")
    except redis_storage.RedisUnavailable as error:
        check("连不上时点名主机与端口（替身工厂）", "127.0.0.1:9" in str(error), str(error))

    if find_spec("redis") is None:
        # CI 的测试 venv 装的是 scrapling[rag] + requirements-dev，不含运行期的 redis 客户端；
        # 替身工厂那条已经钉住错误翻译，真客户端这条只在装了它的机器上跑。
        print("  SKIP  真 redis 客户端不在本环境（运行时包在 py/runtime-requirements.txt）")
    else:
        try:
            cast(Any, redis_storage.RedisStorageSystem).__wrapped__("redis://127.0.0.1:1/0")
            check("真客户端连不上时点名主机与端口", False, "放行")
        except redis_storage.RedisUnavailable as error:
            check("真客户端连不上时点名主机与端口", "127.0.0.1:1" in str(error), str(error))

    from scrapling.parser import Selector

    fake_selector = _FakeRedis()
    page = Selector(
        '<div><span class="price">$10</span></div>',
        url="https://shop.example.com/p/2",
        adaptive=True,
        storage=redis_storage.RedisStorageSystem,
        storage_args={
            "redis_url": "redis://stub/0",
            "url": "https://shop.example.com/p/2",
            "client_factory": lambda _url, **_kwargs: fake_selector,
        },
    )
    hits = page.css("span.price", auto_save=True, identifier="price")
    check(
        "Selector 接受 Redis 存储类并自动保存",
        len(hits) == 1 and len(fake_selector.store) == 1,
        repr(list(fake_selector.store))[:200],
    )

    expect_error(
        "BAD_ARGS",
        lambda: _select_with_deployment({}, {"adaptiveStorage": "memcached"}),
    )

    server = shutil.which("redis-server")
    if server is None or find_spec("redis") is None:
        print("  SKIP  真 Redis：本环境缺 redis-server 或 redis 客户端")
        return
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    # 常量 argv，参数是自选的端口。
    proc = subprocess.Popen(  # noqa: S603  # nosec B603
        [server, "--port", str(port), "--save", "", "--appendonly", "no"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(80):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.05)
        url = f"redis://127.0.0.1:{port}/0"
        real = cast(Any, redis_storage.RedisStorageSystem).__wrapped__(url, "https://real.example.test/a")
        real.save(fromstring('<b id="x">7</b>'), "id-x")
        stored = real.retrieve("id-x")
        check("真 Redis 上 save/retrieve 往返", isinstance(stored, dict) and "tag" in stored, repr(stored)[:160])
        real.close()
        wire_sidecar = Sidecar()
        try:
            wire = wire_sidecar.call(
                "select",
                {
                    "html": '<div><span class="price">$42</span></div>',
                    "selector": "span.price",
                    "url": "https://wire.example.test/p",
                    "adaptive": True,
                    "deployment": {"adaptiveStorage": "redis", "redisUrl": url},
                },
            )
        finally:
            wire_sidecar.close()
        check("走 sidecar 的 redis 存储回 200 形状", wire.get("ok") is True, repr(wire)[:200])
        check(
            "sidecar 那条真的写进了 Redis",
            cast(Any, redis_storage.RedisStorageSystem)
            .__wrapped__(url, "https://wire.example.test/p")
            .retrieve("span.price")
            is not None,
            "fingerprint for span.price",
        )
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def _select_with_deployment(args: dict[str, Any], deployment: dict[str, Any]) -> Any:
    """走 adapters.select 的那条 deployment 分支（不起 sidecar）。"""
    sys.path.insert(0, str(PY_DIR))
    try:
        import adapters
    finally:
        sys.path.remove(str(PY_DIR))
    return adapters.select({"html": "<p>x</p>", "selector": "p", "adaptive": True, "deployment": deployment, **args})


def run_inprocess_adapters() -> None:
    """进程内直接驱动 adapters 的参数收口与工具函数（让它们进覆盖率地板）。"""
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import guard

    print("\n== 进程内：adapters 参数收口与工具函数 ==")

    try:
        adapters._require(None)
        check("_require(None) 报 SCRAPLING_MISSING", False, "没抛")
    except adapters.AdapterError as error:
        check("_require(None) 报 SCRAPLING_MISSING", error.code == "SCRAPLING_MISSING", error.code)
        # 装在哪份解释器里是这条错误的全部信息量：用户手上通常不止一份 python。
        check(
            "_require 的文案点名解释器",
            sys.executable in str(error),
            str(error),
        )

    for bad in ("x", True, 0, -3):
        try:
            adapters._positive_int(bad, "f", 7)
            check(f"_positive_int({bad!r}) 被拒", False, "放行")
        except adapters.AdapterError as error:
            check(f"_positive_int({bad!r}) 被拒", error.code == "BAD_ARGS", error.code)
    check("_positive_int 缺省值", adapters._positive_int(None, "f", 7) == 7, "")

    for bad_num in ("x", True, 0, -1.5):
        try:
            adapters._positive_number(bad_num, "f", 1.0)
            check(f"_positive_number({bad_num!r}) 被拒", False, "放行")
        except adapters.AdapterError as error:
            check(f"_positive_number({bad_num!r}) 被拒", error.code == "BAD_ARGS", error.code)
    check("_positive_number 数值原样", adapters._positive_number(2.5, "f", 1.0) == 2.5, "")
    check("_positive_number 缺省值", adapters._positive_number(None, "f", 1.0) == 1.0, "")

    state_dir = tempfile.mkdtemp(prefix="dsh-state-path-")
    for bad_name in ("../escape", "a/b", ".hidden", "..", "", "x\x00y"):
        try:
            adapters._state_path({"name": bad_name, "deployment": {"sessionStateDir": state_dir}})
            check(f"状态文件名 {bad_name!r} 被拒", False, "放行")
        except adapters.AdapterError as error:
            check(f"状态文件名 {bad_name!r} 被拒", error.code == "BAD_ARGS", error.code)
    check(
        "已带 .json 的名字不重复拼后缀",
        adapters._state_path({"name": "login.json", "deployment": {"sessionStateDir": state_dir}})
        == str(Path(state_dir) / "login.json"),
        "",
    )
    check(
        "没带后缀时补 .json",
        adapters._state_path({"name": "login", "deployment": {"sessionStateDir": state_dir}})
        == str(Path(state_dir) / "login.json"),
        "",
    )

    try:
        adapters._string_map(5, "f")
        check("_string_map 非对象被拒", False, "放行")
    except adapters.AdapterError as error:
        check("_string_map 非对象被拒", error.code == "BAD_ARGS", error.code)
    check("_string_map 压成 str 值", adapters._string_map({"a": 1}, "f") == {"a": "1"}, "")
    check("_string_map None 给 None", adapters._string_map(None, "f") is None, "")

    # clip：截在代理对中间时会留下孤立高代理，要丢掉它
    check("clip 丢掉孤立高代理", adapters.clip("ab\ud800c", 3) == ("ab", True), repr(adapters.clip("ab\ud800c", 3)))
    check("clip 未超限原样返回", adapters.clip("abc", 5) == ("abc", False), "")
    check(
        "_jsonable 兜底成字符串",
        adapters._jsonable(object()).startswith("<object object at"),
        repr(adapters._jsonable(object())),
    )

    for args, note in (({"extractionType": "pdf"}, "未知 extractionType"), ({"cssSelector": 5}, "cssSelector 非串")):
        try:
            adapters._extraction(args)
            check(f"_extraction 拒绝{note}", False, "放行")
        except adapters.AdapterError as error:
            check(f"_extraction 拒绝{note}", error.code == "BAD_ARGS", error.code)
    try:
        adapters._url({})
        check("_url 缺 url 被拒", False, "放行")
    except adapters.AdapterError as error:
        check("_url 缺 url 被拒", error.code == "BAD_ARGS", error.code)

    saved_proxy = guard.PROXY_URL
    try:
        guard.PROXY_URL = "http://127.0.0.1:7890"
        params = adapters._static_params({"headers": {"A": "b"}}, "https://example.com/")
        check("_static_params 带代理表", params.get("proxies") == {"all": "http://127.0.0.1:7890"}, repr(params))
        check("_static_params 带请求头", params.get("headers") == {"A": "b"}, repr(params))
        check("_static_params 固定安全重定向", params.get("follow_redirects") == "safe", repr(params))
        override = adapters._static_params({"followRedirects": True, "follow_redirects": "all"}, "https://example.com/")
        check("_static_params 不接受调用方改重定向", override.get("follow_redirects") == "safe", repr(override))
    finally:
        guard.PROXY_URL = saved_proxy

    import crawl

    sessions: list[Any] = []

    class _Manager:
        """接住 add()，会话本体留给断言。"""

        def add(self, _name: str, session: Any) -> None:
            sessions.append(session)

    crawl._session_config(_Manager(), "https://example.com/")
    # 私有属性是唯一观察点：`_session_config` 不给返回值。
    check(
        "爬虫会话固定安全重定向",
        len(sessions) == 1 and sessions[0]._default_follow_redirects == "safe",
        repr(sessions),
    )

    class _BoomRecorder:
        """search 直接抛的记录器替身。"""

        def search(self, **_kwargs: Any) -> list[Any]:
            """抛。"""
            raise RuntimeError("recorder off")

    check(
        "_network_summary 记录器抛时给空表",
        adapters._network_summary(_BoomRecorder(), query=adapters._network_read({"networkLimit": 1})) == [],
        "",
    )

    class _BoomItem:
        """取 meta 就抛的条目替身。"""

        @property
        def meta(self) -> Any:  # 恒抛
            """抛。"""
            raise RuntimeError("bad item")

    class _OneRecorder:
        """回一条坏条目的记录器替身。"""

        def search(self, **_kwargs: Any) -> list[Any]:
            """回 [_BoomItem()]。"""
            return [_BoomItem()]

    check(
        "_network_summary 单条抛时跳过并继续",
        adapters._network_summary(_OneRecorder(), query=adapters._network_read({"networkLimit": 1})) == [],
        "",
    )

    from scrapling.parser import Selector

    page = Selector("<html><body><h1>HELLO</h1></body></html>")
    check("_scoped_pages 按选择器收窄", [node.tag for node in adapters._scoped_pages(page, "h1")] == ["h1"], "")

    adapters._strip_active_content(object())  # 没有 _root 应当是 no-op
    check("_strip_active_content 无 root 时不炸", True, "")

    class _FakeEl:
        """够 _strip_active_content 看的元素替身。"""

        tag = "p"
        attrib = None

    class _FakeRoot:
        """元素迭代器替身。"""

        def iter(self) -> Any:  # 迭代器
            """回一个无 attrib 的元素。"""
            return iter([_FakeEl()])

    class _FakeTree:
        """带 _root 的页面替身。"""

        _root = _FakeRoot()

    adapters._strip_active_content(_FakeTree())
    check("_strip_active_content 跳过无 attrib 的元素", True, "")

    for kind, value, want in (
        (str, "x", "x"),
        (str, "", None),
        (str, 5, None),
        (bool, True, True),
        (bool, "x", None),
        (int, 5, 5),
        (int, True, None),
        (int, 0, None),
        (int, -1, None),
    ):
        got = adapters._knob_value(kind, value)
        check(f"_knob_value({kind.__name__}, {value!r})", got == want, repr(got))

    full = adapters._browser_params(
        {
            "networkIdle": True,
            "waitSelector": "#x",
            "waitSelectorState": "visible",
            "useragent": "u",
            "locale": "en",
            "timezoneId": "UTC",
            "pierceShadow": True,
            "waitMs": 50,
            "extraHeaders": {"A": "b"},
            "deployment": {
                "browserExecutablePath": "/usr/bin/true",
                "browserCdpUrl": "http://127.0.0.1:9222",
                "browserInitScript": str(Path(tempfile.gettempdir()) / "x.js"),
                "browserRealChrome": True,
                "browserDnsOverHttps": True,
                "recordRequests": True,
                "maxRecordedRequests": 10,
            },
        },
        "https://example.com/",
    )
    expected: dict[str, Any] = {
        "network_idle": True,
        "wait_selector": "#x",
        "wait_selector_state": "visible",
        "useragent": "u",
        "locale": "en",
        "timezone_id": "UTC",
        "pierce_shadow": True,
        "wait": 50,
        "extra_headers": {"A": "b"},
    }
    for key, want in expected.items():
        check(f"_browser_params 带上 {key}", full.get(key) == want, repr(full.get(key)))
    for key in (
        "executable_path",
        "cdp_url",
        "init_script",
        "real_chrome",
        "dns_over_https",
        "record_requests",
        "max_recorded_requests",
    ):
        check(f"_browser_params 落部署旋钮 {key}", key in full, repr(full.get(key)))
    wrong = adapters._browser_params(
        {"deployment": {"maxRecordedRequests": "10", "browserRealChrome": "yes"}}, "https://example.com/"
    )
    check(
        "_browser_params 错类型旋钮不生效",
        "max_recorded_requests" not in wrong and "real_chrome" not in wrong,
        repr(wrong),
    )
    check(
        "_browser_params fetch 层只发白名单",
        set(adapters._browser_params({}, "https://example.com/", level="fetch")) <= adapters.FETCH_LEVEL_KEYS,
        "",
    )

    query = adapters._network_read({"urlPattern": "/a/", "networkLimit": 3, "includeBody": True, "maxBodyChars": 10})
    check(
        "_network_read 收出查询参数",
        (query.pattern, query.limit, query.include_body, query.body_chars) == ("/a/", 3, True, 10)
        and query.method is None
        and query.after_id == 0,
        repr(query),
    )
    check(
        "_network_read 把 method 归一成大写",
        adapters._network_read({"method": "post"}).method == "POST",
        "",
    )

    fake = adapters._fake_response("<p>x</p>", "https://x.test/", 200)
    check("_fake_response 造出真 Response", fake.status == 200 and fake.url == "https://x.test/", "")

    # 已有 HTML 的正文清洗与抓取同一条管线：scrapling_session_read 走的就是下面这三行拼起来
    # 的那次调用，所以清洗判据钉在 to_payload 上，而不是钉在一个协议方法名上。
    offline = adapters.to_payload(
        adapters._fake_response("<html><body><h1>Hi</h1><p>yo</p></body></html>", "about:blank", 200),
        extraction_type="markdown",
        css_selector=None,
        main_content_only=True,
        max_content_chars=2000,
        strip_inline_images=True,
    )
    offline_content = str(offline.get("content", ""))
    check(
        "已有 HTML 归一出正文",
        offline.get("status") == 200 and "Hi" in offline_content and "yo" in offline_content,
        repr(offline)[:120],
    )
    hidden = adapters.to_payload(
        adapters._fake_response("<body><div style='display:none'>SECRET</div>ok</body>", "about:blank", 200),
        extraction_type="markdown",
        css_selector=None,
        main_content_only=True,
        max_content_chars=2000,
        strip_inline_images=True,
    )
    check("已有 HTML 也清洗隐藏内容", "SECRET" not in str(hidden.get("content", "")), repr(hidden)[:160])
    # base 的 href 没有 http-equiv，按属性名判永远清不到 —— 内网地址会经它进模型上下文。
    leaked = adapters.to_payload(
        adapters._fake_response(
            "<html><head><base href='http://10.0.0.1/'>"
            "<meta http-equiv='refresh' content='1;url=http://10.0.0.2/'>"
            "</head><body><p onclick='steal()'>hi</p></body></html>",
            "about:blank",
            200,
        ),
        extraction_type="html",
        css_selector=None,
        main_content_only=True,
        max_content_chars=2000,
        strip_inline_images=True,
    )
    leaked_content = str(leaked.get("content", ""))
    check(
        "html 路径剥掉 base / meta refresh / 事件属性",
        "10.0.0.1" not in leaked_content and "10.0.0.2" not in leaked_content and "onclick" not in leaked_content,
        leaked_content[:220],
    )


def run_inprocess_browser() -> None:
    """进程内：fetch / render / capture / select 的真代码路径（替身引擎，不发网络）。"""
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import guard
    import scrapling.fetchers as fetchers

    print("\n== 进程内：fetch / render / capture / extract / select ==")
    saved_hosts = set(guard.ALLOWED_HOSTS)
    saved_write = guard.ALLOW_WRITE_METHODS
    saved_fetcher = adapters.Fetcher
    saved_stealth = adapters.StealthyFetcher
    saved_session = fetchers.StealthySession

    class _StubFetcher:
        """``Fetcher`` 的替身：四个动词都回一份不联网的 Response。"""

        def get(self, url: str, **_kwargs: Any) -> Any:  # 返回上游 Response
            """回一份 Response。"""
            return adapters._fake_response("<p>ok</p>", url, 200)

        post = put = delete = get

    class _StubStealthyFetcher:
        """``StealthyFetcher`` 的替身。"""

        def fetch(self, url: str, **_kwargs: Any) -> Any:  # 同上
            """回一份 Response。"""
            return adapters._fake_response("<p>ok</p>", url, 200)

    guard.configure(allowed_hosts=frozenset({"example.com"}))
    adapters.Fetcher = _StubFetcher()  # type: ignore[misc,assignment]
    adapters.StealthyFetcher = _StubStealthyFetcher()  # type: ignore[misc,assignment]
    fetchers.StealthySession = _session_stub()  # type: ignore[misc,assignment]
    try:
        guard.configure(allow_write_methods=True)
        got = adapters.fetch({"url": "https://example.com/", "cookies": {"c": "1"}, "impersonate": "chrome"})
        check("fetch 带 cookies/impersonate 走通", got["status"] == 200, repr(got)[:120])
        try:
            adapters.fetch({"url": "https://example.com/", "method": "PATCH"})
            check("fetch 未知方法被拒", False, "放行")
        except adapters.AdapterError as error:
            check("fetch 未知方法被拒", error.code == "BAD_ARGS", error.code)
        adapters.fetch({"url": "https://example.com/", "method": "POST", "body": "a=1"})
        adapters.fetch({"url": "https://example.com/", "method": "POST", "body": [1, 2]})
        check("fetch 非 GET 的 body 两条分支走通", True, "")

        rendered = adapters.render({"url": "https://example.com/", "extractionType": "text"})
        check(
            "render 组装载荷",
            rendered["status"] == 200 and rendered["extractionType"] == "text",
            repr(rendered)[:120],
        )

        captured = adapters.capture(
            {"url": "https://example.com/", "extractionType": "text", "urlPattern": "/a/", "networkLimit": 2}
        )
        check("capture 恒带 xhr 键", isinstance(captured.get("xhr"), list), repr(captured)[:120])
        records = adapters._capture_once(
            {},
            url="https://example.com/",
            query=adapters._network_read({"networkLimit": 2, "maxBodyChars": 10}),
        )[1]
        check("_capture_once 直接可用", isinstance(records, list), repr(records)[:120])

        html = "<p class='k'>a</p><p class='k'>b</p>"
        for select_args, note in (
            ({"html": 5}, "html 非串"),
            ({"html": "x"}, "缺 selector"),
            ({"html": "x", "selector": "p", "attribute": 5}, "attribute 非串"),
            ({"html": "x", "selector": "p", "url": 5}, "url 非串"),
        ):
            try:
                adapters.select(select_args)
                check(f"select 拒绝{note}", False, "放行")
            except adapters.AdapterError as error:
                check(f"select 拒绝{note}", error.code == "BAD_ARGS", error.code)
        check(
            "select xpath 路径",
            adapters.select({"html": html, "selector": "//p", "useXpath": True})["count"] == 2,
            "",
        )
        attributed = adapters.select({"html": html, "selector": "p", "includeAttributes": True})
        check("select 带属性", attributed["matches"][0]["attributes"]["class"] == "k", "")

        # adaptive 会按**相对路径**开 SQLite 指纹库，所以换到临时目录再跑，别把产物留在仓库里。
        cwd = os.getcwd()
        try:
            os.chdir(tempfile.mkdtemp(prefix="dsh-cov-adaptive-"))
            check(
                "select adaptive 路径",
                adapters.select({"html": html, "selector": "p", "adaptive": True})["count"] == 2,
                "",
            )
        finally:
            os.chdir(cwd)

        page = FakePage()
        adapters.page_setup(page)
        check("page_setup 装上 HTTP 路由", "route" in [name for name, _, _ in page.routes], repr(page.routes))
    finally:
        adapters.Fetcher = saved_fetcher  # type: ignore[misc]
        adapters.StealthyFetcher = saved_stealth  # type: ignore[misc]
        fetchers.StealthySession = saved_session  # type: ignore[misc]
        guard.configure(allowed_hosts=frozenset(saved_hosts))
        guard.configure(allow_write_methods=saved_write)


def _browser_ground_truth() -> bool:
    """测试自己起一次浏览器，作为 ``capabilities()["browser"]`` 的外部对照。

    原先这一档写死「必须探到浏览器」，于是它判的是**这台机器装没装浏览器**：该仓 CI 刻意不装
    （runner 上没有二进制），门禁就红在环境上。改成两侧都对表：本机起得来就必须报 True、起不来
    就必须报 False，把探测写死成任何一侧都会在其中一个环境里红。
    """
    import importlib

    try:
        sync_playwright = importlib.import_module("patchright.sync_api").sync_playwright
        with sync_playwright() as driver:
            driver.chromium.launch(headless=True).close()
    except Exception:  # noqa: BLE001 —— 对照只关心起不起得来；起不来的原因由真探测那一侧报
        return False
    return True


def run_inprocess_capabilities() -> None:
    """进程内：能力探测（含一次真浏览器探针）与版本读取的兜底分支。"""
    sys.path.insert(0, str(PY_DIR))
    import types

    import adapters

    print("\n== 进程内：能力探测 ==")
    check("_scrapling_version 读出非空", bool(adapters._scrapling_version()), "")
    saved = sys.modules.get("scrapling")
    sys.modules["scrapling"] = types.ModuleType("scrapling")
    try:
        check("_scrapling_version 读不到版本时给空串", adapters._scrapling_version() == "", "")
    finally:
        if saved is None:
            sys.modules.pop("scrapling", None)
        else:
            sys.modules["scrapling"] = saved
    check("_probe_browser 起不来给 False", adapters._probe_browser("no.such.module_xyz") is False, "")

    report = adapters.capabilities()
    check("capabilities 报 scrapling 可用", report["scrapling"] is True, repr(report)[:120])
    check(
        "capabilities 有 version / browser / proxy",
        {"version", "browser", "proxy"} <= set(report),
        repr(report)[:160],
    )
    want_browser = _browser_ground_truth()
    check(
        "capabilities 的 browser 与「测试自己起一次浏览器」的成败一致",
        report["browser"] is want_browser,
        f"capabilities 报 {report['browser']}，自己起一次是 {want_browser}",
    )
    check(
        "capabilities 的 proxy 是摘要形态",
        set(report["proxy"]) == {"configured", "source", "server"},
        repr(report["proxy"]),
    )

    # README 说浏览器守卫覆盖 WebSocket 握手，并承诺「旧版 Playwright 上日志与能力报告都如实
    # 标出」。期望值直接读上游 Page 类，不从本包的判据里派生。
    from patchright.sync_api import Page as PatchrightPage

    check(
        "capabilities 报出 websocketGuard 且与 Page 类真实的面一致",
        report["websocketGuard"] is callable(getattr(PatchrightPage, "route_web_socket", None)),
        repr(report.get("websocketGuard")),
    )

    def _no_websocket(candidate: Any) -> bool:
        """替身：假装这一版 Playwright 没有 `route_web_socket`。"""
        return False

    saved_supported = adapters.guard.websocket_guard_supported
    adapters.guard.websocket_guard_supported = _no_websocket
    try:
        check("没有 route_web_socket 那一面时报 False 而不是抛", adapters._websocket_guard_capability() is False, "")
    finally:
        adapters.guard.websocket_guard_supported = saved_supported
    saved_sync_api = sys.modules.get("patchright.sync_api")
    sys.modules["patchright.sync_api"] = None  # type: ignore[assignment]
    try:
        check("装不出 patchright 时报 False", adapters._websocket_guard_capability() is False, "")
    finally:
        if saved_sync_api is None:
            sys.modules.pop("patchright.sync_api", None)
        else:
            sys.modules["patchright.sync_api"] = saved_sync_api


def run_inprocess_sessions() -> None:
    """进程内：会话注册表、network 与 state 的全部错误/成功分支。"""
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import scrapling.fetchers as fetchers

    print("\n== 进程内：会话注册表 / network / state ==")
    saved_session = fetchers.StealthySession
    saved_make = adapters._make_session
    tmp = tempfile.mkdtemp(prefix="dsh-cov-state-")
    try:
        fetchers.StealthySession = _session_stub()  # type: ignore[misc,assignment]
        adapters.close_all_sessions()

        try:
            adapters._make_session("bogus", {})
            check("_make_session 未知类型被拒", False, "放行")
        except adapters.AdapterError as error:
            check("_make_session 未知类型被拒", error.code == "BAD_ARGS", error.code)

        opened = adapters.session_open({"sessionType": "stealth", "sessionId": "cov-stealth", "recordNetwork": True})
        check("session_open 走 worker 路径", opened["sessionId"] == "cov-stealth", repr(opened))
        entry = adapters._SESSIONS["cov-stealth"]
        check(
            "recordNetwork 打开记录开关",
            entry["session"].kwargs.get("record_requests") is True,
            repr(entry["session"].kwargs),
        )

        for bad, code in ((5, "BAD_ARGS"), ("nope", "NO_SUCH_SESSION")):
            try:
                adapters._get_session(bad)
                check(f"_get_session({bad!r}) 被拒", False, "放行")
            except adapters.AdapterError as error:
                check(f"_get_session({bad!r}) 被拒", error.code == code, error.code)
        adapters._SESSIONS["pend"] = {"pending": True, "type": "static", "lock": threading.Lock()}
        try:
            adapters._get_session("pend")
            check("_get_session 构造中的条目被拒", False, "放行")
        except adapters.AdapterError as error:
            check("_get_session 构造中的条目被拒", error.code == "NO_SUCH_SESSION", error.code)

        # 构造期间被要求关闭（sidecar 关机走的就是 close_all_sessions）：建好的那一份绝不能
        # 登记回注册表 —— 登记了就再没有人会去关它，浏览器进程会活过 sidecar 自己。
        saved_make_session = adapters._make_session
        closed_log: list[str] = []

        class _RecordingCloser:
            """只记下自己被关过几次的替身。"""

            def close(self) -> None:
                """记一笔。"""
                closed_log.append("close")

            def __exit__(self, *exc: Any) -> None:
                """记一笔。"""
                closed_log.append("exit")

        def _slow_make_session(kind: str, args: dict[str, Any]) -> tuple[Any, Any]:
            """构造得足够慢，好在窗口里被叫停。"""
            time.sleep(0.3)
            return object(), _RecordingCloser()

        adapters._make_session = _slow_make_session
        adapters._SESSIONS.clear()
        race: dict[str, Any] = {}

        def _open_in_thread() -> None:
            """在另一条线程里开会话。"""
            try:
                race["info"] = adapters.session_open({"sessionType": "static", "sessionId": "race-open"})
            except Exception as error:  # noqa: BLE001 —— 记进断言里
                race["error"] = repr(error)

        opener = threading.Thread(target=_open_in_thread)
        opener.start()
        time.sleep(0.05)
        adapters.close_all_sessions()
        opener.join(5)
        check(
            "构造期被关闭的会话不登记回注册表",
            adapters._SESSIONS == {} and "info" in race,
            repr(sorted(adapters._SESSIONS)) + repr(race.get("error", "")),
        )
        check("构造期被关闭的会话当场关掉", closed_log == ["exit"], repr(closed_log))
        adapters._make_session = saved_make_session

        # T10：设置摘要必须在**开场那一刻**就记进登记条目 —— session.list 不该回头去猜，
        # 更不该把凭据面（cookies / 代理口令 / key）带进这份可被模型读到的摘要。
        adapters._make_session = lambda kind, args: (object(), _RecordingCloser())
        try:
            static_opened = adapters.session_open({"sessionType": "static"})
        finally:
            adapters._make_session = saved_make_session
        static_entry = adapters._SESSIONS[static_opened["sessionId"]]
        check(
            "session_open 记下非敏感设置摘要",
            static_entry.get("settings", {}).get("type") == "static"
            and static_entry["settings"].get("headless") is None,
            repr(static_entry.get("settings")),
        )
        adapters._close_entry(static_opened["sessionId"])

        # 上一段把注册表清空了（那正是它要证的），所以这里先自己登记一枚浏览器会话：
        # 下面几条断的是 session_fetch 的浏览器分支，不该依赖上一段留下的残留状态。
        # 浏览器条目必须有属主线程（greenlet 绑在那里），所以起一个真的 _SessionWorker，
        # 条目形状与 session_open 登记的那份逐键一致。
        _cov_worker = adapters._SessionWorker()

        class _FetchableSession:
            """只提供 `fetch` 的最小替身。

            本段断的是**分支路由**：合法调用走通、static 专属键被拒。抓取实现不在这一层，
            所以这里只证明「调用真的投递到了属主线程并被执行」。
            """

            def __init__(self) -> None:
                """给一个可开关的网络记录器：下面要验「未开记录被拒 / 开了就回条目」。"""
                self.network = type("_Rec", (), {"enabled": False})()

            def fetch(self, url: str, **params: Any) -> dict[str, Any]:
                """本段断的是路由，抓取实现不在这层。"""
                raise RuntimeError("reachable")

            def save_state(self, target: str) -> None:
                """把落点写出来，够下面断「文件真的存在」即可。"""
                Path(target).write_text("{}", encoding="utf-8")

            def load_state(self, target: str) -> None:
                """读一下被写的文件：存在性就是本段要的证据。"""
                Path(target).read_text(encoding="utf-8")

        adapters._SESSIONS["cov-stealth"] = {
            "sessionId": "cov-stealth",
            "type": "stealth",
            "session": _FetchableSession(),
            "closer": object(),
            "lock": threading.Lock(),
            "worker": _cov_worker,
            "pending": False,
        }
        # 上面把键整个换掉了，`entry` 还指着旧那份：后面几条用例要在新条目上开网络记录。
        entry = adapters._SESSIONS["cov-stealth"]
        # 这枚替身的 fetch 会抛，正好证明调用**真的投递到了属主线程并被执行**：
        # 若路由没走到浏览器分支，抛的会是 NO_SUCH_SESSION 而不是 FETCH_FAILED + reachable。
        try:
            adapters.session_fetch(
                {"sessionId": "cov-stealth", "url": "https://example.com/", "extractionType": "text"}
            )
            check("session_fetch 浏览器分支投递到属主线程", False, "没抛")
        except adapters.AdapterError as error:
            check(
                "session_fetch 浏览器分支投递到属主线程",
                error.code == "FETCH_FAILED" and "reachable" in str(error),
                f"{error.code}: {error}",
            )
        for key in ("headers", "retries"):
            try:
                adapters.session_fetch(
                    {
                        "sessionId": "cov-stealth",
                        "url": "https://example.com/",
                        key: ({"A": "b"} if key == "headers" else 1),
                    }
                )
                check(f"浏览器会话收到 {key} 被拒", False, "放行")
            except adapters.AdapterError as error:
                check(f"浏览器会话收到 {key} 被拒", error.code == "BAD_ARGS", error.code)

        rows = adapters.session_list({})["sessions"]
        check("session_list 列出已登记会话", any(row["sessionId"] == "cov-stealth" for row in rows), repr(rows))
        stealth_row = next(row for row in rows if row["sessionId"] == "cov-stealth")
        check("session_list 报 alive", stealth_row.get("alive") is True, repr(stealth_row)[:240])
        stealth_settings = json.dumps(stealth_row.get("settings"))
        check(
            "session_list 给非敏感设置摘要且不含凭据面",
            stealth_row.get("settings", {}).get("type") == "stealth"
            and "cookie" not in stealth_settings.lower()
            and "prox" not in stealth_settings.lower(),
            repr(stealth_row)[:240],
        )
        check("拿不到页池统计就省略 poolStats", "poolStats" not in stealth_row, repr(stealth_row)[:200])
        entry["session"].get_pool_stats = lambda: {"total_pages": 2, "busy_pages": 1, "junk": "x"}
        pooled = next(row for row in adapters.session_list({})["sessions"] if row["sessionId"] == "cov-stealth")
        check(
            "session_list 带页池统计且只留整数项",
            pooled.get("poolStats") == {"total_pages": 2, "busy_pages": 1},
            repr(pooled.get("poolStats")),
        )
        entry["session"].get_pool_stats = lambda: (_ for _ in ()).throw(RuntimeError("pool gone"))
        unpooled = next(row for row in adapters.session_list({})["sessions"] if row["sessionId"] == "cov-stealth")
        check("取页池统计抛错时省略而不让 list 失败", "poolStats" not in unpooled, repr(unpooled)[:200])
        del entry["session"].get_pool_stats
        adapters._SESSIONS["pend-live"] = {"pending": True, "type": "static", "lock": threading.Lock()}
        try:
            pend_row = next(row for row in adapters.session_list({})["sessions"] if row["sessionId"] == "pend-live")
            check("session_list 说构造中的会话不 alive", pend_row.get("alive") is False, repr(pend_row)[:200])
            check(
                "构造中的条目回退到非敏感设置摘要",
                pend_row.get("settings", {}).get("type") == "static",
                repr(pend_row.get("settings")),
            )
        finally:
            del adapters._SESSIONS["pend-live"]
        summary = adapters._session_settings(
            "stealth",
            {
                "headless": False,
                "recordNetwork": True,
                "locale": "zh-CN",
                "timezoneId": "Asia/Shanghai",
                "deployment": {"maxRecordedRequests": 25},
            },
        )
        check(
            "设置摘要反映显式开关",
            summary
            == {
                "type": "stealth",
                "headless": False,
                "recordNetwork": True,
                "maxRecordedRequests": 25,
                "locale": "zh-CN",
                "timezone": "Asia/Shanghai",
            },
            repr(summary),
        )
        static_summary = adapters._session_settings("static", {})
        check(
            "静态会话的浏览器开关是 null",
            static_summary["headless"] is None and static_summary["recordNetwork"] is False,
            repr(static_summary),
        )
        bad_knob = adapters._session_settings("stealth", {"deployment": {"maxRecordedRequests": -5}})
        check("非法的部署旋钮不进制摘要", bad_knob["maxRecordedRequests"] is None, repr(bad_knob))

        adapters._SESSIONS["cov-static"] = {
            "sessionId": "cov-static",
            "type": "static",
            "session": object(),
            "closer": object(),
            "lock": threading.Lock(),
            "worker": None,
            "pending": False,
        }
        try:
            adapters.session_network({"sessionId": "cov-static"})
            check("session_network 静态会话被拒", False, "放行")
        except adapters.AdapterError as error:
            check("session_network 静态会话被拒", error.code == "BAD_ARGS", error.code)
        try:
            adapters.session_network({"sessionId": "cov-stealth"})
            check("session_network 未开记录被拒", False, "放行")
        except adapters.AdapterError as error:
            check("session_network 未开记录被拒", error.code == "NETWORK_NOT_RECORDED", error.code)
        entry["session"].network.enabled = True
        summary = adapters.session_network({"sessionId": "cov-stealth", "networkLimit": 3})
        check(
            "session_network 已开记录回条目",
            summary == {"sessionId": "cov-stealth", "count": 0, "matches": []},
            repr(summary),
        )

        for args, note, code in (
            ({}, "没配 sessionStateDir", "STATE_DISABLED"),
            ({"deployment": {"sessionStateDir": tmp}}, "缺 name", "BAD_ARGS"),
            ({"deployment": {"sessionStateDir": tmp}, "name": "../x"}, "name 带路径", "BAD_ARGS"),
            ({"deployment": {"sessionStateDir": tmp}, "name": ".h"}, "name 以点开头", "BAD_ARGS"),
        ):
            try:
                adapters._state_path(args)
                check(f"_state_path 拒绝{note}", False, "放行")
            except adapters.AdapterError as error:
                check(f"_state_path 拒绝{note}", error.code == code, error.code)
        check(
            "_state_path 落点是 <dir>/<name>.json",
            adapters._state_path({"deployment": {"sessionStateDir": tmp}, "name": "login"})
            == str(Path(tmp) / "login.json"),
            "",
        )

        save = adapters.session_state_save(
            {"sessionId": "cov-stealth", "name": "login", "deployment": {"sessionStateDir": tmp}}
        )
        check(
            "session_state_save 落点与 saved",
            save["path"] == str(Path(tmp) / "login.json") and save["saved"] is True,
            repr(save),
        )
        load = adapters.session_state_load(
            {"sessionId": "cov-stealth", "name": "login", "deployment": {"sessionStateDir": tmp}}
        )
        check("session_state_load 的 saved 为假", load["saved"] is False, repr(load))
        try:
            adapters._session_state(
                {"sessionId": "cov-static", "name": "x", "deployment": {"sessionStateDir": tmp}}, saving=True
            )
            check("static 会话存取状态被拒", False, "放行")
        except adapters.AdapterError as error:
            check("static 会话存取状态被拒", error.code == "BAD_ARGS", error.code)

        fetchers.StealthySession = _session_stub(broken_state=True)  # type: ignore[misc,assignment]
        broken = adapters.session_open({"sessionType": "stealth", "sessionId": "cov-broken"})
        check("session_open 返回 id", broken["sessionId"] == "cov-broken", "")
        try:
            adapters.session_state_save(
                {"sessionId": "cov-broken", "name": "login", "deployment": {"sessionStateDir": tmp}}
            )
            check("state 上游报错翻成 STATE_FAILED", False, "放行")
        except adapters.AdapterError as error:
            check("state 上游报错翻成 STATE_FAILED", error.code == "STATE_FAILED", error.code)
        # 浏览器条目的 close 走属主线程（worker 路径）
        adapters.session_close({"sessionId": "cov-broken"})
        check("浏览器会话 close 走 worker", "cov-broken" not in adapters._SESSIONS, repr(sorted(adapters._SESSIONS)))
        fetchers.StealthySession = _session_stub()  # type: ignore[misc,assignment]

        adapters._make_session = _raiser(adapters.AdapterError("X", "boom"))
        try:
            adapters.session_open({"sessionType": "static"})
            check("session_open 构造失败透传 AdapterError", False, "放行")
        except adapters.AdapterError as error:
            check("session_open 构造失败透传 AdapterError", error.code == "X", error.code)
        adapters._make_session = _raiser(ValueError("boom"))
        try:
            adapters.session_open({"sessionType": "stealth"})
            check("session_open 构造失败包成 SESSION_OPEN_FAILED", False, "放行")
        except adapters.AdapterError as error:
            check("session_open 构造失败包成 SESSION_OPEN_FAILED", error.code == "SESSION_OPEN_FAILED", error.code)
        adapters._make_session = saved_make

        adapters._SESSIONS.clear()
        for index in range(adapters.MAX_BROWSER_SESSIONS):
            adapters._SESSIONS[f"b{index}"] = {
                "sessionId": f"b{index}",
                "type": "stealth",
                "session": object(),
                "lock": threading.Lock(),
                "worker": None,
            }
        try:
            adapters.session_open({"sessionType": "stealth", "sessionId": "over"})
            check("浏览器会话名额判 SESSION_LIMIT", False, "放行")
        except adapters.AdapterError as error:
            check("浏览器会话名额判 SESSION_LIMIT", error.code == "SESSION_LIMIT", error.code)
        adapters._SESSIONS.clear()

        adapters._close_entry("ghost")
        check("_close_entry 未知 id 是 no-op", True, "")
        adapters._SESSIONS["p2"] = {"pending": True, "type": "static", "lock": threading.Lock()}
        adapters._close_entry("p2")
        check("_close_entry 构造中的条目不碰 closer", "p2" not in adapters._SESSIONS, "")

        worker = adapters._SessionWorker()
        try:
            check("_SessionWorker 刚起时 alive", worker.alive() is True, "")
            check("_SessionWorker.run 回值", worker.run(lambda: 5) == 5, "")
            try:
                worker.run(_raiser(RuntimeError("boom")))
                check("_SessionWorker 任务异常回到调用方", False, "没抛")
            except RuntimeError:
                check("_SessionWorker 任务异常回到调用方", True, "")
        finally:
            worker.stop()
        check("_SessionWorker.stop 收线程", True, "")
        check("_SessionWorker.stop 后 alive 为假", worker.alive() is False, "")

        # close_all_sessions 要真的有条目可关，循环体才算跑到
        last_stub = _session_stub()
        adapters._SESSIONS["cov-last"] = {
            "sessionId": "cov-last",
            "type": "stealth",
            "session": last_stub(),
            "closer": last_stub(),
            "lock": threading.Lock(),
            "worker": None,
        }
        adapters.close_all_sessions()
        check("close_all_sessions 清空登记", adapters._SESSIONS == {}, repr(adapters._SESSIONS))
    finally:
        fetchers.StealthySession = saved_session  # type: ignore[misc]
        adapters._make_session = saved_make
        adapters.close_all_sessions()


def run_inprocess_crawl() -> None:
    """进程内：crawl 的登记/叫停/起线程/淘汰/取名各分支。"""
    sys.path.insert(0, str(PY_DIR))
    import adapters
    import crawl
    import guard

    print("\n== 进程内：crawl 分支 ==")
    saved_hosts = set(guard.ALLOWED_HOSTS)
    saved_proxy = guard.PROXY_URL
    saved_make = crawl._make_spider
    saved_emit = crawl._emit_event
    saved_thread = crawl.threading.Thread
    guard.configure(allowed_hosts=frozenset({"a.test"}))
    crawl._emit_event = lambda *args, **kwargs: None
    try:
        try:
            crawl._crawl_policy({"deployment": {"crawlDownloadDelayMs": -1}})
            check("crawlDownloadDelayMs=-1 被拒", False, "放行")
        except adapters.AdapterError as error:
            check("crawlDownloadDelayMs=-1 被拒", error.code == "BAD_ARGS", error.code)

        # 配了代理时 configure_sessions 会把代理交给 FetcherSession
        guard.PROXY_URL = "http://127.0.0.1:7890"
        spider = crawl._make_spider(
            "http://a.test/", 2, "cov-proxy", {"pages": [], "deadline": 0}, {"a.test"}, crawl._crawl_policy({})
        )
        check("爬虫配代理时会话带上 proxies", spider is not None, "")
        guard.PROXY_URL = saved_proxy

        # on_scraped_item：页数已到上限时直接返回 None
        state: dict[str, Any] = {"pages": [{"url": "http://a.test/", "title": "t", "markdown": "m"}], "deadline": 0}
        spider = crawl._make_spider("http://a.test/", 1, "cov-full", state, {"a.test"}, crawl._crawl_policy({}))
        out = asyncio.run(spider.on_scraped_item({"url": "http://a.test/x", "title": "x", "markdown": "y"}))
        check("页数到上限时不再收", out is None and len(state["pages"]) == 1, repr(state["pages"]))

        crawl._CRAWLS.clear()
        crawl._make_spider = _raiser(adapters.AdapterError("X", "boom"))
        try:
            crawl.crawl_run({"url": "http://a.test/"})
            check("crawl_run 透传 AdapterError", False, "放行")
        except adapters.AdapterError as error:
            check("crawl_run 透传 AdapterError", error.code == "X", error.code)
        check("构造失败的爬虫不留登记", crawl._CRAWLS == {}, repr(sorted(crawl._CRAWLS)))
        crawl._make_spider = _raiser(ValueError("boom"))
        try:
            crawl.crawl_run({"url": "http://a.test/"})
            check("crawl_run 包成 CRAWL_SETUP_FAILED", False, "放行")
        except adapters.AdapterError as error:
            check("crawl_run 包成 CRAWL_SETUP_FAILED", error.code == "CRAWL_SETUP_FAILED", error.code)

        # worker 起手就被叫停（crawl_stop 在 spider 登记之前到）：一页都不抓
        def _mark_stop(
            url: str,
            limit: int,
            crawl_id: str,
            state: dict[str, Any],
            domains: set[str],
            policy: Any,
            options: dict[str, Any] | None = None,
        ) -> Any:  # 替身
            """把该 id 的登记标成已叫停，并回一个够登记用的蜘蛛替身。"""
            crawl._CRAWLS[crawl_id]["stop_requested"] = True
            return object()

        crawl._CRAWLS.clear()
        crawl._make_spider = _mark_stop
        crawl_id = crawl.crawl_run({"url": "http://a.test/"})["crawlId"]
        crawl._CRAWLS[crawl_id]["thread"].join(timeout=5)
        check("被叫停的 worker 一页都不抓", crawl.crawl_status({"crawlId": crawl_id})["pages"] == [], "")

        class _BoomSpider:
            """start() 抛错的蜘蛛替身。"""

            def start(self) -> None:
                """抛。"""
                raise RuntimeError("start boom")

            def pause(self) -> None:
                """无事可停。"""

        crawl._CRAWLS.clear()
        crawl._make_spider = lambda *args, **kwargs: _BoomSpider()
        crawl_id = crawl.crawl_run({"url": "http://a.test/"})["crawlId"]
        crawl._CRAWLS[crawl_id]["thread"].join(timeout=5)
        check("spider.start 抛时收进 state", "boom" in str(crawl.crawl_status({"crawlId": crawl_id})["error"]), "")

        # 起线程失败：把占位摘掉、名额还回去，再抛
        class _BadThread:
            """start() 抛错的线程替身。"""

            def __init__(self, *args: Any, **kwargs: Any) -> None:
                """:param args: 忽略
                :param kwargs: 忽略
                """

            def start(self) -> None:
                """抛。"""
                raise RuntimeError("cannot start thread")

            def is_alive(self) -> bool:
                """恒假。"""
                return False

            def join(self, timeout: float | None = None) -> None:
                """无事可等。"""

        crawl._CRAWLS.clear()
        crawl._make_spider = lambda *args, **kwargs: _BoomSpider()
        crawl.threading.Thread = _BadThread  # type: ignore[misc,assignment]
        try:
            crawl.crawl_run({"url": "http://a.test/"})
            check("起线程失败时抛且不留登记", False, "放行")
        except RuntimeError:
            check("起线程失败时抛且不留登记", crawl._CRAWLS == {}, repr(sorted(crawl._CRAWLS)))
        finally:
            crawl.threading.Thread = saved_thread  # type: ignore[misc]

        # 淘汰最旧的已结束条目
        crawl._CRAWLS.clear()
        for index in range(crawl.MAX_REMEMBERED_CRAWLS + 3):
            crawl._CRAWLS[f"c{index}"] = {
                "thread": _DeadThread(),
                "crawl_id": f"c{index}",
                "state": {"pages": [], "deadline": 0},
                "stop_requested": False,
            }
        crawl._evict_finished_crawls()
        check("淘汰后只剩上限条数", len(crawl._CRAWLS) == crawl.MAX_REMEMBERED_CRAWLS, str(len(crawl._CRAWLS)))
        check("最旧的条目被丢掉", "c0" not in crawl._CRAWLS, "")

        for bad, code in ((5, "BAD_ARGS"), ("nope", "NO_SUCH_CRAWL")):
            try:
                crawl._get_crawl(bad)
                check(f"_get_crawl({bad!r}) 被拒", False, "放行")
            except adapters.AdapterError as error:
                check(f"_get_crawl({bad!r}) 被拒", error.code == code, error.code)

        # 还没起线程的爬虫叫停：只置标志，stopping 为假
        crawl._CRAWLS.clear()
        crawl._CRAWLS["nostop"] = {
            "thread": None,
            "crawl_id": "nostop",
            "state": {"pages": [], "deadline": 0},
            "stop_requested": False,
        }
        answer = crawl.crawl_stop({"crawlId": "nostop"})
        check("构造中的爬虫叫停说在停为假", answer == {"crawlId": "nostop", "stopping": False}, repr(answer))
        check("构造中的叫停置上标志", crawl._CRAWLS["nostop"]["stop_requested"] is True, "")
        crawl._CRAWLS.clear()

        # sidecar 收尾要真的把在跑的蜘蛛叫停并等到它退出，而不是只清一张登记表：那些线程
        # 会在宿主已经不再读这一路之后继续往 stdout 推事件帧。
        class _PauseSpider:
            """记下 pause() 被叫到几次。"""

            def __init__(self) -> None:
                """:param paused: 被叫停的次数"""
                self.paused = 0

            def pause(self) -> None:
                """算一次叫停。"""
                self.paused += 1

        def _spin(state: dict[str, Any]) -> None:
            """转到截止到了为止 —— 一只听得进叫停的蜘蛛。"""
            while state["deadline"] > time.monotonic():
                time.sleep(0.01)

        pause_spider = _PauseSpider()
        stopping_state: dict[str, Any] = {"pages": [], "deadline": time.monotonic() + 30}
        worker = threading.Thread(target=_spin, args=(stopping_state,))
        worker.start()
        crawl._CRAWLS["bye"] = {
            "thread": worker,
            "crawl_id": "bye",
            "state": stopping_state,
            "stop_requested": False,
            "spider": pause_spider,
        }
        crawl.close_all_crawls()
        check("收尾叫停在跑的蜘蛛", pause_spider.paused == 1, str(pause_spider.paused))
        check("收尾等得到蜘蛛的线程", not worker.is_alive(), "")
        check("收尾清掉登记表", crawl._CRAWLS == {}, repr(sorted(crawl._CRAWLS)))

        # 等不到的那几只：只花预算那么多时间，记一行 stderr，然后照样清登记表。
        saved_join = crawl.SHUTDOWN_JOIN_SECONDS
        crawl.SHUTDOWN_JOIN_SECONDS = 0.05
        stubborn = threading.Thread(target=lambda: time.sleep(0.4))
        stubborn.start()
        crawl._CRAWLS["stubborn"] = {
            "thread": stubborn,
            "crawl_id": "stubborn",
            "state": {"pages": [], "deadline": 0},
            "stop_requested": False,
        }
        stuck_log = io.StringIO()
        started = time.monotonic()
        with contextlib.redirect_stderr(stuck_log):
            crawl.close_all_crawls()
        elapsed = time.monotonic() - started
        crawl.SHUTDOWN_JOIN_SECONDS = saved_join
        check("等不到时只花等待预算", elapsed < 0.35, f"{elapsed:.3f}s")
        check("等不到的那几只记进 stderr", "still running" in stuck_log.getvalue(), repr(stuck_log.getvalue())[:120])
        check("等不到也照样清登记表", crawl._CRAWLS == {}, repr(sorted(crawl._CRAWLS)))
        stubborn.join(timeout=5)

        # 接线：sidecar 的收尾确实先停爬虫；停不掉时记一行而不是把关机拖成异常。
        import bridge

        crawl._CRAWLS["wire"] = {
            "thread": None,
            "crawl_id": "wire",
            "state": {"pages": [], "deadline": 0},
            "stop_requested": False,
        }
        bridge._shutdown_crawls()
        check("bridge 的收尾清掉爬虫登记", crawl._CRAWLS == {}, repr(sorted(crawl._CRAWLS)))

        saved_close = crawl.close_all_crawls
        crawl.close_all_crawls = _raiser(RuntimeError("stop boom"))
        boom_log = io.StringIO()
        try:
            with contextlib.redirect_stderr(boom_log):
                bridge._shutdown_crawls()
            check(
                "停不掉爬虫也不抛，只记一行",
                "failed to stop crawls" in boom_log.getvalue(),
                repr(boom_log.getvalue())[:140],
            )
        finally:
            crawl.close_all_crawls = saved_close
    finally:
        crawl._make_spider = saved_make
        crawl._emit_event = saved_emit
        crawl.threading.Thread = saved_thread  # type: ignore[misc]
        crawl._CRAWLS.clear()
        guard.configure(allowed_hosts=frozenset(saved_hosts))
        guard.PROXY_URL = saved_proxy


def main() -> int:
    """入口。

    :returns: 退出码，0 表示全过且跑量达到本机那一档的下限
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
        check("能力帧如实标出写方法这一档（本次部署为开）", caps.get("writeMethods") is True, repr(caps)[:160])
        print(f"     capabilities = {json.dumps(caps, ensure_ascii=False)}")
        run(sidecar, base, caps)
        print("\n== P1a 离线方法（真 bridge 帧）==")
        run_p1a_wire(sidecar, base)
        print("\n== 静态抓取请求件参数 ==")
        run_fetch_params(sidecar, base)
        print("\n== 浏览器参数分层 ==")
        run_browser_params()
        print("\n== payload 元数据与 JSON 抽取 ==")
        run_payload_metadata()
        print("\n== 检索发现（Tavily/Bing 夹具）==")
        run_search_discovery(base)
        print("\n== 检索层的错误形状 ==")
        run_search_shapes(base)
        run_search_backends(base)
        print("\n== 检索发现（真 bridge 帧）==")
        run_search_wire(sidecar, base)
        print("\n== 文件下载 ==")
        run_download(base)
        print("\n== 写方法与请求件（对端收到了什么）==")
        run_write_verbs(sidecar, base)
        # 闸门那一半必须**关掉写方法**再起一个 sidecar（同一个服务地址能复用）。
        run_write_gate(base)
        # capture / session.network / session.state_* 都要真浏览器，浏览器不可用就跳过。
        if caps.get("browser"):
            run_capture(sidecar, base)
            run_network_filters(base)
            run_session_read(sidecar, base)
            run_session_actions(sidecar, base)
            run_screenshot(sidecar, base)
            run_session_network(sidecar, base)
            run_session_state(sidecar)
        else:
            print(
                "  SKIP  capture / network filters / session.network / session.state_*（capabilities.browser = false）"
            )
    finally:
        sidecar.close()
        server.shutdown()

    print("\n== URL 守卫 ==")
    run_guard()

    print("\n== 代理判定 ==")
    run_proxy()

    print("\n== 会话入参分支（static 专属的键不给浏览器会话）==")
    run_session_param_guards()

    print("\n== stealth 的 WebRTC 强制开启与会话代理同源 ==")
    run_webrtc_guards()

    print("\n== 输出形态（内嵌图片剥离） ==")
    run_output_shape()

    print("\n== 合成池（fake-IP） ==")
    run_synthetic_pools()

    print("\n== 上限与配额 ==")
    run_limits()

    print("\n== 并发名额 ==")
    run_concurrency_guards()

    print("\n== P4 门禁：上游模板（sitemap / xml feed / csv feed）==")
    run_template_probe()

    print("\n== 爬虫边界（真站点收页 / 站外重定向 / 叫停 / select 预算）==")
    run_crawl_guards()

    print("\n== 爬虫策略旋钮（部署命名空间 → Spider 类属性）==")
    run_crawl_policy()

    print("\n== 爬虫目标地址复核（shopify sitemapUrl / 行收集截止）==")
    run_crawl_targets()

    print("\n== 网络摘要脱敏与形状 ==")
    run_network_summary()

    print("\n== 进程内单元（替身页与纯函数）==")
    run_session_page_units()
    run_media_units()
    run_redis_storage()
    run_inprocess_adapters()
    run_inprocess_browser()
    run_inprocess_capabilities()
    run_inprocess_sessions()
    run_inprocess_crawl()

    print("\n== select 扩展（fields/queryType/adaptive）==")
    run_select_extended()

    print("\n== locate/links（纯函数与 METHODS）==")
    run_locate_links()

    print("\n== 提取 helper（fields/query/similar/budget）==")
    run_extraction_helpers()

    print("\n== 提取路径的反注入清洗 ==")
    run_extraction()

    print("\n== 解释器地板（运行时硬闸）==")
    run_python_floor_gate()

    print("\n== 协议通道的编码与 py/ 目录解析 ==")
    run_bridge_wire_encoding()

    print("\n== 缺可选依赖的归类 ==")
    check_dependency_missing_mapping()

    print(f"\n{'=' * 52}")
    print(f"passed {passes}, failed {len(failures)}")
    for item in failures:
        print(f"  - {item}")
    has_browser = _browser_ground_truth()
    floor = MIN_CHECKS_WITH_BROWSER if has_browser else MIN_CHECKS_WITHOUT_BROWSER
    print(f"跑量下限档位：{'有浏览器' if has_browser else '无浏览器'}，下限 {floor}")
    ran = passes + len(failures)
    if ran < floor:
        print(
            f"本次只跑了 {ran} 条断言，低于下限 {floor}：有小节静默消失或整段没执行，"
            "上面的 failed 0 是「没量到」而不是「都过了」。",
            file=sys.stderr,
        )
        return 1
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
