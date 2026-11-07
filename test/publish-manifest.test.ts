// test/publish-manifest.test.ts —— 发布形态门禁：入口必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。两类坑都在
// 装出去之后的那份产物里。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：写下时刻、列表序号、坏字节——三者都对读的人无用，且没有任何读者
// 能从中重建当时的上下文。只扫注释行与文档；夹具里的日期（modifiedAfter 之类的边界
// 值）是数据，角色文档里的日期是内容，两者都不在禁止名单内。
//
// 第三组门禁把**构建产物本身**载入一次。这一条是被真实故障逼出来的：rolldown 内联了
// 运行期才提供的宿主包，其中一个在模块顶层按 import.meta.url 相对解析自身 package.json，
// 搬进本包后那个相对路径就指到别处，import 直接抛 MODULE_NOT_FOUND。源码侧全绿、单测
// 全绿、类型检查全绿，只有装出去才炸——所以门禁必须落在产物上。
import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { MCP_SERVER_NAME } from "../lib/mcp-contract.ts";
import { MCP_SERVER_VERSION } from "../lib/mcp-server.ts";

const pkgDir = path.join(import.meta.dirname, "..");
const PACKAGE_JSON = "package.json";

/**
 * 只在注释与文档里禁的东西：写下来的时刻、列表序号、以及坏字节。四条各管一样，多写一条
 * 「看起来像规则」的行只会让人以为门禁还拦了别的形态。
 *
 * 年份一律拦，中英文两种写法都算 —— 指的是同一件事。列表序号只拦注释行首的有序列表标记
 * （`// 1.`、` * 1.`、YAML 的 `# 1.`），不拦句子里的数字：那类多半是代码引用。U+FFFD 替换字符一并拦：它是
 * 编码坏掉的痕迹，已经在本仓咬到过几处注释，进包就是给用户看的乱码。
 *
 * 本文件自己也不举日期样例 —— 门禁扫的就是全部源码注释，在这里举例等于让自己红。
 *
 * 「轮次编号」仍然不进门禁。本仓的 `本轮` / `第 N 轮` 指的是**会话轮次**这个产品概念
 * （首轮消息不支持 fork、gate 的「下一轮重新计数」），而不是写下注释时的工作轮次。两种含义
 * 在中文里同形，机器分不开；要禁只能靠逐条人工判断，那不是门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/u,
  /(?:19|20)\d{2}\s*年/u,
  /^\s*(?:\/\/|\*|#)\s+\d+[.、)]\s/u,
  /\uFFFD/u,
];

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻刻意不管的目录。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口有关的形状；其余字段本门禁不关心。 */
interface Manifest {
  readonly version?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly bin?: Record<string, string>;
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** 一条 `files` 模式的两种形态。 */
type PatternShape =
  /** 目录模式：列该目录（根之外递归）下以 `extension` 结尾的文件；空后缀表示整目录都要。 */
  | { readonly kind: "glob"; readonly dir: string; readonly extension: string }
  /** 精确文件名：包根下确实是个文件的那一条（`host.js`）。 */
  | { readonly kind: "exact"; readonly file: string };

/** 包根下这条路径确实是个目录时才算目录模式；读不到或不是目录都按精确文件名走。 */
function isDirectoryEntry(entry: string): boolean {
  try {
    return statSync(path.join(pkgDir, entry)).isDirectory();
  } catch {
    return false;
  }
}

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
  const star = entry.indexOf("*");
  if (star !== -1) {
    // 后缀只在最后一个路径段里谈：`locale/*.json` 是 locale 目录下的 .json，而 `py/*` 没有
    // 后缀（整目录都要）。拿整条的最后一个点算会把 `*` 自己当成后缀，覆盖集合当场空掉。
    const segment = entry.slice(entry.lastIndexOf("/") + 1);
    const dot = segment.indexOf(".");
    const dir = entry.slice(0, star).replace(/\/$/u, "");
    return {
      kind: "glob",
      dir: dir === "" ? "." : dir,
      extension: dot === -1 ? "" : segment.slice(dot),
    };
  }
  // 是不是目录按文件系统判，不按「名字里有没有点」：`docs.v2/` 这种目录名会被后者判成文件名，
  // 于是整目录静默漏检，而漏检正是这道门禁最不能容忍的方向。
  if (isDirectoryEntry(entry)) {
    return { kind: "glob", dir: entry, extension: "" };
  }
  return { kind: "exact", file: entry };
}

/** 列一个目录：包根之外递归，包根只取自己那一层（否则会把 node_modules 与 .git 整仓扫进来）。 */
async function listDir(dir: string, entry: string): Promise<string[]> {
  try {
    return await readdir(path.join(pkgDir, dir), { recursive: dir !== "." });
  } catch (error) {
    throw new Error(`${PACKAGE_JSON} 的 files 条目 ${entry} 读不到目录`, { cause: error });
  }
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * @param shape - 见 {@link shapeOf}
 * @param entry - 该条 `files` 原文，只用于报错时点名
 * @returns 命中的文件清单
 */
async function expand(shape: PatternShape, entry: string): Promise<string[]> {
  if (shape.kind === "exact") {
    return existsSync(path.join(pkgDir, shape.file)) ? [shape.file] : [];
  }
  const names = await listDir(shape.dir, entry);
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
 * 把 `exports` 摊成「说明符 + 值」清单。
 *
 * 官方 `exports` 有三种合法写法：字符串（整包一个入口）、条件数组（按序回退）、以说明符为键
 * 的对象。直接把对象版的 `Object.entries` 套在字符串上会把它拆成字符索引 —— 实测拿到
 * `{label:"0",file:"."}`、`{label:"2",file:"h"}` 这类目标，入口断言于是去查一批毫不相关的
 * 路径：换个写法就可能误红，也可能一个真入口都没查到却照样打绿。形态不认识时抛错而不是
 * 交回空清单：空清单在这道门禁里长得和「全部通过」一模一样。
 *
 * @param value - manifest 里的 exports 原值
 * @returns 每条入口的标签与它的值
 */
function exportsEntries(value: unknown): { label: string; value: unknown }[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [{ label: ".", value }];
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index: number) => ({
      label: `exports[${String(index)}]`,
      value: item,
    }));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([label, item]) => ({ label, value: item }));
  }
  throw new Error(`${PACKAGE_JSON} 的 exports 形态不认识：${typeof value}`);
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  const flat = exportsEntries(manifest.exports).flatMap(({ label, value }) =>
    filesOf(value).map((file) => ({ label, file })),
  );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/** 发布器无条件附带的文件：不受 `files` 约束，但也不该由门禁去断言它在 `files` 里。 */
const ALWAYS_SHIPPED = [
  PACKAGE_JSON,
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
async function loadSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, PACKAGE_JSON), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all(
    (manifest.files ?? []).map((entry) => expand(shapeOf(entry), entry)),
  );
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/**
 * 发布名单快照：盘读一次、解析一次，各条断言共用同一份。
 *
 * 每条用例各调一次 `loadSurface()` 时，同一个 `package.json` 会被解析十几遍，而两遍之间
 * 磁盘状态若变了（并跑的构建任务、`files` 改动），同一文件里的断言判的就不是同一份出货内容。
 */
const surface = await loadSurface();

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
 * 文档里的正文行：整篇都算，但代码块里的不算（那里的日期与路径是示例数据）。
 *
 * 围栏不配对时直接抛：那样一半的正文会被静默当成代码块跳过，门禁悄悄失效。
 *
 * @param lines - 文档按行切开的全文
 * @returns 参与门禁的正文行（围栏行本身也留着，它不是内容）
 */
function mdProse(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      kept.push(line);
    } else if (!inFence) {
      kept.push(line);
    }
  }
  if (inFence) {
    throw new Error("文档里有没配对的代码围栏，注释门禁没法判断哪些是正文");
  }
  return kept;
}

/**
 * 取一段文本里属于注释或文档的行。
 *
 * 代码按**区间**取：块注释从起始那对字符一路取到收尾那对字符为止，中间那些不带前导星的
 * 正文行同样是注释 —— 只按行首字符判会整段漏掉，而日期恰恰常写在块注释中间。`.md` 整体算，
 * 但代码块里的示例不算；`#` 那种行首只在 `.yml` 里才是注释（TypeScript 里那是私有字段）。
 *
 * @param file - 相对包根的文件名，用于决定判定规则
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  const lines = text.split("\n");
  if (file.endsWith(".md")) {
    return mdProse(lines);
  }
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    // 块注释按区间取：`/*` 与收尾那两个字符之间的每一行都是注释，中间那些不带前导星的
    // 正文行也在内。只看行首字符会整段漏掉它们，而日期恰恰常写在块注释中间。
    const keep =
      inBlock ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("//") ||
      /^\*\s/u.test(trimmed) ||
      (file.endsWith(".yml") && trimmed.startsWith("#"));
    if (keep) {
      kept.push(line);
    }
    if (inBlock || trimmed.startsWith("/*")) {
      inBlock = !trimmed.includes("*/");
    }
  }
  return kept;
}

describe("entryFiles 认全 exports 的三种合法写法", () => {
  it("字符串形态给一个根入口，而不是被拆成字符索引", () => {
    expect(entryFiles({ exports: "./index.js" })).toStrictEqual([
      { label: ".", file: "./index.js" },
    ]);
  });

  it("条件数组按序给出每条回退目标", () => {
    expect(entryFiles({ exports: ["./fallback.js", { types: "./fallback.d.ts" }] })).toStrictEqual([
      { label: "exports[0]", file: "./fallback.js" },
      { label: "exports[1]", file: "./fallback.d.ts" },
    ]);
  });

  it("对象形态按说明符给标签；通配条目没有可核对的固定文件", () => {
    expect(
      entryFiles({
        exports: { ".": { types: "./a.d.ts", default: "./a.js" }, "./py/*": "./py/*" },
      }),
    ).toStrictEqual([
      { label: ".", file: "./a.d.ts" },
      { label: ".", file: "./a.js" },
    ]);
  });

  it("main 与 types 各自带来源标签；形态不认识时抛错，不交回空清单", () => {
    expect(entryFiles({ main: "./host.js", types: "./host.d.ts" })).toStrictEqual([
      { label: "main", file: "./host.js" },
      { label: "types", file: "./host.d.ts" },
    ]);
    expect(() => entryFiles({ exports: 7 })).toThrow(/形态不认识/u);
    expect(() => entryFiles({ exports: null })).toThrow(/形态不认识/u);
  });
});

describe("注释行的取法", () => {
  it("块注释里不带前导星的正文行也参与", () => {
    const text = ["/*", "下一份报告的时间线写在 2026 年那档", "*/"].join("\n");
    expect(commentLines("a.ts", text)).toStrictEqual([
      "/*",
      "下一份报告的时间线写在 2026 年那档",
      "*/",
    ]);
  });

  it("行注释与续行都参与，普通代码行与字符串不参与", () => {
    const text = [
      "const x = 1; // 尾注不算（整行不是注释）",
      "// 单独的注释行算",
      " * 块注释的续行算",
      'const s = "2026-01-01";',
    ].join("\n");
    expect(commentLines("a.ts", text)).toStrictEqual(["// 单独的注释行算", " * 块注释的续行算"]);
  });

  it("井号行只在 YAML 里算注释；TypeScript 里那是私有字段", () => {
    expect(commentLines("a.yml", "# 说明")).toStrictEqual(["# 说明"]);
    expect(commentLines("a.ts", "  #counter = 0;")).toStrictEqual([]);
    // 拿到行之后还得真判：这条把「yml 的序号列表会被拦下来」走通到规则表本身，
    // 而不是只证明行被取了出来。
    expect(FORBIDDEN_IN_COMMENTS.some((rule) => rule.test("# 1. 步骤"))).toBe(true);
  });

  it("文档取正文、跳过代码块，围栏不配对时抛", () => {
    const text = ["正文一行", "```", "2026-01-01 是示例数据", "```", "又一行正文"].join("\n");
    expect(commentLines("README.md", text)).toStrictEqual(["正文一行", "```", "```", "又一行正文"]);
    expect(() => {
      commentLines("README.md", "正文\n```\n没收尾");
    }).toThrow(/没配对的代码围栏/u);
  });
});

describe("files 模式的归类", () => {
  it("带通配的条目按目录与后缀切分；没有后缀就是整目录", () => {
    expect(shapeOf("py/*")).toStrictEqual({ kind: "glob", dir: "py", extension: "" });
    expect(shapeOf("locale/*.json")).toStrictEqual({
      kind: "glob",
      dir: "locale",
      extension: ".json",
    });
    // 根级通配的 dir 归一成 "."：留空串会让 readdir 递归整仓，把 node_modules 也当成品。
    expect(shapeOf("*.js")).toStrictEqual({ kind: "glob", dir: ".", extension: ".js" });
  });

  it("目录与文件的区分按文件系统判，不按名字里有没有点", () => {
    expect(shapeOf("host.js")).toStrictEqual({ kind: "exact", file: "host.js" });
    expect(shapeOf("docs")).toStrictEqual({ kind: "glob", dir: "docs", extension: "" });
  });

  it("包根那一层不递归：根级模式不会把依赖目录扫进覆盖集合", async () => {
    const rootLevel = await expand(shapeOf("*.json"), "*.json");
    // 递归会把 node_modules 与 dist 里的 .json 一起当成「包根上的根级文件」，覆盖集合当场失真。
    expect(rootLevel.length, "包根上总该有 json 文件，否则这条是空转").toBeGreaterThan(0);
    expect(rootLevel.filter((name) => name.includes("/"))).toStrictEqual([]);
  });

  it("读不到的目录点名报错，不静默交回空清单", async () => {
    await expect(
      expand({ kind: "glob", dir: "no-such-dir", extension: "" }, "no-such-dir/*"),
    ).rejects.toThrow(/no-such-dir/u);
  });
});

describe("发布形态", () => {
  it("files 覆盖运行模块、CLI 与运行时资产，bin 指向产物", async () => {
    const { manifest: pkg } = surface;
    const pyEntries = await readdir(path.join(pkgDir, "py"));
    const runtimePy = pyEntries
      .filter((name) => name.endsWith(".py"))
      .toSorted()
      .map((name) => `py/${name}`);
    expect(runtimePy.length, "py/ 下不该没有运行模块").toBeGreaterThan(0);
    const required = [
      ...runtimePy,
      "py/runtime-requirements.txt",
      "runtime-manifest.json",
      "bin/dsh-scrapling.mjs",
    ];
    const files = pkg.files ?? [];
    expect(required.filter((entry) => !files.includes(entry))).toStrictEqual([]);
    expect(pkg.bin?.["dsh-scrapling"]).toBe("./bin/dsh-scrapling.mjs");
  });

  it("mcp server 自述的版本与包版本同值，SDK 是声明过的运行期依赖", async () => {
    const { manifest: pkg } = surface;
    expect(MCP_SERVER_NAME).toBe("scrapling");
    // 版本号写死在代码里，靠这条断言跟着 package.json 走：发布时忘了抬，红在这里而不是让客户
    // 连上一个自称旧版的 server。
    expect(pkg.version, "package.json 该有版本号").toBeDefined();
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
    expect(pkg.dependencies?.["@modelcontextprotocol/sdk"], "mcp 模式的运行期依赖").toBeDefined();
  });

  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = surface;
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
    const { manifest } = surface;
    for (const target of entryFiles(manifest)) {
      expect(target.file, `${target.label} 不该指源码`).not.toMatch(/\.tsx?$/u);
    }
  });

  it("publishConfig 只留可见性与源，不留入口覆盖", async () => {
    const { manifest } = surface;
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });

  it("py/extraction.py 在 files 里", async () => {
    const { manifest } = surface;
    expect(manifest.files).toContain("py/extraction.py");
  });
});

/** 宿主 dsh 家族的包名前缀（本组三条判据都要按它筛，收常量）。 */
const DSH_PREFIX = "@deepseek-ai/dsh-";

describe("宿主依赖的版本形状（升级防线）", () => {
  it("devDependencies 里的 dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让本包在没有测试的
    // 情况下换掉编译用的宿主类型声明。
    // 只判 dev这一侧 段：它才是本包真正装下来的那一份。peer 记的是「运行期由宿主提供」，
    // 装什么版本由宿主决定，判据在下面那条。
    const { manifest } = surface;
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(manifest.devDependencies ?? {}).filter(
      ([name, range]) =>
        name.startsWith(DSH_PREFIX) && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(range),
    );
    expect(ranged, "这些 dsh-* 开发依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 全部同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型被这些包以 type-only 方式消费；同一次安装里出现两枚 dsh-session 的拷贝，
    // nominal 类型（宿主用 brand 标记的 id 串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。
    const { manifest } = surface;
    const dshDev = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(dshDev.length, "至少要钉住一枚 dsh-* 开发依赖，否则这条是空转").toBeGreaterThan(0);
    const baseline = dshDev[0]?.[1];
    const drifted = dshDev.filter(([, range]) => range !== baseline);
    expect(drifted, `这些 dsh-* 与 ${baseline} 不同版本`).toStrictEqual([]);
  });

  it("peerDependencies 里的 dsh 家族写支持窗口范围，与裸 dsh 逐条同一条", async () => {
    // peer 由宿主拿自己安装的那版去满足：钉成精确版本等于要求两者版本号完全相等，而滚动支持
    // 窗口本来就含三个版本。宿主侧只在 manifest 没有 engines.dsh 时才读 peer（app-boot 的
    // plugin-compatibility 里 engines.dsh 存在即独判），所以这一位是发布元数据的含义问题。
    const { manifest } = surface;
    const bare = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? "";
    expect(bare, "裸 dsh 的 peer 缺失：支持窗口就失去基准了").toMatch(/^\^/u);
    const offPolicy = Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && range !== bare,
    );
    expect(offPolicy, "这些 dsh-* peer 与裸 dsh 不是同一条范围").toStrictEqual([]);
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

/**
 * 工具数量的独立锚点。
 *
 * 判据不得由被验的那张表派生，所以这里必须写死一个数；其余计数一律从 `TOOL_SPECS` 推。
 * 改动登记表时这一位会红，红话里点名要跟着改的文案位置。
 */
const TOOL_COUNT_ANCHOR = 19;

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
    // 内联的痕迹是模块自己的 JSDoc 头（`@module @deepseek-ai/…`）。宿主提供的包必须以只写
    // 包名的说明符留在产物里，否则拿到的是本包私有的那一份副本 —— 模块级状态会裂成多份。
    const inlined = Array.from(
      code.matchAll(/@module (?<pkg>@deepseek-ai\/[\w-]+)/gu),
      (found) => found.groups?.["pkg"],
    );
    expect(inlined, `这些宿主包被内联进产物了: ${[...new Set(inlined)].join(", ")}`).toStrictEqual(
      [],
    );
  });

  it("产物里的真实逻辑还能跑（压缩改形状时这条会红）", async () => {
    // 产物是压缩过的：标识符改名、注释被去掉。只断言「导出一个叫 apply 的函数」太弱，
    // 压缩把内部逻辑改坏它照样绿。这里让**产物自己**跑一遍注册计划：登记表里的每个工具、
    // 两条分支都要给出正确结果。任何依赖名字（constructor.name 之类）或模块级状态的压缩
    // 手法，都会在这里露出来，而不是等到装进 dsh 才发现。
    const artifact = (await import(pathToFileURL(path.join(pkgDir, "host.js")).href)) as {
      TOOL_SPECS: readonly { name: string; flag: string; requires: string }[];
      planTools: (
        flags: Record<string, boolean>,
        capabilities: unknown,
        jobsReady?: boolean,
        attachmentsReady?: boolean,
        sessionStateReady?: boolean,
      ) => {
        ready: readonly string[];
      };
    };
    // 开关取的是每一项自己的 flag，而不是工具名的后缀：会话类四条共用一个 flag，
    // capture_xhr 的 flag 是 captureXhr，网络历史与登录态存取各自有独立的 flag，
    // 按名字拼出来的键对不上任何一项。
    const allOn = Object.fromEntries(artifact.TOOL_SPECS.map((spec) => [spec.flag, true]));
    const full = {
      scrapling: true,
      static: true,
      extract: true,
      browser: true,
      version: "0.5",
    };
    // 手写的只有这一处锚点：登记表换了数量，它要响，让人去核对 README 与设置卡文案。
    expect(artifact.TOOL_SPECS).toHaveLength(TOOL_COUNT_ANCHOR);
    const { ready } = artifact.planTools(allOn, full, true, true, true);
    // 全开且能力齐时，注册数等于登记表长度：这条是关系，不是第二个数字。
    expect(ready).toHaveLength(artifact.TOOL_SPECS.length);
    // 关掉浏览器的分支同样要成立。依赖浏览器的那组由登记表的 requires 字段问出来：抄一份
    // 名单的话，以后加一只 requires 为 browser 的工具，这条断言会照样绿而漏掉它。
    const browserTools = artifact.TOOL_SPECS.filter((spec) => spec.requires === "browser").map(
      (spec) => spec.name,
    );
    const { ready: withoutBrowser } = artifact.planTools(
      allOn,
      { ...full, browser: false },
      true,
      true,
      true,
    );
    expect(browserTools, "登记表里没有依赖浏览器的工具，这条断言就成空转了").not.toHaveLength(0);
    expect(withoutBrowser).toStrictEqual(ready.filter((name) => !browserTools.includes(name)));
  });
});
