// test/global-setup.ts —— 整套件开跑之前，先把「探针解释器在不在」变成一次显式的失败。
//
// 为什么不让它安静跳过：解释器缺失时那些真用例会被 runIf 判成 skip，而覆盖率会跟着掉
// ——门禁确实会红，但报错只说「覆盖率不达标」，真正的原因不出现在任何一行日志里。这里提前
// 把门禁顶红，并把该跑的命令写进报错本身。
//
// 顺带把「跳过」这条路整个关掉：本仓的覆盖率门禁是四项 100%，跳过一条用例等于悄悄把
// 阈值降低。因此「全部 passed」是唯一被接受的结果——环境不具备时应该失败，不应该少跑几条。

import { existsSync } from "node:fs";
import path from "node:path";

/** 本仓跑集成测试用的解释器；与各测试文件里引用的那一条同源。 */
const LOCAL_PYTHON = path.join(import.meta.dirname, "..", "_env", ".venv", "bin", "python3");

// 在模块加载期就抛，而不是等 setup() 被调用：抛得太晚，vitest 会先打出「没找到测试文件」，
// 那句噪音会盖住真正的原因，让人以为是自己把用例删了。
if (!existsSync(LOCAL_PYTHON)) {
  throw new Error(
    `缺少探针解释器：${LOCAL_PYTHON} 不存在。\n` +
      '先按 README「环境要求」建好：pip install "scrapling[rag]>=0.4.15,<0.5"\n' +
      "CI 上由 .github/workflows/publish.yml 的「备 sidecar 解释器」那一步代劳。\n" +
      "这里刻意不把用例跳过——跳过会拉低覆盖率，而覆盖率门禁的报错不会指向真正的原因。",
  );
}

/**
 * globalSetup 的入口；前置检查已在模块加载期做完，这里无事可做。
 *
 * @returns 无
 */
export default function setup(): void {
  // 解释器就位时什么都不用做：各测试文件按自己的 HAS_LOCAL_PYTHON 判断要不要跑。
}
