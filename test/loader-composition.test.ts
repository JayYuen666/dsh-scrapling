// dsh-scrapling/test/loader-composition.test.ts —— 经真实 Loader 装载本插件（不是 ctx.plugin）。
//
// 为什么必须有这一层：cordis 的 `ctx.plugin({name, inject, apply})` 直接吃我们给的命名空间，
// **永远不会经过 `Loader.unwrapExports`**。而本包真实的上载入入口是「ESM 命名空间导出」
// （host.ts 顶层 export name/inject/Config/apply，且刻意没有 default 导出）——上游那份
// postmortem 记的正是这件事：`.default` 一旦存在就会赢，命名空间被丢掉，`inject` 跟着没，
// 症状是 apply 里读服务时抛 `cannot get property ... without inject`。100% 覆盖率在那次
// 事故全程成立（见 docs/postmortem/0001-acp-default-export-drops-inject.md）。
//
// 所以这里跑的是真链路：Loader 建 row → Entry._init 导入 → unwrapExports → registry.plugin
// → 真实 ToolRuntime/SystemPrompt/WebRuntime 服务 → 我们的 apply 注册工具。手写的只有两处，
// 且都写清楚为什么：subprocess（装不到实现，`@deepseek-ai/dsh-subprocess` 只是抽象缝）与
// settings（真实现的闭包要 configEditor + profileContext，那是宿主 app 的东西）。
//
// 打桩 `loader.internal` 用的也是上游自己测试里的办法（packages/session/session-turn-outline/
// tests/loader-composition.spec.ts）：pnpm 把 loader 藏在 .pnpm 真路径下，裸包名从那里 import
// 找不到本包，而 internal.import 正是宿主解析裸名的机制。走这一条还顺带保住覆盖率 —— 它返回
// 的是 `../host.ts` 源码命名空间，不是构建产物。

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { applyEntryPatches } from "@deepseek-ai/cordis-plugin-include";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import type { ModuleLoaderV2 } from "@deepseek-ai/cordis-plugin-loader";
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessStdio,
} from "@deepseek-ai/dsh-subprocess";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  apply as applyNativeExecutor,
  inject as nativeExecutorInject,
} from "@deepseek-ai/dsh-tool-executor-native";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";

/**
 * 把子进程的 close 事件转成上游要的退出结果。
 *
 * @param child - 子进程
 * @returns 退出码与信号
 */
async function exitOf(child: ReturnType<typeof spawn>): Promise<SubprocessOutcome> {
  // close 的第二位就是终止信号：原先写死 null，等于把「被 SIGTERM 打死」这一态抹成
  // 「正常退出且退出码为空」，上层再也分不开两者。
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  return { exitCode: code, signal };
}

/** 什么都不做的 disposer：真实服务注销时调它。 */
function noop(): void {
  // 刻意留空。
}

/** cordis 的 FiberState.ACTIVE（const enum，运行时不导出，只能按值钉）。 */
const FIBER_ACTIVE = 2;

/** 本包名与补丁里那行的裸名 —— 二者必须一致，否则解析不到入口。 */
const PACKAGE_NAME = "@jayyuen66/dsh-scrapling";

/** 补丁里那一条的 id，同时也是设置命名空间；只在这里写一次。 */
const ENTRY_ID = "scrapling";

/**
 * 装载用的那个「不在场的解释器」路径。
 *
 * 降级路径的入口就是它：resolveExecutable 要在这里拒掉，spawn 一次都不该被调用。夹具与断言
 * 共用这一处来源，免得两处各拼一遍再各错一遍。
 *
 * @param dataDir - 本次装载用的临时目录
 * @returns 一个绝对但不存在的路径
 */
function missingInterpreter(dataDir: string): string {
  return path.join(dataDir, "no-such-interpreter");
}

/** 本桩只把三路管道交回：collect / inherit 这些形态不在侧车需要的那一面上，问到就抛。 */
function pipeOnly(mode: SubprocessStdio[keyof SubprocessStdio]): "pipe" {
  if (mode !== "pipe") {
    throw new TypeError(`subprocess 替身只实现 stdio 的 "pipe"，收到的是 ${JSON.stringify(mode)}`);
  }
  return mode;
}

/**
 * subprocess 服务面的替身。
 *
 * 入参与返回值都按真实的 `SubprocessSpawnSpec` / `SubprocessHandle` 收：原先只声明
 * `argv/cwd/env` 并把三路管道写死，`stdio` 的分流对象、`graceMs` 与 `signal` 都被静默丢掉，
 * 上游给这一面加字段时这里不会有任何反应。侧车只用 stdin/stdout/stderr/done/terminate/
 * waitForExit，所以本桩只实现这几位（control 与 collect 模式的输出环留给真实现）。
 *
 * `resolveExecutable` 与真实语义同解：绝对路径要验在场，不在场就拒——降级因此是从这一位
 * 走出去的，而不是靠 `spawn` 的 ENOENT。
 */
function subprocessStub(seen: SubprocessCalls): {
  resolveExecutable: (command: string) => Promise<string>;
  spawn: (
    spec: SubprocessSpawnSpec,
  ) => Pick<SubprocessHandle, "stdin" | "stdout" | "stderr" | "done" | "terminate" | "waitForExit">;
} {
  return {
    resolveExecutable: async (command: string): Promise<string> => {
      seen.resolves.push(command);
      if (!existsSync(command)) {
        throw new Error(`resolveExecutable: 可执行文件不在场：${command}`);
      }
      return command;
    },
    spawn: (spec) => {
      seen.spawns += 1;
      seen.argv.push(spec.argv.join(" "));
      const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: [
          pipeOnly(spec.stdio.stdin),
          pipeOnly(spec.stdio.stdout),
          pipeOnly(spec.stdio.stderr),
        ],
      });
      // 本桩不去区分「被信号终止」与「超时后 SIGKILL」：终止动词只有一个，退出信号照实回传。
      spec.signal?.addEventListener("abort", () => {
        child.kill("SIGTERM");
      });
      const done = exitOf(child);
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        terminate: (): void => {
          child.kill("SIGTERM");
        },
        waitForExit: async (): Promise<boolean> => {
          // 本桩没有 collect 模式的输出环，进程一退出就算排空。等的是 done 那一枚已经挂好的
          // 监听：exit 先于 close 发生，在这里重新 once("exit") 会永远等不到。
          await done;
          return true;
        },
      };
    },
  };
}

/** 取装载好的那一份；装载没起来时点名抛，而不是让断言对着 undefined 猜形状。 */
function requireLoaded(loaded: Loaded | undefined): Loaded {
  if (loaded === undefined) {
    throw new Error("beforeAll 没有装载成功");
  }
  return loaded;
}

/** subprocess 替身的回执：降级到底从哪一位走出去，只有在这里看得出来。 */
interface SubprocessCalls {
  /** resolveExecutable 被问过的命令，按顺序。 */
  resolves: string[];
  /** spawn 被调用的次数。 */
  spawns: number;
  /** spawn 收到的 argv，按顺序。 */
  argv: string[];
}

/** 一次装载的结果，供逐条断言取用。 */
interface Loaded {
  ctx: Context;
  state: number;
  tools: string[];
  logs: string[];
  /** 装载用的模块命名空间（`import("../host.ts")` 的结果）。 */
  namespace: Record<string, unknown>;
  /** loader.create 交回的条目 id。 */
  id: string;
  /** 打桩的 internal.import 收到的每一次解析请求。 */
  internalImports: InternalImport[];
  /** subprocess 替身的回执。 */
  subprocessCalls: SubprocessCalls;
  /** 交给 sidecar 的那个解释器路径。 */
  pythonBin: string;
  dispose: () => Promise<unknown>;
}

/** internal.import 的一次调用：上游传的是 (specifier, parentURL, importAttributes)。 */
interface InternalImport {
  specifier: string;
  parentURL: string;
}

/**
 * 本仓库根的 file:// URL。
 *
 * 不手拼 `file://${path}`：Windows 上盘符前少一道斜杠、反斜杠也没转义，含空格或非 ASCII
 * 的路径同样不会被百分号编码；Loader 按 URL 解析裸名，拼错的表现是「装载失败」而不是
 * 一条能读懂的报错。
 *
 * @returns 不带尾斜杠的 URL
 */
function pathToFileHref(): string {
  return pathToFileURL(path.resolve(import.meta.dirname, "..")).href.replace(/\/$/u, "");
}

/**
 * 组装载荷：真实 Loader + 真实服务 + 两枚手写服务面。
 *
 * @param dataDir - 交给 sidecar 的工作目录（必须是临时目录：默认档会写 ~/.dsh-scrapling）
 * @returns 装载结果
 */
async function load(dataDir: string): Promise<Loaded> {
  // 命名空间只能运行时取：静态 `import *` 被 lint 禁，而这里恰好要判「命名空间上有没有
  // default 导出」——那正是 Loader.unwrapExports 会看的东西。
  const namespace = (await import("../host.ts")) as Record<string, unknown>;
  const ctx = new Context();
  // Entry._init 把导入异常咽进 logger（只留 entry.fiber === undefined）：不接 exporter，
  // 「这一行没装载」与「装载失败」在断言里长得一模一样。
  const logs: string[] = [];
  ctx.logger.exporter({
    levels: { default: 0 },
    export: (entry: { level?: number; type?: string; args?: unknown[] }) => {
      logs.push(`${String(entry.type)} ${JSON.stringify(entry.args ?? null)}`);
    },
  });

  // 顺序要紧：baseUrl 必须在 plugin(Loader) 之前设 —— Loader 在 super(ctx) 之后就抓住
  // ctx 了，之后再改不会传进去（app-boot 也是这个次序）。
  ctx.baseUrl = `${pathToFileHref()}/`;
  await ctx.plugin(Loader);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(WebRuntime, {});
  await ctx.plugin(ToolRuntime, {});
  // alpha.2 起批次与工具声明都经组合里显式提供的执行器；不装这一枚，指引段装配会以
  // TOOL_EXECUTOR_UNAVAILABLE 拒绝。用官方原生执行器，不在台架里复述它的实现。
  await ctx.plugin({ inject: nativeExecutorInject, apply: applyNativeExecutor });

  // 手写的两枚，理由见文件头。
  ctx.provide("settings", { configure: () => noop });
  const subprocessCalls: SubprocessCalls = { resolves: [], spawns: 0, argv: [] };
  ctx.provide("subprocess", subprocessStub(subprocessCalls));

  // 裸包名在 pnpm 布局下会从 loader 的 .pnpm 真路径解析而找不到本包；上游的宿主用
  // `loader.internal` 做同一件事（把名字解析到 baseUrl 那一侧）。这里按同样的缝打桩。
  const internalImports: InternalImport[] = [];
  const loader = ctx.loader as unknown as {
    internal?: Pick<ModuleLoaderV2, "version"> & { import: ModuleLoaderV2["import"] };
    create: (options: {
      id: string;
      name: string;
      config?: Record<string, unknown>;
    }) => Promise<string>;
    resolve: (id: string) => {
      fiber?: { state: number } & Promise<unknown>;
      moduleNamespace?: unknown;
    };
    await: () => Promise<void>;
  };
  // 上游自己解析到的那一枚（没开 --expose-internals 时不存在），它的 version 决定替身报哪一版。
  const internalImport: ModuleLoaderV2["import"] = async (
    specifier,
    parentURL,
  ): Promise<unknown> => {
    internalImports.push({ specifier, parentURL });
    if (specifier !== PACKAGE_NAME) {
      // 原先对任何别的包名都返回空命名空间：插件多 import 一个包时这里不报错，
      // 而是拿着空对象继续跑 —— 与本文件存在的目的正好相反。
      throw new TypeError(`internal 替身只解析 ${PACKAGE_NAME}，问到的是 ${specifier}`);
    }
    return namespace;
  };
  loader.internal = { version: loader.internal?.version ?? "v2", import: internalImport };

  const id = await loader.create({
    id: ENTRY_ID,
    name: PACKAGE_NAME,
    config: {
      // 解释器给一个不存在的路径：apply 会在 resolveExecutable 就失败，于是不拉进程、
      // 不等握手，只留下「能力不可用、工具不注册」这条降级路径。
      pythonBin: missingInterpreter(dataDir),
      failFastOnMissingPython: false,
      dataDir,
    },
  });
  await loader.await();
  const entry = loader.resolve(id);
  const tools = (ctx.get("tools") as { schemas: () => { name: string }[] })
    .schemas()
    .map((item) => item.name)
    .filter((name) => name.startsWith("scrapling_"));

  return {
    ctx,
    namespace,
    id,
    internalImports,
    subprocessCalls,
    pythonBin: missingInterpreter(dataDir),
    state: entry.fiber?.state ?? -1,
    tools,
    logs,
    dispose: async () => ctx.fiber.dispose(),
  };
}

/**
 * 从**真实装配**里取我们那一段指引的文本。
 *
 * 判据取上游服务的产物，而不是假 ctx 记下来的调用：`section` 收到的 `text` 是函数这件事
 * 本身不说明它被调过、也不说明它算出了什么。上游每次装配都会带上调用方的 scope 现算，
 * 而本包的文本正是按「那个 scope 看得见哪些工具」长出来的 —— 只有走真装配才看得到。
 *
 * @param ctx - 装载用的容器
 * @returns 该段的文本；一段都没说时为空串
 */
async function guidanceOf(ctx: Context): Promise<string> {
  const service = ctx.get("systemPrompt") as {
    assemble: () => Promise<{ sections: { name: string; text: string }[] }>;
  };
  const assembly = await service.assemble();
  return assembly.sections.find((item) => item.name === "scrapling-usage")?.text ?? "";
}

/**
 * 取补丁文本里 `insert:` 那一段的条目。
 *
 * 只在 insert 块内认条目：条目必须比 `insert:` 那个键缩进更深，同缩进的下一个键就是本段的
 * 尽头，块外的一切（注释、补丁里别的段、以后新增的兄弟键）都不参与。
 * 读不懂的行直接抛，不交回空清单——空清单在这条断言里与「全部通过」逐字相同。本包依赖段里
 * 没有 YAML 解析器（`yaml` 在伞安装里解析得到，却没被本包钉住，单仓 CI 装不到它），所以按行读。
 *
 * @param text - cordis.patch.yml 全文
 * @returns 该段的条目，顺序与文件一致
 */
function insertRowsOfPatch(text: string): { id: string; name: string }[] {
  const rows: { id: string; name: string }[] = [];
  let current: { id: string; name: string } | undefined;
  const finish = (): void => {
    if (current === undefined) {
      return;
    }
    rows.push(current);
    current = undefined;
  };
  const lines = text.split(/\r?\n/u);
  const insertLine = lines.find((line) => /^-\s+insert:\s*$/u.test(line));
  if (insertLine === undefined) {
    throw new Error("cordis.patch.yml 里没有 `- insert:` 这一段");
  }
  // insert 这个键自身的缩进：条目都在它之下，与它同缩进的下一个键就是本段的尽头。
  const insertIndent = insertLine.indexOf("insert:");
  const start = lines.indexOf(insertLine);
  /** 读一行；交回 false 表示 insert 段到此结束（空行与注释在本段里跳过）。 */
  const takeLine = (line: string): boolean => {
    const content = line.trim();
    if (content === "" || content.startsWith("#")) {
      return true;
    }
    if (line.length - line.trimStart().length <= insertIndent) {
      return false;
    }
    const id = /^\s*-\s+id:\s*(?<id>\S+)\s*$/u.exec(line)?.groups?.["id"];
    const name = /^\s+name:\s*"?(?<name>[^"]+)"?\s*$/u.exec(line)?.groups?.["name"];
    const bareName = /^\s*-\s+name:\s*"?(?<name>[^"]+)"?\s*$/u.exec(line)?.groups?.["name"];
    if (id !== undefined) {
      finish();
      current = { id, name: "" };
      return true;
    }
    if (bareName !== undefined) {
      finish();
      // 真实宿主把无 id 条目保持为不可定位；这里补一个仅用于 EntryOptions 的合成 id，
      // 判据落在 name 上，组件开关的“不可停用”由宿主 dump + 沙箱验证，不靠这条夹具。
      current = { id: bareName, name: bareName };
      return true;
    }
    if (name === undefined) {
      throw new Error(`insert 段里读不懂这一行：${line}`);
    }
    if (current === undefined) {
      throw new Error(`name 出现在条目之外：${line}`);
    }
    current.name = name;
    return true;
  };
  for (const line of lines.slice(start + 1)) {
    if (!takeLine(line)) {
      break;
    }
  }
  finish();
  for (const row of rows) {
    if (row.name === "") {
      throw new Error(`条目 ${row.id} 没有 name`);
    }
  }
  if (rows.length === 0) {
    throw new Error("insert 段里一条都没有");
  }
  return rows;
}

describe("经真实 Loader 装载本插件", () => {
  let dataDir: string | undefined;
  let loaded: Loaded | undefined;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-scrapling-loader-"));
    dataDir = dir;
    loaded = await load(dir);
  });

  afterAll(async () => {
    // 装载失败时 loaded 还是 undefined：原先那句 loaded.dispose() 会抛 TypeError，
    // 把 beforeAll 真正的失败信息盖掉。dispose 抛错也不能挡住临时目录的回收，
    // 所以 rm 放在 finally 里（默认档会往 dataDir 写 sidecar 的文件）。
    try {
      await loaded?.dispose();
    } finally {
      if (dataDir !== undefined) {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });

  it("insert 段之外的一切不参与解析：注释与别的段都不算条目", () => {
    expect(
      insertRowsOfPatch(
        [
          "# name: 注释里的不是条目",
          "- insert:",
          `    - id: ${ENTRY_ID}`,
          `      name: "${PACKAGE_NAME}"`,
          "  config:",
          "    name: 别的段里的键",
        ].join("\n"),
      ),
    ).toStrictEqual([{ id: ENTRY_ID, name: PACKAGE_NAME }]);
  });

  it("解析不出来就抛，不交回空清单", () => {
    // 空清单在断言里与「全部通过」逐字相同，所以每一档都要响。
    expect(() => {
      insertRowsOfPatch("- other:\n    - id: x\n");
    }).toThrow(/没有 `- insert:`/u);
    expect(() => {
      insertRowsOfPatch('- insert:\n    - id: x\n      name: "y"\n    noise\n');
    }).toThrow(/读不懂这一行/u);
    expect(() => {
      insertRowsOfPatch("- insert:\n    - id: x\n");
    }).toThrow(/没有 name/u);
  });

  it("发布的 cordis.patch.yml 经上游合成函数得出装载用的那一条", async () => {
    // 输入只有真实文件这一份。原先两条用例一条把补丁内容手抄进数组（证的是「我抄的这份能被合成」）、
    // 另一条用正则扫全文取 name（会连注释与将来 config 里的 name 键一起算），两条职责重叠，
    // 补丁一演进就会静默失效。
    const text = await readFile(path.resolve(import.meta.dirname, "../cordis.patch.yml"), "utf8");
    const rows = applyEntryPatches(
      [],
      [{ insert: insertRowsOfPatch(text) }],
      (): void => undefined,
    );
    const sharedPackage = "@jayyuen66/dsh-plugin-shared";
    // shared 是卡片组件行，故意不写 id；本包的装载条目仍必须与补丁里的那一条同源。
    expect(rows.filter((row) => row.name !== sharedPackage)).toStrictEqual([
      { id: ENTRY_ID, name: PACKAGE_NAME },
    ]);
    expect(rows.find((row) => row.name === sharedPackage)).toMatchObject({
      name: sharedPackage,
    });
    // 装载用的就是这一条：create 交回的 id 与补丁里那条同源，链子断了这里红。
    expect(requireLoaded(loaded).id).toBe(ENTRY_ID);
  });

  it("裸包名是经 internal.import 的真实签名解析来的", () => {
    // 替身按 ModuleLoaderV2["import"] 的形状写，parentURL 是 loader 递进来的 ctx.baseUrl。
    // 这两件事成立才说明走的是上游那条缝，而不是我们自己 import 了一份模块；问替身要别的
    // 包名会抛，所以这里也只该有一次调用。
    expect(requireLoaded(loaded).internalImports).toStrictEqual([
      { specifier: PACKAGE_NAME, parentURL: `${pathToFileHref()}/` },
    ]);
  });

  it("unwrapExports 之后命名空间仍在（inject 不会被 .default 吃掉）", () => {
    // 那次事故的形状：只要入口多一个 default 导出，Loader 就会取 default，命名空间
    // （连同 name/inject/Config）整体消失，插件在 apply 里抛。
    expect(requireLoaded(loaded).namespace).not.toHaveProperty("default");
    expect(requireLoaded(loaded).namespace["apply"]).toBeTypeOf("function");
    expect(requireLoaded(loaded).namespace["inject"] as string[]).toContain("subprocess");
  });

  it("插件行装载成功、激活，且没有导入异常", () => {
    expect(requireLoaded(loaded).logs.join("\n")).not.toMatch(
      /ERR_MODULE_NOT_FOUND|cannot get property/u,
    );
    expect(requireLoaded(loaded).state).toBe(FIBER_ACTIVE);
  });

  it("subprocess 替身按真实 spec 收参数，终止信号照实回传进 done", async () => {
    // 这条钉两件事：spec 的 stdio 分流对象与 graceMs 被真的读了（不是写死三管道），
    // 以及 close 的第二个参数没有被写死成 null——被 SIGTERM 打死与「正常退出且退出码为空」
    // 必须是两种可分辨的结果。
    // 用自己的替身实例：从装载好的容器里取会把这次 spawn 记到那条「不拉进程」用例的回执上。
    const handle = subprocessStub({ resolves: [], spawns: 0, argv: [] }).spawn({
      argv: ["node", "-e", "setTimeout(() => {}, 30_000)"],
      cwd: process.cwd(),
      env: process.env,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      graceMs: 200,
    });
    handle.terminate();
    await expect(handle.done).resolves.toMatchObject({ exitCode: null, signal: "SIGTERM" });
    await expect(handle.waitForExit()).resolves.toBe(true);
  });

  it("解释器不可用时按降级路径走：注册 0 个工具，也不拉进程", () => {
    // 这条是 failFastOnMissingPython=false 的真实后果。要看到工具真被注册得给真解释器，
    // 而那条路径 host.test.ts 已经拿 _env/.venv 逐条钉过（含注册计划与作业接线）。
    const seen = requireLoaded(loaded);
    // 降级是从 resolveExecutable 走出去的：替身按真实语义验绝对路径在场，拒掉之后 spawn
    // 一次都不该被调用。原先这一位恒成功，链路实际是靠 spawn 的 ENOENT 才落到降级，与注释
    // 相反，而标题里「不拉进程」那半句在断言中根本没有对应物。
    expect(seen.subprocessCalls.resolves).toStrictEqual([seen.pythonBin]);
    expect(seen.subprocessCalls.spawns).toBe(0);
    expect(seen.tools).toStrictEqual([]);
  });

  it("指引段经真实装配现取：一个工具都没注册时整段为空", async () => {
    // 上面那条降级路径的真实后果：模型该看到「这个插件此刻没有可用工具」，而不是一串点了
    // 就报 UNKNOWN_TOOL 的建议。以前这里恒为八段全说 —— 指引只看用户开关，而开关全默认开。
    await expect(guidanceOf(requireLoaded(loaded).ctx)).resolves.toBe("");
  });

  it("把某个工具注册进真实 ToolRuntime 之后，真装配的指引只多出那一句", async () => {
    // 正面保底：上一条只看得到「为空」，而「恒为空」与「按注册状态现取」在那条断言里长得
    // 一样。这里把判据交给真实服务 —— 接线接错（问错服务、漏掉装配的 scope、或拿我们自己
    // 攒的名字表）都会让这一段永远出不来，这条就会红。
    // 这条会往容器里注册工具，所以它自己 load 一份：与「无工具时指引为空」共用一份容器时，
    // 那条断言就依赖用例顺序与串行执行，一旦并发或调整顺序会因这里的残留随机变红，而报错
    // （指引不为空）指不出真正的原因。
    const dir = dataDir;
    if (dir === undefined) {
      throw new Error("beforeAll 没有建出临时目录");
    }
    const own = await load(dir);
    const tools = own.ctx.get("tools") as { register: (definition: unknown) => () => void };
    const dispose = tools.register({
      // 只够过 register 的那道校验（output 必须带 render 与可用的 JSON schema）：这一条
      // 验的是可见性，不是抓取行为。
      name: "scrapling_fetch",
      description: "decoy：本条只验指引跟着注册状态走",
      parameters: {},
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        render: () => [],
      },
      execute: async () => ({ ok: true }),
    });
    try {
      // 前提要看得见：这份容器自己没注册任何 scrapling 工具，注册之后才只多出那一句。
      expect(own.tools).toStrictEqual([]);
      const text = await guidanceOf(own.ctx);
      expect(text).toContain("scrapling_fetch");
      // 这一份配置里默认开着 render/network/session/state，但它们没注册，所以那几句不该出现；
      // crawl/answer 同理 —— 只有 fetch 这一条真被注册进容器。
      expect(text).not.toContain("scrapling_render");
      expect(text).not.toContain("scrapling_session_open");
      expect(text).not.toContain("scrapling_crawl");
    } finally {
      dispose();
      await own.dispose();
    }
  });
});
