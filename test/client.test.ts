// dsh-scrapling/test/client.test.ts —— Client 半：结果行规格与 slot 注册。
//
// Client 半跑在浏览器里，没法在这里起真客户端；所以把可测的部分拆成纯函数
// （buildRow）与一段注册逻辑（apply 用假 ctx 驱动），两者都能在 Node 下验证。

import { describe, expect, it } from "vitest";
import { buildRow, readArgs, resultMetaOf, ROW_TOOLS } from "../src/client-entry.ts";
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

// cordis 的 effect 会**立刻**执行函数体并持有它的返回值，测试替身必须照做：少了这一步，
// effect 里的注册一次都不会发生。
const RUN_EFFECT_IMMEDIATELY = (run: () => unknown): unknown => run();

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

/**
 * 宿主的 toolview props 把阶段写在顶层，`block` 是按阶段变形的联合。
 * 这一组期望写死成字面量：把判据改成从 `resultMetaOf` 反推，它就只是在复读自己。
 */
describe("resultMetaOf", () => {
  it("只有 result 那一支才交回投影", () => {
    const meta = { statusCode: 200, url: SAMPLE };
    expect(resultMetaOf({ phase: "result", block: { meta } } as never)).toStrictEqual(meta);
  });

  it("start 那一支没有 meta 可读，即便宿主给了也不认", () => {
    expect(
      resultMetaOf({ phase: "start", block: { meta: { statusCode: 200 } } } as never),
    ).toBeUndefined();
  });

  it("preparing 那一支同样不交回投影", () => {
    expect(
      resultMetaOf({ phase: "preparing", block: { meta: { statusCode: 200 } } } as never),
    ).toBeUndefined();
  });

  it("落定了但投影还没进来时是 undefined，而不是抛", () => {
    expect(resultMetaOf({ phase: "result", block: {} } as never)).toBeUndefined();
  });

  it("阶段写在 block 里不是宿主的形状：那种 props 一律读不到投影", () => {
    // 这条钉的是修复前的坏形状：宿主从不把 phase 放进 block，所以那时结果侧的字段永远不渲染。
    expect(
      resultMetaOf({ block: { phase: "result", meta: { statusCode: 200 } } } as never),
    ).toBeUndefined();
  });
});

const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";
const TOOLVIEW_SLOT = "tool.call.toolview";

/** 本包会从 ctx 上读的服务名；替身按 harness 收到的清单决定放行哪几枚。 */
const SERVICE_NAMES = ["slots", "locale", "configForms"];

/**
 * 造一个够用的假宿主。
 *
 * `names` 是本包声明给宿主的 inject 清单，ctx 只放行清单里的名字：这就是 cordis 上下文
 * 代理的真行为（@deepseek-ai/cordis 的 `ReflectService.handler.get` —— 没注入的名字抛
 * `cannot get property "<name>" without inject`，而抛出落在 `ctx.effect` 体内时只被记进
 * logger）。替身要是像早先那样把整套服务无条件摆在 ctx 上，「清单里少写一枚
 * configForms」这种错在 Node 下什么都测不出来，真浏览器里的症状却是整张设置卡连同全部结果
 * 行一起静默消失 —— 这个 bug 就是这样躲在替身与宿主的差别里的。
 *
 * @param names - 本包声明注入的服务名
 */
function harness(names: readonly string[] = ["slots", "configForms", "locale"]): {
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
  // 宿主那一版配置：引用恒定（useSyncExternalStore 就靠这一点判「有没有变」），
  // 且整张替身只有一份 —— 与本包对值面的用法一致。
  const hostState = { status: "ready" as const, value: {}, revision: 7, writable: true };
  const listeners: (() => void)[] = [];
  const source = {
    getSnapshot: () => hostState,
    subscribe: (listener: () => void): (() => void) => {
      listeners.push(listener);
      return (): void => {
        const at = listeners.indexOf(listener);
        if (at !== -1) {
          listeners.splice(at, 1);
        }
      };
    },
    mutate: async (): Promise<boolean> => {
      // 宿主收下这笔写入后会替换快照并通知订阅者 —— 卡片靠这一步把新值画上。
      // 先拷一份再遍历：监听者可能在通知里退订，直接遍历会跳过下一个。
      const pending = [...listeners];
      for (const notify of pending) {
        notify();
      }
      return true;
    },
  };
  const services: Record<string, unknown> = {
    slots: {
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
    // 宿主的订阅是引用比较：换了函数就重建订阅。所以值面在注册时造一次，
    // 不能每渲染一次新建一个 —— 下面 configFormsSource 用 source 变量把这点固定住。
    configForms: {
      get: (entryId: string) => {
        asked.push(entryId);
        return source;
      },
    },
  };
  // ctx 只放行清单里的名字，其余名字留一个会炸的 getter，抛的串与宿主逐字相同。
  // effect 不算「注入的服务」—— 它是 @deepseek-ai/cordis 混进每个 ctx 的方法面。
  const ctx: Record<string, unknown> = { effect: RUN_EFFECT_IMMEDIATELY };
  for (const name of SERVICE_NAMES) {
    if (names.includes(name)) {
      ctx[name] = services[name];
    } else {
      Object.defineProperty(ctx, name, {
        get: (): never => {
          throw new Error(`cannot get property "${name}" without inject`);
        },
      });
    }
  }
  return { ctx, registered, renderers, dictionaries, asked };
}

describe("apply", () => {
  it("注入清单交齐 slots、configForms 与 locale：少一枚，卡片与结果行都注册不上", async () => {
    const { ctx, registered } = harness();
    resetApplyFlag();
    const { apply, inject } = await import("../src/client-entry.ts");
    apply(ctx as never);
    // 清单与本包实际读用的服务必须逐字相等 —— 这条断言替我们把宿主那条硬规则钉住。
    expect([...inject].toSorted()).toStrictEqual(["configForms", "locale", "slots"]);
    expect(
      registered.filter((entry) => entry.name === TOOLVIEW_SLOT).map((entry) => entry.key),
    ).toStrictEqual(ROW_TOOLS);
  });

  it("少注入 configForms 时 apply 抛错且卡片消失 —— 宿主里这声抛只进 logger", async () => {
    const { ctx, registered } = harness(["slots", "locale"]);
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    expect(() => {
      apply(ctx as never);
    }).toThrow('cannot get property "configForms" without inject');
    expect(registered.filter((entry) => entry.name === BUNDLE_CONFIG_SLOT)).toStrictEqual([]);
  });

  it("少注入 locale 时连结果行一起丢，不只是卡", async () => {
    const { ctx, registered } = harness(["slots", "configForms"]);
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    expect(() => {
      apply(ctx as never);
    }).toThrow('cannot get property "locale" without inject');
    expect(registered.filter((entry) => entry.name === TOOLVIEW_SLOT)).toStrictEqual([]);
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
      props: {
        form?: { getSnapshot?: () => unknown; subscribe?: unknown; mutate?: unknown };
      };
    };
    expect(element.props.form?.getSnapshot?.()).toStrictEqual({
      status: "ready",
      value: {},
      revision: 7,
      writable: true,
    });
    // subscribe 与 mutate 由卡片直接用，缺一个卡就变成只读且永不更新。
    expect(element.props.form?.subscribe).toBeTypeOf("function");
    expect(element.props.form?.mutate).toBeTypeOf("function");
  });

  it("值面在注册时造一次：每帧换一个新对象等于每帧重建订阅，会漏掉宿主的变更通知", async () => {
    const { ctx, renderers } = harness();
    resetApplyFlag();
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    const render = renderers.get(BUNDLE_CONFIG_SLOT);
    if (render === undefined) {
      throw new Error("设置卡没有注册");
    }
    const face = (): unknown => {
      const element = render({ view: "page", t: (key: string): string => key }) as {
        props: { form?: unknown };
      };
      return element.props.form;
    };
    // useSyncExternalStore 比的是 subscribe 的引用，所以两帧必须拿到同一个对象。
    expect(face()).toBe(face());
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
      phase: "result",
      block: { args: { text: NO_VALUE, value: NO_VALUE }, meta: { statusCode: 200, url: SAMPLE } },
    }) as { type?: unknown; props: { block?: unknown; phase?: string; toolName?: string } };
    // 交给宿主渲染器的是一个组件元素；RowView 自身才是真正读 block 的那一层。
    expect(element.type).toBeTypeOf("function");
    // props 里带着宿主给的 block 与顶层 phase，而不是本包自己的一份 args —— 这一条正是「结果行只剩
    // 工具名」的根因：早先 RowView 只接了一个 tool 字符串，owner props 整个被丢掉。
    expect(element.props.block).toBeDefined();
    expect(element.props.phase).toBe("result");
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
