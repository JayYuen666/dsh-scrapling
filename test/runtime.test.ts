// lib/runtime.ts —— 解释器解析顺序与已验资产清单。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mockPlatform } from "./managed-host.ts";
import {
  managedPythonPath,
  managedVenvPythonPath,
  parseRuntimeManifest,
  readManifestText,
  resolveRuntime,
  runtimeManifest,
  venvVersionOf,
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

  it("托管档优先选 venv：裸托管解释器里装不了包，它不是 sidecar 能用的那支", () => {
    // 安装器落的是「托管 CPython + 由它建出的 runtime/venv」两件东西，scrapling 在 venv 里。
    // 两枚都可执行时必须选 venv：选错的那一版表面完全正常（路径是绝对路径、可执行、
    // 日志写着 managed），只有 sidecar 的 ready 帧会把 capabilities 全报 false，
    // 症状是「工具一只都不注册、skill 正文为空」。
    const dataDir = tempDir();
    const repoRoot = tempDir();
    fakeExecutable(managedPythonPath(dataDir));
    fakeExecutable(managedVenvPythonPath(dataDir));
    // `via` 与裸托管解释器分开报：两支的差别就是「工具全在」与「工具一只都不在」，
    // 都报 managed 时日志与设置卡读不出选中的是哪一支。
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot })).toStrictEqual({
      pythonPath: managedVenvPythonPath(dataDir),
      via: "managed-venv",
      version: runtimeManifest.darwinArm64.pythonVersion,
    });
  });

  it("托管 venv 不在时回落到裸托管解释器（装了一半的机器）", () => {
    const dataDir = tempDir();
    fakeExecutable(managedPythonPath(dataDir));
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot: tempDir() })).toStrictEqual({
      pythonPath: managedPythonPath(dataDir),
      via: "managed",
      version: runtimeManifest.darwinArm64.pythonVersion,
    });
  });

  it("win32 上托管 venv 落在 Scripts/python.exe（venv 不造 python3.exe）", () => {
    // 安装器本身只在 darwin/arm64 落地（`installerSupported`），所以这条分支在真机上走不到；
    // 留着它是因为布局函数被 CLI 的 `--status` 与设置卡共用，那边不判平台。判据是自己拼的
    // 路径而不是复用函数，层级写错才会红。
    // 名字是 `python.exe` 不是 `python3.exe`：CPython 的 `venv/__init__.py` 里 `link_sources`
    // 的键只有 `python.exe` / `python{exe_d}.exe` / `python{exe_t}.exe` / `pythonw*.exe`，
    // Windows 那边不走 POSIX 的 `python` / `python3` 三后缀那套。
    const dataDir = tempDir();
    const restore = mockPlatform("win32", "x64");
    try {
      expect(managedVenvPythonPath(dataDir)).toBe(
        path.join(dataDir, "runtime", "venv", "Scripts", "python.exe"),
      );
    } finally {
      restore();
    }
  });

  it("托管 venv 的版本问它自己的 pyvenv.cfg，不抄清单", () => {
    // venv 的路径不带版本号（runtime/venv），版本只能问 venv 自己。清单升到 3.15 而机器上
    // 留着 3.14 的旧 venv 时，抄清单会让「状态」页把基座版本说成 3.15。
    const dataDir = tempDir();
    const repoRoot = tempDir();
    fakeExecutable(managedVenvPythonPath(dataDir));
    writeFileSync(
      path.join(dataDir, "runtime", "venv", "pyvenv.cfg"),
      "home = /opt/python/bin\nversion = 3.13.7\n",
    );
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot })).toMatchObject({
      pythonPath: managedVenvPythonPath(dataDir),
      via: "managed-venv",
      version: "3.13.7",
    });
  });

  it("pyvenv.cfg 读不到时版本回落到清单值", () => {
    const dataDir = tempDir();
    fakeExecutable(managedVenvPythonPath(dataDir));
    expect(resolveRuntime({ pythonBin: "", dataDir, repoRoot: tempDir() }).version).toBe(
      runtimeManifest.darwinArm64.pythonVersion,
    );
  });

  it("托管 venv 的层级是 runtime/venv/bin/python3", () => {
    // 与 managedPythonPath 那条同理由：期望值自己拼一遍，层级被改出另一个形状时本条要红。
    // 布局与 officialMcpBinary 同源，改一处就得两处一起改。
    const dataDir = tempDir();
    expect(managedVenvPythonPath(dataDir)).toBe(
      path.join(dataDir, "runtime", "venv", "bin", "python3"),
    );
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

  it("repoRoot 为空时不按 cwd 猜仓内 venv", () => {
    // `repoPythonPath("")` 拼出来是相对路径 `_env/.venv/bin/python`，而 `executable()` 的
    // statSync 会按 `process.cwd()` 解析 —— 在仓根跑测试时它恰好存在，于是这一档会选中
    // 一个与部署无关的解释器。这里只要求它**不**被选中，不要求 cwd 恰好有那份 venv：
    // 拿空的 repoRoot 问一次，答案必须落到 PATH。
    expect(resolveRuntime({ pythonBin: "", dataDir: tempDir(), repoRoot: "" })).toMatchObject({
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
      ).toStrictEqual({
        pythonPath: "python",
        via: "path",
        version: "unknown",
        // 落到 PATH 时把清单为这台机器写下的原因一并交回：`unsupported` 那一格此前
        // 谁都不读，等于一条校验了却永不生效的字段。
        assetNote: runtimeManifest.unsupported["win32-x64"],
      });
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

  it("venv 的版本从它自己的 pyvenv.cfg 里读", () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime", "venv"), { recursive: true });
    writeFileSync(
      path.join(dataDir, "runtime", "venv", "pyvenv.cfg"),
      "home = /opt/homebrew/opt/python@3.13/bin\nversion = 3.13.7\n",
    );
    expect(venvVersionOf(dataDir)).toBe("3.13.7");
  });

  it("没有 pyvenv.cfg 时 venv 版本是 undefined（调用方回落到清单值）", () => {
    expect(venvVersionOf(tempDir())).toBeUndefined();
  });

  it("坏清单在加载期抛错", () => {
    expect(() => parseRuntimeManifest('{"darwinArm64":{}}')).toThrow(/darwinArm64/u);
  });

  it("清单读不到时，报错点明是哪份文件（不甩裸 ENOENT）", () => {
    const missing = path.join(tempDir(), "runtime-manifest.json");
    // 两条分开判：一句钉「点明是清单」，一条钉「带上完整路径」。
    // 拼正则会把路径当模式（反斜杠、括号都成了元字符），这里直接比字符串包含。
    expect(() => readManifestText(missing)).toThrow(/runtime-manifest\.json is unreadable/u);
    expect(() => readManifestText(missing)).toThrow(missing);
  });

  it("惰性读清单：模块载入不碰文件，只有真去取清单时才读", () => {
    // 这一条钉的是「模块顶层不同步读」这件事本身：runtimeManifest 是带 getter 的对象，
    // 上面所有用例都在导入之后才访问 darwinArm64，模块载入期就没抛过。
    const descriptor = Object.getOwnPropertyDescriptor(runtimeManifest, "darwinArm64");
    expect(Reflect.get(descriptor ?? {}, "get")).toBeTypeOf("function");
    expect(runtimeManifest.darwinArm64.pythonVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    // 另一枚 getter 走同一条惰性路径：两枚都读一次，任何一枚被改成取值常量都会红。
    expect(runtimeManifest.unsupported).toBeDefined();
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

  it("url 必须是绝对 URL 且只用 https：明文与本机文件协议在加载期就拒", () => {
    // 这份 url 会被 installer 直接交给 fetch / curl。缺协议的写法要等到下载那一步才炸；
    // 而 `http://` 与 `file://` 是**合法 URL**，只校验形态会让安装器去取明文或本机文件，
    // 所以协议也在这一层收死。
    for (const value of [
      "",
      "example.com/x.tar.gz",
      "//example.com/x.tar.gz",
      "http://example.com/x.tar.gz",
      "file:///etc/passwd",
      "ftp://example.com/x.tar.gz",
    ]) {
      expect(() => parseRuntimeManifest(manifestWith({ url: value }))).toThrow(/url/u);
    }
  });

  it("platform / arch 只认 darwin 与 arm64：清单写错在加载期就拒", () => {
    // 这两枚原先只校验「是个字符串」且全仓无人比对，清单里写 linux 照样能装。
    for (const patch of [{ platform: "linux" }, { arch: "x64" }, { platform: "" }]) {
      expect(() => parseRuntimeManifest(manifestWith(patch))).toThrow(/darwinArm64|platform|arch/u);
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
      documents: runtimeManifest.documents,
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

  it("documents 清单钉住 requirements 路径、版本与文件哈希", () => {
    expect(runtimeManifest.documents).toMatchObject({
      requirements: "py/documents-requirements.txt",
      distribution: "pypdf",
      version: "7.1.1",
    });
    expect(runtimeManifest.documents.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("documents 清单拒绝路径穿越与坏哈希", () => {
    for (const patch of [
      { requirements: "../documents-requirements.txt" },
      { sha256: "ABC" },
      { version: "latest" },
    ]) {
      const text = JSON.stringify({
        darwinArm64: runtimeManifest.darwinArm64,
        unsupported: runtimeManifest.unsupported,
        documents: { ...runtimeManifest.documents, ...patch },
      });
      expect(() => parseRuntimeManifest(text)).toThrow(/documents/u);
    }
  });

  it("manifest 钉死 macOS arm64 的哈希与版本", () => {
    expect(runtimeManifest.darwinArm64.sha256).toBe(
      "226d696642a8a53d03b4d5b255b1c319b1575a6d44bd723a953c9f507755e36a",
    );
    expect(runtimeManifest.darwinArm64.pythonVersion).toBe("3.14.9");
  });
});
