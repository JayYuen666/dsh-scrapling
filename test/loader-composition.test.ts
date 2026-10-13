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

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { applyEntryPatches, entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";

/**
 * 把子进程的 close 事件转成上游要的退出结果。
 *
 * @param child - 子进程
 * @returns 退出码与信号
 */
async function exitOf(
  child: ReturnType<typeof spawn>,
): Promise<{ exitCode: number | null; signal: null }> {
  const [code] = (await once(child, "close")) as [number | null];
  return { exitCode: code, signal: null };
}

/** 什么都不做的 disposer：真实服务注销时调它。 */
function noop(): void {
  // 刻意留空。
}

/** cordis 的 FiberState.ACTIVE（const enum，运行时不导出，只能按值钉）。 */
const FIBER_ACTIVE = 2;

/** 本包名与补丁里那行的裸名 —— 二者必须一致，否则解析不到入口。 */
const PACKAGE_NAME = "@jayyuen66/dsh-scrapling";

/** 一次装载的结果，供逐条断言取用。 */
interface Loaded {
  ctx: Context;
  state: number;
  tools: string[];
  logs: string[];
  /** 装载用的模块命名空间（`import("../host.ts")` 的结果）。 */
  namespace: Record<string, unknown>;
  dispose: () => Promise<unknown>;
}

/**
 * 本仓库根的 file:// 前缀。
 *
 * @returns 不带尾分隔符的 URL
 */
function pathToFileHref(): string {
  return `file://${path.resolve(import.meta.dirname, "..")}`;
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
  ctx.baseUrl = `${pathToFileHref()}${path.sep}`;
  await ctx.plugin(Loader);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(WebRuntime, {});
  await ctx.plugin(ToolRuntime, {});

  // 手写的两枚，理由见文件头。
  ctx.provide("settings", { configure: () => noop });
  ctx.provide("subprocess", {
    resolveExecutable: async (command: string): Promise<string> => command,
    spawn: (spec: { argv: string[]; cwd: string; env?: NodeJS.ProcessEnv }) => {
      const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done: exitOf(child),
        terminate: (): void => {
          child.kill("SIGTERM");
        },
        waitForExit: async (): Promise<boolean> => true,
      };
    },
  });

  // 裸包名在 pnpm 布局下会从 loader 的 .pnpm 真路径解析而找不到本包；上游的宿主用
  // `loader.internal` 做同一件事（把名字解析到 baseUrl 那一侧）。这里按同样的缝打桩。
  const loader = ctx.loader as unknown as {
    internal?: { version: string; import: (spec: string) => Promise<unknown> };
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
  loader.internal = {
    version: "v2",
    import: async (specifier: string): Promise<unknown> =>
      specifier === PACKAGE_NAME ? namespace : {},
  };

  const id = await loader.create({
    id: "scrapling",
    name: PACKAGE_NAME,
    config: {
      // 解释器给一个不存在的路径：apply 会在 resolveExecutable 就失败，于是不拉进程、
      // 不等握手，只留下「能力不可用、工具不注册」这条降级路径。
      pythonBin: path.join(dataDir, "no-such-interpreter"),
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

describe("经真实 Loader 装载本插件", () => {
  let dataDir!: string;
  let loaded!: Loaded;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "dsh-scrapling-loader-"));
    loaded = await load(dataDir);
  });

  afterAll(async () => {
    await loaded.dispose();
    if (dataDir !== "") {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("补丁里那一行经过真实 applyEntryPatches 得到我们装载的那一条", () => {
    // 判据取上游的合成函数，而不是我对 patch 语义的理解：我们的 cordis.patch.yml 只有一条
    // `insert`，落在空的根上，产物应该就是那一条 row（id 同时是设置命名空间）。
    const rows = applyEntryPatches(
      [],
      [{ insert: [{ id: "scrapling", name: PACKAGE_NAME }] }],
      (): void => undefined,
    );
    expect(rows).toStrictEqual([{ id: "scrapling", name: PACKAGE_NAME }]);
    expect(entryListSchema).toBeDefined();
  });

  it("发布的 cordis.patch.yml 仍是这一条（改了补丁就得同步这条断言）", async () => {
    const text = await readFile(path.resolve(import.meta.dirname, "../cordis.patch.yml"), "utf8");
    const rows = [...text.matchAll(/^\s+name:\s*"?(?<name>[\w@/.-]+)"?\s*$/gmu)].map(
      (match) => match.groups?.["name"] ?? "",
    );
    // 补丁只该引入我们这一行：多出一条就是「装了别的东西」，而这条测试只对本包负责。
    expect(rows).toStrictEqual([PACKAGE_NAME]);
    // `- id:` 那一行的短横也在缩进里，匹配时得让它可选。
    expect(text).toMatch(/^\s*(?:-\s+)?id:\s*scrapling\s*$/mu);
  });

  it("unwrapExports 之后命名空间仍在（inject 不会被 .default 吃掉）", () => {
    // 那次事故的形状：只要入口多一个 default 导出，Loader 就会取 default，命名空间
    // （连同 name/inject/Config）整体消失，插件在 apply 里抛。
    expect(loaded.namespace).not.toHaveProperty("default");
    expect(loaded.namespace["apply"]).toBeTypeOf("function");
    expect(loaded.namespace["inject"] as string[]).toContain("subprocess");
  });

  it("插件行装载成功、激活，且没有导入异常", () => {
    expect(loaded.logs.join("\n")).not.toMatch(/ERR_MODULE_NOT_FOUND|cannot get property/u);
    expect(loaded.state).toBe(FIBER_ACTIVE);
  });

  it("解释器不可用时按降级路径走：注册 0 个工具，也不拉进程", () => {
    // 这条是 failFastOnMissingPython=false 的真实后果。要看到 9~11 个工具得给真解释器，
    // 而那条路径 host.test.ts 已经拿 _env/.venv 逐条钉过（含注册计划与作业接线）。
    expect(loaded.tools).toStrictEqual([]);
  });

  it("指引段经真实装配现取：一个工具都没注册时整段为空", async () => {
    // 上面那条降级路径的真实后果：模型该看到「这个插件此刻没有可用工具」，而不是一串点了
    // 就报 UNKNOWN_TOOL 的建议。以前这里恒为八段全说 —— 指引只看用户开关，而开关全默认开。
    await expect(guidanceOf(loaded.ctx)).resolves.toBe("");
  });

  it("把某个工具注册进真实 ToolRuntime 之后，真装配的指引只多出那一句", async () => {
    // 正面保底：上一条只看得到「为空」，而「恒为空」与「按注册状态现取」在那条断言里长得
    // 一样。这里把判据交给真实服务 —— 接线接错（问错服务、漏掉装配的 scope、或拿我们自己
    // 攒的名字表）都会让这一段永远出不来，这条就会红。
    const tools = loaded.ctx.get("tools") as { register: (definition: unknown) => () => void };
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
      const text = await guidanceOf(loaded.ctx);
      expect(text).toContain("scrapling_fetch");
      // 默认档开着 render/session，但它们没注册，所以那几句不该出现；crawl/stealth 是关的。
      expect(text).not.toContain("scrapling_render");
      expect(text).not.toContain("scrapling_session_open");
      expect(text).not.toContain("scrapling_crawl");
    } finally {
      dispose();
    }
  });
});
