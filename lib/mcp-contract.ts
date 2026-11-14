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
 * 与宿主同版的那一支：安装命令与官方条目都钉它。
 *
 * npm 的 `latest` 比宿主线还旧（`0.0.1-rc.1`），而客户端对宿主各包的 peer 是**逐字同版**——
 * 版本差一个预发布就装得上、永不生效，所以这里不写 `latest`，也不写范围。
 *
 * 默认值跟开发基线走：`0.2.2-rc.2`。宿主窗口自 `^0.2.2-rc.2` 起，rc.1 落在窗口外——
 * 停在那条线上的宿主默认会被装载门拒掉，只能走显式风险授权 `allow-version` 放行；
 * 放行之后它要的客户端仍是同版 `0.2.2-rc.1`，所以那条钉法留在放行名单里（见下）。
 */
export const MCP_DEFAULT_CLIENT_PIN = "0.2.2-rc.2";

/** 客户端允许的钉法：本包宿主窗口覆盖到的每个宿主预发布的同版客户端，或 npm 的 `next` 标签。
 *
 *  本包的宿主窗口是 `^0.2.2-rc.2`，窗口内只有 rc.2 一个已发布的宿主预发布，所以默认那一份
 *  就够。rc.1 仍在名单里，理由是另一条路径：停在 rc.1 的宿主被装载门拒掉之后，用户可以走
 *  显式风险授权 `dsh plugin allow-version` 把它放进来；放进来之后，这个宿主仍按字面 peer 拒绝
 *  装载不匹配的客户端，它要的客户端就是同版 `0.2.2-rc.1`。名单不为「窗口内」服务，为「被
 *  豁免进来的旧宿主」服务——删掉它，那条豁免路径就会停在一个装不上的客户端版本上。
 *
 *  `next` 是刻意的例外：它随 npm dist-tag 漂移，可能偏离宿主线而让条目「装得上、
 *  永不生效」。放行它是为了跟踪官方 server 的 beta 线；对稳定性优先的部署应使用默认
 *  的字面版本，doctor 也会在发现不匹配时点名。 */
const MCP_CLIENT_PIN_VALUES = [MCP_DEFAULT_CLIENT_PIN, "0.2.2-rc.1", "next"] as const;
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
