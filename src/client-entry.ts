// dsh-scrapling/src/client-entry.ts —— Client 半：每个工具的一行结果 + 设置卡。
//
// 内置 Web Client 不消费我们 `presentCall`/`presentResult` 里那套 `web` 卡片，抓取类工具的
// 结果得自己画一行；设置卡则坐在 `plugins.bundle.config` 这张 slot 上。
//
// 三件宿主契约上的事写在这里，改动前先读完：
//
// · **bundle 页不传 form。** 插件管理器渲染 bundle 页时 owner props 只有 `{ view }`；
//   row 页与官方插件页才有 `form`（一个 bundle 页可能同时坐着几个 entry，宿主没有单一的
//   form 可给）。所以设置卡的 form 由本文件从 `ctx.configForms` 取 —— 见 apply()。
// · **ctx 只认它自己声明过的那些服务。** cordis 的上下文代理对没进 `inject` 的名字直接
//   抛 `cannot get property "<name>" without inject`（@deepseek-ai/cordis 里
//   `ReflectService.handler.get`）。这个抛出落在 `ctx.effect` 的函数体里时会穿出 `apply()`
//   （`Fiber._execute` → `composeError` → `handleError` 以 `throw reason` 收尾），界面上
//   看不出异常的原因是注册根本没发生，而不是错误被谁吞了。所以
//   `ctx.locale` / `ctx.configForms` 必须写进下面的 inject 清单 —— 少写一个，症状就是
//   整张设置卡与全部结果行一起静默消失。六个同类插件与官方的
//   dsh-experimental-client-ui-voice-input 都声明 `["slots", "configForms", "locale"]`。
//   「可选服务改用 ctx.inject 嵌套去取」这条路这里不走：locale 服务自己就 inject 了 configForms
//   （@deepseek-ai/dsh-client-locale 的 client 侧），能拿到 locale 的 profile 必然有 configForms，
//   嵌套只是把一次编译期可见的错误换成运行时的静默失败。
// · **结果行读的是 owner props，而阶段写在顶层。** 宿主给的是 `ToolCallViewProps`：
//   `phase` 与 `block` 是并列的两位，`block` 按阶段变形；参数经 `block.args`（惰性
//   PartialArguments 视图）读，结果侧的投影只在 `phase === "result"` 那一支的 `block.meta` 上。
//
// 只用具名导出：构建脚本把产物包进 window.__ModuleLoader__.load({ id, factory })，
// 同时给具名与 default 会触发 rolldown 的 MIXED_EXPORTS 警告。

import type { Context } from "@deepseek-ai/cordis";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { createElement } from "react";
import type { ReactNode } from "react";
import { claimApply, isRecord } from "@jayyuen66/dsh-plugin-shared/client";
import {
  BUNDLE_PACKAGE_NAME,
  LOCALE_NS,
  SETTINGS_ENTRY_ID,
  localeDictionaries,
} from "./settings-fields.ts";
import { SettingsCard, browserDocument, installStyle, installStyles } from "./settings-card.ts";
import { createRuntimeReader } from "./runtime-reader.ts";
import { SCRAPLING_LOGO_ACCENT_URI, SCRAPLING_LOGO_BODY_URI } from "./scrapling-icon.ts";
import type { RuntimeReader } from "./runtime-reader.ts";
import type {
  CardProps,
  DocumentFace,
  FormSource,
  FormState,
  PathOp,
  Translate,
} from "./settings-card.ts";

/** 一行要展示的一项信息。label 是字典键而不是文案本身：可见文字统一走 locale 服务。 */
/** 结果行字段的文案键：多处复用，抽一份免得字面量散落。 */
const ROW_TYPE_KEY = "row.type";
const ROW_SESSION_KEY = "row.session";

/** 设置页一级分区的 id（`settings.section` 的 `id`，图标靠同一个值对上）。
 *  与设置命名空间分开写：分区 id 是**页面位置**的名字，`SETTINGS_ENTRY_ID` 是**配置与文案**
 *  的名字，两者哪天拆开（比如一个分区放两张卡）时不该互相牵连。 */
const SECTION_ID = "dsh-scrapling";

/** 分区在导航里的位次：宿主已占 -10/0/10/15/20，本包三仓的分区排 30 起。 */
const SECTION_ORDER = 30;

export interface RowField {
  /** 字段名（展示用，不参与计算）；渲染时经 t() 取字。 */
  readonly labelKey: string;
  /** 字段值。值本身也来自宿主载荷，因此直接是要显示的串。 */
  readonly value: string;
  /** 值是固定措辞而非宿主数据时给字典键；给了就用它替掉 value。 */
  readonly valueKey?: string;
}

/** 一个工具的结果行规格。纯数据，方便单测。 */
export interface RowSpec {
  /** 工具名（也是 slot 的 key）。 */
  readonly tool: string;
  /** 行标题。 */
  readonly title: string;
  /** 要展示的字段，按顺序。 */
  readonly fields: readonly RowField[];
}

/**
 * 需要专用结果行的工具。
 *
 * 每个工具一个 key：slot 按 key 派发，漏掉一个只是那一个不画行，不会连累别的。这份清单
 * 必须与 `host.ts` 的 `TOOL_SPECS` 对齐 —— 少登记一个，用户看到的就是宿主那条不带本包
 * 摘要信息的通用行。
 */
export const ROW_TOOLS: readonly string[] = [
  "scrapling_fetch",
  "scrapling_extract",
  "scrapling_locate",
  "scrapling_links",
  "scrapling_render",
  "scrapling_capture_xhr",
  "scrapling_answer",
  "scrapling_session_open",
  "scrapling_session_fetch",
  "scrapling_session_network",
  "scrapling_session_state_save",
  "scrapling_session_state_load",
  "scrapling_session_list",
  "scrapling_session_close",
  "scrapling_crawl",
  "scrapling_session_read",
  "scrapling_session_act",
  "scrapling_download",
  "scrapling_screenshot",
];

/** 把任意值转成字符串；非字符串/非数字一律给空串。 */
function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/** 取第一个非空字符串候选。 */
function firstText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value !== "") {
      return value;
    }
  }
  return "";
}

/** extract / locate 的结果行：选择器进标题，命中数落在 row.matched。 */
function selectorRow(
  tool: string,
  parameters: Record<string, unknown>,
  projected: Record<string, unknown>,
): RowSpec {
  const selector = text(parameters["selector"]);
  return {
    tool,
    title: selector === "" ? tool : `${tool} ${selector}`,
    fields: [{ labelKey: "row.matched", value: text(projected["count"]) }],
  };
}

/** links 的结果行：有 baseUrl 时一并展示，否则只给链接数。 */
function linksRow(
  tool: string,
  parameters: Record<string, unknown>,
  projected: Record<string, unknown>,
): RowSpec {
  const fields: RowField[] = [];
  const baseUrl = text(parameters["baseUrl"]);
  if (baseUrl !== "") {
    fields.push({ labelKey: "row.url", value: baseUrl });
  }
  fields.push({ labelKey: "row.matched", value: text(projected["count"]) });
  return { tool, title: tool, fields };
}

/**
 * 从一次工具调用的参数与投影里抽出要展示的行。
 *
 * 两侧都按「可能缺字段」处理：卡片的输入是别的进程拼出来的载荷，少一个字段就少展示
 * 一项，而不是抛错把整行画没了。
 *
 * @param tool 工具名
 * @param args 调用参数
 * @param meta Host 侧 presentationMeta 投影（可能缺席）
 * @returns 行规格
 */
export function buildRow(tool: string, args: unknown, meta: unknown): RowSpec {
  const parameters = isRecord(args) ? args : {};
  const projected = isRecord(meta) ? meta : {};
  const url = firstText(projected["url"], parameters["url"]);

  if (tool === "scrapling_extract" || tool === "scrapling_locate") {
    return selectorRow(tool, parameters, projected);
  }
  if (tool === "scrapling_links") {
    return linksRow(tool, parameters, projected);
  }
  if (tool === "scrapling_session_list") {
    return {
      tool,
      title: tool,
      fields: [{ labelKey: "row.sessionCount", value: text(projected["count"]) }],
    };
  }
  if (tool === "scrapling_session_open") {
    return {
      tool,
      title: tool,
      fields: [
        { labelKey: ROW_TYPE_KEY, value: text(parameters["sessionType"]) },
        { labelKey: ROW_SESSION_KEY, value: text(projected["sessionId"]) },
      ],
    };
  }
  if (tool === "scrapling_session_close") {
    return {
      tool,
      title: tool,
      fields: [{ labelKey: ROW_SESSION_KEY, value: text(parameters["sessionId"]) }],
    };
  }
  if (
    tool === "scrapling_session_network" ||
    tool === "scrapling_session_state_save" ||
    tool === "scrapling_session_state_load"
  ) {
    const fields: RowField[] = [
      { labelKey: ROW_SESSION_KEY, value: text(parameters["sessionId"]) },
    ];
    // 网络历史与登录态都以会话为轴；登录态那一对再多一个文件名，那是它唯一的模型侧入参。
    const name = text(parameters["name"]);
    if (name !== "") {
      fields.push({ labelKey: "row.name", value: name });
    }
    return { tool, title: tool, fields };
  }
  if (tool === "scrapling_crawl") {
    return {
      tool,
      title: tool,
      fields: [
        { labelKey: "row.start", value: url },
        { labelKey: "row.pageCap", value: text(parameters["maxPages"]) },
        { labelKey: "row.job", value: text(projected["jobId"]) },
      ],
    };
  }

  // 抓取类：URL / HTTP / 是否截断。只展示拿得到的。
  const fields: RowField[] = [];
  if (url !== "") {
    fields.push({ labelKey: "row.url", value: url });
  }
  const status = projected["statusCode"];
  if (typeof status === "number") {
    fields.push({ labelKey: "row.http", value: String(status) });
  }
  if (projected["truncated"] === true) {
    fields.push({ labelKey: "row.body", value: "", valueKey: "row.truncated" });
  }
  return { tool, title: tool, fields };
}

/** 结果行用得到的参数键。视图是惰性的，只挑这几个读才不会物化整段参数 JSON。 */
const ARG_KEYS: readonly string[] = [
  "url",
  "baseUrl",
  "selector",
  "sessionType",
  "sessionId",
  "name",
  "maxPages",
];

/** 宿主给的惰性参数视图上，本行用得到的两个读取器。两者都是全函数：缺席给 undefined。 */
export interface ArgsFace {
  readonly text: (key: string) => string | undefined;
  readonly value: (key: string) => unknown;
}

/**
 * 把宿主的参数视图摊成 buildRow 认得的普通对象。
 *
 * @param args - 宿主给的参数视图
 * @returns 普通对象；视图缺席时是空对象
 */
export function readArgs(args: ArgsFace | undefined): Record<string, unknown> {
  if (args === undefined) {
    return {};
  }
  const values: Record<string, unknown> = {};
  for (const key of ARG_KEYS) {
    const asText = args.text(key);
    // 空串不算「text() 命中」：数值参数在这一路里给回什么形态不是本包的契约，而一旦给回
    // 空串，`??` 会短路掉 `value()`，行上那一格就永久空白 —— 参数明明在场。真实的空串入参
    // 走 `value()` 拿到的仍是同一个空串，两种情况都不丢信息。
    const asValue = asText === undefined || asText.length === 0 ? args.value(key) : asText;
    if (asValue !== undefined) {
      values[key] = asValue;
    }
  }
  return values;
}

/**
 * 结果侧投影只在 `phase === "result"` 那一支上有：宿主的 toolview props 把阶段写在**顶层**，
 * `block` 是按阶段变形的联合（preparing / start / result 各一种节点），meta 只挂在落定的那一支。
 *
 * @param props - 宿主给的 owner props
 * @returns 结果侧投影；没落定时是 undefined
 */
export function resultMetaOf(props: ToolCallViewProps): unknown {
  return props.phase === "result" ? props.block.meta : undefined;
}

/** 结果行自己的样式。跟着宿主的语义色走，明暗两套主题都成立。 */
const ROW_CSS = `
.dsh-scrapling-row{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-scrapling-rowTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-scrapling-rowFields{display:flex;flex-wrap:wrap;gap:2px 12px;margin:0;padding:0;list-style:none}
.dsh-scrapling-rowField{display:flex;gap:4px;min-width:0;font-size:12px;line-height:18px}
.dsh-scrapling-rowLabel{color:var(--dsw-alias-label-tertiary);flex:none}
.dsh-scrapling-rowValue{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-scrapling-rowButton{align-self:flex-start;border:0;background:0 0;padding:0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}
.dsh-scrapling-rowButton:hover{color:var(--dsw-alias-label-primary)}
.dsh-scrapling-rowButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-scrapling-page{padding:4px 0 8px}
.dsh-scrapling-icon{position:relative;display:inline-block;flex:none}
.dsh-scrapling-iconLayer{position:absolute;inset:0;background-color:currentColor;-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-image:url(${SCRAPLING_LOGO_BODY_URI});mask-image:url(${SCRAPLING_LOGO_BODY_URI})}
.dsh-scrapling-iconAccent{position:absolute;inset:0;background-color:#B3FB2A;-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-image:url(${SCRAPLING_LOGO_ACCENT_URI});mask-image:url(${SCRAPLING_LOGO_ACCENT_URI})}
`;

/**
 * 一行结果的渲染。
 *
 * 入参走 `block.args`，结果侧的投影走顶层 `phase` 选出的 `block.meta`；两者都按「可能还没到」处理 ——
 * 调用刚发出时既没有 meta 也没有完整入参，这一行就只画标题。
 */
function RowView(props: ToolCallViewProps & { readonly t: Translate }): ReactNode {
  const { toolName, block, inspect, t } = props;
  const meta = resultMetaOf(props);
  const spec = buildRow(toolName, readArgs(block.args), meta);
  const children: ReactNode[] = [
    createElement("div", { className: "dsh-scrapling-rowTitle", key: "title" }, spec.title),
  ];
  if (spec.fields.length > 0) {
    children.push(
      createElement(
        "ul",
        { className: "dsh-scrapling-rowFields", key: "fields" },
        spec.fields.map((field) =>
          createElement(
            "li",
            { className: "dsh-scrapling-rowField", key: field.labelKey },
            createElement("span", { className: "dsh-scrapling-rowLabel" }, t(field.labelKey)),
            createElement(
              "span",
              { className: "dsh-scrapling-rowValue" },
              field.valueKey === undefined ? field.value : t(field.valueKey),
            ),
          ),
        ),
      ),
    );
  }
  if (inspect !== undefined) {
    children.push(
      createElement(
        "button",
        {
          type: "button",
          className: "dsh-scrapling-rowButton",
          key: "inspect",
          onClick: (): void => {
            inspect();
          },
        },
        t("row.inspect"),
      ),
    );
  }
  return createElement(
    "div",
    { className: "dsh-scrapling-row", "data-tool": toolName },
    ...children,
  );
}

/** 本 Client 半注入的服务。三个都得在这儿 —— 见文件头第二条。 */
const inject = ["slots", "configForms", "locale"];

/**
 * Client 侧只声明用到的成员。
 *
 * 不直接用官方的 Context：客户端 ctx 的完整类型带几十个服务，而本包只需要 slots、effect
 * （两者都是 claimApply 与注册路径的要求），以及 configForms 与 locale 这两个卡片要用的。
 * 三个服务名同时出现在上面的 inject 清单里 —— 这个接口只是类型投影，运行时能不能取到由
 * cordis 按那份清单决定，两边必须一致。
 */
interface ClientFace {
  readonly slots: {
    inject: (slot: string, register: () => void) => void;
    register: (
      // `key` 是 keyed 槽（`plugins.bundle.config`）的寻址位，`id` 是 list 槽
      // （`settings.section` / `settings.section.icon`）的寻址位；`order` 与 `label` 只有 list 槽要。
      // 三处签名合写一份是因为宿主那两个 register 是同一个方法，只是选项按槽位 kind 变形。
      options: {
        name: string;
        key?: string;
        id?: string;
        order?: number;
        label?: () => string;
        locale?: string;
        inject?: () => CardInject;
      },
      render: (props: never) => unknown,
    ) => () => void;
  };
  readonly configForms: {
    get: (entryId: string) => {
      readonly getSnapshot: () => FormState;
      readonly subscribe: (listener: () => void) => () => void;
      readonly mutate: (ops: readonly PathOp[], expectedRevision?: number) => Promise<boolean>;
    };
  };
  readonly locale: {
    register: (ns: string, locale: string, dict: Record<string, string>) => () => void;
    bind: (ns: string) => Translate;
  };
  /** 显式读一个可选客户端服务；运行环境读取接口走它取 remote，不写进 inject。 */
  readonly get?: (name: string, strict?: boolean) => unknown;
  readonly effect: Context["effect"];
}

/**
 * 给每个需要专用结果行的工具登记一行视图。
 *
 * @param ctx - 已就绪 slots 与 locale 的上下文
 * @returns 注销全部登记的函数
 */
function registerToolViews(ctx: ClientFace): () => void {
  const t = ctx.locale.bind(LOCALE_NS);
  const disposers: (() => void)[] = [];
  for (const tool of ROW_TOOLS) {
    disposers.push(
      ctx.slots.register(
        { name: "tool.call.toolview", key: tool, locale: LOCALE_NS },
        (props: ToolCallViewProps) => createElement(RowView, { ...props, t }),
      ),
    );
  }
  return (): void => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

/**
 * 设置页导航图标（`settings.section.icon`）。
 *
 * 图形是 **scrapling 官方标记**（`src/scrapling-icon.ts` 里那两张遮罩位图）：用户要求三个仓
 * 都用官方图形。这里把官方图拆成「本体」与「高光」两层分别上色 —— 本体取 `currentColor`
 * （跟随导航行前景色，深色主题是浅色、浅色主题是深色），高光保留官方绿。于是两种主题下
 * 都与官方图一致，而形状与 alpha 一个像素都没改。
 *
 * 为什么不直接 `<img src>`：官方标记本体是**纯黑**（scrapling logo 的黑章鱼），
 * 深色主题下直接放进去就是一团黑；而先改图再内联等于动官方像素。遮罩只取 alpha。
 *
 * @param props - `size` 是导航行要的方形边长，`active` 表示该分区当前被选中。
 * @returns 两层遮罩叠出来的方块。
 */
function ScraplingSectionIcon(props: {
  readonly size: number;
  readonly active: boolean;
}): ReactNode {
  const box = { width: props.size, height: props.size };
  return createElement(
    "span",
    {
      className: "dsh-scrapling-icon",
      style: box,
      "aria-hidden": true,
      "data-scrapling-section-icon": props.active ? "active" : "idle",
    },
    createElement("span", { className: "dsh-scrapling-iconLayer", style: box }),
    createElement("span", { className: "dsh-scrapling-iconAccent", style: box }),
  );
}

/** 详情页与一级分区共用的注入面（`view` 由宿主给，不在这一份里）。 */
interface CardInject {
  readonly t: Translate;
  readonly form: FormSource;
  readonly runtime: RuntimeReader | undefined;
}

/** 一级分区的 owner props：宿主只给 `close`，**没有 `view`**（那是插件详情页那一侧的位）。 */
interface SectionOwnerProps {
  readonly close: () => void;
}

/**
 * 分区页面外壳：一级分区没有插件页那层卡片外壳，这里补一点留白。
 *
 * ⚠ `view` 必须由这里显式传 `"page"`：`SettingsCard` 在 `view !== "page"` 时早退成一张空表单
 * （`src/settings-card.ts` 里那个早退是给插件详情页的 summary 视图准备的），而
 * `settings.section` 的 owner props 里根本没有 `view` 这一位 —— 直接把 props 透传下去，
 * 分区里就是一片空白，且不报任何错。这是本包在两类槽之间唯一的**形状差异**。
 *
 * @param props - 宿主的 owner props 与本文件的 inject 面合起来的那一份
 * @returns 卡片元素
 */
function ScraplingSection(props: SectionOwnerProps & CardInject): ReactNode {
  return createElement(
    "div",
    { className: "dsh-scrapling-page" },
    createElement(SettingsCard, {
      view: "page",
      t: props.t,
      form: props.form,
      runtime: props.runtime,
    }),
  );
}

/**
 * Client 插件入口：给每个工具注册一行结果视图，并把设置卡挂上插件详情页。
 *
 * @param ctx - 客户端上下文
 */
function apply(ctx: ClientFace): void {
  // HMR 重载时全局标记仍在，直接返回，避免重复注册。
  if (!claimApply(ctx, "__dshScraplingToolviewApplied", "dsh-scrapling toolview")) {
    return;
  }

  // 样式在 apply 里挂一次、卸载时摘掉。挂在组件的 render 里是 React 明令禁止的渲染期副作用。
  ctx.effect(() => {
    const doc: DocumentFace | undefined = browserDocument();
    if (doc === undefined) {
      return (): void => undefined;
    }
    const disposeCard = installStyles(doc);
    const disposeRow = installStyle(doc, "dsh-scrapling-row-css", ROW_CSS);
    return (): void => {
      disposeCard();
      disposeRow();
    };
  }, "dsh-scrapling: client styles");

  // 字典整个插件只注册一份：结果行与设置卡共用同一个命名空间、各自 bind，
  // 两处各注册一次会让后一次悄悄盖掉前一次。
  ctx.effect(() => {
    const dictionaries = localeDictionaries();
    const disposers = [
      ctx.locale.register(LOCALE_NS, "zh", dictionaries.zh),
      ctx.locale.register(LOCALE_NS, "en", dictionaries.en),
    ];
    let disposeRows: (() => void) | undefined;
    ctx.slots.inject("tool.call.toolview", () => {
      disposeRows = registerToolViews(ctx);
    });
    return (): void => {
      disposeRows?.();
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, "dsh-scrapling: dictionaries and tool rows");

  // 设置卡还要 configForms：bundle 页给的 owner props 里没有 form，得自己取。
  ctx.effect(() => {
    const form = ctx.configForms.get(SETTINGS_ENTRY_ID);
    const t = ctx.locale.bind(LOCALE_NS);
    // 宿主给 row/item 页准备的那一份 form，bundle 页没有，这里补上。值在注册体之外造
    // 一次：卡片的 useSyncExternalStore 比的是 subscribe 的引用，每帧换一个新的就会每帧重建
    // 订阅，而重建那一拍可能漏掉一次宿主通知。宿主那份表单本身长活，所以这一份也长活。
    const source: FormSource = {
      getSnapshot: (): FormState => form.getSnapshot(),
      subscribe: (listener: () => void): (() => void) => form.subscribe(listener),
      mutate: (operations, revision) => form.mutate(operations, revision),
    };
    const runtime = createRuntimeReader(ctx);
    // 详情页与设置页一级分区吃同一批注入位：`t` 来自 locale 席位，`form` 是本文件补的那一份，
    // `runtime` 是运行环境读取接口。写成一处工厂是为了「两处显示同一份配置」没有第二种实现。
    const cardInject = (): CardInject => ({ t, form: source, runtime });

    let disposeCard: (() => void) | undefined;
    ctx.slots.inject("plugins.bundle.config", () => {
      disposeCard = ctx.slots.register(
        { name: "plugins.bundle.config", key: BUNDLE_PACKAGE_NAME, locale: LOCALE_NS },
        (props: CardProps) => createElement(SettingsCard, { ...props, ...cardInject() }),
      );
    });

    // 设置页左侧一级分区。`label` 给的是 thunk 而不是字符串：宿主每次读导航行都重新求值，
    // 于是切语言时这一行跟着变，而不需要本插件重新注册。
    let disposeSection: (() => void) | undefined;
    ctx.slots.inject("settings.section", () => {
      disposeSection = ctx.slots.register(
        {
          name: "settings.section",
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t("navLabel"),
          locale: LOCALE_NS,
          inject: cardInject,
        },
        ScraplingSection,
      );
    });

    // 导航图标：id 必须与上面那条 `settings.section` 的 id 逐字相同，对不上时宿主一条都不渲染
    // （`settings.section.icon` 的 doc 原文），症状是分区还在、图标一直是默认齿轮。
    let disposeIcon: (() => void) | undefined;
    ctx.slots.inject("settings.section.icon", () => {
      disposeIcon = ctx.slots.register(
        { name: "settings.section.icon", id: SECTION_ID, order: SECTION_ORDER },
        ScraplingSectionIcon,
      );
    });

    return (): void => {
      disposeCard?.();
      disposeSection?.();
      disposeIcon?.();
    };
  }, "dsh-scrapling: settings card");
}

export { apply, inject };
