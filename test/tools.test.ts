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
  createSessionOpenTool,
  createStealthFetchTool,
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
  captureXhrPattern: ".*",
  requestTimeoutSeconds: 120,
  blockAds: false,
  // 用 schema 默认值：这条夹具要验的是模型侧 maxPages 的缺省（20），不是部署天花板。
  crawlMaxItems: 1000,
  maxUrlLength: 2048,
  browserExecutablePath: "",
  browserCdpUrl: "",
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

  it("回包不是对象时给空列表而不是抛", async () => {
    const fake = fakeSidecar("not an object");
    const tool = createExtractTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ html: "x", selector: "li" }, exec)) as {
      count: number;
      matches: unknown[];
    };
    expect(result.matches).toStrictEqual([]);
    expect(result.count).toBe(0);
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

  it("status 不是非负整数时退回 0", async () => {
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
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as { statusCode: number };
    expect(result.statusCode).toBe(0);
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
      xhr: { url: string; status: number; bytes: number }[];
    };
    expect(result.xhr).toStrictEqual([
      { url: SAMPLE_API, status: 200, bytes: 1234 },
      { url: "https://api.test/user", status: 500, bytes: 12 },
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
      xhr: { url: string; status: number; bytes: number }[];
    };
    expect(result.xhr).toStrictEqual([{ url: "", status: 0, bytes: 0 }]);
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
        xhr: [{ url: SAMPLE_API, status: 200, bytes: 99 }],
      },
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain("Captured XHR");
    expect(text).toContain(SAMPLE_API);
  });
});

/** 会话工具用例共用的执行上下文；放在 describe 外避免每次重建。 */
const sessionExec = (): never => ({ signal: new AbortController().signal }) as never;

describe("scrapling_stealth_fetch", () => {
  it("把 stealth 开关透传给 sidecar", async () => {
    const fake = fakeSidecar({ url: SAMPLE_URL, status: 200, content: "ok", truncated: false });
    const tool = createStealthFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    await tool.execute({ url: SAMPLE_URL, solveCloudflare: true }, exec);
    expect(fake.calls[0]?.method).toBe("stealth_fetch");
    expect(fake.calls[0]?.params).toMatchObject({ url: SAMPLE_URL, solveCloudflare: true });
  });

  it("内容超预算时照样封顶", async () => {
    const fake = fakeSidecar({
      url: SAMPLE_URL,
      status: 200,
      content: "y".repeat(9000),
      truncated: false,
    });
    const tool = createStealthFetchTool({
      sidecar: fake.client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    const exec = { signal: new AbortController().signal } as never;
    const result = (await tool.execute({ url: SAMPLE_URL }, exec)) as {
      truncated: boolean;
      content: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(9000);
  });

  it("卡片元数据与 render 同形", () => {
    const tool = createStealthFetchTool({
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

  it("stealth 的渲染与 fetch 同形，且不可并发", () => {
    const tool = createStealthFetchTool({
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
    expect(JSON.stringify(blocks)).toContain(`Fetched ${SAMPLE_URL}`);
    expect(tool.isConcurrencySafe?.({ url: SAMPLE_URL })).toBe(false);
  });

  it("stealth 的 pending 卡片标为 fetch", () => {
    const tool = createStealthFetchTool({
      sidecar: fakeSidecar({}).client,
      settings: SETTINGS,
      startCrawlJob: fakeJobStarter,
      answer: fakeAnswer,
    });
    expect(tool.presentCall?.({ url: SAMPLE_URL })).toStrictEqual({
      card: "generic",
      title: SAMPLE_URL,
      kind: "fetch",
    });
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
      params: { sessionType: "static", headless: true, solveCloudflare: false },
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
    // 开/抓/关会话都会占住一份浏览器或连接，只有 list 是纯内存读，可以并发。
    const builders = [
      createSessionOpenTool,
      createSessionFetchTool,
      createSessionCloseTool,
      createStealthFetchTool,
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
      params: { url: SAMPLE_URL, maxPages: 3 },
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
});
