// dsh-scrapling/test/search-provider.test.ts —— ctx.web search provider（检索 + 渲染一体）。
//
// 检索由 sidecar 的 search.discover 完成（Tavily/Bing 两条已验证路径），Host 只负责过闸、
// 截断与渲染前 N 条。覆盖重点：错误码原样透出、key 不回显、闸门与正文失败的语义。

import { describe, expect, it } from "vitest";
import { SEARCH_PROVIDER_ID, createWebSearchProvider } from "../lib/search-provider.ts";
import type { SearchProviderDeps } from "../lib/search-provider.ts";
import type { SidecarClient } from "../lib/sidecar.ts";
import { SidecarError } from "../lib/sidecar-error.ts";

const PAGE_A = "https://a.test/1";
const PAGE_B = "https://b.test/2";
const PAGE_C = "https://c.test/3";
const SEARCH_FAILED = "SCRAPLING_SEARCH_FAILED";
const DISCOVER = "search.discover";
const API_ENDPOINT = "https://api.tavily.test/search";
const BING_ENDPOINT = "https://bing.test/search";

/** 假 sidecar 的一次调用记录。 */
interface SidecarCall {
  readonly method: string;
  readonly url: string;
  readonly params: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
  readonly extractionType: unknown;
}

/** 默认能力面：能抓取、有浏览器。 */
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

function deps(over?: Partial<SearchProviderDeps>): SearchProviderDeps {
  return {
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
    timeoutMs: 30_000,
    ...over,
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
    const sidecar = makeSidecar({ calls });
    expect(createWebSearchProvider(deps({ sidecar })).available()).toBe(true);
    expect(calls).toStrictEqual([]);

    const dead = {
      alive: false,
      capabilities: DEFAULT_CAPS,
      call: async (): Promise<unknown> => ({}),
    } as unknown as SidecarClient;
    expect(createWebSearchProvider(deps({ sidecar: dead })).available()).toBe(false);
    const noCap = {
      alive: true,
      capabilities: undefined,
      call: async (): Promise<unknown> => ({}),
    } as unknown as SidecarClient;
    expect(createWebSearchProvider(deps({ sidecar: noCap })).available()).toBe(false);
    const browserOnly = makeSidecar({ capabilities: { browser: true } });
    expect(createWebSearchProvider(deps({ sidecar: browserOnly })).available()).toBe(false);
  });

  it("auto 没有任何发现路径时不可用 —— 公共引擎不是默认路径（spec D10）", () => {
    expect(createWebSearchProvider(deps({ backend: "auto" })).available()).toBe(false);
    expect(
      createWebSearchProvider(
        deps({ backend: "auto", searxngEndpoint: "https://searx.test" }),
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

describe("search provider 检索与渲染", () => {
  it("走 sidecar 的 search.discover，前 N 条用 render 渲染", async () => {
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
    expect(calls.slice(1).map((call) => call.url)).toStrictEqual([PAGE_A, PAGE_B]);
    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["render", "render"]);
    expect(result.content).toContain(`BODY-OF ${PAGE_A}`);
    expect(result.content).not.toContain(`BODY-OF ${PAGE_C}`);
    expect(result.truncated).toBe(false);
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
    const tavilyKey = "tavily-key";
    const cases = [
      { backend: "brave", key: "brave-key", over: { braveApiKey: "brave-key" } },
      { backend: "serper", key: "serper-key", over: { serperApiKey: "serper-key" } },
      { backend: "tavily", key: tavilyKey, over: { apiKey: tavilyKey } },
    ] as const;
    await Promise.all(
      cases.map(async (item) => {
        const calls: SidecarCall[] = [];
        const sidecar = makeSidecar({ calls });
        await createWebSearchProvider(
          deps({ sidecar, backend: item.backend, apiKey: tavilyKey, renderTopN: 0, ...item.over }),
        ).search({ query: "q" });
        expect(calls[0]?.params).toMatchObject({ backend: item.backend, apiKey: item.key });
      }),
    );
  });

  it("没有浏览器时退回静态抓取，仍是 markdown 抽取", async () => {
    const calls: SidecarCall[] = [];
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      capabilities: { scrapling: true, browser: false },
      calls,
    });
    await createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({ query: "q" });
    expect(calls.slice(1).map((call) => call.method)).toStrictEqual(["fetch"]);
    expect(calls[1]?.extractionType).toBe("markdown");
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
    const sidecar = makeSidecar({
      onDiscover: () => Promise.reject(new SidecarError("SEARCH_AUTH", "tavily needs an API key")),
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, backend: "tavily", renderTopN: 0 })).search({
        query: "q",
      }),
    );
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

  it("sidecar 抓取回的不是对象、或 content 非字符串时整次搜索报错", async () => {
    const notObject = makeSidecar({
      hits: [{ url: PAGE_A }],
      onFetch: () => Promise.resolve("not-an-object"),
    });
    const badContent = makeSidecar({
      hits: [{ url: PAGE_A }],
      onFetch: () => Promise.resolve({ content: 12_345, status: 200 }),
    });
    await expect(
      createWebSearchProvider(deps({ sidecar: notObject, renderTopN: 1 })).search({ query: "q" }),
    ).rejects.toThrow(/no body/u);
    await expect(
      createWebSearchProvider(deps({ sidecar: badContent, renderTopN: 1 })).search({ query: "q" }),
    ).rejects.toThrow(/no body/u);
  });

  it("URL 全被安全闸门拦下时报错，原因里点名 URL_BLOCKED", async () => {
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      onFetch: () => Promise.reject(new SidecarError("URL_BLOCKED", "169.254.169.254: metadata")),
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search({ query: "q" }),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("URL_BLOCKED");
  });

  it("发现阶段被取消时原样抛出", async () => {
    const controller = new AbortController();
    const sidecar = makeSidecar({
      onDiscover: () => {
        controller.abort();
        return Promise.reject(new Error("The operation was aborted"));
      },
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 0 })).search(
        { query: "q" },
        controller.signal,
      ),
    );
    expect(error.code).toBeUndefined();
    expect(error.message).toContain("aborted");
  });

  it("抓取途中被取消时，取消原样抛出而不是被包成搜索失败", async () => {
    const controller = new AbortController();
    const sidecar = makeSidecar({
      hits: [{ url: PAGE_A }],
      onFetch: () => {
        controller.abort();
        return Promise.reject(new Error("this call was aborted"));
      },
    });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar, renderTopN: 1 })).search(
        { query: "q" },
        controller.signal,
      ),
    );
    expect(error.code).toBeUndefined();
    expect(error.message).toContain("aborted");
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
