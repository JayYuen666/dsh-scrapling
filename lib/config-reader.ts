// dsh-scrapling/lib/config-reader.ts —— 热改配置项的取值函数类型。
//
// 为什么需要它：设置卡上标了 `.volatile()` 的位改值**不会重跑 `apply`**。宿主只把新值
// 提交给已经装好的那份配置引用（`updateVolatile(ref, source)`），插件的 `apply` 一个字节
// 都不会再执行。所以任何在装配时把值抄进闭包的地方，卡上拧了旋钮都**不会生效**，而回包
// 形状照旧、日志照旧、没有任何异常 —— 这是本仓最难查的一类缺陷（`dsh-rtk` 踩过同一坑）。
//
// `Volatile<T>` 的契约原文就是「A stable reference; keep the reference, or capture its
// value for one operation only.」所以正解有两条：要么在装配时把 **ref 传进来**、在每次
// 操作的入口现取快照；要么把值抄下来就永远别想它变。本仓统一走前者，用这个类型标注。
//
// 约定（写在这里，省得每个依赖接口各说一遍）：
// - 一次操作只取**一次**快照，别在同一笔调用里分散读两次 —— 否则「JSON 里说 30 秒、
//   协议层却等 120 秒」这种自相矛盾的回包会成为可能；
// - 非 volatile 的部署值不必套这层，传字面量就行，多了反而让调用点看不出哪些是热改位。
//
// 引用面：`lib/search-provider.ts` 与 `lib/web-provider.ts` 各 import 一次（类型面）；测试层与
// 文档层不直接引用它（`grep config-reader` 在 test/ 与 docs/ 下零命中，测的是行为不是类型）。
// 受影响面：`lib/search-provider.ts` 的 `SearchProviderDeps` 与 `lib/web-provider.ts` 的
// `WebProviderDeps` 会 import 本类型的 `Reader<Value>`（改的是它们的字段类型），随之需要同步
// 改的测试是 `test/search-provider.test.ts`、`test/web-provider.test.ts`、
// `test/protocol-conformance.test.ts` 三处的依赖字面量；README 与 DETAIL 里描述的
// 「设置卡改值即时生效」行为不变，无需改写。
// 用户指令原文（m25880）：「按官方做法：没凭据就返回 false，web_search 直接不出现」、
// 「两个 provider 都修（推荐）」。

/**
 * 取当下这一刻的配置值。
 *
 * @typeParam Value - 被读出的值
 * @returns 此刻的配置值（不是装配时的值）
 */
export type Reader<Value> = () => Value;
