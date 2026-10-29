// 解释器解析与托管 runtime 清单。Host 与 CLI 共用这一份，避免两处各答一套。

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
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

const RUNTIME_ASSET_SCHEMA = z.object({
  platform: z.string(),
  arch: z.string(),
  pythonVersion: z.string(),
  release: z.string(),
  url: z.url(),
  sha256: z.string(),
  sizeBytes: z.int().positive(),
});

const RUNTIME_MANIFEST_SCHEMA: z.ZodType<RuntimeManifest> = z.object({
  darwinArm64: RUNTIME_ASSET_SCHEMA,
  unsupported: z.record(z.string(), z.string()),
});

// 这个模块同时被源码（lib/）、host.js（包根）与 CLI 产物（bin/）载入，`..` 不是固定的包根。
// 以 runtime-manifest.json 实际所在的那一级为准；右侧只在打包产物里成立，源码态恒走左侧。
// publish-manifest.test.ts 直接 import host.js，负责钉住打包态那一侧真的读得到 manifest。
/* v8 ignore next 1 */
const packageRoot = existsSync(path.join(import.meta.dirname, "runtime-manifest.json"))
  ? import.meta.dirname
  : path.resolve(import.meta.dirname, "..");

/** 解析并校验清单文本；坏清单在加载期就要炸，不能等到安装时才落一个半截 runtime。 */
export function parseRuntimeManifest(text: string): RuntimeManifest {
  const parsed: unknown = JSON.parse(text);
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

/** 托管 Python 在 dataDir 下的固定落点。 */
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
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 仓内 venv 的解释器：POSIX 在 `bin/python`，Windows 在 `Scripts/python.exe`。 */
function repoPythonPath(repoRoot: string): string {
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
 * @param options - 配置、数据目录、包根与环境
 * @returns 选中的解释器
 */
export function resolveRuntime(options: {
  pythonBin: string;
  dataDir: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
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
  // 会与宿主那套解析答出两个不同的路径。
  const pathBinary = process.platform === "win32" ? "python.exe" : "python3";
  return { pythonPath: pathBinary, via: "path", version: "unknown" };
}
