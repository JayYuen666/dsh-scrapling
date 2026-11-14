// dsh-scrapling/test/i18n.test.ts —— 英文装配的端到端判据：模型可见面里不该再出现中文。
//
// 为什么要有这一条：`ToolDeps.messages` 是**可选**位（181 处夹具都在造 deps 字面量，只有
// `host.ts` 一处真构造点）。可选意味着「忘记传」不会编译失败，而症状是英文界面上静默露出
// 中文。`test/messages.test.ts` 只验字典本身，验不到「字典有没有真的接到 19 个工具与指引段上」。
//
// 判据是**字形**而不是逐条文案比对：漏翻的形态有无数种（半句残留、拼接漏掉一段、参数说明
// 忘改），而它们都表现为「本该全英文的地方出现了汉字」。所以这里按英文装配一次，把模型能
// 读到的每一处说明文本摊平，断言零汉字。

import { describe, expect, it } from "vitest";
import { SidecarClient } from "../lib/sidecar.ts";
import { MESSAGES, format } from "../lib/messages.ts";
import { guidanceFor, TOOL_SPECS } from "../host.ts";
import type { AnswerRequest, AnswerResult } from "../lib/answer.ts";
import {
  createAnswerTool,
  createCaptureXhrTool,
  createCrawlTool,
  createExtractTool,
  createFetchTool,
  createLinksTool,
  createLocateTool,
  createRenderTool,
  createSessionCloseTool,
  createSessionFetchTool,
  createSessionListTool,
  createSessionNetworkTool,
  createSessionOpenTool,
  createSessionStateLoadTool,
  createSessionStateSaveTool,
  messagesOf,
} from "../lib/tools.ts";
import type { CrawlJobRunner, CrawlSink, ToolDeps, ToolSettings } from "../lib/tools.ts";
import {
  createDownloadTool,
  createScreenshotTool,
  createSessionActTool,
  createSessionReadTool,
} from "../lib/browser-tools.ts";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/** 汉字：只判汉字本体，英文里合法使用的 U+2014／U+2026 不在这一类里。 */
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;

/** 一份完整的部署设置：取值不重要，这里只关心它能让 19 个工厂都建出来。 */
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
  crawlMaxItems: 1000,
  crawlMaxRuntimeSeconds: 1800,
  browserExecutablePath: "",
  browserInitScript: "",
  browserRealChrome: false,
  browserDnsOverHttps: false,
  recordRequests: false,
  maxRecordedRequests: 100,
  sessionStateDir: "/tmp/scrapling-sessions",
  adaptiveStorage: "sqlite",
  redisUrl: "redis://127.0.0.1:6379/0",
  crawlRespectRobots: false,
  crawlDownloadDelayMs: 0,
  crawlConcurrentRequests: 4,
  crawlAutothrottle: false,
  crawlStrategy: "bfs",
  crawlCheckpointDir: "",
  allowWriteMethods: true,
  stripInlineImages: true,
  downloadDir: "/tmp/scrapling-downloads",
  downloadMaxBytes: 10_000_000,
};

/**
 * 假 sidecar：`capabilities` 声明浏览器可用，`call` 不参与本文件的判定。
 *
 * @param browser - 这台机器有没有浏览器（有两档参数说明文案）
 * @returns 可直接塞进 ToolDeps 的客户端
 */
function fakeSidecar(browser: boolean): SidecarClient {
  const client = new SidecarClient({} as never, {
    pythonBin: "python3",
    bridgePath: "bridge.py",
    cwd: ".",
    handshakeTimeoutMs: 10,
    requestTimeoutMs: 10,
    graceMs: 10,
  });
  Object.defineProperty(client, "capabilities", {
    value: { scrapling: true, static: true, extract: true, browser, writeMethods: true },
    configurable: true,
  });
  Object.assign(client, {
    call: async (): Promise<unknown> => ({}),
  });
  return client;
}

/** 起作业的替身：本文件不跑作业主体。 */
/** 空 sink：本文件不驱动爬虫，只要求作业能起得来。 */
const NULL_SINK: CrawlSink = {
  append: () => {
    // 不关心爬虫输出。
  },
  progress: () => {
    // 同上。
  },
  signal: new AbortController().signal,
};

/** 起作业的替身：本文件不跑作业主体。 */
const fakeJobStarter = async (_label: string, run: CrawlJobRunner): Promise<string> => {
  await run(NULL_SINK);
  return "job-1";
};

/** 问模型的替身。 */
const fakeAnswer = async (request: AnswerRequest): Promise<AnswerResult> => ({
  answer: `answer:${request.question}`,
  provider: "fake",
  model: "fake",
});

/**
 * 按给定语言与浏览器档造一份依赖。
 *
 * @param messages - 文案表（英文那一份用来验翻译真的接到了工具上）
 * @param browser - 有没有可用浏览器
 * @returns 19 个工厂都能吃的依赖
 */
function depsOf(messages: typeof MESSAGES.en, browser: boolean): ToolDeps {
  return {
    sidecar: fakeSidecar(browser),
    settings: SETTINGS,
    startCrawlJob: fakeJobStarter,
    answer: fakeAnswer,
    attachments: { saveImage: async (): Promise<Record<string, unknown>> => ({}) },
    messages,
  };
}

/**
 * 把一份参数 schema 里所有说明文本摊平（含嵌套 items 与 anyOf）。
 *
 * @param node - 编译后的参数 schema（官方 `parameters` 的 JSON Schema 投影）
 * @param into - 收集到的说明文本
 * @returns 同一份收集器（便于链式收尾）
 */
function collectDescriptions(node: unknown, into: string[] = []): string[] {
  if (typeof node !== "object" || node === null) {
    return into;
  }
  const record = node as Record<string, unknown>;
  if (typeof record["description"] === "string") {
    into.push(record["description"]);
  }
  for (const key of ["properties", "items", "anyOf", "oneOf", "allOf"]) {
    const child = record[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        collectDescriptions(item, into);
      }
    } else if (typeof child === "object" && child !== null) {
      for (const item of Object.values(child)) {
        collectDescriptions(item, into);
      }
    }
  }
  return into;
}

/** 19 个工厂 → 工具名。期望表独立写死；工具面多一个少一个这里就红。 */
const BUILDERS: readonly (readonly [string, (deps: ToolDeps) => ToolDefinition])[] = [
  ["scrapling_fetch", createFetchTool],
  ["scrapling_extract", createExtractTool],
  ["scrapling_locate", createLocateTool],
  ["scrapling_links", createLinksTool],
  ["scrapling_render", createRenderTool],
  ["scrapling_capture_xhr", createCaptureXhrTool],
  ["scrapling_answer", createAnswerTool],
  ["scrapling_session_open", createSessionOpenTool],
  ["scrapling_session_fetch", createSessionFetchTool],
  ["scrapling_session_network", createSessionNetworkTool],
  ["scrapling_session_state_save", createSessionStateSaveTool],
  ["scrapling_session_state_load", createSessionStateLoadTool],
  ["scrapling_session_list", createSessionListTool],
  ["scrapling_session_close", createSessionCloseTool],
  ["scrapling_crawl", createCrawlTool],
  ["scrapling_session_read", createSessionReadTool],
  ["scrapling_session_act", createSessionActTool],
  ["scrapling_download", createDownloadTool],
  ["scrapling_screenshot", createScreenshotTool],
];

describe("英文装配：工具说明与参数说明里零汉字", () => {
  it("19 个工具在英文那份文案下都不残留中文", () => {
    const deps = depsOf(MESSAGES.en, true);
    // 唯一一个真的没有参数的工具：它只读内存里的会话寄存器，任何入参都无意义。
    // 把它单列出来，是为了让「每条都该有参数说明」这条前置断言仍然可用 —— 否则为了迁就
    // 这一条，整批就只能退化成「有就验」，而我真正想防的是「某个工具的参数说明整段漏翻」。
    // 参数表为空的工具**只有**这一枚（它只读内存里的会话寄存器，任何入参都无意义）。
    // 单列成一张期望表而不是写进循环里的 if：这样「谁一条参数说明都没有」是一份可读的
    // 断言，而不是被条件吞掉的静默。
    const WITHOUT_PARAMETERS = ["scrapling_session_list"];

    const empty: string[] = [];
    let total = 0;
    for (const [name, build] of BUILDERS) {
      const tool = build(deps);
      expect(tool.name, "工厂交回的工具名对不上").toBe(name);
      expect(tool.description, `${name} 的工具描述残留中文`).not.toMatch(HAN);
      // 传整份 schema（而不是它的 properties 那张表）：摊平函数按 `properties`/`items` 这些
      // 关键字往下走，直接把属性表喂进去会一条都收不到，判据静默空转。
      const descriptions = collectDescriptions(tool.parameters);
      total += descriptions.length;
      if (descriptions.length === 0) {
        empty.push(name);
      }
      for (const text of descriptions) {
        expect(text, `${name} 的参数说明残留中文`).not.toMatch(HAN);
      }
    }
    expect(empty, "没有参数说明的工具与期望表对不上").toStrictEqual(WITHOUT_PARAMETERS);
    // 全局下限：19 个工具的参数说明合起来是几百条，跌到两位数说明摊平函数又没走到。
    expect(total, "摊平到的参数说明太少，说明遍历没走到底").toBeGreaterThan(150);
  });

  it("没有浏览器时那一档参数说明也走英文（两档文案都得翻）", () => {
    const deps = depsOf(MESSAGES.en, false);
    const tool = createSessionOpenTool(deps);
    const sessionType = (
      tool.parameters as unknown as {
        properties?: Record<string, { enum?: string[]; description?: string }>;
      }
    ).properties?.["sessionType"];
    expect(sessionType?.enum, "没有浏览器时只该剩 static 一档").toStrictEqual(["static"]);
    expect(sessionType?.description ?? "").not.toMatch(HAN);
  });

  it("写方法参数表（部署开放写方法时才出现）也是英文", () => {
    const deps = depsOf(MESSAGES.en, true);
    const tool = createFetchTool(deps);
    const properties =
      (tool.parameters as unknown as { properties?: Record<string, unknown> }).properties ?? {};
    // 这几枚只在 allowWriteMethods 为真时进参数表；它们漏翻与否决定「开关一开就露出中文」。
    for (const key of ["method", "body", "form", "json"]) {
      expect(Object.keys(properties), `开放写方法后参数表里缺 ${key}`).toContain(key);
      const text = (properties[key] as { description?: string }).description ?? "";
      expect(text, `${key} 的参数说明残留中文`).not.toMatch(HAN);
    }
  });
});

describe("英文装配：system prompt 的指引段", () => {
  // 15 段全开、每个工具都「可见」时指引最长；这正是英文界面下模型真会读到的那一份。
  const ALL_ON = {
    fetch: true,
    extract: true,
    locate: true,
    links: true,
    render: true,
    captureXhr: true,
    network: true,
    session: true,
    sessionState: true,
    crawl: true,
    answer: true,
    sessionRead: true,
    sessionActions: true,
    download: true,
    screenshot: true,
  };

  it("十五段全开时每行都是英文，且真的一行一段", () => {
    const text = guidanceFor(ALL_ON, () => true, MESSAGES.en);
    const lines = text.split("\n");
    expect(lines, "全开时该有十五条指引").toHaveLength(15);
    for (const line of lines) {
      expect(line, "英文指引行残留中文").not.toMatch(HAN);
      expect(line.startsWith("- "), "指引行没以列表符号开头").toBe(true);
    }
    // 反向钉子：中文那一份必须仍是中文，否则上面那条可能因为两份都空而通过。
    expect(guidanceFor(ALL_ON, () => true, MESSAGES.zh)).toMatch(HAN);
  });

  it("工具不可见时对应行消失（判据落在那张表上，不是文案表）", () => {
    const onlyFetch = guidanceFor(ALL_ON, (tool) => tool === "scrapling_fetch", MESSAGES.en);
    expect(onlyFetch).toContain("scrapling_fetch");
    expect(onlyFetch.split("\n")).toHaveLength(1);
  });
});

describe("文案缺省与回落", () => {
  it("deps 不带 messages 时按中文（改造前的行为不变）", () => {
    const { messages: _omitted, ...rest } = depsOf(MESSAGES.en, true);
    expect(messagesOf(rest)).toBe(MESSAGES.zh);
    expect(createFetchTool(rest).description).toMatch(HAN);
  });

  it("带上英文时 description 与字典逐字一致（不是另一份手抄文案）", () => {
    const deps = depsOf(MESSAGES.en, true);
    expect(createFetchTool(deps).description).toBe(MESSAGES.en.fetchToolDescription);
    expect(createExtractTool(deps).description).toBe(MESSAGES.en.extractToolDescription);
  });

  it("带占位符的文案在英文下真被填过（不是留着 {keys} 的模板）", () => {
    // 会话开单的 static 档忽略提示是唯一一条带插值的模型可见拒绝理由。
    const rendered = format(MESSAGES.en.staticSessionIgnores, { keys: "useragent, locale" });
    expect(rendered).toContain("useragent, locale");
    expect(rendered).not.toContain("{keys}");
    expect(rendered).not.toMatch(HAN);
  });

  it("工厂表与 TOOL_SPECS 覆盖同一批工具名", () => {
    expect(TOOL_SPECS.map((spec) => spec.name).toSorted()).toStrictEqual(
      BUILDERS.map(([name]) => name).toSorted(),
    );
  });
});
