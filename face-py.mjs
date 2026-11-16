// face-py.mjs —— 测量之前先数文件：数的是 **bandit 量到的面**。
//
// 单独成脚本而不是写成 `python -c`：那条命令要经 npm 的 shell 重新拼参数，而 Node 在
// shell 模式下不转义 args，带空格的 `-c` 正文到 Windows 的 cmd 上会被拆成多个参数，
// 于是同一条判据只在 POSIX 上成立。数文件的规则（递归数 py/**/*.py、要求 py/tests/
// 存在）与 bandit -r py/ 实际量到的范围同源：用例也在里面。
//
// coverage 用的**不是**这个数：它 --omit="py/tests/*" 之后只剩随包发布的源文件，
// 分母与 files 清单逐份核对，归 coverage-floor.mjs。两侧份数本来就不该相等，别拿这里
// 的下限去核对那边。

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
// 下限不再是一个手写的魔术数字：它取 package.json.files 里登记了几份 `py/*.py`，也就是
// 「随包发布的那几份源文件」。原先写死 6 时，py/ 下有 14 份（10 随包 + 4 用例），删掉 8 份
// 这条门禁照样绿，而 bandit 只是安静地少扫几份 —— 正是这行下限想防的「量空气」的弱化版。
// 取登记数之后，少一份随包源文件就红，不需要有人记得回来改这个常量。
const FALLBACK_MIN = 6;

/**
 * package.json.files 里登记了几份 `py/*.py`。
 *
 * @returns 份数；读不到或形状不对时返回 null（并已写 stderr）
 */
function shippedPyCount() {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  } catch (error) {
    process.stderr.write(
      `[face:py] 读不到 package.json（${String(error)}）；下限退回 ${String(FALLBACK_MIN)}\n`,
    );
    return null;
  }
  const files = pkg?.files;
  if (!Array.isArray(files)) {
    process.stderr.write(
      `[face:py] package.json.files 不是数组；下限退回 ${String(FALLBACK_MIN)}\n`,
    );
    return null;
  }
  return files.filter((entry) => typeof entry === "string" && /^py\/[\w.-]+\.py$/u.test(entry))
    .length;
}

/**
 * 递归数 *.py 份数。
 *
 * @param dir - 目录
 * @returns 份数
 */
export function countPy(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countPy(full);
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      total += 1;
    }
  }
  return total;
}

/**
 * 是不是目录。
 *
 * 只吞「不存在 / 不是目录」这两种：权限错误、磁盘错误要照原样抛出去，否则「读不到」
 * 会被当成「没有」，门禁红在一个假的成因上。
 *
 * @param file - 路径
 * @returns 是否目录
 */
export function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

/** 判一个路径是不是目录，把读不动的成因翻成一句点名的话。
 *  `isDirectory` 按自己的契约只吞 ENOENT/ENOTDIR，EACCES/EPERM/ELOOP 照抛 —— 那是对的
 *  （「读不到」不能当成「不存在」），但抛在 main 里就成了一条裸栈，判红文案全丢。
 *  所以这一层必须接住它并点名：门禁红要红得能读。 */
function directoryState(file) {
  try {
    return { known: true, isDirectory: isDirectory(file), reason: null };
  } catch (error) {
    return { known: false, isDirectory: false, reason: String(error) };
  }
}

function main() {
  const pyDir = path.join(ROOT, "py");
  const pyState = directoryState(pyDir);
  if (!pyState.known) {
    process.stderr.write(`[face:py] 判不了 ${pyDir} 是不是目录：${pyState.reason}\n`);
    return 1;
  }
  if (!pyState.isDirectory) {
    process.stderr.write(
      "[face:py] 找不到 py/ 目录：bandit 对着缺失目录会退 0 且零输出，先在这里判红\n",
    );
    return 1;
  }
  let count;
  try {
    count = countPy(pyDir);
  } catch (error) {
    process.stderr.write(`[face:py] 读不了 ${pyDir}：${String(error)}\n`);
    return 1;
  }
  const testsState = directoryState(path.join(pyDir, "tests"));
  if (!testsState.known) {
    process.stderr.write(`[face:py] 判不了 py/tests/ 是不是目录：${testsState.reason}\n`);
    return 1;
  }
  const hasTests = testsState.isDirectory;
  const floor = shippedPyCount() ?? FALLBACK_MIN;
  process.stdout.write(
    `[face:py] bandit 量到的面（递归含 py/tests）：py/ 下 ${String(count)} 份 *.py（下限 ${String(floor)} = 随包发布份数），` +
      `py/tests/ 目录存在：${String(hasTests)}\n`,
  );
  if (count < floor) {
    process.stderr.write(
      `py/ 下只找到 ${String(count)} 份 *.py，低于随包发布的 ${String(floor)} 份：有源文件被删或挪出了 py/，bandit 的分母已经空了\n`,
    );
    return 1;
  }
  if (!hasTests) {
    process.stderr.write(
      "py/tests/ 不是目录：bandit -r py/ 会少掉用例面，coverage 的 --omit=py/tests/* 也会连分母一起放宽\n",
    );
    return 1;
  }
  return 0;
}

/**
 * 这次是真被人当脚本调起，还是只被 import（测试要直接调 countPy/isDirectory）。
 *
 * @returns 是否作为主模块运行
 */
export function invokedAsScript() {
  const [, argvPath] = process.argv;
  if (argvPath === undefined) {
    return false;
  }
  const invoked = realpathSync(path.resolve(argvPath));
  const self = realpathSync(path.resolve(import.meta.filename));
  return process.platform === "win32"
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

let asScript;
try {
  asScript = invokedAsScript();
} catch (error) {
  // 判不出「是不是被当脚本调起」时按**是**处理：多跑一次检查的代价远小于静默放行。
  process.stderr.write(
    `[face:py] 判不出本次是否被当脚本调起（${String(error)}）；按「是」处理，照常检查。\n`,
  );
  asScript = true;
}

if (asScript) {
  process.exitCode = main();
}
