import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
export default definePackageConfig({
  // src/ 三个文件里只有 settings-fields 是纯数据面，已被 client / settings-card 两组用例
  // 喂满；client-entry 与 settings-card 的渲染与装配面要真 DOM（happy-dom + createRoot，
  // 见 dsh-session-rescue 的 client-ui.test.ts 形态）才能测，刻意留在分母外 —— 新增纯逻辑
  // 的 src 文件时应把它加进这份名单，渲染面入分母前先补渲染层测试。
  coverageInclude: ["host.ts", "lib/**/*.ts", "src/settings-fields.ts"],
  test: {
    // 串行跑测试文件：本包是族系里唯一会**真的拉起 Python 进程**的（sidecar.test.ts 与
    // host.test.ts 里的爬虫链路）。文件并行时多个解释器同时冷启动、互相抢 CPU，握手预算
    // 就成了随缘的假失败。串行换来的是「只有一个 Python 在跑」这个确定前提。
    fileParallelism: false,
    // 解释器不在位时把整次运行顶红，而不是让用例一条条跳过去：跳过去的代价是覆盖率
    // 跟着掉，而门禁只会说「覆盖率不达标」，真正的原因不落在任何一行日志里。
    globalSetup: ["test/global-setup.ts"],
  },
});
