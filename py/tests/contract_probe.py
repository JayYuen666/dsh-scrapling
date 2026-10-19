"""py/tests/contract_probe.py —— 拿真实 Scrapling 的签名核对 adapters 发出的每一个关键字。

为什么需要这一层：本仓其余 Python 用例断言的是「我们自己认为契约是什么」——全绿也证明不了
与上游对得上。而真实故障形态恰好是**静默失效**：Scrapling 的会话在 fetch 层只认
``_fetch_params`` 的那十几个字段（``engines/_browsers/_validators.py``），其余一律
**丢弃且不报错**；会话级才生效的东西（``record_requests``、``block_ads``、
``executable_path``、``cdp_url``、``locale``、``timezone_id``、``useragent``、``headless``）
从 fetch 传进去就等于没传。表现是「设置卡拧了旋钮，行为没变」，日志里一个字都没有。

做法：把引擎换成记录器，用**尽可能填满参数**的入参驱动 adapters 的真实代码路径，抓下
每个调用点实际发出的 kwargs，再逐一问上游：

* 一次性抓取（``Fetcher.get`` 与 ``StealthyFetcher.fetch``）—— 键必须在那一份 TypedDict 里
  （``GetRequestParams`` / ``DataRequestParams`` / ``StealthSession``）。
* 会话开场（``FetcherSession(...)`` / ``StealthySession(...)``，含 ``capture`` 自起的那一个）——
  同上，这是那些「只有会话级才生效」的键唯一该出现的地方。
* 会话抓取与 ``capture`` 的抓取步（``session.fetch``）—— 键必须是**这次 fetch 真会读**的：
  ``_fetch_params`` 的字段，加上实现自己 ``pop`` 出来的 ``proxy``。

顺带钉住本仓代码直接依赖的上游事实（``facts``）：私有函数名、返回拼接方式、Spider 基类默认
值。这些都不是稳定公开面，上游一改本仓就该在测试里红，而不是在用户机器上炸。

Scrapling 0.5 把 ``extra_flags`` 从「顶掉内建反检测 flag」改成「叠加到它们之上」（上游
``_base.py`` 的 ``__generate_options__``），于是「传了 extra_flags 整套 stealth 就没了」这条
旧不变量作废。取而代之的两条新不变量：本仓任何路径都**不发** ``extra_flags``；走代理时
``block_webrtc`` 为真（WebRTC 防泄露在 0.5 由那一条开关承担，不再靠启动参数）。

输出：一行 JSON 到 stdout。约定「stdout 只给结论」，任何上游的进度/日志一律不管——本脚本不是
sidecar。

用法::

    python3 py/tests/contract_probe.py
"""

from __future__ import annotations

import inspect
import json
import sys
import tempfile
from contextlib import contextmanager, suppress
from dataclasses import fields
from pathlib import Path
from typing import Any, Iterator, Literal

PY_DIR = Path(__file__).resolve().parent.parent
if str(PY_DIR) not in sys.path:
    sys.path.insert(0, str(PY_DIR))

import adapters  # noqa: E402
from scrapling.engines._browsers import _types as engine_types  # noqa: E402
from scrapling.engines._browsers._validators import _fetch_params  # noqa: E402

# 一份够用的 HTML：to_payload 三条提取路径都要在它上面真跑一遍，否则记录器抓不到后续参数。
HTML = "<html><head><title>T</title></head><body><h1>HELLO</h1><p>body text</p></body></html>"
URL = "http://contract.test/page"

# 记录下来的每个调用点：site -> 该点发出的 kwargs 列表。
CALLS: list[dict[str, Any]] = []

# 会话状态工具的落点目录。**不能写字面量 /tmp 路径**：那是 bandit 的 B108（硬编码临时目录），
# 而这条门禁只收 medium 及以上。用真的临时目录既躲开它，也比一个固定路径更不容易互相踩。
STATE_DIR = str(Path(tempfile.gettempdir()) / "scrapling-probe-state")

# 探针全程**假定部署配了代理**：那条路径才是问题所在 —— WebRTC 防泄露在走代理时才被强制
# 打开，而本仓的判据必须是「会话真正拿到的那份代理」，不是模型入参。不点亮这一档，
# block_webrtc 该不该为真就永远不会被这个探针看到。
PROXIED = True
PROXY_FOR_PROBE = "http://probe:probe@127.0.0.1:8899"

# 当前这一次构造会把 kwargs 记到哪个站点、把 fetch 记到哪个站点。同一个 ``StealthySession``
# 替身既服务会话开场、也服务 ``capture`` 自起的那一个，两者要靠这枚标签分家。
_SPAWN: dict[str, str] = {"open": "session.open.stealth", "fetch": "session.fetch.stealth"}


def _typed_keys(name: str) -> set[str]:
    """取上游 TypedDict 的键集合。

    用 ``__annotations__`` 而不是 ``get_type_hints``：后者的字符串注释里有
    ``Cookies`` 这类只在模块全局可见的名字，在 3.14 上会抛 NameError。

    :param name: TypedDict 的类名
    :returns: 键集合
    """
    target = getattr(engine_types, name)
    return set(target.__annotations__)


def _init_keys(obj: Any) -> set[str]:  # noqa: ANN401 —— 上游类，签名就是要钉的那个
    """取一个类 ``__init__`` 真正接受的具名参数。"""
    return {
        name
        for name, param in inspect.signature(obj.__init__).parameters.items()
        if name != "self" and param.kind in (param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY)
    }


def _response(url: str = URL) -> Any:  # noqa: ANN401 —— 返回上游 Response，形状由它定
    """造一个真 ``Response``，让 to_payload 走完整路径。"""
    return adapters._fake_response(HTML, url, 200)


def _record(site: str, kwargs: dict[str, Any], url: str = URL) -> Any:  # noqa: ANN401 —— 同上
    """记下一个调用点实际发出的关键字，并回一个可用的响应。

    :param site: 调用点名字
    :param kwargs: 发出的关键字
    :param url: 该次调用的 URL
    :returns: 一份真 Response
    """
    CALLS.append({"site": site, "url": url, "kwargs": dict(kwargs)})
    return _response(url)


@contextmanager
def _spawn_as(open_site: str, fetch_site: str) -> Iterator[None]:
    """把一次构造 + 抓取记到指定的一对站点上（见 :data:`_SPAWN` 的说明）。

    :param open_site: 构造 kwargs 记到的站点
    :param fetch_site: 该对象随后 fetch 记到的站点
    """
    saved = (_SPAWN["open"], _SPAWN["fetch"])
    _SPAWN["open"], _SPAWN["fetch"] = open_site, fetch_site
    try:
        yield
    finally:
        _SPAWN["open"], _SPAWN["fetch"] = saved


class _StaticEngine:
    """``Fetcher`` 的替身：四个动词各自记录，返回真响应。"""

    @staticmethod
    def _make(verb: str) -> Any:  # noqa: ANN401 —— 动态构造的方法，签名跟着 verb 走
        """造一个记录用的方法。

        闭包把 verb 绑成默认参数：直接引用外层循环变量会踩 B023 那一类问题（这里虽在
        单次调用内，但绑成参数是让「记录点与动词一一对应」这件事不依赖调用时序）。

        :param verb: get / post / put / delete
        :returns: 可挂到类上的静态方法
        """

        def call(url: str, **kwargs: Any) -> Any:  # noqa: ANN401 —— 与上游签名一致
            """记录并返回响应。"""
            return _record(f"static.{verb}", kwargs, url)

        return staticmethod(call)

    def __getattr__(self, name: str) -> Any:  # noqa: ANN401 —— 替身按动词现造方法
        """按名字给出 get/post/put/delete 的记录方法。"""
        if name in ("get", "post", "put", "delete"):
            return self._make(name)
        raise AttributeError(name)


class _BrowserEngine:
    """``StealthyFetcher`` 的替身（一次性抓取）。"""

    def __init__(self, site: str) -> None:
        """:param site: 记录点名字"""
        self._site = site

    def fetch(self, url: str, **kwargs: Any) -> Any:  # noqa: ANN401 —— 与上游签名一致
        """记录并返回响应。"""
        return _record(self._site, kwargs, url)


class _StaticSession:
    """``FetcherSession`` 的替身：开场记一次，``__enter__`` 返回记用的 logic。"""

    def __init__(self, **kwargs: Any) -> None:
        """:param kwargs: 开场参数"""
        CALLS.append({"site": "session.open.static", "url": None, "kwargs": dict(kwargs)})
        self._logic = _StaticLogic()

    def __enter__(self) -> "_StaticLogic":
        """进入上下文。

        真实 ``FetcherSession.__enter__`` 返回的是 ``_SyncSessionLogic``，**不是自己** ——
        adapters 存的正是这个返回值（``session.get`` 打在它身上）。替身必须同形，否则
        「存错对象」这一类缺陷在本探针里就照不出来。

        :returns: 可发请求的 logic
        """
        return self._logic

    def __exit__(self, *args: Any) -> Literal[False]:
        """退出上下文。

        :param args: 异常三元组
        :returns: 不吞异常
        """
        return False


class _StaticLogic:
    """static 会话进入上下文后的请求对象（``_SyncSessionLogic`` 的替身）。"""

    def get(self, url: str, **kwargs: Any) -> Any:  # noqa: ANN401 —— 与上游签名一致
        """记录并返回响应。"""
        return _record("session.fetch.static", kwargs, url)


class _NetworkStub:
    """会话网络记录的替身：``enabled`` 为真、``search`` 回空表。

    没有它，``session.network`` 会在读到 ``enabled`` 之前就抛 NETWORK_NOT_RECORDED，于是
    「这个方法的入参分支读了哪些键」这条记录会缺一段 —— 而那正是探针要留的证据。
    """

    enabled = True

    def search(self, *_args: Any, **_kwargs: Any) -> list[Any]:
        """回一份空的网络历史。"""
        return []


class _StealthSession:
    """``StealthySession`` 的替身：开场记一次，fetch / 状态读写按当前标签记。"""

    def __init__(self, **kwargs: Any) -> None:
        """:param kwargs: 开场参数"""
        CALLS.append({"site": _SPAWN["open"], "url": None, "kwargs": dict(kwargs)})
        self._fetch_site = _SPAWN["fetch"]
        self.network = _NetworkStub()

    def start(self) -> None:
        """开场（替身无事可做）。"""

    def fetch(self, url: str, **kwargs: Any) -> Any:  # noqa: ANN401 —— 与上游签名一致
        """记录并返回响应。"""
        return _record(self._fetch_site, kwargs, url)

    def close(self) -> None:
        """关闭（替身无事可做）。"""

    def save_state(self, path: str) -> None:
        """记下落点（替身不写文件）。"""
        self.state_path = path

    def load_state(self, path: str) -> None:
        """记下落点（替身不读文件）。"""
        self.state_path = path


def _install_recorders() -> dict[str, Any]:
    """把两套引擎与两类会话换成记录器。

    :returns: 还原所需的原对象（本脚本一次性运行，不还原也行，但留着便于单点调试）
    """
    import scrapling.fetchers as fetchers

    originals = {
        "Fetcher": adapters.Fetcher,
        "StealthyFetcher": adapters.StealthyFetcher,
        "fetchers": fetchers,
        "names": ("FetcherSession", "StealthySession"),
        "sessions": (fetchers.FetcherSession, fetchers.StealthySession),
    }
    adapters.Fetcher = _StaticEngine()  # type: ignore[misc,assignment]
    adapters.StealthyFetcher = _BrowserEngine("browser.render")  # type: ignore[misc,assignment]
    fetchers.FetcherSession = _StaticSession  # type: ignore[misc,assignment]
    fetchers.StealthySession = lambda **kw: _StealthSession(**kw)  # type: ignore[misc,assignment]
    return originals


def _restore(originals: dict[str, Any]) -> None:
    """装回真实引擎。

    :param originals: :func:`_install_recorders` 的返回
    """
    adapters.Fetcher = originals["Fetcher"]  # type: ignore[misc,assignment]
    adapters.StealthyFetcher = originals["StealthyFetcher"]  # type: ignore[misc,assignment]
    fetchers = originals["fetchers"]
    for name, obj in zip(originals["names"], originals["sessions"], strict=True):
        setattr(fetchers, name, obj)


# 每个调用点该出现在上游哪一份参数面里。
SESSION_LEVEL = {
    "browser.render": "StealthSession",
    "capture.open": "StealthSession",
    "session.open.stealth": "StealthSession",
}
STATIC_LEVEL = {
    "static.get": "GetRequestParams",
    "static.post": "DataRequestParams",
    "static.put": "DataRequestParams",
    "static.delete": "DataRequestParams",
    "session.open.static": "RequestsSession",
    "session.fetch.static": "GetRequestParams",
}

# 走 fetch 层参数面的站点：会话内每次抓取与 capture 的抓取步。
FETCH_LEVEL_SITES = frozenset({"session.fetch.stealth", "capture.fetch"})

# 会话 fetch 的入参里，实现自己会 pop 掉的键（不在 _fetch_params 字段里但确实生效）。
POPPED_BY_FETCH = frozenset({"proxy"})

# 这些键只在会话开场生效；从 fetch 传过去被丢弃时，「本可以」在开场补上。
SESSION_ONLY_HOPE = tuple(sorted(adapters.SESSION_ONLY_KEYS))


def _full_args(extra: dict[str, Any]) -> dict[str, Any]:
    """一份把 adapters 读取到的抽取参数全部填满的入参。

    :param extra: 该调用点特有的参数
    :returns: 协议参数
    """
    base: dict[str, Any] = {
        "url": URL,
        "extractionType": "html",
        "cssSelector": "body",
        "mainContentOnly": True,
        "maxContentChars": 5000,
        "deployment": {
            # 必须是**真实存在**的文件：上游对 executable_path 有存在性校验
            # （_validators.py 的 _is_invalid_file_path）。cdp_url 在按 kwargs
            # 真造会话那一步会被摘掉（见 _launch_args），所以这里给什么都行。
            "browserExecutablePath": sys.executable,
            "browserCdpUrl": "http://127.0.0.1:9222",
            "stripInlineImages": True,
        },
    }
    return {**base, **extra}


def _browser_args() -> dict[str, Any]:
    """浏览器类调用点的特有参数（把 _browser_params 读到的键全部点亮）。

    :returns: 协议参数增量
    """
    return {
        "headless": True,
        "timeoutMs": 12_000,
        "blockAds": True,
        "networkIdle": True,
        "waitSelector": "#app",
        "waitSelectorState": "visible",
        "useragent": "ContractProbe/1.0",
        "locale": "zh-CN",
        "timezoneId": "Asia/Shanghai",
        "waitMs": 50,
        "extraHeaders": {"X-Probe": "1"},
        "solveCloudflare": True,
        "pierceShadow": True,
        "hideCanvas": True,
        "blockWebrtc": True,
        "allowWebgl": False,
    }


def drive() -> None:
    """驱动 adapters 的全部引擎调用点，让记录器抓到真实 kwargs。"""
    adapters.render(_full_args(_browser_args()))
    adapters.fetch(_full_args({"timeoutSeconds": 30.0, "retries": 2, "headers": {"A": "b"}}))
    adapters.fetch(_full_args({"method": "POST", "body": {"k": "v"}, "cookies": {"c": "1"}}))
    with _spawn_as("capture.open", "capture.fetch"):
        adapters.capture(
            _full_args(
                {
                    **_browser_args(),
                    "urlPattern": "/api/",
                    "networkLimit": 10,
                    "includeBody": True,
                    "maxBodyChars": 200,
                }
            )
        )

    for kind, open_args in (
        (
            "static",
            {"sessionType": "static", "impersonate": "chrome", "timeoutSeconds": 20.0},
        ),
        (
            "stealth",
            {
                "sessionType": "stealth",
                "headless": True,
                "timeoutMs": 9000,
                "solveCloudflare": True,
                "hideCanvas": True,
                "allowWebgl": False,
            },
        ),
    ):
        extra = _browser_args() if kind != "static" else {}
        info = adapters.session_open(_full_args({**open_args, **extra, "sessionId": f"s-{kind}"}))
        assert info["sessionId"] == f"s-{kind}"
        fetch_extra = _browser_args() if kind != "static" else {"timeoutSeconds": 15.0, "retries": 1}
        adapters.session_fetch(_full_args({**fetch_extra, "sessionId": f"s-{kind}"}))
        if kind != "static":
            adapters.session_network(
                _full_args(
                    {
                        "sessionId": f"s-{kind}",
                        "urlPattern": "/api/",
                        "networkLimit": 5,
                        "includeBody": False,
                        "maxBodyChars": 50,
                    }
                )
            )
            for verb in ("session_state_save", "session_state_load"):
                getattr(adapters, verb)(
                    {"sessionId": f"s-{kind}", "name": "login", "deployment": {"sessionStateDir": STATE_DIR}}
                )
        adapters.session_close({"sessionId": f"s-{kind}"})
    adapters.close_all_sessions()

    # 离线抽取与选择器：不发网络，但要确认传给 Selector / Response 的键名是上游真收的。
    adapters.extract(_full_args({"html": HTML}))
    adapters.select(
        {
            "html": HTML,
            "selector": "h1",
            "adaptive": True,
            "auto_save": True,
            "url": "http://contract.test",
            "limit": 10,
            "maxContentChars": 1000,
            "includeAttributes": True,
        }
    )
    adapters.select({"html": HTML, "selector": "//h1", "useXpath": True, "adaptive": True, "url": URL})


class Recording(dict):  # type: ignore[type-arg]
    """记录每一次按键读取的字典。

    为什么不用静态解析：adapters 里有一批「按表驱动」的读法 ——
    ``for key, name in (("waitSelector", "wait_selector"), ...): args.get(key)`` 与
    ``for source, target in (("browserExecutablePath", "executable_path"), ...):
    deployment.get(source)`` —— 静态扫源码只能看见字面量 `key`/`source`，看不见真正被查的
    键名。问运行时才没有这类误报：**它查了哪个键，就记哪个**。

    嵌套的那一层（``deployment``）必须与外层共用同一个记账表，否则 ``deployment.get(...)``
    读到的键会记在子字典身上、外层看不见 —— 而那正是「Host 发了、Python 读不读」最需要看得到
    的一层。

    :param data: 初始内容
    :param seen: 共享的记账表；子层必须传同一份
    :param path: 本层的键名前缀
    """

    def __init__(self, data: dict[str, Any], seen: set[str] | None = None, path: tuple[str, ...] = ()) -> None:
        """:param data: 初始内容
        :param seen: 共享记账表
        :param path: 键名前缀
        """
        self.seen = seen if seen is not None else set()
        self.path = path
        children: dict[str, Any] = {}
        for key, value in data.items():
            children[key] = Recording(value, self.seen, (*path, str(key))) if isinstance(value, dict) else value
        super().__init__(children)

    def _mark(self, key: str) -> None:
        """记下一次按键读取。"""
        self.seen.add(".".join([*self.path, str(key)]))

    def get(self, key: str, default: Any = None) -> Any:  # noqa: ANN401 —— 与 dict.get 同形
        """取一个键并记账。"""
        self._mark(key)
        return super().get(key, default)

    def __getitem__(self, key: str) -> Any:  # noqa: ANN401 —— 与 dict.__getitem__ 同形
        """取一个键并记账。"""
        self._mark(key)
        return super().__getitem__(key)


# 一份「所有可能被读的键都给上合法值」的入参。判据是运行时真查了哪些，而不是这里给了哪些，
# 所以宁可给多：给少了只会让 reads 少记一条，给错了会让调用在到达读取点之前就抛。
READ_PROBE_ARGS: dict[str, Any] = {
    "url": URL,
    "html": HTML,
    "selector": "h1",
    "attribute": "class",
    "useXpath": False,
    "adaptive": True,
    "limit": 5,
    "includeAttributes": True,
    "extractionType": "html",
    "cssSelector": "body",
    "mainContentOnly": True,
    "maxContentChars": 5000,
    "status": 200,
    "method": "GET",
    "body": {"a": 1},
    "headers": {"X-Probe": "1"},
    "cookies": {"c": "1"},
    "impersonate": "chrome",
    "timeoutSeconds": 20.0,
    "retries": 2,
    "sessionId": "s-reads",
    "sessionType": "static",
    "recordNetwork": True,
    "crawlId": "c-reads",
    "maxPages": 2,
    "maxDurationMs": 60_000,
    "since": 0,
    "urlPattern": "/api/",
    "networkLimit": 5,
    "includeBody": False,
    "maxBodyChars": 500,
    "name": "login",
    "deployment": {
        "stripInlineImages": True,
        "browserExecutablePath": sys.executable,
        "browserCdpUrl": "",
        "browserInitScript": "",
        "browserRealChrome": False,
        "browserDnsOverHttps": False,
        "recordRequests": False,
        "maxRecordedRequests": 100,
        "sessionStateDir": STATE_DIR,
        "crawlRespectRobots": False,
        "crawlDownloadDelayMs": 0,
        "crawlConcurrentRequests": 4,
        "crawlAutothrottle": False,
        "crawlStrategy": "bfs",
        "crawlCheckpointDir": "",
    },
    **_browser_args(),
}


# 同一份入参只能走一条分支，而 adapters 里大量读取写在分支里（`session.open` 的两种类型、
# `session.fetch` 的两种类型、`fetch` 的 GET 与非 GET，以及只在浏览器会话上读的那几条）。
# 只跑一遍会把「分支里真读了」误报成「没读」——那种误报一旦进门禁，就逼着人去加豁免，
# 而豁免加多了，真正的「发了没人读」也跟着沉默。所以按方法列出要走的分支。
READ_VARIANTS: dict[str, list[dict[str, Any]]] = {
    "session.open": [{"sessionType": kind} for kind in ("static", "stealth")],
    "session.fetch": [{"sessionType": kind} for kind in ("static", "stealth")],
    "session.network": [{"sessionType": "stealth"}],
    "session.state_save": [{"sessionType": "stealth"}],
    "session.state_load": [{"sessionType": "stealth"}],
    "fetch": [{"method": verb} for verb in ("GET", "POST")],
}


def reads_by_method() -> dict[str, list[str]]:
    """逐个方法真跑一遍（含各分支），记下 Python 侧实际读取的键。

    :returns: 方法名到读过的键列表
    """
    import crawl

    originals = _install_recorders()
    # 读取面这一趟会把引擎调用点也记进 CALLS，而 check()/facts() 读的是「按完整参数驱动
    # adapters 的那批记录」。两拨混在一起，站点级断言就取决于跑序 —— 临时收起来，跑完再还。
    saved_calls = CALLS[:]
    CALLS.clear()
    # crawl.run 会起后台线程；这里只要它把参数读完，不需要真蜘蛛。
    spider_maker = crawl._make_spider
    emit = crawl._emit_event
    crawl._make_spider = lambda *args, **kwargs: object()
    # 事件帧走的是 stdout，而本探针的 stdout 只留给最后那行结论。
    crawl._emit_event = lambda *args, **kwargs: None

    try:
        out: dict[str, list[str]] = {}
        for method, handler in sorted(adapters.METHODS.items()):
            seen: set[str] = set()
            for variant in READ_VARIANTS.get(method, [{}]):
                kind = str(variant.get("sessionType", "static"))
                adapters.close_all_sessions()
                if method.startswith("session.") and method != "session.open":
                    # 这几个方法要求会话**已经存在**，而且类型要和当前分支一致：拿 static 的
                    # 会话去跑浏览器分支，读到的是另一支的参数表，本表就会漏键。
                    # session.open 反过来要求那个 id **没被占用**，否则它读完两个键就以
                    # 「session already exists」收场，分支里的键一个都读不到。
                    adapters.session_open(dict(READ_PROBE_ARGS, sessionType=kind, sessionId="s-reads"))
                # 读完参数之后怎么失败都与本表无关：分支里抛的是抓取本身，不是键的读法。
                with suppress(Exception):
                    handler(Recording(dict(READ_PROBE_ARGS, **variant), seen))
            adapters.close_all_sessions()
            out[method] = sorted(seen)
        return out
    finally:
        crawl._make_spider = spider_maker
        crawl._emit_event = emit
        adapters.close_all_sessions()
        _restore(originals)
        adapters.close_all_sessions()
        CALLS[:] = saved_calls


def _fetch_effective_keys() -> set[str]:
    """会话 fetch 真会读的键。

    :returns: 有效键集合
    """
    return {field.name for field in fields(_fetch_params)} | POPPED_BY_FETCH


def _stripped_tags() -> list[str]:
    """实测 ``_strip_noise_tags`` 到底丢了哪些标签（不抄上游源码的注释）。

    :returns: 被丢掉的标签名
    """
    from scrapling.core.shell import Convertor
    from scrapling.parser import Selector

    candidates = ("script", "style", "noscript", "svg", "iframe", "p")
    doc = "".join(f"<{tag}>x</{tag}>" for tag in candidates)
    cleaned = Convertor._strip_noise_tags(Selector(doc)).html_content
    return sorted(tag for tag in candidates if f"<{tag}" not in cleaned)


def _launch_args(site: str) -> list[str]:
    """按某个调用点实际发出的 kwargs 真造一次会话，取它最终拿到的启动参数。

    不问「我们传了什么」，问「上游据此做了什么」：``_base.py`` 里
    ``__generate_options__`` 现在把 ``config.extra_flags`` **叠加**到 ``__generate_stealth_options``
    递进来的那套反检测 flag 上（0.5 起），所以「本仓到底发没发 extra_flags」这件事只能问
    上游产物本身，而不是读我们那张表。

    ``cdp_url`` / ``executable_path`` 在造之前摘掉：连上远端浏览器时上游**本来就不下发**
    启动参数（``_base.py`` 里 ``_browser_options = {}``），留着它等于把「参数面」与
    「上游按设计不传」两件事混成同一个读数。

    :param site: 调用点名字（必须是 stealth 的会话级站点）
    :returns: 最终的 chromium 启动参数；造不出来时给空表
    """
    call = next((item for item in CALLS if item["site"] == site), None)
    if call is None:
        return []
    import scrapling.fetchers as fetchers

    kwargs = dict(call["kwargs"])
    # page_setup 是回调，与启动参数无关；executable_path / cdp_url 见上面说明。
    for drop in ("page_setup", "cdp_url", "executable_path"):
        kwargs.pop(drop, None)
    try:
        session = fetchers.StealthySession(**kwargs)
    except Exception:  # noqa: BLE001 —— 造不出来本身就是结论，由调用侧按空表判
        return []
    try:
        return list(session._browser_options.get("args", []))
    finally:
        _close_quietly(session)


def _close_quietly(session: Any) -> None:  # noqa: ANN401 —— 只为释放构造品
    """关掉一个只被构造、从未 start 的会话。"""
    with suppress(Exception):
        session.close()


def _stealth_check() -> list[dict[str, Any]]:
    """stealth 路径上的两条新不变量。

    0.5 把 ``extra_flags`` 从「顶掉内建 flag」改成「叠加」，于是旧不变量（传了 extra_flags
    整套 stealth 就没了）反转成：**本仓任何路径都不该发 extra_flags**。同一条 PR 把 WebRTC
    防泄露移交给 ``block_webrtc`` 开关本身，而本仓的取舍是「走代理时强制为真」——这条判据
    只能对着实际发出的 kwargs 判，不能对着某个开关的默认值判。

    顺带钉住那套反检测 flag 仍在：since extra_flags 是叠加的，它们不再会因为「我们发了
    extra_flags」而消失，但任何把它整段顶掉的改动都该在这里红。

    :returns: 违规列表
    """
    from scrapling.engines.constants import STEALTH_ARGS

    issues: list[dict[str, Any]] = []
    for call in CALLS:
        if "extra_flags" in call["kwargs"]:
            issues.append({"site": call["site"], "unexpected": "extra_flags"})
    for site in ("browser.render", "session.open.stealth", "capture.open"):
        # 逐项找而不是 next(..., None)：mypy 在这一处的 next 重载上判 default 的类型不合，
        # 而这里「没这个站点」与「有这个站点」本来就要分开处理（见下面的 continue）。
        matched: dict[str, Any] | None = None
        for item in CALLS:
            if item["site"] == site:
                matched = item
                break
        if matched is None:
            continue
        if PROXIED and matched["kwargs"].get("block_webrtc") is not True:
            issues.append({"site": site, "missing": "block_webrtc (a proxy is configured)"})
    args = _launch_args("browser.render")
    missing = sorted({flag for flag in STEALTH_ARGS if flag not in args})
    if missing:
        issues.append(
            {
                "site": "browser.render",
                "missingStealthArgs": len(missing),
                "of": len(STEALTH_ARGS),
                "sample": missing[:3],
                "totalArgs": len(args),
            }
        )
    return issues


def check() -> dict[str, Any]:
    """把抓到的 kwargs 与上游参数面逐一对照。

    :returns: 报告
    """
    violations: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    checked: dict[str, int] = {}

    for call in CALLS:
        site = call["site"]
        keys = set(call["kwargs"])
        checked[site] = len(keys)
        if site in STATIC_LEVEL:
            allowed = _typed_keys(STATIC_LEVEL[site])
            unknown = sorted(keys - allowed)
            if unknown:
                violations.append({"site": site, "keys": unknown, "expected": STATIC_LEVEL[site]})
        elif site in SESSION_LEVEL:
            allowed = _typed_keys(SESSION_LEVEL[site])
            unknown = sorted(keys - allowed)
            if unknown:
                violations.append({"site": site, "keys": unknown, "expected": SESSION_LEVEL[site]})
        elif site in FETCH_LEVEL_SITES:
            effective = _fetch_effective_keys()
            silent = sorted(keys - effective)
            if silent:
                dropped.append(
                    {
                        "site": site,
                        "keys": silent,
                        # 这些键只在会话开场生效：从 fetch 传过去被静默丢弃时，「本可以」在开场补上。
                        "honorableAtOpen": sorted(set(silent) & _typed_keys("StealthSession")),
                    }
                )

    return {
        "checked": checked,
        "violations": violations,
        "silentAtSessionFetch": dropped,
        "stealthInvariants": _stealth_check(),
        # 本仓自己声明的「fetch 层认哪些键」必须与上游 `_fetch_params` 的实际字段一致：
        # 上游加了字段而我们没跟，就是白扔一个能生效的设置；我们多写了上游不认的键，就是
        # 又造一个静默丢弃。两个方向都是漂移，这里一次算出来。
        "fetchLevelKeysDrift": sorted(_fetch_effective_keys() ^ adapters.FETCH_LEVEL_KEYS),
        "sessionFetchFields": sorted(_fetch_effective_keys()),
        "sessionOnlyHope": list(SESSION_ONLY_HOPE),
    }


def facts() -> dict[str, Any]:
    """钉住本仓代码直接依赖的上游事实。

    :returns: 事实表
    """
    from scrapling.core.shell import Convertor
    from scrapling.engines.constants import DEFAULT_ARGS, STEALTH_ARGS
    from scrapling.engines.toolbelt.custom import Response
    from scrapling.fetchers import Fetcher
    from scrapling.parser import Selector
    from scrapling.spiders import SiteToMarkdownSpider, Spider
    from scrapling.spiders.session import SessionManager

    css = inspect.signature(Selector.css)
    markdown = inspect.signature(Response.markdown)
    return {
        "fetcherVerbs": sorted(name for name in ("get", "post", "put", "delete", "fetch") if hasattr(Fetcher, name)),
        "selectorCssParams": list(css.parameters),
        "selectorCssDefaultPercentage": css.parameters["percentage"].default,
        "responseMarkdownParams": list(markdown.parameters),
        "convertorPrivates": [
            name
            for name in ("_strip_noise_tags", "_sanitize_for_ai", "_extract_content", "_convert_to_markdown")
            if hasattr(Convertor, name)
        ],
        "noiseTagsActuallyStripped": _stripped_tags(),
        "storageInitParams": sorted(_init_keys(_real_storage())),
        # 反检测参数的条数基线：本仓发出的 kwargs 真造一次 stealth 会话后拿到的启动参数条数。
        # 钉的是「这套 flag 还在、没被 extra_flags 之类的输入整段换掉」。
        "stealthArgCount": len(_launch_args("browser.render")),
        "stealthArgsTotal": len(STEALTH_ARGS),
        "defaultArgsTotal": len(DEFAULT_ARGS),
        "spiderDefaults": {
            "robots_txt_obey": Spider.robots_txt_obey,
            "autothrottle_enabled": Spider.autothrottle_enabled,
            "download_delay": Spider.download_delay,
            "concurrent_requests": Spider.concurrent_requests,
            "max_pages": SiteToMarkdownSpider.max_pages,
            "output_dir": SiteToMarkdownSpider.output_dir,
            "main_content_only": SiteToMarkdownSpider.main_content_only,
        },
        "spiderAttrs": sorted(
            name
            for name in ("name", "start_urls", "allowed_domains", "max_pages", "output_dir")
            if hasattr(SiteToMarkdownSpider, name)
        ),
        "sessionManagerAddParams": sorted(str(name) for name in inspect.signature(SessionManager.add).parameters),
        "crawlHooks": sorted(
            name
            for name in ("configure_sessions", "on_scraped_item", "pause", "start", "parse", "rules")
            if hasattr(SiteToMarkdownSpider, name)
        ),
        "responseInitParams": sorted(_init_keys(Response)),
        "redactionTargets": sorted(adapters._SECRET_QUERY_KEYS),
    }


def _real_storage() -> Any:  # noqa: ANN401 —— 上游类，签名就是要钉的那个
    """取真实存储类（不解绑 lru_cache 的包装拿不到 __init__ 的具名参数）。

    :returns: ``SQLiteStorageSystem`` 的原类
    """
    from scrapling.core.storage import SQLiteStorageSystem

    return SQLiteStorageSystem.__wrapped__  # type: ignore[attr-defined]


def main() -> int:
    """跑一遍并输出 JSON。

    先把工作目录换到临时目录：``select(adaptive=True)`` 会按相对路径开 SQLite 库
    （ADAPTIVE_STORAGE_FILE），而 vitest 是以仓库根为 cwd 跑探针的 —— 不换目录就会把
    elements_storage.db 连同 -wal / -shm 拉进仓库，那是运行时状态而不是源码。

    :returns: 退出码
    """
    import os
    import tempfile

    import guard

    os.chdir(tempfile.mkdtemp(prefix="dsh-scrapling-contract-"))

    # 让 guard 看见一份代理配置（见上面 PROXIED 的说明），随后才去驱动各调用点。
    # 写方法同样要开着：drive() 里那条 POST 分支是探针要驱动的一条，被 WRITE_DISABLED 拦下
    # 的话「adapters 到底把哪个键交给了上游」就答不出来了 —— 探针验的是键，不是闸门。
    os.environ["DSH_SCRAPLING_PROXY"] = PROXY_FOR_PROBE
    os.environ["DSH_SCRAPLING_ALLOW_WRITE_METHODS"] = "1"
    guard.configure_from_env()

    originals = _install_recorders()
    try:
        drive()
    finally:
        _restore(originals)
        adapters.close_all_sessions()
    report = check()
    report["facts"] = facts()
    report["methods"] = sorted(adapters.METHODS)
    report["reads"] = reads_by_method()
    report["calls"] = [{"site": call["site"], "keys": sorted(call["kwargs"])} for call in CALLS]
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
