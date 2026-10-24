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
// 为什么 available() 要看搜索端点：注册了第二个「可用」的 search provider 而部署侧没配
// searchProvider，内置 web_search 会直接不可用（WEB_PROVIDER_AMBIGUOUS）。所以 provideWebSearch
// 虽然默认开，available() 在没配搜索端点时仍返回 false —— 只开开关不会误接管 web_search。
import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import type { SidecarClient } from "./sidecar.ts";
import { SidecarError } from "./sidecar-error.ts";

/** 本 provider 在 ctx.web 的 search 接缝里的 id。 */
export const SEARCH_PROVIDER_ID = "scrapling";

/** 建 search provider 需要的参数。 */
export interface SearchProviderDeps {
  /** 已握手的 sidecar 客户端。 */
  readonly sidecar: SidecarClient;
  /**
   * 搜索后端端点（部署级）。留空 = 不提供搜索能力，available() 返回 false。
   *
   * 期望是 SearXNG 兼容的 JSON 接口：GET `<endpoint>?q=<query>&format=json`，
   * 返回 `{"results": [{"url", "title", "content"}]}`。别的后端只要能出这个形状也行。
   */
  readonly searchEndpoint: string;
  /** 搜索结果里前几条要真的抓下来渲染。 */
  readonly renderTopN: number;
  /** 单次抓取的字节预算。 */
  readonly maxOutputBytes: number;
  /** 单次搜索的协同超时（毫秒）。 */
  readonly timeoutMs: number;
  /**
   * 出站 URL 的准入闸门；与 sidecar 用的是同一个实现（Host 侧那道 SSRF 防线）。
   *
   * `sources` 是回给模型去引用、去接着抓的 URL 清单。搜索后端的回包是**外部输入**，
   * 它尽可以回一条内网地址过来；不过这道闸门的话，那些地址就原样出现在模型眼前，
   * 而本包对同一地址的抓取请求是会被拦下的 —— 一边说「这是你的结果」、一边说「它不可抓」。
   * 判否的条目不进 sources；通过时用它交回的那个串（闸门可能归一过），与 sidecar 发出
   * 去的是同一个地址。
   */
  readonly urlGate?: ((url: string) => Promise<string | undefined>) | undefined;
}

/** 搜索后端返回的一条结果。 */
export interface ParsedSearchHit {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

/**
 * 取出搜索后端的条目数组。
 *
 * 认两种形状：SearXNG 的 `results`，以及更常见的 `items`。
 *
 * @param payload - 已确认是对象的回包
 * @returns 条目数组；两种键都不是数组时给空数组
 */
function resultList(payload: Record<string, unknown>): unknown[] {
  const { results, items } = payload;
  if (Array.isArray(results)) {
    return results;
  }
  if (Array.isArray(items)) {
    return items;
  }
  return [];
}

/**
 * 从搜索后端的回包里挑出可用的结果条目。
 *
 * 条目是对象、url 是非空字符串才算数。**URL 的安全判定不在这里做** —— 真正去读它们时
 * sidecar 的 URL 闸门会逐条判，放在解析层等于把一份安全策略复制一遍。
 *
 * @param payload - 解析后的 JSON
 * @returns 命中的条目（可能为空）
 */
export function parseSearchResults(payload: unknown): ParsedSearchHit[] {
  if (!isRecord(payload)) {
    return [];
  }
  return resultList(payload).flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const { url, title, content, snippet } = item;
    if (typeof url !== "string" || url.length === 0) {
      return [];
    }
    const text = content ?? snippet;
    return [
      {
        url,
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
        ...(typeof text === "string" && text.length > 0 ? { snippet: text } : {}),
      },
    ];
  });
}

/**
 * 把一条 URL 归一成绝对 URL；相对 URL 拼到搜索端点上。
 *
 * @param raw - 端点返回的 URL 文本
 * @param endpoint - 搜索端点，作为相对 URL 的基准
 * @returns 绝对 URL；拼不出来时给空串
 */
function absolutize(raw: string, endpoint: string): string {
  try {
    return new URL(raw, endpoint).toString();
  } catch {
    return "";
  }
}

/**
 * 打一次搜索后端，取回它的条目。
 *
 * @param endpoint - 搜索端点
 * @param query - 已 trim 过的查询词
 * @param signal - 取消信号
 * @param timeoutMs - 单次搜索的协同超时；到点即中止这次请求
 * @returns 命中的条目
 * @throws WebError - 端点不是 http(s)、后端非 2xx、或回包不可解析
 */
async function querySearchBackend(
  endpoint: string,
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ParsedSearchHit[]> {
  // 超时与调用方取消是两个来源：只转发 signal 的话，接缝没给 signal（该参数本就是可选的）
  // 时一次卡住的后端会让整次搜索永久挂起，而且没有任何可观测的超时错误。
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const searchUrl = new URL(endpoint);
    if (searchUrl.protocol !== "http:" && searchUrl.protocol !== "https:") {
      throw new Error(`search endpoint must be http(s): ${searchUrl.protocol}`);
    }
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    const response = await fetch(searchUrl, {
      signal: combined,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`search backend answered HTTP ${response.status}`);
    }
    return parseSearchResults(await response.json());
  } catch (error: unknown) {
    // 取消不是故障：调用方改主意了，语义是「这次调用作废」。把它包成 provider 失败码，
    // seam 那头看到的就成了一次搜索失败，日志与用户提示都会指错方向。原样抛出。
    // 超时同理：它是这次搜索的结局，而不是「后端回了坏东西」。
    if (signal?.aborted === true || timeout.aborted) {
      throw error;
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
 * 把一条命中归一成可引用的 source；URL 归一不出来或被闸门拦下时给空数组。
 *
 * 闸门判否就**丢掉这一条**：它是本次搜索的输入，而输入能不能变成一条结果由部署方的安全
 * 策略说了算。丢掉的条目不进 sources，于是模型不会引用一个它紧接着就抓不到的地址。
 *
 * @param hit - 后端返回的条目
 * @param endpoint - 搜索端点，相对 URL 的基准
 * @param gate - 准入闸门；没给就不过闸（自定义 provider 的既有用法）
 * @returns 长度 0 或 1 的数组
 */
async function toSource(
  hit: ParsedSearchHit,
  endpoint: string,
  gate: ((url: string) => Promise<string | undefined>) | undefined,
): Promise<WebSearchSource[]> {
  const url = absolutize(hit.url, endpoint);
  if (url.length === 0) {
    return [];
  }
  let citeable = url;
  if (gate !== undefined) {
    try {
      const normalized = await gate(url);
      // 闸门可能把 URL 归一过。判的和引用的必须是同一个串，否则归一化又成一条绕过面。
      citeable = typeof normalized === "string" ? normalized : url;
    } catch {
      // 被安全闸门拦下（私网、元数据端点、非 http(s)…）：这一条不作为结果交出去。
      return [];
    }
  }
  return [
    {
      url: citeable,
      ...(hit.title === undefined ? {} : { title: hit.title }),
      ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
    },
  ];
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
    const raw: unknown = await deps.sidecar.call(
      deps.sidecar.capabilities?.browser === true ? "render" : "fetch",
      {
        url: source.url,
        cssSelector: null,
        extractionType: "markdown",
        mainContentOnly: true,
        headless: true,
        networkIdle: false,
        maxContentChars: deps.maxOutputBytes,
      },
      { ...(signal === undefined ? {} : { signal }), timeoutMs: deps.timeoutMs },
    );
    const payload = isRecord(raw) ? raw : {};
    const { content } = payload;
    return typeof content === "string" && content.length > 0
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
  const endpoint = deps.searchEndpoint.trim();
  return {
    id: SEARCH_PROVIDER_ID,

    /**
     * 本地可用性判断。契约要求**不得发网络请求**，所以只看 sidecar 是否握手成功、
     * 以及部署侧有没有配搜索端点。
     *
     * @returns 是否可用
     */
    available(): boolean {
      return (
        endpoint.length > 0 && deps.sidecar.alive && deps.sidecar.capabilities?.scrapling === true
      );
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

      const hits = await querySearchBackend(endpoint, query, signal, deps.timeoutMs);
      // sources 也要过准入闸门：搜索后端的回包是外部输入，它尽可以回一条内网地址；
      // 不过闸的话，那条地址就原样出现在模型眼前，而本包对同一地址的抓取会被拦下。
      // 候选先截到 MAX_SOURCES 再过闸 —— 闸门每条一次 DNS，封顶必须落在过闸之前。
      const candidates = hits.slice(0, MAX_SOURCES);
      const gated = await Promise.all(
        candidates.map((hit) => toSource(hit, endpoint, deps.urlGate)),
      );
      const sources = gated.flat();
      // 一条都不剩时必须报错，而不是回一次「成功但没有结果」的搜索：后端只回了内网地址
      // 与「搜不到东西」是两件完全不同的事，后者才是用户想看到的那一种。
      if (sources.length === 0 && candidates.length > 0) {
        throw new WebError(
          `every one of the ${candidates.length} results was rejected by the URL gate`,
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
