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
from threading import Lock
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

from scrapling.core.storage import StorageSystemMixin

DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
KEY_PREFIX = "scrapling:adaptive"
DEFAULT_TIMEOUT_SECONDS = 2.0

# 客户端按 (连接串, 超时) 复用：上游要求存储类用 ``lru_cache`` 包一层（它检查 ``__wrapped__``），
# 而 adapters 的 ``storage_args`` 里带着**整页 URL**，所以每抓一个新页面就会新建一个存储实例。
# 连接池若跟着实例走，就是每页新开一池、上一个池被挤出缓存时没人关（连接要等 GC 才释放）。
# 按连接串复用之后，实例的多少不再放大连接数。
_CLIENT_CACHE: dict[tuple[str, float], Any] = {}
_CLIENT_LOCK = Lock()


class RedisUnavailable(RuntimeError):
    """Redis 不可用或客户端缺失；调用方把它翻成带码的失败。"""


def redacted_redis_url(raw: str) -> str:
    """去掉 userinfo 的展示形式：口令不进日志、不进错误消息。

    urlsplit 对非法端口**不报错**，真正抛 ValueError 的是惰性解析的 .port；本函数恰好只在
    构造异常消息时被调用（__init__ 与 save/retrieve 的 except 分支），早先那版会让「非法
    redisUrl」以 ValueError: Port could not be cast to integer value 顶替本函数该给的可读
    文本，把排障引去看代码而不是看配置。所以端口解析也收进 try，解不开就写 <invalid-port>
    ——主机仍要留着，那正是要看的那一位。

    IPv6 字面量的方括号由 urlsplit 去掉（hostname 是不带方括号的 ::1），重建成 redis://::1:6379/0 就
    不再是可复用的连接串，这里补回方括号。
    """
    try:
        parts = urlsplit(raw)
    except ValueError:
        return "redis://<invalid>"
    host = parts.hostname or "<invalid>"
    if ":" in host:
        host = f"[{host}]"
    try:
        port = f":{parts.port}" if parts.port is not None else ""
    except ValueError:
        port = ":<invalid-port>"
    database = parts.path or ""
    return f"{parts.scheme or 'redis'}://{host}{port}{database}"


def _default_client(redis_url: str, *, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> Any:
    # 同一 (连接串, 超时) 只建一个客户端：存储实例是每个 URL 一个（见 _CLIENT_CACHE 的说明），
    # 连接池跟着实例走就会每页新开一池。复用之后连接数由连接串的个数决定，不由页面个数决定。
    key = (redis_url, timeout_seconds)
    with _CLIENT_LOCK:
        cached = _CLIENT_CACHE.get(key)
        if cached is not None:
            return cached
        try:
            from redis import Redis
        except ModuleNotFoundError as error:
            # 没装客户端是**部署**的问题，不是抓取失败：点名的错误让人知道该装 adaptive-redis 包。
            raise RedisUnavailable(
                "the redis client is missing; install the adaptive-redis pack (pip install redis)"
            ) from error
        # 超时要真的交给客户端：早先它只落在 self.timeout_seconds 上、全文件没有使用点，于是
        # socket 超时一直是客户端自己的默认值（连接卡住时表现为整场抓取挂死）。
        client = Redis.from_url(
            redis_url,
            decode_responses=True,
            socket_timeout=timeout_seconds,
            socket_connect_timeout=timeout_seconds,
        )
        _CLIENT_CACHE[key] = client
        return client


def _forget_client(key: tuple[str, float], client: Any) -> None:
    """把这份客户端从复用表里摘掉（只摘自己那一份，别人的不动）。"""
    with _CLIENT_LOCK:
        if _CLIENT_CACHE.get(key) is client:
            _CLIENT_CACHE.pop(key, None)


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
        self._client_key = (redis_url, timeout_seconds)
        # 构造阶段与连接阶段分开报：工厂抛的是「谁也没连上」，ping 抛的才是「连不上」。
        try:
            self._client = client_factory(redis_url, timeout_seconds=timeout_seconds)
        except RedisUnavailable:
            raise
        except TypeError:
            # 自定义工厂的签名不接受 timeout_seconds 是**代码**问题，不是连接故障；
            # 翻成「not reachable」会把排障引去查网络。原样抛，调用方（adapters）会带上类型名。
            raise
        except Exception as error:
            raise RedisUnavailable(
                f"redis client setup failed for {redacted_redis_url(redis_url)}: {type(error).__name__}: {error}"
            ) from error
        try:
            self._client.ping()
        except Exception as error:  # 连接失败的种类由客户端决定
            # 连不上就把这份客户端从复用表里摘掉：留着它只会让下一次构造再撞同一堵墙。
            _forget_client(self._client_key, self._client)
            raise RedisUnavailable(
                f"redis is not reachable at {redacted_redis_url(redis_url)}: {type(error).__name__}: {error}"
            ) from error

    def _key(self, identifier: str) -> str:
        bucket = self._get_base_url()
        digest = self._get_hash(identifier)
        return f"{self.prefix}:{bucket}:{digest}"

    def save(self, element: Any, identifier: str) -> None:
        from orjson import dumps
        from scrapling.core.utils import _StorageTools

        payload = dumps(_StorageTools.element_to_dict(element)).decode("utf-8")
        # 不加锁：redis-py 的客户端与连接池本身线程安全，单条 SET 也没有可被撕开的中间态；
        # 存储层的锁只会把最多 timeout_seconds 的 socket 阻塞复制到其它线程上。
        try:
            self._client.set(self._key(identifier), payload)
        except Exception as error:
            raise RedisUnavailable(
                f"redis write failed at {redacted_redis_url(self.redis_url)}: {type(error).__name__}: {error}"
            ) from error

    def retrieve(self, identifier: str) -> Optional[dict[str, Any]]:
        from orjson import loads

        try:
            raw = self._client.get(self._key(identifier))
        except Exception as error:
            raise RedisUnavailable(
                f"redis read failed at {redacted_redis_url(self.redis_url)}: {type(error).__name__}: {error}"
            ) from error
        if raw is None:
            return None
        return loads(raw)

    def close(self) -> None:
        """关掉客户端，并把自己从 lru_cache 里摘掉。

        第二件事是承重的：类是用 lru_cache(1) 包的（上游按 __wrapped__ 校验），关掉客户端后
        它仍会把同一个实例发给下一次相同参数的构造，于是那份存储永久坏死——每次 save/retrieve
        都撞一个已关闭的客户端，adapters 每页降级，没有任何自愈路径。
        """
        _forget_client(self._client_key, self._client)
        close = getattr(self._client, "close", None)
        if callable(close):
            close()
        # 注意取的是模块级的包装对象：实例的 type 是**原始类**，lru 包装上的 cache_clear
        # 只挂在模块导出的那个可调用对象上。
        drop_cache = getattr(RedisStorageSystem, "cache_clear", None)
        if callable(drop_cache):
            drop_cache()
