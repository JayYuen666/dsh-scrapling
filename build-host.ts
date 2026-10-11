#!/usr/bin/env node
// dsh-scrapling/build-host.ts —— 构建 host.js。
//
// 用 rolldown 把 host.ts 及其 `./lib/*` 依赖打成单文件 ESM，落在**包根**（与源码同目录，
// 故 `import.meta.dirname` 的语义与源码态完全一致）。
//
// 为什么产物必须是 .js 而不是 .ts：Node 对 node_modules 里的 .ts 直接抛
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING（实测），而发布出去的包正是躺在
// node_modules 里被 dsh 按包名载入运行的。本仓源码全 .ts，只有**产物**是 .js。
//
// 不产 .d.ts：插件包对外没有 TS API —— dsh 按包名载入运行，没有人 import 它。
//
// 产物做压缩（minify）：源码注释是写给维护者的推理——为什么这么判、哪条路试过不行——它们
// 留在发出去的包里既外泄内部设计讨论，又把包撑大一倍。压缩后体积约减半，注释从八百多行
// 降到个位数。标识符也随之压缩，调试时栈里的名字不再可读，这是为体积与不外泄付的代价；
// `test/publish-manifest.test.ts` 会真的 import 产物并断言导出面，改坏对外契约时它会红。

import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { canonicalizeRegionPaths } from "@jayyuen66/dsh-plugin-shared/lib/canonicalize-region-paths";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

const root = import.meta.dirname;

/** CJS 产物的严格模式指令。折进 ModuleLoader 外壳之后它就不再是函数体的指令前导。 */
const STRICT_DIRECTIVE = '"use strict";';

/**
 * 本文件是不是被 `node build-host.ts` 直接执行，而不是被 import 去内存里构建产物。
 *
 * 不能只比 `process.argv[1] === import.meta.filename`：Node 把 argv[1] 解析成绝对路径，
 * 但**不**折符号链接，而 ESM 侧 import.meta.* 一律按真实路径给。pnpm 的软链接包、
 * Windows 的 junction、以及「用一个 shim 转调」这三种形态下两个串恒不相等 —— 于是构建
 * 什么都不做、退出码还是 0，陈旧产物被静默发出去。两边都折成真实路径再比。
 *
 * @returns 是否是直接执行
 */
export function invokedDirectly(): boolean {
  const [entry] = process.argv.slice(1);
  if (entry === undefined || entry.length === 0) {
    return false;
  }
  if (import.meta.filename === entry || import.meta.url === pathToFileURL(entry).href) {
    return true;
  }
  try {
    return realpathSync(import.meta.filename) === realpathSync(entry);
  } catch {
    // 有一边不存在（argv[1] 指向别处、或文件名里有非常规字符）：宁可判否。
    // 判否的代价只是「这次不构建」，而误判为真的代价是构建一条没人要求的产物。
    return false;
  }
}

/**
 * 把产物顶部的严格模式指令摘出来。
 *
 * rolldown 的产物可能以 `"use strict";` 开头。ESM 源码本身就是严格模式，所以少了它不会
 * 有人报错；但多一个被外壳削掉指令地位的串，会让「这份代码到底跑在哪种模式」变成一个
 * 取决于 bundler 版本的偶然。摘掉之后由外壳在确定的位置放回去。
 *
 * @param code - rolldown 产出的正文
 * @returns 摘掉指令后的正文
 */
export function hoistStrictDirective(code: string): string {
  const trimmed = code.replace(/^\s+/u, "");
  return trimmed.startsWith(STRICT_DIRECTIVE)
    ? trimmed.slice(STRICT_DIRECTIVE.length).replace(/^\s+/u, "")
    : trimmed;
}

const pkgJson: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/**
 * 取依赖表里的包名清单（值即外部化说明符）。
 *
 * @param field - package.json 的依赖字段名
 * @returns 该表里的包名
 */
function dependencyNames(field: string): string[] {
  const pkg = isRecord(pkgJson) ? pkgJson : {};
  const table = isRecord(pkg[field]) ? pkg[field] : {};
  return Object.keys(table).filter((name) => typeof table[name] === "string");
}

// 三张依赖表一律外部化：产物里保留裸说明符才拿得到单例（内联会把 shared 的
// 模块级状态复制成多份）。
//
// devDependencies 也要算进来，否则 cordis / dsh-tools / dsh-subprocess / dsh-jobs
// 会被内联 —— 它们由宿主在运行期提供，在 node_modules 里比本包深一层。内联有两个
// 后果，后者是硬故障：按 `import.meta.url` 相对解析自身 package.json 的宿主包一旦
// 被搬进本包，那个相对路径就指到别处，`import` 本包直接抛 MODULE_NOT_FOUND。
// 判据取「声明过的包名全外部化」：本包不 import 未声明的包，那样的解析错误本来
// 就该在构建期炸出来。
//
// 子路径说明符同样要外部化 —— external 的字符串项是精确匹配，所以按「包名段」判定
// 而不是枚举子路径。
const externalNames = new Set([
  ...dependencyNames("dependencies"),
  ...dependencyNames("peerDependencies"),
  ...dependencyNames("devDependencies"),
]);

// `@jayyuen66/dsh-plugin-shared` 是唯一被收回外部化的包，因为它把 cordis / dsh-tools /
// dsh-jobs 等宿主包声明成了自己的 dependencies。一旦被外部化，profile 的 hoisted 安装就会在
// 本地物化出这批宿主包的**第二份物理副本**：dsh-tools 的 TOOL_RUNTIME_SCHEDULER 是普通
// Symbol（不是 Symbol.for），符号身份按模块实例计算，于是宿主 dsh-agent-loop 拿自己那份的
// Symbol 去读由副本挂载出来的 ToolRuntime，得到 undefined —— 每一次原生工具调用都抛
// "Cannot read properties of undefined (reading 'prepare')"，全 profile 的工具一起废。
// 本包用到的 shared 子模块（record / text / jsonl / card-apply）零外部 import、无模块级
// 状态，打进产物不会复制出共享状态；@deepseek-ai/* 仍一律外部化，保持宿主单例。
externalNames.delete("@jayyuen66/dsh-plugin-shared");

/**
 * 说明符的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。
 *
 * @param id - 模块说明符
 * @returns 包名段
 */
function packageNameOf(id: string): string {
  const segments = id.split("/");
  if (id.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] ?? id;
}

/** rolldown 外部化判据。 */
const isExternal = (id: string): boolean => externalNames.has(packageNameOf(id));

/**
 * 把产物写到磁盘：先写同目录的临时文件，再改名。
 *
 * 直接覆盖目标文件的话，中断、磁盘写满或进程被杀都会在目标位置留下半截 JS —— 而那正是
 * `prepack` 之后会被发布出去的东西。同文件系统内的改名是原子的，磁盘上因此永远只有
 * 「上一份完整的」或「这一份完整的」。
 *
 * @param target - 产物路径
 * @param text - 产物全文
 */
function writeArtifact(target: string, text: string): void {
  const scratch = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(scratch, text, "utf8");
    renameSync(scratch, target);
  } catch (error) {
    rmSync(scratch, { force: true });
    throw error;
  }
}

/**
 * 生成 host.js 的完整文本。
 *
 * @returns 产物文本
 */
export async function buildHost(): Promise<string> {
  const bundle = await rolldown({
    input: path.join(root, "host.ts"),
    external: isExternal,
    platform: "node",
    resolve: { extensions: [".ts", ".mjs", ".js"] },
  });
  try {
    const { output } = await bundle.generate({ format: "esm", minify: true });
    // 只取第一块等于「其余代码静默消失」：产物照样能构建、过语法检查、装进 node_modules，
    // 直到某个函数在运行期变成 undefined 才暴露。宁可构建失败。
    const chunks = output.filter((item) => item.type === "chunk");
    if (chunks.length !== 1) {
      throw new Error(
        `expected exactly one chunk from rolldown, got ${chunks.length}; ` +
          "this build writes a single file and must not split the bundle",
      );
    }
    // 资产同样是「会静默消失」的输出：产物只写一个 JS 文件，多出来的 .css/.png 不会
    // 有人接着写盘，引用它的代码要等到运行期才炸。连非 chunk 输出一起拒。
    const extras = output.filter((item) => item.type !== "chunk");
    if (extras.length > 0) {
      throw new Error(
        `rolldown also emitted ${extras.length} non-chunk output(s) ` +
          `(${extras.map((item) => item.fileName).join(", ")}); ` +
          "this build writes a single file and must not drop assets",
      );
    }
    const [chunk] = chunks;
    if (chunk === undefined) {
      throw new Error("rolldown generate returned no chunk output");
    }
    // `//#region` 行的路径由 rolldown 按 process.cwd() 算出 ⇒ 同一份源码有两种字节
    // （cwd=包根 写 `lib/x.ts`，cwd=plugins/ 写 `<包名>/lib/x.ts`）。折成 canonical 必须
    // 落在返回值之前：新鲜度测试拿内存构建与磁盘产物逐字节比，只在一侧折就永远红。
    const code = canonicalizeRegionPaths(hoistStrictDirective(chunk.code), root);
    const banner =
      "// GENERATED by build-host.ts — edit host.ts / lib/*.ts, then run `node build-host.ts`.";
    // 指令前导：ESM 产物本来就在严格模式下，写出来是让这件事不取决于 bundler 的取舍。
    return `${banner}\n${STRICT_DIRECTIVE}\n${code}\n`;
  } finally {
    // bundle 持有 rolldown 的 worker 资源，不关的话进程未必立刻退出。
    await bundle.close();
  }
}

async function main(): Promise<void> {
  const out = await buildHost();
  writeArtifact(path.join(root, "host.js"), out);
  console.info("host.js written:", out.length, "chars");
}

if (invokedDirectly()) {
  // 这里用顶层 await：node/no-top-level-await 与本文件原本该满足的
  // unicorn/prefer-top-level-await 互斥，已在 oxlint.config.ts 里按「对侧互斥」
  // 记录了关掉哪一条。构建脚本只由 node 直接执行，不进 bundler 的 require(esm) 路径。
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
