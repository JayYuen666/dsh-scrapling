import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePython } from "./py-launcher.mjs";

function run(command, args) {
  return spawnSync(command, args, { stdio: "inherit" });
}

function main() {
  const python = resolvePython(path.resolve(import.meta.dirname));
  process.stdout.write(`依赖检查解释器：${python}\n`);
  const uv = run("uv", ["pip", "check", "--python", python]);
  if (uv.error?.code !== "ENOENT") {
    return uv.status ?? 1;
  }
  const pip = run(python, ["-m", "pip", "check"]);
  return pip.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main();
}
