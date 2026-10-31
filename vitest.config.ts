import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
export default definePackageConfig({
  // src/ 四个文件里，settings-fields 是纯数据面、runtime-reader 是纯逻辑面（zod strict
  // codec 与 remote 描述符，不碰 DOM，test/runtime-remote.test.ts 与 test/build-signature.test.ts
  // 直接 import 它），两者入分母；client-entry 与 settings-card 的渲染与装配面要真 DOM
  // （happy-dom + createRoot，见 dsh-session-rescue 的 client-ui.test.ts 形态），刻意留在分母外 ——
  // 新增纯逻辑的 src 文件时应把它加进这份名单，渲染面入分母前先补渲染层测试。
  coverageInclude: ["host.ts", "lib/**/*.ts", "src/runtime-reader.ts", "src/settings-fields.ts"],
  test: {
    // 基线那 20s 是给「假边跑边等」用的，本包有真 Chromium 的用例：CI 的 macOS runner 上
    // `scrapling_render 与真实 sidecar` 那条实测 20080ms 撞线（同一条在 ubuntu 格过），
    // 而首次拉起 Chromium 的成本本来就在秒级到十几秒。放宽的是**测量预算**，不是判据：
    // 真卡住的用例会以 60s 的停顿暴露，而不是悄悄过掉。
    testTimeout: 60_000,
    // 文件级并行，但只开一半 worker：本包确实会**真的拉起 Python 进程**（sidecar.test.ts 与
    // host.test.ts 里的爬虫链路），所以不能按核数全开。实测 8 核机器上 50%（4 worker）把
    // 29.5s 降到约 9.5s，918 条用例与四项 100% 覆盖率阈值不变；取百分比而不是固定值，是为了
    // 让 CI 的小核数 runner 自动收敛到 1–2 个 worker，避免多个解释器冷启动互相抢 CPU。
    fileParallelism: true,
    maxWorkers: "50%",
    // 解释器不在位时把整次运行顶红，而不是让用例一条条跳过去：跳过去的代价是覆盖率
    // 跟着掉，而门禁只会说「覆盖率不达标」，真正的原因不落在任何一行日志里。
    globalSetup: ["test/global-setup.ts"],
    // registry 版 shared 的 dist/card-ui.js 在单仓安装态会被 vitest 当成外部依赖，
    // 它内部的 require("react") 绕过 vi.mock("react")；测试架因此拿到真实 React 的
    // hook 并报 "Cannot read properties of null (reading 'useState')"。内联后 mock 才生效。
    server: { deps: { inline: [/@jayyuen66\/dsh-plugin-shared/u] } },
  },
});
