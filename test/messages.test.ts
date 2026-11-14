// dsh-scrapling/test/messages.test.ts —— 双语文案表的契约。
//
// 键集一致**靠类型**：zh / en 两份都标注 `MessagesCatalog<ScraplingMessages>`，少键多键
// 在 tsc 阶段就红。本文件守的是类型管不到的四件事：
//   1. 值非空，且英文那份真不含汉字（漏翻在这里红，而不是在英文界面上露出一句中文）；
//   2. 每条模板的 `{占位符}` 在两语间同名同数 —— 翻译时漏掉一个插值，运行时只会渲染出
//      空白，没有任何报错；
//   3. `format()` 的替换语义（缺键退空串、字面花括号原样保留）；
//   4. 两语都保住了那些**必须原样**的协议记号与字面量（`§page_end§`、工具名、列表记号）。

import { describe, expect, it } from "vitest";
import { MESSAGES, format } from "../lib/messages.ts";

/**
 * 模板里的 `{占位符}` 名字集合。
 *
 * 只认 `\w+`：文案里成对的字面花括号（`{path, content}`、`{outputName: path}`）不是插值，
 * 把它们算成占位符会让「两语占位符一致」这条判据在正确实现上报红。
 *
 * @param template - 一条文案模板
 * @returns 占位符名字集合
 */
function placeholders(template: string): Set<string> {
  return new Set(Array.from(template.matchAll(/\{(?<key>\w+)\}/gu), (found) => found[1] ?? ""));
}

/**
 * 汉字与中文排版标点的痕迹。
 *
 * 范围刻意比 `[一-龥]` 宽：全角标点（「，」「。」「（」）与全角形式字符在英文译文里
 * 同样是漏翻，而窄字符类会静默放过它们。英文文案实际用到的排版字符是 U+2026（…）
 * 与 U+2014（—），都在这条类之外。
 */
const HAN = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/u;

/**
 * 协议占位符：页面正文里形如闭合标签的写法被 Python 侧换成的记号（`〔page-close〕`）。
 *
 * 它是两语共用的协议记号，不是文案：`〔〕`（U+3014/U+3015）本身属于 CJK 标点区，
 * 于是「英文不残留中文」这条判据会把正确的英文文案判红。判之前先把它剥掉，
 * 剥的时候按形状而不是按字面量——上游换一个占位符名字不该让这条门禁失效。
 */
const PLACEHOLDER_TOKEN = /〔[^〕]*〕/gu;

/** 两语表按「扁平 string 表」看：interface 没有隐式索引签名，只能过一次 unknown。 */
const ZH: Readonly<Record<string, string>> = MESSAGES.zh;
const EN: Readonly<Record<string, string>> = MESSAGES.en;

/** 键清单：两语同一类型，键集由 tsc 保证，这里只当运行时数据比对。 */
const KEYS = Object.keys(ZH);

describe("两语字典同源", () => {
  it("表不是空的（空表会让下面每一条断言都变成空转）", () => {
    expect(KEYS.length).toBeGreaterThan(200);
  });

  it("zh / en 键集一致", () => {
    expect(Object.keys(EN).toSorted()).toStrictEqual(KEYS.toSorted());
  });

  it("每条文案两语都非空", () => {
    for (const key of KEYS) {
      expect((ZH[key] ?? "").trim().length, `zh.${key} 为空`).toBeGreaterThan(0);
      expect((EN[key] ?? "").trim().length, `en.${key} 为空`).toBeGreaterThan(0);
    }
  });

  it("英文那份不残留汉字与全角标点", () => {
    // 全量遍历而不是抽查：抽查等于让其余条目无人看守，而漏翻的典型形态正是
    // 「从 zh 复制过来只改了半句」。
    for (const key of KEYS) {
      // 协议占位符 `〔page-close〕` 两语共用，先按形状剥掉再判（理由见常量注释）。
      const text = (EN[key] ?? "").replaceAll(PLACEHOLDER_TOKEN, "");
      expect(text, `en.${key} 残留中文`).not.toMatch(HAN);
    }
  });

  it("每条模板的 {占位符} 集合在两语间一致", () => {
    for (const key of KEYS) {
      expect(
        [...placeholders(EN[key] ?? "")].toSorted(),
        `${key} 占位符不一致：zh=${[...placeholders(ZH[key] ?? "")].join(",")} en=${[...placeholders(EN[key] ?? "")].join(",")}`,
      ).toStrictEqual([...placeholders(ZH[key] ?? "")].toSorted());
    }
  });
});

describe("format（host 侧 {name} 插值）", () => {
  it("按名字替换，重复占位符都填", () => {
    expect(format("{one}-{two}-{one}", { one: "1", two: "x" })).toBe("1-x-1");
  });

  it("缺键替成空串：文案不该因一个占位符打断工具调用", () => {
    expect(format("a{missing}b", { other: "x" })).toBe("ab");
  });

  it(String.raw`非 \w+ 的花括号片段原样保留（{path, content} 不是插值）`, () => {
    const shape = "输出评论建议格式：{path, content, start_line}。";
    expect(format(shape, { path: "被吃掉就说明规则错了" })).toBe(shape);
    expect(placeholders(shape).size).toBe(0);
  });

  it("没有占位符的文本原样返回", () => {
    expect(format("plain text", {})).toBe("plain text");
  });

  it("问答用户消息模板按 {url}{body}{question} 填", () => {
    const rendered = format(MESSAGES.zh.answerPagePrompt, {
      url: "https://a.test/",
      body: '{"k": 1}',
      question: "这是什么",
    });
    expect(rendered).toContain("https://a.test/");
    expect(rendered).toContain('{"k": 1}');
    expect(rendered).toContain("这是什么");
  });
});

describe("两语都保住了必须原样出现的协议记号与字面量", () => {
  it("页面外框分隔符在两语里逐字相同", () => {
    // 这两个记号是与 Python 侧、MCP 客户端之间的协议，不是文案：换语言不能改它们。
    for (const catalog of [ZH, EN]) {
      expect(catalog["answerPagePrompt"]).toContain("§page_end§");
      expect(catalog["answerPagePrompt"]).toContain("<page url=");
      // 上面那条「英文不残留中文」把 `〔page-close〕` 剥掉才判，这里补上它确实还在——
      // 否则哪天译者在英文里删掉这个占位符说明，剥离逻辑会让门禁静默放行。
      expect(catalog["answerSystemPrompt"]).toContain("〔page-close〕");
    }
  });

  it("工具名在两语里都点得到（指南段与回执都靠它对上真实工具）", () => {
    const tools = ["scrapling_fetch", "scrapling_extract", "scrapling_locate", "scrapling_links"];
    for (const tool of tools) {
      const mentioned = KEYS.filter((key) => (ZH[key] ?? "").includes(tool));
      expect(mentioned.length, `中文表里没有任何一条提到 ${tool}`).toBeGreaterThan(0);
      for (const key of mentioned) {
        expect(EN[key] ?? "", `en.${key} 里丢了工具名 ${tool}`).toContain(tool);
      }
    }
  });

  it("十五段指引两语都一条不少，且都以「- 」开头（渲染成 markdown 列表）", () => {
    const guidance = KEYS.filter((key) => key.startsWith("guidance"));
    expect(guidance).toHaveLength(15);
    for (const key of guidance) {
      expect(ZH[key]?.startsWith("- "), `zh.${key} 没以列表符号开头`).toBe(true);
      expect(EN[key]?.startsWith("- "), `en.${key} 没以列表符号开头`).toBe(true);
      // 一段指引必须是一行：`guidanceFor` 按条拼行，内部换行会把行数判据弄坏。
      expect(ZH[key] ?? "", `zh.${key} 内含换行`).not.toContain("\n");
      expect(EN[key] ?? "", `en.${key} 内含换行`).not.toContain("\n");
    }
  });
});
