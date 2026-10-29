// lib/mcp-profile.ts —— 生成与读回 profile 里的 MCP 条目文本，并判模式一致性。
//
// 射程只到 profile 自己写的那份 patch 文本：bundle 组合后的树不在这里读，因为 `dsh --dump-config`
// 会重写 profile 根配置，而 doctor 的判据必须来自「用户到底写了什么」。生成与解析放在一处，
// 是为了让 setup 写出的条目必然能被 doctor 读回——缩进改一笔，两边一起变。

import { readFile } from "node:fs/promises";
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
  MCP_TRANSPORT_HTTP,
  MCP_TRANSPORT_STDIO,
  mcpUrl,
} from "./mcp-contract.ts";
import type { McpMode } from "./mcp-contract.ts";

/** profile 文本的行分隔、URL 端口与版本行首引号。 */
const LINE_BREAK = /\r\n|\n|\r/u;
const URL_PORT = /:(?<port>\d+)/u;
const LEADING_QUOTE = /^['"]/u;

export type ProfileMode = McpMode;

export interface ProfileInspection {
  readonly mode: ProfileMode;
  /** profile 的 `cordis.patch.yml` 文本。 */
  readonly patchText: string;
  /** profile `package.json` 里 dsh-mcp-client 的那一条版本；没装就是 undefined。 */
  readonly clientVersion?: string | undefined;
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
  readonly config: Record<string, string>;
}

/**
 * 条目认「`name:` 之后、比它更缩进的那一段键值」，不认第几格。
 *
 * 同一份条目文本有三种合法缩进：profile 的 patch 写法（`name:` 6 格、config 键 8 格）、
 * 宿主 `--dump-config` 打出的合成列表（2 格 / 4 格），以及人手写的别的层级。写死格数的解析
 * 会在后两种里把真存在的条目读成「没有条目」，doctor 于是报一条假红。
 */
const ENTRY_NAME = /^name: '?(?<name>[^'\s]+)'?$/u;
const CONFIG_KEY = /^(?<key>[\w-]+): +(?<value>\S.*)$/u;

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
    const named = ENTRY_NAME.exec(body)?.groups;
    const keyed = CONFIG_KEY.exec(body)?.groups;
    if (named?.["name"] !== undefined) {
      current = { entry: { name: named["name"], config: {} }, indent };
      entries.push(current.entry);
    } else if (
      keyed?.["key"] !== undefined &&
      keyed["value"] !== undefined &&
      current !== undefined &&
      indent > current.indent
    ) {
      current.entry.config[keyed["key"]] = keyed["value"];
    }
  }
  return entries;
}

function portOf(entry: ProfileEntry): string | undefined {
  const { url } = entry.config;
  return url === undefined ? undefined : URL_PORT.exec(url)?.groups?.["port"];
}

function isOfficial(entry: ProfileEntry): boolean {
  return entry.config["transport"] === MCP_TRANSPORT_STDIO;
}

function clientFindings(input: ProfileInspection): McpFinding[] {
  const findings: McpFinding[] = [];
  if (input.mode !== "native" && input.clientVersion === undefined) {
    findings.push({
      code: "MCP_CLIENT_MISSING",
      detail: `profile 没有 ${MCP_CLIENT_PACKAGE}：跑 ${clientInstallCommand()} 装上它`,
    });
  }
  const pinned = input.clientVersion?.replace(LEADING_QUOTE, "");
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
        "留着官方 stdio 条目但 officialMcpEnabled=false：那 16 个工具不经本插件守卫，开关要明说",
    });
  }
  return findings;
}

function portFindings(scrapling: readonly ProfileEntry[], expectedPort?: number): McpFinding[] {
  const found = [
    ...new Set(scrapling.map((entry) => portOf(entry)).filter((port) => port !== undefined)),
  ];
  if (found.length === 0) {
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

/** profile 里与 MCP 有关的那三件事。 */
export interface ProfileSnapshot {
  readonly patchText: string;
  readonly clientVersion?: string | undefined;
  readonly officialMcpEnabled: boolean;
}

/**
 * `officialMcpEnabled` 那一行；值里可能带 YAML 注释与引号，行尾可能带 \r。
 *
 * 只认 YAML 1.2 的三种布尔真值拼法（`true` / `True` / `TRUE`）：`yes`、`1`、`truthy` 这类
 * 「看着像开」的写法和裸 `false` 一样都按未开启处理。把「未开启」判据放宽到任意非空值，会让宿主
 * 仍按 false 处理时 doctor 打绿——那比方红更贵。
 */
const SWITCH_LINE = /^[\t ]*officialMcpEnabled:(?<value>[^\r\n]*)$/mu;

/** YAML 里 `#` 只有前面是空白（或行首）时才开始注释；`true#x` 是一个字符串，不是布尔。 */
const TRAILING_COMMENT = /[\t ]#.*$/u;

const QUOTED_SCALAR = /^(?:"(?<double>[^"]*)"|'(?<single>[^']*)')$/u;

/** 取 `officialMcpEnabled` 的标量文本；同一份文本里出现多次时取第一条。 */
function switchScalar(text: string): string | undefined {
  const raw = SWITCH_LINE.exec(text)?.groups?.["value"];
  const value = raw?.replace(TRAILING_COMMENT, "").trim();
  const quoted = value === undefined ? undefined : QUOTED_SCALAR.exec(value)?.groups;
  return quoted?.["double"] ?? quoted?.["single"] ?? value;
}

function isSwitchOn(text: string): boolean {
  const value = switchScalar(text);
  return value === "true" || value === "True" || value === "TRUE";
}

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

/** 坏 JSON、空文本与非对象都归到 `{}`：让取值链自己落回 undefined，不必在调用点分叉。 */
function manifestOf(manifestText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(manifestText);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 读不到、不成形一律按「没装客户端」处理：doctor 宁可报缺，不要猜。 */
function clientVersionOf(manifestText: string): string | undefined {
  const { dependencies } = manifestOf(manifestText);
  const version = isRecord(dependencies) ? dependencies[MCP_CLIENT_PACKAGE] : undefined;
  return typeof version === "string" ? version : undefined;
}

/**
 * 读一个 profile 目录。
 *
 * @param dir - profile 根目录（`<DSH_HOME>/profiles/<名>`）
 * @returns patch 文本、客户端版本与官方开关；文件缺失即空值
 */
export async function readProfileSnapshot(dir: string): Promise<ProfileSnapshot> {
  const patchText = await readText(path.join(dir, "cordis.patch.yml"));
  const manifestText = await readText(path.join(dir, "package.json"));
  return {
    patchText,
    clientVersion: clientVersionOf(manifestText),
    officialMcpEnabled: isSwitchOn(patchText),
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
    "",
  ].join("\n");
}
