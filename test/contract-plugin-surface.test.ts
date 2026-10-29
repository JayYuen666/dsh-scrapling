// dsh-scrapling/test/contract-plugin-surface.test.ts —— 注入面与实际摸到的服务必须一致。
//
// cordis 的上下文是一层代理：**没写进 `inject` 的名字读不到**，读就跑
// `cannot get property "<name>" without inject`（@deepseek-ai/cordis 的 reflect 层）。这条
// 机制在本仓咬过一次真实故障：设置卡与它的结果行一起静默消失 —— 症状不是报错，而是页面上
// 少了一块东西。所以两面都要钉：
//
// 1. **少写**：摸了一个没声明的服务。运行时抛，而抛在异步 effect 里会被 cordis 咽进日志
//    （`lib/index.js` 的 task.catch → logger.error），用户侧只剩「界面少了一块」。
// 2. **多写**：声明了一个不用的服务。后果同样看不见 —— 注入是**必需**依赖，profile 里没有
//    该服务时本插件整个不激活（PENDING），症状是「装了但一个工具都没有」。
//
// 判据从源码自己取：声明清单读 `inject` 那个数组字面量，用法扫 `ctx.<name>`。扫描前先把
// 注释与字符串摘掉 —— 本仓的注释大量讨论「ctx.web / ctx.jobs」这类服务名，不摘就会把
// 「文档里提到」读成「代码里用了」，那种误报会让人开始无视这条门禁，等于没有。
//
// 最后两组拿**真实 cordis 容器**跑一遍机制本身：本文件断言的是上游的语义，不是我对它的
// 理解。上游改了这条行为，这里应当立刻红。

import path from "node:path";
import { readFile } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");

/**
 * cordis 自带的成员名：这些不需要声明注入。
 *
 * 出处是 reflect 层注册的那批 accessor（`effect` / `on` / `provide` / `get` …）与 Context
 * 自身的实例字段（`root` / `logger` / `fiber` / `events` …）。少了这张表，「本插件用了
 * ctx.logger」会被误判成漏声明。
 */
const CORDIS_BUILTINS = new Set([
  "effect",
  "inject",
  "on",
  "once",
  "parallel",
  "emit",
  "serial",
  "bail",
  "waterfall",
  "provide",
  "mixin",
  "runtime",
  "plugin",
  "root",
  "baseUrl",
  "fiber",
  "reflect",
  "events",
  "logger",
  "get",
]);

/**
 * 摘掉注释与字符串，只留真正的代码用法。
 *
 * 顺序要紧：先摘字符串再摘 `//` 行注释，否则 URL（``https://``）里的那个 `//` 会把整行
 * 吃掉，而那一行可能正好有真的 `ctx.xxx`。
 *
 * @param source - 源码
 * @returns 只剩代码的文本
 */
function consumeComment(source: string, index: number): { at: number; text: string } {
  const isLine = source.startsWith("//", index);
  const stop = isLine ? source.indexOf("\n", index) : source.indexOf("*/", index + 2);
  if (stop === -1) {
    return { at: source.length, text: "\n" };
  }
  return { at: isLine ? stop : stop + 2, text: isLine ? "\n" : " " };
}

/**
 * 跳过一段字符串或模板字面量。
 *
 * @param source - 源码
 * @param index - 引号所在位置
 * @returns 引号之后的第一个位置
 */
function consumeQuoted(source: string, index: number): number {
  const quote = source[index] ?? "";
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
    } else if (char === quote) {
      cursor += 1;
      break;
    } else if (quote !== "`" && char === "\n") {
      break;
    } else {
      cursor += 1;
    }
  }
  return cursor;
}

/**
 * 只留代码：注释与字符串（含模板）整段摘掉。
 *
 * @param source - 源码
 * @returns 只剩代码的文本
 */
function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const after = source[index + 1];
    if (char === "/" && (after === "/" || after === "*")) {
      const { at, text } = consumeComment(source, index);
      out.push(text);
      index = at;
    } else if (char === '"' || char === "'" || char === "`") {
      // 字符串与模板整体丢掉：注释与日志文案里满是「ctx.web」这种字样，留下就会被读成
      // 「代码里用了这个服务」。模板里的 ${...} 一并当内容丢掉 —— 判据要的是语句级用法。
      out.push('""');
      index = consumeQuoted(source, index);
    } else {
      out.push(char);
      index += 1;
    }
  }
  return out.join("");
}

/**
 * 从一个数组字面量里取出声明的服务名。
 *
 * @param source - 源码
 * @param marker - 锚点前面的部分（如 `export const inject =`）
 * @returns 声明的服务名
 * @throws 找不到那个字面量
 */
function listAfter(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  if (start === -1 || open === -1 || close === -1) {
    throw new Error(`源码里找不到 ${marker} [...] 这个数组字面量`);
  }
  return Array.from(
    source.slice(open + 1, close).matchAll(/"(?<name>\w+)"/gu),
    (item) => item.groups?.["name"] ?? "",
  );
}

/**
 * 取一批源码里实际读到的 `ctx.<name>`（注释与字符串里的不算）。
 *
 * @param sources - 源码文本
 * @returns 服务名集合
 */
function collect(into: Set<string>, name: string | undefined): void {
  if (name !== undefined && name !== "" && !CORDIS_BUILTINS.has(name)) {
    into.add(name);
  }
}

/**
 * 取一批源码里实际读到的服务名（注释与字符串里的不算）。
 *
 * 两种写法都要认：点号（`ctx.tools`、`this.#ctx.subprocess`）与解构
 * （`const { subprocess } = this.#ctx;`，sidecar.ts 就是这么拿的）。只认点号会把解构写法读成
 * 「这个服务没用到」，「多声明」那条门禁于是误报。
 *
 * @param sources - 源码文本
 * @returns 被读到的服务名
 */
function touchedServices(sources: readonly string[]): Set<string> {
  const out = new Set<string>();
  const dot = /#?\bctx\.(?<name>[a-zA-Z]\w*)/gu;
  const destructured =
    /(?:const|let|var)\s*\{\s*(?<names>[^{}]*?)\s*\}\s*=\s*(?:this\.)?#?[\w.]*\bctx\b/gu;
  for (const source of sources) {
    const code = stripCommentsAndStrings(source);
    for (const match of code.matchAll(dot)) {
      collect(out, match.groups?.["name"]);
    }
    for (const match of code.matchAll(destructured)) {
      for (const item of (match.groups?.["names"] ?? "").split(",")) {
        collect(out, item.trim().split(":")[0]?.trim());
      }
    }
  }
  return out;
}

/**
 * 取 `ctx.get("<name>")` 那一类可选读取。
 *
 * 可选服务按上游约定走 `ctx.get(name)`（拓扑无关的全局存储），**不该**写进 inject；这里从
 * 原文取，因为字符串里的名字正是判据本身。
 *
 * @param sources - 源码文本
 * @returns 可选服务名
 */
function optionalServices(sources: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/ctx\.get\(\s*"(?<name>\w+)"/gu)) {
      collect(out, match.groups?.["name"]);
    }
  }
  return out;
}

/**
 * 读若干文件。
 *
 * @param names - 相对仓库根的路径
 * @returns 文本列表
 */
async function readAll(names: readonly string[]): Promise<string[]> {
  return Promise.all(names.map((name) => readFile(path.join(REPO, name), "utf8")));
}

/** Host 侧的全部实现文件（apply 与它交给的 lib）。 */
/** Host 侧的全部实现文件（apply 与它交给的 lib）。 */
const HOST_FILES = [
  "host.ts",
  "lib/sidecar.ts",
  "lib/tools.ts",
  "lib/answer.ts",
  "lib/web-provider.ts",
  "lib/search-provider.ts",
];

/** 上面那行重复声明的占位（下面清掉）。 */

/**
 * 取 Host 侧的声明面与使用面。
 *
 * @returns 声明集合、使用集合、可选读取集合
 */
async function hostSurface(): Promise<{
  declared: Set<string>;
  touched: Set<string>;
  optional: Set<string>;
}> {
  const sources = await readAll(HOST_FILES);
  return {
    declared: new Set(listAfter(sources[0] ?? "", "export const inject =")),
    touched: touchedServices(sources),
    optional: optionalServices(sources),
  };
}

describe("注入面：声明的服务与真正摸到的服务必须一致", () => {
  it("宿主侧少声明：摸到的每个服务都在 inject 里（漏了就是运行时抛）", async () => {
    const { declared, touched } = await hostSurface();
    const missing = [...touched].filter((name) => !declared.has(name));
    expect(missing, `这些服务被读了却没声明注入：${missing.join(", ")}`).toStrictEqual([]);
    expect(touched.size, "一个服务都没扫到，说明判据本身失效了").toBeGreaterThan(2);
  });

  it("宿主侧多声明：inject 里每个服务都真被摸到（多余声明会让插件整段不激活）", async () => {
    const { declared, touched, optional } = await hostSurface();
    const unused = [...declared].filter((name) => !touched.has(name) && !optional.has(name));
    expect(
      unused,
      `这些服务声明了却没人读：${unused.join(", ")}。注入是必需依赖 —— profile 里没有它时本插件直接 PENDING。`,
    ).toStrictEqual([]);
  });

  it("客户端少声明：设置卡摸到的每个服务都在它的 inject 里", async () => {
    const [entry = "", card = ""] = await readAll(["src/client-entry.ts", "src/settings-card.ts"]);
    const declared = new Set(listAfter(entry, "const inject ="));
    const missing = [...touchedServices([entry, card])].filter((name) => !declared.has(name));
    expect(missing, `客户端少声明注入：${missing.join(", ")}`).toStrictEqual([]);
  });

  it("客户端多声明：设置卡的 inject 里没有用不到的服务", async () => {
    const [entry = "", card = ""] = await readAll(["src/client-entry.ts", "src/settings-card.ts"]);
    const declared = new Set(listAfter(entry, "const inject ="));
    const touched = touchedServices([entry, card]);
    const unused = [...declared].filter((name) => !touched.has(name));
    expect(unused, `客户端多声明注入：${unused.join(", ")}`).toStrictEqual([]);
  });
});

/**
 * 往一个干净容器里装一个读服务的探针插件，把读到的东西原样带回来。
 *
 * @param options - 声明清单、要读的名字、以及那个名字有没有被 provide 过
 * @returns 读取结果或错误文本；插件没被激活时给空串
 */
async function readWith(options: {
  inject: string[];
  read: string;
  provided: boolean;
}): Promise<string> {
  const root = new Context();
  if (options.provided) {
    root.provide("svc", { marker: "provided" });
  }
  let outcome = "";
  await root.plugin({
    name: "probe-reader",
    inject: options.inject,
    apply: (ctx: Context) => {
      const bag = ctx as unknown as Record<string, { marker: string } | undefined>;
      try {
        outcome = `value:${String(bag[options.read]?.marker)}`;
      } catch (error) {
        outcome = `threw:${(error as Error).message}`;
      }
    },
  });
  return outcome;
}

describe("机制本身：注入声明的两种失败形态（真实 cordis 容器）", () => {
  it("少声明：那个服务没人给时，读它就是抛上游那句 without inject", async () => {
    const outcome = await readWith({ inject: [], read: "svc", provided: false });
    expect(outcome).toContain('cannot get property "svc" without inject');
  });

  it("声明了却没人给：apply 根本不跑，插件停在不可用状态", async () => {
    // 这条钉的是「多声明」的代价：注入按必需依赖对待，profile 里缺那个服务时 apply 一次
    // 都不会执行 —— 症状是「装了但一个工具都没有」，而不是一行错误日志。所以多余的声明
    // 与漏声明一样危险：两种都看不见。
    const outcome = await readWith({ inject: ["svc"], read: "svc", provided: false });
    expect(outcome).toBe("");
  });

  it("声明齐、服务在：读得到，插件激活", async () => {
    const outcome = await readWith({ inject: ["svc"], read: "svc", provided: true });
    expect(outcome).toBe("value:provided");
  });

  it("全局存储里有同名服务时，少声明也能读到（所以门禁不能只靠运行时）", async () => {
    // 上游的代理在「服务确实存在于全局存储」时会放行 —— 少声明不一定当场抛，可能只是
    // 在另一种拓扑（客户端那种 shadow）里才炸。所以这条静态门禁不能被「跑一遍没报错」替掉。
    const outcome = await readWith({ inject: [], read: "svc", provided: true });
    expect(outcome).toBe("value:provided");
  });
});
