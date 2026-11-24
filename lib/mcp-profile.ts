// lib/mcp-profile.ts —— 生成与读回 profile 里的 MCP 条目文本，并判模式一致性。
//
// 射程只到 profile 自己写的那份 patch 文本：bundle 组合后的树不在这里读，因为 `dsh --dump-config`
// 会重写 profile 根配置，而 doctor 的判据必须来自「用户到底写了什么」。生成与解析放在一处，
// 是为了让 setup 写出的条目必然能被 doctor 读回——缩进改一笔，两边一起变。

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import {
  clientInstallCommand,
  MCP_CLIENT_ENTRY_ID,
  MCP_CLIENT_PACKAGE,
  MCP_CLIENT_PINS,
  MCP_LISTEN_HOST,
  MCP_SERVER_NAME,
  MCP_TOKEN_ENV,
  MCP_TOOL_LOADINGS,
  MCP_TRANSPORT_HTTP,
  MCP_TRANSPORT_STDIO,
  DEFAULT_MCP_TOOL_LOADING,
  mcpUrl,
} from "./mcp-contract.ts";
import type { McpMode, McpToolLoading } from "./mcp-contract.ts";

/** profile 文本的行分隔与 URL 端口（读不出端口时用它兜一次冒号匹配）。 */
const LINE_BREAK = /\r\n|\n|\r/u;
const URL_PORT = /:(?<port>\d+)/u;

export type ProfileMode = McpMode;

export interface ProfileInspection {
  readonly mode: ProfileMode;
  /** profile 的 `cordis.patch.yml` 文本。 */
  readonly patchText: string;
  /** profile `package.json` 里 dsh-mcp-client 的那一条版本；没装就是 undefined。 */
  readonly clientVersion?: string | undefined;
  /**
   * profile 的 `package.json` 自身读不懂（JSON 语法错误 / 顶层不是对象）。
   *
   * 与「这条依赖没声明」是两件事：前者要先修文件，后者才是去装。合成一个信号会让
   * doctor 在文件写坏时把用户支去装一个已经声明的依赖。
   */
  readonly clientVersionBroken?: boolean | undefined;
  readonly officialMcpEnabled: boolean;
  /**
   * 部署项 `mcpPort` 当前说的那个端口；只有 `mcp` 模式给。
   *
   * CLI 读不到宿主的设置存储，所以这一位由 `--port` 传进来，缺省即「不比对」。
   */
  readonly expectedPort?: number | undefined;
}

export interface McpFinding {
  readonly code: string;
  readonly detail: string;
}

interface ProfileEntry {
  readonly name: string;
  readonly config: Record<string, string | undefined>;
}

/** YAML 里 `#` 只有前面是空白（或行首）时才开始注释；`true#x` 是一个字符串，不是布尔。 */
const TRAILING_COMMENT = /[\t ]#.*$/u;

const QUOTED_SCALAR = /^(?:"(?<double>[^"]*)"|'(?<single>[^']*)')$/u;

/**
 * 条目认「`name:` 之后、比它更缩进的那一段键值」，不认第几格。
 *
 * 同一份条目文本有三种合法缩进：profile 的 patch 写法（`name:` 6 格、config 键 8 格）、
 * 宿主 `--dump-config` 打出的合成列表（2 格 / 4 格），以及人手写的别的层级。写死格数的解析
 * 会在后两种里把真存在的条目读成「没有条目」，doctor 于是报一条误报。
 *
 * 标量本身也不是只有一种写法：列表项可以写 `- name:`，值可以是单引号、双引号或裸标量，
 * 行尾可以带注释或空格。这些都是合法 YAML（本仓自己的 `cordis.patch.yml` 用的就是双引号），
 * 只认「单引号 + 行尾干净」那一种会把真存在的条目读成没有 —— 误报与漏报残留都从这里来。
 */
const ENTRY_NAME = /^(?:-[\t ]*)?name:(?<value>.*)$/u;
const CONFIG_KEY = /^(?<key>[\w-]+):[\t ]+(?<value>\S.*)$/u;

/**
 * 一行 `name:` 是开一条**新**条目，还是嵌在条目内部的子键。
 *
 * 判据是层级：比当前条目更浅或同级的 `name:` 才是兄弟条目；嵌在 config 里的子键
 * （`tools:` 下的 `name:`、`headers:` 下的同名项）比条目本身更深，它不是条目。
 * 列表项短横（`- name:`）永远算新条目 —— `- ` 本身断言的就是「这里是一项」。
 *
 * 原先只凭「这一行匹配到 name:」就无条件开新条目，后果有两个方向：真条目的
 * `serverName` / `transport` / `url` 被伪条目抢走，端口与模式判据全部落空；伪条目名若
 * 恰好是客户端包名，还会凭空多报一条 `DUPLICATE_SCRAPLING_ENTRY`。
 *
 * @param isListItem - 这一行是否以列表项短横开头
 * @param currentIndent - 当前条目的 `name:` 缩进；还没有条目时为 undefined
 * @param indent - 这一行的缩进
 */
function startsEntry(
  isListItem: boolean,
  currentIndent: number | undefined,
  indent: number,
): boolean {
  return isListItem || currentIndent === undefined || indent <= currentIndent;
}

/**
 * 把一个 YAML 标量收成裸值：去掉包裹的引号、行尾注释与两端空白。
 *
 * **先试「整段就是引号包起来的值」，再剥行尾注释，剥完再试一次引号。** 两个方向都要照顾：
 * · `"scrapling # mine"` 是一整个带引号的值，里面的 `#` 不是注释（YAML 的注释只在引号外的
 *   空白之后才开始）。若先剥注释会得到 `"scrapling`（引号不配对），于是一个合法标量被读成
 *   半截串。
 * · `'scrapling' # 用哪个客户端` 是「引号值 + 行尾注释」。整段匹配不上引号形状，必须先剥
 *   注释，剥完才是 `'scrapling'`，还要再剥一次引号得到裸名。
 * 只做其中一次都会漏一种写法，而两种都是本仓真实出现过的（生成侧写双引号，用户手改常带注释）。
 *
 * 不处理转义序列：这里的值只用来比对 `serverName` / `transport` / URL 端口，不做语义还原。
 *
 * @param raw - `key:` 之后的原文
 * @returns 去掉包裹后的标量；整行只有注释或空白时为 undefined
 */
function scalarOf(raw: string): string | undefined {
  const trimmed = raw.trim();
  const direct = QUOTED_SCALAR.exec(trimmed)?.groups;
  if (direct !== undefined) {
    return direct["double"] ?? direct["single"];
  }
  const uncommented = trimmed.replace(TRAILING_COMMENT, "").trim();
  const quoted = QUOTED_SCALAR.exec(uncommented)?.groups;
  const bare = quoted?.["double"] ?? quoted?.["single"];
  if (bare !== undefined) {
    return bare;
  }
  return uncommented.length === 0 ? undefined : uncommented;
}

/**
 * 切行：Windows 上编辑器写出的 patch 是 CRLF，`\r` 留在行尾会让键值两侧的 `$` 锚点全部落空，
 * 表现是条目「一条都不存在」。按行终止符切，别只切 `\n`。
 */
function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

function parseEntries(text: string): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  let current: { entry: ProfileEntry; indent: number } | undefined;
  for (const line of splitLines(text)) {
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    const isListItem = body.startsWith("-");
    const named = scalarOf(ENTRY_NAME.exec(body)?.groups?.["value"] ?? "");
    const keyed = CONFIG_KEY.exec(body)?.groups;
    if (named !== undefined && startsEntry(isListItem, current?.indent, indent)) {
      current = { entry: { name: named, config: {} }, indent };
      entries.push(current.entry);
    } else if (
      keyed?.["key"] !== undefined &&
      keyed["value"] !== undefined &&
      current !== undefined &&
      indent > current.indent
    ) {
      // 行尾注释不是值的一部分：`transport: stdio # …` 仍然是 stdio，
      // 留着注释会让 isOfficial 把它读成非官方条目；引号同理。
      // 值只有注释时 scalarOf 返回 undefined；存成 undefined 与缺席同义，
      // 所有消费点（serverName / transport / url）都做字符串比较。
      current.entry.config[keyed["key"]] = scalarOf(keyed["value"]);
    }
  }
  return entries;
}

function portOf(entry: ProfileEntry): string | undefined {
  const { url } = entry.config;
  let port: string | undefined;
  if (url !== undefined) {
    try {
      const { port: explicitPort, protocol } = new URL(url);
      if (explicitPort === "") {
        // URL 省略端口时按 scheme 默认值比对：否则 `https://host/mcp` 与 --port 443
        // 会被判成不一致。
        if (protocol === "http:") {
          port = "80";
        } else if (protocol === "https:") {
          port = "443";
        }
      } else {
        port = explicitPort;
      }
    } catch {
      // 不是完整 URL（手写的半截值）时退回冒号匹配，至少保留旧行为。
      port = URL_PORT.exec(url)?.groups?.["port"];
    }
  }
  return port;
}

function isOfficial(entry: ProfileEntry): boolean {
  return entry.config["transport"] === MCP_TRANSPORT_STDIO;
}

function clientFindings(input: ProfileInspection): McpFinding[] {
  const findings: McpFinding[] = [];
  // 文件坏掉时先说这一条，且**不**再说「没装」：后者会把用户支去装一个其实已经声明的依赖，
  // 真实故障（package.json 被半截写入 / 留着冲突标记）就被那条建议盖住了。
  if (input.clientVersionBroken === true) {
    findings.push({
      code: "MCP_CLIENT_MANIFEST_BROKEN",
      detail:
        "profile 的 package.json 读不懂（JSON 语法错误或顶层不是对象）——这不是「没装客户端」，先把这份文件修好",
    });
    return findings;
  }
  if (input.mode !== "native" && input.clientVersion === undefined) {
    findings.push({
      code: "MCP_CLIENT_MISSING",
      detail: `profile 没有 ${MCP_CLIENT_PACKAGE}：跑 ${clientInstallCommand()} 装上它`,
    });
  }
  // clientVersion 来自 JSON.parse 之后的 package.json，外层引号早被解析器吃掉，
  // 这里不再剥引号：剥了一半反而会把带尾引号的值送去比对钉版表。
  const pinned = input.clientVersion;
  if (pinned !== undefined && !MCP_CLIENT_PINS.includes(pinned)) {
    findings.push({
      code: "MCP_CLIENT_UNPINNED",
      detail: `客户端钉的是 ${input.clientVersion}，只接受 ${MCP_CLIENT_PINS.join(" 或 ")} —— 宿主对不匹配的对端拒绝装载`,
    });
  }
  return findings;
}

function modeFindings(input: ProfileInspection, scrapling: readonly ProfileEntry[]): McpFinding[] {
  const findings: McpFinding[] = [];
  if (scrapling.length > 1) {
    findings.push({
      code: "DUPLICATE_SCRAPLING_ENTRY",
      detail: `serverName 为 scrapling 的条目有 ${String(scrapling.length)} 条，一个名字只能有一个 server`,
    });
  }
  if (
    scrapling.some((entry) => isOfficial(entry)) &&
    scrapling.some((entry) => !isOfficial(entry))
  ) {
    findings.push({
      code: "MCP_MODE_CONFLICT",
      detail: `本插件的 ${MCP_TRANSPORT_HTTP} 条目与官方 ${MCP_TRANSPORT_STDIO} 条目并存；同一时刻只能一种`,
    });
  }
  const needOfficial = input.mode === "official-mcp";
  const matched = scrapling.some((entry) => needOfficial === isOfficial(entry));
  if (input.mode === "native" && scrapling.length > 0) {
    findings.push({
      code: "MCP_MODE_ENTRY_MISMATCH",
      detail: "integrationMode=native 却留着 scrapling 的 MCP 条目：模型会同时看到两套工具",
    });
  } else if (input.mode !== "native" && !matched) {
    findings.push({
      code: "MCP_MODE_ENTRY_MISMATCH",
      detail: `integrationMode=${input.mode} 需要 ${needOfficial ? MCP_TRANSPORT_STDIO : MCP_TRANSPORT_HTTP} 条目，profile 里没有`,
    });
  }
  if (needOfficial && !input.officialMcpEnabled && scrapling.some((entry) => isOfficial(entry))) {
    findings.push({
      code: "MCP_OFFICIAL_SWITCH_OFF",
      detail:
        "留着官方 stdio 条目但 officialMcpEnabled=false：官方 server 的工具不经本插件守卫，开关要明说",
    });
  }
  return findings;
}

/**
 * 端口一致性与「读得出端口」两条判据。
 *
 * 少了后半条时有一段静默盲区：给了 `--port`、条目也在，但 `url` 读不出端口（空值、
 * `${PORT}` 占位符、被引号或注释截断的手写值）—— 那时一条端口都收不到，旧实现直接返回空数组，
 * 于是**比对根本没发生**却打成一致。这种状态下客户端连的是 patch 里写死的端口，而部署项
 * `mcpPort` 可能早已改成别的值，症状是「MCP 连不上」而 doctor 一切正常。
 *
 * 官方 stdio 条目本来就没有 url，按 `isOfficial` 排除：否则 official-mcp 模式会凭空报一条。
 *
 * @param scrapling - 已过滤出本插件 serverName 的条目
 * @param expectedPort - `--port` 给的预期端口；undefined 表示不比对
 * @returns 端口相关的问题
 */
function portFindings(scrapling: readonly ProfileEntry[], expectedPort?: number): McpFinding[] {
  const found = [
    ...new Set(scrapling.map((entry) => portOf(entry)).filter((port) => port !== undefined)),
  ];
  if (found.length === 0) {
    const httpEntries = scrapling.filter((entry) => !isOfficial(entry));
    if (expectedPort !== undefined && httpEntries.length > 0) {
      return [
        {
          code: "MCP_PORT_UNREADABLE",
          detail: `给了 --port ${String(expectedPort)}，但 profile 里 ${String(httpEntries.length)} 条 ${
            MCP_TRANSPORT_HTTP
          } 条目都读不出端口（url 为空、写成占位符或被引号/注释截断）：端口一致性没法比对，客户端连哪个端口取决于 patch 里那条 url`,
        },
      ];
    }
    return [];
  }
  const wanted = expectedPort === undefined ? undefined : String(expectedPort);
  if (found.length < 2 && (wanted === undefined || found.includes(wanted))) {
    return [];
  }
  return [
    {
      code: "MCP_PORT_MISMATCH",
      detail: `条目里的端口是 ${found.join(", ")}${
        wanted === undefined ? "" : `，--port 说的是 ${wanted}`
      }；改过 mcpPort 就要重新应用 patch`,
    },
  ];
}

/**
 * 判 profile 里的 scrapling MCP 条目与插件模式是否一致。
 *
 * @param input - 模式、patch 文本、客户端版本、官方开关与可选的端口预期
 * @returns 发现的问题；空数组表示一致
 */
export function inspectProfile(input: ProfileInspection): McpFinding[] {
  const scrapling = parseEntries(input.patchText).filter(
    (entry) => entry.name === MCP_CLIENT_PACKAGE && entry.config["serverName"] === MCP_SERVER_NAME,
  );
  return [
    ...clientFindings(input),
    ...modeFindings(input, scrapling),
    ...portFindings(scrapling, input.expectedPort),
  ];
}

/** profile 里与 MCP 有关的四项状态。 */
export interface ProfileSnapshot {
  readonly patchText: string;
  readonly clientVersion?: string | undefined;
  /**
   * profile 的 `package.json` 读不懂（不是「客户端没装」）。
   *
   * 判据在 {@link clientManifestOf}：空文本是没装，语法坏 / 顶层非对象才是这一位。
   */
  readonly clientVersionBroken?: boolean | undefined;
  readonly officialMcpEnabled: boolean;
  /** 部署项 mcpToolLoading；旧 profile 没写时按宿主默认 eager。 */
  readonly mcpToolLoading: McpToolLoading;
}

/**
 * `officialMcpEnabled` 那一行；值里可能带 YAML 注释与引号，行尾可能带 \r。
 *
 * 只认 YAML 1.2 的三种布尔真值拼法（`true` / `True` / `TRUE`）：`yes`、`1`、`truthy` 这类
 * 「看着像开」的写法和裸 `false` 一样都按未开启处理。把「未开启」判据放宽到任意非空值，会让宿主
 * 仍按 false 处理时 doctor 打绿——那比方红更贵。
 *
 * **行首允许缩进**：这一位是插件自己的 config 键（`host.ts` 的 schema 里就有
 * `officialMcpEnabled: Schema.boolean()`），profile 里它写在 `- id: scrapling` 的 `config:`
 * 下面，缩进 8 格是常态。「根映射的一键」这个说法只描述语义归属，不是缩进要求——按「必须顶格」
 * 去收紧会让所有真实 profile 都读成关闭。
 */
const SWITCH_LINE = /^(?<indent>[\t ]*)officialMcpEnabled:(?<value>[^\r\n]*)$/gmu;
const TOOL_LOADING_LINE = /^(?<indent>[\t ]*)mcpToolLoading:(?<value>[^\r\n]*)$/gmu;

/**
 * 取插件 config 标量文本；同一份文本里出现多次时取**同一缩进档**的最后一条。
 *
 * YAML 的重复键按「后者生效」解析，宿主读到的就是那一条；取第一条会让 doctor 的判据与
 * 宿主实际行为相反（前 false 后 true 时，doctor 说开关没开，而宿主已经把工具端出去了）。
 *
 * 限定「同一缩进档」是防**嵌套同名键**：`headers:` 之类的子映射里再出现一个同名键比插件
 * config 那一层更深，它不是同一个配置项。跨档取最后一条会让无关子键改变部署值。取首个命中的
 * 缩进作基准——插件 config 这一档总是先出现。
 */
function indentedScalar(text: string, pattern: RegExp): string | undefined {
  let baseIndent: string | undefined;
  let raw: string | undefined;
  for (const match of text.matchAll(pattern)) {
    /* v8 ignore next -- 命名组恒存在（`indent` 在模式里是无条件的），`?? ""` 只是类型收窄 */
    const indent = match.groups?.["indent"] ?? "";
    // 首个命中的缩进作基准：插件 config 那一档总是先出现，比它更深的同名键属于别的映射。
    baseIndent ??= indent;
    if (indent === baseIndent) {
      raw = match.groups?.["value"];
    }
  }
  const value = raw?.replace(TRAILING_COMMENT, "").trim();
  const quoted = value === undefined ? undefined : QUOTED_SCALAR.exec(value)?.groups;
  return quoted?.["double"] ?? quoted?.["single"] ?? value;
}

function switchScalar(text: string): string | undefined {
  return indentedScalar(text, SWITCH_LINE);
}

/** 读部署项 mcpToolLoading；缺席保持 eager，非法值 fail-closed。 */
function toolLoadingOf(text: string): McpToolLoading {
  const value = indentedScalar(text, TOOL_LOADING_LINE);
  if (value === undefined || value === DEFAULT_MCP_TOOL_LOADING) {
    return DEFAULT_MCP_TOOL_LOADING;
  }
  if (value === "on-demand") {
    return value;
  }
  throw new Error(
    `mcpToolLoading 配置非法：${JSON.stringify(value)}；只接受 ${MCP_TOOL_LOADINGS.join(" / ")}`,
  );
}

function isSwitchOn(text: string): boolean {
  const value = switchScalar(text);
  return value === "true" || value === "True" || value === "TRUE";
}

/**
 * 读一份 profile 文本。
 *
 * 只有 ENOENT 才是「这份文件不存在」；EACCES、EISDIR、EMFILE 这些读不到的原因不能压成
 * 空串——空串在 doctor 眼里就是「profile 里什么都没写」，于是要么静默打绿、要么报一条
 * 与事实无关的模式不匹配。其余错误原样上抛，由 CLI 的 reportFailure 统一处理成一句可读失败。
 *
 * @param file - 要读的文件
 * @returns 文件正文；文件不存在时为空串
 */
async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return "";
    }
    throw new Error(`读不出 ${file}：${String(error)}`, { cause: error });
  }
}

/**
 * 读 `package.json` 里客户端那一条版本，并把「读不懂」与「没有」分开。
 *
 * 「文件不存在 / 空文本」＝没装；**JSON 语法错误或顶层不是对象**＝这份文件坏了（半截写入、
 * 合并冲突标记）。两者原先都折成 `{}`，于是 doctor 在文件坏掉时也说「跑 dsh plugin add 装上它」，
 * 把用户支去装一个其实已经声明的依赖——真实故障（文件写坏）被这条建议盖住。
 *
 * @param manifestText - `package.json` 的正文（读不到时为空串）
 * @returns 客户端版本（没装即 undefined）与这份文件是否读不懂
 */
function clientManifestOf(manifestText: string): {
  version?: string | undefined;
  broken: boolean;
} {
  if (manifestText.trim().length === 0) {
    return { broken: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return { broken: true };
  }
  if (!isRecord(parsed)) {
    return { broken: true };
  }
  const { dependencies } = parsed;
  const version = isRecord(dependencies) ? dependencies[MCP_CLIENT_PACKAGE] : undefined;
  return { version: typeof version === "string" ? version : undefined, broken: false };
}

/**
 * `--profile` 必须指向目录。
 *
 * 不先判这一条时，两个平台对「profile 是个普通文件」给出相反结论：POSIX 读
 * `<文件>/cordis.patch.yml` 报 `ENOTDIR`，而 Windows 报 `ENOENT` —— 那正是
 * {@link readText} 用来表示「这份配置不存在」的错误码，于是同一份错误输入在 Windows 上
 * 被当成空 profile 静默退 0。判据放在两个平台共同的入口，结论才不会跟着文件系统走。
 *
 * 目录不存在时**不**在这里报错：`setup --status --profile <还没建的目录>` 仍要能输出
 * 一份空快照，那两种情况由下面的 `readText` 分别处理。
 *
 * @param dir - profile 根目录
 * @throws Error - 路径存在但不是目录
 */
async function assertProfileDirectory(dir: string): Promise<void> {
  // stat 失败（目录不存在 / 权限不足）交给 readText：那里对 ENOENT 与其它错误的处理
  // 已经分好，这里再抛一次只会让同一个原因出现两种措辞。
  const info = await stat(dir).catch(() => null);
  if (info !== null && !info.isDirectory()) {
    throw new Error(`profile 不是目录：${dir}`);
  }
}

/**
 * 读一个 profile 目录。
 *
 * @param dir - profile 根目录（`<DSH_HOME>/profiles/<名>`）
 * @returns patch 文本、客户端版本、官方开关与 mcpToolLoading（缺省 eager）；文件缺失即空值
 */
export async function readProfileSnapshot(dir: string): Promise<ProfileSnapshot> {
  await assertProfileDirectory(dir);
  const [patchText, manifestText] = await Promise.all([
    readText(path.join(dir, "cordis.patch.yml")),
    readText(path.join(dir, "package.json")),
  ]);
  const client = clientManifestOf(manifestText);
  return {
    patchText,
    clientVersion: client.version,
    clientVersionBroken: client.broken,
    officialMcpEnabled: isSwitchOn(patchText),
    mcpToolLoading: toolLoadingOf(patchText),
  };
}

/** setup 写出去的那份文本落在数据目录的哪个文件里。 */
export function modePatchFile(mode: ProfileMode): string {
  return `${mode}.patch.yml`;
}

/**
 * `mcp` 模式要并入 profile 的那条 `dsh-mcp-client` 条目。
 *
 * URL 由 {@link mcpUrl} 拼，和 server 自己 listen 的那个串同一份常量。
 *
 * `failOnStartupError` 取 `false`：端口要等 sidecar 握手完成才 listen，而客户端在**第一趟**连接
 * 失败时（`SdkError: Version negotiation probe failed: connect ECONNREFUSED`）就会把这条 fiber 抛掉，
 * 宿主报的是「1 entry did not activate」。它自己的重连默认是开的（enabled、500ms 起、上限 10 次），
 * 所以第一趟失败本该由重连吸收；取 `true` 等于让装配顺序决定成败。官方 stdio 那条相反：
 * server 是客户端自己起的子进程，连不上就是真坏了，留 `true` 让它响亮地红。
 *
 * token 不进文本本体，只留一条读环境变量的 `!!js`，所以这份文件可以安全地躺在 profile 目录里。
 */
export function mcpClientPatch(options: {
  readonly port: number;
  readonly withAuth: boolean;
  /** 缺省保持旧调用方与旧 profile 的 eager 行为。 */
  readonly toolLoading?: McpToolLoading | undefined;
}): string {
  const lines = [
    "- insert:",
    `    - id: ${MCP_CLIENT_ENTRY_ID}`,
    `      name: '${MCP_CLIENT_PACKAGE}'`,
    "      config:",
    `        serverName: ${MCP_SERVER_NAME}`,
    `        transport: ${MCP_TRANSPORT_HTTP}`,
    `        url: ${mcpUrl(options.port, MCP_LISTEN_HOST)}`,
    "        failOnStartupError: false",
    `        toolLoading: ${options.toolLoading ?? DEFAULT_MCP_TOOL_LOADING}`,
  ];
  if (options.withAuth) {
    lines.push(
      "        headers:",
      `          Authorization: !!js '\`Bearer \${process.env.${MCP_TOKEN_ENV}}\`'`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `native` 模式的文本：一条都不给，两套工具并存正是要避免的那件事。 */
export function nativeModePatch(): string {
  return [
    "# integrationMode=native：profile 里不留 scrapling 的 MCP 条目。",
    "# 留着条目时模型会同时看到原生工具与 mcp__scrapling__* 两套同名不同层的工具。",
    `# 这份文本本身不删任何东西：profile 里若已有 name: '${MCP_CLIENT_PACKAGE}' 的条目，`,
    "# 要手工删掉它再重启宿主，否则 `doctor --mode native` 会按事实报 MCP_MODE_ENTRY_MISMATCH。",
    "",
  ].join("\n");
}
