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

/** dispose 发出的优雅关闭帧的 id。它不在 pending 表里，bridge 的应答会按「无主帧」落地。 */
const DISPOSE_FRAME_ID = "dispose";

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
        // 握手超时要**先拆进程再拒**：子进程此刻还活着且没人管它，而 #capabilities 仍是
        // undefined，下一次 ensureStarted 会再 spawn 一个 —— 每次启动失败漏一个 Python
        // 进程。紧跟着的协议不匹配分支本来就这么做，这里只是漏了。
        const reason = `no ready frame within ${timeoutMs}ms`;
        // 拆完再拒：调用方拿到的拒绝理由要与已经发生的回收对得上。
        void (async (): Promise<void> => {
          await this.#teardown(reason, "SIDECAR_HANDSHAKE_FAILED");
          reject(new SidecarError("SIDECAR_HANDSHAKE_FAILED", reason));
        })();
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
    // dispose() 可能正好落在 resolveExecutable 的 await 上跑完了：那时 #handle 还是空，
    // #teardown 拆不到任何东西，而这个进程刚出生就没人管了。补一道判定并立刻收掉它 ——
    // 否则每次「启动途中卸载」都会漏一个 Python 进程。
    if (this.#stopped) {
      child.terminate();
      await child.waitForExit();
      this.#handle = undefined;
      throw new SidecarError("SIDECAR_UNAVAILABLE", "sidecar client has been disposed");
    }
    this.#stopPump = pumpFrames(
      stdout,
      (line) => {
        this.#onFrame(line);
      },
      // 管道报错、帧超限或帧处理抛错都归到这里。少一个 error 监听时这些都是未捕获异常，
      // 会直接掀翻宿主进程，所以这里把 sidecar 拆掉，并让在途请求以一个明确的错误收场。
      (error: unknown) => {
        void this.#teardown(`sidecar stream failed: ${String(error)}`, "SIDECAR_CRASHED");
      },
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: unknown) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim().length > 0) {
          this.#log(`[sidecar] ${line}`);
        }
      }
    });
    // stderr 与 stdin 同理：它们也是子进程管道，报错同样会变成未捕获异常。
    child.stderr?.on("error", (error: unknown) => {
      void this.#teardown(`sidecar stderr failed: ${String(error)}`, "SIDECAR_CRASHED");
    });
    stdin.on("error", (error: unknown) => {
      void this.#teardown(`sidecar stdin failed: ${String(error)}`, "SIDECAR_CRASHED");
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

      // 只作废这一个请求：调用方取消的是「这一次调用」，不是整个常驻进程。原先这里也走
      // #teardown，于是取消一个 web_fetch 会把同一进程上所有并行的抓取一起带走 ——
      // 而抓取工具声明的是 isConcurrencySafe: true，并发是常态。
      //
      // 被放弃的请求在对端仍可能跑完；它的回帧按 id 配对，而那个 id 已从表里摘掉，
      // 于是那一帧只是无人认领地落地，不会串到别的请求上。
      const failRequest = (code: SidecarErrorCode, message: string): void => {
        this.#pending.delete(id);
        SidecarClient.#settle(entry, new SidecarError(code, message));
      };

      // null = 本次不设超时（爬虫这类量级不定的任务）。写成 `timeoutMs ?? 0` 会立刻超时。
      if (timeoutMs !== null) {
        entry.timer = setTimeout(() => {
          // 超时仍走拆进程：超时的含义是「这个常驻进程可能已经不响应了」，回收它才有
          // 自愈。与取消分开，正是因为「超时」与「用户改主意」是两回事。
          this.#pending.delete(id);
          SidecarClient.#settle(
            entry,
            new SidecarError("SIDECAR_TIMEOUT", `${method} timed out after ${timeoutMs}ms`),
          );
          void this.#teardown(`${method} timed out after ${timeoutMs}ms`, "SIDECAR_TIMEOUT");
        }, timeoutMs);
      }

      if (signal !== undefined) {
        const onAbort = (): void => {
          failRequest("SIDECAR_ABORTED", `${method} was aborted`);
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

  /**
   * 停掉 sidecar：先给一次优雅收场的机会，等不到再强杀。
   *
   * 优雅路径向 stdin 写一帧 ``shutdown``：bridge 先应答、再等在途请求收尾、然后显式
   * 关掉全部会话 —— 浏览器是独立进程，不显式关就会活过 sidecar 本身，全靠「进程树随
   * 父进程消亡」兜底是拿不到确定的。宽限期内没退（进程卡死、管道已断）才走 terminate。
   * 崩溃路径的 #teardown 不走这套：出错时进程多半已经没救，快速击杀优先。
   */
  public async dispose(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    const child = this.#handle;
    if (child?.stdin !== undefined) {
      try {
        child.stdin.write(
          `${encodeFrame({ id: DISPOSE_FRAME_ID, method: "shutdown", params: {} })}\n`,
        );
      } catch {
        // 管道已断（进程刚死）：写不进去就算了，下面的等待会立刻见分晓。
      }
      // done 对「正常退出」与「被信号杀死」都 resolve，reject 只留给 spawn 失败 ——
      // 两边都按「进程没了」处理，退出形态由调用方（测试）另行断言。
      const exited = child.done.then(
        () => true,
        () => true,
      );
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, this.#options.graceMs);
      });
      const finished = await Promise.race([exited, grace]);
      clearTimeout(timer);
      if (finished) {
        // 进程自己退了：补齐与 #teardown 相同的簿记，但不再对已死的进程 terminate。
        this.#stopPump?.();
        this.#stopPump = undefined;
        this.#handle = undefined;
        this.#capabilities = undefined;
        this.#starting = undefined;
        this.#rejectAll(new SidecarError("SIDECAR_CLOSED", "client disposed"));
        return;
      }
    }
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
