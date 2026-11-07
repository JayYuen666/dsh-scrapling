// eol-gate.mjs —— 把「行尾钉在 LF」这条不变量变成可判的红。
//
// 这条不变量原先只由 `.gitattributes` 与 `oxfmt.config.ts` 两侧注释互指，没有任何判据：把
// `eol=lf` 改掉、把 `text=auto` 那整行删掉、或让索引里存进一条 CRLF blob，Linux 上 `fmt:check`
// 照绿，而 windows-latest 那格翻转时报的是格式问题不是行尾配置。
//
// 判读要分两种安装形状，且两边都真判：`check-attr` 与 `ls-files --eol` 都要 `.git`，而
// `verify:published` 那份 `git archive` 导出的副本没有 `.git`——那里写到磁盘的就是索引字节，
// 于是判「文件里读不到 CRLF」。没有「读不到就当过」那一支。
//
// 期望值是一张自己抄的字面表，不是从 `.gitattributes` 解析出来的：拿被验对象派生判据，改错了
// 两边会一起绿。

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;

/** 按 `* text=auto eol=lf` 与两条 cmd 系豁免应当解析出来的行尾（键是可以并不存在的路径） */
export const CONTRACT_EOL = [
  { file: "host.ts", eol: "lf" },
  { file: "lib/runtime.ts", eol: "lf" },
  { file: "py/bridge.py", eol: "lf" },
  { file: "bin/dsh-scrapling.mjs", eol: "lf" },
  { file: "package.json", eol: "lf" },
  { file: "README.md", eol: "lf" },
  { file: "icon.svg", eol: "lf" },
  { file: "probe.bat", eol: "crlf" },
  { file: "probe.cmd", eol: "crlf" },
  { file: "probe.ps1", eol: "lf" },
];

/** `.gitattributes` 里必须逐字在位的三条规则（缺一条就是有人在改这条不变量） */
export const CONTRACT_RULES = ["* text=auto eol=lf", "*.bat text eol=crlf", "*.cmd text eol=crlf"];

/** 索引与字节都只管这几类源码后缀：二进制与生成物不归这条判据*/
export const SOURCE_SUFFIXES = [
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".json",
  ".py",
  ".md",
  ".yml",
  ".yaml",
];

/** 字节判那一支不走进来的目录：产物、依赖与本机 venv 都不是行尾承诺的对象 */
const SKIPPED_DIRS = new Set(["node_modules", "_env", "dist", "types", "coverage", ".git", ".tmp"]);

/**
 * 把 `git check-attr eol -- …` 的回执读成 路径 → 行尾 的表。
 *
 * @param stdout - 每行形如 `path: eol: lf` 的回执正文
 * @returns 路径到行尾的映射
 */
export function parseCheckAttr(stdout) {
  const resolved = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(?<file>.+?): eol: (?<eol>\S+)$/u.exec(line);
    if (match?.groups !== undefined) {
      resolved[match.groups.file] = match.groups.eol;
    }
  }
  return resolved;
}

/**
 * 从 `git ls-files --eol` 的行里挑出索引行尾不对的源码文件。
 *
 * 判的是 `i/` 那一段（索引里存的字节），不是 `w/`：机器级 `core.autocrlf=true` 换的是工作树，
 * 而这条不变量管的是仓库存了什么。
 *
 * @param rows - `git ls-files --eol` 的逐行回执
 * @returns offenders：`"<状态> <路径>"` 形式的行
 */
export function indexOffenders(rows) {
  const offenders = [];
  for (const row of rows) {
    // 回执形状是 `i/lf␣␣␣w/lf␣␣␣attr/text=auto eol=lf<TAB>路径`：属性列自己带空格，
    // 所以路径只能按第一个制表符切，按空白切会把 `eol=lf` 当成文件名。
    const tab = row.indexOf("\t");
    const file = tab === -1 ? "" : row.slice(tab + 1);
    const status = tab === -1 ? "" : row.slice(0, tab).trimStart().split(/\s+/u)[0];
    if (
      file.length > 0 &&
      SOURCE_SUFFIXES.some((suffix) => file.endsWith(suffix)) &&
      status !== "i/lf"
    ) {
      offenders.push(`${status} ${file}`);
    }
  }
  return offenders;
}

/**
 * 在一堆「路径 → 字节」里挑出含 CRLF 的源码文件。
 *
 * @param entries - `{ file, text }` 的清单
 * @returns offenders：带 CRLF 的路径
 */
export function crlfSources(entries) {
  return entries
    .filter((entry) => SOURCE_SUFFIXES.some((suffix) => entry.file.endsWith(suffix)))
    .filter((entry) => entry.text.includes("\r\n"))
    .map((entry) => entry.file);
}

/**
 * 是不是目录。只吞「不存在 / 不是目录」，其余错误照抛——权限错误读成「没有」会让门禁红在假成因上。
 *
 * @param file - 路径
 * @returns 是否目录
 */
function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

/**
 * 按名排序读目录，让两个平台的回执逐字节可比。
 *
 * @param dir - 目录
 * @returns 条目
 */
function readdirSorted(dir) {
  return readdirSync(dir, { withFileTypes: true }).toSorted((left, right) =>
    left.name < right.name ? -1 : 1,
  );
}

/**
 * 递归收 路径 → 文本 的清单（字节判那一支的输入）。
 *
 * @param dir - 起点目录
 * @returns 清单
 */
function walk(dir) {
  const found = [];
  for (const entry of readdirSorted(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        found.push(...walk(full));
      }
    } else if (entry.isFile() && !entry.name.endsWith(".lock")) {
      found.push({ file: path.relative(ROOT, full), text: readFileSync(full, "utf8") });
    }
  }
  return found;
}

/**
 * 契约字面表是否与 `.gitattributes` 的三条规则同时在位。
 *
 * @param attributes - `.gitattributes` 正文
 * @returns 缺失的规则行
 */
export function missingRules(attributes) {
  return CONTRACT_RULES.filter((rule) => !attributes.split(/\r?\n/u).includes(rule));
}

function main() {
  let attributes;
  try {
    attributes = readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  } catch (error) {
    process.stderr.write(
      `[eol-gate] 读不到 ${path.join(ROOT, ".gitattributes")}：这条不变量没东西可判，判红而不是跳过（${String(error)}）\n`,
    );
    return 1;
  }
  const missing = missingRules(attributes);
  if (missing.length > 0) {
    process.stderr.write(`[eol-gate] .gitattributes 缺规则：${missing.join(" / ")}\n`);
    return 1;
  }
  const insideRepo = isDirectory(path.join(ROOT, ".git"));
  if (insideRepo) {
    const out = execFileSync(
      "git",
      ["check-attr", "eol", "--", ...CONTRACT_EOL.map((item) => item.file)],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    const resolved = parseCheckAttr(out);
    const wrong = CONTRACT_EOL.filter((item) => resolved[item.file] !== item.eol).map(
      (item) => `${item.file}: 期望 ${item.eol}，实得 ${String(resolved[item.file])}`,
    );
    if (wrong.length > 0) {
      process.stderr.write(`[eol-gate] git 解析出的行尾与契约不符：\n  ${wrong.join("\n  ")}\n`);
      return 1;
    }
    const rows = execFileSync("git", ["ls-files", "--eol"], { cwd: ROOT, encoding: "utf8" }).split(
      /\r?\n/u,
    );
    const listed = rows.filter((row) => row.length > 0);
    if (listed.length === 0) {
      process.stderr.write("[eol-gate] git ls-files --eol 零行：这一判没量到任何东西，不能当过\n");
      return 1;
    }
    const offenders = indexOffenders(listed);
    if (offenders.length > 0) {
      process.stderr.write(
        `[eol-gate] 索引里存着非 LF 的源码 blob：\n  ${offenders.join("\n  ")}\n`,
      );
      return 1;
    }
    process.stdout.write(
      `[eol-gate] 仓内形状：规则 ${String(CONTRACT_RULES.length)} 条在位，git 解析 ${String(CONTRACT_EOL.length)} 个位与契约一致，索引 ${String(listed.length)} 行里源码零 CRLF\n`,
    );
    return 0;
  }
  const entries = walk(ROOT);
  if (entries.length === 0) {
    process.stderr.write("[eol-gate] 无 .git 的副本里一个文件也没读到：这一判没量到任何东西\n");
    return 1;
  }
  const bad = crlfSources(entries);
  if (bad.length > 0) {
    process.stderr.write(`[eol-gate] 检出树里存着 CRLF 的源码：\n  ${bad.join("\n  ")}\n`);
    return 1;
  }
  process.stdout.write(
    `[eol-gate] 副本形状（无 .git）：规则在位，逐份读 ${String(entries.length)} 个文件，源码零 CRLF\n`,
  );
  return 0;
}

/**
 * 这次是被当脚本调起，还是只被 import（被 import 时必须安静）。
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
