import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";
import type {
  OffJustification,
  PluginLintOptions,
} from "@jayyuen66/dsh-plugin-shared/config/oxlint";

/**
 * 每一处「关规则」的理由。
 *
 * 正向（关了的必须有理由）由 shared 的 `assertOffsDocumented` 在配置加载时强制，缺理由
 * 就是 `pnpm lint` 直接抛；反向（记了理由的必须真的还关着）与「override 指向的文件还在」
 * 由 `test/lint-deviations.test.ts` 钉住 —— 规则被基线改掉或那处写法被修好之后，留着的
 * 理由就是一条查无实据的说明，而它读起来比缺说明更容易骗过下一个人。
 *
 * `measured` 是把那一行 `off` 删掉（让基线的档位连同它的选项一起生效）之后，`oxlint .`
 * 在该 scope 内新增的条数。重量的动作就照这句话做：删行 → 跑 `./node_modules/.bin/oxlint .`
 * → 数那条规则名的报错行 → 把行放回去。它没有自动判据（自动复核要在用例里重做一遍配置、
 * 再起一次 oxlint），所以动过 `extraOverrides` 或那几处写法之后，数字得由人重新量一次 ——
 * 它是登记那一刻的读数，不是现状。
 */
export const OFF_REASONS = {
  "typescript/dot-notation": {
    kind: "与已启用规则互斥",
    measured: 16,
    note: "16 处命中全在 src/client-entry.ts：`Record<string, unknown>` 上的属性访问被 TS 的 noPropertyAccessFromIndexSignature 强制要求方括号（TS4111），本规则却要求点号。两条规则在索引签名上无解，只能关一侧，且必须关本条 —— 换成点号就编译不过。",
  },
  "node/no-top-level-await": {
    kind: "仅限特定文件",
    measured: 4,
    note: "build-cli.ts、build-client.ts、build-host.ts、cli-main.ts 各一处。前三份由 `node build-*.ts` 按 ESM 直接执行，cli-main.ts 打成 bin/dsh-scrapling.mjs 这个 ESM 入口 —— 没有一份是被 require(esm) 同步加载进来的库代码，本规则担心的那条代价路径在这里不存在，而构建脚本必须 await rolldown()、CLI 入口必须 await 一次运行。",
  },
  "promise/prefer-await-to-then": {
    kind: "实测有害",
    measured: 2,
    note: "两处都在 lib/sidecar.ts 的 `child.done` 上：退出清理的 `void child.done.then(…)`，与 `dispose()` 里把两种退出形态都折成 true 的 `exited`。子进程存活期间这条链永远 pending，本就不存在可 await 的位置；改成 await 会让 spawn 一直挂在那里，sidecar 永远起不来。",
  },
  "promise/prefer-await-to-callbacks": {
    kind: "与已启用规则互斥",
    measured: 2,
    note: "lib/sidecar.ts 的两个回调位：`pumpFrames` 的错误回调，与 `child.done.then(…)` 的 rejection 臂。让本条满足就得把进程退出清理改成 await，而那正是上一条实测否证掉的写法 —— 同一行上两条规则各要一个答案。",
  },
  "promise/prefer-catch": {
    kind: "实测有害",
    measured: 8,
    note: "8 处两臂 `then` 的第二臂都**只**接 Promise 自身的拒绝：lib/sidecar.ts 两处要按 done 的落定形态选收尾文案，改成 `.then(f).catch(r)` 会把 f 自己的拒绝也算成 spawn 失败并再收一次尾；六个用例的第一臂故意 `throw`，让「本该拒绝却兑现」当场判红，`.catch` 会把这处判红吞成通过。规则建议的写法在这里不是等价改写。",
  },
  "unicorn/prefer-spread": {
    kind: "与已启用规则互斥",
    measured: 1,
    note: "唯一命中是 lib/sidecar.ts 里 `#rejectAll` 的 `Array.from(this.#pending.values())`。基线同时开着 unicorn/no-useless-spread，它会把 `[…map.values()]` 判成无用展开；改用 Array.from 又被本条判成应用展开。同一表达式在两条开启的规则下无解，只能关一侧 —— 这里选关 prefer-spread，因为 no-useless-spread 的判据（迭代器展开成无用数组）确实成立。",
  },
} satisfies Record<string, OffJustification>;

/**
 * node/no-sync 的例外，按文件登记（基线的只读组统一放行：existsSync / readFileSync /
 * readdirSync / readSync / realpathSync / statSync —— 组的内容以 shared 的
 * `READONLY_SYNC_ALLOWLIST` 为准，这里不重抄，也不重复登记）。
 *
 * 收窄到文件级是有意的：早先那一张包级扁平名单把 writeFileSync / rmSync 登记进去之后，
 * lib/ 与 host.ts 里的同步写一并免疫，这条规则在本仓就再也拦不住新增的同步调用。
 *
 * 名单里**只列本仓真在用的**：登记一枚不存在的 api 看起来无害，代价是它把「这枚同步调用
 * 出现在哪」这个信息抹掉了 —— 后来真用上时没人会因为多了一行而注意到，而这条 scope 的
 * 作用恰恰是让每一枚都有个可核对的理由。造目录与补可执行位走的是 `node:fs/promises`
 * （`build-cli.ts` 的 `await mkdir(...)` / `await chmod(target, 0o755)`），异步版本本就不被
 * 这条规则拦，所以那三枚（mkdirSync / mkdtempSync / chmodSync）不在构建档里。
 *
 * - 构建脚本：writeFileSync 写暂存文件、renameSync 是原子写的最后一步、rmSync/unlinkSync
 *   只清理上次中断留下的临时文件；realpathSync 走基线只读组，不必登记。
 * - `test/**`：夹具造现场要写到磁盘；同步写在这里没有并发问题，但也不许外溢到 lib/ 与 host.ts。
 * - `lib/runtime.ts`：用 accessSync 判「venv 解释器还能不能跑」——插件装载期的一次性探测，
 *   不在热路径上，而基线的只读组不含这一枚。
 */
export const SYNC_IO_SCOPES = [
  {
    files: ["build-helpers.ts", "build-client.ts", "build-host.ts", "build-cli.ts"],
    apis: ["writeFileSync", "renameSync", "rmSync", "unlinkSync"],
  },
  {
    files: ["test/**"],
    // globSync 是给「override 点名的文件还在不在」那条自检用的存在性扫描：它要递归读目录，
    // 而基线的只读组不含这一枚。utimesSync 只出现在「构造一个 mtime 很旧的临时件」这条用例里 ——
    // 判 `writeArtifact` 回收残留的年龄阈值必须能把 mtime 摆到过去，否则那条判据测不出来。
    // writeSync 只出现在 `test/global-setup.ts` 的 refuse()：那里必须在 throw 之前**同步**把原因
    // 写到 fd 2，`process.stderr.write` 在 POSIX 上接管道时是异步的，紧接着的 throw 会把排队的
    // 那块 buffer 一起带走 —— 恰好在最需要那句话的 CI 场景里丢掉它。
    apis: [
      "writeFileSync",
      "mkdirSync",
      "mkdtempSync",
      "rmSync",
      "chmodSync",
      "accessSync",
      "globSync",
      "utimesSync",
      "writeSync",
    ],
  },
  { files: ["lib/runtime.ts"], apis: ["accessSync"] },
] satisfies NonNullable<PluginLintOptions["syncIoScopes"]>;

/**
 * 本仓自己追加的 override 块。与 `OFF_REASONS` 是同一件事的两半（哪里关了哪条规则 /
 * 为什么可以关），所以两边必须一一对应，由 `test/lint-deviations.test.ts` 钉住。
 *
 * shared 的 SCRIPTS_OVERRIDES 只按 `scripts/**`、`*.mjs`、`*.mts` 收窄，本仓的构建脚本放在
 * 包根且已转成 .ts（源码全 .ts），于是它们落在与源码同一套规则下 —— 这正是我们要的：
 * .mjs 的「类型信息类规则无从计算」豁免对 .ts 不成立。代价是构建脚本需要的例外都得
 * 自己点名，本文件的 `extraOverrides` 与 `syncIoScopes` 两组都是为这件事而存在。
 * 下面这些 override 只处理「两条已启用规则对同一处写法各要一个答案」的那几枚规则，
 * 其余一律走基线。
 */
export const EXTRA_OVERRIDES = [
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
    files: ["build-host.ts", "build-client.ts", "build-cli.ts", "cli-main.ts"],
    rules: {
      // 四份都是 ESM 入口（三份 `node build-*.ts` 直跑，cli-main.ts 打成 bin 的那个 mjs），
      // 不是被 require 进来的库代码，所以顶层 await 没有本规则要防的那条代价路径。
      "node/no-top-level-await": "off",
    },
  },
  {
    files: ["lib/sidecar.ts"],
    rules: {
      // child.done 是一条**故意不 await** 的链：子进程活着的时候它永远 pending，
      // 这里只是在它落定的那一刻做清理。没有可 await 的位置，改成 async/await 反而
      // 会把整个 spawn 挂住。
      "promise/prefer-await-to-then": "off",
      // 同两处的回调位（pumpFrames 的错误回调与 child.done.then 的第二臂）：让本条满足
      // 就得改成 await，而那正是上一条否证掉的写法。
      "promise/prefer-await-to-callbacks": "off",
      // 两臂 then 的第二臂只接 done 自身的拒绝；`.then(f).catch(r)` 会把 f 的拒绝
      // 也算成 spawn 失败并二次收尾。理由与实测条数见 OFF_REASONS。
      "promise/prefer-catch": "off",
      // 与 unicorn/no-useless-spread 直接互斥：Map/Set 的 values() 展开会被那条规则
      // 判成 no-useless-spread，改用 Array.from 又会被本条判成 prefer-spread。
      "unicorn/prefer-spread": "off",
    },
  },
  {
    // 这些用例用两臂 then 把「兑现」写成 `throw`（断言失败），只让拒绝臂接
    // Promise 自身的拒绝；`.then(f).catch(r)` 会把断言失败吞进拒绝臂。理由与
    // 实测条数见 OFF_REASONS。
    files: [
      "test/mcp-server.test.ts",
      "test/host.test.ts",
      "test/tools.test.ts",
      "test/sidecar.test.ts",
    ],
    rules: {
      "promise/prefer-catch": "off",
    },
  },
] satisfies NonNullable<PluginLintOptions["extraOverrides"]>;

export default definePluginConfig({
  // bin/ 是构建产物（压缩后的单文件 CLI），与 host.js/client.js 同类，不参与源码 lint。
  extraIgnorePatterns: ["bin/**"],
  syncIoScopes: SYNC_IO_SCOPES,
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
  extraOverrides: EXTRA_OVERRIDES,
  offReasons: OFF_REASONS,
});
