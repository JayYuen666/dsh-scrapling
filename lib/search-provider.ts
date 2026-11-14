// dsh-scrapling/lib/search-provider.ts —— 搜索 + 渲染一体化，接管内置 web_search。
//
// 为什么需要它：Scrapling 本身**不是搜索引擎**（源码里 `google_search` 只是一个「加 Google
// referer 头」的选项），所以这里把「检索」与「读取」拆成两段：检索交给一个可配置的搜索
// 后端拿 URL 列表，读取交给本插件的 sidecar —— 有浏览器就走渲染，于是内置 web_fetch 结构
// 上读不到的那些 SPA 页面也能进上下文。
//
// 为什么走 provider 而不是同名注册工具：`ToolRuntime.register` 最终落到
// `NamedEntries.insert`，重名会**抛错**（`tool "X" is already registered`），所以工具名换不掉；
// 能换的只有执行后端。这条缝是 dsh-web 官方提供的 —— tool-web 只管模型侧 schema 与排版，
// provider 选择与网络访问都在 ctx.web 里。
//
// 为什么 available() 要看「有没有可用的发现后端」：注册了第二个「可用」的 search provider 而
// 部署侧没配 searchProvider，内置 web_search 会直接不可用（WEB_PROVIDER_AMBIGUOUS）。所以
// provideWebSearch 虽然默认开，available() 在 auto 既没 key、没 SearXNG、又没开公共回退时
// 返回 false —— 只开开关不会误接管 web_search，也不会把查询词悄悄发给公共引擎（spec D10）。
import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import type { Reader } from "./config-reader.ts";
import type { SearchBackend } from "./search-backends.ts";
import type { SidecarClient } from "./sidecar.ts";
import { SidecarError } from "./sidecar-error.ts";

/** 本 provider 在 ctx.web 的 search 接缝里的 id。 */
export const SEARCH_PROVIDER_ID = "scrapling";

/**
 * Brave 与 Serper 的官方 JSON 端点。
 *
 * 这两个后端只有单一对端、没有自托管镜像的常见形态，所以没有做成部署项；Tavily / Bing /
 * DuckDuckGo / SearXNG 的默认值都落在「部署方会换」的地址上，因此走 Config。端点仍是
 * SearchProviderDeps 的入参，测试照旧可以从入参注入。
 */
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Serper 的搜索端点，与 {@link BRAVE_SEARCH_ENDPOINT} 同一档（只有官方对端）。 */
export const SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search";

/**
 * 发现层后端的名单与类型定义在 `lib/search-backends.ts`：CLI 判配置要读同一份名单，而它不能
 * import 本模块（那会把 sidecar 依赖一起拖进 bin 产物）。
 */

/** 建 search provider 需要的参数。 */
export interface SearchProviderDeps {
  /** 已握手的 sidecar 客户端。 */
  readonly sidecar: SidecarClient;
  /**
   * 发现后端：auto 依次尝试配了 key 的 API 后端与 SearXNG，两者都没有时按
   * {@link SearchProviderDeps.publicFallback} 决定是否回落到公共引擎。
   *
   * 读取器：`searchBackend` 是可热改的部署项。
   */
  readonly backend: Reader<SearchBackend>;
  /** Tavily / Brave / Serper 各自的 API key；空串表示没配。三者都是读取器。 */
  readonly apiKey: Reader<string>;
  readonly braveApiKey: Reader<string>;
  readonly serperApiKey: Reader<string>;
  /**
   * 各后端的端点（测试或部署覆盖）。
   *
   * 这几位**不是**读取器：它们不在设置卡上，装配后不会变。只有 `searxngEndpoint` 例外
   * —— 它是用户要在卡上填的部署项，所以单独做成读取器。
   */
  readonly apiEndpoint: string;
  readonly bingEndpoint: string;
  readonly braveEndpoint: string;
  readonly serperEndpoint: string;
  readonly duckduckgoEndpoint: string;
  /** SearXNG 实例地址；空串表示这条后端不可用。读取器。 */
  readonly searxngEndpoint: Reader<string>;
  /**
   * auto 后端是否允许回落到公共引擎（DuckDuckGo → Bing）。
   *
   * 默认 false（spec D10）：公共引擎会把查询词发给第三方，属于要部署方明确同意的行为。
   * 显式把 backend 设成公共引擎时这一项不参与判断 —— 那已经是明确选择。
   *
   * 读取器：卡上可以随时打开它。
   */
  readonly publicFallback: Reader<boolean>;
  /** 搜索结果里前几条要真的抓下来渲染。不在卡上，装配后不变。 */
  readonly renderTopN: number;
  /**
   * 单次抓取的字节预算。读取器：`fetchMaxOutputChars` 是可热改的部署项，且它与
   * `dsh-scrapling_fetch` 等工具共用同一枚设置。
   */
  readonly maxOutputBytes: Reader<number>;
  /**
   * 每一次 sidecar 调用的超时（毫秒）：发现一次、逐条渲染的各次都吃这一位，
   * 所以一次 `search` 的自身上界约为 `(1 + renderTopN) × timeoutMs`。
   *
   * 整次工具调用的上界不在本层：宿主把同一枚设置（`fetchTimeoutMs`）声明在
   * `ToolDefinition.timeoutMs` 上，由它负责取消整笔调用。
   *
   * 读取器：`fetchTimeoutMs` 是可热改的部署项。
   */
  readonly timeoutMs: Reader<number>;
  /**
   * 出站 URL 的准入闸门；与 sidecar 用的是同一个实现（Host 侧那道 SSRF 防线）。
   *
   * `sources` 是回给模型去引用、去接着抓的 URL 清单。搜索后端的回包是**外部输入**，
   * 它尽可以回一条内网地址过来；不过这道闸门的话，那些地址就原样出现在模型眼前，
   * 而本包对同一地址的抓取请求是会被拦下的 —— 一边说「这是你的结果」、一边说「它不可抓」。
   * 判否的条目不进 sources；通过时用它交回的那个串（闸门可能归一过），与 sidecar 发出
   * 去的是同一个地址。
   *
   * 必填：闸门缺席时静默放行等于把这道防线做成 fail-open 的默认值，而生产装配
   * （`host.ts` 的 `searchProviderOf`）本来就每一侧都传同一个闸门。
   */
  readonly urlGate: (url: string) => Promise<string | undefined>;
}

/** 搜索后端返回的一条结果。 */
export interface ParsedSearchHit {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

/**
 * 从 sidecar 的 `search.discover` 回包里挑出可用条目。
 *
 * 条目是对象、url 是非空字符串才算数。**URL 的安全判定不在这里做** —— 真正去读它们时
 * sidecar 的 URL 闸门会逐条判，放在解析层等于把一份安全策略复制一遍。
 *
 * @param payload - sidecar 的 result
 * @returns 命中的条目
 * @throws WebError - 回包形状不是协议声明的那一个
 */
function hitsOf(payload: unknown): ParsedSearchHit[] {
  if (!isRecord(payload) || !Array.isArray(payload["hits"])) {
    throw new WebError("search discovery returned no hits array", "SCRAPLING_SEARCH_FAILED");
  }
  return payload["hits"].flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const { url, title, snippet } = item;
    if (typeof url !== "string" || url.length === 0) {
      return [];
    }
    return [
      {
        url,
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
        ...(typeof snippet === "string" && snippet.length > 0 ? { snippet } : {}),
      },
    ];
  });
}

/**
 * 把一条 URL 归一成绝对 URL；相对 URL 拼到搜索端点上。
 *
 * `endpoint` 为空串（后端不认识）时不借任何基准：只有本来就是绝对 URL 的才留得下来，
 * 相对的那一条宁可丢掉，也不拼到一台不是它自己的主机上去。
 *
 * @param raw - 端点返回的 URL 文本
 * @param endpoint - 搜索端点，作为相对 URL 的基准；空串表示没有可用基准
 * @returns 绝对 URL；拼不出来时给空串
 */
function absolutize(raw: string, endpoint: string): string {
  try {
    return new URL(raw, endpoint.length > 0 ? endpoint : undefined).toString();
  } catch {
    return "";
  }
}

/** 每条后端只认自己那把 key；拼错后端名不会把 Tavily 的 key 递给 Brave。 */
function selectKey(deps: SearchProviderDeps): string {
  const backend = deps.backend();
  if (backend === "brave") {
    return deps.braveApiKey();
  }
  if (backend === "serper") {
    return deps.serperApiKey();
  }
  return deps.apiKey();
}

/**
 * 各后端的基准端点：相对 URL 只能按**回包里那个后端自己的**端点归一。
 *
 * 一律回落到某个固定端点会把引用拼到另一台主机上（SearXNG 实例回的相对路径拼成 Bing 的
 * 绝对 URL 就是这样），既交给模型引用错了地址，也让闸门按错误的主机下结论。认不出后端时给
 * 空串，交给 {@link absolutize} 把相对 URL 判成拼不出来而丢掉。
 *
 * @param deps - provider 依赖
 * @param backend - 回包里报的实际后端
 * @returns 该后端的端点；后端不认识时为空串
 */
function endpointOf(deps: SearchProviderDeps, backend: string): string {
  switch (backend) {
    case "tavily": {
      return deps.apiEndpoint;
    }
    case "bing": {
      return deps.bingEndpoint;
    }
    case "brave": {
      return deps.braveEndpoint;
    }
    case "serper": {
      return deps.serperEndpoint;
    }
    case "duckduckgo": {
      return deps.duckduckgoEndpoint;
    }
    case "searxng": {
      return deps.searxngEndpoint();
    }
    default: {
      return "";
    }
  }
}

/**
 * 调 sidecar 的发现层，取回条目。
 *
 * SEARCH_* 错误码原样保留：Tavily 没配 key 是 SEARCH_AUTH，用户要能据此改配置；
 * 折成通用的失败码只会让「没配 key」和「后端挂了」看起来一样。
 *
 * @param deps - provider 依赖
 * @param query - 已 trim 过的查询词
 * @param maxResults - 候选条数
 * @param signal - 取消信号
 * @returns 命中的条目与相对 URL 的基准端点
 */
async function discover(
  deps: SearchProviderDeps,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<{ hits: ParsedSearchHit[]; base: string }> {
  // 一次操作只取一次快照：下面的 JSON 与协议层超时必须是同一刻的值，边发边取会让
  // 「timeoutSeconds 说 30 秒、协议层却等 120 秒」这种自相矛盾的回包成为可能。
  const backend = deps.backend();
  const timeoutMs = deps.timeoutMs();
  try {
    const raw = await deps.sidecar.call(
      "search.discover",
      {
        backend,
        query,
        maxResults,
        apiKey: selectKey(deps),
        apiEndpoint: deps.apiEndpoint,
        bingEndpoint: deps.bingEndpoint,
        braveEndpoint: deps.braveEndpoint,
        serperEndpoint: deps.serperEndpoint,
        duckduckgoEndpoint: deps.duckduckgoEndpoint,
        searxngEndpoint: deps.searxngEndpoint(),
        publicFallback: deps.publicFallback(),
        timeoutSeconds: timeoutMs / 1000,
      },
      { ...(signal === undefined ? {} : { signal }), timeoutMs },
    );
    const reported = isRecord(raw) && typeof raw["backend"] === "string" ? raw["backend"] : backend;
    return {
      hits: hitsOf(raw),
      base: endpointOf(deps, reported),
    };
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      throw error;
    }
    if (error instanceof WebError) {
      throw error;
    }
    if (error instanceof SidecarError && error.code.startsWith("SEARCH_")) {
      throw new WebError(error.message, error.code);
    }
    throw new WebError(String(error), "SCRAPLING_SEARCH_FAILED");
  }
}

/** 默认最多回多少条 source；上游不给 maxResults 时用它。 */
const DEFAULT_MAX_RESULTS = 8;

/**
 * 一次搜索最多把多少条命中拿去过闸。
 *
 * 每条命中都要过一次闸门，而闸门要解析 DNS —— 后端一次回一万条的话，那就是一万次
 * 解析。所以封顶必须落在**过闸之前**：先截出前 MAX_SOURCES 条当候选，闸门的总耗时才
 * 真正有上界（此前上限只裁剪最终输出，一万条命中照样过一万次闸，注释与实现各说各话）。
 * 超出部分反正到不了结果里 —— maxResults 自身也被钉在同一个数上。
 */
const MAX_SOURCES = 100;

/**
 * 把上游给的 maxResults 收成一个可用的条数。
 *
 * 0 与负数必须**报错**而不是夹成 0：夹过去之后这次调用会变成一次「成功但一条结果都没有」
 * 的搜索，模型与用户都看不出是入参不对，只会以为搜不到东西。上游的类型说明是
 * 「Omitted = no bound」，所以缺省走默认值，给了就必须是正整数。
 *
 * @param raw - 上游给的条数
 * @returns 归一后的条数
 * @throws WebError - 给了但不是正整数
 */
function boundResults(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_MAX_RESULTS;
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new WebError(
      `maxResults must be a positive integer, got ${raw}`,
      "SCRAPLING_SEARCH_FAILED",
    );
  }
  return Math.min(raw, MAX_SOURCES);
}

/**
 * 一条候选归一之后的三种下场。
 *
 * 「拼不成绝对 URL」与「被闸门判否」分开记是有必要的：一次搜索一条结果都没有时，
 * 前者要用户去查后端的回包，后者才去查部署方的安全策略 —— 压成一句会让排查走错方向。
 */
type SourceOutcome =
  | { readonly kind: "ok"; readonly source: WebSearchSource }
  | { readonly kind: "unparsable" }
  | { readonly kind: "rejected" };

/**
 * 这个后端此刻配没配齐它能用的凭据。
 *
 * 与 {@link selectKey} 是同一条规则的两面：`selectKey` 答「该把这个后端的哪把 key 发出去」，
 * 这里答「那把 key 在不在」。两者分开写是因为 `selectKey` 的缺省分支回的是 Tavily 的 key
 * （`tavily` 与 `auto` 都落它），而 `auto` 的凭据判据要看**所有**可能的发现路径。
 *
 * 公开端点（Bing、DuckDuckGo）不需要凭据，恒 true —— 它们要的是
 * {@link SearchProviderDeps.publicFallback} 那种部署方的表态，而不是 key。
 *
 * @param deps - provider 依赖
 * @param backend - 当下选中的后端
 * @returns 发得出一次检索时为 true
 */
function hasCredentialFor(deps: SearchProviderDeps, backend: SearchBackend): boolean {
  switch (backend) {
    case "auto": {
      // auto 会依次试 Tavily、SearXNG，都不行再看 publicFallback（与 py/search.py 一致）。
      return deps.apiKey().length > 0 || deps.searxngEndpoint().length > 0 || deps.publicFallback();
    }
    case "tavily": {
      return deps.apiKey().length > 0;
    }
    case "brave": {
      return deps.braveApiKey().length > 0;
    }
    case "serper": {
      return deps.serperApiKey().length > 0;
    }
    case "searxng": {
      return deps.searxngEndpoint().length > 0;
    }
    case "bing":
    case "duckduckgo": {
      // 公开端点，没有凭据可配。
      return true;
    }
    default: {
      // 类型上是封闭联合，但**配置是运行期读出来的**：profile patch 里留着旧版本的后端名、
      // 或用户手改 settings 写了拼错的值，都会走到这里（`lib/cli.ts` 的
      // `isSearchBackend` 只在 CLI 那条路上收窄，插件装配路径没有第二道门）。这一档取
      // 保守侧：不露面。当成公开端点等于替用户打开一条他没配过的发现路径。
      return false;
    }
  }
}

/**
 * 把一条命中归一成可引用的 source。
 *
 * 闸门判否就**丢掉这一条**：它是本次搜索的输入，而输入能不能变成一条结果由部署方的安全
 * 策略说了算。丢掉的条目不进 sources，于是模型不会引用一个它紧接着就抓不到的地址。
 *
 * @param hit - 后端返回的条目
 * @param endpoint - 该后端自己的端点，相对 URL 的基准；空串表示没有可用基准
 * @param gate - 出站 URL 的准入闸门
 * @returns 通过时给那一条 source，否则给被丢掉的原因
 */
async function toSource(
  hit: ParsedSearchHit,
  endpoint: string,
  gate: (url: string) => Promise<string | undefined>,
): Promise<SourceOutcome> {
  const url = absolutize(hit.url, endpoint);
  if (url.length === 0) {
    return { kind: "unparsable" };
  }
  let citeable: string;
  try {
    const normalized = await gate(url);
    // 闸门可能把 URL 归一过。判的和引用的必须是同一个串，否则归一化又成一条绕过的路子。
    citeable = typeof normalized === "string" ? normalized : url;
  } catch {
    // 被安全闸门拦下（私网、元数据端点、非 http(s)…）：这一条不作为结果交出去。
    return { kind: "rejected" };
  }
  return {
    kind: "ok",
    source: {
      url: citeable,
      ...(hit.title === undefined ? {} : { title: hit.title }),
      ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
    },
  };
}

/** 一条命中的读取结果：正文，或「为什么没正文」。 */
interface FetchOutcome {
  /** 读到的正文；读不到时是空串。 */
  readonly body: string;
  /** 读失败的原因。整场都失败时用它收场，免得「什么都没读到」被当成成功。 */
  readonly reason: string;
}

/**
 * 真去抓一条，返回该条的小节正文或失败原因。
 *
 * 单条读不到时**不抛**：搜索结果里混着失效链接是常态，不该让整次调用失败。
 * 但「读不到」的原因要留着 —— 全部条目都读不到时，那正是用户唯一能看到线索的地方，
 * 尤其当原因是 URL 被安全闸门拦下时。
 *
 * @param source - 要读的 source
 * @param deps - provider 依赖
 * @param signal - 取消信号
 * @returns 正文与失败原因
 */
async function fetchContent(
  source: WebSearchSource,
  deps: SearchProviderDeps,
  signal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  try {
    // 同一笔抓取里「发给 sidecar 的字符上限」与「协议层超时」取同一刻的快照。
    const maxContentChars = deps.maxOutputBytes();
    const timeoutMs = deps.timeoutMs();
    const raw: unknown = await deps.sidecar.call(
      deps.sidecar.capabilities?.browser === true ? "render" : "fetch",
      {
        url: source.url,
        cssSelector: null,
        extractionType: "markdown",
        mainContentOnly: true,
        headless: true,
        networkIdle: false,
        maxContentChars,
      },
      { ...(signal === undefined ? {} : { signal }), timeoutMs },
    );
    if (!isRecord(raw)) {
      // 三种「读不到」分开点名：协议违例（回包不是对象、正文不是字符串）是 sidecar 或
      // 本仓解包坏了，「这一页确实没有正文」是目标站的常态。挤成同一句话会把用户送去
      // 查安全策略，而该查的是协议。
      return { body: "", reason: `the fetch reply was not an object (${typeof raw})` };
    }
    const { content } = raw;
    if (typeof content !== "string") {
      return { body: "", reason: `the page came back without a text body (${typeof content})` };
    }
    return content.length > 0
      ? { body: content, reason: "" }
      : { body: "", reason: "the page came back with no body" };
  } catch (error: unknown) {
    // 取消不归到「这条链接死了」：调用方按了取消，语义是整次调用作废，不是这一条没读到。
    // 吞掉它，一次取消就会表现为「搜到了结果但正文全空」，用户无从判断发生了什么。
    if (signal?.aborted === true) {
      throw error;
    }
    // 带机器可读码的错误（URL_BLOCKED / SIDECAR_TIMEOUT …）把码也写进原因：用户看到的
    // 是「被安全闸门拦下」还是「sidecar 超时」，这两件事要采取的行动完全不同，
    // 而 String(error) 里只有一个错误类名和消息。
    const code = error instanceof SidecarError ? `${error.code}: ` : "";
    return { body: "", reason: `${code}${String(error)}` };
  }
}

/**
 * 把一条 source 渲染成 Markdown 小节。
 *
 * 读不到就跳过那一条：搜索结果里混着失效链接是常态，不该让整次调用失败。
 *
 * @param source - 要读的 source
 * @param deps - provider 依赖
 * @param signal - 取消信号
 * @returns 小节正文与失败原因
 */
async function renderBody(
  source: WebSearchSource,
  deps: SearchProviderDeps,
  signal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  const outcome = await fetchContent(source, deps, signal);
  if (outcome.body.length === 0) {
    return outcome;
  }
  return { body: `## ${source.title ?? source.url}\n\n${outcome.body}`, reason: "" };
}

/**
 * 建一个 ctx.web search provider：检索 + 渲染一体。
 *
 * @param deps - 依赖
 * @returns provider
 */
export function createWebSearchProvider(deps: SearchProviderDeps): WebSearchProvider {
  return {
    id: SEARCH_PROVIDER_ID,

    /**
     * 本地可用性判断。契约要求**不得发网络请求**，所以只看 sidecar 是否握手成功。
     *
     * Tavily 没配 key 仍然算可用：让 search() 报 SEARCH_AUTH，用户才知道该去补哪一项；
     * 在这里静默降级就等于把「配置错了」伪装成「这个 provider 不存在」。
     *
     * @returns 是否可用
     */
    available(): boolean {
      if (!(deps.sidecar.alive && deps.sidecar.capabilities?.scrapling === true)) {
        return false;
      }
      if (deps.backend() !== "auto") {
        // 显式后端：key 缺了也要让 search() 报 SEARCH_AUTH，用户才知道补哪一项；
        // 在这里静默退回“不可用”就等于把配置错误伪装成 provider 不存在。
        return true;
      }
      // auto：只有存在一条真正的发现路径才算可用。公共引擎不是默认路径 —— 它要
      // publicFallback 明确打开，否则查询词会被悄悄发给第三方（spec D10）。
      // 判据与 py/search.py 的 auto 解析保持一致：auto 只看 Tavily key 与 SearXNG
      // 端点，brave/serper 的 key 属于显式选择那些后端的场景。
      return deps.apiKey().length > 0 || deps.searxngEndpoint().length > 0 || deps.publicFallback();
    },

    /**
     * 内置 `web_search` 要不要露给模型。
     *
     * 与 {@link createWebSearchProvider} 里的 `available()` 是**两套判据**，别合并：
     * - `available()` 答「本 provider 该不该进 ctx.web 的候选」，显式后端恒 true（key 缺了
     *   要留给 search() 报 SEARCH_AUTH）；
     * - `ready()` 答「这一条请求路线发得出凭据吗」，而宿主拿它给 `web_search` 装
     *   `when` 门 —— 答 false 时那个工具**整个不出现在模型面前**（`dsh-tool-web` 的
     *   `{ when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider) }`）。
     *   谁都没配却照样把 web_search 露出来，模型只会撞一次 SEARCH_AUTH，然后整轮都
     *   不知道这个能力其实没配好。
     *
     * 按官方 `dsh-web-search-deepseek` 的做法，这里只查配置、不发网络请求。
     *
     * @param _llmProvider - 宿主传进来的模型路线 id；本 provider 的凭据与模型无关，忽略它
     * @returns 当前配置下是否发得出一次检索
     */
    // 返回 Promise 的函数被要求声明 async，而这一位真的没有可等待的操作：契约明写
    // ready() 只查配置、不得发网络请求。两条 lint 在这里互相顶住，取「声明 async、
    // 关掉 require-await」这一侧 —— 反过来写成非 async + Promise.resolve 会撞
    // typescript/promise-function-async，同样要一行豁免，而 async 写法与宿主其余
    // provider 的形状一致。
    // oxlint-disable-next-line typescript/require-await -- ready 是同步判配置，async 没有可等待的操作
    async ready(_llmProvider: string | undefined): Promise<boolean> {
      const reachable = deps.sidecar.alive && deps.sidecar.capabilities?.scrapling === true;
      return reachable && hasCredentialFor(deps, deps.backend());
    },

    /**
     * 检索一次，并把前几条结果真的抓下来渲染。
     *
     * 正文放在 `content`：上游把它定义成「provider 生成的答案正文/摘要」，Perplexity 那类
     * provider 就是这么用的。`sources` 仍是可引用的 URL 列表。
     *
     * @param request - 请求
     * @param signal - 取消信号
     * @returns 归一后的搜索结果
     */
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      const query = request.query.trim();
      if (query.length === 0) {
        throw new WebError("empty query", "SCRAPLING_SEARCH_FAILED");
      }
      const maxResults = boundResults(request.maxResults);

      const { hits, base } = await discover(deps, query, maxResults, signal);
      // sources 也要过准入闸门：搜索后端的回包是外部输入，它尽可以回一条内网地址；
      // 不过闸的话，那条地址就原样出现在模型眼前，而本包对同一地址的抓取会被拦下。
      // 候选先截到 MAX_SOURCES 再过闸 —— 闸门每条一次 DNS，封顶必须落在过闸之前。
      const candidates = hits.slice(0, MAX_SOURCES);
      const cited = await Promise.all(candidates.map((hit) => toSource(hit, base, deps.urlGate)));
      const sources = cited.flatMap((outcome) => (outcome.kind === "ok" ? [outcome.source] : []));
      // 一条都不剩时必须报错，而不是回一次「成功但没有结果」的搜索：后端只回了内网地址
      // 与「搜不到东西」是两件完全不同的事，后者才是用户想看到的那一种。两种丢弃原因分开
      // 点名——只说「被闸门拒绝」会把「后端回了拼不成绝对 URL 的值」也带去查安全策略。
      if (sources.length === 0 && candidates.length > 0) {
        const rejected = cited.filter((outcome) => outcome.kind === "rejected").length;
        const unparsable = cited.filter((outcome) => outcome.kind === "unparsable").length;
        throw new WebError(
          `none of the ${String(candidates.length)} results could be cited: ` +
            `${String(rejected)} rejected by the URL gate, ` +
            `${String(unparsable)} were not usable URLs`,
          "SCRAPLING_SEARCH_FAILED",
        );
      }
      const bounded = sources.length > maxResults;
      const kept = bounded ? sources.slice(0, maxResults) : sources;

      // 前 toRender 条并发走 sidecar：URL 闸门在 sidecar.call 里逐条判；浏览器可用时
      // render 走 Playwright 渲染后再抽，正好补上内置 web_fetch 读不到 SPA 的那块。
      // Promise.all 保序，所以并发不影响 sources 与正文小节的对应关系。
      const toRender = Math.max(0, Math.min(deps.renderTopN, kept.length));
      const outcomes = await Promise.all(
        kept.slice(0, toRender).map((source) => renderBody(source, deps, signal)),
      );
      const bodies = outcomes.filter((outcome) => outcome.body.length > 0);

      // 有 sources 却一条正文都没读到时必须报错。原先一律返回「sources + 没有 content」，
      // 于是全部链接被安全闸门拦下、sidecar 崩了、后端超时 —— 三种完全不同的故障都表现为
      // 一次「成功但没有内容」的搜索。URL 被拦是最需要被看见的一种。
      if (toRender > 0 && bodies.length === 0) {
        // 正文为空的 outcome 一定带 reason（两条产出路径都写了），所以这里不再兜一层
        // 「没有原因」的分支 —— 那种写法既走不到，真走到时也只会印出 undefined。
        const reasons = outcomes.map((outcome) => outcome.reason);
        throw new WebError(
          `none of the first ${toRender} results could be read: ${reasons.join("; ")}`,
          "SCRAPLING_SEARCH_FAILED",
        );
      }

      return {
        ...(bodies.length > 0
          ? { content: bodies.map((outcome) => outcome.body).join("\n\n") }
          : {}),
        sources: kept,
        truncated: bounded,
      };
    },
  };
}
