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

const REPO = path.resolve(import.meta.dirname, "..");
const LOCAL_PYTHON = path.join(REPO, "_env", ".venv", "bin", "python3");
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

/** stealth 反检测启动参数被整段冲掉的记录。 */
export interface StealthDowngrade {
  site: string;
  missingStealthArgs: number;
  of: number;
  sample: string[];
  totalArgs: number;
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
  /** stealth 启动参数被冲掉的调用点。 */
  stealthArgsDowngraded: StealthDowngrade[];
  /** 本仓声明的 fetch 层键集与上游实际字段的差。 */
  fetchLevelKeysDrift: string[];
  /** 上游 `Python` 侧每个协议方法真正读到的键。 */
  reads: Record<string, string[]>;
  /** Python 侧 METHODS 表的全集。 */
  methods: string[];
  /** 本仓代码直接依赖的上游事实。 */
  facts: ProbeFacts;
}

/**
 * 跑一次探针。
 *
 * @returns 探针报告
 * @throws 探针非零退出或输出不是 JSON
 */
export async function runProbe(): Promise<ProbeReport> {
  const child = spawn(LOCAL_PYTHON, [PROBE], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    out.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err.push(chunk);
  });
  // 探针不是 sidecar：它只写一行结论到 stdout，所以这里等它自己退，不超时也不杀。
  const [code] = (await once(child, "exit")) as [number | null];
  const stdout = Buffer.concat(out).toString("utf8");
  if (code !== 0) {
    // 非零退出时栈全在 stderr 那一侧，不接出来就只剩「命令失败」一句废话。
    throw new Error(
      `探针以 ${String(code)} 退出\nstderr:\n${Buffer.concat(err).toString("utf8").slice(-4000)}`,
    );
  }
  try {
    return JSON.parse(stdout) as ProbeReport;
  } catch (parseError) {
    throw new Error(`探针输出不是 JSON：${String(parseError)}\nstdout: ${stdout.slice(0, 2000)}`, {
      cause: parseError,
    });
  }
}
