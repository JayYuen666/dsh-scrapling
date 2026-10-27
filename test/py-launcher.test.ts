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
import { afterAll, describe, expect, it } from "vitest";
import { resolvePythonBin } from "../host.ts";
import { LOCAL_PYTHON } from "./python-bin.ts";

const LAUNCHER = path.resolve(import.meta.dirname, "..", "py-launcher.mjs");
const REPO = path.resolve(import.meta.dirname, "..");
const WINDOWS = process.platform === "win32";
const VENV_DIR = WINDOWS ? "Scripts" : "bin";
const VENV_EXE = WINDOWS ? "python.exe" : "python";
const PATH_PYTHON = WINDOWS ? "python" : "python3";

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
  const [code] = (await once(child, "close")) as [number | null];
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
    const withoutVenv = await run(["--bin", `--root=${tempDir()}`]);
    expect(withoutVenv.stdout).toBe("");
  });

  it("--which 与 --path 指向同一支", async () => {
    const root = venvRoot();
    const withVenv = await run(["--which", `--root=${root}`]);
    expect(withVenv.stdout).toContain(path.join(root, "_env", ".venv", VENV_DIR, VENV_EXE));
    const withoutVenv = await run(["--which", `--root=${tempDir()}`]);
    expect(withoutVenv.stdout).toContain(`PATH 上的 ${PATH_PYTHON}`);
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
    expect(LOCAL_PYTHON).toBe(path.join(REPO, "_env", ".venv", VENV_DIR, VENV_EXE));
    expect(resolvePythonBin("", REPO)).toStrictEqual({ path: LOCAL_PYTHON, via: "_env/.venv" });
    const resolved = await run(["--path"]);
    expect(resolved.stdout.trim()).toBe(LOCAL_PYTHON);
  });

  it.runIf(!WINDOWS)("没有可执行位的 venv 解释器不算可用", async () => {
    const root = tempDir();
    const bin = path.join(root, "_env", ".venv", VENV_DIR);
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, VENV_EXE), "");
    const result = await run(["--path", `--root=${root}`]);
    expect(result.stdout.trim()).toBe(PATH_PYTHON);
  });
});
