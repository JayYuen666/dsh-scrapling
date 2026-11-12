// runtime 设置卡的宿主读取接口：官方 Typert Remote（status / install / repair / cancel）。
//
// 为什么是 Remote：安装是宿主进程里的动作（下载 Python、建 venv、装 Chromium），卡片跑在
// 浏览器里，设置界面没有执行宿主动作的口子。这一条在 apply 的早期就注册 —— 即使这台机器
// 根本没有 Python、sidecar 起不来，用户也要能从卡片里把它装上。
//
// 作业走宿主注册表（ctx.jobs）：一次安装是分钟级的，不能卡住 Remote 调用；卡片按 job id
// 轮询 status，进度从作业输出环形缓冲读。取消只叫停作业并把后续步骤挡住：正在跑的 pip / tar
// 这一拍不可中断（InstallerIO 没有信号接口），这是已知粒度，不把它说成“立即停止”。

import type { Context } from "@deepseek-ai/cordis";
import type { JobId, JobOutcome, JobOutputRead, JobRegistry, JobSpec } from "@deepseek-ai/dsh-jobs";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { markRemote } from "@jayyuen66/dsh-plugin-shared/lib/remote-marker";
import { packStates } from "./installer.ts";
import type { installCapabilityPack, InstallerIO } from "./installer.ts";
import { resolveRuntime } from "./runtime.ts";
import { RUNTIME_PACKS, RUNTIME_REMOTE_NAMESPACE, isRuntimePack } from "./runtime-shape.ts";
import type {
  RuntimeActionResult,
  RuntimeJobStatus,
  RuntimeJobView,
  RuntimePack,
  RuntimeRefused,
  RuntimeStatusResult,
} from "./runtime-shape.ts";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "scrapling-runtime": "scrapling-runtime";
  }
}

const RUNTIME_JOB_KIND = "scrapling-runtime";
const JOB_OUTPUT_VIEW_CHARS = 4000;

/** 本模块用到的作业注册表面（不取整个 JobRegistry）。 */
export type RuntimeJobs = Pick<
  JobRegistry,
  "start" | "attachController" | "list" | "get" | "readAt" | "kill"
>;

export interface RuntimeRemoteDeps {
  dataDir: string;
  repoRoot: string;
  /** 设置卡上的 pythonBin；空串落回“托管 → 仓内 → PATH”的既定顺序。 */
  pythonBin: string;
  io: InstallerIO;
  /** 每次用时现读：作业后端可能在插件装上之后才出现，也可能被重载。 */
  jobsOf: () => RuntimeJobs | undefined;
  installPackFn: typeof installCapabilityPack;
}

interface TrackedJob {
  readonly id: JobId;
  readonly pack: RuntimePack;
}

function refused(status: RuntimeRefused["status"], error: string): RuntimeRefused {
  return { ok: false, status, error };
}

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function isLive(status: RuntimeJobStatus): boolean {
  return status === "running" || status === "stopping";
}

function outputOf(read: JobOutputRead): string {
  const text = read.chunks.map((chunk) => chunk.text).join("");
  return text.length > JOB_OUTPUT_VIEW_CHARS ? text.slice(-JOB_OUTPUT_VIEW_CHARS) : text;
}

/**
 * 一条作业的输出尾部；读不出来时给空串。
 *
 * 输出环形缓冲被回收或读数异常都不改变「这条作业还在」的事实，所以这里的失败不能升级成
 * 「整份作业视图没有」。
 */
function outputTextOf(jobs: RuntimeJobs, id: JobId): string {
  try {
    return outputOf(jobs.readAt(id, 0));
  } catch {
    return "";
  }
}

/**
 * 设置卡「运行环境」的宿主读取接口。
 *
 * 服务在构造时注册（cordis Service 的契约），随所属 fiber 卸载自动撤；调用方拿实例没有用处。
 */
export class ScraplingRuntimeService extends TypertRemoteService {
  private readonly deps: RuntimeRemoteDeps;

  /** 最后一次安装作业。终态后仍留着，卡片才能读到结果与输出；下一次 install 会替换它。 */
  private job: TrackedJob | null = null;

  public constructor(ctx: Context, deps: RuntimeRemoteDeps) {
    super(ctx, RUNTIME_REMOTE_NAMESPACE);
    this.deps = deps;
  }

  private jobView(jobs: RuntimeJobs | undefined): RuntimeJobView | null {
    if (this.job === null || jobs === undefined) {
      return null;
    }
    const tracked = this.job;
    let status: RuntimeJobStatus;
    try {
      ({ status } = jobs.get(tracked.id));
    } catch {
      // 注册表不认这条了（被重载或已收走）：卡片按“没有作业”处理，不把旧读数当现状。
      return null;
    }
    // 输出与状态分开读：`readAt` 失败（输出环形缓冲被回收、读数异常）改变不了「有一个作业在跑」
    // 这个事实。合在一个 try 里会让整份视图退回 null，于是正在装的环境被显示成没在装。
    return {
      id: String(tracked.id),
      pack: tracked.pack,
      status,
      output: outputTextOf(jobs, tracked.id),
    };
  }

  /**
   * 读上一次安装作业的实时状态。
   *
   * 「注册表里没有这一条」与「读不到」是两件事，得分开对待：
   * · 缺席是自愈信号。宿主在显式 `remove()`（@deepseek-ai/dsh-jobs-local
   *   `src/index.ts:340-343`）与作业服务销毁（同文件 :674-682）时都会把记录摘掉，此后
   *   `get()` 对陌生 id 抛 `unknown job <id>`（:399-400）。把这种抛错当成「还在跑」，
   *   下一次安装就永远被拒，而那份旧作业其实已经不存在。
   * · 读失败仍然 fail-closed：上一次安装可能还在写 venv/state.json，把它当成 null 就会
   *   放行第二次安装（两个安装器同时写同一份状态）。
   * 所以先用不抛错的 `list()` 判存在性（`src/index.ts:310-314`：无主作业对任何 caller 都
   * 可见，本包建作业不记 owner），确认还在册才用 `get()` 读状态。
   *
   * @param jobs - 当前作业注册表
   * @returns 仍在跑的作业；没有、已终态或注册表已不认识这条时为 null
   */
  private liveJob(jobs: RuntimeJobs): TrackedJob | null {
    if (this.job === null) {
      return null;
    }
    const tracked = this.job;
    if (!jobs.list().some((view) => view.id === tracked.id)) {
      this.job = null;
      return null;
    }
    const view = jobs.get(tracked.id);
    return isLive(view.status) ? tracked : null;
  }

  public async status(): Promise<RuntimeStatusResult> {
    const jobs = this.deps.jobsOf();
    const job = this.jobView(jobs);
    const installing = job !== null && isLive(job.status) ? job.pack : undefined;
    const python = resolveRuntime({
      pythonBin: this.deps.pythonBin,
      dataDir: this.deps.dataDir,
      repoRoot: this.deps.repoRoot,
    });
    return {
      ok: true,
      packs: await packStates(this.deps.dataDir, installing),
      python: { path: python.pythonPath, via: python.via, version: python.version },
      dataDir: this.deps.dataDir,
      jobsReady: jobs !== undefined,
      job,
    };
  }

  public installPack(request: unknown): RuntimeActionResult {
    return this.start(request, "install");
  }

  public repairPack(request: unknown): RuntimeActionResult {
    return this.start(request, "repair");
  }

  private start(request: unknown, action: "install" | "repair"): RuntimeActionResult {
    const record = isRecord(request) ? request : undefined;
    const raw = record === undefined ? undefined : field(record, "pack");
    if (!isRuntimePack(raw)) {
      return refused(400, `pack must be one of ${RUNTIME_PACKS.join("|")}`);
    }
    const jobs = this.deps.jobsOf();
    if (jobs === undefined) {
      return refused(503, "this profile has no jobs backend; run the CLI instead");
    }
    // 互斥不能只认实例内那一条：插件重载或服务重建后拿到的是新实例（`this.job` 为 null），
    // 而上一次安装可能还在跑；按 kind 向注册表要一次现状，判断才不受实例生命周期影响。
    // `installer` 的 `install.lock` 只保证不双写，挡不住用户白等一个注定 `INSTALL_BUSY` 的作业。
    let busy: string | undefined;
    try {
      const mine = this.liveJob(jobs);
      if (mine === null) {
        const foreign = jobs
          .list()
          .find((view) => view.kind === RUNTIME_JOB_KIND && isLive(view.status));
        if (foreign !== undefined) {
          busy = String(foreign.id);
        }
      } else {
        busy = String(mine.id);
      }
    } catch (error) {
      // 读不到上一次安装的状态就不能放行：它可能还在跑，放行等于双写。
      return refused(500, `cannot read the last install job: ${String(error)}`);
    }
    if (busy !== undefined) {
      return refused(409, `another install is running: ${busy}`);
    }
    const pack = raw;
    const controller = new AbortController();
    const spec: JobSpec = {
      kind: RUNTIME_JOB_KIND,
      label: `${action} ${pack}`,
      run: (job) => {
        const progress = (line: string): void => {
          job.updateProgress(line);
          job.append(`${line}\n`, { channel: "log" });
        };
        const done = (async (): Promise<JobOutcome> => {
          try {
            await this.deps.installPackFn(pack, {
              dataDir: this.deps.dataDir,
              repoRoot: this.deps.repoRoot,
              io: this.deps.io,
              signal: controller.signal,
              onProgress: progress,
            });
            return { status: "completed" };
          } catch (error) {
            const { aborted } = controller.signal;
            const detail = aborted ? "cancelled from settings card" : String(error);
            // 原因必须落到作业输出里：作业视图只透出 status 与 output，`JobOutcome.detail`
            // 到不了卡片 —— 否则界面只看得见一个停在 "installing browser" 的 failed。
            try {
              job.append(`${aborted ? "CANCELLED" : "FAILED"}: ${detail}\n`, { channel: "log" });
            } catch {
              // 输出环形缓冲已经不认这次写入：原因进不了界面，但作业的终态照旧交回注册表。
            }
            return aborted ? { status: "killed", detail } : { status: "failed", detail };
          }
        })();
        return {
          cancel: (): void => {
            controller.abort();
          },
          done,
        };
      },
    };
    let id: JobId;
    try {
      const detach = jobs.attachController("scrapling: runtime");
      try {
        id = jobs.start(spec);
      } finally {
        detach();
      }
    } catch (error) {
      // `start` 可能在调用过 `run` 之后才失败（登记环节出问题），那时装包已经在后台跑，
      // 而 `this.job` 还没写上——不摘掉它，第二次安装就会与它同时写同一份 venv/state.json。
      controller.abort();
      return refused(500, String(error));
    }
    this.job = { id, pack };
    return { ok: true, jobId: String(id) };
  }

  public cancelJob(request: unknown): RuntimeActionResult {
    const record = isRecord(request) ? request : undefined;
    const raw = record === undefined ? undefined : field(record, "jobId");
    if (typeof raw !== "string" || raw.length === 0) {
      return refused(400, "cancel requires a jobId");
    }
    const tracked = this.job;
    if (tracked === null || String(tracked.id) !== raw) {
      return refused(404, `unknown jobId: ${raw}`);
    }
    const jobs = this.deps.jobsOf();
    if (jobs === undefined) {
      return refused(503, "this profile has no jobs backend");
    }
    if (!jobs.list().some((view) => String(view.id) === raw)) {
      // 注册表已经把这条收走（`remove()` 或服务销毁）。本包对「缺席」的规则是自愈信号，
      // 不是一次取消失败：报 404 并忘掉它，下一次安装才不会被一条已不存在的作业挡住。
      this.job = null;
      return refused(404, `unknown jobId: ${raw}`);
    }
    try {
      jobs.kill(tracked.id, undefined, "cancelled from settings card");
    } catch (error) {
      return refused(500, String(error));
    }
    return { ok: true, jobId: String(tracked.id) };
  }
}

markRemote(ScraplingRuntimeService.prototype, "status");
markRemote(ScraplingRuntimeService.prototype, "installPack");
markRemote(ScraplingRuntimeService.prototype, "repairPack");
markRemote(ScraplingRuntimeService.prototype, "cancelJob");

/** 替身上下文没有服务注册口时返回 false：少掉卡片这一栏，不让 apply 当场炸掉。 */
export function installRuntimeRemote(ctx: Context, deps: RuntimeRemoteDeps): boolean {
  const reflect: unknown = Reflect.get(ctx, "reflect");
  if (!isRecord(reflect) || typeof field(reflect, "provide") !== "function") {
    return false;
  }
  // oxlint-disable-next-line eslint/no-new -- 构造即注册，返回值无意义
  new ScraplingRuntimeService(ctx, deps);
  return true;
}
