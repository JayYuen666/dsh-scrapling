// lib/mcp-server.ts —— 把本插件的工具表原样端成一套 MCP server。
//
// 参数面与执行面都取自 native 那一份 `ToolDefinition`：这里不重写任何 schema 或映射，
// 否则两套定义必然漂移（spec §9.1「不允许两套参数面漂移」）。SDK 只在 `mcp` 模式真的
// 起服务时才动态载入，native 模式下这些依赖一行都不执行。

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import {
  MCP_LISTEN_HOST,
  MCP_PATH,
  MCP_SERVER_NAME,
  MCP_TOKEN_ENV,
  mcpUrl,
} from "./mcp-contract.ts";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { jsonOf } from "./browser-tools.ts";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";

/** MCP 侧看到的一枚工具：短名 + native 那份定义。 */
export interface McpToolEntry {
  readonly name: string;
  readonly definition: ToolDefinition;
}

/** 交出去的内容块：文本，或截图那一路的图片字节。 */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** 截图字节的中转：宿主 attachment 服务在 MCP 模式下不参与。 */
export interface McpImageSink {
  readonly saveImage: (input: {
    data: Uint8Array;
    mediaType: string;
    name?: string | undefined;
  }) => Promise<{ id: string }>;
  readonly take: (id: string) => { data: string; mimeType: string } | undefined;
}

/** 搜索发现层在 MCP 侧要的那两面；宿主给的是 `createWebSearchProvider` 的产物。 */
export interface McpSearchSurface {
  readonly available: () => boolean;
  readonly search: (
    request: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export interface McpServerOptions {
  /** 0 = 让内核挑端口。 */
  readonly port: number;
  readonly host?: string | undefined;
  readonly token?: string | undefined;
  readonly entries: readonly McpToolEntry[];
  readonly imageSink?: McpImageSink | undefined;
}

export interface McpServerHandle {
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** MCP server 自述的版本；由 test/publish-manifest.test.ts 钉成 package.json 同值。 */
export const MCP_SERVER_VERSION = "0.1.4";

const RAW_PREFIX = "scrapling_";

/**
 * MCP 不端出去的工具。
 *
 * `scrapling_answer` 让模型对页面正文再跑一次回答，而它读的是宿主会话的模型路由；
 * 外部 MCP 客户端没有那层路由，spec §4.2.2 于是把它排除在 server 面之外。
 */
const HIDDEN_TOOLS = new Set(["scrapling_answer"]);

/** 单次请求的正文上限：这一条路径不在宿主 `/api` 网关后面，上限得自己给。 */
const MAX_BODY_BYTES = 1_048_576;

/** 带错误码的服务端失败；调用方按 `code` 分流，不靠文案匹配。 */
export class McpServerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "McpServerError";
    this.code = code;
  }
}

/**
 * native 工具名换成 MCP 原始名。
 *
 * dsh 那侧再把它拼成 `mcp__scrapling__<原始名>`，所以这里只去掉本插件自己的前缀。
 */
export function mcpRawName(name: string): string {
  return name.startsWith(RAW_PREFIX) ? name.slice(RAW_PREFIX.length) : name;
}

/**
 * 端点清单：与 native 同一份工具表，减去不端出去的，加上 MCP 独有的 `search`。
 *
 * @param tools - native 那侧已经造好的定义，按注册顺序
 * @param search - MCP 独有的搜索工具；没有可用后端时不给
 * @returns MCP 侧的工具表
 */
export function mcpToolEntries(
  tools: readonly { name: string; definition: ToolDefinition }[],
  search?: ToolDefinition,
): McpToolEntry[] {
  const entries = tools
    .filter((tool) => !HIDDEN_TOOLS.has(tool.name))
    .map((tool) => ({ name: mcpRawName(tool.name), definition: tool.definition }));
  if (search !== undefined) {
    entries.push({ name: "search", definition: search });
  }
  return entries;
}

/**
 * 一个把图片字节留在内存里的 attachment 替身。
 *
 * 截图工具的产物形状要求它调 attachment 服务；MCP 客户端要的是 base64 image content，
 * 所以这里存字节、只回一个 id，投内容那一步按 id 取回并即时删除。
 */
export function createMcpImageSink(): McpImageSink {
  const stored = new Map<string, { data: string; mimeType: string }>();
  let seq = 0;
  return {
    saveImage: (input) => {
      seq += 1;
      const id = `mcp-${String(seq)}`;
      stored.set(id, {
        data: Buffer.from(input.data).toString("base64"),
        mimeType: input.mediaType,
      });
      return Promise.resolve({ id });
    },
    take: (id) => {
      const found = stored.get(id);
      stored.delete(id);
      return found;
    },
  };
}

function fieldOf(block: unknown, key: string): unknown {
  return isRecord(block) ? block[key] : undefined;
}

/** 把 native 的 render 结果投成 MCP content；投不出去的原样带 JSON，不静默丢。 */
export function projectBlocks(blocks: readonly unknown[], sink?: McpImageSink): McpContent[] {
  return blocks.map((block) => {
    const kind = fieldOf(block, "type");
    const text = fieldOf(block, "text");
    if (kind === "text" && typeof text === "string") {
      return { type: "text", text };
    }
    const id = fieldOf(fieldOf(block, "attachment"), "id");
    if (kind === "image" && sink !== undefined && typeof id === "string") {
      const stored = sink.take(id);
      if (stored !== undefined) {
        return { type: "image", data: stored.data, mimeType: stored.mimeType };
      }
    }
    return { type: "text", text: JSON.stringify(block) };
  });
}

const SEARCH_PARAMETERS = {
  query: { type: "string", required: true, description: "要检索的词。" },
  maxResults: { type: "integer", description: "返回来源的条数上限；不给就用部署设置的那一档。" },
} as const;

const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", required: true },
    count: { type: "integer", required: true },
    truncated: { type: "boolean", required: true },
    sources: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          snippet: { type: "string", required: true },
        },
      },
    },
    content: { type: "string", required: true },
  },
} as const;

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `search` 工具的规范输出。 */
interface SearchValue {
  readonly query: string;
  readonly count: number;
  readonly truncated: boolean;
  readonly sources: { url: string; title: string; snippet: string }[];
  readonly content: string;
}

/** 把 provider 那一面的结果收成 MCP 工具的稳定形状；缺字段一律落成空值而不是抛。 */
function normalizeSearch(query: string, raw: unknown): SearchValue {
  const sources = isRecord(raw) && Array.isArray(raw["sources"]) ? raw["sources"] : [];
  return {
    query,
    count: sources.length,
    truncated: isRecord(raw) ? raw["truncated"] === true : false,
    sources: sources.map((item) => ({
      url: textOf(fieldOf(item, "url")),
      title: textOf(fieldOf(item, "title")),
      snippet: textOf(fieldOf(item, "snippet")),
    })),
    content: isRecord(raw) ? textOf(raw["content"]) : "",
  };
}

function renderSearch(value: SearchValue): string {
  const lines: string[] = [`scrapling search: ${value.query}`];
  if (value.sources.length === 0) {
    lines.push("(no sources passed the URL gate)");
  }
  for (const [index, item] of value.sources.entries()) {
    const label = item.title.length > 0 ? item.title : item.url;
    lines.push(`${String(index + 1)}. ${label}`);
    if (item.snippet.length > 0) {
      lines.push(`   ${item.snippet}`);
    }
  }
  if (value.truncated) {
    lines.push("(结果被上限截断)");
  }
  return lines.join("\n");
}

/**
 * MCP 独有的 `search` 工具。
 *
 * native 那侧搜索是 ctx.web 的 provider，不占工具位；MCP 客户端没有那层接入，所以把
 * 同一个发现层端成一枚工具（spec §5.4）。来源已经过同一道 URL 闸门，被拦下的不会成为
 * 可引用的来源。
 */
export function mcpSearchTool(provider: McpSearchSurface): ToolDefinition {
  return defineTool({
    name: "search",
    description: "用本插件的搜索发现层检索一次，返回可引用的来源与已渲染正文。",
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: SEARCH_OUTPUT_SCHEMA,
      render: (_args: unknown, value: SearchValue) => [{ type: "text", text: renderSearch(value) }],
    },
    async execute(args: { query: string; maxResults?: number }, exec: ToolRunContext) {
      const { maxResults, query } = args;
      const raw = await provider.search(
        { query, ...(maxResults === undefined ? {} : { maxResults }) },
        exec.signal,
      );
      return normalizeSearch(query, raw);
    },
  });
}

/** 调一枚工具：成功交回渲染结果，失败交回 `isError`，不把异常抛进客户端连接。 */
async function runEntry(
  entry: McpToolEntry,
  args: unknown,
  signal: AbortSignal,
  sink?: McpImageSink,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  const params = args ?? {};
  try {
    // 十九个工具只读 exec 上的 signal（native 的单测同样只给这一位），MCP 请求的取消信号
    // 就落在这一位上。ToolRunContext 的其余成员是宿主的调用身份，这一侧没有对应事实可填。
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const exec = { signal } as ToolRunContext;
    const value = jsonOf(await entry.definition.execute(params, exec));
    const blocks = entry.definition.output.render(params, value) as readonly unknown[];
    return { content: projectBlocks(blocks, sink) };
  } catch (error) {
    // String(error) 而不是 error.message：这一层接的是第三方依赖抛出的任何东西，
    // 只认 Error 形状会在非 Error 抛出时留下一个空字符串。
    return { isError: true, content: [{ type: "text", text: String(error) }] };
  }
}

function pathOf(url: string | undefined): string {
  // node 给 server 侧请求的 url 总有值，类型上它是 optional。
  /* v8 ignore next 2 —— 兜的是类型上的 undefined，不是运行期到得了的一支。 */
  return (url ?? "").split("?")[0] ?? "";
}

function oversized(req: IncomingMessage): boolean {
  const length = Number(req.headers["content-length"]);
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  return token === undefined || req.headers.authorization === `Bearer ${token}`;
}

function refused(res: ServerResponse, status: number, challenge: boolean): void {
  res.writeHead(status, challenge ? { "www-authenticate": "Bearer" } : undefined);
  res.end();
}

function listenFailure(error: NodeJS.ErrnoException, port: number, host: string): McpServerError {
  return error.code === "EADDRINUSE"
    ? new McpServerError(
        "MCP_PORT_IN_USE",
        `MCP server cannot listen on ${host}:${String(port)} — that port is taken; move it with the mcpPort setting`,
      )
    : new McpServerError(
        "MCP_SERVER_FAILED",
        `MCP server cannot listen on ${host}:${String(port)} — ${error.message}`,
      );
}

/**
 * 从 listen 之后的地址里取端口。
 *
 * 类型上 `address()` 还能给出管道名与 null 两种形态；这一条路只走 TCP，所以那两种是
 * 一个点名的失败，而不是静默给个 0。
 */
export function boundPort(address: AddressInfo | string | null): number {
  if (address === null || typeof address === "string") {
    throw new McpServerError("MCP_SERVER_FAILED", "MCP server did not report a TCP bound address");
  }
  return address.port;
}

/** DNS 重绑定防护的允许面：只列这条 server 真实可达的 host:port 字面量。 */
export interface McpAllowedEndpoints {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}

function isWildcardHost(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::" || host === "[::]";
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/** 通配绑定时本机真正可达的名字：回环三枚 + 每张网卡的非 internal 地址。 */
function wildcardNames(): string[] {
  const names = new Set(["127.0.0.1", "localhost", "[::1]"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) {
        // IPv6 在 Host 头里必须带方括号，否则 `:port` 会和地址里的冒号混在一起。
        names.add(address.address.includes(":") ? `[${address.address}]` : address.address);
      }
    }
  }
  return [...names];
}

function endpointNames(host: string): string[] {
  if (isWildcardHost(host)) {
    return wildcardNames();
  }
  if (isLoopbackHost(host)) {
    return [host === "::1" ? "[::1]" : host, "localhost"];
  }
  return [host];
}

/**
 * 把绑定地址展开成允许的 Host / Origin 字面量。
 *
 * DNS 重绑定的攻击面是「浏览器把攻击者域名解析到 127.0.0.1，再用那个域名发请求」—— 请求里的
 * Host 头是攻击者的域名。SDK 对 Host / Origin 做逐字比较，所以这里只能列真实可达的字面量：
 * 写通配（或干脆留空）等于把这道防护关掉。
 *
 * @param host - 实际绑定地址
 * @param port - 实际绑定端口
 * @returns 允许的 Host 与 Origin 列表
 */
export function allowedEndpoints(host: string, port: number): McpAllowedEndpoints {
  const allowedHosts = [...new Set(endpointNames(host))].map((name) => `${name}:${String(port)}`);
  return { allowedHosts, allowedOrigins: allowedHosts.map((entry) => `http://${entry}`) };
}

async function listenOn(http: HttpServer, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) => {
      reject(listenFailure(error, port, host));
    });
    http.listen(port, host, () => {
      resolve(boundPort(http.address()));
    });
  });
}

async function settled(http: HttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    http.close(() => {
      resolve();
    });
    // 与 close 同批排队：不留着活动的 keep-alive 连接，端口才真的空了。
    http.closeAllConnections();
  });
}

/**
 * 起 MCP server。
 *
 * 无会话（stateless）形态：每条请求建一份协议对象与传输，响应结束即回收，所以端口后面
 * 不留下跨请求的状态。默认只绑回环；给了 `token` 就必须带 `Authorization: Bearer <token>`。
 *
 * @param options - 端口、可选绑定地址、可选 token、工具表与截图中转
 * @returns 实际端口、URL 与关闭函数
 */
export async function startMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  const host = options.host ?? MCP_LISTEN_HOST;
  // 绑定端口要等 listen 回来才知道，而防护判据要的是 host:port 字面量 —— 所以先留空，
  // 由 accept 之前的第一次请求把它按「实际端口」展开并缓存。handle 只会在 listen 之后被调到。
  let bound = 0;
  let guard: McpAllowedEndpoints | undefined;
  const serverModule = await import("@modelcontextprotocol/sdk/server/index.js");
  const types = await import("@modelcontextprotocol/sdk/types.js");
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // 高层 McpServer 只收 Zod 形状，而这里要端出去的正是 native 那份 JSON Schema。
      // oxlint-disable-next-line typescript/no-deprecated
      const protocol = new serverModule.Server(
        { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        { capabilities: { tools: {} } },
      );
      protocol.setRequestHandler(types.ListToolsRequestSchema, () => ({
        tools: options.entries.map((entry) => ({
          name: entry.name,
          description: entry.definition.description,
          inputSchema: entry.definition.parameters,
        })),
      }));
      protocol.setRequestHandler(types.CallToolRequestSchema, async (call, extra) => {
        const entry = options.entries.find((item) => item.name === call.params.name);
        if (entry === undefined) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `unknown tool: ${call.params.name}` }],
          };
        }
        return runEntry(entry, call.params.arguments, extra.signal, options.imageSink);
      });
      // DNS 重绑定防护：SDK 会对 Host / Origin 做逐字比较，所以允许面必须是真实可达的字面量。
      // 不写通配就是这条判据的全部意义 —— 没有它，恶意域名解析到 127.0.0.1 的请求看起来与本地请求一样。
      guard ??= allowedEndpoints(host, bound);
      // SDK 把这三项标成了 deprecated、建议改用外部中间件；本插件不起任何 web 框架，
      // 「外部中间件」这一层就是这里 —— 仍用 SDK 自带判据，它与 handleRequest 同批执行，
      // 不会出现中间件顺序错位那种漏判。
      // oxlint-disable typescript/no-deprecated
      const transport = new StreamableHTTPServerTransport({
        enableDnsRebindingProtection: true,
        allowedHosts: [...guard.allowedHosts],
        allowedOrigins: [...guard.allowedOrigins],
      });
      // oxlint-enable typescript/no-deprecated
      response.on("close", () => {
        void transport.close();
        void protocol.close();
      });
      await protocol.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      // 回包之前就失败时没有可读的 JSON-RPC 载体，只能给状态码。
      /* v8 ignore next 2 —— 到不了的一层：SDK 那两步只回错误响应，不抛。 */
      refused(response, 500, false);
    }
  }

  function accept(request: IncomingMessage, response: ServerResponse): void {
    if (!authorized(request, options.token)) {
      refused(response, 401, true);
      return;
    }
    if (pathOf(request.url) !== MCP_PATH) {
      refused(response, 404, false);
      return;
    }
    if (oversized(request)) {
      refused(response, 413, false);
      return;
    }
    void handle(request, response);
  }

  const http = createServer((request, response) => {
    accept(request, response);
  });
  const port = await listenOn(http, options.port, host);
  bound = port;
  if (options.token === undefined) {
    // 不阻断启动：默认只绑回环，这也是文档里的用法。但「本机任何进程都能调这些工具」这件事
    // 必须让人看见 —— 否则用户会以为它默认是锁着的。怎么上锁就写在警告里。
    process.stderr.write(
      `[dsh-scrapling] MCP server is listening on ${host}:${String(port)} WITHOUT authentication: any local process can call these tools. Set ${MCP_TOKEN_ENV} in the host's environment and restart the host to require a bearer token.\n`,
    );
  }
  return {
    port,
    url: mcpUrl(port, host),
    close: async () => {
      await settled(http);
    },
  };
}
