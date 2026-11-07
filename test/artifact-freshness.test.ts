// test/artifact-freshness.test.ts —— 三张被提交的产物必须等于当前源码的内存构建，且 client 的 外壳 可用。
//
// host.js / client.js / bin/dsh-scrapling.mjs 都随仓库走。`prepack` 在发布前会重建它们，所以
// 发出去的字节不会陈旧；会陈旧的是**仓库里那一份**：改完源码没重跑构建时，直接执行 bin 的人与
// review 看到的都是上一版的字节，而没有任何门禁会响。这里拿三个 build*() 的内存构建与磁盘文件
// 逐字节比（比整份文本而不是长度：region 路径折叠 canonicalizeRegionPaths 回退时字节会变，长度未必变）。
//
// 判据取内存构建而不是磁盘产物，与 test/build-signature.test.ts 头部是同一条理由。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { buildClient, clientModuleId } from "../build-client.ts";
import { buildCli } from "../build-cli.ts";
import { buildHost } from "../build-host.ts";

const root = path.resolve(import.meta.dirname, "..");

function disk(name: string): string {
  return readFileSync(path.join(root, name), "utf8");
}

/**
 * 两边一致时交回 null，不一致时交回一句点名的诊断。
 *
 * 判据本身是整份文本相等；诊断里带第一处不同的行号，是为了失败信息可读 —— 直接 toBe 比两份
 * 十几万字符的字符串会灌一屏 diff。
 *
 * @param generated - 内存构建的全文
 * @param committed - 仓库里那一份的全文
 * @param file - 产物路径（只进诊断文本）
 * @returns 诊断字符串，或 null
 */
function artifactDrift(generated: string, committed: string, file: string): string | null {
  if (generated === committed) {
    return null;
  }
  const generatedLines = generated.split("\n");
  const differing = committed
    .split("\n")
    .findIndex((text, index) => text !== generatedLines[index]);
  return `${file} 从第 ${String(differing + 1)} 行起与当前源码的构建结果不同：跑三条 build 脚本后把三张产物一起提交`;
}

describe("提交的产物与当前源码同步", () => {
  it("host.js 与内存构建逐字节一致", async () => {
    const generated = await buildHost();
    expect(artifactDrift(generated, disk("host.js"), "host.js")).toBeNull();
  });

  it("client.js 与内存构建逐字节一致", async () => {
    const generated = await buildClient();
    expect(artifactDrift(generated, disk("client.js"), "client.js")).toBeNull();
  });

  it("bin/dsh-scrapling.mjs 与内存构建逐字节一致", async () => {
    const generated = await buildCli();
    const file = path.join("bin", "dsh-scrapling.mjs");
    expect(artifactDrift(generated, disk(file), file)).toBeNull();
  });
});

interface LoadedModule {
  readonly id: string;
  readonly factory: (require: (spec: string) => unknown) => Record<string, unknown>;
}

/** Proxy 的目标必须可调用才容得下 apply 陷阱；这条函数本身永远不会被跑到。 */
function stubTarget(): void {
  throw new TypeError("client 替身的目标函数不该被直接调用");
}

/**
 * 宿主在客户端侧提供的模块替身：属性访问与调用都回到替身本身。
 *
 * 每次递归都新建一份，避免「proxy 在自己的初始化式里引用自己」这种 TS 推不出类型的写法。
 * 本用例只看 外壳 能不能跑出一份带 apply/inject 的 exports，不看卡片行为——卡片的渲染在
 * happy-dom 那一层（见 vitest.config.ts 里 coverageInclude 的注释）。
 */
function stubModule(): () => void {
  return new Proxy(stubTarget, {
    get: (object: typeof stubTarget, key: string | symbol): unknown =>
      typeof key === "symbol" || key in object ? Reflect.get(object, key) : stubModule(),
    apply: () => stubModule(),
  });
}

/**
 * 在只给了 window 的新上下文里跑一次产物文本，取 外壳 注册进来的那一个模块。
 *
 * 被测对象本身就是「交给宿主 ModuleLoader 求值的一段脚本」（build-client.ts 文件头写了这条
 * 契约），除了求值没有别的读法；上下文里除了 fakeWindow 没有任何全局，也不给它 require 的
 * 能力。文本来自本进程的 buildClient()，不是外部输入。
 *
 * @param code - client 产物全文
 * @returns 外壳 注册的那一个模块
 */
function loadClientModule(code: string): LoadedModule {
  const loaded: LoadedModule[] = [];
  const fakeWindow = { __ModuleLoader__: { load: (mod: LoadedModule) => loaded.push(mod) } };
  runInNewContext(code, { window: fakeWindow });
  const [first, ...extra] = loaded;
  if (first === undefined || extra.length > 0) {
    throw new Error(`外壳 应当只 load 一个模块，实际 ${String(loaded.length)} 个`);
  }
  return first;
}

describe("client.js 的 ModuleLoader 外壳", () => {
  it("外壳 只 load 一个模块，id 与 package.json 的 name 逐字相同", async () => {
    const code = await buildClient();
    const { name } = JSON.parse(disk("package.json")) as { name: string };
    expect(loadClientModule(code).id).toBe(name);
  });

  it("factory 体的第一条语句是严格模式指令（被包进 外壳 后放回原位）", async () => {
    const code = await buildClient();
    expect(code).toMatch(/factory: \(require\) => \{\n\s*"use strict";/u);
  });

  it("产物运行期只解析平台模块（其余依赖一律内联）", async () => {
    const code = await buildClient();
    const specs = Array.from(
      code.matchAll(/require\("(?<spec>[^"]+)"\)/gu),
      (match) => match.groups?.["spec"] ?? "",
    );
    // shared 的客户端代码已收回内联（dsh-ocr-review 仓 issue #2：对它的外部化请求要靠
    // 另一份包被装载成模块表条目才兑现，传递依赖安装形状下宿主可能不排进启动图）。
    expect([...new Set(specs)].toSorted()).toStrictEqual(["react", "zod"]);
  });

  it("用假 require 执行 factory 后，exports 上是可运行的 apply 与宿主装配清单 inject", async () => {
    const code = await buildClient();
    const exports = loadClientModule(code).factory(() => stubModule());
    // 导出名清单按 src/client-entry.ts 当场实测独立写死：产物少导出一位，宿主按名字取就拿到 undefined。
    expect(Object.keys(exports).toSorted()).toStrictEqual([
      "ROW_TOOLS",
      "apply",
      "buildRow",
      "inject",
      "readArgs",
      "resultMetaOf",
    ]);
    expect(exports["apply"]).toBeTypeOf("function");
    // inject 是宿主用来装配注入的清单（src/client-entry.ts 里的字面量），不是函数。
    // 先按可迭代对象取出来再比：factory 在 node:vm 的新上下文里跑，产出的数组不是本上下文的
    // Array 实例，直接 toStrictEqual 会因为「不是同一个类」判不等，而值本身逐位相同。
    const inject = exports["inject"] as Iterable<unknown>;
    expect([...inject]).toStrictEqual(["slots", "configForms", "locale"]);
  });
});

const created: string[] = [];

/** 造一个只放着指定 package.json 的临时包根；`{ name: undefined }` 序列化出来就是 `{}`。 */
function tempPackageRoot(text: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-client-name-"));
  created.push(dir);
  writeFileSync(path.join(dir, "package.json"), text, "utf8");
  return dir;
}

function tempPackageWithName(name: unknown): string {
  return tempPackageRoot(JSON.stringify({ name }));
}

describe("clientModuleId（外壳 id 的判据）", () => {
  afterAll(() => {
    for (const dir of created) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("name 只有空白时点名，而不是拼出一个 id 带空格的 外壳", () => {
    expect(() => {
      clientModuleId(tempPackageWithName("   "));
    }).toThrow(/missing a non-empty `name`/u);
  });

  it("name 两侧的空白去掉之后才是 外壳 id", () => {
    expect(clientModuleId(tempPackageWithName(" @scope/pkg "))).toBe("@scope/pkg");
  });

  it("name 缺失时点名，而不是回退占位符", () => {
    expect(() => {
      clientModuleId(tempPackageWithName(undefined));
    }).toThrow(/missing a non-empty `name`/u);
  });

  it("package.json 不是合法 JSON 时报错里带着是哪一份文件", () => {
    // 读的是原文而不是 JSON.stringify 的结果：字符串字面量本身是合法 JSON，
    // 拿 stringify 造出来的「坏 JSON」会被解析成一个字符串，测不到要测的那条分支。
    expect(() => {
      clientModuleId(tempPackageRoot("{ not json"));
    }).toThrow(/is not valid JSON/u);
  });
});
