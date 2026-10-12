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
//   抛 `cannot get property "<name>" without inject`（@deepseek-ai/cordis
//   lib/index.js:671-697 的 ReflectService.handler.get），而这个抛出发生在 `ctx.effect`
//   的函数体里时只会被记进 logger（同文件 :1261），界面上看不出任何异常。所以
//   `ctx.locale` / `ctx.configForms` 必须写进下面的 inject 清单 —— 少写一个，症状就是
//   整张设置卡与全部结果行一起静默消失。六个同类插件与官方的
//   dsh-experimental-client-ui-voice-input 都声明 `["slots", "configForms", "locale"]`。
//   「可选服务改用 ctx.inject 嵌套去取」这条路这里不走：locale 服务自己就依赖 configForms
//   （dsh-client-locale/lib/client.js:1491），能拿到 locale 的 profile 必然有 configForms，
//   嵌套只是把一次编译期可见的错误换成运行时的静默失败。
// · **结果行读的是 owner props，不是 buildRow 当初假定的入参。** 参数要经宿主给的
//   `block.args`（惰性 PartialArguments 视图）读，结果侧的投影在 `block.meta`。
//
// 只用具名导出：构建脚本把产物包进 window.__ModuleLoader__.load({ id, factory })，
// 同时给具名与 default 会触发 rolldown 的 MIXED_EXPORTS 警告。

import type { Context } from "@deepseek-ai/cordis";
import { createElement } from "react";
import type { ReactNode } from "react";
import { claimApply } from "@jayyuen66/dsh-plugin-shared/lib/card-apply";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import {
  BUNDLE_PACKAGE_NAME,
  LOCALE_NS,
  SETTINGS_ENTRY_ID,
  localeDictionaries,
} from "./settings-fields.ts";
import { SettingsCard, browserDocument, installStyle, installStyles } from "./settings-card.ts";
import type {
  CardProps,
  DocumentFace,
  FormSource,
  FormState,
  PathOp,
  Translate,
} from "./settings-card.ts";

/** 一行要展示的一项信息。label 是字典键而不是文案本身：可见文字统一走 locale 服务。 */
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
  "scrapling_render",
  "scrapling_capture_xhr",
  "scrapling_stealth_fetch",
  "scrapling_answer",
  "scrapling_session_open",
  "scrapling_session_fetch",
  "scrapling_session_list",
  "scrapling_session_close",
  "scrapling_crawl",
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

  if (tool === "scrapling_extract") {
    const selector = text(parameters["selector"]);
    return {
      tool,
      title: selector === "" ? tool : `${tool} ${selector}`,
      fields: [{ labelKey: "row.matched", value: text(projected["count"]) }],
    };
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
        { labelKey: "row.type", value: text(parameters["sessionType"]) },
        { labelKey: "row.session", value: text(projected["sessionId"]) },
      ],
    };
  }
  if (tool === "scrapling_session_close") {
    return {
      tool,
      title: tool,
      fields: [{ labelKey: "row.session", value: text(parameters["sessionId"]) }],
    };
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
const ARG_KEYS: readonly string[] = ["url", "selector", "sessionType", "sessionId", "maxPages"];

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
    const asValue = asText ?? args.value(key);
    if (asValue !== undefined) {
      values[key] = asValue;
    }
  }
  return values;
}

/** `tool.call.toolview` 这张 slot 交给本包的那几个 owner prop。 */
interface ToolViewProps {
  /** 线缆上的工具名，也就是本行的 keyed dispatch 值。 */
  readonly toolName: string;
  /** 当前阶段；结果侧的投影只在 result 阶段才有。 */
  readonly block: {
    readonly phase: "preparing" | "start" | "result";
    readonly args: ArgsFace;
    readonly meta?: unknown;
  };
  /** 有值时给一个「在轨迹里看这次调用」的入口。 */
  readonly inspect?: (() => void) | undefined;
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
`;

/**
 * 一行结果的渲染。
 *
 * 入参走 `block.args`，结果侧的投影走 `block.meta`；两者都按「可能还没到」处理 —— 调用刚发出
 * 时既没有 meta 也没有完整入参，这一行就只画标题。
 */
function RowView(props: ToolViewProps & { readonly t: Translate }): ReactNode {
  const { toolName, block, inspect, t } = props;
  const meta = block.phase === "result" ? block.meta : undefined;
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
              field.valueKey ?? field.value,
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
      options: { name: string; key?: string; locale?: string },
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
        (props: ToolViewProps) => createElement(RowView, { ...props, t }),
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
    // 宿主给 row/item 页准备的那一份 form，bundle 页没有，这里补上。值面在注册体之外造
    // 一次：卡片的 useSyncExternalStore 比的是 subscribe 的引用，每帧换一个新的就会每帧重建
    // 订阅，而重建那一拍可能漏掉一次宿主通知。宿主那份表单本身长活，所以这一份也长活。
    const source: FormSource = {
      getSnapshot: (): FormState => form.getSnapshot(),
      subscribe: (listener: () => void): (() => void) => form.subscribe(listener),
      mutate: (operations, revision) => form.mutate(operations, revision),
    };
    let disposeCard: (() => void) | undefined;
    ctx.slots.inject("plugins.bundle.config", () => {
      disposeCard = ctx.slots.register(
        { name: "plugins.bundle.config", key: BUNDLE_PACKAGE_NAME, locale: LOCALE_NS },
        (props: CardProps) => createElement(SettingsCard, { ...props, t, form: source }),
      );
    });
    return (): void => {
      disposeCard?.();
    };
  }, "dsh-scrapling: settings card");
}

export { apply, inject };
