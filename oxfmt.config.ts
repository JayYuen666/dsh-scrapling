export default {
  ignorePatterns: ["**/*.md", "**/*.jsonc"],
  // 与 .gitattributes 的 `* text=auto eol=lf` 是同一条不变量的两侧：这边显式写死，
  // 判定就只取决于仓库内配置，而不是第三方 schema 当下的默认值。
  endOfLine: "lf",
};
