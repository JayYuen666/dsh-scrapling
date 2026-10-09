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
// 为什么不默认开启：注册了第二个「可用」的 search provider 而部署侧没配 searchProvider，
// 内置 web_search 会直接不可用（WEB_PROVIDER_AMBIGUOUS）。所以 provideWebSearch 默认 false，
// 且 available() 在没配搜索端点时返回 false —— 两道闸都留着。
import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import type { SidecarClient } from "./sidecar.ts";

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
 * @returns 命中的条目
 * @throws WebError - 端点不是 http(s)、后端非 2xx、或回包不可解析
 */
async function querySearchBackend(
  endpoint: string,
  query: string,
  signal: AbortSignal | undefined,
): Promise<ParsedSearchHit[]> {
  try {
    const searchUrl = new URL(endpoint);
    if (searchUrl.protocol !== "http:" && searchUrl.protocol !== "https:") {
      throw new Error(`search endpoint must be http(s): ${searchUrl.protocol}`);
    }
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    const response = await fetch(searchUrl, {
      ...(signal === undefined ? {} : { signal }),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`search backend answered HTTP ${response.status}`);
    }
    return parseSearchResults(await response.json());
  } catch (error: unknown) {
    throw new WebError(String(error), "SCRAPLING_SEARCH_FAILED");
  }
}

/**
 * 把一条命中归一成可引用的 source；URL 归一不出来时给空数组。
 *
 * @param hit - 后端返回的条目
 * @param endpoint - 搜索端点，相对 URL 的基准
 * @returns 长度 0 或 1 的数组
 */
function toSource(hit: ParsedSearchHit, endpoint: string): WebSearchSource[] {
  const url = absolutize(hit.url, endpoint);
  if (url.length === 0) {
    return [];
  }
  return [
    {
      url,
      ...(hit.title === undefined ? {} : { title: hit.title }),
      ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
    },
  ];
}

/**
 * 真去抓一条并渲染，返回该条的小节正文。
 *
 * 读不到时返回 undefined 而不是抛：搜索结果里混着失效链接是常态，不该让整次调用失败。
 *
 * @param source - 要读的 source
 * @param deps - provider 依赖
 * @param signal - 取消信号
 * @returns 小节正文；读不到时是空串
 */
async function fetchContent(
  source: WebSearchSource,
  deps: SearchProviderDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
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
    return typeof payload["content"] === "string" ? payload["content"] : "";
  } catch {
    return "";
  }
}

/**
 * 把一条 source 渲染成 Markdown 小节；没有正文时返回 undefined。
 *
 * 读不到就跳过那一条：搜索结果里混着失效链接是常态，不该让整次调用失败。
 *
 * @param source - 要读的 source
 * @param deps - provider 依赖
 * @param signal - 取消信号
 * @returns 小节正文；读不到时是空串
 */
async function renderBody(
  source: WebSearchSource,
  deps: SearchProviderDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  const body = await fetchContent(source, deps, signal);
  if (body.length === 0) {
    return "";
  }
  return `## ${source.title ?? source.url}\n\n${body}`;
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
      const maxResults = request.maxResults ?? 8;

      const hits = await querySearchBackend(endpoint, query, signal);
      const sources = hits.flatMap((hit) => toSource(hit, endpoint));
      const bounded = sources.length > maxResults;
      const kept = bounded ? sources.slice(0, maxResults) : sources;

      // 前 toRender 条并发走 sidecar：URL 闸门在 sidecar.call 里逐条判；浏览器可用时
      // render 走 Playwright 渲染后再抽，正好补上内置 web_fetch 读不到 SPA 的那块。
      // Promise.all 保序，所以并发不影响 sources 与正文小节的对应关系。
      const toRender = Math.max(0, Math.min(deps.renderTopN, kept.length));
      const rendered = await Promise.all(
        kept.slice(0, toRender).map((source) => renderBody(source, deps, signal)),
      );
      const bodies = rendered.filter((body) => body.length > 0);

      return {
        ...(bodies.length > 0 ? { content: bodies.join("\n\n") } : {}),
        sources: kept,
        truncated: bounded,
      };
    },
  };
}
