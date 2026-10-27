// face-py.mjs —— 测量之前先数面：bandit 与 coverage 的分母。
//
// 单独成脚本而不是写成 `python -c`：那条命令要经 npm 的 shell 重新拼参数，而 Node 在
// shell 模式下不转义 args，带空格的 `-c` 正文到 Windows 的 cmd 上会被拆成多个参数，
// 于是同一条判据只在 POSIX 上成立。数面的规则（递归数 `py/**/*.py`、要求 `py/tests/`
// 存在）与 bandit / coverage 实际量到的范围同源，直接读盘就不会有这层解释器差别。

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const MIN = 6;

function countPy(dir) {
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

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function main() {
  const pyDir = path.join(ROOT, "py");
  const count = countPy(pyDir);
  const hasTests = isDirectory(path.join(pyDir, "tests"));
  process.stdout.write(
    `[face:py] bandit 与覆盖率量到的面：py/ 下 ${String(count)} 份 *.py（下限 ${String(MIN)}），` +
      `py/tests/ 目录存在：${String(hasTests)}\n`,
  );
  if (count < MIN) {
    process.stderr.write(
      `py/ 下只找到 ${String(count)} 份 *.py，低于下限 ${String(MIN)}：` +
        "bandit 与 coverage 的分母已经空了，后面每一段都在量空气\n",
    );
    return 1;
  }
  if (!hasTests) {
    process.stderr.write(
      "py/tests/ 不是目录：coverage 的 --omit=py/tests/* 会连分母一起放宽，地板量的就成了虚高的那一面\n",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main();
}
