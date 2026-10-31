// deps-check.mjs —— 用插件真会拉起的那个解释器跑一次依赖自洽检查。
//
// uv 在 PATH 上就先用 uv pip check（它不要求 venv 里有 pip），否则回退到
// `<python> -m pip check`。两条路都不能「悄悄退个非零」：回退、起不来、被信号杀掉
// 都要点名，否则门禁红在「依赖检查」这一行时看不出是 uv 缺了、解释器没了还是真有冲突。

import path from "node:path";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolvePython } from "./py-launcher.mjs";

function run(command, args) {
  return spawnSync(command, args, { stdio: "inherit" });
}

function describeFailure(command, result) {
  if (result.error) {
    const code = result.error.code ?? "?";
    return `${command} 起不来（${code}）：${result.error.message}`;
  }
  return `${command} 被信号 ${String(result.signal)} 结束`;
}

function main() {
  const python = resolvePython(path.resolve(import.meta.dirname));
  process.stdout.write(`依赖检查解释器：${python}\n`);
  const uv = run("uv", ["pip", "check", "--python", python]);
  if (!uv.error && uv.signal === null) {
    // uv 真跑起来了：它的退出码就是判据（冲突时非零），不当成「uv 不可用」。
    return uv.status ?? 1;
  }
  // 起不来（ENOENT / EACCES / 别的 spawn 失败）或被信号打断：这是 uv 这一层的问题，
  // 不是依赖冲突，退到 pip 那条路并把原因说出来。
  process.stderr.write(`${describeFailure("uv", uv)}；改用 ${python} -m pip check\n`);
  const pip = run(python, ["-m", "pip", "check"]);
  if (pip.error || pip.signal !== null) {
    process.stderr.write(`${describeFailure(`${python} -m pip check`, pip)}\n`);
    return 1;
  }
  if ((pip.status ?? 1) !== 0) {
    process.stderr.write(
      `${python} -m pip check 退出 ${String(pip.status)}：上面那一行是它给的冲突面\n`,
    );
    return pip.status ?? 1;
  }
  return 0;
}

/**
 * 这次是真被人当脚本调起，还是只被 import。
 *
 * path.resolve(process.argv[1]) 与 import.meta.filename 在经符号链接调用时不是同一个串
 * （前者是链接路径，后者是 realpath）；只比字符串会让 main 不跑、进程退 0，门禁静默放行。
 *
 * @returns 是否作为主模块运行
 */
function invokedAsScript() {
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
