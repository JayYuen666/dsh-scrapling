// dsh-scrapling/test/sidecar.test.ts —— sidecar 客户端。
//
// 两组用例：纯本地的假 runtime —— 覆盖协议错误、握手失败、超时、取消、销毁这些不该依赖
// 真实进程的路径，且跑得快、失败定位准；以及真进程 —— 用 node:child_process 顶替
// ctx.subprocess，真的把 py/bridge.py 拉起来，验证两端的协议真的对得上。浏览器与
// Scrapling 不在（安装与否由用户决定），所以只断言握手能力与不依赖浏览器的方法。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Readable, Writable } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSidecar,
  PROTOCOL_VERSION,
  SidecarClient,
  parseCapabilities,
} from "../lib/sidecar.ts";
import type { SidecarOptions } from "../lib/sidecar.ts";
import { asText, SidecarError } from "../lib/sidecar-error.ts";
import { LOCAL_PYTHON } from "./python-bin.ts";

/**
 * 空的流钩子。Node 的 Readable.read 必须返回 void，写成箭头函数返回 undefined 会被
 * no-useless-undefined 判掉 —— 那条规则在这里是对的，签名确实要 void。
 */
function noop(): void {
  // 故意什么都不做。
}

const REPO = path.resolve(import.meta.dirname, "..");
const BRIDGE = path.join(REPO, "py", "bridge.py");

/** 一个假的子进程句柄，形状对齐 SubprocessHandle 的用到部分。 */
interface FakeHandle {
  stdin: Writable | undefined;
  stdout: Readable | undefined;
  stderr: Readable;
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  terminate: () => void;
  waitForExit: () => Promise<boolean>;
}

const readyFrame = (): Record<string, unknown> => ({
  event: "ready",
  protocol: PROTOCOL_VERSION,
  capabilities: { scrapling: true, static: true, extract: true, browser: false },
});

/** 假 runtime 的可调项。 */
interface FakeBehaviour {
  /** 握手帧；null 表示不发握手。 */
  ready?: Record<string, unknown> | null;
  /** 每收到一个 id，回什么帧。 */
  reply?: (id: string, method: string) => Record<string, unknown> | null;
  /** 每收到一个 id，额外往 stdout 推的原始行（用来喂坏帧与无 id 帧）。 */
  rawReply?: (id: string) => string[] | undefined;
  /** 每收到一帧就报一次，用于断言真正发往子进程的载荷。 */
  onFrame?: (frame: { id: string; method: string; params?: Record<string, unknown> }) => void;
  /** spawn 时不给管道，模拟 provider 配错。 */
  noStdio?: boolean;
  /** waitForExit 是否抛错，模拟终止失败。 */
  failExit?: boolean;
  /** 让 done 以 reject 落地，模拟进程异常退出。 */
  crashOnExit?: boolean;
  /** 在 spawn 之前卡住一段时间，用来把 dispose 挤进启动途中那个窗口。 */
  spawnDelayMs?: number;
  /**
   * 这一代的 `done` 等这一位兑现之后才落地。用来把「旧代退出」显式排到测试观察到
   * 新一代已经拉起来之后 —— 那正是旧代事件误拆新进程的时序，靠毫秒猜不稳。
   */
  exitGate?: Promise<unknown>;
  /** `waitForExit` 等这一位兑现才返回，把新一代的 spawn 挤进旧代拆除的窗口里。 */
  reapGate?: Promise<unknown>;
}

/** 每条用例记录「拉起过几代进程、最新那一代是哪枚 handle」的那只袋子。 */
interface SpawnedHandle {
  count: number;
  last?: FakeHandle;
}

const fakeCtx = (behaviour: FakeBehaviour, spawned: SpawnedHandle): unknown => ({
  subprocess: {
    resolveExecutable: async (command: string): Promise<string> => {
      if (behaviour.spawnDelayMs !== undefined) {
        await delay(behaviour.spawnDelayMs);
      }
      return command;
    },
    spawn: (): FakeHandle => {
      spawned.count += 1;
      const stdout = new Readable({ read: noop });
      const stderr = new Readable({ read: noop });
      // 终止后再 push 会抛 ERR_STREAM_PUSH_AFTER_EOF；队列里的微任务可能晚于 terminate
      // 落地，所以这里统一挡一道。
      let closed = false;
      const push = (line: string): void => {
        if (!closed) {
          stdout.push(line);
        }
      };
      // 握手帧在 **spawn 之后立刻**发出，而不是等第一次写 —— 对端也是这么做的，
      // 而且 ensureStarted() 这一路本来就不会写任何东西。
      const ready = behaviour.ready === undefined ? readyFrame() : behaviour.ready;
      if (ready !== null) {
        queueMicrotask(() => {
          push(`${JSON.stringify(ready)}\n`);
        });
      }
      const stdin = new Writable({
        write: (chunk, _encoding, done) => {
          done();
          try {
            const frame = JSON.parse(String(chunk).trim()) as {
              id: string;
              method: string;
              params?: Record<string, unknown>;
            };
            behaviour.onFrame?.(frame);
            for (const raw of behaviour.rawReply?.(frame.id) ?? []) {
              queueMicrotask(() => {
                push(raw);
              });
            }
            const answer = behaviour.reply?.(frame.id, frame.method);
            if (answer !== undefined && answer !== null) {
              queueMicrotask(() => {
                push(`${JSON.stringify(answer)}\n`);
              });
            }
          } catch {
            // 故意发坏帧的用例不处理。
          }
        },
      });
      const handle: FakeHandle = {
        stdin: behaviour.noStdio === true ? undefined : stdin,
        stdout: behaviour.noStdio === true ? undefined : stdout,
        stderr,
        // once() 是官方的事件转 promise 工具；这里再用 async 包一层是因为这个 promise
        // 存进句柄而不是当场 await，.then 链会被 prefer-await-to-then 判掉。
        done: (async (): Promise<{ exitCode: number; signal: null }> => {
          await once(stdout, "end");
          if (behaviour.exitGate !== undefined) {
            await behaviour.exitGate;
          }
          if (behaviour.crashOnExit === true) {
            throw new Error("sidecar died");
          }
          return { exitCode: 0, signal: null };
        })(),
        terminate: (): void => {
          if (!closed) {
            closed = true;
            stdout.push(null);
          }
        },
        waitForExit: async (): Promise<boolean> => {
          if (behaviour.reapGate !== undefined) {
            await behaviour.reapGate;
          }
          if (behaviour.failExit === true) {
            throw new Error("cannot reap");
          }
          return true;
        },
      };
      spawned.last = handle;
      return handle;
    },
  },
});

const okReply = (id: string): Record<string, unknown> => ({ id, ok: true, result: { pong: true } });

/** 闸门用例里反复出现的两个 URL，提出来免得 sonarjs 当重复字面量报。 */
const PUBLIC_URL = "http://93.184.216.34";
const NORMALIZED_URL = "http://93.184.216.34/normalized";
const PRIVATE_SITEMAP = "http://127.0.0.1/sitemap.xml";
const RAW_SITEMAP = "http://93.184.216.34/sitemap.xml?raw=1";
const NORMALIZED_SITEMAP = "http://93.184.216.34/sitemap.xml";

function options(overrides: Partial<SidecarOptions> = {}): SidecarOptions {
  // 这两个默认值只服务于下面「真实 python 进程」那组用例（其余用例都显式传 80 / 5000
  // 这类小值做超时断言）。真实进程冷启动要 import scrapling 并探浏览器，安静机器上就要
  // 一秒以上；并发或机器一忙还能再涨数倍，贴着基配置的 testTimeout 给就会随缘超时。
  // 放宽这两个值不影响任何超时语义断言：那几条用例传的是自己的小值。
  return {
    pythonBin: "python3",
    bridgePath: BRIDGE,
    cwd: REPO,
    handshakeTimeoutMs: 15_000,
    requestTimeoutMs: 15_000,
    graceMs: 100,
    ...overrides,
  };
}

/** 本文件里活到当前的客户端；用例自己 dispose 之外的兜底靠这张表。 */
const live: SidecarClient[] = [];

/** 收尾那条用例读的帧记录：由「不 dispose」那条上的客户端在 afterEach 里填。 */
const drainedFrames: string[] = [];

/**
 * 建一个客户端并登记进 `live`。
 *
 * 用例结尾那句 `await client.dispose()` 只在自己没抛错时才跑到：断言一红，假 handle、
 * 计时器与（那组真进程用例的）Python 子进程就留给后面的用例和 CI 的进程树。登记之后由
 * 下面的 `afterEach` 兜住。`dispose()` 自己有 `#stopped` 判重，两处都调没有副作用，
 * 所以用例内那句照旧保留 —— 有几条断言的就是「调完之后再调仍然安静」。
 *
 * @param runtime - 交给客户端的 runtime 上下文（这里是假 ctx 或真 ctx）
 * @param config - 客户端配置
 * @returns 已登记的客户端
 */
function makeClient(runtime: Context, config: SidecarOptions): SidecarClient {
  const client = new SidecarClient(runtime, config);
  live.push(client);
  return client;
}

/** 把上一条用例遗留的客户端收干净：断言抛错时，用例自己那句 dispose 不会跑到。 */
async function drainLive(): Promise<void> {
  await Promise.all(live.splice(0).map((client) => client.dispose()));
}

describe("asText", () => {
  it("非空白字符串原样返回；空白串算取不到，落兜底", () => {
    expect(asText("boom", "fallback")).toBe("boom");
    expect(asText("  spaced  ", "fallback")).toBe("  spaced  ");
    expect(asText("", "fallback")).toBe("fallback");
    expect(asText("   ", "fallback")).toBe("fallback");
  });

  it("原始类型保留原文，对象与缺失落兜底", () => {
    expect(asText(42, "fallback")).toBe("42");
    expect(asText(true, "fallback")).toBe("true");
    expect(asText(1n, "fallback")).toBe("1");
    expect(asText({ message: "m" }, "fallback")).toBe("fallback");
    expect(asText(undefined, "fallback")).toBe("fallback");
  });
});

describe("错误类的参数位（SidecarError）", () => {
  it("只带 details 时不必给 cause 占位，两位也不会互相吞掉", () => {
    // `ErrorOptions` 只有一个可选成员，`Record<string, unknown>` 赋得进去：两位一旦记反，
    // 编译器不报错，details 会被当成 cause 静默吞掉。所以签名把 details 排在前，这里钉住。
    const error = new SidecarError("ACTION_FAILED", "动作失败", { index: 2 });
    expect(error.details).toStrictEqual({ index: 2 });
    expect(error.cause).toBeUndefined();
    const withCause = new SidecarError("ACTION_FAILED", "动作失败", { index: 3 }, { cause: "raw" });
    expect(withCause.details).toStrictEqual({ index: 3 });
    expect(withCause.cause).toBe("raw");
  });
});

describe("parseCapabilities", () => {
  it("只认真布尔，缺字段与非对象都降级成不可用", () => {
    expect(parseCapabilities({ scrapling: true, static: "yes", browser: 1 })).toStrictEqual({
      scrapling: true,
      static: false,
      extract: false,
      browser: false,
      writeMethods: false,
    });
  });

  it("非对象给全不可用而不是抛", () => {
    expect(parseCapabilities("nope").scrapling).toBe(false);
    expect(parseCapabilities(null).scrapling).toBe(false);
  });

  it("版本号只在是字符串时带上", () => {
    expect(parseCapabilities({ version: "0.5" }).version).toBe("0.5");
    expect(parseCapabilities({ version: 15 }).version).toBeUndefined();
  });

  it("能力报告的 websocketGuard 只在真布尔时带上，缺字段与非布尔都不带这一位", () => {
    expect(parseCapabilities({ websocketGuard: true }).websocketGuard).toBe(true);
    expect(parseCapabilities({ websocketGuard: false }).websocketGuard).toBe(false);
    expect(parseCapabilities({ websocketGuard: "yes" }).websocketGuard).toBeUndefined();
    expect(parseCapabilities({}).websocketGuard).toBeUndefined();
  });

  it("写方法与出口代理如实上报（代理形状不对就不带这一项）", () => {
    expect(
      parseCapabilities({
        scrapling: true,
        writeMethods: true,
        proxy: { configured: true, source: "settings", server: "http://127.0.0.1:7890" },
      }),
    ).toStrictEqual({
      scrapling: true,
      static: false,
      extract: false,
      browser: false,
      writeMethods: true,
      proxy: { configured: true, source: "settings", server: "http://127.0.0.1:7890" },
    });
    const malformed: unknown[] = [
      undefined,
      "nope",
      { configured: "yes", source: "settings", server: "x" },
      { configured: true, source: 7, server: "x" },
      { configured: true, source: "settings" },
    ];
    for (const proxy of malformed) {
      expect(parseCapabilities({ proxy }).proxy).toBeUndefined();
    }
  });
});

describe("sidecar client 与假 runtime", () => {
  afterEach(drainLive);

  it("握手后拿到能力，并把请求结果原样返回", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    const caps = await client.ensureStarted();
    expect(caps.scrapling).toBe(true);
    expect(client.alive).toBe(true);
    expect(spawned.count).toBe(1);
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("闸门交回归一串时，发往子进程的是归一串而不是入参", async () => {
    const sent: (string | undefined)[] = [];
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: okReply,
          onFrame: (frame) => {
            sent.push(frame.params?.["url"] as string | undefined);
          },
        },
        spawned,
      ) as never,
      options({ urlGate: async () => NORMALIZED_URL }),
    );
    await client.ensureStarted();
    const params = { url: PUBLIC_URL, extra: 1 };
    await client.call("fetch", params);
    expect(sent).toStrictEqual([NORMALIZED_URL]);
    // 调用方可能复用同一个 params 对象发多次，就地改会把上一次的归一结果带进下一次。
    expect(params).toStrictEqual({ url: PUBLIC_URL, extra: 1 });
    await client.dispose();
  });

  it("闸门交回与入参相同的串时沿用原串", async () => {
    const sent: (string | undefined)[] = [];
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: okReply,
          onFrame: (frame) => {
            sent.push(frame.params?.["url"] as string | undefined);
          },
        },
        spawned,
      ) as never,
      // 原样交回是自定义闸门最常见的写法：判过就放行，不做归一化。
      options({ urlGate: async (url: string): Promise<string | undefined> => url }),
    );
    await client.ensureStarted();
    await client.call("fetch", { url: PUBLIC_URL });
    expect(sent).toStrictEqual([PUBLIC_URL]);
    await client.dispose();
  });

  it("crawl 的 sitemapUrl 与 feedUrl 同样过闸门，判否就不写管道", async () => {
    const seen: string[] = [];
    const sent: (Record<string, unknown> | undefined)[] = [];
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: okReply,
          onFrame: (frame) => {
            sent.push(frame.params);
          },
        },
        spawned,
      ) as never,
      options({
        urlGate: async (url: string): Promise<string> => {
          seen.push(url);
          if (url === PRIVATE_SITEMAP) {
            throw new SidecarError("URL_BLOCKED", `${url}: refused by the host URL gate`);
          }
          return url;
        },
      }),
    );
    await client.ensureStarted();
    await expect(
      client.call("crawl.run", {
        url: PUBLIC_URL,
        sitemapUrl: PRIVATE_SITEMAP,
        feedUrl: NORMALIZED_SITEMAP,
      }),
    ).rejects.toMatchObject({ code: "URL_BLOCKED" });
    expect(seen).toStrictEqual([PUBLIC_URL, PRIVATE_SITEMAP]);
    expect(sent).toStrictEqual([]);
    await client.dispose();
  });

  it("select/locate/links 的 url 只当基准：不过 DNS/私网判定（J2）", async () => {
    // extract 的 html 是调用方自己给的，url 只是解析相对链接的基准；为它做一次主机
    // 解析会把一个纯本地操作变成需要联网、还会被私网拦截的操作（F2）。
    const seen: string[] = [];
    const sent: (Record<string, unknown> | undefined)[] = [];
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: okReply,
          onFrame: (frame) => {
            sent.push(frame.params);
          },
        },
        spawned,
      ) as never,
      options({
        urlGate: async (url: string): Promise<string> => {
          seen.push(url);
          if (url.startsWith("http://127.0.0.1")) {
            throw new SidecarError("URL_BLOCKED", `${url}: refused`);
          }
          return url;
        },
      }),
    );
    await client.ensureStarted();
    const params = { html: "<p>x</p>", url: "http://127.0.0.1:3080/local-only" };
    await client.call("select", params);
    await client.call("locate", params);
    await client.call("links", params);
    expect(seen).toStrictEqual([]);
    expect(sent[0]).toStrictEqual(params);
    expect(sent[1]).toStrictEqual(params);
    expect(sent[2]).toStrictEqual(params);
    // 非基准类的调用照旧过闸门：静态抓取真的要去打那个地址。
    await expect(client.call("fetch", { url: PRIVATE_SITEMAP })).rejects.toMatchObject({
      code: "URL_BLOCKED",
    });
    await client.dispose();
  });

  it("select 帧上若另带 sitemapUrl/feedUrl，这两个仍要过闸门（J2）", async () => {
    // 只有顶层 url 是「基准」；其它 URL 字段一律是 sidecar 会真去请求的目标。
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx({ reply: okReply }, spawned) as never,
      options({
        urlGate: async (url: string): Promise<string> => {
          if (url === PRIVATE_SITEMAP) {
            throw new SidecarError("URL_BLOCKED", `${url}: refused`);
          }
          return url;
        },
      }),
    );
    await client.ensureStarted();
    await expect(
      client.call("select", { html: "<p>x</p>", url: PUBLIC_URL, sitemapUrl: PRIVATE_SITEMAP }),
    ).rejects.toMatchObject({ code: "URL_BLOCKED" });
    await client.dispose();
  });

  it("闸门归一化嵌套 URL 后，发往子进程的是归一串而不是入参", async () => {
    const sent: (Record<string, unknown> | undefined)[] = [];
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: okReply,
          onFrame: (frame) => {
            sent.push(frame.params);
          },
        },
        spawned,
      ) as never,
      // 归一化按 URL 给：起始页原样，sitemap 换成归一串。判的和连的必须是同一串。
      options({
        urlGate: async (url: string): Promise<string> =>
          url === RAW_SITEMAP ? NORMALIZED_SITEMAP : url,
      }),
    );
    await client.ensureStarted();
    const params = { url: PUBLIC_URL, sitemapUrl: RAW_SITEMAP };
    await client.call("crawl.run", params);
    expect(sent).toStrictEqual([{ url: PUBLIC_URL, sitemapUrl: NORMALIZED_SITEMAP }]);
    expect(params).toStrictEqual({ url: PUBLIC_URL, sitemapUrl: RAW_SITEMAP });
    await client.dispose();
  });

  it("进程惰性拉起：只构造不发请求不会 spawn", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options());
    expect(spawned.count).toBe(0);
    expect(client.alive).toBe(false);
    await client.dispose();
  });

  it("重复 ensureStarted 只 spawn 一次", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    await client.ensureStarted();
    await client.ensureStarted();
    expect(spawned.count).toBe(1);
    await client.dispose();
  });

  it("对端回 ok:false 时把错误码、消息与 details 带出来", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: (id) => ({
            id,
            ok: false,
            error: {
              code: "ACTION_FAILED",
              message: "action 1 failed",
              details: { actionIndex: 1 },
            },
          }),
        },
        spawned,
      ) as never,
      options(),
    );
    const error = await client.call("fetch", {}).then(
      () => null,
      (error_: unknown) => error_,
    );
    expect(error).toMatchObject({
      code: "ACTION_FAILED",
      message: "action 1 failed",
      details: { actionIndex: 1 },
    });
    await client.dispose();
  });

  it("对端不回应时按超时拆掉进程", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options({ requestTimeoutMs: 80 }));
    await client.ensureStarted();
    await expect(client.call("ping")).rejects.toThrow(/timed out/u);
    expect(client.alive).toBe(false);
    await client.dispose();
  });

  it("信号已中止时不发请求", async () => {
    const sent: string[] = [];
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: okReply,
          onFrame: (frame) => {
            if (frame.method !== "capabilities") {
              sent.push(frame.method);
            }
          },
        },
        spawned,
      ) as never,
      options(),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      // timeoutMs: null 是「本次不设超时」那条路（爬虫那类量级不定的任务）—— settled
      // 因此拿不到 timer 要清的，#settle 里判 timer 的两个分支都得走到。
      client.call("crawl.run", {}, { signal: controller.signal, timeoutMs: null }),
    ).rejects.toThrow(/aborted/u);
    // 一帧都不能写进管道：中止时进程正在被拆掉，写进去既不报错也不触发 error，只是静默丢弃。
    expect(sent).toStrictEqual([]);
    // 「不在 #pending 里留下一条已结清的条目」在类外没有可读的条目（`#pending` 是私有字段，
    // 对外只有 capabilities 与 alive），所以这里判的是同一次中止之后**这只客户端**还能不能
    // 重新起一代并把请求结清 —— 半拆的簿记（handle 没清、启动卡在中间态）在这里露出来。
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    // 还是那一代在服务：中止发生在写出之前，请求根本没进管道，进程自然不该被换掉。
    // 换代会在这里露出来（半拆的簿记逼着重新拉起），所以这一位与上一句一起判「没留下
    // 中间态」，而不是另起一只客户端去读它自己那张表。
    expect(spawned.count).toBe(1);
    await client.dispose();
  });

  it("握手超时报错而不是永远挂着", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx({ ready: null, reply: okReply }, spawned) as never,
      options({ handshakeTimeoutMs: 80 }),
    );
    await expect(client.ensureStarted()).rejects.toThrow(/no ready frame/u);
    await client.dispose();
  });

  it("协议版本对不上时报错并拆掉进程", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        { ready: { event: "ready", protocol: 99, capabilities: {} }, reply: okReply },
        spawned,
      ) as never,
      options(),
    );
    await expect(client.ensureStarted()).rejects.toThrow(/protocol/u);
    await client.dispose();
  });

  it("对端送来不可解析的帧时跳过它，后续请求照常", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          rawReply: (id) => (id === "h1" ? ["not json at all\n"] : undefined),
          reply: okReply,
        },
        spawned,
      ) as never,
      options(),
    );
    await client.ensureStarted();
    // 坏帧被丢掉，同一请求的正常响应照样兑现 —— 这才是要断言的行为。
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("对端送来没有 id 的帧时被忽略，而不是误配给在途请求", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          rawReply: (id) => (id === "h1" ? ['{"ok":true,"result":null}\n'] : undefined),
          reply: okReply,
        },
        spawned,
      ) as never,
      options(),
    );
    await client.ensureStarted();
    // 无 id 的帧不能被当成 h1 的响应 —— 真正兑现的仍是随后那帧。
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("事件回调抛错只记一条日志，不拆掉常驻进程", async () => {
    // 回调是调用方代码。让它的异常沿 pumpFrames 的 onError 走，就会被当成 sidecar 崩溃
    // 而 #teardown —— 一个回调 bug 不该带走同一进程上所有在途请求。
    const spawned: SpawnedHandle = { count: 0 };
    const lines: string[] = [];
    const client = makeClient(
      fakeCtx(
        {
          rawReply: (id) => (id === "h1" ? ['{"event":"progress","done":1}\n'] : undefined),
          reply: okReply,
        },
        spawned,
      ) as never,
      {
        ...options(),
        log: (line) => {
          lines.push(line);
        },
        onEvent: () => {
          throw new Error("caller bug");
        },
      },
    );
    await client.ensureStarted();
    // 同一请求的响应帧排在那条事件帧之后：进程若被拆掉，这一条就等不到结果了。
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    expect(client.alive).toBe(true);
    expect(lines.some((line) => line.includes("onEvent handler threw"))).toBe(true);
    await client.dispose();
  });

  it("销毁一个从未启动的客户端不会抛", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options());
    await expect(client.dispose()).resolves.toBeUndefined();
    expect(spawned.count).toBe(0);
  });

  it("stderr 内容会被转发到日志回调", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const lines: string[] = [];
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, {
      ...options(),
      log: (line) => {
        lines.push(line);
      },
    });
    await client.ensureStarted();
    // 必须真往 stderr 推一行：原来这条只断言 lines.length > 0，而那一句是 dispose 的
    // teardown 日志撑起来的 —— 把整段转发删掉也照样绿。握手帧并不走日志（#log 只出现在
    // 坏帧、未知 id、回调抛错、teardown 与 stderr 这几处）。
    const before = lines.length;
    spawned.last?.stderr.push("bridge: 一行诊断\n\n");
    await delay(0);
    // 按行拆，空白行丢掉：尾部那个空行不该变成第二条。
    expect(lines.slice(before)).toStrictEqual(["[sidecar] bridge: 一行诊断"]);
    await client.dispose();
  });

  it("对端把 error 写成非对象时也报得出可读信息", async () => {
    const spawned = { count: 0 };
    const client = makeClient(
      fakeCtx(
        { reply: (id) => ({ id, ok: false, error: "plain string failure" }) },
        spawned,
      ) as never,
      options(),
    );
    await expect(client.call("fetch", {})).rejects.toThrow(/unknown sidecar error/u);
    await client.dispose();
  });

  it("capabilities 在握手前是 undefined，握手后是能力对象", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    expect(client.capabilities).toBeUndefined();
    await client.ensureStarted();
    expect(client.capabilities?.scrapling).toBe(true);
    await client.dispose();
  });

  it("响应里的未知 id 被忽略，不会误配给在途请求", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          rawReply: (id) =>
            id === "h1" ? ['{"id":"other","ok":true,"result":null}\n'] : undefined,
          reply: okReply,
        },
        spawned,
      ) as never,
      options(),
    );
    await client.ensureStarted();
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("并发请求按请求 id 各自兑现，载荷不会派给别的调用方", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    // 请求 id 由客户端自己发号（h1、h2…），调用方事先不知道；所以用出站帧建一张
    // 「id → 这一笔的 index」的表，回帧回显 id，最后按每个调用方拿到的 id 反查 index。
    const indexById = new Map<string, unknown>();
    const client = makeClient(
      fakeCtx(
        {
          reply: (id) => ({ id, ok: true, result: { echo: id } }),
          onFrame: (frame): void => {
            // 只登记这八笔：客户端在握手前后自己写的帧不算在内。
            if (frame.method === "ping") {
              indexById.set(frame.id, frame.params?.["index"]);
            }
          },
        },
        spawned,
      ) as never,
      options(),
    );
    const answers = await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => client.call("ping", { index })),
    );
    // 只断 `toHaveLength(8)` 时，把响应派给错误的在途请求也照样过；这里要求每个调用方
    // 反查回来的 index 正是自己那一个。id 若重复发号，`indexById.size` 先不够 8。
    expect(indexById.size).toBe(8);
    expect(answers.map((answer) => indexById.get((answer as { echo: string }).echo))).toStrictEqual(
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    await client.dispose();
  });

  it("调用途中才 abort 也能把请求作废", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options({ requestTimeoutMs: 5000 }));
    await client.ensureStarted();
    const controller = new AbortController();
    const pending = client.call("ping", {}, { signal: controller.signal });
    // 必须等 call 内部把监听挂上之后再 abort：call 开头先 await ensureStarted，
    // 太早 abort 会走「进入时已中止」那条分支，测不到监听器注册与摘除。
    await delay(20);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/u);
    await client.dispose();
  });

  it("不设超时（timeoutMs: null）的请求被取消时，结算不依赖定时器", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: (id: string, method: string) =>
            method === "slow" ? null : { id, ok: true, result: { pong: true } },
        },
        spawned,
      ) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    await client.ensureStarted();
    const controller = new AbortController();
    // 爬虫这类量级不定的任务会传 null（不设超时）；取消路径必须照样把这条请求结清。
    const pending = client.call("slow", {}, { signal: controller.signal, timeoutMs: null });
    await delay(20);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/u);
    await client.dispose();
  });

  it("不设超时的请求靠回帧结算：清定时器那一步按判空走完", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    await client.ensureStarted();
    // 爬虫那类调用就走这一档（lib/tools.ts 的 timeoutMs: null）：条目没有定时器，
    // #onFrame 里的 clearTimeout 分支是真实路径，不能被当成不可达。
    await expect(client.call("ping", {}, { timeoutMs: null })).resolves.toStrictEqual({
      pong: true,
    });
    expect(client.alive).toBe(true);
    await client.dispose();
  });

  it("日志回调抛错既不掀翻 stderr 监听，也不让进程被拆", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, {
      ...options(),
      log: (): never => {
        throw new Error("logger bug");
      },
    });
    await client.ensureStarted();
    // stderr 的 data 监听没有再包一层：#log 兜不住这一抛就是未捕获异常。
    spawned.last?.stderr.push("bridge: 一行诊断\n");
    await delay(0);
    // 回帧路径里也有 #log（坏帧与未知 id），一句打印的 bug 不该让进程收摊。
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    expect(client.alive).toBe(true);
    await client.dispose();
  });

  it("首个调用方在启动途中取消：不拆共享进程，后来的调用照常", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      // 把 spawn 前的解析拖慢，让取消落在「启动途中」而不是进入时已中止。
      fakeCtx(
        {
          spawnDelayMs: 30,
          reply: (id: string) => ({ id, ok: true, result: { pong: true } }),
        },
        spawned,
      ) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    const controller = new AbortController();
    const first = client.call("ping", {}, { signal: controller.signal });
    const second = client.call("ping");
    await delay(5);
    controller.abort();
    await expect(first).rejects.toThrow(/aborted/u);
    // 共享进程不能跟着首个调用方的取消一起死：否则并发抓取会被一个人的取消全带走。
    await expect(second).resolves.toStrictEqual({ pong: true });
    expect(spawned.count).toBe(1);
    expect(client.alive).toBe(true);
    await client.dispose();
  });

  it("取消一个请求不会拆掉常驻进程，也不会连累并行的其它请求", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      // slow 那个故意不回，等它被取消；ping 正常回，才看得出取消没有连累它。
      fakeCtx(
        {
          reply: (id: string, method: string) =>
            method === "slow" ? null : { id, ok: true, result: { pong: true } },
        },
        spawned,
      ) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    await client.ensureStarted();
    const controller = new AbortController();
    const cancelled = client.call("slow", {}, { signal: controller.signal });
    const kept = client.call("ping");
    await delay(20);
    controller.abort();
    await expect(cancelled).rejects.toThrow(/aborted/u);
    // 取消的语义是「这一次调用作废」，不是「整个进程报废」。抓取工具声明并发安全，
    // 取消一个本该只作废一个。
    expect(client.alive).toBe(true);
    // 被放弃的那个请求的迟到回帧按 id 配对，配不上就只是没人认领 —— 不该连累它之后
    // 那个正经请求。
    await expect(kept).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("超时仍回收进程 —— 超时的含义是对端可能已经不响应了", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      // 不回任何帧：请求会一直挂着直到超时。
      fakeCtx({ reply: () => null }, spawned) as never,
      options({ requestTimeoutMs: 60 }),
    );
    await client.ensureStarted();
    await expect(client.call("ping")).rejects.toThrow(/timed out/u);
    expect(client.alive).toBe(false);
    await client.dispose();
  });

  it("卸载正好落在启动途中时，刚出生的进程立刻被收掉，不留孤儿", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      // resolveExecutable 上卡 40ms，dispose 就在这 40ms 里跑完 —— 那时 #handle 还是空，
      // #teardown 拆不到任何东西。这条用例守的就是「别让这个进程活下来没人管」。
      fakeCtx({ spawnDelayMs: 40 }, spawned) as never,
      options(),
    );
    const starting = client.ensureStarted();
    await client.dispose();
    await expect(starting).rejects.toThrow(/disposed/u);
    expect(spawned.count).toBe(1);
  });

  it("provider 没给出管道时明确报不可用", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ noStdio: true }, spawned) as never, options());
    await expect(client.ensureStarted()).rejects.toThrow(/stdio/u);
    await client.dispose();
  });

  it("进程回收失败时只记日志，dispose 仍然正常返回", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const lines: string[] = [];
    const client = makeClient(fakeCtx({ failExit: true }, spawned) as never, {
      ...options(),
      log: (line) => {
        lines.push(line);
      },
    });
    await client.ensureStarted();
    await expect(client.dispose()).resolves.toBeUndefined();
    expect(lines.some((line) => line.includes("terminate failed"))).toBe(true);
  });

  it("握手中途 dispose 会让握手失败而不是永远挂着", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ ready: null }, spawned) as never, options());
    const starting = client.ensureStarted();
    // 等一拍，确保握手 waiter 已经挂上队列，再拆 —— 否则这条用例有时会退化成
    // 「dispose 先到、spawn 后到」，覆盖不到 waiter 被 reject 的那条路径。
    await delay(20);
    await client.dispose();
    await expect(starting).rejects.toThrow(/disposed|ready frame/u);
  });

  it("进程异常退出时按 crashed 拆掉并作废在途请求", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx({ crashOnExit: true }, spawned) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    await client.ensureStarted();
    const pending = client.call("ping");
    await delay(20);
    // 直接掐掉进程：结束 stdout 让 done 以 reject 落地，触发客户端的崩溃处理。
    spawned.last?.terminate();
    await expect(pending).rejects.toThrow(SidecarError);
    await client.dispose();
  });

  it("stdout 管道报错时按 crashed 拆掉进程，少一个 error 监听就会掀翻宿主", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options({ requestTimeoutMs: 5000 }));
    await client.ensureStarted();
    const pending = client.call("ping");
    await delay(20);
    // EventEmitter 的 'error' 没有监听者时会变成未捕获异常：这条监听就是防它的。
    spawned.last?.stdout?.emit("error", new Error("stdout pipe broke"));
    await expect(pending).rejects.toThrow(SidecarError);
    await client.dispose();
  });

  it("stderr 管道报错被接住并拆掉进程", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const logs: string[] = [];
    const client = makeClient(
      fakeCtx({}, spawned) as never,
      options({
        log: (line): void => {
          logs.push(line);
        },
      }),
    );
    await client.ensureStarted();
    // 之后再发一次请求是测不到这条路径的：拆除已经把这一代换掉，新请求会另起一代，
    // 它按自己的超时以 SIDECAR_TIMEOUT 落地，红绿都与 stderr 的 error 监听无关。
    // 所以判据问在被拆的那一代身上：状态位与那句拆除日志。
    spawned.last?.stderr.emit("error", new Error("stderr pipe broke"));
    await delay(20);
    expect(client.alive).toBe(false);
    expect(
      logs.some((line) => line.includes("stderr failed")),
      `拆除日志里没有 stderr failed：${logs.join("\n")}`,
    ).toBe(true);
    // 监听少一个的话，上面那句 emit 直接变成未捕获异常（EventEmitter 对无监听 'error' 的
    // 行为），这条用例连红带响。
    await client.dispose();
  });

  it("stdin 写端报错同样被接住", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options({ requestTimeoutMs: 5000 }));
    await client.ensureStarted();
    const pending = client.call("ping");
    await delay(20);
    spawned.last?.stdin?.emit("error", new Error("stdin pipe broke"));
    await expect(pending).rejects.toThrow(SidecarError);
    await client.dispose();
  });

  it("旧代退出事件晚到时不拆掉新一代进程，也不作废新一代的在途请求", async () => {
    // 时序：请求超时把第 1 代拆掉，而它的 done 停在测试手里的门上；拆除还卡在
    // waitForExit 上时，下一个请求把第 2 代拉起来。旧实现里那枚 done 回调无条件
    // #teardown，于是晚到的「旧代已退出」会把第 2 代连同在途请求一起带走。
    // 两道门都由测试兑现：窗口排在观察到的事件之后，不靠毫秒数猜。
    const spawned: SpawnedHandle = { count: 0 };
    const lines: string[] = [];
    const exit = Promise.withResolvers<boolean>();
    const reap = Promise.withResolvers<boolean>();
    const client = makeClient(
      fakeCtx(
        {
          reply: (id, method) => (method === "slow" ? null : okReply(id)),
          exitGate: exit.promise,
          reapGate: reap.promise,
        },
        spawned,
      ) as never,
      {
        ...options({ requestTimeoutMs: 30 }),
        log: (line) => {
          lines.push(line);
        },
      },
    );
    await client.ensureStarted();
    const first = spawned.last!;
    await expect(client.call("slow")).rejects.toThrow(/timed out/u);
    // 新一代就出生在旧代卡在 waitForExit 的那段窗口里。ping 自带宽裕预算：机器一忙时
    // 它也不该被上面那档 30ms 打掉（那打掉的是一条与本时序无关的超时）。
    await expect(client.call("ping", {}, { timeoutMs: 5000 })).resolves.toStrictEqual({
      pong: true,
    });
    expect(spawned.count).toBe(2);
    const second = spawned.last!;
    expect(second).not.toBe(first);
    // 现在才放第 1 代退出。`first.done` 上客户端的处理器比这里的 await 先挂上，所以
    // await 回来时那句 stale 判定已经写完日志（它同步跑在 #teardown 的入口）。
    exit.resolve(true);
    reap.resolve(true);
    await first.done;
    expect(client.alive).toBe(true);
    expect(
      lines.some((line) => line.includes("ignoring stale teardown")),
      `日志里没有 stale teardown：${lines.join("\n")}`,
    ).toBe(true);
    await expect(client.call("ping", {}, { timeoutMs: 5000 })).resolves.toStrictEqual({
      pong: true,
    });
    await client.dispose();
  });

  it("旧代管道错误晚到时不拆掉新一代进程", async () => {
    // 管道 error 回调同样来自某一个具体进程：旧代已经退出之后，它的 stderr 错误
    // 才落地，不该据此拆掉后来才拉起来的新一代。
    const spawned: SpawnedHandle = { count: 0 };
    const lines: string[] = [];
    const client = makeClient(
      fakeCtx(
        { reply: (id, method) => (method === "slow" ? null : okReply(id)) },
        spawned,
      ) as never,
      {
        ...options({ requestTimeoutMs: 20 }),
        log: (line) => {
          lines.push(line);
        },
      },
    );
    await client.ensureStarted();
    const first = spawned.last!;
    await expect(client.call("slow")).rejects.toThrow(/timed out/u);
    // 超时处理器在作废请求之后就地清簿记（`#clearState` 跑在它自己任何 await 之前），
    // 所以这里不必等：下一次调用出生的必然是新一代。
    await expect(client.call("ping", {}, { timeoutMs: 5000 })).resolves.toStrictEqual({
      pong: true,
    });
    expect(spawned.count).toBe(2);
    first.stderr.emit("error", new Error("old stderr broke"));
    // 这条也不用等窗口：error 回调里的 #teardown 进门先判 origin，stale 那一句同步写出。
    expect(
      lines.some((line) => line.includes("ignoring stale teardown")),
      `日志里没有 stale teardown：${lines.join("\n")}`,
    ).toBe(true);
    expect(client.alive).toBe(true);
    await expect(client.call("ping", {}, { timeoutMs: 5000 })).resolves.toStrictEqual({
      pong: true,
    });
    await client.dispose();
  });

  it("写管道已销毁时主动拆进程，并结清在途请求", async () => {
    // 已销毁的 Writable 上 write 会同步抛 ERR_STREAM_DESTROYED。这里测的是那之前的一道
    // 判据：先看 destroyed，就地拆进程 —— 在途条目都等不到回帧，只能自己回收。
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options());
    await client.ensureStarted();
    const gone = new Writable({
      write: (_chunk, _encoding, done) => {
        done();
      },
    });
    gone.destroy();
    Object.assign(spawned.last!, { stdin: gone });
    await expect(client.call("ping")).rejects.toThrow(/stdin is gone/u);
    expect(client.alive).toBe(false);
    await client.dispose();
  });

  it("写管道同步抛错时同样收场，不把错误抛给调用方", async () => {
    // write 在管道刚断的那一瞬间会同步抛 EPIPE。让它冒出去的话，一次抓取的失败会变成
    // 调用栈上的一行原生异常，而 pending 条目没人回收。
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options());
    await client.ensureStarted();
    Object.assign(spawned.last!, {
      stdin: {
        write: (): never => {
          throw new Error("EPIPE");
        },
      } as unknown as Writable,
    });
    await expect(client.call("ping")).rejects.toThrow(/EPIPE/u);
    expect(client.alive).toBe(false);
    await client.dispose();
  });

  it("销毁进程时在途请求被作废，而不是永远挂着", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({}, spawned) as never, options({ requestTimeoutMs: 5000 }));
    await client.ensureStarted();
    const pending = client.call("ping");
    // 等一拍让 call 真正把请求写出去并挂上 pending 表，再拆进程 ——
    // 不等这一拍的话，dispose 会先于 call 内部的 await 完成，测的就不是这条路径了。
    await delay(20);
    await client.dispose();
    await expect(pending).rejects.toThrow(/disposed/u);
  });

  it("createSidecar 工厂返回可用的客户端", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = createSidecar(fakeCtx({ reply: okReply }, spawned) as never, options());
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("销毁后再用会拒绝", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    await client.ensureStarted();
    await client.dispose();
    await expect(client.call("ping")).rejects.toThrow(SidecarError);
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  it("宽限期内进程没退就强杀，done 稍后以 reject 落地也不影响收场", async () => {
    // crashOnExit 让 done 在 stdout 结束后走 reject 分支：优雅路径里挂在 done 上的
    // 两个出口（resolve / reject）都必须执行到 —— 少一个就是没验证过的分支。
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ crashOnExit: true }, spawned) as never, options());
    await client.ensureStarted();
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  it("dispose 时写管道同步抛错（EPIPE）也走完收场", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    await client.ensureStarted();
    // 管道刚断的瞬间写帧会同步抛：dispose 必须吞掉它继续走等待/强杀，而不是把
    // 卸载流程本身炸掉。
    Object.assign(spawned.last!, {
      stdin: {
        write: (): void => {
          throw new Error("EPIPE");
        },
      } as unknown as Writable,
    });
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  it("用例不 dispose 的客户端由 afterEach 收干净", async () => {
    const spawned: SpawnedHandle = { count: 0 };
    const client = makeClient(
      fakeCtx(
        {
          reply: okReply,
          onFrame: (frame): void => {
            drainedFrames.push(frame.method);
          },
        },
        spawned,
      ) as never,
      options(),
    );
    await client.ensureStarted();
    expect(spawned.count).toBe(1);
    // 刻意不调 `client.dispose()` —— 收尾交给 afterEach，下一条用例读那份帧记录。
  });

  it("上一条遗留的客户端在收尾时收到了 shutdown 帧", () => {
    // 这条断言读的是上一条之后的记录：没有 afterEach 那次 dispose，这一位就是空表。
    expect(drainedFrames).toContain("shutdown");
  });
});

/** 用 node:child_process 顶替 ctx.subprocess，真的把 Python 拉起来。 */
const realCtx = {
  subprocess: {
    resolveExecutable: async (command: string): Promise<string> => command,
    spawn: (spec: {
      argv: string[];
      cwd: string;
      stdio: { stdin: string; stdout: string; stderr: string };
      env?: Record<string, string>;
    }): FakeHandle => {
      const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let exited = false;
      const done = (async (): Promise<{ exitCode: number | null; signal: null }> => {
        const args = await once(child, "close");
        exited = true;
        return { exitCode: args[0] as number | null, signal: null };
      })();
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        terminate: (): void => {
          if (!exited) {
            child.kill("SIGTERM");
          }
        },
        waitForExit: async (): Promise<boolean> => {
          await done;
          return true;
        },
      };
    },
  },
};

describe("sidecar client 与真实 python 进程", () => {
  afterEach(drainLive);

  const available = existsSync(LOCAL_PYTHON) && existsSync(BRIDGE);

  // 这一组是 TS 侧与 py/bridge.py 的帧格式唯一真对接的地方。缺解释器或缺 bridge 文件时
  // 上面那些 `runIf` 在报告里显式记成 skipped（不是假通过），但「八条 skipped」与「一条
  // 都没跑」在一份绿报告里读起来一样 —— CI 上这组必须真跑到。CI 的 `gate` 作业把
  // sidecar 解释器排在门禁之前备好，所以这条不会在没有解释器的作业里误红。
  it.runIf(process.env["CI"] === "true")("在 CI 上这组真实进程用例不该被跳过", () => {
    expect(available, `LOCAL_PYTHON=${LOCAL_PYTHON}；BRIDGE=${BRIDGE}`).toBe(true);
  });

  it.runIf(available)("握手拿到的能力里 scrapling 为真", async () => {
    const client = makeClient(
      realCtx as never,
      options({ pythonBin: LOCAL_PYTHON, requestTimeoutMs: 30_000 }),
    );
    const caps = await client.ensureStarted();
    expect(caps.scrapling).toBe(true);
    await client.dispose();
  });

  it.runIf(available)("握手如实上报 WebSocket 握手是否被守卫覆盖", async () => {
    const client = makeClient(
      realCtx as never,
      options({ pythonBin: LOCAL_PYTHON, requestTimeoutMs: 30_000 }),
    );
    const caps = await client.ensureStarted();
    // 这里钉的是「有上报」而不是「报 true」：拦不拦得住由对端那套库有没有 route_web_socket
    // 决定，Python 侧的 run_inprocess_capabilities 拿 Page 类的真实值比它；缺这一位才说明
    // README 承诺的覆盖面报告又丢了。
    expect(
      caps.websocketGuard,
      `能力报告没带 WebSocket 覆盖面：${JSON.stringify(caps)}`,
    ).toBeTypeOf("boolean");
    await client.dispose();
  });

  it.runIf(available)("ping 往返", async () => {
    const client = makeClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it.runIf(available)("离线正文方法已从协议面下线（清洗只剩 to_payload 那一条口）", async () => {
    const client = makeClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    await expect(client.call("extract", { html: "<body><h1>你好</h1></body>" })).rejects.toThrow(
      /unknown method/u,
    );
    await client.dispose();
  });

  it.runIf(available)("结构化选择往返", async () => {
    const client = makeClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    const result = (await client.call("select", {
      html: "<ul><li>A</li><li>B</li></ul>",
      selector: "li",
    })) as { count: number; matches: { text: string }[] };
    expect(result.count).toBe(2);
    expect(result.matches.map((item) => item.text)).toStrictEqual(["A", "B"]);
    await client.dispose();
  });

  it.runIf(available)("未知方法回错而不是静默", async () => {
    const client = makeClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    await expect(client.call("nope")).rejects.toThrow(/unknown method/u);
    await client.dispose();
  });

  it.runIf(available)("八个并发请求经真实 bridge 都各自兑现", async () => {
    const client = makeClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    const answers = await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => client.call("ping", { index })),
    );
    // id 路由本身不在这条上判：bridge 的 ping 忽略入参（py/adapters.py 的方法表就是
    // `{"pong": True}`），八份载荷逐字相同，串不串台在这里读不出来。那条判据在假 runtime
    // 那一组，由回显请求 id 的用例钉住。
    expect(answers).toStrictEqual(Array.from({ length: 8 }, () => ({ pong: true })));
    await client.dispose();
  });

  it.runIf(available)("dispose 走优雅关闭：进程自己退干净而不是被杀", async () => {
    // 优雅路径发 shutdown 帧，bridge 应答、清会话、自己退出 —— exit code 0；
    // 强杀路径死于信号，exit code 是 null。断言的是前者。
    const outcomes: Promise<{ exitCode: number | null; signal: null }>[] = [];
    const ctx = {
      subprocess: {
        resolveExecutable: realCtx.subprocess.resolveExecutable,
        spawn: (spec: Parameters<typeof realCtx.subprocess.spawn>[0]): FakeHandle => {
          const handle = realCtx.subprocess.spawn(spec);
          outcomes.push(handle.done as Promise<{ exitCode: number | null; signal: null }>);
          return handle;
        },
      },
    };
    const client = makeClient(
      ctx as never,
      options({ pythonBin: LOCAL_PYTHON, requestTimeoutMs: 30_000, graceMs: 5000 }),
    );
    await client.ensureStarted();
    await client.dispose();
    const settled = await Promise.all(outcomes);
    expect(settled[0]?.exitCode).toBe(0);
  });
});
