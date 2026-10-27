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

/** 单个能力包的状态。`blocked` 是「这台机器/这个平台刻意不装」，不是坏掉。 */
export type PackState = "ready" | "missing" | "corrupt" | "installing" | "blocked";

/** 官方作业状态在卡片契约里的取值域。 */
export type RuntimeJobStatus = "running" | "stopping" | "completed" | "killed" | "failed";

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
  readonly packs: Readonly<Record<RuntimePack, PackState>>;
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

export type RuntimeRefusedStatus = 400 | 404 | 409 | 500 | 503;

export interface RuntimeRefused {
  readonly ok: false;
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
