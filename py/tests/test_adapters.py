"""py/tests/test_adapters.py —— 0.1.3 缺陷修复（P1/P2/P3/P4/P5/P6）的回归用例。

为什么单独成文件却由 ``test_bridge.py`` 调用：本仓的 Python 测试入口只有
``py/tests/test_bridge.py`` 一个（``package.json`` 的 ``test:py`` 直接跑它）。另开一个
没人调用的文件等于让用例静默消失 —— 那些断言看起来在仓库里，实际一条都没跑。
``test_bridge.py`` 的 ``run_inprocess_adapters()`` 负责把它们接进同一条计算里。

这些用例都走**进程内替身**：不联网、不起浏览器、不依赖 sidecar 帧。它们钉的是
「参数怎么落到上游调用上」与「错误码/文案」，那正是本次修复的判据面。
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

PY_DIR = Path(__file__).resolve().parent.parent


class _DirectWorker:
    """把属主线程的投递就地执行：手势路径的替身，不真起线程。"""

    def run(self, action: Any) -> Any:
        """直接调用投递进来的闭包。"""
        return action()


def _entry(kind: str, session: Any) -> dict[str, Any]:
    """造一条会话注册表条目（形状与 ``adapters.session_open`` 落下的那一份一致）。"""
    return {
        "sessionId": "fix",
        "type": kind,
        "session": session,
        "lock": threading.Lock(),
        "worker": _DirectWorker() if kind == "stealth" else None,
        "pending": False,
    }


class _Recorded:
    """记下一次上游调用：方法名与关键字参数。"""

    def __init__(self, method: str, url: str, params: dict[str, Any]) -> None:
        self.method = method
        self.url = url
        self.params = params


class _RecordingFetcher:
    """静态抓取的替身：只记账、回一份最小响应。"""

    calls: list[_Recorded] = []

    @classmethod
    def _respond(cls, method: str, url: str, params: dict[str, Any]) -> Any:
        from adapters import _fake_response

        cls.calls.append(_Recorded(method, url, dict(params)))
        return _fake_response("<html><body><h1>unit</h1></body></html>", url, 200)

    @classmethod
    def get(cls, url: str, **params: Any) -> Any:
        """GET。"""
        return cls._respond("GET", url, params)

    @classmethod
    def post(cls, url: str, **params: Any) -> Any:
        """POST。"""
        return cls._respond("POST", url, params)

    @classmethod
    def put(cls, url: str, **params: Any) -> Any:
        """PUT。"""
        return cls._respond("PUT", url, params)

    @classmethod
    def delete(cls, url: str, **params: Any) -> Any:
        """DELETE。"""
        return cls._respond("DELETE", url, params)


class ImpersonateError(Exception):
    """``curl_cffi.requests.exceptions.ImpersonateError`` 的替身（只按类名分流）。"""


class _StaticSessionStub:
    """static 会话的替身：``get`` 记账并回一份最小响应。"""

    def __init__(self) -> None:
        self.calls: list[_Recorded] = []

    def get(self, url: str, **params: Any) -> Any:
        """GET。"""
        from adapters import _fake_response

        self.calls.append(_Recorded("GET", url, dict(params)))
        return _fake_response("<html><body><h1>unit</h1></body></html>", url, 200)


class _StateSessionStub:
    """浏览器会话的替身：``load_state`` 直接抛指定的错误。"""

    def __init__(self, error: BaseException) -> None:
        self.error = error

    def save_state(self, path: str) -> None:
        """保存：本替身只服务 load 分支。"""
        del path

    def load_state(self, path: str) -> None:
        """载入：抛出预置的错误。"""
        del path
        raise self.error


class _BoomLocator:
    """一个动作必然失败的 locator。"""

    def click(self, **kwargs: Any) -> None:
        """按 Playwright 的失败形状抛。"""
        del kwargs
        raise RuntimeError("no such element")


class _BoomPage:
    """动作必然失败的假页：只实现 ``run_actions`` 碰得到的那几个方法。"""

    url = "http://unit.test/boom"

    def is_closed(self) -> bool:
        """页还开着。"""
        return False

    def locator(self, selector: str) -> _BoomLocator:
        """按选择器拿 locator。"""
        del selector
        return _BoomLocator()

    def title(self) -> str:
        """页标题。"""
        return "boom"


class _BoomInfo:
    """页池条目：page 永远可拿。"""

    def __init__(self) -> None:
        self.page = _BoomPage()
        self.ready = True

    def mark_ready(self) -> None:
        """把页标回就绪。"""
        self.ready = True


class _BoomPool:
    """页池替身：``pages`` 与 ``remove_page`` 是 ``_finish_page`` 要用的面。"""

    def __init__(self) -> None:
        self.info = _BoomInfo()
        self.pages = [self.info]

    def get_ready_page(self) -> Any:
        """给一个就绪页。"""
        return self.info

    def remove_page(self, info: Any) -> None:
        """移除页。"""
        del info


class _BoomSession:
    """持有页池的会话替身。"""

    def __init__(self) -> None:
        self.page_pool = _BoomPool()


def _expect(code: str, run: Any) -> Any:
    """跑一次必须失败的调用并断言错误码；返回那个错误对象（码对不上则给 None）。"""
    try:
        run()
    except Exception as error:  # noqa: BLE001 —— 断言的是错误码，不是异常类型
        actual = getattr(error, "code", None)
        return error if actual == code else None
    return None


def run_adapter_fixes(check: Any) -> None:
    """跑 P1/P2/P3/P4/P5/P6 的回归断言。

    :param check: ``test_bridge.check`` —— 唯一的断言收集器
    """
    if str(PY_DIR) not in sys.path:
        sys.path.insert(0, str(PY_DIR))
    import adapters
    import guard
    import session_page

    saved_url_allowed = guard.url_allowed
    saved_fetcher = adapters.Fetcher
    saved_writes = guard.ALLOW_WRITE_METHODS
    saved_actions = guard.ALLOW_BROWSER_ACTIONS
    guard.url_allowed = lambda url, **kwargs: (True, "")
    try:
        _run_p1(adapters, guard, check)
        _run_p2(adapters, guard, check)
        _run_p3(adapters, guard, session_page, check)
        _run_p4(check)
        _run_p5(adapters, check)
        _run_p6(adapters, check)
    finally:
        setattr(adapters, "Fetcher", saved_fetcher)  # noqa: B010
        guard.url_allowed = saved_url_allowed
        guard.ALLOW_WRITE_METHODS = saved_writes
        guard.ALLOW_BROWSER_ACTIONS = saved_actions
        adapters._SESSIONS.pop("fix", None)


def _run_p1(adapters: Any, guard: Any, check: Any) -> None:
    """P1：请求体推方法、显式 GET 带体、写方法门禁、浏览器路径拒绝请求体。"""
    guard.ALLOW_WRITE_METHODS = True
    setattr(adapters, "Fetcher", _RecordingFetcher)  # noqa: B010 —— 库级替身没有赋值面的类型
    for payload, field in (({"form": {"a": "1"}}, "data"), ({"json": {"a": "1"}}, "json"), ({"body": "raw"}, "data")):
        _RecordingFetcher.calls.clear()
        adapters.fetch({"url": "https://unit.test/", **payload})
        recorded = _RecordingFetcher.calls[0]
        check("P1 缺 method 时请求体把方法推成 POST", recorded.method == "POST", recorded.method)
        check(f"P1 {field} 落到上游同名参数上", field in recorded.params, repr(recorded.params)[:200])

    _RecordingFetcher.calls.clear()
    adapters.fetch({"url": "https://unit.test/"})
    check("P1 不带请求体仍是 GET", _RecordingFetcher.calls[0].method == "GET", _RecordingFetcher.calls[0].method)

    for payload in ({"form": {"a": "1"}}, {"json": {"a": "1"}}, {"body": "raw"}):
        error = _expect(
            "BAD_ARGS",
            lambda payload=payload: adapters.fetch({"url": "https://unit.test/", "method": "GET", **payload}),
        )
        check(
            "P1 显式 GET + 请求体是 BAD_ARGS 且点名 GET 不能带体",
            error is not None and "GET cannot carry a request body" in str(error),
            repr(error),
        )

    error = _expect(
        "BAD_ARGS",
        lambda: adapters.fetch({"url": "https://unit.test/", "method": "PATCH"}),
    )
    check("P1 未知方法仍是 BAD_ARGS", error is not None and "unsupported method" in str(error), repr(error))

    guard.ALLOW_WRITE_METHODS = False
    error = _expect("WRITE_DISABLED", lambda: adapters.fetch({"url": "https://unit.test/", "form": {"a": "1"}}))
    check("P1 写方法关闭时请求体按写意图拒绝", error is not None and "allowWriteMethods" in str(error), repr(error))

    # 浏览器一次性路径（render / capture）**不**拒 form/json/body：JS 侧这两枚工具的参数
    # 面里根本没有这三个键（只有静态 fetch 在写方法开启时才带），留着守卫会先把满参数驱动
    # 拦掉，让协议对表把 render 后面该读的键整段记成「对端不读」，还制造「capture 读了
    # body 但本侧从不发」的死读。判据钉行为：带请求体的 render 照常走到抓取那一步。
    check("P1 浏览器一次性路径不再带写体守卫", not hasattr(adapters, "_refuse_browser_write_body"))

    class _RenderProbe:
        """``StealthyFetcher`` 的替身：只证明 render 真的走到抓取这一步。"""

        calls: list[dict[str, Any]] = []

        @classmethod
        def fetch(cls, url: str, **kwargs: Any) -> Any:
            """记下抓取参数并回一份最小响应。"""
            cls.calls.append({"url": url, "params": dict(kwargs)})
            return adapters._fake_response("<html><body><h1>unit</h1></body></html>", url, 200)

    saved_browser_fetcher = adapters.StealthyFetcher
    setattr(adapters, "StealthyFetcher", _RenderProbe)  # noqa: B010 —— 库级替身没有赋值面的类型
    try:
        rendered = adapters.render({"url": "https://unit.test/", "json": {"a": 1}})
    finally:
        setattr(adapters, "StealthyFetcher", saved_browser_fetcher)  # noqa: B010
    check("P1 render 带请求体不再被拦", isinstance(rendered, dict) and _RenderProbe.calls, repr(rendered)[:200])
    check(
        "P1 请求体不进入浏览器参数面（忽略而不是静默改写方法）",
        not any(key in _RenderProbe.calls[0]["params"] for key in ("form", "json", "body")),
        repr(_RenderProbe.calls[0]["params"])[:300],
    )
    # 会话路径的既有文案不许被换掉（plans p1b Task5 的原话）。
    entry = adapters._SESSIONS.setdefault(
        "p1-probe",
        {
            "sessionId": "p1-probe",
            "type": "stealth",
            "session": object(),
            "lock": threading.Lock(),
            "worker": None,
            "pending": False,
        },
    )
    try:
        error = _expect(
            "BAD_ARGS",
            lambda: adapters.session_fetch({"sessionId": "p1-probe", "url": "https://unit.test/", "form": {"a": "1"}}),
        )
        check(
            "P1 浏览器会话仍用既有拒绝表（点名 static session）",
            error is not None and "only applies to static sessions" in str(error),
            repr(error),
        )
    finally:
        adapters._SESSIONS.pop(entry["sessionId"], None)
        guard.ALLOW_WRITE_METHODS = False
    check(
        "P1 浏览器路径不给请求体时照常算参数",
        "timeout" in adapters._browser_params({}, "https://unit.test/", level="fetch"),
        "",
    )


def _run_p2(adapters: Any, guard: Any, check: Any) -> None:
    """P2：非法 impersonate 归一成 BAD_ARGS，且不透出上游原文。"""
    del guard

    class _BadImpersonateFetcher:
        """所有方法都抛 ``ImpersonateError`` 的替身。"""

        @classmethod
        def get(cls, url: str, **params: Any) -> Any:
            """抛出与 curl_cffi 同名的异常。"""
            del url, params
            raise ImpersonateError("Impersonating nope-not-a-browser is not supported")

    setattr(adapters, "Fetcher", _BadImpersonateFetcher)  # noqa: B010
    error = _expect(
        "BAD_ARGS",
        lambda: adapters.fetch({"url": "https://unit.test/", "impersonate": "nope-not-a-browser"}),
    )
    check("P2 非法 impersonate 报 BAD_ARGS", error is not None, repr(error))
    message = str(error)
    check(
        "P2 文案点名非法取值并指向 curl_cffi 支持列表",
        "impersonate 'nope-not-a-browser' is not supported by curl_cffi" in message
        and "supported browser presets" in message,
        message,
    )
    check("P2 不透出上游原文", "Impersonating nope-not-a-browser" not in message, message)
    setattr(adapters, "Fetcher", _RecordingFetcher)  # noqa: B010 —— 库级替身没有赋值面的类型


def _run_p3(adapters: Any, guard: Any, session_page: Any, check: Any) -> None:
    """P3：未收到 timeoutMs 时内层等待仍是 30s；动作失败给 ACTION_FAILED 而不是挂到外层。"""
    check("P3 默认内层超时是 30s", adapters.DEFAULT_TIMEOUT_MS == 30_000, str(adapters.DEFAULT_TIMEOUT_MS))
    check(
        "P3 fetch 层缺省 timeout=30s",
        adapters._browser_params({}, "", level="fetch").get("timeout") == 30_000,
        "",
    )
    check("P3 会话层缺省 timeout=30s", adapters._browser_params({}, "").get("timeout") == 30_000, "")
    check(
        "P3 显式 timeoutMs 按值用",
        adapters._browser_params({"timeoutMs": 5_000}, "", level="fetch").get("timeout") == 5_000,
        "",
    )

    captured: dict[str, Any] = {}
    saved_run_actions = session_page.run_actions

    def _capture_actions(session: Any, *, actions: Any, slowly: bool, max_actions: int, timeout_ms: int) -> Any:
        """记下动作层收到的超时，并回一份最小结果。"""
        del session, actions, slowly, max_actions
        captured["timeout_ms"] = timeout_ms
        return {"completed": 1, "finalUrl": "http://unit.test/", "title": "unit"}

    guard.ALLOW_BROWSER_ACTIONS = True
    setattr(session_page, "run_actions", _capture_actions)  # noqa: B010
    adapters._SESSIONS["fix"] = _entry("stealth", object())
    try:
        adapters.session_act({"sessionId": "fix", "actions": [{"type": "click", "target": "#ok"}]})
        check("P3 session_act 缺省把 30s 交给动作层", captured.get("timeout_ms") == 30_000, repr(captured))
        captured.clear()
        adapters.session_act({"sessionId": "fix", "actions": [{"type": "click", "target": "#ok"}], "timeoutMs": 7_000})
        check("P3 session_act 显式 timeoutMs 按值用", captured.get("timeout_ms") == 7_000, repr(captured))
    finally:
        setattr(session_page, "run_actions", saved_run_actions)  # noqa: B010
        adapters._SESSIONS.pop("fix", None)

    error = _expect(
        "ACTION_FAILED",
        lambda: session_page.run_actions(
            _BoomSession(),
            actions=[{"type": "click", "target": "#nope"}],
            slowly=False,
            max_actions=5,
            timeout_ms=30_000,
        ),
    )
    check(
        "P3 坏 selector 给 ACTION_FAILED 而不是等外层",
        error is not None and "action 1 (click)" in str(error),
        repr(error),
    )
    details = getattr(error, "details", None) or {}
    check("P3 ACTION_FAILED 带 actionIndex", details.get("actionIndex") == 1, repr(details))


def _run_p5(adapters: Any, check: Any) -> None:
    """P5：state 文件缺失 / 非法 JSON 报 STATE_FAILED，且不透出绝对路径。"""
    state_dir = tempfile.mkdtemp(prefix="dsh-fix-state-")
    missing = FileNotFoundError(2, "No such file or directory", "/Users/secret-user/.dsh/state/fix-login.json")
    adapters._SESSIONS["fix"] = _entry("stealth", _StateSessionStub(missing))
    try:
        error = _expect(
            "STATE_FAILED",
            lambda: adapters._session_state(
                {"sessionId": "fix", "name": "login", "deployment": {"sessionStateDir": state_dir}},
                saving=False,
            ),
        )
    finally:
        adapters._SESSIONS.pop("fix", None)
    message = str(error)
    check(
        "P5 缺文件报 STATE_FAILED 且点名缺哪个文件",
        error is not None and "state file does not exist: login.json" in message,
        message,
    )
    check(
        "P5 缺文件不透出绝对路径",
        "/Users/secret-user" not in message and "No such file or directory" not in message,
        message,
    )
    check("P5 缺文件不透出 FileNotFoundError", "FileNotFoundError" not in message, message)

    adapters._SESSIONS["fix"] = _entry("stealth", _StateSessionStub(json.JSONDecodeError("bad", "x", 0)))
    try:
        error = _expect(
            "STATE_FAILED",
            lambda: adapters._session_state(
                {"sessionId": "fix", "name": "login", "deployment": {"sessionStateDir": state_dir}},
                saving=False,
            ),
        )
    finally:
        adapters._SESSIONS.pop("fix", None)
    message = str(error)
    check(
        "P5 非法 JSON 报 STATE_FAILED 并点名文件",
        error is not None and "state file is not valid JSON: login.json" in message,
        message,
    )
    check("P5 非法 JSON 不透出绝对路径", "/Users/secret-user" not in message and state_dir not in message, message)


def _run_p6(adapters: Any, check: Any) -> None:
    """P6：static 会话的 extraHeaders 真的合并进请求头。"""
    session = _StaticSessionStub()
    adapters._SESSIONS["fix"] = _entry("static", session)
    try:
        adapters.session_fetch(
            {
                "sessionId": "fix",
                "url": "https://unit.test/file",
                "headers": {"A": "b", "X-Static": "from-headers"},
                "extraHeaders": {"X-Static": "yes"},
            }
        )
    finally:
        adapters._SESSIONS.pop("fix", None)
    params = session.calls[0].params
    headers = params.get("headers") or {}
    check("P6 static 会话的 extraHeaders 真发出去", headers.get("X-Static") == "yes", repr(headers))
    check("P6 同名键以 extraHeaders 为准", headers.get("A") == "b", repr(headers))

    session = _StaticSessionStub()
    adapters._SESSIONS["fix"] = _entry("static", session)
    try:
        error = _expect(
            "BAD_ARGS",
            lambda: adapters.session_fetch(
                {"sessionId": "fix", "url": "https://unit.test/file", "extraHeaders": "not-an-object"}
            ),
        )
    finally:
        adapters._SESSIONS.pop("fix", None)
    check("P6 extraHeaders 非对象被拒", error is not None and "extraHeaders" in str(error), repr(error))


def _run_p4(check: Any) -> None:
    """P4：浏览器下载遇到附件响应时改等 ``download`` 事件落盘；两条路都失败时交两份原文。"""
    import adapters
    import media
    import scrapling.fetchers as fetchers

    payload = b"%PDF-1.4 unit payload"
    directory = Path(tempfile.mkdtemp(prefix="dsh-fix-download-"))
    source = directory / "source.bin"
    source.write_bytes(payload)
    state: dict[str, Any] = {}

    class _FakeDownload:
        """``download`` 事件对象的替身：``path()`` 指到真实夹具文件。"""

        def path(self) -> str:
            """回夹具路径。"""
            return str(source)

    class _Pending:
        """``expect_download`` 的上下文管理器替身。"""

        def __init__(self) -> None:
            self.value = _FakeDownload()

        def __enter__(self) -> _Pending:
            """进入。"""
            return self

        def __exit__(self, *_exc: Any) -> None:
            """不吞异常。"""
            return

    class _FakePage:
        """够附件路径用的假页。"""

        def set_default_timeout(self, timeout_ms: int) -> None:
            """记下页级超时。"""
            state["page_timeout_ms"] = timeout_ms

        def set_extra_http_headers(self, headers: dict[str, str]) -> None:
            """记下请求头。"""
            state["headers"] = headers

        def expect_download(self, timeout: int | None = None) -> _Pending:
            """记下下载等待窗口并回夹具。"""
            state["download_timeout_ms"] = timeout
            return _Pending()

        def goto(self, url: str, wait_until: str | None = None) -> None:
            """触发下载的导航在 Chromium 里必失败。"""
            del url, wait_until
            raise RuntimeError("Page.goto: Download is starting")

        def close(self) -> None:
            """关页。"""
            state["page_closed"] = True

    class _FakeContext:
        """``session.context`` 的替身。"""

        def __init__(self) -> None:
            self.page = _FakePage()

        def new_page(self) -> _FakePage:
            """开一页。"""
            return self.page

    class _FakeSession:
        """``StealthySession`` 的替身：只实现附件路径用到的面。"""

        last: _FakeSession | None = None

        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs
            self.context = _FakeContext()
            self.closed = False
            _FakeSession.last = self

        def start(self) -> None:
            """起会话。"""
            state["started"] = True

        def close(self) -> None:
            """关会话。"""
            self.closed = True

    class _FetcherBoom:
        """``StealthyFetcher`` 的替身：附件响应让 goto 失败。"""

        @classmethod
        def fetch(cls, url: str, **kwargs: Any) -> Any:
            """复现上游对附件响应的失败形态。"""
            del url, kwargs
            raise RuntimeError("Page.goto: Download is starting")

    saved_fetcher = fetchers.StealthyFetcher
    saved_session = fetchers.StealthySession
    saved_page_setup = adapters.page_setup
    setattr(fetchers, "StealthyFetcher", _FetcherBoom)  # noqa: B010
    setattr(fetchers, "StealthySession", _FakeSession)  # noqa: B010

    def _record_setup(page: Any) -> None:
        """记下 page_setup 真被调用，且拿到的是即将驱动的那一页。"""
        state["setup_page"] = page

    setattr(adapters, "page_setup", _record_setup)  # noqa: B010
    try:
        result = media._download_via_browser(
            "https://unit.test/file.pdf",
            name="unit.pdf",
            directory=directory,
            limit=1024,
            timeout=7.0,
            headers={"X-Uni": "t"},
        )
    finally:
        setattr(fetchers, "StealthyFetcher", saved_fetcher)  # noqa: B010
        setattr(fetchers, "StealthySession", saved_session)  # noqa: B010
        setattr(adapters, "page_setup", saved_page_setup)  # noqa: B010

    check("P4 附件响应改走 download 事件且落盘成功", result.get("bytes") == len(payload), repr(result))
    written = Path(str(result.get("path", "")))
    check("P4 落盘字节与附件一致", written.is_file() and written.read_bytes() == payload, str(written))
    sha = str(result.get("sha256", ""))
    check("P4 返回 200 与 sha256", result.get("status") == 200 and len(sha) == 64, repr(result))
    check("P4 页级超时按 timeout 换算成毫秒", state.get("page_timeout_ms") == 7_000, repr(state))
    check("P4 下载等待窗口同为 timeout", state.get("download_timeout_ms") == 7_000, repr(state))
    last_session = _FakeSession.last
    check(
        "P4 会话构造带毫秒超时",
        last_session is not None and last_session.kwargs.get("timeout") == 7_000,
        repr(last_session),
    )
    check("P4 page_setup 在下载前挂上", state.get("setup_page") is not None, "")
    check("P4 extraHeaders 挂到页上", state.get("headers") == {"X-Uni": "t"}, repr(state.get("headers")))
    check(
        "P4 会话与页都被收掉",
        state.get("page_closed") is True and last_session is not None and last_session.closed,
        repr(state),
    )

    class _SessionBoom:
        """两次都失败的替身：构造后开页就炸。"""

        def __init__(self, **kwargs: Any) -> None:
            del kwargs
            self.context = self

        def start(self) -> None:
            """起会话。"""

        def close(self) -> None:
            """关会话。"""

        def new_page(self) -> Any:
            """开页失败。"""
            raise RuntimeError("no browser context")

    setattr(fetchers, "StealthyFetcher", _FetcherBoom)  # noqa: B010
    setattr(fetchers, "StealthySession", _SessionBoom)  # noqa: B010
    try:
        error = _expect(
            "DOWNLOAD_FAILED",
            lambda: media._download_via_browser(
                "https://unit.test/file.pdf",
                name="unit.pdf",
                directory=directory,
                limit=1024,
                timeout=3.0,
                headers=None,
            ),
        )
    finally:
        setattr(fetchers, "StealthySession", saved_session)  # noqa: B010
    message = str(error)
    check("P4 两条路都失败时报 DOWNLOAD_FAILED", error is not None, message)
    check(
        "P4 失败文案同时带两条路的原文",
        "Download is starting" in message and "attachment fallback: RuntimeError: no browser context" in message,
        message,
    )
