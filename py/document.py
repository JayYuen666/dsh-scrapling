"""PDF 文本读取：流式下载到临时文件，再用可选 pypdf 逐页抽取。"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from cancellation import raise_if_cancelled

DEFAULT_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_MAX_PAGES = 200
DEFAULT_MAX_OUTPUT_CHARS = 200_000
PYPDF_VERSION = "7.1.1"


def available() -> bool:
    """pypdf 是否可导入；缺包不影响 sidecar 启动。"""
    try:
        from pypdf import PdfReader
    except ImportError:
        return False
    return callable(PdfReader)


def _error(code: str, message: str) -> Exception:
    from adapters import AdapterError

    return AdapterError(code, message)


def _positive(value: Any, field: str, default: int) -> int:
    from adapters import _positive_int

    return _positive_int(value, field, default)


def _limits(args: dict[str, Any]) -> tuple[int, int, int]:
    """模型上限只能向下收，部署缺省值就是任务约定的三档。"""
    deployment = args.get("deployment")
    if deployment is None:
        deployment = {}
    if not isinstance(deployment, dict):
        raise _error("BAD_ARGS", "deployment must be an object")
    byte_ceiling = _positive(deployment.get("documentMaxBytes"), "deployment.documentMaxBytes", DEFAULT_MAX_BYTES)
    page_ceiling = _positive(deployment.get("documentMaxPages"), "deployment.documentMaxPages", DEFAULT_MAX_PAGES)
    output_ceiling = _positive(
        deployment.get("documentMaxOutputChars"),
        "deployment.documentMaxOutputChars",
        DEFAULT_MAX_OUTPUT_CHARS,
    )
    requested_bytes = _positive(args.get("maxBytes"), "maxBytes", byte_ceiling)
    requested_pages = _positive(args.get("maxPages"), "maxPages", page_ceiling)
    requested_output = _positive(args.get("maxOutputChars"), "maxOutputChars", output_ceiling)
    return min(requested_bytes, byte_ceiling), min(requested_pages, page_ceiling), min(requested_output, output_ceiling)


def read(args: dict[str, Any]) -> dict[str, Any]:
    """读一个 HTTP(S) PDF，返回页数、文本与截断标记。"""
    import guard
    import media
    from adapters import AdapterError, _positive_number, _string_map, _url, clip

    if not available():
        raise _error(
            "DEPENDENCY_MISSING",
            f"pypdf {PYPDF_VERSION} is not installed; run dsh-scrapling setup --feature documents --apply",
        )
    url = _url(args)
    allowed, reason = guard.url_allowed(url)
    if not allowed:
        raise _error("URL_BLOCKED", f"{url}: {reason}")
    max_bytes, max_pages, max_output_chars = _limits(args)
    headers = _string_map(args.get("headers"), "headers")
    cookies = _string_map(args.get("cookies"), "cookies")
    timeout = _positive_number(args.get("timeoutSeconds"), "timeoutSeconds", 120.0)
    impersonate = args.get("impersonate")
    if not isinstance(impersonate, str) or not impersonate:
        impersonate = "chrome"

    # TemporaryDirectory 包住整个读取过程：头部预检、流式超限、解析失败与加密/扫描
    # 分支都走同一个 finally，不把远端 PDF 留在用户目录或系统临时目录里。
    with tempfile.TemporaryDirectory(prefix="dsh-scrapling-document-") as temporary:
        downloaded = media._download_via_stream(
            url,
            name="document.pdf",
            directory=Path(temporary),
            limit=max_bytes,
            timeout=timeout,
            headers=headers,
            cookies=cookies,
            impersonate=impersonate,
            too_large_code="PDF_TOO_LARGE",
        )
        try:
            from pypdf import PdfReader
        except ImportError as error:
            raise _error("DEPENDENCY_MISSING", f"pypdf {PYPDF_VERSION} is not installed") from error
        try:
            reader = PdfReader(downloaded["path"])
            if reader.is_encrypted:
                raise _error("PDF_ENCRYPTED", "encrypted PDFs are not supported; provide an unencrypted copy")
            page_count = len(reader.pages)
            if page_count > max_pages:
                raise _error(
                    "PDF_TOO_LARGE",
                    f"PDF has {page_count} pages, over the {max_pages}-page cap",
                )
            texts: list[str] = []
            for index in range(page_count):
                raise_if_cancelled()
                texts.append(reader.pages[index].extract_text() or "")
            if not any(text.strip() for text in texts):
                raise _error("PDF_SCANNED", "PDF has no extractable text; scanned pages need OCR")
            content = "\n\n".join(f"--- Page {index + 1} ---\n{text.strip()}" for index, text in enumerate(texts))
        except AdapterError:
            raise
        except Exception as error:
            raise _error("FETCH_FAILED", f"could not read PDF: {type(error).__name__}: {error}") from error
        content, truncated = clip(content, max_output_chars)
        return {
            "url": url,
            "bytes": downloaded["bytes"],
            "pageCount": page_count,
            "pagesRead": page_count,
            "content": content,
            "truncated": truncated,
        }
