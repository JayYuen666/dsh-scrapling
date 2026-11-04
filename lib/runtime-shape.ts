// runtime 设置面的线上形状。宿主服务与卡片读取器各内联一份，放这里共用一份声明。

/** 宿主服务键 = 客户端线上命名空间。 */
export const RUNTIME_REMOTE_NAMESPACE = "scraplingRuntime";

/** 能力包清单；顺序即卡片上的呈现顺序。 */
export const RUNTIME_PACKS = [
  "core",
  "browser",
  "search",
  "media",
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

export interface RuntimeJobView {
  readonly id: string;
  readonly pack: RuntimePack;
  readonly status: RuntimeJobStatus;
  readonly output: string;
}

export interface RuntimePython {
  readonly path: string;
  readonly via: string;
  readonly version: string;
}

export interface RuntimeStatusResult {
  readonly ok: true;
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
   * 卡片会把它原样放进失败区域，所以这一位不承诺本地化，也不承诺精简；新增写点时必须自己
   * 保证不含凭据——本包的 pip 调用不带 `--index-url`（凭据不会出现在 pip 的报错里），
   * 托管 venv 的路径则是用户本机自己的信息。
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
