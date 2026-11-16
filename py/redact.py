"""py/redact.py —— 把 URL 里像凭据的部分换成占位符。

guard 的日志与 adapters 的网络摘要在「给日志、给模型看」之前都要过这里。单独成模块
是因为 guard 不能 import adapters（adapters 顶层 import guard，反过来就是环）。
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

# 畸形 URL（urlsplit 抛 ValueError）上仍要按参数名兜底：解析失败不能等于「整串放行」。
_QUERY_SECRET_FALLBACK = re.compile(
    r"(?i)([?&;](?:token|key|secret|password|pwd|sig|signature|auth|session)[^=&#]*=)[^&#]*"
)
# 兜底路径同样要摘 authority 里的 `user:pass@`：`http://user:pass@[::1/x?token=abc` 这种
# 括号不闭合的形态会让 urlsplit 抛 ValueError，而它的口令就藏在 authority 段 —— 只处理查询串
# 等于把口令原样放行。锚在 `//` 上（mailto:/tel: 这类没有 `//`，不会误伤）。
_AUTHORITY_USERINFO_FALLBACK = re.compile(r"(?<=//)[^\s/?#@]*@")
# 查询串的两种合法分隔符：`&` 与 `;`（HTML 4 / RFC 1738）。切片时保留分隔符本身，
# 于是 `split` 的奇数位就是分隔符。
_QUERY_SEPARATOR = re.compile(r"([&;])")
# 一段 `name=value`。名字允许空（`?=x` 是畸形但存在），值允许空（`?token=`）。
_QUERY_PAIR = re.compile(r"(?P<name>[^=]*)=(?P<value>.*)", re.DOTALL)
# 这些 scheme 的 ``@`` 属于地址本身（mailto/tel 之类），不是 user:pass@host 的 authority。
_NON_AUTHORITY_SCHEMES = frozenset({"mailto", "tel", "data", "javascript", "urn", "about", "blob"})

# 查询串里这些名字的参数装的是凭据而不是筛选条件。XHR 摘要与守卫日志都是要离开本进程的
# 文本——摘要进会话上下文、进第三方 provider，日志进宿主日志——而真实站点把 access
# token、会话 id、签名都放在查询串里。抓到一条就等于把凭据抄进载体，而读者既用不上它、
# 也拦不住它被复述出来。值的部分一律换成固定占位符：定位接口靠的是路径与参数名，不是那个
# token。
_SECRET_QUERY_KEYS = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "client_secret",
        "x-api-key",
        "x-amz-credential",
        "x-amz-signature",
        "x-amz-security-token",
        "x-goog-signature",
        "private_key",
        "jwt",
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
# 参数名判据的归一形态：去掉 `-` 与 `_` 再比对。浏览器端 JS 拼接口时最常写 `accessToken`
# / `clientSecret` / `idToken`（驼峰），而集合里记的是下划线形式 —— 只做 `strip().lower()`
# 时 `accessToken`.lower() 是 `accesstoken`，命中不了 `access_token`，凭据于是原样进摘要。
# 归一方向只有一个：两边都去掉 `-`/`_` 再比，集合与输入用同一套规则。
_SECRET_QUERY_KEYS_FLAT = frozenset(key.replace("-", "").replace("_", "") for key in _SECRET_QUERY_KEYS)


def _is_secret_query_key(name: str) -> bool:
    """判一个查询参数名是否装凭据；`_`/`-`/大小写都不敏感。

    :param name: 参数名（可能带空白与混合大小写）
    :returns: 命中凭据名单时为真
    """
    flat = name.strip().lower().replace("-", "").replace("_", "")
    return flat in _SECRET_QUERY_KEYS_FLAT


def _redacted_query(text: str) -> str:
    """把一段查询串里像凭据的参数值换成占位符；没有命中时原样返回。

    与 :func:`redact_url_secrets` 同一套参数名判据，片段也复用它 —— OAuth2 隐式流程把
    令牌放在 ``#access_token=`` 里，那同样是「离开本进程就等于抄出去」的凭据。

    :param text: 查询串（或片段的查询部分）
    :returns: 脱敏后的文本
    """
    if not text:
        return text
    changed = False
    pieces: list[str] = []
    # **不能只按 `&` 切**：`;` 在 HTML 4 与 RFC 1738 里也是合法的参数分隔符，真实站点至今仍在用
    # `?a=1;token=…`，而 Python 3.10 起 `parse_qsl` 不再把 `;` 当分隔符 —— 整串于是被读成一个
    # 名字 `a`、值 `1;token=abc`，参数名判据命中不了，凭据原样进日志。这里自己按 `&` 与 `;` 切、
    # 逐段判名，分隔符原样保留（重排或替换分隔符会让日志里的 URL 与真实请求对不上）。
    for position, token in enumerate(_QUERY_SEPARATOR.split(text)):
        if position % 2 == 1 or not token:
            pieces.append(token)
            continue
        match = _QUERY_PAIR.fullmatch(token)
        name = match.group("name") if match is not None else token
        value = match.group("value") if match is not None else None
        if value is not None and _is_secret_query_key(name):
            pieces.append(f"{name}=<redacted>")
            changed = True
        else:
            pieces.append(token)
    if not changed:
        return text
    return "".join(pieces)


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
        without_userinfo = _AUTHORITY_USERINFO_FALLBACK.sub("", raw)
        return _QUERY_SECRET_FALLBACK.sub(r"\1<redacted>", without_userinfo)
    # 没有 scheme 的 ``user:pass@host:8080`` 会被 urlsplit 读成 scheme='user'、
    # path='pass@host:8080'：netloc 为空，下面按 netloc 摘 userinfo 的那一步什么都不做，
    # 整条代理口令于是原样漏进日志（PROXY_URL 不可用那条日志正是这么来的）。这种形态的
    # authority 落在 path 的第一段上，按同一套规则摘掉；误读成 scheme 的那段一起丢弃。
    authority, slash, rest = parsed.path.partition("/")
    standalone_authority = (
        not parsed.netloc and "@" in authority and parsed.scheme.lower() not in _NON_AUTHORITY_SCHEMES
    )
    if standalone_authority:
        path = authority.rpartition("@")[2] + slash + rest
        netloc = ""
    else:
        path = parsed.path
        # rpartition 取最后一段：IPv6 字面量与端口都留在主机名那一段，只把用户信息摘掉。
        netloc = parsed.netloc.rpartition("@")[2]
    query = _redacted_query(parsed.query)
    fragment = _redacted_fragment(parsed.fragment)
    if path == parsed.path and netloc == parsed.netloc and query == parsed.query and fragment == parsed.fragment:
        return raw
    scheme = "" if standalone_authority else parsed.scheme
    return urlunsplit((scheme, netloc, path, query, fragment))
