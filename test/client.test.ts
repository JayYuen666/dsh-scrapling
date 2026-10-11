// dsh-scrapling/test/client.test.ts —— Client 半：结果行规格与 slot 注册。
//
// Client 半跑在浏览器里，没法在这里起真客户端；所以把可测的部分拆成纯函数
// （buildRow）与一段注册逻辑（apply 用假 ctx 驱动），两者都能在 Node 下验证。

import { describe, expect, it } from "vitest";
import { buildRow, readArgs, ROW_TOOLS } from "../src/client-entry.ts";
import { BUNDLE_PACKAGE_NAME, LOCALE_NS, SETTINGS_ENTRY_ID } from "../src/settings-fields.ts";

/** 测试里反复用到的示例地址。 */
const SAMPLE = "https://example.test/a";

/** claimApply 写在 globalThis 上的 HMR 幂等标记；每个用例开始前都要复位。 */
const GLOBAL_FLAG = "__dshScraplingToolviewApplied";

/** 复位幂等标记，让 apply 在本用例里真的跑起来。 */
function resetApplyFlag(): void {
  Reflect.deleteProperty(globalThis, GLOBAL_FLAG);
}

/** 「读不到」的两个读取器都给 undefined。 */
const NO_VALUE = (): undefined => undefined;

/** 什么都不做的替身。 */
const NO_OP = (): void => undefined;

describe("buildRow", () => {
  it("抓取类展示 URL 与 HTTP 状态", () => {
    const row = buildRow(
      "scrapling_fetch",
      { url: SAMPLE },
      { url: SAMPLE, statusCode: 200, truncated: false },
    );
    expect(row.title).toBe("scrapling_fetch");
    expect(row.fields).toStrictEqual([
      { labelKey: "row.url", value: SAMPLE },
      { labelKey: "row.http", value: "200" },
    ]);
  });

  it("投影缺失时退回参数里的 URL", () => {
    const row = buildRow("scrapling_render", { url: "https://example.test/b" }, undefined);
    expect(row.fields[0]).toStrictEqual({ labelKey: "row.url", value: "https://example.test/b" });
  });

  it("截断时明确标出来", () => {
    const row = buildRow(
      "scrapling_render",
      { url: "u" },
      { url: "u", statusCode: 200, truncated: true },
    );
    expect(row.fields).toContainEqual({
      labelKey: "row.body",
      value: "",
      valueKey: "row.truncated",
    });
  });

  it("两边都是垃圾时不抛，字段为空", () => {
    const row = buildRow("scrapling_fetch", "nope", 42);
    expect(row.fields).toStrictEqual([]);
    expect(row.title).toBe("scrapling_fetch");
  });

  it("extract 带选择器标题与匹配数", () => {
    const row = buildRow("scrapling_extract", { selector: "table td" }, { count: 7 });
    expect(row.title).toBe("scrapling_extract table td");
    expect(row.fields).toStrictEqual([{ labelKey: "row.matched", value: "7" }]);
  });

  it("extract 没有选择器时只给工具名", () => {
    expect(buildRow("scrapling_extract", {}, {}).title).toBe("scrapling_extract");
  });

  it("session_open 展示类型与会话 id", () => {
    const row = buildRow("scrapling_session_open", { sessionType: "browser" }, { sessionId: "s1" });
    expect(row.fields).toStrictEqual([
      { labelKey: "row.type", value: "browser" },
      { labelKey: "row.session", value: "s1" },
    ]);
  });

  it("session_close / session_list 各有各的字段", () => {
    expect(buildRow("scrapling_session_close", { sessionId: "s1" }, {}).fields).toStrictEqual([
      { labelKey: "row.session", value: "s1" },
    ]);
    expect(buildRow("scrapling_session_list", {}, { count: 3 }).fields).toStrictEqual([
      { labelKey: "row.sessionCount", value: "3" },
    ]);
  });

  it("crawl 展示起始、上限与作业 id", () => {
    const row = buildRow(
      "scrapling_crawl",
      { url: "https://example.test", maxPages: 20 },
      { jobId: "scrapling-1" },
    );
    expect(row.fields).toStrictEqual([
      { labelKey: "row.start", value: "https://example.test" },
      { labelKey: "row.pageCap", value: "20" },
      { labelKey: "row.job", value: "scrapling-1" },
    ]);
  });

  it("每个登记的工具都能产出一行", () => {
    for (const tool of ROW_TOOLS) {
      const row = buildRow(tool, { url: "u", selector: "s" }, { url: "u", statusCode: 200 });
      expect(row.tool).toBe(tool);
    }
  });
});

describe("readArgs", () => {
  it("视图缺席时给空对象", () => {
    expect(readArgs(undefined)).toStrictEqual({});
  });

  it("字符串走 text()，非字符串走 value()，都只取 buildRow 用得到的键", () => {
    const seen: string[] = [];
    const args = readArgs({
      text: (key) => {
        seen.push(`text:${key}`);
        return key === "url" ? "https://a" : undefined;
      },
      value: (key) => {
        seen.push(`value:${key}`);
        return key === "maxPages" ? 20 : undefined;
      },
    });
    expect(args).toStrictEqual({ url: "https://a", maxPages: 20 });
    expect(seen.filter((entry) => entry.endsWith(":selector"))).not.toHaveLength(0);
  });

  it("text() 命中时不再问 value()", () => {
    const asked: string[] = [];
    readArgs({
      text: () => "x",
      value: (key) => {
        asked.push(key);
        return 1;
      },
    });
    expect(asked).toStrictEqual([]);
  });

  it("两个读取器都给 undefined 的键不进对象", () => {
    expect(readArgs({ text: NO_VALUE, value: NO_VALUE })).toStrictEqual({});
  });
});

const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";
const TOOLVIEW_SLOT = "tool.call.toolview";

/** 一个够用的假 ctx：locale 与 configForms 都在，inject 直接同步执行。 */
function harness(): {
  ctx: unknown;
  registered: { name: string; key?: string; locale?: string }[];
  renderers: Map<string, (props: unknown) => unknown>;
  dictionaries: { ns: string; locale: string }[];
  asked: string[];
} {
  const registered: { name: string; key?: string; locale?: string }[] = [];
  const dictionaries: { ns: string; locale: string }[] = [];
  const asked: string[] = [];
  const renderers = new Map<string, (props: unknown) => unknown>();
  const slots = {
    inject: (_slot: string, register: () => void): void => {
      register();
    },
    register: (
      options: { name: string; key?: string; locale?: string },
      render: (props: never) => unknown,
    ): (() => void) => {
      registered.push(options);
      renderers.set(options.name, render as (props: unknown) => unknown);
      return NO_OP;
    },
  };
  const disposers: (() => void)[] = [];
  const face = {
    slots,
    // cordis 的 effect 会**立刻**执行函数体并持有它的返回值，测试替身必须照做：
    // 少了这一步，effect 里的注册一次都不会发生。
    effect: (run: () => unknown): unknown => {
      const dispose = run();
      if (typeof dispose === "function") {
        const undo = dispose as () => void;
        disposers.push(() => {
          undo();
        });
      }
      return dispose;
    },
    locale: {
      register: (ns: string, locale: string): (() => void) => {
        dictionaries.push({ ns, locale });
        return NO_OP;
      },
      bind:
        (): ((key: string) => string) =>
        (key: string): string =>
          key,
    },
    configForms: {
      get: (entryId: string) => {
        asked.push(entryId);
        return {
          getSnapshot: () => ({
            status: "ready" as const,
            value: {},
            revision: 7,
            writable: true,
          }),
          mutate: async () => true,
        };
      },
    },
    inject: (_deps: readonly string[], run: (ctx: unknown) => void): void => {
      run(face);
    },
  };
  return { ctx: face, registered, renderers, dictionaries, asked };
}

describe("apply", () => {
  it("注入清单里只有 slots，可选服务走 ctx.inject 才不会拖垮缺它们的 profile", async () => {
    const { ctx, registered } = harness();
    resetApplyFlag();
    const { apply, inject } = await import("../src/client-entry.ts");
    apply(ctx as never);
    expect(inject).toStrictEqual(["slots"]);
    expect(
      registered.filter((entry) => entry.name === TOOLVIEW_SLOT).map((entry) => entry.key),
    ).toStrictEqual(ROW_TOOLS);
  });

  it("结果行清单覆盖 host.ts 注册的每个工具，少一个就少画一行", () => {
    expect(ROW_TOOLS).toContain("scrapling_answer");
    expect(new Set(ROW_TOOLS).size).toBe(ROW_TOOLS.length);
  });

  it("设置卡挂在 plugins.bundle.config 上，键是包名，并带上 locale 席位", async () => {
    const { ctx, registered } = harness();
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    const card = registered.filter((entry) => entry.name === BUNDLE_CONFIG_SLOT);
    expect(card).toStrictEqual([
      { name: BUNDLE_CONFIG_SLOT, key: BUNDLE_PACKAGE_NAME, locale: LOCALE_NS },
    ]);
  });

  it("取值走本包的设置命名空间 —— bundle 页的 owner props 里没有 form", async () => {
    const { ctx, asked } = harness();
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    expect(asked).toStrictEqual([SETTINGS_ENTRY_ID]);
  });

  it("字典整份插件只注册一次，中英各一份", async () => {
    const { ctx, dictionaries } = harness();
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    expect(dictionaries).toStrictEqual([
      { ns: LOCALE_NS, locale: "zh" },
      { ns: LOCALE_NS, locale: "en" },
    ]);
  });

  it("宿主给的 props 里没有 form，卡片也必须拿到一个 —— 这正是这张卡曾经空白的原因", async () => {
    const { ctx, renderers } = harness();
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    const render = renderers.get(BUNDLE_CONFIG_SLOT);
    if (render === undefined) {
      throw new Error("设置卡没有注册");
    }
    // 插件管理器渲染 bundle 页时 owner props 只有 view 与 locale 席位给的 t。
    const element = render({ view: "page", t: (key: string): string => key }) as {
      props: { form?: { state: unknown } };
    };
    expect(element.props.form).toBeDefined();
    expect(element.props.form?.state).toStrictEqual({
      status: "ready",
      value: {},
      revision: 7,
      writable: true,
    });
  });

  it("结果行的 render 也接上了真实 owner props，而不是渲染一个空壳", async () => {
    const { ctx, renderers } = harness();
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    const render = renderers.get(TOOLVIEW_SLOT);
    if (render === undefined) {
      throw new Error("结果行没有注册");
    }
    const element = render({
      toolName: "scrapling_fetch",
      block: { phase: "result", args: { text: NO_VALUE, value: NO_VALUE } },
    }) as { type?: unknown; props: { block?: unknown; toolName?: string } };
    // 交给宿主渲染器的是一个组件元素；RowView 自身才是真正读 block 的那一层。
    expect(element.type).toBeTypeOf("function");
    // props 里带着宿主给的 block，而不是本包自己的一份 args —— 这一条正是「结果行只剩
    // 工具名」的根因：早先 RowView 只接了一个 tool 字符串，owner props 整个被丢掉。
    expect(element.props.block).toBeDefined();
    expect(element.props.toolName).toBe("scrapling_fetch");
  });

  it("重复 apply 不会二次注册（HMR 幂等）", async () => {
    const { ctx, registered } = harness();
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    const first = registered.length;
    apply(ctx as never);
    expect(registered).toHaveLength(first);
  });
});
