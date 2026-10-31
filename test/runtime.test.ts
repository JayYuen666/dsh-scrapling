// lib/runtime.ts —— 解释器解析顺序与已验资产清单。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockPlatform } from "./managed-host.ts";
import {
  managedPythonPath,
  parseRuntimeManifest,
  resolveRuntime,
  runtimeManifest,
} from "../lib/runtime.ts";

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
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot })).toMatchObject({
      via: "managed",
      version: runtimeManifest.darwinArm64.pythonVersion,
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
        env: { PATH: tempDir() },
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
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(
        resolveRuntime({ pythonBin: "", dataDir: tempDir(), repoRoot: tempDir() }),
      ).toMatchObject({ pythonPath: "python", via: "path" });
    } finally {
      platform.mockRestore();
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

  it("pythonVersion 必须是三段数字：带路径分隔符的值会被拒（它要拼进落点路径）", () => {
    for (const value of ["../../x", "/abs/path", "3.14"]) {
      expect(() => parseRuntimeManifest(manifestWith({ pythonVersion: value }))).toThrow(
        /pythonVersion/u,
      );
    }
  });

  it("托管落点被替换成同名目录时不算可用解释器", () => {
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
