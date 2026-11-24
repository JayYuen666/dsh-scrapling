// dsh-scrapling/lib/search-backends.ts —— 发现后端名单的单一定义处。
//
// 名单定义在独立模块而不是 lib/search-provider.ts：CLI（lib/cli.ts）要拿这份名单判配置，而
// search-provider 拖 sidecar 与网络依赖，被 bin 的打包一并带进来正是 lib/cli.ts 一直避开的
// （见该文件里 SEARCH_PROVIDER_NAME 那条本地常量）。类型从这份数组派生，所以「数组里有、
// 类型里没有」这类分叉不成立。设置卡的 enum 面（src/settings-fields.ts）读同一份数组，
// 客户端产物里多的只是一串字面量。

/** 发现后端。`auto` = 按配了的 key / SearXNG 依次挑；deepseek 由 Host 侧 ctx.deepseekAuth 授权。 */
export const SEARCH_BACKENDS = [
  "auto",
  "tavily",
  "bing",
  "brave",
  "serper",
  "duckduckgo",
  "searxng",
  "deepseek",
] as const;

/**
 * 设置项上可以写的后端取值。
 *
 * **这个类型里带着哨兵值 `auto`**，它不是一个后端，而是「按配了凭据的那几档依次挑」这条策略
 * （见 {@link SEARCH_BACKENDS} 的说明）。所以凡是标成 `SearchBackend` 的地方，消费点都得自己
 * 决定 `auto` 走哪一支：
 *
 * - 判「发不发得出一次检索」时它要**汇总所有发现路径**（`lib/search-provider.ts` 的
 *   `hasCredentialFor` 的 `case "auto"`）；
 * - 判「该催用户配哪个 key」时它**没有对应的凭据项**（`lib/cli.ts` 的 `BACKEND_CREDENTIAL`
 *   里刻意不列它，取出来是 `undefined`）；
 * - 往下传之前要先落成具体后端（`auto` 直传 sidecar 不是一个后端名，见 `lib/search-provider.ts`
 *   里解析实际后端那一段）。
 *
 * 不拆成「含 auto / 不含 auto」两个类型的理由：`auto` 是设置项的默认值，拆开之后每个读设置
 * 的地方都要多一次收窄，而收窄失败的表现是编译错而不是行为错——收益不抵这层噪音。代价就是
 * 上面这三条得靠注释和分支各自守住。
 */
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

/** 这个取值是不是名单里的一个（空串与拼错的都不是）。**注意 `auto` 也会被判真** —— 本函数只判「名单里有没有」，不判「是不是一个具体后端」。 */
export function isSearchBackend(value: string): value is SearchBackend {
  return (SEARCH_BACKENDS as readonly string[]).includes(value);
}
