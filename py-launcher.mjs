// py-launcher.mjs —— 仓内 Python 解释器的单一解析入口：npm 脚本、deps-check 与本地工具
// 都从这里拿解释器，避免几处各答一套。
//
// 顺序与 lib/runtime.ts 的 resolveRuntime 一致：仓内 `_env/.venv` → PATH 上的名字。
// venv 布局分平台：POSIX 是 `bin/python`，Windows 是 `Scripts/python.exe`；可执行位只
// 在 POSIX 上有意义，Windows 上「文件在」就是判据。回落名同理：POSIX 是 `python3`，
// Windows 是 `python`。
//
// 用法：
//   node py-launcher.mjs [--env KEY=VALUE]... [-- python 参数...]
//   node py-launcher.mjs --which [--root=<目录>]
//   node py-launcher.mjs --path  [--root=<目录>]
//   node py-launcher.mjs --bin   [--root=<目录>]
//
// `--root` 只给测试用：把解析根指到夹具目录，与 host.ts 的 resolvePythonBin 对同一棵树
// 各算一次，两边答案不一致就是漂移。

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const WINDOWS = process.platform === "win32";

/** 没有仓内 venv 时交给 PATH 的解释器名。 */
export const PATH_PYTHON = WINDOWS ? "python" : "python3";

/**
 * venv 的脚本目录。
 *
 * @param root - 包根目录
 * @returns venv 里放解释器与入口脚本的那一层
 */
export function venvBin(root) {
  return path.join(root, "_env", ".venv", WINDOWS ? "Scripts" : "bin");
}

/**
 * venv 解释器的绝对路径。
 *
 * @param root - 包根目录
 * @returns 解释器路径（不判存在性）
 */
export function venvPython(root) {
  return path.join(venvBin(root), WINDOWS ? "python.exe" : "python");
}

function usable(file) {
  if (!existsSync(file)) {
    return false;
  }
  if (WINDOWS) {
    return true;
  }
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 选出这次用的解释器。
 *
 * @param root - 包根目录
 * @returns venv 解释器的绝对路径，或 PATH 上的名字
 */
export function resolvePython(root = ROOT) {
  const candidate = venvPython(root);
  return usable(candidate) ? candidate : PATH_PYTHON;
}

function whichLine(root) {
  const python = resolvePython(root);
  if (python !== PATH_PYTHON) {
    return `[py] 解释器：${python}`;
  }
  return `[py] 解释器：PATH 上的 ${PATH_PYTHON}（本仓没有 _env/.venv，在伞根跑 pnpm py:setup）`;
}

function applyEnv(target, pair) {
  const at = pair.indexOf("=");
  if (at <= 0) {
    process.stderr.write(`--env 要写成 KEY=VALUE；现在给的是 ${pair}\n`);
    return false;
  }
  target[pair.slice(0, at)] = pair.slice(at + 1);
  return true;
}

function parseArgs(argv) {
  let root = ROOT;
  let mode = "run";
  const env = {};
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--which" || arg === "--path" || arg === "--bin") {
      mode = arg.slice(2);
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = path.resolve(arg.slice("--root=".length));
      continue;
    }
    if (arg === "--env") {
      index += 1;
      const pair = argv[index];
      if (pair === undefined || !applyEnv(env, pair)) {
        return null;
      }
      continue;
    }
    if (arg.startsWith("--env=")) {
      if (!applyEnv(env, arg.slice("--env=".length))) {
        return null;
      }
      continue;
    }
    break;
  }
  return { mode, root, env, pythonArgs: argv.slice(index) };
}

function reportMode(mode, root) {
  if (mode === "which") {
    process.stdout.write(`${whichLine(root)}\n`);
    return 0;
  }
  if (mode === "path") {
    process.stdout.write(`${resolvePython(root)}\n`);
    return 0;
  }
  if (mode === "bin") {
    if (resolvePython(root) !== PATH_PYTHON) {
      process.stdout.write(`${venvBin(root)}\n`);
    }
    return 0;
  }
  return null;
}

function runPython(root, env, pythonArgs) {
  const python = resolvePython(root);
  const child = spawn(python, pythonArgs, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("error", (error) => {
    process.stderr.write(`起不来 ${python}：${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    return 2;
  }
  const reported = reportMode(parsed.mode, parsed.root);
  if (reported !== null) {
    return reported;
  }
  runPython(parsed.root, parsed.env, parsed.pythonArgs);
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const status = main(process.argv.slice(2));
  if (status !== null) {
    process.exitCode = status;
  }
}
