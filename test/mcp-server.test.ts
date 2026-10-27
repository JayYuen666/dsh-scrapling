// lib/mcp-server.ts —— 工具表到 MCP 的适配、传输与鉴权。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_TOKEN_ENV } from "../lib/mcp-contract.ts";
import {
  allowedEndpoints,
  createMcpImageSink,
  boundPort,
  mcpRawName,
  mcpSearchTool,
  mcpToolEntries,
  projectBlocks,
  startMcpServer,
} from "../lib/mcp-server.ts";
import type { McpImageSink, McpServerHandle, McpServerOptions } from "../lib/mcp-server.ts";
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

async function expectMcpFailure(options: McpServerOptions): Promise<McpError> {
  const thrown: unknown = await startMcpServer(options).catch((error_: unknown) => error_);
  return thrown as McpError;
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

async function closeAll(): Promise<void> {
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
 * 用 node:http 发一次 POST。
 *
 * fetch 的 forbidden header 名单里包含 Host，伪造它必须走原始 http.request：被判的那条路
 * 恰好是「浏览器把攻击者域名解析到 127.0.0.1，Host/Origin 头留的是攻击者域名」。
 */
async function rawPost(port: number, headers: Record<string, string>): Promise<number> {
  // node:http 的客户端只有事件回调，要拿到一个可 await 的「响应到了」只能自己 deferred；
  // 而 fetch 的 forbidden header 名单里不能写 Host，这条判据要判的正是伪造的 Host。
  // oxlint-disable-next-line promise/avoid-new, typescript/return-await
  return await new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
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
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.once("error", reject);
    request.end(INITIALIZE_BODY);
  });
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

describe("startMcpServer", () => {
  afterEach(closeAll);

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
    await client.close();
  });

  it("调用走同一份执行面，参数原样到达", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "fetch", arguments: { query: "hello" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("ok");
    expect(JSON.stringify(result.content)).toContain("hello");
    await client.close();
  });

  it("没有 arguments 的调用也落进同一张表，由工具自己判缺参", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "fetch" });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("参数不合法时回 isError，而不是把异常抛给客户端", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "fetch", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("query");
    await client.close();
  });

  it("名字不在表里时点名 unknown tool", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const client = await clientFor(handle.port);
    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unknown tool: nope");
    await client.close();
  });

  it("工具自己抛错时也落成 isError，不把异常抛进连接", async () => {
    const rough: ToolDefinition = {
      name: "scrapling_rough",
      description: "抛非 Error",
      parameters: {},
      output: { schema: OUTPUT, render: () => [] },
      execute: async () => {
        throw new Error("kaboom");
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
    await client.close();
  });

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
    await client.close();
  });

  it("设了 token 时，不带 Authorization 的请求 401，带了才列出工具", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES, token: TOKEN });
    const { port } = handle;
    await expect(statusOf(port, "/mcp", { headers: MCP_HEADERS })).resolves.toBe(401);
    const authed = await clientFor(port, TOKEN);
    const listed = await authed.listTools();
    expect(listed.tools.map((tool) => tool.name)).toStrictEqual(["fetch"]);
    await authed.close();
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
    ).resolves.not.toBe(403);
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

  it("关闭后端口不再有人监听", async () => {
    const handle = await serve({ port: 0, entries: ENTRIES });
    const { port } = handle;
    const client = await clientFor(port);
    await client.close();
    await handle.close();
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`).catch(
      (error_: unknown) => error_,
    );
    expect(response).toBeInstanceOf(TypeError);
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
});
