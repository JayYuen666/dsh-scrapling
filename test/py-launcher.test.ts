// py-launcher.mjs —— 解释器解析与参数透传。
//
// 这一组用例同时钉住「三处解析对同一棵树答同一支」：启动器（独立实现）、host 的
// resolvePythonBin、测试侧的 LOCAL_PYTHON。任何一处单独改了 venv 布局而其余没跟上，
// 门禁跑的解释器就不是插件真拉起的那支。

import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { resolvePythonBin } from "../host.ts";
import { LOCAL_PYTHON } from "./python-bin.ts";

const LAUNCHER = path.resolve(import.meta.dirname, "..", "py-launcher.mjs");
const REPO = path.resolve(import.meta.dirname, "..");
const WINDOWS = process.platform === "win32";
const VENV_DIR = WINDOWS ? "Scripts" : "bin";
const VENV_EXE = WINDOWS ? "python.exe" : "python";
const PATH_PYTHON = WINDOWS ? "python" : "python3";
/** `--which` 那一行的前缀，启动器在 `whichLine` 里拼的是同一段话。 */
const WHICH_PREFIX = "[py] 解释器：";

const created: string[] = [];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-py-launcher-"));
  created.push(dir);
  return dir;
}

function venvRoot(): string {
  const root = tempDir();
  const bin = path.join(root, "_env", ".venv", VENV_DIR);
  mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, VENV_EXE);
  writeFileSync(exe, "");
  if (!WINDOWS) {
    chmodSync(exe, 0o755);
  }
  return root;
}

async function run(args: string[]): Promise<RunResult> {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
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
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  if (signal !== null) {
    // 归并成 `status = 1` 会把「启动器自己被杀」与「它按预期退了 1」画成同一个读数，
    // 而红话只能说出 1。这里直接抛，并把 stderr 带出来定位。注意这与下面那条「子进程被
    // 信号结束时按 128+信号号退」的用例无关：那一条里收到信号的是 Python 子进程，启动器
    // 自己带着映射后的 143 正常退出。
    throw new Error(`py-launcher 被信号 ${signal} 终止：\n${stderr.slice(-2000)}`);
  }
  return { status: code ?? 1, stdout, stderr };
}

describe("py-launcher", () => {
  afterAll(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("仓内 venv 存在时 --path 给绝对路径", async () => {
    const root = venvRoot();
    const result = await run(["--path", `--root=${root}`]);
    expect(result.stdout.trim()).toBe(path.join(root, "_env", ".venv", VENV_DIR, VENV_EXE));
  });

  it("没有 venv 时 --path 回落到 PATH 上的名字", async () => {
    const result = await run(["--path", `--root=${tempDir()}`]);
    expect(result.stdout.trim()).toBe(PATH_PYTHON);
  });

  it("--bin 只在 venv 可用时给目录", async () => {
    const root = venvRoot();
    const withVenv = await run(["--bin", `--root=${root}`]);
    expect(withVenv.stdout.trim()).toBe(path.join(root, "_env", ".venv", VENV_DIR));
    // 没有 venv 时不能给个空行：调用方会把它拼进 PATH 的空段（等于把当前目录塞进 PATH）。
    const withoutVenv = await run(["--bin", `--root=${tempDir()}`]);
    expect(withoutVenv.stdout).toBe("");
    expect(withoutVenv.status).not.toBe(0);
    expect(withoutVenv.stderr).toContain("--bin");
  });

  it("--which 与 --path 指向同一支", async () => {
    const root = venvRoot();
    const venvPath = path.join(root, "_env", ".venv", VENV_DIR, VENV_EXE);
    const [withVenv, asPath] = await Promise.all([
      run(["--which", `--root=${root}`]),
      run(["--path", `--root=${root}`]),
    ]);
    // 整行精确比对：`toContain` 下「同一行里既打出 venv 路径又打出 PATH 回落名」这种自相矛盾
    // 的回答也判绿，而那正是这条用例要排除的形状。
    expect(withVenv.stdout).toBe(`${WHICH_PREFIX}${venvPath}\n`);
    // 标题说的那件事：--which 报的那一支与 --path 交出去的那一支是同一个字符串。
    expect(withVenv.stdout.trim().slice(WHICH_PREFIX.length)).toBe(asPath.stdout.trim());
    const withoutVenv = await run(["--which", `--root=${tempDir()}`]);
    // 文案是「没有**可用的**」而不是「没有」：`usable` 把同名目录与无可执行位的文件也判成
    // 不可用，只说「没有」会让「venv 坏了」被读成「venv 不存在」。
    expect(withoutVenv.stdout).toBe(
      `${WHICH_PREFIX}PATH 上的 ${PATH_PYTHON}（没有可用的 _env/.venv，在伞根跑 pnpm py:setup）\n`,
    );
  });

  it("跑模式透传参数、环境与退出码", async () => {
    const root = tempDir();
    const probe = await run([
      `--root=${root}`,
      "--env=PY_LAUNCHER_PROBE=1",
      "-c",
      "import os,sys;sys.exit(0 if os.environ.get('PY_LAUNCHER_PROBE')=='1' else 3)",
    ]);
    expect(probe.status).toBe(0);
    const failing = await run([`--root=${root}`, "-c", "raise SystemExit(7)"]);
    expect(failing.status).toBe(7);
  });

  it("三处解析对同一棵树给出同一支", async () => {
    // 期望值由独立写死的布局常量拼出（`VENV_DIR` / `VENV_EXE`），不从被测函数派生。
    expect(LOCAL_PYTHON).toBe(path.join(REPO, "_env", ".venv", VENV_DIR, VENV_EXE));
    // 第一个实参是设置卡上的 `pythonBin`：空串表示「没表态」，才会接着看仓内 venv 与 PATH。
    // 这一档成立的前提是 `_env/.venv` 已建好且可执行，由 `test/global-setup.ts` 兜住：解释器
    // 不在位时整次运行点名拒掉，而不是让这条断言在干净检出上红成一句看不出成因的失败。
    expect(resolvePythonBin("", REPO)).toStrictEqual({ path: LOCAL_PYTHON, via: "_env/.venv" });
    const resolved = await run(["--path"]);
    expect(resolved.stdout.trim()).toBe(LOCAL_PYTHON);
  });

  it("venv 里同名的是目录时不算解释器", async () => {
    const root = tempDir();
    mkdirSync(path.join(root, "_env", ".venv", VENV_DIR, VENV_EXE), { recursive: true });
    const result = await run(["--path", `--root=${root}`]);
    expect(result.stdout.trim()).toBe(PATH_PYTHON);
  });

  it("--root 的空格形式与等号形式等价", async () => {
    const root = venvRoot();
    const result = await run(["--path", "--root", root]);
    expect(result.stdout.trim()).toBe(path.join(root, "_env", ".venv", VENV_DIR, VENV_EXE));
  });

  it("参数写错时退 2，而不是当成跑模式", async () => {
    const duplicate = await run(["--which", "--path"]);
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain("只接受一个模式");
    const emptyRoot = await run(["--which", "--root="]);
    expect(emptyRoot.status).toBe(2);
    expect(emptyRoot.stderr).toContain("--root=");
    const missingRoot = await run(["--which", "--root"]);
    expect(missingRoot.status).toBe(2);
    const reportWithArgs = await run(["--which", "extra"]);
    expect(reportWithArgs.status).toBe(2);
    expect(reportWithArgs.stderr).toContain("报告模式");
  });

  it.runIf(!WINDOWS)("子进程被信号结束时按 128+信号号退", async () => {
    const result = await run([
      `--root=${tempDir()}`,
      "-c",
      "import os,signal;os.kill(os.getpid(),signal.SIGTERM)",
    ]);
    expect(result.status).toBe(143);
  });

  it.runIf(!WINDOWS)("没有可执行位的 venv 解释器不算可用", async () => {
    const root = tempDir();
    const bin = path.join(root, "_env", ".venv", VENV_DIR);
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, VENV_EXE), "");
    const result = await run(["--path", `--root=${root}`]);
    expect(result.stdout.trim()).toBe(PATH_PYTHON);
  });

  it("-- 之后的内容整段交给解释器，不留在自己的参数里", async () => {
    // 文件头第 10 行承诺 `[-- python 参数...]`。实现若把 `--` 一起透传，python 会把
    // 它当成脚本路径并报 `can't open file '.../--'`；这里要的是 stdout 里那句 ok。
    const result = await run([`--root=${tempDir()}`, "--", "-c", "print('ok')"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("--env 的键以 - 开头时退 2，而不是把旗标吞成环境变量", async () => {
    // `--env --root=/tmp` 会被 splitEnv 读成「键 --root、值 /tmp」，于是本该是启动器旗标的
    // 那个 --root 被静默吞掉、当成环境变量送进子进程 —— 命令照样退 0，只是解析根没生效。
    const result = await run(["--env", "--root=/tmp", "-c", "print('swallowed')"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("不能以 - 开头");
    expect(result.stdout).toBe("");
  });

  it("--env 形状写错时只报一句，不叠第二句", async () => {
    // 两层各写一次 stderr 时同一处错会打两行（「要写成 KEY=VALUE」+「取值不合法」），
    // 而第二行给不出任何新信息。形状错与旗标误吞的出路不同，文案也不该混。
    const shape = await run(["--env=BOGUS"]);
    expect(shape.status).toBe(2);
    expect(shape.stderr.trimEnd().split("\n")).toStrictEqual([
      "--env 要写成 KEY=VALUE；现在给的是 BOGUS",
    ]);
  });

  it.runIf(!WINDOWS)("收到终止信号时转发给子进程，并按 128+n 退出", async () => {
    // 不带转发时启动器会被信号直接带走（`close` 里 signal 非空、退出码无从映射），
    // 而交互式终端靠进程组不会暴露这件事 —— 只有脚本化场景（CI 的 kill、timeout 命令）
    // 只打启动器这一个 pid 时才看得出来。
    const child = spawn(
      process.execPath,
      [LAUNCHER, `--root=${tempDir()}`, "-c", "import time; time.sleep(30)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await delay(500);
    child.kill("SIGTERM");
    const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
    expect(signal).toBeNull();
    expect(code).toBe(143);
  });
});
