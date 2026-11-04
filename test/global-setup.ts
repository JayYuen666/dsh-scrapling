// test/global-setup.ts —— 整套件开跑之前，先把「探针解释器在不在、是不是一个可用的普通文件」
// 变成一次显式的失败。
//
// 为什么不让它安静跳过：解释器缺失时那些真用例会被 runIf 判成 skip，而覆盖率会跟着掉
// ——门禁确实会红，但报错只说「覆盖率不达标」，真正的原因不出现在任何一行日志里。这里提前
// 把门禁顶红，并把该跑的命令写到 stderr（见 refuse()：只抛不写，那句话在 vitest 5.0.5 上会丢）。
//
// 判据放在 setup() 里而不是模块加载期：本文件唯一的使用者是 vitest.config.ts 的 globalSetup，
// 挂在加载期会让任何 import 它的人都拿到一次抛错，而实测两种落点换来同样的结果 —— 退出码 1、
// 零个用例（"No test files found, exiting with code 1"）、stderr 那三行照打。
//
// 顺带把「跳过」这条路整个关掉：本仓的覆盖率门禁是四项 100%，跳过一条用例等于悄悄把
// 阈值降低。因此「全部 passed」是唯一被接受的结果——环境不具备时应该失败，不应该少跑几条。
//
// 判据的边界：这里收口的只有「文件在 / 是普通文件 / POSIX 上有可执行位」这一组，与生产侧那
// 两处解析（lib/runtime.ts 的 executable、py-launcher.mjs 的 usable）读的是同一组判据，多一条
// 或少一条都会让「门禁量到的解释器」与「插件真拉起的那支」不是同一个东西。解释器存在却起不
// 来（架构不符、缺共享库、shebang 失效）不在这里预演：插件侧的答案来自 sidecar 的 ready 帧
// 与能力表，测试侧则是各文件自己报进程启动失败，那已经是带着真原因的失败。

import { accessSync, constants, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { LOCAL_PYTHON } from "./python-bin.ts";

/** 三条失败共用的收尾：修复入口 + 为什么不走 skip。单点维护，免得改了一处留一处误导。 */
const FIX_UP =
  "在伞根跑 pnpm py:setup 建好或重建仓内 venv（细节见 README「环境要求」）。\n" +
  "这里刻意不把用例跳过——跳过会拉低覆盖率，而覆盖率门禁的报错不会指向真正的原因。";

/**
 * 让整套件失败，并保证原因真的落到人眼前。
 *
 * 实测 vitest 5.0.5 + vite 8.3.5：从 globalSetup 抛出的 Error 到不了终端 —— vite 的 module-runner
 * 格式化这个栈时自己抛 `TypeError: code.charCodeAt is not a function`，日志里只剩那句
 * 「No test files found」。所以先写 stderr 再抛：抛出保住「一个用例都不跑」的 fail-closed
 * （退出码 1），写出去的那三行保证读得到原因。
 *
 * @param reason - 缺的是哪一段，第一句点名解释器
 * @returns 不返回，一律抛出
 */
function refuse(reason: string): never {
  const text = `${reason}\n${FIX_UP}`;
  process.stderr.write(`[dsh-scrapling] ${text}\n`);
  throw new Error(text);
}

/**
 * 判探针解释器可用；不可用就把整套件顶红。
 *
 * 一次 statSync 同时回答「在不在」和「是不是普通文件」：existsSync 对目录照样返回真，而 POSIX
 * 上目录常带可执行位，只判 X_OK 会把「venv 坏成一个同名目录」当成可用解释器放行下去。
 * Windows 没有可执行位（X_OK 在那边等同 F_OK），那边判到普通文件为止。
 *
 * @returns 无；不可用时抛出
 */
function requireProbeInterpreter(): void {
  let stats: Stats | undefined;
  try {
    stats = statSync(LOCAL_PYTHON);
  } catch {
    stats = undefined;
  }
  if (stats === undefined || !stats.isFile()) {
    refuse(
      stats === undefined
        ? `缺少探针解释器：${LOCAL_PYTHON} 不存在。`
        : `探针解释器不是一个普通文件：${LOCAL_PYTHON}（目录与指向目录的符号链接都不算）。`,
    );
  }
  if (process.platform === "win32") {
    return;
  }
  try {
    accessSync(LOCAL_PYTHON, constants.X_OK);
  } catch {
    refuse(`探针解释器不可执行：${LOCAL_PYTHON} 没有可执行位（这是坏掉的机器本地态）。`);
  }
}

/**
 * globalSetup 的入口：整套件开跑之前判一次探针解释器。
 *
 * 判过之后测试文件里各自的 HAS_LOCAL_PYTHON 分支实际恒真，「跳过」那条路不可达；它留在各文件
 * 里只是不去动既有形状。
 *
 * @returns 无；解释器不可用时抛出，整套件不跑
 */
export default function setup(): void {
  requireProbeInterpreter();
}
