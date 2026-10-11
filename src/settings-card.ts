// dsh-scrapling/src/settings-card.ts —— 插件页里的设置卡。
//
// 坐在 `plugins.bundle.config` 这张 keyed slot 上，键是本包名，宿主因此把本包的配置
// 画在插件详情页里。卡面自己只负责把「宿主给的配置值面」翻译成一张表单。
//
// **宿主不给这张卡传 form。** 插件管理器渲染 bundle 页时调的是
// `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey })` —— owner props
// 里只有 `view`；row 页与官方插件页才有 `form`，bundle 页没有（一个 bundle 页上可能同时
// 坐着几个 entry，宿主没有单一的 form 可给）。所以 client-entry.ts 自己从
// `ctx.configForms` 取本包的命名空间再喂进来，卡片才拿得到值与写入函数。
//
// 为什么不自己声明设置命名空间：命名空间由 cordis.patch.yml 的 `id` 决定，宿主那边
// `settings.describe()` 本来就在把它投影出去；缺的只是**一张能编辑它的页面**。自己再
// 注册一份命名空间，只会让同一个键出现两次。
//
// 保存语义：改回默认值 = 清除覆盖（`unset`），而不是写一个与默认值相同的值。用户层里
// 「显式写了默认值」和「没写」在将来改默认值时行为完全不同，只有 unset 能保住这个区别。
// 写入用**第一笔改动落地时**读到的 revision 作围栏，而不是点击保存那一刻的最新值 ——
// 后者会让宿主的冲突检测失效，把别处刚写下的值无声覆盖掉。

import { createElement, useState } from "react";
import type { ReactNode } from "react";
import { SETTINGS_FIELDS, SETTINGS_GROUPS } from "./settings-fields.ts";
import type { FieldSpec, GroupSpec } from "./settings-fields.ts";

/** 宿主 locale 服务给的翻译函数；键域是本包的字典键。 */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 一次字段写入；形状照抄宿主 `SettingsPathOp`，窄声明避免跨包类型依赖。 */
export type PathOp =
  | { readonly op: "set"; readonly path: readonly [string]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: readonly [string] };

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
  /** 由 slot 注册的 `locale` 席位注入；bundle 页自己不给，卡片也没有别的取字途径。 */
  readonly t: Translate;
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

/** 一次输入解析的三种结局；分开表示才能不把「非法」误当成「清除」。 */
export type ParsedInput =
  /** 控件被清空 —— 用户要的是交回默认值。 */
  | { readonly kind: "clear" }
  /** 一个能存进 schema 的值。 */
  | { readonly kind: "value"; readonly value: string | number | boolean }
  /** 此刻的输入不是合法值：既不写出去，也不当作清除。 */
  | { readonly kind: "invalid" };

/**
 * 把控件里敲进去的一串字翻成设置值。
 *
 * 清空 = 交回默认值，所以空串给 `clear`。数字字段按 schema 的下界夹住；非数字、零、负数与
 * 小数一律给 `invalid` 而不是 `clear`。早先把它们当成清除，用户填错一个数就会把自己原来
 * 那条覆盖静默删掉，而且界面上看不出发生过什么 —— 非法输入留在控件里、保存按钮因此不可用，
 * 比悄悄改掉用户的配置好。
 *
 * @param field - 字段描述
 * @param raw - 控件里的原始字符串
 * @returns 解析结果
 */
export function parseInput(field: FieldSpec, raw: string): ParsedInput {
  if (field.kind === "boolean") {
    return { kind: "value", value: raw === "true" };
  }
  const text = raw.trim();
  if (text === "") {
    return { kind: "clear" };
  }
  if (field.kind === "number") {
    // 只认十进制正整数，不走 Number()：Number 会把 "0x10" 读成 16、把 " 1e3 " 读成 1000，
    // 用户看到输入框里写着 0x10、存进去的却是 16，是很难自己发现的错。schema 那边是
    // natural().min(1)，这里与它逐字对齐 —— 存不进 schema 的值就不替用户编一个。
    return /^[1-9]\d*$/u.test(text) ? { kind: "value", value: Number(text) } : { kind: "invalid" };
  }
  return { kind: "value", value: text };
}

/**
 * 把草稿翻成一串写入操作。
 *
 * 与默认值相同的项走 unset：用户层里「显式写了默认值」和「没写」在将来改默认值时行为完全
 * 不同，只有 unset 能保住这个区别。顺序跟字段表一致，于是同一份草稿每次生成同样的操作串，
 * 宿主按 revision 拒绝时也不会因为顺序抖动而给出不同的理由。非法字段不出现在串里。
 *
 * @param draft - 用户改过的字段（只有改过的在里面）
 * @returns 写入操作
 */
export function buildOps(draft: Readonly<Record<string, unknown>>): PathOp[] {
  return SETTINGS_FIELDS.filter((field) => Object.hasOwn(draft, field.key))
    .filter((field) => draft[field.key] !== undefined)
    .map((field) => {
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
.dss-secret{display:flex;gap:8px;align-items:center;justify-content:flex-end;width:100%}
.dss-reveal{flex:none;padding:5px 8px;white-space:nowrap}
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
  readonly createElement: (tag: string) => StyleTag;
  readonly head: { readonly append: (node: unknown) => void };
}

/** 注入的 style 元素：只需要设 id 与正文，以及摘掉自己。 */
export interface StyleTag {
  id: string;
  textContent: string;
  remove: () => void;
}

/** 这个值是不是一个带本卡所需那点 API 的 document。类型守卫而不是断言。 */
function isDocumentFace(value: unknown): value is DocumentFace {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const head: unknown = Reflect.get(value, "head");
  return (
    typeof Reflect.get(value, "querySelector") === "function" &&
    typeof Reflect.get(value, "createElement") === "function" &&
    typeof head === "object" &&
    head !== null &&
    typeof Reflect.get(head, "append") === "function"
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

/**
 * 把一段样式挂进文档，返回摘掉它的函数。同一 id 只会有一段，重复调用是空操作。
 *
 * **由 apply 注册在 ctx.effect 里，不在组件的 render 里调**：渲染期改 DOM 是 React 明令
 * 禁止的副作用，并发渲染与 StrictMode 的双调用都会让注入时机不可预测，而同一段 `<style>`
 * 重复注入就会叠两份规则。文档里已经有它时返回的函数也就不该把别人的摘掉。
 *
 * 导出是为了能被直接测 —— 同 :func:`browserDocument` 的理由。
 *
 * @param doc - 宿主文档
 * @param id - 样式元素的 id，也是「已经挂过没有」的判据
 * @param css - 样式正文
 * @returns 摘掉本次注入的样式；没有注入时是空操作
 */
export function installStyle(doc: DocumentFace, id: string, css: string): () => void {
  // 显式比 null 与 undefined 两个「没找到」的写法：本模块声明的返回面是 unknown，只比
  // 其中一个的话，在一个返回 undefined 的实现上会永远短路，样式一次都装不上。
  const present = doc.querySelector(`#${id}`);
  if (present !== undefined && present !== null) {
    return (): void => undefined;
  }
  const tag = doc.createElement("style");
  tag.id = id;
  tag.textContent = css;
  doc.head.append(tag);
  return (): void => {
    tag.remove();
  };
}

/**
 * 把设置卡的样式挂进文档。
 *
 * @param doc - 宿主文档
 * @returns 摘掉本次注入的样式
 */
export function installStyles(doc: DocumentFace): () => void {
  return installStyle(doc, "dsh-scrapling-settings-css", CARD_CSS);
}

/**
 * 文本类控件的 input type。
 *
 * 凭据型字段默认走 ``password``：浏览器只画圆点，值本身丝毫不动 —— 编辑、草稿、保存全都
 * 按原串走，遮住的只是屏幕上那一份。导出为纯函数是为了能被直接测：这一层的两条分支在
 * 真浏览器里各要一次点击才走得到，藏在组件里就只能靠渲染来覆盖。
 *
 * @param field - 字段描述
 * @param revealed - 用户是否已经点过「显示」
 * @returns input 的 type
 */
export function controlType(field: FieldSpec, revealed: boolean): "text" | "password" {
  return field.secret === true && !revealed ? "password" : "text";
}

/** 一个字段的控件。 */
function renderControl(props: {
  readonly field: FieldSpec;
  readonly label: string;
  readonly shown: string;
  readonly disabled: boolean;
  readonly revealed: boolean;
  readonly onReveal: () => void;
  readonly t: Translate;
  readonly onChange: (raw: string) => void;
}): ReactNode {
  const { field, label, shown, disabled, revealed, onReveal, t, onChange } = props;
  if (field.kind === "boolean") {
    return createElement("input", {
      type: "checkbox",
      className: "dss-switch",
      role: "switch",
      checked: shown === "true",
      disabled,
      "aria-label": label,
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
        "aria-label": label,
        onChange: (event: { target: { value: string } }): void => {
          onChange(event.target.value);
        },
      },
      (field.options ?? []).map((option) =>
        createElement("option", { key: option, value: option }, option),
      ),
    );
  }
  const input = createElement("input", {
    type: field.kind === "number" ? "number" : controlType(field, revealed),
    value: shown,
    disabled,
    // 代理地址会被浏览器与密码管理器当成登录凭据：那会把部署方的代理密码收进一个
    // 它根本不打算保管的地方，所以这里显式关掉自动填充。
    ...(field.secret === true ? { autoComplete: "off", spellCheck: false } : {}),
    min: field.kind === "number" ? 1 : undefined,
    step: field.kind === "number" ? 1 : undefined,
    "aria-label": label,
    onChange: (event: { target: { value: string } }): void => {
      onChange(event.target.value);
    },
  });
  if (field.secret !== true) {
    return input;
  }
  // 遮罩的字段配一个显式开关：用户改代理地址时要确认自己填对了，而圆点里看不出 host、
  // 也看不出端口。默认收起，所以「一眼扫过页面」看到仍然是圆点。
  return createElement(
    "span",
    { className: "dss-secret" },
    input,
    createElement(
      "button",
      {
        type: "button",
        className: "dss-button dss-reveal",
        disabled,
        "aria-pressed": revealed,
        "aria-label": label,
        onClick: (): void => {
          onReveal();
        },
      },
      t(revealed ? "conceal" : "reveal"),
    ),
  );
}

/** 一行：左边标签与说明，右边控件。 */
function renderFieldRow(props: {
  readonly field: FieldSpec;
  readonly t: Translate;
  readonly shown: string;
  readonly disabled: boolean;
  readonly revealed: boolean;
  readonly onReveal: () => void;
  readonly onChange: (raw: string) => void;
}): ReactNode {
  const { field, t, shown, disabled, revealed, onReveal, onChange } = props;
  const label = t(`field.${field.key}.label`);
  const control = renderControl({ field, label, shown, disabled, revealed, onReveal, t, onChange });
  const caption = createElement(
    "div",
    { className: "dss-label" },
    label,
    createElement("p", { className: "dss-hint" }, t(`field.${field.key}.hint`)),
  );
  return createElement(
    "div",
    { className: "dss-field", key: field.key },
    caption,
    createElement("div", { className: "dss-control" }, control),
  );
}

/** 一组字段。 */
function renderGroup(props: {
  readonly group: GroupSpec;
  readonly t: Translate;
  readonly shown: (field: FieldSpec) => string;
  readonly disabled: boolean;
  readonly revealed: (field: FieldSpec) => boolean;
  readonly onReveal: (field: FieldSpec) => void;
  readonly onChange: (field: FieldSpec, raw: string) => void;
}): ReactNode {
  const { group, t, shown, disabled, revealed, onReveal, onChange } = props;
  return createElement(
    "section",
    { className: "dss-group", key: group.id },
    createElement("h3", { className: "dss-groupTitle" }, t(`group.${group.id}.title`)),
    createElement("p", { className: "dss-note" }, t(`group.${group.id}.note`)),
    createElement(
      "div",
      { className: "dss-fields" },
      group.fields.map((field) =>
        renderFieldRow({
          field,
          t,
          shown: shown(field),
          disabled,
          revealed: revealed(field),
          onReveal: () => {
            onReveal(field);
          },
          onChange: (raw) => {
            onChange(field, raw);
          },
        }),
      ),
    ),
  );
}

/** 顶部那行状态说明。拆成函数是为了不在 JSX 里套三元。 */
function statusLine(t: Translate, state: FormState, changed: number, invalid: number): string {
  if (state.status === "loading") {
    return t("statusLoading");
  }
  if (invalid > 0) {
    return t("statusInvalid", { count: invalid });
  }
  if (state.status === "unavailable" || !state.writable) {
    return t("statusReadonly");
  }
  return changed === 0 ? t("statusClean") : t("statusChanged", { count: changed });
}

/** 用户的未保存改动，以及它们所依据的那一版宿主配置。 */
interface Draft {
  /** 字段键 → 该字段要写的值；值与字段表默认值相同时按 unset 处理。 */
  readonly values: Readonly<Record<string, unknown>>;
  /** 第一笔改动落地时读到的 revision，写入时当围栏用；还没动过就是 undefined。 */
  readonly baseRevision: number | undefined;
  /** 此刻是非法输入、不会被写出去的字段键。 */
  readonly invalid: readonly string[];
}

const EMPTY_DRAFT: Draft = { values: {}, baseRevision: undefined, invalid: [] };

/** 底部那一行按钮。 */
function renderActions(props: {
  readonly t: Translate;
  readonly saving: boolean;
  readonly editable: boolean;
  readonly blocked: boolean;
  readonly changed: number;
  readonly onSave: () => void;
  readonly onUndo: () => void;
}): ReactNode {
  const { t, saving, editable, blocked, changed, onSave, onUndo } = props;
  const idle = changed === 0;
  return createElement(
    "div",
    { className: "dss-actions" },
    createElement(
      "button",
      {
        type: "button",
        className: "dss-button",
        "data-primary": "true",
        disabled: idle || blocked || saving || !editable,
        onClick: onSave,
      },
      saving ? t("saving") : t("save"),
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "dss-button",
        disabled: idle || blocked || saving,
        onClick: onUndo,
      },
      t("undo"),
    ),
  );
}

/** 设置卡本体。导出为常量而非函数声明：它是 React 组件，不是可 new 的类。 */
export function SettingsCard(props: CardProps): ReactNode {
  const { form, t } = props;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  // 已被用户点开「显示」的凭据型字段。默认空 —— 页面上一眼能看到的仍然是圆点。
  const [revealed, setRevealed] = useState<readonly string[]>([]);
  // 摘要视图不画表单；宿主只在官方插件的卡片上才用这个视图，本包是 bundle 走不到，真走到
  // 时返回一个空 div 也好过抛错把整张卡顶掉。
  if (props.view !== "page" || form === undefined) {
    return createElement("div", { className: "dss-card" });
  }
  const { state } = form;
  const editable = state.writable && state.status === "ready";
  const ops = buildOps(draft.values);
  const save = async (): Promise<void> => {
    setSaving(true);
    setFailure("");
    try {
      // 围栏用「第一笔改动时」的 revision。传点击那一刻的最新值等于没传：宿主在这期间
      // 被别处改过时，本卡的陈旧草稿会带着新 revision 提交，冲突检测形同不存在。
      const accepted = await form.mutate(ops, draft.baseRevision);
      if (accepted) {
        // 只摘掉这次真正发出去的字段：控件在 await 期间是锁着的，但程序化改动仍可能落进来。
        setDraft((previous) => {
          const values = { ...previous.values };
          for (const op of ops) {
            const [key] = op.path;
            Reflect.deleteProperty(values, key);
          }
          // 全发出去了就把围栏也一并清掉，否则下一次改动会继承一个已经过期的 revision。
          return Object.keys(values).length === 0 ? EMPTY_DRAFT : { ...previous, values };
        });
      } else {
        setFailure(
          draft.baseRevision !== undefined && draft.baseRevision !== state.revision
            ? t("stale")
            : t("rejected"),
        );
      }
    } catch (error) {
      setFailure(t("failed", { reason: String(error) }));
    } finally {
      setSaving(false);
    }
  };
  const onFieldChange = (field: FieldSpec, raw: string): void => {
    setFailure("");
    const parsed = parseInput(field, raw);
    setDraft((previous) => {
      const values = { ...previous.values };
      const invalid = previous.invalid.filter((key) => key !== field.key);
      // 围栏只在第一笔改动上记一次：之后同一张卡的草稿始终对着那一版配置。
      const baseRevision = previous.baseRevision ?? state.revision;
      if (parsed.kind === "invalid") {
        // 非法输入留在控件里，但不当成「清除」：写出去的那一串操作里不含这个字段，
        // 保存按钮也因为它在 invalid 里而不可用，用户看得见哪里没填对。
        return { values, baseRevision, invalid: [...invalid, field.key] };
      }
      values[field.key] = parsed.kind === "clear" ? null : parsed.value;
      return { values, baseRevision, invalid };
    });
  };
  const groups = SETTINGS_GROUPS.map((group) =>
    renderGroup({
      group,
      t,
      shown: (field) => displayValue(field, state.value, draft.values),
      // 保存期间连控件一起锁：否则用户在 await 期间改了别的字段，成功后那笔改动会被清掉。
      disabled: !editable || saving,
      revealed: (field) => revealed.includes(field.key),
      onReveal: (field) => {
        setRevealed((previous) =>
          previous.includes(field.key)
            ? previous.filter((key) => key !== field.key)
            : [...previous, field.key],
        );
      },
      onChange: onFieldChange,
    }),
  );
  const blocked = draft.invalid.length > 0;
  const actions = renderActions({
    t,
    saving,
    editable,
    blocked,
    changed: ops.length,
    onSave: (): void => {
      void save();
    },
    onUndo: (): void => {
      setDraft(EMPTY_DRAFT);
      setFailure("");
    },
  });
  const status = createElement(
    "p",
    { className: "dss-status", "data-error": "false", role: "status", "aria-live": "polite" },
    statusLine(t, state, ops.length, draft.invalid.length),
  );
  const reported =
    failure === ""
      ? null
      : createElement(
          "p",
          {
            className: "dss-status",
            "data-error": "true",
            role: "alert",
            "aria-live": "assertive",
          },
          failure,
        );
  return createElement("div", { className: "dss-card" }, status, reported, ...groups, actions);
}
