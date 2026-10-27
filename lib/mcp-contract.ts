// lib/mcp-contract.ts —— MCP 模式里两侧必须逐字相同的几个名字。
//
// server 监听的 path、客户端认的 transport 名、profile 条目里的 serverName 与端口默认值，
// 一旦各写一处，setup 生成的条目就会指向一个 server 没在听的地方，而 doctor 查不出来。
// 这一份只 `export const`，不 import 任何运行期依赖：CLI 打成单文件时不能把 host.ts 那侧的
// 宿主 peer 一起拖进去。

export const MCP_SERVER_NAME = "scrapling";

/** server 只认这一个路径；其余一律 `404`。 */
export const MCP_PATH = "/mcp";

/** 默认只绑回环：这一条路径不在宿主 `/api` 网关后面，没有宿主那道认证。 */
export const MCP_LISTEN_HOST = "127.0.0.1";

/** `mcpPort` 设置的默认值，也是 setup 生成 URL 时的默认端口。 */
export const DEFAULT_MCP_PORT = 39_217;

/** 本插件 server 用的传输名；客户端与官方 server 的 stdio 条目靠它区分。 */
export const MCP_TRANSPORT_HTTP = "streamable-http";
export const MCP_TRANSPORT_STDIO = "stdio";

/** token 只走环境变量：写进 profile 等于把它交给每个能读那个文件的人。 */
export const MCP_TOKEN_ENV = "DSH_SCRAPLING_MCP_TOKEN";

/** 宿主侧的 MCP 客户端包名；本插件不依赖它，只生成它的条目文本。 */
export const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";

/**
 * 与宿主同线的那一版：安装命令与官方条目都钉它。
 *
 * npm 的 `latest` 比宿主线还旧（`0.0.1-rc.1`），宿主对字面 peer 不匹配的对端是**拒绝装载**——
 * 装得上、永不生效，所以这里不写 `latest`，也不写范围。
 */
export const MCP_DEFAULT_CLIENT_PIN = "0.2.1-rc.3";

/** 客户端允许的两种钉法：与宿主同线的那一版，或 npm 的 `next` 标签。 */
export const MCP_CLIENT_PINS: readonly string[] = [MCP_DEFAULT_CLIENT_PIN, "next"];

/** 生成的条目里这条 insert 的 id：一个给本插件的 server，一个给官方 server。 */
export const MCP_CLIENT_ENTRY_ID = "scrapling-mcp";
export const MCP_OFFICIAL_ENTRY_ID = "scrapling-official-mcp";

/** 三种互斥的接法；`integrationMode`、CLI 的 `--mode` 与 doctor 的判据共用这一份。 */
export const MCP_MODES = ["native", "mcp", "official-mcp"] as const;
export type McpMode = (typeof MCP_MODES)[number];

const MODE_NAMES: ReadonlySet<string> = new Set<string>(MCP_MODES);

export function isMcpMode(value: string): value is McpMode {
  return MODE_NAMES.has(value);
}

/** server 的 URL：与 {@link startMcpServer} 实际 listen 的那个串由同一份常量拼出来。 */
export function mcpUrl(port: number, host: string): string {
  return `http://${host}:${String(port)}${MCP_PATH}`;
}

/** 给用户的安装命令；profile 名留成占位符，CLI 不知道用户在用哪个 profile。 */
export function clientInstallCommand(pin: string = MCP_DEFAULT_CLIENT_PIN): string {
  return `dsh plugin --profile <profile> add ${MCP_CLIENT_PACKAGE}@${pin}`;
}
