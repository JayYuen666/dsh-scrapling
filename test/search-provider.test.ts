// dsh-scrapling/test/search-provider.test.ts —— ctx.web search provider（检索 + 渲染一体）。
//
// 覆盖重点：可用性判断不发网络请求、搜索后端的两种回包形状、抓取时确实走了带渲染的路径、
// 单条失败不该拖垮整次搜索、以及 provider 特有错误码真的落在 code 上。

import { describe, expect, it, vi } from "vitest";
import {
  SEARCH_PROVIDER_ID,
  createWebSearchProvider,
  parseSearchResults,
} from "../lib/search-provider.ts";
import type { SearchProviderDeps } from "../lib/search-provider.ts";
import type { SidecarClient } from "../lib/sidecar.ts";
import { SidecarError } from "../lib/sidecar-error.ts";

const ENDPOINT = "http://search.example/api";
const PAGE_A = "https://a.test/1";
const PAGE_B = "https://b.test/2";
const PAGE_C = "https://c.test/3";
const SEARCH_FAILED = "SCRAPLING_SEARCH_FAILED";

/** 假 sidecar 的一次调用记录。 */
interface SidecarCall {
  readonly method: string;
  readonly url: string;
  readonly signal: AbortSignal | undefined;
  readonly extractionType: unknown;
}

/** 建一个不发网络请求的假 sidecar，并记录它被怎么调。 */
const DEFAULT_CAPS = { scrapling: true, browser: true };

function fakeSidecar(calls: SidecarCall[], capabilities?: Record<string, unknown>): SidecarClient {
  const caps = capabilities ?? DEFAULT_CAPS;
  return {
    alive: true,
    capabilities: caps,
    call: (
      method: string,
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<unknown> => {
      const url = String(params["url"]);
      calls.push({
        method,
        url,
        signal: options?.signal,
        extractionType: params["extractionType"],
      });
      return Promise.resolve({ url, status: 200, content: `BODY-OF ${url}`, truncated: false });
    },
  } as unknown as SidecarClient;
}

function deps(over?: Partial<SearchProviderDeps>): SearchProviderDeps {
  return {
    sidecar: fakeSidecar([]),
    searchEndpoint: ENDPOINT,
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

/** 让全局 fetch 返回一段固定的搜索结果。 */
function stubSearchJson(body: unknown, ok?: boolean, status?: number): ReturnType<typeof vi.fn> {
  const mock = vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({
      ok: ok ?? true,
      status: status ?? 200,
      json: async (): Promise<unknown> => body,
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * 跑一次必须失败的调用，取出它抛出的错误。
 *
 * 用 `.then(成功分支抛错, 取错误)` 而不是 `rejects.toMatchObject`：后者对 Error 实例
 * 不成立（比的是可枚举自有属性），而 WebError 的 code 一旦写错位置它仍然是 WebError，
 * 断言照样「通过」—— 那样就等于没断。
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

/** 同上，但返回的是「有没有以某个码失败」—— 调用方不必自己解引用。 */

describe("parseSearchResults", () => {
  it("认 SearXNG 的 results 形状", () => {
    const hits = parseSearchResults({
      results: [{ url: PAGE_A, title: "A", content: "SA" }],
    });
    expect(hits).toStrictEqual([{ url: PAGE_A, title: "A", snippet: "SA" }]);
  });

  it("认 items 形状，丢掉 url 为空与不是对象的条目", () => {
    const hits = parseSearchResults({ items: [{ url: PAGE_B }, { url: "" }, 7] });
    expect(hits).toStrictEqual([{ url: PAGE_B }]);
  });

  it("不是对象 / 缺列表时给空数组，不抛", () => {
    expect(parseSearchResults("nope")).toStrictEqual([]);
    expect(parseSearchResults({})).toStrictEqual([]);
    expect(parseSearchResults({ results: "not-an-array" })).toStrictEqual([]);
  });
});

describe("search provider", () => {
  it("id 与 fetch provider 同一个，部署侧只写一处心智", () => {
    expect(SEARCH_PROVIDER_ID).toBe("scrapling");
    expect(createWebSearchProvider(deps()).id).toBe("scrapling");
  });

  it("没配端点时不可用，且不为此发任何网络请求", () => {
    const fetchMock = stubSearchJson({});
    expect(createWebSearchProvider(deps({ searchEndpoint: "   " })).available()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sidecar 没握手、或没报 scrapling 能力时都不可用", () => {
    const base = {
      alive: true,
      capabilities: DEFAULT_CAPS,
      call: async (): Promise<unknown> => ({}),
    };
    const dead = { alive: false, capabilities: DEFAULT_CAPS, call: base.call };
    const noCap = { alive: true, capabilities: undefined, call: base.call };
    expect(
      createWebSearchProvider(deps({ sidecar: dead as unknown as SidecarClient })).available(),
    ).toBe(false);
    expect(
      createWebSearchProvider(deps({ sidecar: noCap as unknown as SidecarClient })).available(),
    ).toBe(false);
    // capabilities 在，但没有 scrapling:true —— 只认浏览器不算具备抓取能力。
    const browserOnly = fakeSidecar([], { browser: true });
    expect(createWebSearchProvider(deps({ sidecar: browserOnly })).available()).toBe(false);
  });

  it("检索 → 渲染一体：浏览器可用时对前 N 条走 render", async () => {
    stubSearchJson({
      results: [
        { url: PAGE_A, title: "A" },
        { url: PAGE_B, title: "B" },
        { url: PAGE_C, title: "C" },
      ],
    });
    const calls: SidecarCall[] = [];
    const result = await createWebSearchProvider(
      deps({ sidecar: fakeSidecar(calls), renderTopN: 2 }),
    ).search({ query: "hello", maxResults: 8 });

    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A, PAGE_B, PAGE_C]);
    // 只有前两条被抓，且走 render（浏览器路径）；第三条只出现在 sources 里。
    expect(calls.map((call) => call.url)).toStrictEqual([PAGE_A, PAGE_B]);
    expect(calls.map((call) => call.method)).toStrictEqual(["render", "render"]);
    expect(result.content).toContain(`BODY-OF ${PAGE_A}`);
    expect(result.content).not.toContain(`BODY-OF ${PAGE_C}`);
    expect(result.truncated).toBe(false);
  });

  it("没有浏览器时退回静态抓取，仍是 markdown 抽取", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const calls: SidecarCall[] = [];
    await createWebSearchProvider(
      deps({ sidecar: fakeSidecar(calls, { scrapling: true, browser: false }), renderTopN: 1 }),
    ).search({ query: "q" });
    expect(calls.map((call) => call.method)).toStrictEqual(["fetch"]);
    expect(calls[0]?.extractionType).toBe("markdown");
  });

  it("renderTopN=0 时只给链接，不发任何抓取", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const calls: SidecarCall[] = [];
    const result = await createWebSearchProvider(
      deps({ sidecar: fakeSidecar(calls), renderTopN: 0 }),
    ).search({ query: "q" });
    expect(calls).toStrictEqual([]);
    expect(result.content).toBeUndefined();
    expect(result.sources).toHaveLength(1);
  });

  it("单条抓取失败只跳过那一条，整次搜索仍然成功", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }, { url: PAGE_B }] });
    const seen: string[] = [];
    const sidecar = {
      alive: true,
      capabilities: { scrapling: true, browser: true },
      call: (_method: string, params: Record<string, unknown>): Promise<unknown> => {
        const url = String(params["url"]);
        seen.push(url);
        return url === PAGE_A
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({ content: "ok" });
      },
    } as unknown as SidecarClient;
    const result = await createWebSearchProvider(deps({ sidecar, renderTopN: 2 })).search({
      query: "q",
    });
    expect(seen).toStrictEqual([PAGE_A, PAGE_B]);
    expect(result.sources).toHaveLength(2);
    expect(result.content).toContain("ok");
  });

  it("maxResults 截断 sources 并置 truncated", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }, { url: PAGE_B }, { url: PAGE_C }] });
    const result = await createWebSearchProvider(deps({ renderTopN: 0 })).search({
      query: "q",
      maxResults: 2,
    });
    expect(result.sources).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("源地址全部过准入闸门：判否的条目不进 sources", async () => {
    // 搜索后端的回包是外部输入，它尽可以回一条内网地址。不过闸门的话，那条地址就原样
    // 出现在模型眼前，而本包对同一地址的抓取是会被拦下的 —— 一边给结果、一边说不可抓。
    stubSearchJson({ results: [{ url: PAGE_A }, { url: PAGE_B }, { url: PAGE_C }] });
    const result = await createWebSearchProvider(
      deps({ renderTopN: 0, urlGate: blockList([PAGE_B]) }),
    ).search({ query: "q" });
    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A, PAGE_C]);
  });

  it("一条都不剩时报错，而不是回一次「成功但没有结果」的搜索", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }, { url: PAGE_B }] });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ renderTopN: 0, urlGate: blockList([PAGE_A, PAGE_B]) })).search(
        { query: "q" },
      ),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("URL gate");
  });

  it("闸门归一过的地址，sources 与真正去抓的都是那一个", async () => {
    // 判的与引用的必须是同一个串，否则归一化又成一条绕过面。
    const normalized = "https://a.test/normalized";
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const calls: SidecarCall[] = [];
    const result = await createWebSearchProvider(
      deps({
        sidecar: fakeSidecar(calls),
        renderTopN: 1,
        urlGate: async (): Promise<string | undefined> => normalized,
      }),
    ).search({ query: "q" });
    expect(result.sources[0]?.url).toBe(normalized);
    expect(calls[0]?.url).toBe(normalized);
  });

  it("后端一条都没回时是正常的空搜索，不过闸也不报错", async () => {
    stubSearchJson({ results: [] });
    const seen: string[] = [];
    const result = await createWebSearchProvider(
      deps({ renderTopN: 1, urlGate: passGate(seen) }),
    ).search({ query: "q" });
    expect(result.sources).toStrictEqual([]);
    expect(seen).toStrictEqual([]);
    expect(result.content).toBeUndefined();
  });

  it("maxResults 不是正整数时直接判否，不夹成一条空结果", async () => {
    // 夹成 0 的话，这次调用会变成一次「成功但一条结果都没有」的搜索：模型与用户都看不出
    // 是入参不对，只会以为搜不到东西。
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const codes = await Promise.all(
      [0, -3, 2.5].map(async (maxResults) => {
        const error = await failureOf(() =>
          createWebSearchProvider(deps({ renderTopN: 1 })).search({ query: "q", maxResults }),
        );
        expect(error.message).toContain("maxResults");
        return error.code;
      }),
    );
    expect(codes).toStrictEqual([SEARCH_FAILED, SEARCH_FAILED, SEARCH_FAILED]);
  });

  it("搜索后端非 2xx 时抛 provider 特有码，且 code 不是那段文案", async () => {
    stubSearchJson({}, false, 503);
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ renderTopN: 0 })).search({ query: "q" }),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("503");
  });

  it("闸门扇出封顶：命中超过 100 条时只把前 100 条拿去过闸", async () => {
    // 闸门每条一次 DNS：封顶必须落在过闸之前，一万条命中不该触发一万次解析。
    // 上限值与 lib/search-provider.ts 的 MAX_SOURCES 对齐。
    const hits = Array.from({ length: 150 }, (_unused, index) => ({
      url: `https://h.test/${index}`,
    }));
    stubSearchJson({ results: hits });
    const seen: string[] = [];
    await createWebSearchProvider(deps({ renderTopN: 0, urlGate: passGate(seen) })).search({
      query: "q",
      maxResults: 3,
    });
    expect(seen).toHaveLength(100);
  });

  it("端点不是 http(s) 时拒绝，不去读本地文件", async () => {
    stubSearchJson({ results: [] });
    const error = await failureOf(() =>
      createWebSearchProvider(deps({ searchEndpoint: "file:///etc/passwd", renderTopN: 0 })).search(
        {
          query: "q",
        },
      ),
    );
    expect(error.code).toBe(SEARCH_FAILED);
    expect(error.message).toContain("http(s)");
  });

  it("空查询直接判否，不打后端", async () => {
    const fetchMock = stubSearchJson({});
    const error = await failureOf(() => createWebSearchProvider(deps()).search({ query: "   " }));
    expect(error.code).toBe(SEARCH_FAILED);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("search provider 边界", () => {
  it("不带 signal 调用也能走通", async () => {
    stubSearchJson({ results: [{ url: PAGE_A, title: "A", content: "SA" }] });
    const result = await createWebSearchProvider(deps()).search({ query: "q" });
    expect(result.sources[0]).toStrictEqual({ url: PAGE_A, title: "A", snippet: "SA" });
    expect(result.content).toContain(`BODY-OF ${PAGE_A}`);
  });

  it("URL 归一不出来的条目被丢掉，其余照常", async () => {
    stubSearchJson({ results: [{ url: "http://[" }, { url: PAGE_A }] });
    const result = await createWebSearchProvider(deps({ renderTopN: 0 })).search({ query: "q" });
    expect(result.sources.map((source) => source.url)).toStrictEqual([PAGE_A]);
  });

  it("条目缺 title/snippet 时 sources 只带 url", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const result = await createWebSearchProvider(deps({ renderTopN: 0 })).search({ query: "q" });
    expect(result.sources[0]).toStrictEqual({ url: PAGE_A });
  });

  it("sidecar 回的不是对象、或 content 非字符串时整次搜索报错，而不是返回空成功", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const notObject = {
      alive: true,
      capabilities: { scrapling: true, browser: false },
      call: (): Promise<unknown> => Promise.resolve("not-an-object"),
    } as unknown as SidecarClient;
    const badContent = {
      alive: true,
      capabilities: { scrapling: true, browser: false },
      call: (): Promise<unknown> => Promise.resolve({ content: 12_345, status: 200 }),
    } as unknown as SidecarClient;

    // 有 sources 却一条正文都没读到 = 故障，不是一次「成功但没内容」的搜索。
    // 原因写进错误里：URL 被安全闸门拦下与后端超时是两种完全不同的故障，用户要分得清。
    await expect(
      createWebSearchProvider(deps({ sidecar: notObject, renderTopN: 1 })).search({ query: "q" }),
    ).rejects.toThrow(/no body/u);
    await expect(
      createWebSearchProvider(deps({ sidecar: badContent, renderTopN: 1 })).search({ query: "q" }),
    ).rejects.toThrow(/no body/u);
  });

  it("URL 全被安全闸门拦下时报错，原因里点名 URL_BLOCKED", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const blocked = {
      alive: true,
      capabilities: { scrapling: true, browser: false },
      call: (): Promise<unknown> =>
        Promise.reject(new SidecarError("URL_BLOCKED", "169.254.169.254: metadata")),
    } as unknown as SidecarClient;
    let caught: (Error & { code?: string }) | undefined;
    try {
      await createWebSearchProvider(deps({ sidecar: blocked, renderTopN: 1 })).search({
        query: "q",
      });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught?.code).toBe("SCRAPLING_SEARCH_FAILED");
    expect(caught?.message).toContain("URL_BLOCKED");
  });

  it("取消不被当成「这条链接死了」，整次调用照常抛出", async () => {
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const controller = new AbortController();
    const aborting = {
      alive: true,
      capabilities: { scrapling: true, browser: false },
      call: (): Promise<unknown> => {
        controller.abort();
        return Promise.reject(new Error("aborted"));
      },
    } as unknown as SidecarClient;
    await expect(
      createWebSearchProvider(deps({ sidecar: aborting, renderTopN: 1 })).search(
        { query: "q" },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/u);
  });

  it("抓取途中被取消时，取消原样抛出而不是被包成搜索失败", async () => {
    // 取消的语义是「这次调用作废」。包成 provider 失败码的话，seam 那头看到的就是一次
    // 搜索失败，日志与用户提示都会指错方向。
    stubSearchJson({ results: [{ url: PAGE_A }] });
    const controller = new AbortController();
    const aborting = {
      alive: true,
      capabilities: { scrapling: true, browser: false },
      call: (): Promise<unknown> => {
        controller.abort();
        return Promise.reject(new Error("this call was aborted"));
      },
    } as unknown as SidecarClient;
    const caught = await failureOf(() =>
      createWebSearchProvider(deps({ sidecar: aborting, renderTopN: 1 })).search(
        { query: "q" },
        controller.signal,
      ),
    );
    expect(caught.code).toBeUndefined();
    expect(caught.message).toContain("aborted");
  });

  it("搜索后端那次请求本身被取消时，取消原样抛出", async () => {
    // 与抓取途中被取消同一处理：取消不是 provider 故障，包上失败码会让日志指错方向。
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<unknown>>(() => {
        controller.abort();
        return Promise.reject(new Error("The operation was aborted"));
      }),
    );
    const caught = await failureOf(() =>
      createWebSearchProvider(deps({ renderTopN: 0 })).search({ query: "q" }, controller.signal),
    );
    expect(caught.code).toBeUndefined();
    expect(caught.message).toContain("aborted");
  });

  it("signal 同时透给搜索后端与 sidecar 抓取", async () => {
    const fetchMock = stubSearchJson({ results: [{ url: PAGE_A }] });
    const calls: SidecarCall[] = [];
    const controller = new AbortController();
    await createWebSearchProvider(deps({ sidecar: fakeSidecar(calls), renderTopN: 1 })).search(
      { query: "q" },
      controller.signal,
    );
    const options = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    // 搜索后端拿到的是「调用方取消 + 本次搜索超时」的组合信号，不是原对象本身：
    // 只转原 signal 的话，调用方没给 signal 时这一枪就没有任何超时。
    expect(options?.signal?.aborted).toBe(false);
    controller.abort();
    expect(options?.signal?.aborted).toBe(true);
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
