// dsh-scrapling/test/settings-card-ui.test.ts —— 设置卡的渲染与保存回路。
//
// 本包没有 jsdom / @testing-library，也不为此新装依赖：用一个按 hook 次序分配槽位的
// 最小运行时（同 ctx-observe / dir-prep 的测试架）直调 SettingsCard，把函数组件就地
// 展开成宿主元素，再按 `data-field` / role 取控件、直调它们的事件回调。这样测到的是
// 卡片的真实渲染路径（含 @jayyuen66/dsh-plugin-shared/lib/card-ui 的字段组件），
// 但不依赖浏览器。
/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { localeDictionaries, SETTINGS_GROUPS } from "../src/settings-fields.ts";
import { SettingsCard } from "../src/settings-card.ts";
import type { CardProps, FormSource, FormState, PathOp } from "../src/settings-card.ts";

interface HookBox {
  values: unknown[];
  setters: (((next: unknown) => void) | undefined)[];
  deps: (readonly unknown[] | undefined)[];
  cleanups: ((() => void) | undefined)[];
  refs: ({ current: unknown } | undefined)[];
  cursor: number;
  rerender: (() => void) | undefined;
  tree: unknown;
}

const stubHooks = vi.hoisted(() => ({
  useId: (): string => ":r0:",
  useCallback: <Fn>(fn: Fn): Fn => fn,
  useMemo: <Value>(factory: () => Value): Value => factory(),
  useLayoutEffect: (): void => {
    /* 渲染期不碰 DOM：本测试只看元素树 */
  },
  useSyncExternalStore: <Value>(_subscribe: unknown, getSnapshot: () => Value): Value =>
    getSnapshot(),
}));

const runtime = vi.hoisted(() => {
  const box: HookBox = {
    values: [],
    setters: [],
    deps: [],
    cleanups: [],
    refs: [],
    cursor: 0,
    rerender: undefined,
    tree: undefined,
  };
  return { box };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { box } = runtime;
  const useState = <State>(
    initial: State | (() => State),
  ): [State, (next: State | ((prev: State) => State)) => void] => {
    const index = box.cursor;
    box.cursor += 1;
    if (!(index in box.values)) {
      box.values[index] = typeof initial === "function" ? (initial as () => State)() : initial;
      box.setters[index] = (next: unknown): void => {
        const previous = box.values[index] as State;
        box.values[index] =
          typeof next === "function" ? (next as (prev: State) => State)(previous) : next;
        box.rerender?.();
      };
    }
    return [
      box.values[index] as State,
      box.setters[index] as (next: State | ((prev: State) => State)) => void,
    ];
  };
  const useEffect = (effect: () => (() => void) | undefined, deps?: readonly unknown[]): void => {
    const index = box.cursor;
    box.cursor += 1;
    const prev = box.deps[index];
    const stable =
      prev !== undefined &&
      deps !== undefined &&
      prev.length === deps.length &&
      prev.every((item, at) => Object.is(item, deps[at]));
    if (stable) {
      return;
    }
    box.deps[index] = deps === undefined ? undefined : [...deps];
    box.cleanups[index]?.();
    box.cleanups[index] = effect();
  };
  const useRef = <Value>(initial: Value): { current: Value } => {
    const index = box.cursor;
    box.cursor += 1;
    if (!(index in box.refs)) {
      box.refs[index] = { current: initial };
    }
    return box.refs[index] as { current: Value };
  };
  const patched = { ...actual, useState, useEffect, useRef, ...stubHooks };
  return { ...patched, default: patched };
});

const { zh } = localeDictionaries();

function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  });
}

const t = (key: string, params?: Record<string, unknown>): string =>
  fillTemplate(zh[key] ?? key, params ?? {});

interface NodeProps {
  children?: unknown;
  className?: unknown;
  role?: unknown;
  type?: unknown;
  value?: unknown;
  disabled?: unknown;
  inputMode?: unknown;
  "aria-checked"?: unknown;
  "data-field"?: unknown;
  onChange?: unknown;
  onClick?: unknown;
}

interface HostNode {
  type: string;
  props: NodeProps;
}

function isNodeProps(value: unknown): value is NodeProps {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 展开函数组件（就地调用），宿主元素保留类型与已展开的 children。 */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => expand(child));
  }
  if (!isRecord(node)) {
    return node;
  }
  const type = Reflect.get(node, "type");
  const props = Reflect.get(node, "props");
  if (typeof type === "function") {
    return expand(Reflect.apply(type, undefined, [isNodeProps(props) ? props : {}]));
  }
  if (typeof type !== "string" || !isNodeProps(props)) {
    return node;
  }
  return { type, props: { ...props, children: expand(props.children) } };
}

function hostNodes(node: unknown, out: HostNode[] = []): HostNode[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      hostNodes(child, out);
    }
    return out;
  }
  if (!isRecord(node)) {
    return out;
  }
  const type = Reflect.get(node, "type");
  const props = Reflect.get(node, "props");
  if (typeof type !== "string" || !isNodeProps(props)) {
    return out;
  }
  const host: HostNode = { type, props };
  out.push(host);
  hostNodes(host.props.children, out);
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child)).join("");
  }
  if (!isRecord(node)) {
    return "";
  }
  const props = Reflect.get(node, "props");
  return isNodeProps(props) ? textOf(props.children) : "";
}

function byField(tree: unknown, field: string): HostNode[] {
  return hostNodes(tree).filter((node) => node.props["data-field"] === field);
}

function controlOf(tree: unknown, field: string): HostNode {
  const [node] = byField(tree, field);
  if (node === undefined) {
    throw new Error(`找不到字段 ${field} 的控件`);
  }
  return node;
}

function saveButton(tree: unknown): HostNode {
  const [node] = byField(tree, "save");
  if (node === undefined) {
    throw new Error("找不到保存按钮");
  }
  return node;
}

function classNameOf(node: HostNode): string {
  return typeof node.props.className === "string" ? node.props.className : "";
}

function statusText(tree: unknown): string {
  const node = hostNodes(tree).find((host) => classNameOf(host).startsWith("dsu-status"));
  return node === undefined ? "" : textOf(node.props.children);
}

interface MutateCall {
  ops: readonly PathOp[];
  revision: number | undefined;
}

function noop(): void {
  /* 订阅替身：本卡只读静态快照 */
}

interface FormFixture {
  form: FormSource;
  calls: MutateCall[];
}

function formOf(
  value: Record<string, unknown>,
  opts: {
    writable?: boolean;
    status?: FormState["status"];
    revision?: number;
    accept?: boolean;
  } = {},
): FormFixture {
  const calls: MutateCall[] = [];
  const state: FormState = {
    status: opts.status ?? "ready",
    value,
    revision: opts.revision ?? 7,
    writable: opts.writable ?? true,
  };
  return {
    calls,
    form: {
      getSnapshot: () => state,
      subscribe: () => noop,
      mutate: async (ops, revision) => {
        calls.push({ ops, revision });
        return opts.accept ?? true;
      },
    },
  };
}

function drawCard(props: CardProps): unknown {
  runtime.box.cursor = 0;
  const settingsCard = SettingsCard;
  return expand(settingsCard(props));
}

function mountCard(props: CardProps): { tree: () => unknown } {
  const rerender = (): void => {
    runtime.box.tree = drawCard(props);
  };
  runtime.box.rerender = rerender;
  runtime.box.tree = drawCard(props);
  return { tree: () => runtime.box.tree };
}

async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, 0);
  await promise;
}

const PAGE = { view: "page" } as const;

describe("scrapling 设置卡：渲染结构", () => {
  beforeEach(() => {
    Object.assign(runtime.box, {
      values: [],
      setters: [],
      deps: [],
      cleanups: [],
      refs: [],
      cursor: 0,
      rerender: undefined,
      tree: undefined,
    });
  });

  it("page 视图按字段表渲染 7 组、50 个控件，组标题与说明取自字典", () => {
    const { form } = formOf({});
    const card = mountCard({ ...PAGE, t, form });
    const tree = card.tree();
    expect(textOf(tree)).toContain(t("group.runtime.title"));
    expect(textOf(tree)).toContain(t("group.network.note"));
    let fields = 0;
    for (const group of SETTINGS_GROUPS) {
      for (const field of group.fields) {
        fields += 1;
        expect(controlOf(tree, field.key), `字段 ${field.key} 没有控件`).toBeDefined();
      }
    }
    expect(fields).toBe(50);
    expect(SETTINGS_GROUPS).toHaveLength(7);
  });

  it("控件按字段种类选型：开关 / 下拉 / 数字文本框 / 密码框", () => {
    const { form } = formOf({});
    const tree = mountCard({ ...PAGE, t, form }).tree();
    expect(controlOf(tree, "failFastOnMissingPython").props.role).toBe("switch");
    expect(controlOf(tree, "extractionType").props.role).toBe("combobox");
    const numeric = controlOf(tree, "crawlMaxItems");
    expect(numeric.type).toBe("input");
    expect(numeric.props.inputMode).toBe("numeric");
    expect(numeric.props.type).toBe("text");
    const secret = controlOf(tree, "proxyUrl");
    expect(secret.type).toBe("input");
    expect(secret.props.type).toBe("password");
  });

  it("宿主值回显；未设置的布尔用字段表默认值", () => {
    const { form } = formOf({
      crawlMaxItems: 42,
      failFastOnMissingPython: false,
      extractionType: "html",
    });
    const tree = mountCard({ ...PAGE, t, form }).tree();
    expect(controlOf(tree, "crawlMaxItems").props.value).toBe("42");
    expect(controlOf(tree, "failFastOnMissingPython").props["aria-checked"]).toBe(false);
    const enumTrigger = controlOf(tree, "extractionType");
    expect(textOf(enumTrigger.props.children)).toContain("html");
    const optionText = hostNodes(tree)
      .filter((node) => node.props.role === "option")
      .map((node) => textOf(node.props.children));
    expect(optionText).toStrictEqual(
      expect.arrayContaining([
        expect.stringContaining("markdown"),
        expect.stringContaining("html"),
        expect.stringContaining("text"),
      ]),
    );
  });

  it("summary 视图不渲染表单控件", () => {
    const { form } = formOf({});
    const tree = mountCard({ view: "summary", t, form }).tree();
    expect(hostNodes(tree).filter((node) => node.props["data-field"] !== undefined)).toStrictEqual(
      [],
    );
  });

  it("凭据字段默认遮罩，点「显示」后切成明文", () => {
    const { form } = formOf({ proxyUrl: "http://127.0.0.1:7890" });
    const card = mountCard({ ...PAGE, t, form });
    const reveal = hostNodes(card.tree()).find((node) => classNameOf(node).includes("dss-reveal"));
    if (reveal === undefined) {
      throw new Error("找不到凭据字段的显示按钮");
    }
    expect(controlOf(card.tree(), "proxyUrl").props.type).toBe("password");
    (reveal.props.onClick as () => void)();
    expect(controlOf(card.tree(), "proxyUrl").props.type).toBe("text");
  });

  it("只读：控件与保存按钮一起禁用，状态说明可见", () => {
    const { form } = formOf({}, { writable: false });
    const tree = mountCard({ ...PAGE, t, form }).tree();
    expect(controlOf(tree, "pythonBin").props.disabled).toBe(true);
    expect(controlOf(tree, "failFastOnMissingPython").props.disabled).toBe(true);
    expect(saveButton(tree).props.disabled).toBe(true);
    expect(textOf(tree)).toContain(t("statusReadonly"));
  });

  it("没有运行环境读面时给出可照抄的 CLI 命令", () => {
    const { form } = formOf({});
    const tree = mountCard({ ...PAGE, t, form }).tree();
    expect(textOf(tree)).toContain(t("runtimeUnavailable"));
    expect(textOf(tree)).toContain("dsh-scrapling setup --feature <pack> --apply");
  });
});

describe("scrapling 设置卡：保存回路", () => {
  beforeEach(() => {
    Object.assign(runtime.box, {
      values: [],
      setters: [],
      deps: [],
      cleanups: [],
      refs: [],
      cursor: 0,
      rerender: undefined,
      tree: undefined,
    });
  });

  it("有效改动 → mutate 带 ops 与第一笔改动时的 revision → 受理后回到干净态", async () => {
    const fixture = formOf({ pythonBin: "", crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    (
      controlOf(card.tree(), "crawlMaxItems").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({
      target: { value: "250" },
    });
    expect(statusText(card.tree())).toContain(t("statusChanged", { count: 1 }));
    (saveButton(card.tree()).props.onClick as () => void)();
    await flush();
    expect(fixture.calls).toStrictEqual([
      { ops: [{ op: "set", path: ["crawlMaxItems"], value: 250 }], revision: 7 },
    ]);
    expect(statusText(card.tree())).toBe(t("statusClean"));
  });

  it("非法数字不写、保存禁用，状态位点名非法项", () => {
    const fixture = formOf({ crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    (
      controlOf(card.tree(), "crawlMaxItems").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({
      target: { value: "1." },
    });
    expect(saveButton(card.tree()).props.disabled).toBe(true);
    expect(statusText(card.tree())).toContain(t("statusInvalid", { count: 1 }));
    (saveButton(card.tree()).props.onClick as () => void)();
    expect(fixture.calls).toStrictEqual([]);
    expect(controlOf(card.tree(), "crawlMaxItems").props.value).toBe("1.");
  });

  it("改回默认值走 unset，而不是写入同值", async () => {
    const fixture = formOf({ crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    (
      controlOf(card.tree(), "crawlMaxItems").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({
      target: { value: "" },
    });
    (saveButton(card.tree()).props.onClick as () => void)();
    await flush();
    expect(fixture.calls[0]?.ops).toStrictEqual([{ op: "unset", path: ["crawlMaxItems"] }]);
  });

  it("宿主不受理 → 失败文案可见且草稿保留（保存仍可重试）", async () => {
    const fixture = formOf({ crawlMaxItems: 1000 }, { accept: false });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    (
      controlOf(card.tree(), "crawlMaxItems").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({
      target: { value: "250" },
    });
    (saveButton(card.tree()).props.onClick as () => void)();
    await flush();
    expect(textOf(card.tree())).toContain(t("rejected"));
    expect(saveButton(card.tree()).props.disabled).toBe(false);
    expect(controlOf(card.tree(), "crawlMaxItems").props.value).toBe("250");
  });

  it("撤销清空草稿，保存重新禁用", () => {
    const fixture = formOf({ crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    (
      controlOf(card.tree(), "crawlMaxItems").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({
      target: { value: "250" },
    });
    const [discard] = byField(card.tree(), "discard");
    if (discard === undefined) {
      throw new Error("找不到撤销按钮");
    }
    (discard.props.onClick as () => void)();
    expect(controlOf(card.tree(), "crawlMaxItems").props.value).toBe("1000");
    expect(saveButton(card.tree()).props.disabled).toBe(true);
  });
});
