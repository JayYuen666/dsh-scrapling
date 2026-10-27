// lib/installer.ts —— 托管 Python 与 core 依赖的安装边界。

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockPlatform } from "./managed-host.ts";
import {
  acquireLock,
  createCurlDownloader,
  defaultInstallerIO,
  installBrowser,
  installCapabilityPack,
  installCore,
  installPython,
  InstallError,
  packStates,
  readRuntimeState,
  releaseLock,
  relocateScripts,
  repairCapabilityPack,
  uninstallCapabilityPack,
  withInstallLock,
} from "../lib/installer.ts";
import type { InstallerIO, LockHandle, SpawnResult } from "../lib/installer.ts";
import { managedPythonPath, runtimeManifest } from "../lib/runtime.ts";

const created: string[] = [];
const MANAGED_PYTHON = "/managed/python3";
const STATE_FILE = "state.json";
const STORAGE_DB = "elements_storage.db";
const CHROMIUM_DIR = "chromium-1";
const CHROME_MAC = "chrome-mac";
const ASSET_URL = "https://example.invalid/asset";
const INSTALL_LOCK = "install.lock";
const OLD_MARKER = "old-marker";
const OLD_MARKER_BODY = "still installed\n";

type RunStep = (
  argv: readonly string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<SpawnResult>;
const failedCurlRun: RunStep = async () => ({
  code: 22,
  stdout: "",
  stderr: "curl: (22) The requested URL returned error: 404",
});
const missingCurlRun: RunStep = async () => ({
  code: null,
  stdout: "",
  stderr: "spawn curl ENOENT",
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-install-"));
  created.push(dir);
  return dir;
}

function writePackState(dataDir: string, packs: unknown): void {
  mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
  writeFileSync(path.join(dataDir, "runtime", STATE_FILE), JSON.stringify({ packs }));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function installableAsset(): typeof runtimeManifest.darwinArm64 {
  const bytes = new TextEncoder().encode("archive");
  return { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
}

function fakeIO(overrides: Partial<InstallerIO> = {}): InstallerIO {
  return {
    download: async () => new Uint8Array(),
    extract: async () => {
      await Promise.resolve();
    },
    spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

function venvSpawner(calls: string[][], pip: SpawnResult): InstallerIO["spawn"] {
  return async (argv): Promise<SpawnResult> => {
    calls.push([...argv]);
    if (argv.includes("venv")) {
      const target = argv.at(-1) ?? "";
      mkdirSync(path.join(target, "bin"), { recursive: true });
      writeFileSync(path.join(target, "bin", "python3"), "#!/bin/sh\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    return pip;
  };
}

function requirementsRepoRoot(): string {
  const repoRoot = tempDir();
  mkdirSync(path.join(repoRoot, "py"), { recursive: true });
  writeFileSync(path.join(repoRoot, "py", "runtime-requirements.txt"), "scrapling==0.5\n");
  return repoRoot;
}

function browserSpawner(): InstallerIO["spawn"] {
  return async (_argv, options): Promise<SpawnResult> => {
    const browsers = options?.env?.["PLAYWRIGHT_BROWSERS_PATH"] ?? "";
    mkdirSync(path.join(browsers, CHROMIUM_DIR, CHROME_MAC), { recursive: true });
    writeFileSync(path.join(browsers, CHROMIUM_DIR, CHROME_MAC, "Chromium"), "");
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("defaultInstallerIO", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("download 走系统 curl 成功读回字节", async () => {
    // 真起一次本地 HTTP 服务：这一条钉的是旗标组合本身（--fail 不吞 200、--location
    // 不破坏本地回显），假 runner 的那组测不到它。
    const bytes = new TextEncoder().encode("payload");
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(bytes);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const downloaded = await defaultInstallerIO.download(
        `http://127.0.0.1:${String(port)}/asset`,
      );
      expect(Buffer.from(downloaded).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      server.close();
    }
  });

  it("download 遇 HTTP 错误报 INSTALL_NETWORK", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const error = await defaultInstallerIO
        .download(`http://127.0.0.1:${String(port)}/asset`)
        .catch((error_: unknown) => error_);
      expect((error as InstallError).code).toBe("INSTALL_NETWORK");
    } finally {
      server.close();
    }
  });

  it("spawn 收 stdout/stderr 与退出码，extract 解 tar 且坏包报 INSTALL_FAILED", async () => {
    const dir = tempDir();
    const source = path.join(dir, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "hello.txt"), "hi");
    const archive = path.join(dir, "payload.tar.gz");

    const captured = await defaultInstallerIO.spawn([
      process.execPath,
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);",
    ]);
    expect(captured).toStrictEqual({ code: 3, stdout: "out", stderr: "err" });

    // Windows 上 PATH 里先到的可能是 Git 的 GNU tar，它把 `C:\…` 当远端主机（要
    // --force-local 才认本地），于是 -f 收一个盘符路径就退 2。系统自带的 System32 是
    // bsdtar，没有这个坑；把那一格排到前面，测的仍是安装器真用的那支 tar。
    const savedPath = process.env["PATH"];
    if (process.platform === "win32") {
      const system32 = path.join(process.env["SystemRoot"] ?? String.raw`C:\Windows`, "System32");
      process.env["PATH"] = `${system32}${path.delimiter}${savedPath ?? ""}`;
    }
    try {
      const packed = await defaultInstallerIO.spawn(["tar", "-czf", archive, "-C", source, "."]);
      if (packed.code !== 0) {
        throw new Error(`tar -czf 失败（${String(packed.code)}）：${packed.stderr}`);
      }

      const destination = path.join(dir, "destination");
      mkdirSync(destination);
      await defaultInstallerIO.extract(archive, destination);
      expect(readFileSync(path.join(destination, "hello.txt"), "utf8")).toBe("hi");

      const broken = path.join(dir, "broken.tar.gz");
      writeFileSync(broken, "not a tarball");
      const error = await defaultInstallerIO
        .extract(broken, destination)
        .catch((error_: unknown) => error_);
      expect((error as InstallError).code).toBe("INSTALL_FAILED");
    } finally {
      if (savedPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = savedPath;
      }
    }
  });

  it("空 argv 由 spawn 自己拒绝", async () => {
    await expect(defaultInstallerIO.spawn([])).rejects.toThrow(/cannot be empty/u);
  });

  it("spawn 失败时交回 code null 与原始错误", async () => {
    const result = await defaultInstallerIO.spawn(["dsh-scrapling-no-such-binary"]);
    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/ENOENT|no such file/iu);
  });
});

describe("createCurlDownloader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("curl 成功时读回文件字节并清掉临时文件", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    let written = "";
    const runStep: RunStep = async (argv) => {
      written = argv[argv.indexOf("--output") + 1] ?? "";
      writeFileSync(written, bytes);
      return { code: 0, stdout: "", stderr: "" };
    };
    const downloaded = await createCurlDownloader(runStep)(ASSET_URL);
    expect(Buffer.from(downloaded).equals(Buffer.from(bytes))).toBe(true);
    expect(existsSync(written)).toBe(false);
  });

  it("curl 退非零报 INSTALL_NETWORK，不再改走 fetch", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const error = await createCurlDownloader(failedCurlRun)(ASSET_URL).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_NETWORK");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("curl 不在（spawn 失败）时退回 fetch", async () => {
    const bytes = new Uint8Array([9]);
    vi.stubGlobal("fetch", async () => new Response(bytes, { status: 200 }));
    const downloaded = await createCurlDownloader(missingCurlRun)(ASSET_URL);
    expect(Buffer.from(downloaded).equals(Buffer.from(bytes))).toBe(true);
  });

  it("curl 不在且 fetch 非 2xx 时报 INSTALL_NETWORK", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    const error = await createCurlDownloader(missingCurlRun)(ASSET_URL).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_NETWORK");
    expect((error as Error).message).toContain("503");
  });
});

describe("installPython", () => {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("哈希不符时报 INSTALL_HASH_MISMATCH 且不留临时目录", async () => {
    const dataDir = tempDir();
    const io = fakeIO({ download: async () => new Uint8Array([1, 2, 3]) });
    const error = await installPython(runtimeManifest.darwinArm64, dataDir, io).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(InstallError);
    expect((error as InstallError).code).toBe("INSTALL_HASH_MISMATCH");
    expect(existsSync(path.join(dataDir, "runtime", ".tmp"))).toBe(false);
  });

  it("校验通过后解压到托管路径", async () => {
    const dataDir = tempDir();
    const bytes = new TextEncoder().encode("archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    let extracted = "";
    const io = fakeIO({
      download: async () => bytes,
      extract: async (_archive, destination) => {
        extracted = destination;
        const bin = path.join(destination, "python", "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "python3"), "#!/bin/sh\n");
      },
    });
    const result = await installPython(asset, dataDir, io);
    expect(result).toMatchObject({ version: "3.14.9" });
    expect(result.pythonPath).toBe(managedPythonPath(dataDir));
    expect(existsSync(result.pythonPath)).toBe(true);
    expect(extracted).toContain(".tmp");
  });

  it("归档根即解释器目录时直接拷该层", async () => {
    const dataDir = tempDir();
    const bytes = new TextEncoder().encode("archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    const io = fakeIO({
      download: async () => bytes,
      extract: async (_archive, destination) => {
        const bin = path.join(destination, "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "python3"), "#!/bin/sh\n");
      },
    });
    const result = await installPython(asset, dataDir, io);
    expect(existsSync(result.pythonPath)).toBe(true);
  });

  it("复制时解开软链，临时目录删掉后解释器仍可用", async () => {
    const dataDir = tempDir();
    const bytes = new TextEncoder().encode("archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    const io = fakeIO({
      download: async () => bytes,
      extract: async (_archive, destination) => {
        const bin = path.join(destination, "python", "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "python3.14"), "#!/bin/sh\n");
        await symlink("python3.14", path.join(bin, "python3"));
      },
    });
    const result = await installPython(asset, dataDir, io);
    const info = await lstat(result.pythonPath);
    expect(info.isSymbolicLink()).toBe(false);
    expect(existsSync(result.pythonPath)).toBe(true);
    expect(existsSync(path.join(dataDir, "runtime", ".tmp"))).toBe(false);
  });

  it("归档里没有解释器时报 INSTALL_FAILED", async () => {
    const dataDir = tempDir();
    const bytes = new TextEncoder().encode("archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    const error = await installPython(
      asset,
      dataDir,
      fakeIO({ download: async () => bytes }),
    ).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_FAILED");
  });

  it("清理临时目录时不撤掉别的安装的 .tmp", async () => {
    const dataDir = tempDir();
    const other = path.join(dataDir, "runtime", ".tmp", "other");
    mkdirSync(other, { recursive: true });
    const bytes = new TextEncoder().encode("archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    const io = fakeIO({
      download: async () => bytes,
      extract: async (_archive, destination) => {
        const bin = path.join(destination, "python", "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "python3"), "#!/bin/sh\n");
      },
    });
    await installPython(asset, dataDir, io);
    expect(existsSync(other)).toBe(true);
  });

  it("安装锁被占用时报 INSTALL_BUSY", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    writeFileSync(path.join(dataDir, "runtime", INSTALL_LOCK), "other\n");
    const error = await installPython(runtimeManifest.darwinArm64, dataDir, fakeIO()).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_BUSY");
  });

  const usableExtract = {
    extract: async (_archive: string, destination: string) => {
      const bin = path.join(destination, "python", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, "python3"), "#!/bin/sh\n");
    },
  };

  function installableIO(): InstallerIO {
    const bytes = new TextEncoder().encode("archive");
    return fakeIO({
      download: async () => bytes,
      ...usableExtract,
    });
  }

  it("持锁进程已死时清掉陈旧锁继续安装", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    const departed = spawn(process.execPath, ["-e", ""]);
    await once(departed, "exit");
    writeFileSync(
      path.join(dataDir, "runtime", INSTALL_LOCK),
      `${String(departed.pid)} ${String(Date.now())}\n`,
    );
    const result = await installPython(installableAsset(), dataDir, installableIO());
    expect(result.pythonPath).toBe(managedPythonPath(dataDir));
  });

  // 时间戳不是接管依据：一次正常的 pip 安装要下载几百 MB，跑过一小时完全正常。
  // 拿「锁写了一小时」去接管一把**活进程**持有的锁，等于让两个安装同时写同一个 venv。
  it("活进程持锁超过一小时也不接管", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    const staleAt = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(
      path.join(dataDir, "runtime", INSTALL_LOCK),
      `${String(process.pid)} ${String(staleAt)}\n`,
    );
    const error = await installPython(runtimeManifest.darwinArm64, dataDir, fakeIO()).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_BUSY");
  });

  it("活着的别的进程持锁时仍报 INSTALL_BUSY", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000);"], {
      stdio: "ignore",
    });
    try {
      writeFileSync(
        path.join(dataDir, "runtime", INSTALL_LOCK),
        `${String(holder.pid)} ${String(Date.now())}\n`,
      );
      const error = await installPython(runtimeManifest.darwinArm64, dataDir, fakeIO()).catch(
        (error_: unknown) => error_,
      );
      expect((error as InstallError).code).toBe("INSTALL_BUSY");
    } finally {
      holder.kill();
      await once(holder, "exit");
    }
  });

  it("锁路径被目录占住时按 BUSY 处理", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime", INSTALL_LOCK), { recursive: true });
    const error = await installPython(runtimeManifest.darwinArm64, dataDir, fakeIO()).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_BUSY");
  });

  it("锁由当前进程持有且未过期时报 INSTALL_BUSY", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    writeFileSync(
      path.join(dataDir, "runtime", INSTALL_LOCK),
      `${String(process.pid)} ${String(Date.now())}\n`,
    );
    const error = await installPython(runtimeManifest.darwinArm64, dataDir, fakeIO()).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_BUSY");
  });

  it("陈旧锁被移走后二次抢占失败时报 INSTALL_BUSY", async () => {
    const dataDir = tempDir();
    const lockPath = path.join(dataDir, "runtime", INSTALL_LOCK);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `999999 ${String(Date.now() - 2 * 60 * 60 * 1000)}\n`);
    let calls = 0;
    const openLock = async (): Promise<never> => {
      calls += 1;
      const code = calls === 1 ? "EEXIST" : "EACCES";
      throw Object.assign(new Error(code), { code });
    };
    const error = await acquireLock(lockPath, openLock).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_BUSY");
  });
});

describe("withInstallLock", () => {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // close 抛错时若直接放弃清锁，锁里写的是**本进程**的 pid，本进程此后每次安装都自撞 BUSY。
  it("关锁时 close 抛错也照样把锁清掉", async () => {
    const dataDir = tempDir();
    const lockPath = path.join(dataDir, "runtime", INSTALL_LOCK);
    const closed: string[] = [];
    const result = await withInstallLock(
      dataDir,
      async () => {
        expect(existsSync(lockPath)).toBe(true);
        return "done";
      },
      async (file) => ({
        writeFile: async (data) => {
          await writeFile(file, data, "utf8");
        },
        close: async () => {
          closed.push("close");
          throw new Error("close boom");
        },
      }),
    );
    expect(result).toBe("done");
    expect(closed).toStrictEqual(["close"]);
    expect(existsSync(lockPath)).toBe(false);
  });

  // 持有期间锁可能被判陈旧清掉、又被另一路重新写下它的 pid；这时删文件等于放行并发安装。
  it("锁被接管后不删新持有者的锁", async () => {
    const dataDir = tempDir();
    const lockPath = path.join(dataDir, "runtime", INSTALL_LOCK);
    await withInstallLock(dataDir, async () => {
      writeFileSync(lockPath, `999999999 ${String(Date.now())}\n`);
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toContain("999999999");
  });

  // spec §11.6：「runtime 目录 0700」。取锁是建 runtime 目录最常见的入口，量这一条即可
  // 覆盖目录收权；Windows 没有这组权限位（chmod 只改只读位），整条用例跳过而不是断假值。
  it.skipIf(process.platform === "win32")("runtime 目录建出来就是 0700", async () => {
    const dataDir = tempDir();
    await withInstallLock(dataDir, async () => "locked");
    // mode 的高位是文件类型（目录 = 0o040000），取低 12 位就是权限位本身。
    expect(statSync(path.join(dataDir, "runtime")).mode % 0o1000).toBe(0o700);
  });

  // 早期版本按 umask 建目录（典型 0755）；只在建目录那一刻 chmod，等于让老用户的目录永远修不好。
  it.skipIf(process.platform === "win32")("已存在的宽权限 runtime 目录会被重收紧", async () => {
    const dataDir = tempDir();
    const runtimeDir = path.join(dataDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await chmod(runtimeDir, 0o755);
    await withInstallLock(dataDir, async () => "locked");
    expect(statSync(runtimeDir).mode % 0o1000).toBe(0o700);
  });

  // Windows 上没有这组权限位（chmod 只改只读位）：跳过 chmod 而不是假装收到 0700。
  it("win32 上跳过收权但目录照建", async () => {
    const restore = mockPlatform("win32", "x64");
    try {
      const dataDir = tempDir();
      await withInstallLock(dataDir, async () => "locked");
      expect(existsSync(path.join(dataDir, "runtime"))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("releaseLock", () => {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const quietHandle: LockHandle = {
    writeFile: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };

  it("close 抛错也照样把自己那把锁清掉", async () => {
    const dataDir = tempDir();
    const runtimeDir = path.join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, INSTALL_LOCK);
    writeFileSync(lockPath, `${String(process.pid)} ${String(Date.now())}\n`);
    await releaseLock(lockPath, {
      writeFile: () => Promise.resolve(),
      close: () => Promise.reject(new Error("EBADF")),
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  // 锁文件已经不在（被别路清掉）：读属主失败不能变成一次抛错。
  it("锁文件不在时安静收工", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    await expect(
      releaseLock(path.join(dataDir, "runtime", INSTALL_LOCK), quietHandle),
    ).resolves.toBeUndefined();
  });

  // 读不出自己的 pid（写坏了、或是别人的锁）就保留它：宁可留一把等人清，也不能删别人的锁。
  it("锁里读不出自己的 pid 时保留那把锁", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    const lockPath = path.join(dataDir, "runtime", INSTALL_LOCK);
    writeFileSync(lockPath, "not-a-pid\n");
    await releaseLock(lockPath, quietHandle);
    expect(existsSync(lockPath)).toBe(true);
  });

  // 删不掉（目录只读）时只是收工：抛出去会盖掉调用方真正要报的那个错误。
  it.skipIf(process.platform === "win32")("锁文件删不掉时安静收工", async () => {
    const dataDir = tempDir();
    const runtimeDir = path.join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, INSTALL_LOCK);
    writeFileSync(lockPath, `${String(process.pid)} ${String(Date.now())}\n`);
    await chmod(runtimeDir, 0o500);
    try {
      await expect(releaseLock(lockPath, quietHandle)).resolves.toBeUndefined();
    } finally {
      await chmod(runtimeDir, 0o700);
    }
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("installBrowser", () => {
  it("命令与目录正确，且不带 --only-shell", async () => {
    const dataDir = tempDir();
    const calls: { argv: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const io = fakeIO({
      spawn: async (argv, options): Promise<SpawnResult> => {
        calls.push(
          options?.env === undefined ? { argv: [...argv] } : { argv: [...argv], env: options.env },
        );
        const browsers = options?.env?.["PLAYWRIGHT_BROWSERS_PATH"] ?? "";
        mkdirSync(path.join(browsers, CHROMIUM_DIR, CHROME_MAC), { recursive: true });
        writeFileSync(path.join(browsers, CHROMIUM_DIR, CHROME_MAC, "Chromium"), "");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await installBrowser({ pythonPath: MANAGED_PYTHON, dataDir, io });
    expect(result.browsersPath).toBe(path.join(dataDir, "runtime", "browsers"));
    expect(calls[0]?.argv).toStrictEqual([
      MANAGED_PYTHON,
      "-m",
      "patchright",
      "install",
      "chromium",
    ]);
    expect(calls[0]?.argv).not.toContain("--only-shell");
    expect(calls[0]?.env?.["PLAYWRIGHT_BROWSERS_PATH"]).toBe(result.browsersPath);
  });

  // 原地 truncate+write 会保留 inode，rename 替换必然换一个新 inode —— 这就是
  // 「读者要么看到旧整份、要么看到新整份」的可观测面，也是半截 JSON 的来源被堵住的证据。
  it.skipIf(process.platform === "win32")("state.json 用改名替换，不留半截文件", async () => {
    const dataDir = tempDir();
    const runtimeDir = path.join(dataDir, "runtime");
    const statePath = path.join(runtimeDir, STATE_FILE);
    writePackState(dataDir, { core: "ready" });
    const before = statSync(statePath).ino;
    await installBrowser({
      pythonPath: MANAGED_PYTHON,
      dataDir,
      io: fakeIO({ spawn: browserSpawner() }),
    });
    expect(statSync(statePath).ino).not.toBe(before);
    const state = await readRuntimeState(dataDir);
    expect(state["packs"]).toStrictEqual({ core: "ready", browser: "ready" });
    // 临时文件必须被清掉，别把 runtime 变成垃圾场。
    expect(readdirSync(runtimeDir).filter((name) => name.startsWith(STATE_FILE))).toStrictEqual([
      STATE_FILE,
    ]);
  });

  it("非零退出报 INSTALL_BROWSER_FAILED", async () => {
    const error = await installBrowser({
      pythonPath: MANAGED_PYTHON,
      dataDir: tempDir(),
      io: fakeIO({ spawn: async () => ({ code: 1, stdout: "", stderr: "boom" }) }),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_BROWSER_FAILED");
  });

  it("认 macOS 完整 Chromium 的 Google Chrome for Testing 可执行文件", async () => {
    const io = fakeIO({
      spawn: async (_argv, options) => {
        const browsers = options?.env?.["PLAYWRIGHT_BROWSERS_PATH"] ?? "";
        const app = path.join(
          browsers,
          CHROMIUM_DIR,
          "chrome-mac-arm64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
        );
        mkdirSync(app, { recursive: true });
        writeFileSync(path.join(app, "Google Chrome for Testing"), "");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await expect(
      installBrowser({ pythonPath: MANAGED_PYTHON, dataDir: tempDir(), io }),
    ).resolves.toMatchObject({ browsersPath: expect.stringContaining("browsers") as string });
  });

  it("命令成功但目录里没有浏览器时报 INSTALL_BROWSER_FAILED", async () => {
    const error = await installBrowser({
      pythonPath: MANAGED_PYTHON,
      dataDir: tempDir(),
      io: fakeIO(),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).message).toContain("no chromium");
  });

  it("浏览器目录读不到时按未找到处理", async () => {
    const dataDir = tempDir();
    const browsers = path.join(dataDir, "runtime", "browsers");
    const io = fakeIO({
      // 在 mkdir 之后、readdir 之前把目录换成文件。`chmod 000` 在 Windows 上不拦访问，
      // 而「这个路径不是目录」在两边都让 readdir 抛 ENOTDIR——判据因此不再分平台。
      spawn: async () => {
        rmSync(browsers, { recursive: true, force: true });
        writeFileSync(browsers, "");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const error = await installBrowser({
      pythonPath: MANAGED_PYTHON,
      dataDir,
      io,
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_BROWSER_FAILED");
  });

  it("已有 state 的 packs 是坏形状时只写 browser 一包", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    writeFileSync(
      path.join(dataDir, "runtime", STATE_FILE),
      JSON.stringify({ packs: [], extra: true }),
    );
    const io = fakeIO({ spawn: browserSpawner() });
    await installBrowser({ pythonPath: MANAGED_PYTHON, dataDir, io });
    const state = await readRuntimeState(dataDir);
    expect(state["packs"]).toStrictEqual({ browser: "ready" });
    expect(state["extra"]).toBe(true);
  });
});

describe("installCore", () => {
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

  it("建临时 venv、按 --only-binary/--require-hashes 安装，成功后替换", async () => {
    const dataDir = tempDir();
    const repoRoot = requirementsRepoRoot();
    const calls: string[][] = [];
    await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir,
      repoRoot,
      io: fakeIO({ spawn: venvSpawner(calls, { code: 0, stdout: "", stderr: "" }) }),
    });
    const pip = calls.find((argv) => argv.includes("pip"));
    expect(pip).toContain("--only-binary=:all:");
    expect(pip).toContain("--require-hashes");
    expect(pip).toContain("-r");
    expect(existsSync(path.join(dataDir, "runtime", "venv", "bin", "python3"))).toBe(true);
    expect(existsSync(path.join(dataDir, "runtime", STATE_FILE))).toBe(true);
  });

  it("console script 的 shebang 从暂存路径改到最终 venv", async () => {
    const dataDir = tempDir();
    let staging = "";
    const io = fakeIO({
      spawn: async (argv) => {
        if (argv.includes("venv")) {
          staging = argv.at(-1) ?? "";
          mkdirSync(path.join(staging, "bin"), { recursive: true });
          writeFileSync(path.join(staging, "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });
          return { code: 0, stdout: "", stderr: "" };
        }
        // pip 写入口脚本时把当时（暂存）venv 的解释器绝对路径写进 shebang。
        writeFileSync(
          path.join(staging, "bin", "scrapling-mcp"),
          `#!${staging}/bin/python3\nfrom scrapling.cli import mcp\n`,
          { mode: 0o755 },
        );
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io,
    });
    const venv = path.join(dataDir, "runtime", "venv");
    const script = readFileSync(path.join(venv, "bin", "scrapling-mcp"), "utf8");
    expect(script.split("\n")[0]).toBe(`#!${venv}/bin/python3`);
    expect(script).toContain("from scrapling.cli import mcp");
  });

  // movedAside 之后任何一步失败都不能让用户装好的环境消失或留成半成品：旧 venv 必须搬回来。
  // 这里让 state.json 被目录占住，使 readRuntimeState 在换装完成之后炸在回滚分支上。
  it("换装失败时把旧 venv 还原并清掉半成品", async () => {
    const dataDir = tempDir();
    const runtimeDir = path.join(dataDir, "runtime");
    const venv = path.join(runtimeDir, "venv");
    mkdirSync(path.join(venv, "bin"), { recursive: true });
    const marker = path.join(venv, "bin", OLD_MARKER);
    writeFileSync(marker, OLD_MARKER_BODY);
    mkdirSync(path.join(runtimeDir, STATE_FILE), { recursive: true });
    const error = await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({ spawn: venvSpawner([], { code: 0, stdout: "", stderr: "" }) }),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_STATE_CORRUPT");
    expect(readFileSync(marker, "utf8")).toBe(OLD_MARKER_BODY);
    expect(readdirSync(path.join(runtimeDir, ".tmp"))).toStrictEqual([]);
  });

  it("重装 core 保留已有包的 state", async () => {
    const dataDir = tempDir();
    writePackState(dataDir, { browser: "ready" });
    const calls: string[][] = [];
    await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({ spawn: venvSpawner(calls, { code: 0, stdout: "", stderr: "" }) }),
    });
    const state = await readRuntimeState(dataDir);
    expect(state["packs"]).toStrictEqual({ browser: "ready", core: "ready" });

    const malformed = tempDir();
    writePackState(malformed, []);
    await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir: malformed,
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({ spawn: venvSpawner([], { code: 0, stdout: "", stderr: "" }) }),
    });
    const malformedState = await readRuntimeState(malformed);
    expect(malformedState["packs"]).toStrictEqual({ core: "ready" });
  });

  // 旧实现先 rm 旧 venv 再 rename：rename 失败就是「旧包没了、新包没进来」，
  // 用户看到的是一次装到一半的机器。现在旧 venv 先挪开，失败要搬回来。
  it("换 venv 失败时把旧 venv 原样放回去", async () => {
    const dataDir = tempDir();
    const venv = path.join(dataDir, "runtime", "venv");
    mkdirSync(path.join(venv, "bin"), { recursive: true });
    writeFileSync(path.join(venv, "bin", OLD_MARKER), OLD_MARKER_BODY);
    const io = fakeIO({
      spawn: async (argv) => {
        if (argv.includes("venv")) {
          const target = argv.at(-1) ?? "";
          mkdirSync(path.join(target, "bin"), { recursive: true });
          writeFileSync(path.join(target, "bin", "python3"), "#!/bin/sh\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        // pip 报成功，却把暂存 venv 弄没了：随后 rename 到最终位置必然失败。
        const staging = path.dirname(path.dirname(argv[0] ?? ""));
        rmSync(staging, { recursive: true, force: true });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const error = await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io,
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_FAILED");
    expect(readFileSync(path.join(venv, "bin", OLD_MARKER), "utf8")).toBe(OLD_MARKER_BODY);
    // 换装没完成就别写 state：否则下次会以为新 venv 已就绪。
    expect(existsSync(path.join(dataDir, "runtime", STATE_FILE))).toBe(false);
  });

  it("离线安装只读资产目录：不下载，pip 走 --no-index --find-links", async () => {
    const dataDir = tempDir();
    const assets = tempDir();
    const bytes = new TextEncoder().encode("archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    // 浏览器 / curl -O 落盘的是解码后的名字（清单 URL 里 `+` 写成 `%2B`）。
    const archiveName = decodeURIComponent(path.basename(new URL(asset.url).pathname));
    writeFileSync(path.join(assets, archiveName), bytes);
    mkdirSync(path.join(assets, "wheels"), { recursive: true });
    const calls: string[][] = [];
    let downloads = 0;
    const io = fakeIO({
      download: async () => {
        downloads += 1;
        throw new Error("offline: no network expected");
      },
      spawn: async (argv) => {
        calls.push([...argv]);
        if (argv.includes("venv")) {
          const target = argv.at(-1) ?? "";
          mkdirSync(path.join(target, "bin"), { recursive: true });
          writeFileSync(path.join(target, "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      extract: async (_archive, destination) => {
        const bin = path.join(destination, "python", "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "python3"), "#!/bin/sh\n");
      },
    });
    await installCapabilityPack("core", {
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io,
      asset,
      assets,
    });
    expect(downloads).toBe(0);
    const pip = calls.find((argv) => argv.includes("pip"));
    expect(pip).toContain("--no-index");
    expect(pip).toContain("--find-links");
    expect(pip).toContain(path.join(assets, "wheels"));
    expect(existsSync(path.join(dataDir, "runtime", "venv", "bin", "python3"))).toBe(true);
  });

  it("离线归档没有百分号转义时按原名找；缺归档时报 INSTALL_OFFLINE_ASSETS", async () => {
    const dataDir = tempDir();
    const assets = tempDir();
    const bytes = new TextEncoder().encode("asset-bytes");
    const plain = {
      ...runtimeManifest.darwinArm64,
      url: "https://example.test/python.tar.gz",
      sha256: sha256(bytes),
    };
    writeFileSync(path.join(assets, "python.tar.gz"), bytes);
    const io = fakeIO({
      download: async () => {
        throw new Error("offline");
      },
      extract: async (_archive, destination) => {
        const bin = path.join(destination, "python", "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "python3"), "#!/bin/sh\n");
      },
    });
    const installed = await installPython(plain, dataDir, io, assets);
    expect(existsSync(installed.pythonPath)).toBe(true);

    const missing = await installPython(plain, tempDir(), io, tempDir()).catch(
      (error_: unknown) => error_,
    );
    expect((missing as InstallError).code).toBe("INSTALL_OFFLINE_ASSETS");
  });

  it("离线归档哈希不符同样报 INSTALL_HASH_MISMATCH", async () => {
    const assets = tempDir();
    const asset = { ...runtimeManifest.darwinArm64, url: "https://example.test/python.tar.gz" };
    writeFileSync(path.join(assets, "python.tar.gz"), "not the expected bytes");
    const error = await installPython(asset, tempDir(), fakeIO(), assets).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_HASH_MISMATCH");
  });

  it("relocateScripts 只改指向暂存目录的 shebang，认不出的一律不动", async () => {
    const venv = tempDir();
    const staging = path.join(venv, "..", "staging-dir");
    const bin = path.join(venv, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "moved"), `#!${staging}/bin/python3\nprint(1)\n`);
    writeFileSync(path.join(bin, "keep"), "#!/usr/bin/env python3\nprint(2)\n");
    writeFileSync(path.join(bin, "binfile"), "\u0000\u0001binary");
    await relocateScripts(venv, staging);
    expect(readFileSync(path.join(bin, "moved"), "utf8")).toBe(`#!${venv}/bin/python3\nprint(1)\n`);
    expect(readFileSync(path.join(bin, "keep"), "utf8")).toBe("#!/usr/bin/env python3\nprint(2)\n");
    expect(readFileSync(path.join(bin, "binfile"), "utf8")).toBe("\u0000\u0001binary");

    // 没有 bin 目录时安静收工；单行 shebang 没有换行也要改对。
    await expect(relocateScripts(tempDir(), staging)).resolves.toBeUndefined();
    const single = tempDir();
    mkdirSync(path.join(single, "bin"), { recursive: true });
    writeFileSync(path.join(single, "bin", "only"), `#!${staging}/bin/python3`);
    await relocateScripts(single, staging);
    expect(readFileSync(path.join(single, "bin", "only"), "utf8")).toBe(`#!${single}/bin/python3`);
  });

  it("读不了的脚本跳过，不拖垮整次安装", async () => {
    const venv = tempDir();
    const staging = path.join(venv, "..", "staging-dir");
    const bin = path.join(venv, "bin");
    mkdirSync(bin, { recursive: true });
    const locked = path.join(bin, "locked");
    const readable = path.join(bin, "ok");
    writeFileSync(locked, `#!${staging}/bin/python3\n`);
    writeFileSync(readable, `#!${staging}/bin/python3\n`);
    // 用注入的读取器造「读不了」：`chmod 000` 只在 POSIX 上拦读，而这条判的是
    // 「一个脚本读失败不该拖垮整次安装」，与内核对权限的反应无关。
    const readScript = async (file: string): Promise<string> => {
      if (file === locked) {
        throw new Error("EACCES");
      }
      return readFile(file, "utf8");
    };
    await relocateScripts(venv, staging, readScript);
    expect(readFileSync(locked, "utf8")).toContain(staging);
    expect(readFileSync(readable, "utf8")).toContain(`${venv}/bin/python3`);
  });

  it("离线资产目录缺 wheelhouse 时报 INSTALL_OFFLINE_ASSETS", async () => {
    const assets = tempDir();
    const error = await installCapabilityPack("core", {
      dataDir: tempDir(),
      repoRoot: requirementsRepoRoot(),
      io: fakeIO(),
      assets,
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_OFFLINE_ASSETS");
  });

  it("建 venv 失败时报 INSTALL_FAILED", async () => {
    const error = await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir: tempDir(),
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({
        spawn: async () => ({ code: 1, stdout: "", stderr: "venv boom" }),
      }),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_FAILED");
  });

  it("没有 wheel 时映射成 INSTALL_NO_WHEEL", async () => {
    const calls: string[][] = [];
    const error = await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir: tempDir(),
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({
        spawn: venvSpawner(calls, {
          code: 1,
          stdout: "",
          stderr: "ERROR: No matching distribution found for x==1",
        }),
      }),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_NO_WHEEL");
  });

  it("pip 连不上索引时映射成 INSTALL_NETWORK", async () => {
    const calls: string[][] = [];
    const error = await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir: tempDir(),
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({
        spawn: venvSpawner(calls, {
          code: 1,
          stdout: "",
          stderr: "Temporary failure in name resolution",
        }),
      }),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_NETWORK");
  });

  it("其余 pip 失败映射成 INSTALL_FAILED", async () => {
    const calls: string[][] = [];
    const error = await installCore({
      pythonPath: MANAGED_PYTHON,
      dataDir: tempDir(),
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({
        spawn: venvSpawner(calls, { code: 1, stdout: "", stderr: "boom" }),
      }),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_FAILED");
  });
});

describe("readRuntimeState", () => {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺失给空状态（第一次装）", async () => {
    await expect(readRuntimeState(tempDir())).resolves.toStrictEqual({ packs: {} });
  });

  // 缺失与损坏是两件事：缺失是第一次装，损坏是「装过的东西还在，但状态读不出来」。
  // 把后者当空态，下一次写入的合并就会把 browser: ready 抹掉。
  it.each(["{ half", "[]", "null", ""])(
    "state.json 内容 %j 时点名报 INSTALL_STATE_CORRUPT",
    async (broken) => {
      const dataDir = tempDir();
      mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
      const statePath = path.join(dataDir, "runtime", STATE_FILE);
      writeFileSync(statePath, broken);
      const error = await readRuntimeState(dataDir).catch((error_: unknown) => error_);
      expect((error as InstallError).code).toBe("INSTALL_STATE_CORRUPT");
      // 报错必须点名那个文件，否则用户不知道该删谁。
      expect((error as Error).message).toContain(statePath);
    },
  );

  // 读不到 ≠ 没装：路径被目录占住（EISDIR）同样是「已装状态读不出来」，不能当空态。
  it("state.json 被目录占住时报 INSTALL_STATE_CORRUPT", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime", STATE_FILE), { recursive: true });
    const error = await readRuntimeState(dataDir).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_STATE_CORRUPT");
    expect((error as Error).message).toContain(STATE_FILE);
  });
});

const CORE_PACK = "core";
const BROWSER_PACK = "browser";
const MCP_PACK = "mcp";
const REDIS_PACK = "adaptive-redis";

function fakeExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
}

function readyCore(dataDir: string): void {
  const bin = path.join(dataDir, "runtime", "venv", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "python3"), "#!/bin/sh\n");
}

function packSpawner(): InstallerIO["spawn"] {
  return async (argv, options): Promise<SpawnResult> => {
    if (argv.includes("venv")) {
      const target = argv.at(-1) ?? "";
      mkdirSync(path.join(target, "bin"), { recursive: true });
      writeFileSync(path.join(target, "bin", "python3"), "#!/bin/sh\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv.includes("patchright")) {
      const browsers = options?.env?.["PLAYWRIGHT_BROWSERS_PATH"] ?? "";
      mkdirSync(path.join(browsers, CHROMIUM_DIR, CHROME_MAC), { recursive: true });
      writeFileSync(path.join(browsers, CHROMIUM_DIR, CHROME_MAC, "Chromium"), "");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("packStates", () => {
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

  it("非 macOS arm64：六个包全 blocked，安装被拒并点名平台", async () => {
    const restore = mockPlatform("linux", "x64");
    try {
      const states = await packStates(tempDir());
      expect(new Set(Object.values(states))).toStrictEqual(new Set(["blocked"]));
      const error = await installCapabilityPack("core", {
        dataDir: tempDir(),
        repoRoot: requirementsRepoRoot(),
        io: fakeIO(),
      }).catch((error_: unknown) => error_);
      expect((error as InstallError).code).toBe("INSTALL_PACK_BLOCKED");
      expect((error as InstallError).message).toContain("linux/x64");
    } finally {
      restore();
    }
  });

  it("空目录：六个包同态缺失；没有包再被拦", async () => {
    const states = await packStates(tempDir());
    expect(states).toStrictEqual({
      core: "missing",
      browser: "missing",
      search: "missing",
      media: "missing",
      [REDIS_PACK]: "missing",
      mcp: "missing",
    });
  });

  // packs 是数组/字符串这类坏形状时按「没有包」处理：不能把 [] 当记录往下取键。
  it("state 的 packs 是坏形状时按没有包处理", async () => {
    const dataDir = tempDir();
    writePackState(dataDir, []);
    const states = await packStates(dataDir);
    expect(states.core).toBe("missing");
  });

  it("state 标 ready 但文件不在是 corrupt", async () => {
    const dataDir = tempDir();
    writePackState(dataDir, { core: "ready", browser: "ready" });
    const states = await packStates(dataDir);
    expect(states.core).toBe("corrupt");
    expect(states.browser).toBe("corrupt");
  });

  it("文件齐了是 ready，安装中的那一包单独标 installing", async () => {
    const dataDir = tempDir();
    readyCore(dataDir);
    mkdirSync(path.join(dataDir, "runtime", "browsers", CHROMIUM_DIR, CHROME_MAC), {
      recursive: true,
    });
    writeFileSync(
      path.join(dataDir, "runtime", "browsers", CHROMIUM_DIR, CHROME_MAC, "Chromium"),
      "",
    );
    writePackState(dataDir, { core: "ready", browser: "ready" });
    const states = await packStates(dataDir, BROWSER_PACK);
    expect(states).toMatchObject({ core: "ready", browser: "installing" });
  });

  it("只认完整 Chromium，不把 headless shell 当浏览器", async () => {
    const dataDir = tempDir();
    writePackState(dataDir, { browser: "ready" });
    const shell = path.join(dataDir, "runtime", "browsers", "chromium_headless_shell-1");
    mkdirSync(shell, { recursive: true });
    writeFileSync(path.join(shell, "chrome-headless-shell"), "");
    const before = await packStates(dataDir);
    expect(before.browser).toBe("corrupt");

    const full = path.join(dataDir, "runtime", "browsers", CHROMIUM_DIR, "chrome-mac");
    mkdirSync(full, { recursive: true });
    writeFileSync(path.join(full, "Google Chrome for Testing"), "");
    const after = await packStates(dataDir);
    expect(after.browser).toBe("ready");
  });

  it("browsers 路径不是目录时按 corrupt 处理", async () => {
    const dataDir = tempDir();
    writePackState(dataDir, { browser: "ready" });
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    writeFileSync(path.join(dataDir, "runtime", "browsers"), "not a directory");
    const states = await packStates(dataDir);
    expect(states.browser).toBe("corrupt");
  });

  it("非 macOS arm64 上所有包都 blocked", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const arch = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    try {
      const states = await packStates(tempDir());
      expect(Object.values(states).every((state) => state === "blocked")).toBe(true);
      const error = await installCapabilityPack(CORE_PACK, {
        dataDir: tempDir(),
        repoRoot: requirementsRepoRoot(),
        io: fakeIO(),
      }).catch((error_: unknown) => error_);
      expect((error as InstallError).code).toBe("INSTALL_PACK_BLOCKED");
    } finally {
      platform.mockRestore();
      arch.mockRestore();
    }
  });
});

describe("installCapabilityPack", () => {
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

  it("六个包都不再被拦：装 adaptive-redis 走与 core 同一条路", async () => {
    const bytes = new TextEncoder().encode("archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    const calls: string[][] = [];
    await installCapabilityPack(REDIS_PACK, {
      dataDir: tempDir(),
      repoRoot: requirementsRepoRoot(),
      asset,
      io: fakeIO({
        download: async () => bytes,
        spawn: venvSpawner(calls, { code: 0, stdout: "", stderr: "" }),
        extract: async (_archive, destination) => {
          const bin = path.join(destination, "python", "bin");
          await mkdir(bin, { recursive: true });
          await writeFile(path.join(bin, "python3"), "#!/bin/sh\n");
        },
      }),
    });
    expect(calls.some((argv) => argv.includes("pip"))).toBe(true);
  });

  it("已有托管解释器时不重新下载", async () => {
    const dataDir = tempDir();
    fakeExecutable(managedPythonPath(dataDir));
    const progress: string[] = [];
    const io = fakeIO({
      download: async () => {
        throw new Error("should not download");
      },
      spawn: packSpawner(),
    });
    await installCapabilityPack("core", {
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io,
      onProgress: (line) => {
        progress.push(line);
      },
    });
    const states = await packStates(dataDir);
    expect(states.core).toBe("ready");
    expect(progress[0]).toBe("installing core");
    expect(progress.at(-1)).toBe("core ready");
  });

  it("没有托管解释器时先下载并校验清单资产", async () => {
    const dataDir = tempDir();
    const bytes = new TextEncoder().encode("python-archive");
    const asset = { ...runtimeManifest.darwinArm64, sha256: sha256(bytes) };
    const io = fakeIO({
      download: async () => bytes,
      extract: async (_archive, destination) => {
        const bin = path.join(destination, "python", "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(path.join(bin, "python3"), "#!/bin/sh\n");
      },
      spawn: packSpawner(),
    });
    await installCapabilityPack("core", {
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io,
      asset,
    });
    expect(existsSync(managedPythonPath(dataDir))).toBe(true);
    const states = await packStates(dataDir);
    expect(states.core).toBe("ready");
  });

  it("browser 包装完 core 再装 Chromium", async () => {
    const dataDir = tempDir();
    fakeExecutable(managedPythonPath(dataDir));
    await installCapabilityPack(BROWSER_PACK, {
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({ spawn: packSpawner() }),
    });
    const states = await packStates(dataDir);
    expect(states.core).toBe("ready");
    expect(states.browser).toBe("ready");
  });

  it("取消信号在开工前就生效", async () => {
    const error = await installCapabilityPack("core", {
      dataDir: tempDir(),
      repoRoot: requirementsRepoRoot(),
      io: fakeIO(),
      signal: AbortSignal.abort(),
    }).catch((error_: unknown) => error_);
    expect((error as InstallError).code).toBe("INSTALL_FAILED");
  });

  it("repair 与 install 是同一个入口，且能把 corrupt 修成 ready", async () => {
    expect(repairCapabilityPack).toBe(installCapabilityPack);
    const dataDir = tempDir();
    fakeExecutable(managedPythonPath(dataDir));
    writePackState(dataDir, { core: "ready" });
    const before = await packStates(dataDir);
    expect(before.core).toBe("corrupt");
    await repairCapabilityPack(CORE_PACK, {
      dataDir,
      repoRoot: requirementsRepoRoot(),
      io: fakeIO({ spawn: packSpawner() }),
    });
    const after = await packStates(dataDir);
    expect(after.core).toBe("ready");
  });
});

describe("uninstallCapabilityPack", () => {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("卸 core 删 venv 与状态，不碰 adaptive 数据", async () => {
    const dataDir = tempDir();
    readyCore(dataDir);
    writePackState(dataDir, { core: "ready" });
    writeFileSync(path.join(dataDir, STORAGE_DB), "db");
    mkdirSync(path.join(dataDir, "downloads"), { recursive: true });
    await uninstallCapabilityPack(CORE_PACK, { dataDir, purge: false });
    expect(existsSync(path.join(dataDir, "runtime", "venv"))).toBe(false);
    expect(existsSync(path.join(dataDir, "runtime", STATE_FILE))).toBe(false);
    expect(existsSync(path.join(dataDir, STORAGE_DB))).toBe(true);
    expect(existsSync(path.join(dataDir, "downloads"))).toBe(true);
  });

  it("卸 browser 只删浏览器目录与状态位", async () => {
    const dataDir = tempDir();
    readyCore(dataDir);
    mkdirSync(path.join(dataDir, "runtime", "browsers", CHROMIUM_DIR), { recursive: true });
    writePackState(dataDir, { core: "ready", browser: "ready" });
    await uninstallCapabilityPack(BROWSER_PACK, { dataDir, purge: false });
    expect(existsSync(path.join(dataDir, "runtime", "browsers"))).toBe(false);
    expect(existsSync(path.join(dataDir, "runtime", "venv"))).toBe(true);
    const state = await readRuntimeState(dataDir);
    expect(state["packs"]).toStrictEqual({ core: "ready" });
  });

  it("purge 连指纹库与下载一起删", async () => {
    const dataDir = tempDir();
    readyCore(dataDir);
    mkdirSync(path.join(dataDir, "downloads"), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(path.join(dataDir, `${STORAGE_DB}${suffix}`), "db");
    }
    await uninstallCapabilityPack(BROWSER_PACK, { dataDir, purge: true });
    expect(existsSync(path.join(dataDir, STORAGE_DB))).toBe(false);
    expect(existsSync(path.join(dataDir, `${STORAGE_DB}-wal`))).toBe(false);
    expect(existsSync(path.join(dataDir, `${STORAGE_DB}-shm`))).toBe(false);
    expect(existsSync(path.join(dataDir, "downloads"))).toBe(false);
  });

  it("core 系四个包共用一个 venv：撤任何一个都连带撤掉整份", async () => {
    const dataDir = tempDir();
    readyCore(dataDir);
    await uninstallCapabilityPack(REDIS_PACK, { dataDir, purge: false });
    expect(existsSync(path.join(dataDir, "runtime", "venv"))).toBe(false);
    readyCore(dataDir);
    await uninstallCapabilityPack(MCP_PACK, { dataDir, purge: false });
    expect(existsSync(path.join(dataDir, "runtime", "venv"))).toBe(false);

    writeFileSync(path.join(dataDir, "runtime", STATE_FILE), JSON.stringify({ packs: [] }));
    await uninstallCapabilityPack(BROWSER_PACK, { dataDir, purge: false });
    const state = await readRuntimeState(dataDir);
    expect(state["packs"]).toStrictEqual([]);
  });

  it("持锁时卸载被拒 INSTALL_BUSY，且一个文件都不动", async () => {
    const dataDir = tempDir();
    readyCore(dataDir);
    writePackState(dataDir, { core: "ready" });
    const marker = path.join(dataDir, "runtime", "venv", "bin", OLD_MARKER);
    writeFileSync(marker, OLD_MARKER_BODY);
    writeFileSync(path.join(dataDir, "runtime", INSTALL_LOCK), `${process.pid} ${Date.now()}\n`);
    const error = await uninstallCapabilityPack(CORE_PACK, { dataDir, purge: false }).catch(
      (error_: unknown) => error_,
    );
    expect((error as InstallError).code).toBe("INSTALL_BUSY");
    // 卸载是删文件：拿不到锁时一个字节都不该动，venv 与状态位都还在原处。
    expect(readFileSync(marker, "utf8")).toBe(OLD_MARKER_BODY);
    expect(existsSync(path.join(dataDir, "runtime", STATE_FILE))).toBe(true);
  });

  it("外层持锁再调卸载不会自撞 BUSY（同一进程内可重入）", async () => {
    const dataDir = tempDir();
    readyCore(dataDir);
    writePackState(dataDir, { core: "ready" });
    const result = await withInstallLock(dataDir, async () => {
      await uninstallCapabilityPack(CORE_PACK, { dataDir, purge: false });
      return "uninstalled";
    });
    expect(result).toBe("uninstalled");
    expect(existsSync(path.join(dataDir, "runtime", "venv"))).toBe(false);
    expect(existsSync(path.join(dataDir, "runtime", INSTALL_LOCK))).toBe(false);
  });
});
