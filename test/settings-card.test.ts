// dsh-scrapling/test/settings-card.test.ts —— 设置卡：字段表与 host.ts 的 schema 对账，
// 以及卡片那三个纯函数与样式挂载。
//
// **最要紧的是第一条用例**：字段表（src/settings-fields.ts）与 host.ts 的 Config schema 是
// 两份独立的声明，改了一边忘了另一边，用户看到的就会是「卡上有个输入框，填了没反应」或者
// 「找不到某个开关」。这条对账用例把那种漂移挡在门禁上，而不是留给用户发现。

import { afterEach, describe, expect, it, vi } from "vitest";
import { Config as configSchema } from "../host.ts";
import {
  BUNDLE_PACKAGE_NAME,
  SETTINGS_ENTRY_ID,
  SETTINGS_FIELDS,
  SETTINGS_FIELD_KEYS,
  SETTINGS_GROUPS,
} from "../src/settings-fields.ts";
import type { FieldSpec } from "../src/settings-fields.ts";
import {
  browserDocument,
  buildOps,
  displayValue,
  installStyles,
  parseInput,
} from "../src/settings-card.ts";
import type { DocumentFace } from "../src/settings-card.ts";

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

/** 按键取字段。 */
function fieldOf(key: string): FieldSpec {
  const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key);
  if (field === undefined) {
    throw new Error(`字段表里没有 ${key}`);
  }
  return field;
}

/** 一段假的 document，只带本卡用到的那点 API。 */
function fakeDocument(present: boolean): DocumentFace & { readonly appended: { id: string }[] } {
  const appended: { id: string }[] = [];
  return {
    appended,
    querySelector: () => (present ? { id: "already" } : null),
    createElement: () => ({ id: "", textContent: "" }),
    head: {
      append: (node: unknown) => {
        appended.push(node as { id: string });
      },
    },
  };
}

describe("字段表与 schema 同解", () => {
  it("键集合与 host.ts 里 volatile 的字段完全一致", () => {
    expect(SETTINGS_FIELD_KEYS.toSorted()).toStrictEqual(VOLATILE_KEYS.toSorted());
  });

  it("每个字段的默认值都等于 schema 里的默认值", () => {
    const wrong = SETTINGS_FIELDS.filter(
      (field) => PROPERTIES[field.key]?.meta?.default !== field.fallback,
    ).map((field) => `${field.key}=${String(field.fallback)}`);
    expect(wrong).toStrictEqual([]);
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
});

describe("parseInput", () => {
  it("布尔按 true/false 两串", () => {
    expect(parseInput(fieldOf("headless"), "true")).toBe(true);
    expect(parseInput(fieldOf("headless"), "false")).toBe(false);
  });

  it("清空即清除这一项", () => {
    expect(parseInput(fieldOf("proxyUrl"), "   ")).toBeNull();
  });

  it("数字取整并按 schema 下界夹住", () => {
    expect(parseInput(fieldOf("crawlMaxItems"), "250.9")).toBe(250);
    expect(parseInput(fieldOf("crawlMaxItems"), "0")).toBeNull();
    expect(parseInput(fieldOf("crawlMaxItems"), "-5")).toBeNull();
    expect(parseInput(fieldOf("crawlMaxItems"), "abc")).toBeNull();
  });

  it("文本去掉首尾空白后原样保留", () => {
    expect(parseInput(fieldOf("proxyUrl"), "  http://127.0.0.1:7890  ")).toBe(
      "http://127.0.0.1:7890",
    );
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
});

describe("样式挂载", () => {
  it("首次挂载注入一段 style", () => {
    const doc = fakeDocument(false);
    installStyles(doc);
    expect(doc.appended).toHaveLength(1);
    expect(doc.appended[0]?.id).toBe("dsh-scrapling-settings-css");
  });

  it("已经在文档里就跳过，不重复注入", () => {
    const doc = fakeDocument(true);
    installStyles(doc);
    expect(doc.appended).toHaveLength(0);
  });
});

describe("browserDocument", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    vi.unstubAllGlobals();
  });

  it("没有 document 时返回 undefined，而不是抛错", () => {
    expect(browserDocument()).toBeUndefined();
  });

  it("有 document 时交出它", () => {
    const doc = fakeDocument(false);
    Reflect.set(globalThis, "document", doc);
    expect(browserDocument()).toBe(doc);
  });

  it("像个对象但缺方法的不算 document", () => {
    Reflect.set(globalThis, "document", { querySelector: () => null });
    expect(browserDocument()).toBeUndefined();
    Reflect.set(globalThis, "document", null);
    expect(browserDocument()).toBeUndefined();
  });
});
