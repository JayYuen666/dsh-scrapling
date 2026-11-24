// lib/mcp-profile.ts —— 读 profile 自己写的 patch 文本并判模式一致性。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { officialMcpBinary, officialMcpPlan } from "../lib/official-mcp.ts";
import {
  inspectProfile,
  mcpClientPatch,
  modePatchFile,
  nativeModePatch,
  readProfileSnapshot,
} from "../lib/mcp-profile.ts";
import {
  DEFAULT_MCP_PORT,
  MCP_CLIENT_ENTRY_ID,
  MCP_CLIENT_PACKAGE,
  MCP_DEFAULT_CLIENT_PIN,
  MCP_LISTEN_HOST,
  MCP_PATH,
  MCP_SERVER_NAME,
  MCP_TRANSPORT_HTTP,
} from "../lib/mcp-contract.ts";
import type { ProfileMode } from "../lib/mcp-profile.ts";

// #378 的原点：写死 /tmp 在 Windows 上拼出一条既不存在也不合平台形态的 command 路径，
// 而本文件与 CI 的 windows-latest 格都覆盖 CRLF 那一类场景。
const DATA_DIR = path.join(os.tmpdir(), "dsh-scrapling-data");
// 包名、钉版与默认端口的唯一来源在 `lib/mcp-contract.ts`：这里再抄一份，契约换值时这些用例会
// 把「生成器改了」报成「解析器坏了」。
const CLIENT = MCP_CLIENT_PACKAGE;
const PINNED = MCP_DEFAULT_CLIENT_PIN;

describe("官方 MCP 入口：跟 venv 布局同源", () => {
  it("入口按平台选目录：POSIX 在 bin/scrapling-mcp，Windows 在 Scripts/scrapling-mcp.exe", () => {
    const venv = path.join(DATA_DIR, "runtime", "venv");
    const expected =
      process.platform === "win32"
        ? path.join(venv, "Scripts", "scrapling-mcp.exe")
        : path.join(venv, "bin", "scrapling-mcp");
    expect(officialMcpBinary(DATA_DIR)).toBe(expected);
  });

  it("win32 分支即使不在 Windows 上跑也要钉住（CI 的 darwin/linux 格覆盖不到它）", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(officialMcpBinary(DATA_DIR)).toBe(
        path.join(DATA_DIR, "runtime", "venv", "Scripts", "scrapling-mcp.exe"),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
const OFFICIAL: ProfileMode = "official-mcp";

const SERVER_LINE = `serverName: ${MCP_SERVER_NAME}`;
const ENTRY_ID_LINE = `- id: ${MCP_CLIENT_ENTRY_ID}`;
const TRANSPORT_HTTP_LINE = `transport: ${MCP_TRANSPORT_HTTP}`;
const URL_LINE = `url: http://${MCP_LISTEN_HOST}:${String(DEFAULT_MCP_PORT)}${MCP_PATH}`;
// 端口类判据用的「另一档」：漂移、不一致、ipv6 那些用例都拿它与默认档对比。
const OTHER_PORT = 45_991;
const OTHER_IPV6_URL_LINE = `url: http://[::1]:${String(OTHER_PORT)}${MCP_PATH}`;

/**
 * 一条 streamable-http 条目，按给定的缩进层级拼。
 *
 * profile 的 patch 写法是 name 6 格 / 键 8 格，宿主 --dump-config 打的是 2 格 / 4 格，
 * 三种写法都得被同一个解析读出来。
 */
function pad(width: number): string {
  return " ".repeat(width);
}

function entryAt(nameIndent: number, keyIndent: number, wrapped: boolean): string {
  return [
    ...(wrapped ? ["- insert:", `    ${ENTRY_ID_LINE}`] : [ENTRY_ID_LINE]),
    `${pad(nameIndent)}name: '${CLIENT}'`,
    `${pad(nameIndent)}config:`,
    `${pad(keyIndent)}${SERVER_LINE}`,
    `${pad(keyIndent)}${TRANSPORT_HTTP_LINE}`,
    `${pad(keyIndent)}${URL_LINE}`,
    "",
  ].join("\n");
}

/** 一条 streamable-http 条目：本插件自己的 MCP server（patch 写法）。 */
const PLUGIN_ENTRY = entryAt(6, 8, true);

/** stdio 条目的 transport 行（8 格缩进）：测试里要给它加行尾注释，抽成常量免得同一字面量写三遍。 */
const TRANSPORT_STDIO = "        transport: stdio";

/**
 * 一条 stdio 条目：官方 scrapling-mcp。
 *
 * 取 `officialMcpPlan` 真正生成的那份 patch，而不是在测试里复刻它的形状：手写那份会漏掉
 * `yamlScalar` 的双引号转义与 `failOnStartupError` 那一键，官方条目一旦改档，跑在这份文本上的
 * 判据（模式冲突、开关未开、端口不参与比对等）全都测不到真实输出。
 */
function officialEntry(): string {
  return officialMcpPlan({ dataDir: DATA_DIR, enabled: true, acceptedRisk: true }).patch;
}

/** 一条 streamable-http 条目，端口可变：用来判两条条目端口不一致。 */
function pluginEntry(port: number): string {
  const from = String(DEFAULT_MCP_PORT);
  const replaced = PLUGIN_ENTRY.replace(from, String(port));
  // 端口一旦改了档，`PLUGIN_ENTRY` 里就没有 `from` 那一串，replace 静默原样返回；
  // 于是「两条条目端口不一致」变成「两条完全相同」，红的是别的断言，看不出夹具坏了。
  if (port !== DEFAULT_MCP_PORT && replaced === PLUGIN_ENTRY) {
    throw new Error(`夹具没换掉端口 ${from}：条目文本里找不到它，说明 URL 行的派生断了`);
  }
  return replaced;
}

function codes(text: string, clientVersion?: string, mode: ProfileMode = "mcp"): string[] {
  return inspectProfile({
    mode,
    patchText: text,
    clientVersion,
    officialMcpEnabled: true,
  }).map((finding) => finding.code);
}

describe("inspectProfile", () => {
  it("干净的 mcp 条目加钉版客户端：一条问题都没有", () => {
    expect(codes(PLUGIN_ENTRY, PINNED)).toStrictEqual([]);
  });

  it("profile 里根本没有 dsh-mcp-client 时报缺依赖", () => {
    // 空 profile 在 mcp 模式下同时给出两条：客户端没装、也没有本插件的条目。这是两件各自可以
    // 补救的事（装客户端 / 补条目），所以两条都留；判序无关，比集合。
    expect(codes("", undefined).toSorted()).toStrictEqual([
      "MCP_CLIENT_MISSING",
      "MCP_MODE_ENTRY_MISMATCH",
    ]);
    // native 模式本来就不需要条目与客户端，空 profile 在那里一条问题都不该报。
    expect(codes("", undefined, "native")).toStrictEqual([]);
  });

  it("客户端取 latest 或旧 rc 时点名未钉版", () => {
    expect(codes(PLUGIN_ENTRY, "latest")).toStrictEqual(["MCP_CLIENT_UNPINNED"]);
    expect(codes(PLUGIN_ENTRY, "0.0.1-rc.1")).toStrictEqual(["MCP_CLIENT_UNPINNED"]);
  });

  it("同一个 serverName 出现两次就是冲突", () => {
    expect(codes(`${PLUGIN_ENTRY}${PLUGIN_ENTRY}`, PINNED)).toStrictEqual([
      "DUPLICATE_SCRAPLING_ENTRY",
    ]);
  });

  it("mcp 与 official-mcp 两种条目并存时报模式冲突", () => {
    // 两条条目的 serverName 同为 scrapling，所以「重复」与「模式冲突」是这次读出的两条事实；
    // 判序无关（findings 的拼接顺序是实现细节），比排序后的集合。
    expect(codes(`${PLUGIN_ENTRY}${officialEntry()}`, PINNED).toSorted()).toStrictEqual([
      "DUPLICATE_SCRAPLING_ENTRY",
      "MCP_MODE_CONFLICT",
    ]);
  });

  it("模式与条目不符：mcp 模式只有官方条目那一类", () => {
    expect(codes(officialEntry(), PINNED, "mcp")).toStrictEqual(["MCP_MODE_ENTRY_MISMATCH"]);
  });

  it("official-mcp 模式只有本插件条目那一类", () => {
    expect(codes(PLUGIN_ENTRY, PINNED, OFFICIAL)).toStrictEqual(["MCP_MODE_ENTRY_MISMATCH"]);
  });

  it("引号形式的标量同样识别（serverName / transport / url 带引号不改变语义）", () => {
    const quoted = [
      "- insert:",
      `    ${ENTRY_ID_LINE}`,
      `      name: '${CLIENT}'`,
      "      config:",
      '        serverName: "scrapling"',
      '        transport: "streamable-http"',
      `        ${URL_LINE.replaceAll(String.fromCodePoint(39), String.fromCodePoint(34))}`,
      "",
    ].join("\n");
    expect(codes(quoted, PINNED)).toStrictEqual([]);
  });

  it("ipv6 与省略端口的 URL 都按真实端口判，不取第一个冒号后的数字", () => {
    const ipv6 = PLUGIN_ENTRY.replace(URL_LINE, OTHER_IPV6_URL_LINE);
    const ipv6Same = inspectProfile({
      mode: "mcp",
      patchText: ipv6,
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: OTHER_PORT,
    });
    expect(ipv6Same.map((finding) => finding.code)).toStrictEqual([]);
    const defaultPort = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY.replace(URL_LINE, "url: http://127.0.0.1/mcp"),
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: 80,
    });
    expect(defaultPort.map((finding) => finding.code)).toStrictEqual([]);
    const httpsDefault = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY.replace(URL_LINE, "url: https://127.0.0.1/mcp"),
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: 443,
    });
    expect(httpsDefault.map((finding) => finding.code)).toStrictEqual([]);
    // 不是完整 URL 的手写值退回冒号匹配：`host:443/mcp` 仍读成 443。
    const legacy = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY.replace(URL_LINE, "url: 127.0.0.1:443/mcp"),
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: 443,
    });
    expect(legacy.map((finding) => finding.code)).toStrictEqual([]);
  });

  it("配置值只有注释时按未配置处理；非 http(s) URL 不猜默认端口", () => {
    const commented = PLUGIN_ENTRY.replace(TRANSPORT_HTTP_LINE, "transport: # 只有注释");
    expect(codes(commented, PINNED)).toStrictEqual([]);
    const ftp = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY.replace(URL_LINE, "url: ftp://127.0.0.1/mcp"),
      clientVersion: PINNED,
      officialMcpEnabled: false,
    });
    expect(ftp.map((finding) => finding.code)).toStrictEqual([]);
  });

  it("夹具用的另一档端口不能与默认档撞车", () => {
    // 撞车时「漂移」用例判的是同值不报，红话会指向解析逻辑而不是夹具。
    expect(OTHER_PORT).not.toBe(DEFAULT_MCP_PORT);
  });

  it("两条 streamable 条目端口不一致时点名", () => {
    const findings = inspectProfile({
      mode: "mcp",
      patchText: `${pluginEntry(DEFAULT_MCP_PORT)}${pluginEntry(OTHER_PORT)}`,
      clientVersion: PINNED,
      officialMcpEnabled: false,
    });
    const port = findings.find((finding) => finding.code === "MCP_PORT_MISMATCH");
    expect(port?.detail).toContain(String(OTHER_PORT));
    expect(port?.detail).toContain(String(DEFAULT_MCP_PORT));
  });

  it("条目端口与 --port 那一条不一致时点名；同值时不报", () => {
    const drift = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY,
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: OTHER_PORT,
    });
    expect(drift.map((finding) => finding.code)).toStrictEqual(["MCP_PORT_MISMATCH"]);
    expect(drift[0]?.detail).toContain(String(OTHER_PORT));
    const same = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY,
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: DEFAULT_MCP_PORT,
    });
    expect(same).toStrictEqual([]);
  });

  it("official-mcp 模式下端口比对不参与：那条条目里没有端口", () => {
    expect(
      inspectProfile({
        mode: OFFICIAL,
        patchText: officialEntry(),
        clientVersion: PINNED,
        officialMcpEnabled: true,
        expectedPort: OTHER_PORT,
      }),
    ).toStrictEqual([]);
  });

  /**
   * 给了 `--port`、条目也在，但 url 读不出端口：旧实现一条端口都收不到就 `return []`，
   * 于是「比对根本没发生」被打成一致。客户端连的是 patch 里写死的端口，而部署项可能早改了值。
   */
  it("给了 --port 但条目里读不出端口时点名，而不是当成一致", () => {
    // 拼一个 `${PORT}` 占位符：这正是 `!!js` 模板与手写占位符的写法，`new URL()` 读不出端口。
    // 美元号走 fromCodePoint：普通串里写 `${` 撞 no-template-curly-in-string，模板串里写又会插值。
    const placeholder = `${String.fromCodePoint(0x24)}{DSH_SCRAPLING_MCP_HTTP_PORT}`;
    const unreadable = PLUGIN_ENTRY.replace(URL_LINE, `url: ${placeholder}`);
    const findings = inspectProfile({
      mode: "mcp",
      patchText: unreadable,
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: OTHER_PORT,
    });
    expect(findings.map((finding) => finding.code)).toStrictEqual(["MCP_PORT_UNREADABLE"]);
    expect(findings[0]?.detail).toContain(String(OTHER_PORT));
    // 没给 --port 时无从比对，不该凭空报：这条判据只在「本该比对」时才说话。
    expect(
      inspectProfile({
        mode: "mcp",
        patchText: unreadable,
        clientVersion: PINNED,
        officialMcpEnabled: false,
      }).map((finding) => finding.code),
    ).toStrictEqual([]);
  });

  /**
   * 条目 config 里嵌着的 `name:`（`headers:` / `tools:` 下的子键）不是兄弟条目。
   *
   * 旧实现只凭「这一行匹配到 name:」就无条件开新条目，于是**后面的** serverName / transport /
   * url 全被算到那个伪条目名下（它们比伪条目的 indent 浅），真条目变成一条只有名字的空条目、
   * 被「serverName 为 scrapling」的过滤剔掉 —— doctor 报的是模式不匹配，与真因无关。
   */
  it("条目 config 里嵌着的 name 不起一条新条目", () => {
    const nested = [
      "- insert:",
      `    ${ENTRY_ID_LINE}`,
      `      name: '${CLIENT}'`,
      "      config:",
      "        tools:",
      "          name: nested-tool",
      `        ${SERVER_LINE}`,
      `        ${TRANSPORT_HTTP_LINE}`,
      `        ${URL_LINE}`,
      "",
    ].join("\n");
    // 真条目仍被读成一条：没有残留的模式误报，端口也读得出来（期望端口同值时无话可说）。
    expect(
      inspectProfile({
        mode: "mcp",
        patchText: nested,
        clientVersion: PINNED,
        officialMcpEnabled: false,
        expectedPort: DEFAULT_MCP_PORT,
      }),
    ).toStrictEqual([]);
    // 反过来说：把它读成两条时，端口判据会失去比对对象，这里显式钉住「能读出端口」。
    expect(
      inspectProfile({
        mode: "mcp",
        patchText: nested,
        clientVersion: PINNED,
        officialMcpEnabled: false,
        expectedPort: OTHER_PORT,
      }).map((finding) => finding.code),
    ).toStrictEqual(["MCP_PORT_MISMATCH"]);
  });

  // 宿主 --dump-config 打出来的是合成后的列表，name 在 2 格、config 键在 4 格；
  // 手工写条目的人也未必守 6/8 那一档。判据不该因为缩进换档就把真存在的条目说成没有。
  it("条目换个缩进层级也认得出来", () => {
    expect(codes(entryAt(2, 4, false), PINNED)).toStrictEqual([]);
    expect(codes(entryAt(0, 2, false), PINNED)).toStrictEqual([]);
  });

  // 合法 YAML 的标量写法不止一种：双引号、裸标量、行尾注释、行尾空格、列表项短横。
  // 只认「单引号 + 干净行尾」那一种，doctor 会把真存在的条目读成没有 —— 误报与漏报残留。
  const NAME_LINE_SINGLE = `      name: '${CLIENT}'`;

  it.each([
    ["双引号", NAME_LINE_SINGLE.replaceAll("'", String.fromCodePoint(34))],
    ["裸标量", `      name: ${CLIENT}`],
    ["行尾注释", `${NAME_LINE_SINGLE} # ours`],
    ["行尾空格", `${NAME_LINE_SINGLE}   `],
    ["列表项短横", `      - name: '${CLIENT}'`],
  ])("条目名写成%s时照样认得出来", (_label, nameLine) => {
    expect(codes(PLUGIN_ENTRY.replace(NAME_LINE_SINGLE, nameLine), PINNED)).toStrictEqual([]);
  });

  it("config 值的行尾注释不算值的一部分：stdio 条目带注释仍是官方条目", () => {
    const commented = officialEntry().replace(TRANSPORT_STDIO, `${TRANSPORT_STDIO} # official`);
    expect(codes(commented, PINNED, OFFICIAL)).toStrictEqual([]);
  });

  it("比 name 更浅的键不属于这一条目", () => {
    // 层级判据要真的在判：transport 写在比 name 更浅的一格，就不该被算进这条条目，
    // 否则 doctor 会把「不属于它的键」当成条目的事实，一条误判通过就出来了。
    const shallow = [
      "- insert:",
      `    ${ENTRY_ID_LINE}`,
      `      name: '${CLIENT}'`,
      "    transport: stdio",
      "      config:",
      `        ${SERVER_LINE}`,
      "",
    ].join("\n");
    expect(codes(shallow, PINNED, OFFICIAL)).toStrictEqual(["MCP_MODE_ENTRY_MISMATCH"]);
    expect(codes(shallow, PINNED)).toStrictEqual([]);
  });

  it("officialMcpEnabled 关着却有官方条目时点名开关未开", () => {
    const findings = inspectProfile({
      mode: OFFICIAL,
      patchText: `${officialEntry()}${PLUGIN_ENTRY}`,
      clientVersion: PINNED,
      officialMcpEnabled: false,
    });
    // 官方条目与本插件条目并存，开关又没开：除了「开关未开」，两种条目并存本身也要报。
    expect(findings.map((finding) => finding.code).toSorted()).toStrictEqual([
      "DUPLICATE_SCRAPLING_ENTRY",
      "MCP_MODE_CONFLICT",
      "MCP_OFFICIAL_SWITCH_OFF",
    ]);
  });

  it("native 模式却留着 scrapling 条目也算不符", () => {
    expect(codes(PLUGIN_ENTRY, PINNED, "native")).toStrictEqual(["MCP_MODE_ENTRY_MISMATCH"]);
  });
});

describe("readProfileSnapshot", () => {
  const roots: string[] = [];

  function profile(patch: string, manifest: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-profile-"));
    roots.push(dir);
    writeFileSync(path.join(dir, "cordis.patch.yml"), patch);
    writeFileSync(path.join(dir, "package.json"), manifest);
    return dir;
  }

  afterAll(() => {
    for (const dir of roots) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("读出条目文本、客户端版本与官方开关", async () => {
    const snapshot = await readProfileSnapshot(
      profile(
        `${PLUGIN_ENTRY}        officialMcpEnabled: true\n`,
        `{"dependencies":{"${CLIENT}":"${PINNED}"}}`,
      ),
    );
    expect(snapshot.clientVersion).toBe(PINNED);
    expect(snapshot.officialMcpEnabled).toBe(true);
    expect(snapshot.mcpToolLoading).toBe("eager");
    expect(snapshot.patchText).toContain("streamable-http");
  });

  it("旧 profile 缺 mcpToolLoading 时默认 eager", async () => {
    const snapshot = await readProfileSnapshot(profile(PLUGIN_ENTRY, "{}"));
    expect(snapshot.mcpToolLoading).toBe("eager");
  });

  it("profile 显式 mcpToolLoading: on-demand 时读回 on-demand", async () => {
    const snapshot = await readProfileSnapshot(
      profile(`${PLUGIN_ENTRY}        mcpToolLoading: on-demand\n`, "{}"),
    );
    expect(snapshot.mcpToolLoading).toBe("on-demand");
  });

  it("mcpToolLoading 写了非法值时拒绝读回，不静默回落 eager", async () => {
    await expect(
      readProfileSnapshot(profile(`${PLUGIN_ENTRY}        mcpToolLoading: lazy\n`, "{}")),
    ).rejects.toThrow(/mcpToolLoading/u);
  });

  it("文件缺失按「没有这份配置」读，其它读失败不压成空串", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-profile-empty-"));
    roots.push(dir);
    const missing = await readProfileSnapshot(dir);
    expect(missing.patchText).toBe("");
    expect(missing.clientVersion).toBeUndefined();

    // 同名目录占住了 cordis.patch.yml（EISDIR）：这不是「profile 里没写东西」。压成空串
    // 会让 doctor 在 native 模式下静默打绿、在其他模式下报一条与事实无关的模式不匹配。
    mkdirSync(path.join(dir, "cordis.patch.yml"));
    await expect(readProfileSnapshot(dir)).rejects.toThrow(/读不出/u);
  });

  it("profile 指向普通文件时点名「不是目录」，不按空 profile 静默通过", async () => {
    // Windows 对「文件\cordis.patch.yml」报 ENOENT（与「目录里没这份文件」同码），只判
    // readText 的返回值会把它读成空 profile；这条判据必须在两个平台给出同一个结论。
    const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-profile-file-"));
    roots.push(dir);
    const file = path.join(dir, "profile");
    writeFileSync(file, "");
    await expect(readProfileSnapshot(file)).rejects.toThrow(/profile 不是目录/u);
  });

  it("重复写 officialMcpEnabled 时按 YAML 的后者生效", async () => {
    const on = await readProfileSnapshot(
      profile("        officialMcpEnabled: false\n        officialMcpEnabled: true\n", "{}"),
    );
    expect(on.officialMcpEnabled).toBe(true);
    const off = await readProfileSnapshot(
      profile("        officialMcpEnabled: true\n        officialMcpEnabled: false\n", "{}"),
    );
    expect(off.officialMcpEnabled).toBe(false);
  });

  // Windows 上编辑器写出的 patch 是 CRLF。\r 若留在行尾，条目名与键值两侧的 $ 锚点全部落空，
  // doctor 会把一份真存在的条目读成「没有」——那是误报，用户会去改一份本来就对的配置。
  it("patch 用 CRLF 换行时也能读出条目，判据不因换行风格改口", async () => {
    const patch = `${PLUGIN_ENTRY}        officialMcpEnabled: true\n`.replaceAll("\n", "\r\n");
    const snapshot = await readProfileSnapshot(profile(patch, "{}"));
    expect(snapshot.officialMcpEnabled).toBe(true);
    expect(
      inspectProfile({
        mode: "mcp",
        patchText: snapshot.patchText,
        clientVersion: PINNED,
        officialMcpEnabled: true,
      }),
    ).toStrictEqual([]);
  });

  /**
   * 判据是「YAML 说它是不是布尔真值」，不是「这一行看着像不像开」。
   *
   * 前面几种是宿主解析成 true 的写法，miss 了就是误报（叫用户去改一份本来生效的配置）；
   * 后面几种宿主解析成 false 或一个字符串，判成开启就是误判通过——doctor 判定通过而工具没接上更贵。
   */
  const SWITCH_CASES: readonly (readonly [string, boolean, string])[] = [
    ["裸 true", true, "        officialMcpEnabled: true\n"],
    ["行尾注释", true, "        officialMcpEnabled: true # 已确认\n"],
    ["CRLF 行尾", true, "        officialMcpEnabled: true\r\n"],
    ["双引号标量", true, '        officialMcpEnabled: "true"\n'],
    ["单引号标量", true, "        officialMcpEnabled: 'true'\n"],
    ["YAML 的 TRUE 拼法", true, "        officialMcpEnabled: TRUE\n"],
    ["false", false, "        officialMcpEnabled: false\n"],
    ["yes 不是 YAML 1.2 布尔", false, "        officialMcpEnabled: yes\n"],
    ["1 不是布尔", false, "        officialMcpEnabled: 1\n"],
    ['字符串 "yes"', false, '        officialMcpEnabled: "yes"\n'],
    ["无空白的 # 不是注释", false, "        officialMcpEnabled: true#x\n"],
    ["整行被注释掉", false, "# officialMcpEnabled: true\n"],
    ["看着像真的词", false, "        officialMcpEnabled: truthy\n"],
    ["根本没有这一行", false, `${SERVER_LINE}\n`],
  ];

  it.each(SWITCH_CASES)("officialMcpEnabled 判读：%s → %s", async (_name, expected, line) => {
    const snapshot = await readProfileSnapshot(profile(line, "{}"));
    expect(snapshot.officialMcpEnabled).toBe(expected);
  });

  /**
   * 更深一档的同名键不是同一个键。
   *
   * 判据原先跨所有缩进层级取最后一条，于是插件 config（8 格）写着 true、某个子映射（12 格）里
   * 恰好也有一个同名键且是 false 时，doctor 会把开关判反。取首个命中的缩进作基准即可。
   */
  it("嵌套映射里的同名键不把开关判反", async () => {
    const snapshot = await readProfileSnapshot(
      profile(
        "        officialMcpEnabled: true\n        headers:\n          officialMcpEnabled: false\n",
        "{}",
      ),
    );
    expect(snapshot.officialMcpEnabled).toBe(true);
  });

  it("profile 不存在或 package.json 不成形时按缺依赖处理", async () => {
    const missing = await readProfileSnapshot(
      path.join(os.tmpdir(), "definitely-not-a-profile-dir"),
    );
    expect(missing.clientVersion).toBeUndefined();
    expect(missing.patchText).toBe("");
    expect(missing.officialMcpEnabled).toBe(false);
    // 文件不在 = 没装，那一位不亮。
    expect(missing.clientVersionBroken).toBe(false);
    const broken = await readProfileSnapshot(profile("", "not json at all"));
    expect(broken.clientVersion).toBeUndefined();
    const scalar = await readProfileSnapshot(profile("", '"a string"'));
    expect(scalar.clientVersion).toBeUndefined();
  });

  /**
   * 「这份 JSON 读不懂」与「这条依赖没装」是两件事，修法相反。
   *
   * 折成同一个信号时，doctor 在 package.json 被半截写入 / 留着合并冲突标记的机器上也会说
   * 「跑 dsh plugin add 装上它」—— 用户去装一个其实已经声明的依赖，而真正要修的是那份文件。
   */
  it("package.json 读不懂时报的是文件坏了，不是客户端没装", async () => {
    const broken = await readProfileSnapshot(profile("", "{半截"));
    expect(broken.clientVersionBroken).toBe(true);

    const findings = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY,
      clientVersion: broken.clientVersion,
      clientVersionBroken: broken.clientVersionBroken,
      officialMcpEnabled: false,
    });
    // 只有这一条：再叠一条 MCP_CLIENT_MISSING 会把用户支去装那个已经声明的依赖。
    expect(findings.map((finding) => finding.code)).toStrictEqual(["MCP_CLIENT_MANIFEST_BROKEN"]);
    expect(findings[0]?.detail).toContain("不是「没装客户端」");
  });

  it("package.json 顶层不是对象时同样算读不懂", async () => {
    const scalar = await readProfileSnapshot(profile("", '"a string"'));
    expect(scalar.clientVersionBroken).toBe(true);
    const array = await readProfileSnapshot(profile("", "[]"));
    expect(array.clientVersionBroken).toBe(true);
  });

  it("空文本是「没装」而不是「读不懂」", async () => {
    const empty = await readProfileSnapshot(profile("", ""));
    expect(empty.clientVersionBroken).toBe(false);
    expect(
      inspectProfile({
        mode: "mcp",
        patchText: PLUGIN_ENTRY,
        clientVersion: empty.clientVersion,
        clientVersionBroken: empty.clientVersionBroken,
        officialMcpEnabled: false,
      }).map((finding) => finding.code),
    ).toStrictEqual(["MCP_CLIENT_MISSING"]);
  });
});

/**
 * setup 写出去的文本必须能被 doctor 读回一致：两边的缩进与字段名同源，否则「setup 跑完
 * 紧接着 doctor 报红」这种自相矛盾会留在用户身上，而要等到下一次人工读才发现。
 */
describe("生成的条目文本", () => {
  it("mcp 条目读回自己：一条问题都不报", () => {
    const patch = mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: false });
    expect(
      inspectProfile({
        mode: "mcp",
        patchText: patch,
        clientVersion: PINNED,
        officialMcpEnabled: false,
      }),
    ).toStrictEqual([]);
  });

  it("streamable-http 条目用 failOnStartupError: false", () => {
    // 端口要等 sidecar 握手完才 listen，而客户端的连接闸门在第一趟失败就抛；
    // 宿主给的失败形态是「1 entry did not activate」（沙箱实测），不是静默少工具。
    expect(mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: false })).toContain(
      "        failOnStartupError: false",
    );
    expect(mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: false })).not.toContain(
      "failOnStartupError: true",
    );
  });

  it.each(["eager", "on-demand"] as const)("mcp 条目携带 toolLoading=%s", (toolLoading) => {
    expect(mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: false, toolLoading })).toContain(
      `        toolLoading: ${toolLoading}`,
    );
  });

  it("mcp 条目缺省携带 toolLoading: eager，保持旧调用方兼容", () => {
    expect(mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: false })).toContain(
      "        toolLoading: eager",
    );
  });

  it("URL 用独立的字面量钉住，端口改了它跟着改", () => {
    expect(mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: false })).toContain(
      "        url: http://127.0.0.1:39217/mcp",
    );
    expect(mcpClientPatch({ port: 45_991, withAuth: false })).toContain(
      "        url: http://127.0.0.1:45991/mcp",
    );
  });

  it("带 token 时只写读环境变量的表达式，文本里没有 token 值", () => {
    const patch = mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: true });
    expect(patch).toContain(
      `          Authorization: !!js '\`Bearer \${process.env.DSH_SCRAPLING_MCP_TOKEN}\`'`,
    );
    expect(mcpClientPatch({ port: DEFAULT_MCP_PORT, withAuth: false })).not.toContain("headers");
  });

  it("官方条目读回 official-mcp 模式：一条问题都不报", () => {
    const plan = officialMcpPlan({
      dataDir: DATA_DIR,
      enabled: true,
      acceptedRisk: true,
    });
    expect(
      inspectProfile({
        mode: OFFICIAL,
        patchText: plan.patch,
        clientVersion: PINNED,
        officialMcpEnabled: true,
      }),
    ).toStrictEqual([]);
    expect(plan.serverName).toBe(MCP_SERVER_NAME);
    expect(plan.patch).toContain("        toolLoading: eager");
  });

  it.each(["eager", "on-demand"] as const)("官方条目携带 toolLoading=%s", (toolLoading) => {
    const plan = officialMcpPlan({
      dataDir: DATA_DIR,
      enabled: true,
      acceptedRisk: true,
      toolLoading,
    });
    expect(plan.patch).toContain(`        toolLoading: ${toolLoading}`);
  });

  it("native 文本不含条目，读回 native 模式一条问题都不报", () => {
    const patch = nativeModePatch();
    expect(patch).not.toContain("- insert:");
    expect(
      inspectProfile({
        mode: "native",
        patchText: patch,
        clientVersion: undefined,
        officialMcpEnabled: false,
      }),
    ).toStrictEqual([]);
  });

  it("每种模式一个 patch 文件名", () => {
    expect(modePatchFile("native")).toBe("native.patch.yml");
    expect(modePatchFile("mcp")).toBe("mcp.patch.yml");
    expect(modePatchFile(OFFICIAL)).toBe("official-mcp.patch.yml");
  });
});
