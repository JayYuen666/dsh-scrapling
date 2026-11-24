"""逐请求取消 token；只在调用方明确设置的安全阶段边界生效。"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from threading import Event
from typing import Iterator


class RequestCancelled(RuntimeError):
    """当前请求已被取消；bridge 负责把它映射成协议错误码。"""


class CancellationToken:
    """可跨线程设置的请求级取消事件。"""

    def __init__(self) -> None:
        self._event = Event()

    @property
    def cancelled(self) -> bool:
        """是否已经收到取消。"""
        return self._event.is_set()

    def cancel(self) -> None:
        """设置取消事件；重复调用没有副作用。"""
        self._event.set()


_CURRENT_TOKEN: ContextVar[CancellationToken | None] = ContextVar(
    "dsh_scrapling_cancellation",
    default=None,
)


def current_token() -> CancellationToken | None:
    """返回当前请求绑定的 token；没有请求上下文时为 None。"""
    return _CURRENT_TOKEN.get()


@contextmanager
def bind(token: CancellationToken) -> Iterator[None]:
    """把 token 绑定到当前线程与异步上下文，并在退出时恢复上一层。"""
    previous = _CURRENT_TOKEN.set(token)
    try:
        yield
    finally:
        _CURRENT_TOKEN.reset(previous)


def raise_if_cancelled() -> None:
    """在安全阶段边界检查取消；不试图中断阻塞中的第三方调用。"""
    token = current_token()
    if token is not None and token.cancelled:
        raise RequestCancelled("request was cancelled")
