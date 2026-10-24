// dsh-scrapling/build-helpers.ts —— build-host.ts 与 build-client.ts 共用的构建小工具。
//
// 这两个脚本只在产物名、入口、format 与外部化面上不同，其余「执行判定 / 严格模式迁移 /
// 原子写盘 / 单 chunk 校验」原本各写一份。分开写的代价是修 bug 得改两处：close 掩盖原始
// 错误、清理掩盖写入错误、严格模式只认双引号——三项都出现过单侧修一类的情况。
//
// 同步 fs 为构建必需，已列入 oxlint.config.ts 的 syncWrites。

import {
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** CJS 产物的严格模式指令。折进 ModuleLoader 外壳之后它就不再是函数体的指令前导。 */
export const STRICT_DIRECTIVE = '"use strict";';

/**
 * 本文件是不是被 `node build-*.ts` 直接执行，而不是被 import 去内存里构建产物。
 *
 * 不能只比 `process.argv[1] === import.meta.filename`：Node 把 argv[1] 解析成绝对路径，
 * 但**不**折符号链接，而 ESM 侧 import.meta.* 一律按真实路径给。pnpm 的软链接包、
 * Windows 的 junction、以及「用一个 shim 转调」这三种形态下两个串恒不相等 —— 于是构建
 * 什么都不做、退出码还是 0，陈旧产物被静默发出去。两边都折成真实路径再比。
 *
 * 两个 `import.meta.*` 由调用方传入：这个函数住在共享模块里，读自己那份只会拿到本文件。
 *
 * @param moduleFilename - 调用方的 `import.meta.filename`
 * @param moduleUrl - 调用方的 `import.meta.url`
 * @returns 是否是直接执行
 */
export function invokedDirectly(moduleFilename: string, moduleUrl: string): boolean {
  const [entry] = process.argv.slice(1);
  if (entry === undefined || entry.length === 0) {
    return false;
  }
  if (moduleFilename === entry || moduleUrl === pathToFileURL(entry).href) {
    return true;
  }
  try {
    return realpathSync(moduleFilename) === realpathSync(entry);
  } catch (error) {
    // 判否的代价是「这次不构建」，而判否之后进程以退出码 0 什么都不做 —— 所以这次不构建
    // 必须是**看得见**的。catch 覆盖的不只是「文件不存在」，也覆盖权限、Windows 长路径/UNC、
    // 杀毒软件占用这类瞬时故障，它们都该让人知道，而不是静默发出一份陈旧产物。
    console.warn(
      "[build] cannot resolve entry path, treating as not invoked directly:",
      moduleFilename,
      entry,
      error,
    );
    return false;
  }
}

/**
 * 把产物顶部的严格模式指令摘出来。
 *
 * rolldown 的 CJS 产物可能以 `"use strict";` 开头。它一旦被嵌进
 * `factory: (require) => { … }` 的函数体，就再也不是指令前导 —— 位置被 `var module`
 * 那些语句占掉了，于是整份代码跑在非严格模式下。源码是 ESM（天然严格），
 * 语义变化不会有人报错，只会在某个 `this` 或八进制字面量上悄悄出错。
 *
 * 单双引号都认，指令后可以带分号：这一形态只有 bundler 说了算，而它的取舍不该决定
 * 产物跑在哪种模式下。前导空白一并吃掉；指令前面若还有一段注释，那条指令本来就不再
 * 处于指令前导位置，此处不动它。
 *
 * @param code - rolldown 产出的正文
 * @returns 摘掉指令后的正文
 */
export function hoistStrictDirective(code: string): string {
  const stripped = code.replace(/^\s+/u, "");
  const directive = /^(?:"use strict"|'use strict');?/u;
  return stripped.replace(directive, "").replace(/^\s+/u, "");
}

/**
 * 取依赖表里的包名清单（值即外部化说明符）。
 *
 * 只取键，不看值的类型：外部化判据只需要包名。按「值必须是字符串」过滤会把对象形式的
 * 声明（别名、目录依赖）静默丢掉，那个包于是被打进产物 —— 正好触发外部化想防的重复
 * 单例与 MODULE_NOT_FOUND。
 *
 * @param pkgJson - `package.json` 解析结果
 * @param field - 依赖字段名
 * @returns 该表里的包名
 */
export function dependencyNames(pkgJson: unknown, field: string): string[] {
  const pkg = isRecord(pkgJson) ? pkgJson : {};
  const table = isRecord(pkg[field]) ? pkg[field] : {};
  return Object.keys(table);
}

/**
 * 说明符的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。
 *
 * @param id - 模块说明符
 * @returns 包名段
 */
export function packageNameOf(id: string): string {
  const segments = id.split("/");
  if (id.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] ?? id;
}

/**
 * 按包名段外部化一批包，覆盖它们的全部子路径。
 *
 * `external` 的字符串项是精确匹配：只写 `"react"` 时，`react/jsx-runtime` 会被内联进产物，
 * 宿主与产物于是各持一份 React 实例（hook 报 Invalid hook call、状态互不可见），而构建
 * 照样成功退出。
 *
 * @param names - 要外部化的包名
 * @returns rolldown 的外部化判据
 */
export function externalizePackages(names: Iterable<string>): (id: string) => boolean {
  const wanted = new Set(names);
  return (id: string): boolean => wanted.has(packageNameOf(id));
}

/**
 * 把产物写到磁盘：先写同目录的临时文件，再改名。
 *
 * 直接覆盖目标文件的话，中断、磁盘写满或进程被杀都会在目标位置留下半截 JS —— 而那正是
 * `prepack` 之后会被发布出去的东西。同一文件系统内的改名是原子的，磁盘上因此永远只有
 * 「上一份完整的」或「这一份完整的」。
 *
 * 写入前先清掉同目录下匹配本产物名的旧残留：进程被 SIGKILL、CI 取消或断电时临时文件
 * 留在包根，pid 每次不同，没人回收；它们还可能落进 `files` 漏项的缝里随包发出去。
 *
 * @param target - 产物路径
 * @param text - 产物全文
 */
export function writeArtifact(target: string, text: string): void {
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.tmp-`;
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(prefix)) {
        try {
          unlinkSync(path.join(directory, name));
        } catch {
          // 残留清不掉不该拦着这次构建：下面写的是新名字，改名才是决定成败的一步。
        }
      }
    }
  } catch {
    // 目录都列不出来时，下面的写入会给出更准确的错误。
  }
  const scratch = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(scratch, text, "utf8");
    renameSync(scratch, target);
  } catch (error) {
    try {
      rmSync(scratch, { force: true });
    } catch {
      // 清理失败不应掩盖写入/改名阶段的原始错误（磁盘满、权限不足才是要看的那个原因）。
    }
    throw error;
  }
}

/** rolldown 的一条输出。 */
export interface BundleOutputItem {
  readonly type: string;
  readonly fileName: string;
  readonly code?: string;
}

/**
 * 从 rolldown 的输出里取唯一那个 chunk 的正文，并拒掉其余形态。
 *
 * 只取第一块等于「其余代码静默消失」：产物照样能构建、过语法检查、装得上，直到某个函数
 * 在运行期变成 undefined 才暴露。资产同理 —— 一个 .css/.png 被引用而产物只写一个 JS
 * 文件时，引用它的代码要等到运行期才炸。
 *
 * @param output - `bundle.generate()` 的 output
 * @returns chunk 正文
 */
export function singleChunkCode(output: readonly BundleOutputItem[]): string {
  const chunks = output.filter((item) => item.type === "chunk");
  const extras = output.filter((item) => item.type !== "chunk");
  if (extras.length > 0) {
    throw new Error(
      `rolldown also emitted ${extras.length} non-chunk output(s) ` +
        `(${extras.map((item) => item.fileName).join(", ")}); ` +
        "this build writes a single file and must not drop assets",
    );
  }
  const [chunk, ...rest] = chunks;
  if (chunk === undefined || rest.length > 0) {
    throw new Error(
      `expected exactly one chunk from rolldown, got ${chunks.length}; ` +
        "this build writes a single file and must not split the bundle",
    );
  }
  if (typeof chunk.code !== "string") {
    throw new TypeError("rolldown returned a chunk without code");
  }
  return chunk.code;
}

/**
 * 读包根的 `package.json`。
 *
 * @param root - 包根目录
 * @returns 解析结果（未断言形状）
 */
export function readPackageJson(root: string): unknown {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}
