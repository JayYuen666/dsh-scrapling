"""会话当前页的读取。只碰 ``StealthySession`` 的 page pool，不新建浏览器。"""

from __future__ import annotations

from typing import Any


def _adapter_error(code: str, message: str, *, details: dict[str, Any] | None = None) -> Exception:
    from adapters import AdapterError

    return AdapterError(code, message, details=details)


_ACTION_TYPES = frozenset(
    {
        "click",
        "move",
        "wheel",
        "textbox",
        "checkbox",
        "radio",
        "combobox",
        "press_key",
        "dialog",
        "wait_time",
        "wait_element",
        "wait_load",
    }
)
_SELECTOR_ACTIONS = frozenset({"click", "textbox", "checkbox", "radio", "combobox", "wait_element"})
_ELEMENT_STATES = frozenset({"attached", "detached", "hidden", "visible"})
_LOAD_STATES = frozenset({"load", "domcontentloaded", "networkidle"})


def _ready_page(session: Any) -> Any:
    """取一个就绪页；区分「没有页」与「页都被占用」。"""
    pool = getattr(session, "page_pool", None)
    if pool is None:
        raise _adapter_error("BAD_ARGS", "this session has no current page")
    page_info = pool.get_ready_page()
    if page_info is None:
        if getattr(pool, "pages_count", 0) > 0:
            raise _adapter_error("PAGE_BUSY", "the session's page is busy; retry shortly")
        raise _adapter_error("NO_CURRENT_PAGE", "the session has not opened a page yet")
    return page_info


def _finish_page(pool: Any, page_info: Any) -> None:
    page = page_info.page
    if page.is_closed():
        pool.remove_page(page_info)
    elif page_info in pool.pages:
        page_info.mark_ready()


def read_current_page(
    session: Any,
    *,
    extraction_type: str,
    css_selector: str | None,
    main_content_only: bool,
    max_content_chars: int,
    include_metadata: bool,
    strip_inline_images: bool,
) -> dict[str, Any]:
    """读当前就绪页的正文；没有页或页不可用时给出明确错误码。

    页面池把「没有页」与「页都被占用」分成两件事：前者是还没抓过，后者是别的请求
    正在用这一页。两者对模型要采取的行动不同，所以不能合并成一个空正文。
    """
    from adapters import _fake_response, to_payload

    page_info = _ready_page(session)
    page = page_info.page
    try:
        if page.is_closed():
            raise _adapter_error("PAGE_BUSY", "the session's page has been closed")
        html = page.content()
        title = page.title()
        url = page.url
        response = _fake_response(str(html), str(url), 200)
        payload = to_payload(
            response,
            extraction_type=extraction_type,
            css_selector=css_selector,
            main_content_only=main_content_only,
            max_content_chars=max_content_chars,
            strip_inline_images=strip_inline_images,
            include_metadata=include_metadata,
        )
    finally:
        _finish_page(session.page_pool, page_info)
    return {
        "url": payload["url"],
        "title": str(title),
        "content": payload["content"],
        "truncated": payload["truncated"],
        "notice": "the page was read from the session's current DOM, not fetched again",
        **({"metadata": payload["metadata"]} if "metadata" in payload else {}),
    }


def _require_selector(action: dict[str, Any], kind: str) -> str:
    target = action.get("target")
    if not isinstance(target, str) or not target:
        raise _adapter_error("ACTION_INVALID", f"{kind} needs a non-empty target selector")
    return target


def _perform(page: Any, action: dict[str, Any], timeout_ms: int) -> Any:
    """执行一个已校验的动作；dialog 注册的处理器会返回，由调用方在批次结束时摘掉。"""
    kind = str(action["type"])
    if kind == "wait_time":
        page.wait_for_timeout(int(action["ms"]))
        return None
    if kind == "wait_load":
        page.wait_for_load_state(str(action.get("state", "load")), timeout=timeout_ms)
        return None
    if kind == "wheel":
        page.mouse.wheel(float(action["deltaX"]), float(action["deltaY"]))
        return None
    if kind == "dialog":
        accept = action.get("accept", True) is not False

        def handler(dialog: Any) -> None:
            if accept:
                dialog.accept()
            else:
                dialog.dismiss()

        page.once("dialog", handler)
        return handler
    if kind == "press_key":
        key = str(action.get("key", ""))
        target = action.get("target")
        if isinstance(target, str) and target:
            page.locator(target).press(key, timeout=timeout_ms)
        else:
            page.keyboard.press(key)
        return None
    if kind == "move" and not isinstance(action.get("target"), str):
        page.mouse.move(float(action["x"]), float(action["y"]))
        return None

    selector = _require_selector(action, kind)
    locator = page.locator(selector)
    if kind == "click":
        locator.click(timeout=timeout_ms)
    elif kind == "move":
        locator.hover(timeout=timeout_ms)
    elif kind == "textbox":
        locator.fill(str(action.get("value", "")), timeout=timeout_ms)
    elif kind == "checkbox":
        if action.get("checked", True) is False:
            locator.uncheck(timeout=timeout_ms)
        else:
            locator.check(timeout=timeout_ms)
    elif kind == "radio":
        locator.check(timeout=timeout_ms)
    elif kind == "combobox":
        locator.select_option(str(action.get("value", "")), timeout=timeout_ms)
    elif kind == "wait_element":
        locator.wait_for(state=str(action.get("state", "visible")), timeout=timeout_ms)
    else:  # pragma: no cover —— 类型白名单已挡住
        raise _adapter_error("ACTION_INVALID", f"unknown action type: {kind}")
    return None


def _validate_actions(value: Any, max_actions: int) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise _adapter_error("ACTION_INVALID", "actions must be a non-empty array")
    if len(value) > max_actions:
        raise _adapter_error("ACTION_INVALID", f"at most {max_actions} actions are allowed")
    actions: list[dict[str, Any]] = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise _adapter_error("ACTION_INVALID", f"action {index} must be an object")
        kind = item.get("type")
        # frozenset 的成员判断先哈希：type 写成 list/dict 会抛 TypeError 而不是 ACTION_INVALID，
        # 宿主看到的就是内部异常。非字符串与未知类型在这里走同一条判据。
        if not isinstance(kind, str) or kind not in _ACTION_TYPES:
            raise _adapter_error("ACTION_INVALID", f"action {index} has an unknown type: {kind!r}")
        action = dict(item)
        if kind in _SELECTOR_ACTIONS:
            _require_selector(action, str(kind))
        if kind == "move":
            target = action.get("target")
            # 空串 target 不算 target：_perform 会把它当「有 target」交给 locator，
            # 执行期再抛 ACTION_INVALID 又被包装成 ACTION_FAILED，错误码与下标语义都错位。
            has_target = isinstance(target, str) and bool(target)
            has_point = isinstance(action.get("x"), (int, float)) and isinstance(action.get("y"), (int, float))
            if not has_target and not has_point:
                raise _adapter_error("ACTION_INVALID", "move needs a non-empty target selector or x/y coordinates")
        if kind == "wheel" and (
            not isinstance(action.get("deltaX"), (int, float)) or not isinstance(action.get("deltaY"), (int, float))
        ):
            raise _adapter_error("ACTION_INVALID", "wheel needs numeric deltaX and deltaY")
        if kind == "wait_time":
            ms = action.get("ms")
            if not isinstance(ms, int) or isinstance(ms, bool) or ms < 0:
                raise _adapter_error("ACTION_INVALID", "wait_time needs a non-negative ms")
        if kind == "wait_element":
            state = action.get("state", "visible")
            if not isinstance(state, str) or state not in _ELEMENT_STATES:
                raise _adapter_error("ACTION_INVALID", f"unknown element state: {state!r}")
        if kind == "wait_load":
            state = action.get("state", "load")
            if not isinstance(state, str) or state not in _LOAD_STATES:
                raise _adapter_error("ACTION_INVALID", f"unknown load state: {state!r}")
        if kind == "press_key":
            key = action.get("key")
            # 空字符串 key 能过 isinstance，执行期才由 Playwright 抛错并被包装成 ACTION_FAILED。
            if not isinstance(key, str) or not key:
                raise _adapter_error("ACTION_INVALID", "press_key needs a non-empty key")
        if kind == "checkbox" and not isinstance(action.get("checked", True), bool):
            raise _adapter_error("ACTION_INVALID", "checkbox checked must be a boolean")
        if kind == "dialog" and not isinstance(action.get("accept", True), bool):
            raise _adapter_error("ACTION_INVALID", "dialog accept must be a boolean")
        actions.append(action)
    return actions


def _release_dialog_handler(page: Any, handler: Any) -> None:
    """摘掉一个 dialog 处理器；页已关闭时不必再碰它（处理器随页一起消失）。"""
    if page.is_closed():
        return
    page.remove_listener("dialog", handler)


def run_actions(
    session: Any,
    *,
    actions: Any,
    slowly: bool,
    max_actions: int,
    timeout_ms: int,
) -> dict[str, Any]:
    """按顺序执行结构化动作；首个失败停止并点名下标。"""
    prepared = _validate_actions(actions, max_actions)
    page_info = _ready_page(session)
    page = page_info.page
    completed = 0
    dialog_handlers: list[Any] = []
    try:
        if page.is_closed():
            raise _adapter_error("PAGE_BUSY", "the session's page has been closed")
        for index, action in enumerate(prepared, start=1):
            try:
                handler = _perform(page, action, timeout_ms)
                if handler is not None:
                    dialog_handlers.append(handler)
                completed = index
                if slowly:
                    page.wait_for_timeout(100)
            except Exception as error:
                # 慢速间隔也在这一层里：页在动作之间被关掉时同样按 ACTION_FAILED 点名下标，
                # 而不是把裸异常漏给宿主。
                raise _adapter_error(
                    "ACTION_FAILED",
                    f"action {index} ({action['type']}) failed: {type(error).__name__}: {error}",
                    details={"actionIndex": index},
                ) from error
        return {
            "completed": completed,
            "finalUrl": str(page.url),
            "title": str(page.title()),
        }
    finally:
        # 页面在共享的 page pool 里跨请求复用：批次一结束就摘掉 dialog 处理器，
        # 否则后续请求弹出的对话框会被这一次动作留下的处理器替用户应答。
        for handler in dialog_handlers:
            _release_dialog_handler(page, handler)
        _finish_page(session.page_pool, page_info)
