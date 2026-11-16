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
  /**
   * 能力包所在的数据目录（官方 server 装在托管 venv 里）。
   *
   * 必须是绝对路径：这一位拼出来的 `command:` 会写进 cordis 的 patch，而相对路径是按
   * **宿主进程**的 cwd 解析的，跟生成它的那个 shell 的 cwd 不是同一个。CLI 侧在
   * `defaultDataDir()` 里 `path.resolve` 过一次，宿主侧走 `resolveDataDir`。
   */
  readonly dataDir: string;
  /** 部署配置里的 `officialMcpEnabled`。 */
  readonly enabled: boolean;
  /**
   * setup 这一次调用有没有带 `--accept-risk`。
   *
   * 生成接入配置这件事只属于 setup 那条命令行：`--accept-risk` 是命令行列旗标，不是插件设置
   * （见 `officialMcpHint`），宿主侧读的是 profile 里已有的条目、不会走这一层。所以新增任何
   * 入口（doctor、宿主启动路径）时，这一位都必须接在真实的命令行表态上，而不是自己填 `true`。
   */
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

/** 官方 server 在托管 venv 里的入口。
 *  布局跟解释器同源：POSIX 在 `bin/`，Windows 在 `Scripts/` 且可执行体带 `.exe`。 */
export function officialMcpBinary(dataDir: string): string {
  // 闸门放在**生成侧**：这一位拼出来的 `command:` 会被写进 patch，而相对路径是按宿主进程的
  // cwd 解析的 —— 与生成它的那个 shell 不是同一个目录时，patch 指向一个不存在的命令，错误要
  // 到宿主启动那次才现形。两个现有调用点都先 `path.resolve` 过，但本函数是导出的，注释里也
  // 预告了 doctor 之类的新入口，所以判据留在这里而不是交给调用方。
  if (!path.isAbsolute(dataDir)) {
    throw new OfficialMcpError(
      "OFFICIAL_MCP_DATA_DIR",
      `官方 server 的入口要绝对 dataDir 才能拼：现在给的是 ${JSON.stringify(dataDir)}。` +
        "相对路径会被宿主按它自己的 cwd 解析，写进 patch 的 command 就不是这个文件了。",
    );
  }
  const venv = path.join(dataDir, "runtime", "venv");
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "scrapling-mcp.exe")
    : path.join(venv, "bin", "scrapling-mcp");
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
      // 一段「string 可能为空」的类型声明，在这里等于造一条永远走不到的兜底分支。
      // oxlint-disable-next-line unicorn/prefer-code-point
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  }
}

// 这条正则**就是**用来抓「不能原样出现在 YAML 双引号标量里的控制字符」的，命中是设计意图。
// oxlint-disable-next-line eslint/no-control-regex
const YAML_UNSAFE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029"\\]/gu;

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

// 这里不写工具条数：那是官方 server 随版本变化的事实，而这段话是用户做 `--accept-risk` 表态
// 时唯一的依据。要点的名字（`browser_evaluate`）留着——它是这条披露真正要警示的那一枚。
const RISK =
  "official-mcp 直连官方 scrapling-mcp：它的全部工具不经本插件的 URL 守卫与会话闸门" +
  "（钉住的 scrapling 版本里有 `browser_evaluate` 这类任意 JS 执行），用的是它自己的会话与状态，本插件既不复用也不拦截。";

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
  // patch 从这几个字段派生，而不是各写一遍：`args` 先前在返回值与 patch 文本里各有一份字面量，
  // 官方 server 一旦需要参数（transport / dataDir），改一处就会与另一处漂移，而 patch 才是
  // 用户真正应用的那份。这里用 JSON.stringify 落 `[]` / 带引号的参数数组 —— 形态与 YAML 的
  // 流式序列一致，且字符串会按 JSON 规则转义（YAML 1.2 的流式集合是 JSON 的超集）。
  const args: readonly string[] = [];
  const serverName = MCP_SERVER_NAME;
  return {
    command,
    args,
    serverName,
    risk: RISK,
    installCommand: clientInstallCommand(CLIENT_VERSION),
    patch: [
      "- insert:",
      `    - id: ${MCP_OFFICIAL_ENTRY_ID}`,
      `      name: '${MCP_CLIENT_PACKAGE}'`,
      "      config:",
      `        serverName: ${serverName}`,
      `        transport: ${MCP_TRANSPORT_STDIO}`,
      `        command: ${yamlScalar(command)}`,
      `        args: ${JSON.stringify(args)}`,
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
  // `--profile` 不是可省的：那条开关只从 profile 的 cordis.patch.yml 读（见 `lib/cli.ts` 的
  // setupMode —— 不带 `--profile` 时 `enabled` 恒 false），漏了它的命令按下去必然落进
  // OFFICIAL_MCP_DISABLED，用户看到的却是「开关没开」，而他已经开了。
  return enabled
    ? `宿主没有 mcpManager（CLI/headless）或动态注册失败时，用 setup 生成手工接入配置：dsh-scrapling setup --profile <profile 目录> --mode official-mcp --accept-risk。${RISK}`
    : "official-mcp 未启用：先在部署配置里设 officialMcpEnabled=true；宿主没有 mcpManager 时再跑 dsh-scrapling setup --profile <profile 目录> --mode official-mcp --accept-risk。";
}
