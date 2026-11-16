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
import { errorCodeOf, packStates } from "./installer.ts";
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
 *
 * **从尾窗起点读，而不是从 0 读全量**：安装是分钟级的，pip / patchright 的输出能到几百 KB，
 * 而卡片每 2 秒轮询一次 `status()`。从 0 读等于每次轮询都把整份输出搬一遍，开销随安装时长
 * 线性增长；`readAt` 接受任意起点（返回与该窗口相交的保留块），而窗口外的内容本来也会被
 * {@link outputOf} 截掉。
 *
 * @param jobs - 作业注册表
 * @param id - 作业 id
 * @param total - 该作业当前已写入的字节数（`JobView.output.total`，即下一块的起始偏移）
 * @returns 尾部窗口内的文本；读不到时为空串
 */
function outputTextOf(jobs: RuntimeJobs, id: JobId, total: number): string {
  try {
    const from = Math.max(0, total - JOB_OUTPUT_VIEW_CHARS);
    return outputOf(jobs.readAt(id, from));
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
    let total: number;
    try {
      // 一次取两位：状态进视图，`output.total` 是尾窗起点的算式输入。
      const {
        status: current,
        output: { total: written },
      } = jobs.get(tracked.id);
      status = current;
      total = written;
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
      output: outputTextOf(jobs, tracked.id, total),
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
      packs: await this.packsOrEmpty(installing),
      python: { path: python.pythonPath, via: python.via, version: python.version },
      dataDir: this.deps.dataDir,
      jobsReady: jobs !== undefined,
      job,
    };
  }

  /**
   * 读能力包状态；读不出来时退成「全部未装」，不让整张卡跟着崩。
   *
   * `packStates` 会读 `runtime/state.json`，而那份文件在中断的安装、磁盘写坏、旧版本留下的
   * 半截 JSON 上会让 `readRuntimeState` 显式抛 `INSTALL_STATE_CORRUPT`。让这个异常从
   * `status()` 冒出去，后果是卡片收到失败、`snapshot` 停在 null，于是**所有能力包一起显示成
   * 未知、四个安装/修复按钮全被禁**（`src/settings-card.ts` 的 `disabled = … || snapshot === null`）
   * —— 恰恰在最需要那个按钮去修复的时候它不可点。降级成「未装」至少让人能点安装，而安装器
   * 自己会处理坏状态文件（`installCapabilityPack` 里对 `INSTALL_STATE_CORRUPT` 有明确出路）。
   *
   * @param installing - 正在安装的那个包，写进 `installing` 位
   * @returns 能力包状态；读状态失败时是空对象
   */
  private async packsOrEmpty(
    installing: RuntimePack | undefined,
  ): Promise<RuntimeStatusResult["packs"]> {
    try {
      return await packStates(this.deps.dataDir, installing);
    } catch {
      return {};
    }
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
          // 进度回调不能把安装本身打掉：`installCapabilityPack` 是把它当同步回调在 await 链里
          // 调的，这里抛出去会一路冒到 `done` 的 catch，把**已经成功**的安装写成 failed。
          // 输出环形缓冲读过上限、作业已被 kill 收走都会让 `append` 抛，那时唯一正确的做法是
          // 丢掉这一行进度的展示，安装照旧往下走（成败只由 installPackFn 说了算）。
          try {
            job.updateProgress(line);
          } catch {
            // 进度位是展示面：写不进去不影响安装。
          }
          try {
            job.append(`${line}\n`, { channel: "log" });
          } catch {
            // 输出环形缓冲已经不认这次写入：日志少一行，安装继续。
          }
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
            // 取消有自己的错误码，不再靠 `signal.aborted` 反推：安装器中途被叫停时抛的是
            // `INSTALL_CANCELLED`，这条判据在那时成立，而「信号被 abort 了但安装是另一条
            // 路径失败的」也不会被误读成取消。
            const { aborted } = controller.signal;
            const cancelled = aborted || errorCodeOf(error) === "INSTALL_CANCELLED";
            const detail = cancelled ? "cancelled from settings card" : String(error);
            // 原因必须落到作业输出里：作业视图只透出 status 与 output，`JobOutcome.detail`
            // 到不了卡片 —— 否则界面只看得见一个停在 "installing browser" 的 failed。
            try {
              job.append(`${cancelled ? "CANCELLED" : "FAILED"}: ${detail}\n`, { channel: "log" });
            } catch {
              // 输出环形缓冲已经不认这次写入：原因进不了界面，但作业的终态照旧交回注册表。
            }
            return cancelled ? { status: "killed", detail } : { status: "failed", detail };
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
      //
      // 这里只能 abort，没有第二条路可走：按 `JobRegistry.start` 的契约，抛出去的 start
      // **不留任何登记**（`@deepseek-ai/dsh-jobs` 的 `start` 文档：「A throwing starter leaves
      // nothing registered」），所以既没有 job id 可以 kill，`list()` 里也扫不到它。手上唯一
      // 的把手就是这次安装自己的 `AbortSignal`。而「下一次安装会不会与它撞车」不靠这条注释
      // 保证：`start` 顶部那段按 kind 的 foreign 扫描读的是注册表现状，那条路径独立成立。
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
    // 这层判存在性也包 try：`list()` 读的是注册表内部状态，读失败与 `start` 里那次
    // 同源。不包的话异常会直接从 Remote 调用冒到卡片，用户看到的是 `String(error)` 的原始
    // 堆栈串，而不是本包统一的那句「取消没能完成」。
    let listed: boolean;
    try {
      listed = jobs.list().some((view) => String(view.id) === raw);
    } catch (error) {
      return refused(500, `cannot read the job list: ${String(error)}`);
    }
    if (!listed) {
      // 注册表已经把这条收走（`remove()` 或服务销毁）。本包对「缺席」的规则是自愈信号，
      // 不是一次取消失败：报 404 并忘掉它，下一次安装才不会被一条已不存在的作业挡住。
      this.job = null;
      return refused(404, `unknown jobId: ${raw}`);
    }
    let outcome: "requested" | "already-finished";
    try {
      outcome = jobs.kill(tracked.id, undefined, "cancelled from settings card");
    } catch (error) {
      return refused(500, String(error));
    }
    // 「这条作业早就结束了」不是取消成功：`kill` 对终态作业如实回 `already-finished`
    // 且什么都没做，把它报成 `{ ok: true }` 会让卡片显示「已取消」，而安装其实已经以
    // 别的结论收场。按 409 报，卡片读得懂（与「另一个安装在跑」同一档语义）。
    if (outcome === "already-finished") {
      this.job = null;
      return refused(409, `job ${raw} already finished; nothing to cancel`);
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
