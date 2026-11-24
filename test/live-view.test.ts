// lib/live-view.ts 与「工具设置热处理」的回归测试。
//
// 这一组钉的是本轮修掉的那类缺陷：宿主对设置卡的改动**只换 volatile 引用背后的值、
// 不重跑 `apply`**（`cordis-plugin-loader` 的 `_commitVolatile()` → `cosmokit` 的
// `updateVolatile`），而工具 builder 每个只被调用一次。于是装配期把 `.get()` 收成常量再
// 传下去，`extractionType` / `headless` / `fetchMaxOutputChars` 这些旋钮改完就永不生效 ——
// 卡片上保存成功、刷新也持久，工具行为纹丝不动，且没有任何报错。
//
// 判据一律写成「改引用背后的值 → 再读一次」，读的是**同一个对象**（生产里 builder 只拿
// 一次，第二次读到新值才说明它是活视图）。只断言「装配时值对」的写法对这类缺陷完全不敏感。
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { liveView } from "../lib/live-view.ts";
import { bindLiveTimeout, createFetchTool, toolTimeoutOf } from "../lib/tools.ts";
import type { ToolDeps, ToolSettings } from "../lib/tools.ts";
import { settingsViewOf } from "../host.ts";
import type { Config } from "../host.ts";

/** 本文件里每一处假抓取共用的地址：它不访问网络，只是把 sidecar 的帧记下来。 */
const PROBE_URL = "https://example.test/";
const WRITE = Symbol.for("cosmokit.volatile.writable");

/** 一枚可原地换值的 volatile 引用，形状与 `cosmokit` 的 `Volatile` 一致。 */
function ref<Item>(initial: Item): { get: () => Item; [WRITE]: (next: Item) => void } {
  let current = initial;
  return {
    get: () => current,
    [WRITE]: (next: Item): void => {
      current = next;
    },
  };
}

/** 把引用换成新值 —— 复刻宿主 `updateVolatile` 的做法：原地写，引用对象身份不变。 */
function commit<Item>(target: { [WRITE]: (next: Item) => void }, next: Item): void {
  target[WRITE](next);
}

/** 只记 sidecar 收到的帧，回一个最小可用的抓取结果。 */
function recordingSidecar(): { client: never; frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  const client = {
    call: async (_method: string, params: Record<string, unknown>): Promise<unknown> => {
      frames.push(params);
      return { url: PROBE_URL, status: 200, content: "ok", truncated: false };
    },
  };
  return { client: client as never, frames };
}

describe("liveView", () => {
  it("属性每次访问都现算：同一个对象在引用换值后读到新值", () => {
    const color = ref("red");
    const view = liveView(() => ({ color: color.get(), size: 3 }));
    expect(view.color).toBe("red");
    commit(color, "blue");
    expect(view.color).toBe("blue");
  });

  it("键集取自第一次读取，且是真实自有属性（可枚举、可解构）", () => {
    const view = liveView(() => ({ alpha: 1, beta: 2 }));
    expect(Object.keys(view)).toStrictEqual(["alpha", "beta"]);
    const { alpha, beta } = view;
    expect([alpha, beta]).toStrictEqual([1, 2]);
  });

  it("对象展开会把 getter 求值成快照 —— 这是调用侧必须避开的坑", () => {
    const color = ref("red");
    const view = liveView(() => ({ color: color.get() }));
    const spread = { ...view };
    commit(color, "blue");
    expect(view.color, "活视图本身仍然现读").toBe("blue");
    expect(spread.color, "展开后的对象冻在展开那一刻").toBe("red");
  });
});

describe("bindLiveTimeout", () => {
  it("注册级墙钟改引用后跟着变，且是内层超时 + 余量", () => {
    const timeoutMs = ref(30_000);
    const settings = liveView(() => ({ timeoutMs: timeoutMs.get() })) as unknown as ToolSettings;
    const built = {
      name: "probe",
      description: "",
      parameters: {},
      output: { schema: {}, render: () => [] },
      execute: async () => ({}),
    } as unknown as ToolDefinition;
    const tool = bindLiveTimeout(built, settings);
    // 余量由 toolTimeoutOf 自己加：判据用同一函数算期望，只把内层超时换掉。
    expect(tool.timeoutMs).toBe(toolTimeoutOf({ ...settings, timeoutMs: 30_000 }));
    commit(timeoutMs, 120_000);
    expect(tool.timeoutMs, "改设置后同一枚工具定义的墙钟跟着变").toBe(
      toolTimeoutOf({ ...settings, timeoutMs: 120_000 }),
    );
    expect(tool.timeoutMs).toBe(180_000);
  });
});

/** 造一份最小 Config：只填这条判据用得到的 volatile 引用与部署值。 */
function configOf(refs: {
  extractionType: ReturnType<typeof ref<string>>;
  mainContentOnly: ReturnType<typeof ref<boolean>>;
  fetchTimeoutMs: ReturnType<typeof ref<number>>;
  fetchMaxOutputChars: ReturnType<typeof ref<number>>;
}): Config {
  return {
    ...refs,
    dataDir: ref(""),
    downloadMaxBytes: 1,
    documentMaxBytes: 20 * 1024 * 1024,
    documentMaxPages: 200,
    documentMaxOutputChars: 200_000,
    requestTimeoutSeconds: 120,
    crawlMaxRuntimeSeconds: 1800,
    browserExecutablePath: "",
    browserInitScript: "",
    browserCdpUrl: "",
    browserRealChrome: false,
    browserDnsOverHttps: false,
    recordRequests: false,
    maxRecordedRequests: 1,
    sessionStateDir: "",
    adaptiveStorage: "sqlite",
    redisUrl: "",
    crawlRespectRobots: false,
    crawlDownloadDelayMs: 0,
    crawlConcurrentRequests: 1,
    crawlAutothrottle: false,
    crawlStrategy: "bfs",
    crawlCheckpointDir: "",
    allowWriteMethods: false,
    headless: ref(true),
    networkIdle: ref(false),
    waitSelectorState: ref("attached"),
    pierceShadow: ref(false),
    blockAds: ref(true),
    crawlMaxItems: ref(1000),
    stripInlineImages: ref(true),
  } as unknown as Config;
}

describe("settingsViewOf", () => {
  it("抽取类字段改引用后立即生效（装配期快照会在这里红）", () => {
    const extractionType = ref("markdown");
    const mainContentOnly = ref(true);
    const config = configOf({
      extractionType,
      mainContentOnly,
      fetchTimeoutMs: ref(120_000),
      fetchMaxOutputChars: ref(4000),
    });
    const view = settingsViewOf(config, "/tmp/data", "scrapling_fetch");
    expect([view.extractionType, view.mainContentOnly]).toStrictEqual(["markdown", true]);
    commit(extractionType, "html");
    commit(mainContentOnly, false);
    expect([view.extractionType, view.mainContentOnly]).toStrictEqual(["html", false]);
  });

  it("输出预算按工具名分别算，且改引用后立即生效", () => {
    const fetchMaxOutputChars = ref(4000);
    const config = configOf({
      extractionType: ref("markdown"),
      mainContentOnly: ref(true),
      fetchTimeoutMs: ref(120_000),
      fetchMaxOutputChars,
    });
    const fetchView = settingsViewOf(config, "/tmp/data", "scrapling_fetch");
    expect(fetchView.maxOutputBytes).toBe(4000);
    commit(fetchMaxOutputChars, 9000);
    expect(fetchView.maxOutputBytes).toBe(9000);
  });
});

describe("工具跑到执行期时才读设置", () => {
  it("builder 只调用一次，之后改 volatile 引用，execute 仍读到新值", async () => {
    const extractionType = ref("markdown");
    const mainContentOnly = ref(true);
    const config = configOf({
      extractionType,
      mainContentOnly,
      fetchTimeoutMs: ref(30_000),
      fetchMaxOutputChars: ref(4000),
    });
    const settings = settingsViewOf(config, "/tmp/data", "scrapling_fetch");
    const { client, frames } = recordingSidecar();
    const deps: ToolDeps = {
      sidecar: client,
      settings,
      startCrawlJob: async () => "job",
      answer: async () => ({ answer: "", provider: "", model: "" }),
    };
    // 只调用一次 —— 生产里 `spec.build(deps)` 就是这样，只跑一次。
    const tool = createFetchTool(deps);
    const exec = { signal: new AbortController().signal } as never;

    await tool.execute({ url: PROBE_URL }, exec);
    expect(frames.at(-1)?.["extractionType"]).toBe("markdown");
    expect(frames.at(-1)?.["mainContentOnly"]).toBe(true);

    commit(extractionType, "html");
    commit(mainContentOnly, false);
    await tool.execute({ url: PROBE_URL }, exec);
    expect(frames.at(-1)?.["extractionType"], "改设置后不必重建工具").toBe("html");
    expect(frames.at(-1)?.["mainContentOnly"]).toBe(false);
  });
});
