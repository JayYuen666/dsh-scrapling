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
// 包名、钉版与默认端口的真源在 `lib/mcp-contract.ts`：这里再抄一份，契约换值时这些用例会
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

  // 宿主 --dump-config 打出来的是合成后的列表，name 在 2 格、config 键在 4 格；
  // 手工写条目的人也未必守 6/8 那一档。判据不该因为缩进换档就把真存在的条目说成没有。
  it("条目换个缩进层级也认得出来", () => {
    expect(codes(entryAt(2, 4, false), PINNED)).toStrictEqual([]);
    expect(codes(entryAt(0, 2, false), PINNED)).toStrictEqual([]);
  });

  // 合法 YAML 的标量写法不止一种：双引号、裸标量、行尾注释、行尾空格、列表项短横。
  // 只认「单引号 + 干净行尾」那一种，doctor 会把真存在的条目读成没有 —— 假红与漏报残留。
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
    // 否则 doctor 会把「不属于它的键」当成条目的事实，一条假绿就出来了。
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
    expect(snapshot.patchText).toContain("streamable-http");
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
  // doctor 会把一份真存在的条目读成「没有」——那是假红，用户会去改一份本来就对的配置。
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
   * 前面几种是宿主解析成 true 的写法，miss 了就是假红（叫用户去改一份本来生效的配置）；
   * 后面几种宿主解析成 false 或一个字符串，判成开启就是假绿——doctor 打绿而工具没接上更贵。
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

  it("profile 不存在或 package.json 不成形时按缺依赖处理", async () => {
    const missing = await readProfileSnapshot(
      path.join(os.tmpdir(), "definitely-not-a-profile-dir"),
    );
    expect(missing.clientVersion).toBeUndefined();
    expect(missing.patchText).toBe("");
    expect(missing.officialMcpEnabled).toBe(false);
    const broken = await readProfileSnapshot(profile("", "not json at all"));
    expect(broken.clientVersion).toBeUndefined();
    const scalar = await readProfileSnapshot(profile("", '"a string"'));
    expect(scalar.clientVersion).toBeUndefined();
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
