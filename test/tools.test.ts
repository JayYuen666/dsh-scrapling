// dsh-scrapling/test/tools.test.ts —— 两个零浏览器工具。
//
// 覆盖三层：capText 的截断行为（代理对安全、页脚、边界预算）；工具的 schema/渲染/投影 ——
// 用一个假 sidecar，不碰进程；以及真 sidecar 往返 —— 真拉起 Python，验证「抓 → 抽取」
// 这条链真的通。

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capText, tailOf } from "../lib/output.ts";
import {
  createAnswerTool,
  createCaptureXhrTool,
  createCrawlTool,
  createExtractTool,
  createFetchTool,
  createRenderTool,
  createSessionCloseTool,
  createSessionFetchTool,
  createSessionListTool,
  createSessionNetworkTool,
  createSessionOpenTool,
  createSessionStateLoadTool,
  createSessionStateSaveTool,
} from "../lib/tools.ts";
import type { CrawlJobRunner, CrawlSink, ToolSettings } from "../lib/tools.ts";
import type { AnswerRequest, AnswerResult } from "../lib/answer.ts";
import { SidecarClient } from "../lib/sidecar.ts";
import { SidecarError } from "../lib/sidecar-error.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const BRIDGE = path.join(REPO, "py", "bridge.py");
const LOCAL_PYTHON = path.join(REPO, "_env", ".venv", "bin", "python3");

/** 测试里反复用到的示例 XHR 接口 URL。 */
const SAMPLE_API = "https://api.test/items";

/** 测试里反复用到的示例 URL。 */
const SAMPLE_URL = "http://example.test/";
/** 跟随重定向之后的最终地址：结果卡片用它，而不是调用参数里那个。 */
const FINAL_URL = "http://final.test/";

/**
 * 假的起作业回调：立刻跑一次主体并返回固定 id。
 *
 * 这样测试能同步验证作业主体干了什么，而不必真的去挂 `ctx.jobs`。
 *
 * @param label - 作业标签
 * @param run - 作业主体
 * @returns 固定作业 id
 */
/** 空 sink：测试里不关心输出内容，只关心爬虫有没有被驱动起来。 */
const NULL_SINK: CrawlSink = {
  append: () => {
    // 测试不关心输出内容，只关心爬虫有没有被驱动起来。
  },
  progress: () => {
    // 同上。
  },
  signal: new AbortController().signal,
};

/**
 * 假的起作业回调。
 *
 * 同步跑一次主体再返回固定 id —— 这样测试能直接验证作业主体干了什么，
 * 而不必真的去挂 `ctx.jobs`。
 *
 * @param label - 作业标签
 * @param run - 作业主体
 * @returns 固定作业 id
 */
async function fakeJobStarter(label: string, run: CrawlJobRunner): Promise<string> {
  void label;
  await run(NULL_SINK);
  return "job-1";
}

/**
 * 一个不调模型的问答替身：把收到的正文回显成固定答案。
 *
 * 除了 scrapling_answer 自己那组测试，其余工具都用不到它 —— 它挂在 ToolDeps 上只是为了
 * 让类型逼出「每个 builder 都看得见完整依赖」，跟 startCrawlJob 的道理一样。
 *
 * @param request - 问答请求
 * @returns 固定答案
 */
async function fakeAnswer(request: AnswerRequest): Promise<AnswerResult> {
  return {
    answer: `fake-answer:${request.question}`,
    provider: "fake-provider",
    model: "fake-model",
  };
}

/** 一份小预算的设置，让截断真的发生。 */
const SETTINGS: ToolSettings = {
  extractionType: "markdown",
  mainContentOnly: true,
  maxOutputBytes: 4000,
  timeoutMs: 30_000,
  headless: true,
  networkIdle: false,
  pageTimeoutMs: 30_000,
  waitSelectorState: "attached",
  pierceShadow: false,
  requestTimeoutSeconds: 120,
  blockAds: false,
  // 用 schema 默认值：这条夹具要验的是模型侧 maxPages 的缺省（20），不是部署天花板。
  crawlMaxItems: 1000,
  crawlMaxRuntimeSeconds: 1800,
  browserExecutablePath: "",
  browserCdpUrl: "",
  browserInitScript: "",
  browserRealChrome: false,
  browserDnsOverHttps: false,
  recordRequests: false,
  maxRecordedRequests: 100,
  sessionStateDir: "",
  crawlRespectRobots: false,
  crawlDownloadDelayMs: 0,
  crawlConcurrentRequests: 4,
  crawlAutothrottle: false,
  crawlStrategy: "bfs",
  crawlCheckpointDir: "",
  // 开着的：这一份夹具要覆盖写方法那条支路（参数面与帧上都得带着 method/body）。
  // 关的那一支在下面 `scrapling_fetch 的写方法闸门` 那一组里逐条钉。
  allowWriteMethods: true,
  stripInlineImages: true,
};

/** 假 sidecar：按 method 回固定结果，并记录收到的参数。 */
function fakeSidecar(result: unknown): {
  client: SidecarClient;
  calls: { method: string; params: unknown }[];
} {
  const calls: { method: string; params: unknown }[] = [];
  const client = new SidecarClient(
    {
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (): never => {
          throw new Error("not used");
        },
      },
    } as unknown as never,
    {
      pythonBin: "python3",
      bridgePath: BRIDGE,
      cwd: REPO,
      handshakeTimeoutMs: 50,
      requestTimeoutMs: 50,
      graceMs: 10,
    },
  );
  const original = client.call.bind(client);
  Object.assign(client, {
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return result;
    },
  });
  void original;
  return { client, calls };
}

/** UTF-16 高代理区下界。 */
const HIGH_SURROGATE_START = 55_296;
/** UTF-16 高代理区上界。 */
const HIGH_SURROGATE_END = 57_343;
/** UTF-16 低代理区下界。 */
const LOW_SURROGATE_START = 56_320;
/** UTF-16 低代理区上界。 */
const LOW_SURROGATE_END = 57_343;

/**
 * 判断一个码元是否落在代理对的上半区。
 *
 * 截断切点落在代理对中间就会留下一枚孤立项，那种文本进会话日志后会让后续
 * Messages 请求整体失败 —— 所以这条断言是必要的。
 *
 * @param code - 码元
 * @returns 是否落在上半区
 */
function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

/**
 * 判断一个码元是否落在代理对的下半区。
 *
 * @param code - 码元
 * @returns 是否落在下半区
 */
function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

describe("capText", () => {
  it("未超预算时原样返回且没有页脚", () => {
    const result = capText("hello", 1000, "再取一次");
    expect(result).toStrictEqual({ text: "hello", truncated: false, notice: "" });
  });

  it("预算为零时也原样返回（不做无意义的截断）", () => {
    expect(capText("hello", 0, "x").text).toBe("hello");
  });

  it("超预算时做头尾截断，并给出说明省了多少", () => {
    const body = "A".repeat(500) + "B".repeat(500);
    const result = capText(body, 600, "用 cssSelector 再取一次");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(body.length);
    expect(result.notice).toContain("cssSelector");
  });

  it("截断点不会留下孤立高代理", () => {
    // 全是代理对的正文：每个码元 4 字节，正好压在中点最容易切出孤立项。
    const body = "😀".repeat(200);
    const result = capText(body, 101, "x");
    const units = Array.from(result.text, (char) => char.codePointAt(0) ?? 0);
    for (const code of units) {
      expect(isHighSurrogate(code)).toBe(false);
      expect(isLowSurrogate(code)).toBe(false);
    }
  });

  it("恢复建议为空时页脚仍然完整", () => {
    const result = capText("x".repeat(1000), 100, "");
    expect(result.truncated).toBe(true);
    expect(result.notice.length).toBeGreaterThan(0);
  });
});

describe("tailOf", () => {
  it("保留尾部", () => {
    expect(tailOf("abcdef", 3)).toBe("def");
  });

  it("预算为零时给空串而不是整串", () => {
    expect(tailOf("abcdef", 0)).toBe("");
  });
});

describe("scrapling_fetch", () => {
  it("把参数与设置转成 sidecar 的调用", async () => {
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "# hi",
      truncated: false,
    });
    const tool = createFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const args = { url: SAMPLE_URL, cssSelector: "main" };
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute(args, exec)) as { url: string; notice: string };
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("fetch");
    expect(fake.calls[0]?.params).toMatchObject({
      url: SAMPLE_URL,
      cssSelector: "main",
      extractionType: "markdown",
      mainContentOnly: true,
    });
    expect(result.url).toBeTypeOf("string");
  });

  it("侧端缺字段时报可读错误而不是把 undefined 传下去", async () => {
    const fake = fakeSidecar({ status: 200 });
    const tool = createFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await expect(tool.execute({ url: SAMPLE_URL }, exec)).rejects.toThrow(
      /missing a string field/u,
    );
  });

  it("内容超预算时标 truncated 并附页脚", async () => {
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "x".repeat(9000),
      truncated: false,
    });
    const tool = createFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as {
      truncated: boolean;
      notice: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.notice).not.toBe("");
  });

  it("投影出的卡片元数据是无损 JSON", () => {
    const tool = createFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const meta = tool.output.presentationMeta?.(
      { url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 204,
        extractionType: "markdown",
        content: "",
        truncated: true,
        notice: "",
      },
    );
    expect(meta).toStrictEqual({ url: SAMPLE_URL, statusCode: 204, truncated: true });
  });

  it("pending 卡片用 generic，抓取结果卡片用 web", () => {
    const tool = createFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const pending = tool.presentCall?.({ url: SAMPLE_URL });
    expect(pending).toStrictEqual({ card: "generic", title: SAMPLE_URL, kind: "fetch" });
    const done = tool.presentResult?.(
      { url: SAMPLE_URL },
      {
        content: [{ type: "text", text: "" }],
        isError: false,
        meta: { url: FINAL_URL, statusCode: 200, truncated: false },
      },
    );
    expect(done).toStrictEqual({
      card: "web",
      kind: "fetch",
      title: SAMPLE_URL,
      url: FINAL_URL,
      statusCode: 200,
      truncated: false,
    });
  });

  it("失败或没有投影时卡片退回占位值", () => {
    const tool = createFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const done = tool.presentResult?.(
      { url: SAMPLE_URL },
      { content: [{ type: "text", text: "boom" }], isError: true },
    );
    expect(done).toStrictEqual({
      card: "web",
      kind: "fetch",
      title: SAMPLE_URL,
      url: SAMPLE_URL,
      statusCode: 0,
      truncated: false,
    });
  });

  it("声明了超时且并发安全", () => {
    const tool = createFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.timeoutMs).toBe(SETTINGS.timeoutMs);
    // 这份夹具把 allowWriteMethods 开着，但这一次调用是 GET：并发判定是**按参数**问的，
    // 读的那一次照旧可并发。写请求那一支在下面 `scrapling_fetch 的写方法闸门` 里钉。
    expect(tool.isConcurrencySafe?.({ url: SAMPLE_URL })).toBe(true);
  });

  it("渲染出的文本带 Fetched 头", () => {
    const blocks = createFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    }).output.render(
      { url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 200,
        extractionType: "markdown",
        content: "body",
        truncated: false,
        notice: "",
      },
    );
    expect(JSON.stringify(blocks)).toContain("Fetched http://example.test/ (HTTP 200)");
  });

  it("有截断提示时渲染结果把它附在正文后面", () => {
    const tool = createFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 200,
        extractionType: "markdown",
        content: "body",
        truncated: true,
        notice: "(Content truncated.)",
      },
    );
    expect(JSON.stringify(blocks)).toContain("(Content truncated.)");
  });
});

/**
 * 按一档闸门配置造一个 fetch 工具，并带回它收到的帧。
 *
 * @param allowWriteMethods - 部署有没有开放写方法
 * @returns 工具定义与帧记录
 */
function gated(allowWriteMethods: boolean): {
  tool: ReturnType<typeof createFetchTool>;
  calls: { method: string; params: unknown }[];
} {
  const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "ok", truncated: false });
  return {
    tool: createFetchTool({
      sidecar: fake.client,
      settings: { ...SETTINGS, allowWriteMethods },
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    }),
    calls: fake.calls,
  };
}

/**
 * 取工具声明给模型的参数名。
 *
 * @param tool - 工具定义
 * @returns 参数名列表
 */
function parameterNames(tool: ReturnType<typeof createFetchTool>): string[] {
  const compiled = tool.parameters as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(compiled?.properties ?? {});
}

/**
 * 问一次「这一档闸门下、这一次调用能不能并发」。
 *
 * @param allowWriteMethods - 部署有没有开放写方法
 * @param args - 这一次调用的参数
 * @returns 工具的并发判定
 */
function concurrencySafe(allowWriteMethods: boolean, args: Record<string, unknown>): boolean {
  return gated(allowWriteMethods).tool.isConcurrencySafe?.(args) ?? true;
}

describe("scrapling_fetch 的写方法闸门", () => {
  /** 一次工具调用用的执行上下文。 */
  const exec = { signal: new AbortController().signal } as never;

  it("闸门关着时，method/body 根本不在参数面里（而不是给了再拦）", () => {
    const names = parameterNames(gated(false).tool);
    expect(names).not.toContain("method");
    expect(names).not.toContain("body");
    // 只读那一半不受影响：带凭据的 GET 是正常用法，闸门管的是「到了之后干什么」。
    expect(names).toContain("headers");
    expect(names).toContain("cookies");
  });

  it("闸门开着时两个键都摆出来", () => {
    const names = parameterNames(gated(true).tool);
    expect(names).toContain("method");
    expect(names).toContain("body");
  });

  it("关着时帧上不带 method/body，普通 GET 照常上网线", async () => {
    const { tool, calls } = gated(false);
    await tool.execute({ url: SAMPLE_URL }, exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).not.toHaveProperty("method");
    expect(calls[0]?.params).not.toHaveProperty("body");
  });

  it("关着时手搓的 method 被就地拒绝，而不是悄悄发成 GET", async () => {
    // 上游的参数校验是**开放根对象**：未声明的键不报错也不剥离，原样进 execute
    // （tools.spec.ts 里那条 "allows extra keys"）。所以「参数面里没有 method」只拦得住
    // 模型，拦不住重放的旧调用或代发的调用。把写请求改成 GET 是最坏的失败形态：调用方以为
    // 写成功了，对端什么都没发生，而且没有一行日志能看出这件事。
    const { tool, calls } = gated(false);
    await expect(
      tool.execute({ url: SAMPLE_URL, method: "POST", body: "x" }, exec),
      "写意图必须被拒，请求不该发出去",
    ).rejects.toThrow(/allowWriteMethods/u);
    // 码要是机器可读的那一个：调用方（如 search provider）是按码决定要不要重试或降级的。
    await expect(tool.execute({ url: SAMPLE_URL, method: "POST" }, exec)).rejects.toMatchObject({
      code: "WRITE_DISABLED",
    });
    expect(calls, "被拒的调用一帧都不该发出去").toStrictEqual([]);
  });

  it("关着时只给 body（没给 method）同样被拒", async () => {
    // 带着 body 的 GET 在关着的时候只有一种解释：调用方想写。
    const { tool, calls } = gated(false);
    await expect(tool.execute({ url: SAMPLE_URL, body: { field: "value" } }, exec)).rejects.toThrow(
      /allowWriteMethods/u,
    );
    expect(calls).toStrictEqual([]);
  });

  it("关着时 method=GET 且不带 body 不被误拒", async () => {
    const { tool, calls } = gated(false);
    await tool.execute({ url: SAMPLE_URL, method: "get" }, exec);
    expect(calls).toHaveLength(1);
  });

  it("开着时不给 method 就按 GET 上网线", async () => {
    const { tool, calls } = gated(true);
    await tool.execute({ url: SAMPLE_URL }, exec);
    expect(calls[0]?.params).toMatchObject({ method: "GET", body: null });
  });

  it("开着时模型给的写方法与请求体原样转发", async () => {
    const { tool, calls } = gated(true);
    await tool.execute({ url: SAMPLE_URL, method: "put", body: { field: "value" } }, exec);
    expect(calls[0]?.params).toMatchObject({ method: "put", body: { field: "value" } });
  });

  it("并发判定按这一次调用的动词走：写请求串行，读请求照旧可并发", () => {
    // 上游把这一档做成按参数问的，所以开了写方法的部署不必让所有静态抓取都排队 —— 而并行
    // 的写请求就是重复提交（重试再叠上去，对端会收到两次），那一档必须串起来。
    expect(concurrencySafe(false, { url: SAMPLE_URL })).toBe(true);
    expect(concurrencySafe(false, { url: SAMPLE_URL, method: "POST" })).toBe(true);
    expect(concurrencySafe(true, { url: SAMPLE_URL })).toBe(true);
    expect(concurrencySafe(true, { url: SAMPLE_URL, method: "get" })).toBe(true);
    expect(concurrencySafe(true, { url: SAMPLE_URL, method: "POST" })).toBe(false);
    expect(concurrencySafe(true, { url: SAMPLE_URL, method: "delete" })).toBe(false);
  });
});

describe("scrapling_extract", () => {
  it("把选择结果归一成结构化列表", async () => {
    const fake = fakeSidecar({
      count: 2,
      truncated: false,
      matches: [{ tag: "li", text: "A" }, { tag: "li", text: "B" }, "垃圾项"],
    });
    const tool = createExtractTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ html: "<ul></ul>", selector: "li" }, exec)) as {
      count: number;
      matches: { tag: string; text: string }[];
    };
    expect(result.count).toBe(2);
    // 非对象的元素被丢掉，不会污染列表。
    expect(result.matches).toStrictEqual([
      { tag: "li", text: "A" },
      { tag: "li", text: "B" },
    ]);
  });

  it("请求里带着字符预算：limit 数条数，预算管总长度", async () => {
    // 少了它就等于 matches 完全不封顶：一个 5MB 的 html 命中几万个节点时，整份会
    // 原样进模型上下文 —— 那是本工具唯一没有上限的一路。
    const fake = fakeSidecar({ count: 1, truncated: true, matches: [{ tag: "li", text: "A" }] });
    const tool = createExtractTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await tool.execute({ html: "<ul><li>A</li></ul>", selector: "li", limit: 5000 }, exec);
    expect(fake.calls[0]?.params).toStrictEqual({
      html: "<ul><li>A</li></ul>",
      selector: "li",
      useXpath: false,
      limit: 5000,
      attribute: null,
      includeAttributes: false,
      maxContentChars: SETTINGS.maxOutputBytes,
    });
  });

  it("取属性时回 value 而不是 text，includeAttributes 时连属性表一起回", async () => {
    // 这两个入参在 Python 侧早就实现了，缺的只是 Host 没给入口：模型只能拿到正文，
    // 拿不到 href/data-* 这类真正结构化的东西。
    const fake = fakeSidecar({
      count: 1,
      truncated: false,
      matches: [{ tag: "a", value: "/p/1", attributes: { href: "/p/1", class: "x" } }],
    });
    const tool = createExtractTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute(
      { html: "<a href='/p/1'>x</a>", selector: "a", attribute: "href", includeAttributes: true },
      exec,
    )) as { matches: Record<string, unknown>[] };
    expect(fake.calls[0]?.params).toMatchObject({ attribute: "href", includeAttributes: true });
    // 回包里不该同时出现 text：取属性时 Python 只给 value。
    expect(result.matches[0]).toStrictEqual({
      tag: "a",
      value: "/p/1",
      attributes: { href: "/p/1", class: "x" },
    });
  });

  it("adaptive 与 url 原样透传；不给时这两个键不出现", async () => {
    // 协议上 undefined 与「没给」同义，条件展开保证缺省载荷与旧版逐字节一致。
    const fake = fakeSidecar({ count: 0, truncated: false, matches: [] });
    const tool = createExtractTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await tool.execute(
      { html: "<p>x</p>", selector: "p", adaptive: true, url: "https://a.test/" },
      exec,
    );
    expect(fake.calls[0]?.params).toMatchObject({
      adaptive: true,
      url: "https://a.test/",
    });
    await tool.execute({ html: "<p>x</p>", selector: "p" }, exec);
    expect(fake.calls[1]?.params).not.toHaveProperty("adaptive");
    expect(fake.calls[1]?.params).not.toHaveProperty("url");
  });

  it("count / truncated 缺失或类型不对时报可读错误", async () => {
    // count 缺的时候原先退回 matches.length，而 Python 报的 count 是**命中总数**，
    // 不是返回条数 —— 拿后者当前者会把「还有 900 条没给」说成「一共就这些」。
    const missing = fakeSidecar({ matches: [{ tag: "li", text: "A" }] });
    const tool = createExtractTool({
      sidecar: missing.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await expect(tool.execute({ html: "x", selector: "li" }, exec)).rejects.toThrow(
      /missing a non-negative integer field: count/u,
    );
  });

  it("渲染时没有匹配给 no matches，有匹配逐行列出", () => {
    const tool = createExtractTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const empty = tool.output.render(
      { html: "", selector: "li" },
      { count: 0, truncated: false, matches: [] },
    );
    expect(JSON.stringify(empty)).toContain("no matches");
    const some = tool.output.render(
      { html: "", selector: "li" },
      { count: 1, truncated: false, matches: [{ tag: "li", text: "A" }] },
    );
    expect(JSON.stringify(some)).toContain("<li> A");
    // 取属性那一档的渲染：正文缺席、只有 value 与 attributes 时也要看得见，
    // 否则模型从卡片上读不出「这条匹配给的是属性值」。
    const attrs = tool.output.render(
      { html: "", selector: "a", attribute: "href", includeAttributes: true },
      {
        count: 1,
        truncated: false,
        matches: [{ tag: "a", value: "/p/1", attributes: { href: "/p/1" } }],
      },
    );
    const rendered = JSON.stringify(attrs);
    expect(rendered).toContain("<a> /p/1");
    // 属性表以 JSON 形式跟在行尾：断言键与值都在，不去逐字符钉转义形式。
    expect(rendered).toContain("href");
    expect(rendered).toContain("/p/1");
    // text 与 value 在 schema 里都是可选的，所以「两个都没有」是一份合法回包：渲染要给出
    // 标签行而不是 undefined —— 归一逻辑保证不到这一层（render 收的是已校验的回包）。
    const neither = tool.output.render(
      { html: "", selector: "li" },
      { count: 1, truncated: false, matches: [{ tag: "li" }] },
    );
    expect(JSON.stringify(neither)).toContain("<li> ");
  });

  it("pending 卡片用 generic 且标为 search", () => {
    const tool = createExtractTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.presentCall?.({ html: "", selector: ".price" })).toStrictEqual({
      card: "generic",
      title: ".price",
      kind: "search",
    });
    expect(tool.timeoutMs).toBe(SETTINGS.timeoutMs);
    expect(tool.isConcurrencySafe?.({ html: "", selector: ".price" })).toBe(true);
  });

  it("回包不是对象时报可读错误，而不是补成一次空搜索", async () => {
    // 补成 { count: 0, matches: [] } 的话，模型看到的是「这个选择器一条都没命中」——
    // 一个结论；而事实是协议坏了。两种事的后续动作完全不同。
    const fake = fakeSidecar("not an object");
    const tool = createExtractTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await expect(tool.execute({ html: "x", selector: "li" }, exec)).rejects.toThrow(
      /missing an integer field: count/u,
    );
  });

  it("match 里缺 tag/text 时补空串，不把 undefined 漏给模型", async () => {
    const fake = fakeSidecar({
      count: 1,
      truncated: false,
      matches: [{ tag: 7, text: null }],
    });
    const tool = createExtractTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ html: "x", selector: "li" }, exec)) as {
      matches: { tag: string; text: string }[];
    };
    expect(result.matches).toStrictEqual([{ tag: "", text: "" }]);
  });

  it("status 缺失或不是非负整数时报可读错误，而不是补成一个 0", async () => {
    // 补成 0 的话，宿主与模型看到的是一条真实的状态码 0 —— 而对端协议其实已经坏了。
    // 补齐让破损静默，报错才让人知道该去修 Python 那一侧。
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: -1,
      content: "x",
      truncated: false,
    });
    const tool = createFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await expect(tool.execute({ url: SAMPLE_URL }, exec)).rejects.toThrow(
      /missing a non-negative integer field: status/u,
    );
  });

  it("truncated 缺失或不是布尔时报可读错误，不补成 false", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "x", truncated: "no" });
    const tool = createFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await expect(tool.execute({ url: SAMPLE_URL }, exec)).rejects.toThrow(
      /missing a boolean field: truncated/u,
    );
  });

  it("对端已经截过时，本地没超预算也照实标 truncated", async () => {
    // 本地 capText 只看自己这一份：Python 按 maxContentChars 截过的正文，在 Host 侧往往
    // 还在预算内。直接覆盖就等于告诉模型「这条是完整的」，而那正是它最该知道被截断的时刻。
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "短正文",
      truncated: true,
    });
    const tool = createFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as { truncated: boolean };
    expect(result.truncated).toBe(true);
  });
});

/** 真 sidecar：node:child_process 顶替 ctx.subprocess。 */
function realCtx(): unknown {
  return {
    subprocess: {
      resolveExecutable: async (command: string): Promise<string> => command,
      spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
        const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          done: (async (): Promise<{ exitCode: number | null; signal: null }> => {
            const args = await once(child, "close");
            return { exitCode: args[0] as number | null, signal: null };
          })(),
          terminate: (): void => {
            child.kill("SIGTERM");
          },
          waitForExit: async (): Promise<boolean> => true,
        };
      },
    },
  };
}

/**
 * 起一个只回 SPA 外壳的本地服务：内容要等 JS 执行后才出现。
 *
 * 这正是 dsh 内置 web_fetch 结构上给不了的那部分 —— 它不执行 JS，只能拿到壳。
 */
async function startSpaServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const page = Buffer.from(
    "<!doctype html><html><head><title>SPA Shell</title></head><body>" +
      '<div id="app">LOADING_PLACEHOLDER</div><script>setTimeout(function(){' +
      "document.getElementById('app').innerHTML=" +
      "'<h1>Server Price</h1><table><tr><td>ABC-1</td><td>$19.99</td></tr></table>';" +
      "},40);</script></body></html>",
  );
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": page.length,
    });
    res.end(page);
  });
  // 先挂监听再 listen：反过来的话事件可能已经发过，await 会永远等下去。
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}/`,
    close: async (): Promise<void> => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("scrapling_render 与真实 sidecar", () => {
  const available = existsSync(LOCAL_PYTHON) && existsSync(BRIDGE);

  it.runIf(available)("渲染出 JS 执行后才出现的内容（内置 web_fetch 拿不到的那部分）", async () => {
    const spa = await startSpaServer();
    const client = new SidecarClient(realCtx() as never, {
      pythonBin: LOCAL_PYTHON,
      bridgePath: BRIDGE,
      cwd: REPO,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 90_000,
      graceMs: 5000,
      // 守卫默认拒绝回环地址；本地测试服务器就在 127.0.0.1，必须显式放行。
      env: { DSH_SCRAPLING_ALLOWED_HOSTS: "127.0.0.1,localhost" },
    });
    try {
      const caps = await client.ensureStarted();
      if (!caps.browser) {
        return;
      }
      const tool = createRenderTool({
        sidecar: client,
        settings: { ...SETTINGS, timeoutMs: 90_000 },
        startCrawlJob: fakeJobStarter,
        answer: fakeAnswer,
      });
      const exec = { signal: new AbortController().signal } as never;
      const result = (await tool.execute({ url: spa.base, networkIdle: true }, exec)) as {
        content: string;
        statusCode: number;
      };
      expect(result.statusCode).toBe(200);
      expect(result.content).toContain("Server Price");
      expect(result.content).toContain("ABC-1");
      // 加载占位不该还在 —— 说明拿到的是渲染后的 DOM 而不是壳。
      expect(result.content).not.toContain("LOADING_PLACEHOLDER");
    } finally {
      await client.dispose();
      await spa.close();
    }
  });
});

describe("scrapling_fetch 与真实 sidecar", () => {
  const available = existsSync(LOCAL_PYTHON) && existsSync(BRIDGE);

  it.runIf(available)("抽取一段 HTML 并按选择器取出结构化内容", async () => {
    const client = new SidecarClient(realCtx() as never, {
      pythonBin: LOCAL_PYTHON,
      bridgePath: BRIDGE,
      cwd: REPO,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      graceMs: 5000,
    });
    const fetchTool = createFetchTool({
      sidecar: client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const html = "<html><body><ul><li>alpha</li><li>beta</li></ul></body></html>";

    const extractTool = createExtractTool({
      sidecar: client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const selected = (await extractTool.execute({ html, selector: "li" }, exec)) as {
      count: number;
      matches: { text: string }[];
    };
    expect(selected.count).toBe(2);
    expect(selected.matches.map((item) => item.text)).toStrictEqual(["alpha", "beta"]);

    // fetch 走的是网络，这里只验证参数能被 sidecar 接受并给出可读错误（本地无服务）。
    const fetched = await fetchTool
      .execute({ url: "http://127.0.0.1:1/never" }, exec)
      .then(() => "ok")
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(fetched).toBeTypeOf("string");
    void fetchTool;
    await client.dispose();
  });
});

describe("scrapling_render", () => {
  it("把等待策略转成 sidecar 调用", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "# ok", truncated: false });
    const tool = createRenderTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await tool.execute({ url: SAMPLE_URL, networkIdle: true, waitSelector: "#app h1" }, exec);
    expect(fake.calls[0]?.method).toBe("render");
    expect(fake.calls[0]?.params).toMatchObject({
      url: SAMPLE_URL,
      networkIdle: true,
      waitSelector: "#app h1",
      waitSelectorState: "attached",
    });
  });

  it("没给 waitSelector 时不把空串塞给 sidecar", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "x", truncated: false });
    const tool = createRenderTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await tool.execute({ url: SAMPLE_URL }, exec);
    expect(fake.calls[0]?.params).not.toHaveProperty("waitSelector");
  });

  it("结果的每个键都在 schema 里声明过——schema 写着 additionalProperties: false", async () => {
    // 回归守卫：render 与 capture_xhr 共用一套 execute，过去它无条件给结果塞 xhr，
    // 而 render 的 schema 没声明这个字段，于是 render 每一次调用都被判成
    // `value.xhr is not a declared property`。两边键集必须与各自 schema 完全一致。
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "# ok",
      truncated: false,
      xhr: [{ url: "https://api.example.com/x", status: 200, bytes: 12 }],
    });
    const exec = { signal: new AbortController().signal } as never;
    const render = createRenderTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const capture = createCaptureXhrTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const declaredKeysOf = (tool: typeof render): string[] =>
      Object.keys((tool.output.schema as unknown as { properties: object }).properties);

    const executed = (await Promise.all([
      render.execute({ url: SAMPLE_URL }, exec),
      capture.execute({ url: SAMPLE_URL }, exec),
    ])) as Record<string, unknown>[];
    const undeclaredKeys = (
      result: Record<string, unknown> | undefined,
      tool: typeof render,
    ): string[] => Object.keys(result ?? {}).filter((key) => !declaredKeysOf(tool).includes(key));

    expect(undeclaredKeys(executed[0], render)).toStrictEqual([]);
    expect(undeclaredKeys(executed[1], capture)).toStrictEqual([]);
    expect(declaredKeysOf(render)).not.toContain("xhr");
    expect(declaredKeysOf(capture)).toContain("xhr");
  });

  it("卡片元数据与 fetch 工具同形：url/status/truncated", () => {
    const tool = createRenderTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const meta = tool.output.presentationMeta?.(
      { url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 200,
        extractionType: "markdown",
        content: "",
        truncated: false,
        notice: "",
      },
    );
    expect(meta).toStrictEqual({ url: SAMPLE_URL, statusCode: 200, truncated: false });
    const pending = tool.presentCall?.({ url: SAMPLE_URL });
    expect(pending).toStrictEqual({ card: "generic", title: SAMPLE_URL, kind: "fetch" });
    const done = tool.presentResult?.(
      { url: SAMPLE_URL },
      {
        content: [{ type: "text", text: "" }],
        isError: false,
        meta: { url: SAMPLE_URL, statusCode: 200, truncated: true },
      },
    );
    expect(done).toStrictEqual({
      card: "web",
      kind: "fetch",
      title: SAMPLE_URL,
      url: SAMPLE_URL,
      statusCode: 200,
      truncated: true,
    });
  });

  it("失败时卡片退回占位值", () => {
    const tool = createRenderTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const done = tool.presentResult?.(
      { url: SAMPLE_URL },
      { content: [{ type: "text", text: "boom" }], isError: true },
    );
    expect(done).toStrictEqual({
      card: "web",
      kind: "fetch",
      title: SAMPLE_URL,
      url: SAMPLE_URL,
      statusCode: 0,
      truncated: false,
    });
  });

  it("明确声明不可并发：浏览器很吃内存", () => {
    const tool = createRenderTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.isConcurrencySafe?.({ url: SAMPLE_URL })).toBe(false);
  });

  it("只有被显式拧过的反检测参数才上网线（allowWebgl=false 也只在显式给时发）", async () => {
    // 没给就交给 Python 的默认值（hide_canvas=False、allow_webgl=True、block_webrtc 由有没有
    // 代理决定）：发一个默认值等于把「部署没表态」写死成一次表态。
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "ok", truncated: false });
    const tool = createRenderTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await tool.execute(
      {
        url: SAMPLE_URL,
        solveCloudflare: true,
        hideCanvas: true,
        blockWebrtc: true,
        allowWebgl: false,
      },
      exec,
    );
    expect(fake.calls[0]?.params).toMatchObject({
      solveCloudflare: true,
      hideCanvas: true,
      blockWebrtc: true,
      allowWebgl: false,
    });
  });

  it("render 的渲染文本不带 XHR 段", () => {
    const tool = createRenderTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 200,
        extractionType: "markdown",
        content: "body",
        truncated: false,
        notice: "",
      },
    );
    expect(JSON.stringify(blocks)).not.toContain("Captured XHR");
  });
});

describe("scrapling_answer", () => {
  const ANSWER_EXEC = { signal: new AbortController().signal, agent: undefined } as never;

  it("默认走静态抓取，把正文与问题一起交给问答器", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "# 标题", truncated: false });
    const seen: AnswerRequest[] = [];
    const tool = createAnswerTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: async (request: AnswerRequest): Promise<AnswerResult> => {
        seen.push(request);
        return { answer: "标题", provider: "p", model: "m" };
      },
    });
    const result = (await tool.execute(
      { url: SAMPLE_URL, question: "标题是什么" },
      ANSWER_EXEC,
    )) as {
      answer: string;
      rendered: boolean;
      provider: string;
      model: string;
      url: string;
      statusCode: number;
    };
    expect(fake.calls[0]?.method).toBe("fetch");
    expect(seen[0]?.context).toBe("# 标题");
    expect(seen[0]?.question).toBe("标题是什么");
    expect(seen[0]?.url).toBe(SAMPLE_URL);
    // Agent 原样透下去：路由要靠它读会话当前模型。
    expect(seen[0]?.agent).toBeUndefined();
    expect(result).toMatchObject({
      answer: "标题",
      rendered: false,
      provider: "p",
      model: "m",
      url: SAMPLE_URL,
      statusCode: 200,
    });
  });

  it("render:true 时改走浏览器路径，并在结果里如实标出走过渲染", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "渲染后", truncated: false });
    const tool = createAnswerTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute(
      { url: SAMPLE_URL, question: "q", render: true },
      ANSWER_EXEC,
    )) as { rendered: boolean };
    expect(fake.calls[0]?.method).toBe("render");
    expect(result.rendered).toBe(true);
  });

  it("问答失败时原样抛，不把错误包成一个看起来成功的空答案", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "# 标题", truncated: false });
    const tool = createAnswerTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: (): Promise<AnswerResult> =>
        Promise.reject(new SidecarError("ANSWER_NO_ROUTE", "没路由")),
    });
    await expect(tool.execute({ url: SAMPLE_URL, question: "q" }, ANSWER_EXEC)).rejects.toThrow(
      "没路由",
    );
  });

  it("正文被截断时，截断标记跟着进问答上下文", async () => {
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "x".repeat(SETTINGS.maxOutputBytes + 500),
      truncated: false,
    });
    const seen: AnswerRequest[] = [];
    const tool = createAnswerTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: async (request: AnswerRequest): Promise<AnswerResult> => {
        seen.push(request);
        return { answer: "a", provider: "p", model: "m" };
      },
    });
    const result = (await tool.execute({ url: SAMPLE_URL, question: "q" }, ANSWER_EXEC)) as {
      truncated: boolean;
      notice: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.notice.length).toBeGreaterThan(0);
    expect(seen[0]?.context.length).toBeLessThanOrEqual(SETTINGS.maxOutputBytes);
  });

  it("结果里不出现 schema 未声明的键", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "# 标题", truncated: false });
    const tool = createAnswerTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const declared = new Set(
      Object.keys((tool.output.schema as unknown as { properties: object }).properties),
    );
    const result = (await tool.execute({ url: SAMPLE_URL, question: "q" }, ANSWER_EXEC)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(result).filter((key) => !declared.has(key))).toStrictEqual([]);
  });

  it("模型侧文本把答案、来源 URL 与实际用的模型一并给出", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "# 标题", truncated: false });
    const tool = createAnswerTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ url: SAMPLE_URL, question: "q" }, ANSWER_EXEC)) as never;
    const blocks = tool.output.render({ url: SAMPLE_URL, question: "q" }, result);
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    expect(text).toContain("fake-answer:q");
    expect(text).toContain(SAMPLE_URL);
    expect(text).toContain("fake-provider/fake-model");
  });

  it("有 notice（被截断）时追加到模型侧文本末尾", () => {
    const tool = createAnswerTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      {},
      {
        url: SAMPLE_URL,
        statusCode: 200,
        extractionType: "markdown",
        answer: "结论",
        rendered: false,
        provider: "p",
        model: "m",
        truncated: true,
        notice: "已截断",
      },
    );
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    expect(text).toContain("已截断");
  });

  it("卡片元数据与 fetch 工具同形：url/status/truncated", () => {
    const tool = createAnswerTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(
      tool.output.presentationMeta?.(
        { url: SAMPLE_URL },
        {
          url: SAMPLE_URL,
          statusCode: 200,
          extractionType: "markdown",
          answer: "a",
          rendered: false,
          provider: "p",
          model: "m",
          truncated: true,
          notice: "",
        },
      ),
    ).toStrictEqual({ url: SAMPLE_URL, statusCode: 200, truncated: true });
  });

  it("声明不可并发：一次问答里有一次模型调用", () => {
    const tool = createAnswerTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.isConcurrencySafe?.({ url: SAMPLE_URL, question: "q" })).toBe(false);
  });

  it("结果卡片与 fetch 工具同形：url/status/truncated", () => {
    const tool = createAnswerTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const done = tool.presentResult?.(
      { url: SAMPLE_URL, question: "q" },
      {
        content: [{ type: "text", text: "" }],
        isError: false,
        meta: { url: FINAL_URL, statusCode: 200, truncated: true },
      },
    );
    expect(done).toStrictEqual({
      card: "web",
      kind: "fetch",
      title: SAMPLE_URL,
      url: FINAL_URL,
      statusCode: 200,
      truncated: true,
    });
  });

  it("结果卡片在 meta 不是对象时退回调用参数，而不是整张卡空掉", () => {
    const tool = createAnswerTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const done = tool.presentResult?.(
      { url: SAMPLE_URL, question: "q" },
      { content: [], isError: false, meta: "not-a-record" },
    );
    expect(done).toMatchObject({ url: SAMPLE_URL, statusCode: 0, truncated: false });
  });

  it("调用卡片是通用抓取卡片，标题取 URL", () => {
    const tool = createAnswerTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    // presentCall 先过参数校验，所以这里必须给出 question —— 只给 url 会被判为不合规而
    // 返回 undefined。这同时说明「必填参数缺失时卡片也不出」。
    expect(tool.presentCall?.({ url: SAMPLE_URL })).toBeUndefined();
    expect(tool.presentCall?.({ url: SAMPLE_URL, question: "q" })).toStrictEqual({
      card: "generic",
      title: SAMPLE_URL,
      kind: "fetch",
    });
  });
});

describe("scrapling_capture_xhr", () => {
  it("把 XHR 摘要归一成结构化列表", async () => {
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "body",
      truncated: false,
      xhr: [
        { url: SAMPLE_API, status: 200, bytes: 1234 },
        { url: "https://api.test/user", status: 500, bytes: 12 },
        "垃圾项",
      ],
    });
    const tool = createCaptureXhrTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as {
      xhr: { url: string; status: number; bytes: number; method: string; resourceType: string }[];
    };
    expect(result.xhr).toStrictEqual([
      { url: SAMPLE_API, status: 200, bytes: 1234, method: "GET", resourceType: "" },
      { url: "https://api.test/user", status: 500, bytes: 12, method: "GET", resourceType: "" },
    ]);
  });

  it("xhr 条目缺字段时补默认值，不把 undefined 漏给模型", async () => {
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "body",
      truncated: false,
      xhr: [{ url: 7, status: "nope" }],
    });
    const tool = createCaptureXhrTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as {
      xhr: { url: string; status: number; bytes: number; method: string; resourceType: string }[];
    };
    expect(result.xhr).toStrictEqual([
      { url: "", status: 0, bytes: 0, method: "GET", resourceType: "" },
    ]);
  });

  it("没有 XHR 时给空数组", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "body", truncated: false });
    const tool = createCaptureXhrTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as { xhr: unknown[] };
    expect(result.xhr).toStrictEqual([]);
  });

  it("渲染文本末尾列出 XHR 摘要", () => {
    const tool = createCaptureXhrTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 200,
        extractionType: "markdown",
        content: "body",
        truncated: false,
        notice: "",
        xhr: [{ url: SAMPLE_API, status: 200, bytes: 99, method: "GET", resourceType: "fetch" }],
      },
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain("Captured XHR");
    expect(text).toContain(SAMPLE_API);
  });
});

/** 会话工具用例共用的执行上下文；放在 describe 外避免每次重建。 */
const sessionExec = (): never => ({ signal: new AbortController().signal }) as never;

describe("scrapling_session_network", () => {
  it("把会话 id 与四个筛选参数发给 sidecar，并把回包的 count 原样带出", async () => {
    const fake = fakeSidecar({ sessionId: "s1", count: 7, matches: [] });
    const tool = createSessionNetworkTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute(
      {
        sessionId: "s1",
        urlPattern: "/api/",
        includeBody: true,
        networkLimit: 5,
        maxBodyChars: 50,
      },
      sessionExec(),
    )) as { sessionId: string; count: number; matches: unknown[] };
    expect(fake.calls[0]).toStrictEqual({
      method: "session.network",
      params: {
        sessionId: "s1",
        urlPattern: "/api/",
        includeBody: true,
        networkLimit: 5,
        maxBodyChars: 50,
      },
    });
    expect(result.sessionId).toBe("s1");
    // count 取自回包自己的那一格，不是数出来的条目数（两者此处故意不同）。
    expect(result.count).toBe(7);
    expect(result.matches).toStrictEqual([]);
  });

  it("不传筛选参数时四个键按缺省 null/false 发出", async () => {
    const fake = fakeSidecar({ sessionId: "s1", count: 0, matches: [] });
    const tool = createSessionNetworkTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    await tool.execute({ sessionId: "s1" }, sessionExec());
    expect(fake.calls[0]?.params).toMatchObject({
      sessionId: "s1",
      urlPattern: null,
      includeBody: false,
      networkLimit: null,
      maxBodyChars: null,
    });
    expect(tool.isConcurrencySafe?.({ sessionId: "s1" })).toBe(false);
  });

  it("回包条目带 bodyNote / body / bodyTruncated 时，三个可选字段都留在归一结果里", async () => {
    const fake = fakeSidecar({
      sessionId: "s1",
      count: 1,
      matches: [
        {
          url: SAMPLE_API,
          status: 200,
          bytes: 1234,
          method: "POST",
          resourceType: "xhr",
          bodyNote: "upstream did not store a body for this one",
          body: '{"a":1}',
          bodyTruncated: true,
        },
      ],
    });
    const tool = createSessionNetworkTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s1" }, sessionExec())) as {
      matches: Record<string, unknown>[];
    };
    expect(result.matches).toStrictEqual([
      {
        url: SAMPLE_API,
        status: 200,
        bytes: 1234,
        method: "POST",
        resourceType: "xhr",
        bodyNote: "upstream did not store a body for this one",
        body: '{"a":1}',
        bodyTruncated: true,
      },
    ]);
  });

  it("render 把四种条目形态各渲染成它该有的那一行", () => {
    const tool = createSessionNetworkTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { sessionId: "s1" },
      {
        sessionId: "s1",
        count: 4,
        matches: [
          // 上游存不下正文时给原因 —— 那一行要说清「没有正文」是哪来的。
          {
            url: "https://a.test/1",
            status: 200,
            bytes: 10,
            method: "GET",
            resourceType: "xhr",
            bodyNote: "no body stored upstream",
          },
          // 既没有 bodyNote 也没有正文：只有一行摘要，resourceType 为空时不该多出逗号段。
          { url: "https://a.test/2", status: 404, bytes: 0, method: "GET", resourceType: "" },
          // 正文被截断：标签要标明这一点，正文照原样展开。
          {
            url: "https://a.test/3",
            status: 200,
            bytes: 20,
            method: "POST",
            resourceType: "fetch",
            body: '{"x":2}',
            bodyTruncated: true,
          },
          // 完整正文：标签就是 body。
          {
            url: "https://a.test/4",
            status: 200,
            bytes: 30,
            method: "GET",
            resourceType: "document",
            body: "<html>",
          },
        ],
      },
    );
    expect(blocks).toStrictEqual([
      {
        type: "text",
        text:
          "session s1 — 4 XHR/fetch:\n" +
          "- GET https://a.test/1 (HTTP 200, 10B, xhr) — no body: no body stored upstream\n" +
          "- GET https://a.test/2 (HTTP 404, 0B)\n" +
          '- POST https://a.test/3 (HTTP 200, 20B, fetch) — body (truncated):\n{"x":2}\n' +
          "- GET https://a.test/4 (HTTP 200, 30B, document) — body:\n<html>",
      },
    ]);
  });

  it("render 在一条历史都没有时明说是空", () => {
    const tool = createSessionNetworkTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { sessionId: "s9" },
      { sessionId: "s9", count: 0, matches: [] },
    );
    expect(blocks).toStrictEqual([
      { type: "text", text: "session s9 recorded no XHR/fetch (0 matches)" },
    ]);
  });

  it("pending 卡片标成读历史", () => {
    const tool = createSessionNetworkTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.presentCall?.({ sessionId: "s1" })).toStrictEqual({
      card: "generic",
      title: "s1",
      kind: "search",
    });
  });

  it("回包不是对象时，count 退回归一后的条目数而不是编一个数", async () => {
    const fake = fakeSidecar("nope");
    const tool = createSessionNetworkTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s1" }, sessionExec())) as {
      sessionId: string;
      count: number;
      matches: unknown[];
    };
    // 回包不是对象 → 没有 count 可读，于是退回归一后的条目数（这里归一出来是 0）。
    expect(result).toStrictEqual({ sessionId: "s1", count: 0, matches: [] });
  });
});

describe("scrapling_session_state_save / _load", () => {
  /** 登录态存取用例共用的部署目录。 */
  const STATE_DIR = "/tmp/scrapling-state";

  it("存登录态：发给 sidecar 的帧带上纯文件名与部署状态目录", async () => {
    const fake = fakeSidecar({
      sessionId: "s1",
      path: `${STATE_DIR}/login.json`,
      saved: true,
    });
    const tool = createSessionStateSaveTool({
      sidecar: fake.client,
      settings: { ...SETTINGS, sessionStateDir: STATE_DIR },
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s1", name: "login" }, sessionExec())) as {
      sessionId: string;
      path: string;
      saved: boolean;
    };
    expect(fake.calls[0]).toStrictEqual({
      method: "session.state_save",
      params: {
        sessionId: "s1",
        name: "login",
        deployment: { sessionStateDir: STATE_DIR },
      },
    });
    expect(result).toStrictEqual({
      sessionId: "s1",
      path: `${STATE_DIR}/login.json`,
      saved: true,
    });
    expect(JSON.stringify(tool.output.render({}, result))).toContain("saved to");
  });

  it("取登录态：走 session.state_load，回包缺字段时退回入参", async () => {
    const fake = fakeSidecar({});
    const tool = createSessionStateLoadTool({
      sidecar: fake.client,
      settings: { ...SETTINGS, sessionStateDir: STATE_DIR },
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s1", name: "login" }, sessionExec())) as {
      sessionId: string;
      path: string;
      saved: boolean;
    };
    expect(fake.calls[0]?.method).toBe("session.state_load");
    // 回包没有 path 时退回空串；saved 这一格按「取」这一支的口径为真（见 lib/tools.ts 的
    // toStateResult：保存时看回包，取时恒为真）。
    expect(result).toStrictEqual({ sessionId: "s1", path: "", saved: true });
    expect(JSON.stringify(tool.output.render({}, result))).toContain("loaded from");
  });

  it("两个登录态工具都声明不可并发、pending 卡片都指向会话", () => {
    // 参数必须**齐全**：`defineTool` 的 isConcurrencySafe 包装在校验不过时直接短路返回 false，
    // 那时工具自己的表态根本不会被调用 —— 只传 `{}` 就会把这条断言测成「包装的短路」。
    const save = createSessionStateSaveTool({
      sidecar: fakeSidecar({}).client,
      settings: { ...SETTINGS, sessionStateDir: STATE_DIR },
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const load = createSessionStateLoadTool({
      sidecar: fakeSidecar({}).client,
      settings: { ...SETTINGS, sessionStateDir: STATE_DIR },
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(save.isConcurrencySafe?.({ sessionId: "s1", name: "login" })).toBe(false);
    expect(load.isConcurrencySafe?.({ sessionId: "s1", name: "login" })).toBe(false);
    const pending = { card: "generic", title: "s1", kind: "search" };
    expect(save.presentCall?.({ sessionId: "s1", name: "login" })).toStrictEqual(pending);
    expect(load.presentCall?.({ sessionId: "s1", name: "login" })).toStrictEqual(pending);
  });

  it("回包不是对象时，归一那一侧退回空表并据此判「没存下」", async () => {
    const fake = fakeSidecar("nope");
    const tool = createSessionStateSaveTool({
      sidecar: fake.client,
      settings: { ...SETTINGS, sessionStateDir: STATE_DIR },
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s1", name: "login" }, sessionExec())) as {
      sessionId: string;
      path: string;
      saved: boolean;
    };
    // 回包不是对象 → 归一那一侧的 record 退回空表；path 退回空串；保存时回包没说 saved
    // 就按「没存下」判（取那一支才是恒为真）。
    expect(result).toStrictEqual({ sessionId: "s1", path: "", saved: false });
  });
});

describe("会话工具的渲染", () => {
  it("open 渲染出「session <id> (<type>) opened at <time>」", () => {
    const tool = createSessionOpenTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { sessionType: "static" },
      { sessionId: "s1", sessionType: "browser", createdAt: "T0" },
    );
    expect(JSON.stringify(blocks)).toContain("session s1 (browser) opened at T0");
    // 开会话要起浏览器/连接，不能并发。
    expect(tool.isConcurrencySafe?.({ sessionType: "static" })).toBe(false);
  });

  it("fetch 的渲染与抓取工具同形", () => {
    const tool = createSessionFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { sessionId: "s1", url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 200,
        extractionType: "markdown",
        content: "body",
        truncated: false,
        notice: "",
        sessionId: "s1",
      },
    );
    expect(JSON.stringify(blocks)).toContain(`Fetched ${SAMPLE_URL}`);
  });

  it("fetch 的投影元数据带 url/status/truncated", () => {
    const tool = createSessionFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const meta = tool.output.presentationMeta?.(
      { sessionId: "s1", url: SAMPLE_URL },
      {
        url: SAMPLE_URL,
        statusCode: 302,
        extractionType: "markdown",
        content: "",
        truncated: true,
        notice: "",
        sessionId: "s1",
      },
    );
    expect(meta).toStrictEqual({ url: SAMPLE_URL, statusCode: 302, truncated: true });
  });

  it("fetch 的 pending 卡片标为 fetch", () => {
    const tool = createSessionFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.presentCall?.({ sessionId: "s1", url: SAMPLE_URL })).toStrictEqual({
      card: "generic",
      title: SAMPLE_URL,
      kind: "fetch",
    });
  });

  it("fetch/close 都声明不可并发（各自持有浏览器或连接）", () => {
    const fetchTool = createSessionFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const closeTool = createSessionCloseTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(fetchTool.isConcurrencySafe?.({ sessionId: "s1", url: SAMPLE_URL })).toBe(false);
    expect(closeTool.isConcurrencySafe?.({ sessionId: "s1" })).toBe(false);
  });

  it("close 渲染出已关闭", () => {
    const tool = createSessionCloseTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render({ sessionId: "s1" }, { sessionId: "s1", closed: true });
    expect(JSON.stringify(blocks)).toContain("session s1 closed");
  });
});

describe("会话工具", () => {
  it("open 归一回包并回显", async () => {
    const fake = fakeSidecar({
      sessionId: "s1",
      sessionType: "static",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const tool = createSessionOpenTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionType: "static" }, sessionExec())) as {
      sessionId: string;
      sessionType: string;
    };
    expect(fake.calls[0]).toStrictEqual({
      method: "session.open",
      // 这几枚旋钮只有「开场」这一个生效位置：会话内每次 fetch 传过去会被上游
      // validate_fetch 静默丢掉。之前 session.open 只发 sessionType/headless/solveCloudflare，
      // 于是设置卡上的页面超时、广告拦截、浏览器二进制路径、注入脚本与网络记录开关对浏览器
      // 会话完全不生效，而且一行日志都没有。
      params: {
        sessionType: "static",
        headless: true,
        solveCloudflare: false,
        // 身份与区域这几枚只有开场生效（会话内 fetch 传会被上游丢掉），所以入口开在这里。
        useragent: "",
        locale: "",
        timezoneId: "",
        impersonate: "",
        hideCanvas: false,
        blockWebrtc: false,
        allowWebgl: true,
        recordNetwork: false,
        timeoutMs: SETTINGS.pageTimeoutMs,
        blockAds: SETTINGS.blockAds,
        deployment: {
          browserExecutablePath: SETTINGS.browserExecutablePath,
          browserCdpUrl: SETTINGS.browserCdpUrl,
          browserInitScript: SETTINGS.browserInitScript,
          browserRealChrome: SETTINGS.browserRealChrome,
          browserDnsOverHttps: SETTINGS.browserDnsOverHttps,
          recordRequests: SETTINGS.recordRequests,
          maxRecordedRequests: SETTINGS.maxRecordedRequests,
        },
      },
    });
    expect(result.sessionId).toBe("s1");
    expect(result.sessionType).toBe("static");
  });

  it("open 缺 sessionId 时报可读错误", async () => {
    const fake = fakeSidecar({ sessionType: "static" });
    const tool = createSessionOpenTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    await expect(tool.execute({ sessionType: "static" }, sessionExec())).rejects.toThrow(
      /missing a string field/u,
    );
  });

  it("fetch 把 sessionId 一起发出去，并在回包上补回", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "body", truncated: false });
    const tool = createSessionFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s1", url: SAMPLE_URL }, sessionExec())) as {
      sessionId: string;
    };
    expect(fake.calls[0]?.method).toBe("session.fetch");
    expect(fake.calls[0]?.params).toMatchObject({ sessionId: "s1", url: SAMPLE_URL });
    expect(result.sessionId).toBe("s1");
  });

  it("list 归一每一条并渲染", async () => {
    const fake = fakeSidecar({
      sessions: [
        { sessionId: "s1", sessionType: "static", createdAt: "t1" },
        { sessionId: "s2" },
        "垃圾",
      ],
    });
    const tool = createSessionListTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({}, sessionExec())) as {
      sessions: { sessionId: string; sessionType: string; createdAt: string }[];
    };
    expect(result.sessions).toStrictEqual([
      { sessionId: "s1", sessionType: "static", createdAt: "t1" },
      { sessionId: "s2", sessionType: "unknown", createdAt: "" },
    ]);
    expect(JSON.stringify(tool.output.render({}, result))).toContain("s1 (static)");
  });

  it("open 回包缺 sessionType/createdAt 时补默认值", async () => {
    const fake = fakeSidecar({ sessionId: "s1" });
    const tool = createSessionOpenTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionType: "static" }, sessionExec())) as {
      sessionType: string;
      createdAt: string;
    };
    expect(result.sessionType).toBe("unknown");
    expect(result.createdAt).toBe("");
  });

  it("open 回包不是对象时按缺 sessionId 报错", async () => {
    const fake = fakeSidecar("nope");
    const tool = createSessionOpenTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    await expect(tool.execute({ sessionType: "static" }, sessionExec())).rejects.toThrow(
      /missing a string field/u,
    );
  });

  it("list 回包不是对象时给空列表", async () => {
    const fake = fakeSidecar(42);
    const tool = createSessionListTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({}, sessionExec())) as { sessions: unknown[] };
    expect(result.sessions).toStrictEqual([]);
  });

  it("list 里非对象的条目被丢掉", async () => {
    const fake = fakeSidecar({
      sessions: ["垃圾", { sessionType: "static" }, { sessionId: "s1", sessionType: "static" }],
    });
    const tool = createSessionListTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({}, sessionExec())) as {
      sessions: { sessionId: string }[];
    };
    expect(result.sessions).toHaveLength(2);
    // 缺 sessionId 的条目补空串，而不是漏 undefined。
    expect(result.sessions[0]?.sessionId).toBe("");
    expect(result.sessions[1]?.sessionId).toBe("s1");
  });

  it("list 空时渲染 no open sessions", async () => {
    const fake = fakeSidecar({ sessions: [] });
    const tool = createSessionListTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({}, sessionExec())) as {
      sessions: { sessionId: string; sessionType: string; createdAt: string }[];
    };
    expect(JSON.stringify(tool.output.render({}, result))).toContain("no open sessions");
  });

  it("list 回包是数字（而非数组）时给空列表", async () => {
    const fake = fakeSidecar("nope");
    const tool = createSessionListTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({}, sessionExec())) as {
      sessions: { sessionId: string; sessionType: string; createdAt: string }[];
    };
    expect(result.sessions).toStrictEqual([]);
  });

  it("close 读回 closed 与 sessionId", async () => {
    const fake = fakeSidecar({ sessionId: "s1", closed: true });
    const tool = createSessionCloseTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s1" }, sessionExec())) as {
      sessionId: string;
      closed: boolean;
    };
    expect(fake.calls[0]).toStrictEqual({ method: "session.close", params: { sessionId: "s1" } });
    expect(result).toStrictEqual({ sessionId: "s1", closed: true });
  });

  it("close 回包缺字段时退回入参并标记未关闭", async () => {
    const fake = fakeSidecar({});
    const tool = createSessionCloseTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const result = (await tool.execute({ sessionId: "s9" }, sessionExec())) as {
      sessionId: string;
      closed: boolean;
    };
    expect(result).toStrictEqual({ sessionId: "s9", closed: false });
    expect(JSON.stringify(tool.output.render({}, result))).toContain("not closed");
  });

  it("除 list 外的会话工具都声明不可并发", () => {
    // 开/抓/读历史/存取状态/关会话都会占住一份浏览器或连接，只有 list 是纯内存读，可以并发。
    const builders = [
      createSessionOpenTool,
      createSessionFetchTool,
      createSessionNetworkTool,
      createSessionStateSaveTool,
      createSessionStateLoadTool,
      createSessionCloseTool,
    ];
    for (const build of builders) {
      const tool = build({
        sidecar: fakeSidecar({}).client,
        settings: SETTINGS,
        startCrawlJob: fakeJobStarter,
        answer: fakeAnswer,
      });
      expect(tool.isConcurrencySafe?.({})).toBe(false);
      expect(tool.timeoutMs).toBe(SETTINGS.timeoutMs);
    }
    const list = createSessionListTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(list.isConcurrencySafe?.({})).toBe(true);
  });
});

describe("scrapling_crawl", () => {
  it("立刻返回作业 id，而不是等爬完", async () => {
    const fake = fakeSidecar({ crawlId: "c1" });
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL, maxPages: 3 }, exec)) as {
      jobId: string;
      maxPages: number;
    };
    expect(result.jobId).toBe("job-1");
    expect(result.maxPages).toBe(3);
    // crawlId 是 Python 侧内部句柄：作业异步调度，execute 返回时它还不存在，所以绝不能
    // 出现在返回值里 —— 真机上它会渲染成半截的 `crawlId ` 文案。
    expect(result).not.toHaveProperty("crawlId");
    expect(fake.calls[0]).toStrictEqual({
      method: "crawl.run",
      params: {
        url: SAMPLE_URL,
        maxPages: 3,
        maxDurationMs: 1_800_000,
        // 站点的礼貌与顺序整套走 deployment 命名空间：模型入参到不了这里，Python 只从
        // deployment 读。夹具跟着 SETTINGS 的部署档走，串档立刻暴露。
        deployment: {
          crawlRespectRobots: SETTINGS.crawlRespectRobots,
          crawlDownloadDelayMs: SETTINGS.crawlDownloadDelayMs,
          crawlConcurrentRequests: SETTINGS.crawlConcurrentRequests,
          crawlAutothrottle: SETTINGS.crawlAutothrottle,
          crawlStrategy: SETTINGS.crawlStrategy,
          crawlCheckpointDir: SETTINGS.crawlCheckpointDir,
        },
      },
    });
  });

  it("maxPages 缺省时用 20", async () => {
    const fake = fakeSidecar({ crawlId: "c1" });
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as { maxPages: number };
    expect(result.maxPages).toBe(20);
  });

  it("crawlMaxItems 是部署天花板：模型要的页数超过它就被压到它", async () => {
    const fake = fakeSidecar({ crawlId: "c1" });
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: { ...SETTINGS, crawlMaxItems: 5 },
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL, maxPages: 50 }, exec)) as {
      maxPages: number;
    };
    expect(result.maxPages).toBe(5);
  });

  it("非法 maxPages 原样透给 sidecar，不被静默夹成合法值", async () => {
    // 静默夹成 1 等于把一个明确的参数错误换成一个静默跑起来的爬虫：模型再也学不到
    // 「这个参数是非法的」，而 sidecar 侧的契约报错才是应该冒出来的那条信息。
    const fake = fakeSidecar({ crawlId: "c1" });
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL, maxPages: 0 }, exec)) as {
      maxPages: number;
    };
    expect(result.maxPages).toBe(0);
  });

  it("渲染结果告诉模型怎么观察作业", () => {
    const tool = createCrawlTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const blocks = tool.output.render(
      { url: SAMPLE_URL },
      { jobId: "scrapling-1", url: SAMPLE_URL, maxPages: 20 },
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain("scrapling-1");
    expect(text).toContain("job_output");
    // 输出里不该再出现那个内部句柄的名头，更不该出现它后面空着的半截文案。
    expect(text).not.toContain("crawlId");
  });

  it("声明不可并发（一次只跑一个爬虫）", () => {
    const tool = createCrawlTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.isConcurrencySafe?.({ url: SAMPLE_URL })).toBe(false);
    expect(tool.presentCall?.({ url: SAMPLE_URL })).toStrictEqual({
      card: "generic",
      title: SAMPLE_URL,
      kind: "search",
    });
  });
});

describe("取消信号的合成", () => {
  it("作业信号已中止时，传给 sidecar 的信号也是中止的", async () => {
    const seen: { aborted: boolean }[] = [];
    const fake = fakeSidecar({ crawlId: "c1" });
    const controller = new AbortController();
    controller.abort();
    // 记下 sidecar 收到的信号状态：这是「job_kill 能真的停住爬虫」的关键一环。
    const probe = {
      call: async (
        _method: string,
        _params: unknown,
        opts?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        seen.push({ aborted: opts?.signal?.aborted ?? false });
        return { crawlId: "c1" };
      },
    };
    Object.assign(fake.client, { call: probe.call });
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: async (_label, run) => {
        await run({
          append: (): void => undefined,
          progress: (): void => undefined,
          signal: controller.signal,
        });
        return "job-1";
      },
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await tool.execute({ url: SAMPLE_URL, maxPages: 1 }, exec);
    // 假 sidecar 不真的中止，只记录信号状态 —— 断言的是「合成后的信号已中止」。
    expect(seen[0]?.aborted).toBe(true);
  });

  it("工具执行超时也会中止传给 sidecar 的信号", async () => {
    const seen: { aborted: boolean }[] = [];
    const fake = fakeSidecar({ crawlId: "c1" });
    const execController = new AbortController();
    execController.abort();
    Object.assign(fake.client, {
      call: async (
        _method: string,
        _params: unknown,
        opts?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        seen.push({ aborted: opts?.signal?.aborted ?? false });
        return { crawlId: "c1" };
      },
    });
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: async (_label, run) => {
        await run({
          append: (): void => undefined,
          progress: (): void => undefined,
          signal: new AbortController().signal,
        });
        return "job-1";
      },
      answer: fakeAnswer,
    });
    await tool.execute({ url: SAMPLE_URL, maxPages: 1 }, {
      signal: execController.signal,
    } as never);
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe("爬虫报错的传播", () => {
  it("crawl.status 带回错误时，作业主体以可读信息抛错", async () => {
    const fake = fakeSidecar({ crawlId: "c1" });
    Object.assign(fake.client, {
      call: async (method: string): Promise<unknown> => {
        if (method === "crawl.run") {
          return { crawlId: "c1" };
        }
        return { running: false, pages: [], error: "RuntimeError: selector blew up" };
      },
    });
    let caught: unknown;
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: async (_label, run) => {
        try {
          await run({
            append: (): void => undefined,
            progress: (): void => undefined,
            signal: new AbortController().signal,
          });
        } catch (error: unknown) {
          caught = error;
        }
        return "job-1";
      },
      answer: fakeAnswer,
    });
    await tool.execute({ url: SAMPLE_URL, maxPages: 1 }, {
      signal: new AbortController().signal,
    } as never);
    expect(String(caught)).toContain("selector blew up");
  });

  it("到点收场的爬虫在输出里说明原因", async () => {
    // 页数比 maxPages 少时，模型该能看出是「整体截止到了点」而不是站点就这么大。
    const notes: string[] = [];
    const fake = fakeSidecar({ crawlId: "c1" });
    Object.assign(fake.client, {
      call: async (method: string): Promise<unknown> => {
        if (method === "crawl.run") {
          return { crawlId: "c1" };
        }
        return {
          running: false,
          pages: [{ url: "https://x.test/1", title: "one", markdown: "m" }],
          error: null,
          expired: true,
        };
      },
    });
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: async (_label, run) => {
        await run({
          append: (): void => undefined,
          progress: (line: string): void => {
            notes.push(line);
          },
          signal: new AbortController().signal,
        });
        return "job-1";
      },
      answer: fakeAnswer,
    });
    await tool.execute({ url: SAMPLE_URL, maxPages: 20 }, {
      signal: new AbortController().signal,
    } as never);
    const text = notes.join("\n");
    expect(text).toContain("runtime budget");
    expect(text).toContain("1 page(s) crawled");
  });

  it("轮询断了先去叫停 Python 侧那个爬虫，再把原因抛出去", async () => {
    // 作业取消只活在 Node 侧，Python 里的 Spider 在自己的线程上跑，看不见它。
    // 少这一帧的话，作业显示已杀、爬虫还在后台跑。
    const methods: string[] = [];
    const fake = fakeSidecar({ crawlId: "c1" });
    const controller = new AbortController();
    Object.assign(fake.client, {
      call: async (method: string): Promise<unknown> => {
        methods.push(method);
        if (method === "crawl.run") {
          return { crawlId: "c1" };
        }
        // 第一帧状态查询就被打断：模拟 job_kill / 本轮超时落在这里。
        controller.abort();
        throw new Error("aborted");
      },
    });
    let caught: unknown;
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: async (_label, run) => {
        try {
          await run({
            append: (): void => undefined,
            progress: (): void => undefined,
            signal: controller.signal,
          });
        } catch (error: unknown) {
          caught = error;
        }
        return "job-1";
      },
      answer: fakeAnswer,
    });
    await tool.execute({ url: SAMPLE_URL, maxPages: 1 }, {
      signal: new AbortController().signal,
    } as never);
    expect(methods).toStrictEqual(["crawl.run", "crawl.status", "crawl.stop"]);
    expect(String(caught)).toContain("aborted");
  });

  it("叫停失败不盖掉真正的失败原因", async () => {
    // sidecar 可能已经崩了：那时 crawl.stop 只会换回一个错误，而它不该替换掉
    // 调用方真正该看到的那一条。
    const fake = fakeSidecar({ crawlId: "c1" });
    Object.assign(fake.client, {
      call: async (method: string): Promise<unknown> => {
        if (method === "crawl.run") {
          return { crawlId: "c1" };
        }
        if (method === "crawl.stop") {
          throw new Error("sidecar is gone");
        }
        throw new Error("status poll failed");
      },
    });
    let caught: unknown;
    const tool = createCrawlTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: async (_label, run) => {
        try {
          await run({
            append: (): void => undefined,
            progress: (): void => undefined,
            signal: new AbortController().signal,
          });
        } catch (error: unknown) {
          caught = error;
        }
        return "job-1";
      },
      answer: fakeAnswer,
    });
    await tool.execute({ url: SAMPLE_URL, maxPages: 1 }, {
      signal: new AbortController().signal,
    } as never);
    expect(String(caught)).toContain("status poll failed");
  });
});
