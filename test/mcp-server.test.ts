// lib/mcp-server.ts —— 工具表到 MCP 的适配、传输与鉴权。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { once } from "node:events";
import http from "node:http";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_TOKEN_ENV } from "../lib/mcp-contract.ts";
import {
  allowedEndpoints,
  createMcpImageSink,
  boundPort,
  headerWritable,
  mcpRawName,
  mcpSearchTool,
  mcpToolEntries,
  pathOf,
  projectBlocks,
  startMcpServer,
} from "../lib/mcp-server.ts";
import type {
  McpAllowedEndpoints,
  McpImageSink,
  McpServerHandle,
  McpServerOptions,
  McpSession,
} from "../lib/mcp-server.ts";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/**
 * mcp-server 只有在通配绑定时才问网卡清单。这里把 `networkInterfaces` 换成可控替身：
 * 默认给空表（不依赖跑测试那台机器有几张网卡），单条用例可以造出「某一项是 undefined」的形状。
 */
const networkInterfaces = vi.hoisted(() =>
  vi.fn<() => Record<string, NetworkInterfaceInfo[]>>(() => ({})),
);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, networkInterfaces };
});

const OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: { echo: { type: "string", required: true } },
} as never;

const QUERY_PARAM = { query: { type: "string", required: true, description: "要查的词" } };

function fakeTool(
  name: string,
  run: (args: Record<string, unknown>) => Promise<unknown>,
): ToolDefinition {
  return defineTool({
    name,
    description: `desc ${name}`,
    parameters: QUERY_PARAM,
    output: {
      schema: OUTPUT,
      render: (args: unknown, value: never) => [
        { type: "text", text: `${JSON.stringify(value)}|${JSON.stringify(args)}` },
      ],
    },
    execute: async (args: unknown) => run(args as Record<string, unknown>),
  } as never);
}

function imageTool(sink: McpImageSink): ToolDefinition {
  return defineTool({
    name: "scrapling_screenshot",
    description: "截图",
    parameters: { sessionId: { type: "string", required: true, description: "会话 id" } },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          attachment: { type: "json", required: true },
        },
      },
      render: (args: unknown, value: never) => [
        { type: "image", attachment: (value as { attachment: unknown }).attachment as never },
        { type: "text", text: String(args) },
      ],
    },
    execute: async () => {
      const attachment = await sink.saveImage({
        data: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        name: "screenshot.png",
      });
      return { url: "http://93.184.216.34", attachment };
    },
  } as never);
}

/** 让 listen 立刻回声一个非 EADDRINUSE 的绑定错误，用来判错误映射本身。 */
function failedListen(this: Server): Server {
  setImmediate(() => {
    this.emit("error", Object.assign(new Error("listen EACCES"), { code: "EACCES" }));
  });
  return this;
}

interface McpError {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

const ENTRIES = mcpToolEntries([
  {
    name: "scrapling_fetch",
    definition: fakeTool("scrapling_fetch", async () => ({ echo: "ok" })),
  },
  {
    name: "scrapling_answer",
    definition: fakeTool("scrapling_answer", async () => ({ echo: "no" })),
  },
]);

const started: McpServerHandle[] = [];

/**
 * `runEntry` 的 catch 用 `String(error)` 收两种抛出形状，两种都得真测。
 *
 * 抛出值取自用例参数而不是写成语句里的字面量：这条用例判的正是「非 Error 抛出」，
 * 而 `throw "字符串"` 那种写法要么被 no-throw-literal 判红、要么靠禁用注释绕开 ——
 * 绕开等于把这条分支又藏回去。
 */
const THROWN_SHAPES: readonly {
  readonly label: string;
  readonly value: unknown;
}[] = [
  { label: "Error", value: new Error("kaboom") },
  { label: "非 Error", value: "kaboom-string" },
];

/**
 * 要求一次启动失败，并把那条错误交给调用方按码断。
 *
 * 意外成功时**先登记再报**：否则服务器与端口留到后面的用例里，而红话只是「code 是
 * undefined」一句，看不出真发生了什么事。抛出的形状不是 McpError 时同样点名，而不是
 * 让 `expect(failure.code)` 去比一个 undefined。
 *
 * @param options - 交给 `startMcpServer` 的配置
 * @returns 启动失败的 McpError
 */
async function expectMcpFailure(options: McpServerOptions): Promise<McpError> {
  const outcome = await startMcpServer(options).then(
    (handle): { started: McpServerHandle } => ({ started: handle }),
    (error: unknown): { failure: unknown } => ({ failure: error }),
  );
  if ("started" in outcome) {
    started.push(outcome.started);
    throw new Error(
      `startMcpServer 意外启动成功（端口 ${String(outcome.started.port)}），这条用例判的是失败路径`,
    );
  }
  const failure = outcome.failure as Partial<McpError> | undefined;
  if (typeof failure?.code !== "string") {
    throw new TypeError(`startMcpServer 抛的不带 code：${String(outcome.failure)}`, {
      cause: outcome.failure,
    });
  }
  return failure as McpError;
}

/** 建好连接、还没关的 Client；用例自己关的会从这里摘掉。 */
const openClients = new Set<Client>();

/** 真的走过关闭流程的连接，收尾兜底是否动过手由它作证。 */
const closedClients: Client[] = [];

/** 上一条用例故意留下的连接，下一条用例据此检查兜底。 */
const leftoverClients: Client[] = [];

/**
 * 关一只 Client 并把它摘出登记。
 *
 * @param client - 要关的连接
 */
async function closeClient(client: Client): Promise<void> {
  openClients.delete(client);
  closedClients.push(client);
  await client.close();
}

async function closeAll(): Promise<void> {
  // Client 先关：它还握着到服务端的 HTTP 会话，服务端先收摊会让关闭的回包拿不到，
  // 用例之间就可能挂到全局超时。断言提前失败、没走到 closeClient 的连接也从这里收掉。
  const leftover = [...openClients];
  openClients.clear();
  await Promise.all(leftover.map((client) => closeClient(client)));
  await Promise.all(started.splice(0).map((handle) => handle.close()));
}

async function serve(options: McpServerOptions): Promise<McpServerHandle> {
  const handle = await startMcpServer(options);
  started.push(handle);
  return handle;
}

async function clientFor(port: number, token?: string): Promise<Client> {
  const client = new Client({ name: "probe", version: "0.0.0" });
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(port)}/mcp`),
    {
      requestInit: { headers },
    },
  );
  await client.connect(transport);
  openClients.add(client);
  return client;
}

async function statusOf(port: number, path: string, init: RequestInit = {}): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: "POST",
    ...init,
  });
  void response.body?.cancel();
  return response.status;
}

const MCP_HEADERS = { accept: "application/json, text/event-stream" };
const TOKEN = "secret-token";

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "0.0.0" },
  },
});

/**
 * 响应有界的预算：服务端收下请求却不把响应写完时，宁可要一句点名端口的错，
 * 也不要让 vitest 的全局超时来替这条用例解释失败原因。
 */
const RAW_POST_TIMEOUT_MS = 5000;

/** 拆响应时 socket 会顺带让 request 也发一次 'error'；没人接就是宿主进程的未捕获异常。 */
const swallowSocketError = (): void => undefined;

/**
 * 等到响应写完并取回状态码，超预算时按当前走到哪一步来拆，并报出端口。
 *
 * `events.once` 是官方那段「事件转 promise」：仓里不用手写 deferred，也不需要给
 * `promise/avoid-new` 开豁免。它自带 'error' 分支 —— 超时时 destroy(err) 正是从这里
 * 变成一次拒绝的；请求与响应两个方向都挂上，服务端只回头部不写完、或连接中途坏掉，
 * 都不会让用例永远挂着。
 *
 * @param request - 已经 end() 的请求
 * @param port - 只进报错文案，让失败的用例自己说出是哪一端没回话
 * @param budgetMs - 响应预算，默认 `RAW_POST_TIMEOUT_MS`；判预算本身的那条用例会压小它
 * @returns 响应状态码
 */
async function readStatus(
  request: ClientRequest,
  port: number,
  budgetMs: number = RAW_POST_TIMEOUT_MS,
): Promise<number> {
  // 响应对象在 once() 落地那一刻才被登记（'response' 事件与这次登记之间没有 await，
  // 定时器插不进来）。
  const arrived = { response: undefined as IncomingMessage | undefined };
  // once(request, "response") 一落地就把自己的 error 监听摘掉，之后 socket 上的错误
  // 再无接收者：这条常驻的吞错监听让「拆响应」不会把 'error' 抛成未捕获异常（实测：
  // vitest 会打一条 Uncaught Exception 并把整次运行判红）。
  request.on("error", swallowSocketError);
  const guard = setTimeout((): void => {
    // 已经回头部时拆请求只会让响应端收到一句 'aborted'（实测）：那句不带端口，也看不出
    // 是预算到点，判据会退化成「不知道谁把它掐了」。所以按当前走到哪一步来拆。
    const failure = new Error(`端口 ${String(port)} 收下请求后没把响应写完`);
    (arrived.response ?? request).destroy(failure);
  }, budgetMs);
  try {
    const [response] = (await once(request, "response")) as [IncomingMessage];
    arrived.response = response;
    response.resume();
    await once(response, "end");
    return response.statusCode ?? 0;
  } finally {
    clearTimeout(guard);
    request.off("error", swallowSocketError);
  }
}

/**
 * 用 node:http 发一次 POST，返回状态码。
 *
 * fetch 的 forbidden header 名单里包含 Host，伪造它必须走原始 http.request：被判的那条路
 * 恰好是「浏览器把攻击者域名解析到 127.0.0.1，Host/Origin 头留的是攻击者域名」。
 *
 * @param port - 服务端端口
 * @param headers - 覆盖默认请求头的键（`host` / `origin` / `authorization` 一类）
 * @returns 响应状态码
 * @throws 连接失败，或在 `RAW_POST_TIMEOUT_MS` 内没等到响应写完
 */
async function rawPost(port: number, headers: Record<string, string>): Promise<number> {
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(INITIALIZE_BODY),
      ...headers,
    },
  });
  request.end(INITIALIZE_BODY);
  return readStatus(request, port);
}

/**
 * 发一个不带 content-length 的 POST。
 *
 * 不写这个头时 node:http 会改用 chunked 传输 —— 正好是「客户端不声明长度」那一支，
 * 而正文大小在读到之前不可知。
 */
async function rawPostChunked(port: number): Promise<number> {
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: { ...MCP_HEADERS, "content-type": "application/json" },
  });
  // 分两次写且不带长度：node 会自己选 chunked。
  request.write(INITIALIZE_BODY.slice(0, 20));
  request.end(INITIALIZE_BODY.slice(20));
  return readStatus(request, port);
}

/**
 * 用假会话起一条 server，把「这一条请求怎么处理」交给调用方。
 *
 * SDK 那两步只回错误响应、不抛，所以兜底分支只能从这一层注入失败 —— 判的是本模块对
 * 失败的收口，不是 SDK 的脾气。
 *
 * @param behavior - 假会话在这条请求上做点什么
 * @returns 起好的 handle 与装配记录
 */
async function withFakeSession(behavior: (response: ServerResponse) => Promise<void>): Promise<{
  handle: McpServerHandle;
  seen: { endpoints: McpAllowedEndpoints[]; order: string[]; closed: number };
}> {
  const seen = { endpoints: [] as McpAllowedEndpoints[], order: [] as string[], closed: 0 };
  const session: McpSession = {
    connect: async () => {
      seen.order.push("connect");
    },
    close: async () => {
      seen.order.push("close");
      seen.closed += 1;
    },
    handle: async (_request, response) => {
      seen.order.push("handle");
      await behavior(response);
    },
  };
  const handle = await serve({
    port: 0,
    entries: ENTRIES,
    sessionFactory: (endpoints) => {
      seen.endpoints.push(endpoints);
      return session;
    },
  });
  return { handle, seen };
}

describe("mcpToolEntries", () => {
  it("去掉 MCP 不端出去的工具，并换成短名", () => {
    expect(ENTRIES.map((entry) => entry.name)).toStrictEqual(["fetch"]);
  });

  it("原始名去掉 scrapling_ 前缀", () => {
    expect(mcpRawName("scrapling_session_state_save")).toBe("session_state_save");
    expect(mcpRawName("standalone_name")).toBe("standalone_name");
  });

  it("search 只在给了定义时出现，并且排在最后", () => {
    const withSearch = mcpToolEntries(
      [
        {
          name: "scrapling_fetch",
          definition: fakeTool("scrapling_fetch", async () => ({ echo: "1" })),
        },
      ],
      fakeTool("search", async () => ({ echo: "2" })),
    );
    expect(withSearch.map((entry) => entry.name)).toStrictEqual(["fetch", "search"]);
  });
});

describe("createMcpImageSink 的容量与过期", () => {
  it("超过容量上限时淘汰最旧的一份，不无界增长", async () => {
    const sink = createMcpImageSink();
    const saved = await Promise.all(
      Array.from({ length: 17 }, (_value, index) =>
        sink.saveImage({ data: new Uint8Array([index]), mediaType: "image/png" }),
      ),
    );
    const [oldest] = saved;
    expect(oldest).toBeDefined();
    expect(sink.take(oldest?.id ?? "")).toBeUndefined();
    const newest = saved.at(-1);
    expect(newest).toBeDefined();
    expect(sink.take(newest?.id ?? "")).toBeDefined();
  });

  it("超过时长的未取走条目在下次读写时被清掉", async () => {
    const sink = createMcpImageSink();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const saved = await sink.saveImage({ data: new Uint8Array([1]), mediaType: "image/png" });
      spy.mockReturnValue(now + 61_000);
      expect(sink.take(saved.id)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("projectBlocks", () => {
  it("认不出的块带 JSON 交回，不静默丢", () => {
    expect(projectBlocks([{ type: "resource", uri: "x" }, "plain"])).toStrictEqual([
      { type: "text", text: '{"type":"resource","uri":"x"}' },
      { type: "text", text: '"plain"' },
    ]);
  });

  it("没有 sink 时图片块落文本兜底", () => {
    expect(projectBlocks([{ type: "image", attachment: { id: "mcp-1" } }])).toStrictEqual([
      { type: "text", text: '{"type":"image","attachment":{"id":"mcp-1"}}' },
    ]);
  });

  it("sink 里查不到 id 时同样落文本兜底", () => {
    const sink = createMcpImageSink();
    expect(projectBlocks([{ type: "image", attachment: { id: "gone" } }], sink)).toStrictEqual([
      { type: "text", text: '{"type":"image","attachment":{"id":"gone"}}' },
    ]);
  });
});

function toolFor(payload: unknown): ToolDefinition {
  return mcpSearchTool({ available: () => true, search: async () => payload });
}

describe("boundPort", () => {
  it("tcp 形态交出端口", () => {
    expect(boundPort({ address: "127.0.0.1", family: "IPv4", port: 4321 })).toBe(4321);
  });

  it("管道名与 null 都点名失败，而不是交出一个 0", () => {
    expect(() => boundPort("/tmp/mcp.sock")).toThrow(/did not report/u);
    expect(() => boundPort(null)).toThrow(/did not report/u);
  });
});

describe("pathOf", () => {
  it("查询串不参与比较，读不到请求行时按空串比出去", () => {
    expect(pathOf("/mcp")).toBe("/mcp");
    expect(pathOf("/mcp?sessionId=s1")).toBe("/mcp");
    expect(pathOf("/mcp?")).toBe("/mcp");
    // node 的类型上 url 是 optional；缺它只能算「不是本路径」，不能算通配。
    expect(pathOf()).toBe("");
    expect(pathOf(undefined)).toBe("");
  });
});

describe("headerWritable", () => {
  it("四种状态里只有「既没发头也没结束」还能写状态行", () => {
    expect(headerWritable({ headersSent: false, writableEnded: false })).toBe(true);
    expect(headerWritable({ headersSent: true, writableEnded: false })).toBe(false);
    expect(headerWritable({ headersSent: false, writableEnded: true })).toBe(false);
    expect(headerWritable({ headersSent: true, writableEnded: true })).toBe(false);
  });
});

describe("mcpSearchTool", () => {
  const exec = { signal: new AbortController().signal } as never;

  async function textOf(definition: ToolDefinition, query: string): Promise<string> {
    const value = await definition.execute({ query }, exec);
    const blocks = definition.output.render({ query }, value as never);
    return blocks.map((block) => ("text" in block ? block.text : "")).join("\n");
  }

  it("没有来源与被截断这两种形状都写进行文", async () => {
    const body = await textOf(toolFor({ sources: [], truncated: true }), "dsh");
    expect(body).toContain("scrapling search: dsh");
    expect(body).toContain("(no sources passed the URL gate)");
    expect(body).toContain("(结果被上限截断)");
  });

  it("payload 形状不对时全部落成空值而不是抛", async () => {
    const body = await textOf(toolFor({ sources: "nope", truncated: "yes", content: 7 }), "y");
    expect(body).toContain("(no sources passed the URL gate)");
    expect(body).not.toContain("结果被上限截断");
  });

  it("标题缺失退回 URL，摘要缺失就不加那一行", async () => {
    const body = await textOf(toolFor({ sources: [{ url: "http://93.184.216.34/a" }] }), "z");
    expect(body).toContain("1. http://93.184.216.34/a");
    expect(body.split("\n")).toHaveLength(2);
  });

  it("标题与摘要都在时各占一行，摘要有自己的缩进", async () => {
    const body = await textOf(
      toolFor({ sources: [{ url: "http://93.184.216.34/a", title: "示例", snippet: "摘要" }] }),
      "w",
    );
    expect(body).toContain("1. 示例");
    expect(body).toContain("   摘要");
  });

  it("非对象的结果也走得通（render 与 normalize 各自兜一层）", async () => {
    const definition = mcpSearchTool({ available: () => true, search: async () => null });
    const value = (await definition.execute({ query: "q", maxResults: 3 }, exec)) as {
      count: number;
      content: string;
    };
    expect(value).toMatchObject({ count: 0, content: "", query: "q" });
    expect(value.content).toBe("");
  });
});

describe("allowedEndpoints", () => {
  it("回环绑定时只放行回环字面量，不出现通配", () => {
    const guard = allowedEndpoints("127.0.0.1", 39_217);
    expect(guard.allowedHosts).toContain("127.0.0.1:39217");
    expect(guard.allowedHosts).toContain("localhost:39217");
    expect(guard.allowedHosts.some((entry) => entry.includes("*"))).toBe(false);
    expect(guard.allowedOrigins).toContain("http://127.0.0.1:39217");
    // Origin 面必须与 Host 面一一对应，不另起一套。
    expect(guard.allowedOrigins).toStrictEqual(
      guard.allowedHosts.map((entry) => `http://${entry}`),
    );
  });

  it("通配绑定时展开成回环与本机网卡地址，仍不含通配", () => {
    for (const host of ["0.0.0.0", "::", ""]) {
      const guard = allowedEndpoints(host, 8080);
      expect(guard.allowedHosts).toContain("127.0.0.1:8080");
      expect(guard.allowedHosts).toContain("localhost:8080");
      expect(guard.allowedHosts).toContain("[::1]:8080");
      // 绑定地址本身是通配，但**允许面**不能写通配，否则防护等于没开。
      expect(guard.allowedHosts).not.toContain(`${host}:8080`);
      expect(guard.allowedHosts.some((entry) => entry.includes("*"))).toBe(false);
    }
  });

  it("显式 host 只放行它自己", () => {
    const guard = allowedEndpoints("192.0.2.10", 9000);
    expect(guard.allowedHosts).toStrictEqual(["192.0.2.10:9000"]);
    expect(guard.allowedOrigins).toStrictEqual(["http://192.0.2.10:9000"]);
  });

  it("::1 绑定时 Host 写成方括号形态，不出现裸 ::1:port", () => {
    const guard = allowedEndpoints("::1", 39_219);
    expect(guard.allowedHosts).toContain("[::1]:39219");
    expect(guard.allowedHosts).toContain("localhost:39219");
    // `::1:39219` 会把地址里的冒号与端口分隔混在一起，SDK 逐字比较时它是另一串。
    expect(guard.allowedHosts).not.toContain("::1:39219");
  });

  it("网卡条目读成 undefined 时按空表跳过，防护面照样给出回环字面量", () => {
    networkInterfaces.mockReturnValueOnce({ lo: undefined } as never);
    const guard = allowedEndpoints("0.0.0.0", 39_218);
    expect(guard.allowedHosts).toContain("127.0.0.1:39218");
    expect(guard.allowedHosts).toContain("[::1]:39218");
  });

  it("通配绑定时展开非 internal 网卡地址，IPv6 加方括号、internal 的不进允许面", () => {
    networkInterfaces.mockReturnValueOnce({
      en0: [
        { address: "192.0.2.7", internal: false },
        { address: "10.1.2.3", internal: true },
      ],
      en1: [{ address: "2001:db8::1", internal: false }],
    } as never);
    const guard = allowedEndpoints("0.0.0.0", 39_220);
    expect(guard.allowedHosts).toContain("192.0.2.7:39220");
    expect(guard.allowedHosts).toContain("[2001:db8::1]:39220");
    // internal 地址不是本机对外名字，进允许面只会把防护放大。
    expect(guard.allowedHosts).not.toContain("10.1.2.3:39220");
  });
});

/** 判预算用的压缩档：只给「装死的对端」那两条用例，为的是秒级出结果。 */
const SILENT_BUDGET_MS = 200;

/** 一次「预算到点」的结局：报错原文与服务端实际绑到的端口。 */
interface BudgetOutcome {
  readonly message: string;
  readonly port: number;
}

/**
 * 起一台由 `handler` 决定行为的服务端，对它发一次 POST，等预算把它掐断。
 *
 * @param handler - 服务端对每个请求做什么（只回头部 / 一个响应字节都不写）
 * @returns 拒绝原因的原文，外加那条消息本该点名的端口
 */
async function breakTheBudget(
  handler: (incoming: IncomingMessage, response: ServerResponse) => void,
): Promise<BudgetOutcome> {
  const silent = http.createServer(handler);
  silent.listen(0);
  await once(silent, "listening");
  const port = boundPort(silent.address());
  try {
    const request = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST" });
    request.end(INITIALIZE_BODY);
    const failure = await readStatus(request, port, SILENT_BUDGET_MS).catch(
      (error: unknown) => error,
    );
    return { message: String(failure), port };
  } finally {
    // 请求已被预算拆掉，连接随之结束，这里的 close 才等得到 'close'。
    silent.close();
    await once(silent, "close");
  }
}

describe("原始请求的响应预算", () => {
  it("服务端回了头部却永不 end 时，预算到点拆掉响应并点名端口", async () => {
    const outcome = await breakTheBudget((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
    });
    expect(outcome.message).toContain("没把响应写完");
    expect(outcome.message).toContain(String(outcome.port));
  });

  it("服务端一个响应字节都不写时，预算到点拆掉请求并点名端口", async () => {
    const outcome = await breakTheBudget((incoming) => {
      // 读干请求体、不写响应：客户端连 'response' 都等不到，等的是第一道 once。
      incoming.resume();
    });
    expect(outcome.message).toContain("没把响应写完");
    expect(outcome.message).toContain(String(outcome.port));
  });
});

describe("startMcpServer", () => {
  afterEach(closeAll);

  it("用例没关的连接仍在登记里（这条刻意不调 closeClient）", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    // 留下一只没人关的连接给 afterEach 收：下一条用例判的就是它有没有真被关掉。
    leftoverClients.push(client);
    expect(openClients.has(client)).toBe(true);
  });

  it("上一条遗留的连接在收尾时被关掉", () => {
    const [leaked] = leftoverClients;
    // 先确认兜底有对象可判：上一条没留下连接时，这里要红而不是安静地比 undefined。
    expect(leaked, "上一条用例没留下连接，这条判据就成了空转").toBeInstanceOf(Client);
    // 按对象身份比，不按数量：数量会被同一批里其它连接的成功关闭顶掉。
    expect(closedClients.some((client) => client === leaked)).toBe(true);
    // 登记表也被清空：残留连接不该跟着下一条用例的连接一起留在表里。
    expect(openClients.size).toBe(0);
  });

  it("列出的工具来自同一份定义表，参数面不另起一套", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toStrictEqual(["fetch"]);
    expect(listed.tools[0]?.description).toBe("desc scrapling_fetch");
    expect(listed.tools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    await closeClient(client);
  });

  it("调用走同一份执行面，参数原样到达", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "fetch", arguments: { query: "hello" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("ok");
    expect(JSON.stringify(result.content)).toContain("hello");
    await closeClient(client);
  });

  it("没有 arguments 的调用也落进同一张表，由工具自己判缺参", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "fetch" });
    expect(result.isError).toBe(true);
    await closeClient(client);
  });

  it("参数不合法时回 isError，而不是把异常抛给客户端", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "fetch", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("query");
    await closeClient(client);
  });

  it("名字不在表里时点名 unknown tool", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unknown tool: nope");
    await closeClient(client);
  });

  it.each(THROWN_SHAPES)(
    "工具自己抛 $label 时也落成 isError，不把异常抛进连接",
    async ({ value }) => {
      const rough: ToolDefinition = {
        name: "scrapling_rough",
        description: "execute 抛东西",
        parameters: {},
        output: { schema: OUTPUT, render: () => [] },
        execute: async () => {
          throw value;
        },
      };
      const handle = await serve({
        port: 0,
        entries: mcpToolEntries([{ name: "scrapling_rough", definition: rough }]),
      });
      const client = await clientFor(handle.port);
      const result = await client.callTool({ name: "rough", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("kaboom");
      await closeClient(client);
    },
  );

  it("截图作为 image 内容交出去，字节来自本次调用的 sink", async () => {
    const sink = createMcpImageSink();
    const handle = await serve({
      port: 0,
      entries: mcpToolEntries([{ name: "scrapling_screenshot", definition: imageTool(sink) }]),
      imageSink: sink,
    });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "screenshot", arguments: { sessionId: "s1" } });
    const blocks = result.content as { type: string; data?: string; mimeType?: string }[];
    expect(blocks[0]?.type).toBe("image");
    expect(blocks[0]?.mimeType).toBe("image/png");
    expect(Buffer.from(blocks[0]?.data ?? "", "base64")).toStrictEqual(Buffer.from([1, 2, 3]));
    await closeClient(client);
  });

  it("设了 token 时，不带 Authorization 的请求 401，带了才列出工具", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES, token: TOKEN });
    const { port } = handle;
    await expect(statusOf(port, "/mcp", { headers: MCP_HEADERS })).resolves.toBe(401);
    const authed = await clientFor(port, TOKEN);
    const listed = await authed.listTools();
    expect(listed.tools.map((tool) => tool.name)).toStrictEqual(["fetch"]);
    await closeClient(authed);
  });

  // DNS 重绑定/CSRF 的请求与本地请求长得一样，唯一的区别就在 Host / Origin 头里。
  it("伪造 Host 的请求被 DNS-rebinding 防护拒掉", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES, token: TOKEN });
    // 连 token 都带对也要拒：这一条判的是 Host，不是鉴权。
    await expect(
      rawPost(handle.port, {
        host: `evil.example:${String(handle.port)}`,
        authorization: `Bearer ${TOKEN}`,
      }),
    ).resolves.toBe(403);
  });

  it("伪造 Origin 的请求被拒，本机 Origin 照常放行", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    await expect(rawPost(handle.port, { origin: "http://evil.example" })).resolves.toBe(403);
    await expect(
      rawPost(handle.port, { origin: `http://127.0.0.1:${String(handle.port)}` }),
      // 放行不等于「不是 403」：415 / 500 也是「不是 403」。initialize 走 JSON 应答，
      // 本机 Origin 该拿到的是 200。
    ).resolves.toBe(200);
  });

  it("非回环地址没有 token ⇒ 拒绝启动，不把工具表敞给局域网", async () => {
    await expect(serve({ host: "0.0.0.0", port: 0, entries: ENTRIES })).rejects.toMatchObject({
      code: "MCP_AUTH_REQUIRED",
    });
    await expect(
      serve({ host: "0.0.0.0", port: 0, entries: ENTRIES, token: TOKEN }),
    ).resolves.toBeDefined();
  });

  it("没有 token 时启动就在 stderr 打一条无鉴权警告", async () => {
    const written = vi.spyOn(process.stderr, "write");
    try {
      const handle = await serve({ port: 0, entries: ENTRIES });
      const text = written.mock.calls.map((call) => String(call[0])).join("");
      expect(text).toContain("WITHOUT authentication");
      expect(text).toContain(MCP_TOKEN_ENV);
      expect(text).toContain(String(handle.port));
    } finally {
      written.mockRestore();
    }
  });

  it("配了 token 就不打无鉴权警告", async () => {
    const written = vi.spyOn(process.stderr, "write");
    try {
      await serve({ port: 0, entries: ENTRIES, token: TOKEN });
      const text = written.mock.calls.map((call) => String(call[0])).join("");
      expect(text).not.toContain("WITHOUT authentication");
    } finally {
      written.mockRestore();
    }
  });

  it("get 请求开的是通知流，不是请求通道", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const response = await fetch(handle.url, { method: "GET", headers: MCP_HEADERS });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    void response.body?.cancel();
  });

  it("只服务 /mcp，其他路径 404", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    await expect(statusOf(handle.port, "/other")).resolves.toBe(404);
  });

  it("正文超过上限直接拒", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const huge = { body: "x".repeat(2_000_000), headers: MCP_HEADERS };
    await expect(statusOf(handle.port, "/mcp", huge)).resolves.toBe(413);
  });

  it("没声明长度的 POST 被拒，而不是当成没有上限", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    // chunked 传输的字节数在读到之前不可知：放行等于这条端口没有正文上限。
    await expect(rawPostChunked(handle.port)).resolves.toBe(411);
  });

  it("关闭后端口不再有人监听", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const { port } = handle;
    const client = await clientFor(port);
    await closeClient(client);
    await handle.close();
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`).catch(
      (error_: unknown) => error_,
    );
    expect(response).toBeInstanceOf(TypeError);
  });

  it("判失败路径的 helper 自己撞上意外成功时，先登记再点名报错", async () => {
    // 这条判的是 helper 的契约：意外成功时必须说出「意外启动成功」，而不是让调用方拿
    // undefined 去比 code；那只 handle 还要登记进 started，否则端口一直占着，后面的用例
    // 会在一个看不见的占用者上反复撞 MCP_PORT_IN_USE。
    const before = started.length;
    const failure = await expectMcpFailure({ port: 0, entries: ENTRIES }).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toContain("意外启动成功");
    expect(started).toHaveLength(before + 1);
  });

  it("端口被占时点名 MCP_PORT_IN_USE", async () => {
    const taken = await serve({ port: 0, entries: ENTRIES });
    const failure = await expectMcpFailure({ port: taken.port, entries: ENTRIES });
    expect(failure.name).toBe("McpServerError");
    expect(failure.code).toBe("MCP_PORT_IN_USE");
    expect(failure.message).toContain(String(taken.port));
  });

  it("端口要不到时不是 MCP_PORT_IN_USE 而是 MCP_SERVER_FAILED", async () => {
    // 低端口在 POSIX 上特权、在 Windows 上普通用户也绑得上，所以「绑不上」不能拿 port 1 造。
    // 这里让 listen 回一个非 EADDRINUSE 的错误：判的是错误映射，不是内核的脸色。
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(failedListen as never);
    try {
      const failure = await expectMcpFailure({ port: 1, entries: ENTRIES });
      expect(failure.code).toBe("MCP_SERVER_FAILED");
    } finally {
      listen.mockRestore();
    }
  });

  describe("会话装配缝", () => {
    it("会话抛错时收成一记 500，防护面仍按实际端口算好交出去", async () => {
      const { handle, seen } = await withFakeSession(async () => {
        throw new Error("transport 炸了");
      });
      await expect(statusOf(handle.port, "/mcp", { headers: MCP_HEADERS })).resolves.toBe(500);
      // 先接上再处理；close 那一记在响应结束时才来，逐条钉在下一条用例里。
      expect(seen.order.slice(0, 2)).toStrictEqual(["connect", "handle"]);
      expect(seen.endpoints[0]?.allowedHosts).toStrictEqual([
        `127.0.0.1:${String(handle.port)}`,
        `localhost:${String(handle.port)}`,
      ]);
    });

    it("响应已经写完时兜底不再写第二个状态行，也不漏出未处理拒绝", async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onRejection);
      try {
        const { handle, seen } = await withFakeSession(async (response) => {
          response.writeHead(202);
          response.end("{}");
          // 写完再抛：SDK 已经开始回包又失败的形态。此时再写一次头会同步抛
          // ERR_HTTP_HEADERS_SENT，而那颗抛出发生在 catch 里。
          throw new Error("半路炸了");
        });
        await expect(statusOf(handle.port, "/mcp", { headers: MCP_HEADERS })).resolves.toBe(202);
        // 关掉服务端再判：未处理拒绝要等微任务队列排空才会被报出来，close 的回包是又一轮。
        await handle.close();
        expect(rejections).toStrictEqual([]);
        expect(seen.order).toStrictEqual(["connect", "handle", "close"]);
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    });
  });
});
