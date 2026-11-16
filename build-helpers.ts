// dsh-scrapling/build-helpers.ts —— build-host.ts、build-client.ts 与 build-cli.ts 共用的构建小工具。
//
// 这三个脚本只在产物名、入口、format 与外部化上不同，其余「执行判定 / 打包形状 / 严格模式迁移 /
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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { canonicalizeRegionPaths } from "@jayyuen66/dsh-plugin-shared/lib/canonicalize-region-paths";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** CJS 产物的严格模式指令。折进 ModuleLoader 外壳 之后它就不再是函数体的指令前导。 */
export const STRICT_DIRECTIVE = '"use strict";';

/**
 * 临时件被判成「没人要的残留」所需的年龄。
 *
 * pid 判据之外的第二道：容器里 pid 复用比宿主机快得多，一个被复用的 pid 会让残留看上去
 * 「还活着」。一次构建里写临时件到改名的间隔是毫秒级，所以十分钟足够长 —— 它比任何一次
 * 真构建的写盘窗口都大，又比「第二天重跑构建」短。
 */
const ABANDONED_SCRATCH_MS = 10 * 60_000;

/**
 * 本文件是不是被 `node build-*.ts` 直接执行，而不是被 import 去内存里构建产物。
 *
 * 不能只比 `process.argv[1] === import.meta.filename`：Node 把 argv[1] 解析成绝对路径，
 * 但**不**折符号链接，而 ESM 侧 import.meta.* 一律按真实路径给。pnpm 的软链接包、
 * Windows 的 junction、以及「用一个 shim 转调」这三种形态下两个串恒不相等 —— 于是构建
 * 什么都不做、退出码还是 0，陈旧产物被静默发出去。两边都折成真实路径再比。
 *
 * 两个 `import.meta.*` 由调用方传入：这个函数定义在共享模块里，读自己那份只会拿到本文件。
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
    // 走到这里说明「这次是不是入口」已经没有答案了：两个候选路径都解不开。替它猜一个
    // 就是 fail-open —— 三个构建脚本都用 `if (invokedDirectly(…)) { await main(); }` 当闸门，
    // 交回 false 意味着退出码 0、一个产物都不写，而 `prepack` 接着把磁盘上陈旧的那份发出去。
    // 覆盖这一支的不只是「文件不存在」：权限、Windows 长路径与 UNC、杀毒软件瞬时占用都会
    // 从 realpath 里抛出来，它们都是瞬时故障而不是「这不是入口」的证据。
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[build] cannot resolve entry path, refusing to guess: ${moduleFilename} vs ${entry}: ${reason}`,
      { cause: error },
    );
  }
}

/**
 * 跳过开头的空白与整段注释，返回第一处真正是代码的下标。
 *
 * 注释不是语句，所以「一行 license banner 之后紧跟 `"use strict";`」这种正文里，那条指令
 * **仍然**处于指令前导位置：判指令在不在前导，要按去掉注释与空白之后的正文看，
 * 不能按字符串的第一个字符看。
 *
 * @param code - 原始正文
 * @returns 第一处代码的下标；整段都是空白或注释时交回 `code.length`
 */
function codeStart(code: string): number {
  let index = 0;
  let moved = true;
  while (moved) {
    moved = false;
    while (index < code.length && /\s/u.test(code.charAt(index))) {
      index += 1;
      moved = true;
    }
    if (code.startsWith("//", index)) {
      const end = code.indexOf("\n", index);
      index = end === -1 ? code.length : end + 1;
      moved = true;
    } else if (code.startsWith("/*", index)) {
      const end = code.indexOf("*/", index);
      index = end === -1 ? code.length : end + 2;
      moved = true;
    }
  }
  return index;
}

/**
 * 产物顶部的一条指令语句：带引号的字面量，可以被空白包着、可以带结尾分号。
 *
 * `y`（sticky）让它只在 `lastIndex` 处匹配 —— 读前导时逐条推进，不匹配就停，
 * 不必自己写「跳空白 / 跳引号 / 跳转义 / 跳分号」那四段循环。
 */
const DIRECTIVE_STATEMENT =
  /\s*(?:"(?<double>(?:[^"\\]|\\.)*)"|'(?<single>(?:[^'\\]|\\.)*)')\s*;?/uy;

/**
 * 读产物顶部的指令前导：从 `start` 起连续的那些字符串字面量语句。
 *
 * @param code - 原始正文
 * @param start - `codeStart(code)`
 * @returns 各条指令的字面量内容（按出现顺序）
 */
function directivePrologue(code: string, start: number): string[] {
  const directives: string[] = [];
  DIRECTIVE_STATEMENT.lastIndex = start;
  let match = DIRECTIVE_STATEMENT.exec(code);
  while (match !== null) {
    const { double, single } = match.groups ?? {};
    directives.push(double ?? single ?? "");
    match = DIRECTIVE_STATEMENT.exec(code);
  }
  // 最后那次失败匹配会把 lastIndex 留在原地；下一次调用是重新赋值起点，所以不必复位。
  return directives;
}

/**
 * 摘不到指令时，确认产物顶部**没有**一条被埋在别的指令之后的严格模式指令。
 *
 * 只认「第一条指令就是 `"use strict"`」是不够的：产物开头若是 `'use client';` 再跟
 * `"use strict";`（rolldown 保留多条指令，或源码将来加 directive），`hoistStrictDirective`
 * 里那段正则匹配为 null、原样交回，而调用方（`hoistStrict: true`）随后把 `var module` 排在
 * 函数体最前 —— 于是**两条**指令一起失去指令位，整份代码静默跑在非严格模式下。这正是本函数
 * 注释里说要避免的那类失败，而它的症状出现在运行期（某个 `this`、八进制字面量、重复参数名）
 * 而不是构建期。宁可构建红。
 *
 * @param code - 原始正文
 * @param start - `codeStart(code)`
 * @throws Error - 指令前导里含 `"use strict"` 但它不是第一条
 */
function assertNoBuriedStrictDirective(code: string, start: number): void {
  const prologue = directivePrologue(code, start);
  if (!prologue.includes("use strict")) {
    return;
  }
  throw new Error(
    `[build] 产物顶部的指令前导是 ${JSON.stringify(prologue)}：其中的 "use strict" 不在第一条，` +
      "摘不出来，折进 外壳 之后会整份跑在非严格模式下。先把严格模式指令放到第一条，或调整外壳。",
  );
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
 * 产物跑在哪种模式下。指令前面的空白与注释一并跳过（见 `codeStart`），摘完之后
 * 那些注释原样留着 —— license banner 是要随产物发出去的东西。
 *
 * @param code - rolldown 产出的正文
 * @returns 摘掉指令后的正文
 * @throws Error - 指令前导里含 `"use strict"` 但它不是第一条（摘不出来，折进 外壳 会静默丢严格模式）
 */
export function hoistStrictDirective(code: string): string {
  const start = codeStart(code);
  const directive = /^(?:"use strict"|'use strict');?/u;
  const match = directive.exec(code.slice(start));
  if (match === null) {
    assertNoBuriedStrictDirective(code, start);
    return code;
  }
  const [found = ""] = match;
  const prefix = code.slice(0, start);
  // 指令后面紧跟的那一段空白一起摘掉：旧写法也是这么收的，留着会在 外壳 里多出一个空行。
  const after = code.slice(start + found.length).replace(/^\s+/u, "");
  // 前导只有空白时一并丢掉（与旧写法一致）；带注释的前导要留着，license banner 是
  // 要随产物发出去的东西。
  return /^\s*$/u.test(prefix) ? after : `${prefix}${after}`;
}

/**
 * 取依赖表里的包名清单（返回值即外部化用的说明符）。
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
 * 非裸说明符的开头：相对路径、绝对路径、`node:` 内置、`#` 私有映射、虚拟模块的前缀字节，
 * 以及盘符（`C:\x` / `C:/x`）与带 scheme 的 URL（`https://…`、`virtual:foo`）。
 *
 * 盘符与 scheme 不在里面时 `packageNameOf` 会把它们当包名段交出去（`C:`、`https:`、`virtual:foo`），
 * 与上面「不是 npm 裸说明符时是空串」的承诺相反。当前唯一调用方拿依赖表判否，所以行为碰巧对；
 * 但这个函数被文档描述成可供「白名单外一律外部化」一类调用方使用，伪包名会让那类判据误判。
 */
const NOT_A_PACKAGE_SPECIFIER = /^(?:[./\\#\0]|node:|[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:)/u;

/**
 * 说明符的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。
 *
 * 相对 / 绝对 / `node:` / `#` / `\0` 开头的说明符不是任何 npm 包，按 `/` 切第一段会得到
 * `.`、`..`、空串或整串 `node:fs` —— 那些值都不会出现在依赖表里，判否是碰巧对了，但读代码的人
 * （和将来拿它做「白名单外一律外部化」的人）会以为子路径已经被覆盖。这里显式交回空串：
 * 空串不是包名，`externalizePackages` 的名单里也永远不会有它。
 *
 * @param id -说明符
 * @returns 包名段；不是 npm裸说明符时是空串
 */
export function packageNameOf(id: string): string {
  if (NOT_A_PACKAGE_SPECIFIER.test(id)) {
    return "";
  }
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
 * 从临时件名里取 pid：`host.js.tmp-<pid>` 或 `host.js.tmp-<pid>-<uuid>`。
 *
 * 取不到时交 `NaN`（不是 `undefined`）：这里只有一个返回类型，调用点的判据也就只有一条
 * `Number.isNaN`，不必再分别处理「没有 pid」与「pid 不是数字」两种空值。
 *
 * @param name - 文件名
 * @returns pid；名字里没有可读的 pid 时是 `NaN`
 */
function scratchPidOf(name: string): number {
  const raw = /\.tmp-(?<pid>\d+)(?:-|$)/u.exec(name)?.groups?.["pid"];
  return raw === undefined ? Number.NaN : Math.trunc(Number(raw));
}

/**
 * 判一个进程还在不在。
 *
 * `kill(pid, 0)` 不投递信号，只做存在性与权限检查：`ESRCH` 说明没了，`EPERM` 说明还在
 * （只是不归我们管）。
 *
 * @param pid - 进程号
 * @returns 是否还活着
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error["code"] === "EPERM";
  }
}

/**
 * 判断一个临时件是不是「没人要的残留」，而不是另一个正在跑的构建手里的那一份。
 *
 * 三条判据，任一成立就算残留：文件名里根本没有 pid（老版本留下的、或不是本函数写的）、
 * pid 已经不在了（同一台机器上 pid 复用窗口远小于构建间隔）、或 mtime 早于
 * `ABANDONED_SCRATCH_MS`。pid 相同的一律当活件：那是本次构建自己（或同一进程的另一次构建）的。
 *
 * @param directory - 临时件所在目录
 * @param name - 临时件文件名
 * @returns 是否可以安全删掉
 */
function isAbandonedScratch(directory: string, name: string): boolean {
  const pid = scratchPidOf(name);
  if (Number.isNaN(pid)) {
    // 名字里没有可读的 pid：老版本留下的（它们用 `${target}.tmp-${pid}` 之前的形态），
    // 没有别的办法判它是不是活的，按残留处理。
    return true;
  }
  if (pid === process.pid) {
    return false;
  }
  if (!isProcessAlive(pid)) {
    return true;
  }
  try {
    return Date.now() - statSync(path.join(directory, name)).mtimeMs > ABANDONED_SCRATCH_MS;
  } catch {
    // 读不到 stat：它刚刚被别人删掉或挪走，当作残留（下一次 unlink 会自己再判一次）。
    return true;
  }
}

/**
 * 把产物写到磁盘：先写同目录的临时文件，再改名。
 *
 * 直接覆盖目标文件的话，中断、磁盘写满或进程被杀都会在目标位置留下半截 JS —— 而那正是
 * `prepack` 之后会被发布出去的东西。同一文件系统内的改名是原子的，所以**读者**看到的要么
 * 是上一份、要么是这一份，不会读到半截。这里不承诺掉电之后的持久性：没有 fsync，写回缓存里
 * 的数据块可能比目录项晚写到磁盘；构建产物每次 `build` 都整份重写，值得省的是构建时间而不是这次
 * 写到磁盘的同步，真要断电恢复的语义属于数据文件，不属于产物。
 *
 * 写入前先清掉同目录下匹配本产物名的旧残留：进程被 SIGKILL、CI 取消时临时文件留在包根，
 * pid 每次不同，没人回收；它们还可能落进 `files` 漏项的缝里随包发出去。
 *
 * 清理只动**比本次构建更早**的残留（见 `isAbandonedScratch`）：一口气删掉所有匹配项的话，
 * 两个并行构建会互相拆台 —— 进程 A 刚写完 `${target}.tmp-${pidA}` 准备改名，进程 B 的清理把它
 * unlink 掉，A 的 `renameSync` 于是抛 ENOENT。那一次构建本来是会成功的（后写者胜），现在直接
 * 失败，且报错指向 rename 而不是清理。
 *
 * @param target - 产物路径
 * @param text - 产物全文
 */
export function writeArtifact(target: string, text: string): void {
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.tmp-`;
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(prefix) && isAbandonedScratch(directory, name)) {
        try {
          // 残留清不掉不该拦着这次构建：下面写的是新名字，改名才是决定成败的一步。
          unlinkSync(path.join(directory, name));
        } catch {
          // 同上：忽略。
        }
      }
    }
  } catch {
    // 目录都列不出来时，下面的写入会给出更准确的错误。
  }
  const scratch = `${target}.tmp-${process.pid}-${randomUUID()}`;
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
  /** 这个 chunk 实际打进来哪些模块（解析后的真实路径）。宿主包内联的判据读它。 */
  readonly moduleIds?: readonly string[];
}

/**
 * 从 rolldown 的输出里取唯一那个 chunk，并拒掉其余形态。
 *
 * 只取第一块等于「其余代码静默消失」：产物照样能构建、过语法检查、装得上，直到某个函数
 * 在运行期变成 undefined 才暴露。资产同理 —— 一个 .css/.png 被引用而产物只写一个 JS
 * 文件时，引用它的代码要等到运行期才炸。
 *
 * 交回的是**整块**（含 `moduleIds`）而不是正文：调用方要拿它判「宿主包有没有被内联」，
 * 而那个判据必须跑在这条唯一性校验**之后** —— 反过来的话，`output` 里一个 chunk 都没有
 * （或只有资产）时，先跑内联判据会拿到 `undefined` 的 `moduleIds`，报出「rolldown 没交回
 * moduleIds」，把排查引向一个完全无关的方向。
 *
 * @param output - `bundle.generate()` 的 output
 * @returns 唯一那个 chunk
 */
export function singleChunk(output: readonly BundleOutputItem[]): BundleOutputItem {
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
  return chunk;
}

/**
 * 从 rolldown 的输出里取唯一那个 chunk 的正文。
 *
 * @param output - `bundle.generate()` 的 output
 * @returns chunk 正文
 */
export function singleChunkCode(output: readonly BundleOutputItem[]): string {
  const { code } = singleChunk(output);
  if (typeof code !== "string") {
    throw new TypeError("rolldown returned a chunk without code");
  }
  return code;
}

/**
 * 读包根的 `package.json`。
 *
 * `JSON.parse` 的原生报错只有 `Unexpected token …` 这类片段，不带是哪个文件；pnpm 工作区里
 * 包根不止一份，光看那一行判断不了坏掉的是哪一份。所以把路径与原因一起抛出去。
 *
 * @param root - 包根目录
 * @returns 解析结果（未断言形状）
 * @throws Error - 文件不是合法 JSON，报错里带绝对路径
 */
export function readPackageJson(root: string): unknown {
  const file = path.join(root, "package.json");
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} is not valid JSON: ${reason}`, { cause: error });
  }
}

/**
 * 模块路径里的宿主包段：`.pnpm/@deepseek-ai+dsh-tools@…` 与 `…/node_modules/@deepseek-ai/dsh-tools/…`
 * 两种形态都算，读的是解析后的真实路径而不是说明符。
 */
const HOST_PACKAGE_SEGMENT = /@deepseek-ai[+/]/u;

/**
 * 拒掉「宿主包被内联进产物」。
 *
 * 三张产物都按包名段外部化 `@deepseek-ai/*`，靠的是「宿主提供单例」这条前提：内联一份就得到
 * 第二个模块实例，而宿主侧那些 Symbol（例如 dsh-tools 的 TOOL_RUNTIME_SCHEDULER 是普通
 * Symbol，不是 Symbol.for）按实例计算身份，症状是宿主拿自己那份符号去读副本挂出来的对象，
 * 得到 undefined，而构建照样成功退出。外部化清单一旦漏项（新增一条宿主 import 而没进依赖表），
 * 只有这一条判据能在构建期点名。
 *
 * rolldown 不再交回 moduleIds 时这里**抛错而不是静默放行**：那条判据从此量不到东西，
 * 判定通过就是误判通过。
 *
 * @param moduleIds - chunk 的 moduleIds
 * @param label - 出错文本里指名的产物
 */
export function assertNoHostPackageInlined(
  moduleIds: readonly string[] | undefined,
  label: string,
): void {
  if (moduleIds === undefined) {
    throw new Error(
      `${label}: rolldown 没有交回 moduleIds，无法判宿主包有没有被内联（外部化判据失效，构建中止）`,
    );
  }
  const inlined = moduleIds.filter((id) => HOST_PACKAGE_SEGMENT.test(id));
  if (inlined.length > 0) {
    throw new Error(
      `${label}: ${String(inlined.length)} 个 @deepseek-ai/* 模块被打进产物而不是外部化，` +
        `宿主单例会变成第二份实例。首个：${inlined[0] ?? ""}`,
    );
  }
}

/** 一次打包的输入参数；三张产物只在这些参数上不同。 */
export interface BundlePlan {
  /** 包根（region 路径折叠 canonicalizeRegionPaths 按它算）。 */
  readonly root: string;
  /** rolldown 的入口。 */
  readonly input: string;
  /** 出错与日志里指名的产物名。 */
  readonly label: string;
  readonly platform: "node" | "browser";
  readonly format: "esm" | "cjs";
  readonly minify: boolean | { readonly compress: boolean; readonly mangle: boolean };
  readonly extensions: readonly string[];
  readonly external: (id: string) => boolean;
  /**
   * 严格模式指令要不要摘出来：嵌进 ModuleLoader 外壳 的 CJS 必须摘（否则它不再是函数体的
   * 第一条语句），直接执行的 ESM 本来就还在指令位。
   */
  readonly hoistStrict: boolean;
}

/**
 * 「rolldown 打包 → 单 chunk 校验 → 宿主包内联判据 → 严格模式迁移 → region 路径折叠 → 关
 * bundle」这一段的共同形状。
 *
 * 顺序是承重的：唯一性校验必须在最前（`singleChunk` 把 chunk 定形），内联判据随后（它读
 * `moduleIds`，而那个字段只在那唯一一块上有意义），严格模式迁移与 region 折叠最后
 * （两者都只改正文）。倒过来时「一个 chunk 都没有」会先报成「rolldown 没交回 moduleIds」。
 *
 * 三个构建脚本原先各写一份，`build-helpers.ts` 头部记的那类单侧修 bug（close 掩盖原始错误、
 * 清理掩盖写入错误、严格模式只认双引号）就是这种形状的直接后果；banner、外壳 与写盘仍归各脚本。
 *
 * region 路径折叠落在这里而不是各脚本：`//#region` 行的路径由 rolldown 按 `process.cwd()` 算出
 * ⇒ 同一份源码有两种字节（cwd=包根 写 `lib/x.ts`，cwd=上一层 写 `<包名>/lib/x.ts`），而
 * `test/artifact-freshness.test.ts` 拿内存构建与磁盘产物逐字节比 —— 只在一侧折就永远红。
 *
 * @param plan - 打包输入参数
 * @returns 折叠过 region 路径的 chunk 正文
 */
export async function bundleChunkText(plan: BundlePlan): Promise<string> {
  const bundle = await rolldown({
    input: plan.input,
    external: plan.external,
    platform: plan.platform,
    resolve: { extensions: [...plan.extensions] },
  });
  try {
    const { output } = await bundle.generate({ format: plan.format, minify: plan.minify });
    // 先定形：唯一性/资产判据跑在内联判据之前。顺序反过来时，`output` 里一个 chunk 都没有的
    // 情况会先撞上「没交回 moduleIds」，报错指向 rolldown 而不是「got 0 / 多余资产」。
    const chunk = singleChunk(output);
    assertNoHostPackageInlined(chunk.moduleIds, plan.label);
    const { code } = chunk;
    if (typeof code !== "string") {
      throw new TypeError("rolldown returned a chunk without code");
    }
    return canonicalizeRegionPaths(
      plan.hoistStrict ? hoistStrictDirective(code) : code,
      plan.root,
      process.cwd(),
    );
  } finally {
    // bundle 持有 rolldown 的 worker 资源，不关的话进程未必立刻退出。
    // close 自己失败不该顶掉 generate/校验阶段的原始错误（finally 的异常会成为最终异常）。
    await bundle.close().catch((closeError: unknown) => {
      console.error(`[${plan.label}] failed to close rolldown bundle:`, closeError);
    });
  }
}
