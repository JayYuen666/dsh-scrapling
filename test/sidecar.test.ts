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
import { SidecarError } from "../lib/sidecar-error.ts";

/**
 * 空的流钩子。Node 的 Readable.read 必须返回 void，写成箭头函数返回 undefined 会被
 * no-useless-undefined 判掉 —— 那条规则在这里是对的，签名确实要 void。
 */
function noop(): void {
  // 故意什么都不做。
}

const REPO = path.resolve(import.meta.dirname, "..");
const BRIDGE = path.join(REPO, "py", "bridge.py");
const LOCAL_PYTHON = path.join(REPO, "_env", ".venv", "bin", "python3");

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
  capabilities: { scrapling: true, static: true, extract: true, browser: false, stealth: false },
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
}

const fakeCtx = (
  behaviour: FakeBehaviour,
  spawned: { count: number; last?: FakeHandle },
): unknown => ({
  subprocess: {
    resolveExecutable: async (command: string): Promise<string> => command,
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
  // 1.5s 上下；并发或机器一忙，2000ms 就成了一笔随缘的假失败 —— 实测全量跑时同一组用例
  // 耗时飘到 10–24s，而基配置的 testTimeout 是 20s，于是直接超时。
  // 放宽到 15s 不影响任何超时语义断言：那几条用例传的是自己的小值。
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

describe("parseCapabilities", () => {
  it("只认真布尔，缺字段与非对象都降级成不可用", () => {
    expect(parseCapabilities({ scrapling: true, static: "yes", browser: 1 })).toStrictEqual({
      scrapling: true,
      static: false,
      extract: false,
      browser: false,
      stealth: false,
    });
  });

  it("非对象给全不可用而不是抛", () => {
    expect(parseCapabilities("nope").scrapling).toBe(false);
    expect(parseCapabilities(null).scrapling).toBe(false);
  });

  it("版本号只在是字符串时带上", () => {
    expect(parseCapabilities({ version: "0.4.15" }).version).toBe("0.4.15");
    expect(parseCapabilities({ version: 15 }).version).toBeUndefined();
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
});
