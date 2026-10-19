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
 * 把正文按字节预算做头尾两段截断。
 *
 * 用字节而不是字符：`TextRetainer` 的预算本来就是字节，跟 sidecar 侧的
 * `maxContentChars`（字符）并存时，靠这个函数收口成模型最终真正看到的那一份。
 *
 * @param text - 完整正文
 * @param budgetBytes - 字节预算
 * @param recovery - 恢复建议；告诉模型怎么把被省略的内容再拿回来
 * @returns 截断后的正文与页脚
 */
export function capText(text: string, budgetBytes: number, recovery: string): CappedText {
  const size = Buffer.byteLength(text, "utf8");
  // Number.isFinite 一起判：NaN 与两个大小比较都返回 false，会一路穿到 TextRetainer 那里，
  // 拿到的 headBytes / tailBytes 全是 NaN，截断结果无从预测。
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0 || size <= budgetBytes) {
    return { text, truncated: false, notice: "" };
  }
  // 头 2/3、尾 1/3：抓取结果里结论通常在开头，表格尾行与免责声明在结尾。
  // 合计严格等于预算 —— 两段各取 max(1, …) 时，预算给到 1 或 2 字节反而会留下比预算
  // 更长的正文。代价是极小预算下头部可能被压到 0（预算 1 字节时全部留给尾部），
  // TextRetainer 对 0 的接受是经过验证的。
  const headBytes = Math.min(Math.max(1, Math.floor((budgetBytes * 2) / 3)), budgetBytes - 1);
  const tailBytes = budgetBytes - headBytes;
  const retainer = new TextRetainer({ kind: "headTail", headBytes, tailBytes });
  retainer.push(text);
  const kept = retainer.finish();
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
