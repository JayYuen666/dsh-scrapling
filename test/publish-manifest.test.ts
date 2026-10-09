// test/publish-manifest.test.ts —— 发布形态门禁：入口面必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。两类坑都在
// 那一侧。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：写下时刻、列表序号、坏字节——三者都对读的人无用，且没有任何读者
// 能从中重建当时的上下文。只扫注释行与文档；测试夹具里的日期（modifiedAfter 之类的边界
// 值）是数据，角色文档里的日期是内容，两者都不在禁面内。
//
// 第三组门禁把**构建产物本身**载入一次。这一条是被真实故障逼出来的：rolldown 内联了
// 运行期才提供的宿主包，其中一个在模块顶层按 import.meta.url 相对解析自身 package.json，
// 搬进本包后那个相对路径就指到别处，import 直接抛 MODULE_NOT_FOUND。源码侧全绿、单测
// 全绿、类型检查全绿，只有装出去才炸——所以门禁必须落在产物上。
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/**
 * 只在注释与文档里禁的东西：写下来的时刻、列表序号、以及坏字节。
 *
 * 年份一律拦，中英文两种写法都算 —— 指的是同一件事。列表序号只拦行首 `// ` 或 ` * ` 之后
 * 紧跟的有序列表标记，不拦句子里的数字：那类多半是代码引用。U+FFFD 替换字符一并拦：它是
 * 编码坏掉的痕迹，已经在本仓咬到过几处注释，进包就是给用户看的乱码。
 *
 * 本文件自己也不举日期样例 —— 门禁扫的就是全部源码注释，在这里举例等于让自己红。
 *
 * 「轮次编号」仍然不进门禁。本仓的 `本轮` / `第 N 轮` 指的是**会话轮次**这个产品概念
 * （首轮消息不支持 fork、gate 的「下一轮重新计数」），而不是写下注释时的工轮次。两种含义
 * 在中文里同形，机器分不开；要禁只能靠逐条人工判断，那不是门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/u,
  /(?:19|20)\d{2}\s*年/u,
  /^\s*(?:\/\/|\*|#)\s+\d+[.、)]\s/u,
  /\uFFFD/u,
  //u,
];

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口面。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻意不管的面。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 测试夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口面有关的形状；其余字段本门禁不关心。 */
interface Manifest {
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** 一条 `files` 模式的两种形态。 */
type PatternShape =
  /** 目录或后缀模式：列该目录（可递归）下以 `extension` 结尾的文件。 */
  | { readonly kind: "glob"; readonly dir: string; readonly extension: string }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly file: string };

/**
 * 把 `files` 的一条模式归类。本仓实际用到的只有三种写法：裸文件名、目录名、`dir/*.ext`。
 *
 * 「精确文件名」这一档不能和后缀过滤混为一谈：把 `host.js` 当成 `.js` 后缀过滤，于是
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，门禁
 * 自己先失效。实测报出来是「main 指向 host.js，但它不在 files 覆盖范围内」。
 *
 * @param entry - `files` 数组里的一项
 * @returns 该模式要列的目录与后缀过滤，或一个精确文件名
 */
function shapeOf(entry: string): PatternShape {
  const dot = entry.lastIndexOf(".");
  const star = entry.indexOf("*");
  if (star !== -1) {
    return {
      kind: "glob",
      dir: entry.slice(0, star).replace(/\/$/u, ""),
      extension: entry.slice(dot),
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", dir: entry, extension: "" };
  }
  return { kind: "exact", file: entry };
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * @param shape - 见 {@link shapeOf}
 * @returns 命中的文件清单
 */
async function expand(shape: PatternShape): Promise<string[]> {
  if (shape.kind === "exact") {
    return existsSync(path.join(pkgDir, shape.file)) ? [shape.file] : [];
  }
  const names = await readdir(path.join(pkgDir, shape.dir), { recursive: shape.dir !== "." });
  return names
    .map((name) => name.split(path.sep).join("/"))
    .filter((name) => shape.extension === "" || name.endsWith(shape.extension))
    .map((name) => path.posix.join(shape.dir, name));
}

/**
 * 递归收集一条 `exports` 值里的具体目标文件。通配条目（值含 `*`）没有可验证的固定文件。
 *
 * @param value - `exports` 里某一键的值（字符串或条件对象）
 * @returns 该条目要求存在的包内路径
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
}

/** 入口目标的相对形态（去掉 `./` 前缀）。 */
function asRelative(target: string): string {
  return target.replace(/^\.\//u, "");
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  const flat = Object.entries(manifest.exports ?? {}).flatMap(([specifier, value]) =>
    filesOf(value).map((file) => ({ label: specifier, file })),
  );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/** 发布器无条件附带的文件：不受 `files` 约束，但也不该由门禁去断言它在 `files` 里。 */
const ALWAYS_SHIPPED = [
  "package.json",
  "README.md",
  "README.zh.md",
  "README.zh-CN.md",
  "LICENSE",
  "CHANGELOG.md",
];

/**
 * 读 manifest 与它应当发出去的文件清单。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, "package.json"), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/**
 * 递归收集该纳入注释门禁的源文件与文档（相对包根、`/` 分隔）。
 *
 * @param dir - 当前目录的绝对路径
 * @param prefix - 相对包根的前缀
 * @returns 命中的文件清单
 */
async function collectSources(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // 每个条目一个 promise 再一起等：顺序无关，而顺序相关的写法（循环里 await）在这里既
  // 慢又没有对应的正确性理由——收集的是文件名集合，先返回谁都一样。
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const nested = await collectSources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        return nested;
      }
      if (/\.(?:ts|tsx|mjs|yml|md)$/u.test(entry.name)) {
        return [`${prefix}${entry.name}`];
      }
      return [];
    }),
  );
  return groups.flat();
}

/**
 * 取一段文本里属于注释或文档的行。文档（`.md`）整体算；代码只取注释行，免得把字符串
 * 字面量里的数据（日期夹具、示例路径）误判成注释噪音。
 *
 * @param file - 相对包根的文件名，用于决定判定口径
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  return text.split("\n").filter((line) => /^\s*(?:\/\/|\/\*|\*|#)/u.test(line));
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        shipped.has(asRelative(target.file)),
        `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`,
      ).toBe(true);
    }
  });

  it("入口一律指向构建产物，源码目录不参与发布", async () => {
    const { manifest } = await readSurface();
    for (const target of entryFiles(manifest)) {
      expect(target.file, `${target.label} 不该指源码`).not.toMatch(/\.tsx?$/u);
    }
  });

  it("publishConfig 只留可见性与源，不留入口覆盖", async () => {
    const { manifest } = await readSurface();
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });
});

describe("宿主依赖的版本形状（升级防线）", () => {
  it("dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不可能发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让消费方在没有测试的
    // 情况下换掉宿主类型面。
    const { manifest } = await readSurface();
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(manifest.dependencies ?? {}).filter(
      ([name, range]) => name.startsWith("@deepseek-ai/dsh-") && !/^\d+\.\d+\.\d+-/u.test(range),
    );
    expect(ranged, "这些 dsh-* 依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("dsh-* 全部与 peer 的 dsh 同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型面被这些包以 type-only 方式消费；同一个会话里出现两个 dsh-session 的拷贝，
    // nominal 类型（品牌串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"];
    expect(peer, "peer 依赖缺失：宿主版本就失去基准了").toBeDefined();
    const hostVersion = (peer ?? "").replace(/^[\^~]/u, "");
    const drifted = Object.entries(manifest.dependencies ?? {}).filter(
      ([name, range]) => name.startsWith("@deepseek-ai/dsh-") && range !== hostVersion,
    );
    expect(drifted, "这些 dsh-* 与宿主 dsh 不同版本").toStrictEqual([]);
  });
});

describe("注释与文档没有内部指涉", () => {
  it("源码与文档的注释里没有日期", async () => {
    const collected = await collectSources(pkgDir, "");
    const sources = collected.toSorted();
    expect(sources.length, "至少要扫到源码文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const entry of texts) {
      for (const line of commentLines(entry.file, entry.text)) {
        for (const pattern of FORBIDDEN_IN_COMMENTS) {
          expect(
            pattern.test(line),
            `${entry.file} 的注释命中内部指涉 ${pattern}：${line.trim().slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("构建产物可载入", () => {
  it("host.js 真的能 import（内联的宿主包会在模块顶层就炸）", async () => {
    const artifact = path.join(pkgDir, "host.js");
    expect(existsSync(artifact), "host.js 不存在：先跑 node build-host.ts").toBe(true);
    // 按 dsh 的加载方式（按包名/路径 import ESM）载入，而不是 require。
    const loaded = (await import(pathToFileURL(artifact).href)) as Record<string, unknown>;
    for (const name of ["apply", "Config", "name", "inject", "TOOL_SPECS"]) {
      expect(loaded[name], `产物缺少导出 ${name}`).toBeDefined();
    }
  });

  it("产物里没有内联的宿主包正文（它们由宿主在运行期提供）", async () => {
    const code = await readFile(path.join(pkgDir, "host.js"), "utf8");
    // 内联的痕迹是模块自己的 JSDoc 头（`@module @deepseek-ai/…`）。宿主提供的包必须以裸
    // 说明符留在产物里，否则拿到的是本包私有的那一份副本 —— 模块级状态会裂成多份。
    const inlined = [...code.matchAll(/@module (?<pkg>@deepseek-ai\/[\w-]+)/gu)].map(
      (found) => found.groups?.["pkg"],
    );
    expect(inlined, `这些宿主包被内联进产物了: ${[...new Set(inlined)].join(", ")}`).toStrictEqual(
      [],
    );
  });

  it("产物里的真实逻辑还能跑（压缩改形状时这条会红）", async () => {
    // 产物是压缩过的：标识符改名、注释剥掉。只断言「导出一个叫 apply 的函数」太弱，
    // 压缩把内部逻辑改坏它照样绿。这里让**产物自己**跑一遍注册计划：十一个工具、两条
    // 分支都要给出正确结果。任何依赖名字（constructor.name 之类）或模块级状态的压缩
    // 手法，都会在这里露出来，而不是等到装进 dsh 才发现。
    const artifact = (await import(pathToFileURL(path.join(pkgDir, "host.js")).href)) as {
      TOOL_SPECS: readonly { name: string; flag: string }[];
      planTools: (
        flags: Record<string, boolean>,
        capabilities: unknown,
      ) => {
        ready: readonly string[];
      };
    };
    // 开关取的是每一项自己的 flag，而不是工具名的后缀：会话类四条共用一个 flag，
    // capture_xhr 的 flag 是 captureXhr，按名字拼出来的键对不上任何一项。
    const allOn = Object.fromEntries(artifact.TOOL_SPECS.map((spec) => [spec.flag, true]));
    const full = {
      scrapling: true,
      fetch: true,
      extract: true,
      browser: true,
      stealth: true,
      version: "0.4.15",
    };
    expect(artifact.TOOL_SPECS).toHaveLength(11);
    const { ready } = artifact.planTools(allOn, full);
    // 有浏览器时十一个全注册；会话类四条各自独立，所以总数与工具数相等。
    expect(ready).toHaveLength(11);
    // 关掉浏览器的分支同样要成立，且恰好少掉那三个依赖浏览器的工具。写成差集而不是
    // 写死个数：以后往登记表里加工具，这个断言仍然成立，而不会因为数字对不上而失败。
    const BROWSER_TOOLS = new Set([
      "scrapling_render",
      "scrapling_capture_xhr",
      "scrapling_stealth_fetch",
    ]);
    const { ready: withoutBrowser } = artifact.planTools(allOn, {
      ...full,
      browser: false,
      stealth: false,
    });
    expect(withoutBrowser).toStrictEqual(ready.filter((name) => !BROWSER_TOOLS.has(name)));
    expect(BROWSER_TOOLS.has("scrapling_render")).toBe(true);
  });
});
