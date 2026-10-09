// dsh-scrapling/test/web-provider.test.ts —— ctx.web fetch provider。
//
// 重点验两条容易搞错的契约：available() 不得发网络请求（只看 sidecar 本地状态）；
// markdown 必须降级成 text —— dsh-web 的 WebFetchBody 是封闭联合，只有 html/text。

import { describe, expect, it } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import { createWebFetchProvider, PROVIDER_ID, toBodyKind } from "../lib/web-provider.ts";
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
        stealth: false,
        version: "0.4.15",
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

  it("回包缺字段时退回请求的 url，不抛", async () => {
    const client = stubSidecar();
    Object.assign(client, { call: async (): Promise<unknown> => "not an object" });
    const result = await createWebFetchProvider({ ...DEPS, sidecar: client }).fetch({ url: "u" });
    expect(result.url).toBe("u");
    expect(result.statusCode).toBe(0);
    expect(result.body).toStrictEqual({ kind: "text", content: "" });
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

  it("sidecar 抛错时包成带 code 的 WebError", async () => {
    const client = stubSidecar();
    Object.assign(client, {
      call: async (): Promise<unknown> => {
        throw new Error("boom");
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
    expect(caught).toBeInstanceOf(WebError);
    expect(caught?.code).toBe("SCRAPLING_FETCH_FAILED");
    expect(caught?.message).toContain("boom");
  });
});

describe("provider id", () => {
  it("固定为 scrapling（部署配置要按这个名字写）", () => {
    expect(PROVIDER_ID).toBe("scrapling");
    expect(createWebFetchProvider(DEPS).id).toBe("scrapling");
  });
});
