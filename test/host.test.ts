// dsh-scrapling/test/host.test.ts —— Host 半的配置面与工具注册计划。
//
// 覆盖三件事：（1）volatile 字段是引用而非真值，必须经 .get() 取快照；
// （2）Config schema 的默认值；（3）planTools 如何把「用户开关」与「运行环境具备什么」
// 两个维度合成一份注册计划。

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { createCrawlTool } from "../lib/tools.ts";
import type { CrawlSink, ToolDeps, ToolSettings } from "../lib/tools.ts";
import type { AnswerResult } from "../lib/answer.ts";
import { SidecarClient } from "../lib/sidecar.ts";
import { SidecarError } from "../lib/sidecar-error.ts";
import { MCP_TOKEN_ENV } from "../lib/mcp-contract.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Config as configSchema,
  apply,
  crawlFailureDetail,
  createCrawlEventRouter,
  createUrlGate,
  guidanceFor,
  inject,
  name,
  outputBudgetOf,
  planTools,
  resolveDataDir,
  resolvePythonBin,
  snapshotFlags,
  startMcpSurface,
  TOOL_SPECS,
} from "../host.ts";
import type { Config as ConfigType, ToolFlags, ToolPlan } from "../host.ts";
import type { Volatile } from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";
import type { SidecarCapabilities } from "../lib/sidecar.ts";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { LOCAL_PYTHON } from "./python-bin.ts";

/**
 * 造一个 volatile 引用。
 *
 * 用 dsh 官方的 `Volatile<T>`（cordis 从 cosmokit 再导出）标注返回值，而不是自己声明
 * `{ get(): T }` —— 后者一旦官方给 Volatile 加成员就会与真实形状脱节。
 * 官方 `get()` 返回 `VolatileSnapshot<T>`；它对原始值联合是恒等的，而本包的 volatile
 * 字段全都是原始值，所以把参数类型定死成原始值联合。
 *
 * @param value - 引用的真值
 * @returns 一个只实现 get 的 volatile 引用
 */
function mkRef(value: string | number | boolean): Volatile<string | number | boolean> {
  return { get: () => value };
}

/** 全开开关。 */
const BROWSER_MISSING = "browser-missing";

const ALL_ON: ToolFlags = {
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

/** 全关开关。 */
const ALL_OFF: ToolFlags = {
  fetch: false,
  extract: false,
  locate: false,
  links: false,
  render: false,
  captureXhr: false,
  network: false,
  session: false,
  sessionState: false,
  crawl: false,
  answer: false,
  sessionRead: false,
  sessionActions: false,
  download: false,
  screenshot: false,
};

/** 指引判据的另一半：所有工具都看得见（只看开关那一档时用这份）。 */
const EVERYWHERE = (): boolean => true;

/**
 * 造一份「除了 `absent` 都看得见」的可见性判据。
 *
 * @param absent - 当成没注册的那个工具名
 * @returns 可直接交给 guidanceFor 的判据
 */
function exceptTool(absent: string): (tool: string) => boolean {
  return (tool: string) => tool !== absent;
}

/** 全能力就绪。 */
const FULL_CAPS: SidecarCapabilities = {
  scrapling: true,
  static: true,
  extract: true,
  browser: true,
  version: "0.5",
  writeMethods: false,
};

/**
 * 把任意 JSON 值投影为对象映射（非对象 → 空对象），避免断言成具体类型。
 *
 * @param raw - 任意值
 * @returns 对象形态的映射
 */
function asRecord(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

/**
 * 从 schema 的产物里取某个 volatile 字段的真值。
 *
 * schema 对标了 .volatile() 的字段会包成引用（带 get 与 cosmokit 的 write symbol），
 * 不是裸值 —— 这个 helper 的存在本身就是在钉这个形状。
 *
 * @param key - 字段名
 * @returns 该字段的 volatile 引用
 */
function volatileRef(key: string): Volatile<unknown> {
  const refs = asRecord(configSchema({}));
  const ref: unknown = refs[key];
  if (!isRecord(ref) || typeof ref["get"] !== "function") {
    throw new Error(`config field is not a volatile ref: ${key}`);
  }
  return ref as unknown as Volatile<unknown>;
}

/**
 * 假 ctx 里的 settings 面。
 *
 * 本插件在 apply 开头登记一次页面策略（`auto: false`，意思是「这一页由自带卡片编辑」，
 * 别再自动生成一份通用表单）。记下收到的值供断言，返回一个空 disposer，与真实服务同形。
 *
 * @param registrations - 收到的 `auto` 值会推进来
 * @returns 可直接挂进假 ctx 的对象
 */
function settingsStub(registrations: string[] = []): unknown {
  return {
    configure: (presentation: { auto?: boolean }): (() => void) => {
      registrations.push(String(presentation.auto));
      return (): void => undefined;
    },
  };
}

/** 注册过的一段 system prompt。 */
interface PromptRecord {
  name: string;
  order: number;
  /** 静态文本，或上游那种「每次装配现取」的函数；`scope` 本包只转交给 `ctx.tools.get`。 */
  text: string | ((context: { scope?: object }) => string);
}

/** 假 systemPrompt 收到的段。 */
const SECTIONS: PromptRecord[] = [];

/**
 * 假 ctx 的 systemPrompt 面。
 *
 * apply 会注册一段用量指引，所以每个跑 apply 的用例都得给它挂上这个面 —— 缺了它，症状不是
 * 「指引段没注册」而是整个 apply 抛，那会把一堆无关用例一起带走，报错还不指向真正的原因。
 *
 * @param into - 收到的段推进这里
 * @returns 可直接挂进假 ctx 的对象
 */
function promptStub(into: PromptRecord[] = SECTIONS): unknown {
  return {
    getSectionOrder: (): number => 2100,
    section: (section: PromptRecord): (() => void) => {
      into.push(section);
      return (): void => undefined;
    },
  };
}

/**
 * 假 tools 面：`register` 把名字登记下来，`get` 按那份登记回答。
 *
 * 指引段的文本是**装配时**现算的，而它问的是「这个 scope 看得见哪些工具」。这里必须让 `get`
 * 给真答案：只给 `register` 的话 `ctx.tools.get` 是 undefined 方法、text() 直接抛，或者更糟——
 * 夹具把 get 写成恒返回 undefined，指引于是恒为空串，而「空串」恰是它该有的失败形状，那条
 * 门禁就静默失效了。
 */
function toolsStub(): { names: string[]; face: unknown } {
  const names: string[] = [];
  return {
    names,
    face: {
      register: (definition: { name: string }): (() => void) => {
        names.push(definition.name);
        return (): void => undefined;
      },
      get: (tool: string): unknown => (names.includes(tool) ? { name: tool } : undefined),
    },
  };
}

type Mode = "native" | "mcp" | "official-mcp";

/**
 * 造一份与宿主同形的配置：volatile 字段是引用，部署级字段是真值。
 *
 * @param overrides - 覆盖的 volatile 字段真值
 * @returns 形状与 apply 收到的 config 一致的对象
 */
function makeConfig(overrides: Record<string, unknown> = {}): ConfigType {
  const pick = (key: string, fallback: string | number | boolean): never =>
    mkRef((overrides[key] as string | number | boolean | undefined) ?? fallback) as never;
  // requestTimeoutSeconds 与 maxUrlLength 在 Config 里是**非 volatile** 的部署值，宿主交下来
  // 的就是裸值。夹具若也包成引用，`url.length > maxUrlLength` 这类比较会拿引用去比——
  // 恒为 false，于是长度上限这条分支在测试里永远走不到，断言还会「因为没触发」而变绿。
  const plain = (key: string, fallback: number): number =>
    (overrides[key] as number | undefined) ?? fallback;
  // 部署级字符串字段同理：宿主交下来的是裸字符串，包成引用会让「与默认值比较」恒为 false。
  const plainText = (key: string, fallback: string): string =>
    (overrides[key] as string | undefined) ?? fallback;
  // 部署级布尔档（allowWriteMethods）也一样是裸值：包成引用会让 `config.x ? "1" : "0"`
  // 恒走真值那一支，于是「默认关」这条安全承诺在测试里根本没被验到。
  const plainFlag = (key: string, fallback: boolean): boolean =>
    (overrides[key] as boolean | undefined) ?? fallback;
  // 部署级二选一枚举（crawlStrategy）同样是裸值，且类型是 `"bfs" | "dfs"` 而非泛 string。
  const plainChoice = (key: string, fallback: "bfs" | "dfs"): "bfs" | "dfs" =>
    (overrides[key] as "bfs" | "dfs" | undefined) ?? fallback;
  const plainChoice3 = (key: string, fallback: Mode): Mode =>
    (overrides[key] as Mode | undefined) ?? fallback;
  return {
    pythonBin: pick("pythonBin", ""),
    failFastOnMissingPython: pick("failFastOnMissingPython", true),
    fetchEnabled: pick("fetchEnabled", true),
    extractEnabled: pick("extractEnabled", true),
    locateEnabled: pick("locateEnabled", true),
    linksEnabled: pick("linksEnabled", true),
    renderEnabled: pick("renderEnabled", true),
    captureXhrEnabled: pick("captureXhrEnabled", true),
    networkEnabled: pick("networkEnabled", true),
    sessionEnabled: pick("sessionEnabled", true),
    sessionStateEnabled: pick("sessionStateEnabled", true),
    crawlEnabled: pick("crawlEnabled", true),
    answerEnabled: pick("answerEnabled", true),
    sessionReadEnabled: pick("sessionReadEnabled", true),
    sessionActionsEnabled: pick("sessionActionsEnabled", true),
    downloadEnabled: pick("downloadEnabled", true),
    screenshotEnabled: pick("screenshotEnabled", true),
    allowBrowserActions: plainFlag("allowBrowserActions", false),
    allowFileDownloads: plainFlag("allowFileDownloads", false),
    downloadMaxBytes: plain("downloadMaxBytes", 10 * 1024 * 1024),
    extractionType: pick("extractionType", "markdown"),
    mainContentOnly: pick("mainContentOnly", true),
    fetchMaxOutputChars: pick("fetchMaxOutputChars", 200_000),
    extractMaxOutputChars: pick("extractMaxOutputChars", 200_000),
    renderMaxOutputChars: pick("renderMaxOutputChars", 200_000),
    xhrMaxOutputChars: pick("xhrMaxOutputChars", 120_000),
    crawlMaxItems: pick("crawlMaxItems", 1000),
    crawlMaxRuntimeSeconds: plain("crawlMaxRuntimeSeconds", 1800),
    stripInlineImages: pick("stripInlineImages", true),
    headless: pick("headless", true),
    networkIdle: pick("networkIdle", false),
    blockAds: pick("blockAds", true),
    pierceShadow: pick("pierceShadow", false),
    waitSelectorState: pick("waitSelectorState", "attached"),
    sidecarHandshakeTimeoutMs: pick("sidecarHandshakeTimeoutMs", 30_000),
    fetchTimeoutMs: pick("fetchTimeoutMs", 120_000),
    sidecarGraceMs: pick("sidecarGraceMs", 5000),
    requestTimeoutSeconds: plain("requestTimeoutSeconds", 120),
    maxUrlLength: plain("maxUrlLength", 2048),
    browserExecutablePath: plainText("browserExecutablePath", ""),
    browserCdpUrl: plainText("browserCdpUrl", ""),
    browserInitScript: plainText("browserInitScript", ""),
    browserRealChrome: plainFlag("browserRealChrome", false),
    browserDnsOverHttps: plainFlag("browserDnsOverHttps", false),
    recordRequests: plainFlag("recordRequests", false),
    maxRecordedRequests: plain("maxRecordedRequests", 100),
    sessionStateDir: plainText("sessionStateDir", ""),
    adaptiveStorage: pick("adaptiveStorage", "sqlite"),
    redisUrl: plainText("redisUrl", "redis://127.0.0.1:6379/0"),
    crawlRespectRobots: plainFlag("crawlRespectRobots", false),
    crawlDownloadDelayMs: plain("crawlDownloadDelayMs", 0),
    crawlConcurrentRequests: plain("crawlConcurrentRequests", 4),
    crawlAutothrottle: plainFlag("crawlAutothrottle", false),
    crawlStrategy: plainChoice("crawlStrategy", "bfs"),
    crawlCheckpointDir: plainText("crawlCheckpointDir", ""),
    allowWriteMethods: plainFlag("allowWriteMethods", false),
    integrationMode: plainChoice3("integrationMode", "native"),
    mcpPort: plain("mcpPort", 39_217),
    officialMcpEnabled: plainFlag("officialMcpEnabled", false),
    nat64Prefixes: pick("nat64Prefixes", ""),
    dataDir: pick("dataDir", ""),
    provideWebFetch: pick("provideWebFetch", true),
    provideWebSearch: pick("provideWebSearch", true),
    searchBackend: pick("searchBackend", "auto"),
    searchPublicFallback: pick("searchPublicFallback", false),
    tavilyApiKey: pick("tavilyApiKey", ""),
    braveApiKey: pick("braveApiKey", ""),
    serperApiKey: pick("serperApiKey", ""),
    searxngEndpoint: pick("searxngEndpoint", ""),
    duckduckgoEndpoint: plainText("duckduckgoEndpoint", "https://html.duckduckgo.com/html/"),
    tavilyApiEndpoint: plainText("tavilyApiEndpoint", "https://api.tavily.com/search"),
    bingEndpoint: plainText("bingEndpoint", "https://www.bing.com/search"),
    searchRenderTopN: plain("searchRenderTopN", 3),
    answerProvider: pick("answerProvider", ""),
    answerModel: pick("answerModel", ""),
    answerMaxTokens: pick("answerMaxTokens", 2000),
    allowedHosts: pick("allowedHosts", ""),
    syntheticDnsRanges: pick("syntheticDnsRanges", ""),
    proxyUrl: pick("proxyUrl", ""),
    proxyBypass: pick("proxyBypass", ""),
  };
}

/** 本仓探针解释器是否就位。不就位时下面这些用例整条跳过，而不是跑起来空转。 */
const HAS_LOCAL_PYTHON = existsSync(LOCAL_PYTHON);

/** 工具没被注册时的报错文案。 */
const NOT_REGISTERED = "scrapling_crawl was not registered";

/** 一个必然连不上的地址：端口 1 上没有任何服务在听。 */
const UNREACHABLE = "http://127.0.0.1:1/";

/** 假 spawn 被调到时的哨兵：走到这里说明测试的前提被破坏了。 */
const SHOULD_NOT_REACHED = "should not be reached";

/** 假解释器抛出的那句话；多处复用，抽成常量免得改一处漏一处。 */
const INTERPRETER_UNUSABLE = "interpreter not usable";

/** 本地测试站点所在的回环主机：Host 侧闸门与 Python 侧放行设置共用这一份。 */
const LOOPBACK_ALLOWLIST = "127.0.0.1,localhost";

/** 用例里统一的假作业 id。 */
const CRAWL_JOB_ID = "scrapling-1";

describe("插件元信息", () => {
  it("插件 id 与 cordis.patch.yml 的 id 一致（设置命名空间由此决定）", () => {
    expect(name).toBe("scrapling");
  });

  it("注入了 tools / subprocess / web / systemPrompt / settings 五个服务", () => {
    expect(inject).toStrictEqual(["tools", "subprocess", "web", "systemPrompt", "settings"]);
  });
});

describe("config schema", () => {
  it("pythonBin 默认留空（具体用哪支由 resolvePythonBin 现探）", () => {
    expect(volatileRef("pythonBin").get()).toBe("");
  });

  it("工具开关默认全开；pierceShadow 默认关（只有页面把正文封进 shadow DOM 时才需要它）", () => {
    expect(volatileRef("crawlEnabled").get()).toBe(true);
    expect(volatileRef("networkEnabled").get()).toBe(true);
    expect(volatileRef("sessionStateEnabled").get()).toBe(true);
    expect(volatileRef("pierceShadow").get()).toBe(false);
  });

  it("接管内置 web_fetch / web_search 的开关默认开（真正接管仍要部署侧配 provider 名）", () => {
    expect(volatileRef("provideWebFetch").get()).toBe(true);
    expect(volatileRef("provideWebSearch").get()).toBe(true);
  });

  it("抽取默认 markdown 且只取 body —— 与 dsh 内置 web_fetch 的呈现口径对齐", () => {
    expect(volatileRef("extractionType").get()).toBe("markdown");
    expect(volatileRef("mainContentOnly").get()).toBe(true);
  });

  it("安全相关的用户可改字段默认都是最严档", () => {
    expect(volatileRef("allowedHosts").get()).toBe("");
    expect(volatileRef("nat64Prefixes").get()).toBe("");
  });

  it("部署级字段不带 volatile，读出来就是真值（只能走 cordis.patch.yml）", () => {
    const config = asRecord(configSchema({}));
    expect(config["maxUrlLength"]).toBe(2048);
    expect(config["requestTimeoutSeconds"]).toBe(120);
    // 写方法默认关，而且是**裸值**：包成引用的话 `config.allowWriteMethods ? "1" : "0"`
    // 恒走真值那一支，这条安全承诺就永远测不到。
    expect(config["allowWriteMethods"]).toBe(false);
  });
});

describe("volatile 快照", () => {
  it("volatile 字段是引用对象，必须经 .get() 取真值", () => {
    const config = makeConfig();
    // 直接读拿到的是引用本身而不是 boolean —— 这正是要防的写法
    expect(config.fetchEnabled).toBeTypeOf("object");
    expect(snapshotFlags(config).fetch).toBe(true);
  });

  it("引用被改写后快照跟着变（所以不能长期缓存快照）", () => {
    let value = true;
    const config = makeConfig();
    Object.defineProperty(config, "crawlEnabled", { get: () => mkRef(value) });
    expect(snapshotFlags(config).crawl).toBe(true);
    value = false;
    expect(snapshotFlags(config).crawl).toBe(false);
  });
});

describe("工具注册计划", () => {
  it("全开且环境齐备（含 sessionStateDir）时十九个工具全注册", () => {
    const { ready, skipped } = planTools(ALL_ON, FULL_CAPS, true, true, true);
    expect(ready).toHaveLength(19);
    expect(ready).toStrictEqual(TOOL_SPECS.map((spec) => spec.name));
    expect(skipped).toStrictEqual([]);
  });

  it("sessionStateDir 未配置时登录态两只不注册，其余十七个照常", () => {
    // sessionStateDir 留空是出厂状态：sidecar 对这两只一律回 SESSION_STATE_DISABLED，
    // 注册出去就是两只注定失败的工具，所以计划里直接不出现（F4/F11）。
    const plan = planTools(ALL_ON, FULL_CAPS, true);
    expect(plan.ready).toHaveLength(17);
    expect(plan.ready).not.toContain("scrapling_session_state_save");
    expect(plan.ready).not.toContain("scrapling_session_state_load");
    expect(plan.skipped).toStrictEqual([
      { name: "scrapling_session_state_save", reason: "session-state-unavailable" },
      { name: "scrapling_session_state_load", reason: "session-state-unavailable" },
    ]);
  });

  it("用户关掉的工具不注册，原因记为 disabled", () => {
    const plan = planTools({ ...ALL_ON, crawl: false, answer: false }, FULL_CAPS, true, true, true);
    expect(plan.ready).toHaveLength(17);
    expect(plan.skipped).toStrictEqual([
      { name: "scrapling_crawl", reason: "disabled" },
      { name: "scrapling_answer", reason: "disabled" },
    ]);
  });

  it("缺浏览器时不注册四个浏览器类工具，会话与爬虫照常", () => {
    // 依赖 browser 的现在是 render / capture_xhr / session_read / session_act / screenshot；
    // 下载只依赖 scrapling，所以浏览器缺失时照常注册。
    const caps: SidecarCapabilities = { ...FULL_CAPS, browser: false };
    const plan = planTools(ALL_ON, caps, true, true, true);
    expect(plan.ready).toStrictEqual([
      "scrapling_fetch",
      "scrapling_extract",
      "scrapling_locate",
      "scrapling_links",
      "scrapling_session_open",
      "scrapling_session_fetch",
      "scrapling_session_network",
      "scrapling_session_state_save",
      "scrapling_session_state_load",
      "scrapling_session_list",
      "scrapling_session_close",
      "scrapling_crawl",
      "scrapling_answer",
      "scrapling_download",
    ]);
    expect(plan.skipped).toStrictEqual([
      { name: "scrapling_render", reason: BROWSER_MISSING },
      { name: "scrapling_capture_xhr", reason: BROWSER_MISSING },
      { name: "scrapling_session_read", reason: BROWSER_MISSING },
      { name: "scrapling_session_act", reason: BROWSER_MISSING },
      { name: "scrapling_screenshot", reason: BROWSER_MISSING },
    ]);
  });

  it("没有 attachment 服务时截图不注册，其余照常", () => {
    const plan = planTools(ALL_ON, FULL_CAPS, true, false);
    expect(plan.ready).not.toContain("scrapling_screenshot");
    expect(plan.skipped).toContainEqual({
      name: "scrapling_screenshot",
      reason: "attachments-missing",
    });
  });

  it("部署门禁压过卡片开关：动作与下载在门禁关时不注册", () => {
    const config = makeConfig({ allowBrowserActions: false, allowFileDownloads: false });
    const flags = snapshotFlags(config);
    expect(flags.sessionActions).toBe(false);
    expect(flags.download).toBe(false);
    const open = snapshotFlags(makeConfig({ allowBrowserActions: true, allowFileDownloads: true }));
    expect(open.sessionActions).toBe(true);
    expect(open.download).toBe(true);
  });

  it("scrapling 缺失时一个工具都不注册", () => {
    const caps: SidecarCapabilities = { ...FULL_CAPS, scrapling: false };
    const plan = planTools(ALL_ON, caps, true);
    expect(plan.ready).toStrictEqual([]);
    expect(plan.skipped).toHaveLength(TOOL_SPECS.length);
  });

  it("尚未握手成功（capabilities 为 undefined）等价于缺 scrapling", () => {
    const plan = planTools(ALL_ON, undefined, true);
    expect(plan.ready).toStrictEqual([]);
    expect(plan.skipped.every((item) => item.reason === "scrapling-missing")).toBe(true);
  });

  it("全关时 ready 为空、skipped 记满 disabled", () => {
    // 环境全部齐备（含 sessionStateDir），这样每条 skipped 的原因都只剩开关这一维。
    const plan = planTools(ALL_OFF, FULL_CAPS, true, true, true);
    expect(plan.ready).toStrictEqual([]);
    expect(plan.skipped).toHaveLength(TOOL_SPECS.length);
    expect(plan.skipped.every((item) => item.reason === "disabled")).toBe(true);
  });

  it("登记表里的每个开关名都在 ToolFlags 上有对应字段", () => {
    for (const spec of TOOL_SPECS) {
      expect(ALL_ON[spec.flag]).toBeTypeOf("boolean");
    }
  });
});

describe("resolveDataDir", () => {
  it("留空时落到用户主目录下的 .dsh-scrapling", () => {
    expect(resolveDataDir("")).toBe(path.join(os.homedir(), ".dsh-scrapling"));
  });

  it("只由空白字符组成同样走默认", () => {
    expect(resolveDataDir("   ")).toBe(path.join(os.homedir(), ".dsh-scrapling"));
  });

  it("显式配置时解析成绝对路径（相对路径按 cwd 展开）", () => {
    // 用 path.resolve 现造一条本平台上的绝对路径：写死 `/tmp/...` 在 Windows 上会被
    // 解析成 `<当前盘符>:\\tmp\\...`，测的就不是「绝对路径原样返回」了。
    const absolute = path.resolve("scrapling-data");
    expect(resolveDataDir(absolute)).toBe(absolute);
    expect(path.isAbsolute(resolveDataDir("relative-dir"))).toBe(true);
  });
});

describe("每个工具的输出预算各走各的旋钮", () => {
  it("四个抓取面分别取自己的预算，其余工具落到渲染那一档", () => {
    // 这层映射只被 apply() 的注册循环覆盖，而注册取决于运行环境：没有浏览器时
    // scrapling_capture_xhr 不注册，它那一支不会被执行，覆盖率也看不出缺的是哪一段。
    // 直接打这一层，顺带把「共用一份预算等于把三档调节压成一档」这个约定钉住——
    // 用互不相同的数值，串档立刻暴露。
    const config = makeConfig({
      fetchMaxOutputChars: 111,
      extractMaxOutputChars: 222,
      renderMaxOutputChars: 333,
      xhrMaxOutputChars: 444,
    });
    expect(outputBudgetOf(config, "scrapling_fetch")).toBe(111);
    expect(outputBudgetOf(config, "scrapling_extract")).toBe(222);
    expect(outputBudgetOf(config, "scrapling_session_read")).toBe(222);
    // locate / links 只解析调用方给的 HTML，产出与 extract 同档，共用它的预算。
    expect(outputBudgetOf(config, "scrapling_locate")).toBe(222);
    expect(outputBudgetOf(config, "scrapling_links")).toBe(222);
    expect(outputBudgetOf(config, "scrapling_render")).toBe(333);
    expect(outputBudgetOf(config, "scrapling_capture_xhr")).toBe(444);
    // 会话类产出的是句柄与列表而非页面正文，跟渲染同档；爬虫、网络历史与登录态存取同理。
    expect(outputBudgetOf(config, "scrapling_session_list")).toBe(333);
    expect(outputBudgetOf(config, "scrapling_session_network")).toBe(333);
    expect(outputBudgetOf(config, "scrapling_session_state_save")).toBe(333);
    expect(outputBudgetOf(config, "scrapling_crawl")).toBe(333);
  });
});

describe("system prompt 指引段", () => {
  it("全开且工具都在时九段指引都在，只开一条时就只剩一条", () => {
    // 判据是**行数与开关数一一对应**，而不是逐行文本内容：指引写的是给人读的话，措辞会变，
    // 而「关掉一个工具就少一段」这个不变式不会变。
    expect(guidanceFor(ALL_ON, EVERYWHERE).split("\n")).toHaveLength(Object.keys(ALL_ON).length);
    const onlyFetch = guidanceFor({ ...ALL_OFF, fetch: true }, EVERYWHERE);
    expect(onlyFetch.split("\n")).toHaveLength(1);
    expect(onlyFetch).toContain("scrapling_fetch");
  });

  it("全关时文本是空串（README 说的「一并消失」就是这个形状）", () => {
    expect(guidanceFor(ALL_OFF, EVERYWHERE)).toBe("");
  });

  it("开关开着但工具没注册时，那句指引也不说（这是同一个不变式的另一半）", () => {
    // 注册还要过 planTools 的环境要求：没装 Chromium 时 render / capture_xhr 不注册，而
    // Python 起不来（failFastOnMissingPython=false）时**一个都不注册**。只看开关就会给模型
    // 一串点了就报 UNKNOWN_TOOL 的建议 —— 与「少一段指引」是同一种故障的两个方向。
    for (const spec of TOOL_SPECS) {
      const text = guidanceFor(ALL_ON, exceptTool(spec.name));
      expect(text, `${spec.name} 没注册时不该被点名（这是那条降级路径的真实后果）`).not.toContain(
        spec.name,
      );
    }
    // 反向保底：全注册时每一句都在 —— 少了这条，「恒为空串」的实现也能骗过上面那一组断言。
    expect(guidanceFor(ALL_ON, EVERYWHERE).split("\n")).toHaveLength(Object.keys(ALL_ON).length);
  });

  it("指引段按**装配时**的开关与注册状态现取文本，而不是注册那一刻定死", async () => {
    // 这条同时钉四件事：① apply 确实注册了一段；② 文本是**函数**（装配时现取），不是
    // 注册那一刻算好的死字符串 —— 否则设置卡关掉工具，指引不会跟着消失；③ 那段文本问的是
    // ctx.tools.get(名字, 装配 scope)，而不是我们自己攒的注册表；④ ctx.effect 的工厂被宿主
    // 调用过，disposer 真的产出（上游规则「注册即 effect」要求回收路径被验证）。
    SECTIONS.length = 0;
    const factories: (() => unknown)[] = [];
    const tools = toolsStub();
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (): Promise<string> => {
          throw new Error(INTERPRETER_UNUSABLE);
        },
        spawn: (): never => {
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      settings: settingsStub(),
      systemPrompt: promptStub(),
      tools: tools.face,
      effect: (factory: () => unknown): void => {
        factories.push(factory);
      },
    } as unknown as never;
    await apply(
      ctx,
      makeConfig({
        pythonBin: "",
        failFastOnMissingPython: false,
        crawlEnabled: false,
        networkEnabled: false,
      }),
    );

    // settings 那条与 sidecar 回收那条之外，指引段自己也占一个 effect。
    expect(factories.length).toBeGreaterThanOrEqual(3);
    for (const factory of factories) {
      factory();
    }
    const section = SECTIONS.at(-1);
    expect(section?.name).toBe("scrapling-usage");
    expect(section?.text).toBeTypeOf("function");
    const read = (): string => (typeof section?.text === "function" ? section.text({}) : "");

    // 解释器不可用 → 一个工具都没注册 → 指引必须整段为空。这一格以前是「默认档里某两段
    // 关着所以不出现」，而那在注册表为空时同样成立，看不出真正的因果。
    expect(tools.names).toStrictEqual([]);
    expect(read()).toBe("");

    // 注册了几条，指引就只说开关开着的那几条：crawl / network 这两条的开关被显式关掉了，
    // 所以即便有人把它们的工具塞进注册表也不该出现（开关那一半仍然管着）。
    tools.names.push(
      "scrapling_fetch",
      "scrapling_render",
      "scrapling_crawl",
      "scrapling_session_network",
    );
    const text = read();
    expect(text).toContain("scrapling_fetch");
    expect(text).toContain("scrapling_render");
    expect(text).not.toContain("scrapling_crawl");
    expect(text).not.toContain("scrapling_session_network");
  });
});

describe("apply", () => {
  it("数据目录建不出来时默认拒绝加载（failFast），不去 spawn", async () => {
    let spawned = 0;
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (): Promise<string> => "python3",
        spawn: (): never => {
          spawned += 1;
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      settings: settingsStub(),
      systemPrompt: promptStub(),
      effect: (): void => undefined,
    } as unknown as never;
    // 指向一个不可能建出来的路径：父级是文件而不是目录。`/dev/null/impossible` 只在
    // POSIX 上成立——Windows 会把它解析成 `<盘符>:\dev\null\impossible` 并真的建出来，
    // 于是这条测的成了「建得出来」。父级是文件这一条在两边都必失败。
    // 目录建不出来 = sidecar 的 cwd 必然 ENOENT，跟「解释器起不来」同一档：failFast
    // 默认开着，所以拒绝加载而不是静默降级成「设置卡能开、工具一个没有」的空壳。
    const holder = mkdtempSync(path.join(os.tmpdir(), "dsh-blocked-"));
    const blocker = path.join(holder, "blocker");
    writeFileSync(blocker, "");
    const dataDir = path.join(blocker, "impossible");
    try {
      await expect(apply(ctx, makeConfig({ dataDir }))).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      expect(spawned).toBe(0);
    } finally {
      rmSync(path.dirname(blocker), { recursive: true, force: true });
    }
  });

  it("数据目录建不出来且 failFast 关着时，warn 里点名 dataDir 并提前返回", async () => {
    const warnings: string[] = [];
    let spawned = 0;
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (): Promise<string> => "python3",
        spawn: (): never => {
          spawned += 1;
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (line: string): void => {
          warnings.push(line);
        },
        debug: (): void => undefined,
      },
      settings: settingsStub(),
      systemPrompt: promptStub(),
      effect: (): void => undefined,
    } as unknown as never;
    const holder = mkdtempSync(path.join(os.tmpdir(), "dsh-blocked-"));
    const blocker = path.join(holder, "blocker");
    writeFileSync(blocker, "");
    const dataDir = path.join(blocker, "impossible");
    try {
      await apply(ctx, makeConfig({ dataDir, failFastOnMissingPython: false }));
      expect(spawned).toBe(0);
      // 死因是目录，不是 sidecar：文案必须点名 dataDir 与具体路径，把排查引向正确的设置项。
      expect(warnings.some((line) => line.includes("dataDir") && line.includes(dataDir))).toBe(
        true,
      );
      expect(warnings.some((line) => line.includes("未能启动"))).toBe(false);
    } finally {
      rmSync(path.dirname(blocker), { recursive: true, force: true });
    }
  });

  it("pythonBin 留空且没有托管 runtime 时用仓内 venv 的绝对路径", async () => {
    const resolved: string[] = [];
    // dataDir 必须显式给一个空目录：托管 runtime 只从 dataDir 里探，缺省会落到这台机器真实的
    // ~/.dsh-scrapling。装过能力包的机器上那里有托管 Python，解析会走 managed（D13 的优先级是
    // 显式 → 托管 → 仓内 → PATH），这条用例就随机器状态红绿。这里要验的是「没有托管时落仓内」。
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "dsh-python-default-"));
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => {
          resolved.push(command);
          throw new Error(INTERPRETER_UNUSABLE);
        },
        spawn: (): never => {
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      settings: settingsStub(),
      systemPrompt: promptStub(),
      effect: (): void => undefined,
    } as unknown as never;
    // failFastOnMissingPython 默认 true：Python 起不来就拒绝加载，不静默降级成
    // 「所有工具不可用」——后者会让模型几轮之后才发现工具全没了。
    try {
      await expect(apply(ctx, makeConfig({ pythonBin: "", dataDir }))).rejects.toThrow(
        INTERPRETER_UNUSABLE,
      );
      // 留空不再等于 PATH 上的名字：没有托管 runtime 时仓内 venv 的解释器可用就用它。用同一份
      // 解析器算出期望值之外的**独立**判据：这条路必须指向包根下的 venv，而不是 PATH 上的名字。
      expect(resolved).toStrictEqual([LOCAL_PYTHON]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("failFastOnMissingPython=false 时探测失败只 warn，降级为工具全不可用", async () => {
    // 同一条理由：显式空 dataDir，避开这台机器 ~/.dsh-scrapling 里的托管 runtime。
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "dsh-python-warn-"));
    const warnings: string[] = [];
    const infos: string[] = [];
    const logger = {
      info: (line: string): void => {
        infos.push(line);
      },
      warn: (line: string): void => {
        warnings.push(line);
      },
      debug: (): void => undefined,
    };
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (): Promise<string> => {
          throw new Error(INTERPRETER_UNUSABLE);
        },
        spawn: (): never => {
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger,
      settings: settingsStub(),
      systemPrompt: promptStub(),
      effect: (): void => undefined,
    } as unknown as never;
    try {
      await expect(
        apply(ctx, makeConfig({ pythonBin: "", failFastOnMissingPython: false, dataDir })),
      ).resolves.toBeUndefined();
      expect(warnings.some((line) => line.includes("未能启动"))).toBe(true);
      // 选中哪支解释器必须每次都播报：这是「工具全没了」时唯一能对照的线索。
      expect(infos.some((line) => line.includes("[dsh-scrapling] Python 解释器："))).toBe(true);
      // 缺 Scrapling 时那条 warn 要点名解释器路径。这里写的是一条**独立的**事实：本仓
      // venv 的解释器就在包根下，所以这条文案必须带它，而不是带一个泛称。
      expect(
        warnings.some((line) => line.includes(LOCAL_PYTHON) && line.includes("Scrapling")),
      ).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("venv 存在但不可执行时落回 PATH；显式配置压过两者", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dsh-python-choice-"));
    const venvBin = path.join(root, "_env", ".venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    writeFileSync(path.join(venvBin, "python"), "#!/bin/sh\nexit 0\n");

    // 可执行位是判据本身：文件在但跑不起来属于坏掉的机器本地态，跟着它走会把整轮测量带崩。
    // `writeFileSync` 落盘是 0644，所以先显式立起可执行位，这一档才是在判「文件在且能跑」。
    chmodSync(path.join(venvBin, "python"), 0o755);
    expect(resolvePythonBin("", root)).toStrictEqual({
      path: path.join(venvBin, "python"),
      via: "_env/.venv",
    });
    chmodSync(path.join(venvBin, "python"), 0o644);
    expect(resolvePythonBin("", root)).toStrictEqual({ path: "python3", via: "PATH" });
    expect(resolvePythonBin("", path.join(root, "absent"))).toStrictEqual({
      path: "python3",
      via: "PATH",
    });
    expect(resolvePythonBin("  /opt/py/bin/python3  ", root)).toStrictEqual({
      path: "/opt/py/bin/python3",
      via: "configured",
    });
  });

  it.runIf(process.platform === "win32")("win32 没有可执行位，venv 文件在就被选中", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dsh-python-choice-"));
    const venvBin = path.join(root, "_env", ".venv", "Scripts");
    const exe = "python.exe";
    mkdirSync(venvBin, { recursive: true });
    writeFileSync(path.join(venvBin, exe), "");

    expect(resolvePythonBin("", root)).toStrictEqual({
      path: path.join(venvBin, exe),
      via: "_env/.venv",
    });
    expect(resolvePythonBin("", path.join(root, "absent"))).toStrictEqual({
      path: exe,
      via: "PATH",
    });
    const configured = String.raw`C:\py\python.exe`;
    expect(resolvePythonBin(`  ${configured}  `, root)).toStrictEqual({
      path: configured,
      via: "configured",
    });
  });

  it("写方法这一档作为明确表态送到 Python 侧（两侧各判一次的前提）", async () => {
    // 关着的时候 Host 不给参数面，Python 那边还得独立硬拒一次；这一条钉的是两侧读到
    // **同一份**表态。给 "0" 而不是留空：留空时「部署显式关」与「忘了配」在进程环境里
    // 长得一模一样，而 Python 的默认恰好也是关 —— 那种巧合最难查。
    const seen: Record<string, string | undefined>[] = [];

    /**
     * 造一个只把 spawn 的 spec.env 记下来的假 ctx。
     *
     * @returns 可直接交给 apply 的 ctx
     */
    function capturingCtx(): never {
      return {
        get: (): undefined => undefined,
        subprocess: {
          resolveExecutable: async (command: string): Promise<string> => command,
          spawn: (spec: { env?: Record<string, string> }): unknown => {
            seen.push(spec.env ?? {});
            return {
              stdin: new PassThrough(),
              stdout: new PassThrough(),
              stderr: new PassThrough(),
              // 立刻"退出"：握手由 5ms 的超时先裁掉，这里要的是别留一个永不落定的 promise。
              done: Promise.resolve({ exitCode: null, signal: null }),
              terminate: (): void => undefined,
              waitForExit: async (): Promise<boolean> => true,
            };
          },
        },
        logger: {
          info: (): void => undefined,
          warn: (): void => undefined,
          debug: (): void => undefined,
        },
        tools: { register: (): (() => void) => (): void => undefined },
        settings: settingsStub(),
        systemPrompt: promptStub(),
        effect: (): void => undefined,
      } as unknown as never;
    }

    /**
     * 跑一次 apply，取送回 sidecar 的那一枚环境变量。
     *
     * @param allowWriteMethods - 这一档部署的表态
     * @returns 送过去的环境变量值
     */
    async function sentFlag(allowWriteMethods: boolean): Promise<string | undefined> {
      seen.length = 0;
      await apply(
        capturingCtx(),
        makeConfig({
          pythonBin: "python3",
          failFastOnMissingPython: false,
          sidecarHandshakeTimeoutMs: 5,
          allowWriteMethods,
        }),
      );
      return seen[0]?.["DSH_SCRAPLING_ALLOW_WRITE_METHODS"];
    }

    await expect(sentFlag(true), "开放写方法时要送明确的表态").resolves.toBe("1");
    await expect(
      sentFlag(false),
      "关着时也要送明确的表态，而不是留空 —— 留空与「忘了配」在进程环境里读起来一样",
    ).resolves.toBe("0");
  });

  it.runIf(HAS_LOCAL_PYTHON)("真的拉起 sidecar 时能走通握手与注册计划", async () => {
    const python = LOCAL_PYTHON;
    const warnings: string[] = [];
    const infos: string[] = [];
    const disposers: (() => unknown)[] = [];
    const settingsRegistrations: string[] = [];
    const registered: string[] = [];
    const jobsStub = {
      // 这条验的是「全能力时 19 个工具全注册」，所以作业后端要报可用；
      // 探测作业（kind='probe'）照实回一个 id。
      start: (): string => "probe-job",
      // 本包起作业时自己挂 controller（见 startUnderCrawlController）。
      attachController: (): (() => void) => (): void => undefined,
    };
    const ctx = {
      get: (service: string): unknown => (service === "jobs" ? jobsStub : undefined),
      subprocess: {
        // 官方实现会校验可执行文件存在（SubprocessExecutableNotFoundError），这里照做：
        // 否则会拿一个不存在的解释器去 spawn，而 ENOENT 是异步事件，try/catch 抓不到。
        resolveExecutable: async (command: string): Promise<string> => {
          if (!existsSync(command)) {
            throw new Error(`executable not found: ${command}`);
          }
          return command;
        },
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
      logger: {
        info: (line: string): void => {
          infos.push(line);
        },
        warn: (line: string): void => {
          warnings.push(line);
        },
        debug: (): void => undefined,
      },
      // 只记名字，不真的进注册表 —— 这里验的是「apply 打算注册哪些」。
      tools: {
        register: (definition: { name: string }): (() => void) => {
          registered.push(definition.name);
          return (): void => undefined;
        },
      },
      // ctx.effect 收的是**工厂**：宿主会调用它拿到真正的 disposer 再登记。
      // 早先这里把工厂直接当 disposer 存下，于是真正的清理函数一次都没跑过 ——
      // 断言「disposers 有 2 条」照样通过，回收路径却完全没被验证。
      settings: settingsStub(settingsRegistrations),
      systemPrompt: promptStub(),
      effect: (factory: () => () => unknown): void => {
        disposers.push(factory());
      },
    } as unknown as never;

    // 先探一次能力：注册结果依赖环境里到底有没有浏览器，断言要跟着环境走，
    // 而不是把「这台机器装了什么」写死进期望值。
    const probe = new SidecarClient(ctx, {
      pythonBin: python,
      bridgePath: path.resolve(import.meta.dirname, "../py/bridge.py"),
      cwd: os.tmpdir(),
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      graceMs: 5000,
    });
    const caps = await probe.ensureStarted();
    await probe.dispose();

    // 这一格不验 provider 注册（那条由「接管 ctx.web 的两个接缝」那组负责），而夹具里
    // 也没有 ctx.web 面，所以把默认开着的两个 provider 显式关掉，免得 apply 在半路抛。
    await apply(
      ctx,
      makeConfig({ pythonBin: python, provideWebFetch: false, provideWebSearch: false }),
    );
    // 握手成功后必然打出注册计划这一行。
    expect(infos.some((line) => line.includes("注册"))).toBe(true);
    // 真正注册上去的 =「静态四条」+「会话五条」+「爬虫一条」+「问答一条」+（浏览器可用时的两条）。
    // 这里 makeConfig 没配 sessionStateDir，登录态存取两只按设计不注册（F4/F11）。
    const sessionTools = [
      "scrapling_session_open",
      "scrapling_session_fetch",
      "scrapling_session_network",
      "scrapling_session_list",
      "scrapling_session_close",
    ];
    const expected = caps.browser
      ? [
          "scrapling_fetch",
          "scrapling_extract",
          "scrapling_locate",
          "scrapling_links",
          "scrapling_render",
          "scrapling_capture_xhr",
          ...sessionTools,
          "scrapling_crawl",
          "scrapling_answer",
          "scrapling_session_read",
        ]
      : [
          "scrapling_fetch",
          "scrapling_extract",
          "scrapling_locate",
          "scrapling_links",
          ...sessionTools,
          "scrapling_crawl",
          "scrapling_answer",
        ];
    expect(registered).toStrictEqual(expected);

    // 再跑一次「全部关掉」：ready 为空时日志要落到 (none) 分支。
    infos.length = 0;
    registered.length = 0;
    await apply(
      ctx,
      makeConfig({
        pythonBin: python,
        provideWebFetch: false,
        provideWebSearch: false,
        fetchEnabled: false,
        extractEnabled: false,
        locateEnabled: false,
        linksEnabled: false,
        renderEnabled: false,
        captureXhrEnabled: false,
        networkEnabled: false,
        sessionEnabled: false,
        sessionStateEnabled: false,
        crawlEnabled: false,
        answerEnabled: false,
        sessionReadEnabled: false,
        sessionActionsEnabled: false,
        downloadEnabled: false,
        screenshotEnabled: false,
      }),
    );
    expect(infos.some((line) => line.includes("(none)"))).toBe(true);
    expect(registered).toStrictEqual([]);
    // 两次 apply，每次登记三个 disposer：「这一页由自带卡片编辑」的页面策略、sidecar 回收，
    // 以及 system prompt 指引段 —— 注册就是 effect，回收路径也要被数到。
    expect(disposers).toHaveLength(6);
    expect(settingsRegistrations).toStrictEqual(["false", "false"]);
    // 卸载插件要能回收进程 —— disposer 把 promise 交回来，宿主会 await 它。
    await Promise.all(disposers.map((disposer) => disposer()));
  });
});

/**
 * 造一份只把 append 记进数组的爬虫出口。
 *
 * @param out - 收到的文本
 * @returns 出口
 */
function recordingSink(out: string[]): CrawlSink {
  return {
    append: (text): void => {
      out.push(text);
    },
    progress: (): void => undefined,
    signal: new AbortController().signal,
  };
}

describe("爬虫事件路由", () => {
  it("按 crawlId 交给各自的作业；未登记与已清掉的帧都丢掉", () => {
    // 两只蜘蛛并行（py/crawl.py 的 MAX_CONCURRENT_CRAWLS 是 2）时，单槽位会把一只的
    // 进度写进另一只的输出。这里钉的是「归属只看 crawlId」。
    const outA: string[] = [];
    const outB: string[] = [];
    const sinkA = recordingSink(outA);
    const sinkB = recordingSink(outB);
    const router = createCrawlEventRouter();
    router.route("c1", "before-register");
    router.register("c1", sinkA);
    router.register("c2", sinkB);
    router.route("c1", "a-1");
    router.route("c2", "b-1");
    router.forget(sinkA);
    router.route("c1", "after-forget");
    router.route("c2", "b-2");
    expect(outA).toStrictEqual(["a-1\n"]);
    expect(outB).toStrictEqual(["b-1\n", "b-2\n"]);
  });
});

/** 端到端用例里用来判定「爬到了第二页」的标记。 */
const LEAF_MARK = "Leaf Page";
const ROOT_MARK = "Root Page";

/** 爬虫用例用的设置：极小预算，让断言跑得快。 */
const CRAWL_SETTINGS = {
  extractionType: "markdown",
  mainContentOnly: true,
  maxOutputBytes: 4000,
  timeoutMs: 30_000,
  headless: true,
  networkIdle: false,
  pageTimeoutMs: 30_000,
  waitSelectorState: "attached" as const,
  pierceShadow: false,
  requestTimeoutSeconds: 120,
  blockAds: false,
  crawlMaxItems: 10,
  // 爬虫用例跑本地站点，几十毫秒就结束；给一个宽到不会误触发的截止即可。
  crawlMaxRuntimeSeconds: 600,
  browserExecutablePath: "",
  browserCdpUrl: "",
  browserInitScript: "",
  browserRealChrome: false,
  browserDnsOverHttps: false,
  recordRequests: false,
  maxRecordedRequests: 100,
  sessionStateDir: "",
  adaptiveStorage: "sqlite",
  redisUrl: "redis://127.0.0.1:6379/0",
  crawlRespectRobots: false,
  crawlDownloadDelayMs: 0,
  crawlConcurrentRequests: 4,
  crawlAutothrottle: false,
  crawlStrategy: "bfs" as const,
  crawlCheckpointDir: "",
  // 爬虫这一组与写方法无关，按 schema 默认档给关：夹具跟着默认走，才不至于把闸门开着
  // 这件事悄悄当成前提。
  allowWriteMethods: false,
  stripInlineImages: true,
  downloadDir: "/tmp/scrapling-downloads",
  downloadMaxBytes: 10_000_000,
} satisfies ToolSettings;

/**
 * 造一个「一次 crawl.run + 一次 crawl.status 就结束」的假 sidecar。
 *
 * @returns 假 sidecar 客户端
 */
function fakeSidecarForCrawl(): { client: SidecarClient } {
  const replies: Record<string, unknown> = {
    "crawl.run": { crawlId: "c1" },
    "crawl.status": {
      running: false,
      error: null,
      pages: [
        { url: "http://a.test/", title: "A", markdown: "# A" },
        { url: "http://a.test/b", title: "B", markdown: "# B" },
      ],
    },
  };
  const client = new SidecarClient({} as never, {
    pythonBin: "python3",
    bridgePath: "bridge.py",
    cwd: ".",
    handshakeTimeoutMs: 10,
    requestTimeoutMs: 10,
    graceMs: 10,
  });
  Object.assign(client, {
    call: async (method: string): Promise<unknown> => replies[method] ?? {},
  });
  return { client };
}

/**
 * 造一份带作业句柄的 ToolDeps，并让作业主体真的跑起来。
 *
 * @param sink - 记录输出与进度的数组
 * @param jobHandle - 作业句柄的替身
 * @returns 可直接喂给 createCrawlTool 的依赖
 */
function createCrawlToolDeps(sink: {
  appended: string[];
  progressed: string[];
  jobHandle: { append: (text: string) => void; updateProgress: (line: string) => void };
}): ToolDeps {
  const fake = fakeSidecarForCrawl();
  return {
    sidecar: fake.client,
    settings: CRAWL_SETTINGS,
    startCrawlJob: async (_label, run) => {
      const job = sink.jobHandle;
      // 同步跑完主体再返回 id，模拟 ctx.jobs.start 里「登记后立刻返回」的形状。
      await run({
        append: job.append,
        progress: job.updateProgress,
        signal: new AbortController().signal,
      });
      return CRAWL_JOB_ID;
    },
    answer: async (): Promise<AnswerResult> => ({
      answer: "unused",
      provider: "unused",
      model: "unused",
    }),
  };
}

describe("apply 的爬虫作业接线", () => {
  it.runIf(HAS_LOCAL_PYTHON)("crawl 开关打开时会注册爬虫工具，并起一个 ctx.jobs 作业", async () => {
    const python = LOCAL_PYTHON;
    const appended: string[] = [];
    const progressed: string[] = [];
    let spec:
      | { run?: (job: unknown) => { cancel: () => void; done: Promise<unknown> } }
      | undefined;
    const jobsStub = {
      // 只记真实作业：`scrapling` 在 apply 时先起一个 kind='probe' 的空作业探测后端，
      // 那是能力探测，不是被测的接线。夹具据此分流，否则 spec 会被探测覆盖。
      attachController: (): (() => void) => (): void => undefined,
      start: (received: { kind?: string }): string => {
        if (received.kind !== "probe") {
          spec = received as typeof spec;
        }
        return CRAWL_JOB_ID;
      },
    };
    const ctx = {
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (): never => {
          throw new Error("no real spawn here");
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      tools: { register: (): (() => void) => (): void => undefined },
      settings: settingsStub(),
      systemPrompt: promptStub(),
      effect: (): void => undefined,
      // 可选服务按文档用 ctx.get(name) 取，所以夹具要同时提供 get 与 jobs。
      get: (service: string): unknown => (service === "jobs" ? jobsStub : undefined),
      jobs: jobsStub,
    } as unknown as never;

    await apply(
      ctx,
      makeConfig({ pythonBin: python, crawlEnabled: true, failFastOnMissingPython: false }),
    );
    // failFastOnMissingPython=false 时 sidecar 起不来（spawn 被拒）crawl 工具照样注册 ——
    // 它只是返回作业 id，真正的抓取发生在作业里，所以「探不到 python」不该影响工具面。
    expect(spec).toBeUndefined();

    // 直接驱动作业主体：这段代码在 apply 里通过 startJob 闭包挂到 ctx.jobs 上。
    const crawlDeps = createCrawlToolDeps({
      appended,
      progressed,
      jobHandle: {
        append: (text: string): void => {
          appended.push(text);
        },
        updateProgress: (line: string): void => {
          progressed.push(line);
        },
      },
    });
    const tool = createCrawlTool(crawlDeps);
    const result = (await tool.execute({ url: UNREACHABLE, maxPages: 2 }, {
      signal: new AbortController().signal,
    } as never)) as { jobId: string };
    expect(result.jobId).toBe(CRAWL_JOB_ID);
    expect(appended.length).toBeGreaterThan(0);
    expect(progressed.length).toBeGreaterThan(0);
  });
});

/**
 * 等作业输出环里出现某个标记，最多等 timeoutMs。
 *
 * @param output - 输出环的替身
 * @param marker - 要等到的标记
 * @param timeoutMs - 上限
 */
async function waitFor(check: () => boolean, remaining = 10_000): Promise<void> {
  if (check() || remaining <= 0) {
    return;
  }
  await sleep(50);
  await waitFor(check, remaining - 50);
}

async function waitForOutput(output: string[], marker: string, remaining = 30_000): Promise<void> {
  const seen = output.some((text) => text.includes(marker));
  if (seen || remaining <= 0) {
    return;
  }
  await sleep(200);
  await waitForOutput(output, marker, remaining - 200);
}

/**
 * 起一个两页、带出链的本地站点 —— 爬虫需要至少两页才能证明它真的跟了链接。
 *
 * @returns 起始 URL 与关闭函数
 */
async function startCrawlSite(): Promise<{ base: string; close: () => Promise<void> }> {
  const root = Buffer.from(
    "<!doctype html><html><head><title>Root</title></head><body><h1>Root Page</h1><a href='/b.html'>to B</a></body></html>",
  );
  const leaf = Buffer.from(
    "<!doctype html><html><head><title>Leaf</title></head><body><h1>Leaf Page</h1></body></html>",
  );
  const server = createServer((req, res) => {
    const body = req.url === "/b.html" ? leaf : root;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
    });
    res.end(body);
  });
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

describe("apply 到爬虫作业的完整链路", () => {
  it.runIf(HAS_LOCAL_PYTHON)("注册的工具真能把爬虫挂到 ctx.jobs 上并产出页面", async () => {
    const python = LOCAL_PYTHON;
    const site = await startCrawlSite();
    const registered = new Map<string, { execute?: (args: unknown, run: unknown) => unknown }>();
    const output: string[] = [];
    const progress: string[] = [];

    // 可选服务按文档用 ctx.get(name) 取，夹具要同时给 get 与 jobs。
    const jobsStub = {
      attachController: (): (() => void) => (): void => undefined,
      start: (spec: {
        kind?: string;
        run: (job: { append: (text: string) => void; updateProgress: (line: string) => void }) => {
          cancel: () => void;
          done: Promise<unknown>;
        };
      }): string => {
        // 能力探测那个空作业不跑、也不写输出环（见上面第一处夹具的同一说明）。
        if (spec.kind === "probe") {
          return "probe-job";
        }
        const job = {
          append: (text: string): void => {
            output.push(text);
          },
          updateProgress: (line: string): void => {
            progress.push(line);
          },
        };
        void spec.run(job).done;
        return CRAWL_JOB_ID;
      },
    };

    const ctx = {
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
          const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
            cwd: spec.cwd,
            env: {
              ...process.env,
              DSH_SCRAPLING_ALLOWED_HOSTS: LOOPBACK_ALLOWLIST,
              ...spec.env,
            },
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
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      tools: {
        register: (definition: { name: string }): (() => void) => {
          registered.set(definition.name, definition as never);
          return (): void => undefined;
        },
      },
      settings: settingsStub(),
      systemPrompt: promptStub(),
      effect: (): void => undefined,
      get: (service: string): unknown => (service === "jobs" ? jobsStub : undefined),
      jobs: jobsStub,
    } as unknown as never;

    try {
      await apply(
        ctx,
        makeConfig({
          pythonBin: python,
          crawlEnabled: true,
          failFastOnMissingPython: false,
          // 夹具没有 ctx.web 面：把默认开着的两个 provider 关掉，免得 apply 在半路抛。
          provideWebFetch: false,
          provideWebSearch: false,
          // 本地测试站点在回环地址上：与 Python 侧同一份放行设置，Host 侧闸门才放得过。
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      const crawlTool = registered.get("scrapling_crawl");
      if (crawlTool?.execute === undefined) {
        throw new Error(NOT_REGISTERED);
      }
      await crawlTool.execute(
        { url: site.base, maxPages: 3 },
        { signal: new AbortController().signal },
      );

      // 作业是异步跑的，给它一点时间把页面写进输出环。
      // 作业是异步跑的；这里只等一小段时间把结果凑齐，不是长期轮询。
      await waitForOutput(output, "Leaf Page");
      expect(output.some((text) => text.includes(ROOT_MARK))).toBe(true);
      expect(output.some((text) => text.includes(LEAF_MARK))).toBe(true);
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      await site.close();
    }
  });
});

/** 爬虫作业接线测试里共用的一份宿主替身。 */
interface JobHarness {
  /** 宿主上下文。 */
  ctx: never;
  /** 已注册的工具，按名字索引。 */
  tools: Map<string, { execute?: (args: unknown, run: unknown) => unknown }>;
  /** 最近一次 ctx.jobs.start 拿到的 hooks。 */
  hooks: { cancel: () => void; done: Promise<unknown> } | undefined;
  /** 子进程被拆掉的次数。 */
  terminated: () => number;
  /** 注册到 ctx.web 的 provider，按接缝分。 */
  webProviders: { fetch: string[]; search: string[] };
  /** 拆掉夹具自己起的 sidecar，免得拖到进程退出。 */
  dispose: () => void;
}

/**
 * 造一份能真拉起 sidecar 的宿主替身，并把作业 hooks 暴露出来。
 *
 * @returns 替身
 */
function makeJobHarness({ withoutJobs = false }: { withoutJobs?: boolean } = {}): JobHarness {
  const tools = new Map<string, { execute?: (args: unknown, run: unknown) => unknown }>();
  const state: {
    hooks?: { cancel: () => void; done: Promise<unknown> };
    terminated: number;
    output: string[];
    progress: string[];
  } = { terminated: 0, output: [], progress: [] };
  const disposers: (() => unknown)[] = [];
  const webProviders: { fetch: string[]; search: string[] } = { fetch: [], search: [] };
  // 可选服务按文档用 ctx.get(name) 取，夹具要同时给 get 与 jobs。
  //
  // 这个夹具**复刻真实注册表的闸门**：没有 controller 附着时 start 抛
  // 「no job controller serves this agent」。原先的夹具让 start 无条件成功，于是
  // 「宿主平面的 tool-jobs 被 disabled」这一态在测试里根本不存在 —— 那正是
  // scrapling_crawl 在真实 profile 里必挂而 57 条用例全绿的原因。
  let attachDepth = 0;
  const jobsStub = {
    attachController: (): (() => void) => {
      attachDepth += 1;
      return (): void => {
        attachDepth -= 1;
      };
    },
    start: (spec: {
      run: (job: { append: (text: string) => void; updateProgress: (line: string) => void }) => {
        cancel: () => void;
        done: Promise<unknown>;
      };
    }): string => {
      if (attachDepth === 0) {
        throw new Error(
          "background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)",
        );
      }
      const job = { append: (): void => undefined, updateProgress: (): void => undefined };
      state.hooks = spec.run(job);
      return CRAWL_JOB_ID;
    },
  };
  const ctx = {
    subprocess: {
      resolveExecutable: async (command: string): Promise<string> => command,
      spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
        const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
          cwd: spec.cwd,
          env: { ...process.env, DSH_SCRAPLING_ALLOWED_HOSTS: LOOPBACK_ALLOWLIST, ...spec.env },
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
            state.terminated += 1;
            child.kill("SIGTERM");
          },
          waitForExit: async (): Promise<boolean> => true,
        };
      },
    },
    logger: {
      info: (): void => undefined,
      warn: (): void => undefined,
      debug: (): void => undefined,
    },
    tools: {
      register: (definition: { name: string }): (() => void) => {
        tools.set(definition.name, definition as never);
        return (): void => undefined;
      },
    },
    // ctx.effect 收的是**工厂**：宿主会调用它拿到真正的 disposer 再登记。
    settings: settingsStub(),
    systemPrompt: promptStub(),
    effect: (factory: () => () => unknown): void => {
      disposers.push(factory());
    },
    // withoutJobs 模拟「这个 profile 没装作业后端」：可选服务按文档用 ctx.get(name) 取，
    // 取不到就是 undefined，生产代码据此给出可读错误。
    web: {
      registerFetchProvider: (provider: { id: string }): (() => void) => {
        webProviders.fetch.push(provider.id);
        return (): void => undefined;
      },
      registerSearchProvider: (provider: { id: string }): (() => void) => {
        webProviders.search.push(provider.id);
        return (): void => undefined;
      },
    },
    get: (service: string): unknown => (withoutJobs || service !== "jobs" ? undefined : jobsStub),
    jobs: jobsStub,
  } as unknown as never;
  return {
    ctx,
    tools,
    webProviders,
    dispose: (): void => {
      for (const disposeOne of disposers) {
        disposeOne();
      }
    },
    get hooks(): { cancel: () => void; done: Promise<unknown> } | undefined {
      return state.hooks;
    },
    terminated: (): number => state.terminated,
  };
}

/**
 * 起一个「接连接但永不回响应」的站点。
 *
 * 爬虫会一直卡在第一次请求上，作业也就一直挂着 —— 正好用来测取消：
 * 作业跑得快的站点在 cancel 打上去之前就结束了，什么都测不到。
 *
 * @returns 起始 URL 与关闭函数
 */
async function startStallingSite(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    // 故意什么都不写：连接保持着，响应永远不来。
    void res;
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}/`,
    close: async (): Promise<void> => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, "close");
    },
  };
}

describe("crawlFailureDetail：作业结算行的错误文案（J9）", () => {
  it("sidecar 错误把码放最前面", () => {
    expect(crawlFailureDetail(new SidecarError("BAD_ARGS", "maxPages must be positive"))).toBe(
      "BAD_ARGS: maxPages must be positive",
    );
  });

  it("消息里已带过码时不重复拼（F18：Python 侧有时已拼前缀）", () => {
    expect(crawlFailureDetail(new SidecarError("BAD_ARGS", "BAD_ARGS: too many pages"))).toBe(
      "BAD_ARGS: too many pages",
    );
  });

  it("非 sidecar 错误原样保留，不编假码", () => {
    expect(crawlFailureDetail(new Error("jobs backend vanished"))).toBe(
      "Error: jobs backend vanished",
    );
  });
});

describe("爬虫作业的取消与失败", () => {
  it.runIf(HAS_LOCAL_PYTHON)(
    "profile 没有作业后端时报可读错，而不是走到一半抛未捕获异常",
    async () => {
      // 没有作业后端时**根本不注册** scrapling_crawl：注册一个必然失败的工具等于让模型
      // 白烧一轮。这条替换掉旧断言「注册后调用报 JOBS_UNAVAILABLE」——那是在测一个
      // 本该不存在的状态。
      const harness = makeJobHarness({ withoutJobs: true });
      try {
        await apply(
          harness.ctx,
          makeConfig({
            pythonBin: LOCAL_PYTHON,
            crawlEnabled: true,
            failFastOnMissingPython: false,
          }),
        );
        expect(
          harness.tools.get("scrapling_crawl"),
          "没有作业后端时不该注册 scrapling_crawl",
        ).toBeUndefined();
        // 其余十二个照常注册：缺的只是作业那一个。
        expect(harness.tools.get("scrapling_fetch")).toBeDefined();
      } finally {
        harness.dispose();
      }
    },
  );

  it.runIf(HAS_LOCAL_PYTHON)("取消会让爬虫真的停下来，作业落定为 killed", async () => {
    const harness = makeJobHarness();
    await apply(
      harness.ctx,
      makeConfig({
        pythonBin: LOCAL_PYTHON,
        crawlEnabled: true,
        // 本地测试站点在回环地址上：与 Python 侧同一份放行设置，Host 侧闸门才放得过。
        allowedHosts: LOOPBACK_ALLOWLIST,
      }),
    );
    const tool = harness.tools.get("scrapling_crawl");
    if (tool?.execute === undefined) {
      throw new Error(NOT_REGISTERED);
    }
    // 用一个「接连接但永不回响应」的站点把爬虫拖住：跑得快的站点在 cancel 打上去
    // 之前就结束了，那样什么都测不到。
    const stalling = await startStallingSite();
    try {
      void tool.execute(
        { url: stalling.base, maxPages: 2 },
        { signal: new AbortController().signal },
      );
      await waitFor(() => harness.hooks !== undefined);
      expect(harness.hooks).toBeDefined();
      await sleep(500);
      harness.hooks?.cancel();
      const outcome = (await harness.hooks?.done) as { status: string };
      // 信号传对了的话，取消会让 sidecar 调用中止、作业主体抛错，最终落成 killed。
      expect(outcome.status).toBe("killed");
      // teardown 是 fire-and-forget：done 先落定、terminate 随后才到，所以要等。
      await waitFor(() => harness.terminated() > 0);
    } finally {
      await stalling.close();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)("爬虫报错时作业以 failed 结算，码与原因写进 detail", async () => {
    const harness = makeJobHarness();
    await apply(
      harness.ctx,
      makeConfig({
        pythonBin: LOCAL_PYTHON,
        crawlEnabled: true,
        // 本地测试站点在回环地址上：与 Python 侧同一份放行设置，Host 侧闸门才放得过。
        allowedHosts: LOOPBACK_ALLOWLIST,
      }),
    );
    const tool = harness.tools.get("scrapling_crawl");
    if (tool?.execute === undefined) {
      throw new Error(NOT_REGISTERED);
    }
    // maxPages=0 会被 sidecar 当参数错误拒掉，于是作业主体必然抛错。
    // 用参数错误而不是网络故障：爬一个连不上的站点**不会失败** ——
    // spider 收 0 页就正常结束，那条路径给的是 completed。
    await tool.execute({ url: UNREACHABLE, maxPages: 0 }, { signal: new AbortController().signal });
    await waitFor(() => harness.hooks !== undefined);
    const outcome = (await harness.hooks?.done) as { status: string; detail: string };
    // 「它自己断了」不是取消：状态必须是 failed，且 detail 带 sidecar 的错误码（J9）。
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("BAD_ARGS");
    expect(outcome.detail).toContain("positive integer");
  });

  it("注册之后作业后端消失：crawl 给出可读的 JOBS_UNAVAILABLE（防御分支）", async () => {
    // 正常情况下 planTools 已经不会注册 crawl（后端不可用就跳过）。这一支覆盖的是
    // **注册之后**后端被卸载的窗口：那时工具还在，但 ctx.get("jobs") 已经取不到。
    // 判据只看错误码与可读文案，不关心用户该改什么配置——那一步在注册期就处理完了。
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({ pythonBin: LOCAL_PYTHON, crawlEnabled: true, failFastOnMissingPython: false }),
      );
      const crawl = harness.tools.get("scrapling_crawl");
      expect(crawl?.execute, "后端可用时应注册 crawl").toBeDefined();
      // 把 jobs 服务摘掉，模拟"注册后卸载"。夹具的 ctx 是 `never`（与真实 ctx 同形的匿名
      // 对象），这里按"有一个可替换的 get"收窄后再改。
      const mutable = harness.ctx as unknown as { get: (name: string) => unknown };
      mutable.get = (): undefined => undefined;
      await expect(
        crawl?.execute?.({ url: "http://127.0.0.1:1/" }, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: "JOBS_UNAVAILABLE" });
    } finally {
      harness.dispose();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)(
    "作业后端在起作业那一刻同步抛错：也按 JOBS_UNAVAILABLE 拒绝，不裸传宿主报错",
    async () => {
      // startCrawlJob 声明的是 Promise<string>：attachController / start 的同步异常必须
      // 翻成 rejection，且换成可执行的文案 —— 裸的宿主报错（「no job controller …」）
      // 对模型少一句该改哪里的上下文。
      const harness = makeJobHarness();
      try {
        await apply(
          harness.ctx,
          makeConfig({
            pythonBin: LOCAL_PYTHON,
            crawlEnabled: true,
            failFastOnMissingPython: false,
          }),
        );
        const crawl = harness.tools.get("scrapling_crawl");
        expect(crawl?.execute, "后端可用时应注册 crawl").toBeDefined();
        const mutable = harness.ctx as unknown as { get: (name: string) => unknown };
        mutable.get = (service: string) =>
          service === "jobs"
            ? {
                attachController: (): never => {
                  throw new Error("controller registry exploded");
                },
                start: (): string => CRAWL_JOB_ID,
              }
            : undefined;
        await expect(
          crawl?.execute?.({ url: UNREACHABLE }, { signal: new AbortController().signal }),
        ).rejects.toMatchObject({ code: "JOBS_UNAVAILABLE" });
      } finally {
        harness.dispose();
      }
    },
  );
});

describe("出站 URL 闸门（Host 侧 SSRF 防线）", () => {
  /** 公网地址字面量：走 IP 直连分支，不需要 DNS，测试因此不碰网络。 */
  const PUBLIC = "http://93.184.216.34/page";

  /** 回环与 RFC1918 是两类最常见的内网目标；多处复用，抽成常量。 */
  const LOOPBACK_URL = "http://127.0.0.1/";
  const PRIVATE_URL = "http://10.0.0.5/";

  /** 判否的码在 error.code 上，不在 message 里 —— message 是给模型看的人话。 */
  const blocked = { code: "URL_BLOCKED" };

  it("私网回环目标判否", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(LOOPBACK_URL)).rejects.toMatchObject(blocked);
  });

  it("rfc1918 私网目标判否", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(PRIVATE_URL)).rejects.toMatchObject(blocked);
  });

  it("非 http/https 协议判否（scheme 白名单）", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate("file:///etc/passwd")).rejects.toMatchObject(blocked);
  });

  it("URL 内嵌凭据判否", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate("http://user:pw@93.184.216.34/")).rejects.toMatchObject(blocked);
  });

  it("判否文案里的 userinfo 脱敏：口令不进日志与模型上下文（F3/J3）", async () => {
    const gate = createUrlGate(makeConfig({}));
    const reason = await gate("http://user:sekret-pw@93.184.216.34/").then(
      () => {
        throw new Error("应当判否");
      },
      (error: unknown) => (error as Error).message,
    );
    expect(reason).toContain("***@93.184.216.34");
    expect(reason).not.toContain("sekret-pw");
  });

  it("超过 maxUrlLength 判否", async () => {
    const gate = createUrlGate(makeConfig({ maxUrlLength: 32 }));
    await expect(gate(`http://93.184.216.34/${"a".repeat(64)}`)).rejects.toMatchObject(blocked);
  });

  it("打开合成段放行时，字面量仍走严格判定", async () => {
    // 这一条覆盖的是配置项真的传进了策略：用 IP 字面量当探针，它不查 DNS，
    // 于是既能走到那处分支，又不会把用例绑到真实解析上。
    const relaxed = createUrlGate(makeConfig({ allowSyntheticDns: true }));
    await expect(relaxed("http://93.184.216.34/x")).resolves.toContain("93.184.216.34");
    // 放宽只针对解析结果：回环字面量拿不到它。
    await expect(relaxed(LOOPBACK_URL)).rejects.toMatchObject(blocked);
  });

  it("合成段白名单非空时才传给策略，空值不传", async () => {
    // 这条覆盖的是配置真的透传下去了：IP 字面量当探针，它不查 DNS，于是既能走到那处分支，
    // 又不会把用例绑到真实解析上。
    const relaxed = createUrlGate(makeConfig({ syntheticDnsRanges: "198.18.0.0/16" }));
    await expect(relaxed("http://93.184.216.34/x")).resolves.toContain("93.184.216.34");
    // 放宽只针对解析结果：回环字面量拿不到它。
    await expect(relaxed(LOOPBACK_URL)).rejects.toMatchObject(blocked);
  });

  it("判否时 message 带人话原因（模型要能据此改写目标）", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(LOOPBACK_URL)).rejects.toThrow(/non-public address/u);
  });

  it("公网地址字面量放行，交回归一后的 URL", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(PUBLIC)).resolves.toBe(PUBLIC);
  });

  it("放行名单里的回环目标放行（与 Python 侧 ALLOWED_HOSTS 同一份设置）", async () => {
    const gate = createUrlGate(makeConfig({ allowedHosts: "127.0.0.1,localhost" }));
    await expect(gate(LOOPBACK_URL)).resolves.toBe(LOOPBACK_URL);
  });

  it("authority 里的反斜杠判否（WHATWG 与 libcurl 读出的 host 不是同一个）", async () => {
    // Node 的 WHATWG URL 把 http/https 的 `\` 当路径分隔符，于是这些串的 hostname 是
    // a.example；libcurl 按 RFC 3986 不当，`@` 前面成了 userinfo，真正建连的却是
    // 127.0.0.1 之类。不带反斜杠时同一目标本就判否，加一个反斜杠就必须照样判否。
    const gate = createUrlGate(makeConfig({}));
    await Promise.all(
      [
        String.raw`http://a.example\@127.0.0.1/x`,
        String.raw`http://a.example\\@169.254.169.254/latest/meta-data/`,
        String.raw`HTTP://a.example\@127.0.0.1:8080/admin`,
      ].map((sneaky) =>
        gate(sneaky).then(
          () => {
            throw new Error(`未被拦下: ${sneaky}`);
          },
          (error: unknown) => {
            expect(error).toMatchObject({ code: "URL_BLOCKED" });
          },
        ),
      ),
    );
  });

  it("声明自建 NAT64 前缀时被接进策略：藏在内嵌私网里的地址判否", async () => {
    // 2a00:1450::/96 看起来是公网段，但它把 10.0.0.1 藏在最后 32 位。
    const gate = createUrlGate(makeConfig({ nat64Prefixes: "2a00:1450::/96" }));
    await expect(gate("http://[2a00:1450::a00:1]/")).rejects.toMatchObject(blocked);
  });

  it("nat64Prefixes 与 allowedHosts 同时为空时策略照样建得起来", async () => {
    const gate = createUrlGate(makeConfig({ nat64Prefixes: "", allowedHosts: "" }));
    await expect(gate(PUBLIC)).resolves.toBe(PUBLIC);
  });

  it("nat64Prefixes 配错时报可读错并拒绝加载（而不是抛一条裸异常）", () => {
    // 方向是拒绝加载而不是「忽略这一项」：丢掉的前缀 = 它内嵌的私网 IPv4 被当成公网放行。
    for (const bad of ["1.1.1.1/32", "not-an-ip/96", "2001:db8::/1"]) {
      expect(() => createUrlGate(makeConfig({ nat64Prefixes: bad }))).toThrow(
        /nat64Prefixes 配置非法/u,
      );
    }
    // 文案得指出该改哪个设置项、长什么样，否则部署方只能去翻源码。
    expect(() => createUrlGate(makeConfig({ nat64Prefixes: "1.1.1.1/32" }))).toThrow(
      /<IPv6 前缀>\/<32\|40\|48\|56\|64\|96>/u,
    );
  });

  it("归一后的 URL 与入参不同时以归一串为准（判的和连的必须是同一个地址）", async () => {
    const gate = createUrlGate(makeConfig({}));
    // 缺省端口与补全的路径都会被 WHATWG 归一；sidecar 拿到的必须就是这个归一串。
    await expect(gate("http://93.184.216.34:80")).resolves.toBe("http://93.184.216.34/");
  });
});

describe("接管 ctx.web 的两个接缝", () => {
  it.runIf(HAS_LOCAL_PYTHON)("fetch 接缝：sidecar 可用时注册 provider", async () => {
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebFetch: true,
          provideWebSearch: false,
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      expect(harness.webProviders.fetch).toStrictEqual(["scrapling"]);
      expect(harness.webProviders.search).toStrictEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)("fetch 接缝：开关关着时不注册", async () => {
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebFetch: false,
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      expect(harness.webProviders.fetch).toStrictEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)("search 接缝：backend=bing 时注册 provider", async () => {
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebFetch: false,
          provideWebSearch: true,
          searchBackend: "bing",
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      expect(harness.webProviders.search).toStrictEqual(["scrapling"]);
      expect(harness.webProviders.fetch).toStrictEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("fetch 接缝：sidecar 不可用时跳过注册并记一条警告", async () => {
    // spawn 一律抛 = sidecar 起不来；provider 的 available() 契约要求只看本地状态，
    // 所以这里判否是确定的，不需要真去等握手超时。
    const warnings: string[] = [];
    const tools = new Map<string, { name: string }>();
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (): never => {
          throw new Error("no real spawn here");
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (line: string): void => {
          warnings.push(line);
        },
        debug: (): void => undefined,
      },
      tools: {
        register: (definition: { name: string }): (() => void) => {
          tools.set(definition.name, definition);
          return (): void => undefined;
        },
      },
      web: {
        registerFetchProvider: vi.fn<(provider: { id: string }) => () => void>(),
        registerSearchProvider: vi.fn<(provider: { id: string }) => () => void>(),
      },
      settings: settingsStub(),
      systemPrompt: promptStub(),
      effect: (): void => undefined,
    } as unknown as never;
    await apply(
      ctx,
      makeConfig({
        pythonBin: LOCAL_PYTHON,
        provideWebFetch: true,
        failFastOnMissingPython: false,
      }),
    );
    expect(warnings.some((line) => line.includes("跳过注册 fetch provider"))).toBe(true);
  });

  it.runIf(HAS_LOCAL_PYTHON)("动作与下载门禁打开时两个工具注册", async () => {
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebFetch: false,
          provideWebSearch: false,
          allowBrowserActions: true,
          allowFileDownloads: true,
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      expect(harness.tools.has("scrapling_session_act")).toBe(true);
      expect(harness.tools.has("scrapling_download")).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)(
    "search 接缝：Tavily 没配 key 仍然注册，错误留到 search 时报",
    async () => {
      const harness = makeJobHarness();
      try {
        await apply(
          harness.ctx,
          makeConfig({
            pythonBin: LOCAL_PYTHON,
            provideWebSearch: true,
            searchBackend: "tavily",
            tavilyApiKey: "",
            allowedHosts: LOOPBACK_ALLOWLIST,
          }),
        );
        expect(harness.webProviders.search).toStrictEqual(["scrapling"]);
      } finally {
        harness.dispose();
      }
    },
  );
});

/** 起一枚真 `LocalJobRegistry`；配置走官方 schema 的默认值，不手抄数字。 */
function makeRealRegistry(): LocalJobRegistry {
  const parsed = (
    LocalJobRegistry.Config as unknown as {
      "~standard": {
        validate: (value: unknown) => { issues?: unknown; value: unknown };
      };
    }
  )["~standard"].validate({ pumpPollMs: 25 });
  if (parsed.issues !== undefined) {
    // 用 JSON.stringify 而不是 String：后者会把对象渲染成 "[object Object]"，读的人拿不到成因。
    throw new Error(`LocalJobRegistry.Config 默认值解析失败：${JSON.stringify(parsed.issues)}`);
  }
  return new LocalJobRegistry(new Context(), parsed.value as never);
}

/** 一份最小 spec：真注册表要求 run 交出 cancel 与 done，缺一个就在 start 里抛。 */
function realRegistrySpec(): never {
  return {
    kind: "scrapling",
    label: "probe",
    run: (): { cancel: () => void; done: Promise<unknown> } => ({
      cancel: (): void => undefined,
      done: Promise.resolve({ status: "completed" }),
    }),
  } as never;
}

/** 把「抛了还是成了」读成两个可断言的值，而不是靠 try/catch 里塞断言。 */
function outcomeOf(start: () => string): { id?: string; error?: string } {
  try {
    return { id: start() };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 夹具的作业闸门必须与**真实现**同解。
 *
 * 为什么需要这条：上面那份 `jobsStub` 手抄了 `dsh-jobs-local` 的准入判定（没有 controller
 * 附着就拒 start）。手抄件会腐烂——上游改了闸门或换了文案，夹具照旧，而用例继续绿。这条用
 * 真注册表跑同样三种状态，把「手抄件是否还等于真件」变成一条会自己变红的断言。
 *
 * 三种状态就是本包生产代码所依赖的全部：
 *   ① 裸 start 被拒 —— 这正是 `scrapling_crawl` 在默认 profile 里挂掉的形态；
 *   ② attach 之后 start 成功 —— `startUnderCrawlController` 的做法；
 *   ③ detach 之后回到被拒 —— 证明作用域是临时的，生产的 detach 不会给宿主留开着的闸门。
 */
describe("作业闸门：夹具与真实现同解", () => {
  it("裸 start 被拒，attach 后成功，detach 后回到被拒", () => {
    const registry = makeRealRegistry();
    const bare = outcomeOf(() => registry.start(realRegistrySpec()));
    expect(bare.id, "没有 controller 附着时真注册表必须拒绝").toBeUndefined();
    expect(bare.error).toContain("no job controller serves this agent");

    const detach = registry.attachController("scrapling: crawl");
    let attached: { id?: string; error?: string };
    try {
      attached = outcomeOf(() => registry.start(realRegistrySpec()));
    } finally {
      detach();
    }
    expect(
      attached.error,
      `attach 之后应当起得来，实测：${String(attached.error)}`,
    ).toBeUndefined();
    expect(attached.id).toMatch(/^scrapling-[0-9a-f]{16}$/u);

    const afterDetach = outcomeOf(() => registry.start(realRegistrySpec()));
    expect(afterDetach.id, "detach 之后必须回到被拒：证明作用域是临时的").toBeUndefined();
    expect(afterDetach.error).toContain("no job controller serves this agent");
  });

  it("夹具那句文案仍与真实现逐字一致（上游改文案时这条会红）", () => {
    const registry = makeRealRegistry();
    // 取 .message 而不是 String(error)：后者会带上 "Error: " 前缀，那样比的就成了 String 的格式。
    let message = "";
    try {
      registry.start(realRegistrySpec());
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    // 夹具里写死的那句：两边对不上就说明手抄件已经腐烂，改夹具而不是放宽这里。
    const stubbed =
      "background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)";
    expect(message).toBe(stubbed);
  });
});

/** MCP server 的卸载函数；宿主按「调用它即回收」这一约定登记。 */
type Disposer = () => unknown;

const STUB_DEPS = (): never =>
  ({
    sidecar: { call: async () => ({}) } as never,
    settings: {} as never,
    startCrawlJob: async () => "crawl-0000000000000000",
    answer: async () => ({}) as never,
    attachments: undefined,
  }) as never;

const LIVE_SEARCH = {
  available: () => true,
  search: async () => ({
    sources: [{ url: "http://93.184.216.34/a", title: "A 页", snippet: "摘要" }],
    truncated: false,
  }),
};

const MCP_PLAN = {
  ready: ["scrapling_fetch", "scrapling_answer", "scrapling_screenshot"],
  skipped: [],
} as unknown as ToolPlan;

function surfaceHarness(): {
  ctx: unknown;
  logs: string[];
  disposers: Disposer[];
  port: () => number;
} {
  const logs: string[] = [];
  const disposers: Disposer[] = [];
  const ctx = {
    effect: (factory: () => Disposer): void => {
      disposers.push(factory());
    },
    logger: {
      info: (line: string): void => {
        logs.push(line);
      },
      warn: (line: string): void => {
        logs.push(line);
      },
      debug: (): void => undefined,
    },
  };
  return {
    ctx,
    logs,
    disposers,
    port: () => Number(/127\.0\.0\.1:(?<port>\d+)/u.exec(logs.join("\n"))?.groups?.["port"] ?? 0),
  };
}

async function connectProbe(port: number, token?: string): Promise<Client> {
  const client = new Client({ name: "host-probe", version: "0.0.0" });
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(port)}/mcp`),
    {
      requestInit: { headers },
    },
  );
  await client.connect(transport);
  return client;
}

async function startSurface(
  env: NodeJS.ProcessEnv,
  search: unknown,
): Promise<ReturnType<typeof surfaceHarness>> {
  const harness = surfaceHarness();
  const handle = await startMcpSurface({
    ctx: harness.ctx as never,
    config: makeConfig({ mcpPort: 0 }),
    plan: MCP_PLAN,
    depsFor: STUB_DEPS,
    search: search as never,
    env,
  });
  const { port } = harness;
  expect(handle.url).toContain(String(port()));
  return harness;
}

function degradedHarness(): {
  infos: string[];
  names: string[];
  disposers: Disposer[];
  ctx: never;
} {
  const infos: string[] = [];
  const names: string[] = [];
  const disposers: Disposer[] = [];
  const ctx = {
    get: (): undefined => undefined,
    subprocess: {
      resolveExecutable: async (): Promise<string> => {
        throw new Error(INTERPRETER_UNUSABLE);
      },
      spawn: (): never => {
        throw new Error(SHOULD_NOT_REACHED);
      },
    },
    logger: {
      info: (line: string): void => {
        infos.push(line);
      },
      warn: (): void => undefined,
      debug: (): void => undefined,
    },
    settings: settingsStub(),
    systemPrompt: promptStub(),
    tools: {
      register: (definition: { name: string }): (() => void) => {
        names.push(definition.name);
        return (): void => undefined;
      },
      get: (): undefined => undefined,
    },
    effect: (factory: () => Disposer): void => {
      disposers.push(factory());
    },
  };
  return { infos, names, disposers, ctx: ctx as never };
}

async function tearDown(harness: ReturnType<typeof surfaceHarness>): Promise<void> {
  await Promise.all(harness.disposers.map((dispose) => dispose()));
}

describe("mcp 模式的装配", () => {
  it("apply 在 mcp 模式下不注册原生工具，只起 server", async () => {
    const harness = degradedHarness();
    await apply(
      harness.ctx,
      makeConfig({
        pythonBin: "",
        failFastOnMissingPython: false,
        integrationMode: "mcp",
        mcpPort: 0,
      }),
    );
    expect(harness.names).toStrictEqual([]);
    expect(harness.infos.join("\n")).toContain("MCP server：http://127.0.0.1:");
    await Promise.all(harness.disposers.map((dispose) => dispose()));
  });

  it("apply 在 official-mcp 模式下既不起 server 也不注册工具", async () => {
    const harness = degradedHarness();
    await apply(
      harness.ctx,
      makeConfig({
        pythonBin: "",
        failFastOnMissingPython: false,
        integrationMode: "official-mcp",
      }),
    );
    expect(harness.names).toStrictEqual([]);
    const joined = harness.infos.join("\n");
    expect(joined).toContain("integrationMode=official-mcp");
    // 指路要指到能动手的那一句：没开开关时要点名 officialMcpEnabled 与 --accept-risk。
    expect(joined).toContain("officialMcpEnabled");
    expect(joined).toContain("--accept-risk");
    await Promise.all(harness.disposers.map((dispose) => dispose()));
  });

  it.runIf(HAS_LOCAL_PYTHON)(
    "mcp 模式下真宿主、真 sidecar 与真 MCP 客户端能走通一次 fetch",
    async () => {
      const site = await startCrawlSite();
      const infos: string[] = [];
      const registered: string[] = [];
      const disposers: Disposer[] = [];
      const ctx = {
        get: (): undefined => undefined,
        subprocess: {
          resolveExecutable: async (command: string): Promise<string> => {
            if (!existsSync(command)) {
              throw new Error(`executable not found: ${command}`);
            }
            return command;
          },
          spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }): never => {
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
            } as never;
          },
        },
        logger: {
          info: (line: string): void => {
            infos.push(line);
          },
          warn: (): void => undefined,
          debug: (): void => undefined,
        },
        tools: {
          register: (definition: { name: string }): (() => void) => {
            registered.push(definition.name);
            return (): void => undefined;
          },
          get: (): undefined => undefined,
        },
        settings: settingsStub(),
        systemPrompt: promptStub(),
        effect: (factory: () => Disposer): void => {
          disposers.push(factory());
        },
      } as unknown as never;

      await apply(
        ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebFetch: false,
          provideWebSearch: false,
          // D10：公共引擎不是默认发现路径，MCP 的 search 工具要显式打开回退才存在。
          searchPublicFallback: true,
          integrationMode: "mcp",
          mcpPort: 0,
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      try {
        // 模式互斥的第一条判据：mcp 模式下一个原生工具都不注册。
        expect(registered).toStrictEqual([]);
        const port = Number(
          /127\.0\.0\.1:(?<port>\d+)/u.exec(infos.join("\n"))?.groups?.["port"] ?? 0,
        );
        expect(port).toBeGreaterThan(0);
        const client = await connectProbe(port);
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name);
        expect(names).toContain("fetch");
        expect(names).toContain("search");
        expect(names).not.toContain("answer");
        const fetched = await client.callTool({
          name: "fetch",
          arguments: { url: `${site.base}b.html` },
        });
        expect(fetched.isError).not.toBe(true);
        expect(JSON.stringify(fetched.content)).toContain("Leaf Page");
        await client.close();
      } finally {
        await Promise.all(disposers.map((dispose) => dispose()));
        await site.close();
      }
    },
  );

  it("端出去的是同一份工具表，但不含 answer", async () => {
    const harness = await startSurface({}, LIVE_SEARCH);
    const client = await connectProbe(harness.port());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toStrictEqual(["fetch", "screenshot", "search"]);
    await client.close();
    await tearDown(harness);
  });

  it("mcp 调用真的走工具执行面与渲染面", async () => {
    const harness = await startSurface({}, LIVE_SEARCH);
    const client = await connectProbe(harness.port());
    const result = await client.callTool({ name: "search", arguments: { query: "dsh" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("A 页");
    await client.close();
    await tearDown(harness);
  });

  it("卸载后端口不再应答", async () => {
    const harness = await startSurface({}, LIVE_SEARCH);
    const port = harness.port();
    const client = await connectProbe(port);
    await client.close();
    await tearDown(harness);
    const refused = await fetch(`http://127.0.0.1:${String(port)}/mcp`).catch(
      (error_: unknown) => error_,
    );
    expect(refused).toBeInstanceOf(TypeError);
  });

  it("环境里有 token 时，不带 Authorization 的连接被拒", async () => {
    const harness = await startSurface({ [MCP_TOKEN_ENV]: "issued-token" }, LIVE_SEARCH);
    const port = harness.port();
    const anonymous = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
    });
    expect(anonymous.status).toBe(401);
    void anonymous.body?.cancel();
    expect(harness.logs.join("\n")).toContain("需要 bearer token");
    const client = await connectProbe(port, "issued-token");
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(3);
    await client.close();
    await tearDown(harness);
  });

  it("搜索层不可用时 MCP 侧也没有 search", async () => {
    const harness = await startSurface({}, { available: () => false, search: async () => ({}) });
    const client = await connectProbe(harness.port());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toStrictEqual(["fetch", "screenshot"]);
    await client.close();
    await tearDown(harness);
  });
});
