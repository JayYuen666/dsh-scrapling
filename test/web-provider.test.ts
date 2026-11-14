// dsh-scrapling/test/web-provider.test.ts —— ctx.web fetch provider。
//
// 重点验两条容易搞错的契约：available() 不得发网络请求（只看 sidecar 本地状态）；
// markdown 必须降级成 text —— dsh-web 的 WebFetchBody 是封闭联合，只有 html/text。

import { describe, expect, it } from "vitest";
import { createWebFetchProvider, PROVIDER_ID, toBodyKind } from "../lib/web-provider.ts";
import type { WebProviderDeps } from "../lib/web-provider.ts";
import { SidecarError } from "../lib/sidecar-error.ts";
import { SidecarClient } from "../lib/sidecar.ts";

/** 造一个不发任何请求的 sidecar 客户端。 */
function stubSidecar(): SidecarClient {
  return new SidecarClient({} as never, {
    pythonBin: "python3",
    bridgePath: "bridge.py",
    cwd: ".",
    handshakeTimeoutMs: 10,
    requestTimeoutMs: 10,
    graceMs: 10,
  });
}

/**
 * 用例侧的依赖形态：两个热改预算写成普通值，由 {@link makeDeps} 包成读取器。
 *
 * 读取器本身由 `预算读取器` 那条用例专门钉住（同一个 provider 两次抓取之间改值，第二次要
 * 看到新值），所以这里不必每处手写 `() => 4000`。
 */
type PlainDeps = Omit<WebProviderDeps, "maxOutputBytes" | "timeoutMs"> & {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
};

/**
 * 一份用例依赖：sidecar 与两个预算值每次都是新的。
 *
 * 原先这是模块级共享的 `const DEPS`，而 `available` 那组用 `Object.defineProperty` 反复改写
 * 同一枚 sidecar 的 `alive` / `capabilities`：用例一重排、加 `.concurrent`，或中途有一条红在
 * 改状态之后（恢复语句就跑不到），下一条读到的就是上一位的残留状态。
 *
 * @param overrides - 要替换的位（通常只换 sidecar）
 * @returns 供 `createWebFetchProvider` 用的依赖
 */
function makeDeps(overrides: Partial<PlainDeps> = {}): WebProviderDeps {
  const plain: PlainDeps = {
    sidecar: stubSidecar(),
    maxOutputBytes: 4000,
    timeoutMs: 30_000,
    ...overrides,
  };
  return {
    ...plain,
    maxOutputBytes: () => plain.maxOutputBytes,
    timeoutMs: () => plain.timeoutMs,
  };
}

/** 用例里要读默认预算时用它，免得把「读取器」这件事泄漏到断言表达式里。 */
const DEFAULT_MAX_OUTPUT_BYTES = 4000;

/** 握手后的能力表：`scrapling` 那一档可按用例需要改。 */
function capabilities(scrapling = true): Record<string, unknown> {
  return {
    scrapling,
    static: true,
    extract: true,
    browser: false,
    version: "0.5",
  };
}

/**
 * 造一台「握过手 / 没握手」可控的 sidecar。
 *
 * `alive` 与 `capabilities` 在 `SidecarClient` 上是只读 getter，只能按实例覆盖；
 * 覆盖动作留在这个工厂里，用例就不再直接改共享对象。
 *
 * @param options - 活不活、能力表、以及 `call` 要不要被记录
 * @returns 可用的 sidecar 替身
 */
function fakeSidecar(
  options: {
    alive?: boolean;
    caps?: Record<string, unknown> | undefined;
    call?: (method: string, params: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  } = {},
): SidecarClient {
  const client = stubSidecar();
  Object.defineProperties(client, {
    alive: { value: options.alive ?? false, configurable: true },
    capabilities: { value: options.caps, configurable: true },
  });
  if (options.call !== undefined) {
    Object.assign(client, { call: options.call });
  }
  return client;
}

describe("toBodyKind", () => {
  it("html 保持 html，markdown 与 text 都降级成 text", () => {
    expect(toBodyKind("html")).toBe("html");
    expect(toBodyKind("markdown")).toBe("text");
    expect(toBodyKind("text")).toBe("text");
    expect(toBodyKind("别的")).toBe("text");
  });
});

describe("available", () => {
  it("sidecar 没起来时不可用，而且不发任何请求", () => {
    // available() 是同步的：实现里若偷偷 call 一次 sidecar，那个 Promise 会被丢掉，
    // 只看布尔值的断言一位都测不到。所以替身把每一次 call 记下来并直接抛。
    const requested: string[] = [];
    const sidecar = fakeSidecar({
      alive: false,
      call: (method): Promise<unknown> => {
        requested.push(method);
        throw new Error("available() 不该发请求");
      },
    });
    expect(createWebFetchProvider(makeDeps({ sidecar })).available()).toBe(false);
    expect(requested).toStrictEqual([]);
  });

  it("handshake 过且有 scrapling 才可用", () => {
    const sidecar = fakeSidecar({ alive: true, caps: capabilities(true) });
    expect(createWebFetchProvider(makeDeps({ sidecar })).available()).toBe(true);
  });

  it("活着但能力表说没有 scrapling 时不可用", () => {
    // 这一档与「没起来」是两条不同的路径：握手成功、scrapling 没装上，
    // 实现里那句 `capabilities?.scrapling === true` 一旦退化就会被这里抓到。
    const noScrapling = fakeSidecar({ alive: true, caps: capabilities(false) });
    const noCapabilities = fakeSidecar({ alive: true });
    expect(createWebFetchProvider(makeDeps({ sidecar: noScrapling })).available()).toBe(false);
    expect(createWebFetchProvider(makeDeps({ sidecar: noCapabilities })).available()).toBe(false);
  });

  it("有 scrapling 但 sidecar 已死时不可用", () => {
    const sidecar = fakeSidecar({ alive: true, caps: capabilities(true) });
    expect(createWebFetchProvider(makeDeps({ sidecar })).available()).toBe(true);
    Object.defineProperty(sidecar, "alive", { value: false, configurable: true });
    expect(createWebFetchProvider(makeDeps({ sidecar })).available()).toBe(false);
  });
});

describe("fetch", () => {
  it("返回 url/status/body/truncated，markdown 降级成 text", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({
        url: "https://example.test/final",
        status: 201,
        content: "# body",
        truncated: false,
      }),
    });
    const result = await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({
      url: "https://example.test/start",
    });
    expect(result.url).toBe("https://example.test/final");
    expect(result.statusCode).toBe(201);
    expect(result.body).toStrictEqual({ kind: "text", content: "# body" });
    expect(result.truncated).toBe(false);
  });

  it("sidecar 截断或超出字节预算都会标 truncated", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({
        url: "u",
        status: 200,
        content: "y".repeat(9000),
        truncated: false,
      }),
    });
    const result = await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    expect(result.truncated).toBe(true);
  });

  it("sidecar 自己标了截断、正文没超预算时也透传 truncated", async () => {
    // 实现是 `payload.truncated === true || capped.truncated` 两半并列：只测后半段时，
    // 前半段（sidecar 已裁过、本层不必再裁）被整段丢掉也不会红。
    const client = fakeSidecar({
      call: async (): Promise<unknown> => ({
        url: "u",
        status: 200,
        content: "短正文",
        truncated: true,
      }),
    });
    const result = await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    expect(result.truncated).toBe(true);
    expect(result.body.content).toBe("短正文");
  });

  it("超预算时正文真的被裁到预算以内，不只是标一个 truncated", async () => {
    // 只置 truncated 而原样返回超长正文的话，那段正文照样进上下文与会话日志，
    // 而 truncated: true 反而让调用方以为已经裁过了。
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({
        url: "u",
        status: 200,
        content: "y".repeat(9000),
        truncated: false,
      }),
    });
    const result = await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    expect(Buffer.byteLength(result.body.content, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    expect(result.body.content.length).toBeLessThan(9000);
  });

  it("多字节正文同样按预算统一处理，不会靠字符数蒙混过去", async () => {
    // 预算这一个数同时是 sidecar 的 maxContentChars（字符）与 capText 的字节预算。
    // 中文一个字三字节，所以 3000 个中文在字节预算下确实超了：统一处理按字节算，如实标真截断。
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({
        url: "u",
        status: 200,
        content: "中".repeat(3000),
        truncated: false,
      }),
    });
    const result = await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body.content, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_OUTPUT_BYTES,
    );
  });

  it("回包不是对象时抛错，而不是补成一张空白的成功页", async () => {
    // 补成 { statusCode: 0, content: "" } 的话，调用方会把 0 当成真实状态码、把空正文
    // 当成「这个页面本来就没内容」—— 对端协议一坏，结果就是一片看着正常的空结果。
    const client = stubSidecar();
    Object.assign(client, { call: async (): Promise<unknown> => "not an object" });
    let caught: (Error & { code?: string }) | undefined;
    try {
      await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught?.code).toBe("SCRAPLING_FETCH_FAILED");
    expect(caught?.message).toContain("malformed");
  });

  it("回包是 undefined 时同样抛可路由的抓取失败，而不是在拼错误文案时崩掉", async () => {
    // `JSON.stringify(undefined)` 返回 undefined，紧跟的 `.slice` 会抛 TypeError ——
    // 调用方拿到的是没有 code 的崩溃，而不是能按码路由的 SCRAPLING_FETCH_FAILED。
    const client = stubSidecar();
    Object.assign(client, { call: async (): Promise<unknown> => undefined });
    let caught: (Error & { code?: string }) | undefined;
    try {
      await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.constructor.name).toBe("WebError");
    expect(caught?.code).toBe("SCRAPLING_FETCH_FAILED");
    expect(caught?.message).toContain("malformed");
  });

  it("回包是循环引用对象时也不崩在拼错误文案上", async () => {
    // 循环引用会让 JSON.stringify 抛；拼文案这一层不许把「回包坏了」换成一条
    // 没有 code 的 TypeError。
    const client = stubSidecar();
    const cyclic: Record<string, unknown> = { url: "u" };
    cyclic["self"] = cyclic;
    Object.assign(client, { call: async (): Promise<unknown> => cyclic });
    let caught: (Error & { code?: string }) | undefined;
    try {
      await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught?.constructor.name).toBe("WebError");
    expect(caught?.code).toBe("SCRAPLING_FETCH_FAILED");
    expect(caught?.message).toContain("malformed");
  });

  it("回包缺 status / content 时同样抛错", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({ url: "u" }),
    });
    await expect(
      createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" }),
    ).rejects.toThrow(/malformed/u);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["0", 0],
    ["负数", -1],
    ["600", 600],
    ["小数", 200.5],
  ])("status 是 %s 时按回包坏了处理，不让它进模型看到的标题行", async (_label, status) => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({ url: "http://a.test/", status, content: "body" }),
    });
    let caught: (Error & { code?: string }) | undefined;
    try {
      await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught?.code).toBe("SCRAPLING_FETCH_FAILED");
    expect(caught?.message).toContain("malformed");
  });

  it("url 是空串时同样判坏了：宿主那张卡会没有标题", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({ url: "", status: 200, content: "body" }),
    });
    await expect(
      createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" }),
    ).rejects.toThrow(/malformed/u);
  });

  it("sidecar 的原始错误挂在 cause 上：code 是 provider 的，机器可读的那一枚不能只活在文案里", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<never> => {
        throw new SidecarError("URL_BLOCKED", "blocked by the url policy");
      },
    });
    let caught: (Error & { code?: string; cause?: unknown }) | undefined;
    try {
      await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string; cause?: unknown };
    }
    expect(caught?.code).toBe("SCRAPLING_FETCH_FAILED");
    expect(caught?.message).toContain("URL_BLOCKED");
    const cause = caught?.cause;
    expect(cause).toBeInstanceOf(SidecarError);
    expect((cause as SidecarError).code).toBe("URL_BLOCKED");
  });

  it("给了 signal 时会一并透传给 sidecar", async () => {
    const deps = makeDeps();
    const seen: { hasSignal: boolean }[] = [];
    const client = fakeSidecar({
      call: async (_m: string, _p: unknown, opts?: Record<string, unknown>): Promise<unknown> => {
        seen.push({ hasSignal: (opts?.["signal"] as AbortSignal | undefined) !== undefined });
        return { url: "u", status: 200, content: "x", truncated: false };
      },
    });
    const provider = createWebFetchProvider({ ...deps, sidecar: client });
    await provider.fetch({ url: "u" }, new AbortController().signal);
    await provider.fetch({ url: "u" });
    expect(seen).toStrictEqual([{ hasSignal: true }, { hasSignal: false }]);
  });

  it("输出的字节预算与协同超时按 deps 透传，不写死也不漏传", async () => {
    // 这两个值一边决定 sidecar 侧裁到多少字符，一边决定协议层的超时；漏传或写死都会
    // 让「设置卡拧了旋钮」在这条路径上没有效果，而回包形状照旧、看不出异常。
    const deps = makeDeps();
    const sent: { params: unknown; opts: unknown }[] = [];
    const client = fakeSidecar({
      call: async (
        _method: string,
        params: unknown,
        opts?: Record<string, unknown>,
      ): Promise<unknown> => {
        sent.push({ params, opts });
        return { url: "u", status: 200, content: "x", truncated: false };
      },
    });
    await createWebFetchProvider({ ...deps, sidecar: client }).fetch({ url: "https://a.test/" });
    expect(sent).toHaveLength(1);
    const record = sent[0] as { params: Record<string, unknown>; opts: Record<string, unknown> };
    expect(record.params["url"]).toBe("https://a.test/");
    expect(record.params["maxContentChars"]).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(record.opts["timeoutMs"]).toBe(30_000);
  });

  it("预算与超时是读取器：同一个 provider 两次抓取之间改值，第二次按新值走", async () => {
    // `fetchMaxOutputChars` / `fetchTimeoutMs` 都是 volatile 位，改值不重跑 apply。装配时把
    // 值抄进闭包的实现在这条用例上第二次仍然发旧值 —— 而生产里的症状是「卡上拧了旋钮、
    // 抓回来的正文还是按老预算裁的」，回包形状照旧，看不出任何异常。
    const sent: { params: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    const client = fakeSidecar({
      call: async (
        _method: string,
        params: unknown,
        opts?: Record<string, unknown>,
      ): Promise<unknown> => {
        sent.push({ params: params as Record<string, unknown>, opts: opts! });
        return { url: "u", status: 200, content: "x", truncated: false };
      },
    });
    let budget = 4000;
    let timeout = 30_000;
    const provider = createWebFetchProvider({
      ...makeDeps(),
      sidecar: client,
      maxOutputBytes: () => budget,
      timeoutMs: () => timeout,
    });

    await provider.fetch({ url: "u" });
    budget = 9000;
    timeout = 45_000;
    await provider.fetch({ url: "u" });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.params["maxContentChars"]).toBe(4000);
    expect(sent[0]?.opts["timeoutMs"]).toBe(30_000);
    expect(sent[1]?.params["maxContentChars"]).toBe(9000);
    expect(sent[1]?.opts["timeoutMs"]).toBe(45_000);
  });

  it("sidecar 抛错时包成带 code 的 WebError，并把 sidecar 的码带进消息", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => {
        throw new SidecarError("URL_BLOCKED", "blocked by the host gate");
      },
    });
    const provider = createWebFetchProvider(makeDeps({ sidecar: client }));
    // WebError 的签名是 (message, code)。这里必须断 code 而不是只看类型 —— 参数写反时
    // 照样是 WebError 实例，但 code 会变成一整段错误文本，按码路由的调用方就废了。
    let caught: (Error & { code?: string }) | undefined;
    try {
      await provider.fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    // ctx.web.fetch 对 provider 抛出的错是原样透传（宿主 web 侧不 catch、不按 instanceof
    // 分流），跨模块副本真正流动的只有 message 与 code；而 vitest 5 的模块图会把
    // @deepseek-ai/dsh-web 在测试侧与 lib 侧各装一份（纯 node 下同一个说明符解析为同一
    // 实例，instanceof 通过），instanceof 在这里量到的是装载器不是行为——类身份改用
    // constructor.name 钉，message 与 code 仍逐字断言。
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.constructor.name).toBe("WebError");
    expect(caught?.code).toBe("SCRAPLING_FETCH_FAILED");
    // 外层码统一是 SCRAPLING_FETCH_FAILED（WebError 的 code 是开放的 provider 码），
    // 但内层 sidecar 码必须留在消息里：「被安全闸门拦下」与「sidecar 超时」要采取的行动不同。
    expect(caught?.message).toContain("URL_BLOCKED");
    expect(caught?.message).toContain("blocked by the host gate");
  });

  it("sidecar 抛的不是 SidecarError 时，消息里不带空的码前缀", async () => {
    // 码前缀只在真有码时拼。非 sidecar 错误也拼的话，消息会以「: 」开头 —— 调用方读到的是
    // 一段以冒号起头的文本，看不出这条错误有没有码。
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => {
        throw new Error("socket hang up");
      },
    });
    let caught: (Error & { code?: string }) | undefined;
    try {
      await createWebFetchProvider(makeDeps({ sidecar: client })).fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.constructor.name).toBe("WebError");
    // 判的是这条意图：没有码时不许拼出以「: 」起头的空前缀。整段比对 `String(error)`
    // 的拼法（含类名）会把实现换成更干净的 `error.message` 时也判红，那是误报。
    expect(caught?.message).not.toMatch(/^\s*:/u);
    expect(caught?.message).toContain("socket hang up");
  });

  it("调用方取消时原样抛出，不被包成一次抓取失败", async () => {
    // 包成抓取失败的话，调用方会把一次用户已经放弃的请求当成可重试的故障。
    const client = stubSidecar();
    const controller = new AbortController();
    Object.assign(client, {
      call: async (): Promise<unknown> => {
        controller.abort();
        throw new SidecarError("SIDECAR_ABORTED", "aborted");
      },
    });
    const provider = createWebFetchProvider(makeDeps({ sidecar: client }));
    let caught: unknown;
    try {
      await provider.fetch({ url: "u" }, controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SidecarError);
    expect((caught as SidecarError).code).toBe("SIDECAR_ABORTED");
  });
});

describe("provider id", () => {
  it("固定为 scrapling（部署配置要按这个名字写）", () => {
    expect(PROVIDER_ID).toBe("scrapling");
    expect(createWebFetchProvider(makeDeps()).id).toBe("scrapling");
  });
});
