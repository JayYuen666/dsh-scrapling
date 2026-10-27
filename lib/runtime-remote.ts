// runtime 设置卡的宿主读面：官方 Typert Remote（status / install / repair / cancel）。
//
// 为什么是 Remote：安装是宿主进程里的动作（下载 Python、建 venv、装 Chromium），卡片跑在
// 浏览器里，设置面没有执行宿主动作的口子。这条面在 apply 的早期就注册 —— 即使这台机器
// 根本没有 Python、sidecar 起不来，用户也要能从卡片里把它装上。
//
// 作业走宿主注册表（ctx.jobs）：一次安装是分钟级的，不能卡住 Remote 调用；卡片按 job id
// 轮询 status，进度从作业输出环读。取消只叫停作业并把后续步骤挡住：正在跑的 pip / tar
// 这一拍不可中断（InstallerIO 没有信号面），这是已知粒度，不把它说成“立即停止”。

import type { Context } from "@deepseek-ai/cordis";
import type { JobId, JobOutcome, JobOutputRead, JobRegistry, JobSpec } from "@deepseek-ai/dsh-jobs";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { packStates } from "./installer.ts";
import type { installCapabilityPack, InstallerIO } from "./installer.ts";
import { resolveRuntime } from "./runtime.ts";
import { RUNTIME_REMOTE_NAMESPACE, isRuntimePack } from "./runtime-shape.ts";
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
  "start" | "attachController" | "get" | "readAt" | "kill"
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
 * 设置卡「运行环境」的宿主读面。
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
    try {
      const view = jobs.get(this.job.id);
      return {
        id: String(this.job.id),
        pack: this.job.pack,
        status: view.status,
        output: outputOf(jobs.readAt(this.job.id, 0)),
      };
    } catch {
      // 注册表不认这条了（被重载或已收走）：卡片按“没有作业”处理，不把旧读数当现状。
      return null;
    }
  }

  /**
   * 读上一次安装作业的实时状态。
   *
   * 读失败**不**等于「没有作业」：上一次安装可能还在写 venv/state.json，把这个失败
   * 当成 null 就会放行第二次安装（两个安装器同时写同一份状态）。所以这里让异常向上
   * 走，由 start() 转成一次明确的拒收 —— fail-closed 是这里的唯一选项。
   *
   * @param jobs - 当前作业注册表
   * @returns 仍在跑的作业；没有或已终态时为 null
   */
  private liveJob(jobs: RuntimeJobs): TrackedJob | null {
    if (this.job === null) {
      return null;
    }
    const view = jobs.get(this.job.id);
    return isLive(view.status) ? this.job : null;
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
      return refused(400, "pack must be one of core|browser|search|media|adaptive-redis|mcp");
    }
    const jobs = this.deps.jobsOf();
    if (jobs === undefined) {
      return refused(503, "this profile has no jobs backend; run the CLI instead");
    }
    let running: TrackedJob | null;
    try {
      running = this.liveJob(jobs);
    } catch (error) {
      // 读不到上一次安装的状态就不能放行：它可能还在跑，放行等于双写。
      return refused(500, `cannot read the last install job: ${String(error)}`);
    }
    if (running !== null) {
      return refused(409, `another install is running: ${String(running.id)}`);
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
            return controller.signal.aborted
              ? { status: "killed", detail: "cancelled from settings card" }
              : { status: "failed", detail: String(error) };
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
    if (this.job === null || String(this.job.id) !== raw) {
      return refused(404, `unknown jobId: ${raw}`);
    }
    const jobs = this.deps.jobsOf();
    if (jobs === undefined) {
      return refused(503, "this profile has no jobs backend");
    }
    try {
      jobs.kill(this.job.id, undefined, "cancelled from settings card");
    } catch (error) {
      return refused(500, String(error));
    }
    return { ok: true, jobId: String(this.job.id) };
  }
}

/**
 * 标准装饰器的程序化调用：源码不引装饰器语法，构建与测试解析器就不必挂降级管线。
 * 与 `dsh-zvec-grep/lib/rebuild-remote.ts` 的 `markRemote` 同形。
 */
function markRemote(prototype: ScraplingRuntimeService, methodName: string): void {
  const context = {
    kind: "method",
    name: methodName,
    static: false,
    private: false,
    addInitializer: (initializer: (this: unknown) => void): void => {
      Reflect.apply(initializer, Object.create(prototype), []);
    },
  };
  // oxlint-disable-next-line eslint/new-cap -- Remote(…) 是装饰器工厂，不是大写开头的构造调用
  const decorate = Remote(methodName);
  Reflect.apply(decorate, undefined, [Reflect.get(prototype, methodName), context]);
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
