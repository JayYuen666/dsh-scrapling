// test/build-helpers.test.ts —— 构建小工具里那几条「判错方向就 fail-open」的分支。
//
// build-helpers.ts 不在 vitest 的 coverageInclude 名单里（那份名单收的是随包发布的运行期），
// 所以这里判的是行为而不是覆盖率。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    ])("不是裸说明符%s 交回空串，不冒充包名", (id) => {
      expect(packageNameOf(id)).toBe("");
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
    it("写成功后目标里是全文，同 target 的临时残留被回收", () => {
      const dir = tempDir();
      const target = path.join(dir, "host.js");
      const stale = `${target}.tmp-999`;
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
