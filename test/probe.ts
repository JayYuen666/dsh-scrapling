// dsh-scrapling/test/probe.ts —— 跑 py/tests/contract_probe.py 并把它的答案表取回来。
//
// 两份门禁（契约对表与线路对表）问的是同一件事：本仓发出去/读进来的那些键，上游与另一侧
// 到底认不认。判据必须只有一个来源，否则两份测试会各自漂移，而漂移出来的差值看着像 bug、
// 其实是夹具不一致 —— 那种红最难查。
//
// 探针在**真实 Scrapling** 上运行（_env/.venv 那份解释器，与 sidecar 用例同源），所以这里
// 不必再对本仓的映射表做任何复刻。

import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { LOCAL_PYTHON } from "./python-bin.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const PROBE = path.join(REPO, "py", "tests", "contract_probe.py");

/** 探针记录的一个调用点：站点名与它实际发出的键。 */
export interface ProbeCall {
  site: string;
  keys: string[];
}

/** 键名根本不在上游参数面里（会抛 TypeError）。 */
export interface ViolationRecord {
  site: string;
  keys: string[];
  expected: string;
}

/** 键在该调用点被上游静默丢弃。 */
export interface SilentRecord {
  site: string;
  keys: string[];
  honorableAtOpen: string[];
}

/**
 * stealth 路径上的一条不变量违规。
 *
 * 字段随违规种类而变（不该出现的键、该为真却缺失的开关、被顶掉的启动参数条数），所以这里
 * 把站点单列、其余按可选出面 —— 具体形状由探针的 `_stealth_check` 决定，见其实现。
 */
export interface StealthInvariantViolation {
  /** 出问题的调用点。 */
  site: string;
  /** 不该出现却出现了的键（例如 `extra_flags`）。 */
  unexpected?: string;
  /** 该为真却缺失的东西（例如走代理时的 `block_webrtc`）。 */
  missing?: string;
  /** 被整段顶掉的反检测启动参数条数。 */
  missingStealthArgs?: number;
  /** 上游 STEALTH_ARGS 的总数。 */
  of?: number;
  /** 前几条缺失的参数名，便于排查。 */
  sample?: string[];
  /** 本次实测的启动参数总数。 */
  totalArgs?: number;
}

/**
 * 探针钉住的上游事实。
 *
 * 这些字段是本仓代码直接依赖的上游形状：形状写死成接口，读法就能用点号 —— 一旦探针少了
 * 某个字段，编译期就报错，而不是让断言对着一个 `undefined` 安静通过。
 */
export interface ProbeFacts {
  /** ``Fetcher`` 上真实存在的动词。 */
  fetcherVerbs: string[];
  /** ``Selector.css`` 的参数名。 */
  selectorCssParams: string[];
  /** 自愈相似度的默认门槛。 */
  selectorCssDefaultPercentage: number;
  /** ``Response.markdown`` 的参数名。 */
  responseMarkdownParams: string[];
  /** ``Convertor`` 那几个私有函数在不在。 */
  convertorPrivates: string[];
  /** ``_strip_noise_tags`` 实测丢掉的标签。 */
  noiseTagsActuallyStripped: string[];
  /** ``SQLiteStorageSystem`` 的构造参数。 */
  storageInitParams: string[];
  /** stealth 会话按本仓参数真造出来后拿到的启动参数条数。 */
  stealthArgCount: number;
  /** 上游 STEALTH_ARGS 的条数。 */
  stealthArgsTotal: number;
  /** 上游 DEFAULT_ARGS 的条数。 */
  defaultArgsTotal: number;
  /** 上游 DEFAULT_ARGS 与 STEALTH_ARGS 的并集条数（交集非空时小于两条之和）。 */
  defaultStealthUnionTotal: number;
  /** ``Response.__init__`` 的参数名。 */
  responseInitParams: string[];
  /** Spider 基类默认值。 */
  spiderDefaults: {
    robots_txt_obey: boolean;
    autothrottle_enabled: boolean;
    download_delay: number;
    concurrent_requests: number;
    max_pages: number;
    output_dir: string | null;
    main_content_only: boolean;
  };
  /** 爬虫子类写的那些类属性是否都真实存在。 */
  spiderAttrs: string[];
  /** ``SessionManager.add`` 的参数名。 */
  sessionManagerAddParams: string[];
  /** 爬虫钩子是否都还在。 */
  crawlHooks: string[];
  /** 本仓脱敏名单（用于核对与文档一致）。 */
  redactionTargets: string[];
}

/** 探针输出的完整报告。 */
export interface ProbeReport {
  /** 站点名 -> 该点抓到的键数量。 */
  checked: Record<string, number>;
  /** 每个调用点实际发出的键。 */
  calls: ProbeCall[];
  /** 键名不在上游参数面里的调用点。 */
  violations: ViolationRecord[];
  /** 会话 fetch 层被静默丢弃的键。 */
  silentAtSessionFetch: SilentRecord[];
  /** stealth 路径上的不变量违规（不发 extra_flags / 走代理时 block_webrtc 为真 / 反检测参数仍在）。 */
  stealthInvariants: StealthInvariantViolation[];
  /** 本仓声明的 fetch 层键集与上游实际字段的差。 */
  fetchLevelKeysDrift: string[];
  /** 上游 `Python` 侧每个协议方法真正读到的键。 */
  reads: Record<string, string[]>;
  /** Python 侧 METHODS 表的全集。 */
  methods: string[];
  /** 本仓代码直接依赖的上游事实。 */
  facts: ProbeFacts;
}

/** runProbe 的可替换路径：只给测试在不碰真实 venv 的情况下验启动失败那条分支用。 */
export interface ProbeOptions {
  /** 覆盖探针解释器路径（缺省为 py-launcher 解析出的那一支）。 */
  pythonPath?: string;
  /** 覆盖探针脚本路径（缺省为 py/tests/contract_probe.py）。 */
  probePath?: string;
  /** 覆盖看门狗预算（缺省 `PROBE_TIMEOUT_MS`）；只给「探针挂住」那条分支的测试用。 */
  timeoutMs?: number;
}

/**
 * 探针的看门狗预算。
 *
 * 探针不是 sidecar：它只写一行结论到 stdout，所以正常路径等它自己退。但**挂住**必须有界：
 * 契约测试在模块顶层 await 它，而模块求值不受 vitest 的 `testTimeout` 约束 —— 上游哪天让
 * 会话构造卡住（真造一次 stealth 会话本来就要拉起浏览器），整个 test run 会无限等下去，
 * 报告里既没有红也没有绿。超预算就杀掉并点名预算。
 */
const PROBE_TIMEOUT_MS = 180_000;

/** stderr 在内存里最多留多少字节：只留尾巴，刷屏的日志不该把测试进程的内存吃空。 */
const STDERR_TAIL_BYTES = 256 * 1024;

/**
 * stdout 的上限：探针的结论是一行 JSON，写到这个量说明它没在写结论。
 *
 * 数值与 `lib/jsonl.ts` 的 `MAX_FRAME_CHARS` 同档（8 MiB），两侧口径不同这点也跟那边一样：
 * 这里比的是**字节**，那条比的是 UTF-16 码元。
 */
const PROBE_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** 报错文案里留 stderr 末尾多少行：栈在头几行与最后几行，中间是重复。 */
const STDERR_TAIL_LINES = 60;

/** 报错文案里留 stdout 开头多少行：输出不是 JSON 时它是唯一线索。 */
const STDOUT_HEAD_LINES = 40;

/** 一条有界的字节尾巴。 */
interface TailCollector {
  /** 收一段字节；超过上限时从最前面丢起。 */
  collect: (chunk: Buffer) => void;
  /** 现在手里的那段尾巴。 */
  text: () => string;
}

/**
 * 建一条只会往后留 `limitBytes` 字节的尾巴收集器。
 *
 * 探针正常退出时 stderr 不该进判据，只有失败时才是线索；无界攒下去，一次刷屏（patchright
 * 的启动日志或 Scrapling 的 INFO 行都能到 MB 级）吃的是宿主测试进程的内存，那比丢掉的中间
 * 段落危险得多。切片可能把一个多字节字符截在边界上，那只会让尾巴第一个字符变成替换符，
 * 不影响人读的那几行。
 *
 * @param limitBytes - 内存里最多留多少字节
 * @returns 收集器
 */
function tailCollector(limitBytes: number): TailCollector {
  const state = { parts: [] as Buffer[], size: 0 };
  return {
    collect: (chunk: Buffer): void => {
      state.parts.push(chunk);
      state.size += chunk.length;
      while (state.size > limitBytes && state.parts.length > 1) {
        const first = state.parts.shift();
        state.size -= first?.length ?? 0;
      }
      const [last] = state.parts;
      if (last !== undefined && last.length > limitBytes) {
        // 单段就超上限：留它的尾巴，否则上一轮的 shift 一次也轮不到它。
        state.parts[0] = last.subarray(last.length - limitBytes);
        state.size = limitBytes;
      }
    },
    text: (): string => Buffer.concat(state.parts).toString("utf8"),
  };
}

/**
 * 取一段文本的末尾 `limit` 行。
 *
 * 按行而不是按字符截：`slice(-4000)` 会把代理对切成半个（页面正文、上游异常消息里都
 * 可能出现），而日志本来就读得成行。行数上限只管报错文案，内存那一头由 `tailCollector`
 * 的字节预算管。
 *
 * @param text - 整段文本
 * @param limit - 保留末尾多少行
 * @returns 截过的文本
 */
function tailLines(text: string, limit: number): string {
  const lines = text.split("\n");
  return lines.slice(-limit).join("\n");
}

/** 取一段文本的开头 `limit` 行。 */
function headLines(text: string, limit: number): string {
  return text.split("\n").slice(0, limit).join("\n");
}

/** 报告顶层那几项必须是数组。 */
const REPORT_ARRAY_FIELDS = [
  "calls",
  "violations",
  "silentAtSessionFetch",
  "stealthInvariants",
  "fetchLevelKeysDrift",
  "methods",
] as const;

/** `facts` 里必须是数组的那些。 */
const FACTS_ARRAY_FIELDS = [
  "fetcherVerbs",
  "selectorCssParams",
  "responseMarkdownParams",
  "convertorPrivates",
  "noiseTagsActuallyStripped",
  "storageInitParams",
  "spiderAttrs",
  "sessionManagerAddParams",
  "crawlHooks",
  "redactionTargets",
] as const;

/** `facts` 里必须是数字的那些。 */
const FACTS_NUMBER_FIELDS = [
  "selectorCssDefaultPercentage",
  "stealthArgCount",
  "stealthArgsTotal",
  "defaultArgsTotal",
  "defaultStealthUnionTotal",
] as const;

/** Spider 基类默认值里必须存在的键。 */
const SPIDER_DEFAULT_FIELDS = [
  "robots_txt_obey",
  "autothrottle_enabled",
  "download_delay",
  "concurrent_requests",
  "max_pages",
  "output_dir",
  "main_content_only",
] as const;

/** 给报错用的类型名：array 与 null 在 `typeof` 下都说不出真相。 */
function kindOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

/** 期望的形状种类与它的中文名，只用于报错文案。 */
const KIND_LABELS: Record<string, string> = { array: "数组", number: "数字", object: "对象" };

/** `value` 是不是那个种类：`array` 与 `null` 在 `typeof` 下都说不出真相，所以按种类分派。 */
function matchesKind(value: unknown, expect: "array" | "number" | "object"): boolean {
  switch (expect) {
    case "array": {
      return Array.isArray(value);
    }
    case "number": {
      return typeof value === "number";
    }
    case "object": {
      return isRecord(value);
    }
    default: {
      return false;
    }
  }
}

/**
 * 要求 `owner[name]` 是那个种类，否则点名它实际是什么。
 *
 * @param owner - 被检查的对象
 * @param name - 这一层里的字段名
 * @param expect - 期望种类
 * @param prefix - 报错文案里的路径前缀（如 `facts.`），不参与取值
 */
function requireKind(
  owner: Record<string, unknown>,
  name: string,
  expect: "array" | "number" | "object",
  prefix = "",
): void {
  const value = owner[name];
  if (!matchesKind(value, expect)) {
    throw new Error(
      `探针报告的 ${prefix}${name} 应为${KIND_LABELS[expect]}，实际是 ${kindOf(value)}：契约对表与线路对表都判不了`,
    );
  }
}

/**
 * 要求 `owner[name]` 是个对象，且每个值的种类都符合 `valueExpect`。
 *
 * @param owner - 被检查的对象
 * @param name - 字段名
 * @param valueExpect - 每个值应有的种类
 */
function requireRecordValues(
  owner: Record<string, unknown>,
  name: string,
  valueExpect: "number" | "array",
): void {
  const value = owner[name];
  if (!isRecord(value)) {
    throw new Error(
      `探针报告的 ${name} 应为对象，实际是 ${kindOf(value)}：契约对表与线路对表都判不了`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    const ok = valueExpect === "number" ? typeof entry === "number" : Array.isArray(entry);
    if (!ok) {
      throw new Error(
        `探针报告的 ${name}.${key} 的值应为${KIND_LABELS[valueExpect]}，实际是 ${kindOf(entry)}`,
      );
    }
  }
}

/**
 * 校验探针回的结构确实是 `ProbeReport` 承诺的那张表。
 *
 * 为什么要有这一段：`JSON.parse(text) as ProbeReport` 只是类型欺骗。探针改了字段名、少了
 * 一项或多写一行非 JSON 的输出时，下游拿到的是 undefined —— 有的断言会对着它安静通过，
 * 有的报一句与契约无关的 TypeError，两种都比「这句话就是契约」难查。本文件开头的初衷是
 * 判据只有一个来源，那张表得先证明它存在。
 *
 * @param parsed - `JSON.parse` 的结果
 * @returns 通过校验的报告
 * @throws 点名缺哪一项、它实际是什么种类
 */
export function assertProbeReport(parsed: unknown): ProbeReport {
  if (!isRecord(parsed)) {
    throw new Error(`探针报告不是一个 JSON 对象，实际是 ${kindOf(parsed)}`);
  }
  for (const field of REPORT_ARRAY_FIELDS) {
    requireKind(parsed, field, "array");
  }
  requireRecordValues(parsed, "checked", "number");
  requireRecordValues(parsed, "reads", "array");
  const facts: Record<string, unknown> = {};
  if (!isRecord(parsed["facts"])) {
    throw new Error(`探针报告的 facts 应为对象，实际是 ${kindOf(parsed["facts"])}`);
  }
  Object.assign(facts, parsed["facts"]);
  for (const field of FACTS_ARRAY_FIELDS) {
    requireKind(facts, field, "array", "facts.");
  }
  for (const field of FACTS_NUMBER_FIELDS) {
    requireKind(facts, field, "number", "facts.");
  }
  const { spiderDefaults } = facts;
  if (!isRecord(spiderDefaults)) {
    throw new Error(`探针报告的 facts.spiderDefaults 应为对象，实际是 ${kindOf(spiderDefaults)}`);
  }
  for (const field of SPIDER_DEFAULT_FIELDS) {
    if (!(field in spiderDefaults)) {
      throw new Error(`探针报告的 facts.spiderDefaults 少了 ${field}`);
    }
  }
  return parsed as unknown as ProbeReport;
}

/**
 * 跑一次探针。
 *
 * 解释器与脚本都先判存在：CI 上没有 `_env/.venv` 时 `spawn` 会给一个裸 ENOENT，那句
 * 「spawn ... ENOENT」分不清缺的是解释器还是探针脚本，而两者的修法完全不同。
 * 判过存在性之后，剩下的启动失败（解释器在但不可执行）走的是 `error` 事件：Node 在这里
 * 不再发 `close`，`events.once` 会把它转成拒绝，所以下面接住那条拒绝并点名解释器路径。
 *
 * 等的是 `close` 而不是 `exit`：Node 文档明写 `exit` 触发时 stdio 流可能尚未读完，探针
 * 输出稍大一点 `Buffer.concat` 就会拿到截断的 JSON —— 表现为随机失败，最难查。`close`
 * 的第二个返回值是终止信号：进程被信号打死时 `code` 是 null，只报「以 null 退出」等于
 * 把真正的死因丢掉。
 *
 * @returns 探针报告
 * @throws 探针不存在、起不来、超预算被杀、非零退出（或被信号终止）、输出不是 JSON
 */
export async function runProbe(options: ProbeOptions = {}): Promise<ProbeReport> {
  const python = options.pythonPath ?? LOCAL_PYTHON;
  const probe = options.probePath ?? PROBE;
  if (!existsSync(python)) {
    throw new Error(
      `缺少探针解释器：${python} 不存在。\n` +
        '先建好环境：pip install "scrapling[rag]>=0.5,<0.6"（CI 上由 publish.yml 那一步代劳）。',
    );
  }
  if (!existsSync(probe)) {
    throw new Error(`缺少探针脚本：${probe} 不存在。它随仓库发布，不该缺席。`);
  }
  const child = spawn(python, [probe], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  // `once(child, "close")` 会临时挂一个 error 监听，并在敲定时把包括 error 在内的监听全摘掉。
  // close 之后进程销毁阶段再冒一次 error（或 error 与 close 的到达次序有先后差），就没有
  // 接收者了：Node 会把它抛成未处理异常、崩掉整个测试进程，那句报错与探针无关，最难归因。
  // 这条常驻监听先接住，让「有没有人在听」不依赖 once 的内部实现。
  const lateError = { error: undefined as unknown };
  child.on("error", (error: unknown): void => {
    lateError.error = error;
  });
  const stderrTail = tailCollector(STDERR_TAIL_BYTES);
  child.stderr.on("data", (chunk: Buffer): void => {
    stderrTail.collect(chunk);
  });
  const stdout = { parts: [] as Buffer[], size: 0, capped: false };
  child.stdout.on("data", (chunk: Buffer): void => {
    stdout.size += chunk.length;
    if (stdout.size > PROBE_OUTPUT_LIMIT_BYTES) {
      // 结论超过预算时它写的已经不是那一行 JSON：交给 JSON.parse 只会得到一句语法错，
      // 把「探针在往 stdout 刷日志」这个真正的原因盖掉。
      stdout.capped = true;
      return;
    }
    stdout.parts.push(chunk);
  });
  // 定时器 `unref`：探针正常收尾时它不该把事件循环按住。SIGKILL 而不是 SIGTERM ——
  // 挂住的探针大概率正卡在上游的阻塞调用里，TERM 未必收得到。
  // 状态放在对象里：`let` 的赋值只发生在回调里，规则的流分析会把外层读到的一路当成恒假。
  const watchdogState = { fired: false };
  const watchdog = setTimeout(() => {
    watchdogState.fired = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  watchdog.unref();
  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } catch (spawnError) {
    // 启动失败只来 `error` 事件、永远不来 `close`（实测 EACCES：error 先到，close 的 once
    // 直接以同一个错误拒绝）。把它包成一句点名解释器的话，否则用户读到的是一句裸 EACCES。
    throw new Error(
      `探针起不来：${python}（${spawnError instanceof Error ? spawnError.message : String(spawnError)}）。\n` +
        "存在性已经判过，这类失败通常是可执行位或权限问题，不是缺少 Scrapling。",
      { cause: spawnError },
    );
  }
  clearTimeout(watchdog);
  const stderr = (): string => tailLines(stderrTail.text(), STDERR_TAIL_LINES);
  if (watchdogState.fired) {
    // 先看门狗再谈退出码：被 SIGKILL 打死的进程也走 `code !== 0` 那一支，而那句话说它是
    // 「自己崩了」，与「挂住到预算」是两种排查方向。
    throw new Error(
      `探针超过 ${String(options.timeoutMs ?? PROBE_TIMEOUT_MS)}ms 没写完结论，已用 SIGKILL 终止。` +
        `\nstderr:\n${stderr()}`,
    );
  }
  if (code !== 0) {
    // 非零退出时栈全在 stderr 那一侧，不接出来就只剩「命令失败」一句废话。
    const how =
      signal === null
        ? `以 ${String(code)} 退出`
        : `被信号 ${signal} 终止（exit code ${String(code)}）`;
    throw new Error(`探针${how}\nstderr:\n${stderr()}`);
  }
  if (lateError.error !== undefined) {
    // 退出码为 0 但进程报过 error：stdio 被拆过时结论可能就是半截，别把它当完整的一行 JSON。
    // 报错原文挂在 cause 上（vitest 会把 cause 一起打出来）：这里不对一个 unknown 做字符串化，
    // 非 Error 的载荷会被 `String()` 打成 `[object Object]`，那句比原因更误导。
    throw new Error(`探针在收尾之后报过一个 error 事件，原因见 cause。\nstderr:\n${stderr()}`, {
      cause: lateError.error,
    });
  }
  if (stdout.capped) {
    throw new Error(
      `探针的 stdout 超过 ${String(PROBE_OUTPUT_LIMIT_BYTES)} 字节上限：它写的不是那一行结论。\n` +
        `stderr:\n${stderr()}`,
    );
  }
  const text = Buffer.concat(stdout.parts).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    throw new Error(
      `探针输出不是 JSON：${String(parseError)}\nstdout: ${headLines(text, STDOUT_HEAD_LINES)}`,
      { cause: parseError },
    );
  }
  // 形状判据单独一步：校验失败要说「少了哪一项」，不能被上面那句「不是 JSON」盖掉。
  return assertProbeReport(parsed);
}
