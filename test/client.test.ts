// dsh-scrapling/test/client.test.ts —— Client 半：结果行规格与 slot 注册。
//
// Client 半跑在浏览器里，没法在这里起真客户端；所以把可测的部分拆成纯函数
// （buildRow）与一段注册逻辑（apply 用假 ctx 驱动），两者都能在 Node 下验证。

import { describe, expect, it } from "vitest";
import { TOOL_SPECS } from "../host.ts";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { apply, buildRow, inject, readArgs, resultMetaOf, ROW_TOOLS } from "../src/client-entry.ts";
import { BUNDLE_PACKAGE_NAME, LOCALE_NS, SETTINGS_ENTRY_ID } from "../src/settings-fields.ts";

/** 测试里反复用到的示例地址。 */
const SAMPLE = "https://example.test/a";

/** 离线解析类结果行共用的命中数标签。 */
const MATCHED_LABEL = "row.matched";

/** claimApply 写在 globalThis 上的 HMR 幂等标记；每个用例开始前都要复位。 */
const GLOBAL_FLAG = "__dshScraplingToolviewApplied";

/** 复位幂等标记，让 apply 在本用例里真的跑起来。 */
function resetApplyFlag(): void {
  Reflect.deleteProperty(globalThis, GLOBAL_FLAG);
}

/** 「读不到」的两个读取器都给 undefined。 */
const NO_VALUE = (): undefined => undefined;

/**
 * 造一个「立刻执行 effect 函数体」的替身工厂，并把 effect 交回的清理函数记进 `sink`。
 *
 * cordis 的 effect 会立刻执行函数体并持有它的返回值，替身必须照做：少了这一步，effect 里的
 * 注册一次都不会发生。返回值是清理函数时还要记一份 —— 宿主到卸载才跑它们，本包的卸载路径
 * （摘样式、注销结果行与字典）全在那一步上，不记下来就永远测不到。
 *
 * @param sink - 收集 effect 返回的清理函数（每个 harness 一份）
 * @returns 可当 `ctx.effect` 用的替身
 */
const makeEffectRunner =
  (sink: (() => void)[]) =>
  (run: () => unknown): unknown => {
    const result = run();
    if (typeof result === "function") {
      sink.push(result as () => void);
    }
    return result;
  };

/**
 * 造一份宿主 toolview 的 props 夹具。
 *
 * 夹具只带本包读的那几位（block 的内容按宿主联合类型无法逐位构造），但**键名与 phase 的
 * 类型**由 `ToolCallViewProps` 约束：宿主把 `phase` 改名或换掉取值集时这里编译红，
 * 而逐处 `as never` 会让漂移只剩运行期那一道防线（宿主 `block` 是按阶段变形的联合，
 * 手抄一份本地接口根本拦不住）。
 *
 * @param props - 本用例要给的几位
 * @returns 交给被测函数的 props
 */
function propsOf(props: {
  phase?: ToolCallViewProps["phase"];
  toolName?: string;
  block?: unknown;
}): ToolCallViewProps {
  return props as ToolCallViewProps;
}

/** 结果行里"会话"那一列的字面量键：本文件多处用到。
 *  刻意写独立字面量而不是引实现的 `ROW_SESSION_KEY`——期望值必须与被测对象各写一份，
 *  引用实现在实现改名时会同步变绿，那条断言就什么都没测。 */
const SESSION_LABEL_KEY = "row.session";
const TYPE_LABEL_KEY = "row.type";

/** 期望的一行 `{ labelKey, value }`：测试里成片出现，抽一处避免同一字面量散落多次。 */
const fieldOf = (labelKey: string, value: string): { labelKey: string; value: string } => ({
  labelKey,
  value,
});

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
    expect(row.fields).toStrictEqual([{ labelKey: MATCHED_LABEL, value: "7" }]);
  });

  it("extract 没有选择器时只给工具名", () => {
    expect(buildRow("scrapling_extract", {}, {}).title).toBe("scrapling_extract");
  });

  it("session_open 展示类型与会话 id", () => {
    const row = buildRow("scrapling_session_open", { sessionType: "browser" }, { sessionId: "s1" });
    expect(row.fields).toStrictEqual([
      { labelKey: TYPE_LABEL_KEY, value: "browser" },
      fieldOf(SESSION_LABEL_KEY, "s1"),
    ]);
  });

  it("session_close / session_list 各有各的字段", () => {
    expect(buildRow("scrapling_session_close", { sessionId: "s1" }, {}).fields).toStrictEqual([
      fieldOf(SESSION_LABEL_KEY, "s1"),
    ]);
    expect(buildRow("scrapling_session_list", {}, { count: 3 }).fields).toStrictEqual([
      { labelKey: "row.sessionCount", value: "3" },
    ]);
  });

  it("session_network 展示会话", () => {
    expect(buildRow("scrapling_session_network", { sessionId: "s2" }, {}).fields).toStrictEqual([
      fieldOf(SESSION_LABEL_KEY, "s2"),
    ]);
  });

  it("登录态存取展示会话与文件名；没给名字就只展示会话", () => {
    for (const tool of ["scrapling_session_state_save", "scrapling_session_state_load"]) {
      expect(buildRow(tool, { sessionId: "s3", name: "login" }, {}).fields).toStrictEqual([
        fieldOf(SESSION_LABEL_KEY, "s3"),
        { labelKey: "row.name", value: "login" },
      ]);
      expect(buildRow(tool, { sessionId: "s3" }, {}).fields).toStrictEqual([
        fieldOf(SESSION_LABEL_KEY, "s3"),
      ]);
    }
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

  it("locate 展示选择器与命中数", () => {
    const row = buildRow("scrapling_locate", { selector: "P1" }, { count: 2 });
    expect(row.title).toBe("scrapling_locate P1");
    expect(row.fields).toStrictEqual([{ labelKey: MATCHED_LABEL, value: "2" }]);
  });

  it("links 展示 baseUrl 与链接数", () => {
    const row = buildRow("scrapling_links", { baseUrl: "https://example.test/" }, { count: 3 });
    expect(row.fields).toStrictEqual([
      { labelKey: "row.url", value: "https://example.test/" },
      { labelKey: MATCHED_LABEL, value: "3" },
    ]);
  });

  it("每个登记的工具都能产出一行", () => {
    for (const tool of ROW_TOOLS) {
      const row = buildRow(tool, { url: "u", selector: "s" }, { url: "u", statusCode: 200 });
      expect(row.tool).toBe(tool);
      // 「结果行只剩工具名」正是这条用例要防的症状：只断 tool 时，某个工具的字段规格被
      // 写成空表或键名拼错都照样绿。字段数按同一份输入逐个钉住。
      expect(row.fields.length, `${tool} 的结果行没有渲染出任何字段`).toBeGreaterThan(0);
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
    // 具体键而不是「有某项以 :selector 结尾」：按白名单一次探测或漏读某个键时，后半句照样绿。
    expect(seen, "selector 要被 text() 读到").toContain("text:selector");
    expect(seen, "links 的 baseUrl 也要被惰性视图读到").toContain("text:baseUrl");
  });

  it("text() 交出空串时仍按 value() 取值：数值参数不能被空串静默吞掉", () => {
    // 惰性视图对非字符串参数给回什么形态不是本包的契约；`??` 只挡 undefined，空串会短路，
    // 于是 crawl 行上的「页数上限」永久空白，而 maxPages 明明在参数里。
    const args = readArgs({
      text: (key) => (key === "maxPages" ? "" : undefined),
      value: (key) => (key === "maxPages" ? 20 : undefined),
    });
    expect(args).toStrictEqual({ maxPages: 20 });
    expect(buildRow("scrapling_crawl", args, { jobId: "job-1" }).fields).toContainEqual({
      labelKey: "row.pageCap",
      value: "20",
    });
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
    expect(resultMetaOf(propsOf({ phase: "result", block: { meta } }))).toStrictEqual(meta);
  });

  it("start 那一支没有 meta 可读，即便宿主给了也不认", () => {
    expect(
      resultMetaOf(propsOf({ phase: "start", block: { meta: { statusCode: 200 } } })),
    ).toBeUndefined();
  });

  it("preparing 那一支同样不交回投影", () => {
    expect(
      resultMetaOf(propsOf({ phase: "preparing", block: { meta: { statusCode: 200 } } })),
    ).toBeUndefined();
  });

  it("落定了但投影还没进来时是 undefined，而不是抛", () => {
    expect(resultMetaOf(propsOf({ phase: "result", block: {} }))).toBeUndefined();
  });

  it("阶段写在 block 里不是宿主的形状：那种 props 一律读不到投影", () => {
    // 这条钉的是修复前的坏形状：宿主从不把 phase 放进 block，所以那时结果侧的字段永远不渲染。
    expect(
      resultMetaOf(propsOf({ block: { phase: "result", meta: { statusCode: 200 } } })),
    ).toBeUndefined();
  });
});

const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";
const TOOLVIEW_SLOT = "tool.call.toolview";

/**
 * 替身里渲染器的登记键。
 *
 * 只用 slot 名当键会把 19 个 key 各不相同的 toolview 压成同一格（后写的盖掉前面的），
 * 于是「按具体工具取渲染器」这种断言写不出来。宿主本来就是按 name+key 登记的。
 */
const rendererKey = (slot: string, key: string): string => `${slot}:${key}`;

/** 宿主配置表单那份快照的形状（本包只按这几位读）。 */
interface HostSnapshot {
  readonly status: "ready";
  readonly value: unknown;
  readonly revision: number;
  readonly writable: boolean;
}

/** 本包会从 ctx 上读的服务名；替身按 harness 收到的清单决定放行哪几枚。 */
const SERVICE_NAMES = ["slots", "locale", "configForms"];

/**
 * 造一个够用的假宿主。
 *
 * `names` 是本包声明给宿主的 inject 清单，ctx 只放行清单里的名字：这就是 cordis 上下文
 * 代理的真行为（`ReflectService.handler.get` 对没注入的名字抛
 * `cannot get property "<name>" without inject`）。抛出发生在 `ctx.effect` 的函数体里时
 * 会穿出 `ctx.effect` / `apply` —— `Fiber._execute` 走 `composeError`，而 `handleError` 每条
 * 路径都以 `throw reason` 收尾（@deepseek-ai/cordis src/fiber.ts、src/utils.ts）；被记进
 * logger 的是**清理函数**那一路（`Fiber._unload` 里 catch 后 `ctx.logger.error`）。所以本文件
 * 断的是「apply 抛出 + 一位都没登记」，界面看不到东西的原因是注册没发生。
 * 替身要是像早先那样把整套服务无条件摆在 ctx 上，「清单里少写一枚 configForms」这种错在
 * Node 下什么都测不出来，真浏览器里的症状却是整张设置卡连同全部结果行一起消失。
 *
 * @param names - 本包声明注入的服务名
 */
function harness(names: readonly string[] = ["slots", "configForms", "locale"]): {
  ctx: unknown;
  registered: { name: string; key?: string; locale?: string }[];
  renderers: Map<string, (props: unknown) => unknown>;
  dictionaries: { ns: string; locale: string }[];
  asked: string[];
  disposed: string[];
  effectDisposers: (() => void)[];
} {
  const effectDisposers: (() => void)[] = [];
  const registered: { name: string; key?: string; locale?: string }[] = [];
  const disposed: string[] = [];
  const dictionaries: { ns: string; locale: string }[] = [];
  const asked: string[] = [];
  const renderers = new Map<string, (props: unknown) => unknown>();
  // 宿主那一版配置：引用恒定（useSyncExternalStore 就靠这一点判「有没有变」），
  // 且整张替身只有一份 —— 与本包对值面的用法一致。
  let hostState: HostSnapshot = { status: "ready", value: {}, revision: 7, writable: true };
  // 下一笔写入是否按「宿主拒绝」收场：版本冲突与只读表单都走这条，卡片要能区分
  // 「没保存上」与「保存成功」，否则用户以为改动了而配置没变。
  let rejectNextWrite = false;
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
    mutate: async (value: unknown): Promise<boolean> => {
      if (rejectNextWrite) {
        rejectNextWrite = false;
        return false;
      }
      // 宿主收下这笔写入后会**换掉**快照对象并通知订阅者 —— 卡片靠这一步把新值画上。
      // 引用必须换：useSyncExternalStore 比的是引用，原地改值等于告诉订阅者「什么都没变」。
      hostState = { ...hostState, value, revision: hostState.revision + 1 };
      // 先拷一份再遍历：监听者可能在通知里退订，直接遍历会跳过下一个。
      const pending = [...listeners];
      for (const notify of pending) {
        notify();
      }
      return true;
    },
    /** 让下一次写入按宿主拒绝（返回 false、快照不动）收场。 */
    rejectNextWrite(): void {
      rejectNextWrite = true;
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
        renderers.set(
          rendererKey(options.name, options.key ?? ""),
          render as (props: unknown) => unknown,
        );
        return (): void => {
          disposed.push(`slot:${options.key ?? options.name}`);
        };
      },
    },
    locale: {
      register: (ns: string, locale: string): (() => void) => {
        dictionaries.push({ ns, locale });
        return (): void => {
          disposed.push(`locale:${ns}/${locale}`);
        };
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
  const ctx: Record<string, unknown> = { effect: makeEffectRunner(effectDisposers) };
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
  return { ctx, registered, renderers, dictionaries, asked, disposed, effectDisposers };
}

/**
 * 造替身、复位 HMR 幂等标记、跑一次 apply，把替身记下的东西交给用例断言。
 *
 * 入口只有一个：模块在本文件顶部就是静态导入的（幂等标记在每次调用前复位，动态 import
 * 不带任何必要性），所以「谁能跑 apply」不再散在九个用例里各写一遍。
 *
 * @param names - 交给 ctx 的 inject 清单（默认交齐本包声明的三枚）
 * @returns 替身记下的注册、渲染器、字典与 configForms 取用记录
 */
function applyWith(names: readonly string[] = ["slots", "configForms", "locale"]): {
  ctx: unknown;
  registered: { name: string; key?: string; locale?: string }[];
  renderers: Map<string, (props: unknown) => unknown>;
  dictionaries: { ns: string; locale: string }[];
  asked: string[];
  disposed: string[];
  effectDisposers: (() => void)[];
} {
  const result = harness(names);
  resetApplyFlag();
  apply(result.ctx as never);
  return result;
}

describe("apply", () => {
  it("注入清单交齐 slots、configForms 与 locale：少一枚，卡片与结果行都注册不上", async () => {
    const { registered } = applyWith();
    // 清单与本包实际读用的服务必须逐字相等 —— 这条断言替我们把宿主那条硬规则钉住。
    expect([...inject].toSorted()).toStrictEqual(["configForms", "locale", "slots"]);
    expect(
      registered.filter((entry) => entry.name === TOOLVIEW_SLOT).map((entry) => entry.key),
    ).toStrictEqual(ROW_TOOLS);
  });

  it("少注入 configForms：apply 当场抛出，卡片一位都没登记", () => {
    const { ctx, registered } = harness(["slots", "locale"]);
    resetApplyFlag();
    expect(() => {
      apply(ctx as never);
    }).toThrow('cannot get property "configForms" without inject');
    expect(registered.filter((entry) => entry.name === BUNDLE_CONFIG_SLOT)).toStrictEqual([]);
  });

  it("少注入 locale 时连结果行一起丢，不只是卡", () => {
    const { ctx, registered } = harness(["slots", "configForms"]);
    resetApplyFlag();
    expect(() => {
      apply(ctx as never);
    }).toThrow('cannot get property "locale" without inject');
    expect(registered.filter((entry) => entry.name === TOOLVIEW_SLOT)).toStrictEqual([]);
  });

  it("结果行清单与 host.ts 的登记表逐项相等（多一个幽灵少一个真工具都算红）", () => {
    // 只断言 `toContain("scrapling_answer")` 是不够的：那条曾经放过了「清单里留着已经删掉的
    // scrapling_stealth_fetch、同时缺三个真会话工具」这一整片漂移。两张表的对应关系是集合相等，
    // 判据就得写成集合相等。
    expect([...ROW_TOOLS].toSorted()).toStrictEqual(TOOL_SPECS.map((spec) => spec.name).toSorted());
  });

  it("设置卡挂在 plugins.bundle.config 上，键是包名，并带上 locale 席位", async () => {
    const { registered } = applyWith();
    const card = registered.filter((entry) => entry.name === BUNDLE_CONFIG_SLOT);
    expect(card).toStrictEqual([
      { name: BUNDLE_CONFIG_SLOT, key: BUNDLE_PACKAGE_NAME, locale: LOCALE_NS },
    ]);
  });

  it("取值走本包的设置命名空间 —— bundle 页的 owner props 里没有 form", async () => {
    const { asked } = applyWith();
    expect(asked).toStrictEqual([SETTINGS_ENTRY_ID]);
  });

  it("字典整份插件只注册一次，中英各一份", async () => {
    const { dictionaries } = applyWith();
    expect(dictionaries).toStrictEqual([
      { ns: LOCALE_NS, locale: "zh" },
      { ns: LOCALE_NS, locale: "en" },
    ]);
  });

  it("宿主给的 props 里没有 form，卡片也必须拿到一个 —— 这正是这张卡曾经空白的原因", async () => {
    const { renderers } = applyWith();
    const render = renderers.get(rendererKey(BUNDLE_CONFIG_SLOT, BUNDLE_PACKAGE_NAME));
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
    const { renderers } = applyWith();
    const render = renderers.get(rendererKey(BUNDLE_CONFIG_SLOT, BUNDLE_PACKAGE_NAME));
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
    const { renderers } = applyWith();
    // 按被断言的那个工具取渲染器：拿「最后一个登记进来的」去配 scrapling_fetch 的 props，
    // 实现改成按 key 捕获工具名时这条用例仍然全绿。
    const render = renderers.get(rendererKey(TOOLVIEW_SLOT, "scrapling_fetch"));
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

  it("effect 交回的清理函数撤掉字典与结果行的登记（宿主卸载插件那一步）", () => {
    const { disposed, effectDisposers } = applyWith();
    // 四条：claimApply 复位 HMR 标记的那一条，加上本包的样式、字典+结果行、设置卡三条。
    // 少任何一条，卸载时就有一批登记或标记撤不掉。
    expect(effectDisposers).toHaveLength(4);
    for (const dispose of effectDisposers) {
      dispose();
    }
    expect(disposed.filter((entry) => entry.startsWith("locale:")).toSorted()).toStrictEqual([
      `locale:${LOCALE_NS}/en`,
      `locale:${LOCALE_NS}/zh`,
    ]);
    // 结果行的注销走的是 slots.register 交回的那一位：19 个工具一位都不能少，
    // 少一位就是宿主重载后残留一个渲染器。
    expect(disposed.filter((entry) => entry.startsWith("slot:scrapling_"))).toHaveLength(
      ROW_TOOLS.length,
    );
  });

  it("重复 apply 不会二次注册（HMR 幂等）", () => {
    const { ctx, registered } = applyWith();
    const first = registered.length;
    // 先钉「第一次确实登记满了」：一次都没注册时（标记没复位、claimApply 认为已应用过），
    // 下面那句「长度没变」照样成立 —— 那是最严重的坏形状，不能被当成幂等。
    expect(first).toBe(ROW_TOOLS.length + 1);
    apply(ctx as never);
    expect(registered).toHaveLength(first);
  });
});
