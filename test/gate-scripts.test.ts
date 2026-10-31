// 门禁脚本 —— 符号链接调用仍要执行、import 时安静、纯函数按形状判红。
//
// 四个脚本都是 npm 脚本入口（py:which / face:py / deps:py / coverage:floor）。它们共同的
// 失败形态是「静默退 0」：主模块判据写成 process.argv[1] 与 import.meta.filename 字符串
// 比较时，经符号链接调用会让 main 根本不跑，Node 照样 exit 0，门禁以为自己量过了。

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const WINDOWS = process.platform === "win32";
const PY_DIR = path.join(REPO, "py");
const PY_LAUNCHER = "py-launcher.mjs";
const FACE_PY = "face-py.mjs";
const DEPS_CHECK = "deps-check.mjs";
const COVERAGE_FLOOR = "coverage-floor.mjs";
const MODULES = [PY_LAUNCHER, FACE_PY, DEPS_CHECK, COVERAGE_FLOOR];
const NEWLINE = String.fromCodePoint(10);

const created: string[] = [];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-gate-scripts-"));
  created.push(dir);
  return dir;
}

async function runNode(args: string[], cwd: string): Promise<RunResult> {
  const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * 在子进程里 import 目标模块再跑一段语句。
 *
 * 走子进程而不是从 .ts 直接 import：这些脚本是 .mjs，而本仓 tsconfig 没开 allowJs，
 * 直接 import 会 TS7016。子进程还顺带证了「被 import 时不跑 main」。
 *
 * @param file - 仓根下的模块文件名
 * @param body - 以 mod 为模块命名空间的一段语句
 * @returns 子进程回执
 */
async function evalModule(file: string, body: string): Promise<RunResult> {
  const url = pathToFileURL(path.join(REPO, file)).href;
  const code = ["const mod = await import(", JSON.stringify(url), ");", NEWLINE, body].join("");
  return runNode(["--input-type=module", "-e", code], tempDir());
}

function jsonBody(expression: string): string {
  return ["console.log(JSON.stringify(", expression, "));"].join("");
}

function outputOf(result: RunResult): string {
  return result.stdout + result.stderr;
}

describe("门禁脚本", () => {
  afterAll(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(!WINDOWS)("经符号链接调用时四个脚本仍然执行", async () => {
    const dir = tempDir();
    const cases = [
      { script: PY_LAUNCHER, args: ["--which"], marker: "[py]" },
      { script: FACE_PY, args: [], marker: "[face:py]" },
      { script: DEPS_CHECK, args: [], marker: "依赖检查解释器" },
      { script: COVERAGE_FLOOR, args: [], marker: "" },
    ];
    const entries = await Promise.all(
      cases.map(async (item) => {
        const link = path.join(dir, item.script);
        await symlink(path.join(REPO, item.script), link);
        return { item, result: await runNode([link, ...item.args], dir) };
      }),
    );
    for (const entry of entries) {
      const output = outputOf(entry.result);
      expect(output).not.toBe("");
      expect(output).toContain(entry.item.marker);
    }
  });

  it("import 时不跑 main", async () => {
    const results = await Promise.all(MODULES.map((file) => evalModule(file, "")));
    for (const result of results) {
      expect(result.status).toBe(0);
      expect(outputOf(result)).toBe("");
    }
  });

  it("coverage-floor 只认字面 py/*.py 条目", async () => {
    const body = [
      'const ok = mod.shippedFiles({ files: ["py/adapters.py", "README.md"] });',
      'const notArray = mod.shippedFiles({ files: "py/adapters.py" });',
      'const glob = mod.shippedFiles({ files: ["py/*.py"] });',
      "const noFloor = mod.floorFromScripts({ scripts: {} });",
      'const floor = mod.floorFromScripts({ scripts: { "coverage:floor": "x --fail-under=75 && node coverage-floor.mjs" } });',
      jsonBody("{ ok, notArray, glob, noFloor, floor }"),
    ].join(NEWLINE);
    const result = await evalModule(COVERAGE_FLOOR, body);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(payload["ok"]).toStrictEqual(["py/adapters.py"]);
    expect(payload["notArray"]).toBeNull();
    expect(payload["glob"]).toBeNull();
    expect(payload["noFloor"]).toBeNull();
    expect(payload["floor"]).toBe(75);
    expect(result.stderr).toContain("不是数组");
    expect(result.stderr).toContain("不是字面文件名");
  });

  it("coverage-floor 能点出磁盘上有、files 里没登记的 py 源文件", async () => {
    const result = await evalModule(COVERAGE_FLOOR, jsonBody("mod.missingFromFiles([])"));
    const missing = JSON.parse(result.stdout.trim()) as string[];
    expect(missing).toContain("py/bridge.py");
    expect(missing.length).toBeGreaterThan(0);
  });

  it("face-py 的存在性判据不把目录与文件搞混", async () => {
    const empty = tempDir();
    const body = [
      "console.log(JSON.stringify({",
      ["dirOk: mod.isDirectory(", JSON.stringify(PY_DIR), "),"].join(""),
      ["fileNo: mod.isDirectory(", JSON.stringify(path.join(PY_DIR, "bridge.py")), "),"].join(""),
      ["missing: mod.isDirectory(", JSON.stringify(path.join(empty, "nope")), "),"].join(""),
      "}));",
    ].join(NEWLINE);
    const result = await evalModule(FACE_PY, body);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(payload["dirOk"]).toBe(true);
    expect(payload["fileNo"]).toBe(false);
    expect(payload["missing"]).toBe(false);
  });

  it("face-py 递归数夹具目录里的 *.py", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "tests"), { recursive: true });
    writeFileSync(path.join(dir, "a.py"), "");
    writeFileSync(path.join(dir, "b.txt"), "");
    writeFileSync(path.join(dir, "tests", "c.py"), "");
    const expression = ["mod.countPy(", JSON.stringify(dir), ")"].join("");
    const result = await evalModule(FACE_PY, jsonBody(expression));
    expect(JSON.parse(result.stdout.trim())).toBe(2);
  });
});
