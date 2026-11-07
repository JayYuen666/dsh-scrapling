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

import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const MIN = 6;

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

function main() {
  const pyDir = path.join(ROOT, "py");
  if (!isDirectory(pyDir)) {
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
  const hasTests = isDirectory(path.join(pyDir, "tests"));
  process.stdout.write(
    `[face:py] bandit 量到的面（递归含 py/tests）：py/ 下 ${String(count)} 份 *.py（下限 ${String(MIN)}），` +
      `py/tests/ 目录存在：${String(hasTests)}\n`,
  );
  if (count < MIN) {
    process.stderr.write(
      `py/ 下只找到 ${String(count)} 份 *.py，低于下限 ${String(MIN)}：bandit 的分母已经空了，后面每一段都在量空气\n`,
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
  try {
    const invoked = realpathSync(path.resolve(argvPath));
    const self = realpathSync(path.resolve(import.meta.filename));
    return process.platform === "win32"
      ? invoked.toLowerCase() === self.toLowerCase()
      : invoked === self;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  process.exitCode = main();
}
