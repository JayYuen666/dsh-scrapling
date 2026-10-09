// dsh-scrapling/src/client-entry.ts —— Client 半：十个工具的专用结果行 + 设置卡。
//
// 内置 Web Client 不消费我们 `presentCall`/`presentResult` 里那套 `web` 卡片，抓取类工具的
// 结果得自己画一行；设置卡则坐在 `plugins.bundle.config` 这张 slot 上，宿主因此把本包的
// 配置画在插件详情页里。**这张卡不会自动出现**：设置命名空间由 cordis.patch.yml 的 `id`
// 决定，宿主那边一直在投影它，但没有任何页面去渲染它 —— 投影出来的是「有哪些键」，不是
// 「怎么编辑」。卡片本体在 settings-card.ts，字段表在 settings-fields.ts。
//
// 只用具名导出：构建脚本把产物包进 window.__ModuleLoader__.load({ id, factory })，
// 同时给具名与 default 会触发 rolldown 的 MIXED_EXPORTS 警告。

import type { Context } from "@deepseek-ai/cordis";
import { createElement } from "react";
import type { ReactNode } from "react";
import { claimApply } from "@jayyuen66/dsh-plugin-shared/lib/card-apply";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { BUNDLE_PACKAGE_NAME } from "./settings-fields.ts";
import { SettingsCard } from "./settings-card.ts";
import type { CardProps } from "./settings-card.ts";

/** 一行要展示的一项信息。 */
export interface RowField {
  /** 字段名（展示用，不参与计算）。 */
  readonly label: string;
  /** 字段值。 */
  readonly value: string;
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
 * 七个「面向用户」的工具各一行；会话的四个工具共用一组 key，但分散的 key 更省心 ——
 * slot 按 key 派发，漏掉一个只是那一个不画行，不会连累别的。
 */
export const ROW_TOOLS: readonly string[] = [
  "scrapling_fetch",
  "scrapling_extract",
  "scrapling_render",
  "scrapling_capture_xhr",
  "scrapling_stealth_fetch",
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
      fields: [{ label: "匹配", value: text(projected["count"]) }],
    };
  }
  if (tool === "scrapling_session_list") {
    return { tool, title: tool, fields: [{ label: "会话数", value: text(projected["count"]) }] };
  }
  if (tool === "scrapling_session_open") {
    return {
      tool,
      title: tool,
      fields: [
        { label: "类型", value: text(parameters["sessionType"]) },
        { label: "会话", value: text(projected["sessionId"]) },
      ],
    };
  }
  if (tool === "scrapling_session_close") {
    return { tool, title: tool, fields: [{ label: "会话", value: text(parameters["sessionId"]) }] };
  }
  if (tool === "scrapling_crawl") {
    return {
      tool,
      title: tool,
      fields: [
        { label: "起始", value: url },
        { label: "上限", value: text(parameters["maxPages"]) },
        { label: "作业", value: text(projected["jobId"]) },
      ],
    };
  }

  // 抓取类：URL / HTTP / 是否截断。只展示拿得到的。
  const fields: RowField[] = [];
  if (url !== "") {
    fields.push({ label: "URL", value: url });
  }
  const status = projected["statusCode"];
  if (typeof status === "number") {
    fields.push({ label: "HTTP", value: String(status) });
  }
  if (projected["truncated"] === true) {
    fields.push({ label: "正文", value: "已截断" });
  }
  return { tool, title: tool, fields };
}

/** 一行结果的渲染。 */
function RowView(props: { readonly tool: string }): ReactNode {
  return createElement(
    "div",
    { className: "dsh-scrapling-row", "data-tool": props.tool },
    props.tool,
  );
}

/** 本 Client 半注入的服务。 */
const inject = ["slots"];

/**
 * Client 侧只声明用到的两个成员。
 *
 * 不直接用官方的 Context：客户端 ctx 的完整类型带几十个服务，而本包只需要 slots 与
 * effect（后者是 claimApply 的入参要求）。声明窄接口，注入清单就只需 slots ——
 * 注入未就绪的 key 会让整个模块静默不加载，写多了反而危险。
 */
interface SlotsOnly {
  readonly slots: {
    inject: (slot: string, register: () => void) => void;
    register: (
      options: { name: string; key: string },
      render: (props: CardProps) => unknown,
    ) => () => void;
  };
  readonly effect: Context["effect"];
}

/**
 * Client 插件入口：给每个工具注册一行结果视图，并把设置卡挂上插件详情页。
 *
 * @param ctx - 客户端上下文
 */
function apply(ctx: SlotsOnly): void {
  // HMR 重载时全局标记仍在，直接返回，避免重复注册。
  if (!claimApply(ctx, "__dshScraplingToolviewApplied", "dsh-scrapling toolview")) {
    return;
  }
  for (const tool of ROW_TOOLS) {
    ctx.slots.inject("tool.call.toolview", () => {
      ctx.slots.register({ name: "tool.call.toolview", key: tool }, () =>
        createElement(RowView, { tool }),
      );
    });
  }
  // 设置卡不需要 configForms：宿主把值面与写入函数作为渲染入参直接交过来，插件不该
  // 自己去抓命名空间 —— 抓了就等于在客户端重建一份设置状态，两边迟早不一致。
  ctx.slots.inject("plugins.bundle.config", () => {
    ctx.slots.register(
      { name: "plugins.bundle.config", key: BUNDLE_PACKAGE_NAME },
      (props: CardProps) => createElement(SettingsCard, props),
    );
  });
}

export { apply, inject };
