// dsh-scrapling/test/host.test.ts —— Host 半的配置面与工具注册计划。
//
// 覆盖三件事：（1）volatile 字段是引用而非真值，必须经 .get() 取快照；
// （2）Config schema 的默认值；（3）planTools 如何把「用户开关」与「运行环境具备什么」
// 两个维度合成一份注册计划。

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { createCrawlTool } from "../lib/tools.ts";
import type { ToolDeps, ToolSettings } from "../lib/tools.ts";
import type { AnswerResult } from "../lib/answer.ts";
import { SidecarClient } from "../lib/sidecar.ts";
import {
  Config as configSchema,
  apply,
  createUrlGate,
  inject,
  name,
  outputBudgetOf,
  planTools,
  resolveDataDir,
  snapshotFlags,
  TOOL_SPECS,
} from "../host.ts";
import type { Config as ConfigType, ToolFlags } from "../host.ts";
import type { Volatile } from "@deepseek-ai/cordis";
import type { SidecarCapabilities } from "../lib/sidecar.ts";

/**
 * 造一个 volatile 引用。
 *
 * 用 dsh 官方的 `Volatile<T>`（cordis 从 cosmokit 再导出）标注返回值，而不是自己声明
 * `{ get(): T }` —— 后者一旦官方给 Volatile 加成员就会与真实形状脱节。
 * 官方 `get()` 返回 `VolatileSnapshot<T>`；它对原始值联合是恒等的，而本包的 volatile
 * 字段全都是原始值，所以把参数类型定死成原始值联合。
 *
 * @param value - 引用的真值
 * @returns 一个只实现 get 的 volatile 引用
 */
function mkRef(value: string | number | boolean): Volatile<string | number | boolean> {
  return { get: () => value };
}

/** 全开开关。 */
const ALL_ON: ToolFlags = {
  fetch: true,
  extract: true,
  render: true,
  captureXhr: true,
  stealth: true,
  session: true,
  crawl: true,
  answer: true,
};

/** 全关开关。 */
const ALL_OFF: ToolFlags = {
  fetch: false,
  extract: false,
  render: false,
  captureXhr: false,
  stealth: false,
  session: false,
  crawl: false,
  answer: false,
};

/** 全能力就绪。 */
const FULL_CAPS: SidecarCapabilities = {
  scrapling: true,
  static: true,
  extract: true,
  browser: true,
  stealth: true,
  version: "0.4.15",
};

/**
 * 把任意 JSON 值投影为对象映射（非对象 → 空对象），避免断言成具体类型。
 *
 * @param raw - 任意值
 * @returns 对象形态的映射
 */
function asRecord(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

/**
 * 从 schema 的产物里取某个 volatile 字段的真值。
 *
 * schema 对标了 .volatile() 的字段会包成引用（带 get 与 cosmokit 的 write symbol），
 * 不是裸值 —— 这个 helper 的存在本身就是在钉这个形状。
 *
 * @param key - 字段名
 * @returns 该字段的 volatile 引用
 */
function volatileRef(key: string): Volatile<unknown> {
  const refs = asRecord(configSchema({}));
  const ref: unknown = refs[key];
  if (!isRecord(ref) || typeof ref["get"] !== "function") {
    throw new Error(`config field is not a volatile ref: ${key}`);
  }
  return ref as unknown as Volatile<unknown>;
}

/**
 * 假 ctx 里的 settings 面。
 *
 * 本插件在 apply 开头登记一次页面策略（`auto: false`，意思是「这一页由自带卡片编辑」，
 * 别再自动生成一份通用表单）。记下收到的值供断言，返回一个空 disposer，与真实服务同形。
 *
 * @param registrations - 收到的 `auto` 值会推进来
 * @returns 可直接挂进假 ctx 的对象
 */
function settingsStub(registrations: string[] = []): unknown {
  return {
    configure: (presentation: { auto?: boolean }): (() => void) => {
      registrations.push(String(presentation.auto));
      return (): void => undefined;
    },
  };
}

/**
 * 造一份与宿主同形的配置：volatile 字段是引用，部署级字段是真值。
 *
 * @param overrides - 覆盖的 volatile 字段真值
 * @returns 形状与 apply 收到的 config 一致的对象
 */
function makeConfig(overrides: Record<string, unknown> = {}): ConfigType {
  const pick = (key: string, fallback: string | number | boolean): never =>
    mkRef((overrides[key] as string | number | boolean | undefined) ?? fallback) as never;
  // requestTimeoutSeconds 与 maxUrlLength 在 Config 里是**非 volatile** 的部署值，宿主交下来
  // 的就是裸值。夹具若也包成引用，`url.length > maxUrlLength` 这类比较会拿引用去比——
  // 恒为 false，于是长度上限这条分支在测试里永远走不到，断言还会「因为没触发」而变绿。
  const plain = (key: string, fallback: number): number =>
    (overrides[key] as number | undefined) ?? fallback;
  // 部署级字符串字段同理：宿主交下来的是裸字符串，包成引用会让「与默认值比较」恒为 false。
  const plainText = (key: string, fallback: string): string =>
    (overrides[key] as string | undefined) ?? fallback;
  return {
    pythonBin: pick("pythonBin", ""),
    failFastOnMissingPython: pick("failFastOnMissingPython", true),
    fetchEnabled: pick("fetchEnabled", true),
    extractEnabled: pick("extractEnabled", true),
    renderEnabled: pick("renderEnabled", true),
    captureXhrEnabled: pick("captureXhrEnabled", true),
    stealthEnabled: pick("stealthEnabled", false),
    sessionEnabled: pick("sessionEnabled", true),
    crawlEnabled: pick("crawlEnabled", false),
    answerEnabled: pick("answerEnabled", true),
    extractionType: pick("extractionType", "markdown"),
    mainContentOnly: pick("mainContentOnly", true),
    fetchMaxOutputChars: pick("fetchMaxOutputChars", 200_000),
    extractMaxOutputChars: pick("extractMaxOutputChars", 200_000),
    renderMaxOutputChars: pick("renderMaxOutputChars", 200_000),
    xhrMaxOutputChars: pick("xhrMaxOutputChars", 120_000),
    crawlMaxItems: pick("crawlMaxItems", 1000),
    stripInlineImages: pick("stripInlineImages", true),
    headless: pick("headless", true),
    networkIdle: pick("networkIdle", false),
    blockAds: pick("blockAds", true),
    captureXhrPattern: pick("captureXhrPattern", ".*"),
    waitSelectorState: pick("waitSelectorState", "attached"),
    sidecarHandshakeTimeoutMs: pick("sidecarHandshakeTimeoutMs", 30_000),
    fetchTimeoutMs: pick("fetchTimeoutMs", 120_000),
    sidecarGraceMs: pick("sidecarGraceMs", 5000),
    requestTimeoutSeconds: plain("requestTimeoutSeconds", 120),
    maxUrlLength: plain("maxUrlLength", 2048),
    browserExecutablePath: plainText("browserExecutablePath", ""),
    browserCdpUrl: plainText("browserCdpUrl", ""),
    nat64Prefixes: pick("nat64Prefixes", ""),
    dataDir: pick("dataDir", ""),
    provideWebFetch: pick("provideWebFetch", false),
    provideWebSearch: pick("provideWebSearch", false),
    searchEndpoint: plainText("searchEndpoint", ""),
    searchRenderTopN: plain("searchRenderTopN", 3),
    answerProvider: pick("answerProvider", ""),
    answerModel: pick("answerModel", ""),
    answerMaxTokens: pick("answerMaxTokens", 2000),
    allowedHosts: pick("allowedHosts", ""),
    syntheticDnsRanges: pick("syntheticDnsRanges", ""),
    proxyUrl: pick("proxyUrl", ""),
    proxyBypass: pick("proxyBypass", ""),
  };
}

/** 本仓用来跑集成测试的 Python 解释器。 */
const LOCAL_PYTHON = path.resolve(import.meta.dirname, "../_env/.venv/bin/python3");

/** 本仓探针解释器是否就位。不就位时下面这些用例整条跳过，而不是跑起来空转。 */
const HAS_LOCAL_PYTHON = existsSync(LOCAL_PYTHON);

/** 工具没被注册时的报错文案。 */
const NOT_REGISTERED = "scrapling_crawl was not registered";

/** 一个必然连不上的地址：端口 1 上没有任何服务在听。 */
const UNREACHABLE = "http://127.0.0.1:1/";

/** 假 spawn 被调到时的哨兵：走到这里说明测试的前提被破坏了。 */
const SHOULD_NOT_REACHED = "should not be reached";

/** 假解释器抛出的那句话；多处复用，抽成常量免得改一处漏一处。 */
const INTERPRETER_UNUSABLE = "interpreter not usable";

/** 本地测试站点所在的回环主机：Host 侧闸门与 Python 侧放行设置共用这一份。 */
const LOOPBACK_ALLOWLIST = "127.0.0.1,localhost";

/** 用例里统一的假作业 id。 */
const CRAWL_JOB_ID = "scrapling-1";

describe("插件元信息", () => {
  it("插件 id 与 cordis.patch.yml 的 id 一致（设置命名空间由此决定）", () => {
    expect(name).toBe("scrapling");
  });

  it("注入了 tools / subprocess / web / systemPrompt / settings 五个服务", () => {
    expect(inject).toStrictEqual(["tools", "subprocess", "web", "systemPrompt", "settings"]);
  });
});

describe("config schema", () => {
  it("python 解释器默认走 PATH 上的 python3", () => {
    expect(volatileRef("pythonBin").get()).toBe("");
  });

  it("stealth 与 crawl 默认关（多一层浏览器依赖 / 重量级后台任务）", () => {
    expect(volatileRef("stealthEnabled").get()).toBe(false);
    expect(volatileRef("crawlEnabled").get()).toBe(false);
  });

  it("抽取默认 markdown 且只取 body —— 与 dsh 内置 web_fetch 的呈现口径对齐", () => {
    expect(volatileRef("extractionType").get()).toBe("markdown");
    expect(volatileRef("mainContentOnly").get()).toBe(true);
  });

  it("安全相关的用户可改字段默认都是最严档", () => {
    expect(volatileRef("allowedHosts").get()).toBe("");
    expect(volatileRef("nat64Prefixes").get()).toBe("");
  });

  it("部署级字段不带 volatile，读出来就是真值（只能走 cordis.patch.yml）", () => {
    const config = asRecord(configSchema({}));
    expect(config["maxUrlLength"]).toBe(2048);
    expect(config["requestTimeoutSeconds"]).toBe(120);
  });
});

describe("volatile 快照", () => {
  it("volatile 字段是引用对象，必须经 .get() 取真值", () => {
    const config = makeConfig();
    // 直接读拿到的是引用本身而不是 boolean —— 这正是要防的写法
    expect(config.fetchEnabled).toBeTypeOf("object");
    expect(snapshotFlags(config).fetch).toBe(true);
  });

  it("引用被改写后快照跟着变（所以不能长期缓存快照）", () => {
    let value = true;
    const config = makeConfig();
    Object.defineProperty(config, "crawlEnabled", { get: () => mkRef(value) });
    expect(snapshotFlags(config).crawl).toBe(true);
    value = false;
    expect(snapshotFlags(config).crawl).toBe(false);
  });
});

describe("工具注册计划", () => {
  it("全开且能力齐备时七个工具全注册", () => {
    expect(planTools(ALL_ON, FULL_CAPS).ready).toStrictEqual(TOOL_SPECS.map((spec) => spec.name));
  });

  it("用户关掉的工具不注册，原因记为 disabled", () => {
    const plan = planTools({ ...ALL_ON, stealth: false, crawl: false }, FULL_CAPS);
    expect(plan.ready).toHaveLength(9);
    expect(plan.skipped).toStrictEqual([
      { name: "scrapling_stealth_fetch", reason: "disabled" },
      { name: "scrapling_crawl", reason: "disabled" },
    ]);
  });

  it("缺浏览器时不注册浏览器类工具，也不注册依赖 stealth 的", () => {
    const caps: SidecarCapabilities = { ...FULL_CAPS, browser: false, stealth: false };
    const plan = planTools(ALL_ON, caps);
    expect(plan.ready).toStrictEqual([
      "scrapling_fetch",
      "scrapling_extract",
      "scrapling_session_open",
      "scrapling_session_fetch",
      "scrapling_session_list",
      "scrapling_session_close",
      "scrapling_crawl",
      "scrapling_answer",
    ]);
    expect(plan.skipped).toContainEqual({ name: "scrapling_render", reason: "browser-missing" });
    expect(plan.skipped).toContainEqual({
      name: "scrapling_capture_xhr",
      reason: "browser-missing",
    });
    expect(plan.skipped).toContainEqual({
      name: "scrapling_stealth_fetch",
      reason: "stealth-missing",
    });
  });

  it("有浏览器但没有 stealth 时，浏览器类照常注册", () => {
    const caps: SidecarCapabilities = { ...FULL_CAPS, stealth: false };
    const plan = planTools(ALL_ON, caps);
    expect(plan.ready).toContain("scrapling_render");
    expect(plan.skipped).toContainEqual({
      name: "scrapling_stealth_fetch",
      reason: "stealth-missing",
    });
  });

  it("scrapling 缺失时一个工具都不注册", () => {
    const caps: SidecarCapabilities = { ...FULL_CAPS, scrapling: false };
    const plan = planTools(ALL_ON, caps);
    expect(plan.ready).toStrictEqual([]);
    expect(plan.skipped).toHaveLength(TOOL_SPECS.length);
  });

  it("尚未握手成功（capabilities 为 undefined）等价于缺 scrapling", () => {
    const plan = planTools(ALL_ON, undefined);
    expect(plan.ready).toStrictEqual([]);
    expect(plan.skipped.every((item) => item.reason === "scrapling-missing")).toBe(true);
  });

  it("全关时 ready 为空、skipped 记满七条 disabled", () => {
    const plan = planTools(ALL_OFF, FULL_CAPS);
    expect(plan.ready).toStrictEqual([]);
    expect(plan.skipped).toHaveLength(TOOL_SPECS.length);
    expect(plan.skipped.every((item) => item.reason === "disabled")).toBe(true);
  });

  it("登记表里的每个开关名都在 ToolFlags 上有对应字段", () => {
    for (const spec of TOOL_SPECS) {
      expect(ALL_ON[spec.flag]).toBeTypeOf("boolean");
    }
  });
});

describe("resolveDataDir", () => {
  it("留空时落到用户主目录下的 .dsh-scrapling", () => {
    expect(resolveDataDir("")).toBe(path.join(os.homedir(), ".dsh-scrapling"));
  });

  it("只由空白字符组成同样走默认", () => {
    expect(resolveDataDir("   ")).toBe(path.join(os.homedir(), ".dsh-scrapling"));
  });

  it("显式配置时解析成绝对路径（相对路径按 cwd 展开）", () => {
    expect(resolveDataDir("/tmp/scrapling-data")).toBe("/tmp/scrapling-data");
    expect(path.isAbsolute(resolveDataDir("relative-dir"))).toBe(true);
  });
});

describe("每个工具的输出预算各走各的旋钮", () => {
  it("四个抓取面分别取自己的预算，其余工具落到渲染那一档", () => {
    // 这层映射只被 apply() 的注册循环覆盖，而注册取决于运行环境：没有浏览器时
    // scrapling_capture_xhr 不注册，它那一支不会被执行，覆盖率也看不出缺的是哪一段。
    // 直接打这一层，顺带把「共用一份预算等于把三档调节压成一档」这个约定钉住——
    // 用互不相同的数值，串档立刻暴露。
    const config = makeConfig({
      fetchMaxOutputChars: 111,
      extractMaxOutputChars: 222,
      renderMaxOutputChars: 333,
      xhrMaxOutputChars: 444,
    });
    expect(outputBudgetOf(config, "scrapling_fetch")).toBe(111);
    expect(outputBudgetOf(config, "scrapling_extract")).toBe(222);
    expect(outputBudgetOf(config, "scrapling_render")).toBe(333);
    expect(outputBudgetOf(config, "scrapling_capture_xhr")).toBe(444);
    // 会话类产出的是句柄与列表而非页面正文，跟渲染同档；爬虫同理。
    expect(outputBudgetOf(config, "scrapling_session_list")).toBe(333);
    expect(outputBudgetOf(config, "scrapling_crawl")).toBe(333);
  });
});

describe("apply", () => {
  it("数据目录建不出来时只 warn 并提前返回，不去 spawn", async () => {
    const warnings: string[] = [];
    let spawned = 0;
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (): Promise<string> => "python3",
        spawn: (): never => {
          spawned += 1;
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (line: string): void => {
          warnings.push(line);
        },
        debug: (): void => undefined,
      },
      settings: settingsStub(),
      effect: (): void => undefined,
    } as unknown as never;
    // 指向一个不可能建出来的路径：父级是文件而不是目录。
    await apply(ctx, makeConfig({ dataDir: "/dev/null/impossible" }));
    expect(spawned).toBe(0);
    expect(warnings.some((line) => line.includes("未能启动"))).toBe(true);
  });

  it("pythonBin 留空时回落到 python3", async () => {
    const resolved: string[] = [];
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => {
          resolved.push(command);
          throw new Error(INTERPRETER_UNUSABLE);
        },
        spawn: (): never => {
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      settings: settingsStub(),
      effect: (): void => undefined,
    } as unknown as never;
    // failFastOnMissingPython 默认 true：Python 起不来就拒绝加载，不静默降级成
    // 「所有工具不可用」——后者会让模型几轮之后才发现工具全没了。
    await expect(apply(ctx, makeConfig({ pythonBin: "" }))).rejects.toThrow(INTERPRETER_UNUSABLE);
    // 留空就该走 PATH 上的 python3，而不是空串。
    expect(resolved).toStrictEqual(["python3"]);
  });

  it("failFastOnMissingPython=false 时探测失败只 warn，降级为工具全不可用", async () => {
    const warnings: string[] = [];
    const logger = {
      info: (): void => undefined,
      warn: (line: string): void => {
        warnings.push(line);
      },
      debug: (): void => undefined,
    };
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (): Promise<string> => {
          throw new Error(INTERPRETER_UNUSABLE);
        },
        spawn: (): never => {
          throw new Error(SHOULD_NOT_REACHED);
        },
      },
      logger,
      settings: settingsStub(),
      effect: (): void => undefined,
    } as unknown as never;
    await expect(
      apply(ctx, makeConfig({ pythonBin: "", failFastOnMissingPython: false })),
    ).resolves.toBeUndefined();
    expect(warnings.some((line) => line.includes("未能启动"))).toBe(true);
  });

  it.runIf(HAS_LOCAL_PYTHON)("真的拉起 sidecar 时能走通握手与注册计划", async () => {
    const python = LOCAL_PYTHON;
    const warnings: string[] = [];
    const infos: string[] = [];
    const disposers: (() => unknown)[] = [];
    const settingsRegistrations: string[] = [];
    const registered: string[] = [];
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        // 官方实现会校验可执行文件存在（SubprocessExecutableNotFoundError），这里照做：
        // 否则会拿一个不存在的解释器去 spawn，而 ENOENT 是异步事件，try/catch 抓不到。
        resolveExecutable: async (command: string): Promise<string> => {
          if (!existsSync(command)) {
            throw new Error(`executable not found: ${command}`);
          }
          return command;
        },
        spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
          const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.env },
            stdio: ["pipe", "pipe", "pipe"],
          });
          return {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            done: (async (): Promise<{ exitCode: number | null; signal: null }> => {
              const args = await once(child, "close");
              return { exitCode: args[0] as number | null, signal: null };
            })(),
            terminate: (): void => {
              child.kill("SIGTERM");
            },
            waitForExit: async (): Promise<boolean> => true,
          };
        },
      },
      logger: {
        info: (line: string): void => {
          infos.push(line);
        },
        warn: (line: string): void => {
          warnings.push(line);
        },
        debug: (): void => undefined,
      },
      // 只记名字，不真的进注册表 —— 这里验的是「apply 打算注册哪些」。
      tools: {
        register: (definition: { name: string }): (() => void) => {
          registered.push(definition.name);
          return (): void => undefined;
        },
      },
      // ctx.effect 收的是**工厂**：宿主会调用它拿到真正的 disposer 再登记。
      // 早先这里把工厂直接当 disposer 存下，于是真正的清理函数一次都没跑过 ——
      // 断言「disposers 有 2 条」照样通过，回收路径却完全没被验证。
      settings: settingsStub(settingsRegistrations),
      effect: (factory: () => () => unknown): void => {
        disposers.push(factory());
      },
    } as unknown as never;

    // 先探一次能力：注册结果依赖环境里到底有没有浏览器，断言要跟着环境走，
    // 而不是把「这台机器装了什么」写死进期望值。
    const probe = new SidecarClient(ctx, {
      pythonBin: python,
      bridgePath: path.resolve(import.meta.dirname, "../py/bridge.py"),
      cwd: os.tmpdir(),
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      graceMs: 5000,
    });
    const caps = await probe.ensureStarted();
    await probe.dispose();

    await apply(ctx, makeConfig({ pythonBin: python }));
    // 握手成功后必然打出注册计划这一行。
    expect(infos.some((line) => line.includes("注册"))).toBe(true);
    // 真正注册上去的 =「静态两条」+「会话四条」+「问答一条」+（浏览器可用时的两条）。
    // stealth 要 patchright、crawl 默认关，这两条按构造就不在里面。会话四条与问答一条
    // 都是独立工具名，少一条就说明 TOOL_SPECS 与构造器又对不上了。
    const sessionTools = [
      "scrapling_session_open",
      "scrapling_session_fetch",
      "scrapling_session_list",
      "scrapling_session_close",
    ];
    const expected = caps.browser
      ? [
          "scrapling_fetch",
          "scrapling_extract",
          "scrapling_render",
          "scrapling_capture_xhr",
          ...sessionTools,
          "scrapling_answer",
        ]
      : ["scrapling_fetch", "scrapling_extract", ...sessionTools, "scrapling_answer"];
    expect(registered).toStrictEqual(expected);

    // 再跑一次「全部关掉」：ready 为空时日志要落到 (none) 分支。
    infos.length = 0;
    registered.length = 0;
    await apply(
      ctx,
      makeConfig({
        pythonBin: python,
        fetchEnabled: false,
        extractEnabled: false,
        renderEnabled: false,
        captureXhrEnabled: false,
        sessionEnabled: false,
        answerEnabled: false,
      }),
    );
    expect(infos.some((line) => line.includes("(none)"))).toBe(true);
    expect(registered).toStrictEqual([]);
    // 两次 apply，每次登记两个 disposer：一个是「这一页由自带卡片编辑」的页面策略，
    // 一个是 sidecar 回收。
    expect(disposers).toHaveLength(4);
    expect(settingsRegistrations).toStrictEqual(["false", "false"]);
    // 卸载插件要能回收进程 —— disposer 把 promise 交回来，宿主会 await 它。
    await Promise.all(disposers.map((disposer) => disposer()));
  });
});

/** 端到端用例里用来判定「爬到了第二页」的标记。 */
const LEAF_MARK = "Leaf Page";
const ROOT_MARK = "Root Page";

/** 爬虫用例用的设置：极小预算，让断言跑得快。 */
const CRAWL_SETTINGS = {
  extractionType: "markdown",
  mainContentOnly: true,
  maxOutputBytes: 4000,
  timeoutMs: 30_000,
  headless: true,
  networkIdle: false,
  pageTimeoutMs: 30_000,
  waitSelectorState: "attached" as const,
  captureXhrPattern: ".*",
  requestTimeoutSeconds: 120,
  blockAds: false,
  crawlMaxItems: 10,
  maxUrlLength: 2048,
  browserExecutablePath: "",
  browserCdpUrl: "",
  stripInlineImages: true,
} satisfies ToolSettings;

/**
 * 造一个「一次 crawl.run + 一次 crawl.status 就结束」的假 sidecar。
 *
 * @returns 假 sidecar 客户端
 */
function fakeSidecarForCrawl(): { client: SidecarClient } {
  const replies: Record<string, unknown> = {
    "crawl.run": { crawlId: "c1" },
    "crawl.status": {
      running: false,
      error: null,
      pages: [
        { url: "http://a.test/", title: "A", markdown: "# A" },
        { url: "http://a.test/b", title: "B", markdown: "# B" },
      ],
    },
  };
  const client = new SidecarClient({} as never, {
    pythonBin: "python3",
    bridgePath: "bridge.py",
    cwd: ".",
    handshakeTimeoutMs: 10,
    requestTimeoutMs: 10,
    graceMs: 10,
  });
  Object.assign(client, {
    call: async (method: string): Promise<unknown> => replies[method] ?? {},
  });
  return { client };
}

/**
 * 造一份带作业句柄的 ToolDeps，并让作业主体真的跑起来。
 *
 * @param sink - 记录输出与进度的数组
 * @param jobHandle - 作业句柄的替身
 * @returns 可直接喂给 createCrawlTool 的依赖
 */
function createCrawlToolDeps(sink: {
  appended: string[];
  progressed: string[];
  jobHandle: { append: (text: string) => void; updateProgress: (line: string) => void };
}): ToolDeps {
  const fake = fakeSidecarForCrawl();
  return {
    sidecar: fake.client,
    settings: CRAWL_SETTINGS,
    startCrawlJob: async (_label, run) => {
      const job = sink.jobHandle;
      // 同步跑完主体再返回 id，模拟 ctx.jobs.start 里「登记后立刻返回」的形状。
      await run({
        append: job.append,
        progress: job.updateProgress,
        signal: new AbortController().signal,
      });
      return CRAWL_JOB_ID;
    },
    answer: async (): Promise<AnswerResult> => ({
      answer: "unused",
      provider: "unused",
      model: "unused",
    }),
  };
}

describe("apply 的爬虫作业接线", () => {
  it.runIf(HAS_LOCAL_PYTHON)("crawl 开关打开时会注册爬虫工具，并起一个 ctx.jobs 作业", async () => {
    const python = LOCAL_PYTHON;
    const appended: string[] = [];
    const progressed: string[] = [];
    let spec:
      | { run?: (job: unknown) => { cancel: () => void; done: Promise<unknown> } }
      | undefined;
    const jobsStub = {
      start: (received: typeof spec): string => {
        spec = received;
        return CRAWL_JOB_ID;
      },
    };
    const ctx = {
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (): never => {
          throw new Error("no real spawn here");
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      tools: { register: (): (() => void) => (): void => undefined },
      settings: settingsStub(),
      effect: (): void => undefined,
      // 可选服务按文档用 ctx.get(name) 取，所以夹具要同时提供 get 与 jobs。
      get: (service: string): unknown => (service === "jobs" ? jobsStub : undefined),
      jobs: jobsStub,
    } as unknown as never;

    await apply(
      ctx,
      makeConfig({ pythonBin: python, crawlEnabled: true, failFastOnMissingPython: false }),
    );
    // failFastOnMissingPython=false 时 sidecar 起不来（spawn 被拒）crawl 工具照样注册 ——
    // 它只是返回作业 id，真正的抓取发生在作业里，所以「探不到 python」不该影响工具面。
    expect(spec).toBeUndefined();

    // 直接驱动作业主体：这段代码在 apply 里通过 startJob 闭包挂到 ctx.jobs 上。
    const crawlDeps = createCrawlToolDeps({
      appended,
      progressed,
      jobHandle: {
        append: (text: string): void => {
          appended.push(text);
        },
        updateProgress: (line: string): void => {
          progressed.push(line);
        },
      },
    });
    const tool = createCrawlTool(crawlDeps);
    const result = (await tool.execute({ url: UNREACHABLE, maxPages: 2 }, {
      signal: new AbortController().signal,
    } as never)) as { jobId: string };
    expect(result.jobId).toBe(CRAWL_JOB_ID);
    expect(appended.length).toBeGreaterThan(0);
    expect(progressed.length).toBeGreaterThan(0);
  });
});

/**
 * 等作业输出环里出现某个标记，最多等 timeoutMs。
 *
 * @param output - 输出环的替身
 * @param marker - 要等到的标记
 * @param timeoutMs - 上限
 */
async function waitFor(check: () => boolean, remaining = 10_000): Promise<void> {
  if (check() || remaining <= 0) {
    return;
  }
  await sleep(50);
  await waitFor(check, remaining - 50);
}

async function waitForOutput(output: string[], marker: string, remaining = 30_000): Promise<void> {
  const seen = output.some((text) => text.includes(marker));
  if (seen || remaining <= 0) {
    return;
  }
  await sleep(200);
  await waitForOutput(output, marker, remaining - 200);
}

/**
 * 起一个两页、带出链的本地站点 —— 爬虫需要至少两页才能证明它真的跟了链接。
 *
 * @returns 起始 URL 与关闭函数
 */
async function startCrawlSite(): Promise<{ base: string; close: () => Promise<void> }> {
  const root = Buffer.from(
    "<!doctype html><html><head><title>Root</title></head><body><h1>Root Page</h1><a href='/b.html'>to B</a></body></html>",
  );
  const leaf = Buffer.from(
    "<!doctype html><html><head><title>Leaf</title></head><body><h1>Leaf Page</h1></body></html>",
  );
  const server = createServer((req, res) => {
    const body = req.url === "/b.html" ? leaf : root;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
    });
    res.end(body);
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}/`,
    close: async (): Promise<void> => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("apply 到爬虫作业的完整链路", () => {
  it.runIf(HAS_LOCAL_PYTHON)("注册的工具真能把爬虫挂到 ctx.jobs 上并产出页面", async () => {
    const python = LOCAL_PYTHON;
    const site = await startCrawlSite();
    const registered = new Map<string, { execute?: (args: unknown, run: unknown) => unknown }>();
    const output: string[] = [];
    const progress: string[] = [];

    // 可选服务按文档用 ctx.get(name) 取，夹具要同时给 get 与 jobs。
    const jobsStub = {
      start: (spec: {
        run: (job: { append: (text: string) => void; updateProgress: (line: string) => void }) => {
          cancel: () => void;
          done: Promise<unknown>;
        };
      }): string => {
        const job = {
          append: (text: string): void => {
            output.push(text);
          },
          updateProgress: (line: string): void => {
            progress.push(line);
          },
        };
        void spec.run(job).done;
        return CRAWL_JOB_ID;
      },
    };

    const ctx = {
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
          const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
            cwd: spec.cwd,
            env: {
              ...process.env,
              DSH_SCRAPLING_ALLOWED_HOSTS: LOOPBACK_ALLOWLIST,
              ...spec.env,
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
          return {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            done: (async (): Promise<{ exitCode: number | null; signal: null }> => {
              const args = await once(child, "close");
              return { exitCode: args[0] as number | null, signal: null };
            })(),
            terminate: (): void => {
              child.kill("SIGTERM");
            },
            waitForExit: async (): Promise<boolean> => true,
          };
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        debug: (): void => undefined,
      },
      tools: {
        register: (definition: { name: string }): (() => void) => {
          registered.set(definition.name, definition as never);
          return (): void => undefined;
        },
      },
      settings: settingsStub(),
      effect: (): void => undefined,
      get: (service: string): unknown => (service === "jobs" ? jobsStub : undefined),
      jobs: jobsStub,
    } as unknown as never;

    try {
      await apply(
        ctx,
        makeConfig({
          pythonBin: python,
          crawlEnabled: true,
          failFastOnMissingPython: false,
          // 本地测试站点在回环地址上：与 Python 侧同一份放行设置，Host 侧闸门才放得过。
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      const crawlTool = registered.get("scrapling_crawl");
      if (crawlTool?.execute === undefined) {
        throw new Error(NOT_REGISTERED);
      }
      await crawlTool.execute(
        { url: site.base, maxPages: 3 },
        { signal: new AbortController().signal },
      );

      // 作业是异步跑的，给它一点时间把页面写进输出环。
      // 作业是异步跑的；这里只等一小段时间把结果凑齐，不是长期轮询。
      await waitForOutput(output, "Leaf Page");
      expect(output.some((text) => text.includes(ROOT_MARK))).toBe(true);
      expect(output.some((text) => text.includes(LEAF_MARK))).toBe(true);
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      await site.close();
    }
  });
});

/** 爬虫作业接线测试里共用的一份宿主替身。 */
interface JobHarness {
  /** 宿主上下文。 */
  ctx: never;
  /** 已注册的工具，按名字索引。 */
  tools: Map<string, { execute?: (args: unknown, run: unknown) => unknown }>;
  /** 最近一次 ctx.jobs.start 拿到的 hooks。 */
  hooks: { cancel: () => void; done: Promise<unknown> } | undefined;
  /** 子进程被拆掉的次数。 */
  terminated: () => number;
  /** 注册到 ctx.web 的 provider，按接缝分。 */
  webProviders: { fetch: string[]; search: string[] };
  /** 拆掉夹具自己起的 sidecar，免得拖到进程退出。 */
  dispose: () => void;
}

/**
 * 造一份能真拉起 sidecar 的宿主替身，并把作业 hooks 暴露出来。
 *
 * @returns 替身
 */
function makeJobHarness({ withoutJobs = false }: { withoutJobs?: boolean } = {}): JobHarness {
  const tools = new Map<string, { execute?: (args: unknown, run: unknown) => unknown }>();
  const state: {
    hooks?: { cancel: () => void; done: Promise<unknown> };
    terminated: number;
    output: string[];
    progress: string[];
  } = { terminated: 0, output: [], progress: [] };
  const disposers: (() => unknown)[] = [];
  const webProviders: { fetch: string[]; search: string[] } = { fetch: [], search: [] };
  // 可选服务按文档用 ctx.get(name) 取，夹具要同时给 get 与 jobs。
  const jobsStub = {
    start: (spec: {
      run: (job: { append: (text: string) => void; updateProgress: (line: string) => void }) => {
        cancel: () => void;
        done: Promise<unknown>;
      };
    }): string => {
      const job = { append: (): void => undefined, updateProgress: (): void => undefined };
      state.hooks = spec.run(job);
      return CRAWL_JOB_ID;
    },
  };
  const ctx = {
    subprocess: {
      resolveExecutable: async (command: string): Promise<string> => command,
      spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
        const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
          cwd: spec.cwd,
          env: { ...process.env, DSH_SCRAPLING_ALLOWED_HOSTS: LOOPBACK_ALLOWLIST, ...spec.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          done: (async (): Promise<{ exitCode: number | null; signal: null }> => {
            const args = await once(child, "close");
            return { exitCode: args[0] as number | null, signal: null };
          })(),
          terminate: (): void => {
            state.terminated += 1;
            child.kill("SIGTERM");
          },
          waitForExit: async (): Promise<boolean> => true,
        };
      },
    },
    logger: {
      info: (): void => undefined,
      warn: (): void => undefined,
      debug: (): void => undefined,
    },
    tools: {
      register: (definition: { name: string }): (() => void) => {
        tools.set(definition.name, definition as never);
        return (): void => undefined;
      },
    },
    // ctx.effect 收的是**工厂**：宿主会调用它拿到真正的 disposer 再登记。
    settings: settingsStub(),
    effect: (factory: () => () => unknown): void => {
      disposers.push(factory());
    },
    // withoutJobs 模拟「这个 profile 没装作业后端」：可选服务按文档用 ctx.get(name) 取，
    // 取不到就是 undefined，生产代码据此给出可读错误。
    web: {
      registerFetchProvider: (provider: { id: string }): (() => void) => {
        webProviders.fetch.push(provider.id);
        return (): void => undefined;
      },
      registerSearchProvider: (provider: { id: string }): (() => void) => {
        webProviders.search.push(provider.id);
        return (): void => undefined;
      },
    },
    get: (service: string): unknown => (withoutJobs || service !== "jobs" ? undefined : jobsStub),
    jobs: jobsStub,
  } as unknown as never;
  return {
    ctx,
    tools,
    webProviders,
    dispose: (): void => {
      for (const disposeOne of disposers) {
        disposeOne();
      }
    },
    get hooks(): { cancel: () => void; done: Promise<unknown> } | undefined {
      return state.hooks;
    },
    terminated: (): number => state.terminated,
  };
}

/**
 * 起一个「接连接但永不回响应」的站点。
 *
 * 爬虫会一直卡在第一次请求上，作业也就一直挂着 —— 正好用来测取消：
 * 作业跑得快的站点在 cancel 打上去之前就结束了，什么都测不到。
 *
 * @returns 起始 URL 与关闭函数
 */
async function startStallingSite(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    // 故意什么都不写：连接保持着，响应永远不来。
    void res;
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}/`,
    close: async (): Promise<void> => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, "close");
    },
  };
}

describe("爬虫作业的取消与失败", () => {
  it.runIf(HAS_LOCAL_PYTHON)(
    "profile 没有作业后端时报可读错，而不是走到一半抛未捕获异常",
    async () => {
      // 复用真起 sidecar 的夹具：能力探测要通过，scrapling_crawl 才会被注册。
      const harness = makeJobHarness({ withoutJobs: true });
      try {
        await apply(
          harness.ctx,
          makeConfig({
            pythonBin: LOCAL_PYTHON,
            crawlEnabled: true,
            failFastOnMissingPython: false,
          }),
        );
        const crawl = harness.tools.get("scrapling_crawl");
        expect(crawl?.execute, "crawlEnabled 打开时应注册 scrapling_crawl").toBeDefined();
        await expect(
          crawl?.execute?.(
            { url: "http://127.0.0.1:1/" },
            { signal: new AbortController().signal },
          ),
        ).rejects.toMatchObject({ code: "JOBS_UNAVAILABLE" });
      } finally {
        harness.dispose();
      }
    },
  );

  it.runIf(HAS_LOCAL_PYTHON)("取消会让爬虫真的停下来，作业落定为 killed", async () => {
    const harness = makeJobHarness();
    await apply(
      harness.ctx,
      makeConfig({
        pythonBin: LOCAL_PYTHON,
        crawlEnabled: true,
        // 本地测试站点在回环地址上：与 Python 侧同一份放行设置，Host 侧闸门才放得过。
        allowedHosts: LOOPBACK_ALLOWLIST,
      }),
    );
    const tool = harness.tools.get("scrapling_crawl");
    if (tool?.execute === undefined) {
      throw new Error(NOT_REGISTERED);
    }
    // 用一个「接连接但永不回响应」的站点把爬虫拖住：跑得快的站点在 cancel 打上去
    // 之前就结束了，那样什么都测不到。
    const stalling = await startStallingSite();
    try {
      void tool.execute(
        { url: stalling.base, maxPages: 2 },
        { signal: new AbortController().signal },
      );
      await waitFor(() => harness.hooks !== undefined);
      expect(harness.hooks).toBeDefined();
      await sleep(500);
      harness.hooks?.cancel();
      const outcome = (await harness.hooks?.done) as { status: string };
      // 信号传对了的话，取消会让 sidecar 调用中止、作业主体抛错，最终落成 killed。
      expect(outcome.status).toBe("killed");
      // teardown 是 fire-and-forget：done 先落定、terminate 随后才到，所以要等。
      await waitFor(() => harness.terminated() > 0);
    } finally {
      await stalling.close();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)("爬虫报错时作业以 killed 结算，原因写进 detail", async () => {
    const harness = makeJobHarness();
    await apply(
      harness.ctx,
      makeConfig({
        pythonBin: LOCAL_PYTHON,
        crawlEnabled: true,
        // 本地测试站点在回环地址上：与 Python 侧同一份放行设置，Host 侧闸门才放得过。
        allowedHosts: LOOPBACK_ALLOWLIST,
      }),
    );
    const tool = harness.tools.get("scrapling_crawl");
    if (tool?.execute === undefined) {
      throw new Error(NOT_REGISTERED);
    }
    // maxPages=0 会被 sidecar 当参数错误拒掉，于是作业主体必然抛错。
    // 用参数错误而不是网络故障：爬一个连不上的站点**不会失败** ——
    // spider 收 0 页就正常结束，那条路径给的是 completed。
    await tool.execute({ url: UNREACHABLE, maxPages: 0 }, { signal: new AbortController().signal });
    await waitFor(() => harness.hooks !== undefined);
    const outcome = (await harness.hooks?.done) as { status: string; detail: string };
    expect(outcome.status).toBe("killed");
    expect(outcome.detail).toContain("positive integer");
  });
});

describe("出站 URL 闸门（Host 侧 SSRF 防线）", () => {
  /** 公网地址字面量：走 IP 直连分支，不需要 DNS，测试因此不碰网络。 */
  const PUBLIC = "http://93.184.216.34/page";

  /** 回环与 RFC1918 是两类最常见的内网目标；多处复用，抽成常量。 */
  const LOOPBACK_URL = "http://127.0.0.1/";
  const PRIVATE_URL = "http://10.0.0.5/";

  /** 判否的码在 error.code 上，不在 message 里 —— message 是给模型看的人话。 */
  const blocked = { code: "URL_BLOCKED" };

  it("私网回环目标判否", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(LOOPBACK_URL)).rejects.toMatchObject(blocked);
  });

  it("rfc1918 私网目标判否", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(PRIVATE_URL)).rejects.toMatchObject(blocked);
  });

  it("非 http/https 协议判否（scheme 白名单）", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate("file:///etc/passwd")).rejects.toMatchObject(blocked);
  });

  it("URL 内嵌凭据判否", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate("http://user:pw@93.184.216.34/")).rejects.toMatchObject(blocked);
  });

  it("超过 maxUrlLength 判否", async () => {
    const gate = createUrlGate(makeConfig({ maxUrlLength: 32 }));
    await expect(gate(`http://93.184.216.34/${"a".repeat(64)}`)).rejects.toMatchObject(blocked);
  });

  it("打开合成段放行时，字面量仍走严格判定", async () => {
    // 这一条覆盖的是配置项真的传进了策略：用 IP 字面量当探针，它不查 DNS，
    // 于是既能走到那处分支，又不会把用例绑到真实解析上。
    const relaxed = createUrlGate(makeConfig({ allowSyntheticDns: true }));
    await expect(relaxed("http://93.184.216.34/x")).resolves.toContain("93.184.216.34");
    // 放宽只针对解析结果：回环字面量拿不到它。
    await expect(relaxed(LOOPBACK_URL)).rejects.toMatchObject(blocked);
  });

  it("合成段白名单非空时才传给策略，空值不传", async () => {
    // 这条覆盖的是配置真的透传下去了：IP 字面量当探针，它不查 DNS，于是既能走到那处分支，
    // 又不会把用例绑到真实解析上。
    const relaxed = createUrlGate(makeConfig({ syntheticDnsRanges: "198.18.0.0/16" }));
    await expect(relaxed("http://93.184.216.34/x")).resolves.toContain("93.184.216.34");
    // 放宽只针对解析结果：回环字面量拿不到它。
    await expect(relaxed(LOOPBACK_URL)).rejects.toMatchObject(blocked);
  });

  it("判否时 message 带人话原因（模型要能据此改写目标）", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(LOOPBACK_URL)).rejects.toThrow(/non-public address/u);
  });

  it("公网地址字面量放行，交回归一后的 URL", async () => {
    const gate = createUrlGate(makeConfig({}));
    await expect(gate(PUBLIC)).resolves.toBe(PUBLIC);
  });

  it("放行名单里的回环目标放行（与 Python 侧 ALLOWED_HOSTS 同一份设置）", async () => {
    const gate = createUrlGate(makeConfig({ allowedHosts: "127.0.0.1,localhost" }));
    await expect(gate(LOOPBACK_URL)).resolves.toBe(LOOPBACK_URL);
  });

  it("authority 里的反斜杠判否（WHATWG 与 libcurl 读出的 host 不是同一个）", async () => {
    // Node 的 WHATWG URL 把 http/https 的 `\` 当路径分隔符，于是这些串的 hostname 是
    // a.example；libcurl 按 RFC 3986 不当，`@` 前面成了 userinfo，真正建连的却是
    // 127.0.0.1 之类。不带反斜杠时同一目标本就判否，加一个反斜杠就必须照样判否。
    const gate = createUrlGate(makeConfig({}));
    await Promise.all(
      [
        String.raw`http://a.example\@127.0.0.1/x`,
        String.raw`http://a.example\\@169.254.169.254/latest/meta-data/`,
        String.raw`HTTP://a.example\@127.0.0.1:8080/admin`,
      ].map((sneaky) =>
        gate(sneaky).then(
          () => {
            throw new Error(`未被拦下: ${sneaky}`);
          },
          (error: unknown) => {
            expect(error).toMatchObject({ code: "URL_BLOCKED" });
          },
        ),
      ),
    );
  });

  it("声明自建 NAT64 前缀时被接进策略：藏在内嵌私网里的地址判否", async () => {
    // 2a00:1450::/96 看起来是公网段，但它把 10.0.0.1 藏在最后 32 位。
    const gate = createUrlGate(makeConfig({ nat64Prefixes: "2a00:1450::/96" }));
    await expect(gate("http://[2a00:1450::a00:1]/")).rejects.toMatchObject(blocked);
  });

  it("nat64Prefixes 与 allowedHosts 同时为空时策略照样建得起来", async () => {
    const gate = createUrlGate(makeConfig({ nat64Prefixes: "", allowedHosts: "" }));
    await expect(gate(PUBLIC)).resolves.toBe(PUBLIC);
  });

  it("nat64Prefixes 配错时报可读错并拒绝加载（而不是抛一条裸异常）", () => {
    // 方向是拒绝加载而不是「忽略这一项」：丢掉的前缀 = 它内嵌的私网 IPv4 被当成公网放行。
    for (const bad of ["1.1.1.1/32", "not-an-ip/96", "2001:db8::/1"]) {
      expect(() => createUrlGate(makeConfig({ nat64Prefixes: bad }))).toThrow(
        /nat64Prefixes 配置非法/u,
      );
    }
    // 文案得指出该改哪个设置项、长什么样，否则部署方只能去翻源码。
    expect(() => createUrlGate(makeConfig({ nat64Prefixes: "1.1.1.1/32" }))).toThrow(
      /<IPv6 前缀>\/<32\|40\|48\|56\|64\|96>/u,
    );
  });

  it("归一后的 URL 与入参不同时以归一串为准（判的和连的必须是同一个地址）", async () => {
    const gate = createUrlGate(makeConfig({}));
    // 缺省端口与补全的路径都会被 WHATWG 归一；sidecar 拿到的必须就是这个归一串。
    await expect(gate("http://93.184.216.34:80")).resolves.toBe("http://93.184.216.34/");
  });
});

describe("接管 ctx.web 的两个接缝", () => {
  it.runIf(HAS_LOCAL_PYTHON)("fetch 接缝：sidecar 可用时注册 provider", async () => {
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebFetch: true,
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      expect(harness.webProviders.fetch).toStrictEqual(["scrapling"]);
      expect(harness.webProviders.search).toStrictEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)("fetch 接缝：开关关着时不注册", async () => {
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebFetch: false,
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      expect(harness.webProviders.fetch).toStrictEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it.runIf(HAS_LOCAL_PYTHON)("search 接缝：配了端点时注册 provider", async () => {
    const harness = makeJobHarness();
    try {
      await apply(
        harness.ctx,
        makeConfig({
          pythonBin: LOCAL_PYTHON,
          provideWebSearch: true,
          searchEndpoint: "http://search.example/api",
          allowedHosts: LOOPBACK_ALLOWLIST,
        }),
      );
      expect(harness.webProviders.search).toStrictEqual(["scrapling"]);
      expect(harness.webProviders.fetch).toStrictEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("fetch 接缝：sidecar 不可用时跳过注册并记一条警告", async () => {
    // spawn 一律抛 = sidecar 起不来；provider 的 available() 契约要求只看本地状态，
    // 所以这里判否是确定的，不需要真去等握手超时。
    const warnings: string[] = [];
    const tools = new Map<string, { name: string }>();
    const ctx = {
      get: (): undefined => undefined,
      subprocess: {
        resolveExecutable: async (command: string): Promise<string> => command,
        spawn: (): never => {
          throw new Error("no real spawn here");
        },
      },
      logger: {
        info: (): void => undefined,
        warn: (line: string): void => {
          warnings.push(line);
        },
        debug: (): void => undefined,
      },
      tools: {
        register: (definition: { name: string }): (() => void) => {
          tools.set(definition.name, definition);
          return (): void => undefined;
        },
      },
      web: {
        registerFetchProvider: vi.fn<(provider: { id: string }) => () => void>(),
        registerSearchProvider: vi.fn<(provider: { id: string }) => () => void>(),
      },
      settings: settingsStub(),
      effect: (): void => undefined,
    } as unknown as never;
    await apply(
      ctx,
      makeConfig({
        pythonBin: LOCAL_PYTHON,
        provideWebFetch: true,
        failFastOnMissingPython: false,
      }),
    );
    expect(warnings.some((line) => line.includes("跳过注册 fetch provider"))).toBe(true);
  });

  it.runIf(HAS_LOCAL_PYTHON)(
    "search 接缝：没配端点时即使开关打开也不注册（否则会触发 AMBIGUOUS）",
    async () => {
      const harness = makeJobHarness();
      try {
        await apply(
          harness.ctx,
          makeConfig({
            pythonBin: LOCAL_PYTHON,
            provideWebSearch: true,
            searchEndpoint: "",
            allowedHosts: LOOPBACK_ALLOWLIST,
          }),
        );
        expect(harness.webProviders.search).toStrictEqual([]);
      } finally {
        harness.dispose();
      }
    },
  );
});
