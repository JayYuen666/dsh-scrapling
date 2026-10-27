// lib/mcp-profile.ts —— 读 profile 自己写的 patch 文本并判模式一致性。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { DEFAULT_MCP_PORT, MCP_SERVER_NAME } from "../lib/mcp-contract.ts";
import type { ProfileMode } from "../lib/mcp-profile.ts";

const DATA_DIR = "/tmp/dsh-scrapling-data";
const CLIENT = "@deepseek-ai/dsh-mcp-client";
const PINNED = "0.2.1-rc.3";
const OFFICIAL = "official-mcp";

const SERVER_LINE = "serverName: scrapling";
const TRANSPORT_HTTP_LINE = "transport: streamable-http";
const URL_LINE = "url: http://127.0.0.1:39217/mcp";

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
    ...(wrapped ? ["- insert:", `    - id: scrapling-mcp`] : ["- id: scrapling-mcp"]),
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

/** 一条 stdio 条目：官方 scrapling-mcp。 */
function officialEntry(): string {
  return [
    "- insert:",
    "    - id: scrapling-official-mcp",
    `      name: '${CLIENT}'`,
    "      config:",
    `        ${SERVER_LINE}`,
    "        transport: stdio",
    `        command: ${officialMcpBinary(DATA_DIR)}`,
    "        args: []",
    "",
  ].join("\n");
}

/** 一条 streamable-http 条目，端口可变：用来判两条条目端口不一致。 */
function pluginEntry(port: number): string {
  return PLUGIN_ENTRY.replace("39217", String(port));
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
    expect(codes("", undefined)).toContain("MCP_CLIENT_MISSING");
    // 没装客户端也没条目时，"模式缺条目"是同一条事实的另一面，不算第二个问题。
    expect(codes("", undefined, "native")).toStrictEqual([]);
  });

  it("客户端取 latest 或旧 rc 时点名未钉版", () => {
    expect(codes(PLUGIN_ENTRY, "latest")).toContain("MCP_CLIENT_UNPINNED");
    expect(codes(PLUGIN_ENTRY, "0.0.1-rc.1")).toContain("MCP_CLIENT_UNPINNED");
  });

  it("同一个 serverName 出现两次就是冲突", () => {
    expect(codes(`${PLUGIN_ENTRY}${PLUGIN_ENTRY}`, PINNED)).toContain("DUPLICATE_SCRAPLING_ENTRY");
  });

  it("mcp 与 official-mcp 两种条目并存时报模式冲突", () => {
    expect(codes(`${PLUGIN_ENTRY}${officialEntry()}`, PINNED)).toContain("MCP_MODE_CONFLICT");
  });

  it("模式与条目不符：mcp 模式只有官方条目那一类", () => {
    expect(codes(officialEntry(), PINNED, "mcp")).toContain("MCP_MODE_ENTRY_MISMATCH");
  });

  it("official-mcp 模式只有本插件条目那一类", () => {
    expect(codes(PLUGIN_ENTRY, PINNED, OFFICIAL)).toContain("MCP_MODE_ENTRY_MISMATCH");
  });

  it("两条 streamable 条目端口不一致时点名", () => {
    const findings = inspectProfile({
      mode: "mcp",
      patchText: `${pluginEntry(39_217)}${pluginEntry(45_991)}`,
      clientVersion: PINNED,
      officialMcpEnabled: false,
    });
    const port = findings.find((finding) => finding.code === "MCP_PORT_MISMATCH");
    expect(port?.detail).toContain("45991");
    expect(port?.detail).toContain("39217");
  });

  it("条目端口与 --port 那一条不一致时点名；同值时不报", () => {
    const drift = inspectProfile({
      mode: "mcp",
      patchText: PLUGIN_ENTRY,
      clientVersion: PINNED,
      officialMcpEnabled: false,
      expectedPort: 45_991,
    });
    expect(drift.map((finding) => finding.code)).toStrictEqual(["MCP_PORT_MISMATCH"]);
    expect(drift[0]?.detail).toContain("45991");
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
        expectedPort: 45_991,
      }),
    ).toStrictEqual([]);
  });

  // 宿主 --dump-config 打出来的是合成后的列表，name 在 2 格、config 键在 4 格；
  // 手工写条目的人也未必守 6/8 那一档。判据不该因为缩进换档就把真存在的条目说成没有。
  it("条目换个缩进层级也认得出来", () => {
    expect(codes(entryAt(2, 4, false), PINNED)).toStrictEqual([]);
    expect(codes(entryAt(0, 2, false), PINNED)).toStrictEqual([]);
  });

  it("比 name 更浅的键不属于这一条目", () => {
    // 层级判据要真的在判：transport 写在比 name 更浅的一格，就不该被算进这条条目，
    // 否则 doctor 会把「不属于它的键」当成条目的事实，一条假绿就出来了。
    const shallow = [
      "- insert:",
      "    - id: scrapling-mcp",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "    transport: stdio",
      "      config:",
      `        ${SERVER_LINE}`,
      "",
    ].join("\n");
    expect(codes(shallow, PINNED, OFFICIAL)).toContain("MCP_MODE_ENTRY_MISMATCH");
    expect(codes(shallow, PINNED)).toStrictEqual([]);
  });

  it("officialMcpEnabled 关着却有官方条目时点名开关未开", () => {
    const findings = inspectProfile({
      mode: OFFICIAL,
      patchText: `${officialEntry()}${PLUGIN_ENTRY}`,
      clientVersion: PINNED,
      officialMcpEnabled: false,
    });
    expect(findings.map((finding) => finding.code)).toContain("MCP_OFFICIAL_SWITCH_OFF");
  });

  it("native 模式却留着 scrapling 条目也算不符", () => {
    expect(codes(PLUGIN_ENTRY, PINNED, "native")).toContain("MCP_MODE_ENTRY_MISMATCH");
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
  const SWITCH_CASES: readonly (readonly [string, string, boolean])[] = [
    ["裸 true", "        officialMcpEnabled: true\n", true],
    ["行尾注释", "        officialMcpEnabled: true # 已确认\n", true],
    ["CRLF 行尾", "        officialMcpEnabled: true\r\n", true],
    ["双引号标量", '        officialMcpEnabled: "true"\n', true],
    ["单引号标量", "        officialMcpEnabled: 'true'\n", true],
    ["YAML 的 TRUE 拼法", "        officialMcpEnabled: TRUE\n", true],
    ["false", "        officialMcpEnabled: false\n", false],
    ["yes 不是 YAML 1.2 布尔", "        officialMcpEnabled: yes\n", false],
    ["1 不是布尔", "        officialMcpEnabled: 1\n", false],
    ['字符串 "yes"', '        officialMcpEnabled: "yes"\n', false],
    ["无空白的 # 不是注释", "        officialMcpEnabled: true#x\n", false],
    ["整行被注释掉", "# officialMcpEnabled: true\n", false],
    ["看着像真的词", "        officialMcpEnabled: truthy\n", false],
    ["根本没有这一行", "serverName: scrapling\n", false],
  ];

  it.each(SWITCH_CASES)("officialMcpEnabled 判读：%s → %s", async (_name, line, expected) => {
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
