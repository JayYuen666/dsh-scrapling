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

  it("二级章节数一致", async () => {
    const { en, zh } = await readPair();
    expect(sectionCount(zh), `${ZH} 的章节数与 ${EN} 不一致`).toBe(sectionCount(en));
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
