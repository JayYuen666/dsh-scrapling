import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const FLOOR = 74;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(`读不到 ${file}：${String(error)}\n`);
    return null;
  }
}

function main() {
  const pkg = readJson(path.resolve(ROOT, "package.json"));
  const coverage = readJson(path.resolve(ROOT, "coverage/python-coverage.json"));
  if (pkg === null || coverage === null) {
    return 1;
  }
  const shipped = (pkg.files ?? []).filter(
    (entry) => typeof entry === "string" && entry.startsWith("py/") && entry.endsWith(".py"),
  );
  if (shipped.length === 0) {
    process.stderr.write("package.json.files 里没有 py/*.py\n");
    return 1;
  }
  const measured = new Map();
  for (const [file, info] of Object.entries(coverage.files ?? {})) {
    measured.set(path.relative(ROOT, file).split(path.sep).join("/"), info);
  }
  const failures = [];
  for (const entry of shipped) {
    const info = measured.get(entry);
    if (!info) {
      failures.push(`${entry}: 不在 coverage 数据里`);
      continue;
    }
    const pct = info.summary?.percent_covered;
    if (typeof pct !== "number" || pct < FLOOR) {
      failures.push(`${entry}: ${typeof pct === "number" ? pct.toFixed(2) : "?"}% < ${FLOOR}%`);
    }
  }
  if (failures.length > 0) {
    process.stderr.write(`Python 分文件覆盖率低于 ${FLOOR}%：\n${failures.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`Python 分文件覆盖率：${shipped.length} 份，均 ≥ ${FLOOR}%\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main();
}
