"""py/guard.py —— 浏览器路径的网络守卫。

Scrapling 自己**没有任何** SSRF 防护：Playwright 原生跟随重定向，也没有拦截层。
本模块用 Scrapling 的 `page_setup` 钩子注册**唯一一个** route handler，在每个请求
真正发出前判定目标地址，命中私网/元数据端点就 abort。

为什么不直接把守卫写在 Node 侧：浏览器侧的每一个子请求都发生在 Python 进程里，Host
侧看不到；而重定向是 Playwright 在 Python 内部跟进的，Node 侧更无从逐跳判定。

为什么只注册一个 handler：Playwright 的 route 是「后注册的优先」，两个 handler 同时
匹配时前一个会被 `continue_()` 掉而永不执行。所以 SSRF 与广告拦截必须**合并在同一个
handler 里**；对应地，调用 Scrapling 时必须把 `block_ads` / `blocked_domains` /
`disable_resources` 全关掉（见 `adapters.py`），否则 Scrapling 自己也会注册一个。

`page_setup` 的回调由本模块提供，**不接受任何模型入参** —— 沿用 Scrapling 官方 MCP
的 `_EXCLUDED_FETCH_KEYS` 原则：模型只传数据，不传可执行对象。
"""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Iterable
from typing import Any
from urllib.parse import unquote, urlparse

# 放行的额外主机名。默认空 —— 只有字面量公网 IP 与解析到公网的域名能过。
ALLOWED_HOSTS: frozenset[str] = frozenset()

# 额外放行的端口；空表示不限端口（与 dsh 内置 fetch provider 同取舍）。
ALLOWED_PORTS: frozenset[int] = frozenset()

# 「看起来是想写 IP 字面量」的主机名形态：只由数字、点、冒号、x 与十六进制字母组成。
# 真正的域名至少含一个字母且形态更杂，所以不会误伤；反过来 0177.0.0.1 / 2852039166 /
# 0x7f000001 都在内。IPv6 字面量带方括号，从别处进来。
_IP_LITERAL_SHAPE = re.compile(r"\A[0-9a-fA-FxX.:]+\Z")

# 允许额外放行主机名的环境变量。默认不设 ⇒ 放行集合为空 ⇒ 守卫最严。
#
# 这是一个**安全相关**开关：把它指到内网地址等于主动放弃对那些目标的 SSRF 防护。
# 存在的理由是抓自建/内网站点是真实需求（自建 CMS、内网 Git、预发环境），
# 而守卫默认拒绝会让这类目标直接不可抓。要求显式设置，并由部署方自行承担后果。
ALLOWED_HOSTS_ENV = "DSH_SCRAPLING_ALLOWED_HOSTS"

# 额外 NAT64 前缀的环境变量。与放行主机名同一个开关族：前缀不是"放行"，而是补齐
# 判定表——不声明时，藏在运营商自建前缀里的私网 IPv4 会被当成公网放行。
NAT64_PREFIXES_ENV = "DSH_SCRAPLING_NAT64_PREFIXES"

# 放行「代理软件合成的 DNS 答案」的环境变量。默认不设 ⇒ 自动判定，判定不出来时最严。
#
# fake-IP 模式的代理不返回真实地址：每个域名都落进 198.18.0.0/15（RFC 2544 基准测试段），
# 另一批客户端落在 100.64.0.0/10（CGNAT）。Python 的 ipaddress 把两段都算 is_private，
# 于是守卫会把**每一个** URL 判否——开了代理反而全都抓不了。自动识别认出这一类解析器后
# 才放宽；列在环境变量里的是识别失灵时的手动兜底。放宽只对**解析结果**生效：URL 里写死
# 的 IP 字面量照旧严格判定。
SYNTHETIC_RANGES_ENV = "DSH_SCRAPLING_SYNTHETIC_RANGES"

# 抓取走的代理地址与它的绕过清单，逗号分隔的清单项形如 NO_PROXY。判定顺序是
# 「设置卡 proxyUrl → 环境里的代理变量 → 操作系统代理设置 → 直连」，详见
# :func:`proxy_for`。
PROXY_ENV = "DSH_SCRAPLING_PROXY"
PROXY_BYPASS_ENV = "DSH_SCRAPLING_PROXY_BYPASS"

# 手动追加的合成段（CIDR）。默认空 —— 自动检测是主路径。
SYNTHETIC_NETWORKS: tuple[ipaddress.IPv4Network, ...] = ()

# 抓取走的代理（部署设置）。留空表示依次跟随环境里的代理变量与操作系统的代理设置。
PROXY_URL = ""

# 不走代理的主机名（逗号分隔，对应 NO_PROXY）。命中时该请求直连。
PROXY_BYPASS = ""

# 环境里的代理变量与绕过清单，启动时快照一次。进程生命周期内环境不会变，而每次请求
# 都重新扫一遍 os.environ 在浏览器抓取（每个子资源都过一次守卫）下并不便宜。
_ENV_PROXIES: dict[str, str] = {}
_ENV_BYPASS: tuple[str, ...] = ()

# 操作系统「系统代理」设置里读出来的全局代理，同样只在启动时取一次。macOS 的代理软件
# （Clash Verge / Surge / Shadowrocket 等）默认就走这一档：它们把代理写进系统网络设置，
# 浏览器全部自动跟随，而 curl_cffi 只读环境变量、对它一无所知 —— 不补这一档，「开了
# 代理」的用户就会发现本插件的静态抓取在必须代理的网络上一个 URL 都抓不到。
_SYSTEM_PROXIES: dict[str, str] = {}

# 系统代理是 PAC（自动配置脚本）时记下这一条。PAC 要下载脚本并求值，各平台格式互不相同，
# 本包不猜；遇到它就在 stderr 点一句，让用户知道该手填 proxyUrl，而不是看到一个
# 「明明开了系统代理却不走」的静默行为。
_PAC_NOTICE = ""

# 设置与环境的绕过清单合并后的结果，同样只在启动时算一次。
_BYPASS_ENTRIES: tuple[str, ...] = ()

# Playwright 认识的代理协议。与 Scrapling 的 construct_proxy_dict 取同一份清单。
# socks5h 是 libcurl 的写法（由代理去解析域名，不在本地泄漏 DNS）；Chromium 的 SOCKS5
# 本来就把解析放在代理侧，所以浏览器那份折成 socks5，curl 那份保留 socks5h。
_PROXY_SCHEMES = ("http", "https", "socks4", "socks5", "socks5h")
_BROWSER_PROXY_SCHEMES = ("http", "https", "socks4", "socks5")

# Chromium 的 WebRTC 会绕过 HTTP/SOCKS 代理直接发 UDP，于是页面里一句 STUN 就能问出
# 访客的真实出口 IP —— 对「我要走代理」的部署方来说，那等于代理白配。这条 flag 让
# 非代理 UDP 一律不走；Playwright 不暴露对应开关（patchright 那边有 block_webrtc），
# 只能从启动参数进去。
WEBRTC_NO_LEAK_FLAG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"

# 额外的 NAT64 前缀（CIDR 字符串）。IPv6 地址命中其中之一时，会抽出内嵌 IPv4 复判；
# 运营商自建前缀必须在这里声明，否则藏在 IPv6 里的私网 IPv4 会被当成公网放行。
EXTRA_NAT64_PREFIXES: tuple[str, ...] = ()

# 内嵌 IPv4 在 16 字节里的起始下标，随前缀长度变化（RFC 6052 §2.2）。
_NAT64_EMBEDDED_OFFSET: dict[int, int] = {96: 12, 64: 9, 56: 7, 48: 6, 40: 5, 32: 4}


def configure(allowed_hosts=None, allowed_ports=None, nat64_prefixes=None) -> None:
    """按部署配置收紧或放宽放行集合。

    只应由宿主侧在启动时调用一次，参数来自用户显式设置，而不是模型入参。

    :param allowed_hosts: 额外放行的主机名；None 表示沿用当前值
    :param allowed_ports: 额外放行的端口；None 表示沿用当前值
    :param nat64_prefixes: 额外的 NAT64 前缀（CIDR）；None 表示沿用当前值
    """
    global ALLOWED_HOSTS, ALLOWED_PORTS, EXTRA_NAT64_PREFIXES  # noqa: PLW0603 —— 模块级策略常量，需整体替换
    if allowed_hosts is not None:
        ALLOWED_HOSTS = allowed_hosts
    if allowed_ports is not None:
        ALLOWED_PORTS = allowed_ports
    if nat64_prefixes is not None:
        EXTRA_NAT64_PREFIXES = nat64_prefixes


def configure_from_env() -> None:
    """从环境变量读放行主机名、额外 NAT64 前缀、合成段与代理设置，供启动时调用。

    变量都是逗号分隔；未设置或为空则保持最严。环境里的代理变量与 NO_PROXY 在这里快照成
    模块级状态（:func:`proxy_for` 每个请求都要读一次，不适合每次现扫环境）。
    """
    import os

    raw = os.environ.get(ALLOWED_HOSTS_ENV, "")
    hosts = frozenset(item.strip() for item in raw.split(",") if item.strip())
    if hosts:
        configure(allowed_hosts=hosts)

    raw_prefixes = os.environ.get(NAT64_PREFIXES_ENV, "")
    prefixes = tuple(item.strip() for item in raw_prefixes.split(",") if item.strip())
    if prefixes:
        configure(nat64_prefixes=prefixes)

    global SYNTHETIC_NETWORKS, PROXY_URL, PROXY_BYPASS, _BYPASS_ENTRIES  # noqa: PLW0603 —— 启动时定一次
    global _ENV_PROXIES, _ENV_BYPASS, _SYSTEM_PROXIES, _PAC_NOTICE  # noqa: PLW0603 —— 同上
    networks = []
    for item in os.environ.get(SYNTHETIC_RANGES_ENV, "").split(","):
        text = item.strip()
        if text:
            try:
                networks.append(ipaddress.ip_network(text))
            except ValueError:
                continue
    SYNTHETIC_NETWORKS = tuple(networks)
    PROXY_URL = os.environ.get(PROXY_ENV, "").strip()
    PROXY_BYPASS = os.environ.get(PROXY_BYPASS_ENV, "").strip()
    _ENV_PROXIES, _ENV_BYPASS = _snapshot_env_proxies()
    _SYSTEM_PROXIES, _PAC_NOTICE = _read_system_proxies()
    _BYPASS_ENTRIES = (
        *(item.strip() for item in PROXY_BYPASS.split(",") if item.strip()),
        *_ENV_BYPASS,
    )
    if PROXY_URL and split_proxy(PROXY_URL) is None:
        # 不抛：抛出去 sidecar 直接起不来，用户看到的只是「插件加载失败」，看不出是自己
        # 填错了一个地址。记一行指向明确的日志，让侧栏里的能力摘要照实报成未配置。
        _log(f"ignoring an unusable {PROXY_ENV}: {PROXY_URL!r} (scheme must be one of {_PROXY_SCHEMES})")
        PROXY_URL = ""
    if _PAC_NOTICE:
        _log(
            f"system proxy is a PAC script ({_PAC_NOTICE}); it is not evaluated here — "
            f"set {PROXY_ENV} (the settings card's proxy) to the proxy address you want"
        )
    if _SYSTEM_PROXIES and not (PROXY_URL or _ENV_PROXIES):
        # 只在「本来要直连、却发现系统里开着代理」时记一行：这时候用户看到的现象是
        # 「浏览器能上，本插件抓不到」，这行日志就是他们要找的那条线索。
        _log(f"following the system proxy for fetches: {sorted(_SYSTEM_PROXIES.values())}")


def _snapshot_env_proxies() -> tuple[dict[str, str], tuple[str, ...]]:
    """从环境变量里读出代理表与绕过清单。

    这是 curl_cffi（静态抓取）**唯一**认的来源：它的 trust_env 只看环境变量，macOS /
    Windows 的「系统代理」开关对它完全不可见。操作系统的代理由 :func:`_read_system_proxies`
    单独读，两边合起来才是「这台机器当前要怎么出去」。

    :returns: (代理表, 绕过清单项)
    """
    import os

    table: dict[str, str] = {}
    for name in ("http", "https", "all"):
        value = (os.environ.get(f"{name}_proxy") or os.environ.get(f"{name.upper()}_PROXY") or "").strip()
        if value:
            table[name] = value
    raw_bypass = os.environ.get("no_proxy") or os.environ.get("NO_PROXY") or ""
    return table, tuple(item.strip() for item in raw_bypass.split(",") if item.strip())


def parse_scutil_proxy(blob: str) -> dict[str, str]:
    """解析 ``scutil --proxy`` 的输出，取**全局**那几项。

    只取全局（``__SCOPED__`` 之外的顶层键）是有意的：按接口分别配代理的形态少见得多，
    而把带缩进的子字典一起扫进来会把某个网卡的局部设置误当成全局出口。

    macOS 的 SOCKS 项说的是 SOCKS5，所以统一写成 ``socks5://``。只有 HTTP 一项时也给 https
    补上同一份：CFNetwork 与浏览器都是这个行为，用户把「系统代理」只勾了 HTTP 时预期就是
    https 也走它。

    :param blob: ``scutil --proxy`` 的标准输出
    :returns: 形如 ``{"http": url, "https": url, "all": url}`` 的代理表
    """
    import re

    fields: dict[str, str] = {}
    scoped_indent: int | None = None
    for line in blob.splitlines():
        match = re.match(r"\A\s*([A-Za-z_]\w*)\s*:\s*(.*?)\s*\Z", line)
        if match is None:
            continue
        indent = len(line) - len(line.lstrip())
        if scoped_indent is None:
            if match.group(1) == "__SCOPED__":
                # 它的子树按接口分别配代理，比全局那几项缩进更深；记下这个深度，后面一律跳过。
                scoped_indent = indent
            else:
                fields[match.group(1)] = match.group(2)
        elif indent < scoped_indent:
            # 理论上不会有（__SCOPED__ 之后只有它的子树），留这条以免未来多一层时错位。
            fields[match.group(1)] = match.group(2)

    def endpoint(name: str, port_name: str) -> str:
        host = fields.get(name, "").strip()
        port = fields.get(port_name, "").strip()
        return f"{host}:{port}" if host and port else ""

    table: dict[str, str] = {}
    for key, prefix, scheme in (("http", "HTTP", "http"), ("https", "HTTPS", "https")):
        if fields.get(f"{prefix}Enable", "0") == "1":
            target = endpoint(f"{prefix}Proxy", f"{prefix}Port")
            if target:
                table[key] = f"{scheme}://{target}"
    if table and "https" not in table:
        table["https"] = table["http"]
    if fields.get("SOCKSEnable", "0") == "1":
        target = endpoint("SOCKSProxy", "SOCKSPort")
        if target:
            table["all"] = f"socks5://{target}"
    return table


def parse_windows_proxy(entries: dict[str, str]) -> dict[str, str]:
    """解析 Windows Internet Settings 那三枚注册表值。

    ``ProxyServer`` 有两种写法：单个 ``host:port``（对所有协议生效），或者分协议的
    ``http=h:1;https=h:2;socks=h:3``。两种都认。

    ``AutoConfigURL``（PAC）不在这里处理：求值 PAC 要下载脚本、跑 JavaScript，各平台格式
    还不一样。见到它只报一声，让用户手填 proxyUrl。

    :param entries: 键是 ``ProxyEnable`` / ``ProxyServer`` / ``AutoConfigURL`` 的小写形式
    :returns: 代理表
    """
    if entries.get("proxyenable", "0") != "1":
        return {}
    raw = entries.get("proxyserver", "").strip()
    if not raw:
        return {}
    if "=" in raw:
        parts = dict(
            item.split("=", 1) for item in raw.split(";") if "=" in item
        )
    else:
        parts = {"http": raw, "https": raw}
    table: dict[str, str] = {}
    for key, scheme in (("http", "http"), ("https", "https"), ("socks", "socks5")):
        target = parts.get(key, "").strip()
        if target and ":" in target:
            table[key if key != "socks" else "all"] = f"{scheme}://{target}"
    return table


def _run_readonly(argv: list[str]) -> str:
    """跑一条只读的系统查询命令，拿它的标准输出。

    刻意不抛：读不到系统代理只意味着「按直连处理」，而让 sidecar 为此起不来是不可接受的。
    绝对路径而不是靠 PATH —— dsh 拉起 sidecar 时给的是一份裁剪过的环境变量，PATH 里未必
    还在。

    :param argv: 命令与参数
    :returns: 标准输出；任何失败都返回空串
    """
    import subprocess

    try:
        done = subprocess.run(  # noqa: S603 —— 参数是本文件里的常量，没有外部输入
            argv,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""
    return done.stdout


def _macos_system_proxies() -> dict[str, str]:
    """读 macOS 的全局系统代理。"""
    return parse_scutil_proxy(_run_readonly(["/usr/sbin/scutil", "--proxy"]))


def _windows_system_proxies() -> tuple[dict[str, str], str]:
    """读 Windows 的用户级 Internet Settings。返回 (代理表, PAC 地址)。"""
    import os
    import re

    root = os.environ.get("SystemRoot", "C:\\Windows")
    blob = _run_readonly(
        [
            f"{root}\\System32\\reg.exe",
            "query",
            r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ]
    )
    entries: dict[str, str] = {}
    for line in blob.splitlines():
        match = re.match(r"\s{4}(\w+)\s+REG_\w+\s+(.+?)\s*\Z", line)
        if match is not None:
            entries[match.group(1).lower()] = match.group(2)
    return parse_windows_proxy(entries), entries.get("autoconfigurl", "").strip()


def _read_system_proxies() -> tuple[dict[str, str], str]:
    """读操作系统设置里的全局代理。返回 (代理表, PAC 地址)。

    只覆盖 macOS 与 Windows：这两边「系统代理」是代理软件的默认形态，也是 curl_cffi 唯一
    完全看不见的那种代理。Linux 上的代理几乎都用 TUN 或环境变量表达，那两条已经在别处
    覆盖；gsettings 的输出格式与前两者毫无共同之处，为它单开一套解析不值得。

    :returns: 代理表与 PAC 地址（PAC 不为空时本包不求值它）
    """
    import sys

    if sys.platform == "darwin":
        return _macos_system_proxies(), ""
    if sys.platform == "win32":
        return _windows_system_proxies()
    return {}, ""


def _host_matches(host: str, entry: str) -> bool:
    """NO_PROXY 口径的主机名匹配：整名命中，也覆盖该名下的全部子域。

    ``example.com`` 命中 ``example.com`` 与 ``a.b.example.com``，但不命中
    ``notexample.com`` —— 后缀相同而已，那不是同一台主机。用 ``.example.com`` /
    ``*.example.com`` 写也等价。单独一个 ``*`` 表示全部绕过（即整台机器直连）。

    :param host: 待判定的小写主机名
    :param entry: 清单里的一项（可能带前导 ``.`` 或 ``*``）
    :returns: 是否命中
    """
    item = entry.strip().lower().lstrip("*")
    if not item:
        return False
    name = host.lower()
    item = item.lstrip(".")
    return name == item or name.endswith(f".{item}")


def _is_bypassed(host: str) -> bool:
    """主机名是否命中绕过清单（设置与环境的并集）。

    :param host: 待判定的主机名
    :returns: 命中即直连
    """
    return any(_host_matches(host, entry) for entry in _BYPASS_ENTRIES)


def _proxy_scheme_key(url: str) -> str:
    """URL 该去环境表的哪一栏取代理。

    :param url: 待判定的完整 URL
    :returns: ``"https"`` 或 ``"http"``
    """
    return "https" if urlparse(url).scheme in ("https", "wss") else "http"


def proxy_for(url: str) -> str:
    """这次请求该走哪个代理；空串 = 直连。

    顺序是**设置卡 proxyUrl → 环境里的代理变量 → 操作系统的代理设置 → 直连**，绕过清单
    横切在最前（命中即直连，无论代理来自哪边）。设置里填了 proxyUrl 时后面两档整份被忽略：
    显式设置就该压过隐式来源，否则「我明明填了 7890 却还在走 1080」这类问题无从查起。

    三档各有各的存在理由，少一档就有一类用户抓不到东西：设置卡是显式意图；环境变量覆盖
    CI、ssh 会话、docker exec 这类只在 shell 里 export 过的地方；系统代理是 macOS 与
    Windows 上代理软件的默认形态（Clash Verge、Surge 等把「系统代理」一勾浏览器立刻就上，
    而 curl_cffi 对它一无所知）。

    :param url: 待判定的完整 URL
    :returns: 代理地址；直连时为空串
    """
    if _is_bypassed(urlparse(url).hostname or ""):
        return ""
    if PROXY_URL:
        return PROXY_URL
    key = _proxy_scheme_key(url)
    return (
        _ENV_PROXIES.get(key)
        or _ENV_PROXIES.get("all")
        or _SYSTEM_PROXIES.get(key)
        or _SYSTEM_PROXIES.get("all", "")
    )


def proxies_for(url: str) -> dict[str, str] | None:
    """curl_cffi 形态的代理表。

    返回 None 表示「本包不表态」，由 curl_cffi 照它自己的 trust_env 去读环境 —— 那是
    设置、绕过清单与系统代理**都**为空时的路径，行为与本包不介入时逐字节一致。
    返回 ``{"all": ""}`` 才是「明确直连」：curl 会把空串当成 ``CURLOPT_PROXY=""``，即彻底
    关掉代理，包括环境里的那份。

    :param url: 待判定的完整 URL
    :returns: 代理表，或 None 表示交给底层自己判断
    """
    if not (PROXY_URL or PROXY_BYPASS or _BYPASS_ENTRIES or _SYSTEM_PROXIES):
        return None
    return {"all": proxy_for(url)}


def default_proxy() -> str:
    """不依赖具体主机的那个代理，供会话开场这类「还不知道 URL」的场合用。

    与 :func:`proxy_for` 的差别只有一处：不看绕过清单 —— 会话开在哪个主机上尚未可知，
    而浏览器会话的代理在 context 创建时就定死了（中途换 context 等于丢掉 cookie）。
    绕过清单里单独一个 ``*`` 是「整台机器直连」，那个要照认。

    :returns: 代理地址；没有配置代理时为空串
    """
    if any(entry.strip() == "*" for entry in _BYPASS_ENTRIES):
        return ""
    table = PROXY_URL or next(iter(_ENV_PROXIES.values()), "") or next(
        iter(_SYSTEM_PROXIES.values()), ""
    )
    return table


def split_proxy(raw: str) -> dict[str, str] | None:
    """把代理地址拆成 Playwright 认的 ``{server, username, password}``。

    自己拆而不是交给 Scrapling 的 ``construct_proxy_dict``：那份丢掉 IPv6 字面量的方括号
    （``socks5://[::1]:1080`` 会变成 ``socks5://::1``），而代理软件确实会用回环监听。
    路径、查询串与片段一并丢掉 —— 代理地址里出现它们没有任何意义。

    :param raw: 代理地址
    :returns: 代理字典；地址不可用时为 None
    """
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if scheme not in _BROWSER_PROXY_SCHEMES or not parsed.hostname:
        return None
    # urlparse 已经把 IPv6 字面量的方括号摘掉了（hostname 是 `::1`），Playwright 要的
    # server 里得再装回去 —— 否则 `[::1]` 会被解析成端口。
    host = parsed.hostname if ":" not in parsed.hostname else f"[{parsed.hostname}]"
    server = f"{scheme}://{host}"
    if parsed.port:
        server = f"{server}:{parsed.port}"
    return {
        "server": server,
        # 凭据要 percent-decode：urlparse 不解，而 Playwright 是把这对值原样塞进
        # Proxy-Authorization 的 Basic 段（不做解码），libcurl 则会解码。不在这里解开，
        # 含 `@` 或 `:` 的密码就会在两条路径上给出两个不同的密码。
        "username": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
    }


def browser_proxy(url: str) -> dict[str, str] | None:
    """浏览器引擎形态的代理。

    :param url: 待判定的完整 URL
    :returns: 代理字典；直连时为 None
    """
    return split_proxy(proxy_for(url))


def proxy_settings() -> dict[str, Any]:
    """当前代理配置的可展示摘要，供能力上报如实说明。

    **绝不含凭据**：只回显 ``scheme://host:port``，连用户名都不带 —— 这份摘要会进日志、
    进能力协商帧，而密码只应该待在环境变量与设置文件里。

    ``source`` 如实标出代理是从哪一档来的。用户报「抓不到东西」时，这一栏就是第一眼的
    答案：``system`` 表示跟着操作系统的代理设置走（浏览器能上、本插件静态抓取也能上，
    两侧一致），``none`` 表示这台机器压根没配代理。

    :returns: ``{configured, source, server}``
    """
    if PROXY_URL:
        source, raw = "settings", PROXY_URL
    elif _ENV_PROXIES:
        source, raw = "environment", next(iter(_ENV_PROXIES.values()))
    elif _SYSTEM_PROXIES:
        source, raw = "system", next(iter(_SYSTEM_PROXIES.values()))
    else:
        source, raw = "none", ""
    parsed = split_proxy(raw)
    return {"configured": bool(parsed), "source": source, "server": parsed["server"] if parsed else ""}


def _nat64_tables() -> tuple[tuple[ipaddress.IPv6Network, int, int], ...]:
    """把 NAT64 前缀表预解析成 (网络, 前缀长度, 偏移)。"""
    tables: list[tuple[ipaddress.IPv6Network, int, int]] = []
    for raw in ("64:ff9b::/96", "64:ff9b:1::/48", *EXTRA_NAT64_PREFIXES):
        try:
            network = ipaddress.ip_network(raw, strict=True)
        except ValueError:
            continue
        offset = _NAT64_EMBEDDED_OFFSET.get(network.prefixlen)
        if isinstance(network, ipaddress.IPv6Network) and offset is not None:
            tables.append((network, network.prefixlen, offset))
    return tuple(tables)


def _embedded_ipv4(address: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """若地址落在某个 NAT64 前缀里，抽出内嵌的 IPv4。"""
    packed = address.packed
    for network, _prefixlen, offset in _nat64_tables():
        if address not in network:
            continue
        return ipaddress.IPv4Address(packed[offset : offset + 4])
    return None


def effective_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    """把地址归约成「最终该按谁的属性判定」。

    IPv4-mapped（::ffff:a.b.c.d）与 NAT64 藏着的 IPv4 都要换成内嵌 IPv4 再判，
    否则 ``::ffff:127.0.0.1`` 会被当成普通 IPv6 公网放行。
    """
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return address.ipv4_mapped
        embedded = _embedded_ipv4(address)
        if embedded is not None:
            return embedded
    return address


# 检测合成解析器用的控制域名：与用户的目标无关，答案只反映解析器本身的行为。
CONTROL_HOSTS: tuple[str, ...] = ("example.com", "www.iana.org", "www.wikipedia.org")

# 检测结果；只算一次并缓存。
_SYNTHETIC_RESOLVER: bool | None = None


def detect_synthetic_resolver() -> bool:
    """判断当前解析器是不是在合成地址。

    依据是 fake-ip 的指纹：**所有**主机名都被指到同一个非公网小池里。实测在一台开着 TUN +
    fake-ip 的机器上，example.com / github.com / wikipedia.org / echarts.apache.org /
    www.apple.com 全部落在 198.18.0.0/15 内且互不相同，而 IP 字面量原样不动。

    这么判而不是枚举段：落点由代理自己定，用户不该被迫先知道自己代理用了哪一段。控制域名
    解析失败时判否——判否只让守卫维持最严，不会误放行。

    :returns: 解析器是否在合成地址
    """
    global _SYNTHETIC_RESOLVER  # noqa: PLW0603 —— 缓存一次即可
    if _SYNTHETIC_RESOLVER is not None:
        return _SYNTHETIC_RESOLVER
    resolved: list[str] = []
    for host in CONTROL_HOSTS:
        try:
            infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        except OSError:
            _SYNTHETIC_RESOLVER = False
            return _SYNTHETIC_RESOLVER
        resolved.extend(info[4][0] for info in infos)
    if len(resolved) < len(CONTROL_HOSTS):
        _SYNTHETIC_RESOLVER = False
        return _SYNTHETIC_RESOLVER
    parsed = []
    for item in resolved:
        try:
            parsed.append(ipaddress.ip_address(item))
        except ValueError:
            _SYNTHETIC_RESOLVER = False
            return _SYNTHETIC_RESOLVER
    # 全非公网且彼此不同 = 一个合成池。全指向同一处更像是解析器坏了，不当成 fake-ip。
    _SYNTHETIC_RESOLVER = all(not item.is_global for item in parsed) and len(set(parsed)) > 1
    return _SYNTHETIC_RESOLVER


def _acceptable_resolved(item: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """判定一个**解析得到**的地址能否放行。

    与字面量口径的唯一差别在这里：认出合成解析器、或用户手动列了合成段时，那几段算通过。
    字面量走 :func:`is_public_address` 里另一条分支，拿不到这份放宽。

    :param item: 已做过内嵌 IPv4 复判的地址
    :returns: 是否放行
    """
    if item.is_global:
        return True
    if not isinstance(item, ipaddress.IPv4Address):
        return False
    if detect_synthetic_resolver():
        return True
    return bool(SYNTHETIC_NETWORKS) and any(item in network for network in SYNTHETIC_NETWORKS)


def is_public_address(host: str, *, proxied: bool = False) -> bool:
    """判定一个主机名/字面量是否指向公网地址。

    没有代理时，解析失败一律按不可抓处理 —— 拿不到答案时选择拒，而不是选择放行。

    ``proxied`` 为真时**只有一条**判据放宽：本机解析失败改成放行。理由是那一刻请求根本
    不从本机网络命名空间出去，域名由代理去解析，本机解析器答不上来什么也说明不了 ——
    而在 DNS 被按地区过滤的网络里，恰恰是这些站点才需要代理才能访问。字面量与本地能解析
    出来的私网答案**照旧拒**（上面两条分支都不看 ``proxied``），单标签主机名也照旧拒：
    `intranet`、`router` 这类名字经代理去解析也没有公网含义，放开它等于把「猜一个内网名
    试试」重新变成一条可用路径。

    :param host: 主机名或 IP 字面量
    :param proxied: 这次请求是否经代理发出
    :returns: 是否放行
    """
    if host in ALLOWED_HOSTS:
        return True
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return effective_ip(parsed).is_global

    # 形态判据：全由数字/点/十六进制字符组成的主机名一定是想写 IP 字面量（十进制、八进制、
    # 分段十六进制这些老写法），而各家的读法并不一致。ipaddress 按十进制读，WHATWG
    # （也就是 Chromium）把前导 0 当八进制：`0177.0.0.1` 在这里是 177.0.0.1，在浏览器里
    # 就是 127.0.0.1 —— 守卫放行、浏览器连回环。ipaddress 既然解析不出来，就不交给
    # getaddrinfo 去赌平台解析器的口径，直接判否。
    if _IP_LITERAL_SHAPE.search(host) and not host.startswith("["):
        return False
    if "." not in host:
        return False

    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError:
        if proxied:
            _log(f"local DNS has no answer for {host}; allowing it through the proxy")
            return True
        return False
    # 整张答案表都要是公网：混入一条私网即整体拒绝，避免 DNS 轮询绕过。
    addresses: Iterable[ipaddress.IPv4Address | ipaddress.IPv6Address] = (
        ipaddress.ip_address(info[4][0]) for info in infos
    )
    resolved = [effective_ip(item) for item in addresses]
    return bool(resolved) and all(_acceptable_resolved(item) for item in resolved)


def url_allowed(url: str) -> tuple[bool, str]:
    """判定一个 URL 是否允许发出。

    :param url: 待判定的完整 URL
    :returns: (是否允许, 原因)；允许时原因为空串
    """
    parsed = urlparse(url)
    # ws/wss 与 http/https 走同一套地址判定。WebSocket 握手是独立路由，page.route 拦不到，
    # 这里不认它就等于把公网 WebSocket 一起杀了 —— 不少站点的实时数据就靠它。
    if parsed.scheme not in ("http", "https", "ws", "wss"):
        return False, f"unsupported URL scheme: {parsed.scheme!r}"
    host = parsed.hostname or ""
    if not host:
        return False, "URL has no host"
    try:
        port = parsed.port
    except ValueError:
        return False, "URL has an invalid port"
    if ALLOWED_PORTS and port is not None and port not in ALLOWED_PORTS:
        return False, f"port {port} is not in the allow list"
    if not is_public_address(host, proxied=bool(proxy_for(url))):
        return False, f"host does not resolve to a public address: {host}"
    return True, ""


def install(page: object) -> None:
    """把守卫注册到 Playwright 的 page 上。

    用法是交给 Scrapling 的 ``page_setup=install``。选择器用 ``**/*`` 以覆盖主导航、
    子资源与 XHR；Scrapling 自己在 ``_get_page`` 里会先 ``page.unroute_all()`` 再注册它
    自带的 handler，而 ``page_setup`` 在那之后才跑（见
    ``engines/_browsers/_controllers.py``：``_page_generator`` 在前，``page_setup`` 在后，
    ``goto`` 最后），所以我们的 handler 不会被冲掉，且每次重试都会重新注册。

    放行时走 ``fallback()`` 而不是 ``continue_()``：Playwright 里多个匹配的 handler 逆序
    执行，而 ``continue_()`` 会**立刻**把请求放到网络上，跳过后面所有 handler。守卫排第一
    （page_setup 在后注册）所以 SSRF 判定永远最先跑，但用 ``continue_()`` 的话，Scrapling
    自己那个拦截 handler（广告/资源）就永远轮不到。``fallback()`` 把它交给下一个匹配者，
    没有下一个时才真的放行——于是 ``block_ads`` 之类的上游拦截能够叠加在守卫之上。
    Playwright 1.63 两种 API 都有；旧版本没有 ``fallback`` 时退回 ``continue_``，
    代价只是上游拦截失效，SSRF 判定不受影响（它本来就先跑完了）。

    WebSocket 握手走另一套路由，``page.route`` 拦不到，所以额外挂一个
    ``route_web_socket``。少了它，页面里一句 ``new WebSocket("ws://127.0.0.1:…")``
    就能连进内网并在 JS 里读帧，而页面内容本就是攻击者完全可控的。旧版没有这个方法时
    往 stderr 记一行，由 ``websocket_guard_supported`` 如实报出覆盖面，不静默降级。

    :param page: Playwright 的 Page 对象（同步或异步 API 通用）
    """

    def handler(route: object) -> None:  # noqa: ANN401 —— 拿不到 Playwright 的类型
        request = route.request  # pyright: ignore[reportAttributeAccessIssue]
        allowed, reason = url_allowed(request.url)
        if allowed:
            fallback = getattr(route, "fallback", None)
            if callable(fallback):
                fallback()
            else:
                route.continue_()  # pyright: ignore[reportAttributeAccessIssue]
        else:
            _log(f"blocked {request.url}: {reason}")
            route.abort()  # pyright: ignore[reportAttributeAccessIssue]

    def ws_handler(websocket: object) -> None:  # noqa: ANN401 —— 同上
        url = getattr(websocket, "url", "")
        allowed, reason = url_allowed(url if isinstance(url, str) else "")
        if allowed:
            # 显式连一次而不是什么都不做：不连时 Playwright 自己放行，那条默认路径
            # 不经任何判定，显式连接才与 HTTP 侧摆在同一套逻辑里。
            websocket.connect_to_server()  # pyright: ignore[reportAttributeAccessIssue]
        else:
            _log(f"blocked websocket {url}: {reason}")
            websocket.close()  # pyright: ignore[reportAttributeAccessIssue]

    page.route("**/*", handler)  # pyright: ignore[reportAttributeAccessIssue]

    route_ws = getattr(page, "route_web_socket", None)
    if callable(route_ws):
        route_ws("**/*", ws_handler)  # pyright: ignore[reportAttributeAccessIssue]
    else:
        _log(
            "this Playwright build has no route_web_socket; "
            "WebSocket connections are not covered by the URL guard"
        )


def websocket_guard_supported(page: object) -> bool:  # noqa: ANN401 —— 同上
    """page 上挂得上 WebSocket 守卫与否；供能力报告如实说明覆盖面。

    :param page: Playwright 的 Page 对象
    :returns 是否支持拦截 WebSocket 握手
    """
    return callable(getattr(page, "route_web_socket", None))


def _log(message: str) -> None:
    """把守卫的判定写进 **stderr**。

    stdout 是与 Host 的协议通道，任何往那里写的东西都会破坏 JSON-lines 帧。
    """
    import sys

    print(f"[guard] {message}", file=sys.stderr, flush=True)
