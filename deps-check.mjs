// deps-check.mjs —— 用插件真会拉起的那个解释器跑一次依赖自洽检查。
//
// uv 在 PATH 上就先用 uv pip check（它不要求 venv 里有 pip），否则回退到
// `<python> -m pip check`。两条路都不能「悄悄退个非零」：回退、起不来、被信号杀掉
// 都要点名，否则门禁红在「依赖检查」这一行时看不出是 uv 缺了、解释器没了还是真有冲突。

import path from "node:path";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolvePython } from "./py-launcher.mjs";

/** 单次子进程的上限：uv/pip 卡住时（解析远端解释器、等网络索引、win32 启动器等交互）
 *  不设超时会让整条门禁永久挂住 —— 那不是红，是「没有结果」。 */
const RUN_TIMEOUT_MS = 120_000;

function run(command, args) {
  return spawnSync(command, args, {
    stdio: "inherit",
    timeout: RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function describeFailure(command, result) {
  if (result.error) {
    const code = result.error.code ?? "?";
    // 超时是 spawnSync 自己杀的：error.code 会是 ETIMEDOUT，点明白比「起不来」有用。
    if (code === "ETIMEDOUT" || result.signal !== null) {
      return `${command} 超过 ${String(RUN_TIMEOUT_MS)}ms 未结束，已杀（${code}）`;
    }
    return `${command} 起不来（${code}）：${result.error.message}`;
  }
  return `${command} 被信号 ${String(result.signal)} 结束`;
}

function main() {
  const python = resolvePython(path.resolve(import.meta.dirname));
  process.stdout.write(`依赖检查解释器：${python}\n`);
  const uv = run("uv", ["pip", "check", "--python", python]);
  if (!uv.error && uv.signal === null) {
    // uv 真跑起来了：退出码为 0 才算过。非零**不能**直接当成「依赖冲突」——
    // 解释器找不到（--python 指到的路径/名字解析失败）、参数不合法同样是非零，
    // 那时门禁会红在「依赖检查」，读不出红在 uv 这一层。所以先点名再退。
    if ((uv.status ?? 1) === 0) {
      return 0;
    }
    process.stderr.write(
      `uv pip check 退出 ${String(uv.status)}：若上面没有列出冲突包，则这是 uv 自己的错误（解释器解析 / 参数），不是依赖问题\n`,
    );
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
    // 回退到 pip 时首页要判「这个 venv 里到底有没有 pip」：uv 建的 venv 默认不装 pip，
    // 那条路的非零是 `No module named pip`，把它念成「依赖冲突」会把人带到错方向。
    const hasPip = spawnSync(python, ["-c", "import pip"], {
      stdio: "ignore",
      timeout: RUN_TIMEOUT_MS,
    });
    if (hasPip.status !== 0) {
      process.stderr.write(
        `${python} 里没有 pip（uv 建的 venv 默认如此），pip check 这条路不可用；装 pip 或用 uv 再跑一次\n`,
      );
      return 1;
    }
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
 * 解析失败时**不能**安静地回 false：那等于「检查没跑」被当成「检查通过」。npx 的临时目录、
 * 被删了一半的软链、EACCES 这些都会落到这一支。把它抛给调用点按「是」处理，代价只是多跑
 * 一次依赖检查，而静默放行的代价是门禁假绿。
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
  return process.platform === "win32"
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

let asScript;
try {
  asScript = invokedAsScript();
} catch (error) {
  // 判不出「是不是被当脚本调起」时按**是**处理：多跑一次依赖检查的代价远小于静默放行。
  process.stderr.write(
    `deps-check: 判不出本次是否被当脚本调起（${String(error)}）；按「是」处理，照常检查。\n`,
  );
  asScript = true;
}

if (asScript) {
  process.exitCode = main();
}
