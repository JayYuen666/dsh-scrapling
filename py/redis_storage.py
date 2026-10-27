"""py/redis_storage.py —— Scrapling adaptive 指纹的 Redis 存储。

上游只发 SQLite 一种具体实现，但把扩展点留成了 ``StorageSystemMixin`` 子类；
它的文档里 Redis 就是这一档的示例。这里按同一个契约实现：键按
``<prefix>:<注册域>:<sha256(identifier)>`` 落，值是该元素指纹的 orjson 串。

两个约束来自上游 ``Selector`` 的装配代码：类必须用 ``lru_cache`` 包一层
（它检查 ``__wrapped__``），且构造参数必须全从 ``storage_args`` 来。因此这里的
``__init__`` 只收可序列化的值；测试要注入替身客户端时才用 ``client_factory``。
"""

from __future__ import annotations

from functools import lru_cache
from threading import RLock
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

from scrapling.core.storage import StorageSystemMixin

DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
KEY_PREFIX = "scrapling:adaptive"
DEFAULT_TIMEOUT_SECONDS = 2.0


class RedisUnavailable(RuntimeError):
    """Redis 不可用或客户端缺失；调用方把它翻成带码的失败。"""


def redacted_redis_url(raw: str) -> str:
    """去掉 userinfo 的展示形式：口令不进日志、不进错误消息。"""
    try:
        parts = urlsplit(raw)
    except ValueError:
        return "redis://<invalid>"
    host = parts.hostname or "<invalid>"
    port = f":{parts.port}" if parts.port is not None else ""
    database = parts.path or ""
    return f"{parts.scheme or 'redis'}://{host}{port}{database}"


def _default_client(redis_url: str, *, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> Any:
    try:
        from redis import Redis
    except ModuleNotFoundError as error:
        # 没装客户端是**部署**的问题，不是抓取失败：点名的错误让人知道该装 adaptive-redis 包。
        raise RedisUnavailable(
            "the redis client is missing; install the adaptive-redis pack (pip install redis)"
        ) from error
    # 超时要真的交给客户端：早先它只落在 self.timeout_seconds 上、全文件没有使用点，于是
    # socket 超时一直是客户端自己的默认值（连接卡住时表现为整场抓取挂死）。
    return Redis.from_url(
        redis_url,
        decode_responses=True,
        socket_timeout=timeout_seconds,
        socket_connect_timeout=timeout_seconds,
    )


@lru_cache(1, typed=True)
class RedisStorageSystem(StorageSystemMixin):
    """以 Redis 为后端的 adaptive 指纹库。

    与 ``SQLiteStorageSystem`` 同契约：``save(element, identifier)`` /
    ``retrieve(identifier)``；``_get_base_url`` 由上游 mixin 提供（按注册域分桶）。
    """

    def __init__(
        self,
        redis_url: str = DEFAULT_REDIS_URL,
        url: Optional[str] = None,
        *,
        prefix: str = KEY_PREFIX,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        client_factory: Callable[..., Any] = _default_client,
    ) -> None:
        # redis 客户端是可选件，导入放在 _default_client 里；本模块本身只依赖 scrapling。
        super().__init__(url)
        self.redis_url = redis_url
        self.prefix = prefix
        self.timeout_seconds = timeout_seconds
        self._lock = RLock()
        try:
            self._client = client_factory(redis_url, timeout_seconds=timeout_seconds)
            self._client.ping()
        except RedisUnavailable:
            raise
        except Exception as error:  # 连接失败的种类由客户端决定
            raise RedisUnavailable(
                f"redis is not reachable at {redacted_redis_url(redis_url)}: {type(error).__name__}"
            ) from error

    def _key(self, identifier: str) -> str:
        bucket = self._get_base_url()
        digest = self._get_hash(identifier)
        return f"{self.prefix}:{bucket}:{digest}"

    def save(self, element: Any, identifier: str) -> None:
        from orjson import dumps
        from scrapling.core.utils import _StorageTools

        payload = dumps(_StorageTools.element_to_dict(element)).decode("utf-8")
        try:
            with self._lock:
                self._client.set(self._key(identifier), payload)
        except Exception as error:
            raise RedisUnavailable(
                f"redis write failed at {redacted_redis_url(self.redis_url)}: {type(error).__name__}"
            ) from error

    def retrieve(self, identifier: str) -> Optional[dict[str, Any]]:
        from orjson import loads

        try:
            with self._lock:
                raw = self._client.get(self._key(identifier))
        except Exception as error:
            raise RedisUnavailable(
                f"redis read failed at {redacted_redis_url(self.redis_url)}: {type(error).__name__}"
            ) from error
        if raw is None:
            return None
        return loads(raw)

    def close(self) -> None:
        with self._lock:
            close = getattr(self._client, "close", None)
            if callable(close):
                close()
