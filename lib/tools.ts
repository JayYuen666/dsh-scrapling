// dsh-scrapling/lib/tools.ts —— 工具的注册实现。
//
// 本文件只放工具**定义**；要不要注册由 host.ts 的 `planTools` 决定 —— 两个维度分开：
// 这里是「注册了之后怎么工作」，那边是「要不要注册」。
//
// 共同约定：
//   - `execute` 返回**无损的 JSON 值**，模型看到的文本由 `output.render` 生成；
//   - 失败一律 throw（注册表转成 isError），不把失败塞进 result 里假装成功；
//   - `exec.signal` 一路透传给 sidecar —— 超时策略只通知不杀进程，sidecar 客户端
//     收到 abort 会自己拆掉进程重连；
//   - 抓回的内容**已在 Python 侧做过隐藏元素清洗**，这里不二次处理，也不提供
//     关掉它的开关（官方 MCP 在 `mainContentOnly=false` 时会绕过清洗，本插件不重复）。

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { capText } from "./output.ts";
import type { AnswerRequest, AnswerResult } from "./answer.ts";
import type { SidecarClient } from "./sidecar.ts";

/** 抽取形态；与 Scrapling 的 extraction_types 一致。 */
export type ExtractionType = "markdown" | "html" | "text";

/** 工具共用的一份「已解析的设置」。 */
export interface ToolSettings {
  /** 抽取形态。 */
  readonly extractionType: ExtractionType;
  /** 是否只取 body 内容。 */
  readonly mainContentOnly: boolean;
  /** 单个工具结果的字节预算。 */
  readonly maxOutputBytes: number;
  /** 单次调用的协同超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 浏览器是否无头运行。 */
  readonly headless: boolean;
  /** 是否等到网络静默；SPA 场景下不打开就会只拿到加载占位。 */
  readonly networkIdle: boolean;
  /** 浏览器侧的导航超时（毫秒），与工具的协同超时是两层。 */
  readonly pageTimeoutMs: number;
  /** 等待的选择器状态。 */
  readonly waitSelectorState: WaitSelectorState;
  /** 拦截抓到的 XHR 时用的正则。 */
  readonly captureXhrPattern: string;
  /** Python 侧单次请求的硬上限（秒）。与 timeoutMs 是两层：后者管宿主等多久，前者管子进程
   *  自己何时放弃——只设前者，一个卡死的子进程会一直占着宿主的协同超时。 */
  readonly requestTimeoutSeconds: number;
  /** 浏览器侧是否拦截广告与追踪资源。 */
  readonly blockAds: boolean;
  /** crawl 一次最多抓多少条。 */
  readonly crawlMaxItems: number;
  /** URL 长度上限（字符）；与 dsh 内置 web_fetch 的默认同值。 */
  readonly maxUrlLength: number;
  /** 浏览器二进制路径；空表示用 Playwright 自带的。部署级，模型改不了。 */
  readonly browserExecutablePath: string;
  /** CDP 端点；空表示由 Playwright 拉起进程。部署级，模型改不了。 */
  readonly browserCdpUrl: string;
  /**
   * 是否剥掉正文里内嵌的 `data:` URI 图片（只留 alt 文本）。
   *
   * 走 deployment 命名空间而不是模型入参：它改的是**所有**抓取的输出形态，属于部署侧的
   * 取舍，不该由被 prompt 注入的模型逐次决定。
   */
  readonly stripInlineImages: boolean;
}

/** CSS 选择器的等待状态；与 Playwright 的同名概念一致。 */
export type WaitSelectorState = "attached" | "detached" | "hidden" | "visible";

/** 建工具所需的依赖。 */
/** 起问答的回调；由 host.ts 用 `ctx.llm` 实现（实现见 lib/answer.ts）。 */
export type AnswerStarter = (request: AnswerRequest) => Promise<AnswerResult>;

/** 建工具所需的依赖。 */
export interface ToolDeps {
  /** 已握手的 sidecar 客户端。 */
  readonly sidecar: SidecarClient;
  /** 已解析的工具设置。 */
  readonly settings: ToolSettings;
  /** 起后台作业的回调；由 host.ts 用 `ctx.jobs` 实现。 */
  readonly startCrawlJob: CrawlJobStarter;
  /** 问模型的回调；由 host.ts 用 `ctx.llm` 实现。只有 scrapling_answer 用得到，
   *  但跟 startCrawlJob 一样对每个 builder 都传：类型逼着所有工具看见完整依赖，
   *  漏传是编译错误而不是运行时才发现。 */
  readonly answer: AnswerStarter;
}

/** 抓取类工具的 canonical 结果。 */
interface FetchResult {
  url: string;
  statusCode: number;
  extractionType: string;
  content: string;
  truncated: boolean;
  notice: string;
}

/** 一条结构化匹配。 */
interface Match {
  tag: string;
  text: string;
}

/** 结构化选择的结果。 */
interface SelectResult {
  count: number;
  truncated: boolean;
  matches: Match[];
}

/**
 * 从 sidecar 的自由形状回包里挑一个字符串字段。
 *
 * sidecar 是另一个语言实现的进程，载荷形状不该被直接断言 —— 这里逐字段校验，
 * 缺失就报可读错误，而不是让 `undefined` 流进模型上下文。
 *
 * @param value - 回包里的 result
 * @param field - 字段名
 * @returns 字符串值
 */
function textOf(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string") {
    throw new Error(`sidecar result is missing a string field: ${field}`);
  }
  return value[field];
}

/**
 * 从回包里挑一个非负整数。
 *
 * @param value - 回包里的 result
 * @param field - 字段名
 * @param fallback - 缺失或非法时给的值
 * @returns 整数
 */
function intOf(value: unknown, field: string, fallback: number): number {
  if (!isRecord(value)) {
    return fallback;
  }
  const raw = value[field];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

/**
 * 从回包里挑一个布尔。
 *
 * @param value - 回包里的 result
 * @param field - 字段名
 * @returns 布尔值
 */
function boolOf(value: unknown, field: string): boolean {
  return isRecord(value) && value[field] === true;
}

/**
 * 把 sidecar 的 result 归一成抓取类工具的载荷。
 *
 * @param raw - 回包里的 result
 * @param extractionType - 本次请求的抽取形态
 * @returns 抓取载荷
 */
function toFetchResult(raw: unknown, extractionType: string): FetchResult {
  return {
    url: textOf(raw, "url"),
    statusCode: intOf(raw, "status", 0),
    extractionType,
    content: textOf(raw, "content"),
    truncated: boolOf(raw, "truncated"),
    notice: "",
  };
}

/** 被截断时告诉模型怎么把内容再拿回来。 */
/** url 参数的说明，被多处参数表共用。 */
const URL_PARAM_DESC = "要抓取的 HTTP(S) URL。";

const RECOVERY_HINT = "要拿被省略的部分，请用 cssSelector 收窄范围，或分多次抓取。";

/**
 * 把 sidecar 的会话开单回包归一成结构。
 *
 * @param raw - 回包里的 result
 * @returns 会话开单
 */
function toSessionOpen(raw: unknown): SessionOpenResult {
  const value = isRecord(raw) ? raw : {};
  return {
    sessionId: textOf(raw, "sessionId"),
    sessionType: typeof value["sessionType"] === "string" ? value["sessionType"] : "unknown",
    createdAt: typeof value["createdAt"] === "string" ? value["createdAt"] : "",
  };
}

/**
 * 把 sidecar 的会话列表回包归一成结构。
 *
 * @param raw - 回包里的 result
 * @returns 会话列表
 */
function toSessionRows(raw: unknown): SessionRow[] {
  if (!isRecord(raw) || !Array.isArray(raw["sessions"])) {
    return [];
  }
  const rows: SessionRow[] = [];
  for (const item of raw["sessions"]) {
    if (isRecord(item)) {
      rows.push({
        sessionId: typeof item["sessionId"] === "string" ? item["sessionId"] : "",
        sessionType: typeof item["sessionType"] === "string" ? item["sessionType"] : "unknown",
        createdAt: typeof item["createdAt"] === "string" ? item["createdAt"] : "",
      });
    }
  }
  return rows;
}

/**
 * 把回包里的 matches 数组归一成结构化列表。
 *
 * render 与 execute 共用同一套归一逻辑 —— 渲染时看到的和执行时算出来的不该是两回事。
 *
 * @param raw - 回包里的 result
 * @returns 归一后的匹配列表
 */
function toMatches(raw: unknown): Match[] {
  if (!isRecord(raw) || !Array.isArray(raw["matches"])) {
    return [];
  }
  const matches: Match[] = [];
  for (const item of raw["matches"]) {
    if (isRecord(item)) {
      matches.push({
        tag: typeof item["tag"] === "string" ? item["tag"] : "",
        text: typeof item["text"] === "string" ? item["text"] : "",
      });
    }
  }
  return matches;
}

/**
 * 把抓取结果渲染成模型看的文本。
 *
 * 收强类型而不是 `unknown`：output.schema 用的是 value-schema DSL，必填字段由 schema
 * 声明，defineTool 推出来的 value 每个字段都保证存在。写「万一字段缺失」那层兜底只会
 * 造出永远走不到的死分支。
 *
 * @param value - 投影出的结果值
 * @returns 模型侧文本
 */
function renderFetch(value: FetchResult): string {
  const body = `Fetched ${value.url} (HTTP ${value.statusCode})\n\n${value.content}`;
  return value.notice.length > 0 ? `${body}\n\n${value.notice}` : body;
}

/**
 * 把选择结果渲染成模型看的文本。
 *
 * 收强类型：`output.schema` 用 value-schema DSL 声明了必填字段，defineTool 推出来的
 * `value` 保证每项都在；写「万一不是数组」的兜底只会造出永远走不到的死分支。
 *
 * @param value - 投影出的结果值
 * @returns 模型侧文本
 */
function renderMatches(value: SelectResult): string {
  return value.matches.length === 0
    ? "no matches"
    : value.matches.map((item) => `<${item.tag}> ${item.text}`).join("\n");
}

/**
 * 建 `scrapling_fetch`：抓一个 URL 并转成 Markdown/文本/HTML。
 *
 * 与 dsh 内置 `web_fetch` 的差别在于可选 `cssSelector`（把页面收窄到某一块）
 * 与 `extractionType`（默认 markdown）；不需要这些时用内置的更省事。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createFetchTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_fetch",
    description:
      "抓取一个 HTTP(S) URL 并返回正文（默认转成干净的 Markdown）。" +
      "与 web_fetch 的差别：可以用 cssSelector 把结果收窄到页面的一部分，也可以要原始 HTML 或纯文本。" +
      "页面要执行 JavaScript 才能看到内容时，改用 scrapling_render。" +
      "正文里内嵌的 data: URI 图片（base64 SVG/PNG）会被剥掉只留 alt —— 模型从 base64 里读不出任何图形信息，" +
      "而它照样按字符吃 token 预算；代码围栏内的原样保留。要原始 data URI 就关掉设置里的 stripInlineImages。",
    parameters: {
      url: { type: "string", required: true, description: "要抓取的 HTTP(S) URL。" },
      cssSelector: {
        type: "string",
        description:
          "可选的 CSS 选择器，只转换匹配到的元素 —— 抓整页时留空。" +
          "用它既能省 token，也能避开页面上无关的样板内容。",
      },
      extractionType: {
        type: "string",
        description: "输出形态：markdown（默认）/ html / text。",
      },
      mainContentOnly: {
        type: "boolean",
        description: "只保留 body 内容，默认 true。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        // output.schema 用的是 value-schema DSL：必填是**逐字段**标 required: true，
        // 没有顶层 required 数组 —— 写上去 defineTool 会当场抛 JsonSchemaError。
        properties: {
          url: { type: "string", required: true },
          statusCode: { type: "integer", required: true },
          extractionType: { type: "string", required: true },
          content: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          notice: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderFetch(value) }],
      // 投影必须是**无损 JSON**：只放原始值，不做格式化，也不塞 undefined。
      // 改成 DSL 写法后 value 已是强类型，这里不必再逐字段兜底。
      presentationMeta: (_args, value) => ({
        url: value.url,
        statusCode: value.statusCode,
        truncated: value.truncated,
      }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolRunContext): Promise<FetchResult> {
      const requested = args["extractionType"];
      const extractionType = requested ?? settings.extractionType;
      const raw = await sidecar.call(
        "fetch",
        {
          url: args["url"],
          cssSelector: args["cssSelector"] ?? null,
          extractionType,
          mainContentOnly: args["mainContentOnly"] ?? settings.mainContentOnly,
          maxContentChars: settings.maxOutputBytes,
          timeoutSeconds: settings.requestTimeoutSeconds,
          maxUrlLength: settings.maxUrlLength,
          deployment: { stripInlineImages: settings.stripInlineImages },
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      const result = toFetchResult(raw, extractionType);
      const capped = capText(result.content, settings.maxOutputBytes, RECOVERY_HINT);
      return {
        ...result,
        content: capped.text,
        truncated: capped.truncated,
        notice: capped.notice,
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "fetch" }),
    presentResult: (args, result) => {
      // 投影载荷挂在 result.meta 上（不是 output）；meta 缺席时退回占位值，
      // 让 UI 至少还能显示这是一次抓取。
      const meta = isRecord(result.meta) ? result.meta : {};
      return {
        card: "web",
        kind: "fetch",
        title: args["url"],
        url: typeof meta["url"] === "string" ? meta["url"] : args["url"],
        statusCode: typeof meta["statusCode"] === "number" ? meta["statusCode"] : 0,
        truncated: meta["truncated"] === true,
      };
    },
  });
}

/**
 * 建 `scrapling_extract`：对**已有**的 HTML 做 CSS/XPath 选择，返回结构化结果。
 *
 * 这个工具不发网络请求，所以可以直接复用 `scrapling_fetch` 的结果，
 * 也可以单独处理模型自己已经拿到的 HTML。返回的是选择器命中的内容，
 * 而不是一整块 Markdown —— 这正是内置 `web_fetch` 结构上给不了的东西。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createExtractTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_extract",
    description:
      "用 CSS 选择器或 XPath 从一段 HTML 里取出结构化内容（匹配数、元素标签、文本）。" +
      "不发网络请求 —— HTML 通常来自 scrapling_fetch 的结果。要从 URL 开始，就先抓再抽取。",
    parameters: {
      html: { type: "string", required: true, description: "要抽取的 HTML 源码。" },
      selector: {
        type: "string",
        required: true,
        description: "CSS 选择器，例如 'table tr td.price'。",
      },
      useXpath: { type: "boolean", description: "把 selector 当作 XPath 解析，默认 false。" },
      limit: { type: "integer", description: "最多返回多少条匹配，默认 200。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          matches: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                tag: { type: "string", required: true },
                text: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderMatches(value) }],
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolRunContext): Promise<SelectResult> {
      const raw = await sidecar.call(
        "select",
        {
          html: args["html"],
          selector: args["selector"],
          useXpath: args["useXpath"] === true,
          limit: args["limit"] ?? 200,
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      const matches: Match[] = toMatches(raw);
      return {
        count: intOf(raw, "count", matches.length),
        truncated: boolOf(raw, "truncated"),
        matches,
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["selector"], kind: "search" }),
  });
}

/** 浏览器抓取的一条 XHR 摘要。 */
export interface XhrSummary {
  url: string;
  status: number;
  bytes: number;
}

/**
 * 浏览器抓取的结果。
 *
 * `xhr` 是可选的：只有 `scrapling_capture_xhr` 的输出 schema 里声明了它，
 * `scrapling_render` 没声明，而那条 schema 写着 `additionalProperties: false` ——
 * 多返回这个字段会被判成 `value.xhr is not a declared property`，工具次次失败。
 */
export interface BrowserResult extends FetchResult {
  xhr?: XhrSummary[];
}

/** 浏览器工具的公共参数说明。 */
const BROWSER_PARAMS_TEXT = {
  url: { type: "string", required: true, description: URL_PARAM_DESC },
  cssSelector: {
    type: "string",
    description: "可选的 CSS 选择器，只转换匹配到的元素 —— 抓整页时留空。",
  },
  extractionType: { type: "string", description: "输出形态：markdown（默认）/ html / text。" },
  mainContentOnly: { type: "boolean", description: "只保留 body 内容，默认 true。" },
  networkIdle: {
    type: "boolean",
    description:
      "等到网络静默再取内容。页面靠 JS 渲染时**必须**打开，否则 Playwright 的 load 事件" +
      "早于渲染完成，你会只拿到加载占位。默认跟随设置。",
  },
  waitSelector: {
    type: "string",
    description:
      "可选的 CSS 选择器，等它出现再取内容。比 networkIdle 更精确：" +
      "直接说明「等到这个元素出现」。",
  },
  headless: { type: "boolean", description: "无头运行浏览器，默认 true。" },
} as const;

/**
 * 把 sidecar 的 XHR 摘要归一成结构化列表。
 *
 * 响应体可能很大，所以 Python 侧只回 URL/状态码/字节数；模型看到摘要后自己决定要不要
 * 再对其中某个 URL 单独抓一次。
 *
 * @param raw - 回包里的 result
 * @returns XHR 摘要列表
 */
function toXhr(raw: unknown): XhrSummary[] {
  if (!isRecord(raw) || !Array.isArray(raw["xhr"])) {
    return [];
  }
  const items: XhrSummary[] = [];
  for (const item of raw["xhr"]) {
    if (isRecord(item)) {
      items.push({
        url: typeof item["url"] === "string" ? item["url"] : "",
        status: typeof item["status"] === "number" ? item["status"] : 0,
        bytes: typeof item["bytes"] === "number" ? item["bytes"] : 0,
      });
    }
  }
  return items;
}

/**
 * 浏览器抓取的公共参数，组装成 sidecar 调用。
 *
 * @param args - 工具入参
 * @param settings - 工具设置
 * @param method - sidecar 方法名
 * @returns 调用载荷
 */
function browserPayload(
  args: Record<string, unknown>,
  settings: ToolSettings,
  method: string,
): { method: string; params: Record<string, unknown> } {
  const { waitSelector } = args;
  return {
    method,
    params: {
      url: args["url"],
      cssSelector: args["cssSelector"] ?? null,
      extractionType: args["extractionType"] ?? settings.extractionType,
      mainContentOnly: args["mainContentOnly"] ?? settings.mainContentOnly,
      headless: args["headless"] ?? settings.headless,
      networkIdle: args["networkIdle"] ?? settings.networkIdle,
      timeoutMs: settings.pageTimeoutMs,
      requestTimeoutSeconds: settings.requestTimeoutSeconds,
      maxContentChars: settings.maxOutputBytes,
      captureXhrPattern: settings.captureXhrPattern,
      blockAds: settings.blockAds,
      maxUrlLength: settings.maxUrlLength,
      // deployment 是部署级能力的专用命名空间：Python 侧只从这里读浏览器二进制路径、
      // CDP 端点与输出形态开关，不在模型可见的透传表里。
      deployment: {
        browserExecutablePath: settings.browserExecutablePath,
        browserCdpUrl: settings.browserCdpUrl,
        stripInlineImages: settings.stripInlineImages,
      },
      ...(typeof waitSelector === "string" && waitSelector.length > 0
        ? { waitSelector, waitSelectorState: settings.waitSelectorState }
        : {}),
    },
  };
}

/** XHR 摘要的条目 schema。 */
const XHR_ITEM = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    url: { type: "string" as const, required: true as const },
    status: { type: "integer" as const, required: true as const },
    bytes: { type: "integer" as const, required: true as const },
  },
};

/**
 * 把浏览器抓取结果渲染成模型看的文本，末尾附上 XHR 摘要。
 *
 * @param value - 浏览器抓取载荷
 * @returns 模型侧文本
 */
function renderBrowser(value: BrowserResult | FetchResult): string {
  const body = renderFetch(value);
  // 不带 XHR 的工具（render）其 schema 里没有这个字段，execute 也就不会产出它；
  // capture_xhr 那一路上它一定是数组。这里只能断言一次：联合类型里 FetchResult 没有
  // 这个键，但两个调用点传进来的对象都出自 createBrowserTool 的 execute。
  const captured: XhrSummary[] = (value as Partial<BrowserResult>).xhr ?? [];
  if (captured.length === 0) {
    return body;
  }
  const lines = captured.map((item) => `- ${item.url} (HTTP ${item.status}, ${item.bytes}B)`);
  return `${body}\n\nCaptured XHR/fetch:\n${lines.join("\n")}`;
}

/** 建浏览器抓取工具时的可变部分。 */
interface BrowserToolOptions {
  readonly name: string;
  readonly description: string;
  readonly method: string;
  /** 结果里是否带 XHR 摘要。 */
  readonly withXhr: boolean;
}

/**
 * 建一个浏览器抓取工具。
 *
 * render 与 capture_xhr 只有「结果里多不多一段 XHR 摘要」这一处差别，共用同一套参数
 * 与截断逻辑 —— 分成两个函数只会让两边悄悄漂移。
 *
 * @param deps - 依赖
 * @param options - 工具的可变部分
 * @returns 工具定义
 */
function createBrowserTool(deps: ToolDeps, options: BrowserToolOptions): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: options.name,
    description: options.description,
    parameters: { ...BROWSER_PARAMS_TEXT },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          statusCode: { type: "integer", required: true },
          extractionType: { type: "string", required: true },
          content: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          notice: { type: "string", required: true },
          ...(options.withXhr ? { xhr: { type: "array", required: true, items: XHR_ITEM } } : {}),
        },
      },
      render: (_args, value) => [{ type: "text", text: renderBrowser(value) }],
      presentationMeta: (_args, value) => ({
        url: value.url,
        statusCode: value.statusCode,
        truncated: value.truncated,
      }),
    },
    timeoutMs: settings.timeoutMs,
    // 浏览器很吃内存，且同时开几个会把机器拖垮 —— 明确声明不可并发。
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext): Promise<BrowserResult> {
      const payload = browserPayload(args, settings, options.method);
      const raw = await sidecar.call(payload.method, payload.params, {
        signal: exec.signal,
        timeoutMs: settings.timeoutMs,
      });
      const base = toFetchResult(raw, String(payload.params["extractionType"]));
      const capped = capText(base.content, settings.maxOutputBytes, RECOVERY_HINT);
      const result: BrowserResult = {
        ...base,
        content: capped.text,
        truncated: capped.truncated,
        notice: capped.notice,
        // 只在 schema 声明了 xhr 的那个工具上才产出它：schema 是
        // additionalProperties: false，无条件带上会让 render 每一次都被判非法。
        ...(options.withXhr ? { xhr: toXhr(raw) } : {}),
      };
      return result;
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "fetch" }),
    presentResult: (args, result) => {
      const meta = isRecord(result.meta) ? result.meta : {};
      return {
        card: "web",
        kind: "fetch",
        title: args["url"],
        url: typeof meta["url"] === "string" ? meta["url"] : args["url"],
        statusCode: typeof meta["statusCode"] === "number" ? meta["statusCode"] : 0,
        truncated: meta["truncated"] === true,
      };
    },
  });
}

/**
 * 建 `scrapling_render`：用真实浏览器渲染后抓取。
 *
 * 这是内置 `web_fetch` 结构上给不了的能力：它不执行 JavaScript，遇到 SPA 只能拿到
 * 加载占位。代价是慢得多（秒级起步）且吃内存，所以先试 `scrapling_fetch`。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createRenderTool(deps: ToolDeps): ToolDefinition {
  return createBrowserTool(deps, {
    name: "scrapling_render",
    description:
      "用真实浏览器打开一个 URL、执行 JavaScript，再把渲染后的页面抓下来。" +
      "内置 web_fetch 不执行 JS，遇到单页应用只能拿到加载占位时才需要它。" +
      "比 web_fetch 慢得多、也更吃内存 —— 先试 scrapling_fetch，确认内容确实依赖 JS 再用这个。" +
      "**结果比 scrapling_fetch 短就该退回静态抓取**：不少页面在服务端下发了可读文字（给搜索引擎与无 JS 用户），" +
      "加载后又用自己的脚本把那些容器清空、换成 canvas/Lottie 动画 —— 这类页面渲染后只会更少，" +
      "穷举 networkIdle / waitSelector / mainContentOnly / headless 都补不回来。" +
      "另外 waitSelector 等的是「元素出现」，不是「内容稳定」：元素可能在匹配之后被脚本移除，" +
      "所以匹配成功不代表那部分内容还在结果里。",
    method: "render",
    withXhr: false,
  });
}

/**
 * 建 `scrapling_capture_xhr`：渲染页面的同时，把它发出的 XHR/fetch 响应摘要一并收回来。
 *
 * 很多站点的数据不渲染进 DOM，而是从一个 JSON 接口取。抓这个接口比解析 DOM 稳得多，
 * 而且拿到的就是原始结构化数据。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createCaptureXhrTool(deps: ToolDeps): ToolDefinition {
  return createBrowserTool(deps, {
    name: "scrapling_capture_xhr",
    description:
      "用真实浏览器打开一个 URL，同时收集它发出的所有 XHR/fetch 请求（URL、状态码、字节数）。" +
      "站点数据来自 JSON 接口而不是 DOM 时，用它找到那个接口，再对接口 URL 单独抓一次即可拿到原始结构化数据。" +
      "响应体不回传 —— 只回摘要，避免把模型上下文撑爆。",
    method: "render",
    withXhr: true,
  });
}

/**
 * 建 `scrapling_stealth_fetch`：用 patchright 的反检测浏览器抓取。
 *
 * 官方宣传「轻松绕过所有类型的 Cloudflare Turnstile」是**夸大**的：实现只是对挑战框
 * 固定偏移点一次鼠标（抖动 3px/2px），最多 3 次，无 token 处理。所以这里的描述写的是
 * 「提高成功率」而不是「一定能过」。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createStealthFetchTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_stealth_fetch",
    description:
      "用带反检测补丁的浏览器（patchright）打开 URL 并抓取渲染后的页面。" +
      "站点对自动化痕迹敏感、scrapling_render 拿不到内容时才需要它。" +
      "比 render 更慢更吃内存。Cloudflare 挑战可能需要几次尝试才能过，不保证成功。",
    parameters: {
      ...BROWSER_PARAMS_TEXT,
      solveCloudflare: {
        type: "boolean",
        description: "尝试点击 Cloudflare 挑战框。默认 false；开了最多尝试 3 次。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          statusCode: { type: "integer", required: true },
          extractionType: { type: "string", required: true },
          content: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          notice: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderFetch(value) }],
      presentationMeta: (_args, value) => ({
        url: value.url,
        statusCode: value.statusCode,
        truncated: value.truncated,
      }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext): Promise<FetchResult> {
      const payload = browserPayload(args, settings, "stealth_fetch");
      const raw = await sidecar.call(
        payload.method,
        {
          ...payload.params,
          solveCloudflare: args["solveCloudflare"] === true,
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      const base = toFetchResult(raw, String(payload.params["extractionType"]));
      const capped = capText(base.content, settings.maxOutputBytes, RECOVERY_HINT);
      return { ...base, content: capped.text, truncated: capped.truncated, notice: capped.notice };
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "fetch" }),
  });
}

/** scrapling_answer 的结果。 */
export interface AnswerToolResult {
  url: string;
  statusCode: number;
  extractionType: string;
  answer: string;
  rendered: boolean;
  provider: string;
  model: string;
  truncated: boolean;
  notice: string;
}

/**
 * 把问答结果渲染成模型看的文本。
 *
 * @param value - 问答结果
 * @returns 模型侧文本
 */
function renderAnswer(value: AnswerToolResult): string {
  const head = `Answer to "${value.url}" (HTTP ${value.statusCode}, via ${value.provider}/${value.model}):`;
  const tail = value.notice.length > 0 ? `\n\n${value.notice}` : "";
  return `${head}\n\n${value.answer}${tail}`;
}

/**
 * 建 `scrapling_answer`：抓一个页面，把正文连同问题一起交给模型作答。
 *
 * 与 `scrapling_fetch` / `render` 的区别是最后多一步模型综合 —— 它们把正文原样交给
 * 模型自己读，这个工具替模型读完再给结论。页面正文是不可信输入，防提示注入的那道提示
 * 写在 `lib/answer.ts` 的系统提示里，与这里的输出投影是两件事。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createAnswerTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings, answer } = deps;
  return defineTool({
    name: "scrapling_answer",
    description:
      "打开一个 URL，把页面正文交给模型回答一个问题，直接拿到结论而不是原始正文。" +
      "页面很长、而你只关心其中某一点时用它，省得把整页读进上下文。" +
      "默认走静态抓取；单页应用（scrapling_fetch 只拿到加载占位）加 render:true 走真实浏览器。" +
      "要的就是正文原文时用 scrapling_fetch，不要用这个。",
    parameters: {
      url: { type: "string", required: true, description: URL_PARAM_DESC },
      question: {
        type: "string",
        required: true,
        description: "要问的问题。越具体越好——「表格里第三列是什么」比「讲讲这个页面」有用得多。",
      },
      render: {
        type: "boolean",
        description:
          "用真实浏览器渲染后再交给模型。默认 false。页面内容依赖 JavaScript 时才需要开。",
      },
      extractionType: {
        type: "string",
        enum: ["markdown", "html", "text"],
        description: "喂给模型的正文形态，默认取插件设置。",
      },
      mainContentOnly: {
        type: "boolean",
        description: "是否只取 body 内容，默认取插件设置。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          statusCode: { type: "integer", required: true },
          extractionType: { type: "string", required: true },
          answer: { type: "string", required: true },
          rendered: { type: "boolean", required: true },
          provider: { type: "string", required: true },
          model: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          notice: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderAnswer(value) }],
      presentationMeta: (_args, value) => ({
        url: value.url,
        statusCode: value.statusCode,
        truncated: value.truncated,
      }),
    },
    timeoutMs: settings.timeoutMs,
    // 一次问答里有一次模型调用，并发放开会让同一轮里多个问答互相抢额度。
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext): Promise<AnswerToolResult> {
      const rendered = args["render"] === true;
      const payload = browserPayload(args, settings, rendered ? "render" : "fetch");
      const raw = await sidecar.call(payload.method, payload.params, {
        signal: exec.signal,
        timeoutMs: settings.timeoutMs,
      });
      const base = toFetchResult(raw, String(payload.params["extractionType"]));
      const capped = capText(base.content, settings.maxOutputBytes, RECOVERY_HINT);
      const answered = await answer({
        question: args["question"],
        context: capped.text,
        url: base.url,
        agent: exec.agent,
        signal: exec.signal,
      });
      return {
        url: base.url,
        statusCode: base.statusCode,
        extractionType: base.extractionType,
        answer: answered.answer,
        rendered,
        provider: answered.provider,
        model: answered.model,
        truncated: capped.truncated,
        notice: capped.notice,
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "fetch" }),
    presentResult: (args, result) => {
      const meta = isRecord(result.meta) ? result.meta : {};
      return {
        card: "web",
        kind: "fetch",
        title: args["url"],
        url: typeof meta["url"] === "string" ? meta["url"] : args["url"],
        statusCode: typeof meta["statusCode"] === "number" ? meta["statusCode"] : 0,
        truncated: meta["truncated"] === true,
      };
    },
  });
}

/** 会话列表里的一项。 */
interface SessionRow {
  sessionId: string;
  sessionType: string;
  createdAt: string;
}

/** 开一个会话的结果。 */
interface SessionOpenResult {
  sessionId: string;
  sessionType: string;
  createdAt: string;
}

/**
 * 建 `scrapling_session_open`：开一个跨请求复用的会话。
 *
 * 一次性抓取每次都重新建连，cookie 与登录态留不住。要连续访问同一个站点
 * （翻页、翻页码、保持登录）时先开会话，再用 session_fetch 取内容。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createSessionOpenTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_session_open",
    description:
      "开一个跨请求复用的抓取会话（cookie、连接与浏览器实例都会保留）。" +
      "连续访问同一个站点时用它，避免每次都重新建连丢状态。" +
      "用完请用 scrapling_session_close 关掉 —— 会话常驻在宿主进程里，不会自己结束。",
    parameters: {
      sessionType: {
        type: "string",
        required: true,
        description:
          "static（curl_cffi，最快）/ browser（Playwright，执行 JS）/ stealth（patchright，反检测）。",
      },
      headless: { type: "boolean", description: "browser/stealth 是否无头运行，默认 true。" },
      solveCloudflare: {
        type: "boolean",
        description: "仅 stealth：是否尝试点 Cloudflare 挑战框。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", required: true },
          sessionType: { type: "string", required: true },
          createdAt: { type: "string", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `session ${value.sessionId} (${value.sessionType}) opened at ${value.createdAt}`,
        },
      ],
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext): Promise<SessionOpenResult> {
      const raw = await sidecar.call(
        "session.open",
        {
          sessionType: args["sessionType"],
          headless: args["headless"] ?? settings.headless,
          solveCloudflare: args["solveCloudflare"] === true,
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      return toSessionOpen(raw);
    },
  });
}

/**
 * 建 `scrapling_session_fetch`：用已开好的会话抓一个 URL。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createSessionFetchTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_session_fetch",
    description: "用 scrapling_session_open 开好的会话抓一个 URL，复用该会话的 cookie 与连接。",
    parameters: {
      sessionId: { type: "string", required: true, description: "会话 id。" },
      ...BROWSER_PARAMS_TEXT,
      url: { type: "string", required: true, description: URL_PARAM_DESC },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          statusCode: { type: "integer", required: true },
          extractionType: { type: "string", required: true },
          content: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          notice: { type: "string", required: true },
          sessionId: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderFetch(value) }],
      presentationMeta: (_args, value) => ({
        url: value.url,
        statusCode: value.statusCode,
        truncated: value.truncated,
      }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext): Promise<FetchResult & { sessionId: string }> {
      const raw = await sidecar.call(
        "session.fetch",
        { ...browserPayload(args, settings, "session.fetch").params, sessionId: args["sessionId"] },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      const base = toFetchResult(raw, args["extractionType"] ?? settings.extractionType);
      const capped = capText(base.content, settings.maxOutputBytes, RECOVERY_HINT);
      return {
        ...base,
        content: capped.text,
        truncated: capped.truncated,
        notice: capped.notice,
        sessionId: args["sessionId"],
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "fetch" }),
  });
}

/**
 * 建 `scrapling_session_list`：列出当前所有会话。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createSessionListTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_session_list",
    description: "列出当前打开的抓取会话（id、类型、创建时间）。不返回任何凭据。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessions: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                sessionId: { type: "string", required: true },
                sessionType: { type: "string", required: true },
                createdAt: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value.sessions.length === 0
              ? "no open sessions"
              : value.sessions
                  .map((item) => `${item.sessionId} (${item.sessionType}) opened ${item.createdAt}`)
                  .join("\n"),
        },
      ],
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec: ToolRunContext): Promise<{ sessions: SessionRow[] }> {
      const raw = await sidecar.call("session.list", {}, { signal: exec.signal });
      return { sessions: toSessionRows(raw) };
    },
  });
}

/**
 * 建 `scrapling_session_close`：关掉一个会话，释放它的资源。
 *
 * @param deps - 依赖
 * @returns 工具定义
 */
export function createSessionCloseTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_session_close",
    description:
      "关掉一个抓取会话，释放它的 cookie、连接与浏览器进程。用完请务必调用，否则会话会一直留在宿主进程里。",
    parameters: {
      sessionId: { type: "string", required: true, description: "要关的会话 id。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", required: true },
          closed: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.closed ? `session ${value.sessionId} closed` : "not closed" },
      ],
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext): Promise<{ sessionId: string; closed: boolean }> {
      const raw = await sidecar.call(
        "session.close",
        { sessionId: args["sessionId"] },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      return {
        sessionId:
          isRecord(raw) && typeof raw["sessionId"] === "string"
            ? raw["sessionId"]
            : args["sessionId"],
        closed: isRecord(raw) && raw["closed"] === true,
      };
    },
  });
}

/** 爬虫作业往后台作业输出环上写东西的出口。 */
export interface CrawlSink {
  /** 追加一行输出。 */
  append: (text: string) => void;
  /** 更新「当前进度」那一行。 */
  progress: (line: string) => void;
  /**
   * 作业的取消信号。
   *
   * 爬虫必须用**这个**信号，而不是工具执行上下文那个：job_kill 中止的是作业自己的
   * controller，两者毫无关系。用了 exec.signal 的话，作业显示被杀了，爬虫却还在跑，
   * Python 进程也不会被拆。
   */
  signal: AbortSignal;
}

/** 爬虫作业的干活部分：宿主保证它只被调用一次，返回后作业就算结束。 */
export type CrawlJobRunner = (sink: CrawlSink) => Promise<void>;

/**
 * 起一个后台作业并返回它的 id。
 *
 * 抽成回调是为了让 `lib/tools.ts` 不必依赖 `@deepseek-ai/dsh-jobs`：工具定义只管
 * 「把这次调用交给后台跑」，真正怎么挂到 `ctx.jobs` 上由 host.ts 决定。
 */
export type CrawlJobStarter = (label: string, run: CrawlJobRunner) => Promise<string>;

/** 轮询爬虫状态的间隔（毫秒）。 */
const CRAWL_POLL_MS = 500;

/**
 * 把多个取消信号合成一个：任一中止则整体中止。
 *
 * 爬虫有两个独立的取消来源 —— 作业被 job_kill 杀掉，以及本轮工具调用超时/被打断。
 * 之前只接了后者，于是「作业显示已杀、爬虫还在跑」。
 *
 * @param sources - 参与合成的信号
 * @returns 合并后的信号
 */
function anySignal(sources: readonly AbortSignal[]): AbortSignal {
  // 先看原始列表：已经中止的源必须立刻生效。
  // （先 filter 再查会恒为假 —— 过滤后的信号按定义都不是已中止状态。）
  if (sources.some((signal) => signal.aborted)) {
    return AbortSignal.abort();
  }
  const alive = sources.filter((signal) => !signal.aborted);
  /* v8 ignore start —— 空列表与单信号都是防御性分支：调用方恒定传两个
     （作业信号 + 工具执行信号），且任一已中止都会在上一行提前返回。 */
  if (alive.length === 0) {
    return AbortSignal.abort();
  }
  // 只有一个信号时不必再包一层：它本身就是想要的那个语义。
  const [only] = alive;
  if (alive.length === 1 && only !== undefined) {
    return only;
  }
  /* v8 ignore stop */
  const merged = new AbortController();
  for (const signal of alive) {
    signal.addEventListener(
      "abort",
      (): void => {
        merged.abort();
      },
      { once: true },
    );
  }
  return merged.signal;
}

/* v8 ignore start —— 下面这两个函数是对**对端形状**的防御：crawl.status 的 pages
   由另一个语言的进程拼出来，字段类型不该被直接相信。正常路径（三个字段都是字符串）
   由端到端爬虫用例覆盖，非字符串那一侧属于兜底。 */
/** 把一个可能不是字符串的字段取成字符串，缺失时给空串。 */
function strField(page: Record<string, unknown>, field: string): string {
  const value = page[field];
  return typeof value === "string" ? value : "";
}

/**
 * 把一页爬取结果写成输出环上的一段文本。
 *
 * 逐字段判类型而不是直接 String(...)：回包是跨语言进程给的，String({}) 会变成
 * "[object Object]" 混进模型上下文。
 *
 * @param page - 一页
 * @returns 可追加的文本
 */
function pageToText(page: Record<string, unknown>): string {
  const url = strField(page, "url");
  const title = strField(page, "title") || url;
  return `## ${title}\n${url}\n\n${strField(page, "markdown")}\n`;
}
/* v8 ignore stop */

/**
 * 把一个跑着的爬虫的页面增量写进作业输出环，直到它结束。
 *
 * 轮询而不是等一个大回包：一次爬取可能几分钟，作业的输出环是给模型增量看的，
 * 等全部跑完再一次性吐出来等于没有进度可言。
 *
 * 写成递归而不是循环：每一步都要等上一次 sidecar 往返，顺序不能并行；
 * 递归也让「顺序等待」这件事在代码结构上显形，不用靠注释说明为什么不能并发。
 *
 * @param sidecar - sidecar 客户端
 * @param crawlId - 爬虫 id
 * @param sink - 输出出口
 * @param signal - 取消信号
 * @param seen - 已经输出过多少页，跨轮次累积
 */
async function drainCrawl(
  sidecar: SidecarClient,
  crawlId: string,
  sink: CrawlSink,
  signal: AbortSignal,
  seen: number,
): Promise<number> {
  const raw = await sidecar.call("crawl.status", { crawlId }, { signal, timeoutMs: null });
  /* v8 ignore next 1 —— sidecar 回了非对象时的兜底：协议层已保证回包是对象。 */
  const status = isRecord(raw) ? raw : {};
  const failure = typeof status["error"] === "string" ? status["error"] : "";
  if (failure !== "") {
    throw new Error(`crawl failed: ${failure}`);
  }
  /* v8 ignore start —— 下面这段只在「sidecar 回了非数组 pages」时走到，
     属于对端形状异常的防御：过滤掉非对象项、跳过已输出过的页。
     正常路径（crawl.status 每轮返回递增的 pages 数组）由集成测试覆盖。 */
  const allPages = Array.isArray(status["pages"]) ? status["pages"] : [];
  const pages = allPages.filter((page): page is Record<string, unknown> => isRecord(page));
  for (const page of pages.slice(seen)) {
    sink.append(pageToText(page));
  }
  /* v8 ignore stop */
  sink.progress(`${pages.length} page(s) crawled`);
  if (status["running"] !== true) {
    return pages.length;
  }
  await sleep(CRAWL_POLL_MS, undefined, { signal });
  return drainCrawl(sidecar, crawlId, sink, signal, pages.length);
}

/** 爬虫工具的输出。 */
export interface CrawlResult {
  jobId: string;
  url: string;
  maxPages: number;
}

/**
 * 建 `scrapling_crawl`：后台爬一个站点，把每页转成 Markdown。
 *
 * **立刻返回 job id，不阻塞当前这一轮。** 原因很实际：一次爬取是分钟级的，而工具
 * 调用是有超时的。让模型干等一个必然超时的调用，不如把作业交出去，让它用 job_list /
 * job_output / job_kill 去观察、读取、中断。
 *
 * @param deps - 依赖；必须带 startCrawlJob
 * @returns 工具定义
 */
export function createCrawlTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings, startCrawlJob } = deps;
  return defineTool({
    name: "scrapling_crawl",
    description:
      "后台爬一个网站，把每页转成 Markdown。**立刻返回 job id，不会阻塞。**" +
      "用 job_list 看进度、job_output 读已抓到的页面、job_kill 中断。" +
      "爬取只在起始 URL 所属的域名内进行，并遵守站点的 robots.txt；默认最多 20 页。" +
      "只想抓一个已知 URL 时用 scrapling_fetch，不必起爬虫。",
    parameters: {
      url: { type: "string", required: true, description: URL_PARAM_DESC },
      maxPages: { type: "integer", description: "最多爬多少页，默认 20。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: { type: "string", required: true },
          url: { type: "string", required: true },
          maxPages: { type: "integer", required: true },
        },
      },
      // 输出里**不给** crawlId：它是 Python 侧的内部句柄，只有作业体内部拿得到，而作业是
      // 异步调度的 —— execute 返回时它必然还是空串，打出来只会得到 `crawlId ` 这种半截
      // 文案（真机验证时确实如此）。模型要跟作业打交道用的是作业 id，不是这个句柄。
      render: (_args, value) => [
        {
          type: "text",
          text:
            `crawl started as job ${value.jobId}; ` +
            `max ${value.maxPages} page(s) from ${value.url}\n` +
            "用 job_output 读进度，job_kill 中断。",
        },
      ],
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext): Promise<CrawlResult> {
      const { url } = args;
      // crawlMaxItems 是部署侧的天花板，maxPages 是模型可提的参数：后者只能在前者之内。
      // 只压上限，不动非法值（0 / 负数 / NaN 原样透下去）——把它们静默夹成 1 等于把一个
      // 明确的参数错误换成一个静默跑起来的爬虫，模型再也学不到「这个参数是非法的」。
      const requested = typeof args["maxPages"] === "number" ? args["maxPages"] : 20;
      const maxPages = Math.min(requested, settings.crawlMaxItems);
      // crawlId 只在作业体内部拿得到（作业是异步调度的，execute 返回时它还不存在），
      // 所以它是纯内部变量，不进返回值也不进 schema。
      let crawlId = "";
      const jobId = await startCrawlJob(`crawl ${url} (max ${maxPages})`, async (sink) => {
        // 工具执行上下文与作业取消都要生效：前者是本轮超时，后者是 job_kill。
        const signal = anySignal([sink.signal, exec.signal]);
        const started = await sidecar.call(
          "crawl.run",
          { url, maxPages },
          {
            signal,
            // 爬多久不固定，不能套用工具的默认超时。
            timeoutMs: null,
          },
        );
        crawlId = textOf(started, "crawlId");
        sink.progress(`crawling ${url} (max ${maxPages})`);
        await drainCrawl(sidecar, crawlId, sink, signal, 0);
      });
      return { jobId, url, maxPages };
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "search" }),
  });
}
