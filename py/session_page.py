"""会话当前页的读取。只碰 ``StealthySession`` 的 page pool，不新建浏览器。"""

from __future__ import annotations

from typing import Any


def _adapter_error(code: str, message: str, *, details: dict[str, Any] | None = None) -> Exception:
    from adapters import AdapterError

    return AdapterError(code, message, details=details)


# 单条 `wait_time` 的上限：默认动作超时在 30s 量级，无上界会把 page pool 的槽位占死。
_MAX_WAIT_MS = 60_000

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


def _closed_page_error() -> Exception:
    """页已被关闭时的错误码。

    与「页被别的请求占着」分开：`PAGE_BUSY` 的文案是「retry shortly」，而这一页紧接着就会被
    `_finish_page` 从池里摘掉，重试拿到的是 `NO_CURRENT_PAGE` —— 让模型按「稍后重试」去等一个
    已经不存在的页，是把它往错的方向支。`PAGE_CLOSED` 的意思是「这一页没了，重新开一次会话或
    再抓一次」，那才是它该做的事。
    """
    return _adapter_error("PAGE_CLOSED", "the session's page has been closed; open the session again")


def _page_identity(page: Any) -> tuple[str, str]:
    """读终页的 url 与标题，读不到就给空串。

    这两个是**纯展示**字段，而 `title()` 是一次远端调用：最后一条动作如果是关窗（点击
    `window.close()`）或页面崩溃，这里会抛 Playwright 的 TargetClosedError。那样整批动作的
    成果（`completed` 计数）会连同这一句一起丢掉，宿主只能看到内部异常 —— 动作其实全做成了。
    所以两项各自兜底，读不出就是空串，由调用方决定怎么措辞。
    """
    url = ""
    title = ""
    try:
        url = str(page.url)
    except Exception:  # noqa: BLE001 —— 纯展示字段，读不到就是空串
        url = ""
    try:
        title = str(page.title())
    except Exception:  # noqa: BLE001 —— 同上；`title()` 是远端调用，页一崩就抛
        title = ""
    return url, title


def _number(value: Any) -> bool:
    """是不是一个真数字：`bool` 是 `int` 的子类，`True` 会被 `float()` 静默变成 1.0。

    坐标与滚轮位移用这一条判据。传 `true` / `false` 是调用方明显的传参错误，静默成 1.0 / 0.0
    等于替它做了一次带副作用的鼠标位移。同文件对 `wait_time.ms` 早已显式排除 `bool`
    （`isinstance(ms, bool)`），两处判据现在同源。
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool)


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
            raise _closed_page_error()
        try:
            html = page.content()
        except Exception as error:  # 读到一半页被关掉/崩溃，归成「这一页没了」
            raise _closed_page_error() from error
        url, title = _page_identity(page)
        response = _fake_response(str(html), url, 200)
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


def _has_target(action: dict[str, Any]) -> bool:
    """动作里是否带了一个**可用**的 target 选择器：非字符串与空串都算没有。

    校验侧与执行侧必须走同一条判据。分头判会错位：校验侧认可「空串 target + x/y 坐标」这种
    合法写法（坐标位移），而执行侧只判 `isinstance(target, str)` —— 空串是 str，于是它跳过
    坐标分支、落到 `_require_selector` 抛 ACTION_INVALID，再被批次包装成 ACTION_FAILED。
    用户看到的是「执行失败」，真实原因是「这个动作本来就不该带 target」，错误码与下标语义全错位。
    """
    target = action.get("target")
    return isinstance(target, str) and bool(target)


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
        if _has_target(action):
            page.locator(_require_selector(action, kind)).press(key, timeout=timeout_ms)
        else:
            page.keyboard.press(key)
        return None
    if kind == "move" and not _has_target(action):
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
            # 与执行侧同一条判据（`_has_target`）：空串 target 不算 target。
            has_point = _number(action.get("x")) and _number(action.get("y"))
            if not _has_target(action) and not has_point:
                raise _adapter_error("ACTION_INVALID", "move needs a non-empty target selector or x/y coordinates")
        if kind == "wheel" and (not _number(action.get("deltaX")) or not _number(action.get("deltaY"))):
            raise _adapter_error("ACTION_INVALID", "wheel needs numeric deltaX and deltaY")
        if kind == "wait_time":
            ms = action.get("ms")
            if not isinstance(ms, int) or isinstance(ms, bool) or ms < 0:
                raise _adapter_error("ACTION_INVALID", "wait_time needs a non-negative ms")
            # 上界：默认动作超时是 30s 量级，而单条 wait_time 无上界时模型可以要几个小时，
            # 把整批动作连同共享 page pool 的槽位一起占死。
            if ms > _MAX_WAIT_MS:
                raise _adapter_error(
                    "ACTION_INVALID",
                    f"wait_time must be at most {_MAX_WAIT_MS} ms",
                )
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


def _release_or_error(page: Any, handler: Any) -> Exception | None:
    """摘一个 dialog 处理器；失败时把异常交回调用方，而不是当场中断收尾。

    @param page - 当前页
    @param handler - 之前挂上的 dialog 处理器
    @returns 失败时的异常，成功时为 None
    """
    try:
        _release_dialog_handler(page, handler)
    except Exception as error:  # noqa: BLE001 —— 交给调用方在收尾之后统一报
        return error
    return None


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
            raise _closed_page_error()
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
        # 终页信息在 finally 之外读：动作全做成了才走这里，而这两项各自兜底（一次关窗或页崩溃
        # 不该把已经完成的批次报成内部异常）。
        url, title = _page_identity(page)
        return {
            "completed": completed,
            "finalUrl": url,
            "title": title,
        }
    finally:
        # 页面在共享的 page pool 里跨请求复用：批次一结束就摘掉 dialog 处理器，
        # 否则后续请求弹出的对话框会被这一次动作留下的处理器替用户应答。
        # 摘处理器失败不能挡住 _finish_page：那一句才是把页还给池子的那一步，
        # 少了它页面永久 PAGE_BUSY、后续请求全被拒。所以先逐条摘并收集失败，
        # 让收尾先跑完，再把失败一次性说出去 —— 不静默吞，也不 try/except/continue。
        release_failures = [_release_or_error(page, handler) for handler in dialog_handlers]
        _finish_page(session.page_pool, page_info)
        # 收尾跑完之后再一次性上报：失败有可读出口，但不会挡住把页还给池子。
        first_failure = next((item for item in release_failures if item is not None), None)
        if first_failure is not None:
            raise first_failure
