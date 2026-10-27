// 爬虫页面的输出投影。单独成文件，避免 lib/tools.ts 超过行数上限。

/** 把一个可能不是字符串的字段取成字符串，缺失时给空串。 */
function strField(page: Record<string, unknown>, field: string): string {
  const value = page[field];
  return typeof value === "string" ? value : "";
}

/**
 * 把一页爬取结果写成输出环上的一段文本。
 *
 * 逐字段判类型而不是直接 String(...)：回包是跨语言进程给的，String({}) 会变成
 * "[object Object]" 混进模型上下文。
 *
 * @param page - 一页
 * @returns 可追加的文本
 */
export function pageToText(page: Record<string, unknown>): string {
  const url = strField(page, "url");
  const title = strField(page, "title") || url;
  return `## ${title}\n${url}\n\n${strField(page, "markdown")}\n`;
}

/** 把一行结构化 feed 数据写成输出环上的一段文本。 */
export function rowToText(row: Record<string, unknown>): string {
  return `- ${JSON.stringify(row)}\n`;
}
