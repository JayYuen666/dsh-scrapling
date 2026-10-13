"""py/tests/contract_probe.py —— 拿真实 Scrapling 的签名核对 adapters 发出的每一个关键字。

为什么需要这一层：本仓其余 Python 用例断言的是「我们自己认为契约是什么」——全绿也证明不了
与上游对得上。而真实故障形态恰好是**静默失效**：Scrapling 的会话在 fetch 层只认
``_fetch_params`` 的那十几个字段（``engines/_browsers/_validators.py``），其余一律
**丢弃且不报错**；会话级才生效的东西（``capture_xhr``、``block_ads``、``executable_path``、
``cdp_url``、``locale``、``timezone_id``、``useragent``、``headless``）从 fetch 传进去就
等于没传。表现是「设置卡拧了旋钮，行为没变」，日志里一个字都没有。

做法：把三套引擎换成记录器，用**尽可能填满参数**的入参驱动 adapters 的真实代码路径，抓下
每个调用点实际发出的 kwargs，再逐一问上游：

* 一次性抓取（``Fetcher.get`` / ``DynamicFetcher.fetch`` / ``StealthyFetcher.fetch``）——
  键必须在那一对 TypedDict 里（``GetRequestParams`` / ``DataRequestParams`` /
  ``PlaywrightSession`` / ``StealthSession``）。
* 会话开场（``FetcherSession(...)`` / ``DynamicSession(...)`` / ``StealthySession(...)``）——
  同上，这是那些「只有会话级才生效」的键唯一该出现的地方。
* 会话抓取（``session.get`` / ``session.fetch``）—— 键必须是**这次 fetch 真会读**的：
  ``_fetch_params`` 的字段，加上实现自己 ``pop`` 出来的 ``proxy``。

顺带钉住本仓代码直接依赖的上游事实（``facts``）：私有函数名、返回拼接方式、Spider 基类默认
值。这些都不是稳定公开面，上游一改本仓就该在测试里红，而不是在用户机器上炸。

输出：一行 JSON 到 stdout。约定「stdout 只给结论」，任何上游的进度/日志一律不管——本脚本不是
sidecar。

用法::

    python3 py/tests/contract_probe.py
"""

from __future__ import annotations

import inspect
import json
import sys
from contextlib import suppress
from dataclasses import fields
from pathlib import Path
from typing import Any, Literal

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

# 探针全程**假定部署配了代理**：那条路径才是问题所在 —— _browser_params 与 _make_session
# 只在有代理时塞 extra_flags，而 extra_flags 会整段顶掉 stealth 的 53 条反检测参数。
# 不点亮这一档，stealth 的降级就永远不会被这个探针看到。
PROXIED = True
PROXY_FOR_PROBE = "http://probe:probe@127.0.0.1:8899"


def _typed_keys(name: str) -> set[str]:
    """取上游 TypedDict 的键集合。

    用 ``__annotations__`` 而不是 ``get_type_hints``：后者的字符串注释里有
    ``Cookies`` 这类只在模块全局可见的名字，在 3.14 上会抛 NameError。

    :param name: TypedDict 的类名
    :returns: 键集合
    """
    target = getattr(engine_types, name)
    return set(target.__annotations__)


def _init_keys(obj: Any) -> set[str]:
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


class _StaticEngine:
    """``Fetcher`` 的替身：四个动词各自记录，返回真响应。"""

    @staticmethod
    def _make(verb: str) -> Any:  # noqa: ANN401 —— 动态构造的方法，签名跟着 verb 走
        """造一个记录用的方法。

        闭包必须把 verb 绑成默认值：直接引用外层循环变量会踩 B023 那一类问题（这里虽在
        单次调用内，但绑成参数是让「记录点与动词一一对应」这件事不依赖调用时序）。

        :param verb: get / post / put / delete
        :returns: 可挂到类上的静态方法
        """

        def call(url: str, **kwargs: Any) -> Any:  # noqa: ANN401 —— 与上游签名一致
            """记录并返回响应。

            :param url: 目标地址
            :param kwargs: 引擎参数
            :returns: 真 Response
            """
            return _record(f"static.{verb}", kwargs, url)

        return staticmethod(call)

    def __getattr__(self, name: str) -> Any:  # noqa: ANN401 —— 替身按动词现造方法
        """按名字给出 get/post/put/delete 的记录方法。

        :param name: 方法名
        :returns: 静态方法
        """
        if name in ("get", "post", "put", "delete"):
            return self._make(name)
        raise AttributeError(name)


class _BrowserEngine:
    """``DynamicFetcher`` / ``StealthyFetcher`` 的替身（一次性抓取）。"""

    def __init__(self, site: str) -> None:
        """:param site: 记录点名字"""
        self._site = site

    def fetch(self, url: str, **kwargs: Any) -> Any:  # noqa: ANN401 —— 与上游签名一致
        """记录并返回响应。

        :param url: 目标地址
        :param kwargs: 引擎参数
        :returns: 真 Response
        """
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
        """记录并返回响应。

        :param url: 目标地址
        :param kwargs: 引擎参数
        :returns: 真 Response
        """
        return _record("session.fetch.static", kwargs, url)


class _BrowserSession:
    """``DynamicSession`` / ``StealthySession`` 的替身。"""

    def __init__(self, kind: str, **kwargs: Any) -> None:
        """:param kind: browser / stealth
        :param kwargs: 开场参数
        """
        self._kind = kind
        self._site = f"session.open.{kind}"
        self._fetch_site = f"session.fetch.{kind}"
        CALLS.append({"site": self._site, "url": None, "kwargs": dict(kwargs)})

    def start(self) -> None:
        """开场（替身无事可做）。"""

    def fetch(self, url: str, **kwargs: Any) -> Any:  # noqa: ANN401 —— 与上游签名一致
        """记录并返回响应。

        :param url: 目标地址
        :param kwargs: 引擎参数
        :returns: 真 Response
        """
        return _record(self._fetch_site, kwargs, url)

    def close(self) -> None:
        """关闭（替身无事可做）。"""


def _install_recorders() -> dict[str, Any]:
    """把三套引擎与三类会话换成记录器。

    :returns: 还原所需的原对象（本脚本一次性运行，不还原也行，但留着便于单点调试）
    """
    import scrapling.fetchers as fetchers

    originals = {
        "Fetcher": adapters.Fetcher,
        "DynamicFetcher": adapters.DynamicFetcher,
        "StealthyFetcher": adapters.StealthyFetcher,
        "fetchers": fetchers,
        "names": ("FetcherSession", "DynamicSession", "StealthySession"),
        "sessions": (fetchers.FetcherSession, fetchers.DynamicSession, fetchers.StealthySession),
    }
    adapters.Fetcher = _StaticEngine()  # type: ignore[misc,assignment]
    adapters.DynamicFetcher = _BrowserEngine("browser.render")  # type: ignore[misc,assignment]
    adapters.StealthyFetcher = _BrowserEngine("browser.stealth")  # type: ignore[misc,assignment]
    fetchers.FetcherSession = _StaticSession  # type: ignore[misc,assignment]
    fetchers.DynamicSession = lambda **kw: _BrowserSession("browser", **kw)  # type: ignore[misc,assignment]
    fetchers.StealthySession = lambda **kw: _BrowserSession("stealth", **kw)  # type: ignore[misc,assignment]
    return originals


def _restore(originals: dict[str, Any]) -> None:
    """装回真实引擎。

    :param originals: :func:`_install_recorders` 的返回
    """
    adapters.Fetcher = originals["Fetcher"]  # type: ignore[misc,assignment]
    adapters.DynamicFetcher = originals["DynamicFetcher"]  # type: ignore[misc,assignment]
    adapters.StealthyFetcher = originals["StealthyFetcher"]  # type: ignore[misc,assignment]
    fetchers = originals["fetchers"]
    for name, obj in zip(originals["names"], originals["sessions"], strict=True):
        setattr(fetchers, name, obj)


# 每个调用点该出现在上游哪一份参数面里。
SESSION_LEVEL = {
    "browser.render": "PlaywrightSession",
    "browser.stealth": "StealthSession",
    "session.open.browser": "PlaywrightSession",
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

# 会话 fetch 的入参里，实现自己会 pop 掉的键（不在 _fetch_params 字段里但确实生效）。
POPPED_BY_FETCH = frozenset({"proxy"})

# 这些键只在会话开场生效；从 fetch 传过去被丢弃时，「本可以」在开场补上。
SESSION_ONLY_HOPE = (
    "capture_xhr",
    "block_ads",
    "executable_path",
    "cdp_url",
    "locale",
    "timezone_id",
    "useragent",
    "headless",
    "retries",
    "max_pages",
)


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
            # （_validators.py 的 _is_invalid_file_path），拿假路径会让「按发出的参数真造一次
            # 会话」这一步直接失败，而那一步要验的正是 stealth 参数有没有被冲掉。
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
        "captureXhrPattern": "/api/",
        "waitMs": 50,
        "extraHeaders": {"X-Probe": "1"},
        "solveCloudflare": True,
        "hideCanvas": True,
        "blockWebrtc": True,
        "allowWebgl": False,
    }


def drive() -> None:
    """驱动 adapters 的全部引擎调用点，让记录器抓到真实 kwargs。"""
    adapters.render(_full_args(_browser_args()), stealth=False)
    adapters.render(_full_args(_browser_args()), stealth=True)
    adapters.fetch(_full_args({"timeoutSeconds": 30.0, "retries": 2, "headers": {"A": "b"}}))
    adapters.fetch(_full_args({"method": "POST", "body": {"k": "v"}, "cookies": {"c": "1"}}))

    for kind, open_args in (
        (
            "static",
            {"sessionType": "static", "impersonate": "chrome", "timeoutSeconds": 20.0},
        ),
        ("browser", {"sessionType": "browser", "headless": True, "timeoutMs": 9000}),
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
        info = adapters.session_open(
            _full_args({**open_args, **(_browser_args() if kind != "static" else {}), "sessionId": f"s-{kind}"})
        )
        assert info["sessionId"] == f"s-{kind}"
        extra = _browser_args() if kind != "static" else {"timeoutSeconds": 15.0, "retries": 1}
        adapters.session_fetch(_full_args({**extra, "sessionId": f"s-{kind}"}))
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
        """记下一次按键读取。

        :param key: 被读的键
        """
        self.seen.add(".".join([*self.path, str(key)]))

    def get(self, key: str, default: Any = None) -> Any:  # noqa: ANN401 —— 与 dict.get 同形
        """取一个键并记账。

        :param key: 键名
        :param default: 缺省值
        :returns: 值
        """
        self._mark(key)
        return super().get(key, default)

    def __getitem__(self, key: str) -> Any:  # noqa: ANN401 —— 与 dict.__getitem__ 同形
        """取一个键并记账。

        :param key: 键名
        :returns: 值
        """
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
    "crawlId": "c-reads",
    "maxPages": 2,
    "maxDurationMs": 60_000,
    "deployment": {
        "stripInlineImages": True,
        "browserExecutablePath": sys.executable,
        "browserCdpUrl": "",
    },
    **_browser_args(),
}


# 同一份入参只能走一条分支，而 adapters 里大量读取写在分支里（`session.open` 的三种类型、
# `fetch` 的 GET 与非 GET）。只跑一遍会把「分支里真读了」误报成「没读」——那种误报一旦进门禁，
# 就逼着人去加豁免，而豁免加多了，真正的「发了没人读」也跟着沉默。所以按方法列出要走的分支。
READ_VARIANTS: dict[str, list[dict[str, Any]]] = {
    "session.open": [{"sessionType": kind} for kind in ("static", "browser", "stealth")],
    "session.fetch": [{"sessionType": kind} for kind in ("static", "browser", "stealth")],
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

    不问「我们传了什么」，问「上游据此做了什么」：``engines/_browsers/_base.py`` 里
    ``config.extra_flags`` 优先于 ``__generate_stealth_options`` 递进来的那 53 条反检测
    flag —— 于是**只要传了 extra_flags，整套 stealth 就被替换成用户那一条**，连
    ``block_webrtc=True`` 自己该上的两条 flag 也一起没了。这个后果只能问上游本身。

    ``cdp_url`` / ``executable_path`` 在造之前摘掉：连上远端浏览器时上游**本来就不下发**
    启动参数（``_base.py`` 里 ``_browser_options = {}``），留着它等于把「stealth 被我们自己
    冲掉」与「上游按设计不传」两件事混成同一个读数。

    :param site: 调用点名字（必须是 browser/stealth 的会话级站点）
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
    engine = fetchers.StealthySession if "stealth" in site else fetchers.DynamicSession
    try:
        session = engine(**kwargs)
    except Exception:  # noqa: BLE001 —— 造不出来本身就是结论，由调用侧按空表判
        return []
    try:
        return list(session._browser_options.get("args", []))
    finally:
        _close_quietly(session)


def _close_quietly(session: Any) -> None:  # noqa: ANN401 —— 只为释放构造品
    """关掉一个只被构造、从未 start 的会话。

    :param session: 会话对象
    """
    with suppress(Exception):
        session.close()


def _stealth_check() -> list[dict[str, Any]]:
    """stealth 引擎的启动参数是否真的还在。

    :returns: 违规列表
    """
    from scrapling.engines.constants import STEALTH_ARGS

    issues: list[dict[str, Any]] = []
    for site in ("browser.stealth", "session.open.stealth"):
        args = _launch_args(site)
        missing = sorted({flag for flag in STEALTH_ARGS if flag not in args})
        if missing:
            issues.append(
                {
                    "site": site,
                    "missingStealthArgs": len(missing),
                    "of": len(STEALTH_ARGS),
                    "sample": missing[:3],
                    "totalArgs": len(args),
                }
            )
        webrtc = sorted(flag for flag in args if "webrtc" in flag.lower())
        if site == "session.open.stealth" and PROXIED and not webrtc:
            issues.append({"site": site, "missing": "任何 WebRTC 泄露防护", "args": len(args)})
    return issues


def check() -> dict[str, Any]:
    """把抓到的 kwargs 与上游参数面逐一对照。

    :returns: 报告
    """
    sessions = {
        "browser": adapters._SESSION_CLASSES["browser"],
        "stealth": adapters._SESSION_CLASSES["stealth"],
    }
    session_keys: dict[str, set[str]] = {}
    for kind, class_name in sessions.items():
        import scrapling.fetchers as fetchers

        target = getattr(fetchers, class_name)
        session_keys[f"session.open.{kind}"] = _typed_keys(
            "PlaywrightSession" if kind == "browser" else "StealthSession"
        )
        # 会话 fetch 的有效性要问真实实现：构造一个不开浏览器的会话对象只为拿字段，
        # 这里直接用 _fetch_params 的字段集（见 check 的注释）。
        del target

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
        elif site.startswith("session.fetch."):
            kind = site.rsplit(".", 1)[1]
            if kind == "static":
                allowed = _typed_keys("GetRequestParams")
                unknown = sorted(keys - allowed)
                if unknown:
                    violations.append({"site": site, "keys": unknown, "expected": "GetRequestParams"})
                continue
            effective = _fetch_effective_keys()
            silent = sorted(keys - effective)
            if silent:
                dropped.append(
                    {
                        "site": site,
                        "keys": silent,
                        "honorableAtOpen": sorted(set(silent) & session_keys[f"session.open.{kind}"]),
                    }
                )

    return {
        "checked": checked,
        "violations": violations,
        "silentAtSessionFetch": dropped,
        "stealthArgsDowngraded": _stealth_check(),
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
        # 反检测参数的条数基线：本仓任何一处往 stealth 传 extra_flags 都会把这套换掉
        # （_base.py 里 config.extra_flags 优先于内部算出的 flags），所以要把「应该有多少条」
        # 钉成上游事实，而不是留在注释里。
        "stealthArgCount": len(_launch_args("browser.stealth")),
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
    # 写方法同样要开着：drive() 里那条 POST 分支是本轮接线的一部分，被 WRITE_DISABLED 拦下
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
