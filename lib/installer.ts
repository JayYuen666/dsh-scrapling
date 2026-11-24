// 能力包安装器：只写 dataDir/runtime，不碰系统 Python 与用户 Playwright 缓存。

import { AsyncLocalStorage } from "node:async_hooks";
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
import {
  executable,
  managedPythonPath,
  managedVenvPythonPath,
  runtimeManifest,
} from "./runtime.ts";
import type { PackState, RuntimePack } from "./runtime-shape.ts";
import { redactUrlSecrets } from "./url-policy.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATE_FILE = "state.json";

/** pip 失败输出归类：没有轮子 vs 网络不通。 */
const PIP_NO_WHEEL = /No matching distribution|Could not find a version/iu;
const PIP_NETWORK = /Network|Temporary failure|Connection|timed out/iu;
const STORAGE_DB = "elements_storage.db";

/**
 * 外部命令的 stderr 进文案之前先脱敏。
 *
 * 这些 stderr 会进 `InstallError` 的消息、再进作业输出与模型上下文，而它们**会原样回显
 * 带凭据的地址**：`pip` 打 `Looking in indexes: https://user:token@mirror/simple` 与
 * `WARNING: The index url "…" seems invalid`，`curl` 打它请求的那条 URL。用户在企业
 * 镜像里把 token 写进 `PIP_INDEX_URL` 是常规做法，于是失败一次就等于把 token 写进会话日志。
 *
 * 闸门放在这里而不是各个调用点：四条 stderr 通路共用同一处，新增一条也不会漏。
 *
 * @param text - 命令的原始 stderr
 * @returns 遮掉 userinfo 之后的文本；没有凭据时原样返回
 */
function safeStderr(text: string): string {
  return redactUrlSecrets(text);
}

/** 首批只支持 macOS arm64；其他平台没有已验证的 Python/浏览器资产，不猜路径。 */
function installerSupported(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

// 只认完整 Chromium 的可执行文件。headless shell 不算：V2 实测它的组件不足，
// StealthyFetcher 起不来（计划里因此禁用 --only-shell）。macOS 的完整版叫
// `Google Chrome for Testing`，Linux / Windows 分别是 chrome / chrome.exe。
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
  | "INSTALL_CANCELLED"
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

/**
 * 单条子进程的兜底超时。
 *
 * 必须存在：`spawn` 起的东西是对端（curl / pip / tar），对端不回包时子进程会一直活着，
 * `close` 永不来，`run` 的 Promise 永不 resolve —— 安装界面就永久停在 “installing …”，
 * 用户既看不到失败、也没有退出的路。卡住与失败在界面上是两回事，而卡住更难自查。
 *
 * 取值比最慢的正常路径还宽一档（`pip install` 装 scrapling 全家在国内网络下见过几分钟）：
 * 这里要的是「不会永远挂着」，不是给某个具体步骤定预算。
 */
const SPAWN_TIMEOUT_MS = 30 * 60_000;

/** 下载的超时：连接与整体分开给，卡在握手与卡在传输的出路不同。 */
const DOWNLOAD_CONNECT_TIMEOUT_S = 20;
const DOWNLOAD_MAX_TIME_S = 900;

/**
 * 子进程输出留多少。
 *
 * `pip install` 失败时能把几 MB 日志刷出来，而调用方只取前 400 字符做归因（`INSTALL_*`
 * 那几条 message）。不封顶就是「留一整个 MB 的字符串只为截前 400 字符」，同时在长安装里
 * 白吃内存。封口留一句标记，读日志的人知道后面还有内容被丢掉。
 */
const MAX_CAPTURED_OUTPUT = 64 * 1024;
const OUTPUT_TRUNCATED = "\n[installer] 输出过长，后续内容已丢弃";

/**
 * 往已收集的输出后面追加一段，超上限就截尾一次并挂标记。
 *
 * 判「已经截过」用标记本身，不用长度：分块边界恰好落在上限上时（`pip` 的缓冲常常就是整块
 * 刷），按长度判会让第一次不多不少等于上限、此后再也不挂标记 —— 日志看起来像「本来就这么多」，
 * 而真相是后面还有几 MB 被丢了。
 *
 * @param previous - 已收集的输出
 * @param chunk - 新到的一段
 * @returns 追加后的输出（可能已被截尾并带标记）
 */
function appendCapped(previous: string, chunk: string): string {
  if (previous.endsWith(OUTPUT_TRUNCATED)) {
    return previous;
  }
  const next = previous + chunk;
  return next.length > MAX_CAPTURED_OUTPUT
    ? `${next.slice(0, MAX_CAPTURED_OUTPUT)}${OUTPUT_TRUNCATED}`
    : next;
}

interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * 起一条子进程并收集输出（带兜底超时与输出封顶）。
 *
 * 导出是给单测用的：超时与封顶这两条只能靠真起一个不结束 / 话很多的子进程来判，
 * 替身里写不出「close 永不来」。生产侧只经 `defaultInstallerIO.spawn` 与
 * `createCurlDownloader` 用到它。
 *
 * @param argv - 命令与参数
 * @param options - 环境变量与超时
 * @returns 退出码与两端输出
 */
export async function runOnce(
  argv: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? SPAWN_TIMEOUT_MS;
  // 子进程只有事件式 API，没有现成 Promise。
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // 超时句柄与 `finish` 互相引用，所以先留一个可变槽位：`const` 拿不掉
    // （`finish` 要读它、`setTimeout` 要写它），`let` 又会撞 prefer-const。
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (result: SpawnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      // 不先判 `!== undefined`：`clearTimeout(undefined)` 本来就是空操作，而那个判断
      // 只在「超时句柄还没装上就 finish」时才为假 —— 那条路永远不会发生（`spawn` 的
      // 'error' 也是在下一拍才发），多一个恒真的分支只是给覆盖率留一个假洞。
      clearTimeout(deadline.timer);
      resolve(result);
    };
    // 超时用 `code: null` 而不是某个退出码：它与「没能执行」走同一条失败分支，调用方
    // 据此换路或报 INSTALL_NETWORK，不用为「超时」再学一个新码。stderr 里留一句人话，
    // 否则界面只说「失败」而不说为什么。
    deadline.timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        code: null,
        stdout,
        stderr: `${stderr}\n[installer] ${String(timeoutMs)}ms 内没有结束，已终止`,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    // spawn 失败（二进制不在、无法执行）只发 'error' 事件，'close' 不保证会来：
    // 不接住它，一次 ENOENT 就是未捕获异常。code null 是「没能执行」的信号，
    // 与「执行了但退出非零」分开，调用方据此决定要不要换一条路。
    child.on("error", (error: Error) => {
      finish({ code: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
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
export function createCurlDownloader(
  runStep: typeof runOnce,
): (url: string) => Promise<Uint8Array> {
  return async (url) => {
    const target = path.join(os.tmpdir(), `dsh-scrapling-dl-${randomUUID()}`);
    // 两个超时都必须显式给：curl 自己不会超时，对端不回包时它就一直挂着，而 `run` 的
    // 兜底超时是「别永远挂住」那一道，不是下载该有的等待时间。`--connect-timeout` 管
    // 握手（DNS / TCP / TLS），`--max-time` 管整段（含慢速传输卡住）。
    const result = await runStep([
      "curl",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      String(DOWNLOAD_CONNECT_TIMEOUT_S),
      "--max-time",
      String(DOWNLOAD_MAX_TIME_S),
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
        `curl failed for ${redactUrlSecrets(url)}: ${safeStderr(result.stderr).slice(0, 400)}`,
      );
    }
    // curl 不在（或它自己超时被杀）时才走到这里。fetch 也要带 signal：它同样会对
    // 不回包的对端一直等，而这条兜底路径原先一个超时都没有。
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_MAX_TIME_S * 1000) });
    if (!response.ok) {
      throw new InstallError(
        "INSTALL_NETWORK",
        `${redactUrlSecrets(url)} answered HTTP ${response.status}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

export const defaultInstallerIO: InstallerIO = {
  download: createCurlDownloader(runOnce),
  extract: async (archive, destination) => {
    const result = await runOnce(["tar", "-xzf", archive, "-C", destination]);
    if (result.code !== 0) {
      throw new InstallError(
        "INSTALL_FAILED",
        `tar failed: ${safeStderr(result.stderr).slice(0, 400)}`,
      );
    }
  },
  spawn: runOnce,
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** OS 级文件文件锁的最小类型；模块缺失或形状不符时返回 null，由调用方报可行动错误。 */
export interface NativeLock {
  tryLock: (fd: number) => boolean;
  unlock: (fd: number) => void;
}

/** 按依赖名加载原生锁；`load` 可注入，单测用它覆盖模块缺失/形状不符两条失败。 */
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

/** 安装锁的句柄类型：互斥由 OS 级锁维护，释放动作只负责解锁并关闭句柄。 */
export interface LockHandle {
  release: () => Promise<void>;
}

/** 拿到 fd 后尝试非阻塞排他锁；失败按「锁不可读」统一处理，交给调用方报可行动错误。 */
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
  let locked: boolean;
  try {
    locked = lockFd(handle.fd, lock);
  } catch (error) {
    // `lockFd` 抛的是 INSTALL_LOCK_UNREADABLE（原生模块不可用 / tryLock 自身抛错），
    // 而不是「锁被占」。句柄已经开在这里了：不关就每次失败漏一个 fd，用户反复重试
    // 会把进程的 fd 用尽，之后所有安装连带其它文件操作都以 EMFILE 失败 —— 而报错信息
    // 说的是「锁不可读」，现场完全对不上。
    await handle.close();
    throw error;
  }
  if (!locked) {
    await handle.close();
    throw new InstallError("INSTALL_BUSY", `another install holds ${lockPath}`);
  }
  return {
    release: async () => {
      try {
        lock?.unlock(handle.fd);
      } catch {
        // 句柄已关闭或锁已释放：第二次 release 不执行任何操作，关闭句柄仍要走到。
      }
      await handle.close();
    },
  };
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
 * 当前异步调用链已经持有的锁（键是解析后的锁路径）。
 *
 * 只能用 `AsyncLocalStorage`，不能用进程级的「层数 Map」：层数分不清「同一调用链的嵌套
 * 重入」与「同进程里的两个并发调用」—— 后者看到层数 > 0 就直接放行，于是两条安装并行改
 * 同一份 venv 与 state.json，而 OS 锁在那里根本没起到作用。反过来，两个并发调用各自
 * 结束时的减层还会互相覆盖（外层删键、内层把键写回 1），留下一份永不清空的深度记录，
 * 此后跨进程互斥静默失效。
 */
const heldLockChains = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * 在安装锁下跑一段工作。
 *
 * 安装、卸载、卸载式清理共用同一把 `runtime/install.lock`：它们改的是同一批文件
 * （venv / state.json / browsers），并发进来就会互相踩。
 *
 * 同一**调用链**可以重入：CLI 的卸载路径先取锁、再叫 `uninstallCapabilityPack`，而后者
 * 自己也要取同一把锁。OS 级锁按 fd 互斥，同一进程再开一个句柄同样拿不到，没有这层记录
 * 就是自己挡住自己，卸载永远报 BUSY。判据是「这条异步链路上是否已经持锁」，而不是
 * 「进程里有没有人在持锁」—— 后者会把并发的第二条安装放进来。
 *
 * @param dataDir - 插件数据目录
 * @param work - 锁下要做的事
 * @returns work 的返回值
 */
export async function withInstallLock<Result>(
  dataDir: string,
  work: () => Promise<Result>,
): Promise<Result> {
  const runtimeDir = path.join(dataDir, "runtime");
  const lockPath = path.join(runtimeDir, "install.lock");
  const key = path.resolve(lockPath);
  const held = heldLockChains.getStore();
  // 本调用链已在锁下：只跑工作，不再开句柄、不再碰文件锁。
  if (held?.has(key) === true) {
    return work();
  }
  await ensureRuntimeDir(dataDir);
  const handle = await acquireLock(lockPath);
  const chain = new Set([...(held ?? []), key]);
  try {
    return await heldLockChains.run(chain, work);
  } finally {
    await handle.release();
  }
}

export interface PythonInstallResult {
  pythonPath: string;
  version: string;
}

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
  // 清单 URL 里 `+` 是 `%2B`；浏览器 / curl -O 写到磁盘时用的是解码后的名字，两种都认。
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

/**
 * 下载、校验、解压托管 Python。
 *
 * @param asset - 已验资产（含 SHA256）；版本必须与清单一致，否则拒绝落盘
 * @param dataDir - 数据目录
 * @param io - 安装 IO
 * @param assets - 离线资产目录，给定时全程不联网
 * @returns 托管解释器路径与版本
 */
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
      // 临时文件先写到磁盘：解压器需要真实路径，也保证失败时能整段清掉。
      await writeFile(archive, bytes);
      const extractDir = path.join(tmpRoot, "extract");
      await mkdir(extractDir, { recursive: true });
      await io.extract(archive, extractDir);
      const layout = path.join(extractDir, "python");
      // 判「归档里有没有解释器」用 `executable` 而不是 `exists`：同名目录也能过 F_OK，
      // 而它装过去之后 `resolveRuntime` 会拒绝使用 —— 那时报出来的错与「归档不全」无关。
      const source = executable(path.join(layout, "bin", "python3")) ? layout : extractDir;
      // 落盘位置与校验都归 `managedPythonPath`（它读的是清单里的版本号）。`asset` 是入参，
      // 与清单可以脱钩：装了别的版本时归档会被解到**清单版本**的目录，而返回值却报
      // `asset.pythonVersion` ⇒ 版本说一套、文件在另一套，`ensurePython` 再查清单路径
      // 就会重复下载并把两个版本混进同一个布局。
      if (asset.pythonVersion !== runtimeManifest.darwinArm64.pythonVersion) {
        throw new InstallError(
          "INSTALL_FAILED",
          `python asset version ${asset.pythonVersion} is not the manifest version ${runtimeManifest.darwinArm64.pythonVersion}`,
        );
      }
      const target = path.dirname(path.dirname(managedPythonPath(dataDir)));
      await mkdir(path.dirname(target), { recursive: true });
      // 先解到同级暂存名、再 rename 换上去：`rm` 之后 `cp` 之前被打断（Ctrl-C / 被杀 /
      // 磁盘满）会让托管位置空着，而 venv 的 `bin/python3` 是指到这里的符号链接 ——
      // 断链之后状态页报「没装」、实际上一半文件还在，现场与「从没装过」分不开。
      // 同一文件系统内的 rename 是原子的：要么旧目录在位，要么新目录在位。
      const staging = `${target}.new-${randomUUID()}`;
      try {
        // 必须解引用：python-build-standalone 的 `python3` 是相对软链，原样 cp 会让目标
        // 指进临时解压目录 —— 那个目录在 finally 里被删，托管解释器当场变成断链（真机 smoke 抓到）。
        await cp(source, staging, { recursive: true, dereference: true });
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      const pythonPath = managedPythonPath(dataDir);
      if (!executable(pythonPath)) {
        throw new InstallError("INSTALL_FAILED", "python archive did not contain bin/python3");
      }
      return { pythonPath, version: runtimeManifest.darwinArm64.pythonVersion };
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
 * 原子写到磁盘状态：先写同目录临时文件再 rename。
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
 *
 * 导出是给单测用的（生产只有 `installCore` 内部这一处调用）：这段逻辑的正确性只能靠
 * 「暂存路径 → 最终路径」这一对具体目录来判，装到一半的 venv 造不出来。
 *
 * @param scanDir - 扫哪个目录下的 `bin/`
 * @param from - 脚本 shebang 里现存的旧前缀
 * @param to - 要换成的最终前缀
 * @param readScript - 读脚本正文（可注入，门禁用它造读不了的样本）
 */
export async function rewriteShebangs(
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

/**
 * 建 venv 并安装 core 依赖。
 *
 * 先装进临时 venv，成功后才替换旧 venv —— 中断或失败时旧包仍然可用。
 *
 * @param options - 解释器、数据目录、包根与 IO
 */
export async function installCore(options: {
  pythonPath: string;
  dataDir: string;
  repoRoot: string;
  io: InstallerIO;
  /** 是否把可选 documents 的钉版 requirements 一起装进 venv。 */
  documents?: boolean;
  /** 本次装的是 documents 包时，提交状态要同时标记它。 */
  markDocuments?: boolean;
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
    const requirementFiles = [requirements];
    if (options.documents === true) {
      const documentsRequirements = path.join(
        options.repoRoot,
        runtimeManifest.documents.requirements,
      );
      const bytes = await readFile(documentsRequirements);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== runtimeManifest.documents.sha256) {
        throw new InstallError(
          "INSTALL_HASH_MISMATCH",
          `documents requirements hash ${digest} does not match ${runtimeManifest.documents.sha256}`,
        );
      }
      requirementFiles.push(documentsRequirements);
    }
    let movedAside = false;
    // 「换装完成」以状态写成功为准，不是以 rename 成功为准：venv 换过去之后还要把
    // state.json 写成功，那才算这一次安装真的落地。rename 成功而状态写入失败时若就此收工，
    // 磁盘上留着的是「新 venv + 旧状态/坏状态」，用户看到安装失败、包却半新半旧。
    let committed = false;
    try {
      const created = await io.spawn([options.pythonPath, "-m", "venv", staging]);
      if (created.code !== 0) {
        throw new InstallError(
          "INSTALL_FAILED",
          `venv failed: ${safeStderr(created.stderr).slice(0, 400)}`,
        );
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
          ...requirementFiles.flatMap((file) => ["-r", file]),
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
        throw new InstallError(
          "INSTALL_FAILED",
          `pip failed: ${safeStderr(installed.stderr).slice(0, 400)}`,
        );
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
        ...(options.markDocuments === true ? { documents: "ready" } : {}),
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

/** 目录里是否有 Chromium 的可执行标记；安装后的验收与 status 的当场读数共用这一条判据。 */
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

/** documents 的就绪判据：钉版 pypdf 的 dist-info 真在共享 venv 里。 */
async function documentsInstalled(dataDir: string): Promise<boolean> {
  const marker = `${runtimeManifest.documents.distribution}-${runtimeManifest.documents.version}.dist-info`;
  try {
    const entries = await readdir(path.join(dataDir, "runtime", "venv"), { recursive: true });
    return entries.some((entry) => path.basename(entry) === marker);
  } catch {
    return false;
  }
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
        `chromium install failed: ${safeStderr(installed.stderr).slice(0, 400)}`,
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
      documents: "blocked",
      "adaptive-redis": "blocked",
      mcp: "blocked",
    };
  }
  const state = await readRuntimeState(dataDir);
  const raw = state["packs"];
  const packs: Record<string, unknown> = isPlainRecord(raw) ? raw : {};
  const core = stateOf(packs["core"], executable(managedVenvPythonPath(dataDir)));
  const browser = stateOf(packs["browser"], await chromiumInstalled(dataDir));
  const documents = stateOf(
    packs["documents"],
    core === "ready" && (await documentsInstalled(dataDir)),
  );
  const result: Record<RuntimePack, PackState> = {
    core,
    browser,
    search: core,
    media: core,
    documents,
    // adaptive-redis 的客户端与官方 server 的二进制都与 core 同住一个 venv：它们各自是
    // 一条依赖 / 一个入口，钉在 runtime-requirements 里，所以这两包的就绪状态就是 core 的。
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

/**
 * 取消信号已经生效就抛。
 *
 * 取消用**自己的码**（`INSTALL_CANCELLED`）而不是 `INSTALL_FAILED`：两者在设置卡上
 * 走的是不同的收场——取消是用户自己点的，界面不该把它报成一次安装失败，调用方
 * （`lib/runtime-remote.ts`）也不必靠 `signal.aborted` 去反推。
 *
 * @param signal - 取消信号
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new InstallError("INSTALL_CANCELLED", "install cancelled");
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
  if (executable(managed)) {
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
  const previous = await readRuntimeState(dataDir);
  const previousPacks = isPlainRecord(previous["packs"]) ? previous["packs"] : {};
  await installCore({
    pythonPath,
    dataDir,
    repoRoot,
    io,
    documents: pack === "documents" || previousPacks["documents"] === "ready",
    markDocuments: pack === "documents",
    ...(assets === undefined ? {} : { assets }),
  });
  throwIfAborted(signal);
  if (pack === "browser") {
    onProgress?.("installing full chromium");
    // patchright 装在 venv 里，托管 Python 自己没有它 —— 浏览器安装必须走 venv 解释器。
    // 路径复用 `managedVenvPythonPath`：那里带 win32 的 `Scripts/python.exe` 分支，而这里
    // 手拼的 `bin/python3` 在 Windows 上永远不存在，浏览器包会报一个与真实原因无关的失败。
    const venvPython = managedVenvPythonPath(dataDir);
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
 * 的包标记同步摘掉，下一次 status 会按文件当场读数。
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
    // browser 安装目录是 browsers/，其余包共用整份 venv。
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
