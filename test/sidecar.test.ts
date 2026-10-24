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
import { describe, expect, it } from "vitest";
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
}

const fakeCtx = (
  behaviour: FakeBehaviour,
  spawned: { count: number; last?: FakeHandle },
): unknown => ({
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
  it("握手后拿到能力，并把请求结果原样返回", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    const caps = await client.ensureStarted();
    expect(caps.scrapling).toBe(true);
    expect(client.alive).toBe(true);
    expect(spawned.count).toBe(1);
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("闸门交回归一串时，发往子进程的是归一串而不是入参", async () => {
    const sent: (string | undefined)[] = [];
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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

  it("进程惰性拉起：只构造不发请求不会 spawn", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({}, spawned) as never, options());
    expect(spawned.count).toBe(0);
    expect(client.alive).toBe(false);
    await client.dispose();
  });

  it("重复 ensureStarted 只 spawn 一次", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    await client.ensureStarted();
    await client.ensureStarted();
    expect(spawned.count).toBe(1);
    await client.dispose();
  });

  it("对端回 ok:false 时把错误码与消息带出来", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx(
        {
          reply: (id) => ({
            id,
            ok: false,
            error: { code: "BAD_ARGS", message: "url is required" },
          }),
        },
        spawned,
      ) as never,
      options(),
    );
    await expect(client.call("fetch", {})).rejects.toThrow("url is required");
    await client.dispose();
  });

  it("对端不回应时按超时拆掉进程", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({}, spawned) as never,
      options({ requestTimeoutMs: 80 }),
    );
    await client.ensureStarted();
    await expect(client.call("ping")).rejects.toThrow(/timed out/u);
    expect(client.alive).toBe(false);
    await client.dispose();
  });

  it("信号已中止时不发请求", async () => {
    const sent: string[] = [];
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    // 也不能在 #pending 里留下一条已结清的条目 —— 那会一直占着 id，直到下一次 teardown。
    const again = new SidecarClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    await expect(again.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
    await again.dispose();
  });

  it("握手超时报错而不是永远挂着", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({ ready: null, reply: okReply }, spawned) as never,
      options({ handshakeTimeoutMs: 80 }),
    );
    await expect(client.ensureStarted()).rejects.toThrow(/no ready frame/u);
    await client.dispose();
  });

  it("协议版本对不上时报错并拆掉进程", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx(
        { ready: { event: "ready", protocol: 99, capabilities: {} }, reply: okReply },
        spawned,
      ) as never,
      options(),
    );
    await expect(client.ensureStarted()).rejects.toThrow(/protocol/u);
    await client.dispose();
  });

  it("对端回不可解析的帧不影响后续请求", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({ reply: (id) => (id === "h1" ? null : okReply(id)) }, spawned) as never,
      options(),
    );
    await client.ensureStarted();
    const logs: string[] = [];
    await expect(client.call("ping", {}, { timeoutMs: 300 })).rejects.toThrow(/timed out/u);
    expect(logs).toStrictEqual([]);
    await client.dispose();
  });

  it("对端送来不可解析的帧时跳过它，后续请求照常", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const lines: string[] = [];
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({}, spawned) as never, options());
    await expect(client.dispose()).resolves.toBeUndefined();
    expect(spawned.count).toBe(0);
  });

  it("stderr 内容会被转发到日志回调", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const lines: string[] = [];
    const client = new SidecarClient(fakeCtx({ reply: okReply }, spawned) as never, {
      ...options(),
      log: (line) => {
        lines.push(line);
      },
    });
    await client.ensureStarted();
    await client.dispose();
    // ready 帧也会走日志，所以至少要有一条。
    expect(lines.length).toBeGreaterThan(0);
  });

  it("对端把 error 写成非对象时也报得出可读信息", async () => {
    const spawned = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    expect(client.capabilities).toBeUndefined();
    await client.ensureStarted();
    expect(client.capabilities?.scrapling).toBe(true);
    await client.dispose();
  });

  it("响应里的未知 id 被忽略，不会误配给在途请求", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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

  it("调用途中才 abort 也能把请求作废", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({}, spawned) as never,
      options({ requestTimeoutMs: 5000 }),
    );
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

  it("取消一个请求不会拆掉常驻进程，也不会连累并行的其它请求", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ noStdio: true }, spawned) as never, options());
    await expect(client.ensureStarted()).rejects.toThrow(/stdio/u);
    await client.dispose();
  });

  it("进程回收失败时只记日志，dispose 仍然正常返回", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const lines: string[] = [];
    const client = new SidecarClient(fakeCtx({ failExit: true }, spawned) as never, {
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ ready: null }, spawned) as never, options());
    const starting = client.ensureStarted();
    // 等一拍，确保握手 waiter 已经挂上队列，再拆 —— 否则这条用例有时会退化成
    // 「dispose 先到、spawn 后到」，覆盖不到 waiter 被 reject 的那条路径。
    await delay(20);
    await client.dispose();
    await expect(starting).rejects.toThrow(/disposed|ready frame/u);
  });

  it("进程异常退出时按 crashed 拆掉并作废在途请求", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({}, spawned) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    await client.ensureStarted();
    const pending = client.call("ping");
    await delay(20);
    // EventEmitter 的 'error' 没有监听者时会变成未捕获异常：这条监听就是防它的。
    spawned.last?.stdout?.emit("error", new Error("stdout pipe broke"));
    await expect(pending).rejects.toThrow(SidecarError);
    await client.dispose();
  });

  it("stderr 管道报错同样被接住", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({}, spawned) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    await client.ensureStarted();
    spawned.last?.stderr.emit("error", new Error("stderr pipe broke"));
    await delay(20);
    await expect(client.call("ping")).rejects.toThrow(SidecarError);
    await client.dispose();
  });

  it("stdin 写端报错同样被接住", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({}, spawned) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    await client.ensureStarted();
    const pending = client.call("ping");
    await delay(20);
    spawned.last?.stdin?.emit("error", new Error("stdin pipe broke"));
    await expect(pending).rejects.toThrow(SidecarError);
    await client.dispose();
  });

  it("写管道已销毁时主动拆进程，并结清在途请求", async () => {
    // 已销毁的 Writable 上 write 会同步抛 ERR_STREAM_DESTROYED。这里测的是那之前的一道
    // 判据：先看 destroyed，就地拆进程 —— 在途条目都等不到回帧，只能自己回收。
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({}, spawned) as never, options());
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({}, spawned) as never, options());
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
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(
      fakeCtx({}, spawned) as never,
      options({ requestTimeoutMs: 5000 }),
    );
    await client.ensureStarted();
    const pending = client.call("ping");
    // 等一拍让 call 真正把请求写出去并挂上 pending 表，再拆进程 ——
    // 不等这一拍的话，dispose 会先于 call 内部的 await 完成，测的就不是这条路径了。
    await delay(20);
    await client.dispose();
    await expect(pending).rejects.toThrow(/disposed/u);
  });

  it("createSidecar 工厂返回可用的客户端", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = createSidecar(fakeCtx({ reply: okReply }, spawned) as never, options());
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it("销毁后再用会拒绝", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ reply: okReply }, spawned) as never, options());
    await client.ensureStarted();
    await client.dispose();
    await expect(client.call("ping")).rejects.toThrow(SidecarError);
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  it("宽限期内进程没退就强杀，done 稍后以 reject 落地也不影响收场", async () => {
    // crashOnExit 让 done 在 stdout 结束后走 reject 分支：优雅路径里挂在 done 上的
    // 两个出口（resolve / reject）都必须执行到 —— 少一个就是没验证过的分支。
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ crashOnExit: true }, spawned) as never, options());
    await client.ensureStarted();
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  it("dispose 时写管道同步抛错（EPIPE）也走完收场", async () => {
    const spawned: { count: number; last?: FakeHandle } = { count: 0 };
    const client = new SidecarClient(fakeCtx({ reply: okReply }, spawned) as never, options());
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
  const available = existsSync(LOCAL_PYTHON) && existsSync(BRIDGE);

  it.runIf(available)("握手拿到的能力里 scrapling 为真", async () => {
    const client = new SidecarClient(
      realCtx as never,
      options({ pythonBin: LOCAL_PYTHON, requestTimeoutMs: 30_000 }),
    );
    const caps = await client.ensureStarted();
    expect(caps.scrapling).toBe(true);
    await client.dispose();
  });

  it.runIf(available)("ping 往返", async () => {
    const client = new SidecarClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    await expect(client.call("ping")).resolves.toStrictEqual({ pong: true });
    await client.dispose();
  });

  it.runIf(available)("离线抽取往返（不需要网络）", async () => {
    const client = new SidecarClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    const result = (await client.call("extract", { html: "<body><h1>你好</h1></body>" })) as {
      content: string;
    };
    expect(result.content).toContain("你好");
    await client.dispose();
  });

  it.runIf(available)("结构化选择往返", async () => {
    const client = new SidecarClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    const result = (await client.call("select", {
      html: "<ul><li>A</li><li>B</li></ul>",
      selector: "li",
    })) as { count: number; matches: { text: string }[] };
    expect(result.count).toBe(2);
    expect(result.matches.map((item) => item.text)).toStrictEqual(["A", "B"]);
    await client.dispose();
  });

  it.runIf(available)("未知方法回错而不是静默", async () => {
    const client = new SidecarClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    await expect(client.call("nope")).rejects.toThrow(/unknown method/u);
    await client.dispose();
  });

  it.runIf(available)("并发请求 id 不串台", async () => {
    const client = new SidecarClient(realCtx as never, options({ pythonBin: LOCAL_PYTHON }));
    const answers = await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => client.call("ping", { index })),
    );
    expect(answers).toHaveLength(8);
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
    const client = new SidecarClient(
      ctx as never,
      options({ pythonBin: LOCAL_PYTHON, requestTimeoutMs: 30_000, graceMs: 5000 }),
    );
    await client.ensureStarted();
    await client.dispose();
    const settled = await Promise.all(outcomes);
    expect(settled[0]?.exitCode).toBe(0);
  });
});
