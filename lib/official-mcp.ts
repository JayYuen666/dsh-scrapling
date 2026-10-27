// lib/official-mcp.ts —— 官方 scrapling-mcp 的接入配置生成与风险闸门。
//
// 这一层只产文本：本插件不改写、不删除、也不自动应用别人 profile 里的条目（spec §4.3）。
// 官方 server 走自己的进程与状态，不经本插件的 URL 守卫，所以它必须同时拿到
// `officialMcpEnabled` 与 setup 的 `--accept-risk` 才会被生成出来。

import path from "node:path";
import {
  clientInstallCommand,
  MCP_CLIENT_PACKAGE,
  MCP_DEFAULT_CLIENT_PIN,
  MCP_OFFICIAL_ENTRY_ID,
  MCP_SERVER_NAME,
  MCP_TRANSPORT_STDIO,
} from "./mcp-contract.ts";

export interface OfficialMcpOptions {
  /** 能力包所在的数据目录（官方 server 装在托管 venv 里）。 */
  readonly dataDir: string;
  /** 部署配置里的 `officialMcpEnabled`。 */
  readonly enabled: boolean;
  /** setup 这一次调用有没有带 `--accept-risk`。 */
  readonly acceptedRisk: boolean;
}

export interface OfficialMcpPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly serverName: string;
  /** 交给用户自己应用的 patch 片段文本。 */
  readonly patch: string;
  /** 这次接入放弃了什么，随配置一起打印。 */
  readonly risk: string;
  /** 客户端安装命令（钉版本）。 */
  readonly installCommand: string;
}

/** 带错误码的拒绝；调用方按 `code` 分流，不靠文案匹配。 */
export class OfficialMcpError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "OfficialMcpError";
    this.code = code;
  }
}

const CLIENT_VERSION = MCP_DEFAULT_CLIENT_PIN;

/** 官方 server 在托管 venv 里的入口。 */
export function officialMcpBinary(dataDir: string): string {
  return path.join(dataDir, "runtime", "venv", "bin", "scrapling-mcp");
}

/**
 * 双引号标量里的一个字符怎么落笔：五个具名转义，其余不可打印字符落 `\uXXXX`。
 *
 * 用 switch 而不是「查表 + `??` 兜底」：`char` 是正则字符类抓到的单个 UTF-16 码元，
 * `charCodeAt(0)` 一定有值，因此不需要 `codePointAt(0)?.` 那种永远走不到的兜底分支。
 */
function yamlEscape(char: string): string {
  switch (char) {
    case '"': {
      return String.raw`\"`;
    }
    case "\\": {
      return String.raw`\\`;
    }
    case "\n": {
      return String.raw`\n`;
    }
    case "\r": {
      return String.raw`\r`;
    }
    case "\t": {
      return String.raw`\t`;
    }
    default: {
      // 字符类只匹配 BMP 控制字符，char 是单个 UTF-16 码元；换 codePointAt 只会多出
      // 一段「string 可能为空」的类型面，在这里等于造一条永远走不到的兜底分支。
      // oxlint-disable-next-line unicorn/prefer-code-point
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  }
}

// 这条正则**就是**用来抓「不能裸出现在 YAML 双引号标量里的控制字符」的，命中是设计意图。
// oxlint-disable-next-line eslint/no-control-regex
const YAML_UNSAFE = /[\u0000-\u001F\u007F-\u009F"\\]/gu;

/**
 * 把一个字符串写成 YAML 双引号标量。
 *
 * 官方 server 的 command 是部署环境给的 dataDir 拼出来的绝对路径：带空格、`#`、Windows 盘符的
 * 冒号，甚至夹一个换行都可能。裸标量在这些字符上会被解析成另一份结构——`#` 之后整段变注释、
 * `key: value` 那个冒号被当成映射分隔、换行直接断行——于是 patch 指向一个不存在的命令，而错误
 * 要到宿主启动那次才现形。双引号风格对这些问题都免疫；转义集合取 YAML 双引号标量的子集（`\"` `\\` `\n`
 * `\r` `\t` 与 `\uXXXX`），所以这里不需要引入 YAML 序列化依赖。单引号风格不能用：
 * 它容不下换行（会被折行成空格），也无法表示控制字符。
 */
function yamlScalar(value: string): string {
  return `"${value.replaceAll(YAML_UNSAFE, (char) => yamlEscape(char))}"`;
}

const RISK =
  "official-mcp 直连官方 scrapling-mcp：那 16 个工具不经本插件的 URL 守卫与会话闸门（含 browser_evaluate 的任意 JS），" +
  "用的是它自己的会话与状态，本插件既不复用也不拦截。";

/**
 * 生成 dsh-mcp-client 的 stdio 接入配置。
 *
 * @param options - 数据目录与两项表态
 * @returns 命令、patch 文本、风险说明与安装命令
 * @throws OfficialMcpError 开关未开（`OFFICIAL_MCP_DISABLED`）或风险未确认（`RISK_NOT_ACCEPTED`）
 */
export function officialMcpPlan(options: OfficialMcpOptions): OfficialMcpPlan {
  if (!options.enabled) {
    throw new OfficialMcpError(
      "OFFICIAL_MCP_DISABLED",
      "official-mcp 未启用：部署配置里把 officialMcpEnabled 设为 true 才会生成接入配置",
    );
  }
  if (!options.acceptedRisk) {
    throw new OfficialMcpError(
      "RISK_NOT_ACCEPTED",
      `${RISK} 确认接受请再跑一次 setup 并带 --accept-risk。`,
    );
  }
  const command = officialMcpBinary(options.dataDir);
  return {
    command,
    args: [],
    serverName: MCP_SERVER_NAME,
    risk: RISK,
    installCommand: clientInstallCommand(CLIENT_VERSION),
    patch: [
      "- insert:",
      `    - id: ${MCP_OFFICIAL_ENTRY_ID}`,
      `      name: '${MCP_CLIENT_PACKAGE}'`,
      "      config:",
      `        serverName: ${MCP_SERVER_NAME}`,
      `        transport: ${MCP_TRANSPORT_STDIO}`,
      `        command: ${yamlScalar(command)}`,
      "        args: []",
      "        failOnStartupError: true",
      "",
    ].join("\n"),
  };
}

/**
 * official-mcp 模式下宿主该播报的那一句。
 *
 * 生成动作属于 setup（`--accept-risk` 是命令行列旗标，不是插件设置），所以这里只指路，
 * 不生成、不写任何 profile。
 */
export function officialMcpHint(enabled: boolean): string {
  return enabled
    ? `生成接入配置请跑 setup：dsh-scrapling setup --mode official-mcp --accept-risk。${RISK}`
    : "official-mcp 未启用：先在部署配置里设 officialMcpEnabled=true，再跑 setup --mode official-mcp --accept-risk。";
}
