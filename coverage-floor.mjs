// coverage-floor.mjs —— 逐份核对随包发布的 Python 源文件覆盖率。
//
// coverage report --fail-under=74 量的是**整包平均**，一份文件掉下去会被别处抬平；
// 这个脚本把 package.json.files 里那几份 py 源文件逐个对到 coverage json 的分文件读数，
// 并要求每一份都 >= 地板。地板写在两处（本文件的 FLOOR 与 package.json 的
// --fail-under），两处不一致时先判红：否则改一处就等于悄悄换了判据。

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const FLOOR = 74;
// 只认字面文件名：目录或 glob 写进 files 之后，下面按名字比对会静默对空。
const LITERAL_PY = /^py\/[\w.-]+\.py$/u;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(`读不到 ${file}：${String(error)}\n`);
    return null;
  }
}

/**
 * package.json.files 里随包发布的 py 源文件。
 *
 * @param pkg - package.json 内容
 * @returns 条目清单；形状不对时返回 null（并已写 stderr）
 */
export function shippedFiles(pkg) {
  const { files } = pkg;
  if (!Array.isArray(files)) {
    process.stderr.write("package.json.files 不是数组，无法核对随包发布的 py 源文件\n");
    return null;
  }
  const shipped = files.filter(
    (entry) => typeof entry === "string" && entry.startsWith("py/") && entry.endsWith(".py"),
  );
  if (shipped.length === 0) {
    process.stderr.write("package.json.files 里没有 py/*.py\n");
    return null;
  }
  const bad = shipped.filter((entry) => !LITERAL_PY.test(entry));
  if (bad.length > 0) {
    process.stderr.write(
      `package.json.files 里这些 py 条目不是字面文件名（目录/glob 会让分文件比对静默空转）：${bad.join(", ")}\n`,
    );
    return null;
  }
  return shipped;
}

/**
 * 脚本里那条 --fail-under 的取值。
 *
 * @param pkg - package.json 内容
 * @returns 脚本地板；读不到时返回 null（并已写 stderr）
 */
export function floorFromScripts(pkg) {
  const command = pkg.scripts?.["coverage:floor"];
  if (typeof command !== "string") {
    process.stderr.write("package.json.scripts.coverage:floor 读不到，无法核对两处地板是否一致\n");
    return null;
  }
  const match = /--fail-under=(?<floor>\d+)/u.exec(command);
  const floor = match?.groups?.floor;
  if (floor === undefined) {
    process.stderr.write("coverage:floor 里没有 --fail-under，无法核对两处地板是否一致\n");
    return null;
  }
  return Number(floor);
}

/**
 * 磁盘上有、files 里没登记的 py 源文件。
 *
 * @param shipped - files 里登记的条目
 * @returns 漏登记的相对路径
 */
export function missingFromFiles(shipped) {
  const onDisk = readdirSync(path.join(ROOT, "py"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => `py/${entry.name}`);
  const listed = new Set(shipped);
  return onDisk.filter((name) => !listed.has(name)).toSorted();
}

/**
 * coverage json 的分文件读数，键归一成仓根相对路径。
 *
 * @param coverage - coverage json 内容
 * @returns 路径到读数的映射；形状不对时返回 null
 */
function measuredPercents(coverage) {
  const { files } = coverage;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    process.stderr.write("coverage json 的 files 不是对象，分文件读数读不出来\n");
    return null;
  }
  const measured = new Map();
  for (const [file, info] of Object.entries(files)) {
    // 相对路径按 ROOT 解析：path.relative(ROOT, file) 对相对键会按进程 cwd 解析，
    // 从别的目录起这个脚本就会把键算歪。
    const absolute = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
    measured.set(path.relative(ROOT, absolute).split(path.sep).join("/"), info);
  }
  return measured;
}

function validateShipped(pkg) {
  const shipped = shippedFiles(pkg);
  if (shipped === null) {
    return null;
  }
  const scriptFloor = floorFromScripts(pkg);
  if (scriptFloor === null) {
    return null;
  }
  if (scriptFloor !== FLOOR) {
    process.stderr.write(
      `地板两处不一致：coverage:floor 的 --fail-under=${String(scriptFloor)}，本文件 FLOOR=${String(FLOOR)}\n`,
    );
    return null;
  }
  const missing = missingFromFiles(shipped);
  if (missing.length > 0) {
    process.stderr.write(
      `这些 py 源文件在磁盘上却不在 package.json.files 里，不会被本脚本量到：${missing.join(", ")}\n`,
    );
    return null;
  }
  return shipped;
}

function failuresOf(shipped, measured) {
  const failures = [];
  for (const entry of shipped) {
    const info = measured.get(entry);
    if (!info) {
      failures.push(`${entry}: 不在 coverage 数据里`);
      continue;
    }
    const pct = info.summary?.percent_covered;
    if (typeof pct !== "number" || pct < FLOOR) {
      failures.push(
        `${entry}: ${typeof pct === "number" ? pct.toFixed(2) : "?"}% < ${String(FLOOR)}%`,
      );
    }
  }
  return failures;
}

function main() {
  const pkg = readJson(path.resolve(ROOT, "package.json"));
  const coverage = readJson(path.resolve(ROOT, "coverage/python-coverage.json"));
  if (pkg === null || coverage === null) {
    return 1;
  }
  const shipped = validateShipped(pkg);
  if (shipped === null) {
    return 1;
  }
  const measured = measuredPercents(coverage);
  if (measured === null) {
    return 1;
  }
  const failures = failuresOf(shipped, measured);
  if (failures.length > 0) {
    process.stderr.write(`Python 分文件覆盖率低于 ${String(FLOOR)}%：\n${failures.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(
    `Python 分文件覆盖率：${String(shipped.length)} 份，均 >= ${String(FLOOR)}%\n`,
  );
  return 0;
}

/**
 * 这次是真被人当脚本调起，还是只被 import（测试要直接调上面那几个纯函数）。
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
