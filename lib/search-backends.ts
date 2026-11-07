// dsh-scrapling/lib/search-backends.ts —— 发现后端名单的单一定义处。
//
// 名单定义在独立模块而不是 lib/search-provider.ts：CLI（lib/cli.ts）要拿这份名单判配置，而
// search-provider 拖 sidecar 与网络依赖，被 bin 的打包一并带进来正是 lib/cli.ts 一直避开的
// （见该文件里 SEARCH_PROVIDER_NAME 那条本地常量）。类型从这份数组派生，所以「数组里有、
// 类型里没有」这类分叉不成立。设置卡的 enum 面（src/settings-fields.ts）读同一份数组，
// 客户端产物里多的只是一串字面量。

/** 发现后端。`auto` = 按配了的 key / SearXNG 依次挑，两条都没有时只看 searchPublicFallback。 */
export const SEARCH_BACKENDS = [
  "auto",
  "tavily",
  "bing",
  "brave",
  "serper",
  "duckduckgo",
  "searxng",
] as const;

/** 一个已实现的后端名；空串与拼错的都不在这份名单里。打过真实端点的是哪几档见 src/settings-fields.ts 的 hint。 */
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

/** 这个后端名是不是本包实现了的那一档（空串与拼错的都不是）。 */
export function isSearchBackend(value: string): value is SearchBackend {
  return (SEARCH_BACKENDS as readonly string[]).includes(value);
}
