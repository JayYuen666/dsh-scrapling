// dsh-scrapling/test/web-provider.test.ts —— ctx.web fetch provider。
//
// 重点验两条容易搞错的契约：available() 不得发网络请求（只看 sidecar 本地状态）；
// markdown 必须降级成 text —— dsh-web 的 WebFetchBody 是封闭联合，只有 html/text。

import { describe, expect, it } from "vitest";
import { createWebFetchProvider, PROVIDER_ID, toBodyKind } from "../lib/web-provider.ts";
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

const DEPS = { sidecar: stubSidecar(), maxOutputBytes: 4000, timeoutMs: 30_000 };

describe("toBodyKind", () => {
  it("html 保持 html，markdown 与 text 都降级成 text", () => {
    expect(toBodyKind("html")).toBe("html");
    expect(toBodyKind("markdown")).toBe("text");
    expect(toBodyKind("text")).toBe("text");
    expect(toBodyKind("别的")).toBe("text");
  });
});

describe("available", () => {
  it("sidecar 没起来时不可用", () => {
    expect(createWebFetchProvider(DEPS).available()).toBe(false);
  });

  it("handshake 过且有 scrapling 才可用", () => {
    const provider = createWebFetchProvider(DEPS);
    Object.defineProperty(DEPS.sidecar, "alive", { value: true, configurable: true });
    Object.defineProperty(DEPS.sidecar, "capabilities", {
      value: {
        scrapling: true,
        static: true,
        extract: true,
        browser: false,
        version: "0.5",
      },
      configurable: true,
    });
    expect(provider.available()).toBe(true);
  });

  it("有 scrapling 但 sidecar 已死时不可用", () => {
    Object.defineProperty(DEPS.sidecar, "alive", { value: false, configurable: true });
    expect(createWebFetchProvider(DEPS).available()).toBe(false);
    Object.defineProperty(DEPS.sidecar, "alive", { value: true, configurable: true });
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
    const result = await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({
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
    const result = await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
    expect(result.truncated).toBe(true);
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
    const result = await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
    expect(Buffer.byteLength(result.body.content, "utf8")).toBeLessThanOrEqual(DEPS.maxOutputBytes);
    expect(result.body.content.length).toBeLessThan(9000);
  });

  it("多字节正文同样按预算收口，不会靠字符数蒙混过去", async () => {
    // 预算这一个数同时是 sidecar 的 maxContentChars（字符）与 capText 的字节预算。
    // 中文一个字三字节，所以 3000 个中文在字节预算下确实超了：收口按字节算，如实标真截断。
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => ({
        url: "u",
        status: 200,
        content: "中".repeat(3000),
        truncated: false,
      }),
    });
    const result = await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body.content, "utf8")).toBeLessThanOrEqual(DEPS.maxOutputBytes);
  });

  it("回包不是对象时抛错，而不是补成一张空白的成功页", async () => {
    // 补成 { statusCode: 0, content: "" } 的话，调用方会把 0 当成真实状态码、把空正文
    // 当成「这个页面本来就没内容」—— 对端协议一坏，结果就是一片看着正常的空结果。
    const client = stubSidecar();
    Object.assign(client, { call: async (): Promise<unknown> => "not an object" });
    let caught: (Error & { code?: string }) | undefined;
    try {
      await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
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
      await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
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
      await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
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
      createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" }),
    ).rejects.toThrow(/malformed/u);
  });

  it("给了 signal 时会一并透传给 sidecar", async () => {
    const client = stubSidecar();
    const seen: { hasSignal: boolean }[] = [];
    Object.assign(client, {
      call: async (_m: string, _p: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> => {
        seen.push({ hasSignal: opts?.signal !== undefined });
        return { url: "u", status: 200, content: "x", truncated: false };
      },
    });
    const provider = createWebFetchProvider({ ...DEPS, sidecar: client });
    await provider.fetch({ url: "u" }, new AbortController().signal);
    await provider.fetch({ url: "u" });
    expect(seen).toStrictEqual([{ hasSignal: true }, { hasSignal: false }]);
  });

  it("sidecar 抛错时包成带 code 的 WebError，并把 sidecar 的码带进消息", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => {
        throw new SidecarError("URL_BLOCKED", "blocked by the host gate");
      },
    });
    const provider = createWebFetchProvider({ ...DEPS, sidecar: client });
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
    // @deepseek-ai/dsh-web 在测试侧与 lib 侧各装一份（纯 node 下同一说明符解析为同一
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
      await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.constructor.name).toBe("WebError");
    expect(caught?.message).toBe("Error: socket hang up");
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
    const provider = createWebFetchProvider({ ...DEPS, sidecar: client });
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
    expect(createWebFetchProvider(DEPS).id).toBe("scrapling");
  });
});
