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
//   node py-launcher.mjs --which [--root=<目录>|--root <目录>]
//   node py-launcher.mjs --path  [--root=<目录>|--root <目录>]
//   node py-launcher.mjs --bin   [--root=<目录>|--root <目录>]
//
// `--root` 只给测试用：把解析根指到夹具目录，与 host.ts 的 resolvePythonBin 对同一棵树
// 各算一次，两边答案不一致就是漂移。

import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = import.meta.dirname;
const WINDOWS = process.platform === "win32";
const MODES = new Set(["which", "path", "bin"]);

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

/**
 * 这个候选能不能当解释器用。
 *
 * 只判存在性会把**目录**与任意占位文件也算成解释器：existsSync 对目录照样真，
 * POSIX 上目录还常带可执行位，于是「venv 坏成空壳」这一态会静默把 PATH 那支换掉。
 * 所以先要是个普通文件。
 *
 * @param file - 候选路径
 * @returns 能否当解释器用
 */
function usable(file) {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return false;
  }
  if (!stats.isFile()) {
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
  // 「没有」与「有但不能用」是两件事：`usable` 也把同名目录、没有可执行位的文件判成不可用
  // （POSIX 上目录常带可执行位，只看 existsSync 会把空壳 venv 当成好的）。文案若只说
  // 「没有 _env/.venv」，坏掉的那份就被读成不存在，用户会去重跑一遍 setup 而不是看它是怎么坏的。
  return `[py] 解释器：PATH 上的 ${PATH_PYTHON}（没有可用的 _env/.venv，在伞根跑 pnpm py:setup）`;
}

/**
 * 拆一个 `KEY=VALUE`。
 *
 * **不在这一层写 stderr**：调用方（`envFromArg`）才知道该报哪一句，两层各写一次会让一次
 * 参数错误打出两行（实测 `--env=BOGUS` 曾经同时出现「要写成 KEY=VALUE」与「取值不合法」）。
 * 两种不合法的成因不同、给出的出路也不同，所以分开报：没有 `=` 是写法错；键以 `-` 开头是
 * 把启动器旗标当成了环境变量（那种形状下 `--root` 之类会被静默吞掉）。
 *
 * @param pair - `KEY=VALUE` 一个整段
 * @returns `{ env }` 或 `{ reason }`，理由只说明成因，文案由调用方拼
 */
function splitEnv(pair) {
  const at = pair.indexOf("=");
  if (at <= 0) {
    return { reason: "shape" };
  }
  const key = pair.slice(0, at);
  if (key.startsWith("-")) {
    return { reason: "flag" };
  }
  return { env: { key, value: pair.slice(at + 1) } };
}

function rootFromArg(argv, index) {
  const arg = argv[index];
  if (arg === "--root") {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: "--root 需要一个目录" };
    }
    return { root: path.resolve(value), step: 2 };
  }
  if (arg.startsWith("--root=")) {
    const value = arg.slice("--root=".length);
    if (value === "") {
      return { error: "--root= 不能为空：空值会被解析成当前目录，夹具就指错了树" };
    }
    return { root: path.resolve(value), step: 1 };
  }
  return null;
}

function envFromArg(argv, index) {
  const arg = argv[index];
  let pair;
  let step;
  if (arg === "--env") {
    pair = argv[index + 1];
    step = 2;
    if (pair === undefined) {
      return { error: "--env 需要一个 KEY=VALUE" };
    }
  } else if (arg.startsWith("--env=")) {
    pair = arg.slice("--env=".length);
    step = 1;
  } else {
    return null;
  }
  const parsed = splitEnv(pair);
  if (parsed.reason === "shape") {
    return { error: `--env 要写成 KEY=VALUE；现在给的是 ${pair}` };
  }
  if (parsed.reason === "flag") {
    return {
      error: `--env 的键不能以 - 开头（会被当成旗标）：${pair}。要传旗标请写在 --env 之前`,
    };
  }
  return { env: parsed.env, step };
}

function takeMode(arg, state) {
  const modeName = arg.slice(2);
  if (!arg.startsWith("--") || !MODES.has(modeName)) {
    return false;
  }
  if (state.mode !== "run") {
    process.stderr.write(
      ["只接受一个模式；已经有 --", state.mode, "，又给了 ", arg, "\n"].join(""),
    );
    return null;
  }
  state.mode = modeName;
  return true;
}

function stepArg(argv, index, state) {
  const arg = argv[index];
  const tookMode = takeMode(arg, state);
  if (tookMode === null) {
    return null;
  }
  if (tookMode) {
    return 1;
  }
  const rootArg = rootFromArg(argv, index);
  if (rootArg !== null) {
    if (rootArg.error !== undefined) {
      process.stderr.write([rootArg.error, "\n"].join(""));
      return null;
    }
    state.root = rootArg.root;
    return rootArg.step;
  }
  const envArg = envFromArg(argv, index);
  if (envArg !== null) {
    if (envArg.error !== undefined) {
      process.stderr.write([envArg.error, "\n"].join(""));
      return null;
    }
    const { env: parsedEnv } = envArg;
    state.env[parsedEnv.key] = parsedEnv.value;
    return envArg.step;
  }
  return 0;
}

function parseArgs(argv) {
  const state = { root: ROOT, mode: "run", env: {} };
  let index = 0;
  while (index < argv.length) {
    const step = stepArg(argv, index, state);
    if (step === null) {
      return null;
    }
    if (step === 0) {
      break;
    }
    index += step;
  }
  // `--` 是「启动器旗标到此为止」的分隔符，不是解释器的参数：留在里面会被 python 当成
  // 脚本路径，报 `can't open file '.../--'`。文件头第 10 行承诺的写法必须真的成立。
  const pythonArgs = argv[index] === "--" ? argv.slice(index + 1) : argv.slice(index);
  return { mode: state.mode, root: state.root, env: state.env, pythonArgs };
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
      return 0;
    }
    // 没有 venv 时别输出空行：调用方会把它拼成 PATH 的空段（等于把当前目录塞进 PATH）。
    // 退出码也得非零，否则 PATH="$(...)" 那类写法分不出「没 venv」与「venv 就是空」。
    process.stderr.write(
      "[py] 没有可用的 _env/.venv：--bin 无目录可给（在伞根跑 pnpm py:setup 建出来）\n",
    );
    return 1;
  }
  return null;
}

function exitCodeFrom(code, signal) {
  if (code !== null) {
    return code;
  }
  if (signal !== null) {
    const number = os.constants.signals[signal];
    return typeof number === "number" ? 128 + number : 1;
  }
  return 1;
}

function runPython(root, env, pythonArgs) {
  const python = resolvePython(root);
  const child = spawn(python, pythonArgs, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  // 转发终止信号给子进程：`stdio: "inherit"` 让子进程与启动器同属终端的前台进程组，
  // 交互式 Ctrl-C 内核会同时打给两边；但脚本化场景（CI 的 `kill`、`timeout` 命令、
  // 宿主的 shell 服务按 pid 发信号）只打到启动器这一个 pid，不转发时 python 会继续跑，
  // 启动器却先退出 —— 调用方看到「命令结束了」，子进程还在写文件/占端口。
  // 不监听 SIGKILL：它不可捕获，那种情形只能靠对方的进程组语义。
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  child.on("error", (error) => {
    process.stderr.write(`起不来 ${python}：${error.message}\n`);
    if (process.exitCode === undefined) {
      process.exitCode = 1;
    }
  });
  child.on("exit", (code, signal) => {
    // 起不来时 error 先到、那一位已写下非零码；exit 不能把它盖回 1 或 0。
    if (process.exitCode === undefined) {
      process.exitCode = exitCodeFrom(code, signal);
    }
  });
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    return 2;
  }
  if (parsed.mode !== "run" && parsed.pythonArgs.length > 0) {
    process.stderr.write(
      `--${parsed.mode} 是报告模式，不接受解释器参数：${parsed.pythonArgs.join(" ")}\n`,
    );
    return 2;
  }
  const reported = reportMode(parsed.mode, parsed.root);
  if (reported !== null) {
    return reported;
  }
  runPython(parsed.root, parsed.env, parsed.pythonArgs);
  return null;
}

/**
 * 这次是真被人当脚本调起，还是只被 import（测试、deps-check 的 resolvePython）。
 *
 * path.resolve(process.argv[1]) 与 import.meta.filename 在**经符号链接**调用时不是同一个
 * 串：Node 给的 import.meta.filename 是 realpath，argv 里是链接路径。直接比字符串会让
 * main 根本不跑、进程退 0 —— 一条「静默通过」的门，比红还坏。
 *
 * @returns 是否作为主模块运行
 */
function invokedAsScript() {
  const [, argvPath] = process.argv;
  if (argvPath === undefined) {
    return false;
  }
  const invoked = realpathSync(path.resolve(argvPath));
  const self = realpathSync(path.resolve(import.meta.filename));
  // win32 的文件名比较不区分大小写，realpath 的盘符大小写也不保证一致。
  return WINDOWS ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

let asScript;
try {
  asScript = invokedAsScript();
} catch (error) {
  // 判不出「是不是被当脚本调起」时按**是**处理：多跑一次启动器的代价远小于静默放行。
  process.stderr.write(
    `[py-launcher] 判不出本次是否被当脚本调起（${String(error)}）；按「是」处理，照常解析解释器。\n`,
  );
  asScript = true;
}

if (asScript) {
  const status = main(process.argv.slice(2));
  if (status !== null) {
    process.exitCode = status;
  }
}
