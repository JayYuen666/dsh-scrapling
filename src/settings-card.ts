// dsh-scrapling/src/settings-card.ts —— 插件页里的设置卡。
//
// 坐在 `plugins.bundle.config` 这张 keyed slot 上，键是本包名，宿主因此把本包的配置
// 画在插件详情页里。宿主已经把「读什么、写什么」的通道备好了（`form.state` 是宿主认的
// 值，`form.mutate` 是宿主认的写），本文件只负责把这两样翻译成一张表单。
//
// 为什么不自己声明设置命名空间：命名空间由 cordis.patch.yml 的 `id` 决定，宿主那边
// `settings.describe()` 本来就在把它投影出去；缺的只是**一张能编辑它的页面**。自己再
// 注册一份命名空间，只会让同一个键出现两次。
//
// 保存语义：改回默认值 = 清除覆盖（`unset`），而不是写一个与默认值相同的值。用户层里
// 「显式写了默认值」和「没写」在将来改默认值时行为完全不同，只有 unset 能保住这个区别。

import { createElement, useState } from "react";
import type { ReactNode } from "react";
import { SETTINGS_FIELDS, SETTINGS_GROUPS } from "./settings-fields.ts";
import type { FieldSpec, GroupSpec } from "./settings-fields.ts";

/** 一次字段写入；形状照抄宿主 `SettingsPathOp`，窄声明避免跨包类型依赖。 */
export type PathOp =
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: readonly string[] };

/** 宿主给这张卡的值面。 */
export interface FormState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly value?: Record<string, unknown> | undefined;
  readonly revision?: number | undefined;
  readonly writable: boolean;
}

/** slot 渲染函数的入参。宿主对 `summary` 视图也会调它，那种情况下 form 不给。 */
export interface CardProps {
  readonly view: "summary" | "page";
  readonly form?:
    | {
        readonly state: FormState;
        readonly mutate: (ops: readonly PathOp[], expectedRevision?: number) => Promise<boolean>;
      }
    | undefined;
}

/** 把任意设置值转成控件能显示的字符串；结构值给空串而不是 `[object Object]`。 */
function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * 控件里显示的字符串。草稿优先，其次宿主值，最后字段表里的默认值。
 *
 * @param field - 字段描述
 * @param host - 宿主给的值
 * @param draft - 用户改过但还没保存的值
 * @returns 控件该显示的字符串
 */
export function displayValue(
  field: FieldSpec,
  host: Record<string, unknown> | undefined,
  draft: Record<string, unknown>,
): string {
  const edited = draft[field.key];
  if (edited !== undefined) {
    return textOf(edited);
  }
  const current = host?.[field.key];
  return current === undefined ? String(field.fallback) : textOf(current);
}

/**
 * 把控件里敲进去的一串字翻成设置值。
 *
 * 清空 = 交回默认值，所以空串返回 null（存不下 null —— null 与「没设」在 schema 里同义，
 * 但 unset 表达得更准，且不会在用户层留下一条永远等于默认值的记录）。数字字段按 schema 的
 * 下界夹住，负数与非数字在这里就被挡住，而不是等宿主校验失败再回一句看不懂的报错。
 *
 * @param field - 字段描述
 * @param raw - 控件里的原始字符串
 * @returns 要存的值；null 表示「清除这一项」
 */
export function parseInput(field: FieldSpec, raw: string): string | number | boolean | null {
  if (field.kind === "boolean") {
    return raw === "true";
  }
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  if (field.kind === "number") {
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }
  return text;
}

/**
 * 把草稿翻成一串写入操作。
 *
 * 与默认值相同的项走 unset：用户层里「显式写了默认值」和「没写」在将来改默认值时行为完全
 * 不同，只有 unset 能保住这个区别。顺序跟字段表一致，于是同一份草稿每次生成同样的操作串，
 * 宿主按 revision 拒绝时也不会因为顺序抖动而给出不同的理由。
 *
 * @param draft - 用户改过的字段（只有改过的在里面）
 * @returns 写入操作
 */
export function buildOps(draft: Readonly<Record<string, unknown>>): PathOp[] {
  return SETTINGS_FIELDS.filter((field) => field.key in draft).map((field) => {
    const value = draft[field.key];
    const op: PathOp =
      value === null || value === field.fallback
        ? { op: "unset", path: [field.key] }
        : { op: "set", path: [field.key], value };
    return op;
  });
}

/** 卡片样式。跟着宿主的语义色走，因此明暗两套主题都成立。 */
const CARD_CSS = `
.dss-card{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}
.dss-group{display:flex;flex-direction:column;gap:10px}
.dss-group+.dss-group{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:16px}
.dss-groupTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}
.dss-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dss-fields{display:flex;flex-direction:column;gap:10px}
.dss-field{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 16px;align-items:start}
.dss-label{font-size:13px;line-height:20px}
.dss-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;grid-column:1}
.dss-control{grid-column:2;display:flex;justify-content:flex-end}
.dss-control input[type=text],.dss-control input[type=number]{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:5px 8px;width:100%;max-width:280px}
.dss-control input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dss-control select{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:5px 8px;max-width:280px}
.dss-switch{appearance:none;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-border-l3);position:relative;cursor:pointer;border:0}
.dss-switch:checked{background:var(--dsw-alias-state-business-primary)}
.dss-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .14s}
.dss-switch:checked::after{transform:translateX(16px)}
.dss-switch:disabled{cursor:not-allowed;opacity:.55}
.dss-actions{display:flex;gap:8px;align-items:center}
.dss-button{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;padding:5px 14px}
.dss-button[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent}
.dss-button:disabled{opacity:.5;cursor:not-allowed}
.dss-status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dss-status[data-error=true]{color:var(--dsw-alias-state-error-primary)}
@media (max-width:560px){.dss-field{grid-template-columns:minmax(0,1fr)}.dss-hint,.dss-control{grid-column:1}}
`;

/**
 * 本卡用到的 `document` 面。
 *
 * 窄声明而不是 `Document`：`src/**` 也会被 Node 版 tsconfig 编译（`test/client.test.ts`
 * 经 client-entry.ts 把整个 src 拉进那个程序），那边的 lib 里没有 DOM 全局，写
 * `document.querySelector` 会直接编译不过。声明自己用到的那几个成员，两套 lib 下都成立。
 */
export interface DocumentFace {
  readonly querySelector: (selector: string) => unknown;
  readonly createElement: (tag: string) => { id: string; textContent: string };
  readonly head: { readonly append: (node: unknown) => void };
}

/** 这个值是不是一个带本卡所需那点 API 的 document。类型守卫而不是断言。 */
function isDocumentFace(value: unknown): value is DocumentFace {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "querySelector") === "function" &&
    typeof Reflect.get(value, "createElement") === "function"
  );
}

/** 宿主浏览器里的 document；Node 侧（测试、打包）没有，返回 undefined。
 *
 * 导出是为了能被直接测：这一层的两条分支（是 / 不是 document）在真浏览器里各要一次挂载
 * 才走得到，而把它藏在组件里就只能靠渲染来覆盖。`test/settings-card.test.ts` 直接打它。
 */
export function browserDocument(): DocumentFace | undefined {
  // 用类型守卫而不是断言：断言会把「可能是什么」写成「一定是」，而这里要的恰恰是
  // 「不是就算没有」——非浏览器环境（Node、打包期）里这个值本来就常常不存在。
  const candidate: unknown = Reflect.get(globalThis, "document");
  return isDocumentFace(candidate) ? candidate : undefined;
}

/** 把样式挂进文档，只挂一次。重复挂载会重复注入同一段 CSS，所以那个短路是必要的。
 *
 * 导出是为了能被直接测 —— 同 :func:`browserDocument` 的理由。
 */
export function installStyles(doc: DocumentFace): void {
  const id = "dsh-scrapling-settings-css";
  if (doc.querySelector(`#${id}`) !== null) {
    return;
  }
  const tag = doc.createElement("style");
  tag.id = id;
  tag.textContent = CARD_CSS;
  doc.head.append(tag);
}

/** 一个字段的控件。 */
function renderControl(props: {
  readonly field: FieldSpec;
  readonly shown: string;
  readonly disabled: boolean;
  readonly onChange: (raw: string) => void;
}): ReactNode {
  const { field, shown, disabled, onChange } = props;
  if (field.kind === "boolean") {
    return createElement("input", {
      type: "checkbox",
      className: "dss-switch",
      checked: shown === "true",
      disabled,
      "aria-label": field.label.zh,
      onChange: (event: { target: { checked: boolean } }): void => {
        onChange(String(event.target.checked));
      },
    });
  }
  if (field.kind === "enum") {
    return createElement(
      "select",
      {
        disabled,
        value: shown,
        "aria-label": field.label.zh,
        onChange: (event: { target: { value: string } }): void => {
          onChange(event.target.value);
        },
      },
      (field.options ?? []).map((option) =>
        createElement("option", { key: option, value: option }, option),
      ),
    );
  }
  return createElement("input", {
    type: field.kind === "number" ? "number" : "text",
    value: shown,
    disabled,
    min: field.kind === "number" ? 1 : undefined,
    "aria-label": field.label.zh,
    onChange: (event: { target: { value: string } }): void => {
      onChange(event.target.value);
    },
  });
}

/** 一行：左边标签与说明，右边控件。 */
function renderFieldRow(props: {
  readonly field: FieldSpec;
  readonly shown: string;
  readonly disabled: boolean;
  readonly onChange: (raw: string) => void;
}): ReactNode {
  const { field, shown, disabled, onChange } = props;
  return createElement(
    "div",
    { className: "dss-field" },
    createElement(
      "div",
      { className: "dss-label" },
      field.label.zh,
      createElement("p", { className: "dss-hint" }, field.hint.zh),
    ),
    createElement(
      "div",
      { className: "dss-control" },
      renderControl({ field, shown, disabled, onChange }),
    ),
  );
}

/** 一组字段。 */
function renderGroup(props: {
  readonly group: GroupSpec;
  readonly shown: (field: FieldSpec) => string;
  readonly disabled: boolean;
  readonly onChange: (field: FieldSpec, raw: string) => void;
}): ReactNode {
  const { group, shown, disabled, onChange } = props;
  return createElement(
    "section",
    { className: "dss-group" },
    createElement("h3", { className: "dss-groupTitle" }, group.title.zh),
    createElement("p", { className: "dss-note" }, group.note.zh),
    createElement(
      "div",
      { className: "dss-fields" },
      group.fields.map((field) =>
        renderFieldRow({
          field,
          shown: shown(field),
          disabled,
          onChange: (raw) => {
            onChange(field, raw);
          },
        }),
      ),
    ),
  );
}

/** 顶部那行状态说明。拆成函数是为了不在 JSX 里套三元。 */
function statusLine(state: FormState, changed: number): string {
  if (state.status === "loading") {
    return "正在读取设置…";
  }
  if (state.status === "unavailable" || !state.writable) {
    return "这个连接以只读方式运行，设置改不了。";
  }
  return changed === 0 ? "没有未保存的改动" : `已改动 ${changed} 项，未保存`;
}

/** 设置卡本体。导出为常量而非函数声明：它是 React 组件，不是可 new 的类。 */
export function SettingsCard(props: CardProps): ReactNode {
  const { form } = props;
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  const doc = browserDocument();
  if (doc !== undefined) {
    installStyles(doc);
  }
  // 摘要视图不画表单；宿主只在官方插件的卡片上才用这个视图，本包是 bundle 走不到，真走到
  // 时返回一个空 div 也好过抛错把整张卡顶掉。
  if (props.view !== "page" || form === undefined) {
    return createElement("div", { className: "dss-card" });
  }
  const { state } = form;
  const editable = state.writable && state.status === "ready";
  const ops = buildOps(draft);
  const save = async (): Promise<void> => {
    setSaving(true);
    setFailure("");
    try {
      const accepted = await form.mutate(ops, state.revision);
      if (accepted) {
        setDraft({});
      } else {
        setFailure("保存被宿主拒绝了，设置未改动");
      }
    } catch (error) {
      setFailure(`保存失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  };
  const onFieldChange = (field: FieldSpec, raw: string): void => {
    setFailure("");
    setDraft((previous) => ({ ...previous, [field.key]: parseInput(field, raw) }));
  };
  const groups = SETTINGS_GROUPS.map((group) =>
    renderGroup({
      group,
      shown: (field) => displayValue(field, state.value, draft),
      disabled: !editable,
      onChange: onFieldChange,
    }),
  );
  const actions = createElement(
    "div",
    { className: "dss-actions" },
    createElement(
      "button",
      {
        type: "button",
        className: "dss-button",
        "data-primary": "true",
        disabled: ops.length === 0 || saving || !editable,
        onClick: (): void => {
          void save();
        },
      },
      saving ? "保存中…" : "保存",
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "dss-button",
        disabled: ops.length === 0 || saving,
        onClick: (): void => {
          setDraft({});
          setFailure("");
        },
      },
      "撤销",
    ),
  );
  const status = createElement(
    "p",
    { className: "dss-status", "data-error": "false" },
    statusLine(state, ops.length),
  );
  const reported =
    failure === ""
      ? null
      : createElement("p", { className: "dss-status", "data-error": "true" }, failure);
  return createElement("div", { className: "dss-card" }, status, reported, ...groups, actions);
}
