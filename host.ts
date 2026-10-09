// dsh-scrapling/host.ts —— Scrapling 网页抓取插件的 Host 半。
//
// 架构：Host 侧不碰网络，只负责（1）探测 Python 与浏览器可用性，（2）用
// ctx.subprocess 拉起一个常驻 Python 进程，（3）通过 stdin/stdout 的 JSON-lines
// 协议把模型请求转成对端调用，（4）做 URL 安全校验与输出封顶。
//
// 为什么走常驻进程而不是每次拉起：Scrapling 的三大增量（浏览器会话、adaptive
// 选择器存储、Spider 断点）都跨请求有状态；每次新进程会把 cookie、SQLite 指纹库
// 和浏览器实例全部丢掉，等于只用了 Scrapling 的静态部分。
//
// 安全不变量（不要在后续 PR 里绕过）：page_action / page_setup / selector_config /
// proxy **绝不**进任何模型可见 schema。浏览器侧的 SSRF 守卫由 Python 侧用自己写的
// 回调注册（见 py/guard.py），模型只能传数据，不能传代码。

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context, Volatile } from "@deepseek-ai/cordis";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { WebFetchBody } from "@deepseek-ai/dsh-web";
import Schema from "@deepseek-ai/schemastery";
import { createSidecar } from "./lib/sidecar.ts";
import { SidecarError } from "./lib/sidecar-error.ts";
import { createUrlPolicy } from "./lib/url-policy.ts";
import { createWebFetchProvider, PROVIDER_ID } from "./lib/web-provider.ts";
import { createWebSearchProvider, SEARCH_PROVIDER_ID } from "./lib/search-provider.ts";
import { createAnswerer, profileRoute } from "./lib/answer.ts";
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
} from "./lib/tools.ts";
import type { CrawlJobRunner, CrawlSink, ToolDeps, ToolSettings } from "./lib/tools.ts";
import type { SidecarCapabilities, SidecarClient } from "./lib/sidecar.ts";

/**
 * 抽取输出的形态。
 *
 * 直接从 dsh 官方的 `WebFetchBody["kind"]` 派生（`'html' | 'text'`），只补上
 * Scrapling 提供而 dsh 内置 web_fetch 没有的 `'markdown'`。不复述官方联合类型，
 * 官方将来加成员时这里自动跟随。
 */
export type ExtractionType = WebFetchBody["kind"] | "markdown";

/** 页面必须就绪的 CSS selector 状态；与 Scrapling 的 SelectorWaitStates 一致。 */
export type WaitSelectorState = "attached" | "detached" | "hidden" | "visible";

/**
 * 插件配置。标 `.volatile()` 的字段会投影成设置卡，用户可改；不标的属于部署级
 * 调参，只能走 cordis.patch.yml 的 `config:` 块。
 */
export interface Config {
  // ---- 环境定位（用户可改）----
  /** Python 解释器名或绝对路径；留空则用 PATH 上的 `python3`。 */
  pythonBin: Volatile<string>;
  /** Scrapling 未安装时是否直接拒绝加载（true）还是降级为「所有工具不可用」。 */
  failFastOnMissingPython: Volatile<boolean>;

  // ---- 每工具开关（用户可改）----
  fetchEnabled: Volatile<boolean>;
  extractEnabled: Volatile<boolean>;
  renderEnabled: Volatile<boolean>;
  captureXhrEnabled: Volatile<boolean>;
  stealthEnabled: Volatile<boolean>;
  sessionEnabled: Volatile<boolean>;
  crawlEnabled: Volatile<boolean>;
  /** scrapling_answer（页面问答）总开关。 */
  answerEnabled: Volatile<boolean>;

  // ---- 抽取与封顶（用户可改，直接影响模型看到的 token 成本）----
  extractionType: Volatile<ExtractionType>;
  mainContentOnly: Volatile<boolean>;
  fetchMaxOutputChars: Volatile<number>;
  extractMaxOutputChars: Volatile<number>;
  renderMaxOutputChars: Volatile<number>;
  xhrMaxOutputChars: Volatile<number>;
  crawlMaxItems: Volatile<number>;
  /**
   * 是否剥掉正文里内嵌的 `data:` URI 图片（只留 alt 文本）。默认开。
   *
   * 这类图片对模型是**纯 token 噪音**：一段 base64 SVG 编码进上下文要按字符计费，而模型
   * 从里面读不出任何图形信息。不含内联图的页面逐字节不变；含内联的页面省掉的量取决于内联图
   * 有多少—— 站点要么一个都不内联，要么就是一整面 logo 墙，中间态很少。所以默认开启对不含
   * 内联图的站点零风险，收益全部出现在命中时。
   *
   * 关掉的理由只有一个：目标是把内联图当**数据**读（例如从 base64 里取配色或指纹）。那属于
   * 罕见用法，所以做成可关而不是写死。
   */
  stripInlineImages: Volatile<boolean>;

  // ---- 浏览器行为（用户可改）----
  headless: Volatile<boolean>;
  networkIdle: Volatile<boolean>;
  blockAds: Volatile<boolean>;
  captureXhrPattern: Volatile<string>;
  waitSelectorState: Volatile<WaitSelectorState>;

  // ---- 超时与进程回收（用户可改）----
  /** 常驻进程拉起后的握手超时（毫秒）。 */
  sidecarHandshakeTimeoutMs: Volatile<number>;
  /** 单次抓取的默认协同超时；声明在 ToolDefinition.timeoutMs 上。 */
  fetchTimeoutMs: Volatile<number>;
  /** 超时后等待进程退出的宽限（毫秒），透传给 ctx.subprocess 的 graceMs。 */
  sidecarGraceMs: Volatile<number>;

  // ---- 部署级（不可 volatile）----
  /** Python 侧单次请求的硬上限（秒），防止模型把一个抓取挂到天荒地老。 */
  requestTimeoutSeconds: number;
  /** 交互式同步 API 的 url 长度上限；与 dsh 内置 web_fetch 的 2048 对齐。 */
  maxUrlLength: number;
  /**
   * 浏览器二进制路径；留空表示用 Playwright 自带的 chromium。
   *
   * **安全相关**：等于让 Chromium 执行这个文件。只从部署配置来，模型入参到不了这里。
   */
  browserExecutablePath: string;
  /**
   * CDP 端点；留空表示由 Playwright 拉起进程。
   *
   * **安全相关**：等于把浏览器交给这个调试端点。只从部署配置来，模型入参到不了这里。
   */
  browserCdpUrl: string;
  /** sidecar 的工作目录；留空则用 ~/.dsh-scrapling。需要可写 —— adaptive 的库落这里。 */
  dataDir: Volatile<string>;
  /**
   * 守卫额外放行的主机名（逗号分隔）。
   *
   * **安全相关**：指到内网地址等于主动放弃对那些目标的 SSRF 防护。默认空 = 最严。
   * 抓自建/内网站点是真实需求（自建 CMS、内网 Git、预发环境），所以留了口子，
   * 但必须由部署方显式设置并自行承担后果。
   */
  /** 是否注册成 ctx.web 的 fetch provider；默认关，打开还需部署侧配 fetchProvider。 */
  provideWebFetch: Volatile<boolean>;
  /** 是否注册成 ctx.web 的 search provider；默认关，打开还需部署侧配 searchProvider。 */
  provideWebSearch: Volatile<boolean>;
  /**
   * 搜索后端端点；留空 = 不提供搜索能力。
   *
   * 部署级：期望 SearXNG 兼容的 JSON 接口（`?q=<query>&format=json`）。Scrapling 自己
   * 不是搜索引擎，检索这一段必须由外部后端做，渲染那一段才由本插件做。
   */
  searchEndpoint: string;
  /** 搜索结果里前几条要真的抓下来渲染；0 表示只给链接列表。 */
  searchRenderTopN: number;
  /**
   * scrapling_answer 用哪个 provider 路由。
   *
   * 留空 = 跟随**当前会话的模型**（`session.requestHeader().config`，会话中途换模型也跟着
   * 变），这与官方内置 web_search 的做法一致，也让插件不额外烧另一份额度。填了就固定用
   * 这一条 —— 想让「读网页」和「写代码」分给不同模型时用得上。
   */
  answerProvider: Volatile<string>;
  /** 配合 answerProvider 的模型 id；answerProvider 为空时这一项也不看。 */
  answerModel: Volatile<string>;
  /** 单次回答的 token 上限。 */
  answerMaxTokens: Volatile<number>;
  /**
   * 守卫额外放行的主机名（逗号分隔）。
   *
   * **安全相关**：指到内网地址等于主动放弃对那些目标的 SSRF 防护。默认空 = 最严。
   * 抓自建/内网站点是真实需求（自建 CMS、内网 Git、预发环境），所以留了口子，
   * 但必须由部署方显式设置并自行承担后果。
   */
  allowedHosts: Volatile<string>;
  /**
   * 手动追加的「代理合成地址段」（CIDR，逗号分隔）。默认空。
   *
   * 正常用不上：fake-ip 型解析器会被自动认出（见 lib/url-policy.ts 的 detectSyntheticResolver），
   * 认出后放宽到 198.18.0.0/15 与 100.64.0.0/10 的**整段**。这一项是给自建池落在那两段之外的
   * 场合兜底的。列进来的段等于放弃对它们的 SSRF 防护。
   */
  syntheticDnsRanges: Volatile<string>;
  /**
   * 抓取走的代理地址，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890；可带
   * user:pass@。留空表示依次跟随环境里的代理变量与操作系统的代理设置。
   *
   * 绝大多数情况留空即可：TUN 模式的代理由系统接管，环境里的 HTTPS_PROXY 与 macOS /
   * Windows 的「系统代理」都会被 Python 侧自动接上。填它是为了压过那两者，或者在使用
   * PAC（自动配置脚本）时手动指定——PAC 要下载脚本并求值，本包不做。
   *
   * **安全相关**：它决定请求从哪儿出去，属于部署级能力，只从设置卡与部署配置来，绝不进入
   * 任何工具 schema。
   */
  proxyUrl: Volatile<string>;
  /** 不走代理的主机名（逗号分隔），对应 NO_PROXY；整台机器直连填 `*`。 */
  proxyBypass: Volatile<string>;
  /**
   * 额外的 NAT64 前缀（形如 `2001:4860:4860::/96`），逗号分隔。
   * 用运营商自建 NAT64 前缀的网络必须在这里声明，否则藏在 IPv6 里的私网 IPv4
   * 会被当成普通公网 IPv6 放行。留空表示只用两个标准化前缀。
   */
  nat64Prefixes: Volatile<string>;
}

const configSchema = Schema.object({
  pythonBin: Schema.string().default("").volatile(),
  failFastOnMissingPython: Schema.boolean().default(true).volatile(),

  fetchEnabled: Schema.boolean().default(true).volatile(),
  extractEnabled: Schema.boolean().default(true).volatile(),
  renderEnabled: Schema.boolean().default(true).volatile(),
  captureXhrEnabled: Schema.boolean().default(true).volatile(),
  // stealth 与 crawl 默认关：前者要 patchright 浏览器，后者是重量级后台任务。
  stealthEnabled: Schema.boolean().default(false).volatile(),
  sessionEnabled: Schema.boolean().default(true).volatile(),
  crawlEnabled: Schema.boolean().default(false).volatile(),
  answerEnabled: Schema.boolean().default(true).volatile(),

  extractionType: Schema.union(["markdown", "html", "text"]).default("markdown").volatile(),
  mainContentOnly: Schema.boolean().default(true).volatile(),
  fetchMaxOutputChars: Schema.natural().min(1).default(200_000).volatile(),
  extractMaxOutputChars: Schema.natural().min(1).default(200_000).volatile(),
  renderMaxOutputChars: Schema.natural().min(1).default(200_000).volatile(),
  xhrMaxOutputChars: Schema.natural().min(1).default(120_000).volatile(),
  crawlMaxItems: Schema.natural().min(1).default(1000).volatile(),
  // 内嵌 base64 图片是纯 token 噪音，默认剥掉；要读原始 data URI 的场景才关。
  stripInlineImages: Schema.boolean().default(true).volatile(),

  headless: Schema.boolean().default(true).volatile(),
  networkIdle: Schema.boolean().default(false).volatile(),
  blockAds: Schema.boolean().default(true).volatile(),
  captureXhrPattern: Schema.string().default(".*").volatile(),
  waitSelectorState: Schema.union(["attached", "detached", "hidden", "visible"])
    .default("attached")
    .volatile(),

  // 这三个是 settings 卡可调的：接口声明 Volatile、消费处一律 .get()、测试夹具也按引用
  // 构造。漏掉 .volatile() 时 schema 产出的是裸值，.get() 就是 TypeError —— 而 TypeScript
  // 信的是接口，测试夹具也照接口造，类型检查与单测都看不出来，只有宿主真正 resolve 之后
  // 加载插件才会炸。
  sidecarHandshakeTimeoutMs: Schema.natural().min(1).default(30_000).volatile(),
  fetchTimeoutMs: Schema.natural().min(1).default(120_000).volatile(),
  sidecarGraceMs: Schema.natural().min(1).default(5000).volatile(),
  // 下面这些刻意保持非 volatile：部署级旋钮，不进设置卡，只走 cordis.patch.yml 的
  // config: 块。消费处也就不调 .get()，保持裸值语义。
  requestTimeoutSeconds: Schema.natural().min(1).default(120),
  maxUrlLength: Schema.natural().min(1).default(2048),
  // 浏览器二进制路径：给装在非标准位置的企业镜像 / 便携版 Chromium 用的。
  browserExecutablePath: Schema.string().default(""),
  // CDP 端点：让浏览器连到一个已在运行的实例（如带着登录态的调试浏览器）。留空表示由
  // Playwright 自己拉起进程。两项都是部署级强能力，模型入参一律到不了这里。
  browserCdpUrl: Schema.string().default(""),
  nat64Prefixes: Schema.string().default("").volatile(),
  dataDir: Schema.string().default("").volatile(),
  provideWebFetch: Schema.boolean().default(false).volatile(),
  provideWebSearch: Schema.boolean().default(false).volatile(),
  // 搜索后端端点（部署级）。空 = 不提供搜索能力，search provider 的 available() 为 false。
  searchEndpoint: Schema.string().default(""),
  // 搜索结果里前几条要真的抓下来渲染。渲染正是这半个需求的价值：内置 web_fetch 结构上
  // 读不到 SPA，这里走的是带浏览器的路径。
  searchRenderTopN: Schema.natural().min(0).default(3),
  // 回答模型：三项都留空就是「跟随会话当前模型」，也就是官方内置 web_search 的做法。
  answerProvider: Schema.string().default("").volatile(),
  answerModel: Schema.string().default("").volatile(),
  answerMaxTokens: Schema.natural().min(1).default(2000).volatile(),
  allowedHosts: Schema.string().default("").volatile(),
  // 代理软件合成的 DNS 答案要放行才抓得了东西，默认关。不开代理就不需要它。
  syntheticDnsRanges: Schema.string().default("").volatile(),
  proxyUrl: Schema.string().default("").volatile(),
  proxyBypass: Schema.string().default("").volatile(),
});

// 同名再导出：interface 提供类型面，schema 提供运行时校验面（宿主据此渲染设置卡
// 并校验 cordis.patch.yml 里的 `config:`）。这是 dsh 插件的约定写法。
export { configSchema as Config };

/**
 * 登记本插件的作业类型。
 *
 * `JobKindMap` 是官方留的「可合并扩展」点：作业 id 的前缀也由它决定（`scrapling-1`）。
 * 不声明的话只能用内置的 bash/subagent，模型在 job_list 里会把爬虫误认成 shell 作业。
 */
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    scrapling: "scrapling";
  }
}

/** 插件 id（同时是设置卡命名空间，由 cordis.patch.yml 的 `id` 字段决定）。 */
export const name = "scrapling";

/**
 * 插件注入的服务。
 *
 * `subprocess` 是关键：没有它 sidecar 起不来，插件也就没有存在的意义。与官方
 * tool-web / tool-lsp 同样的写法（工具 + 自己的 seam + systemPrompt）。
 */
export const inject = ["tools", "subprocess", "web", "systemPrompt", "settings"];

/**
 * Host 半真正用到的那一点 settings 服务面。
 *
 * 窄声明而不是直接用 `Context["settings"]`：那条类型挂在 `@deepseek-ai/dsh-settings` 的
 * 模块增强上，本包不 import 它（只把它当可选 peer），增强就不会进本包的类型图，写出来
 * 的是 `ctx.settings` 编译不过。少声明一个面总比多依赖一个类型来源稳。
 */
interface SettingsFace {
  readonly settings: {
    configure: (presentation: { auto?: boolean }, owner?: Context["fiber"]) => () => void;
  };
}

/** 每工具开关的**快照**。 */
export interface ToolFlags {
  fetch: boolean;
  extract: boolean;
  render: boolean;
  captureXhr: boolean;
  stealth: boolean;
  session: boolean;
  crawl: boolean;
  answer: boolean;
}

/**
 * 从 Config 现取一次 volatile 快照。
 *
 * 引用可以随时被设置卡改写，所以按 cosmokit 的约定「capture its value for one
 * operation only」——每次决策现取一次，不长期缓存。
 *
 * @param config - 宿主传入的配置
 * @returns 每工具开关的真值快照
 */
export function snapshotFlags(config: Config): ToolFlags {
  return {
    fetch: config.fetchEnabled.get(),
    extract: config.extractEnabled.get(),
    render: config.renderEnabled.get(),
    captureXhr: config.captureXhrEnabled.get(),
    stealth: config.stealthEnabled.get(),
    session: config.sessionEnabled.get(),
    crawl: config.crawlEnabled.get(),
    answer: config.answerEnabled.get(),
  };
}

/** 一个工具对运行环境的最低要求。 */
export type ToolRequirement = "scrapling" | "browser" | "stealth";

/** 工具构造器：名字到「给定依赖造一个工具定义」的映射。 */
type ToolBuilder = (deps: ToolDeps) => ToolDefinition;

/** 工具登记表里的一项。 */
export interface ToolSpec {
  /** 模型可见的工具名。 */
  readonly name: string;
  /** 用户侧的开关字段名（ToolFlags 上的键）。 */
  readonly flag: keyof ToolFlags;
  /** 对运行环境的最低要求。 */
  readonly requires: ToolRequirement;
  /** 造这个工具的构造器。 */
  readonly build: ToolBuilder;
}

/**
 * 十一个工具的登记表。
 *
 * 顺序即注册顺序，也方便测试逐条对照。构造器直接挂在每一项上，而不是另开一张
 * 「名字 → 构造器」表：两张表只要有一处对不上，`apply` 就会拿不到构造器而跳过那条，
 * 工具于是**静默地不注册** —— 日志里只有一行 warn，模型那边只是看不见这个工具，
 * 而 100% 覆盖率照样是绿的（跳过的分支也被走到了）。合成一张表之后这种走散无从发生。
 */
export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: "scrapling_fetch", flag: "fetch", requires: "scrapling", build: createFetchTool },
  { name: "scrapling_extract", flag: "extract", requires: "scrapling", build: createExtractTool },
  {
    name: "scrapling_render",
    flag: "render",
    requires: "browser",
    build: createRenderTool,
  },
  {
    name: "scrapling_capture_xhr",
    flag: "captureXhr",
    requires: "browser",
    build: createCaptureXhrTool,
  },
  {
    name: "scrapling_stealth_fetch",
    flag: "stealth",
    requires: "stealth",
    build: createStealthFetchTool,
  },
  // 会话类是四个独立工具而不是一个：开/用/列/关各自是一次独立动作，模型按当前持有
  // 的句柄挑该调哪一个，合成一个工具就得让它再吃一个 action 参数把这一步路由出去。
  // 四条共用同一个 flag，开关关掉时是四条一起消失。
  {
    name: "scrapling_session_open",
    flag: "session",
    requires: "scrapling",
    build: createSessionOpenTool,
  },
  {
    name: "scrapling_session_fetch",
    flag: "session",
    requires: "scrapling",
    build: createSessionFetchTool,
  },
  {
    name: "scrapling_session_list",
    flag: "session",
    requires: "scrapling",
    build: createSessionListTool,
  },
  {
    name: "scrapling_session_close",
    flag: "session",
    requires: "scrapling",
    build: createSessionCloseTool,
  },
  { name: "scrapling_crawl", flag: "crawl", requires: "scrapling", build: createCrawlTool },
  {
    name: "scrapling_answer",
    flag: "answer",
    requires: "scrapling",
    build: createAnswerTool,
  },
];

/**
 * 一个工具的输出预算取自哪枚设置项。
 *
 * 三种抓取面的正文体量差一个数量级（静态 HTML、渲染后的 DOM、XHR 快照），共用一个
 * 旋钮就没有分别调节的余地。会话类工具产出的是句柄与列表而非页面正文，跟渲染同档。
 *
 * 导出是为了能被直接测。这一层只被 apply() 的注册循环覆盖到，而注册取决于运行环境：
 * 没有浏览器时 scrapling_capture_xhr 不注册，它那一支不会被执行，覆盖率也就看不出缺的是
 * 哪一段。
 *
 * @param config - 已解析的设置
 * @param toolName - 工具名
 * @returns 该工具的字节预算
 */
export function outputBudgetOf(config: Config, toolName: string): number {
  if (toolName === "scrapling_fetch") {
    return config.fetchMaxOutputChars.get();
  }
  if (toolName === "scrapling_extract") {
    return config.extractMaxOutputChars.get();
  }
  if (toolName === "scrapling_capture_xhr") {
    return config.xhrMaxOutputChars.get();
  }
  return config.renderMaxOutputChars.get();
}

/** 内部哨兵：区分「无需环境」与「环境已满足」，两者都不等于「环境缺失」。 */
const NONE = "none" as const;

/** 一个工具没被注册的原因。 */
export type SkipReason = "disabled" | "scrapling-missing" | "browser-missing" | "stealth-missing";

/** 注册计划的结果。 */
export interface ToolPlan {
  /** 会被注册的工具名，按登记表顺序。 */
  readonly ready: readonly string[];
  /** 被跳过的工具与原因，供日志与设置卡提示使用。 */
  readonly skipped: readonly { name: string; reason: SkipReason }[];
}

/**
 * 算出这次该注册哪些工具。
 *
 * 两个维度同时看：用户的开关，以及运行环境到底具备什么。前者是用户说了算，后者是
 * 探测出来的既成事实 —— 缺能力时**不注册**而不是注册了再报错，这样模型根本看不到
 * 一个必然失败的工具，不会白白浪费一轮。
 *
 * @param flags - 每工具开关快照
 * @param capabilities - sidecar 握手报上来的能力；undefined 表示尚未探测成功
 * @returns 注册计划
 */
export function planTools(
  flags: ToolFlags,
  capabilities: SidecarCapabilities | undefined,
): ToolPlan {
  const ready: string[] = [];
  const skipped: { name: string; reason: SkipReason }[] = [];
  const satisfied = (requires: ToolRequirement): SkipReason | typeof NONE => {
    // 还没握手成功时一律按「缺 scrapling」处理：没有 scrapling，后面什么都没意义。
    if (capabilities === undefined || !capabilities.scrapling) {
      return "scrapling-missing";
    }
    if (requires === "scrapling") {
      return NONE;
    }
    if (requires === "browser" && !capabilities.browser) {
      return "browser-missing";
    }
    if (requires === "stealth" && !capabilities.stealth) {
      return "stealth-missing";
    }
    return NONE;
  };

  for (const spec of TOOL_SPECS) {
    const missing = satisfied(spec.requires);
    const enabled = flags[spec.flag];
    if (missing === NONE) {
      // 环境满足：开关开就注册，关就记 disabled。
      if (enabled) {
        ready.push(spec.name);
      } else {
        skipped.push({ name: spec.name, reason: "disabled" });
      }
    } else {
      skipped.push({ name: spec.name, reason: missing });
    }
  }
  return { ready, skipped };
}

/**
 * 解析 sidecar 的工作目录。
 *
 * profile 目录没有暴露给插件（`ocr-review` 也是退回 `os.homedir()` 派生），所以这里
 * 沿用同样的做法：默认落在 `~/.dsh-scrapling`，用户可以在设置里改。这个目录要能写 ——
 * adaptive 的 SQLite 指纹库就落在这里。
 *
 * @param configured - 用户配置的目录；空白则用默认
 * @returns 绝对路径
 */
export function resolveDataDir(configured: string): string {
  const trimmed = configured.trim();
  if (trimmed.length > 0) {
    return path.resolve(trimmed);
  }
  return path.join(os.homedir(), ".dsh-scrapling");
}

/**
 * 确保 sidecar 的工作目录存在。
 *
 * 这是必须的：`ctx.subprocess` 拿到一个不存在的 `cwd` 会直接 ENOENT，而 sidecar 还没
 * 起来，报错只会表现为「进程起不来」，看不出根因是目录缺失。目录里还要放 adaptive 的
 * SQLite 指纹库，本来就得可写。
 *
 * @param dir - 绝对路径
 */
async function ensureDataDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * sidecar 启动失败时的兜底文案。
 *
 * 统一走 String() 而不对 Error 分流：`String(new Error("x"))` 得到 "Error: x"，
 * 既带上了错误类名又带着消息，比只取 message 信息更多；少一条分支也就少一处
 * 「测试永远走不到」的代码。
 *
 * @param error - 捕获到的任意值
 * @returns 可直接进日志的一行
 */
/**
 * 当前爬虫作业的输出出口。
 *
 * 爬虫工具声明了不可并发，同一时刻最多一个作业 —— 用单个槽位即可，不需要任务队列。
 * sidecar 推来的进度事件没有 id，只能走事件通道，直接写进这个槽位。
 */
let currentCrawlSink: CrawlSink | undefined;

/**
 * 把作业句柄包装成工具层要的输出出口。
 *
 * @param job - 作业句柄
 * @returns 输出出口
 */
function sinkOf(
  job: { append: (text: string) => void; updateProgress: (line: string) => void },
  signal: AbortSignal,
): CrawlSink {
  return {
    append: (text): void => {
      job.append(text);
    },
    progress: (line): void => {
      job.updateProgress(line);
    },
    signal,
  };
}

/**
 * 起一个爬虫后台作业。
 *
 * 作业产出者返回的 `done` **不能 reject**：运行时会把 rejection 翻成 `failed`，而那
 * 只是记录状态、不代表工作真的停了。所有失败都走显式的 `killed` outcome，语义才准确。
 *
 * @param ctx - 宿主上下文
 * @param label - 一行说明（模型可见）
 * @param run - 作业主体
 * @returns 作业 id
 */
function startCrawlJob(ctx: Context, label: string, run: CrawlJobRunner): Promise<string> {
  // jobs 是**可选服务**：并非每个 profile 都装了作业后端，而爬虫默认也是关的，因此它不在
  // inject 里。文档的规则是可选服务一律用 ctx.get(name) 取 —— 属性代理 ctx.jobs 走的是
  // 只向祖先的 fiber 遍历（cordis vendor/cordis/src/reflect.ts），而 jobs 由兄弟 fiber 提供时
  // 那次遍历会一路走到 root 然后抛错；ctx.get 走全局 isolate store，与拓扑无关。
  // 在使用点取而不是 apply 时取一次：作业后端可能在插件装上之后才出现。
  const jobs = ctx.get("jobs");
  if (jobs === undefined) {
    return Promise.reject(
      new SidecarError(
        "JOBS_UNAVAILABLE",
        "这个 profile 没有作业后端（ctx.jobs 不可用），scrapling_crawl 需要它来跑后台作业",
      ),
    );
  }
  // jobs.start 本身是同步的；用 Promise.resolve 包一层是为了匹配工具层那条
  // async 契约 —— 免得以后真要等点什么（比如先确认会话）时再改两边。
  return Promise.resolve(
    jobs.start({
      kind: "scrapling",
      label,
      run: (job) => {
        const controller = new AbortController();
        // 取消只置 signal：真正拆掉 Python 进程的是 sidecar 客户端收到 abort 后的自毁逻辑。
        controller.signal.addEventListener(
          "abort",
          () => {
            currentCrawlSink = undefined;
          },
          { once: true },
        );
        const sink = sinkOf(job, controller.signal);
        currentCrawlSink = sink;
        const done = (async (): Promise<JobOutcome> => {
          try {
            await run(sink);
            return { status: "completed" };
          } catch (error: unknown) {
            currentCrawlSink = undefined;
            return {
              status: "killed",
              detail: String(error),
            };
          }
        })();
        return {
          cancel: (): void => {
            controller.abort();
          },
          done,
        };
      },
    }),
  );
}

function probeFailure(error: unknown): string {
  return `[dsh-scrapling] 未能启动 Python sidecar：${String(error)}`;
}

/**
 * 插件入口。
 *
 * 流程：建客户端 → 探测能力 → 按「开关 ∩ 能力」注册工具。工具本体的注册在后续阶段接上，
 * 这里先把接线与注册计划跑通。
 *
 * 能力探测会真的拉起一个 Python 进程（约 0.5 秒到 2 秒），所以 `apply` 是 async 的 ——
 * 官方也这么做（`packages/fs/tool-fs-search/src/index.ts:128`）。
 *
 * @param ctx - 宿主上下文
 * @param config - 已由 schemastery 填满默认值的配置
 */
/**
 * Host 侧出站 URL 准入闸门：判否就地抛 `URL_BLOCKED`，请求根本不发出去。
 *
 * 这是 `lib/url-policy.ts` 的落点——那份判定此前只被自己的测试引用，生产路径上没有任何人
 * 构造过策略对象，等于 Host 侧那道 SSRF 防线一直没有生效（真防线只有 Python 侧
 * guard.py 一道）。两侧都要有：Host 侧判完到子进程真连之间隔着一个进程边界，
 * DNS 记录在这中间被改就能绕过（TOCTOU）。
 *
 * 策略参数里的 `nat64Prefixes` 来自同一枚设置，与 Python 侧共用同一份配置，两边判定同解。
 *
 * @param config - 已解析的设置
 * @returns 闸门函数；判否时 reject，通过时交回归一后的 URL
 */
/**
 * 取这次抓取要用的代理地址：设置卡上的 proxyUrl 优先，否则跟随环境的代理变量。
 *
 * 浏览器引擎不认环境变量，所以显式配置是让 render / capture_xhr / stealth 走代理的唯一
 * 办法；静态抓取由 curl_cffi 自行读环境，两者因此共用这一个来源。
 *
 * @param config - 已解析的设置
 * @returns 代理地址；留空表示跟随环境
 */
function proxyOf(config: Config): string {
  return config.proxyUrl.get().trim();
}

export function createUrlGate(config: Config): (url: string) => Promise<string> {
  const nat64Prefixes = config.nat64Prefixes
    .get()
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const allowHosts = config.allowedHosts
    .get()
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const policy = ((): ReturnType<typeof createUrlPolicy> => {
    try {
      const syntheticRanges = config.syntheticDnsRanges
        .get()
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return createUrlPolicy({
        maxUrlLength: config.maxUrlLength,
        ...(nat64Prefixes.length > 0 ? { nat64Prefixes } : {}),
        ...(allowHosts.length > 0 ? { allowHosts } : {}),
        ...(syntheticRanges.length > 0 ? { syntheticRanges } : {}),
      });
    } catch (error) {
      // 方向是**拒绝加载**而不是「忽略这一条」：丢掉一个前缀 = 把它内嵌的私网 IPv4 当成
      // 普通公网 IPv6 放行，比「插件起不来」危险得多。把底层那条原始 Error 换成一句
      // 部署方读得懂的话，指明该改哪个设置项、长什么样。
      throw new SidecarError(
        "CONFIG_INVALID",
        `nat64Prefixes 配置非法：${String(error)}。每项须形如 <IPv6 前缀>/<32|40|48|56|64|96>，` +
          "逗号分隔。插件已拒绝加载，以免把藏在 IPv6 里的私网 IPv4 当成公网放行。",
      );
    }
  })();
  return async (url: string): Promise<string> => {
    const verdict = await policy.verify(url);
    if (!verdict.ok) {
      throw new SidecarError("URL_BLOCKED", `${url}: ${verdict.message}`);
    }
    // 交回归一串，让 sidecar 发出去的与这里判过的是同一个地址。
    return verdict.url.toString();
  };
}

/**
 * 把本插件注册成 ctx.web 的 fetch provider，让内置 web_fetch 由 Scrapling 执行。
 *
 * 抽出来是为了让 apply() 保持可读；两件事都必须在部署侧再配一次
 * `fetchProvider: "scrapling"` / `searchProvider: "scrapling"`，否则 ctx.web 会因为出现
 * 多个可用 provider 而报 WEB_PROVIDER_AMBIGUOUS，把内置工具直接弄坏。
 *
 * @param ctx - 宿主上下文
 * @param sidecar - 已握手的 sidecar 客户端
 * @param config - 已解析的设置
 */
function registerFetchProvider(ctx: Context, sidecar: SidecarClient, config: Config): void {
  const provider = createWebFetchProvider({
    sidecar,
    maxOutputBytes: config.fetchMaxOutputChars.get(),
    timeoutMs: config.fetchTimeoutMs.get(),
  });
  if (!provider.available()) {
    ctx.logger.warn("[dsh-scrapling] 跳过注册 fetch provider：sidecar 尚未可用");
    return;
  }
  ctx.web.registerFetchProvider(provider);
  ctx.logger.info(
    `[dsh-scrapling] 已注册 ctx.web fetch provider（id=${PROVIDER_ID}）。` +
      '内置 web_fetch 要真正走它，部署配置里还需写 fetchProvider: "scrapling"。',
  );
}

/**
 * 把本插件注册成 ctx.web 的 search provider，让内置 web_search 走「检索 + 渲染」。
 *
 * 需要同时具备两样东西：sidecar 可用，以及部署侧配了 searchEndpoint —— 检索这一段
 * Scrapling 自己做不到（它不是搜索引擎），只有渲染那一段归本插件。
 *
 * @param ctx - 宿主上下文
 * @param sidecar - 已握手的 sidecar 客户端
 * @param config - 已解析的设置
 */
function registerSearchProvider(ctx: Context, sidecar: SidecarClient, config: Config): void {
  const provider = createWebSearchProvider({
    sidecar,
    searchEndpoint: config.searchEndpoint,
    renderTopN: config.searchRenderTopN,
    maxOutputBytes: config.fetchMaxOutputChars.get(),
    timeoutMs: config.fetchTimeoutMs.get(),
  });
  if (!provider.available()) {
    ctx.logger.warn(
      "[dsh-scrapling] 跳过注册 search provider：需要 sidecar 可用且配置了 searchEndpoint",
    );
    return;
  }
  ctx.web.registerSearchProvider(provider);
  ctx.logger.info(
    `[dsh-scrapling] 已注册 ctx.web search provider（id=${SEARCH_PROVIDER_ID}）。` +
      '内置 web_search 要真正走它，部署配置里还需写 searchProvider: "scrapling"。',
  );
}

export async function apply(ctx: Context & SettingsFace, config: Config): Promise<void> {
  // 登记「本页由自带卡片编辑」。`auto: false` 是告诉宿主别再自动生成一份通用表单 ——
  // 自动那份会把 36 个字段摊成没有分组、没有说明的长列表，而真正在编辑这张卡的
  // client.js 已经按用途分了组、补了「改了会怎样」。
  //
  // 这行不是可有可无的礼貌：宿主侧的设置投影一直存在（命名空间由 cordis.patch.yml 的
  // `id` 决定），缺的只是页面。哪天宿主开始自动生成页面而我们没登记，用户就会同时看到
  // 两份互相覆盖的表单。
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), "scrapling: settings page");

  const flags = snapshotFlags(config);
  const dataDir = resolveDataDir(config.dataDir.get());
  const bridgePath = path.join(import.meta.dirname, "py", "bridge.py");
  try {
    await ensureDataDir(dataDir);
  } catch (error) {
    ctx.logger.warn(probeFailure(error));
    return;
  }

  const sidecar = createSidecar(ctx, {
    pythonBin: config.pythonBin.get() || "python3",
    bridgePath,
    cwd: dataDir,
    handshakeTimeoutMs: config.sidecarHandshakeTimeoutMs.get(),
    requestTimeoutMs: config.fetchTimeoutMs.get(),
    graceMs: config.sidecarGraceMs.get(),
    urlGate: createUrlGate(config),
    env: {
      DSH_SCRAPLING_ALLOWED_HOSTS: config.allowedHosts.get(),
      // 自建 NAT64 前缀必须送到 Python 侧，否则藏在里面的私网 IPv4 会被当公网放行。
      DSH_SCRAPLING_NAT64_PREFIXES: config.nat64Prefixes.get(),
      // 合成段与代理都必须两侧同解，否则 Host 侧放行了、Python 侧守卫照样 abort 浏览器请求，
      // 表现为 Page.goto: net::ERR_FAILED。
      DSH_SCRAPLING_SYNTHETIC_RANGES: config.syntheticDnsRanges.get(),
      DSH_SCRAPLING_PROXY: proxyOf(config),
      DSH_SCRAPLING_PROXY_BYPASS: config.proxyBypass.get(),
    },
    log: (line) => {
      ctx.logger.debug(line);
    },
    onEvent: (frame) => {
      // 进度事件没有 id，只能走事件通道；没有作业在跑时直接丢掉。
      /* v8 ignore start —— 非字符串 text 的兜底到不了：py/crawl.py 每帧都带 text。
         留着只为防对端改协议时打挂宿主（那时退回整帧 JSON 也还读得懂）。 */
      const text = typeof frame["text"] === "string" ? frame["text"] : JSON.stringify(frame);
      currentCrawlSink?.append(`${text}\n`);
    },
  });

  // 进程随插件卸载一起回收。disposer 把 promise 直接交回去：cordis 的
  // `Disposable<T> = () => T` 允许返回任意值，宿主会 await 它 —— 这样能保证
  // 「插件已卸载」返回时 Python 进程与浏览器一定收干净，而不是留在后台。
  const disposeSidecar = (): Promise<void> => sidecar.dispose();
  ctx.effect(() => disposeSidecar);

  let capabilities: SidecarCapabilities | undefined;
  try {
    capabilities = await sidecar.ensureStarted();
  } catch (error) {
    // failFastOnMissingPython=true（默认）＝拒绝加载：Python 装不上时本插件没有半个功能可用，
    // 静默降级只会让模型在几轮之后才发现工具全都不见了。false 才走降级：警告，然后按
    // 「所有工具不可用」注册（planTools 对 capabilities===undefined 的既有行为）。
    if (config.failFastOnMissingPython.get()) {
      throw error;
    }
    ctx.logger.warn(probeFailure(error));
  }

  const plan = planTools(flags, capabilities);
  for (const item of plan.skipped) {
    if (item.reason !== "disabled") {
      ctx.logger.warn(`[dsh-scrapling] ${item.name} 不注册：${item.reason}`);
    }
  }

  // 按计划真正注册。工具构造器按名字索引而不是散在各处，避免「登记表加了一个工具却忘了
  // 在这里接线」这种漏注册 —— 下面的断言会在缺构造器时立刻炸出来。
  const startJob = (label: string, run: CrawlJobRunner): Promise<string> =>
    startCrawlJob(ctx, label, run);
  // 回答模型：三项配置全空就跟随会话当前模型，与官方内置 web_search 的做法一致。
  // profile 默认值只当兜底 —— 会话发起的调用总能读到活的请求头。
  const answerProvider = config.answerProvider.get().trim();
  const answerModel = config.answerModel.get().trim();
  const defaultSelection = profileRoute(ctx.get("agentDefaultModel"));
  const answer = createAnswerer({
    ctx,
    override:
      answerProvider.length > 0 && answerModel.length > 0
        ? { provider: answerProvider, model: answerModel }
        : undefined,
    fallback: defaultSelection,
    maxTokens: config.answerMaxTokens.get(),
  });
  const baseSettings = {
    extractionType: config.extractionType.get(),
    mainContentOnly: config.mainContentOnly.get(),
    timeoutMs: config.fetchTimeoutMs.get(),
    headless: config.headless.get(),
    networkIdle: config.networkIdle.get(),
    pageTimeoutMs: config.fetchTimeoutMs.get(),
    waitSelectorState: config.waitSelectorState.get(),
    captureXhrPattern: config.captureXhrPattern.get(),
    requestTimeoutSeconds: config.requestTimeoutSeconds,
    blockAds: config.blockAds.get(),
    crawlMaxItems: config.crawlMaxItems.get(),
    maxUrlLength: config.maxUrlLength,
    browserExecutablePath: config.browserExecutablePath,
    browserCdpUrl: config.browserCdpUrl,
    stripInlineImages: config.stripInlineImages.get(),
  };
  const ready = new Set(plan.ready);
  for (const spec of TOOL_SPECS) {
    if (ready.has(spec.name)) {
      // 预算按工具分别给：静态抓取的正文、浏览器渲染后的正文、XHR 快照三者体量差一个
      // 数量级，共用一份预算等于把三档调节压成一档——调 fetch 的旋钮会连带改掉 render。
      const settings: ToolSettings = {
        ...baseSettings,
        maxOutputBytes: outputBudgetOf(config, spec.name),
      };
      ctx.tools.register(spec.build({ sidecar, settings, startCrawlJob: startJob, answer }));
    }
  }

  if (config.provideWebFetch.get()) {
    registerFetchProvider(ctx, sidecar, config);
  }

  if (config.provideWebSearch.get()) {
    registerSearchProvider(ctx, sidecar, config);
  }

  ctx.logger.info(
    `[dsh-scrapling] 能力 ${JSON.stringify(capabilities ?? null)}；` +
      `注册 ${plan.ready.length}/${TOOL_SPECS.length}：${plan.ready.join(", ") || "(none)"}`,
  );
}
