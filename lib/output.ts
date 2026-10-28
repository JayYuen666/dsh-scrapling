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

import { formatRetentionNotice, TextRetainer } from "@deepseek-ai/dsh-output-retention";

import type {
  AnswerToolResult,
  BrowserResult,
  FetchResult,
  LinksResult,
  LocateResult,
  NetworkEntry,
  SelectResult,
} from "./tools.ts";

/** 被截断时告诉模型怎么把内容再拿回来。 */
const SELECT_TRUNCATION_HINT = "结果被截断：请减小 limit，或提高 maxContentChars 后再取。";

/**
 * 结果正文的尾巴：对端 notice 优先，其次截断提示；两者都没有就返回空串。
 *
 * 用 if 而不是嵌套三元：三元套三元在 lint 里是硬错误，而这里恰好是三个层级。
 *
 * @param notice - 对端给的人读说明
 * @param truncated - 结果是否被截断
 * @returns 追加到正文后的尾巴
 */
function tailOf(notice: string | undefined, truncated: boolean): string {
  if (notice !== undefined && notice.length > 0) {
    return notice;
  }
  return truncated ? SELECT_TRUNCATION_HINT : "";
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
 * 与设置卡上各「输出上限」字段的默认值同一档。兜底而不是「不封顶」：本函数存在的理由就是
 * 别让超大正文整份进会话日志与模型上下文，预算坏了时静默放行等于把唯一的闸门拆掉。
 */
const FALLBACK_BUDGET_BYTES = 200_000;

/**
 * 把调用方给的预算归一成「至少 1 的整数」；非法值回落到兜底。
 *
 * 本函数是导出面，预算不是只能从 schema 来（`Schema.natural().min(1)` 只管设置卡那一侧）：
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
 * `maxContentChars`（字符）并存时，靠这个函数收口成模型最终真正看到的那一份。
 *
 * @param text - 完整正文
 * @param budgetBytes - 字节预算；非有限数或不足 1 时按兜底预算处理
 * @param recovery - 恢复建议；告诉模型怎么把被省略的内容再拿回来
 * @returns 截断后的正文与页脚
 */
export function capText(text: string, budgetBytes: number, recovery: string): CappedText {
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
  // 构造保证，而不是依赖对 TextRetainer 记账方式的推断。
  /* v8 ignore next 3 */
  if (!kept.truncated) {
    return { text: kept.text, truncated: false, notice: "" };
  }
  const notice = formatRetentionNotice(
    {
      scope: "body",
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
 * @returns 模型侧文本
 */
function renderLocate(value: LocateResult): string {
  const body =
    value.matches.length === 0
      ? "no matches"
      : value.matches
          .map((item) => {
            const lines = [
              `<${item.tag}> ${item.text}`,
              `  css: ${item.cssSelector}`,
              `  xpath: ${item.xpathSelector}`,
            ];
            // 开关打开时 sidecar 才带这些面；空对象/空数组就是「没有」，不额外打一行空壳。
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
  const tail = tailOf(value.notice, value.truncated);
  return tail.length > 0 ? `${body}\n\n${tail}` : body;
}

/**
 * 渲染 links 结果。
 *
 * @param value - links 结果
 * @returns 模型侧文本
 */
function renderLinks(value: LinksResult): string {
  const lines = value.links.map((item) => item.url);
  for (const candidate of value.nextCandidates) {
    lines.push(`next: ${candidate.text} -> ${candidate.url} (${candidate.reason})`);
  }
  const body = lines.length === 0 ? "no links" : lines.join("\n");
  return value.truncated ? `${body}\n\n${SELECT_TRUNCATION_HINT}` : body;
}

/**
 * 把抓取结果渲染成模型看的文本。
 *
 * 收强类型而不是 `unknown`：output.schema 用的是 value-schema DSL，必填字段由 schema
 * 声明，defineTool 推出来的 value 每个字段都保证存在。写「万一字段缺失」那层兜底只会
 * 造出永远走不到的死分支。
 *
 * @param value - 投影出的结果值
 * @returns 模型侧文本
 */
function renderFetch(value: FetchResult): string {
  const body = `Fetched ${value.url} (HTTP ${value.statusCode})\n\n${value.content}`;
  const metadata =
    value.metadata === undefined || Object.keys(value.metadata).length === 0
      ? ""
      : `\n\nMetadata:\n${Object.entries(value.metadata)
          .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
          .join("\n")}`;
  const withMetadata = `${body}${metadata}`;
  return value.notice.length > 0 ? `${withMetadata}\n\n${value.notice}` : withMetadata;
}

/**
 * 把选择结果渲染成模型看的文本。
 *
 * 收强类型：`output.schema` 用 value-schema DSL 声明了必填字段，defineTool 推出来的
 * `value` 保证每项都在；写「万一不是数组」的兜底只会造出永远走不到的死分支。
 *
 * @param value - 投影出的结果值
 * @returns 模型侧文本
 */
function renderMatches(value: SelectResult): string {
  let body: string;
  if (value.rows) {
    body =
      value.rows.length === 0 ? "no rows" : value.rows.map((row) => JSON.stringify(row)).join("\n");
  } else if (value.matches.length === 0) {
    body = "no matches";
  } else {
    body = value.matches
      .map((item) => {
        const picked = item.value ?? item.text ?? "";
        const attrs = item.attributes ? ` ${JSON.stringify(item.attributes)}` : "";
        // includeHtml 且没给 attribute 时 Python 会单独写一份 outerHTML。不渲染它，
        // includeHtml 在模型侧就是个空操作 —— schema 声明了却永远看不到。
        const html = item.html === undefined ? "" : `\n  html: ${item.html}`;
        return `<${item.tag}> ${picked}${attrs}${html}`;
      })
      .join("\n");
  }
  const tail = tailOf(value.notice, value.truncated);
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
 * @param value - 浏览器抓取载荷
 * @returns 模型侧文本
 */
function renderBrowser(value: BrowserResult | FetchResult): string {
  const body = renderFetch(value);
  // 不带网络历史的工具（render）其 schema 里没有这个字段，execute 也就不会产出它；
  // capture 那一路上它一定是数组。这里只能断言一次：联合类型里 FetchResult 没有
  // 这个键，但两个调用点传进来的对象都出自 createBrowserTool 的 execute。
  const captured = (value as Partial<BrowserResult>).xhr;
  if (captured === undefined) {
    return body;
  }
  if (captured.length === 0) {
    return (
      `${body}\n\nCaptured no XHR/fetch requests. ` +
      "The page may issue none, or they may have fired after this capture — " +
      "try scrapling_render with waitMs / waitSelector first, then capture again."
    );
  }
  return `${body}\n\nCaptured XHR/fetch:\n${networkLines(captured).join("\n")}`;
}

/**
 * 把问答结果渲染成模型看的文本。
 *
 * @param value - 问答结果
 * @returns 模型侧文本
 */
function renderAnswer(value: AnswerToolResult): string {
  const head = `Answer to "${value.url}" (HTTP ${value.statusCode}, via ${value.provider}/${value.model}):`;
  const tail = value.notice.length > 0 ? `\n\n${value.notice}` : "";
  return `${head}\n\n${value.answer}${tail}`;
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
