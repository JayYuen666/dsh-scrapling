import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 本包真实用到的同步写盘 API —— node/no-sync 的包内例外。
  // 构建脚本（build-host.ts / build-client.ts）按需同步读写产物。
  syncWrites: ["writeFileSync", "readFileSync", "existsSync", "mkdirSync", "rmSync"],
  titlePrefixes: [
    "ADR",
    "CIDR",
    "HTML",
    "HTTP",
    "JSON",
    "NAT64",
    "SSRF",
    "URL",
    "XHR",
    "ScraplingCard",
  ],
  // shared 的 SCRIPTS_OVERRIDES 只按 `scripts/**`、`*.mjs`、`*.mts` 收窄。
  // 本仓把构建脚本放在包根且已转成 .ts（源码全 .ts），于是它们落在与源码同一套
  // 规则下 —— 这正是我们要的：.mjs 的「类型信息类规则无从计算」豁免对 .ts 不成立。
  // 只在下面这一条上按「对侧互斥」关规则，其余仍走基线。
  extraOverrides: [
    {
      files: ["src/client-entry.ts"],
      rules: {
        // Record<string, unknown> 上的属性访问：TS 要求方括号
        // （noPropertyAccessFromIndexSignature，报 TS4111），本规则要求点号。
        // 两者直接互斥，只能关一侧 —— 必须留方括号，否则构建根本过不去。
        "typescript/dot-notation": "off",
      },
    },
    {
      files: ["build-host.ts", "build-client.ts"],
      rules: {
        "node/no-top-level-await": "off",
      },
    },
    {
      files: ["lib/jsonl.ts"],
      rules: {
        // pumpFrames 的循环里，onFrame 是调用方给的回调，它可以调 stop() 把本次投递
        // 中断。TS 的控制流分析看不到这条跨闭包的副作用，于是把 state.stopped 窄化成
        // false 并报「这个条件永远不成立」。实测把该守卫删掉后，同一个 chunk 里的
        // 后续帧仍会被投递 —— 守卫是承重的，不是冗余分支。
        "typescript/no-unnecessary-condition": "off",
      },
    },
    {
      files: ["host.ts"],
      rules: {
        // startCrawlJob 只是把 ctx.jobs.start（同步）包成 Promise，用来满足工具层那条
        // async 契约 —— 这里没有任何真实的异步步骤。加上 async 会被 require-await 判掉，
        // 不写又会被 promise-function-async 判掉：两条规则在「无异步工作的
        // Promise 返回函数」上直接互斥，而契约本身就是这么定的。
        "typescript/require-await": "off",
        "typescript/promise-function-async": "off",
      },
    },
    {
      files: ["lib/sidecar.ts"],
      rules: {
        // 请求/响应协议的本质就是 deferred：先拿到一个「以后再兑现」的 Promise，
        // 靠 id 把响应接回去。eslint-plugin-promise 的 avoid-new 假设的是「把一个
        // async 函数包进 Promise」这种反模式，这里不是那种情况。
        "promise/avoid-new": "off",
        // child.done 是一条**故意不 await** 的链：子进程活着的时候它永远 pending，
        // 这里只是在它落定的那一刻做清理。没有可 await 的位置，改成 async/await 反而
        // 会把整个 spawn 挂住。
        "promise/prefer-await-to-then": "off",
        "promise/prefer-await-to-callbacks": "off",
        // 与 unicorn/no-useless-spread 直接互斥：Map/Set 的 values() 展开会被那条规则
        // 判成 no-useless-spread，改用 Array.from 又会被本条判成 prefer-spread。
        "unicorn/prefer-spread": "off",
      },
    },
  ],
  offReasons: {
    "typescript/dot-notation": {
      kind: "对侧互斥",
      measured: 1,
      note: "唯一命中在 src/client-entry.ts：Record<string, unknown> 的属性访问被 TS 的 noPropertyAccessFromIndexSignature 强制要求方括号（TS4111），而本规则要求点号。两条规则在索引签名上无解，只能关一侧，且必须关本条 —— 留点号就编译不过。",
    },
    "typescript/require-await": {
      kind: "对侧互斥",
      measured: 1,
      note: "startCrawlJob 只是把同步的 ctx.jobs.start 包成 Promise 以匹配工具层的 async 契约，本仓 1 处，这里没有任何真实异步步骤。加上 async 就撞上 promise-function-async，两条规则在「无异步工作的 Promise 返回函数」上直接互斥，而契约本身就是这么定的。",
    },
    "typescript/promise-function-async": {
      kind: "对侧互斥",
      measured: 1,
      note: "与 typescript/require-await 互斥，同一处代码：加上 async 会被 require-await 判掉，不加 async 会被本条判掉。两条只能关一侧，故一并记录。",
    },
    "node/no-top-level-await": {
      kind: "对侧互斥",
      measured: 2,
      note: "构建脚本必须 await rolldown()。改用 promise 链就会撞上本文件本该满足的 unicorn/prefer-top-level-await 与 promise/prefer-await-to-then —— 两条规则在这两个文件上互斥，只能关一侧。脚本只由 node 按 ESM 直接执行，不进 bundler 的 require(esm) 路径，顶层 await 的真实代价不存在。",
    },
    "promise/avoid-new": {
      kind: "实测否证",
      measured: 2,
      note: "sidecar 是请求/响应协议：握手等待与单次调用都必须先拿到一个「以后再兑现」的 Promise，再按 id 把响应接回去。按该规则改写就只能轮询 pending 表，CPU 空转且把延迟从 O(响应时间) 变成 O(轮询间隔)。全仓 2 处，都是协议实现本身，不是 async 函数的包装。",
    },
    "promise/prefer-await-to-then": {
      kind: "实测否证",
      measured: 1,
      note: "唯一命中是 `void child.done.catch(...)`：子进程存活期间这条链永远 pending，本就不存在可 await 的位置。改成 async/await 会让 spawn 一直挂在 await 上，sidecar 永远起不来。",
    },
    "promise/prefer-await-to-callbacks": {
      kind: "对侧互斥",
      measured: 1,
      note: "与上一条同处：要让这条满足就必须把进程退出清理改成 await，而那正是上一条实测否证掉的写法。两条规则在这行上互斥。",
    },
    "typescript/no-unnecessary-condition": {
      kind: "契约冲突",
      measured: 1,
      note: "只作用于 lib/jsonl.ts 的 pumpFrames：循环里的 stopped 守卫被 onFrame 回调间接翻转，TS 看不见跨闭包的副作用而误判为死分支。实测删除该守卫后，stop() 之后的同 chunk 帧会继续被投递（test/jsonl.test.ts 的「停止后不再回调」一条即为此设）。",
    },
    "unicorn/prefer-spread": {
      kind: "对侧互斥",
      measured: 1,
      note: "基线同时开着 unicorn/no-useless-spread，它会把 `[...map.values()]` 判成无用展开；改用 Array.from 又被本条判成应用展开。同一表达式在两条开启的规则下无解，只能关一侧 —— 这里选关 prefer-spread，因为 no-useless-spread 的判据（迭代器展开成无用数组）确实成立。",
    },
  },
});
