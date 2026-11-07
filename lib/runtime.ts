// 解释器解析与托管 runtime 清单。Host 与 CLI 共用这一份，避免两处各答一套。

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** 本次实际选中的解释器。 */
export interface RuntimeResolution {
  pythonPath: string;
  via: "configured" | "managed" | "repo" | "path";
  version: string;
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
  platform: z.string(),
  arch: z.string(),
  pythonVersion: z.string().regex(PYTHON_VERSION, "pythonVersion 必须是三段数字的版本号"),
  release: z.string(),
  url: z.url(),
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

/** 与 `runtime-manifest.json` 同源；构建后按包根解析。 */
export const runtimeManifest: RuntimeManifest = parseRuntimeManifest(
  readFileSync(path.join(packageRoot, "runtime-manifest.json"), "utf8"),
);

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

function executable(file: string): boolean {
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
 * 解析这次用哪个 Python。
 *
 * 顺序固定：显式配置 → 托管 runtime → 仓内 `_env/.venv` → PATH。托管 runtime 只在
 * macOS arm64 有已验证资产，其他平台不猜路径。
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
    const managed = managedPythonPath(options.dataDir);
    if (executable(managed)) {
      return {
        pythonPath: managed,
        via: "managed",
        version: runtimeManifest.darwinArm64.pythonVersion,
      };
    }
  }
  const repoPython = repoPythonPath(options.repoRoot);
  if (executable(repoPython)) {
    return { pythonPath: repoPython, via: "repo", version: "unknown" };
  }
  // PATH 这一档交回裸名字，由宿主的 subprocess.resolveExecutable 去展开。这里自己扫 PATH
  // 会与宿主那套解析答出两个不同的路径。win32 名字必须与 py-launcher.mjs 的 PATH_PYTHON
  // 同为 "python"：本包的「解释器解析只有一个入口」承诺覆盖所有门禁与运行时读法，
  // 两个名字在宿主 resolveExecutable 的 PATHEXT 展开下等价，但答案是两个字符串就会让
  // 「门禁选的解释器」与「运行时用的解释器」在日志里对不上。
  const pathBinary = process.platform === "win32" ? "python" : "python3";
  return { pythonPath: pathBinary, via: "path", version: "unknown" };
}
