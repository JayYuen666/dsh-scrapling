// dsh-scrapling/test/search-provider.test.ts —— ctx.web search provider（检索 + 按策略读取）。
//
// 检索由 sidecar 的 search.discover 完成（Tavily/Bing 两条已验证路径），Host 只负责过闸、
// 按 webFetchStrategy 读取前 N 条与截断。覆盖重点：策略分支、错误码、key 不回显、闸门与正文失败的语义。

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SEARCH_TOTAL_BUDGET_BYTES,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
  SEARCH_PROVIDER_ID,
  canonicalizeSearchUrl,
  createWebSearchProvider,
} from "../lib/search-provider.ts";
import type { SearchProviderDeps } from "../lib/search-provider.ts";
import type { DeepSeekAuthLike, DeepSeekAuthRequestLike } from "../lib/deepseek-search.ts";
import type { SearchBackend } from "../lib/search-backends.ts";
import type { SidecarClient } from "../lib/sidecar.ts";
import { SidecarError } from "../lib/sidecar-error.ts";

const PAGE_A = "https://a.test/1";
const PAGE_B = "https://b.test/2";
const PAGE_C = "https://c.test/3";
const SEARCH_FAILED = "SCRAPLING_SEARCH_FAILED";
const NO_BODY_REASON = "came back with no body";
const DISCOVER = "search.discover";
const API_ENDPOINT = "https://api.tavily.test/search";
const BING_ENDPOINT = "https://bing.test/search";
/** SearXNG 自建实例地址：几处用例都要它，值只写一次。 */
const SEARX_ENDPOINT = "https://searx.test";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.test/v1/tools/search";
const DEEPSEEK_ROUTE = "deepseek-official";
const PUBLISHED_AT = "2026-11-20";

/** 三把后端 key 的替身值：既配上、又要求只下发自家那一把，值只在这里写一次。 */
const BRAVE_KEY = "brave-key";
const SERPER_KEY = "serper-key";
const TAVILY_KEY = "tavily-key";
type FetchStrategy = "static" | "auto" | "browser";

/** 假 sidecar 的一次调用记录。 */
interface SidecarCall {
  readonly method: string;
  readonly url: string;
  readonly params: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
  readonly extractionType: unknown;
}

/** 默认能力清单：能抓取、有浏览器。 */
const DEFAULT_CAPS = { scrapling: true, browser: true };

interface SidecarOptions {
  readonly hits?: unknown[];
  readonly discovery?: unknown;
  readonly capabilities?: Record<string, unknown>;
  readonly onDiscover?: (params: Record<string, unknown>) => unknown;
  readonly onFetch?: (method: string, params: Record<string, unknown>) => unknown;
  readonly calls?: SidecarCall[];
}

/** 建一个不发网络请求的假 sidecar：search.discover 与 fetch/render 分开回。 */
function makeSidecar(options: SidecarOptions = {}): SidecarClient {
  const calls = options.calls ?? [];
  const caps = options.capabilities ?? DEFAULT_CAPS;
  return {
    alive: true,
    capabilities: caps,
    call: (
      method: string,
      params: Record<string, unknown>,
      callOptions?: { signal?: AbortSignal },
    ): Promise<unknown> => {
      const url = typeof params["url"] === "string" ? params["url"] : "";
      calls.push({
        method,
        url,
        params,
        signal: callOptions?.signal,
        extractionType: params["extractionType"],
      });
      if (method === DISCOVER) {
        return Promise.resolve(
          options.onDiscover?.(params) ??
            options.discovery ?? { backend: "bing", hits: options.hits ?? [] },
        );
      }
      return Promise.resolve(
        options.onFetch?.(method, params) ?? {
          url,
          status: 200,
          content: `BODY-OF ${url}`,
          truncated: false,
        },
      );
    },
  } as unknown as SidecarClient;
}

/**
 * 用例侧的依赖形态：热改项写成**普通值**，由 {@link deps} 统一包成读取器。
 *
 * 单独定这一层是因为 `SearchProviderDeps` 现在有八位读取器（见 lib/config-reader.ts 的
 * 说明），四十多处调用点若都手写 `() => x` 只会让断言里的值淹没在类型噪音里；而「读取器
 * 真的每次现取」这件事由专门那条用例钉住，不靠每个调用点重复表态。
 */
type PlainDeps = Omit<
  SearchProviderDeps,
  | "backend"
  | "apiKey"
  | "braveApiKey"
  | "serperApiKey"
  | "searxngEndpoint"
  | "publicFallback"
  | "maxOutputBytes"
  | "searchMaxOutputBytes"
  | "timeoutMs"
  | "fetchStrategy"
  | "deepseekEndpoint"
> & {
  readonly backend: SearchBackend;
  readonly apiKey: string;
  readonly braveApiKey: string;
  readonly serperApiKey: string;
  readonly searxngEndpoint: string;
  readonly publicFallback: boolean;
  readonly maxOutputBytes: number;
  readonly searchMaxOutputBytes: number;
  readonly timeoutMs: number;
  readonly fetchStrategy: FetchStrategy;
  readonly deepseekEndpoint: string;
};

function deps(over?: Partial<PlainDeps>): SearchProviderDeps {
  const plain: PlainDeps = {
    sidecar: makeSidecar(),
    backend: "bing",
    apiKey: "",
    braveApiKey: "",
    serperApiKey: "",
    apiEndpoint: API_ENDPOINT,
    bingEndpoint: BING_ENDPOINT,
    braveEndpoint: "https://api.search.brave.com/res/v1/web/search",
    serperEndpoint: "https://google.serper.dev/search",
    duckduckgoEndpoint: "https://html.duckduckgo.com/html/",
    searxngEndpoint: "",
    publicFallback: false,
    renderTopN: 2,
    maxOutputBytes: 100_000,
    searchMaxOutputBytes: DEFAULT_SEARCH_TOTAL_BUDGET_BYTES,
    timeoutMs: 30_000,
    fetchStrategy: "auto",
    deepseekEndpoint: DEEPSEEK_ENDPOINT,
    fetchImpl: globalThis.fetch,
    // 闸门是必填依赖：默认给一枚全放行的，用例要判否时用 blockList/passGate 覆盖。
    urlGate: async (url: string): Promise<string | undefined> => url,
    ...over,
  };
  return {
    ...plain,
    backend: () => plain.backend,
    apiKey: () => plain.apiKey,
    braveApiKey: () => plain.braveApiKey,
    serperApiKey: () => plain.serperApiKey,
    searxngEndpoint: () => plain.searxngEndpoint,
    publicFallback: () => plain.publicFallback,
    maxOutputBytes: () => plain.maxOutputBytes,
    searchMaxOutputBytes: () => plain.searchMaxOutputBytes,
    timeoutMs: () => plain.timeoutMs,
    fetchStrategy: () => plain.fetchStrategy,
    deepseekEndpoint: () => plain.deepseekEndpoint,
  };
}

/** 一个永远放行的闸门；调用被记下来，用于断言 sources 确实过了闸门。 */
function passGate(seen: string[]): (url: string) => Promise<string | undefined> {
  return async (url: string): Promise<string | undefined> => {
    seen.push(url);
    return undefined;
  };
}

/** 一个按名单拦的闸门；命中即抛，模拟 URL_BLOCKED。 */
function blockList(blocked: readonly string[]): (url: string) => Promise<string | undefined> {
  return async (url: string): Promise<string | undefined> => {
    if (blocked.includes(url)) {
      throw new Error("URL_BLOCKED: private address");
    }
    return undefined;
  };
}

/**
 * 跑一次必须失败的调用，取出它抛出的错误。
 *
 * 用 try/catch 而不是 `rejects.toMatchObject`：后者对 Error 实例不成立（比的是可枚举
 * 自有属性），code 写错位置时它仍然是 Error，断言照样「通过」。
 *
 * @param run - 触发失败的操作
 * @returns 抛出的错误
 */
async function failureOf(run: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected this call to fail, but it resolved");
}

describe("search provider 可用性", () => {
  it("id 与 fetch provider 同一个，部署侧只写一处心智", () => {
    expect(SEARCH_PROVIDER_ID).toBe("scrapling");
    expect(createWebSearchProvider(deps()).id).toBe("scrapling");
  });

  it("sidecar 没握手或没有 scrapling 能力时不可用，且不发任何网络请求", () => {
    const calls: SidecarCall[] = [];
    const readySidecar = makeSidecar({ calls });
    const ready = createWebSearchProvider(deps({ sidecar: readySidecar }));
    expect(ready.available()).toBe(true);
    expect(calls).toStrictEqual([]);

    // 三条「不可用」路径各配一只会记录的假 sidecar：标题里那句「不发任何网络请求」只有
    // 在账本上才判得出来。内联假件里那个永远 resolve、又不记录的 call 判不了这件事。
    const deadCalls: SidecarCall[] = [];
    const dead = Object.assign(makeSidecar({ calls: deadCalls }), { alive: false });
    expect(createWebSearchProvider(deps({ sidecar: dead })).available()).toBe(false);
    expect(deadCalls).toStrictEqual([]);

    const noCapsCalls: SidecarCall[] = [];
    const noCaps = Object.assign(makeSidecar({ calls: noCapsCalls }), { capabilities: undefined });
    expect(createWebSearchProvider(deps({ sidecar: noCaps })).available()).toBe(false);
    expect(noCapsCalls).toStrictEqual([]);

    const browserOnlyCalls: SidecarCall[] = [];
    const browserOnly = makeSidecar({ capabilities: { browser: true }, calls: browserOnlyCalls });
    expect(createWebSearchProvider(deps({ sidecar: browserOnly })).available()).toBe(false);
    expect(browserOnlyCalls).toStrictEqual([]);
  });

  it("auto 没有任何发现路径时不可用 —— 公共引擎不是默认路径（spec D10）", () => {
    expect(createWebSearchProvider(deps({ backend: "auto" })).available()).toBe(false);
    expect(
      createWebSearchProvider(
        deps({ backend: "auto", searxngEndpoint: SEARX_ENDPOINT }),
      ).available(),
    ).toBe(true);
    expect(createWebSearchProvider(deps({ backend: "auto", apiKey: "tvly-x" })).available()).toBe(
      true,
    );
    expect(
      createWebSearchProvider(deps({ backend: "auto", publicFallback: true })).available(),
    ).toBe(true);
  });

  it("显式选后端就算可用：key 缺了交给 search 报 SEARCH_AUTH，而不是静默消失", () => {
    for (const backend of ["tavily", "brave", "serper", "bing", "duckduckgo", "searxng"] as const) {
      expect(createWebSearchProvider(deps({ backend, apiKey: "" })).available()).toBe(true);
    }
  });
});

/**
 * 调 provider 的 `ready()`。
 *
 * `WebSearchProvider.ready` 在官方类型上是**可选方法**（不实现就等于「总是可用」），所以
 * 直接 `provider.ready(...)` 会被类型层判成可能 undefined。本包的 provider 必须实现它 ——
 * 这条断言就是这个契约本身：漏了实现时用例在调用点就红，而不是默默落到「总是 ready」。
 *
 * @param provider - 被测 provider
 * @param llmProvider - 宿主会传进来的模型路线 id
 * @returns provider 给出的可用结论
 */
async function readyOf(
  provider: ReturnType<typeof createWebSearchProvider>,
  llmProvider?: string,
): Promise<boolean> {
  if (provider.ready === undefined) {
    throw new Error("本包的 search provider 必须实现 ready()：宿主拿它决定 web_search 露不露面");
  }
  // 上一条判空把可选方法收窄成必在，所以这里直接调；拆成中间变量会让
  // typescript/unbound-method 报「可能丢 this」。
  return provider.ready(llmProvider);
}

/**
 * `ready()` 与 `available()` 是两套判据（见 lib/search-provider.ts 里 ready 的 doc）：
 * available 答「本 provider 进不进候选」，显式后端恒 true；ready 答「这一条请求路线发得出
 * 凭据吗」，而宿主拿它给内置 `web_search` 装 when 门 —— 答 false 时那个工具整个不出现在
 * 模型面前。两者混在一起写，症状是「设置了没配好的后端，web_search 还在、每调必失败」。
 */
describe("search provider 的 ready()：内置 web_search 要不要露面", () => {
  it("sidecar 没握手时 ready 为 false —— 与 available 同一道前提", async () => {
    const dead = Object.assign(makeSidecar(), { alive: false });
    const deadProvider = createWebSearchProvider(deps({ sidecar: dead }));
    await expect(readyOf(deadProvider)).resolves.toBe(false);
    const noCaps = Object.assign(makeSidecar(), { capabilities: undefined });
    const noCapsProvider = createWebSearchProvider(deps({ sidecar: noCaps }));
    await expect(readyOf(noCapsProvider)).resolves.toBe(false);
  });

  it("auto 且一条发现路径都没配时 ready 为 false", async () => {
    // 这正是「装好了插件、什么都没配」的默认态：web_search 不该出现在模型面前，否则模型
    // 每调一次都吃 SEARCH_AUTH 或 SEARCH_BACKEND_MISSING，而它没有任何办法自救。
    const provider = createWebSearchProvider(deps({ backend: "auto" }));
    await expect(readyOf(provider, undefined)).resolves.toBe(false);
    await expect(readyOf(provider, "deepseek")).resolves.toBe(false);
  });

  it("auto 下三种发现路径各自把 ready 打开", async () => {
    const byTavily = createWebSearchProvider(deps({ backend: "auto", apiKey: TAVILY_KEY }));
    await expect(readyOf(byTavily, undefined)).resolves.toBe(true);
    const bySearxng = createWebSearchProvider(
      deps({ backend: "auto", searxngEndpoint: SEARX_ENDPOINT }),
    );
    await expect(readyOf(bySearxng, undefined)).resolves.toBe(true);
    const byPublicFallback = createWebSearchProvider(
      deps({ backend: "auto", publicFallback: true }),
    );
    await expect(readyOf(byPublicFallback, undefined)).resolves.toBe(true);
  });

  it("显式后端只认自己那把 key：选 tavily 而只有 brave 的 key 时 ready 为 false", async () => {
    // 与 selectKey 同一条规则的两面：这里不判的话，选 tavily 却只有 brave key 的部署会
    // 一直露着 web_search，每次调用都 401。
    const wrongKey = createWebSearchProvider(deps({ backend: "tavily", braveApiKey: BRAVE_KEY }));
    await expect(readyOf(wrongKey, undefined)).resolves.toBe(false);
    const rightKey = createWebSearchProvider(deps({ backend: "tavily", apiKey: TAVILY_KEY }));
    await expect(readyOf(rightKey, undefined)).resolves.toBe(true);
  });

  it("公开端点与配齐凭据的后端 ready 为 true", async () => {
    const providers = [
      createWebSearchProvider(deps({ backend: "bing" })),
      createWebSearchProvider(deps({ backend: "duckduckgo" })),
      createWebSearchProvider(deps({ backend: "brave", braveApiKey: BRAVE_KEY })),
      createWebSearchProvider(deps({ backend: "serper", serperApiKey: SERPER_KEY })),
      createWebSearchProvider(deps({ backend: "searxng", searxngEndpoint: SEARX_ENDPOINT })),
    ];
    const verdicts = await Promise.all(providers.map((provider) => readyOf(provider)));
    expect(verdicts).toStrictEqual([true, true, true, true, true]);
  });

  it("后端名是名单外的旧值或拼错时按保守侧处理：不露面", async () => {
    // 配置是**运行期**读出来的：profile patch 里留着上版本的后端名、或手改 settings 写了
    // 拼错的值，都会走到凭据判据的 default 分支。这一档若顺手 return true，等于替用户
    // 打开一条他没配过的发现路径 —— 而那条路径在 search() 里又会以未知名失败。
    const unknownBackend = createWebSearchProvider(
      deps({ backend: "nope" as unknown as SearchBackend, apiKey: TAVILY_KEY }),
    );
    await expect(readyOf(unknownBackend)).resolves.toBe(false);
  });

  it("ready 只查配置、不发任何 sidecar 调用（契约明写不得发网络请求）", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({ calls });
    const provider = createWebSearchProvider(
      deps({ sidecar, backend: "tavily", apiKey: TAVILY_KEY }),
    );
    await expect(readyOf(provider, undefined)).resolves.toBe(true);
    await expect(readyOf(provider, "deepseek")).resolves.toBe(true);
    expect(calls).toStrictEqual([]);
  });

  it("deepseek 后端按模型路线检查 auth 凭据，不读取 key 也不发网络", async () => {
    const routes: (string | undefined)[] = [];
    const auth: DeepSeekAuthLike = {
      candidates: (request) => {
        routes.push(request.route);
        return [
          {
            kind: "api-key",
            endpoint: DEEPSEEK_ENDPOINT,
            configured: () => Promise.resolve(true),
            resolve: () => Promise.resolve(undefined),
          },
        ];
      },
      authorize: () => Promise.resolve(undefined),
    };
    const provider = createWebSearchProvider({
      ...deps({ backend: "deepseek" }),
      deepseekAuth: auth,
    });

    await expect(readyOf(provider, DEEPSEEK_ROUTE)).resolves.toBe(true);
    await expect(readyOf(provider, "other-route")).resolves.toBe(true);
    expect(routes).toStrictEqual([DEEPSEEK_ROUTE, "other-route"]);
  });

  it("deepseek 没有 auth 服务或没有已配置凭据时 ready 为 false", async () => {
    const withoutAuth = createWebSearchProvider(deps({ backend: "deepseek" }));
    await expect(readyOf(withoutAuth)).resolves.toBe(false);
    const auth: DeepSeekAuthLike = {
      candidates: () => [],
      authorize: () => Promise.resolve(undefined),
    };
    const withoutCredential = createWebSearchProvider({
      ...deps({ backend: "deepseek" }),
      deepseekAuth: auth,
    });
    await expect(readyOf(withoutCredential)).resolves.toBe(false);
  });
});

/**
 * 热改项每次现取。
 *
 * `.volatile()` 的位改值不重跑 `apply`，而 provider 是装配期建好的那一枚 —— 装配时把值抄进
 * 闭包，卡上拧了旋钮运行行为一点不变，回包形状照旧、日志照旧。这条用例把「同一个 provider
 * 实例，两次调用之间改配置」当判据：抄了值的实现第二次仍按旧值走。
 */
describe("reading 热改配置", () => {
  it("同一个 provider 第二次搜到时用的是新配置：读取器不是装配时的快照", async () => {
    const calls: SidecarCall[] = [];
    let timeoutMs = 30_000;
    let maxOutputBytes = 1000;
    let backend = "tavily";
    let apiKey = "";
    const sidecar = makeSidecar({ calls, hits: [] });
    const provider = createWebSearchProvider({
      ...deps({ sidecar, renderTopN: 0 }),
      backend: () => backend as SearchBackend,
      apiKey: () => apiKey,
      maxOutputBytes: () => maxOutputBytes,
      timeoutMs: () => timeoutMs,
    });

    await provider.search({ query: "first" });
    timeoutMs = 45_000;
    maxOutputBytes = 2000;
    backend = "bing";
    apiKey = TAVILY_KEY;
    await provider.search({ query: "second" });

    const discover = calls.filter((call) => call.method === DISCOVER);
    expect(discover).toHaveLength(2);
    expect(discover[0]?.params["timeoutSeconds"]).toBe(30);
    expect(discover[1]?.params["timeoutSeconds"]).toBe(45);
    expect(discover[0]?.params["backend"]).toBe("tavily");
    expect(discover[1]?.params["backend"]).toBe("bing");
    expect(discover[0]?.params["apiKey"]).toBe("");
    expect(discover[1]?.params["apiKey"]).toBe(TAVILY_KEY);
  });

  it("ready() 与 available() 都读当下的值：卡上补了 key 立刻不再隐身", async () => {
    const holder = { apiKey: "" };
    // 覆盖必须发生在 deps() **之后**：那个 helper 会把传进去的值再包一层读取器，
    // 先传读取器会让它变成「返回一个函数」的读取器，长度判据拿到 0。
    const provider = createWebSearchProvider({
      ...deps({ backend: "auto" }),
      apiKey: () => holder.apiKey,
    });
    await expect(readyOf(provider, undefined)).resolves.toBe(false);
    holder.apiKey = TAVILY_KEY;
    await expect(readyOf(provider, undefined)).resolves.toBe(true);
    expect(provider.available()).toBe(true);
  });
});

describe("search provider 检索与按策略读取", () => {
  it("省略 maxResults 时按宿主默认请求 10 条", async () => {
    const calls: SidecarCall[] = [];
    await createWebSearchProvider(deps({ sidecar: makeSidecar({ calls }) })).search({ query: "q" });
    expect(calls[0]?.params["maxResults"]).toBe(10);
  });

  it("auto 先静态抓取，正文不足时对前 N 条回退渲染", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [
        { url: PAGE_A, title: "A", snippet: "SA" },
        { url: PAGE_B, title: "B" },
        { url: PAGE_C, title: "C" },
      ],
      calls,
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 2 })).search({
      query: "hello",
      maxResults: 8,
    });

    expect(calls[0]?.method).toBe(DISCOVER);
    expect(calls[0]?.params).toMatchObject({ backend: "bing", query: "hello", maxResults: 8 });

    // publicFallback 是 discovery 的输入，必须随载荷下发；sidecar 才不会自己决定发公共查询。
    const fallbackCalls: SidecarCall[] = [];
    await createWebSearchProvider(
      deps({
        sidecar: makeSidecar({ hits: [], calls: fallbackCalls }),
        backend: "auto",
        publicFallback: true,
        renderTopN: 0,
      }),
    ).search({ query: "hello" });
    expect(fallbackCalls[0]?.params).toMatchObject({ backend: "auto", publicFallback: true });
    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A, PAGE_B, PAGE_C]);
    expect(calls.slice(1).map((call) => call.url)).toStrictEqual([PAGE_A, PAGE_B, PAGE_A, PAGE_B]);
    expect(calls.slice(1).map((call) => call.method)).toStrictEqual([
      "fetch",
      "fetch",
      "render",
      "render",
    ]);
    expect(
      calls
        .slice(1)
        .filter((call) => call.url === PAGE_A)
        .map((call) => call.method),
    ).toStrictEqual(["fetch", "render"]);
    expect(
      calls
        .slice(1)
        .filter((call) => call.url === PAGE_B)
        .map((call) => call.method),
    ).toStrictEqual(["fetch", "render"]);
    expect(result.content).toContain(`BODY-OF ${PAGE_A}`);
    expect(result.content).not.toContain(`BODY-OF ${PAGE_C}`);
    expect(result.truncated).toBe(false);
  });

  it("auto 的静态正文有 500 字符时只调用 fetch", async () => {
    const calls: SidecarCall[] = [];
    const body = "S".repeat(500);
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A, title: "A" }],
      calls,
      onFetch: (method) => ({ content: method === "fetch" ? body : "rendered", truncated: false }),
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({
      query: "q",
    });

    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["fetch"]);
    expect(result.content).toBe(`## A\n\n${body}`);
  });

  it.each([
    { chars: 199, methods: ["fetch", "render"] },
    { chars: 200, methods: ["fetch"] },
  ])("auto 以 200 字符为界：$chars 字符走 $methods", async ({ chars, methods }) => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      calls,
      onFetch: () => ({ content: "x".repeat(chars), truncated: false }),
    });
    await createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({ query: "q" });
    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(methods);
  });

  it("static 即使正文为空也不渲染", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      calls,
      onFetch: () => ({ content: "", truncated: false }),
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1, fetchStrategy: "static" })).search({
        query: "q",
      }),
    );

    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["fetch"]);
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain(NO_BODY_REASON);
  });

  it("browser 直接渲染，不先静态抓取", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A, title: "A" }],
      calls,
      onFetch: (method) => ({
        content: method === "render" ? "rendered" : "static",
        truncated: false,
      }),
    });
    const result = await createWebSearchProvider(
      deps({ sidecar, renderTopN: 1, fetchStrategy: "browser" }),
    ).search({ query: "q" });

    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["render"]);
    expect(result.content).toBe("## A\n\nrendered");
  });

  it("auto 没有浏览器时保持静态，不因空正文渲染", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      capabilities: { scrapling: true, browser: false },
      calls,
      onFetch: () => ({ content: "", truncated: false }),
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({ query: "q" }),
    );

    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["fetch"]);
    expect(calls[1]?.extractionType).toBe("markdown");
    expect(error.message).toContain(NO_BODY_REASON);
  });

  it("auto 静态回包形状错误时不渲染", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      calls,
      onFetch: () => "not-an-object",
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({ query: "q" }),
    );

    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["fetch"]);
    expect(error.message).toContain("the fetch reply was not an object");
  });

  it("canonicalize 去 hash、跟踪参数并按 key 排序", () => {
    expect(
      canonicalizeSearchUrl("https://Example.COM:443/a/?utm_source=x&b=2&a=1&fbclid=z#frag", ""),
    ).toBe("https://example.com/a/?a=1&b=2");
    expect(canonicalizeSearchUrl("/r?b=2&a=1", "https://search.test/base")).toBe(
      "https://search.test/r?a=1&b=2",
    );
    expect(canonicalizeSearchUrl("not a url", "")).toBe("");
  });

  it("同一查询里 canonical 相同的 URL 只保留一条来源", async () => {
    const sidecar = makeSidecar({
      hits: [
        { url: "https://a.test/path?utm_source=x&b=2#one", title: "first" },
        { url: "https://A.test:443/path?b=2#two", title: "duplicate" },
        { url: PAGE_B, title: "second" },
      ],
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
    });
    expect(result.sources).toStrictEqual([
      { url: "https://a.test/path?b=2", title: "first" },
      { url: PAGE_B, title: "second" },
    ]);
  });

  it("sidecar 命中的 summary/publishedAt 原样进入来源", async () => {
    const sidecar = makeSidecar({
      hits: [
        {
          url: PAGE_A,
          title: "A",
          snippet: "short",
          summary: "long summary",
          publishedAt: PUBLISHED_AT,
        },
      ],
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
    });
    expect(result.sources[0]).toStrictEqual({
      url: PAGE_A,
      title: "A",
      snippet: "short",
      summary: "long summary",
      publishedAt: PUBLISHED_AT,
    });
  });

  it("发现结果按 300 秒 TTL 缓存，过期后重新发现", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-24T00:00:00Z"));
      const calls: SidecarCall[] = [];
      const provider = createWebSearchProvider(
        deps({ sidecar: makeSidecar({ hits: [{ url: PAGE_A }], calls }), renderTopN: 0 }),
      );
      await provider.search({ query: "cached" });
      await provider.search({ query: "cached" });
      expect(calls.filter((call) => call.method === DISCOVER)).toHaveLength(1);
      vi.advanceTimersByTime(SEARCH_CACHE_TTL_MS + 1);
      await provider.search({ query: "cached" });
      expect(calls.filter((call) => call.method === DISCOVER)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("发现缓存最多 128 项，超出后淘汰最旧项", async () => {
    expect(SEARCH_CACHE_MAX_ENTRIES).toBe(128);
    const calls: SidecarCall[] = [];
    const provider = createWebSearchProvider(
      deps({ sidecar: makeSidecar({ hits: [], calls }), renderTopN: 0 }),
    );
    async function fillCache(index: number): Promise<void> {
      if (index >= SEARCH_CACHE_MAX_ENTRIES) {
        return;
      }
      await provider.search({ query: `q-${String(index)}` });
      await fillCache(index + 1);
    }
    await fillCache(0);
    await provider.search({ query: `q-${String(SEARCH_CACHE_MAX_ENTRIES)}` });
    await provider.search({ query: "q-0" });
    expect(calls.filter((call) => call.method === DISCOVER)).toHaveLength(
      SEARCH_CACHE_MAX_ENTRIES + 2,
    );
  });

  it("缓存键包含 SearXNG 端点但不包含 API key 值", async () => {
    const calls: SidecarCall[] = [];
    let endpoint = "https://search-one.test";
    let apiKey = "secret-one";
    const provider = createWebSearchProvider({
      ...deps({
        sidecar: makeSidecar({ hits: [{ url: PAGE_A }], calls }),
        backend: "auto",
        renderTopN: 0,
      }),
      searxngEndpoint: () => endpoint,
      apiKey: () => apiKey,
    });
    await provider.search({ query: "same" });
    apiKey = "secret-two";
    await provider.search({ query: "same" });
    expect(calls.filter((call) => call.method === DISCOVER)).toHaveLength(1);
    endpoint = "https://search-two.test";
    await provider.search({ query: "same" });
    expect(calls.filter((call) => call.method === DISCOVER)).toHaveLength(2);
  });

  it("发现失败不写入缓存，下一次仍会重试", async () => {
    const calls: SidecarCall[] = [];
    let attempts = 0;
    const sidecar = makeSidecar({
      calls,
      onDiscover: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new SidecarError("SEARCH_TIMEOUT", "timeout"))
          : { backend: "bing", hits: [{ url: PAGE_A }] };
      },
    });
    const provider = createWebSearchProvider(deps({ sidecar, renderTopN: 0 }));
    await expect(provider.search({ query: "retry" })).rejects.toMatchObject({
      code: "SEARCH_TIMEOUT",
    });
    await expect(provider.search({ query: "retry" })).resolves.toMatchObject({
      sources: [{ url: PAGE_A }],
    });
    expect(calls.filter((call) => call.method === DISCOVER)).toHaveLength(2);
  });

  it("offset 跳过发现结果前面的条目，非法值直接报错", async () => {
    const calls: SidecarCall[] = [];
    const hits = [{ url: PAGE_A }, { url: PAGE_B }, { url: PAGE_C }];
    const sidecar = makeSidecar({
      calls,
      onDiscover: (params) => ({
        backend: "bing",
        hits: hits.slice(typeof params["offset"] === "number" ? params["offset"] : 0),
      }),
    });
    const provider = createWebSearchProvider(deps({ sidecar, renderTopN: 0 }));
    const result = await provider.search({ query: "q", maxResults: 1, offset: 1 });
    expect(result.sources).toStrictEqual([{ url: PAGE_B }]);
    expect(calls[0]?.params["maxResults"]).toBe(1);
    expect(calls[0]?.params["offset"]).toBe(1);
    const errors = await Promise.all(
      [-1, 1.5].map((offset) => failureOf(() => provider.search({ query: "q", offset }))),
    );
    for (const error of errors) {
      expect(error.code).toBe(SEARCH_FAILED);
      expect(error.message).toContain("offset");
    }
  });

  it("fetchStrategy 是读取器：同一个 provider 会按改动后的策略抓取", async () => {
    const calls: SidecarCall[] = [];
    let strategy: FetchStrategy = "static";
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      calls,
      onFetch: (method) => ({
        content: method === "fetch" ? "S".repeat(500) : "rendered",
        truncated: false,
      }),
    });
    const provider = createWebSearchProvider({
      ...deps({ sidecar, renderTopN: 1 }),
      fetchStrategy: () => strategy,
    });

    await provider.search({ query: "static-query" });
    strategy = "browser";
    await provider.search({ query: "browser-query" });

    expect(calls.map((call) => call.method)).toStrictEqual([DISCOVER, "fetch", DISCOVER, "render"]);
  });

  it("搜索聚合预算可热改，默认仍是 24,000 字节", async () => {
    let budget = DEFAULT_SEARCH_TOTAL_BUDGET_BYTES;
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A, title: "A" }],
      onFetch: () => ({ content: "X".repeat(100), truncated: false }),
    });
    const provider = createWebSearchProvider({
      ...deps({ sidecar, renderTopN: 1 }),
      searchMaxOutputBytes: () => budget,
    });
    const first = await provider.search({ query: "first" });
    expect(Buffer.byteLength(first.content ?? "", "utf8")).toBeLessThanOrEqual(24_000);
    expect(first.truncated).toBe(false);

    budget = 20;
    const second = await provider.search({ query: "second" });
    expect(Buffer.byteLength(second.content ?? "", "utf8")).toBeLessThanOrEqual(20);
    expect(second.truncated).toBe(true);
  });

  it("三条各 20,000 字符的正文按字节共享总预算，并保留每页小节", async () => {
    const body = "中".repeat(20_000);
    const sidecar = makeSidecar({
      hits: [
        { url: PAGE_A, title: "A" },
        { url: PAGE_B, title: "B" },
        { url: PAGE_C, title: "C" },
      ],
      onFetch: () => ({ content: body, truncated: false }),
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 3 })).search({
      query: "q",
    });

    const content = result.content ?? "";
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(24_000);
    expect(result.truncated).toBe(true);
    expect(content).toContain("## A");
    expect(content).toContain("## B");
    expect(content).toContain("## C");
    expect(content).not.toContain("Omitted ");
  });

  it("单页均未截断但小节分隔符将总内容推过预算时仍截断", async () => {
    const sidecar = makeSidecar({
      hits: [
        { url: PAGE_A, title: "A" },
        { url: PAGE_B, title: "B" },
        { url: PAGE_C, title: "C" },
      ],
      onFetch: () => ({ content: "X".repeat(7994), truncated: false }),
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 3 })).search({
      query: "q",
    });

    // 每个小节恰为 8,000 字节，单页预算不截断；两个分隔符再把总内容推到 24,004 字节。
    expect(Buffer.byteLength(result.content ?? "", "utf8")).toBe(24_000);
    expect(result.truncated).toBe(true);
    expect(result.content).not.toContain("Omitted ");
  });

  it("sidecar 单页标了截断时，最终结果也保留 truncated", async () => {
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A, title: "A" }],
      onFetch: () => ({ content: "短正文", truncated: true }),
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({
      query: "q",
    });

    expect(result.content).toBe("## A\n\n短正文");
    expect(result.truncated).toBe(true);
  });

  it("总内容未超预算时原样返回且 truncated 为 false", async () => {
    const sidecar = makeSidecar({
      hits: [
        { url: PAGE_A, title: "A" },
        { url: PAGE_B, title: "B" },
      ],
      onFetch: (_method, params) => ({
        content: `正文 ${typeof params["url"] === "string" ? params["url"] : ""}`,
        truncated: false,
      }),
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 2 })).search({
      query: "q",
    });

    expect(result.content).toBe(`## A\n\n正文 ${PAGE_A}\n\n## B\n\n正文 ${PAGE_B}`);
    expect(result.truncated).toBe(false);
  });

  it("非对称小节总长未超预算时完整保留，不提前套用单页均分", async () => {
    const largeBody = "L".repeat(9000);
    const sidecar = makeSidecar({
      hits: [
        { url: PAGE_A, title: "A" },
        { url: PAGE_B, title: "B" },
        { url: PAGE_C, title: "C" },
      ],
      onFetch: (_method, params) => {
        if (params["url"] === PAGE_A) {
          return { content: largeBody, truncated: false };
        }
        return { content: params["url"] === PAGE_B ? "M" : "N", truncated: false };
      },
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 3 })).search({
      query: "q",
    });

    expect(result.truncated).toBe(false);
    expect(Buffer.byteLength(result.content ?? "", "utf8")).toBe(9024);
    expect(result.content).toBe(`## A\n\n${largeBody}\n\n## B\n\nM\n\n## C\n\nN`);
  });

  it("tavily 的 key 只进 sidecar 参数，不进入结果", async () => {
    const key = "super-secret-key-123";
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A, title: "A" }],
      calls,
    });
    const result = await createWebSearchProvider(
      deps({ sidecar, backend: "tavily", apiKey: key, renderTopN: 0 }),
    ).search({ query: "q" });
    expect(calls[0]?.params["apiKey"]).toBe(key);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("每条后端只把自家 key 递给 sidecar", async () => {
    const cases = [
      { backend: "brave", key: BRAVE_KEY, over: { braveApiKey: BRAVE_KEY } },
      { backend: "serper", key: SERPER_KEY, over: { serperApiKey: SERPER_KEY } },
      { backend: "tavily", key: TAVILY_KEY, over: { apiKey: TAVILY_KEY } },
    ] as const;
    // 三把 key 每次都一起配上（`apiKey` 一律给 tavily 那把，另两把走各自字段），所以
    // 「把别家 key 也下发」是看得见的。`toMatchObject({ apiKey })` 只看那一位，漏在
    // params 别处的另一把 key 它看不见，因此这里比整张回执表。
    const outcomes = await Promise.all(
      cases.map(async (item) => {
        const calls: SidecarCall[] = [];
        const sidecar = makeSidecar({ calls });
        const provider = createWebSearchProvider(
          deps({ sidecar, backend: item.backend, apiKey: TAVILY_KEY, renderTopN: 0, ...item.over }),
        );
        await provider.search({ query: "q" });
        const serialized = JSON.stringify(calls[0]?.params);
        return {
          backend: item.backend,
          apiKey: calls[0]?.params["apiKey"],
          leaked: cases
            .filter((other) => other.backend !== item.backend && serialized.includes(other.key))
            .map((other) => other.backend),
        };
      }),
    );
    expect(outcomes).toStrictEqual([
      { backend: "brave", apiKey: BRAVE_KEY, leaked: [] },
      { backend: "serper", apiKey: SERPER_KEY, leaked: [] },
      { backend: "tavily", apiKey: TAVILY_KEY, leaked: [] },
    ]);
  });

  it("renderTopN=0 时只给链接，不发任何抓取", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({ hits: [{ url: PAGE_A }], calls });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
    });
    expect(calls.map((call) => call.method)).toStrictEqual([DISCOVER]);
    expect(result.content).toBeUndefined();
    expect(result.sources).toHaveLength(1);
  });

  it("单条抓取失败只跳过那一条，整次搜索仍然成功", async () => {
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }, { url: PAGE_B }],
      onFetch: (_method, params) =>
        params["url"] === PAGE_A
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({ content: "ok" }),
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 2 })).search({
      query: "q",
    });
    expect(result.sources).toHaveLength(2);
    expect(result.content).toContain("ok");
  });

  it("maxResults 截断 sources 并置 truncated", async () => {
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }, { url: PAGE_B }, { url: PAGE_C }],
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
      maxResults: 2,
    });
    expect(result.sources).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("deepseek 后端用 ctx.deepseekAuth 授权并直接调用 Search API", async () => {
    const calls: SidecarCall[] = [];
    const authRequests: DeepSeekAuthRequestLike[] = [];
    const fetchCalls: { input: string; init: RequestInit }[] = [];
    const authorization = {
      kind: "api-key" as const,
      endpoint: DEEPSEEK_ENDPOINT,
      headers: { authorization: "Bearer deepseek-secret" },
    };
    const auth: DeepSeekAuthLike = {
      candidates: (request) => {
        authRequests.push(request);
        return [
          {
            kind: "api-key",
            endpoint: DEEPSEEK_ENDPOINT,
            configured: () => Promise.resolve(true),
            resolve: () => Promise.resolve(authorization),
          },
        ];
      },
      authorize: (request) => {
        authRequests.push(request);
        return Promise.resolve(authorization);
      },
    };
    const fetchImpl: typeof fetch = (input, init) => {
      if (typeof input !== "string") {
        return Promise.reject(new TypeError("expected string endpoint"));
      }
      fetchCalls.push({ input, init: init ?? {} });
      return Promise.resolve(
        Response.json({
          results: [
            {
              url: PAGE_A,
              title: "DeepSeek A",
              snippet: "snippet A",
              summary: "summary A",
              date: "2026-11-20",
            },
            { url: PAGE_B, title: "DeepSeek B", snippet: "snippet B", date: null },
          ],
        }),
      );
    };
    const provider = createWebSearchProvider({
      ...deps({ backend: "deepseek", sidecar: makeSidecar({ calls }), renderTopN: 0 }),
      deepseekAuth: auth,
      deepseekEndpoint: () => DEEPSEEK_ENDPOINT,
      fetchImpl,
    });

    const result = await provider.search({
      query: "dsh scrapling",
      maxResults: 2,
      llmProvider: DEEPSEEK_ROUTE,
    });

    expect(calls).toStrictEqual([]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe(DEEPSEEK_ENDPOINT);
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(fetchCalls[0]?.init.redirect).toBe("error");
    expect(new Headers(fetchCalls[0]?.init.headers).get("authorization")).toBe(
      "Bearer deepseek-secret",
    );
    const body = fetchCalls[0]?.init.body;
    if (typeof body !== "string") {
      throw new TypeError("expected JSON request body");
    }
    expect(JSON.parse(body)).toStrictEqual({
      query: "dsh scrapling",
      count: 2,
      need_content: false,
    });
    expect(authRequests[0]).toMatchObject({
      consumer: "@jayyuen66/dsh-scrapling",
      accepts: ["account", "api-key"],
      billing: "auto",
      route: DEEPSEEK_ROUTE,
      destination: { url: DEEPSEEK_ENDPOINT },
    });
    expect(result.sources).toStrictEqual([
      {
        url: PAGE_A,
        title: "DeepSeek A",
        snippet: "snippet A",
        summary: "summary A",
        publishedAt: PUBLISHED_AT,
      },
      { url: PAGE_B, title: "DeepSeek B", snippet: "snippet B" },
    ]);
    expect(JSON.stringify(result)).not.toContain("deepseek-secret");
  });

  it("deepseek 没有凭据时报 SEARCH_AUTH，且不发 HTTP 请求", async () => {
    let fetched = false;
    const provider = createWebSearchProvider({
      ...deps({ backend: "deepseek", renderTopN: 0 }),
      deepseekAuth: { candidates: () => [], authorize: () => Promise.resolve(undefined) },
      deepseekEndpoint: () => DEEPSEEK_ENDPOINT,
      fetchImpl: () => {
        fetched = true;
        return Promise.resolve(Response.json({ results: [] }));
      },
    });

    const error = await failureOf(() => provider.search({ query: "q" }));
    expect(error.code).toBe("SEARCH_AUTH");
    expect(fetched).toBe(false);
  });

  it("deepseek 401 会 reject 凭据并报 SEARCH_AUTH", async () => {
    let rejected = false;
    const provider = createWebSearchProvider({
      ...deps({ backend: "deepseek", renderTopN: 0 }),
      deepseekAuth: {
        candidates: () => [],
        authorize: () =>
          Promise.resolve({
            kind: "account",
            endpoint: DEEPSEEK_ENDPOINT,
            headers: { "x-dsh-auth-token": "account-secret" },
            reject: () => {
              rejected = true;
              return Promise.resolve();
            },
          }),
      },
      deepseekEndpoint: () => DEEPSEEK_ENDPOINT,
      fetchImpl: () => Promise.resolve(new Response("unauthorized", { status: 401 })),
    });

    const error = await failureOf(() => provider.search({ query: "q" }));
    expect(error.code).toBe("SEARCH_AUTH");
    expect(rejected).toBe(true);
  });

  it("deepseek 429 与畸形响应分别报 SEARCH_RATE_LIMIT / SEARCH_FAILED", async () => {
    const limited = createWebSearchProvider({
      ...deps({ backend: "deepseek", renderTopN: 0 }),
      deepseekAuth: {
        candidates: () => [],
        authorize: () =>
          Promise.resolve({ kind: "api-key", endpoint: DEEPSEEK_ENDPOINT, headers: {} }),
      },
      deepseekEndpoint: () => DEEPSEEK_ENDPOINT,
      fetchImpl: () => Promise.resolve(new Response("limited", { status: 429 })),
    });
    const limitedError = await failureOf(() => limited.search({ query: "q" }));
    expect(limitedError.code).toBe("SEARCH_RATE_LIMIT");

    const malformed = createWebSearchProvider({
      ...deps({ backend: "deepseek", renderTopN: 0 }),
      deepseekAuth: {
        candidates: () => [],
        authorize: () =>
          Promise.resolve({ kind: "api-key", endpoint: DEEPSEEK_ENDPOINT, headers: {} }),
      },
      deepseekEndpoint: () => DEEPSEEK_ENDPOINT,
      fetchImpl: () => Promise.resolve(Response.json({ results: "nope" })),
    });
    const malformedError = await failureOf(() => malformed.search({ query: "q" }));
    expect(malformedError.code).toBe("SCRAPLING_SEARCH_FAILED");
  });

  it("deepseek 搜索把调用方取消信号传给授权与 HTTP", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const provider = createWebSearchProvider({
      ...deps({ backend: "deepseek", renderTopN: 0 }),
      deepseekAuth: {
        candidates: () => [],
        authorize: (_request: DeepSeekAuthRequestLike, signal?: AbortSignal) => {
          if (signal !== undefined) {
            seen.push(signal);
          }
          return Promise.resolve({ kind: "api-key", endpoint: DEEPSEEK_ENDPOINT, headers: {} });
        },
      },
      deepseekEndpoint: () => DEEPSEEK_ENDPOINT,
      fetchImpl: (_input, init) => {
        if (init?.signal !== undefined && init.signal !== null) {
          seen.push(init.signal);
        }
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      },
    });

    await expect(provider.search({ query: "q" }, controller.signal)).rejects.toThrow(/aborted/u);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((signal) => signal.aborted)).toBe(true);
  });

  it("源地址全部过准入闸门：判否的条目不进 sources", async () => {
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }, { url: PAGE_B }, { url: PAGE_C }],
    });
    const result = await createWebSearchProvider(
      deps({ sidecar, renderTopN: 0, urlGate: blockList([PAGE_B]) }),
    ).search({ query: "q" });
    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A, PAGE_C]);
  });

  it("一条都不剩时报错，而不是回一次「成功但没有结果」的搜索", async () => {
    const sidecar = makeSidecar({ hits: [{ url: PAGE_A }, { url: PAGE_B }] });
    const error = await failureOf(() =>
      createWebSearchProvider(
        deps({ sidecar, renderTopN: 0, urlGate: blockList([PAGE_A, PAGE_B]) }),
      ).search({ query: "q" }),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("URL gate");
  });

  it("丢弃原因分开点名：被闸门判否的与拼不成绝对 URL 的各算各的", async () => {
    // 压成一句「全部被闸门拒绝」会把后端回了垃圾值也带去查安全策略。
    const sidecar = makeSidecar({
      discovery: { backend: "mojeek", hits: [{ url: "/relative-only" }, { url: PAGE_A }] },
    });
    const error = await failureOf(() =>
      createWebSearchProvider(
        deps({ sidecar, renderTopN: 0, urlGate: blockList([PAGE_A]) }),
      ).search({ query: "q" }),
    );
    expect(error.message).toContain("1 rejected by the URL gate");
    expect(error.message).toContain("1 were not usable URLs");
  });

  it("相对 URL 按回包里那个后端自己的端点归一", async () => {
    const sidecar = makeSidecar({
      discovery: { backend: "searxng", hits: [{ url: "/results/1" }] },
    });
    const result = await createWebSearchProvider(
      deps({ sidecar, renderTopN: 0, searxngEndpoint: "https://search.test" }),
    ).search({ query: "q" });
    expect(result.sources[0]?.url).toBe("https://search.test/results/1");
  });

  it("brave / serper / duckduckgo 的相对 URL 也各按自己的端点归一", async () => {
    const results = await Promise.all(
      [
        { backend: "brave", base: "https://brave.test", key: "braveEndpoint" },
        { backend: "serper", base: "https://serper.test", key: "serperEndpoint" },
        { backend: "duckduckgo", base: "https://ddg.test", key: "duckduckgoEndpoint" },
      ].map(async (item) => {
        const sidecar = makeSidecar({
          discovery: { backend: item.backend, hits: [{ url: "/r/1" }] },
        });
        const result = await createWebSearchProvider(
          deps({ sidecar, renderTopN: 0, [item.key]: item.base }),
        ).search({ query: "q" });
        return result.sources[0]?.url;
      }),
    );
    expect(results).toStrictEqual([
      "https://brave.test/r/1",
      "https://serper.test/r/1",
      "https://ddg.test/r/1",
    ]);
  });

  it("后端名不认识时相对 URL 宁可丢掉，也不拼到另一台主机上", async () => {
    const sidecar = makeSidecar({
      discovery: { backend: "mojeek", hits: [{ url: "/results/1" }, { url: PAGE_A }] },
    });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
    });
    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A]);
  });

  it("闸门归一过的地址，sources 与真正去抓的都是那一个", async () => {
    const normalized = "https://a.test/normalized";
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({ hits: [{ url: PAGE_A }], calls });
    const result = await createWebSearchProvider(
      deps({
        sidecar,
        renderTopN: 1,
        urlGate: async (): Promise<string | undefined> => normalized,
      }),
    ).search({ query: "q" });
    expect(result.sources[0]?.url).toBe(normalized);
    expect(calls[1]?.url).toBe(normalized);
  });

  it("后端一条都没回时是正常的空搜索，不过闸也不报错", async () => {
    const sidecar = makeSidecar({ hits: [] });
    const seen: string[] = [];
    const result = await createWebSearchProvider(
      deps({ sidecar, renderTopN: 1, urlGate: passGate(seen) }),
    ).search({ query: "q" });
    expect(result.sources).toStrictEqual([]);
    expect(seen).toStrictEqual([]);
    expect(result.content).toBeUndefined();
  });

  it("后端一条都没抓到、却带了一句原因时，把原因报出来而不是当成空搜索", async () => {
    const sidecar = makeSidecar({
      discovery: {
        backend: "bing",
        hits: [],
        note: "bing returned no li.b_algo results; the page layout may have changed",
      },
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({ query: "q" }),
    );
    // 抓 HTML 的后端（Bing / DuckDuckGo）空表多是版式变了或弹了验证码，那一句是
    // 唯一能说清成因的东西；不带原因的空表才是真空搜索（上一条用例钉着）。
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("li.b_algo");
  });

  it("maxResults 不是正整数时直接判否，不夹成一条空结果", async () => {
    const sidecar = makeSidecar({ hits: [{ url: PAGE_A }] });
    const codes = await Promise.all(
      [0, -3, 2.5].map(async (maxResults) => {
        const error = await failureOf(() =>
          createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({
            query: "q",
            maxResults,
          }),
        );
        expect(error.message).toContain("maxResults");
        return error.code;
      }),
    );
    expect(codes).toStrictEqual([SEARCH_FAILED, SEARCH_FAILED, SEARCH_FAILED]);
  });

  it("闸门扇出封顶：命中超过 100 条时只把前 100 条拿去过闸", async () => {
    const hits = Array.from({ length: 150 }, (_unused, index) => ({
      url: `https://h.test/${index}`,
    }));
    const sidecar = makeSidecar({ hits });
    const seen: string[] = [];
    await createWebSearchProvider(deps({ sidecar, renderTopN: 0, urlGate: passGate(seen) })).search(
      { query: "q", maxResults: 3 },
    );
    expect(seen).toHaveLength(100);
  });

  it("空查询直接判否，不打 sidecar", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({ calls });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar })).search({ query: "   " }),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(calls).toStrictEqual([]);
  });
});

describe("search provider 错误与取消", () => {
  it("tavily 没配 key 时 SEARCH_AUTH 原样透出，不静默换后端", async () => {
    const key = "super-secret-key-123";
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      calls,
      onDiscover: () => Promise.reject(new SidecarError("SEARCH_AUTH", "tavily needs an API key")),
    });
    const error = await failureOf(() =>
      createWebSearchProvider(
        deps({ sidecar, backend: "tavily", apiKey: key, renderTopN: 0 }),
      ).search({ query: "q" }),
    );
    // 先证明这枚 key 真进了链路：不传 apiKey 时「不回显 key」是一句永远成立的空断言。
    expect(calls[0]?.params["apiKey"]).toBe(key);
    expect(error.code).toBe("SEARCH_AUTH");
    expect(error.message).not.toContain(key);
  });

  it("发现层回包缺 hits 数组时报 SCRAPLING_SEARCH_FAILED", async () => {
    const sidecar = makeSidecar({ discovery: { backend: "bing" } });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({ query: "q" }),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("hits");
  });

  it("发现层回包根本不是对象时报 SCRAPLING_SEARCH_FAILED，且说得出收到的是什么", async () => {
    // 协议声明的是一个对象。sidecar 版本不匹配或对端换了形状时这里会收到别的东西，
    // 报错里带上类型名，比一句「没有 hits 数组」更容易看出是哪一层出了问题。
    const sidecar = makeSidecar({ discovery: ["not", "an", "object"] });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({ query: "q" }),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("object");
  });

  it("发现层的非 SEARCH_* sidecar 错误折成通用失败码", async () => {
    const sidecar = makeSidecar({
      onDiscover: () => Promise.reject(new SidecarError("SIDECAR_CLOSED", "pipe gone")),
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({ query: "q" }),
    );
    expect(error.code).toBe(SEARCH_FAILED);
  });

  it("URL 归一不出来的条目被丢掉，其余照常", async () => {
    const sidecar = makeSidecar({ hits: [{ url: "http://[" }, { url: PAGE_A }] });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
    });
    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A]);
  });

  it("丢掉非对象条目与空 URL 条目", async () => {
    const sidecar = makeSidecar({ hits: [7, { url: "" }, { url: PAGE_A }] });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
    });
    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A]);
  });

  it("sidecar 没回 backend 时按配置的后端选基准", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({ discovery: { hits: [{ url: "/relative" }] }, calls });
    await createWebSearchProvider(deps({ sidecar, backend: "bing", renderTopN: 1 })).search({
      query: "q",
    });
    expect(calls[1]?.url).toBe(new URL("/relative", BING_ENDPOINT).toString());
  });

  it("条目缺 title/snippet 时 sources 只带 url", async () => {
    const sidecar = makeSidecar({ hits: [{ url: PAGE_A }] });
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search({
      query: "q",
    });
    expect(result.sources[0]).toStrictEqual({ url: PAGE_A });
  });

  it("三种「读不到正文」的形态各报各的成因，并且整次搜索以通用失败码收", async () => {
    // 用 failureOf 而不是 rejects.toThrow(/…/)：后者只看消息，错误码回归成别的值它照样绿，
    // 与本文件其它失败用例的判法不一致。
    const cases = [
      { reply: "not-an-object", cause: "the fetch reply was not an object" },
      { reply: { content: 12_345, status: 200 }, cause: "without a text body" },
      { reply: { content: "", status: 200 }, cause: NO_BODY_REASON },
    ] as const;
    const outcomes = await Promise.all(
      cases.map(async (item) => {
        const sidecar = makeSidecar({
          hits: [{ url: PAGE_A }],
          onFetch: () => Promise.resolve(item.reply),
        });
        const provider = createWebSearchProvider(deps({ sidecar, renderTopN: 1 }));
        const error = await failureOf(() => provider.search({ query: "q" }));
        return {
          code: error.code ?? "",
          // 命中就把该档成因原样交回，没命中就把整条消息交回：红话里直接能看出是哪档含糊了。
          cause: error.message.includes(item.cause) ? item.cause : `未点名成因：${error.message}`,
        };
      }),
    );
    // 逐档比一张表：红话会指出是哪一档的成因或错误码不对，而不是三条里任一条含糊失败。
    expect(outcomes).toStrictEqual(
      cases.map((item) => ({ code: SEARCH_FAILED, cause: item.cause })),
    );
  });

  it("URL 全被安全闸门拦下时报错，原因里点名 URL_BLOCKED，且不触发渲染", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      calls,
      onFetch: () => Promise.reject(new SidecarError("URL_BLOCKED", "169.254.169.254: metadata")),
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({ query: "q" }),
    );
    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["fetch"]);
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("URL_BLOCKED");
  });

  it("发现阶段被取消时原样抛出", async () => {
    const controller = new AbortController();
    // 桩的文案刻意不含 "aborted"：那样「消息里含 aborted」就不再是判据。真正要钉的是
    // 抛出来的就是同一枚错误对象 —— 实现按 signal.aborted 决定不归包，不是按文案。
    const failure = new Error("pipe gone during discover");
    const sidecar = makeSidecar({
      onDiscover: () => {
        controller.abort();
        return Promise.reject(failure);
      },
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search(
        { query: "q" },
        controller.signal,
      ),
    );
    expect(error).toBe(failure);
    expect(error.code).toBeUndefined();
  });

  it("抓取途中被取消时，取消原样抛出而不是被包成搜索失败", async () => {
    const controller = new AbortController();
    const failure = new Error("pipe gone during fetch");
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      onFetch: () => {
        controller.abort();
        return Promise.reject(failure);
      },
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search(
        { query: "q" },
        controller.signal,
      ),
    );
    // 同一枚对象：包一层就变成另一个 Error，code 也会带上通用失败码。
    expect(error).toBe(failure);
    expect(error.code).toBeUndefined();
  });

  it("signal 同时透给发现层与 sidecar 抓取", async () => {
    const controller = new AbortController();
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({ hits: [{ url: PAGE_A }], calls });
    await createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search(
      { query: "q" },
      controller.signal,
    );
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[1]?.signal).toBe(controller.signal);
  });

  it("自动后端按 sidecar 回的 backend 选相对 URL 的基准", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      discovery: { backend: "tavily", hits: [{ url: "/relative" }] },
      calls,
    });
    await createWebSearchProvider(deps({ sidecar, backend: "auto", renderTopN: 1 })).search({
      query: "q",
    });
    expect(calls[1]?.url).toBe(new URL("/relative", API_ENDPOINT).toString());
  });
});
