// bin/dsh-scrapling.mjs 的入口。build-cli.ts 以它为打包输入，bin 里那份是产物。
//
// 这里必须自带兜底：`runCli` 的 try 从它自己体内才开始，而它要调 `withDefaults(...)`
// （内部 `defaultDataDir()` 会摸 `os.homedir()` 与 `path.resolve`）与 `parseArgs` ——
// 这些同步步骤在进 try 之前就跑，抛出来会越过本文件成为顶层未捕获异常：Node 打一整段
// 堆栈后以它自己的默认码退出，而 CLI 对外的契约是「`CODE: message` + 一个确定退出码」
// （`lib/cli.ts` 的 `reportFailure`）。同仓 `build-cli.ts` 的入口对自己也包了 try/catch，
// 两边保持同形。

import { runCli } from "./lib/cli.ts";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  // 与 `lib/cli.ts` 的 `reportFailure` 同一句式和同一个退出码：走到这里的是装配期失败
  // （默认数据目录取不到、参数解析器自己抛），用户看到的仍是「command failed: …」加退 1，
  // 而不是一段与本命令无关的 Node 堆栈。
  console.error(`command failed: ${String(error)}`);
  process.exitCode = 1;
}
