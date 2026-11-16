// 能力包与 MCP 模式 CLI 的参数编排。安装细节仍只定义在 lib/installer.ts，条目文本定义在
// lib/mcp-profile.ts：这一层只认旗标、落笔与退出码。

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clientInstallCommand,
  DEFAULT_MCP_PORT,
  isMcpMode,
  MCP_MODES,
  MCP_CLIENT_PINS,
  MCP_TOKEN_ENV,
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
import { SEARCH_BACKENDS, isSearchBackend } from "./search-backends.ts";
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
import type { PackState } from "./runtime-shape.ts";

/** patch 文本的行分隔与行尾注释。 */
const LINE_BREAK = /\r\n|\n|\r/u;
const TRAILING_INLINE_COMMENT = /[\t ]#.*$/u;

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

/** 取值旗标：拼错的 `--ofline /assets` 不能被当成一个取值旗标静默吞掉后面的参数。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "port",
  "mode",
  "profile",
  "offline",
  "uninstall",
  "feature",
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
  // 归一成绝对路径再交下去：这一位最后会拼成写进 cordis.patch.yml 的 `command:`，
  // 相对路径是按**宿主进程**的 cwd 解析的，于是 setup 打印的那条与宿主实际起的
  // 那条不是同一个文件，而失败要等到宿主启动那次才现形。
  return path.resolve(configured);
}

function isFeature(value: string): value is Feature {
  return FEATURE_NAMES.has(value);
}

/** 一个命令行 token 的归类结果：布尔旗标、取值旗标（已带值），或不可接受。 */
type FlagToken =
  | { readonly kind: "boolean"; readonly name: string }
  | { readonly kind: "value"; readonly name: string; readonly value: string }
  | { readonly kind: "invalid" };

/**
 * 判一个 token 是哪一类旗标。
 *
 * 未知旗标一律判不可接受：把它当取值旗标吞掉下一项，拼错的 `--offline` 会让离线安装
 * 静默退化成在线安装，命令还照常往下跑。
 * @param token - 形如 `--name` 的一项
 * @param next - 紧跟其后的那一项（取值旗标的值），末尾时为 undefined
 * @returns 归类结果
 */
function classifyFlag(token: string, next: string | undefined): FlagToken {
  if (!token.startsWith("--")) {
    return { kind: "invalid" };
  }
  const name = token.slice(2);
  if (BOOLEAN_FLAGS.has(name)) {
    return { kind: "boolean", name };
  }
  if (!VALUE_FLAGS.has(name)) {
    return { kind: "invalid" };
  }
  if (next === undefined || next.startsWith("--")) {
    return { kind: "invalid" };
  }
  return { kind: "value", name, value: next };
}

function parseArgs(argv: readonly string[]): { command: string; flags: FlagMap } | null {
  const [command, ...rest] = argv;
  if (command === undefined || !COMMANDS.has(command)) {
    return null;
  }
  const flags: FlagMap = new Map();
  // 用 entries() 而不是下标取值：`noUncheckedIndexedAccess` 让 `rest[index]` 带 undefined，
  // 而下标循环又要自己跳过被取值旗标消费掉的那一项 —— 两头凑齐就会多出一条构造上到不了的
  // 分支，只能靠豁免过覆盖率。改成标记「已消费的下标」，元素类型就是 string，
  // 既不需要兜底值也不需要抑制注释。
  const consumed = new Set<number>();
  for (const [index, item] of rest.entries()) {
    if (!consumed.has(index)) {
      const token = classifyFlag(item, rest[index + 1]);
      if (token.kind === "invalid") {
        return null;
      }
      flags.set(token.name, token.kind === "value" ? token.value : true);
      if (token.kind === "value") {
        consumed.add(index + 1);
      }
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

/**
 * 某个取值旗标不合法时的提示：点名合法取值，并如实打出当前给的是什么。
 *
 * `--mode` / `--feature` / `--uninstall` 三处共用：它们都只能写名单里那几个取值，
 * 各自手写一份文案会在加值或改名时漂移，而用户看到的正好是这一行。
 *
 * @param flag - 旗标名（不带前导 `--`）
 * @param allowed - 合法取值
 * @param value - 本次命令行给的原始项
 * @returns 一行可照抄的提示
 */
function choiceHint(
  flag: string,
  allowed: readonly string[],
  value: string | true | undefined,
): string {
  const given = typeof value === "string" ? JSON.stringify(value) : "（缺省）";
  return `--${flag} 要写 ${allowed.join(" / ")} 之一；现在给的是 ${given}`;
}

/** `--mode` 取不到合法值时点名合法取值；与 pin 那条提示同一种做法。 */
function modeHint(flags: FlagMap): string {
  return choiceHint("mode", MCP_MODES, flags.get("mode"));
}

/** `--feature` / `--uninstall` 取不到合法值时点名六个能力包（不再静默退 2）。 */
function featureHint(flag: string, flags: FlagMap): string {
  return choiceHint(flag, FEATURES, flags.get(flag));
}

/**
 * 这次是否允许真的落地。
 *
 * `--apply` 是「允许写」，`--dry-run` 是「这一次仍然只打印」，两者同时出现时后者胜
 * —— 否则 `setup --feature core --apply --dry-run` 会真下载几百 MB 并改写 runtime，
 * 而命令行上明写着 dry-run。
 */
function shouldApply(flags: FlagMap): boolean {
  return flags.has("apply") && !flags.has("dry-run");
}

/**
 * 干跑时那一句提示（三处写动词共用）。
 *
 * 提示**必须按本次实际给的旗标分叉**：`--apply` 与 `--dry-run` 同时给出时还说
 * 「add --apply」，用户照做之后仍然什么都没写 —— 命令在骗人。原先 setup / install /
 * uninstall 三处各写一遍三分支，其中一处（setup）漏了「压过」这一支。
 *
 * @param flags - 本次旗标
 * @param wording - 两个分支的措辞：`suppressed` 用于真给了 --apply、`missingApply` 用于确实缺 --apply
 * @returns 一行提示
 */
function dryRunNotice(
  flags: FlagMap,
  wording: { readonly suppressed: string; readonly missingApply: string },
): string {
  return flags.has("dry-run") && flags.has("apply")
    ? `dry-run：--dry-run 压过 --apply，${wording.suppressed}`
    : wording.missingApply;
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
 * 缺哪半都不该生成配置，退 1 由 runCli 的统一处理负责。
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
    const authNote = input.withAuth
      ? `Authorization 在宿主装载时从宿主进程环境的 ${MCP_TOKEN_ENV} 求值：变量缺席会写成 "Bearer undefined"，加鉴权前先确认宿主环境里已设置它。`
      : "";
    return {
      text: mcpClientPatch({ port: input.port, withAuth: input.withAuth }),
      note: `mcp 模式起的是本插件的 server，URL 里的端口要与部署项 mcpPort 同值（当前按 ${String(input.port)} 生成）。${authNote}`,
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
 * 所以 `--apply` 的位置是数据目录下一份可以自己并入的文件。
 */
async function setupMode(flags: FlagMap, deps: CliDeps): Promise<number> {
  const mode = modeValue(flags);
  if (mode === null) {
    deps.log(modeHint(flags));
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
  if (!shouldApply(flags)) {
    deps.log(
      dryRunNotice(flags, {
        suppressed: `只打印条目，不写 ${target}`,
        missingApply: `dry-run; add --apply to write ${target}`,
      }),
    );
    return 0;
  }
  await writePatch(target, out.text);
  deps.log(`wrote ${target}`);
  deps.log("profile 不会被这条命令改写：把这段并进 <profile>/cordis.patch.yml，再重启宿主。");
  return 0;
}

/**
 * 把一段字面量转成能安全拼进正则的形式。
 *
 * 只服务 {@link patchScalar}：键名在那里的用法是「整段字面量」，不是模式。
 *
 * @param text - 任意字面量
 * @returns 转义后的字面量
 */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** 去掉行尾注释与成对引号。`#` 前面必须有空白才算注释（YAML 的规则），`true#x` 是值不是注释。 */
function bareScalar(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed.charAt(0);
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) {
      return trimmed.slice(1, end);
    }
  }
  return trimmed.replace(TRAILING_INLINE_COMMENT, "").trim();
}

/**
 * 取 patch 文本里某个键**最后一条有值**的标量（整行注释跳过，行尾注释与引号由 bareScalar 去掉）。
 * 只写了键名没给值的那些出现被跳过，所以返回值为 `undefined` 就等于「这份 patch 没配这一项」。
 *
 * **取最后一条而不是第一条**：YAML 的重复键按「后者生效」解析，宿主读到的就是那一条。
 * profile 的 `cordis.patch.yml` 聚合了多层 patch，同一个键可能被写过好几次（本仓 `setup --mode`
 * 的示例、用户手改、market 的 force-enable 各落一次），取第一条会让 doctor 的判据与宿主
 * 实际行为相反 —— 前 `false` 后 `true` 时 doctor 说没开，而宿主已经把工具端出去了。
 * 同文件 `switchScalar`（lib/mcp-profile.ts）早就按这条走的。
 *
 * 「跳过空值」与「取最后一条」不冲突：空 `pythonBin:` 是「这层没给值」，它盖不掉别层的真值；
 * 但两处都给了真值时，后落的那处才是宿主读到的。
 */
function patchScalar(text: string, key: string): string | undefined {
  // 键要转义再拼进正则：现调用点传的都是字面量键，但签名看起来接受任意键 ——
  // 一旦传进含 `.` / `+` / `(` 的键，`patchScalar` 会静默换成另一种匹配语义（`.` 能匹配任何字符），
  // 判据从此对不上的行也照绿。
  const pattern = new RegExp(
    `^[\\t ]*(?:-[\\t ]+)?${escapeRegExp(key)}:(?<value>[^\\r\\n]*)$`,
    "u",
  );
  const values = text
    .split(LINE_BREAK)
    .filter((raw) => !raw.trimStart().startsWith("#"))
    .map((raw) => bareScalar(pattern.exec(raw)?.groups?.["value"] ?? ""))
    .filter((value) => value !== "");
  return values.at(-1);
}

function hasPatchValue(text: string, key: string): boolean {
  return patchScalar(text, key) !== undefined;
}

/** 只认 YAML 1.2 的三种布尔真值拼法：与 lib/mcp-profile.ts 的 isSwitchOn 同一条判据。 */
function patchFlag(text: string, key: string): boolean {
  const value = patchScalar(text, key);
  return value === "true" || value === "True" || value === "TRUE";
}

/** `--status` 里 profile 那一段：没给 `--profile` 时是 `null` 路径加一句为什么没读。 */
interface StatusProfile {
  readonly path: string | null;
  readonly pythonBin: string | null;
  readonly dataDir: string | null;
  readonly note?: string;
}

const NO_PROFILE_NOTE =
  "未读 profile：runtime 只按 CLI 自身的解析链（pythonBin 配置 → 托管 venv → 裸托管解释器 → 仓内 _env/.venv → PATH python3）；" +
  "要看部署配置解析出的解释器就加 --profile <目录>";

const NO_PYTHON_BIN_NOTE =
  "profile 里没有 scrapling 的 pythonBin：runtime 回落到 CLI 自身的解析链（托管 venv → 裸托管解释器 → 仓内 _env/.venv → PATH python3）";

/**
 * profile 里那两位路径位写成相对路径时的提示。
 *
 * 宿主按**自己的 cwd** 展开（`resolveDataDir` 的 `path.resolve`），CLI 的 cwd 不是同一个，
 * 所以相对路径在两边会落到不同目录。CLI 读不到宿主的 cwd，只能按自己的展开一次并如实说明，
 * 而不是让用户拿着一个量错目录的 `--status` 去排障。
 */
const RELATIVE_PATH_NOTE =
  "profile 里的 pythonBin / dataDir 写的是相对路径：CLI 已按自己进程的 cwd 展开，而宿主按它自己的 cwd 展开，" +
  "两处可能不是同一个目录；改写成绝对路径才没有这层歧义";

/**
 * `--status` 的解释器与数据目录来源。
 *
 * 宿主按 profile 里的 `pythonBin` 起 sidecar、按同一份条目里的 `dataDir` 放运行时与
 * 能力包；CLI 不读 profile 时只能走自己的链——那会让 `--status` 报 `python3/path`，
 * 并把能力包状态报到默认数据目录上，而部署实际用的是别的解释器与目录。给了
 * `--profile` 就读那份 `cordis.patch.yml` 里的 `pythonBin` 与 `dataDir`（与 doctor
 * 读同一份文本、同一个 `patchScalar`）；没给则在输出里明说没读，而不是假装那已经是
 * 宿主会用的解释器。
 *
 * @param flags - 本次命令行旗标
 * @returns 写进 JSON 的 profile 段、交给 `resolveRuntime` 的 `pythonBin`，
 *   以及 profile 声明的 dataDir（未声明时为 undefined，调用方沿用默认）
 */
/**
 * 把 profile 里写下的路径就地展开成绝对路径，并说明它原本是不是相对的。
 *
 * 宿主自己用 `path.resolve` 展开 `dataDir`（`host.ts` 的 `resolveDataDir`），那一步按
 * **宿主进程的 cwd** 解析；CLI 的 cwd 与宿主的不是同一个，所以相对路径在两边会落到不同目录。
 * CLI 修不了这个差别（它读不到宿主的 cwd），但可以做两件事：按自己的 cwd 展开一次，
 * 让 `packStates` / `readRuntimeState` 的读法**不随每次调用隐含变化**；以及在输出里点明
 * 「这一位是相对的，宿主可能解析到别处」—— 否则用户看到的就是一个与部署无关的目录被静静地量。
 *
 * 裸命令名（`python3`、`python`）不当路径处理：`path.resolve("python3")` 会变成
 * `<cwd>/python3`，那是另一个东西。
 *
 * @param raw - profile 里写下的原始值
 * @returns 展开后的路径与「原本是否相对」这一事实
 */
function expandDeclared(raw: string): { readonly value: string; readonly relative: boolean } {
  if (!raw.includes("/") && !raw.includes("\\")) {
    return { value: raw, relative: false };
  }
  return { value: path.resolve(raw), relative: !path.isAbsolute(raw) };
}

async function statusProfile(
  flags: FlagMap,
): Promise<{ profile: StatusProfile; pythonBin: string; dataDirOverride?: string }> {
  const dir = stringFlag(flags, "profile");
  if (dir === undefined) {
    return {
      profile: { path: null, pythonBin: null, dataDir: null, note: NO_PROFILE_NOTE },
      pythonBin: "",
    };
  }
  const snapshot = await readProfileSnapshot(dir);
  const declaredBin = patchScalar(snapshot.patchText, "pythonBin") ?? "";
  const declaredDir = patchScalar(snapshot.patchText, "dataDir") ?? "";
  const bin = expandDeclared(declaredBin);
  const dataDir = expandDeclared(declaredDir);
  const pythonBin = bin.value;
  const notes = [
    ...(declaredBin === "" ? [NO_PYTHON_BIN_NOTE] : []),
    ...(bin.relative || dataDir.relative ? [RELATIVE_PATH_NOTE] : []),
  ];
  return {
    profile: {
      path: dir,
      pythonBin: declaredBin === "" ? null : declaredBin,
      dataDir: declaredDir === "" ? null : declaredDir,
      ...(notes.length === 0 ? {} : { note: notes.join("；") }),
    },
    pythonBin,
    ...(declaredDir === "" ? {} : { dataDirOverride: dataDir.value }),
  };
}

async function showStatus(flags: FlagMap, deps: CliDeps): Promise<number> {
  const { profile, pythonBin, dataDirOverride } = await statusProfile(flags);
  // 能力包与运行时状态跟着部署实际用的那份数据目录走：profile 声明了 dataDir 时，
  // 状态报的就是那一份，而不是 CLI 默认目录上的（那会让「宿主装没装」答错对象）。
  const dataDir = dataDirOverride ?? deps.dataDir;
  const runtime = resolveRuntime({
    pythonBin,
    dataDir,
    repoRoot: deps.repoRoot,
  });
  const state = await readRuntimeState(dataDir);
  const packs = await packStates(dataDir);
  deps.log(JSON.stringify({ dataDir, profile, runtime, packs, state }, null, 2));
  return 0;
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
/**
 * 后端名不在本包实现的名单里时的那一条配置错；写对了（或整行没写）交回空表。
 * provider 不拒未知后端：它按 deps.backend 走到 endpointOf 的 switch，落空之后连对端都取不到，
 * 坏要等到每一次查询才现形 —— 所以这一档必须由 doctor 判红，不能让「键存在且不是 auto」当成没问题。
 */
function backendConfigFinding(backendRaw: string | undefined): SearchFinding[] {
  if (backendRaw === undefined || isSearchBackend(backendRaw)) {
    return [];
  }
  return [
    {
      code: "SEARCH_BACKEND_INVALID",
      detail: `searchBackend=${backendRaw} 不是本包实现的后端：可写的取值是 ${SEARCH_BACKENDS.join(" / ")}，删掉这一行即回到 auto。`,
    },
  ];
}

/**
 * 搜索侧的 doctor 判据需要一个比「ready 不 ready」更细的输入。
 *
 * `blocked` 与 `missing` 不是同一件事：`packStates` 在 `installerSupported()` 为假
 * （非 macOS arm64）时无条件报全 `blocked`，而那些平台上 `resolveRuntime` 仍可回落到
 * PATH 的 python3 —— 也就是说「装不了」不等于「装不上就跑不了」。把两者压成一个 boolean
 * 之后，Linux 上装好且能跑的部署会被 doctor 固定判红，并指向一条在那台机器上永远修不好
 * 的 `setup --feature core --apply`。
 *
 * @param state - `packStates` 给出的 core 状态；调用点只在它不是 `ready` 时进来
 * @returns 一句可以照做的处置
 */
function coreUnreadyDetail(state: PackState): string {
  const prefix =
    "searchProvider 已指向 scrapling，但能力包没装好：web_search 会报 WEB_PROVIDER_CONFIGURED_UNAVAILABLE。";
  if (state === "blocked") {
    // 这一档刻意**不点** setup 命令：`installerSupported()` 为假时它在那些平台上永远修不好，
    // 把命令写进文案再解释说「但没用」只会让人照着敲一遍（判据侧也据此断言这句不出现）。
    return (
      `${prefix}原因是这台机器不在安装器支持的范围内（只验过 macOS arm64），` +
      "所以 core 被标成 blocked —— 这不是「没装」，重跑安装计划在那台机器上也修不好。" +
      "修复：把 profile 里 - id: scrapling 的 pythonBin 指到一个装好 scrapling 的解释器，或把 searchProvider 从 scrapling 改回宿主自己的 provider。"
    );
  }
  return `${prefix}修复：dsh-scrapling setup --feature core --apply。`;
}

function searchDiagnostics(patchText: string, coreState: PackState): SearchDiagnostics {
  const provider = patchScalar(patchText, "searchProvider");
  const backendRaw = patchScalar(patchText, "searchBackend");
  const backend = backendRaw ?? "auto";
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
  findings.push(...backendConfigFinding(backendRaw));
  if (pointedHere && coreState !== "ready") {
    findings.push({
      code: "WEB_PROVIDER_CONFIGURED_UNAVAILABLE",
      detail: coreUnreadyDetail(coreState),
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
    deps.log(modeHint(flags));
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
  // 判「core 能力包装没装」必须落在宿主真正用的那份数据目录上：profile 声明了 dataDir 时
  // 宿主把它传给插件，CLI 默认目录上的状态与它无关。用 `deps.dataDir` 会让 doctor 在
  // 「profile 指到别处、那边装好了、默认目录没装」的机器上报 core 未就绪 —— 与
  // `--status` 的判据（`dataDirOverride ?? deps.dataDir`）得出相反的答案。
  const dataDir = patchScalar(snapshot.patchText, "dataDir") ?? deps.dataDir;
  const packs = await packStates(dataDir);
  const findings = inspectProfile({ mode, expectedPort: given.port, ...snapshot });
  const search = searchDiagnostics(snapshot.patchText, packs.core);
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
  // 只剩搜索侧的 finding 时不许指到 setup --mode：searchProvider / searchBackend / 各凭据键
  // 都不归那条命令写（它落的是模式块与 command 那几行），按上面逐条的修复动作改 web 条目
  // 才是出路 —— 把用户支去重跑一次不相关的命令，等于让配置错原样留着。
  deps.log(
    findings.length > 0
      ? `${String(total)} 处不一致：改完重跑 setup --mode ${mode} --apply，并把条目并进 profile 后重启宿主。`
      : `${String(total)} 处搜索配置不一致：按上面逐条的修复动作改 ${profile} 里 web 条目的 config，重启宿主生效。`,
  );
  return 1;
}

async function uninstallPack(flags: FlagMap, deps: CliDeps): Promise<number> {
  const value = flags.get("uninstall");
  if (typeof value !== "string" || !isFeature(value)) {
    deps.log(featureHint("uninstall", flags));
    return 2;
  }
  const purge = flags.has("purge");
  // 先打印计划再判门：与 setup 的写动词同一条纪律 —— 不带 --apply 时一个字节都不动。
  deps.log(
    `uninstall ${value}${purge ? " (and purge user data)" : ""} from ${path.join(deps.dataDir, "runtime")}`,
  );
  // 干跑判据与 installPack / setupMode 同源（同一个 shouldApply）。
  if (!shouldApply(flags)) {
    deps.log(
      dryRunNotice(flags, {
        suppressed: "只打印计划，不删任何 runtime 文件",
        missingApply: "dry-run; add --apply to uninstall",
      }),
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

/**
 * 安装计划的三到四行文案。
 *
 * 体积**只打清单里那一枚**（`sizeBytes`，托管 Python 压缩包），其余一律不给数字：
 * 原先 wheelhouse 与 Chromium 各写了 `~327M` / `~583M`，两个常数没有任何可核对来源、
 * 会随清单版本漂移，而且除 `browser` 之外的每一包（含 `mcp`，它还要多一个官方 server 入口）
 * 都被印成同一句「core wheels」—— 计划文案与实际要下载的东西对不上。
 *
 * @param feature - 目标能力包
 * @param deps - 数据目录与包根
 * @returns 多行计划
 */
function installPlan(feature: Feature, deps: CliDeps): string {
  const asset = runtimeManifest.darwinArm64;
  const requirements = path.join(deps.repoRoot, "py", "runtime-requirements.txt");
  const lines = [
    `python ${asset.pythonVersion}（清单声明 ${String(asset.sizeBytes)} 字节，sha256 前 12 位 ${asset.sha256.slice(0, 12)}）`,
    // browser 是 core 之上的增量：先建 venv 装依赖，再用 patchright 拉一份完整 Chromium。
    // 其余五包都只是 core venv 里的依赖（各自的 wheel 与入口钉在同一份 requirements 里）。
    feature === "browser"
      ? `core venv 依赖：${requirements}，再装一份完整 Chromium（patchright）`
      : `core venv 依赖：${requirements}`,
    `落地位置：${path.join(deps.dataDir, "runtime")}（Python 在 runtime/python/，wheel 在 runtime/venv/）`,
  ];
  return lines.join("\n");
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
    // 不打印任何一行就退 2 的那一代已经走了：`dsh-scrapling setup`（不带旗标）曾静默退出，
    // 用户看不到任何原因，而 runCli 的注释恰好写着「仅退出 2 会让用户不知道是哪一段写错了」。
    deps.log(featureHint("feature", flags));
    return 2;
  }
  const offline = stringFlag(flags, "offline");
  // `--offline` 是取值旗标：给了就一定带一个字符串（缺值或紧跟另一个旗标在 parseArgs
  // 那层已判 invalid），所以这里只可能是「显式给了空串」这一种缺值形态。
  if (offline === "") {
    deps.log("--offline 要给一个资产目录");
    return 2;
  }
  deps.log(installPlan(value, deps));
  if (offline !== undefined) {
    deps.log(`离线资产目录：${offline}`);
  }
  // 干跑判据与 setupMode / uninstallPack 同源（同一个 shouldApply）：--apply 是"允许落地"，
  // --dry-run 是"仍然只打印"，两者同时出现时后者胜——否则 `setup --feature core --apply --dry-run`
  // 会真下载几百 MB 并改写 runtime，而命令行上明写着 dry-run。
  if (!shouldApply(flags)) {
    deps.log(
      dryRunNotice(flags, {
        suppressed: "只打印计划，不下载也不写 runtime",
        missingApply: "dry-run; add --apply to install",
      }),
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
const USAGE =
  "用法：dsh-scrapling setup [--feature <core|browser|search|media|adaptive-redis|mcp>] " +
  "[--mode <native|mcp|official-mcp>] [--profile <目录>] [--port <1-65535>] " +
  "[--offline <资产目录>] [--apply] [--dry-run] [--repair] [--status] [--with-auth] " +
  "[--accept-risk] [--uninstall <core|browser|search|media|adaptive-redis|mcp> [--purge]]；" +
  "dsh-scrapling doctor --mode <native|mcp|official-mcp> --profile <目录>；" +
  "--apply 才落地，--dry-run（缺省）只打印计划，两者同时给时 --dry-run 胜。";

export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  const deps = withDefaults(overrides);
  const parsed = parseArgs(argv);
  if (parsed === null) {
    // 解析失败时仅退出 2 会让用户不知道是哪一段写错了；用法行至少点名命令与旗标形状。
    deps.log(USAGE);
    return 2;
  }
  const { flags } = parsed;
  try {
    if (parsed.command === "doctor") {
      return await runDoctor(flags, deps);
    }
    if (flags.has("status")) {
      return await showStatus(flags, deps);
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
