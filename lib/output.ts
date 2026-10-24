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
