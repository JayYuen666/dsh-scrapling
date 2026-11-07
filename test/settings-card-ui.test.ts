// dsh-scrapling/test/settings-card-ui.test.ts —— 设置卡的渲染与保存回路。
//
// 本包没有 jsdom / @testing-library，也不为此新装依赖：用一个按 hook 次序分配槽位的
// 最小运行时（同 ctx-observe / dir-prep 的测试架）直调 SettingsCard，把函数组件就地
// 展开成宿主元素，再按 `data-field` / role 取控件、直调它们的事件回调。这样测到的是
// 卡片的真实渲染路径（含 @jayyuen66/dsh-plugin-shared/lib/card-ui 的字段组件），
// 但不依赖浏览器。
/// <reference types="node" />
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCallback as stubUseCallback,
  useEffect as stubUseEffect,
  useMemo as stubUseMemo,
  useState as stubUseState,
} from "react";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { localeDictionaries, SETTINGS_GROUPS } from "../src/settings-fields.ts";
import { SettingsCard } from "../src/settings-card.ts";
import type { CardProps, FormSource, FormState, PathOp } from "../src/settings-card.ts";
import type { RuntimeReader } from "../src/runtime-reader.ts";
import type { RuntimeActionResult, RuntimeStatusResult } from "../lib/runtime-shape.ts";

/** effect 槽位登记的东西：一个执行后可能交回清理函数的函数；未占用时是 undefined。 */
type PendingEffect = (() => (() => void) | undefined) | undefined;

/** 依赖数组是否逐位等值；任一侧没有依赖数组就按 React 的语义视作「每次都变」。 */
function sameDeps(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  return (
    prev !== undefined &&
    next !== undefined &&
    prev.length === next.length &&
    prev.every((item, at) => Object.is(item, next[at]))
  );
}

interface HookBox {
  values: unknown[];
  setters: (((next: unknown) => void) | undefined)[];
  /** 每个槽位上一轮的依赖数组：effect / useCallback / useMemo 共用，一个槽位只属于一种 hook。 */
  deps: (readonly unknown[] | undefined)[];
  /** useCallback 记住的那个函数身份，按槽位存放。 */
  callbacks: unknown[];
  /** useMemo 算出的那个值，按槽位存放。 */
  memos: unknown[];
  cleanups: ((() => void) | undefined)[];
  /** 本次渲染登记下、还没执行的 effect（React 在提交阶段才跑它们；按槽位稀疏存放）。 */
  pending: PendingEffect[];
  refs: ({ current: unknown } | undefined)[];
  cursor: number;
  rerender: (() => void) | undefined;
  tree: unknown;
}

const stubHooks = vi.hoisted(() => ({
  useId: (): string => ":r0:",
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
    callbacks: [],
    memos: [],
    cleanups: [],
    pending: [],
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
        const resolved =
          typeof next === "function" ? (next as (prev: State) => State)(previous) : next;
        // 同值不再渲染：卡片的一处回读会连着写两位状态，缺这条就会凭空多出整轮再渲染，
        // 而每轮再渲染都会重跑那些依赖不稳定的 effect。
        if (Object.is(previous, resolved)) {
          return;
        }
        box.values[index] = resolved;
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
    if (sameDeps(box.deps[index], deps)) {
      return;
    }
    box.deps[index] = deps === undefined ? undefined : [...deps];
    // 只登记，不在渲染期执行：effect 里一 setState 就会在一次渲染中途 rerender，
    // drawCard 把 cursor 归零，槽位随之错位且不报错，断言在错误方向上变绿。
    box.pending[index] = effect;
  };
  const useCallback = <Fn>(fn: Fn, deps?: readonly unknown[]): Fn => {
    const index = box.cursor;
    box.cursor += 1;
    if (sameDeps(box.deps[index], deps)) {
      // 依赖没变就交回上一轮那个函数身份：卡片把 useCallback 的结果写进 effect 的依赖里，
      // 每次给新闭包会让那条 effect 每轮都重跑，真实 React 里它不会。
      return box.callbacks[index] as Fn;
    }
    box.deps[index] = deps === undefined ? undefined : [...deps];
    box.callbacks[index] = fn;
    return fn;
  };
  const useMemo = <Value>(factory: () => Value, deps?: readonly unknown[]): Value => {
    const index = box.cursor;
    box.cursor += 1;
    if (sameDeps(box.deps[index], deps)) {
      return box.memos[index] as Value;
    }
    box.deps[index] = deps === undefined ? undefined : [...deps];
    const value = factory();
    box.memos[index] = value;
    return value;
  };
  const useRef = <Value>(initial: Value): { current: Value } => {
    const index = box.cursor;
    box.cursor += 1;
    if (!(index in box.refs)) {
      box.refs[index] = { current: initial };
    }
    return box.refs[index] as { current: Value };
  };
  const patched = { ...actual, useState, useEffect, useRef, useCallback, useMemo, ...stubHooks };
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
  // Fragment（Symbol 型）与 memo / forwardRef（对象型）都不是宿主元素，但它们的 children
  // 必须继续展开：原样返回会让整棵子树被 hostNodes 丢掉，于是「某视图没渲染控件」这种断言
  // 会因为「根本没看见」而变绿。共享卡片组件里给某段包一层 Fragment 是很常见的重构。
  if (typeof type === "symbol" || typeof type === "object") {
    if (!isNodeProps(props) || props.children === undefined) {
      throw new TypeError(`展开器遇到既非宿主元素、又没有 children 的节点（type=${typeof type}）`);
    }
    return expand(props.children);
  }
  if (typeof type !== "string" || !isNodeProps(props)) {
    throw new Error(
      `展开器遇到无法识别的节点类型（${typeof type}）：补进本文件的分派，别让子树静默消失`,
    );
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
    /** 让 mutate 直接抛（宿主通道关闭、协议异常那一档），与 accept: false 不是一回事。 */
    reject?: Error;
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
        if (opts.reject !== undefined) {
          throw opts.reject;
        }
        return opts.accept ?? true;
      },
    },
  };
}

/** 跑本次渲染登记的 effect（提交阶段），并先执行该槽位上一轮的清理。 */
function runPendingEffects(): void {
  const { box } = runtime;
  const { pending: queued } = box;
  // 先清空：effect 里 setState 会触发再渲染，那一轮登记的 effect 必须由再渲染自己跑，
  // 不能被这里重复执行。
  box.pending = [];
  for (const [index, effect] of queued.entries()) {
    if (effect !== undefined) {
      box.cleanups[index]?.();
      box.cleanups[index] = effect();
    }
  }
}

/** 用例之间换一份干净的槽位：整套替身状态都放在 runtime.box 里。 */
function resetBox(): void {
  Object.assign(runtime.box, {
    values: [],
    setters: [],
    deps: [],
    callbacks: [],
    memos: [],
    cleanups: [],
    pending: [],
    refs: [],
    cursor: 0,
    rerender: undefined,
    tree: undefined,
  });
}

/**
 * 执行并清空上一轮 effect 交回的清理函数。
 *
 * afterEach 挂的就是这一个函数：`useRuntime` 那类计时器靠它收尾。原先 beforeEach 直接把
 * `cleanups` 换成新数组，清理一次都没跑过，而用例照绿。
 */
function runCleanups(): void {
  const { cleanups } = runtime.box;
  runtime.box.cleanups = [];
  for (const cleanup of cleanups) {
    cleanup?.();
  }
}

/**
 * 按宿主输入框的事件形状改一位草稿。
 *
 * 原先每处用例各抄一遍「取控件 → 把 onChange 断成事件签名 → 造 `{ target: { value } }`」，
 * 断言里的强制转换还会吞掉真实签名：字段组件把回调改成 `(value: string)` 时，样板照样
 * 编译通过、静默传错参数。
 *
 * @param tree - 当前元素树
 * @param field - `data-field` 名
 * @param value - 要写进去的字符串
 */
function change(tree: unknown, field: string, value: string): void {
  const { onChange } = controlOf(tree, field).props;
  if (typeof onChange !== "function") {
    throw new TypeError(`字段 ${field} 的控件没有 onChange`);
  }
  Reflect.apply(onChange, undefined, [{ target: { value } }]);
}

/**
 * 触发一个按钮的 onClick。
 *
 * 原先每处用例各写一遍 `(node.props.onClick as () => void)()`：那层强制转换吞掉真实签名，
 * 组件把回调改成 `(event: MouseEvent) => void` 时样板照旧编译通过、静默少传参数。
 *
 * @param node - 取到的那个按钮元素
 */
function click(node: HostNode): void {
  const { onClick } = node.props;
  if (typeof onClick !== "function") {
    throw new TypeError(`按钮 ${String(node.props["data-field"])} 没有 onClick`);
  }
  Reflect.apply(onClick, undefined, []);
}

function drawCard(props: CardProps): unknown {
  runtime.box.cursor = 0;
  const settingsCard = SettingsCard;
  const tree = expand(settingsCard(props));
  runPendingEffects();
  return tree;
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

/**
 * 替身自身也要有判据：这套测试架的正确性是上面所有用例的地基。
 */
describe("测试架：展开器与 effect 时机", () => {
  beforeEach(resetBox);

  afterEach(runCleanups);

  it("展开器：Fragment 与 memo 形态的节点继续展开，认不出的类型直接抛而不是静默丢子树", () => {
    const fragment = {
      type: Symbol.for("react.fragment"),
      props: { children: [{ type: "input", props: { "data-field": "wrapped" } }] },
    };
    expect(hostNodes(expand(fragment)).map((node) => node.props["data-field"])).toStrictEqual([
      "wrapped",
    ]);
    const memoLike = {
      type: { $$typeof: Symbol.for("react.memo") },
      props: { children: [{ type: "span", props: { children: "inside" } }] },
    };
    expect(textOf(expand(memoLike))).toContain("inside");
    expect(() => {
      expand({ type: 7, props: {} });
    }).toThrow(/无法识别的节点类型/u);
  });

  it("effect 在元素树建完之后才执行，交回的清理函数由 runCleanups 收掉", () => {
    const seen: string[] = [];
    const renderProbe = (): unknown => {
      const [count, setCount] = stubUseState(0);
      stubUseEffect(() => {
        seen.push("effect");
        setCount(1);
        return (): void => {
          seen.push("cleanup");
        };
      }, []);
      return { type: "output", props: { value: count } };
    };
    const rendered = expand(renderProbe());
    // 渲染期一次都不执行：effect 里那句 setCount 若在此刻跑，drawCard 的 cursor 归零会让
    // 后续槽位错位，而本卡 50 个控件的断言仍可能全绿。
    expect(seen).toStrictEqual([]);
    expect(hostNodes(rendered)[0]?.props.value).toBe(0);
    runPendingEffects();
    expect(seen).toStrictEqual(["effect"]);
    runCleanups();
    expect(seen).toStrictEqual(["effect", "cleanup"]);
    // 提交阶段那次 setState 落在槽位上：按 drawCard 的做法把 cursor 归零再渲染，读到的就是新值。
    runtime.box.cursor = 0;
    const rerendered = expand(renderProbe());
    expect(hostNodes(rerendered)[0]?.props.value).toBe(1);
  });

  it("依赖没变时 useCallback / useMemo 交回同一份身份，换了依赖才重建", () => {
    const callbacks: unknown[] = [];
    const memos: unknown[] = [];
    let dep: { tick: number } = { tick: 1 };
    const renderProbe = (): unknown => {
      callbacks.push(stubUseCallback(() => dep.tick, [dep]));
      memos.push(stubUseMemo(() => ({ read: dep.tick }), [dep]));
      return { type: "output", props: { value: "probe" } };
    };
    const drawOnce = (): void => {
      runtime.box.cursor = 0;
      expand(renderProbe());
    };
    drawOnce();
    drawOnce();
    // 卡片把 useCallback 的结果写进 effect 的依赖里：这里每次给新闭包，那条 effect 就会每轮
    // 重跑，真实 React 里它不会——计时器与请求序号都因此被测成另一个东西。
    expect(callbacks[1]).toBe(callbacks[0]);
    expect(memos[1]).toBe(memos[0]);
    dep = { tick: 2 };
    drawOnce();
    expect(callbacks[2]).not.toBe(callbacks[1]);
    expect(memos[2]).not.toBe(memos[1]);
  });

  it("写入同值不再触发再渲染，写入新值才触发", () => {
    let rerenders = 0;
    let writeCount: ((next: number) => void) | undefined;
    const renderProbe = (): unknown => {
      const [count, setCount] = stubUseState(0);
      writeCount = setCount;
      return { type: "output", props: { value: count } };
    };
    runtime.box.cursor = 0;
    expand(renderProbe());
    runtime.box.rerender = (): void => {
      rerenders += 1;
      runtime.box.cursor = 0;
      expand(renderProbe());
    };
    if (writeCount === undefined) {
      throw new Error("探针没有登记 setState");
    }
    writeCount(0);
    expect(rerenders).toBe(0);
    writeCount(5);
    expect(rerenders).toBe(1);
  });
});

const PAGE = { view: "page" } as const;

describe("scrapling 设置卡：渲染结构", () => {
  beforeEach(resetBox);

  afterEach(runCleanups);

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
    // 这两个数字**刻意不从 SETTINGS_GROUPS 推导**：上面那个循环的期望值来自同一张表，
    // 表被删空时它照样全绿。独立写死的规模才是「字段表面变了要有人确认」的哨兵，
    // 代价是改表时要同步这两个数（本仓判据要求期望值独立写死，不接受自证）。
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

  it("宿主值回显（含被显式写成 false 的布尔，不被字典默认值盖掉）", () => {
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

  it("布尔位未设置时回显字段表的 fallback，而不是当成 false", () => {
    // failFastOnMissingPython 的 fallback 是 true（src/settings-fields.ts）。上一例把这一位
    // 显式写成 false，测的是「宿主值优先」；这一位没写时读成 false 就把默认行为反着显示了。
    const { form } = formOf({ crawlMaxItems: 1000 });
    const tree = mountCard({ ...PAGE, t, form }).tree();
    expect(controlOf(tree, "failFastOnMissingPython").props["aria-checked"]).toBe(true);
  });

  it("mutate 抛错时显示失败原因并保留草稿，不回到干净态", async () => {
    const fixture = formOf({ crawlMaxItems: 1000 }, { reject: new Error("channel closed") });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    change(card.tree(), "crawlMaxItems", "250");
    click(saveButton(card.tree()));
    await flush();
    expect(fixture.calls).toHaveLength(1);
    expect(textOf(card.tree())).toContain(t("failed", { reason: "Error: channel closed" }));
    // 草稿必须还在：写失败后把输入框抹回宿主值，用户就不知道自己刚改过什么。
    expect(controlOf(card.tree(), "crawlMaxItems").props.value).toBe("250");
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
    click(reveal);
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

  it("没有运行环境读取接口时给出可照抄的 CLI 命令", () => {
    const { form } = formOf({});
    const tree = mountCard({ ...PAGE, t, form }).tree();
    expect(textOf(tree)).toContain(t("runtimeUnavailable"));
    expect(textOf(tree)).toContain("dsh-scrapling setup --feature <pack> --apply");
  });
});

describe("scrapling 设置卡：保存回路", () => {
  beforeEach(resetBox);

  afterEach(runCleanups);

  it("有效改动 → mutate 带 ops 与第一笔改动时的 revision → 受理后回到干净态", async () => {
    const fixture = formOf({ pythonBin: "", crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    change(card.tree(), "crawlMaxItems", "250");
    expect(statusText(card.tree())).toContain(t("statusChanged", { count: 1 }));
    click(saveButton(card.tree()));
    await flush();
    expect(fixture.calls).toStrictEqual([
      { ops: [{ op: "set", path: ["crawlMaxItems"], value: 250 }], revision: 7 },
    ]);
    expect(statusText(card.tree())).toBe(t("statusClean"));
  });

  it("非法数字不写、保存禁用，状态位点名非法项", async () => {
    const fixture = formOf({ crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    change(card.tree(), "crawlMaxItems", "1.");
    expect(saveButton(card.tree()).props.disabled).toBe(true);
    expect(statusText(card.tree())).toContain(t("statusInvalid", { count: 1 }));
    click(saveButton(card.tree()));
    // 与其余用例同一形状：等一拍再断言「没发出写入」。这里原先不加等待就能过，
    // 靠的是实现在第一个 await 之前就按非法项提前返回 —— 那是时序细节，不是判据。
    await flush();
    expect(fixture.calls).toStrictEqual([]);
    expect(controlOf(card.tree(), "crawlMaxItems").props.value).toBe("1.");
  });

  it("改回默认值走 unset，而不是写入同值", async () => {
    const fixture = formOf({ crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    change(card.tree(), "crawlMaxItems", "");
    click(saveButton(card.tree()));
    await flush();
    expect(fixture.calls[0]?.ops).toStrictEqual([{ op: "unset", path: ["crawlMaxItems"] }]);
  });

  it("宿主不受理 → 失败文案可见且草稿保留（保存仍可重试）", async () => {
    const fixture = formOf({ crawlMaxItems: 1000 }, { accept: false });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    change(card.tree(), "crawlMaxItems", "250");
    click(saveButton(card.tree()));
    await flush();
    expect(textOf(card.tree())).toContain(t("rejected"));
    expect(saveButton(card.tree()).props.disabled).toBe(false);
    expect(controlOf(card.tree(), "crawlMaxItems").props.value).toBe("250");
  });

  it("撤销清空草稿，保存重新禁用", () => {
    const fixture = formOf({ crawlMaxItems: 1000 });
    const card = mountCard({ ...PAGE, t, form: fixture.form });
    change(card.tree(), "crawlMaxItems", "250");
    click(controlOf(card.tree(), "discard"));
    expect(controlOf(card.tree(), "crawlMaxItems").props.value).toBe("1000");
    expect(saveButton(card.tree()).props.disabled).toBe(true);
  });
});

/** 动作入口在本用例里不该被触碰：碰到就抛，而不是回一条没人等的 rejected promise。 */
async function actionMustNotRun(): Promise<RuntimeActionResult> {
  throw new Error("本用例不触发安装 / 修复 / 取消");
}

/**
 * 卡片带 runtime 读取接口时才会开轮询计时器，所以清理回路只在这一组用例里真正跑到。
 */
describe("scrapling 设置卡：运行时轮询计时器的回收", () => {
  beforeEach(resetBox);

  afterEach(runCleanups);

  afterAll(() => {
    vi.useRealTimers();
  });

  it("作业 running 时开轮询：计时器按节拍继续回读", async () => {
    vi.useFakeTimers();
    const status = {
      ok: true,
      packs: { core: "ready", browser: "ready" },
      python: { path: "/usr/bin/python3", via: "PATH", version: "3.14.0" },
      dataDir: "/tmp/dsh-scrapling-card-test",
      jobsReady: true,
      job: { id: "job-0123456789abcdef", pack: "browser", status: "running", output: "" },
    } satisfies RuntimeStatusResult;
    let reads = 0;
    // 只让第一笔应答：后续回读若继续 setState 就会不断再渲染，而这两条用例判的是计时器的
    // 回收、不是轮询内容。这一枚永不 settle 的 promise 也不留下未处理拒绝。
    const pendingStatus = Promise.withResolvers<RuntimeStatusResult>();
    const reader: RuntimeReader = {
      status: () => {
        reads += 1;
        return reads === 1 ? Promise.resolve(status) : pendingStatus.promise;
      },
      install: actionMustNotRun,
      repair: actionMustNotRun,
      cancel: actionMustNotRun,
    };
    mountCard({ ...PAGE, t, form: formOf({}).form, runtime: reader });
    // 首次装载 effect 的应答落在微任务里：跑完它 running 才为真，计时器才开。
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const beforePoll = reads;
    await vi.advanceTimersByTimeAsync(4000);
    // 判据要先证明自己量得到东西：计时器活着时回读次数必须往上涨。
    expect(reads).toBeGreaterThan(beforePoll);
  });

  it("afterEach 统一处理：上一条用例的轮询计时器没有带进这一条", () => {
    // 上一条用例故意不自己统一处理，所以这里红不红只由 afterEach 那一条回路决定。
    // 计时器没被 mock 时这一句直接抛，不会在「上一条用例没跑到」时打绿。
    expect(vi.getTimerCount()).toBe(0);
  });
});
