// 入口 cli-main.ts 的进程级契约：退出码一定落到 `process.exitCode`，失败一定是
// `command failed: …` 加退 1 —— 而不是一段 Node 顶层未捕获异常的堆栈。
//
// 为什么只能 spawn 子进程：这两条都是**进程**层面的行为（`process.exitCode`、未捕获异常的
// 默认退出形态）。从 .ts 直接 import 只能看到「函数返回了几」，看不到「进程最后以什么码退出」，
// 而后者正是这个文件存在的理由。`bin/dsh-scrapling.mjs` 那条安装态由 test/install-probe.mjs
// 走打包路径覆盖，这里覆盖的是源码入口本身。
//
// 两条失败路径要分开看：`runCli` 自己那个 try 里的失败由 `lib/cli.ts` 的 `reportFailure`
// 报出（走 `deps.log` → stdout）；本文件的 catch 兜的是**进 try 之前**的同步步骤
// （`withDefaults` 里的 `defaultDataDir()`、`parseArgs`）。本套件能稳定造出来的是前者；
// 后者只在 `os.homedir()` 之类的宿主调用抛错时才走到，无法在测试里可靠复现，所以这里
// 对它只要求「报错形态与那句话一致」，不假装跑到了那条分支。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { afterAll, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const ENTRY = path.join(REPO, "cli-main.ts");
const created: string[] = [];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-cli-main-"));
  created.push(dir);
  return dir;
}

/** 真起一个子进程跑入口，回执把 stdout / stderr / 退出码分开带回来。 */
async function runEntry(
  args: readonly string[],
  nodeArgs: readonly string[] = [],
): Promise<RunResult> {
  const child = spawn(process.execPath, [...nodeArgs, ENTRY, ...args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { status: code ?? 1, stdout, stderr };
}

describe("cli-main 入口", () => {
  afterAll(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("认不出的命令打用法并退 2，退出码真落在进程上", async () => {
    const result = await runEntry([]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("用法：dsh-scrapling setup");
    // 用法行走 stdout：解析失败不是「异常」，不该被塞进 stderr。
    expect(result.stderr).toBe("");
  });

  it("状态查询成功时退出码是 0，且 stdout 是一份可解析的 JSON", async () => {
    const absent = path.join(tempDir(), "absent");
    const result = await runEntry(["setup", "--status", "--profile", absent]);
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toBeTypeOf("object");
  });

  it("跑起来之后的失败被报成一行 command failed 加退 1，不带顶层堆栈", async () => {
    // 拿一个**普通文件**当 profile 目录：`readProfileSnapshot` 会先判它是不是目录。
    // 这条异常发生在 `runCli` 的 try 里，由 `reportFailure` 报出 —— 也正是本文件那条
    // catch 要兜成同一种形态的那句话。判目录放在源码里而不是靠「读子路径时报 ENOTDIR」：
    // Windows 对「文件\cordis.patch.yml」给的是 ENOENT，会被误当成「profile 里没有这份文件」。
    const notADirectory = path.join(tempDir(), "profile");
    writeFileSync(notADirectory, "");
    const result = await runEntry(["setup", "--status", "--profile", notADirectory]);
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("command failed: ");
    expect(output).toContain("command failed: Error:");
    // 一段未捕获异常会带 `at ` 的栈帧与 `Node.js v` 尾巴；兜住之后只有那一行。
    expect(output).not.toContain("Node.js v");
    expect(output.trimEnd().split("\n")).toHaveLength(1);
  });

  it("进 runCli 的 try 之前就抛的错同样被兜成一行 command failed 加退 1", async () => {
    // 这条才是 cli-main.ts 那条 catch 真正兜的分支：`withDefaults()` 与 `parseArgs()`
    // 都在 `runCli` 的 try 之外，而 `withDefaults` 里的 `defaultDataDir()` 会调
    // `os.homedir()`。用一个 --import 预载把 homedir 换成抛错函数，就能在**不改产品代码**
    // 的前提下稳定走到那条路 —— 否则它只能等宿主环境真的缺 HOME 才现形。
    const preload = path.join(tempDir(), "break-homedir.mjs");
    writeFileSync(
      preload,
      [
        'import os from "node:os";',
        "os.homedir = () => {",
        '  throw new Error("homedir unavailable (preload)");',
        "};",
        "",
      ].join("\n"),
    );
    // Windows 上绝对路径不能直接当 ESM 说明符（`C:` 会被当成协议），必须走 file URL。
    const result = await runEntry(
      ["setup", "--status"],
      [`--import=${pathToFileURL(preload).href}`],
    );
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("command failed: Error: homedir unavailable (preload)");
    expect(output).not.toContain("Node.js v");
    expect(output.trimEnd().split("\n")).toHaveLength(1);
  });
});
