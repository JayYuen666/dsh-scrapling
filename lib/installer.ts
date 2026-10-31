// 能力包安装器：只写 dataDir/runtime，不碰系统 Python 与用户 Playwright 缓存。

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  open,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { RuntimeAsset } from "./runtime.ts";
import { managedPythonPath, runtimeManifest } from "./runtime.ts";
import type { PackState, RuntimePack } from "./runtime-shape.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATE_FILE = "state.json";

/** 空白切分与 pip 失败措辞。 */
const PIP_NO_WHEEL = /No matching distribution|Could not find a version/iu;
const PIP_NETWORK = /Network|Temporary failure|Connection|timed out/iu;
const STORAGE_DB = "elements_storage.db";

// 只认完整 Chromium 的可执行文件。headless shell 不算：V2 实测它的组件不足，
// StealthyFetcher 起不来（计划里因此禁用 --only-shell）。macOS 的完整版叫
// `Google Chrome for Testing`，Linux / Windows 分别是 chrome / chrome.exe。
/** 首批只支持 macOS arm64；其他平台没有已验证的 Python/浏览器资产，不猜路径。 */
function installerSupported(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

const CHROMIUM_MARKERS: ReadonlySet<string> = new Set([
  "Chromium",
  "chrome",
  "chrome.exe",
  "Google Chrome for Testing",
]);

export type InstallErrorCode =
  | "INSTALL_HASH_MISMATCH"
  | "INSTALL_NO_WHEEL"
  | "INSTALL_NETWORK"
  | "INSTALL_BUSY"
  | "INSTALL_FAILED"
  | "INSTALL_BROWSER_FAILED"
  | "INSTALL_PACK_BLOCKED"
  | "INSTALL_OFFLINE_ASSETS"
  | "INSTALL_LOCK_UNREADABLE"
  | "INSTALL_STATE_CORRUPT";

export class InstallError extends Error {
  public readonly code: InstallErrorCode;

  public constructor(code: InstallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InstallError";
    this.code = code;
  }
}

/** Node 的 errno 异常是带 code 的对象；这里只读 code，不做收窄断言。 */
export function errorCodeOf(error: unknown): string | undefined {
  return isPlainRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 安装过程需要的三件外部能力：下载、解压、起子进程。测试全部替换成替身。 */
export interface InstallerIO {
  download: (url: string) => Promise<Uint8Array>;
  extract: (archive: string, destination: string) => Promise<void>;
  spawn: (argv: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<SpawnResult>;
}

async function run(
  argv: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<SpawnResult> {
  // 子进程只有事件式 API，没有现成 Promise。
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // spawn 失败（二进制不在、无法执行）只发 'error' 事件，'close' 不保证会来：
    // 不接住它，一次 ENOENT 就是未捕获异常。code null 是「没能执行」的信号，
    // 与「执行了但退出非零」分开，调用方据此决定要不要换一条路。
    child.on("error", (error: Error) => {
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 读一段 URL 的字节：先起系统 curl，它不在时退回 fetch。导出是为了测试能注入假 runner。
 *
 * 为什么默认走 curl：它原生认 `http_proxy` / `https_proxy` / `no_proxy` 环境变量，
 * 而 Node 的 fetch 不读这些；强代理网络下「抓取走代理、安装器直连」会表现为
 * 下载永远超时。`--location` 必须有——GitHub release 资产是 302 重定向。
 * spawn 失败（`code` 为 null）才是「curl 不在」的信号；HTTP 层的失败
 * （`--fail` 退非零）如实报 INSTALL_NETWORK，不再重试一遍。
 */
export function createCurlDownloader(runStep: typeof run): (url: string) => Promise<Uint8Array> {
  return async (url) => {
    const target = path.join(os.tmpdir(), `dsh-scrapling-dl-${randomUUID()}`);
    const result = await runStep([
      "curl",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--output",
      target,
      url,
    ]);
    if (result.code === 0) {
      try {
        return new Uint8Array(await readFile(target));
      } finally {
        await rm(target, { force: true });
      }
    }
    await rm(target, { force: true });
    if (result.code !== null) {
      throw new InstallError(
        "INSTALL_NETWORK",
        `curl failed for ${url}: ${result.stderr.slice(0, 400)}`,
      );
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new InstallError("INSTALL_NETWORK", `${url} answered HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

export const defaultInstallerIO: InstallerIO = {
  download: createCurlDownloader(run),
  extract: async (archive, destination) => {
    const result = await run(["tar", "-xzf", archive, "-C", destination]);
    if (result.code !== 0) {
      throw new InstallError("INSTALL_FAILED", `tar failed: ${result.stderr.slice(0, 400)}`);
    }
  },
  spawn: run,
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** OS 级文件锁的最小面；模块缺失或形状不符时返回 null，由调用方报可行动错误。 */
export interface NativeLock {
  tryLock: (fd: number) => boolean;
  unlock: (fd: number) => void;
}

/** 按依赖名加载原生锁；`load` 可注入，单测用它覆盖模块缺失/形状不符两条失败面。 */
export function loadNativeLock(
  load: (id: string) => unknown = createRequire(import.meta.url),
): NativeLock | null {
  let loaded: unknown;
  try {
    loaded = load("fs-native-extensions");
  } catch {
    loaded = undefined;
  }
  if (isPlainRecord(loaded)) {
    const tryLockFn = loaded["tryLock"];
    const unlockFn = loaded["unlock"];
    if (typeof tryLockFn === "function" && typeof unlockFn === "function") {
      return {
        tryLock: (fd) => Boolean(tryLockFn.call(loaded, fd)),
        unlock: (fd) => {
          unlockFn.call(loaded, fd);
        },
      };
    }
  }
  return null;
}

const NATIVE_LOCK = loadNativeLock();

/** 安装锁的句柄面：互斥由 OS 级锁维护，释放动作只负责解锁并关闭句柄。 */
export interface LockHandle {
  release: () => Promise<void>;
}

/** 拿到 fd 后尝试非阻塞排他锁；失败按「锁不可读」收口，交给调用方报可行动错误。 */
export function lockFd(fd: number, lock: NativeLock | null = NATIVE_LOCK): boolean {
  if (lock === null) {
    throw new InstallError("INSTALL_LOCK_UNREADABLE", "fs-native-extensions is not loadable");
  }
  try {
    return lock.tryLock(fd);
  } catch (error) {
    throw new InstallError("INSTALL_LOCK_UNREADABLE", `cannot lock install fd: ${String(error)}`);
  }
}

/**
 * 打开锁文件并尝试排他锁。
 *
 * 锁文件只是句柄载体，互斥由内核维护：进程退出（含被杀）时 fd 关闭、锁随之释放，
 * 因此不存在「陈旧锁由谁接管」的竞态；重复获取同一把锁只会得到 INSTALL_BUSY。
 */
export async function acquireLock(
  lockPath: string,
  lock: NativeLock | null = NATIVE_LOCK,
): Promise<LockHandle> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "a+");
  } catch (error) {
    throw new InstallError(
      "INSTALL_LOCK_UNREADABLE",
      `cannot open install lock ${lockPath}: ${String(error)}`,
    );
  }
  if (!lockFd(handle.fd, lock)) {
    await handle.close();
    throw new InstallError("INSTALL_BUSY", `another install holds ${lockPath}`);
  }
  return {
    release: async () => {
      try {
        lock?.unlock(handle.fd);
      } catch {
        // 句柄已关闭或锁已释放：第二次 release 是空转，关闭句柄仍要走到。
      }
      await handle.close();
    },
  };
}

/** 本进程已经在锁下跑的工作层数（键是解析后的锁路径）。 */
const heldLockDepths = new Map<string, number>();

function releaseLockDepth(key: string, held: number): void {
  if (held <= 1) {
    heldLockDepths.delete(key);
    return;
  }
  heldLockDepths.set(key, held - 1);
}

/**
 * 建 `dataDir/runtime` 并把目录权限收到 0700（spec §11.6）。
 *
 * 这个目录里放的是安装状态、venv 与浏览器缓存：同机其他用户能读，就能看出装了哪些
 * 能力包、解释器在哪。目录已存在时也重收一次 —— 早期版本按 umask 建出来的目录是
 * 0755，只对新目录 chmod 等于让老用户的目录永远是宽的。
 *
 * Windows 没有这组权限位（`chmod` 只改只读位），那里跳过而不是假装收到 0700。
 *
 * @param dataDir - 插件数据目录
 * @returns 建好并收权的 `runtime` 目录
 */
async function ensureRuntimeDir(dataDir: string): Promise<string> {
  const runtimeDir = path.join(dataDir, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  if (process.platform !== "win32") {
    await chmod(runtimeDir, 0o700);
  }
  return runtimeDir;
}

/**
 * 在安装锁下跑一段工作。
 *
 * 安装、卸载、卸载式清理共用同一把 `runtime/install.lock`：它们改的是同一批文件
 * （venv / state.json / browsers），并发进来就会互相踩。
 *
 * 同一进程可以重入：CLI 的卸载路径先取锁、再叫 `uninstallCapabilityPack`，而后者自己
 * 也要取同一把锁。OS 级锁按 fd 互斥，同一进程再开一个句柄同样拿不到，没有这层记账
 * 就是自己挡住自己，卸载永远报 BUSY。
 */
export async function withInstallLock<Result>(
  dataDir: string,
  work: () => Promise<Result>,
): Promise<Result> {
  const runtimeDir = path.join(dataDir, "runtime");
  const lockPath = path.join(runtimeDir, "install.lock");
  const key = path.resolve(lockPath);
  const depth = heldLockDepths.get(key) ?? 0;
  // 已经在锁下：只记层数，不再开句柄、不再碰文件锁。
  if (depth > 0) {
    heldLockDepths.set(key, depth + 1);
    try {
      return await work();
    } finally {
      releaseLockDepth(key, depth + 1);
    }
  }
  await ensureRuntimeDir(dataDir);
  const handle = await acquireLock(lockPath);
  heldLockDepths.set(key, 1);
  try {
    return await work();
  } finally {
    releaseLockDepth(key, 1);
    await handle.release();
  }
}

export interface PythonInstallResult {
  pythonPath: string;
  version: string;
}

/**
 * 下载、校验、解压托管 Python。
 *
 * @param asset - 已验资产（含 SHA256）
 * @param dataDir - 数据目录
 * @param io - 安装 IO
 * @returns 托管解释器路径
 */
/**
 * 离线安装时从资产目录里取 Python 归档。
 *
 * 文件名取清单 URL 的最后一段：那一份就是安装器原本要下载的东西，哈希校验照旧，所以离线
 * 与联网走的是同一条校验；文件不在就是一条点名的失败，而不是退回联网。
 */
async function offlineArchive(assets: string, url: string): Promise<Uint8Array> {
  if (!URL.canParse(url)) {
    throw new InstallError(
      "INSTALL_OFFLINE_ASSETS",
      `manifest archive URL is not parseable: ${url}`,
    );
  }
  const raw = path.basename(new URL(url).pathname);
  // 清单 URL 里 `+` 是 `%2B`；浏览器 / curl -O 落盘时用的是解码后的名字，两种都认。
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new InstallError(
      "INSTALL_OFFLINE_ASSETS",
      `manifest archive name has invalid percent-encoding: ${raw}`,
    );
  }
  const names = raw === decoded ? [raw] : [decoded, raw];
  const found = await Promise.all(
    names.map(async (name) => ({
      name,
      bytes: await readFile(path.join(assets, name)).catch(() => null),
    })),
  );
  const bytes = found.find((item) => item.bytes !== null)?.bytes;
  if (bytes === undefined || bytes === null) {
    throw new InstallError(
      "INSTALL_OFFLINE_ASSETS",
      `offline python archive missing under ${assets}: expected ${names.join(" or ")}`,
    );
  }
  return new Uint8Array(bytes);
}

export async function installPython(
  asset: RuntimeAsset,
  dataDir: string,
  io: InstallerIO,
  assets?: string,
): Promise<PythonInstallResult> {
  return withInstallLock(dataDir, async () => {
    const tmpRoot = path.join(dataDir, "runtime", ".tmp", randomUUID());
    await mkdir(tmpRoot, { recursive: true });
    const archive = path.join(tmpRoot, "python.tar.gz");
    try {
      const bytes =
        assets === undefined
          ? await io.download(asset.url)
          : await offlineArchive(assets, asset.url);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== asset.sha256) {
        throw new InstallError(
          "INSTALL_HASH_MISMATCH",
          `python archive hash ${digest} does not match ${asset.sha256}`,
        );
      }
      // 临时文件先落盘：解压器需要真实路径，也保证失败时能整段清掉。
      await writeFile(archive, bytes);
      const extractDir = path.join(tmpRoot, "extract");
      await mkdir(extractDir, { recursive: true });
      await io.extract(archive, extractDir);
      const layout = path.join(extractDir, "python");
      const source = (await exists(path.join(layout, "bin", "python3"))) ? layout : extractDir;
      const target = path.dirname(path.dirname(managedPythonPath(dataDir)));
      await rm(target, { recursive: true, force: true });
      await mkdir(path.dirname(target), { recursive: true });
      // 必须解引用：python-build-standalone 的 `python3` 是相对软链，原样 cp 会让目标
      // 指进临时解压目录 —— 那个目录在 finally 里被删，托管解释器当场变成断链（真机 smoke 抓到）。
      await cp(source, target, { recursive: true, dereference: true });
      const pythonPath = managedPythonPath(dataDir);
      if (!(await exists(pythonPath))) {
        throw new InstallError("INSTALL_FAILED", "python archive did not contain bin/python3");
      }
      return { pythonPath, version: asset.pythonVersion };
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
      // 只在空了的时候撤掉 .tmp；别的安装可能正占着它。
      await rmdir(path.join(dataDir, "runtime", ".tmp")).catch(() => null);
    }
  });
}

/**
 * 读安装状态。
 *
 * 文件不存在 → 空状态（第一次装）。但「读到了却不是一份完整 JSON 对象」不能当成空状态：
 * 若把半份 JSON 当「什么都没装」，下一次安装的合并就会把 browser 的 ready 标记抹掉，
 * 而用户看到的是「装过的东西不见了」。所以损坏一律点名报错，让人删掉它重装，不静默降级。
 */
export async function readRuntimeState(dataDir: string): Promise<Record<string, unknown>> {
  const statePath = path.join(dataDir, "runtime", STATE_FILE);
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    // Node 的文件错误总是带 code 的 ErrnoException：ENOENT 是「第一次装」，
    // 其余（EACCES / EISDIR / 路径被占）都是「读不到已经装上的状态」——一律点名报损坏，
    // 不能因为错误类型没对上就把它当空态（那会把下一次合并里的 browser: ready 抹掉）。
    if (errorCodeOf(error) === "ENOENT") {
      return { packs: {} };
    }
    throw new InstallError(
      "INSTALL_STATE_CORRUPT",
      `cannot read ${statePath}: ${String(error)}; delete it and install again`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InstallError(
      "INSTALL_STATE_CORRUPT",
      `${statePath} is not valid JSON; delete it and install again`,
      { cause: error },
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new InstallError(
      "INSTALL_STATE_CORRUPT",
      `${statePath} does not hold a JSON object; delete it and install again`,
    );
  }
  return parsed;
}

/**
 * 原子落盘状态：先写同目录临时文件再 rename。
 *
 * 直接 writeFile 到 state.json 时，进程在 truncate 之后、写完之前被杀就留下半份 JSON。
 * rename 是同一文件系统内的原子替换 —— 读到的要么是旧整份、要么是新整份。
 */
async function writeRuntimeState(dataDir: string, state: Record<string, unknown>): Promise<void> {
  const runtimeDir = await ensureRuntimeDir(dataDir);
  const target = path.join(runtimeDir, STATE_FILE);
  const staging = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, JSON.stringify(state, null, 2), "utf8");
    await rename(staging, target);
  } finally {
    // rename 成功后 staging 已不在；失败时这里清掉半成品。清不掉（只读目录）时
    // 留下的只是一份临时文件，不该顶替真正的原因。
    try {
      await rm(staging, { force: true });
    } catch {
      // 尽力而为。
    }
  }
}

/**
 * 建 venv 并安装 core 依赖。
 *
 * 先装进临时 venv，成功后才替换旧 venv —— 中断或失败时旧包仍然可用。
 *
 * @param options - 解释器、数据目录、包根与 IO
 */
/**
 * 把 venv 里 console script 的 shebang 从暂存路径改到最终路径。
 *
 * pip 写入口脚本时把解释器的**绝对路径**写进 shebang，而这个 venv 先建在
 * `.tmp/venv-<uuid>`、装完再整体 rename 到 `runtime/venv`。不改这一行，`scrapling-mcp`
 * 这类入口一执行就是 `bad interpreter: .../.tmp/venv-…/bin/python3`（真机装 mcp 包时撞到）。
 * 只改以 shebang 开头、且指向暂存目录的普通文件：`bin/python*` 是指向托管解释器的符号
 * 链接，二进制与无 shebang 的文件都不碰。
 *
 * 「读脚本」这一步可以由调用方替换：门禁用它造出读不了的文件（Windows 上 `chmod 000`
 * 并不拦读），而判的是「一个脚本读失败不该拖垮整次安装」，与内核对权限的反应无关。
 */
async function rewriteShebangs(
  scanDir: string,
  from: string,
  to: string,
  readScript: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<void> {
  const binDir = path.join(scanDir, "bin");
  const stale = `#!${from}/`;
  const entries = await readdir(binDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(binDir, entry.name));
  await Promise.all(
    files.map(async (file) => {
      // 读不了（权限、编码）就跳过这一个：改不动一个脚本不该让整次安装失败。
      const text = await readScript(file).catch(() => "");
      const newline = text.indexOf("\n");
      const head = newline === -1 ? text : text.slice(0, newline);
      if (!head.startsWith(stale)) {
        return;
      }
      const tail = newline === -1 ? "" : text.slice(newline);
      await writeFile(file, `#!${to}/${head.slice(stale.length)}${tail}`, "utf8");
    }),
  );
}

export async function relocateScripts(
  venv: string,
  staging: string,
  readScript: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<void> {
  return rewriteShebangs(venv, staging, venv, readScript);
}

/**
 * core 安装的收尾：清掉暂存目录；换装没落地时先删半成品、再把旧 venv 搬回原位。
 *
 * 全部尽力而为 —— 收尾失败不该掩盖调用方真正要看到的那个错误（比如 state.json 写不进去）。
 *
 * @param paths - 最终 venv、旧 venv 的暂存位、本次的暂存 venv
 * @param restore - 是否要把旧 venv 搬回原位（rename 或状态写入失败时为真）
 */
async function finishCoreInstall(
  paths: { venv: string; previousVenv: string; staging: string },
  restore: boolean,
): Promise<void> {
  let restoreFailed = false;
  if (restore) {
    try {
      await rm(paths.venv, { recursive: true, force: true });
    } catch {
      // 半成品清不掉也要继续试还原。
    }
    try {
      await rename(paths.previousVenv, paths.venv);
    } catch {
      // 还原失败：旧 venv 还留在 .tmp/venv-previous-*。那是用户原本可用的环境，
      // 必须留着 —— 下面那段收尾清理会把它删掉，所以这一支要跳过。
      restoreFailed = true;
    }
  }
  if (!restoreFailed) {
    try {
      await rm(paths.previousVenv, { recursive: true, force: true });
    } catch {
      // 收尾清理尽力而为。
    }
  }
  try {
    await rm(paths.staging, { recursive: true, force: true });
  } catch {
    // 同上。
  }
}

export async function installCore(options: {
  pythonPath: string;
  dataDir: string;
  repoRoot: string;
  io: InstallerIO;
  /** 离线资产目录：给了就只从 `<assets>/wheels` 取 wheel，pip 不许联网。 */
  assets?: string;
}): Promise<void> {
  const { io } = options;
  await withInstallLock(options.dataDir, async () => {
    const runtimeDir = await ensureRuntimeDir(options.dataDir);
    const venv = path.join(runtimeDir, "venv");
    const staging = path.join(runtimeDir, ".tmp", `venv-${randomUUID()}`);
    // 旧 venv 挪去这里而不是直接删：换装失败时要能把它原样搬回来。
    const previousVenv = path.join(runtimeDir, ".tmp", `venv-previous-${randomUUID()}`);
    const requirements = path.join(options.repoRoot, "py", "runtime-requirements.txt");
    let movedAside = false;
    // 「换装完成」以状态写成功为准，不是以 rename 成功为准：venv 换过去之后还要把
    // state.json 写成功，那才算这一次安装真的落地。rename 成功而状态写入失败时若就此收工，
    // 磁盘上留着的是「新 venv + 旧状态/坏状态」，用户看到安装失败、包却半新半旧。
    let committed = false;
    try {
      const created = await io.spawn([options.pythonPath, "-m", "venv", staging]);
      if (created.code !== 0) {
        throw new InstallError("INSTALL_FAILED", `venv failed: ${created.stderr.slice(0, 400)}`);
      }
      const stagingPython = path.join(staging, "bin", "python3");
      const offlineArgs =
        options.assets === undefined
          ? []
          : ["--no-index", "--find-links", path.join(options.assets, "wheels")];
      const installed = await io.spawn(
        [
          stagingPython,
          "-m",
          "pip",
          "install",
          "--only-binary=:all:",
          "--require-hashes",
          "-r",
          requirements,
          ...offlineArgs,
        ],
        { env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" } },
      );
      if (installed.code !== 0) {
        const text = `${installed.stdout}\n${installed.stderr}`;
        if (PIP_NO_WHEEL.test(text)) {
          throw new InstallError("INSTALL_NO_WHEEL", "a dependency has no wheel for this platform");
        }
        if (PIP_NETWORK.test(text)) {
          throw new InstallError("INSTALL_NETWORK", "pip could not reach the package index");
        }
        throw new InstallError("INSTALL_FAILED", `pip failed: ${installed.stderr.slice(0, 400)}`);
      }
      // 先把 shebang 改在暂存目录里：这一步失败时旧 venv 还一动不动。
      await rewriteShebangs(staging, staging, venv);
      // 旧 venv 先挪开而不是删掉，rename 失败（权限、目标被占）时才还原得回来。
      try {
        if (await exists(venv)) {
          await rename(venv, previousVenv);
          movedAside = true;
        }
        await rename(staging, venv);
      } catch (error) {
        throw new InstallError("INSTALL_FAILED", `cannot replace ${venv}: ${String(error)}`, {
          cause: error,
        });
      }
      // 合并而不是覆盖：重装 core 不能把已经装好的 browser 标记抹掉。
      const previous = await readRuntimeState(options.dataDir);
      const packs = {
        ...(isPlainRecord(previous["packs"]) ? previous["packs"] : {}),
        core: "ready",
      };
      await writeRuntimeState(options.dataDir, {
        ...previous,
        packs,
        python: options.pythonPath,
      });
      committed = true;
    } finally {
      // 「换装没落地」= 旧 venv 已挪开、而这次安装又没走到 committed：
      // rename 或状态写入失败都算，必须把旧 venv 搬回来。
      await finishCoreInstall({ venv, previousVenv, staging }, movedAside && !committed);
    }
  });
}

/** 目录里是否有 Chromium 的可执行标记；安装后的验收与 status 的现量共用这一条判据。 */
async function hasChromiumUnder(browsersPath: string): Promise<boolean> {
  try {
    const entries = await readdir(browsersPath, { recursive: true });
    return entries.some((entry) => CHROMIUM_MARKERS.has(path.basename(entry)));
  } catch {
    return false;
  }
}

async function chromiumInstalled(dataDir: string): Promise<boolean> {
  return hasChromiumUnder(path.join(dataDir, "runtime", "browsers"));
}

/**
 * 安装完整 Chromium 到 dataDir/runtime/browsers。
 *
 * 必须装完整版：`--only-shell` 缺的组件会让 Scrapling 的 StealthyFetcher 起不来（V2）。
 *
 * @param options - 托管解释器、数据目录与 IO
 * @returns 浏览器目录
 */
export async function installBrowser(options: {
  pythonPath: string;
  dataDir: string;
  io: InstallerIO;
}): Promise<{ browsersPath: string }> {
  const { io } = options;
  return withInstallLock(options.dataDir, async () => {
    const browsersPath = path.join(options.dataDir, "runtime", "browsers");
    await mkdir(browsersPath, { recursive: true });
    const installed = await io.spawn(
      [options.pythonPath, "-m", "patchright", "install", "chromium"],
      { env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath } },
    );
    if (installed.code !== 0) {
      throw new InstallError(
        "INSTALL_BROWSER_FAILED",
        `chromium install failed: ${installed.stderr.slice(0, 400)}`,
      );
    }
    if (!(await hasChromiumUnder(browsersPath))) {
      throw new InstallError(
        "INSTALL_BROWSER_FAILED",
        `no chromium executable found under ${browsersPath}`,
      );
    }
    const previous = await readRuntimeState(options.dataDir);
    const packs = {
      ...(isPlainRecord(previous["packs"]) ? previous["packs"] : {}),
      browser: "ready",
    };
    await writeRuntimeState(options.dataDir, { ...previous, packs, browsersPath });
    return { browsersPath };
  });
}

/** state 标了 ready、文件却不在，就是 corrupt —— 这正是 repair 要修的那一档。 */
function stateOf(marked: unknown, installed: boolean): PackState {
  if (marked !== "ready") {
    return "missing";
  }
  return installed ? "ready" : "corrupt";
}

/**
 * 六个能力包现在处于哪一档。
 *
 * `search` / `media` / `adaptive-redis` 都以 core 的 Python 环境为载体，因此跟随 core 的
 * 状态；`mcp` 与 core 共用同一 Python 环境，跟随 core 的状态。`installing` 由调用方给出（作业正在跑的那一包），
 * 文件态在安装完成前本来就还是旧的。
 *
 * @param dataDir - 数据目录
 * @param installing - 正在安装的包，可选
 * @returns 每个包的状态
 */
export async function packStates(
  dataDir: string,
  installing?: RuntimePack,
): Promise<Record<RuntimePack, PackState>> {
  if (!installerSupported()) {
    return {
      core: "blocked",
      browser: "blocked",
      search: "blocked",
      media: "blocked",
      "adaptive-redis": "blocked",
      mcp: "blocked",
    };
  }
  const state = await readRuntimeState(dataDir);
  const raw = state["packs"];
  const packs: Record<string, unknown> = isPlainRecord(raw) ? raw : {};
  const core = stateOf(
    packs["core"],
    await exists(path.join(dataDir, "runtime", "venv", "bin", "python3")),
  );
  const browser = stateOf(packs["browser"], await chromiumInstalled(dataDir));
  const result: Record<RuntimePack, PackState> = {
    core,
    browser,
    search: core,
    media: core,
    // adaptive-redis 的客户端与官方 server 的二进制都与 core 同住一个 venv：它们各自是
    // 一条依赖 / 一个入口，钉在 runtime-requirements 里，所以这两包的就绪面就是 core 的面。
    "adaptive-redis": core,
    mcp: core,
  };
  if (installing !== undefined) {
    result[installing] = "installing";
  }
  return result;
}

export interface PackInstallOptions {
  dataDir: string;
  repoRoot: string;
  io: InstallerIO;
  /** 取消只在步骤之间生效：正在跑的 pip / tar 这一拍不可中断。 */
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /** 测试注入的清单资产；生产一律用 runtimeManifest 里已验的那一份。 */
  asset?: RuntimeAsset;
  /** 离线资产目录：`<dir>/<清单归档名>` 与 `<dir>/wheels/`，给定时全程不联网。 */
  assets?: string;
}

export interface PackUninstallOptions {
  dataDir: string;
  purge: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new InstallError("INSTALL_FAILED", "install cancelled");
  }
}

/** 已有托管解释器就复用，没有才下载；修复浏览器包不必重下一份 Python。 */
async function ensurePython(
  dataDir: string,
  io: InstallerIO,
  signal: AbortSignal | undefined,
  asset: RuntimeAsset,
  assets?: string,
): Promise<string> {
  const managed = managedPythonPath(dataDir);
  if (await exists(managed)) {
    return managed;
  }
  throwIfAborted(signal);
  const installed = await installPython(asset, dataDir, io, assets);
  return installed.pythonPath;
}

/**
 * 安装一个能力包。
 *
 * `browser` 先装 core 再装 Chromium；其余包以 core 的 Python 环境为载体，`mcp` 也一样。
 * 数据目录里的指纹库、下载与登录态全程不动。
 *
 * @param pack - 能力包
 * @param options - 数据目录、包根、IO、取消信号与进度出口
 */
export async function installCapabilityPack(
  pack: RuntimePack,
  options: PackInstallOptions,
): Promise<void> {
  if (!installerSupported()) {
    throw new InstallError(
      "INSTALL_PACK_BLOCKED",
      `runtime packs are verified on macOS arm64 only; this host is ${process.platform}/${process.arch}`,
    );
  }
  const { dataDir, repoRoot, io, signal, onProgress, assets } = options;
  const asset = options.asset ?? runtimeManifest.darwinArm64;
  if (assets !== undefined && !(await exists(path.join(assets, "wheels")))) {
    throw new InstallError(
      "INSTALL_OFFLINE_ASSETS",
      `offline wheelhouse missing: ${path.join(assets, "wheels")}`,
    );
  }
  throwIfAborted(signal);
  onProgress?.(`installing ${pack}`);
  const pythonPath = await ensurePython(dataDir, io, signal, asset, assets);
  throwIfAborted(signal);
  onProgress?.(`installing core packages into ${pythonPath}`);
  await installCore({
    pythonPath,
    dataDir,
    repoRoot,
    io,
    ...(assets === undefined ? {} : { assets }),
  });
  throwIfAborted(signal);
  if (pack === "browser") {
    onProgress?.("installing full chromium");
    // patchright 装在 venv 里，托管 Python 自己没有它 —— 浏览器安装必须走 venv 解释器。
    const venvPython = path.join(dataDir, "runtime", "venv", "bin", "python3");
    await installBrowser({ pythonPath: venvPython, dataDir, io });
    throwIfAborted(signal);
  }
  onProgress?.(`${pack} ready`);
}

/** 修复 = 重新安装一遍；数据目录里的用户数据不参与这个过程。 */
export const repairCapabilityPack: typeof installCapabilityPack = installCapabilityPack;

/**
 * 卸载一个能力包。
 *
 * 只删运行时文件；`purge` 才连同 adaptive 指纹库、下载与登录态一起删。`mcp` 与 `core` /
 * `search` / `media` 共用同一个 venv，所以撤任何一个都走同一条路：删 venv。状态文件里对应
 * 的包标记同步摘掉，下一次 status 会按文件现量。
 *
 * @param pack - 能力包
 * @param options - 数据目录与是否清数据
 */
export async function uninstallCapabilityPack(
  pack: RuntimePack,
  options: PackUninstallOptions,
): Promise<void> {
  // 卸载与安装写的是同一批文件（venv / browsers / state.json），必须共用同一把锁。
  // CLI 的卸载路径已经在外层取过锁，这里靠 withInstallLock 的进程内重入才不会被自己挡住。
  await withInstallLock(options.dataDir, async () => {
    const runtimeDir = path.join(options.dataDir, "runtime");
    // browser 的安装面是 browsers/，其余包共用整份 venv。
    const removedDir = pack === "browser" ? "browsers" : "venv";
    await rm(path.join(runtimeDir, removedDir), { recursive: true, force: true });
    if (options.purge) {
      await Promise.all(
        ["", "-wal", "-shm"].map((suffix) =>
          rm(path.join(options.dataDir, `${STORAGE_DB}${suffix}`), { force: true }),
        ),
      );
      await rm(path.join(options.dataDir, "downloads"), { recursive: true, force: true });
    }
    // 只摘被卸的那一包，其余标记原样保留：core 卸载连带删掉 venv，但 browser 的
    // chromium 与 browsersPath 还在盘上；整份删掉状态会让它显示 missing 并重下几百 MB。
    const state = await readRuntimeState(options.dataDir);
    if (!isPlainRecord(state["packs"])) {
      return;
    }
    const packs = { ...state["packs"] };
    Reflect.deleteProperty(packs, pack);
    await writeRuntimeState(options.dataDir, { ...state, packs });
  });
}
