"""py/bridge.py —— 常驻 Python 进程的入口：JSON-lines 请求/响应服务。

为什么是常驻进程而不是每次拉起：Scrapling 最有价值的三块能力（浏览器会话、adaptive
选择器的 SQLite 指纹库、Spider 的断点）全都跨请求有状态。每次新进程会把 cookie、
指纹库和浏览器实例全部丢掉，等于只用了 Scrapling 的静态部分。

协议（Host -> Python，每行一个 JSON 对象）::

    {"id": "7", "method": "fetch", "params": {...}}

响应（Python -> Host，同样一行一个）::

    {"id": "7", "ok": true,  "result": {...}}
    {"id": "7", "ok": false, "error": {"code": "BAD_ARGS", "message": "..."}}

启动时先主动发一条**没有 id** 的事件帧，Host 侧据此做能力协商::

    {"event": "ready", "protocol": 1, "capabilities": {...}}

四条硬约束，写错了会静默坏掉：

1. **stdout 只能是协议帧。** 任何 ``print`` 或第三方库的进度输出都会把 JSON-lines
   流打坏，所以本文件与 adapters 的一切日志都走 stderr。
2. **一行一帧且不能交错。** 并发请求各自回帧时要串行化，否则两个响应会被拼在同一行。
3. **读 stdin 要按字节自行切行。** 直接用 ``sys.stdin.readline()`` 在管道上会因预读
   把两行一起吞掉，导致第二帧永远读不到。
4. **worker 数与并发上限一致。** 浏览器抓取很吃内存（每个 Chromium 实例数百 MB），
   无上限会让几个并行的工具调用把机器拖垮。

用法（``-u`` 关缓冲、``-I`` 隔离，避免用户 site-packages 里的同名模块把 scrapling 顶掉）::

    python -u -I bridge.py
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
from typing import Any, Callable

# 让 py/ 目录里的 guard 能被 adapters 用 `from guard import install` 找到。
_HERE = __file__.rsplit("/", 1)[0] or "."
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

PROTOCOL_VERSION = 1

# 并发上限：与工作线程数一致，多了也只是排队。
MAX_INFLIGHT = 4

# 单帧字节上限。readline() 拿到的是整行，超大的行在 json.loads 之前就该判掉 —— 解析本身
# 就要把这行再展开一份。宿主侧对每个工具的输出另有封顶，这条防的是「入参本身很大」。
MAX_FRAME_BYTES = 8 * 1024 * 1024

# 待处理队列的深度上限。队列只在 worker 全部占满时增长，而 worker 数是 MAX_INFLIGHT，
# 所以正常情况下的深度约等于 MAX_INFLIGHT；超过它说明调用方在以远超并发的速率灌帧，
# 继续收就是纯粹的内存增长。判否让调用方自己退避。
MAX_QUEUE_DEPTH = MAX_INFLIGHT * 4

_WRITE_LOCK = threading.Lock()
_SLOTS = threading.Semaphore(MAX_INFLIGHT)
_QUEUE: list[dict[str, Any]] = []
_QUEUE_LOCK = threading.Lock()
_WORKERS_LOCK = threading.Lock()
_WORKERS: list[threading.Thread] = []


def log(message: str) -> None:
    """写日志到 stderr。stdout 留给协议帧。"""
    print(f"[bridge] {message}", file=sys.stderr, flush=True)


def emit(frame: dict[str, Any]) -> None:
    """写一帧到 stdout 并立刻冲刷。

    冲刷是必须的：Host 侧按行阻塞读取，不冲的话响应会卡在缓冲区里直到进程退出。
    """
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    with _WRITE_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def ok(request_id: Any, result: Any) -> dict[str, Any]:
    """构造成功响应帧。

    :param request_id - 原样回传请求的 id
    :param result - 业务结果
    :returns: 响应帧
    """
    return {"id": request_id, "ok": True, "result": result}


def fail(request_id: Any, code: str, message: str) -> dict[str, Any]:
    """构造失败响应帧。

    :param request_id - 原样回传请求的 id
    :param code - 机器可读错误码
    :param message - 人读信息
    :returns: 响应帧
    """
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}


def handle(frame: dict[str, Any]) -> dict[str, Any]:
    """分发一个请求帧。

    :param frame - 已解析的请求帧
    :returns: 响应帧
    """
    import adapters

    request_id = frame.get("id")
    method = frame.get("method")
    params = frame.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return fail(request_id, "BAD_ARGS", "params must be an object")
    if not isinstance(method, str):
        return fail(request_id, "BAD_ARGS", "method must be a string")

    handler: Callable[[dict[str, Any]], Any] | None = adapters.METHODS.get(method)
    if handler is None:
        return fail(request_id, "UNKNOWN_METHOD", f"unknown method: {method}")

    with _SLOTS:
        try:
            return ok(request_id, handler(params))
        except adapters.AdapterError as error:
            return fail(request_id, error.code, str(error))
        except ModuleNotFoundError as error:
            # 缺的是可选依赖，不是抓取失败。落到下面的 FETCH_FAILED 会把它说成「请求出错」，
            # 而模型与用户对这两种情况的正确反应完全不同：前者该退避重试，后者该去装包。
            # 报错必须指向后者，所以单列一个码，并把本插件的硬性安装命令直接写进去——
            # Scrapling 自己只说「装 markdownify」，而本插件要的是整个 extra。
            missing = error.name or "某个可选依赖"
            log(f"{method} aborted: missing dependency {missing}")
            return fail(
                request_id,
                "DEPENDENCY_MISSING",
                f"缺少可选依赖 {missing}，这次调用无法执行。本插件的默认 extractionType 是 "
                f'markdown，需要 scrapling 的 rag extra：pip install "scrapling[rag]>=0.4.15,<0.5"',
            )
        except Exception as error:  # noqa: BLE001 —— 任何异常都要变成一帧错误，不能让线程死掉
            log(f"{method} failed: {type(error).__name__}: {error}")
            log(traceback.format_exc())
            return fail(request_id, "FETCH_FAILED", f"{type(error).__name__}: {error}")


def _drain() -> dict[str, Any] | None:
    """取一帧待处理请求；队列空给 None。"""
    with _QUEUE_LOCK:
        return _QUEUE.pop(0) if _QUEUE else None


def _worker() -> None:
    """工作线程：取帧、处理、回帧。空闲时退出，由 ``_ensure_worker`` 按需再拉起。

    空闲退出而不是常驻，是为了让「跑过的 worker」不被记成活线程 —— 否则线程计数会
    只增不减，最后再多的请求也没有 worker 处理。
    """
    try:
        while True:
            frame = _drain()
            if frame is None:
                # 短暂等一下再退出：入队与起线程之间总有一个时间差，
                # 立刻退出等于把这个窗口留给运气。
                time.sleep(0.05)
                frame = _drain()
            if frame is None:
                return
            try:
                emit(handle(frame))
            except Exception as error:  # noqa: BLE001 —— 连序列化失败都不能让线程死掉
                log(f"emit failed: {type(error).__name__}: {error}")
    finally:
        with _WORKERS_LOCK:
            current = threading.current_thread()
            if current in _WORKERS:
                _WORKERS.remove(current)


def _ensure_worker(count: int) -> None:
    """保证活着的工作线程数达到 count。

    刻意**不用** ``threading.active_count()``：那是全局线程数，会把 Playwright、
    patchright 留下的后台线程一起算进来，于是本包自己的 worker 永远算不满，一个请求
    都不会被处理。这里只数本包自己拉起来的线程。

    :param count: 期望的存活线程数，上限 MAX_INFLIGHT
    """
    wanted = max(1, min(count, MAX_INFLIGHT))
    while True:
        with _WORKERS_LOCK:
            _WORKERS[:] = [item for item in _WORKERS if item.is_alive()]
            if len(_WORKERS) >= wanted:
                return
            worker = threading.Thread(target=_worker, daemon=True, name="bridge-worker")
            _WORKERS.append(worker)
            worker.start()


def _shutdown_sessions() -> None:
    """退出前关掉全部会话。

    浏览器会话是独立进程：sidecar 自己退了、Chromium 还活着，就成了没人管的孤儿。
    """
    import adapters

    try:
        adapters.close_all_sessions()
    except Exception as error:  # noqa: BLE001 —— 关不掉也不能拖住关机
        log(f"failed to close sessions: {type(error).__name__}: {error}")


def _drain_before_exit(timeout: float = 5.0) -> None:
    """关机前给在途请求一个把话说完的机会。

    收到 shutdown 就直接 return 的话，队列里已排队的请求会被静默丢掉 —— Host 侧看到的
    是「没等到响应」而不是「被关机打断」。所以这里有界地等一下：等空了就走，等不到就
    记一行日志再走，不无限期拖住关机。

    :param timeout - 最长等待秒数
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _QUEUE_LOCK:
            pending = bool(_QUEUE)
        with _WORKERS_LOCK:
            busy = any(item.is_alive() for item in _WORKERS)
        if not pending and not busy:
            return
        time.sleep(0.02)
    log("shutdown: giving up on in-flight requests")


def read_loop() -> int:
    """按字节读 stdin 并切成一帧一帧，直到 EOF 或收到 shutdown。

    :returns: 进程退出码
    """
    import adapters
    from guard import configure_from_env

    configure_from_env()

    try:
        emit(
            {
                "event": "ready",
                "protocol": PROTOCOL_VERSION,
                "capabilities": adapters.capabilities(),
            }
        )
    except Exception as error:  # noqa: BLE001
        log(f"failed to report readiness: {type(error).__name__}: {error}")

    # 必须用 readline()，不能用 read(65536)。
    # BufferedReader.read(n) 的语义是「读满 n 字节或遇到 EOF」：宿主只要保持管道开着
    # （而常驻进程本来就该一直开着），它就会一直等下去，第一个请求永远进不来。
    # 实测踩过：批量发完立刻 close stdin 的探针能过，逐帧交互的客户端会挂死。
    # readline() 逐行返回、读到换行就走，既不会被预读吞掉下一帧，也不会空等。
    for raw in iter(sys.stdin.buffer.readline, b""):
        if not raw.strip():
            continue
        if len(raw) > MAX_FRAME_BYTES:
            emit(
                fail(
                    None,
                    "BAD_FRAME",
                    f"frame of {len(raw)} bytes exceeds the {MAX_FRAME_BYTES} byte limit",
                )
            )
            continue
        try:
            frame = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            emit(fail(None, "BAD_FRAME", f"unparsable frame: {error}"))
            continue
        if not isinstance(frame, dict):
            emit(fail(None, "BAD_FRAME", "frame must be an object"))
            continue
        if frame.get("method") == "shutdown":
            emit(ok(frame.get("id"), {"stopping": True}))
            _drain_before_exit()
            return 0
        # 顺序要紧：先入队再起 worker。反过来的话，新起的线程可能立刻醒来、
        # 看到空队列就退出，这一帧就永远没人处理 —— 且只在时序凑巧时才会复现。
        with _QUEUE_LOCK:
            depth = len(_QUEUE)
            if depth >= MAX_QUEUE_DEPTH:
                emit(
                    fail(
                        frame.get("id"),
                        "BUSY",
                        f"{depth} requests already queued (limit {MAX_QUEUE_DEPTH})",
                    )
                )
                continue
            _QUEUE.append(frame)
            depth += 1
        _ensure_worker(min(depth, MAX_INFLIGHT))
    log("stdin closed")
    _drain_before_exit()
    _shutdown_sessions()
    return 0


def main() -> int:
    """进程入口。

    :returns: 退出码
    """
    log(f"protocol {PROTOCOL_VERSION} ready; python {sys.version.split()[0]}")
    try:
        return read_loop()
    except KeyboardInterrupt:  # pragma: no cover —— 只有手动 Ctrl+C 才会走到
        log("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
