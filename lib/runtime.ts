// 解释器解析与托管 runtime 清单。Host 与 CLI 共用这一份，避免两处各答一套。

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PythonVia } from "./runtime-shape.ts";

/** 本次实际选中的解释器。 */
export interface RuntimeResolution {
  pythonPath: string;
  /**
   * 选中来源。
   *
   * `managed-venv` 与 `managed` 分开：`managed` 是**裸托管 CPython**（安装器拿它建 venv，
   * 里面一个包都没有），`managed-venv` 才是装了 wheel 的那一支。两个都报 `managed` 时，
   * 日志与设置卡上「Python 解释器：…（managed）」读不出到底是哪一支 —— 而这两支的差别
   * 恰好就是「工具全在」与「工具一只都不在」。
   */
  via: PythonVia;
  version: string;
  /**
   * 清单为这台机器写下的「为什么不提供托管 runtime」。
   *
   * `runtime-manifest.json` 的 `unsupported` 此前**没有任何读取点**：它被 schema 校验、被
   * 测试断言「值必须是字符串」，然后永远不出现在任何诊断里 —— 读清单的人会以为这条信息
   * 已经生效。现在它随解析结果一起交回，`--status` 因此能说出「这台机器为什么没走托管档」。
   * 只有落到 PATH 那一档才可能有值（别的档位都是真选中了某个解释器）；清单没写这台机器时
   * 是 `undefined`，那是常态。
   */
  assetNote?: string | undefined;
}

/** 已验证的托管 Python 资产；只收 macOS arm64。 */
export interface RuntimeAsset {
  platform: string;
  arch: string;
  pythonVersion: string;
  release: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface RuntimeManifest {
  darwinArm64: RuntimeAsset;
  unsupported: Record<string, string>;
}

/** sha256 的清单形态：installer 用 `createHash("sha256").digest("hex")`（64 位小写）逐字节比对，
 *  大写、缺位或空串在比对时必然失败。这里先按同一形态统一处理，让清单写错在加载期就暴露，
 *  而不是等下载完 25 MB 资产后落到一句「hash 不匹配」。 */
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** pythonVersion 会被当作目录名拼进托管位置（`managedPythonPath`，installer 复用同一位置），
 *  故只收形如 `3.14.9` 的三段数字：`../x` 或带分隔符的值会让 `path.join` 落到 dataDir 之外。 */
const PYTHON_VERSION = /^\d+\.\d+\.\d+$/u;

const RUNTIME_ASSET_SCHEMA = z.object({
  // 这两枚原先只校验「是个字符串」，而全仓没有任何地方拿它们比对 —— 清单里写
  // `platform: "linux"` 照样能装。现在收成字面值：darwinArm64 这一格就只认这两个值，
  // 写错在加载期就炸，而不是把一份 linux 资产装进 macOS 的 runtime 目录。
  platform: z.literal("darwin"),
  arch: z.literal("arm64"),
  pythonVersion: z.string().regex(PYTHON_VERSION, "pythonVersion 必须是三段数字的版本号"),
  release: z.string(),
  // `z.url()` 只校验形态，不限定协议与主机：`http://` 明文下载 25 MB 的可执行解释器，
  // 或 `file:///…` 直接读本机文件都算「合法 URL」。安装器把这一位原样交给 curl / io.download，
  // 所以协议必须在清单这一层就收死（https 一个）。
  url: z
    .url({ protocol: /^https$/u })
    .describe("托管资产只允许 https 下载：http/file 会让安装器去取明文或本机文件"),
  sha256: z.string().regex(SHA256_HEX, "sha256 必须是 64 位小写十六进制"),
  sizeBytes: z.int().positive(),
});

const RUNTIME_MANIFEST_SCHEMA: z.ZodType<RuntimeManifest> = z.object({
  darwinArm64: RUNTIME_ASSET_SCHEMA,
  unsupported: z.record(z.string(), z.string()),
});

// 这个模块同时被源码（lib/）、host.js（包根）与 CLI 产物（bin/）载入，`..` 不是固定的包根。
// 以 runtime-manifest.json 实际所在的那一级为准：打包产物里 manifest 就在 import.meta.dirname
// 这一级（左侧），源码态的 lib/ 里没有它，只能回到上一级（右侧）。
// publish-manifest.test.ts 直接 import host.js，负责确认装出去的那份产物真能读到 manifest。
/* v8 ignore next 1 */
const packageRoot = existsSync(path.join(import.meta.dirname, "runtime-manifest.json"))
  ? import.meta.dirname
  : path.resolve(import.meta.dirname, "..");

/** 解析并校验清单文本；坏清单在加载期就要炸，不能等到安装时才落一个半截 runtime。
 *  语法错与形态错给同一句前缀：`JSON.parse` 原样抛出的 SyntaxError 只说明「哪一行多了个逗号」，
 *  调用方（含 CLI 产物）读不出错的是哪份文件，故障现场对不上。 */
export function parseRuntimeManifest(text: string): RuntimeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`runtime-manifest.json is invalid: ${String(error)}`, { cause: error });
  }
  const result = RUNTIME_MANIFEST_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new Error(`runtime-manifest.json is invalid: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let manifestCache: RuntimeManifest | undefined;

/**
 * 读一次清单（结果缓存）。
 *
 * 这里刻意不在模块顶层 `readFileSync`：本模块被 host.js、bin/ 与 lib/ 三处载入，顶层同步抛
 * 会让**整个模块 import 失败** —— 连与清单毫无关系的 `repoPythonPath`、`resolveRuntime` 的
 * configured 档都跟着不可用，现场只剩一句 ENOENT。改成首次访问时读，错误也只发生在真需要
 * 清单的那一刻，并且点明是哪份文件。
 *
 * @returns 校验通过的清单
 */
/** `pyvenv.cfg` 里的 `version = X.Y.Z` 行；venv 的目录名不带版本号，只能问它自己。 */
const PYVENV_VERSION = /^version\s*=\s*(?<version>\S+)\s*$/mu;

/**
 * 清单文件的位置（按包根解析）。
 *
 * @returns 绝对路径
 */
export function manifestFile(): string {
  return path.join(packageRoot, "runtime-manifest.json");
}

/**
 * 读清单正文；读不到时把 ENOENT 翻成点名文件的一句话。
 *
 * @param file - 清单路径；缺省为包根下那一份
 * @returns 文件正文
 */
export function readManifestText(file: string = manifestFile()): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    // 裸 ENOENT 只报半个路径、也不说这是清单：现场要能直接看出缺的是哪份文件。
    throw new Error(`runtime-manifest.json is unreadable: ${file}`, { cause: error });
  }
}

function loadRuntimeManifest(): RuntimeManifest {
  manifestCache ??= parseRuntimeManifest(readManifestText());
  return manifestCache;
}

/** 与 `runtime-manifest.json` 同源；构建后按包根解析。首次读取清单时才落盘。 */
export const runtimeManifest: RuntimeManifest = {
  get darwinArm64() {
    return loadRuntimeManifest().darwinArm64;
  },
  get unsupported() {
    return loadRuntimeManifest().unsupported;
  },
};

/** 托管 Python 在 dataDir 下的固定位置。 */
export function managedPythonPath(dataDir: string): string {
  return path.join(
    dataDir,
    "runtime",
    "python",
    runtimeManifest.darwinArm64.pythonVersion,
    "bin",
    "python3",
  );
}

/**
 * 托管 venv 的解释器：`dataDir/runtime/venv/bin/python3`（Windows 是 `Scripts/python.exe`）。
 *
 * **为什么它跟 `managedPythonPath` 是两个位置**：安装器先落一份托管 CPython
 * （`runtime/python/<版本>/`），再用它 `-m venv` 出一份 `runtime/venv`，所有 wheel
 * （`core` 的 scrapling、`browser` 的 patchright、`mcp` 的官方 server）都装进**后者**。
 * 裸的托管 CPython 里一个包都没有 —— 拿它当 sidecar 解释器，`import scrapling` 必然失败，
 * 表现为「工具一个都不注册、skill 正文为空」，而日志里那行解释器路径看起来完全正常。
 *
 * 布局与 `officialMcpBinary`（`lib/official-mcp.ts`）同源：那边取 `bin/scrapling-mcp`，
 * 这里取 `bin/python3`。
 *
 * 与同文件的 `managedPythonPath`（裸托管解释器，安装器建 venv 时用它）**不可互换**；
 * 调用点在 `resolveRuntime` 的托管档（先 venv、venv 不在才回落裸解释器）。
 *
 * @param dataDir - 数据目录
 * @returns 托管 venv 解释器的路径（不保证存在）
 */
export function managedVenvPythonPath(dataDir: string): string {
  const venv = path.join(dataDir, "runtime", "venv");
  // Windows 的 `venv` 只造 `python.exe` / `python<ver>.exe` / `pythonw*.exe` 这几种名字：
  // CPython 的 `venv/__init__.py` 里 `link_sources` 的键是 `python.exe`、`python{exe_d}.exe`、
  // `python{exe_t}.exe` 与 `pythonw*`，**没有 `python3.exe`** —— 那边不沿 POSIX 的
  // `python` / `python3` / `python3.N` 三后缀习惯。照 POSIX 的名字拼会得到一个永远不存在的
  // 路径，`executable()` 判假后回落到裸托管解释器（那里一个包都没有），症状与「托管 venv
  // 没装」一模一样。同文件 `repoPythonPath` 用的就是 `Scripts/python.exe`。
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python3");
}

/**
 * 判一个路径是不是「能当解释器用」的普通可执行文件。
 *
 * 导出给安装器复用：`packStates` 判 core 就绪时若只做 `access(F_OK)`，同名目录（或指向目录的
 * 符号链接）也会被当成已安装，而这里会拒绝它 —— 两处判据必须同源，否则状态卡报 `ready`
 * 而 sidecar 启动时拒绝使用，表现为「显示已安装、工具全部不可用」。
 *
 * @param file - 候选路径
 * @returns 是普通文件且有可执行位时为 true
 */
export function executable(file: string): boolean {
  // X_OK 在 Windows 上没有效果（等同 F_OK），所以这一条在两边都成立：POSIX 判可执行位，
  // Windows 判文件在。缺文件在两边都会抛同一个错误。
  //
  // 先按普通文件统一处理：POSIX 的 X_OK 对目录同样成立，托管位置若在安装中断后被替换成同名
  // 目录（或符号链接指向目录），只判 X_OK 会把目录当成可用解释器，并带上清单声明的版本
  // 返回出去——错误要到子进程启动时才以 EISDIR/ENOENT 的形式出现，来源比「没找到」更难查。
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 仓内 venv 的解释器：POSIX 在 `bin/python`，Windows 在 `Scripts/python.exe`。
 *
 * 这份布局导出给测试侧复用（`test/python-bin.ts` 的 `LOCAL_PYTHON` 由它算），门禁量的解释器
 * 与插件真拉起的那支因此同源，而不是两处各写一遍再靠断言对齐。`py-launcher.mjs` 里还留着
 * 同样的一段拼接，它不并入这里：那份是仓内 CLI，不在发布名单上，发出去的 host 产物不能依赖
 * 一个不随包的文件。两边不一致由 `test/py-launcher.test.ts` 拿 `--root` 对同一棵树各算一次
 * 来判红。
 *
 * @param repoRoot - 包根
 * @returns 仓内 venv 解释器的路径（不保证存在）
 */
export function repoPythonPath(repoRoot: string): string {
  return process.platform === "win32"
    ? path.join(repoRoot, "_env", ".venv", "Scripts", "python.exe")
    : path.join(repoRoot, "_env", ".venv", "bin", "python");
}

/**
 * 读托管 venv 的真实基座版本（`pyvenv.cfg` 的 `version =`）。
 *
 * @param dataDir - 数据目录
 * @returns 版本号；文件不在、读不到或没有那一行时返回 undefined
 */
export function venvVersionOf(dataDir: string): string | undefined {
  const config = path.join(dataDir, "runtime", "venv", "pyvenv.cfg");
  let text: string | undefined;
  try {
    text = readFileSync(config, "utf8");
  } catch {
    // 没有 pyvenv.cfg ⇒ 没有可问的版本；调用方回落到清单值。
    text = undefined;
  }
  const match = text === undefined ? null : PYVENV_VERSION.exec(text);
  return match?.groups?.["version"];
}

/**
 * 清单为这台机器写下的「为什么不提供托管 runtime」。
 *
 * `runtime-manifest.json` 的 `unsupported` 此前**没有任何读取点**：它被 schema 校验、被测试
 * 断言「值必须是字符串」，然后永远不出现在任何诊断里 —— 读清单的人会以为这条信息已经生效。
 * 现在它跟着解析结果交回，`--status` 因此能说出「这台机器为什么没走托管档」。
 *
 * 清单读不到（漏打包、读权限不足）时回 `undefined` 而不是把异常抛出去：这一档本来就要
 * 落到 PATH，为了附一句说明而让整个解析失败，是把「没有说明」升级成「不能用」。
 *
 * @returns 平台原因；没有这一条时 undefined
 */
function unsupportedNote(): string | undefined {
  let note: string | undefined;
  try {
    note = runtimeManifest.unsupported[`${process.platform}-${process.arch}`];
  } catch {
    /* v8 ignore next 2 -- 清单读不到才走到这条兜底：正常装配里它必须存在，要在用例里造出来
       得清掉模块级缓存，代价与「这条兜底不吞异常」的收益不成比例 */
    note = undefined;
  }
  return note;
}

/**
 * 解析这次用哪个 Python。
 *
 * 顺序固定：显式配置 → 托管 venv → 裸托管解释器 → 仓内 `_env/.venv` → PATH。托管那两档
 * 只在 macOS arm64 有已验证资产，其他平台不猜路径。
 *
 * **为什么托管档先看 venv 而不是裸解释器**：`setup --feature core --apply` 落地的是两件东西
 * —— `runtime/python/<版本>/` 的托管 CPython，以及由它 `-m venv` 出来的 `runtime/venv`，
 * scrapling / patchright / 官方 mcp server 全在后者里。裸解释器里一个包都没有，拿它起
 * sidecar 会 `import scrapling` 失败：工具一只都不注册、skill 正文为空，而日志里那行
 * 「Python 解释器：<路径>（managed）」看起来完全正常 —— 这是最难自查的一类现场。
 * venv 不在时仍回落到裸解释器（安装做了一半的机器），此时上面那句告警会点名路径。
 *
 * @param options - 配置、数据目录与包根
 * @returns 选中的解释器
 */
export function resolveRuntime(options: {
  pythonBin: string;
  dataDir: string;
  repoRoot: string;
}): RuntimeResolution {
  const explicit = options.pythonBin.trim();
  if (explicit.length > 0) {
    return { pythonPath: explicit, via: "configured", version: "unknown" };
  }
  if (process.platform === "darwin" && process.arch === "arm64" && options.dataDir.length > 0) {
    const venv = managedVenvPythonPath(options.dataDir);
    if (executable(venv)) {
      // venv 的路径不带版本号（`runtime/venv`），所以版本必须问它自己：`pyvenv.cfg` 里
      // `version = 3.14.9` 那一行就是这份 venv 的真实基座。清单版本只在这份文件读不到时兜底
      // —— 清单升到 3.15 而机器上留着 3.14 的旧 venv 时，报清单版本会让「状态」页说假话。
      return {
        pythonPath: venv,
        via: "managed-venv",
        version: venvVersionOf(options.dataDir) ?? runtimeManifest.darwinArm64.pythonVersion,
      };
    }
    const bare = managedPythonPath(options.dataDir);
    if (executable(bare)) {
      return {
        pythonPath: bare,
        via: "managed",
        version: runtimeManifest.darwinArm64.pythonVersion,
      };
    }
  }
  // 空串与托管档的 `dataDir` 同样处理：`repoPythonPath("")` 拼出来的是**相对路径**
  // `_env/.venv/bin/python`，而 `executable()` 的 `statSync` / `accessSync` 会按
  // `process.cwd()` 解析它。宿主恰好在某个含 `_env/.venv` 的目录下启动时（本仓自己就是，
  // 门禁也从这里跑），这一档会选中一个与部署毫无关系的解释器；发布出去的包里更不该有
  // 「按 cwd 猜解释器」这条路。
  const repoPython = options.repoRoot.length > 0 ? repoPythonPath(options.repoRoot) : "";
  if (repoPython.length > 0 && executable(repoPython)) {
    return { pythonPath: repoPython, via: "repo", version: "unknown" };
  }
  // PATH 这一档交回裸名字，由宿主的 subprocess.resolveExecutable 去展开。这里自己扫 PATH
  // 会与宿主那套解析答出两个不同的路径。win32 名字必须与 py-launcher.mjs 的 PATH_PYTHON
  // 同为 "python"：本包的「解释器解析只有一个入口」承诺覆盖所有门禁与运行时读法，
  // 两个名字在宿主 resolveExecutable 的 PATHEXT 展开下等价，但答案是两个字符串就会让
  // 「门禁选的解释器」与「运行时用的解释器」在日志里对不上。
  const pathBinary = process.platform === "win32" ? "python" : "python3";
  const note = unsupportedNote();
  if (note === undefined) {
    return { pythonPath: pathBinary, via: "path", version: "unknown" };
  }
  return { pythonPath: pathBinary, via: "path", version: "unknown", assetNote: note };
}
