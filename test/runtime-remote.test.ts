// lib/runtime-remote.ts / src/runtime-reader.ts 的直测：真 Context 注册、四个方法的源模式
// 契约、作业编排与客户端读取器。不起真进程，也不经 HTTP/网关。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mockPlatform } from "./managed-host.ts";
import { Context } from "@deepseek-ai/cordis";
import type {
  JobHandle,
  JobHooks,
  JobId,
  JobOutcome,
  JobSpec,
  JobView,
} from "@deepseek-ai/dsh-jobs";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { InstallError } from "../lib/installer.ts";
import { installRuntimeRemote, ScraplingRuntimeService } from "../lib/runtime-remote.ts";
import type { RuntimeJobs, RuntimeRemoteDeps } from "../lib/runtime-remote.ts";
import { RUNTIME_PACKS, RUNTIME_REMOTE_NAMESPACE } from "../lib/runtime-shape.ts";
import { RUNTIME_DESCRIPTORS, createRuntimeReader } from "../src/runtime-reader.ts";
import type { RemoteHost } from "../src/runtime-reader.ts";

const created: string[] = [];
const CORE = "core";
const BROWSER = "browser";
const MANIFEST_STATE = "state.json";
const CHROMIUM_DIR = "chromium-1";
/** 一次注定的安装失败；原因要能在作业输出里读到。 */
const PIP_FAILURE = "pip blew up";
const INSTALL_REFUSED = "install was refused";
const READER_MISSING = "reader missing";
const JOB_KIND = "scrapling-runtime";

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-runtime-remote-"));
  created.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeState(dataDir: string, packs: unknown): void {
  mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
  writeFileSync(path.join(dataDir, "runtime", MANIFEST_STATE), JSON.stringify({ packs }));
}

function installCoreFiles(dataDir: string): void {
  const bin = path.join(dataDir, "runtime", "venv", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "python3"), "#!/bin/sh\n", { mode: 0o755 });
}

function installBrowserFiles(dataDir: string): void {
  const dir = path.join(dataDir, "runtime", "browsers", CHROMIUM_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Chromium"), "");
}

function packInstaller(dataDir: string): Pick<RuntimeRemoteDeps, "installPackFn"> {
  return {
    installPackFn: async (pack, options) => {
      options.onProgress?.(`installing ${pack}`);
      installCoreFiles(dataDir);
      writeState(dataDir, { core: "ready" });
      if (pack === "browser") {
        installBrowserFiles(dataDir);
        writeState(dataDir, { core: "ready", browser: "ready" });
      }
      options.onProgress?.(`${pack} ready`);
    },
  };
}

async function recordOutcome(
  done: Promise<JobOutcome>,
  record: (outcome: JobOutcome) => void,
): Promise<void> {
  record(await done);
}

interface FakeJobs {
  registry: RuntimeJobs | undefined;
  hooks: Map<string, JobHooks>;
  specs: JobSpec[];
  views: Map<string, JobView["status"]>;
  outputs: Map<string, string>;
  progress: Map<string, string[]>;
  kills: string[];
  /** attachController 与它交回的 detach 各被调用了几次。 */
  readonly attached: number;
  readonly detached: number;
  /** 让注册表忘掉所有记录，对齐宿主 `remove()` 与服务销毁后的状态。 */
  forget: () => void;
}

function fakeJobs(
  options: {
    jobs?: boolean;
    getThrows?: boolean;
    readThrows?: boolean;
    startThrows?: boolean;
    /** 走完 `run` 再抛：注册环节在作业已经起跑之后才失败的那一档。 */
    startThrowsAfterRun?: boolean;
    killThrows?: boolean;
    /** `list()` 抛：注册表内部状态读不出来。 */
    listThrows?: boolean;
    /** 输出写入与进度更新都抛：环形缓冲读过上限、作业被 kill 收走时的形态。 */
    writesThrow?: boolean;
  } = {},
): FakeJobs {
  const hooks = new Map<string, JobHooks>();
  const specs: JobSpec[] = [];
  const views = new Map<string, JobView["status"]>();
  const outputs = new Map<string, string>();
  const progress = new Map<string, string[]>();
  const kills: string[] = [];
  let sequence = 0;
  let forgotten = false;
  let attached = 0;
  let detached = 0;
  /** 一条作业拿到的写入接口：输出与进度都记进各自的表。 */
  const handleOf = (id: string): JobHandle => ({
    id: id as never,
    append: (text: string): void => {
      if (options.writesThrow === true) {
        throw new Error("output buffer is gone");
      }
      outputs.set(id, (outputs.get(id) ?? "") + text);
    },
    updateProgress: (line: string): void => {
      if (options.writesThrow === true) {
        throw new Error("output buffer is gone");
      }
      progress.set(id, [...(progress.get(id) ?? []), line]);
    },
  });
  const registry = {
    // 服务侧的契约是「起作业时必须自己挂 controller，并在 start 之后立刻摘掉」
    // （lib/runtime-remote.ts 里那层嵌套 try/finally）。计数让这条契约可断言。
    attachController: (): (() => void) => {
      attached += 1;
      return (): void => {
        detached += 1;
      };
    },
    start: (spec: JobSpec): JobId => {
      if (options.startThrows === true) {
        throw new Error("start blew up");
      }
      if (options.startThrowsAfterRun === true) {
        // 先让 `run` 起跑（真实注册表的 `start` 就是这个次序：调过生产者再登记），再抛。
        const late = "scrapling-runtime-late";
        hooks.set(late, spec.run(handleOf(late)));
        throw new Error("registry refused the job");
      }
      const id = `scrapling-runtime-${String(sequence)}`;
      sequence += 1;
      specs.push(spec);
      const handle = handleOf(id);
      const createdHooks = spec.run(handle);
      hooks.set(id, createdHooks);
      views.set(id, "running");
      void recordOutcome(createdHooks.done, (outcome) => {
        views.set(id, outcome.status);
      });
      return id as never;
    },
    list: (): JobView[] => {
      if (options.listThrows === true) {
        throw new Error("registry store is unreadable");
      }
      return forgotten
        ? []
        : Array.from(views.keys(), (id) => ({
            id: id as never,
            kind: JOB_KIND,
            label: "runtime",
            status: views.get(id) ?? "running",
            startedAt: 0,
            output: { total: 0, earliest: 0 },
          }));
    },
    get: (id: JobId): JobView => {
      if (forgotten) {
        // 宿主对陌生 id 的说法：jobs-local src/index.ts:399-400。
        throw new Error(`unknown job ${String(id)}`);
      }
      if (options.getThrows === true) {
        throw new Error("no view");
      }
      const status = views.get(String(id)) ?? "running";
      return {
        id,
        kind: JOB_KIND,
        label: "runtime",
        status,
        startedAt: 0,
        // `total` 是下一块的起始偏移：服务侧拿它算尾窗起点，写死 0 会让「只读尾部」
        // 这条优化在测试里退化成「从 0 读全量」，把要测的东西测掉。
        output: { total: (outputs.get(String(id)) ?? "").length, earliest: 0 },
      };
    },
    readAt: (id: JobId, from: number) => {
      if (options.readThrows === true) {
        throw new Error("no read");
      }
      // 与宿主契约一致：返回**与 `[from, total)` 相交的整块**（`chunks` 按偏移序、切点只在块边界），
      // `next` 是环当前的 `total`。夹具把整份输出当成一块 —— 这正是「一次 append 写了很多字节」
      // 的形态，也是服务侧即使按尾窗起点读、仍要自己再截一次的原因（块是整块交回的）。
      // 第一版返回的是从 `from` 处切开的窄块，于是「块比窗口大」这条根本不存在，
      // `outputOf` 的截尾分支在测试里永远走不到。
      const text = outputs.get(String(id)) ?? "";
      const overlaps = text.length > 0 && from < text.length;
      return {
        chunks: overlaps ? [{ at: 0, text }] : [],
        next: text.length,
        lossy: false,
      };
    },
    kill: (id: JobId): "requested" | "already-finished" => {
      if (options.killThrows === true) {
        throw new Error("kill blew up");
      }
      // 与宿主一致：对已终态的作业如实回 `already-finished`，且什么都不做
      // （jobs-local 的 kill 在状态不是 running/stopping 时直接返回这个值）。
      const current = views.get(String(id)) ?? "running";
      if (current !== "running" && current !== "stopping") {
        return "already-finished";
      }
      kills.push(String(id));
      views.set(String(id), "killed");
      hooks.get(String(id))?.cancel("killed");
      return "requested";
    },
  };
  return {
    registry: options.jobs === false ? undefined : registry,
    hooks,
    specs,
    views,
    outputs,
    progress,
    kills,
    /** attachController 被调用了几次。 */
    get attached(): number {
      return attached;
    },
    /** 交回的 detach 被调用了几次。 */
    get detached(): number {
      return detached;
    },
    forget: (): void => {
      forgotten = true;
    },
  };
}

function depsOf(
  dataDir: string,
  jobs: FakeJobs,
  overrides: Partial<RuntimeRemoteDeps> = {},
): RuntimeRemoteDeps {
  return {
    dataDir,
    repoRoot: tempDir(),
    pythonBin: "",
    io: {} as never,
    jobsOf: () => jobs.registry,
    ...packInstaller(dataDir),
    ...overrides,
  };
}

function serviceOf(ctx: Context): ScraplingRuntimeService {
  const service: unknown = ctx.get(RUNTIME_REMOTE_NAMESPACE);
  if (!(service instanceof ScraplingRuntimeService)) {
    throw new TypeError("runtime service was not registered");
  }
  return service;
}

describe("官方 Typert Remote：runtime 服务", () => {
  let restorePlatform: (() => void) | undefined;
  beforeAll(() => {
    restorePlatform = mockPlatform("darwin", "arm64");
  });
  afterEach(cleanup);

  afterAll(() => {
    restorePlatform?.();
  });

  it("装进真 Context，四个方法都带 @Remote 标记", () => {
    const jobs = fakeJobs();
    const ctx = new Context();
    const deps = depsOf(tempDir(), jobs);
    expect(installRuntimeRemote(ctx, deps)).toBe(true);
    expect(
      remoteMethods(serviceOf(ctx))
        .map((marker) => marker.method)
        .toSorted(),
    ).toStrictEqual(["cancelJob", "installPack", "repairPack", "status"]);
  });

  it("客户端 descriptor 与宿主标记逐项对质", () => {
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const methods = remoteMethods(serviceOf(ctx))
      .map((marker) => marker.method)
      .toSorted();
    expect(RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.method).toSorted()).toStrictEqual(
      methods,
    );
    for (const descriptor of RUNTIME_DESCRIPTORS) {
      expect(descriptor.service).toBe(RUNTIME_REMOTE_NAMESPACE);
      expect(descriptor.namespace).toBe(RUNTIME_REMOTE_NAMESPACE);
      expect(descriptor.result.mode).toBe("src-json");
    }
    for (const descriptor of RUNTIME_DESCRIPTORS.filter((item) => item.method !== "status")) {
      expect(descriptor.parameters.map((parameter) => parameter.wire)).toStrictEqual(["request"]);
    }
  });

  it("注册口缺席时返回 false", () => {
    const deps = depsOf(tempDir(), fakeJobs());
    expect(installRuntimeRemote({} as never, deps)).toBe(false);
  });

  it("空 dataDir：六个包全都 missing", async () => {
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const status = await serviceOf(ctx).status();
    expect(status.packs.core).toBe("missing");
    expect(status.packs.browser).toBe("missing");
    expect(status.packs.search).toBe("missing");
    expect(status.packs.media).toBe("missing");
    expect(status.packs["adaptive-redis"]).toBe("missing");
    expect(status.packs.mcp).toBe("missing");
    expect(status.job).toBeNull();
    expect(status.jobsReady).toBe(true);
    expect(status.python.via).toBe("path");
  });

  it("state 标 ready 但文件不在：core 与 browser 都是 corrupt", async () => {
    const dataDir = tempDir();
    writeState(dataDir, { core: "ready", browser: "ready" });
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, fakeJobs()));
    const status = await serviceOf(ctx).status();
    expect(status.packs.core).toBe("corrupt");
    expect(status.packs.browser).toBe("corrupt");
  });

  it("state.json 坏成半截 JSON 时读成「都没装」，不让整张卡的安装按钮跟着禁掉", async () => {
    // `readRuntimeState` 对坏状态文件显式抛 INSTALL_STATE_CORRUPT。让它从 status() 冒出去，
    // 卡片就收到失败、snapshot 停在 null，而 `src/settings-card.ts` 的
    // `disabled = busy !== "" || !jobsReady || snapshot === null` 会把四个安装/修复按钮
    // 全禁掉 —— 恰恰在最需要按它去修的时候不可点。降级成空对象至少还能点安装重来。
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    writeFileSync(path.join(dataDir, "runtime", MANIFEST_STATE), '{"packs": {"core": ');
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, fakeJobs()));
    const status = await serviceOf(ctx).status();
    expect(status.ok).toBe(true);
    expect(status.packs).toStrictEqual({});
    expect(status.jobsReady).toBe(true);
  });

  it("进度写入抛错时安装照旧完成，不被展示面拖成 failed", async () => {
    // `progress` 回调在 installCapabilityPack 的 await 链里被同步调用，抛出去会一路冒到
    // `done` 的 catch，把**已经成功**的安装写成 failed。输出环形缓冲读过上限、作业被 kill
    // 收走都会让 append 抛，那时唯一正确的做法是丢掉这一行的展示。
    const dataDir = tempDir();
    const jobs = fakeJobs({ writesThrow: true });
    const ctx = new Context();
    installRuntimeRemote(ctx, {
      ...depsOf(dataDir, jobs),
      installPackFn: async (pack, options): Promise<void> => {
        installCoreFiles(dataDir);
        writeState(dataDir, { core: "ready" });
        options.onProgress?.(`installing ${pack}`);
      },
    });
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const hooks = jobs.hooks.get(started.jobId);
    if (hooks === undefined) {
      throw new TypeError("job hooks were not recorded");
    }
    const outcome = await hooks.done;
    expect(outcome.status).toBe("completed");
    const status = await service.status();
    expect(status.packs.core).toBe("ready");
  });

  it("文件齐了就是 ready，解释器按显式配置走", async () => {
    const dataDir = tempDir();
    writeState(dataDir, { core: "ready", browser: "ready" });
    installCoreFiles(dataDir);
    installBrowserFiles(dataDir);
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, fakeJobs(), { pythonBin: "/x/python3" }));
    const status = await serviceOf(ctx).status();
    expect(status.packs.core).toBe("ready");
    expect(status.packs.browser).toBe("ready");
    expect(status.python).toMatchObject({ path: "/x/python3", via: "configured" });
  });

  it("install 拒绝未知包；adaptive-redis 与 mcp 都已可安装", async () => {
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), fakeJobs()));
    const service = serviceOf(ctx);
    expect(service.installPack(null).ok).toBe(false);
    expect(service.installPack({ pack: "nope" }).ok).toBe(false);
    // 同一时刻只允许一条安装作业：两个包各起一个服务来验「不再被拦」。
    expect(service.installPack({ pack: "adaptive-redis" }).ok).toBe(true);
    const second = new Context();
    installRuntimeRemote(second, depsOf(tempDir(), fakeJobs()));
    expect(serviceOf(second).installPack({ pack: "mcp" }).ok).toBe(true);
  });

  it("没有作业后端时 install 退 503", async () => {
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), fakeJobs({ jobs: false })));
    const service = serviceOf(ctx);
    expect(service.installPack({ pack: CORE })).toMatchObject({ ok: false, status: 503 });
    const status = await service.status();
    expect(status.jobsReady).toBe(false);
  });

  it("install core：作业落到注册表，状态从输出环形缓冲读，完成后 core 变 ready", async () => {
    const dataDir = tempDir();
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, jobs));
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const { jobId } = started;
    const running = await service.status();
    expect(running.packs.core).toBe("installing");
    expect(running.job?.id).toBe(jobId);
    expect(running.job?.output).toContain("installing core");
    const finished = await jobs.hooks.get(jobId)?.done;
    // 不加判空地 await，会在 hooks 缺席时静默 resolve 成 undefined，作业到底有没有跑完、是不是 failed
    // 都不影响这条用例通过——结算状态必须断出来。
    expect(finished?.status).toBe("completed");
    // append 之外那条并行通道：progress 一直被填却从没人读过。
    expect(jobs.progress.get(jobId)).toStrictEqual(["installing core", "core ready"]);
    // 起了几次 controller 就得摘掉几次，包括 start 之后那一步。
    expect([jobs.attached, jobs.detached]).toStrictEqual([1, 1]);
    const done = await service.status();
    expect(done.packs.core).toBe("ready");
    expect(done.job?.status).toBe("completed");
    expect(jobs.specs[0]?.kind).toBe("scrapling-runtime");
    expect(jobs.specs[0]?.label).toBe("install core");
  });

  it("browser 包在 core 之后装浏览器", async () => {
    const dataDir = tempDir();
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, jobs));
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: BROWSER });
    if (!started.ok) {
      throw new Error("browser install was refused");
    }
    const finished = await jobs.hooks.get(started.jobId)?.done;
    expect(finished?.status).toBe("completed");
    const status = await service.status();
    expect(status.packs.browser).toBe("ready");
    expect(status.job?.status).toBe("completed");
  });

  it("repair 走同一条编排，标签不同", async () => {
    const dataDir = tempDir();
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, jobs));
    const started = serviceOf(ctx).repairPack({ pack: CORE });
    if (!started.ok) {
      throw new Error("repair was refused");
    }
    expect(jobs.specs[0]?.label).toBe("repair core");
    const finished = await jobs.hooks.get(started.jobId)?.done;
    expect(finished?.status).toBe("completed");
  });

  it("终态作业不挡下一次安装", async () => {
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const service = serviceOf(ctx);
    const first = service.installPack({ pack: CORE });
    if (!first.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const firstOutcome = await jobs.hooks.get(first.jobId)?.done;
    expect(firstOutcome?.status).toBe("completed");
    const second = service.installPack({ pack: BROWSER });
    expect(second.ok).toBe(true);
    expect(jobs.specs[1]?.label).toBe("install browser");
    if (!second.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const secondOutcome = await jobs.hooks.get(second.jobId)?.done;
    expect(secondOutcome?.status).toBe("completed");
  });

  it("读数抛错时拒绝第二次安装，而不是当成没有作业放行", () => {
    // fail-closed：读不到上一次作业的状态，就不能断言它已经结束。原先这里把异常
    // 当成 null，于是第二次安装照样启动 —— 两个安装器会同时写 venv/state.json。
    const jobs = fakeJobs({ getThrows: true });
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const service = serviceOf(ctx);
    expect(service.installPack({ pack: CORE }).ok).toBe(true);
    const second = service.installPack({ pack: CORE });
    expect(second).toMatchObject({ ok: false, status: 500 });
    if (second.ok) {
      throw new Error("the second install was not refused");
    }
    // 拒收理由要可路由：带上注册表那次读失败的原因。
    expect(second.error).toContain("no view");
    // 第二次真的没被启动：作业表里仍然只有第一条。
    expect(jobs.specs).toHaveLength(1);
  });

  it("注册表已不认识那条作业时放行下一次安装，并把陈旧的作业读数丢掉", async () => {
    // 缺席与读失败不是一回事：宿主会在 remove() 与作业服务销毁时摘掉记录
    // （@deepseek-ai/dsh-jobs-local src/index.ts:340-343、:674-682），此后 get() 抛
    // unknown job。把这种抛错当「还在跑」会让安装按钮永久 500。
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const service = serviceOf(ctx);
    expect(service.installPack({ pack: CORE }).ok).toBe(true);
    jobs.forget();
    const second = service.installPack({ pack: CORE });
    expect(second.ok).toBe(true);
    expect(jobs.specs).toHaveLength(2);
    // 卡片不再拿那条陌生作业当现状。
    const view = await service.status();
    expect(view.job).toBeNull();
  });

  it("同一时刻只允许一条安装作业", async () => {
    // 第一次安装显式停在 running（安装函数等一枚 gate），409 才是「有作业在跑所以挡」的判据。
    // 原先两次 installPack 落在同一个 tick 才读得到 running：替身的 views 是同步写的、
    // 安装函数里又没有任何 await，用例中间一旦插入等待第一条就落成 completed，这条会静默失效。
    const gate = Promise.withResolvers<undefined>();
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(
      ctx,
      depsOf(tempDir(), jobs, {
        installPackFn: async (): Promise<void> => {
          await gate.promise;
        },
      }),
    );
    const service = serviceOf(ctx);
    const first = service.installPack({ pack: CORE });
    if (!first.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const running = await service.status();
    expect(running.job?.status).toBe("running");
    expect(service.installPack({ pack: CORE })).toMatchObject({ ok: false, status: 409 });
    gate.resolve(undefined);
    const outcome = await jobs.hooks.get(first.jobId)?.done;
    expect(outcome?.status).toBe("completed");
  });

  it("注册表 start 抛错时退 500，controller 照样摘掉", () => {
    const jobs = fakeJobs({ startThrows: true });
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    expect(serviceOf(ctx).installPack({ pack: CORE })).toMatchObject({ ok: false, status: 500 });
    // 服务侧那句 `try { jobs.start(spec) } finally { detach() }`：把 finally 去掉或只在成功
    // 路径摘，就等于往宿主那一层常驻一扇「有人能收这桶作业」的闸门。
    expect([jobs.attached, jobs.detached]).toStrictEqual([1, 1]);
  });

  it("安装失败落成 failed 作业，detail 带原因", async () => {
    const dataDir = tempDir();
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(
      ctx,
      depsOf(dataDir, jobs, {
        installPackFn: async () => {
          throw new Error("pip exploded");
        },
      }),
    );
    const started = serviceOf(ctx).installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const outcome = await jobs.hooks.get(started.jobId)?.done;
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toContain("pip exploded");
  });

  it("取消：坏请求 400、归属不符 404、kill 抛错 500、成功叫停作业", async () => {
    const dataDir = tempDir();
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, jobs));
    const service = serviceOf(ctx);
    expect(service.cancelJob(null)).toMatchObject({ ok: false, status: 400 });
    expect(service.cancelJob({ jobId: "" })).toMatchObject({ ok: false, status: 400 });
    expect(service.cancelJob({ jobId: "someone-else" })).toMatchObject({ ok: false, status: 404 });
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    expect(service.cancelJob({ jobId: started.jobId })).toMatchObject({ ok: true });
    expect(jobs.kills).toStrictEqual([started.jobId]);

    // 没有作业后端时读到的仍是 404：cancelJob 先按本服务记录的归属判（`this.job === null`
    // 那一支在取 jobsOf 之前），503 只在「归属对上而后端没了」时出现——那是下一条的用例。
    const noJobs = fakeJobs({ jobs: false });
    const noJobsCtx = new Context();
    installRuntimeRemote(noJobsCtx, depsOf(tempDir(), noJobs));
    expect(serviceOf(noJobsCtx).cancelJob({ jobId: "x" })).toMatchObject({
      ok: false,
      status: 404,
    });

    const killing = fakeJobs({ killThrows: true });
    const killingCtx = new Context();
    installRuntimeRemote(killingCtx, depsOf(tempDir(), killing));
    const killingService = serviceOf(killingCtx);
    const running = killingService.installPack({ pack: CORE });
    if (!running.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    expect(killingService.cancelJob({ jobId: running.jobId })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  it("作业后端在运行中消失：cancel 退 503", async () => {
    const jobs = fakeJobs();
    let live = true;
    const ctx = new Context();
    installRuntimeRemote(
      ctx,
      depsOf(tempDir(), jobs, { jobsOf: () => (live ? jobs.registry : undefined) }),
    );
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    live = false;
    expect(service.cancelJob({ jobId: started.jobId })).toMatchObject({ ok: false, status: 503 });
  });

  it("注册表读不出清单时 cancel 报 500，而不是把原始异常甩给卡片", async () => {
    const jobs = fakeJobs();
    const realRegistry = jobs.registry;
    if (realRegistry === undefined) {
      throw new Error("作业后端没到位");
    }
    let broken = false;
    const ctx = new Context();
    installRuntimeRemote(
      ctx,
      depsOf(tempDir(), jobs, {
        jobsOf: () => ({
          ...realRegistry,
          list: () => {
            if (broken) {
              throw new Error("registry store is unreadable");
            }
            return realRegistry.list();
          },
        }),
      }),
    );
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    broken = true;
    // 判据是「本包统一的那句 + 500」：让异常直接冒出去的话，卡片拿到的是原始错误串，
    // 与这张卡其余失败回执的形态不一致。
    expect(service.cancelJob({ jobId: started.jobId })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  it("作业已经结束时 cancel 报 409，不当成取消成功", async () => {
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    // 宿主对终态作业的 kill 回 `already-finished` 且什么都不做（jobs-local 的 kill）。
    // 把它报成 `{ ok: true }` 会让卡片显示「已取消」，而安装其实以别的结论收场了。
    jobs.views.set(started.jobId, "completed");
    const refused = service.cancelJob({ jobId: started.jobId });
    expect(refused).toMatchObject({ ok: false, status: 409 });
    // 报完之后这条作业不再被本服务记着：下一次安装不该被一条已结束的作业挡住。
    expect(service.installPack({ pack: BROWSER }).ok).toBe(true);
  });

  it("state 的 packs 不是对象时按空状态处理", async () => {
    const dataDir = tempDir();
    writeState(dataDir, []);
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, fakeJobs()));
    const status = await serviceOf(ctx).status();
    expect(status.packs.core).toBe("missing");
  });

  it("browsers 路径读不到时按 corrupt 处理", async () => {
    const dataDir = tempDir();
    writeState(dataDir, { browser: "ready" });
    mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
    writeFileSync(path.join(dataDir, "runtime", "browsers"), "not a directory");
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(dataDir, fakeJobs()));
    const status = await serviceOf(ctx).status();
    expect(status.packs.browser).toBe("corrupt");
  });

  it("取消后作业落成 killed，后续步骤不再执行", async () => {
    const dataDir = tempDir();
    const jobs = fakeJobs();
    const gate = Promise.withResolvers<undefined>();
    const ctx = new Context();
    installRuntimeRemote(
      ctx,
      depsOf(dataDir, jobs, {
        installPackFn: async (_pack, options) => {
          await gate.promise;
          if (options.signal?.aborted === true) {
            throw new Error("cancelled");
          }
          installCoreFiles(dataDir);
          writeState(dataDir, { core: "ready" });
        },
      }),
    );
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    service.cancelJob({ jobId: started.jobId });
    gate.resolve(undefined);
    const outcome = await jobs.hooks.get(started.jobId)?.done;
    expect(outcome?.status).toBe("killed");
    expect(outcome?.detail).toContain("cancelled");
  });

  // 取消的判据有两处：信号被 abort，以及安装器自己抛 `INSTALL_CANCELLED`。后者必须单独
  // 钉住 —— 只按 `signal.aborted` 判的话，「信号没被 abort 但安装器如实报了取消」会被写成 failed。
  it("安装器报 INSTALL_CANCELLED 时作业落 killed，不靠信号反推", async () => {
    const dataDir = tempDir();
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(
      ctx,
      depsOf(dataDir, jobs, {
        installPackFn: async () => {
          throw new InstallError("INSTALL_CANCELLED", "install cancelled");
        },
      }),
    );
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const outcome = await jobs.hooks.get(started.jobId)?.done;
    expect(outcome?.status).toBe("killed");
    expect(outcome?.detail).toBe("cancelled from settings card");
  });

  it("作业读数坏掉时 status 不把旧读数当现状", async () => {
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), fakeJobs({ getThrows: true })));
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const status = await service.status();
    expect(status.job).toBeNull();
  });

  it("输出环形缓冲读不到时作业照旧在位，只是读不到尾部", async () => {
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), fakeJobs({ readThrows: true })));
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const status = await service.status();
    // 输出环形缓冲失效不改变「有一个安装在跑」：整份视图退回 null 会把正在装的环境显示成没在装，
    // 而卡片正是在这一位上决定要不要再给一次安装按钮。
    expect(status.job?.status).toBe("running");
    expect(status.job?.output).toBe("");
  });

  it("安装失败的原因落进作业输出，卡片看得见为什么 failed", async () => {
    const ctx = new Context();
    const jobs = fakeJobs();
    installRuntimeRemote(ctx, {
      ...depsOf(tempDir(), jobs),
      installPackFn: async (): Promise<void> => {
        throw new Error(PIP_FAILURE);
      },
    });
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const outcome = await jobs.hooks.get(started.jobId)?.done;
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toContain(PIP_FAILURE);
    // 作业视图只透出 status 与 output：detail 不进输出的话，界面就只看得见一个 failed。
    const shown = await service.status();
    expect(shown.job?.output).toContain("FAILED:");
    expect(shown.job?.output).toContain(PIP_FAILURE);
  });

  it("注册表在作业起跑之后才拒绝时，取消信号要发给那次安装", async () => {
    const ctx = new Context();
    const signals: (AbortSignal | undefined)[] = [];
    installRuntimeRemote(ctx, {
      ...depsOf(tempDir(), fakeJobs({ startThrowsAfterRun: true })),
      installPackFn: async (_pack, options): Promise<void> => {
        signals.push(options.signal);
      },
    });
    const started = serviceOf(ctx).installPack({ pack: CORE });
    if (started.ok) {
      throw new Error("a registry that refuses the job must not report it as started");
    }
    // `this.job` 没写上，但那次安装已经在跑：不 abort 就是下一次安装的互斥盲区。
    expect(signals[0]?.aborted).toBe(true);
  });

  it("服务实例换了也认得在跑的安装（按 kind 问注册表）", async () => {
    const jobs = fakeJobs();
    const dataDir = tempDir();
    const firstCtx = new Context();
    installRuntimeRemote(firstCtx, depsOf(dataDir, jobs));
    const started = serviceOf(firstCtx).installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    const secondCtx = new Context();
    installRuntimeRemote(secondCtx, depsOf(dataDir, jobs));
    const again = serviceOf(secondCtx).installPack({ pack: BROWSER });
    if (again.ok) {
      throw new Error("a live job of our kind must block a second install");
    }
    expect(again.error).toContain(started.jobId);
  });

  it("注册表收走作业后取消报 404，而不是把它报成取消失败", async () => {
    const ctx = new Context();
    const jobs = fakeJobs();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    jobs.forget();
    const refused = service.cancelJob({ jobId: started.jobId });
    if (refused.ok) {
      throw new Error("a forgotten job must not report a successful cancel");
    }
    expect(refused.status).toBe(404);
    // 缺席按自愈处理之后，同一实例不必再被这条作业挡住。
    expect(service.installPack({ pack: BROWSER }).ok).toBe(true);
  });

  it("输出超过尾窗时只留最后 4000 个字符", async () => {
    const jobs = fakeJobs();
    const ctx = new Context();
    installRuntimeRemote(ctx, depsOf(tempDir(), jobs));
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    // 同字符串里 slice(0, 4000) 与 slice(-4000) 逐字节相同，尾窗改坏也测不出来；
    // 首尾各放一个可辨识标记，长度与两端同时判。
    jobs.outputs.set(started.jobId, `HEAD${"-".repeat(5000)}TAIL`);
    const status = await service.status();
    expect(status.job?.output.length).toBe(4000);
    expect(status.job?.output.startsWith("HEAD")).toBe(false);
    expect(status.job?.output.endsWith("TAIL")).toBe(true);
  });

  it("只从尾窗起点读输出，不把整份输出搬一遍", async () => {
    const jobs = fakeJobs();
    const realRegistry = jobs.registry;
    if (realRegistry === undefined) {
      throw new Error("作业后端没到位");
    }
    // 卡片每 2 秒轮询一次，安装是分钟级的：从 0 读等于每次轮询搬一遍整份输出。
    // 判据落在 readAt 的起点上 —— 只看输出文本的话，从 0 读再截尾结果逐字节相同，
    // 那条优化整个失效也测不出来。
    const seen: number[] = [];
    const ctx = new Context();
    installRuntimeRemote(ctx, {
      ...depsOf(tempDir(), jobs),
      jobsOf: () => ({
        ...realRegistry,
        readAt: (id: JobId, from: number) => {
          seen.push(from);
          return realRegistry.readAt(id, from);
        },
      }),
    });
    const service = serviceOf(ctx);
    const started = service.installPack({ pack: CORE });
    if (!started.ok) {
      throw new Error(INSTALL_REFUSED);
    }
    jobs.outputs.set(started.jobId, `${"-".repeat(9000)}TAIL`);
    const status = await service.status();
    expect(status.job?.output.endsWith("TAIL")).toBe(true);
    // 9004 个字符（9000 个横线 + TAIL）、尾窗 4000 ⇒ 起点是 5004。
    expect(seen).toStrictEqual([5004]);
  });

  it("pack 清单覆盖计划里的六个包", () => {
    expect([...RUNTIME_PACKS]).toStrictEqual([
      CORE,
      BROWSER,
      "search",
      "media",
      "adaptive-redis",
      "mcp",
    ]);
  });
});

function namespaceStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: async () => ({
      ok: true,
      value: {
        ok: true,
        packs: {},
        python: { path: "/usr/bin/python3", via: "path", version: "3.14" },
        dataDir: "/tmp/scrapling",
        jobsReady: true,
        job: null,
      },
    }),
    installPack: async () => ({ ok: true, value: { ok: true, jobId: "job-1" } }),
    repairPack: async () => ({ ok: true, value: { ok: true, jobId: "job-2" } }),
    cancelJob: async () => ({ ok: true, value: { ok: true, jobId: "job-1" } }),
    ...overrides,
  };
}

describe("客户端读取器", () => {
  afterEach(cleanup);

  const SERVICE_KEY = `remote.${RUNTIME_REMOTE_NAMESPACE}`;

  function hostOf(options: { remote?: unknown; namespace?: unknown; mounts?: unknown[] }): {
    host: RemoteHost;
    mounts: number[];
  } {
    const mounts: number[] = [];
    let index = 0;
    const mounter = {
      $mount: async (): Promise<unknown> => {
        mounts.push(1);
        const outcomes = options.mounts;
        if (outcomes === undefined) {
          return { mounted: true };
        }
        const outcome = outcomes.at(index);
        index += 1;
        if (outcome === undefined) {
          // 不再复用最后一条：那会把「实际挂载了几次」抹平，而空清单（一份结果都不该给）
          // 经 `at(-1)` 会交回 undefined，等于把失败伪装成挂载成功。
          throw new TypeError(
            `挂载脚本只有 ${String(outcomes.length)} 条，第 ${String(index)} 次 $mount 没有对应结果`,
          );
        }
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    };
    const services = new Map<string, unknown>([
      ["remote", options.remote ?? mounter],
      [SERVICE_KEY, options.namespace ?? namespaceStub()],
    ]);
    return { mounts, host: { get: (name: string) => services.get(name) } };
  }

  it("ctx 没有 get 面时返回 undefined", () => {
    expect(createRuntimeReader({})).toBeUndefined();
  });

  it("四个方法都经网关解包", async () => {
    const { host, mounts } = hostOf({});
    const reader = createRuntimeReader(host);
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.status()).resolves.toMatchObject({ job: null });
    await expect(reader.install(CORE)).resolves.toMatchObject({ ok: true, jobId: "job-1" });
    await expect(reader.repair(BROWSER)).resolves.toMatchObject({ ok: true, jobId: "job-2" });
    await expect(reader.cancel("job-1")).resolves.toMatchObject({ ok: true });
    expect(mounts).toHaveLength(1);
  });

  it("remote 缺席或命名空间没挂上时点名报错", async () => {
    const none = createRuntimeReader(hostOf({ remote: 42 }).host);
    await expect(none?.status() ?? Promise.reject(new Error("no reader"))).rejects.toThrow(
      /remote/u,
    );
    const unmounted = createRuntimeReader(hostOf({ namespace: 42 }).host);
    await expect(unmounted?.status() ?? Promise.reject(new Error("no reader"))).rejects.toThrow(
      /未提供/u,
    );
  });

  it("线上拒绝翻成异常，挂载失败不留在缓存里", async () => {
    const failure = new Error("gateway restarted");
    const { host, mounts } = hostOf({
      mounts: [failure, { mounted: true }],
    });
    const reader = createRuntimeReader(host);
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.install(CORE)).rejects.toThrow(/gateway restarted/u);
    await expect(reader.install(CORE)).resolves.toMatchObject({ ok: true });
    expect(mounts).toHaveLength(2);
    const refusing = createRuntimeReader(
      hostOf({
        namespace: namespaceStub({
          cancelJob: async () => ({ ok: false, error: { code: "E", message: "refused" } }),
        }),
      }).host,
    );
    await expect(
      refusing?.cancel("job-1") ?? Promise.reject(new Error("no reader")),
    ).rejects.toThrow(/refused/u);
  });

  it("返回类型的拒绝码不在保留集合时判坏，不把未知状态码当合法回执", async () => {
    const reader = createRuntimeReader(
      hostOf({
        namespace: namespaceStub({
          cancelJob: async () => ({
            ok: true,
            value: { ok: false, error: "unknown refusal", status: 502 },
          }),
        }),
      }).host,
    );
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.cancel("job-1")).rejects.toThrow(/at status/u);
  });

  it("回包里的包状态不在取值域时判坏，卡片拿不到没配译名的状态串", async () => {
    // #186 那条建议要在 `packStateKey` 里加白名单；这里钉住为什么不需要：域外状态在
    // 读取器的 zod 校验就被拒，永远走不到拼译名键的那一步。
    const reader = createRuntimeReader(
      hostOf({
        namespace: namespaceStub({
          status: async () => ({
            ok: true,
            value: {
              ok: true,
              packs: { [CORE]: "draining" },
              python: { path: "/py/bin/python", via: "managed", version: "3.14.0" },
              dataDir: "/data",
              jobsReady: true,
              job: null,
            },
          }),
        }),
      }).host,
    );
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.status()).rejects.toThrow(/packs/u);
  });

  it("strict codec 拒绝未知包与空 jobId", () => {
    // 按方法名取，不按下标：清单增删或重排时硬编码下标会静默拿到别的方法的 codec，
    // 或者落到一句与真实原因无关的报错上。
    const packParameter = RUNTIME_DESCRIPTORS.find((item) => item.method === "installPack")
      ?.parameters[0];
    const cancelParameter = RUNTIME_DESCRIPTORS.find((item) => item.method === "cancelJob")
      ?.parameters[0];
    if (packParameter === undefined || cancelParameter === undefined) {
      throw new Error("descriptor 清单里少了 installPack 或 cancelJob");
    }
    if (!("codec" in packParameter) || !("codec" in cancelParameter)) {
      throw new Error("installPack / cancelJob 的入参没有 codec");
    }
    const packTypert = packParameter.codec;
    const cancelTypert = cancelParameter.codec;
    if (packTypert.mode !== "strict" || cancelTypert.mode !== "strict") {
      throw new Error("runtime request codecs must be strict");
    }
    const packParser = packTypert.create();
    const cancelParser = cancelTypert.create();
    expect(() => packParser.parse({ pack: "nope" })).toThrow(/known pack/u);
    expect(() => cancelParser.parse({ jobId: "" })).toThrow(/jobId/u);
    // 纯空白同样算「没有 jobId」：`min(1)` 只看长度，先 trim 才判得住。
    expect(() => cancelParser.parse({ jobId: "   " })).toThrow(/jobId/u);
    expect(cancelParser.parse({ jobId: " job-1 " })).toStrictEqual({ jobId: "job-1" });
    expect(packParser.parse({ pack: CORE })).toStrictEqual({ pack: CORE });
  });

  it("失败回执没带 error 字段时给出占位码，而不是崩在读属性上", async () => {
    // `RemoteResult` 的类型把 failure 分支的 `error` 写成必填，但类型只在编译期成立：
    // 网关另一侧可能是别的版本、可能被中间层改写。直接读 `result.error.code` 会在这种回包上
    // 抛 `Cannot read properties of undefined`，把「对端答了坏包」伪装成客户端崩溃。
    const reader = createRuntimeReader(
      hostOf({ namespace: namespaceStub({ cancelJob: async () => ({ ok: false }) }) }).host,
    );
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.cancel("job-1")).rejects.toThrow(/REMOTE_BAD_ENVELOPE/u);
  });

  it("失败回执的 error 字段是对象但内容不合法时，逐位退回占位值", async () => {
    // `{ ok: false, error: 有对象 }` 只保证形状像回执，不保证 `code` / `message` 的类型。
    // 空 code 拼进异常信息会得到一句只剩冒号的话；非字符串 message 更会把 `[object Object]`
    // 塞给模型。所以两格各自退回占位值，而不是信类型声明。
    const reader = createRuntimeReader(
      hostOf({
        namespace: namespaceStub({
          cancelJob: async () => ({ ok: false, error: { code: "", message: 42 } }),
        }),
      }).host,
    );
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.cancel("job-1")).rejects.toThrow(/^REMOTE_BAD_ENVELOPE: $/u);
  });

  it("命名空间那一拍取不到时也清缓存，下一次调用会重挂而不是永久卡死", async () => {
    // 挂载 resolve 了但这枚命名空间取不到（网关重启后命名空间被摘掉、服务注册滞后一拍、
    // 或 `isNamespace` 因方法缺失判假）。不清 `mounted` 的话，此后每次调用都跳过挂载、
    // 复现同一条「未提供」错误 —— 读取器永久卡死，用户只能刷新页面。
    let mounts = 0;
    let namespaceAvailable = false;
    const host: RemoteHost = {
      get: (name: string): unknown => {
        if (name === "remote") {
          return {
            $mount: async (): Promise<unknown> => {
              mounts += 1;
              return { mounted: true };
            },
          };
        }
        return namespaceAvailable ? namespaceStub() : null;
      },
    };
    const reader = createRuntimeReader(host);
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.status()).rejects.toThrow(/未提供/u);
    namespaceAvailable = true;
    await expect(reader.status()).resolves.toMatchObject({ job: null });
    expect(mounts, "第二次调用应当重新走一遍 $mount，而不是复用那条已 resolve 的 promise").toBe(2);
  });

  it("回包不是信封形状时判协议错误，而不是崩在读属性上", async () => {
    // `result.ok` / `result.error.code` 都不做非空检查：网关交回 undefined 或一条字符串时，
    // 症状会变成 `Cannot read properties of undefined`，读不出「哪一侧的协议坏了」。
    const { host } = hostOf({
      namespace: namespaceStub({ status: async () => undefined as never }),
    });
    const reader = createRuntimeReader(host);
    await expect(reader?.status() ?? Promise.reject(new Error("no reader"))).rejects.toThrow(
      /malformed envelope/u,
    );
  });

  it("坏回包有循环引用时也能把话说完，不换成 JSON.stringify 自己的报错", async () => {
    // 回包里有循环引用时 `JSON.stringify` 自己抛 `TypeError: Converting circular structure
    // to JSON`，把「对端答了坏包」的协议语义整个换掉；回包很大时还会把整份载荷塞进错误文案，
    // 而卡片是 `setFailure(String(error))` 原样渲染。
    const cyclic: Record<string, unknown> = { ok: "yes" };
    cyclic["self"] = cyclic;
    const reader = createRuntimeReader(
      hostOf({ namespace: namespaceStub({ status: async () => cyclic as never }) }).host,
    );
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.status()).rejects.toThrow(/malformed envelope: \{ ok, self \}/u);
  });

  it("回包是空对象时把话说完（不把整份载荷塞进错误文案）", async () => {
    // `describeEnvelope` 的 `keys.length === 0` 支：空对象本身没有可列的键，印 `{}` 比印空串
    // 清楚。这一支与「有键」那支只差 listEnvelope 的一句拼装，但两者都会进
    // `setFailure(String(error))`，缺了它就只能看到 `malformed envelope: ` 后面什么都没有。
    const reader = createRuntimeReader(
      hostOf({ namespace: namespaceStub({ status: async () => ({}) as never }) }).host,
    );
    if (reader === undefined) {
      throw new TypeError(READER_MISSING);
    }
    await expect(reader.status()).rejects.toThrow(/malformed envelope: \{\}/u);
  });
});
