// test/readme-parity.test.ts —— 中英文两份 README 的对等门禁。
//
// 为什么值得一条测试：两份文档是手工维护的，改一侧忘另一侧**不会让任何东西变红**——
// 构建照过、单测照过、覆盖率照满，而读者只会读到其中一份，中文读者就此少知道一件事。
// 漂移的形态就那几种：某个旋钮只在一侧出现、某段语义只在一侧解释、乃至一侧把事实写错
// （写错的那一侧没人看得出来，因为它是唯一有那段话的地方）。
//
// 官方包用逐节的哈希记录（`README.i18n.yaml`）配 `verify-translation-pairing` 把这件事交给
// CI；本包不在那个 monorepo 里，那套脚本用不上，于是把不变式直接写成断言。
//
// 钉的是两件事：**对称**（一侧写了，另一侧也得有）与**可发现**（设置卡上的每一枚旋钮在
// 两份里都找得到）。只钉工具名是不够的——漂移恰恰发生在「两边都提到了同一个工具，
// 但某一侧的读者找不到某个旋钮」这种地方。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_SPECS } from "../host.ts";

const pkgDir = path.join(import.meta.dirname, "..");
const EN = "README.md";
const ZH = "README.zh-CN.md";
const NOTICES = "THIRD_PARTY_NOTICES.md";
const HOST = "host.ts";

/**
 * 读一对文档。
 *
 * @returns 英文与中文正文
 */
async function readPair(): Promise<{ en: string; zh: string }> {
  // 逐个 await 而不是 Promise.all 后解构：解构的结果在 noUncheckedIndexedAccess 下是
  // `string | undefined`，补一个 ?? 兜底等于给「文件没读到」编一个空文档的谎。
  const en = await readFile(path.join(pkgDir, EN), "utf8");
  const zh = await readFile(path.join(pkgDir, ZH), "utf8");
  return { en, zh };
}

/**
 * 从 `Config` 接口里取配置键，标出哪些会投影到设置卡。
 *
 * 接口本身在运行期不存在（schemastery 的 `Config` 是同名的另一个值，键不可枚举），所以这里
 * 读源码。取「声明成 `Volatile<…>`」这一档，是因为它正是用户能在设置卡上改的那批——用户
 * 看得见，就期望文档里找得到。
 *
 * @param source - host.ts 全文
 * @returns 全部配置键，以及其中的设置卡可见键
 */
function configKeys(source: string): { all: readonly string[]; volatile: readonly string[] } {
  const body = /export interface Config \{(?<body>[\s\S]*?)\n\}/u.exec(source)?.groups?.["body"];
  if (body === undefined) {
    throw new Error(`${HOST} 里找不到 Config 接口`);
  }
  const entries = [...body.matchAll(/^ {2}(?<key>[A-Za-z][A-Za-z0-9]*): (?<decl>.*)$/gmu)].map(
    (found) => [found.groups?.["key"] ?? "", found.groups?.["decl"] ?? ""] as const,
  );
  return {
    all: entries.map(([key]) => key),
    volatile: entries.filter(([, decl]) => decl.includes("Volatile<")).map(([key]) => key),
  };
}

/**
 * 判断一枚配置键能否在这份文档里被读者找到。
 *
 * 文档用 `*MaxOutputChars` 这样的通写法覆盖一族旋钮，逐个键逐个字面去匹配会把这条写法的
 * 文档判成「缺五项」。因此字面出现算找到；否则看有没有一条 `*` 前缀的族写法正好以该键收尾
 * ——`fetchMaxOutputChars` 由 `*MaxOutputChars` 覆盖，正是这一条要认的。
 *
 * @param key - 配置键
 * @param text - 文档正文
 * @returns 读者能否定位到这一项
 */
function discoverable(key: string, text: string): boolean {
  if (text.includes(key)) {
    return true;
  }
  const families = [...text.matchAll(/`\*(?<suffix>[A-Za-z][A-Za-z0-9]*)`/gu)].map(
    (found) => found.groups?.["suffix"] ?? "",
  );
  return families.some((suffix) => suffix !== "" && key.endsWith(suffix));
}

/** 文档里的二级章节数。译名不同但结构必须一致，所以只数不比对文本。 */
function sectionCount(text: string): number {
  return text.split("\n").filter((line) => line.startsWith("## ")).length;
}

/** 设置卡表在正文里的起点：卡表紧跟在设置节的引言句后面。 */
const CARD_TABLE_START = {
  en: "Settings live on the **scrapling** card",
  zh: "设置在插件详情页的 **scrapling** 卡上",
} as const;

/** 部署表的起点：这句标记之后只该出现部署级键。 */
const DEPLOY_TABLE_START = {
  en: "**Deployment-only knobs**",
  zh: "**部署级旋钮**",
} as const;

/**
 * 切出一份 README 里「设置卡表」与「部署表」两段的表格行。
 *
 * 只按 `| \`` 开头的行取行，是为了不让标题与说明句混进来；两份 README 里还有别的表
 * （工具表、逐项能力表），所以起点用设置节自己的两句话定位，而不是从文件头往后数。
 *
 * @param text - 一份 README 正文
 * @param cardStart - 设置卡表的定位句
 * @param deployStart - 部署表的定位句
 * @returns 两段表格行（不含表头与分隔行）
 */
function settingsTableRows(
  text: string,
  cardStart: string,
  deployStart: string,
): { card: readonly string[]; deploy: readonly string[] } {
  const cardBegin = text.indexOf(cardStart);
  const deployBegin = text.indexOf(deployStart);
  if (cardBegin === -1 || deployBegin === -1 || deployBegin <= cardBegin) {
    throw new Error("README 结构变了：找不到设置卡表或部署表的起始标记");
  }
  const heading = text.indexOf("\n## ", deployBegin);
  const rowsIn = (from: number, to: number | undefined): readonly string[] =>
    text
      .slice(from, to)
      .split("\n")
      .filter((line) => line.startsWith("| `"));
  return {
    card: rowsIn(cardBegin, deployBegin),
    deploy: rowsIn(deployBegin, heading === -1 ? undefined : heading),
  };
}

/** 取表格行首列里的反引号 token —— 一行常写成 `a` / `b` 多枚键。 */
function rowTokens(rows: readonly string[]): readonly string[] {
  return rows.flatMap((row) => {
    const first = row.split("|")[1] ?? "";
    return [...first.matchAll(/`(?<token>[^`]+)`/gu)].map((found) => found.groups?.["token"] ?? "");
  });
}

/**
 * 把 `*MaxOutputChars` 这类族写法展开成实际配置键。
 *
 * @param tokens - 行首列里的 token
 * @param all - `Config` 接口里的全部配置键
 * @returns 展开后的键；未知 token 原样保留，好让断言把它当多出来的项报出来
 */
function expandFamilies(tokens: readonly string[], all: readonly string[]): readonly string[] {
  return tokens.flatMap((token) =>
    token.startsWith("*") ? all.filter((key) => key.endsWith(token.slice(1))) : [token],
  );
}

describe("中英文文档对等", () => {
  it("两份 README 互相链接", async () => {
    const { en, zh } = await readPair();
    expect(en, `英文侧没有指向 ${ZH} 的入口`).toContain(ZH);
    expect(zh, `中文侧没有指向 ${EN} 的入口`).toContain(EN);
  });

  it("每个工具名在两份里都出现", async () => {
    const { en, zh } = await readPair();
    const names = TOOL_SPECS.map((spec) => spec.name);
    expect(names.length, "工具登记表不该是空的").toBeGreaterThan(0);
    for (const name of names) {
      expect(en, `${EN} 没有提到工具 ${name}`).toContain(name);
      expect(zh, `${ZH} 没有提到工具 ${name}`).toContain(name);
    }
  });

  it("配置键在两份里对称出现", async () => {
    const { en, zh } = await readPair();
    const { all } = configKeys(await readFile(path.join(pkgDir, HOST), "utf8"));
    expect(all.length, "配置键不该是空的").toBeGreaterThan(0);
    // 只在英文侧出现的：中文读者按文档找不到这一项。
    expect(
      all.filter((key) => en.includes(key) && !zh.includes(key)),
      `${ZH} 落后于 ${EN}`,
    ).toStrictEqual([]);
    // 只在中文侧出现的：反过来，英文读者缺一份。
    expect(
      all.filter((key) => zh.includes(key) && !en.includes(key)),
      `${EN} 落后于 ${ZH}`,
    ).toStrictEqual([]);
  });

  it("设置卡上的每一枚旋钮在两份里都能找到", async () => {
    const { en, zh } = await readPair();
    const { volatile } = configKeys(await readFile(path.join(pkgDir, HOST), "utf8"));
    expect(volatile.length, "设置卡旋钮不该是空的").toBeGreaterThan(0);
    expect(
      volatile.filter((key) => !discoverable(key, en)),
      `${EN} 里找不到这些设置卡旋钮`,
    ).toStrictEqual([]);
    expect(
      volatile.filter((key) => !discoverable(key, zh)),
      `${ZH} 里找不到这些设置卡旋钮`,
    ).toStrictEqual([]);
  });

  it("新工具的边界在两份里都写清楚", async () => {
    const { en, zh } = await readPair();
    for (const [label, text] of [
      [EN, en],
      [ZH, zh],
    ] as const) {
      expect(text, `${label} 没写清 baseUrl 为空时的行为`).toContain("baseUrl");
    }
    expect(en).toContain("best-effort");
    expect(zh).toContain("尽力而为");
  });

  it("发布范围写明 macOS arm64、安装器与 blocked 项", async () => {
    const { en, zh } = await readPair();
    for (const [label, text] of [
      [EN, en],
      [ZH, zh],
    ] as const) {
      expect(text, `${label} 没写 macOS arm64`).toContain("macOS arm64");
      expect(text, `${label} 没写 blocked 项`).toContain("blocked");
      expect(text, `${label} 没写 integrationMode`).toContain("integrationMode");
      expect(text, `${label} 没写 CLI 安装器`).toContain("dsh-scrapling setup");
      expect(text, `${label} 不该声称四平台可用`).not.toMatch(/four platforms|四平台可用/u);
      expect(text, `${label} 不该声称三家 API 全通`).not.toMatch(/three APIs|三家 API 全通/u);
    }
  });

  it("二级章节数一致", async () => {
    const { en, zh } = await readPair();
    expect(sectionCount(zh), `${ZH} 的章节数与 ${EN} 不一致`).toBe(sectionCount(en));
  });
});

describe("设置表与 schema 的 volatile 面对齐", () => {
  it("卡片表恰是设置卡可见键，部署表只装部署级键", async () => {
    const { en, zh } = await readPair();
    const { all, volatile } = configKeys(await readFile(path.join(pkgDir, HOST), "utf8"));
    const nonVolatile = all.filter((key) => !volatile.includes(key));
    for (const [label, text, cardStart, deployStart] of [
      [EN, en, CARD_TABLE_START.en, DEPLOY_TABLE_START.en],
      [ZH, zh, CARD_TABLE_START.zh, DEPLOY_TABLE_START.zh],
    ] as const) {
      const { card, deploy } = settingsTableRows(text, cardStart, deployStart);
      expect(card.length, `${label} 里找不到设置卡表`).toBeGreaterThan(0);
      const cardKeys = expandFamilies(rowTokens(card), all);
      expect(
        [...new Set(cardKeys)].toSorted(),
        `${label} 的卡片表与 schema 的 volatile 面不一致`,
      ).toStrictEqual([...volatile].toSorted());
      const deployKeys = [...new Set(expandFamilies(rowTokens(deploy), all))].toSorted();
      // 部署表可以只写一部分（MCP 三枚键在 MCP 章节里讲），但混进设置卡字段就是放错表。
      expect(
        deployKeys.filter((key) => !nonVolatile.includes(key)),
        `${label} 的部署表里混进了设置卡字段`,
      ).toStrictEqual([]);
      // 剩下没进部署表的，必须正好是 MCP 章节里单独文档化的那三枚。
      expect(
        nonVolatile.filter((key) => !deployKeys.includes(key)),
        `${label} 的部署表缺了部署级键`,
      ).toStrictEqual(["integrationMode", "mcpPort", "officialMcpEnabled"]);
    }
  });
});

describe("文档里的工具计数跟着工具表走", () => {
  it("两份 README 与随包补丁注释都写现量", async () => {
    const { en, zh } = await readPair();
    // 工具表增删工具时，这两句文案与补丁注释要一起改——这条断言就是那个提醒。
    expect(TOOL_SPECS, "工具表变了就把这几处计数文案一起改").toHaveLength(19);
    expect(en).toContain("Nineteen tools");
    expect(zh).toContain("十九个工具");
    const patch = await readFile(path.join(pkgDir, "cordis.patch.yml"), "utf8");
    expect(patch).toContain(`# ${TOOL_SPECS.length} 个工具`);
  });
});

describe("第三方声明随包发出", () => {
  it("声明文件被两份 README 引用，并进了 files", async () => {
    const { en, zh } = await readPair();
    const manifest = JSON.parse(
      await readFile(path.join(pkgDir, "package.json"), "utf8"),
    ) as unknown as {
      files?: readonly string[];
    };
    // npm 只无条件附带 README* 与 LICENSE*，声明文件不在其列——不写进 files 就会在发布时
    // 悄悄消失，而门禁跑在没发布的仓库上，看不出任何异常。
    expect(en, `${EN} 没有引用 ${NOTICES}`).toContain(NOTICES);
    expect(zh, `${ZH} 没有引用 ${NOTICES}`).toContain(NOTICES);
    expect(manifest.files ?? [], `files 里缺 ${NOTICES}`).toContain(NOTICES);
  });
});
