// dsh-scrapling/test/settings-card.test.ts —— 设置卡：字段表与 host.ts 的 schema 对账，
// 卡片那三个纯函数、locale 字典，以及样式挂载。
//
// **最要紧的是第一条用例**：字段表（src/settings-fields.ts）与 host.ts 的 Config schema 是
// 两份独立的声明，改了一边忘了另一边，用户看到的就会是「卡上有个输入框，填了没反应」或者
// 「找不到某个开关」。这条对账用例把那种漂移挡在门禁上，而不是留给用户发现。
//
// 字典那组用例同样重要：字段文案存在字段表里，真正显示出来的却是 locale 字典，两者一旦
// 对不上，英文界面就会露出一半未翻译的标签。

import { afterEach, describe, expect, it, vi } from "vitest";
import { Config as configSchema } from "../host.ts";
import { FALLBACK_BUDGET_BYTES } from "../lib/output.ts";
import { PACK_STATES, RUNTIME_PACKS, packLabelKey, packStateKey } from "../lib/runtime-shape.ts";
import {
  BUNDLE_PACKAGE_NAME,
  LOCALE_NS,
  SETTINGS_ENTRY_ID,
  SETTINGS_FIELDS,
  SETTINGS_FIELD_KEYS,
  SETTINGS_GROUPS,
  localeDictionaries,
} from "../src/settings-fields.ts";
import type { FieldSpec } from "../src/settings-fields.ts";
import {
  browserDocument,
  buildOps,
  controlType,
  displayValue,
  draftAfterWrite,
  installStyle,
  installStyles,
  parseInput,
} from "../src/settings-card.ts";
import type { DocumentFace, StyleTag } from "../src/settings-card.ts";

/** 「没找到」的一个返回：既非 null 也非 undefined 的第三种写法，正用它检验按真值判的分支。 */
const noMatch = (): undefined => undefined;

/** URL 字段的样例值：同一个字面量在断言里出现多次会被 sonarjs 的重复串规则盯上。 */
const PROXY_HTTP_URL = "http://127.0.0.1:7890";
const PROXY_SOCKS_URL = "socks5://user:pass@127.0.0.1:7890";
const SEARXNG_URL = "https://searx.example.com";
/** 非法协议样例：拼出来而不是写成字面量，`no-script-url` 会拦下 `javascript:` 字面量。 */
const SCRIPT_SCHEME_URL = ["javascript", ":alert(1)"].join("");

/** schema 的单条属性：只取本用例要用的两个面。 */
interface PropertySchema {
  readonly meta?: { readonly volatile?: boolean; readonly default?: unknown };
}

/** 全部配置项的键 → 声明。 */
const PROPERTIES: Record<string, PropertySchema> = (
  configSchema as unknown as { readonly dict: Record<string, PropertySchema> }
).dict;

/** 标了 `.volatile()` 的键，也就是设置卡该有的字段。 */
const VOLATILE_KEYS: readonly string[] = Object.entries(PROPERTIES)
  .filter(([, property]) => property.meta?.volatile === true)
  .map(([key]) => key);

/** 键在某语言字典里缺位或文案为空串时，收成 `语言/键` 便于点名；全齐时为空数组。 */
function missingLabels(
  dicts: ReturnType<typeof localeDictionaries>,
  keys: readonly string[],
): string[] {
  const out: string[] = [];
  for (const [lang, table] of Object.entries(dicts)) {
    for (const key of keys) {
      const text = table[key];
      if (text === undefined || text === "") {
        out.push(`${lang}/${key}`);
      }
    }
  }
  return out;
}

/** 按键取字段。 */
function fieldOf(key: string): FieldSpec {
  const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key);
  if (field === undefined) {
    throw new Error(`字段表里没有 ${key}`);
  }
  return field;
}

/** 一段假的 document，只带本卡用到的那点 API。 */
function fakeDocument(present: boolean): DocumentFace & {
  readonly appended: { id: string }[];
  readonly removed: unknown[];
} {
  const appended: { id: string }[] = [];
  const removed: unknown[] = [];
  return {
    appended,
    removed,
    querySelector: (selector: string): unknown => {
      // 「已经在文档里」有两种来源：测试预先摆一枚（present），或本卡自己刚注入过 ——
      // 后一种才是 installStyle 幂等分支真正要判的那一档（产品侧靠真 DOM 的 querySelector）。
      const id = selector.replace(/^#/u, "");
      return appended.find((tag) => tag.id === id) ?? (present ? { id: "already" } : null);
    },
    createElement: () => {
      const tag: StyleTag = {
        id: "",
        textContent: "",
        remove: () => {
          removed.push(tag);
        },
      };
      return tag;
    },
    head: {
      append: (node: unknown) => {
        appended.push(node as { id: string });
      },
    },
  };
}

describe("字段表与 schema 同解", () => {
  it("对账拿到的 schema 不是空表，字段表里每个键都在 schema 上有名", () => {
    // 先判数据源在位：`configSchema.dict` 换名或换形状时，上面那次强转不是报错就是给一个
    // 空对象，而集合比对那时只会说一句笼统的「不一致」。
    expect(Object.keys(PROPERTIES).length).toBeGreaterThan(0);
    expect(VOLATILE_KEYS.length).toBeGreaterThan(0);
    expect(SETTINGS_FIELD_KEYS.filter((key) => !(key in PROPERTIES))).toStrictEqual([]);
  });

  it("键集合与 host.ts 里 volatile 的字段完全一致", () => {
    expect(SETTINGS_FIELD_KEYS.toSorted()).toStrictEqual(VOLATILE_KEYS.toSorted());
  });

  it("locate / links 两枚离线解析开关在字段表里，默认开", () => {
    for (const key of ["locateEnabled", "linksEnabled"]) {
      expect(SETTINGS_FIELD_KEYS).toContain(key);
      expect(fieldOf(key).fallback).toBe(true);
    }
  });

  it("每个字段的默认值都等于 schema 里的默认值", () => {
    // 红话把两侧都写出来：只给字段表那一侧时，「schema 没有 default 这一位」与「两边值
    // 不一样」看着是同一句话。
    const wrong = SETTINGS_FIELDS.filter(
      (field) => PROPERTIES[field.key]?.meta?.default !== field.fallback,
    ).map(
      (field) =>
        `${field.key}: 卡片 ${String(field.fallback)} / schema ${String(PROPERTIES[field.key]?.meta?.default)}`,
    );
    expect(wrong).toStrictEqual([]);
  });

  it("capText 的兜底预算与三枚输出上限的默认值同一档", () => {
    // lib/output.ts 的兜底是第三份声明：schema 默认值、卡片 fallback 之外，预算非法时用的
    // 就是它。注释说「同一档」，这里就把这句话变成可复跑的判据。
    for (const key of ["fetchMaxOutputChars", "extractMaxOutputChars", "renderMaxOutputChars"]) {
      expect(PROPERTIES[key]?.meta?.default).toBe(FALLBACK_BUDGET_BYTES);
    }
  });

  it("枚举字段的取值非空，且默认值就在其中", () => {
    for (const field of SETTINGS_FIELDS.filter((candidate) => candidate.kind === "enum")) {
      expect(field.options?.length ?? 0).toBeGreaterThan(0);
      expect(field.options).toContain(field.fallback);
    }
  });

  it("键不重复，分组 id 也不重复", () => {
    expect(new Set(SETTINGS_FIELD_KEYS).size).toBe(SETTINGS_FIELD_KEYS.length);
    const ids = SETTINGS_GROUPS.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个字段都带齐中英两套标签与说明", () => {
    for (const field of SETTINGS_FIELDS) {
      const texts = [field.label.zh, field.label.en, field.hint.zh, field.hint.en];
      expect(texts.filter((text) => text.length === 0)).toStrictEqual([]);
    }
  });

  it("命名空间与 bundle 键就是包名，不另起炉灶", () => {
    expect(SETTINGS_ENTRY_ID).toBe("scrapling");
    expect(BUNDLE_PACKAGE_NAME).toBe("@jayyuen66/dsh-scrapling");
  });
});

describe("locale 字典", () => {
  const dicts = localeDictionaries();

  it("中英两份键集完全一致，缺一条就有一半标签露成键名", () => {
    expect(Object.keys(dicts.zh).toSorted()).toStrictEqual(Object.keys(dicts.en).toSorted());
  });

  it("每个能力包的名称与每种包状态都配了中英文案", () => {
    // 判据是「键在位且非空」：只写 `.not.toBe("")` 时缺键拿到 undefined 照样通过，门禁对着
    // 真正缺文案的那一档恒绿（变异实测：给 PACK_STATES 加一个没配译名的状态，旧写法不红）。
    //
    // 状态清单取自 lib/runtime-shape.ts 的运行时值域：加一个状态而没配译名，这条会点名是哪一个，
    // 而不是等卡片把 `runtime.state.<新值>` 原样露在界面上。
    const labels = [
      ...RUNTIME_PACKS.map((pack) => packLabelKey(pack)),
      ...PACK_STATES.map((state) => packStateKey(state)),
    ];
    // 先证明这条有的判：值域一旦被清空，下面的 missingLabels 就只是在判一张空表。
    expect(labels.length).toBeGreaterThan(0);
    expect(missingLabels(dicts, labels)).toStrictEqual([]);
  });

  it("每个字段与每个分组都有 label / hint / title / note 四个键", () => {
    for (const group of SETTINGS_GROUPS) {
      for (const key of [`group.${group.id}.title`, `group.${group.id}.note`]) {
        expect(dicts.zh[key] !== undefined && dicts.zh[key] !== "").toBe(true);
        expect(dicts.en[key] !== undefined && dicts.en[key] !== "").toBe(true);
      }
      for (const field of group.fields) {
        expect(dicts.zh[`field.${field.key}.label`]).toBe(field.label.zh);
        expect(dicts.en[`field.${field.key}.label`]).toBe(field.label.en);
        expect(dicts.zh[`field.${field.key}.hint`]).toBe(field.hint.zh);
        expect(dicts.en[`field.${field.key}.hint`]).toBe(field.hint.en);
      }
    }
  });

  it("字典里没有任何空串，空串会让界面上少一块字而不是报错", () => {
    for (const [lang, dict] of Object.entries(dicts)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(`${lang}:${key}:${value.length > 0}`).toBe(`${lang}:${key}:true`);
      }
    }
  });

  it("命名空间名稳定，卡片与结果行共用同一份字典", () => {
    expect(LOCALE_NS).toBe("dshScrapling");
  });
});

describe("displayValue", () => {
  const text = fieldOf("proxyUrl");

  it("草稿优先于宿主值", () => {
    expect(displayValue(text, { proxyUrl: "http://a" }, { proxyUrl: "http://b" })).toBe("http://b");
  });

  it("没有草稿时取宿主值", () => {
    expect(displayValue(text, { proxyUrl: "http://a" }, {})).toBe("http://a");
  });

  it("宿主没给该项时退回字段表默认值", () => {
    expect(displayValue(text, undefined, {})).toBe("");
    expect(displayValue(fieldOf("headless"), {}, {})).toBe("true");
  });

  it("结构值给空串而不是 [object Object]", () => {
    expect(displayValue(text, { proxyUrl: { nested: true } }, {})).toBe("");
    expect(displayValue(text, undefined, { proxyUrl: [] })).toBe("");
  });

  it("数字与布尔照常显示", () => {
    expect(displayValue(fieldOf("crawlMaxItems"), { crawlMaxItems: 42 }, {})).toBe("42");
    expect(displayValue(fieldOf("headless"), { headless: false }, {})).toBe("false");
  });

  it("非法原文压过草稿与宿主值：用户敲的那半截数要原样留在控件里", () => {
    // 若回退去显示宿主值，控件会在下一次渲染时把用户刚输的东西换掉，而保存按钮同时
    // 是禁用的 —— 界面上看不出哪里不对，只看到自己打的字被吃了。
    const field = fieldOf("crawlMaxItems");
    expect(
      displayValue(field, { crawlMaxItems: 42 }, { crawlMaxItems: 7 }, { crawlMaxItems: "1." }),
    ).toBe("1.");
    expect(displayValue(field, { crawlMaxItems: 42 }, {}, { crawlMaxItems: "-" })).toBe("-");
  });
});

describe("controlType", () => {
  const secret = fieldOf("proxyUrl");
  const plain = fieldOf("dataDir");

  it("凭据型字段默认遮罩：代理地址里的 user:pass 不上屏幕", () => {
    // 明文摆在一个输入框里，截图、屏幕共享、录屏、扩展都能原样读走。遮罩只改显示，
    // 值本身仍是原串，编辑与保存语义不变。
    expect(controlType(secret, false)).toBe("password");
    expect(controlType(plain, false)).toBe("text");
  });

  it("点过「显示」之后换回 text，再点一次又遮上", () => {
    expect(controlType(secret, true)).toBe("text");
    expect(controlType(secret, false)).toBe("password");
  });

  it("不是凭据字段的，显示开关不影响它", () => {
    expect(controlType(plain, true)).toBe("text");
    expect(controlType(plain, false)).toBe("text");
  });

  it("说明里承诺遮罩的字段，控件必须真遮罩", () => {
    // 反方向不要求：三枚 API key 的说明只讲「必填 / 留空」，不必重复一句「会遮罩」。
    // 但说明写了遮罩而字段没标 secret 时，用户在卡上看见的仍是明文，而这一位没有任何
    // 别的判据会红 —— 卡片文案与控件形态之间唯一的连线就是这条。
    const promised = SETTINGS_FIELDS.filter(
      (field) => field.hint.zh.includes("遮罩") || field.hint.en.includes("Masked"),
    );
    expect(promised.length).toBeGreaterThanOrEqual(2);
    for (const field of promised) {
      expect(field.secret, `${field.key} 的说明写了遮罩却没标 secret`).toBe(true);
      expect(controlType(field, false), `${field.key} 没走密码控件`).toBe("password");
    }
  });
});

describe("parseInput", () => {
  it("布尔按 true/false 两串，域外原文判非法而不是猜成 false", () => {
    expect(parseInput(fieldOf("headless"), "true")).toStrictEqual({ kind: "value", value: true });
    expect(parseInput(fieldOf("headless"), "false")).toStrictEqual({ kind: "value", value: false });
    expect(parseInput(fieldOf("headless"), "yes")).toStrictEqual({ kind: "invalid" });
  });

  it("枚举只收下拉候选里的值，域外原文判非法", () => {
    expect(parseInput(fieldOf("extractionType"), "markdown")).toStrictEqual({
      kind: "value",
      value: "markdown",
    });
    expect(parseInput(fieldOf("extractionType"), "yaml")).toStrictEqual({ kind: "invalid" });
  });

  it("URL 字段走 z.url：http/socks5 都收，缺 scheme 的原文判非法", () => {
    expect(parseInput(fieldOf("proxyUrl"), PROXY_HTTP_URL)).toStrictEqual({
      kind: "value",
      value: PROXY_HTTP_URL,
    });
    expect(parseInput(fieldOf("proxyUrl"), PROXY_SOCKS_URL)).toStrictEqual({
      kind: "value",
      value: PROXY_SOCKS_URL,
    });
    expect(parseInput(fieldOf("proxyUrl"), "127.0.0.1:7890")).toStrictEqual({ kind: "invalid" });
    expect(parseInput(fieldOf("searxngEndpoint"), SEARXNG_URL)).toStrictEqual({
      kind: "value",
      value: SEARXNG_URL,
    });
    expect(parseInput(fieldOf("searxngEndpoint"), "searx.example.com")).toStrictEqual({
      kind: "invalid",
    });
  });

  it("URL 协议按字段白名单收口：file:/data:/javascript: 不收，socks5h 收", () => {
    expect(parseInput(fieldOf("proxyUrl"), "file:///etc/passwd")).toStrictEqual({
      kind: "invalid",
    });
    expect(parseInput(fieldOf("proxyUrl"), SCRIPT_SCHEME_URL)).toStrictEqual({
      kind: "invalid",
    });
    expect(parseInput(fieldOf("proxyUrl"), "socks5h://127.0.0.1:7890")).toStrictEqual({
      kind: "value",
      value: "socks5h://127.0.0.1:7890",
    });
    // SearXNG 端点只发 http(s) 请求：socks 代理的串在这里同样是非法值。
    expect(parseInput(fieldOf("searxngEndpoint"), "socks5://127.0.0.1:7890")).toStrictEqual({
      kind: "invalid",
    });
    expect(parseInput(fieldOf("searxngEndpoint"), "http://searx.local")).toStrictEqual({
      kind: "value",
      value: "http://searx.local",
    });
  });

  it("清空即清除这一项", () => {
    expect(parseInput(fieldOf("proxyUrl"), "   ")).toStrictEqual({ kind: "clear" });
  });

  it("保存成功后的草稿：只摘掉发出去的字段，剩余草稿清掉已失效的围栏", () => {
    const leftover = draftAfterWrite(
      {
        values: { proxyUrl: PROXY_HTTP_URL, headless: false },
        baseRevision: 7,
        invalid: [],
        invalidText: {},
      },
      [{ op: "set", path: ["proxyUrl"], value: PROXY_HTTP_URL }],
    );
    // 还剩 headless：它没进这一笔，仍要保留；围栏已过期，下一笔按宿主当时那版重新取。
    expect(leftover.values).toStrictEqual({ headless: false });
    expect(leftover.baseRevision).toBeUndefined();
    // 全部发出去 ⇒ 回到干净起点（非法原文与围栏都不该跟着留）。
    const cleared = draftAfterWrite(
      {
        values: { proxyUrl: PROXY_HTTP_URL },
        baseRevision: 9,
        invalid: ["headless"],
        invalidText: { headless: "yes" },
      },
      [{ op: "unset", path: ["proxyUrl"] }],
    );
    expect(cleared).toStrictEqual({
      values: {},
      baseRevision: undefined,
      invalid: [],
      invalidText: {},
    });
  });

  it("正整数照原样收下", () => {
    expect(parseInput(fieldOf("crawlMaxItems"), "250")).toStrictEqual({
      kind: "value",
      value: 250,
    });
  });

  it("小数按 schema 的整数口径判为非法 —— natural().min(1) 存不下 250.9", () => {
    expect(parseInput(fieldOf("crawlMaxItems"), "250.9")).toStrictEqual({ kind: "invalid" });
  });

  it("非法数字是 invalid，不是 clear —— 否则一次手滑就删掉了原有的覆盖", () => {
    for (const raw of ["0", "-5", "abc", "1e999", "0x10", "007", "1_000"]) {
      expect(parseInput(fieldOf("crawlMaxItems"), raw)).toStrictEqual({ kind: "invalid" });
    }
  });

  it("文本去掉首尾空白后原样保留", () => {
    expect(parseInput(fieldOf("proxyUrl"), `  ${PROXY_HTTP_URL}  `)).toStrictEqual({
      kind: "value",
      value: PROXY_HTTP_URL,
    });
  });
});

describe("buildOps", () => {
  it("空草稿不产生任何写入", () => {
    expect(buildOps({})).toStrictEqual([]);
  });

  it("没动过的字段不出现在操作串里", () => {
    expect(buildOps({ headless: false })).toStrictEqual([
      { op: "set", path: ["headless"], value: false },
    ]);
  });

  it("改回默认值走 unset 而不是写入同值", () => {
    expect(buildOps({ proxyUrl: "" })).toStrictEqual([{ op: "unset", path: ["proxyUrl"] }]);
    expect(buildOps({ headless: true })).toStrictEqual([{ op: "unset", path: ["headless"] }]);
  });

  it("清空的项同样走 unset", () => {
    expect(buildOps({ crawlMaxItems: null })).toStrictEqual([
      { op: "unset", path: ["crawlMaxItems"] },
    ]);
  });

  it("顺序跟字段表一致，与草稿的键顺序无关", () => {
    const forward = buildOps({ headless: false, proxyUrl: "http://a" });
    const reversed = buildOps({ proxyUrl: "http://a", headless: false });
    expect(forward).toStrictEqual(reversed);
    expect(forward.map((op) => op.path[0])).toStrictEqual(["headless", "proxyUrl"]);
  });

  it("草稿里的字段名不在字段表上时不进操作串", () => {
    expect(buildOps({ toString: 2 })).toStrictEqual([]);
  });

  it("显式写成 undefined 的键不进操作串", () => {
    expect(buildOps({ headless: undefined })).toStrictEqual([]);
  });
});

describe("样式挂载", () => {
  it("首次挂载注入一段 style，并交出摘掉它的函数", () => {
    const doc = fakeDocument(false);
    const dispose = installStyles(doc);
    expect(doc.appended).toHaveLength(1);
    expect(doc.appended[0]?.id).toBe("dsh-scrapling-settings-css");
    dispose();
    // 判「摘掉的就是刚注入的那一枚」，不判长度：假 document 里每个 tag 的 remove 都只把
    // 自己 push 进 removed，无论 dispose 关的是谁，长度都是 1。
    expect(doc.removed).toStrictEqual([doc.appended[0]]);
  });

  it("同一 id 注入两次只留一段：摘除函数也不该把第二段的活抢过来", () => {
    // 这就是 installStyle 注释里「重复调用是空操作」那一支：第二次得从文档里认回第一段，
    // 而不是再叠一份 CSS 规则。
    const doc = fakeDocument(false);
    const first = installStyles(doc);
    const second = installStyles(doc);
    expect(doc.appended).toHaveLength(1);
    second();
    expect(doc.removed).toStrictEqual([]);
    first();
    expect(doc.removed).toStrictEqual([doc.appended[0]]);
  });

  it("已经在文档里就跳过，不重复注入，摘除函数也不该动别人的东西", () => {
    const doc = fakeDocument(true);
    const dispose = installStyles(doc);
    expect(doc.appended).toHaveLength(0);
    dispose();
    expect(doc.removed).toHaveLength(0);
  });

  it("querySelector 返回 undefined 时照样装得上 —— 按真值判而不是只比 null", () => {
    const doc = fakeDocument(false);
    const undefinedDoc: DocumentFace = { ...doc, querySelector: noMatch };
    installStyle(undefinedDoc, "x", "body{}");
    expect(doc.appended).toHaveLength(1);
  });
});

describe("browserDocument", () => {
  // `Reflect.deleteProperty` 是删掉而不是还原：环境本身提供 document 时（happy-dom 那类
  // 渲染用例就在同一个 worker 里跑），它会被永久摘走。stubGlobal 记下原值、unstubAllGlobals
  // 负责放回，这才叫还原。
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("没有 document 时返回 undefined，而不是抛错", () => {
    expect(browserDocument()).toBeUndefined();
  });

  it("有 document 时交出它", () => {
    const doc = fakeDocument(false);
    vi.stubGlobal("document", doc);
    expect(browserDocument()).toBe(doc);
  });

  it("像个对象但缺方法的不算 document", () => {
    vi.stubGlobal("document", { querySelector: () => null });
    expect(browserDocument()).toBeUndefined();
    vi.stubGlobal("document", null);
    expect(browserDocument()).toBeUndefined();
  });

  it("head 不是可用对象的不算 document —— 否则 installStyles 会在 doc.head 上炸掉", () => {
    const partial = fakeDocument(false) as { head?: unknown };
    vi.stubGlobal("document", { ...partial, head: undefined });
    expect(browserDocument()).toBeUndefined();
    vi.stubGlobal("document", { ...partial, head: "not-an-object" });
    expect(browserDocument()).toBeUndefined();
    vi.stubGlobal("document", { ...partial, head: { append: "not-a-function" } });
    expect(browserDocument()).toBeUndefined();
  });
});
