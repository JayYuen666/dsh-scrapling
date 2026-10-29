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
    // 基线那 20s 是给「假边跑边等」用的，本包有真 Chromium 的用例：CI 的 macOS runner 上
    // `scrapling_render 与真实 sidecar` 那条实测 20080ms 撞线（同一条在 ubuntu 格过），
    // 而首次拉起 Chromium 的成本本来就在秒级到十几秒。放宽的是**测量预算**，不是判据：
    // 真卡住的用例会以 60s 的停顿暴露，而不是悄悄过掉。
    testTimeout: 60_000,
    // 串行跑测试文件：本包是族系里唯一会**真的拉起 Python 进程**的（sidecar.test.ts 与
    // host.test.ts 里的爬虫链路）。文件并行时多个解释器同时冷启动、互相抢 CPU，握手预算
    // 就成了随缘的假失败。串行换来的是「只有一个 Python 在跑」这个确定前提。
    fileParallelism: false,
    // 解释器不在位时把整次运行顶红，而不是让用例一条条跳过去：跳过去的代价是覆盖率
    // 跟着掉，而门禁只会说「覆盖率不达标」，真正的原因不落在任何一行日志里。
    globalSetup: ["test/global-setup.ts"],
    // registry 版 shared 的 dist/card-ui.js 在单仓安装态会被 vitest 当成外部依赖，
    // 它内部的 require("react") 绕过 vi.mock("react")；测试架因此拿到真实 React 的
    // hook 并报 "Cannot read properties of null (reading 'useState')"。内联后 mock 才生效。
    server: { deps: { inline: [/@jayyuen66\/dsh-plugin-shared/u] } },
  },
});
