// runtime 设置面的线上形状。宿主服务与卡片读取器各内联一份，放这里共用一份声明。

/** 宿主服务键 = 客户端线上命名空间。 */
export const RUNTIME_REMOTE_NAMESPACE = "scraplingRuntime";

/** 能力包清单；顺序即卡片上的呈现顺序。 */
export const RUNTIME_PACKS = [
  "core",
  "browser",
  "search",
  "media",
  "documents",
  "adaptive-redis",
  "mcp",
] as const;

export type RuntimePack = (typeof RUNTIME_PACKS)[number];

const PACK_NAMES: ReadonlySet<string> = new Set(RUNTIME_PACKS);

export function isRuntimePack(value: unknown): value is RuntimePack {
  return typeof value === "string" && PACK_NAMES.has(value);
}

/**
 * 单个能力包的状态取值域；顺序与卡片译名键一一对应。
 * `blocked` 是「这台机器/这个平台刻意不装」，不是坏掉。
 *
 * 值域在这里以**运行时清单**给出而不是只写类型联合：卡片读取器要拿它构造 zod 校验，
 * 宿主与卡片是分开发版的两侧，各抄一份枚举时新增一个状态不会有任何编译期报错。
 */
export const PACK_STATES = ["ready", "missing", "corrupt", "installing", "blocked"] as const;

export type PackState = (typeof PACK_STATES)[number];

/** 官方作业状态的取值域（同一理由：运行时清单是单一来源）。 */
export const JOB_STATUSES = ["running", "stopping", "completed", "killed", "failed"] as const;

export type RuntimeJobStatus = (typeof JOB_STATUSES)[number];

/**
 * 解释器来源的取值域；顺序即 `resolveRuntime` 的解析优先级。
 *
 * 与 `PACK_STATES` 同一理由用运行时清单给出：卡片读取器要拿它构造 zod 校验，而宿主与
 * 卡片是分开发版的两侧 —— 只写类型联合时，新增或改名一个档位既不会有编译期报错，也不会
 * 被读取器挡住，症状是「宿主解析出了新档位、卡片把它判成非法响应整块不渲染」。
 *
 * `managed-venv` 与 `managed` 不是同一件事：前者是装了 wheel 的 venv（工具全在），后者是
 * 裸托管 CPython（安装器拿它建 venv，里面一个包都没有）。
 */
export const PYTHON_VIAS = ["configured", "managed-venv", "managed", "repo", "path"] as const;

export type PythonVia = (typeof PYTHON_VIAS)[number];

export interface RuntimeJobView {
  readonly id: string;
  readonly pack: RuntimePack;
  readonly status: RuntimeJobStatus;
  readonly output: string;
}

export interface RuntimePython {
  readonly path: string;
  readonly via: PythonVia;
  /**
   * 解释器版本。
   *
   * 只有两个托管档位说得准（前者问 venv 自己的 `pyvenv.cfg`，后者抄清单）；其余三档
   * （显式配置 / 仓内 venv / PATH）一律 `"unknown"` —— 那三档要报准版本就得在每次读状态时
   * 起一个解释器进程。所以**别把它当成一定可信的值**：卡片只在它不等于 `"unknown"` 时呈现。
   */
  readonly version: string;
}

export interface RuntimeStatusResult {
  readonly ok: true;
  /**
   * 每个能力包的状态。
   *
   * 声明成 `Partial` 是刻意的：宿主读状态失败时会降级成空对象（`packsOrEmpty`），旧版宿主
   * 也可能压根不认识新版卡片多出来的那个包 —— 两侧分开发版，这是本文件的前提。**卡片必须
   * 把缺键当成「未安装」，不能当成「正在读取」**：后者永远等不到第二次渲染，而那一行的
   * 两个按钮又被 `state === null` 一起禁掉，于是新增的包在旧宿主上会显示成一行永远转圈、
   * 点不动的死行（`src/settings-card.ts` 的 `renderRuntime` 按这条语义取值）。
   */
  readonly packs: Readonly<Partial<Record<RuntimePack, PackState>>>;
  readonly python: RuntimePython;
  readonly dataDir: string;
  /** 宿主有没有作业后端；没有时卡片禁用安装按钮并显示 CLI 命令。 */
  readonly jobsReady: boolean;
  readonly job: RuntimeJobView | null;
}

export interface RuntimePackRequest {
  readonly pack: RuntimePack;
}

export interface RuntimeCancelRequest {
  readonly jobId: string;
}

/** 被拒时的 HTTP 语义码取值域（卡片读取器用它构造校验）。 */
export const REFUSED_STATUSES = [400, 404, 409, 500, 503] as const;

export type RuntimeRefusedStatus = (typeof REFUSED_STATUSES)[number];

export interface RuntimeRefused {
  readonly ok: false;
  /**
   * 给人排障用的诊断原文（宿主侧多为 `String(error)` 或点名的配置问题）。
   *
   * 卡片会把它原样放进失败区域，所以这一位不承诺本地化，也不承诺精简；**新增写点时必须
   * 自己保证不含凭据**。这里不承诺「本包的命令不会带出凭据」：pip 会继承宿主进程环境里的
   * `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL`（企业镜像把 token 写在那里是常规做法），**即使
   * 我们不传 `--index-url`**，它的报错里也会带着那条地址。所以脱敏闸门在
   * `lib/installer.ts` 的 `safeStderr()`（逐条 stderr 进文案之前过一遍 `redactUrlSecrets`），
   * 而不是靠「我们不传参数」这个推断。
   */
  readonly error: string;
  readonly status: RuntimeRefusedStatus;
}

export interface RuntimeStarted {
  readonly ok: true;
  readonly jobId: string;
}

export type RuntimeActionResult = RuntimeStarted | RuntimeRefused;

/** pack 状态在卡片上的译名键（host 与 client 共用同一份词表）。 */
export function packStateKey(state: PackState): string {
  return `runtime.state.${state}`;
}

/** pack 名称的译名键。 */
export function packLabelKey(pack: RuntimePack): string {
  return `runtime.pack.${pack}`;
}

/**
 * 解释器来源的译名键。
 *
 * 卡面上直接印 `managed-venv` 这种机器标识，用户读不出「工具全在」与「一只都不在」的差别
 * —— 而那两支的差别恰好是最要紧的那一档。
 *
 * @param via - 来源档位
 * @returns 译名键
 */
export function pythonViaKey(via: PythonVia): string {
  return `runtime.via.${via}`;
}
