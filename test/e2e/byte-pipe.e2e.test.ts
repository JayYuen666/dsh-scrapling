// 端到端：真 bridge.py 进程上的**字节层**协议回路。test/sidecar.test.ts 的真进程组
// 走 SidecarClient（帧级）；这一层直接对 stdin/stdout 管道写字节，钉「FrameSplitter
// 与 bridge 的 readline 两侧对同一批字节同解」：半帧分多次写、CRLF 行尾、超长帧的
// BAD_FRAME 与进程存活、优雅关闭。需要仓内 venv（本机在位；CI 的 mac/win 格也装）。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const LOCAL_PYTHON =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "_env", ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, "_env", ".venv", "bin", "python");
const BRIDGE = path.join(REPO_ROOT, "py", "bridge.py");
const available = existsSync(LOCAL_PYTHON) && existsSync(BRIDGE);

interface Bridge {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  wait: Promise<number | null>;
  close: () => Promise<void>;
}

/** 起真 bridge，收帧按行（测试侧的参考实现：与 lib/jsonl.ts 同一套「按 \n 切」契约）。 */
async function startBridge(): Promise<Bridge> {
  const child = spawn(LOCAL_PYTHON, ["-u", "-I", BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
  let pending = "";
  const frames: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newlineAt = pending.indexOf("\n");
    while (newlineAt >= 0) {
      const line = pending.slice(0, newlineAt);
      pending = pending.slice(newlineAt + 1);
      if (line.trim().length > 0) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter === undefined) {
          frames.push(frame);
        } else {
          waiter(frame);
        }
      }
      newlineAt = pending.indexOf("\n");
    }
  });
  const close = (async (): Promise<number | null> => {
    const [code] = (await once(child, "close")) as [number | null];
    return code;
  })();
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    wait: close,
    close: async () => {
      child.kill("SIGTERM");
      await close;
    },
  };
}

describe("真 bridge.py 的字节层协议", () => {
  it("半帧分三次写 + CRLF 行尾：两侧同解，应答按 id 配对", async () => {
    if (!available) {
      return;
    }
    const child = spawn(LOCAL_PYTHON, ["-u", "-I", BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      let buffer = "";
      const responses = new Map<string, Record<string, unknown>>();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newlineAt = buffer.indexOf("\n");
        while (newlineAt >= 0) {
          const line = buffer.slice(0, newlineAt);
          buffer = buffer.slice(newlineAt + 1);
          if (line.trim().length > 0) {
            const frame = JSON.parse(line) as Record<string, unknown>;
            if (typeof frame["id"] === "string") {
              responses.set(frame["id"], frame);
            }
          }
          newlineAt = buffer.indexOf("\n");
        }
      });

      const request = `${JSON.stringify({ id: "h1", method: "ping", params: {} })}\n`;
      const half = Math.floor(request.length / 2);
      // 半帧两次写 + 尾巴第三次写，帧中段故意停一拍（对端分多次 write 的实况）。
      child.stdin.write(request.slice(0, half));
      await delay(30);
      child.stdin.write(request.slice(half, -1));
      await delay(30);
      // CRLF 行尾：bridge 的 readline 容忍尾随 \r（实测的「容忍」语义）。
      child.stdin.write(`${request.slice(-1)}\r`);
      await delay(30);
      child.stdin.write("\n");

      // ready 帧先到（无 id），随后 h1 应答。
      const deadline = Date.now() + 15_000;
      // 等帧轮询：事件排序在测试侧不保证，轮询是最简可靠形态（块级豁免只罩这一段）。
      /* oxlint-disable eslint/no-await-in-loop -- 等帧轮询 */
      while (!responses.has("h1") && Date.now() < deadline) {
        await delay(20);
      }
      /* oxlint-enable eslint/no-await-in-loop */
      const reply = responses.get("h1");
      assert.ok(reply !== undefined, "半帧 + CRLF 的请求没有等到应答");
      assert.equal(reply["ok"], true, JSON.stringify(reply));
    } finally {
      child.kill("SIGTERM");
    }
  }, 30_000);

  it("超长帧（>8MiB）回 BAD_FRAME 且进程不死：后续请求照常应答", async () => {
    if (!available) {
      return;
    }
    const child = spawn(LOCAL_PYTHON, ["-u", "-I", BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      let buffer = "";
      const responses = new Map<string, Record<string, unknown>>();
      const unowned: Record<string, unknown>[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newlineAt = buffer.indexOf("\n");
        while (newlineAt >= 0) {
          const line = buffer.slice(0, newlineAt);
          buffer = buffer.slice(newlineAt + 1);
          if (line.trim().length > 0) {
            const frame = JSON.parse(line) as Record<string, unknown>;
            // BAD_FRAME 的应答帧**无 id**（fail(None, …)）：单独收，不进 id 配对表。
            if (typeof frame["id"] === "string") {
              responses.set(frame["id"], frame);
            } else {
              unowned.push(frame);
            }
          }
          newlineAt = buffer.indexOf("\n");
        }
      });
      child.stdin.write(`${JSON.stringify({ id: "h0", method: "ping", params: {} })}\n`);
      // 先等 ready/h0 都到，再灌超长帧。
      await delay(800);
      child.stdin.write(`${"x".repeat(8 * 1024 * 1024 + 1)}\n`);
      await delay(800);
      child.stdin.write(`${JSON.stringify({ id: "h2", method: "ping", params: {} })}\n`);
      const deadline = Date.now() + 15_000;
      /* oxlint-disable eslint/no-await-in-loop -- 等帧轮询 */
      while (!responses.has("h2") && Date.now() < deadline) {
        await delay(20);
      }
      /* oxlint-enable eslint/no-await-in-loop */
      const badFrame = unowned.find((frame) => JSON.stringify(frame).includes("BAD_FRAME"));
      assert.ok(badFrame !== undefined, `超长帧没有回 BAD_FRAME：${String([...responses.keys()])}`);
      assert.equal(responses.get("h2")?.["ok"], true, "BAD_FRAME 之后进程死了（后续请求无应答）");
    } finally {
      child.kill("SIGTERM");
    }
  }, 30_000);

  it("shutdown 帧应答后退 0（优雅关闭）", async () => {
    if (!available) {
      return;
    }
    const bridge = await startBridge();
    bridge.stdin.write(`${JSON.stringify({ id: "bye", method: "shutdown", params: {} })}\n`);
    const exitCode = await bridge.wait;
    assert.equal(exitCode, 0, `shutdown 后退出码 ${String(exitCode)}`);
  }, 30_000);
});
