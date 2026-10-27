// dsh-scrapling/test/protocol-conformance.test.ts —— 两侧各读各的字典，中间必须有人对表。
//
// Host 侧把 params 拼成一帧 JSON，Python 侧用 `args.get("...")` 取 —— 两串字符串之间没有
// 任何编译期或运行期约束。三类真实故障形态，全都不会让任何一侧单独变红：
//
// 1. **方法名写错**：Python 回 `UNKNOWN_METHOD`。至少会报错，看得见。
// 2. **发了没人读**：Host 以为拧了旋钮，Python 从来不看那个键。表现是「设置项无效」，
//    一行日志都没有 —— 比方法名写错更贵。
// 3. **读了没人发**：Python 里那段分支永远走不到，是**看起来活着**的死代码。而工具 schema
//    一旦把同名键声明给模型，模型就会照着填、填完静默消失：契约上写了，行为上没有。
//
// 判据两侧都取自动态执行与源码本身，不取注释、不取 README：
// * TS 侧**真的驱动每个工具的 `execute()`**（sidecar 换成记录器），拿到线上实发的键；
//   入参不手写，而是**从每个工具自己声明的 schema 生成**，于是「schema 声明了但没转发」
//   这一类漂移不可能被我的手写夹具放过。
// * Python 侧解析 `args.get(...)` / `args[...]` / `deployment.get(...)`，并沿调用图把
//   `_extraction(args)` 这类辅助函数读到的键并进来。
//
// 允许表里每一项都要写明理由 —— 那是「这段不对称是故意的」唯一的记录处。

import path from "node:path";
import { describe, expect, it } from "vitest";
import { SidecarClient } from "../lib/sidecar.ts";
import { TOOL_SPECS } from "../host.ts";
import { createWebSearchProvider } from "../lib/search-provider.ts";
import { runProbe } from "./probe.ts";
import type { CrawlJobRunner, ToolSettings } from "../lib/tools.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const BRIDGE = path.join(REPO, "py", "bridge.py");

/** 一次线上调用：方法名 + 实发的键（嵌套键写成 `父.子`）。 */
interface WireCall {
  method: string;
  keys: string[];
}

/** 一个工具跑完之后的观测结果。 */
interface ToolObservation {
  /** 线上实发的调用。 */
  calls: WireCall[];
  /** schema 声明给模型的入参名。 */
  declared: string[];
}

/** 一份把部署旋钮都点亮、并且不会触发截断的设置。 */
const SETTINGS: ToolSettings = {
  extractionType: "markdown",
  mainContentOnly: true,
  maxOutputBytes: 4000,
  timeoutMs: 30_000,
  headless: true,
  networkIdle: true,
  pageTimeoutMs: 30_000,
  waitSelectorState: "visible",
  pierceShadow: true,
  requestTimeoutSeconds: 120,
  blockAds: true,
  crawlMaxItems: 1000,
  crawlMaxRuntimeSeconds: 1800,
  browserExecutablePath: "/tmp/chromium",
  browserCdpUrl: "",
  browserInitScript: "/tmp/init.js",
  browserRealChrome: false,
  browserDnsOverHttps: true,
  recordRequests: true,
  maxRecordedRequests: 100,
  sessionStateDir: "/tmp/scrapling-state",
  adaptiveStorage: "sqlite",
  redisUrl: "redis://127.0.0.1:6379/0",
  crawlRespectRobots: false,
  crawlDownloadDelayMs: 0,
  crawlConcurrentRequests: 4,
  crawlAutothrottle: false,
  crawlStrategy: "bfs",
  crawlCheckpointDir: "",
  // 对表要跑**满参数面**：写方法开放时 method/body 才在参数面与线路上，两侧才逐键对得上。
  // 关掉那一档的形状由 test/tools.test.ts 单独钉（那里判的是「参数面里根本没有这两个键」）。
  allowWriteMethods: true,
  stripInlineImages: true,
  downloadDir: "/tmp/scrapling-downloads",
  downloadMaxBytes: 10_000_000,
};

const SAMPLE_URL = "https://example.com/page";

/** 空实现：本用例只关心发出去的帧，输出内容无人读。 */
function noop(): void {
  // 刻意什么都不做。
}

/**
 * 按参数名给一个能通过校验的值。
 *
 * 这些值必须是**合法**的：Python 侧对 extractionType / method / sessionType 都有取值校验，
 * 非法值会让调用在到达引擎之前就没收，本用例要量的「线上到底发了哪些键」就跟着失真。
 */
const BY_NAME: Record<string, unknown> = {
  url: SAMPLE_URL,
  startUrl: SAMPLE_URL,
  extractionType: "markdown",
  method: "GET",
  sessionType: "static",
  imageType: "png",
  selector: "h1",
  html: "<html><body><h1>hi</h1></body></html>",
  body: { a: 1 },
  params: { page: "1" },
  form: { field: "1" },
  json: { field: 1 },
  blockedDomains: ["ads.test"],
  cookies: [{ name: "c", value: "1" }],
  question: "这个页面讲什么",
  crawlId: "c-1",
  sessionId: "s-1",
  mode: "content",
  sitemapUrl: SAMPLE_URL,
  sitemapFollow: "sitemap",
  feedUrl: SAMPLE_URL,
  feedType: "xml",
  itertag: "item",
  fields: { title: "title" },
};

/** 一个参数的声明形状（只取本用例关心的几点）。 */
interface ParamSpec {
  type?: string;
  enum?: unknown[];
}

/**
 * 由声明的 schema 造一份入参。
 *
 * @param name - 参数名
 * @param spec - 声明形状
 * @returns 一个合法值
 */
const BY_TYPE: Record<string, unknown> = {
  boolean: true,
  integer: 5,
  number: 5,
  array: [],
  object: {},
};

/**
 * 由声明的 schema 造一份入参。
 *
 * @param name - 参数名
 * @param spec - 声明形状
 * @returns 一个合法值
 */
function sampleValue(name: string, spec: ParamSpec): unknown {
  if (name in BY_NAME) {
    return BY_NAME[name];
  }
  // 枚举参数取第一个合法值：塞 "probe" 会被 defineTool 的入参校验拦在 sidecar.call 之前，
  // 整个工具一个帧都发不出去 —— 该工具的每一个声明参数都会被误报成「线上没有它」。
  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    return spec.enum[0];
  }
  const type = spec.type ?? "";
  return type in BY_TYPE ? BY_TYPE[type] : "probe";
}

/**
 * 把一份载荷摊平成 `父.子` 形式的键列表。
 *
 * @param value - 任意 JSON 值
 * @param prefix - 上层路径
 * @returns 键列表
 */
function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  /**
   * 这几个键的值是**调用方自定的映射**（请求体、请求头、Cookie），不是协议字段表：
   * 摊平它们会把 `body.a` 当成一个协议键去问对端读不读，那是夹具造出来的假违规。
   */
  const OPAQUE = new Set([
    "body",
    "headers",
    "cookies",
    "extraHeaders",
    "attributes",
    "params",
    "form",
    "json",
    "fields",
  ]);
  const out: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    if (!OPAQUE.has(name) && item !== null && typeof item === "object" && !Array.isArray(item)) {
      out.push(name, ...flattenKeys(item, name));
    } else {
      out.push(name);
    }
  }
  return out;
}

/**
 * 一个记录用的 sidecar：把 (method, keys) 记下来，按方法回合法形状的回包。
 *
 * @param replies - 方法名到回包的映射
 * @returns 客户端与记录
 */
function recordingSidecar(replies: Record<string, unknown>): {
  client: SidecarClient;
  calls: WireCall[];
} {
  const calls: WireCall[] = [];
  const client = new SidecarClient(
    {
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (): never => {
          throw new Error("本用例不拉起真进程");
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
  Object.assign(client, {
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, keys: flattenKeys(params) });
      return replies[method] ?? {};
    },
  });
  return { client, calls };
}

/** 抓取类回包：三条提取路径与 XHR 摘要都齐，任何工具都不会因缺字段而抛。 */
const FETCH_REPLY = {
  url: SAMPLE_URL,
  status: 200,
  extractionType: "markdown",
  content: "# hi",
  truncated: false,
  redirects: 0,
  xhr: [{ url: "https://example.com/api/a", status: 200, bytes: 12 }],
};

/** 每个 sidecar 方法的回包：都要长成该工具后处理认得的形状。 */
const REPLIES: Record<string, unknown> = {
  fetch: FETCH_REPLY,
  render: FETCH_REPLY,
  extract: FETCH_REPLY,
  select: { count: 1, truncated: false, matches: [{ tag: "h1", text: "hi" }] },
  "session.open": { sessionId: "s-1", sessionType: "static", createdAt: "2020-01-01T00:00:00Z" },
  "session.fetch": { ...FETCH_REPLY, sessionId: "s-1" },
  "session.network": {
    sessionId: "s-1",
    count: 1,
    matches: [
      {
        url: "https://example.com/api/a",
        status: 200,
        bytes: 12,
        method: "GET",
        resourceType: "xhr",
      },
    ],
  },
  "session.state_save": { sessionId: "s-1", path: "/tmp/s.json", saved: true },
  "session.state_load": { sessionId: "s-1", path: "/tmp/s.json", saved: false },
  "session.list": { sessions: [] },
  "session.close": { sessionId: "s-1", closed: true },
  "crawl.run": { crawlId: "c-1" },
  "crawl.status": {
    crawlId: "c-1",
    running: false,
    pages: [{ url: SAMPLE_URL, title: "T", markdown: "body" }],
    error: null,
    expired: false,
  },
  "crawl.stop": { crawlId: "c-1", stopping: true },
  screenshot: {
    url: SAMPLE_URL,
    mediaType: "image/png",
    base64: "aGVsbG8=",
    width: 1,
    height: 1,
  },
};

/**
 * 驱动全部工具（`TOOL_SPECS` 逐条，不从测试里手写清单），收集线上实发的键。
 *
 * 清单取自 host.ts 的登记表：那正是「新增一个工具却忘了被这批门禁扫到」的唯一防线 ——
 * 手写清单会走散，登记表不会。
 *
 * @returns 工具名到观测结果的映射
 */
async function driveTools(): Promise<Record<string, ToolObservation>> {
  const out: Record<string, ToolObservation> = {};
  // 每个工具各自挂一份记录用的 sidecar，彼此没有共享状态，可以并发跑；顺序无所谓，
  // 断言读的是「工具名 -> 观测」这张表。
  await Promise.all(
    TOOL_SPECS.map(async (spec) => {
      const { client, calls } = recordingSidecar(REPLIES);
      const definition = spec.build({
        sidecar: client,
        settings: SETTINGS,
        startCrawlJob: async (label: string, run: CrawlJobRunner): Promise<string> => {
          void label;
          await run({ append: noop, progress: noop, signal: new AbortController().signal });
          return "job-1";
        },
        answer: async () => ({ answer: "a", provider: "p", model: "m" }),
        attachments: {
          saveImage: async (input) => ({
            attachmentId: "a-1",
            mediaType: input.mediaType,
            bytes: input.data.byteLength,
            width: 1,
            height: 1,
          }),
        },
      });
      // `defineTool` 把声明的那份 DSL 编译成 JSON Schema（type/properties/required），
      // 模型看到的正是这一份 —— 所以「声明了什么」必须从编译结果读，而不是从源码字面量抄。
      const compiled = definition.parameters as
        | { properties?: Record<string, ParamSpec> }
        | undefined;
      const parameters = compiled?.properties ?? {};
      const args: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(parameters)) {
        args[name] = sampleValue(name, item);
      }
      try {
        await definition.execute(args, { signal: new AbortController().signal } as never);
      } catch {
        // 回包与某个工具对不上时本用例仍只看**发出去的帧**；结果侧的形状问题由
        // tools.test.ts 那套按工具逐条钉的用例负责。
      }
      out[spec.name] = { calls, declared: Object.keys(parameters) };
    }),
  );
  // 检索不是工具：它由 ctx.web 的 search provider 驱动，同样要进这张对表，否则
  // search.discover 的读取会被当成「本侧从不发」。
  const search = recordingSidecar({
    "search.discover": { backend: "bing", hits: [] },
  });
  await createWebSearchProvider({
    sidecar: search.client,
    backend: "bing",
    apiKey: "",
    braveApiKey: "",
    serperApiKey: "",
    apiEndpoint: "https://api.tavily.com/search",
    bingEndpoint: "https://www.bing.com/search",
    braveEndpoint: "https://api.search.brave.com/res/v1/web/search",
    serperEndpoint: "https://google.serper.dev/search",
    duckduckgoEndpoint: "https://html.duckduckgo.com/html/",
    searxngEndpoint: "",
    publicFallback: false,
    renderTopN: 0,
    maxOutputBytes: 4000,
    timeoutMs: 30_000,
  }).search({ query: "probe" });
  out["web_search provider"] = { calls: search.calls, declared: [] };
  return out;
}

/** Python 侧：方法 -> 该处理链读到的键；以及方法名全集。 */
interface PythonSide {
  reads: Map<string, Set<string>>;
  methods: Set<string>;
}

/**
 * Python 侧的读取面。
 *
 * 判据来自运行时而不是静态扫源码：adapters 里有一批按表驱动的读法 ——
 * `for key, name in (("waitSelector", "wait_selector"), ...): args.get(key)` 与
 * `for source, target in (...): deployment.get(source)` —— 静态扫只看得见字面量 `key`，
 * 会把「真读了」误判成「没读」。误报一旦进门禁，下一次有人为了变绿而加豁免，真正的
 * 「发了没人读」就也跟着沉默了。探针用记录型字典驱动每个方法，读哪个记哪个。
 *
 * 一个进程只起一次探针：它要拉起真解释器、按上游真形状造会话与 Spider，一次十几秒，
 * 而下面四条用例问的是同一份表。每条各起一次会把单条时长顶到 `testTimeout` 那条线上
 * （macOS runner 上就是这么越线的），而判据一条也不会因此多覆盖。
 *
 * @returns 方法全集与读取表
 */
let side: Promise<PythonSide> | undefined;

async function buildPythonSide(): Promise<PythonSide> {
  const report = await runProbe();
  const reads = new Map<string, Set<string>>();
  for (const [method, keys] of Object.entries(report.reads)) {
    reads.set(method, new Set(keys));
  }
  return { reads, methods: new Set(report.methods) };
}

async function pythonSide(): Promise<PythonSide> {
  side ??= buildPythonSide();
  return side;
}

/** 起探针那一条用例的时间预算：默认那 20s 恰好压在探针的实际耗时上，runner 慢一点就越线。 */
const PROBE_TIMEOUT_MS = 180_000;

/**
 * 已知「Python 读了但 Host 从不发」的键。
 *
 * 这一组与前两类不同：它们不是漂移，而是 **sidecar 协议支持、Host 侧没接线**的能力面。
 * 每条最终都要落到「接线（进 schema 或进设置）还是删除」这个产品决定上，本测试不替它决定；
 * 但清单必须逐条写在这里 —— 于是新增一段走不到的读取会立刻被点名，而不是跟着「反正有历史
 * 包袱」一起沉默。
 */
const KNOWN_UNREACHABLE: Record<string, string[]> = {};

/**
 * 允许「声明给模型但不上网线」的入参：值在本侧就消化掉了。
 *
 * 每一项都要写清消化方式 —— 否则这条豁免会变成「加了个参数却忘了转发」的遮羞布。
 */
const MODEL_ONLY: Record<string, string[]> = {
  // question 交给 ctx.llm（deps.answer），本来就不是 sidecar 的入参。
  // render 不发给 Python，它选的是发哪一个方法：true -> render，false -> fetch。
  scrapling_answer: ["question", "render"],
  // locate 的 by/query 是模型面的新名：by -> 线上 queryType、query -> 线上 selector
  // （Python 只读旧名）。两个新名都在本侧映射掉，协议帧上不会出现它们。
  scrapling_locate: ["by", "query"],
};

/**
 * 把一批调用记录摊平成键集合。
 *
 * @param items - 调用记录
 * @returns 出现过的键
 */
function keysOf(items: readonly WireCall[]): Set<string> {
  return new Set(items.flatMap((call) => call.keys));
}

/**
 * 取某个方法/工具的豁免集合。
 *
 * 表里没有这一项时直接给 `new Set(undefined)`，而不是先 `?? []` 再塞进去 —— 那个空数组
 * 是多余的参数，会让读代码的人以为「缺省是空表」是件需要写出来的事。
 *
 * @param table - 豁免表
 * @param key - 方法名或工具名
 * @returns 豁免的键
 */
function excusedFor(table: Record<string, string[]>, key: string): Set<string> {
  return new Set(table[key]);
}

/**
 * 本侧发了、对端不读的键。
 *
 * @param observations - 工具观测
 * @param reads - 对端读取表
 * @returns 违规说明
 */
function unreadKeys(
  observations: Record<string, ToolObservation>,
  reads: Map<string, Set<string>>,
): string[] {
  return Object.entries(observations).flatMap(([tool, observation]) =>
    observation.calls.flatMap((call) => {
      const read = reads.get(call.method);
      if (read === undefined) {
        return [];
      }
      return call.keys
        .filter((key) => !read.has(key))
        .map((key) => `${tool} -> ${call.method} 发了 ${key}，对端不读`);
    }),
  );
}

/**
 * 对端读了、本侧从不发的键，以及已经接线却仍躺在豁免表里的条目。
 *
 * @param observations - 工具观测
 * @param reads - 对端读取表
 * @returns 两个列表：新增的死分支与过期的豁免
 */
function sentKeysByMethod(observations: Record<string, ToolObservation>): Map<string, Set<string>> {
  const sentByMethod = new Map<string, Set<string>>();
  for (const observation of Object.values(observations)) {
    for (const call of observation.calls) {
      const sent = sentByMethod.get(call.method) ?? new Set<string>();
      for (const key of call.keys) {
        sent.add(key);
      }
      sentByMethod.set(call.method, sent);
    }
  }
  return sentByMethod;
}

function deadReads(
  observations: Record<string, ToolObservation>,
  reads: Map<string, Set<string>>,
): { unreachable: string[]; stale: string[] } {
  const wire = keysOf(Object.values(observations).flatMap((item) => item.calls));
  const sentByMethod = sentKeysByMethod(observations);
  const unreachable: string[] = [];
  const stale: string[] = [];
  for (const [method, read] of reads) {
    const excused = excusedFor(KNOWN_UNREACHABLE, method);
    for (const key of read) {
      if (wire.has(key)) {
        // 豁免是针对**这个方法**的：别的工具把同名键发给别的方法，不能让这条豁免
        // 看起来已经接线。
        if (excused.has(key) && (sentByMethod.get(method)?.has(key) ?? false)) {
          stale.push(`${method} 的 ${key} 已上网线，仍留在豁免表里`);
        }
      } else if (!excused.has(key)) {
        unreachable.push(`${method} 读了 ${key}，本侧从不发`);
      }
    }
  }
  return { unreachable, stale };
}

/**
 * schema 声明给模型、却上不了网线的入参。
 *
 * @param observations - 工具观测
 * @param reads - 对端读取表
 * @returns 违规说明
 */
function unforwardedArgs(
  observations: Record<string, ToolObservation>,
  reads: Map<string, Set<string>>,
): string[] {
  return Object.entries(observations).flatMap(([tool, observation]) => {
    const sent = keysOf(observation.calls);
    const excused = excusedFor(MODEL_ONLY, tool);
    return observation.declared.flatMap((name) => {
      const reachesPeer = observation.calls.some(
        (call) => reads.get(call.method)?.has(name) === true,
      );
      if (reachesPeer || sent.has(name)) {
        return excused.has(name) ? [`${tool} 的 ${name} 已上网线，仍留在本侧消化名单里`] : [];
      }
      return excused.has(name) ? [] : [`${tool} 把 ${name} 写进了 schema，但线上没有它`];
    });
  });
}

describe("两侧对表：线路上的键必须一一对得上", () => {
  it(
    "每个被调用的 sidecar 方法都在对端的 METHODS 表里",
    async () => {
      const { methods } = await pythonSide();
      const observations = await driveTools();
      const sent = new Set(
        Object.values(observations).flatMap((item) => item.calls.map((call) => call.method)),
      );
      const unknown = [...sent].filter((method) => !methods.has(method));
      expect(unknown, "对端不认这些方法，运行时会回 UNKNOWN_METHOD").toStrictEqual([]);
      // 驱动退化（工具没跑起来、一帧没发）会让下面几组断言一起变成真空通过。
      expect(sent.size).toBeGreaterThanOrEqual(10);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "本侧发出的每个键，对端那侧真读（否则就是「拧了没反应」）",
    async () => {
      const { reads } = await pythonSide();
      expect(unreadKeys(await driveTools(), reads)).toStrictEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "对端读的每个键，本侧真发（否则是走不到的死分支）",
    async () => {
      const { reads } = await pythonSide();
      const { unreachable, stale } = deadReads(await driveTools(), reads);
      // 新增的走不到的读取要被抓到……
      expect(unreachable).toStrictEqual([]);
      // ……而已接线的键也不能继续躺在豁免表里：那会让这张表慢慢变成「谁也不读」的废纸。
      expect(stale).toStrictEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "声明给模型的参数要么上网线，要么被本侧消化（写了却没有=静默失效）",
    async () => {
      const { reads } = await pythonSide();
      const observations = await driveTools();
      expect(unforwardedArgs(observations, reads)).toStrictEqual([]);
      // 驱动退化保护：schema 一个都解析不出来会让上面那条断言变成真空通过。
      // `scrapling_session_list` 本来就无入参，所以按总量判而不是按每个工具判。
      const total = Object.values(observations).reduce(
        (sum, item) => sum + item.declared.length,
        0,
      );
      expect(total).toBeGreaterThanOrEqual(40);
    },
    PROBE_TIMEOUT_MS,
  );

  it("会话开场把部署级浏览器设置发过去（那些键只在构造期生效）", async () => {
    // block_ads / executable_path / init_script / record_requests / max_recorded_requests 只在
    // 会话构造期被读；fetch 层传一律被丢弃（见 contract-scrapling）。所以它们必须出现在
    // session.open 这一帧上，否则设置卡上的旋钮对浏览器会话永远无效。
    const observations = await driveTools();
    const keys = keysOf(observations["scrapling_session_open"]?.calls ?? []);
    for (const wanted of [
      "blockAds",
      "timeoutMs",
      "deployment.browserExecutablePath",
      "deployment.browserInitScript",
      "deployment.recordRequests",
      "deployment.maxRecordedRequests",
    ]) {
      expect(keys.has(wanted), `session.open 没发 ${wanted}`).toBe(true);
    }
  });
});
