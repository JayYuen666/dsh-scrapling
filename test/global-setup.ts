// test/global-setup.ts —— 整套件开跑之前，先把「探针解释器在不在、能不能跑」变成一次显式的失败。
//
// 为什么不让它安静跳过：解释器缺失时那些真用例会被 runIf 判成 skip，而覆盖率会跟着掉
// ——门禁确实会红，但报错只说「覆盖率不达标」，真正的原因不出现在任何一行日志里。这里提前
// 把门禁顶红，并把该跑的命令写进报错本身。
//
// 顺带把「跳过」这条路整个关掉：本仓的覆盖率门禁是四项 100%，跳过一条用例等于悄悄把
// 阈值降低。因此「全部 passed」是唯一被接受的结果——环境不具备时应该失败，不应该少跑几条。

import { accessSync, constants, existsSync } from "node:fs";
import { LOCAL_PYTHON } from "./python-bin.ts";

// 在模块加载期就抛，而不是等 setup() 被调用：抛得太晚，vitest 会先打出「没找到测试文件」，
// 那句噪音会盖住真正的原因，让人以为是自己把用例删了。
//
// 存在性给出更准的文案，可执行位才是 POSIX 侧的判据：文件在但跑不起来（0 权限）与文件缺失
// 是两种不同的机器本地态，existsSync 对后者照样返回 true，放行下去真用例只会以「进程起不来」
// 的晦涩方式失败。Windows 没有可执行位（X_OK 在那边等同 F_OK），那边只看存在性。
// 修复入口指向 py:which 那句话点名的同一条路：伞根的 `pnpm py:setup`，
// 细节在 README「环境要求」——不复述版本区间与 CI 步骤名，那些会漂移。
function requireProbeInterpreter(): void {
  if (!existsSync(LOCAL_PYTHON)) {
    throw new Error(
      `缺少探针解释器：${LOCAL_PYTHON} 不存在。\n` +
        "在伞根跑 pnpm py:setup 建仓内 venv（详见 README「环境要求」）。\n" +
        "这里刻意不把用例跳过——跳过会拉低覆盖率，而覆盖率门禁的报错不会指向真正的原因。",
    );
  }
  if (process.platform === "win32") {
    return;
  }
  try {
    accessSync(LOCAL_PYTHON, constants.X_OK);
  } catch {
    throw new Error(
      `探针解释器不可执行：${LOCAL_PYTHON} 没有可执行位。\n` +
        "这是坏掉的机器本地态；在伞根重跑 pnpm py:setup 重建 venv（详见 README「环境要求」）。\n" +
        "这里刻意不把用例跳过——跳过会拉低覆盖率，而覆盖率门禁的报错不会指向真正的原因。",
    );
  }
}

requireProbeInterpreter();

/**
 * globalSetup 的入口；前置检查已在模块加载期做完，这里无事可做。
 *
 * @returns 无
 */
export default function setup(): void {
  // 解释器已在加载期被 requireProbeInterpreter 判过：测试文件里各自的 HAS_LOCAL_PYTHON
  // 分支实际恒真，「跳过」那条路已经不可达，留着只是不去动各测试文件里的既有形状。
}
