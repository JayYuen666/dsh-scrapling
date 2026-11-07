// lib/runtime.ts —— 解释器解析顺序与已验资产清单。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mockPlatform } from "./managed-host.ts";
import {
  managedPythonPath,
  parseRuntimeManifest,
  resolveRuntime,
  runtimeManifest,
} from "../lib/runtime.ts";

/** Windows 没有可执行位，对应的判据由同名的 win32 用例负责，不在这里两头判。 */
const WINDOWS = process.platform === "win32";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-runtime-"));
  created.push(dir);
  return dir;
}

function fakeExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

/** 普通文件、但没有可执行位：安装中断或 tar 解包丢权限时的真实形态。 */
function fakeNonExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o644);
}

/** 在已验清单的基础上改一处字段，供加载期形态校验的用例（值一律走 JSON 文本入口）。 */
function manifestWith(patch: Record<string, unknown>): string {
  return JSON.stringify({
    darwinArm64: { ...runtimeManifest.darwinArm64, ...patch },
    unsupported: {},
  });
}

describe("resolveRuntime", () => {
  let restorePlatform: (() => void) | undefined;
  beforeAll(() => {
    restorePlatform = mockPlatform("darwin", "arm64");
  });
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    restorePlatform?.();
  });

  it("显式 pythonBin 优先", () => {
    const resolved = resolveRuntime({
      pythonBin: "/x/python3",
      dataDir: tempDir(),
      repoRoot: tempDir(),
    });
    expect(resolved).toMatchObject({ pythonPath: "/x/python3", via: "configured" });
  });

  it("托管 runtime 先于仓内 _env", () => {
    const dataDir = tempDir();
    const repoRoot = tempDir();
    fakeExecutable(managedPythonPath(dataDir));
    fakeExecutable(path.join(repoRoot, "_env", ".venv", "bin", "python"));
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot })).toStrictEqual({
      pythonPath: managedPythonPath(dataDir),
      via: "managed",
      version: runtimeManifest.darwinArm64.pythonVersion,
    });
  });

  it("托管位置的层级是 runtime/python/<清单版本>/bin/python3", () => {
    // 期望值在这里按层级自己拼一遍，而不是复用 managedPythonPath：层级一旦被改出另一
    // 个形状（少一层、结尾换成 python），本条要红。installer 与 resolveRuntime 共用
    // 这一个位置，拼错的后果是装好的资产永远探不到，而现场只会说「没找到解释器」。
    const dataDir = tempDir();
    expect(managedPythonPath(dataDir)).toBe(
      path.join(
        dataDir,
        "runtime",
        "python",
        runtimeManifest.darwinArm64.pythonVersion,
        "bin",
        "python3",
      ),
    );
  });

  it.runIf(!WINDOWS)("托管落点是个没有可执行位的文件时回落到仓内 _env", () => {
    // 安装中断、或 tar 解包丢了权限位时的形态：文件在、跑不起来。跟着它走会得到一个
    // 立刻 ENOENT 的 sidecar，回落才是可用答案。同一条判据在仓内 venv 上由
    // host.test.ts 的 0o644 用例判（两者共用 lib/runtime.ts 的 executable）。
    const dataDir = tempDir();
    const repoRoot = tempDir();
    fakeNonExecutable(managedPythonPath(dataDir));
    const python = path.join(repoRoot, "_env", ".venv", "bin", "python");
    fakeExecutable(python);
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot })).toStrictEqual({
      pythonPath: python,
      via: "repo",
      version: "unknown",
    });
  });

  it("没有托管 runtime 时用仓内 _env", () => {
    const repoRoot = tempDir();
    const python = path.join(repoRoot, "_env", ".venv", "bin", "python");
    fakeExecutable(python);
    expect(resolveRuntime({ pythonBin: "", dataDir: tempDir(), repoRoot })).toMatchObject({
      pythonPath: python,
      via: "repo",
    });
  });

  it("都没有时交回裸 python3，由宿主展开 PATH", () => {
    expect(
      resolveRuntime({
        pythonBin: "",
        dataDir: tempDir(),
        repoRoot: tempDir(),
      }),
    ).toMatchObject({ pythonPath: "python3", via: "path" });
  });

  it("dataDir 为空时不探托管 runtime", () => {
    expect(resolveRuntime({ pythonBin: "", dataDir: "", repoRoot: tempDir() })).toMatchObject({
      pythonPath: "python3",
      via: "path",
    });
  });

  it("非 macOS arm64 不探托管 runtime", () => {
    const dataDir = tempDir();
    fakeExecutable(managedPythonPath(dataDir));
    const restore = mockPlatform("linux", "x64");
    try {
      expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot: tempDir() })).toMatchObject({
        via: "path",
      });
    } finally {
      restore();
    }
  });

  it("win32 上交回 python（与 py-launcher 的 PATH_PYTHON 同名）", () => {
    // 与同组其它用例走同一套 mockPlatform：它同时管 platform 与 arch，恢复的是进 mock
    // 之前那一份描述符（也就是 beforeAll 装的 darwin/arm64 getter）。用
    // `vi.spyOn(process, "platform", "get")` 只会盖住 platform，arch 仍停在 arm64，
    // 这条用例的实际前提与它的标题不是一回事。
    const restore = mockPlatform("win32", "x64");
    try {
      expect(
        resolveRuntime({ pythonBin: "", dataDir: tempDir(), repoRoot: tempDir() }),
      ).toStrictEqual({ pythonPath: "python", via: "path", version: "unknown" });
    } finally {
      restore();
    }
  });

  it("win32 上仓内 venv 落在 Scripts/python.exe", () => {
    const repoRoot = tempDir();
    const python = path.join(repoRoot, "_env", ".venv", "Scripts", "python.exe");
    fakeExecutable(python);
    const restore = mockPlatform("win32", "x64");
    try {
      expect(resolveRuntime({ pythonBin: "", dataDir: tempDir(), repoRoot })).toMatchObject({
        pythonPath: python,
        via: "repo",
      });
    } finally {
      restore();
    }
  });

  it("坏清单在加载期抛错", () => {
    expect(() => parseRuntimeManifest('{"darwinArm64":{}}')).toThrow(/darwinArm64/u);
  });

  it("清单不是合法 JSON 时，报错点明是哪份文件", () => {
    expect(() => parseRuntimeManifest('{"darwinArm64": {}')).toThrow(
      /runtime-manifest\.json is invalid/u,
    );
  });

  it("sha256 必须是小写 64 位十六进制：大写或缺位在加载期就拒", () => {
    const sha = runtimeManifest.darwinArm64.sha256;
    for (const value of [sha.toUpperCase(), sha.slice(1), ""]) {
      expect(() => parseRuntimeManifest(manifestWith({ sha256: value }))).toThrow(/sha256/u);
    }
  });

  it("pythonVersion 必须是三段数字：带路径分隔符的值会被拒（它要拼进位置路径）", () => {
    for (const value of ["../../x", "/abs/path", "3.14"]) {
      expect(() => parseRuntimeManifest(manifestWith({ pythonVersion: value }))).toThrow(
        /pythonVersion/u,
      );
    }
  });

  it("url 必须是绝对 URL：没有协议头的写法在加载期就拒", () => {
    // 这份 url 会被 installer 直接交给 fetch，缺协议的写法要等到下载那一步才炸。
    for (const value of ["", "example.com/x.tar.gz", "//example.com/x.tar.gz"]) {
      expect(() => parseRuntimeManifest(manifestWith({ url: value }))).toThrow(/url/u);
    }
  });

  it("sizeBytes 必须是正整数：0、负数、小数都算坏清单", () => {
    // 它决定「下载体积对不上」那一条判据，写成 0 或小数等于把判据关掉。
    for (const value of [0, -1, 1.5]) {
      expect(() => parseRuntimeManifest(manifestWith({ sizeBytes: value }))).toThrow(/sizeBytes/u);
    }
  });

  it("unsupported 的值必须是字符串：平台名到原因的映射写成数字也算坏", () => {
    const text = JSON.stringify({
      darwinArm64: runtimeManifest.darwinArm64,
      unsupported: { "win32-x64": 2 },
    });
    expect(() => parseRuntimeManifest(text)).toThrow(/unsupported/u);
  });

  it("托管位置被替换成同名目录时不算可用解释器", () => {
    const dataDir = tempDir();
    const repoRoot = tempDir();
    const fakeManaged = managedPythonPath(dataDir);
    mkdirSync(fakeManaged, { recursive: true });
    chmodSync(fakeManaged, 0o755);
    const python = path.join(repoRoot, "_env", ".venv", "bin", "python");
    fakeExecutable(python);
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot })).toMatchObject({
      pythonPath: python,
      via: "repo",
    });
  });

  it("manifest 钉死 macOS arm64 的哈希与版本", () => {
    expect(runtimeManifest.darwinArm64.sha256).toBe(
      "226d696642a8a53d03b4d5b255b1c319b1575a6d44bd723a953c9f507755e36a",
    );
    expect(runtimeManifest.darwinArm64.pythonVersion).toBe("3.14.9");
  });
});
