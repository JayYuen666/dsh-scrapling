"""py/redact.py —— 把 URL 里像凭据的部分换成占位符。

guard 的日志与 adapters 的网络摘要在「给日志、给模型看」之前都要过这里。单独成模块
是因为 guard 不能 import adapters（adapters 顶层 import guard，反过来就是环）。
"""

from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# 查询串里这些名字的参数装的是凭据而不是筛选条件。XHR 摘要与守卫日志都是要离开本进程的
# 文本——摘要进会话上下文、进第三方 provider，日志进宿主日志面——而真实站点把 access
# token、会话 id、签名都放在查询串里。抓到一条就等于把凭据抄进载体，而读者既用不上它、
# 也拦不住它被复述出来。值的部分一律换成固定占位符：定位接口靠的是路径与参数名，不是那个
# token。
_SECRET_QUERY_KEYS = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "auth",
        "auth_token",
        "authorization",
        "code",
        "credential",
        "id_token",
        "key",
        "password",
        "pwd",
        "refresh_token",
        "secret",
        "session",
        "sessionid",
        "session_id",
        "sig",
        "signature",
        "sign",
        "token",
    }
)


def _redacted_query(text: str) -> str:
    """把一段查询串里像凭据的参数值换成占位符；没有命中时原样返回。

    与 :func:`redact_url_secrets` 同一套参数名判据，片段也复用它 —— OAuth2 隐式流程把
    令牌放在 ``#access_token=`` 里，那同样是「离开本进程就等于抄出去」的凭据。

    :param text: 查询串（或片段的查询部分）
    :returns: 脱敏后的文本
    """
    if not text:
        return text
    pairs: list[tuple[str, str]] = []
    changed = False
    for name, value in parse_qsl(text, keep_blank_values=True):
        if name.strip().lower() in _SECRET_QUERY_KEYS:
            pairs.append((name, "<redacted>"))
            changed = True
        else:
            pairs.append((name, value))
    if not changed:
        return text
    return urlencode(pairs)


def _redacted_fragment(fragment: str) -> str:
    """把片段里像查询串的那一段脱敏；没有命中时原样返回。

    片段有两种藏令牌的写法：OAuth2 隐式流程把整个片段当查询串（``#access_token=…``），
    单页应用的路由则是先路径后查询（``#!/list?token=…``）。两种都要覆盖。

    :param fragment: URL 的 fragment 段
    :returns: 脱敏后的 fragment
    """
    head, separator, query = fragment.partition("?")
    if separator:
        return f"{head}?{_redacted_query(query)}"
    return _redacted_query(fragment)


def redact_url_secrets(raw: str) -> str:
    """把 URL 里像凭据的部分替换成占位符。

    三处各藏一类凭据：查询串与片段的查询部分按**参数名**判（真实站点把 access token、
    会话 id、签名放在那里），authority 里的 ``user:pass@`` 整段丢掉（代理与 Basic 认证
    的接口都爱这么写）。值的部分一律换成固定占位符：定位接口靠的是路径与参数名，不是
    那个 token。

    只按参数名判断、不看值 —— 值本身无法可靠判定（短 token 与普通 id 长得一样）。
    认不出来的参数原样保留：把 ``?page=2`` 也涂掉只会让摘要失去意义，而那不是凭据。

    :param raw: 原始 URL
    :returns: 已脱敏的 URL；解析不出或没有可脱敏的部分时原样返回
    """
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return raw
    # 没有 scheme 的 ``user:pass@host:8080`` 会被 urlsplit 读成 scheme='user'、
    # path='pass@host:8080'：netloc 为空，下面按 netloc 摘 userinfo 的那一步什么都不做，
    # 整条代理口令于是原样漏进日志（PROXY_URL 不可用那条日志正是这么来的）。这种形态的
    # authority 落在 path 的第一段上，按同一套规则摘掉；误读成 scheme 的那段一起丢弃。
    authority, slash, rest = parsed.path.partition("/")
    standalone_authority = not parsed.netloc and "@" in authority
    if standalone_authority:
        path = authority.rpartition("@")[2] + slash + rest
        netloc = ""
    else:
        path = parsed.path
        # rpartition 取最后一段：IPv6 字面量与端口都留在主机那一侧，只把用户信息摘掉。
        netloc = parsed.netloc.rpartition("@")[2]
    query = _redacted_query(parsed.query)
    fragment = _redacted_fragment(parsed.fragment)
    if path == parsed.path and netloc == parsed.netloc and query == parsed.query and fragment == parsed.fragment:
        return raw
    scheme = "" if standalone_authority else parsed.scheme
    return urlunsplit((scheme, netloc, path, query, fragment))
