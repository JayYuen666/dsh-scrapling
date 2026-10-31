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

/** 客户端允许的两种钉法：与宿主同线的那一版，或 npm 的 `next` 标签。
 *
 *  `next` 是刻意的例外：它随 npm dist-tag 漂移，可能偏离宿主线而让条目「装得上、
 *  永不生效」。放行它是为了跟踪官方 server 的 beta 线；对稳定性优先的部署应使用默认
 *  的字面版本，doctor 也会在发现不匹配时点名。 */
const MCP_CLIENT_PIN_VALUES = [MCP_DEFAULT_CLIENT_PIN, "next"] as const;
export type McpClientPin = (typeof MCP_CLIENT_PIN_VALUES)[number];
export const MCP_CLIENT_PINS: readonly string[] = MCP_CLIENT_PIN_VALUES;

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

/** server 的 URL：与 {@link startMcpServer} 实际 listen 的那个串由同一份常量拼出来。
 *
 *  IPv6 字面量必须带方括号，否则 `http://::1:39217/mcp` 连主机的分界都没有；
 *  端口在这里也校验一次，避免把越界值拼进一条客户端永远连不上的 URL。
 */
export function mcpUrl(port: number, host: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MCP port must be an integer in 1..65535, got ${String(port)}`);
  }
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${String(port)}${MCP_PATH}`;
}

/** 给用户的安装命令；profile 名留成占位符，CLI 不知道用户在用哪个 profile。 */
export function clientInstallCommand(pin: McpClientPin = MCP_DEFAULT_CLIENT_PIN): string {
  // JS 侧调用者（打包后的 CLI）拿不到联合类型；钉版越界会生成一条宿主拒绝装载的命令。
  if (!MCP_CLIENT_PINS.includes(pin)) {
    throw new Error(`unsupported MCP client pin: ${JSON.stringify(pin)}`);
  }
  return `dsh plugin --profile <profile> add ${MCP_CLIENT_PACKAGE}@${pin}`;
}
