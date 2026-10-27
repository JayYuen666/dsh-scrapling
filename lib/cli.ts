// 能力包与 MCP 模式 CLI 的参数编排。安装细节仍只住在 lib/installer.ts，条目文本住在
// lib/mcp-profile.ts：这一层只认旗标、落笔与退出码。

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clientInstallCommand,
  DEFAULT_MCP_PORT,
  isMcpMode,
  MCP_CLIENT_PINS,
} from "./mcp-contract.ts";
import type { McpMode } from "./mcp-contract.ts";
import { officialMcpBinary, officialMcpPlan, OfficialMcpError } from "./official-mcp.ts";
import {
  inspectProfile,
  mcpClientPatch,
  modePatchFile,
  nativeModePatch,
  readProfileSnapshot,
} from "./mcp-profile.ts";
import type { InstallerIO } from "./installer.ts";
import {
  defaultInstallerIO,
  installCapabilityPack,
  InstallError,
  packStates,
  readRuntimeState,
  repairCapabilityPack,
  uninstallCapabilityPack,
  withInstallLock,
} from "./installer.ts";
import { resolveRuntime, runtimeManifest } from "./runtime.ts";

const FEATURES = ["core", "browser", "search", "media", "adaptive-redis", "mcp"] as const;
type Feature = (typeof FEATURES)[number];
const FEATURE_NAMES: ReadonlySet<string> = new Set(FEATURES);

const COMMANDS: ReadonlySet<string> = new Set(["setup", "doctor"]);

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "status",
  "apply",
  "repair",
  "purge",
  "dry-run",
  "with-auth",
  "accept-risk",
]);

export interface CliDeps {
  io: InstallerIO;
  dataDir: string;
  repoRoot: string;
  log: (line: string) => void;
  installPackFn: typeof installCapabilityPack;
  repairPackFn: typeof repairCapabilityPack;
  uninstallPackFn: typeof uninstallCapabilityPack;
}

type FlagMap = Map<string, string | true>;

function defaultDataDir(): string {
  const configured = process.env["DSH_SCRAPLING_DATA_DIR"];
  if (configured === undefined || configured === "") {
    return path.join(os.homedir(), ".dsh-scrapling");
  }
  return configured;
}

function isFeature(value: string): value is Feature {
  return FEATURE_NAMES.has(value);
}

function parseArgs(argv: readonly string[]): { command: string; flags: FlagMap } | null {
  const [command, ...rest] = argv;
  if (command === undefined || !COMMANDS.has(command)) {
    return null;
  }
  const flags: FlagMap = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    /* v8 ignore next 1 —— 循环条件保证 rest[index] 存在；`?? ""` 只为满足 noUncheckedIndexedAccess。 */
    const item = rest[index] ?? "";
    if (!item.startsWith("--")) {
      return null;
    }
    const name = item.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return null;
      }
      flags.set(name, value);
      index += 1;
    }
  }
  return { command, flags };
}

function withDefaults(overrides: Partial<CliDeps>): CliDeps {
  return {
    io: defaultInstallerIO,
    dataDir: defaultDataDir(),
    repoRoot: path.resolve(import.meta.dirname, ".."),
    log: (line) => {
      console.info(line);
    },
    installPackFn: installCapabilityPack,
    repairPackFn: repairCapabilityPack,
    uninstallPackFn: uninstallCapabilityPack,
    ...overrides,
  };
}

async function showStatus(deps: CliDeps): Promise<number> {
  const runtime = resolveRuntime({
    pythonBin: "",
    dataDir: deps.dataDir,
    repoRoot: deps.repoRoot,
  });
  const state = await readRuntimeState(deps.dataDir);
  const packs = await packStates(deps.dataDir);
  deps.log(JSON.stringify({ dataDir: deps.dataDir, runtime, packs, state }, null, 2));
  return 0;
}

function stringFlag(flags: FlagMap, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

interface PortFlag {
  /** 没给 `--port` 时是 undefined：setup 落回默认端口，doctor 据此决定比不比。 */
  readonly port?: number | undefined;
  readonly invalid: boolean;
}

/** `--port` 的取值；不合法交回 invalid 让调用方退 2，而不是悄悄回到默认端口。 */
function portFlag(flags: FlagMap): PortFlag {
  const value = stringFlag(flags, "port");
  if (value === undefined) {
    return { invalid: false };
  }
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? { port, invalid: false }
    : { invalid: true };
}

function modeValue(flags: FlagMap): McpMode | null {
  const value = stringFlag(flags, "mode");
  return value === undefined || !isMcpMode(value) ? null : value;
}

interface ModeOutput {
  readonly text: string;
  readonly note: string;
  readonly install: string;
}

/**
 * 一种模式对应的条目文本、这一次放弃了什么，以及要不要装客户端。
 *
 * `official-mcp` 那一支会抛 {@link OfficialMcpError}：开关与 `--accept-risk` 是同一次表态的两半，
 * 缺哪半都不该生成配置，退 1 由 runCli 的收口负责。
 */
function patchForMode(input: {
  readonly mode: McpMode;
  readonly port: number;
  readonly withAuth: boolean;
  readonly acceptRisk: boolean;
  readonly dataDir: string;
  readonly enabled: boolean;
}): ModeOutput {
  if (input.mode === "native") {
    return {
      text: nativeModePatch(),
      note: "native 模式不留 dsh-mcp-client 条目：原生工具已经在宿主名册里，再端一份就是两套。",
      install: "",
    };
  }
  if (input.mode === "mcp") {
    return {
      text: mcpClientPatch({ port: input.port, withAuth: input.withAuth }),
      note: `mcp 模式起的是本插件的 server，URL 里的端口要与部署项 mcpPort 同值（当前按 ${String(input.port)} 生成）。`,
      install: clientInstallCommand(),
    };
  }
  const plan = officialMcpPlan({
    dataDir: input.dataDir,
    enabled: input.enabled,
    acceptedRisk: input.acceptRisk,
  });
  return { text: plan.patch, note: plan.risk, install: plan.installCommand };
}

async function writePatch(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

/**
 * `setup --mode`：打印或写出条目文本，profile 本体一个字都不改。
 *
 * 宿主没有「安全写入 cordis.patch.yml」的 API（`--dump-config` 反而会把 profile 根配置重写一遍），
 * 所以 `--apply` 的落点是数据目录下一份可以自己并入的文件。
 */
async function setupMode(flags: FlagMap, deps: CliDeps): Promise<number> {
  const mode = modeValue(flags);
  if (mode === null) {
    return 2;
  }
  const given = portFlag(flags);
  if (given.invalid) {
    deps.log(`--port 要写 1 到 65535 之间的整数；现在给的是 ${String(stringFlag(flags, "port"))}`);
    return 2;
  }
  const port = given.port ?? DEFAULT_MCP_PORT;
  const profile = stringFlag(flags, "profile");
  const snapshot = profile === undefined ? undefined : await readProfileSnapshot(profile);
  const out = patchForMode({
    mode,
    port,
    withAuth: flags.has("with-auth"),
    acceptRisk: flags.has("accept-risk"),
    dataDir: deps.dataDir,
    enabled: snapshot?.officialMcpEnabled === true,
  });
  deps.log(out.text);
  deps.log(out.note);
  if (out.install !== "") {
    deps.log(`客户端没装就先跑：${out.install}`);
    deps.log(
      `只接受 ${MCP_CLIENT_PINS.join(" 或 ")}：npm 的 latest 比宿主线旧，宿主拒绝装载不匹配的对端。`,
    );
  }
  const target = path.join(deps.dataDir, "mcp", modePatchFile(mode));
  if (mode === "official-mcp") {
    const binary = officialMcpBinary(deps.dataDir);
    if (!existsSync(binary)) {
      deps.log(
        `${binary} 现在还不存在：先跑 setup --feature mcp --apply 把官方 server 装进托管 venv；` +
          "在那之前这条条目连不上（failOnStartupError: true 会让宿主把这条报成红）。",
      );
    }
  }
  if (!flags.has("apply") || flags.has("dry-run")) {
    deps.log(`dry-run; add --apply to write ${target}`);
    return 0;
  }
  await writePatch(target, out.text);
  deps.log(`wrote ${target}`);
  deps.log("profile 不会被这条命令改写：把这段并进 <profile>/cordis.patch.yml，再重启宿主。");
  return 0;
}

/** 剥掉行尾注释与成对引号。`#` 前面必须有空白才算注释（YAML 的规则），`true#x` 是值不是注释。 */
function bareScalar(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed.charAt(0);
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) {
      return trimmed.slice(1, end);
    }
  }
  return trimmed.replace(/[\t ]#.*$/u, "").trim();
}

/** 把 patch 文本里某个键第一次出现的标量取出来（整行注释跳过，行尾注释与引号由 bareScalar 剥掉）。 */
function patchScalar(text: string, key: string): string | undefined {
  const line = new RegExp(`^[\\t ]*(?:-[\\t ]+)?${key}:(?<value>[^\\r\\n]*)$`, "u");
  const raw = text
    .split(/\r\n|\n|\r/u)
    .filter((line_) => !line_.trimStart().startsWith("#"))
    .map((line_) => line.exec(line_)?.groups?.["value"])
    .find((value) => value !== undefined);
  return raw === undefined ? undefined : bareScalar(raw);
}

function hasPatchValue(text: string, key: string): boolean {
  const value = patchScalar(text, key);
  return value !== undefined && value !== "";
}

/** 只认 YAML 1.2 的三种布尔真值拼法：与 lib/mcp-profile.ts 的 isSwitchOn 同一条判据。 */
function patchFlag(text: string, key: string): boolean {
  const value = patchScalar(text, key);
  return value === "true" || value === "True" || value === "TRUE";
}

// lib/search-provider.ts 里的 SEARCH_PROVIDER_ID。这里写本地常量，免得 CLI 把 sidecar 依赖一起拖进来。
const SEARCH_PROVIDER_NAME = "scrapling";

/** 显式指定后端时它需要的凭据键：缺了就是把 SEARCH_AUTH 留给每一次查询。 */
const BACKEND_CREDENTIAL: Readonly<Record<string, string>> = {
  tavily: "tavilyApiKey",
  brave: "braveApiKey",
  serper: "serperApiKey",
  searxng: "searxngEndpoint",
};

interface SearchFinding {
  readonly code: string;
  readonly detail: string;
}

interface SearchDiagnostics {
  readonly hints: readonly string[];
  readonly findings: readonly SearchFinding[];
}

/**
 * 搜索侧的 doctor 判据（spec §6.4 / F7 / D9）：
 * - `searchProvider` 没写 → 内置 web_search 仍走宿主自己在 base 层选的 provider，插件只是备选，提示怎么接管。
 * - auto 后端没有任何发现路径且 `searchPublicFallback=false` → provider 不可用是**预期行为**，只提示不判红。
 * - 显式指定后端却缺凭据 → 每次查询都会 SEARCH_AUTH，按配置错判红。
 * - `searchProvider: scrapling` 而 provider 不可用 → web_search 会报 WEB_PROVIDER_CONFIGURED_UNAVAILABLE，判红并点名缺什么。
 */
function searchDiagnostics(patchText: string, coreReady: boolean): SearchDiagnostics {
  const provider = patchScalar(patchText, "searchProvider");
  const backend = patchScalar(patchText, "searchBackend") ?? "auto";
  const publicFallback = patchFlag(patchText, "searchPublicFallback");
  const hasTavily = hasPatchValue(patchText, "tavilyApiKey");
  const hasSearxng = hasPatchValue(patchText, "searxngEndpoint");
  const discoveryMissing = backend === "auto" && !hasTavily && !hasSearxng && !publicFallback;
  const credentialKey = backend === "auto" ? undefined : BACKEND_CREDENTIAL[backend];
  const credentialMissing = credentialKey !== undefined && !hasPatchValue(patchText, credentialKey);
  const pointedHere = provider === SEARCH_PROVIDER_NAME;
  const hints: string[] = [];
  const findings: SearchFinding[] = [];
  if (provider === undefined) {
    hints.push(
      "SEARCH_PROVIDER_NOT_CONFIGURED 部署配置里还没写 searchProvider: scrapling：内置 web_search 仍走宿主自己选的 provider（base 层默认 deepseek-official），本插件的 search provider 只是备选。要接管它，给 <profile>/cordis.patch.yml 里 - id: web 的 config 加一行 searchProvider: scrapling，再重启宿主。",
    );
  }
  if (discoveryMissing && !pointedHere) {
    hints.push(
      "SEARCH_BACKEND_MISSING 搜索后端未配置（预期行为）：searchBackend=auto 但没配 tavilyApiKey、也没设 searxngEndpoint，且 searchPublicFallback=false，所以本插件的 search provider 不可用。修复：配 tavilyApiKey、设 searxngEndpoint，或显式把 searchPublicFallback 设为 true（会把查询词发给公共引擎）。",
    );
  }
  if (credentialMissing && !pointedHere) {
    hints.push(
      `SEARCH_AUTH searchBackend=${backend} 但 ${credentialKey} 没配：查询会报 SEARCH_AUTH。修复：配 ${credentialKey}，或换一个后端。`,
    );
  }
  if (pointedHere && !coreReady) {
    findings.push({
      code: "WEB_PROVIDER_CONFIGURED_UNAVAILABLE",
      detail:
        "searchProvider 已指向 scrapling，但能力包没装好（core venv 不在 ready）：web_search 会报 WEB_PROVIDER_CONFIGURED_UNAVAILABLE。修复：dsh-scrapling setup --feature core --apply。",
    });
  }
  if (pointedHere && discoveryMissing) {
    findings.push({
      code: "WEB_PROVIDER_CONFIGURED_UNAVAILABLE",
      detail:
        "searchProvider 已指向 scrapling，但搜索后端不可用（没配 key/SearXNG，且 searchPublicFallback=false）：web_search 会报 WEB_PROVIDER_CONFIGURED_UNAVAILABLE。修复：配 tavilyApiKey、设 searxngEndpoint，或显式打开 searchPublicFallback。",
    });
  }
  if (pointedHere && credentialMissing) {
    findings.push({
      code: "SEARCH_AUTH",
      detail: `searchBackend=${backend} 但 ${credentialKey} 没配：provider 会注册成功，而每次查询都会报 SEARCH_AUTH。修复：配 ${credentialKey}，或换一个后端。`,
    });
  }
  return { hints, findings };
}

/** `doctor`：拿 profile 自己写下的文本判模式一致性，问题逐条点名。 */
async function runDoctor(flags: FlagMap, deps: CliDeps): Promise<number> {
  const mode = modeValue(flags);
  if (mode === null) {
    return 2;
  }
  const profile = stringFlag(flags, "profile");
  if (profile === undefined) {
    deps.log("doctor 要 --profile <目录>：判据来自那份 profile 自己写下的 cordis.patch.yml。");
    return 2;
  }
  const given = portFlag(flags);
  if (given.invalid) {
    deps.log(`--port 要写 1 到 65535 之间的整数；现在给的是 ${String(stringFlag(flags, "port"))}`);
    return 2;
  }
  const snapshot = await readProfileSnapshot(profile);
  const packs = await packStates(deps.dataDir);
  const findings = inspectProfile({ mode, expectedPort: given.port, ...snapshot });
  const search = searchDiagnostics(snapshot.patchText, packs.core === "ready");
  // 提示只解释现状（含「不可用是预期行为」），不改变退出码；真正的配置错进 findings 判红。
  for (const hint of search.hints) {
    deps.log(hint);
  }
  for (const finding of findings) {
    deps.log(`${finding.code} ${finding.detail}`);
  }
  for (const finding of search.findings) {
    deps.log(`${finding.code} ${finding.detail}`);
  }
  const total = findings.length + search.findings.length;
  if (total === 0) {
    deps.log(`${profile} 与 integrationMode=${mode} 一致。`);
    return 0;
  }
  deps.log(
    `${String(total)} 处不一致：改完重跑 setup --mode ${mode} --apply，并把条目并进 profile 后重启宿主。`,
  );
  return 1;
}

async function uninstallPack(flags: FlagMap, deps: CliDeps): Promise<number> {
  const value = flags.get("uninstall");
  if (typeof value !== "string" || !isFeature(value)) {
    return 2;
  }
  const purge = flags.has("purge");
  // 先打印计划再判门：与 setup 的写动词同一条纪律 —— 不带 --apply 时一个字节都不动。
  deps.log(
    `uninstall ${value}${purge ? " (and purge user data)" : ""} from ${path.join(deps.dataDir, "runtime")}`,
  );
  // 干跑判据与 installPack 同源：--apply 才允许落地，--dry-run 压过 --apply。
  if (!flags.has("apply") || flags.has("dry-run")) {
    deps.log(
      flags.has("dry-run")
        ? "dry-run：--dry-run 压过 --apply，只打印计划，不删任何 runtime 文件"
        : "dry-run; add --apply to uninstall",
    );
    return 0;
  }
  // 与安装同一把锁：卸载改的也是 venv / browsers / state.json，允许它与安装并发就是互相踩。
  await withInstallLock(deps.dataDir, async () => {
    await deps.uninstallPackFn(value, { dataDir: deps.dataDir, purge });
  });
  deps.log(`uninstalled ${value}${purge ? " (purged data)" : ""}`);
  return 0;
}

function installPlan(feature: Feature, deps: CliDeps): string {
  const asset = runtimeManifest.darwinArm64;
  return [
    `python ${asset.pythonVersion} (${asset.sizeBytes} bytes)`,
    feature === "browser" ? "full Chromium (~583M)" : "core wheels (~327M)",
    `into ${path.join(deps.dataDir, "runtime")}`,
  ].join("\n");
}

async function applyInstall(
  feature: Feature,
  deps: CliDeps,
  repair: boolean,
  offline: string | undefined,
): Promise<void> {
  const install = repair ? deps.repairPackFn : deps.installPackFn;
  await install(feature, {
    dataDir: deps.dataDir,
    repoRoot: deps.repoRoot,
    io: deps.io,
    onProgress: deps.log,
    ...(offline === undefined ? {} : { assets: offline }),
  });
}

async function installPack(flags: FlagMap, deps: CliDeps): Promise<number> {
  const value = flags.get("feature");
  if (typeof value !== "string" || !isFeature(value)) {
    return 2;
  }
  const offline = stringFlag(flags, "offline");
  if (flags.has("offline") && (offline === undefined || offline === "")) {
    deps.log("--offline 要给一个资产目录");
    return 2;
  }
  deps.log(installPlan(value, deps));
  if (offline !== undefined) {
    deps.log(`离线资产目录：${offline}`);
  }
  // 干跑判据与 setupMode 同源：--apply 是"允许落地"，--dry-run 是"仍然只打印"，
  // 两者同时出现时后者胜——否则 `setup --feature core --apply --dry-run` 会真下载
  // 几百 MB 并改写 runtime，而命令行上明写着 dry-run。
  if (!flags.has("apply") || flags.has("dry-run")) {
    deps.log(
      flags.has("dry-run")
        ? "dry-run：--dry-run 压过 --apply，只打印计划，不下载也不写 runtime"
        : "dry-run; add --apply to install",
    );
    return 0;
  }
  await applyInstall(value, deps, flags.has("repair"), offline);
  deps.log(`installed ${value}`);
  return 0;
}

function reportFailure(error: unknown, deps: CliDeps): number {
  deps.log(
    error instanceof InstallError || error instanceof OfficialMcpError
      ? `${error.code}: ${error.message}`
      : `command failed: ${String(error)}`,
  );
  return 1;
}

/**
 * 跑一次 CLI。
 *
 * @param argv - 不含 node 与脚本名的参数
 * @param overrides - 测试替换项
 * @returns 退出码：0 成功、1 失败、2 参数错误
 */
export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    return 2;
  }
  const deps = withDefaults(overrides);
  const { flags } = parsed;
  try {
    if (parsed.command === "doctor") {
      return await runDoctor(flags, deps);
    }
    if (flags.has("status")) {
      return await showStatus(deps);
    }
    if (flags.has("mode")) {
      return await setupMode(flags, deps);
    }
    if (flags.has("uninstall")) {
      return await uninstallPack(flags, deps);
    }
    return await installPack(flags, deps);
  } catch (error) {
    return reportFailure(error, deps);
  }
}
