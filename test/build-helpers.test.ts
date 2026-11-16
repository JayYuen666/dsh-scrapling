// test/build-helpers.test.ts —— 构建小工具里那几条「判错方向就 fail-open」的分支。
//
// build-helpers.ts 不在 vitest 的 coverageInclude 名单里（那份名单收的是随包发布的运行期），
// 所以这里判的是行为而不是覆盖率。

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoHostPackageInlined,
  hoistStrictDirective,
  invokedDirectly,
  packageNameOf,
  readPackageJson,
  STRICT_DIRECTIVE,
  writeArtifact,
} from "../build-helpers.ts";

/** 摘掉指令之后剩下的那段正文，多条用例共用（重复字面量本身会被 lint 点名）。 */
const BODY = "var x = 1;";
/** 带 scope 的包名与它的子路径形态。 */
const SCOPED = "@scope/pkg";
const SCOPED_SUB = "@scope/pkg/sub";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-build-helpers-"));
  created.push(dir);
  return dir;
}

/**
 * 把 argv[1] 换成给定值，跑完立刻放回原值。
 *
 * `invokedDirectly` 读的是进程真实的 argv，所以「入口是谁」「路径解不解得开」这两条形态只能
 * 这样测，不能靠替身。
 *
 * @param entry - 这一次充当 `process.argv[1]` 的路径
 * @param run - 要跑的判定
 * @returns `run` 的结果
 */
function withArgv(entry: string, run: () => boolean): boolean {
  const [, previous] = process.argv;
  process.argv[1] = entry;
  try {
    return run();
  } finally {
    // 按 noUncheckedIndexedAccess 读出来是 `string | undefined`；空串与「没有入口」在这套
    // 判据里同义（`invokedDirectly` 对空串判否）。
    process.argv[1] = previous ?? "";
  }
}

describe("build-helpers", () => {
  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe("invokedDirectly", () => {
    it("字面相等时判真", () => {
      const file = path.join(tempDir(), "build-host.ts");
      writeFileSync(file, "", "utf8");
      expect(withArgv(file, () => invokedDirectly(file, `file://${file}`))).toBe(true);
    });

    /**
     * realpath 两条都解不开时抛错，而不是交回 false。
     *
     * 三个构建脚本用它当入口闸门（`if (invokedDirectly(…)) { await main(); }`）。交回 false 就是
     * 退出码 0、一个产物都不写，而 `prepack` 接着把磁盘上陈旧的那份发出去。
     */
    it("入口路径解不开时抛错并点名两个候选", () => {
      const missing = path.join(tempDir(), "gone", "build-host.ts");
      const other = path.join(tempDir(), "gone", "elsewhere.ts");
      const message = (): string => {
        try {
          withArgv(other, () => invokedDirectly(missing, `file://${missing}`));
        } catch (error: unknown) {
          return error instanceof Error ? error.message : String(error);
        }
        return "";
      };
      expect(message()).toContain("cannot resolve entry path");
      // 两个候选路径都要出现在报错里：只说「解不开」等于让人去猜是哪一侧的路径坏了。
      expect(message()).toContain(missing);
      expect(message()).toContain(other);
    });

    it("argv 里没有入口时判否（被 import 的正常路径）", () => {
      const fake = "/whatever/build-host.ts";
      expect(withArgv("", () => invokedDirectly(fake, `file://${fake}`))).toBe(false);
    });
  });

  describe("hoistStrictDirective", () => {
    it("指令在正文最前面时摘掉它", () => {
      expect(hoistStrictDirective(`${STRICT_DIRECTIVE}\n${BODY}`)).toBe(BODY);
    });

    it("单引号形态与不带分号都摘得掉", () => {
      expect(hoistStrictDirective(`'use strict'\n${BODY}`)).toBe(BODY);
      expect(hoistStrictDirective(`  "use strict"  \n${BODY}`)).toBe(BODY);
    });

    it("指令前面有注释时照样摘：注释不是语句，指令仍在指令前导位置", () => {
      expect(hoistStrictDirective(`// license banner\n${STRICT_DIRECTIVE}\n${BODY}`)).toBe(
        `// license banner\n${BODY}`,
      );
      expect(hoistStrictDirective(`/*! license\n   banner */${STRICT_DIRECTIVE}${BODY}`)).toBe(
        `/*! license\n   banner */${BODY}`,
      );
    });

    it("没有指令时原文一字不动地交回，license 注释不会被吃掉", () => {
      const code = '/*! keep me */\nvar x = 1;\n"use strict";\n';
      expect(hoistStrictDirective(code)).toBe(code);
    });

    it("整段只有注释时原样交回", () => {
      const code = "// only a comment";
      expect(hoistStrictDirective(code)).toBe(code);
    });

    it("严格模式指令被埋在别的指令之后时中止构建，而不是静默丢严格模式", () => {
      // 只认「第一条指令就是 use strict」时这里匹配为 null、原样交回，而调用方（hoistStrict）
      // 随后把 `var module` 排到函数体最前 —— 两条指令一起失去指令位，整份代码静默跑在非严格
      // 模式下，症状出现在运行期而不是构建期。宁可构建红。
      const code = `'use client';\n${STRICT_DIRECTIVE}\n${BODY}`;
      expect(() => hoistStrictDirective(code)).toThrow(/use strict.*不在第一条/u);
    });

    it("只有别的指令时原样交回（别把「有一条指令」当成「有严格模式」）", () => {
      const code = `'use client';\n${BODY}`;
      expect(hoistStrictDirective(code)).toBe(code);
    });

    it("严格模式指令出现在代码之后不算指令前导，原样交回", () => {
      const code = `${BODY}\n${STRICT_DIRECTIVE}`;
      expect(hoistStrictDirective(code)).toBe(code);
    });
  });

  describe("packageNameOf", () => {
    it.each([
      ["react", "react"],
      ["react/jsx-runtime", "react"],
      [SCOPED_SUB, SCOPED],
      [SCOPED, SCOPED],
    ])("%s → %s", (id, expected) => {
      expect(packageNameOf(id)).toBe(expected);
    });

    it.each([
      "./local",
      "../up",
      "/abs/path",
      "node:fs",
      "#internal/thing",
      String.raw`\0virtual:module`,
      // 盘符与 scheme 同样不是包名：判漏时 packageNameOf 会交出 `C:` / `https:` / `virtual:foo`
      // 这类伪包名，而文档承诺「不是 npm 裸说明符时是空串」。
      String.raw`C:\x\m.js`,
      "C:/x/m.js",
      "https://example.com/x.js",
      "virtual:foo",
    ])("不是裸说明符%s 交回空串，不冒充包名", (id) => {
      expect(packageNameOf(id)).toBe("");
    });

    it("带点号与短横的裸包名照旧认得（别把 scheme 判据写成吞掉一切冒号）", () => {
      const plain = "string-width";
      expect(packageNameOf("lodash.merge")).toBe("lodash.merge");
      expect(packageNameOf(plain)).toBe(plain);
      expect(packageNameOf(`${plain}/index.js`)).toBe(plain);
    });

    it("虚拟模块的 NUL 前缀同样交回空串", () => {
      expect(packageNameOf("\0virtual:module")).toBe("");
    });
  });

  describe("readPackageJson", () => {
    it("合法 JSON 读出对象", () => {
      const dir = tempDir();
      writeFileSync(path.join(dir, "package.json"), '{"name":"x"}', "utf8");
      expect(readPackageJson(dir)).toStrictEqual({ name: "x" });
    });

    it("坏 JSON 的报错点名是哪个文件", () => {
      const dir = tempDir();
      const file = path.join(dir, "package.json");
      writeFileSync(file, "{ not json", "utf8");
      let message = "";
      try {
        readPackageJson(dir);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      // monorepo 里包根不止一份 package.json，只给 `Unexpected token` 判断不了坏的是哪一份。
      expect(message).toContain(file);
      expect(message).toContain("is not valid JSON");
    });
  });

  describe("writeArtifact", () => {
    it("写成功后目标里是全文，同 target 的临时残留被回收", async () => {
      const dir = tempDir();
      const target = path.join(dir, "host.js");
      // 固定写一个「假想已死」的 pid 在不同机器上会得到不同结论：CI runner 上 999 常常
      // 是活进程（或被 `kill(pid, 0)` 的 EPERM 判成活着），而实现按设计保活件。起一个立刻
      // 退出的子进程、等它被回收后再用它的 pid：pid 复用的窗口远小于这一步调用。
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const deadPid = child.pid;
      if (deadPid === undefined) {
        throw new Error("起不到一个立刻退出的子进程，这条用例无法构造一个确定已死的 pid");
      }
      const [code] = (await once(child, "close")) as [number | null];
      if (code !== 0) {
        throw new Error(`子进程退出码是 ${String(code)}，构造不出干净退出的 pid`);
      }
      const stale = `${target}.tmp-${String(deadPid)}`;
      writeFileSync(stale, "stale", "utf8");
      writeArtifact(target, "fresh");
      expect(readFileSync(target, "utf8")).toBe("fresh");
      // 残留已经没了：读它会给出 ENOENT，而不是「文件还在但内容旧了」。
      expect(() => readFileSync(stale, "utf8")).toThrow(/ENOENT/u);
    });

    it("别的产物的临时件不受本次清理影响", () => {
      const dir = tempDir();
      const target = path.join(dir, "host.js");
      const foreign = path.join(dir, "client.js.tmp-1");
      writeFileSync(foreign, "someone else's scratch", "utf8");
      writeArtifact(target, "ok");
      expect(readFileSync(foreign, "utf8")).toBe("someone else's scratch");
    });

    it("本进程的临时件不删：那可能是同一次构建手里还没改名的份", () => {
      const dir = tempDir();
      const target = path.join(dir, "host.js");
      // 同一 pid 的临时件在并发构建里是「活件」，删了会让对方的 rename 抛 ENOENT。
      const mine = `${target}.tmp-${String(process.pid)}`;
      writeFileSync(mine, "in flight", "utf8");
      writeArtifact(target, "ok");
      expect(readFileSync(mine, "utf8")).toBe("in flight");
    });

    it("pid 还活着但 mtime 很旧的临时件照样回收（被复用的 pid 不该把残留钉住）", () => {
      const dir = tempDir();
      const target = path.join(dir, "host.js");
      // 用父进程的 pid：它一定活着，又不是本进程（本进程的会被上面那条判据保下来）。
      const stale = `${target}.tmp-${String(process.ppid)}`;
      writeFileSync(stale, "abandoned long ago", "utf8");
      const longAgo = new Date(Date.now() - 60 * 60_000);
      utimesSync(stale, longAgo, longAgo);
      writeArtifact(target, "ok");
      expect(() => readFileSync(stale, "utf8")).toThrow(/ENOENT/u);
    });

    it("还活着且刚写下的临时件不删（另一个构建正在用）", () => {
      const dir = tempDir();
      const target = path.join(dir, "host.js");
      const live = `${target}.tmp-${String(process.ppid)}`;
      writeFileSync(live, "someone else is building", "utf8");
      writeArtifact(target, "ok");
      expect(readFileSync(live, "utf8")).toBe("someone else is building");
    });

    it("同一进程连写两次不会撞名（临时件名带随机后缀）", () => {
      const dir = tempDir();
      const target = path.join(dir, "host.js");
      writeArtifact(target, "first");
      writeArtifact(target, "second");
      expect(readFileSync(target, "utf8")).toBe("second");
      // 两次写完目录里只剩目标本身：自己的临时件都被改名消耗掉了。
      expect(readdirSync(dir)).toStrictEqual(["host.js"]);
    });
  });
});

describe("assertNoHostPackageInlined", () => {
  it("rolldown 不再交回 moduleIds 时中止构建，而不是静默放行", () => {
    expect(() => {
      assertNoHostPackageInlined(undefined, "build-client");
    }).toThrow(/build-client: rolldown 没有交回 moduleIds/u);
  });

  it("宿主包被打进产物时点名是哪一份", () => {
    const ids = [
      "/repo/node_modules/.pnpm/@deepseek-ai+dsh-tools@0.2.2-alpha.2/node_modules/@deepseek-ai/dsh-tools/lib/index.js",
      "/repo/dsh-scrapling/lib/cli.ts",
    ];
    expect(() => {
      assertNoHostPackageInlined(ids, "build-host");
    }).toThrow(/1 个 @deepseek-ai\/\* 模块被打进产物/u);
  });

  it("本包源码与被收回外部化的 shared 都不算宿主包", () => {
    const ids = [
      "/repo/dsh-scrapling/host.ts",
      "/repo/dsh-scrapling/lib/installer.ts",
      "/repo/node_modules/.pnpm/@jayyuen66+dsh-plugin-shared@0.1.5/node_modules/@jayyuen66/dsh-plugin-shared/dist/lib/record.js",
    ];
    expect(() => {
      assertNoHostPackageInlined(ids, "build-host");
    }).not.toThrow();
  });
});
