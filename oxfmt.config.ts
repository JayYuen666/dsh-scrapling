import type { OxfmtConfig } from "oxfmt";

export default {
  // bin/ 是 build-cli.ts 的压缩单文件产物，与 host.js/client.js 同类，不参与源码格式检查。
  // **.md**：Markdown 由文档工具链负责（表格对齐、换行语义），oxfmt 重排会让 diff 变成一堵墙。
  // **.jsonc**：本仓**当前没有任何 jsonc 资产**，这一条是给将来留的口子 —— 带注释的 JSON 若被
  // oxfmt 按严格 JSON 处理会直接抹掉注释。理由写在这里，免得读者以为仓内已有 jsonc 资产。
  ignorePatterns: ["**/*.md", "**/*.jsonc", "bin/**"],
  // 与 .gitattributes 的 `* text=auto eol=lf` 是同一条不变量的两侧：这边显式写死，
  // 判定就只取决于仓库内配置，而不是第三方 schema 当下的默认值。
  endOfLine: "lf",
} satisfies OxfmtConfig;
