// dsh-scrapling/lib/output.ts —— 工具输出的封顶与呈现。
//
// 为什么单独一层：抓回来的页面可以很大，而工具结果会进会话日志、占模型上下文。
// 官方没有「每工具声明 retention」这回事（那个方案被显式否决了，`maxInlineTokens`
// 是部署级单旋钮），所以**每个工具自己带上限字段 + 用官方 retainer 实现**。
//
// 这里统一两件事：头尾两段截断（保头保尾，中间省略），以及用官方的
// `formatRetentionNotice` 生成「留了什么、丢了多少、怎么拿回来」。
//
// 截断切点必须落在安全位置：官方的 `TextRetainer` 处理了代理对，直接 `slice` 会在切点
// 留下孤立高代理 —— 那种文本进会话日志后会让后续 Messages 请求整体失败（dsh PR #4827）。
//
// 模型可见的句子一律从 `messages` 取：这一层也是模型可见面的一部分，硬编中文等于英文
// 部署里正文是英文、页脚却仍是中文。

import { formatRetentionNotice, TextRetainer } from "@deepseek-ai/dsh-output-retention";

import { format } from "./messages.ts";
import type { ScraplingMessages } from "./messages.ts";
import type {
  AnswerToolResult,
  BrowserResult,
  FetchResult,
  LinksResult,
  LocateResult,
  NetworkEntry,
  SelectResult,
} from "./tools.ts";

/**
 * 结果正文的尾巴：对端 notice 优先，其次截断提示；两者都没有就返回空串。
 *
 * 用 if 而不是嵌套三元：三元套三元在 lint 里是硬错误，而这里恰好是三个层级。
 *
 * @param notice - 对端给的人读说明
 * @param truncated - 结果是否被截断
 * @param hint - 截断提示，由调用方按语言给
 * @returns 追加到正文后的尾巴
 */
function tailOf(notice: string | undefined, truncated: boolean, hint: string): string {
  const said = notice !== undefined && notice.length > 0 ? [notice] : [];
  // 对端给了 notice 与「结果被截断」是**独立**的两件事：选择器自适应失败会写 notice，
  // 而 truncated 由条数/字节另算，两者能同时为真（`py/adapters.py` 里就是分开算的）。
  // 早返回会让模型只知道对端留了句话、不知道结果被截过。
  if (truncated && !said.some((line) => line.includes(hint))) {
    said.push(hint);
  }
  return said.join("\n\n");
}

/** 一次封顶的结果。 */
export interface CappedText {
  /** 保留下来的正文。 */
  readonly text: string;
  /** 是否发生了截断。 */
  readonly truncated: boolean;
  /** 页脚；没截断时为空串。 */
  readonly notice: string;
}

/**
 * 预算非法（非有限数或不足 1）时的兜底。
 *
 * 兜底而不是「不封顶」：本函数存在的理由就是别让超大正文整份进会话日志与模型上下文，
 * 预算坏了时静默放行等于把唯一的闸门拆掉。取值与设置卡上 fetch / extract / render 这
 * **三枚**「输出上限」的默认值同一档 —— 不是四枚：`xhrMaxOutputChars` 是 120_000，
 * 预算非法时被撑到这一档等于把它放宽。这一档由 test/settings-card.test.ts 的门禁核住
 * （改了这里而没改 schema 默认值，那条用例会点名两个数不一致）。
 */
export const FALLBACK_BUDGET_BYTES = 200_000;

/** 网络历史结构化数组的 JSON 字节总预算；模型入参不能放宽。 */
export const NETWORK_STRUCTURED_BUDGET_BYTES = 120_000;

/** 按 JSON 字节预算保留后的网络条目及分页信息。 */
export interface BoundedNetworkEntries {
  /** 按原顺序保留的条目。 */
  readonly matches: NetworkEntry[];
  /** 送入本函数的总条目数。 */
  readonly count: number;
  /** 实际保留的条目数。 */
  readonly returnedCount: number;
  /** 是否有条目因字节预算被省略。 */
  readonly truncated: boolean;
  /** 下一次 afterId 查询的跳过锚点；没有可前进的 id 时不出现。 */
  readonly nextAfterId?: number;
}

/** 取能交给 Python afterId 的正整数 id；缺失、非安全整数或非正数都不构成锚点。 */
function forwardNetworkId(entry: NetworkEntry): number | undefined {
  const { id } = entry;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * 按 JSON 数组的 UTF-8 字节数增量保留网络条目。
 *
 * 预算包含数组方括号与条目间逗号。遇到第一条放不下的条目就停止，不越过它保留后续
 * 条目。该条目有比前锚点更大的正整数 id 时，直接用它作跳过锚点，让下一页越过这条
 * 超大记录；否则省略锚点并保留截断标记，避免下一页在原条目上原地循环。全部条目都保
 * 留时，锚点只取最后一条的 id；最后一条没有 id 时不沿用更早的值。单条超预算时也不
 * 改造它，而是整条省略，避免交回一个已经超过预算的对象。
 *
 * @param matches - 已归一的网络条目
 * @param budget - JSON 数组字节预算；必须是至少 2 的有限数
 * @returns 保留条目、总条数、返回条数与分页锚点
 * @throws RangeError - 预算无法容纳一个空 JSON 数组
 */
export function boundNetworkEntries(
  matches: readonly NetworkEntry[],
  budget: number,
): BoundedNetworkEntries {
  if (!Number.isFinite(budget) || budget < 2) {
    throw new RangeError("network entry budget must be a finite number of at least 2 bytes");
  }
  const limit = Math.floor(budget);
  const bounded: NetworkEntry[] = [];
  let usedBytes = 2;
  let previousAnchor: number | undefined;
  let nextAfterId: number | undefined;
  for (const entry of matches) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    const separatorBytes = bounded.length === 0 ? 0 : 1;
    const id = forwardNetworkId(entry);
    if (usedBytes + separatorBytes + entryBytes > limit) {
      nextAfterId =
        id !== undefined && (previousAnchor === undefined || id > previousAnchor) ? id : undefined;
      break;
    }
    bounded.push(entry);
    usedBytes += separatorBytes + entryBytes;
    previousAnchor = id ?? previousAnchor;
    nextAfterId = id;
  }
  return {
    matches: bounded,
    count: matches.length,
    returnedCount: bounded.length,
    truncated: bounded.length < matches.length,
    ...(nextAfterId === undefined ? {} : { nextAfterId }),
  };
}

/**
 * 把调用方给的预算归一成「至少 1 的整数」；非法值回落到兜底。
 *
 * 本函数是导出名单，预算不是只能从 schema 来（`Schema.natural().min(1)` 只管从设置卡进来的值）：
 * 小数预算会让尾部字节数带小数一路传进 TextRetainer，(0,1) 的预算更会让头部字节数算出负数。
 *
 * @param budgetBytes - 调用方给的预算
 * @returns 可直接使用的字节预算
 */
function normalizeBudget(budgetBytes: number): number {
  if (!Number.isFinite(budgetBytes) || budgetBytes < 1) {
    return FALLBACK_BUDGET_BYTES;
  }
  return Math.floor(budgetBytes);
}

/**
 * 把正文按字节预算做头尾两段截断。
 *
 * 用字节而不是字符：`TextRetainer` 的预算本来就是字节，跟 sidecar 侧的
 * `maxContentChars`（字符）并存时，靠这个函数统一处理成模型最终真正看到的那一份。
 *
 * @param text - 完整正文
 * @param budgetBytes - 字节预算；非有限数或不足 1 时按兜底预算处理
 * @param recovery - 恢复建议；告诉模型怎么把被省略的内容再拿回来
 * @returns 截断后的正文与页脚
 */
export function capText(
  text: string,
  budgetBytes: number,
  recovery: string,
  scope: "body" | "network" = "body",
): CappedText {
  const budget = normalizeBudget(budgetBytes);
  const size = Buffer.byteLength(text, "utf8");
  if (size <= budget) {
    return { text, truncated: false, notice: "" };
  }
  // 头 2/3、尾 1/3：抓取结果里结论通常在开头，表格尾行与免责声明在结尾。
  // 合计严格等于预算 —— 两段各取 max(1, …) 时，预算给到 1 或 2 字节反而会留下比预算
  // 更长的正文。代价是极小预算下头部可能被压到 0（预算 1 字节时全部留给尾部），
  // TextRetainer 对 0 的接受是经过验证的。
  const headBytes = Math.min(Math.max(1, Math.floor((budget * 2) / 3)), budget - 1);
  const tailBytes = budget - headBytes;
  const retainer = new TextRetainer({ kind: "headTail", headBytes, tailBytes });
  retainer.push(text);
  const kept = retainer.finish();
  // 到不了：走到这里的前提是正文字节数超过预算，而 TextRetainer 与本函数同按字节计，
  // 超过 budget 的正文必然有字节被它丢掉。留着这一支是为了让「没截断就没有页脚」由
  // 构造保证，而不是依赖对 TextRetainer 记录方式的推断。
  /* v8 ignore next 3 */
  if (!kept.truncated) {
    return { text: kept.text, truncated: false, notice: "" };
  }
  const notice = formatRetentionNotice(
    {
      scope,
      strategy: "headTail",
      unit: "bytes",
      limit: { head: headBytes, tail: tailBytes },
      kept: Buffer.byteLength(kept.text, "utf8"),
      omitted: kept.omittedBytes,
    },
    () => recovery,
  );
  return { text: kept.text, truncated: kept.truncated, notice };
}

/**
 * 渲染 locate 结果。
 *
 * @param value - locate 结果
 * @param messages - 当前语言的文案
 * @returns 模型侧文本
 */
function renderLocate(value: LocateResult, messages: ScraplingMessages): string {
  const body =
    value.matches.length === 0
      ? messages.outputNoMatches
      : value.matches
          .map((item) => {
            const lines = [
              `<${item.tag}> ${item.text}`,
              `  css: ${item.cssSelector}`,
              `  xpath: ${item.xpathSelector}`,
            ];
            // 开关打开时 sidecar 才带这些字段；空对象/空数组就是「没有」，不额外打一行空壳。
            if (Object.keys(item.attributes).length > 0) {
              lines.push(`  attributes: ${JSON.stringify(item.attributes)}`);
            }
            if (item.fullCssSelector.length > 0 && item.fullCssSelector !== item.cssSelector) {
              lines.push(`  full css: ${item.fullCssSelector}`);
            }
            if (
              item.fullXpathSelector.length > 0 &&
              item.fullXpathSelector !== item.xpathSelector
            ) {
              lines.push(`  full xpath: ${item.fullXpathSelector}`);
            }
            if (item.ancestors.length > 0) {
              const chain = item.ancestors
                .map((ancestor) => {
                  const attrs =
                    Object.keys(ancestor.attributes).length > 0
                      ? ` ${JSON.stringify(ancestor.attributes)}`
                      : "";
                  return `<${ancestor.tag}>${attrs}`;
                })
                .join(" < ");
              lines.push(`  ancestors: ${chain}`);
            }
            return lines.join("\n");
          })
          .join("\n");
  const tail = tailOf(value.notice, value.truncated, messages.selectTruncationHint);
  return tail.length > 0 ? `${body}\n\n${tail}` : body;
}

/**
 * 渲染 links 结果。
 *
 * @param value - links 结果
 * @param messages - 当前语言的文案
 * @returns 模型侧文本
 */
function renderLinks(value: LinksResult, messages: ScraplingMessages): string {
  const lines = value.links.map((item) => item.url);
  for (const candidate of value.nextCandidates) {
    lines.push(`next: ${candidate.text} -> ${candidate.url} (${candidate.reason})`);
  }
  const body = lines.length === 0 ? messages.outputNoLinks : lines.join("\n");
  // links 的截断只来自 `limit`：它没有 maxContentChars 这个参数，照搬选择器那条文案会让
  // 模型去调一个不存在的键。
  return value.truncated ? `${body}\n\n${messages.linksTruncationHint}` : body;
}

/**
 * 把抓取结果渲染成模型看的文本。
 *
 * 收强类型而不是 `unknown`：output.schema 用的是 value-schema DSL，必填字段由 schema
 * 声明，defineTool 推出来的 value 每个字段都保证存在。写「万一字段缺失」那层兜底只会
 * 造出永远走不到的死分支。
 *
 * @param value - 投影出的结果值
 * @param messages - 当前语言的文案
 * @returns 模型侧文本
 */
function renderFetch(value: FetchResult, messages: ScraplingMessages): string {
  const head = format(messages.outputFetchHead, {
    url: value.url,
    status: String(value.statusCode),
  });
  const body = `${head}\n\n${value.content}`;
  const metadata =
    value.metadata === undefined || Object.keys(value.metadata).length === 0
      ? ""
      : `\n\n${messages.outputMetadataHeading}:\n${Object.entries(value.metadata)
          .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
          .join("\n")}`;
  const withMetadata = `${body}${metadata}`;
  // 对端的 `maxContentChars` 截断只体现在 `truncated` 这一位上（`toFetchResult` 交回的 notice
  // 恒为空串），本地预算没再截时 notice 也是空串——只读 notice 就等于把这一份正文报成完整。
  const tail = tailOf(value.notice, value.truncated, messages.contentTruncationHint);
  return tail.length > 0 ? `${withMetadata}\n\n${tail}` : withMetadata;
}

/**
 * 把选择结果渲染成模型看的文本。
 *
 * 收强类型：`output.schema` 用 value-schema DSL 声明了必填字段，defineTool 推出来的
 * `value` 保证每项都在；写「万一不是数组」的兜底只会造出永远走不到的死分支。
 *
 * @param value - 投影出的结果值
 * @param messages - 当前语言的文案
 * @returns 模型侧文本
 */
function renderMatches(value: SelectResult, messages: ScraplingMessages): string {
  let body: string;
  if (value.rows) {
    body =
      value.rows.length === 0
        ? messages.outputNoRows
        : value.rows.map((row) => JSON.stringify(row)).join("\n");
  } else if (value.matches.length === 0) {
    body = messages.outputNoMatches;
  } else {
    body = value.matches
      .map((item) => {
        const picked = item.value ?? item.text ?? "";
        // 与非空判定对齐（`renderLocate` 用的也是键数）：Python 侧在 includeAttributes
        // 为真时无条件带上 attributes，空对象是可达的，真值判定会渲染出一行 ` {}`。
        const attrs =
          item.attributes !== undefined && Object.keys(item.attributes).length > 0
            ? ` ${JSON.stringify(item.attributes)}`
            : "";
        // includeHtml 且没给 attribute 时 Python 会单独写一份 outerHTML。不渲染它，
        // includeHtml 在模型侧就是个空操作 —— schema 声明了却永远看不到。
        const html = item.html === undefined ? "" : `\n  html: ${item.html}`;
        return `<${item.tag}> ${picked}${attrs}${html}`;
      })
      .join("\n");
  }
  const tail = tailOf(value.notice, value.truncated, messages.selectTruncationHint);
  return tail.length > 0 ? `${body}\n\n${tail}` : body;
}

/**
 * 网络历史条目 → 模型可读的若干行。
 *
 * 正文只在条目真的带了 body 时展开；`bodyNote` 说明上游为什么没存下正文。
 *
 * @param matches - 归一后的条目
 * @returns 行文本
 */
function networkLines(matches: readonly NetworkEntry[]): string[] {
  return matches.flatMap((item) => {
    const kind = item.resourceType.length > 0 ? `, ${item.resourceType}` : "";
    // id 只在 sidecar 带了的时候出现：它是 requestId / afterId 的锚点，不渲染出来
    // 那两个参数对模型就是「拧了没反应」。headers 只在 includeHeaders 时才有。
    const label = item.id === undefined ? "" : `[id ${item.id}] `;
    const head = `- ${label}${item.method} ${item.url} (HTTP ${item.status}, ${item.bytes}B${kind})`;
    const headers =
      item.headers === undefined ? "" : `\n  headers: ${JSON.stringify(item.headers)}`;
    if (typeof item.bodyNote === "string") {
      return [`${head} — no body: ${item.bodyNote}${headers}`];
    }
    if (typeof item.body !== "string") {
      return [`${head}${headers}`];
    }
    const bodyLabel = item.bodyTruncated === true ? "body (truncated)" : "body";
    return [`${head} — ${bodyLabel}:\n${item.body}${headers}`];
  });
}

/**
 * 把浏览器抓取结果渲染成模型看的文本，末尾附上网络历史。
 *
 * 结构化网络数组已由 `boundNetworkEntries` 在执行阶段按固定预算裁剪；这里只约束模型
 * 可见的文本段。正文已按 `maxOutputBytes` 截过，而条目数与每条正文的上限都在对端
 * （`limit` / `body_chars`），叠起来的字节数与那份预算无关。不封这一段，工具回执
 * 就能整段绕过输出上限，且没有任何说明。
 *
 * **两段各自按同一档预算封顶**，所以单次回执的字节上限是两倍预算，不是一倍。这是刻意的：
 * 网络历史是**另一份**信息（正文里一条都不含），用「剩余预算」封它会在正文本身就用满
 * 预算时把它压成零 —— 而那恰好是最需要看网络请求的时刻。这一条也写在两份 README 的
 * 输出封顶一节里，改这里要同步改文档。
 *
 * @param value - 浏览器抓取载荷
 * @param networkBudgetBytes - 网络历史那一段的字节预算（与正文同一档）
 * @param messages - 当前语言的文案
 * @returns 模型侧文本
 */
function renderBrowser(
  value: BrowserResult,
  networkBudgetBytes: number,
  messages: ScraplingMessages,
): string {
  const body = renderFetch(
    { ...value, truncated: value.contentTruncated ?? value.truncated },
    messages,
  );
  const captured = value.xhr;
  if (captured === undefined) {
    return body;
  }
  if (captured.length === 0) {
    const empty = `${body}\n\n${messages.outputXhrNone}`;
    return value.xhrTruncated === true
      ? `${empty}\n\n${messages.captureNetworkTruncationHint}`
      : empty;
  }
  const section = capText(
    networkLines(captured).join("\n"),
    networkBudgetBytes,
    messages.captureNetworkTruncationHint,
    "network",
  );
  let networkNotice = section.notice;
  if (networkNotice.length === 0 && value.xhrTruncated === true) {
    networkNotice = messages.captureNetworkTruncationHint;
  }
  const footer = networkNotice.length > 0 ? `\n\n${networkNotice}` : "";
  return `${body}\n\n${messages.outputXhrHeading}:\n${section.text}${footer}`;
}

/**
 * 把问答结果渲染成模型看的文本。
 *
 * @param value - 问答结果
 * @param messages - 当前语言的文案
 * @returns 模型侧文本
 */
function renderAnswer(value: AnswerToolResult, messages: ScraplingMessages): string {
  const head = format(messages.outputAnswerHead, {
    url: value.url,
    status: String(value.statusCode),
    provider: value.provider,
    model: value.model,
  });
  const tail = tailOf(value.notice, value.truncated, messages.contentTruncationHint);
  return `${head}\n\n${value.answer}${tail.length > 0 ? `\n\n${tail}` : ""}`;
}

export {
  networkLines,
  renderAnswer,
  renderBrowser,
  renderFetch,
  renderLinks,
  renderLocate,
  renderMatches,
};
