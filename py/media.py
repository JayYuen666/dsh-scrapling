"""下载落盘与截图字节。两者都不经过正文清洗：字节就是字节。"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import os
import struct
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DEFAULT_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024


def _error(code: str, message: str) -> Exception:
    from adapters import AdapterError

    return AdapterError(code, message)


def _safe_name(raw: Any, url: str) -> str:
    """把调用方给的文件名收成目录内的纯文件名；任何路径成分都拒绝。"""
    name = raw if isinstance(raw, str) and raw else Path(urlparse(url).path).name
    if not name:
        name = "download.bin"
    if "\x00" in name or "/" in name or "\\" in name:
        raise _error("DOWNLOAD_PATH", "filename must not contain path separators or NUL")
    if name in (".", "..") or os.path.isabs(name):
        raise _error("DOWNLOAD_PATH", "filename must be a plain file name")
    return name


def _claim_path(directory: Path, name: str) -> Path:
    """占住一个当前不存在的目标名并创建空文件；占不住就按 -1、-2… 往后找。

    「探测」与「占位」必须是同一原子操作：O_EXCL 的创建语义保证了两个并发下载不可能
    各自都以为拿到了同一个名字——而先 ``exists()`` 再写的那两步之间，另一路可以整个
    走完，后落盘的 ``os.replace`` 就把先到的那份覆盖掉了。占位本身产生一个空文件，
    正常路径随后会被 ``os.replace`` 原子覆盖成正文。
    """
    candidate = directory / name
    stem = candidate.stem
    suffix = candidate.suffix
    index = 0
    while True:
        try:
            handle = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            index += 1
            candidate = directory / f"{stem}-{index}{suffix}"
            continue
        os.close(handle)
        return candidate


def _release_claim(target: Path) -> None:
    """撤掉一个尚未被正文覆盖的占位空文件；占位可能已被覆盖或已被撤，缺席不算错。"""
    try:
        if target.stat().st_size == 0:
            target.unlink()
    except OSError:
        return


def _temp_path(directory: Path, name: str) -> Path:
    """一次落盘的临时文件名：点前缀 + uuid，让「写到一半」的文件不会撞上任何正名。"""
    return directory / f".{name}.{uuid.uuid4().hex}.part"


def _header_value(headers: Any, name: str) -> str:
    """按大小写不敏感读一个响应头；读不到给空串。dict 与 curl_cffi 的 Headers 都适用。"""
    try:
        items = list(headers.items())
    except Exception:  # noqa: BLE001 —— 形状不对就当没有这个头
        return ""
    for key, value in items:
        if str(key).lower() == name.lower():
            return str(value)
    return ""


def _commit_temp(directory: Path, name: str, temporary: Path) -> Path:
    """把已写完的临时文件落成正式名：占位 + 原子替换，不覆盖任何已存在的文件。"""
    target = _claim_path(directory, name)
    try:
        os.replace(temporary, target)
    except OSError:
        _release_claim(target)
        raise
    return target


def _download_dir(args: dict[str, Any]) -> Path:
    deployment = args.get("deployment")
    configured = deployment.get("downloadDir") if isinstance(deployment, dict) else None
    if isinstance(configured, str) and configured:
        return Path(configured)
    return Path.home() / ".dsh-scrapling" / "downloads"


def _max_bytes(args: dict[str, Any]) -> int:
    """下载字节上限。

    部署侧的 ``downloadMaxBytes`` 是**硬上限**：模型给的 ``maxBytes`` 只能在它下面
    往下收，不能把它顶掉。早先只在 ``maxBytes`` 缺席时才读部署项，于是模型随手写一个
    大数就绕过了运维定的那道闸。
    """
    deployment = args.get("deployment")
    configured = deployment.get("downloadMaxBytes") if isinstance(deployment, dict) else None
    if configured is not None and (not isinstance(configured, int) or isinstance(configured, bool) or configured <= 0):
        # 部署项写坏不悄悄回落默认值：那会让人以为「上限是默认的那一档」，而实际配置没生效。
        raise _error("BAD_ARGS", "deployment.downloadMaxBytes must be a positive integer")
    ceiling = configured if isinstance(configured, int) else DEFAULT_DOWNLOAD_MAX_BYTES
    raw = args.get("maxBytes")
    if raw is None:
        return ceiling
    if not isinstance(raw, int) or isinstance(raw, bool) or raw <= 0:
        raise _error("BAD_ARGS", "maxBytes must be a positive integer")
    return min(raw, ceiling)


_DOWNLOAD_CHUNK_BYTES = 64 * 1024


def download(args: dict[str, Any]) -> dict[str, Any]:
    """取一个 URL 的字节并写进下载目录；流式落盘，不覆盖、不越界。"""
    import guard

    if not guard.ALLOW_FILE_DOWNLOADS:
        raise _error(
            "DOWNLOAD_DISABLED",
            f"file downloads are disabled; the deployment must set {guard.ALLOW_FILE_DOWNLOADS_ENV}",
        )
    from adapters import _string_map, _url

    url = _url(args)
    allowed, reason = guard.url_allowed(url)
    if not allowed:
        raise _error("URL_BLOCKED", f"{url}: {reason}")
    name = _safe_name(args.get("filename"), url)
    limit = _max_bytes(args)
    directory = _download_dir(args)
    directory.mkdir(parents=True, exist_ok=True)

    headers = _string_map(args.get("headers"), "headers")
    cookies = _string_map(args.get("cookies"), "cookies")
    timeout = args.get("timeoutSeconds", 120.0)
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
        raise _error("BAD_ARGS", "timeoutSeconds must be a positive number")
    if args.get("useBrowser") is True:
        if cookies is not None:
            raise _error("BAD_ARGS", "cookies need a session; use useBrowser:false for a one-off download")
        return _download_via_browser(url, name=name, directory=directory, limit=limit, timeout=timeout, headers=headers)
    impersonate = args.get("impersonate")
    return _download_via_stream(
        url,
        name=name,
        directory=directory,
        limit=limit,
        timeout=timeout,
        headers=headers,
        cookies=cookies,
        impersonate=impersonate if isinstance(impersonate, str) and impersonate else "chrome",
    )


def _download_via_stream(
    url: str,
    *,
    name: str,
    directory: Path,
    limit: int,
    timeout: float,
    headers: dict[str, str] | None,
    cookies: dict[str, str] | None,
    impersonate: str,
) -> dict[str, Any]:
    """流式下载：逐块落盘并计哈希，内存占用与块同阶，与响应体大小无关。

    走 curl_cffi 而不是 Scrapling 的 Fetcher：后者的响应整体缓冲，大小上限只能在
    「全部读进内存之后」判，一条快链路足以在超时窗口内把进程内存顶爆。下载不需要
    Scrapling 的解析层；impersonate 的默认档沿用它的 ``chrome``，代理表与重定向
    安全档与静态抓取共用同一份 guard 判定。
    """
    import guard
    from curl_cffi import requests as curl_requests

    session_kwargs: dict[str, Any] = {"impersonate": impersonate}
    proxies = guard.proxies_for(url)
    if proxies is not None:
        session_kwargs["proxies"] = proxies
    request_kwargs: dict[str, Any] = {
        "timeout": float(timeout),
        # 直连 curl_cffi 就用它的参数名：Scrapling 的 follow_redirects 是它自己翻成
        # allow_redirects 的那一层（engines/static.py），这里没有翻译层可借。
        "allow_redirects": "safe",
        "stream": True,
    }
    if headers is not None:
        request_kwargs["headers"] = headers
    if cookies is not None:
        request_kwargs["cookies"] = cookies
    try:
        session = curl_requests.Session(**session_kwargs)
    except Exception as error:
        raise _error("DOWNLOAD_FAILED", f"download failed: {type(error).__name__}: {error}") from error
    try:
        try:
            response = session.request("GET", url, **request_kwargs)
        except Exception as error:
            raise _error("DOWNLOAD_FAILED", f"download failed: {type(error).__name__}: {error}") from error
        try:
            status = int(getattr(response, "status_code", 0))
            if not 200 <= status < 300:
                raise _error("DOWNLOAD_FAILED", f"download answered HTTP {status}")
            declared = _header_value(response.headers, "Content-Length")
            # 头部预检在正文传输之前给出结论；谎报长度的服务端由流式循环里的复核兜住。
            if declared.isdigit() and int(declared) > limit:
                raise _error(
                    "DOWNLOAD_TOO_LARGE",
                    f"download is {int(declared)} bytes by Content-Length, over the {limit}-byte cap",
                )
            digest = hashlib.sha256()
            total = 0
            temporary = _temp_path(directory, name)
            try:
                with open(temporary, "wb") as sink:
                    for chunk in response.iter_content(chunk_size=_DOWNLOAD_CHUNK_BYTES):
                        sink.write(chunk)
                        digest.update(chunk)
                        total += len(chunk)
                        if total > limit:
                            raise _error(
                                "DOWNLOAD_TOO_LARGE",
                                f"download is over the {limit}-byte cap"
                                + (f" (Content-Length declared {int(declared)})" if declared.isdigit() else ""),
                            )
                target = _commit_temp(directory, name, temporary)
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
            return {
                "path": str(target),
                "bytes": total,
                "sha256": digest.hexdigest(),
                "contentType": _header_value(response.headers, "Content-Type"),
                "status": status,
            }
        finally:
            response.close()
    finally:
        session.close()


def _commit_bytes(directory: Path, name: str, body: bytes) -> Path:
    """把一段已在内存里的字节落成正式名（浏览器路径）：临时文件 + 占位 + 原子替换。"""
    temporary = _temp_path(directory, name)
    try:
        temporary.write_bytes(body)
        return _commit_temp(directory, name, temporary)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _download_via_browser(
    url: str,
    *,
    name: str,
    directory: Path,
    limit: int,
    timeout: float,
    headers: dict[str, str] | None,
) -> dict[str, Any]:
    """浏览器路径的下载：Scrapling 的响应整体缓冲，没有流式出口。

    内存上界因此由 requestTimeoutSeconds 与链路吞吐共同决定；这一档是给「要 JS 才拿
    得到文件」的少数场景用的，静态路径（默认）已经是流式。
    """
    import guard

    # 与 :func:`adapters.render` 同一条判据：浏览器路径必须显式挂上网络守卫与部署代理。
    # 少了 ``page_setup``，重定向与页面子资源都不经过 guard.install 的 ``**/*`` 路由，
    # 一条被下载链接重定向到内网的响应会绕过 url_allowed；少了 ``proxy``，配了代理的
    # 机器上这条路径直连（Chromium 不读 HTTP_PROXY）。
    from adapters import page_setup
    from scrapling.fetchers import StealthyFetcher

    browser_params: dict[str, Any] = {
        "timeout": int(timeout * 1000),
        "page_setup": page_setup,
    }
    proxy = guard.browser_proxy(url)
    if proxy is not None:
        browser_params["proxy"] = proxy
    if headers is not None:
        browser_params["extra_headers"] = headers
    try:
        response = StealthyFetcher.fetch(url, **browser_params)
    except Exception as error:  # noqa: BLE001 —— 把附件响应换一条路走完，而不是只剩一个类名
        # 「Page.goto: Download is starting」：Chromium 不能把「触发下载的响应」当成一次
        # 导航，fetch 这条路对附件/二进制响应天然走不通。换成等真实的 download 事件再把它
        # 落盘。HTML 页走不到这里（fetch 成功就原样返回），所以既有成功路径不动。
        return _download_via_browser_attachment(
            url,
            name=name,
            directory=directory,
            limit=limit,
            timeout=timeout,
            headers=headers,
            cause=error,
        )
    status = int(getattr(response, "status", 0))
    if not 200 <= status < 300:
        raise _error("DOWNLOAD_FAILED", f"download answered HTTP {status}")
    body = response.body
    if not isinstance(body, (bytes, bytearray)):
        raise _error("DOWNLOAD_FAILED", "download response had no byte body")
    if len(body) > limit:
        raise _error("DOWNLOAD_TOO_LARGE", f"download is {len(body)} bytes, over the {limit}-byte cap")
    target = _commit_bytes(directory, name, bytes(body))
    return {
        "path": str(target),
        "bytes": len(body),
        "sha256": hashlib.sha256(bytes(body)).hexdigest(),
        "contentType": _header_value(getattr(response, "headers", {}), "Content-Type"),
        "status": status,
    }


def _download_via_browser_attachment(
    url: str,
    *,
    name: str,
    directory: Path,
    limit: int,
    timeout: float,
    headers: dict[str, str] | None,
    cause: BaseException,
) -> dict[str, Any]:
    """浏览器路径的附件下载：等 ``download`` 事件，而不是等一次导航。

    ``StealthyFetcher.fetch`` 走的是 ``page.goto``，而触发下载的响应在 Chromium 里不算
    导航，于是它只回一句 ``Page.goto: Download is starting``。这里直接开一个会话、挂上
    与一次性路径同一套网络守卫，然后等 Playwright 的 ``expect_download`` 把附件交出来。
    """
    import guard
    from adapters import page_setup
    from scrapling.fetchers import StealthySession

    timeout_ms = int(timeout * 1000)
    session_params: dict[str, Any] = {"timeout": timeout_ms}
    proxy = guard.browser_proxy(url)
    if proxy is not None:
        session_params["proxy"] = proxy
    session = StealthySession(**session_params)
    page = None
    try:
        session.start()
        page = session.context.new_page()
        page.set_default_timeout(timeout_ms)
        page_setup(page)
        if headers is not None:
            page.set_extra_http_headers(headers)
        # 一触发下载这次导航就会失败，失败本身是预期的一部分（理由见上）。
        with page.expect_download(timeout=timeout_ms) as pending, contextlib.suppress(Exception):
            page.goto(url, wait_until="commit")
        download = pending.value
        source = download.path()
        body = Path(source).read_bytes() if source is not None else b""
    except Exception as error:
        raise _error(
            "DOWNLOAD_FAILED",
            f"download failed: {type(cause).__name__}: {cause}; attachment fallback: {type(error).__name__}: {error}",
        ) from error
    finally:
        if page is not None:
            with contextlib.suppress(Exception):
                page.close()
        with contextlib.suppress(Exception):
            session.close()
    if len(body) > limit:
        raise _error("DOWNLOAD_TOO_LARGE", f"download is {len(body)} bytes, over the {limit}-byte cap")
    target = _commit_bytes(directory, name, body)
    return {
        "path": str(target),
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "contentType": None,
        "status": 200,
    }


def _image_size(data: bytes, image_type: str) -> tuple[int, int]:
    """从 PNG/JPEG 字节里读固有尺寸；读不出时给 (0, 0)。"""
    if image_type == "png" and data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return int(width), int(height)
    if image_type == "jpeg":
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                height, width = struct.unpack(">HH", data[index + 5 : index + 9])
                return int(width), int(height)
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                index += 2
                continue
            length = struct.unpack(">H", data[index + 2 : index + 4])[0]
            index += 2 + length
    return 0, 0


def screenshot(
    session: Any,
    *,
    image_type: str,
    full_page: bool,
    quality: Any,
    selector: str | None,
    timeout_ms: int,
) -> dict[str, Any]:
    """对会话当前页或页内单个元素截图，返回 base64 与固有尺寸。"""
    from session_page import _finish_page, _ready_page

    if image_type not in ("png", "jpeg"):
        raise _error("BAD_ARGS", "imageType must be png or jpeg")
    if quality is not None and (not isinstance(quality, int) or isinstance(quality, bool) or not 1 <= quality <= 100):
        raise _error("BAD_ARGS", "quality must be an integer from 1 to 100")
    if quality is not None and image_type != "jpeg":
        raise _error("BAD_ARGS", "quality only applies to jpeg screenshots")
    if full_page and selector is not None:
        raise _error("BAD_ARGS", "fullPage and selector cannot be combined")

    page_info = _ready_page(session)
    page = page_info.page
    try:
        if page.is_closed():
            raise _error("PAGE_BUSY", "the session's page has been closed")
        if selector is not None:
            locator = page.locator(selector)
            matches = locator.count()
            if matches != 1:
                raise _error("BAD_ARGS", f"selector must match exactly one element, matched {matches}")
            # timeout 与整页那支同源：参数面声明了 timeoutMs，两条路径都得真生效。
            data = locator.screenshot(
                type=image_type,
                timeout=timeout_ms,
                **({"quality": quality} if quality else {}),
            )
        else:
            data = page.screenshot(
                type=image_type,
                full_page=full_page,
                **({"quality": quality} if quality else {}),
                timeout=timeout_ms,
            )
        encoded = bytes(data)
        width, height = _image_size(encoded, image_type)
        return {
            "base64": base64.b64encode(encoded).decode("ascii"),
            "mediaType": "image/png" if image_type == "png" else "image/jpeg",
            "width": width,
            "height": height,
            "url": str(page.url),
        }
    finally:
        _finish_page(session.page_pool, page_info)
