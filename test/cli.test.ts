// lib/cli.ts —— 能力包 CLI 的参数编排（安装细节用替身）。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockPlatform } from "./managed-host.ts";
import { runCli } from "../lib/cli.ts";
import type { CliDeps } from "../lib/cli.ts";
import { InstallError } from "../lib/installer.ts";

const created: string[] = [];
const SETUP = "setup";
const DOCTOR = "doctor";
const STATUS = "--status";
const APPLY = "--apply";
const REPAIR = "--repair";
const FEATURE = "--feature";
const MODE = "--mode";
const UNINSTALL = "--uninstall";
const PURGE = "--purge";
const OFFLINE = "--offline";
const PROFILE = "--profile";
const PORT = "--port";
const DRY_RUN = "--dry-run";
const WITH_AUTH = "--with-auth";
const ACCEPT_RISK = "--accept-risk";
const CORE = "core";
const BROWSER = "browser";
const MCP = "mcp";
const CLIENT_KEY = "@deepseek-ai/dsh-mcp-client";
const OFFICIAL = "official-mcp";
const ENABLED_LINE = "        officialMcpEnabled: true\n";
const PLAIN_PATCH = "serverName: scrapling\n";
const PINNED_CLIENT = { [CLIENT_KEY]: "0.2.1-rc.3" };
const SERVER_LINE = "        serverName: scrapling";
const HTTP_LINE = "        transport: streamable-http";
const HTTP_URL_LINE = "        url: http://127.0.0.1:39217/mcp";
const STDIO_LINE = "        transport: stdio";

/** 一条与本插件模式一致的 streamable-http 条目，外加钉版客户端。 */
const CLEAN_MCP_ENTRY = [
  "- insert:",
  "    - id: scrapling-mcp",
  `      name: '${CLIENT_KEY}'`,
  "      config:",
  SERVER_LINE,
  HTTP_LINE,
  HTTP_URL_LINE,
  "        failOnStartupError: true",
  "",
].join("\n");

const SEARCH_ENTRY_ID = "- id: scrapling";

/** 把内置 web provider 指向本插件的那一段（`- id: web` 是宿主的 web 条目）。 */
const WEB_POINTS_HERE = ["- id: web", "  config:", "    searchProvider: scrapling", ""].join("\n");

/** 本插件自己的设置块：auto 后端 + 一枚 Tavily key。 */
const SEARCH_WITH_KEY = [
  SEARCH_ENTRY_ID,
  "  config:",
  "    searchBackend: auto",
  '    tavilyApiKey: "tvly-test"',
  "",
].join("\n");

/** 本插件自己的设置块：auto 后端、没有 key，公开回退也关着（机器的默认态）。 */
const SEARCH_WITHOUT_KEY = [
  SEARCH_ENTRY_ID,
  "  config:",
  "    searchBackend: auto",
  "    searchPublicFallback: false",
  "",
].join("\n");

/** 造一份「core 能力包已就绪」的 dataDir 现量：状态文件与解释器文件都要在。 */
function readyCoreData(dataDir: string): void {
  const bin = path.join(dataDir, "runtime", "venv", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "python3"), "#!/bin/sh\n");
  writeFileSync(
    path.join(dataDir, "runtime", "state.json"),
    JSON.stringify({ packs: { core: "ready" } }),
  );
}

/** 本插件条目与官方条目并存。 */
const TWO_ENTRIES = `${CLEAN_MCP_ENTRY}${[
  "- insert:",
  "    - id: scrapling-official-mcp",
  `      name: '${CLIENT_KEY}'`,
  "      config:",
  SERVER_LINE,
  STDIO_LINE,
  "        command: /tmp/x/bin/scrapling-mcp",
  "",
].join("\n")}`;

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-cli-"));
  created.push(dir);
  return dir;
}

/** 造一个真的 profile 目录：doctor 与 setup 都按文件读，不给自己留替身。 */
function profileDir(
  base: string,
  patchText: string,
  dependencies: Record<string, string> = {},
): string {
  const dir = mkdtempSync(path.join(base, "profile-"));
  created.push(dir);
  writeFileSync(path.join(dir, "cordis.patch.yml"), patchText, "utf8");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "sandbox-profile", dependencies }),
    "utf8",
  );
  return dir;
}

function harness(): { deps: Partial<CliDeps>; lines: string[]; calls: string[]; dataDir: string } {
  const lines: string[] = [];
  const calls: string[] = [];
  const dataDir = tempDir();
  return {
    lines,
    calls,
    dataDir,
    deps: {
      dataDir,
      repoRoot: tempDir(),
      log: (line) => {
        lines.push(line);
      },
      installPackFn: async (pack) => {
        calls.push(pack);
      },
      repairPackFn: async (pack) => {
        calls.push(`repair:${pack}`);
      },
      uninstallPackFn: async (pack, options) => {
        calls.push(options.purge ? `${pack}:purge` : pack);
      },
    },
  };
}

describe("runCli", () => {
  let restorePlatform: (() => void) | undefined;
  beforeAll(() => {
    restorePlatform = mockPlatform("darwin", "arm64");
  });
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    restorePlatform?.();
  });

  it("--status 只读状态，不安装", async () => {
    const { deps, lines, calls } = harness();
    await expect(runCli([SETUP, STATUS], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([]);
    expect(lines.join("\n")).toContain("runtime");
    expect(lines.join("\n")).toContain('"core": "missing"');
  });

  it("--feature core --apply 交给 installer 的包安装入口", async () => {
    const { deps, calls, lines } = harness();
    await expect(runCli([SETUP, FEATURE, CORE, APPLY], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([CORE]);
    expect(lines.join("\n")).toContain("installed core");
  });

  it("browser 包原样交给 installer", async () => {
    const { deps, calls } = harness();
    await expect(runCli([SETUP, FEATURE, BROWSER, APPLY], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([BROWSER]);
  });

  it("默认 dry-run 不落地", async () => {
    const { deps, calls, lines } = harness();
    await expect(runCli([SETUP, FEATURE, CORE], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([]);
    expect(lines.join("\n")).toContain("dry-run");
  });

  // --apply 只表示"允许落地"，--dry-run 表示"这一次仍然别落地"。两个一起给时后者胜：
  // 修复前这一条会调 installPackFn（真跑就是下载 ~327MB 并改写 runtime），所以判据要看
  // 安装入口有没有被调用 + dataDir 里有没有新东西，而不是只看退出码。
  it("--apply 与 --dry-run 同时给出时按 dry-run 走：不下载、也不写 runtime", async () => {
    const { deps, calls, lines, dataDir } = harness();
    await expect(runCli([SETUP, FEATURE, CORE, APPLY, DRY_RUN], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([]);
    expect(readdirSync(dataDir)).toStrictEqual([]);
    expect(lines.join("\n")).toContain("dry-run");

    // --repair 走的是另一个入口（repairPackFn），同一个门也得挡住它。
    const repaired = harness();
    await expect(
      runCli([SETUP, REPAIR, FEATURE, CORE, APPLY, DRY_RUN], repaired.deps),
    ).resolves.toBe(0);
    expect(repaired.calls).toStrictEqual([]);
    expect(readdirSync(repaired.dataDir)).toStrictEqual([]);
  });

  it("--repair 默认 dry-run，--apply 时交给 repair 入口", async () => {
    const { deps, calls, lines } = harness();
    await expect(runCli([SETUP, REPAIR, FEATURE, CORE], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([]);
    expect(lines.join("\n")).toContain("dry-run");
    await expect(runCli([SETUP, REPAIR, FEATURE, CORE, APPLY], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([`repair:${CORE}`]);
  });

  it("offline 走资产目录；adaptive-redis 与 mcp 都走安装入口", async () => {
    const packs = harness();
    await expect(runCli([SETUP, FEATURE, "adaptive-redis"], packs.deps)).resolves.toBe(0);
    expect(packs.lines.join("\n")).toContain("dry-run");
    const offline = harness();
    const assets = tempDir();
    const seen: boolean[] = [];
    const withAssets = {
      ...offline.deps,
      installPackFn: async (_pack: string, options: { assets?: string }) => {
        seen.push(options.assets === assets);
      },
    };
    await expect(runCli([SETUP, FEATURE, CORE, OFFLINE, assets, APPLY], withAssets)).resolves.toBe(
      0,
    );
    expect(seen).toStrictEqual([true]);
    const empty = harness();
    await expect(runCli([SETUP, FEATURE, CORE, OFFLINE, ""], empty.deps)).resolves.toBe(2);
    expect(empty.lines.join("\n")).toContain("资产目录");

    const promoted = harness();
    await expect(runCli([SETUP, FEATURE, MCP], promoted.deps)).resolves.toBe(0);
    expect(promoted.lines.join("\n")).toContain("dry-run");
    await expect(runCli([SETUP, FEATURE, MCP, APPLY], promoted.deps)).resolves.toBe(0);
    expect(promoted.calls).toStrictEqual([MCP]);
  });

  it("参数错误退 2", async () => {
    const { deps } = harness();
    await expect(runCli(["nope"], deps)).resolves.toBe(2);
    await expect(runCli([SETUP, FEATURE, "unknown"], deps)).resolves.toBe(2);
    await expect(runCli([SETUP, MODE, "x"], deps)).resolves.toBe(2);
    await expect(runCli([SETUP, CORE], deps)).resolves.toBe(2);
    await expect(runCli([SETUP, FEATURE], deps)).resolves.toBe(2);
    await expect(runCli([SETUP, FEATURE, APPLY], deps)).resolves.toBe(2);
    await expect(runCli([SETUP, UNINSTALL], deps)).resolves.toBe(2);
    await expect(runCli([SETUP, UNINSTALL, "unknown"], deps)).resolves.toBe(2);
  });

  it("--mode mcp 默认 dry-run：打印条目与安装命令，不写文件", async () => {
    const { deps, lines, dataDir } = harness();
    await expect(runCli([SETUP, MODE, MCP], deps)).resolves.toBe(0);
    const text = lines.join("\n");
    expect(text).toContain(HTTP_LINE);
    expect(text).toContain(HTTP_URL_LINE);
    expect(text).toContain(
      "dsh plugin --profile <profile> add @deepseek-ai/dsh-mcp-client@0.2.1-rc.3",
    );
    expect(text).toContain("dry-run");
    expect(existsSync(path.join(dataDir, "mcp"))).toBe(false);
  });

  it("--mode mcp --apply 写到数据目录下，profile 一个字都不碰", async () => {
    const { deps, lines, dataDir } = harness();
    await expect(runCli([SETUP, MODE, MCP, APPLY], deps)).resolves.toBe(0);
    const written = path.join(dataDir, "mcp", "mcp.patch.yml");
    expect(readFileSync(written, "utf8")).toContain(HTTP_LINE);
    expect(lines.join("\n")).toContain(written);
  });

  it("--port 与 --with-auth 跟着进条目文本", async () => {
    const ported = harness();
    await expect(runCli([SETUP, MODE, MCP, PORT, "45991"], ported.deps)).resolves.toBe(0);
    expect(ported.lines.join("\n")).toContain("        url: http://127.0.0.1:45991/mcp");

    const authed = harness();
    await expect(runCli([SETUP, MODE, MCP, WITH_AUTH], authed.deps)).resolves.toBe(0);
    expect(authed.lines.join("\n")).toContain(
      `          Authorization: !!js '\`Bearer \${process.env.DSH_SCRAPLING_MCP_TOKEN}\`'`,
    );
  });

  it("--dry-run 压过 --apply；端口不合法退 2", async () => {
    const { deps, dataDir } = harness();
    await expect(runCli([SETUP, MODE, MCP, APPLY, DRY_RUN], deps)).resolves.toBe(0);
    expect(existsSync(path.join(dataDir, "mcp"))).toBe(false);
    const bad = harness();
    await expect(runCli([SETUP, MODE, MCP, PORT, "abc"], bad.deps)).resolves.toBe(2);
    await expect(runCli([SETUP, MODE, MCP, PORT, "70000"], bad.deps)).resolves.toBe(2);
    await expect(runCli([SETUP, MODE, MCP, PORT, "0"], bad.deps)).resolves.toBe(2);
  });

  it("--mode native 不留条目", async () => {
    const { deps, lines, dataDir } = harness();
    await expect(runCli([SETUP, MODE, "native"], deps)).resolves.toBe(0);
    expect(lines.join("\n")).not.toContain("- insert:");
    await expect(runCli([SETUP, MODE, "native", APPLY], deps)).resolves.toBe(0);
    const written = path.join(dataDir, "mcp", "native.patch.yml");
    expect(readFileSync(written, "utf8")).not.toContain("- insert:");
  });

  it("official-mcp 要 profile 里开开关、命令行认风险，两样缺一退 1", async () => {
    const enabled = harness();
    const on = profileDir(enabled.dataDir, `${ENABLED_LINE}${SERVER_LINE}\n`);
    await expect(runCli([SETUP, MODE, OFFICIAL, PROFILE, on], enabled.deps)).resolves.toBe(1);
    expect(enabled.lines.join("\n")).toContain("RISK_NOT_ACCEPTED");

    const noSwitch = harness();
    const plain = profileDir(noSwitch.dataDir, PLAIN_PATCH);
    await expect(
      runCli([SETUP, MODE, OFFICIAL, ACCEPT_RISK, PROFILE, plain], noSwitch.deps),
    ).resolves.toBe(1);
    expect(noSwitch.lines.join("\n")).toContain("OFFICIAL_MCP_DISABLED");

    await expect(
      runCli([SETUP, MODE, OFFICIAL, ACCEPT_RISK, PROFILE, on], enabled.deps),
    ).resolves.toBe(0);
    expect(enabled.lines.join("\n")).toContain(STDIO_LINE);
    expect(enabled.lines.join("\n")).toContain("现在还不存在");
    expect(enabled.lines.join("\n")).toContain("setup --feature mcp --apply");
  });

  it("官方 server 已装在托管 venv 里时不再报缺二进制", async () => {
    const { deps, lines, dataDir } = harness();
    const bin = path.join(dataDir, "runtime", "venv", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "scrapling-mcp"), "#!/bin/sh\n", { mode: 0o755 });
    const profile = profileDir(dataDir, `${ENABLED_LINE}${SERVER_LINE}\n`);
    await expect(
      runCli([SETUP, MODE, OFFICIAL, ACCEPT_RISK, PROFILE, profile], deps),
    ).resolves.toBe(0);
    expect(lines.join("\n")).toContain(STDIO_LINE);
    expect(lines.join("\n")).not.toContain("现在还不存在");
  });

  it("doctor 缺 --profile 退 2；一致时退 0", async () => {
    const { deps } = harness();
    await expect(runCli([DOCTOR, MODE, MCP], deps)).resolves.toBe(2);
    await expect(runCli([DOCTOR], deps)).resolves.toBe(2);
    await expect(runCli([DOCTOR, MODE, "nope"], deps)).resolves.toBe(2);
    const ok = harness();
    await expect(
      runCli(
        [DOCTOR, MODE, MCP, PROFILE, profileDir(ok.dataDir, CLEAN_MCP_ENTRY, PINNED_CLIENT)],
        ok.deps,
      ),
    ).resolves.toBe(0);
    expect(ok.lines.join("\n")).toContain("一致");
  });

  it("doctor 拿 --port 比条目里的端口；端口写坏退 2", async () => {
    const { deps, lines, dataDir } = harness();
    const profile = profileDir(dataDir, CLEAN_MCP_ENTRY, PINNED_CLIENT);
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile, PORT, "45991"], deps)).resolves.toBe(
      1,
    );
    expect(lines.join("\n")).toContain("MCP_PORT_MISMATCH");
    const drift = harness();
    await expect(
      runCli([DOCTOR, MODE, MCP, PROFILE, profile, PORT, "abc"], drift.deps),
    ).resolves.toBe(2);
  });

  it("doctor 把冲突与未钉版都点名并退 1", async () => {
    const { deps, lines, dataDir } = harness();
    const profile = profileDir(dataDir, TWO_ENTRIES, {
      "@deepseek-ai/dsh-mcp-client": "0.0.1-rc.1",
    });
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("MCP_MODE_CONFLICT");
    expect(text).toContain("MCP_CLIENT_UNPINNED");
    expect(text).toContain("0.2.1-rc.3");
  });

  it("doctor 提示 searchProvider 没配，并把「后端缺失」说成预期行为", async () => {
    const { deps, lines, dataDir } = harness();
    const profile = profileDir(dataDir, CLEAN_MCP_ENTRY, PINNED_CLIENT);
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("SEARCH_PROVIDER_NOT_CONFIGURED");
    expect(text).toContain("searchProvider: scrapling");
    expect(text).toContain("SEARCH_BACKEND_MISSING");
    expect(text).toContain("预期行为");
    expect(text).toContain("一致");
  });

  it("doctor 在配了 tavilyApiKey 时不再报后端缺失", async () => {
    const { deps, lines, dataDir } = harness();
    const profile = profileDir(dataDir, `${CLEAN_MCP_ENTRY}${SEARCH_WITH_KEY}`, PINNED_CLIENT);
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(0);
    const text = lines.join("\n");
    expect(text).not.toContain("SEARCH_BACKEND_MISSING");
    // searchProvider 仍然没写，所以接管提示还在：它说的是另一件事，不该被 key 挡住。
    expect(text).toContain("SEARCH_PROVIDER_NOT_CONFIGURED");
  });

  it("searchProvider 指向本插件而后端没配时，doctor 退 1 并点名不能静默回退", async () => {
    const { deps, lines, dataDir } = harness();
    readyCoreData(dataDir);
    const profile = profileDir(
      dataDir,
      `${CLEAN_MCP_ENTRY}${WEB_POINTS_HERE}${SEARCH_WITHOUT_KEY}`,
      PINNED_CLIENT,
    );
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
    expect(text).toContain("searchPublicFallback");
    // 已经指名道姓指向本插件时，不再是「预期行为」那条提示，而是一条真配置错。
    expect(text).not.toContain("SEARCH_BACKEND_MISSING");
    expect(text).toContain("1 处不一致");
  });

  it("searchProvider 指向本插件而能力包没装好时，doctor 点名先装能力包", async () => {
    const { deps, lines, dataDir } = harness();
    const profile = profileDir(
      dataDir,
      `${CLEAN_MCP_ENTRY}${WEB_POINTS_HERE}${SEARCH_WITH_KEY}`,
      PINNED_CLIENT,
    );
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
    expect(text).toContain("setup --feature core --apply");
  });

  it("能力包与后端都就绪时 doctor 打绿", async () => {
    const { deps, lines, dataDir } = harness();
    readyCoreData(dataDir);
    const profile = profileDir(
      dataDir,
      `${CLEAN_MCP_ENTRY}${WEB_POINTS_HERE}${SEARCH_WITH_KEY}`,
      PINNED_CLIENT,
    );
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(0);
    expect(lines.join("\n")).toContain("一致");
  });

  it("显式指定后端却缺凭据时按 SEARCH_AUTH 退 1", async () => {
    const { deps, lines, dataDir } = harness();
    readyCoreData(dataDir);
    const patch = `${CLEAN_MCP_ENTRY}${WEB_POINTS_HERE}${[
      SEARCH_ENTRY_ID,
      "  config:",
      "    searchBackend: brave",
      "",
    ].join("\n")}`;
    const profile = profileDir(dataDir, patch, PINNED_CLIENT);
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("SEARCH_AUTH");
    expect(text).toContain("braveApiKey");
  });

  it("引号没闭合的标量不被当成 scrapling，doctor 仍按没指向本插件解释现状", async () => {
    const { deps, lines, dataDir } = harness();
    readyCoreData(dataDir);
    const patch = `${CLEAN_MCP_ENTRY}${[
      "- id: web",
      "  config:",
      '    searchProvider: "scrapling',
      "",
    ].join("\n")}`;
    const profile = profileDir(dataDir, patch, PINNED_CLIENT);
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(0);
    const text = lines.join("\n");
    // 没闭合的引号读不成 scrapling：不该判「已指向本插件却不可用」，仍按「没配」解释。
    expect(text).not.toContain("WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
    expect(text).toContain("SEARCH_BACKEND_MISSING");
  });

  it("显式后端缺凭据但没指向本插件时只提示 SEARCH_AUTH，不判红", async () => {
    const { deps, lines, dataDir } = harness();
    const patch = `${CLEAN_MCP_ENTRY}${[
      SEARCH_ENTRY_ID,
      "  config:",
      "    searchBackend: brave",
      "",
    ].join("\n")}`;
    const profile = profileDir(dataDir, patch, PINNED_CLIENT);
    await expect(runCli([DOCTOR, MODE, MCP, PROFILE, profile], deps)).resolves.toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("SEARCH_AUTH searchBackend=brave");
    expect(text).toContain("braveApiKey");
    expect(text).toContain("一致");
  });

  it("安装失败按 InstallError 的 code 报出并退 1", async () => {
    const { deps, lines } = harness();
    await expect(
      runCli([SETUP, FEATURE, CORE, APPLY], {
        ...deps,
        installPackFn: async () => {
          throw new InstallError("INSTALL_NETWORK", "no network");
        },
      }),
    ).resolves.toBe(1);
    expect(lines.join("\n")).toContain("INSTALL_NETWORK: no network");
  });

  it("未知错误也收口为退 1", async () => {
    const { deps, lines } = harness();
    await expect(
      runCli([SETUP, FEATURE, CORE, APPLY], {
        ...deps,
        installPackFn: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBe(1);
    expect(lines.join("\n")).toContain("command failed: Error: boom");
  });

  it("dataDir 默认读 DSH_SCRAPLING_DATA_DIR，并走默认输出口", async () => {
    const dir = tempDir();
    const previous = process.env["DSH_SCRAPLING_DATA_DIR"];
    process.env["DSH_SCRAPLING_DATA_DIR"] = dir;
    const lines: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      await expect(runCli([SETUP, STATUS])).resolves.toBe(0);
    } finally {
      info.mockRestore();
      if (previous === undefined) {
        delete process.env["DSH_SCRAPLING_DATA_DIR"];
      } else {
        process.env["DSH_SCRAPLING_DATA_DIR"] = previous;
      }
    }
    // 读字段而不是比子串：输出是 JSON，Windows 的路径反斜杠在 JSON 里是转义过的
    // （`C:\\Users\\…`），拿原始路径去 toContain 只在 POSIX 上成立。
    const parsed = JSON.parse(lines.join("\n")) as { dataDir?: string };
    expect(parsed.dataDir).toBe(dir);
  });

  it("空的 DSH_SCRAPLING_DATA_DIR 落回家目录", async () => {
    const previous = process.env["DSH_SCRAPLING_DATA_DIR"];
    process.env["DSH_SCRAPLING_DATA_DIR"] = "";
    const lines: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      await expect(runCli([SETUP, STATUS])).resolves.toBe(0);
    } finally {
      info.mockRestore();
      if (previous === undefined) {
        delete process.env["DSH_SCRAPLING_DATA_DIR"];
      } else {
        process.env["DSH_SCRAPLING_DATA_DIR"] = previous;
      }
    }
    expect(lines.length).toBeGreaterThan(0);
  });

  it("uninstall 把包与 purge 原样交给 installer", async () => {
    const { deps, lines } = harness();
    await expect(runCli([SETUP, UNINSTALL, CORE, PURGE, APPLY], deps)).resolves.toBe(0);
    expect(deps.uninstallPackFn).toBeTypeOf("function");
    expect(lines.join("\n")).toContain("uninstalled core (purged data)");

    const browser = harness();
    await expect(runCli([SETUP, UNINSTALL, BROWSER, APPLY], browser.deps)).resolves.toBe(0);
    expect(browser.lines.join("\n")).toContain("uninstalled browser");
  });

  it("uninstall 的假实现收到 purge 位", async () => {
    const { deps, calls } = harness();
    await expect(runCli([SETUP, UNINSTALL, CORE, PURGE, APPLY], deps)).resolves.toBe(0);
    await expect(runCli([SETUP, UNINSTALL, MCP, APPLY], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([`${CORE}:purge`, MCP]);
  });

  // 卸载与安装是同一类写动词：不带 --apply 时只能是计划，不能删文件。
  it("uninstall 默认只打印计划，一个文件都不动", async () => {
    const { deps, lines, calls, dataDir } = harness();
    await expect(runCli([SETUP, UNINSTALL, CORE], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([]);
    expect(lines.join("\n")).toContain("dry-run; add --apply to uninstall");
    // 计划行必须点名包与落点，否则「dry-run」三个字等于什么都没说。
    expect(lines.join("\n")).toContain(`uninstall core from ${path.join(dataDir, "runtime")}`);
  });

  it("--apply 与 --dry-run 同时给出时卸载也按 dry-run 走", async () => {
    const { deps, lines, calls } = harness();
    await expect(runCli([SETUP, UNINSTALL, CORE, APPLY, DRY_RUN], deps)).resolves.toBe(0);
    expect(calls).toStrictEqual([]);
    expect(lines.join("\n")).toContain("dry-run：--dry-run 压过 --apply");
  });

  it("安装锁被占时 uninstall 报 INSTALL_BUSY 且不调用卸载", async () => {
    const { deps, lines, calls, dataDir } = harness();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    // 活进程（就是本进程）持锁：与 install 同一把 runtime/install.lock。
    writeFileSync(
      path.join(dataDir, "runtime", "install.lock"),
      `${String(process.pid)} ${String(Date.now())}\n`,
    );
    await expect(runCli([SETUP, UNINSTALL, CORE, APPLY], deps)).resolves.toBe(1);
    expect(lines.join("\n")).toContain("INSTALL_BUSY");
    expect(calls).toStrictEqual([]);
  });
});
