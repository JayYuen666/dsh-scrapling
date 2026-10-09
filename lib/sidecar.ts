// dsh-scrapling/lib/sidecar.ts —— 常驻 Python sidecar 的宿主侧客户端。
//
// 为什么用 `ctx.subprocess` 而不是 `ctx.shell`：`ShellProcess` 根本没有 stdin 成员，
// 它的 `stdin` 是「写一次即关闭」的批量形态 —— 常驻进程需要的是能持续写的双向通道。
// `ctx.subprocess.spawn()` 同步返回活句柄，`stdin:'pipe'` 时给出 `Writable`。
//
// 用官方 seam 还白拿三样东西，裸 `node:child_process` 都得自己重写：POSIX 上独立的
// 进程组（`kill(-pid)` 能打到后代）、宿主退出时的自动回收、环境变量脱敏。
//
// **一条必须自己接的线**：`dsh-tool-call-timeout-policy` 是**协作式**的，超时只通过
// `exec.signal` 通知，不会杀子进程。所以本客户端把每次调用的 signal 一路传到 spawn，
// 并在超时或 abort 时主动 `terminate()` + `waitForExit()` —— 否则一次超时的抓取会把
// 浏览器进程挂在后台，直到宿主退出。
//
// **返回值一律是 `unknown`**：sidecar 的载荷是跨语言的 JSON，宿主不该凭信任就断言形状。
// 工具层必须自己校验；多这一次校验换来的是「Python 侧改坏协议不会静默污染模型上下文」。

import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { decodeFrame, encodeFrame, pumpFrames } from "./jsonl.ts";
import { asText, SidecarError } from "./sidecar-error.ts";

import type { SidecarErrorCode } from "./sidecar-error.ts";
/**
 * 占位实现：ReadyWaiter 先用它满足类型，随后立刻被真正的回调改写。
 * 不是死代码 —— 构造对象时那两项必须有值，只是永远不会被调用到。
 */
/* v8 ignore next 4 —— 占位实现本身永远不会被调用：构造对象时需要它满足类型，
   紧接着就被真正的回调改写掉。 */
function noop(): void {
  // 故意什么都不做。
}

/** 协议版本；与 py/bridge.py 的 PROTOCOL_VERSION 对齐。 */
export const PROTOCOL_VERSION = 1;

/** Python 侧上报的能力。决定宿主注册哪些工具。 */
export interface SidecarCapabilities {
  /** Scrapling 是否可导入。 */
  readonly scrapling: boolean;
  /** 静态抓取是否可用。 */
  readonly static: boolean;
  /** 离线抽取是否可用。 */
  readonly extract: boolean;
  /** Playwright 浏览器是否就绪。 */
  readonly browser: boolean;
  /** patchright stealth 浏览器是否就绪。 */
  readonly stealth: boolean;
  /** Scrapling 版本号。 */
  readonly version?: string;
}

/** 客户端参数。 */
export interface SidecarOptions {
  /** Python 解释器名或绝对路径。 */
  readonly pythonBin: string;
  /** bridge.py 的绝对路径。 */
  readonly bridgePath: string;
  /** 子进程工作目录（放 adaptive 的 SQLite 等数据）。 */
  readonly cwd: string;
  /** 握手等待毫秒数。 */
  readonly handshakeTimeoutMs: number;
  /** 单次调用默认超时毫秒数。 */
  readonly requestTimeoutMs: number;
  /** 终止宽限毫秒数，透传给 ctx.subprocess 的 graceMs。 */
  readonly graceMs: number;
  /** 追加给子进程的环境变量；在脱敏之后合并。 */
  readonly env?: Readonly<Record<string, string>>;
  /** stderr 与诊断日志的去向；不给就静默丢弃。 */
  readonly log?: (line: string) => void;
  /**
   * sidecar 主动推来的事件帧（没有 id 的那种）。
   *
   * 爬虫这类长任务靠它把进度实时接出来 —— 响应帧要等任务结束才有，而进度要边跑边看。
   */
  readonly onEvent?: (frame: Record<string, unknown>) => void;
  /**
   * 出站 URL 的准入闸门：每个带 `url` 参数的调用都会先过它，判否就地抛错、根本不发子进程。
   *
   * 这是 Host 侧那道防线。Python 侧 guard.py 仍会在真实连接前复判一次；两边的差别是
   * 「有没有 TOCTOU 窗口」——Host 侧判完到子进程真连之间隔着一个进程边界，DNS 记录在这
   * 中间被改掉就能绕过。所以两边都要有，缺一不可。
   *
   * 返回值是**通过判定后实际要用的 URL**。闸门判的是 WHATWG 归一后的 host，真正发出去的
   * 必须是同一个字符串，否则「判的和连的不是同一个地址」会重新变成一条绕过路径。不返回
   * 则沿用原串，仅为兼容不需要归一化的自定义闸门。
   */
  readonly urlGate?: (url: string) => Promise<string | undefined>;
}

/** 单次调用的可选参数。 */
export interface CallOptions {
  /** 取消信号。abort 会连带拆掉整个进程。 */
  readonly signal?: AbortSignal;
  /**
   * 覆盖本次调用的超时；传 null 表示**不设超时**。
   *
   * 爬虫这种量级不定的任务不能用固定超时 —— 30 秒的预算套到一次几分钟的爬取上，
   * 会让每次成功都在最后一刻被判超时，然后整个进程被拆掉重来。
   */
  readonly timeoutMs?: number | null;
}

/** 一笔在途请求。 */
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  detachAbort: (() => void) | undefined;
}

/**
 * 握手帧没有 id，单独走一条等待队列。
 *
 * 两个成员故意不是 readonly：要把超时定时器挂在「被兑现即清掉」的位置，就需要在
 * 构造之后改写这两个函数。
 */
interface ReadyWaiter {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * 校验并归一 sidecar 上报的能力。
 *
 * 刻意不直接断言成 `SidecarCapabilities`：对端是另一个语言实现的进程，字段缺失或类型
 * 不对都该降级成「不可用」，而不是让一个断言崩在工具调用里。
 *
 * @param value - 握手帧里的 capabilities 原值
 * @returns 归一后的能力
 */
export function parseCapabilities(value: unknown): SidecarCapabilities {
  const record = isRecord(value) ? value : {};
  const flag = (key: string): boolean => record[key] === true;
  const { version } = record;
  return {
    scrapling: flag("scrapling"),
    static: flag("static"),
    extract: flag("extract"),
    browser: flag("browser"),
    stealth: flag("stealth"),
    ...(typeof version === "string" ? { version } : {}),
  };
}

/** sidecar 客户端。 */
export class SidecarClient {
  readonly #ctx: Context;
  readonly #options: SidecarOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #readyWaiters: ReadyWaiter[] = [];

  #handle: SubprocessHandle | undefined;
  #stopPump: (() => void) | undefined;
  #capabilities: SidecarCapabilities | undefined;
  #starting: Promise<SidecarCapabilities> | undefined;
  #stopped = false;
  #nextId = 0;

  /**
   * @param ctx - 宿主上下文，必须已注入 subprocess 服务
   * @param options - 客户端参数
   */
  public constructor(ctx: Context, options: SidecarOptions) {
    this.#ctx = ctx;
    this.#options = options;
  }

  /** 握手后拿到的能力；未就绪为 undefined。 */
  public get capabilities(): SidecarCapabilities | undefined {
    return this.#capabilities;
  }

  /** 进程是否就绪。 */
  public get alive(): boolean {
    return this.#handle !== undefined && this.#capabilities !== undefined && !this.#stopped;
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }

  /** 放弃所有在途请求：进程没了，继续等下去没有意义。 */
  #rejectAll(error: SidecarError): void {
    const entries = Array.from(this.#pending.values());
    for (const entry of entries) {
      SidecarClient.#settle(entry, error);
    }
    this.#pending.clear();
    while (this.#readyWaiters.length > 0) {
      this.#readyWaiters.shift()?.reject(error);
    }
  }

  static #settle(entry: Pending, error: SidecarError): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.detachAbort?.();
    entry.detachAbort = undefined;
    entry.reject(error);
  }

  #routeResponse(frame: Record<string, unknown>): void {
    const rawId = frame["id"];
    if (typeof rawId !== "string") {
      this.#log("[sidecar] response frame without id");
      return;
    }
    const entry = this.#pending.get(rawId);
    if (entry === undefined) {
      this.#log(`[sidecar] response for unknown id ${rawId}`);
      return;
    }
    this.#pending.delete(rawId);
    // 每笔在途请求都挂了超时定时器，所以「没有定时器」这一侧到不了。
    /* v8 ignore next 4 */
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.detachAbort?.();
    entry.detachAbort = undefined;
    if (frame["ok"] === true) {
      entry.resolve(frame["result"]);
      return;
    }
    const rawError = frame["error"];
    const message = isRecord(rawError) ? rawError["message"] : undefined;
    entry.reject(
      new SidecarError("SIDECAR_REQUEST_FAILED", asText(message, "unknown sidecar error")),
    );
  }

  #onFrame(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = decodeFrame(line);
    } catch (error) {
      this.#log(`[sidecar] unparsable frame: ${String(error)}`);
      return;
    }
    if (frame["event"] === "ready") {
      this.#readyWaiters.shift()?.resolve(frame);
      return;
    }
    if (typeof frame["event"] === "string") {
      // 非 ready 的事件帧（进度、心跳…）交给调用方，不进 pending 表。
      this.#options.onEvent?.(frame);
      return;
    }
    this.#routeResponse(frame);
  }

  /** 拆掉当前进程：所有在途请求作废。 */
  async #teardown(reason: string, code: SidecarErrorCode): Promise<void> {
    this.#log(`[sidecar] teardown: ${reason}`);
    this.#stopPump?.();
    this.#stopPump = undefined;
    const child = this.#handle;
    this.#handle = undefined;
    this.#capabilities = undefined;
    this.#starting = undefined;
    this.#rejectAll(new SidecarError(code, reason));
    if (child === undefined) {
      return;
    }
    try {
      child.terminate();
      await child.waitForExit();
    } catch (error) {
      this.#log(`[sidecar] terminate failed: ${String(error)}`);
    }
  }

  /**
   * 等握手帧。
   *
   * @param timeoutMs - 最长等待毫秒数
   * @returns 握手帧
   */
  async #waitForReady(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve: noop, reject: noop };
      const timer = setTimeout(() => {
        const index = this.#readyWaiters.indexOf(waiter);
        // waiter 一定还在队列里（只有被兑现或被 reject 才会移除，而那两条路都会清掉
        // 这个定时器），所以「找不到」这一侧到不了。
        /* v8 ignore next 3 */
        if (index !== -1) {
          this.#readyWaiters.splice(index, 1);
        }
        reject(
          new SidecarError("SIDECAR_HANDSHAKE_FAILED", `no ready frame within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      waiter.resolve = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };

      this.#readyWaiters.push(waiter);
    });
  }

  async #spawnOnce(signal?: AbortSignal): Promise<SidecarCapabilities> {
    // 这里不再判 ctx.subprocess 是否存在：插件的 inject 里声明了 subprocess，
    // 没有对应 provider 时 apply 根本不会被调用。真要在单测里跑，就把一个假的
    // runtime 塞进注入的 ctx —— 那本来就是测试该做的事。
    const { subprocess } = this.#ctx;
    const python = await subprocess.resolveExecutable(this.#options.pythonBin);
    const child = subprocess.spawn({
      argv: [python, "-u", "-I", this.#options.bridgePath],
      cwd: this.#options.cwd,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      graceMs: this.#options.graceMs,
      // PYTHONUNBUFFERED 是冗余的（已传 -u），但多一道不依赖启动参数的保险。
      env: { PYTHONUNBUFFERED: "1", ...this.#options.env },
      ...(signal === undefined ? {} : { signal }),
    });
    this.#handle = child;

    const { stdin, stdout } = child;
    if (stdin === undefined || stdout === undefined) {
      await this.#teardown("sidecar stdio pipes were not created", "SIDECAR_UNAVAILABLE");
      throw new SidecarError("SIDECAR_UNAVAILABLE", "sidecar stdio pipes were not created");
    }
    this.#stopPump = pumpFrames(stdout, (line) => {
      this.#onFrame(line);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: unknown) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim().length > 0) {
          this.#log(`[sidecar] ${line}`);
        }
      }
    });
    void child.done.catch((error: unknown) => {
      void this.#teardown(`sidecar exited: ${String(error)}`, "SIDECAR_CRASHED");
    });

    const ready = await this.#waitForReady(this.#options.handshakeTimeoutMs);
    if (ready["protocol"] !== PROTOCOL_VERSION) {
      const seen = asText(ready["protocol"], "unknown");
      await this.#teardown("protocol mismatch", "SIDECAR_PROTOCOL_MISMATCH");
      throw new SidecarError(
        "SIDECAR_PROTOCOL_MISMATCH",
        `sidecar speaks protocol ${seen}, host expects ${PROTOCOL_VERSION}`,
      );
    }
    this.#capabilities = parseCapabilities(ready["capabilities"]);
    return this.#capabilities;
  }

  /**
   * 确保进程就绪（必要时拉起）。
   *
   * @param signal - 取消信号
   * @returns 握手后的能力
   */
  public async ensureStarted(signal?: AbortSignal): Promise<SidecarCapabilities> {
    if (this.#stopped) {
      throw new SidecarError("SIDECAR_UNAVAILABLE", "sidecar client has been disposed");
    }
    if (this.#capabilities !== undefined) {
      return this.#capabilities;
    }
    this.#starting ??= this.#spawnOnce(signal);
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  /**
   * 发一个请求并等响应。
   *
   * @param method - 方法名
   * @param params - 参数对象
   * @param options - 超时与取消
   * @returns 对端的 result 原值（形状未经验证，调用方需自行校验）
   */
  public async call(
    method: string,
    params: object = {},
    options: CallOptions = {},
  ): Promise<unknown> {
    // URL 准入先于一切：判否就不必拉起子进程、更不必写管道。
    const gate = this.#options.urlGate;
    const target = (params as { url?: unknown }).url;
    let outgoing = params;
    if (gate !== undefined && typeof target === "string" && target.length > 0) {
      const normalized = await gate(target);
      // 闸门可能把 URL 归一过。判的和连的必须是同一个字符串，否则归一化就成了绕过面。
      // 换新的 params 对象而不是就地改：params 可能是调用方复用的对象，就地改会把
      // 上一次的归一结果带进下一次调用。
      if (typeof normalized === "string" && normalized !== target) {
        outgoing = { ...params, url: normalized };
      }
    }
    await this.ensureStarted(options.signal);
    const stdin = this.#handle?.stdin;
    // ensureStarted 成功即意味着 spawn 时拿到了管道（缺管道它自己就抛了），
    // 所以这里只是类型收窄用的兜底，运行期到不了。
    /* v8 ignore next 3 */
    if (stdin === undefined) {
      throw new SidecarError("SIDECAR_UNAVAILABLE", "sidecar is not running");
    }
    this.#nextId += 1;
    const id = `h${this.#nextId}`;
    // `??` 会把 null 也替换掉，于是「本次不设超时」变成用默认值 —— 必须判 undefined。
    const timeoutMs =
      options.timeoutMs === undefined ? this.#options.requestTimeoutMs : options.timeoutMs;

    const settled = new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { resolve, reject, timer: undefined, detachAbort: undefined };
      // 先落表再挂中止钩子。顺序反了的话，「信号进来时就已中止」这条同步路径会先跑完
      // abort()（它内部 teardown → #rejectAll() → 把表清空），然后这一行又把已经结清的
      // entry 塞回表里 —— 每来一次已中止的调用就永久留下一条死条目。
      this.#pending.set(id, entry);

      const { signal } = options;

      const abort = (code: SidecarErrorCode, message: string): void => {
        this.#pending.delete(id);
        SidecarClient.#settle(entry, new SidecarError(code, message));
        void this.#teardown(message, code);
      };

      // null = 本次不设超时（爬虫这类量级不定的任务）。写成 `timeoutMs ?? 0` 会立刻超时。
      if (timeoutMs !== null) {
        entry.timer = setTimeout(() => {
          abort("SIDECAR_TIMEOUT", `${method} timed out after ${timeoutMs}ms`);
        }, timeoutMs);
      }

      if (signal !== undefined) {
        const onAbort = (): void => {
          abort("SIDECAR_ABORTED", `${method} was aborted`);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          entry.detachAbort = () => {
            signal.removeEventListener("abort", onAbort);
          };
        }
      }
    });

    // 已经中止的那一次在上面就已经从表里摘掉了：请求根本没发出去，也就不该往正在终止的
    // 管道里再写一帧（写进去既不抛错也不触发 error，只是被静默丢弃）。
    if (!this.#pending.has(id)) {
      return settled;
    }

    // 一次 write 送完整的一行。Node 的 Writable.write 在同一 tick 内不会与别的 write
    // 交错，所以并发调用各自 write 也不会把两帧拼在一起。
    stdin.write(`${encodeFrame({ id, method, params: outgoing })}\n`);
    return settled;
  }

  /** 终止进程并等待受管区间清空。 */
  public async dispose(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    await this.#teardown("client disposed", "SIDECAR_CLOSED");
  }
}

/**
 * 建立一个 sidecar 客户端。
 *
 * 进程**惰性**拉起：第一次 `ensureStarted` 才 spawn，所以插件仅仅被加载不会凭空多出
 * 一个 Python 进程。
 *
 * @param ctx - 宿主上下文，必须已注入 subprocess 服务
 * @param options - 客户端参数
 * @returns 客户端
 */
export function createSidecar(ctx: Context, options: SidecarOptions): SidecarClient {
  return new SidecarClient(ctx, options);
}

export { SidecarError } from "./sidecar-error.ts";
export type { SidecarErrorCode } from "./sidecar-error.ts";
