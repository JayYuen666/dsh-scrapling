// test/global-setup.ts —— 整套件开跑之前，先把「探测脚本用的解释器在不在、是不是一个可用的普通文件」
// 变成一次显式的失败。
//
// 为什么不让它安静跳过：解释器缺失时那些真用例会被 runIf 判成 skip，而覆盖率会跟着掉
// ——门禁确实会红，但报错只说「覆盖率不达标」，真正的原因不出现在任何一行日志里。这里提前
// 把门禁顶红，并把该跑的命令写到 stderr（见 refuse()：只抛不写，那句话在 vitest 5.0.5 上会丢）。
//
// 判据放在 setup() 里而不是模块加载期：本文件唯一的使用者是 vitest.config.ts 的 globalSetup，
// 挂在加载期会让任何 import 它的人都拿到一次抛错，而实测两种位置换来同样的结果 —— 退出码 1、
// 零个用例（"No test files found, exiting with code 1"）、stderr 那三行照打。
//
// 顺带把「跳过」这条路整个关掉：本仓的覆盖率门禁是四项 100%，跳过一条用例等于悄悄把
// 阈值降低。因此「全部 passed」是唯一被接受的结果——环境不具备时应该失败，不应该少跑几条。
//
// 判据的边界：这里统一处理的只有「文件在 / 是普通文件 / POSIX 上有可执行位」这一组，与生产侧那
// 两处解析（lib/runtime.ts 的 executable、py-launcher.mjs 的 usable）读的是同一组判据，多一条
// 或少一条都会让「门禁量到的解释器」与「插件真拉起的那支」不是同一个东西。解释器存在却起不
// 来（架构不符、缺共享库、shebang 失效）不在这里预演：插件侧的答案来自 sidecar 的 ready 帧
// 与能力表，测试侧则是各文件自己报进程启动失败，那已经是带着真原因的失败。
//
// 这条闸门管到的只是**解释器**：`py/bridge.py` 不在判据里。`test/tools.test.ts` 的
// `available = existsSync(LOCAL_PYTHON) && existsSync(BRIDGE)` 里那半个条件仍会在 bridge 缺失时
// 把真进程用例静默跳过，`ctx.skip()`（无 Chromium 时）也仍是一条可达的跳过路径。本文件的
// 保证到此为止，别把「解释器这一半关掉了」读成「跳过这条路整条不可达」。

import { accessSync, constants, statSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { LOCAL_PYTHON } from "./python-bin.ts";

/** 三条失败共用的收尾：修复入口 + 为什么不走 skip。单点维护，免得改了一处留一处误导。 */
const FIX_UP =
  "在伞根跑 pnpm py:setup 建好或重建仓内 venv（细节见 README 的「Development」/「开发」一节）。\n" +
  "这里刻意不把用例跳过——跳过会拉低覆盖率，而覆盖率门禁的报错不会指向真正的原因。";

/**
 * 让整套件失败，并保证原因真的落到人眼前。
 *
 * 实测 vitest 5.0.5 + vite 8.3.5：从 globalSetup 抛出的 Error 到不了终端 —— vite 的 module-runner
 * 格式化这个栈时自己抛 `TypeError: code.charCodeAt is not a function`，日志里只剩那句
 * 「No test files found」。所以先写 stderr 再抛：抛出保住「一个用例都不跑」的 fail-closed
 * （退出码 1），写出去的那三行保证读得到原因。
 *
 * **写 stderr 必须用 `writeSync(2, …)`，不能用 `process.stderr.write`**：POSIX 上 stderr 接管道
 * 或套接字时（CI 里绝大多数情况）那个写入是异步的，紧接着的 `throw` 会立刻把进程推上退出路径，
 * 排队的那块 buffer 可能来不及刷出 —— 恰好在最需要那句话的场景里丢掉它。`writeSync` 是同步
 * 系统调用，与 throw 的时序无关。
 *
 * @param reason - 缺的是哪一段，第一句点名解释器
 * @returns 不返回，一律抛出
 */
function refuse(reason: string): never {
  const text = `${reason}\n${FIX_UP}`;
  writeSync(2, `[dsh-scrapling] ${text}\n`);
  throw new Error(text);
}

/** 从任意抛错值上取 errno 名（拿不到就是 `undefined`）。 */
function errorCodeOf(error: unknown): string | undefined {
  const code: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * 判 POSIX 上的可执行位。
 *
 * 只有 X_OK 一条判据：目录也常带可执行位，所以「是不是普通文件」必须先由调用方判掉
 * （见 `interpreterRefusal`）。Windows 没有可执行位（X_OK 在那边等同 F_OK），那条路不调这里。
 *
 * @param target - 被判的解释器路径
 * @returns 拒绝的理由；可执行时返回 `undefined`
 */
function executableRefusal(target: string): string | undefined {
  let refusal: string | undefined;
  try {
    accessSync(target, constants.X_OK);
  } catch {
    refusal = `探针解释器不可执行：${target} 没有可执行位（这是坏掉的机器本地态）。`;
  }
  return refusal;
}

/**
 * 判一次 statSync + accessSync 的结果要不要拒，以及拒的理由。
 *
 * 抽成纯函数是为了能被钉住：本文件不在覆盖率分母里（`vitest.config.ts` 的 `coverageInclude`
 * 只有 host.ts / lib 与 src 两枚），而它的三条拒绝分支是整套件唯一的 fail-closed 机制 —— 只靠
 * 现场跑一遍「解释器在」的那条路，改错分支条件或误删 `writeSync` 都不会红。
 *
 * 一次 statSync 同时回答「在不在」和「是不是普通文件」：existsSync 对目录照样返回真，而 POSIX
 * 上目录常带可执行位，只判 X_OK 会把「venv 坏成一个同名目录」当成可用解释器放行下去。
 *
 * statSync 抛错时不能一律报「不存在」：EACCES（父目录权限）、ELOOP（符号链接成环）、
 * ENAMETOOLONG 都会走到这条 catch，而把它们的成因说成「文件不在」会把人支去重建 venv。
 * 所以只有 ENOENT（或拿不到 errno）归「不存在」，其余把 errno 一起点名。
 *
 * @param stats - statSync 的结果；抛错时是 `undefined`
 * @param statError - statSync 抛出的那个值（成功时忽略）
 * @param platform - 判可执行位时要用的平台（win32 不判）
 * @param target - 被判的解释器路径，只用于文案
 * @returns 拒绝的理由；可用时返回 `undefined`
 */
export function interpreterRefusal(
  stats: Pick<Stats, "isFile"> | undefined,
  statError: unknown,
  platform: NodeJS.Platform,
  target: string,
): string | undefined {
  let refusal: string | undefined;
  if (stats === undefined) {
    const code = errorCodeOf(statError);
    refusal =
      code === "ENOENT" || code === undefined
        ? `缺少探针解释器：${target} 不存在。`
        : `探针解释器读不到：${target}（${code}）。这不是「文件不在」——按那个成因去找最多重建一次 venv。`;
  } else if (!stats.isFile()) {
    refusal = `探针解释器不是一个普通文件：${target}（目录与指向目录的符号链接都不算）。`;
  } else if (platform !== "win32") {
    refusal = executableRefusal(target);
  }
  return refusal;
}

/**
 * 判探测脚本用的解释器可用；不可用就把整套件顶红。
 *
 * @returns 无；不可用时抛出
 */
function requireProbeInterpreter(): void {
  let stats: Stats | undefined;
  let statError: unknown;
  try {
    stats = statSync(LOCAL_PYTHON);
  } catch (error) {
    statError = error;
    stats = undefined;
  }
  const refusal = interpreterRefusal(stats, statError, process.platform, LOCAL_PYTHON);
  if (refusal !== undefined) {
    refuse(refusal);
  }
}

/**
 * globalSetup 的入口：整套件开跑之前判一次探测脚本用的解释器。
 *
 * 判过之后测试文件里各自的 HAS_LOCAL_PYTHON 分支实际永远成立；它留在各文件里只是不去动既有
 * 形状。注意这只覆盖解释器那一位，别的跳过路径（bridge.py 缺失、无 Chromium）仍是可达的。
 *
 * @returns 无；解释器不可用时抛出，整套件不跑
 */
export default function setup(): void {
  requireProbeInterpreter();
}
