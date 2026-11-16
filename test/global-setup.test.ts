// test/global-setup.ts 的理由层单测 —— 整套件唯一的 fail-closed 机制在这里被钉住。
//
// 这个文件不在覆盖率分母里（`vitest.config.ts` 的 `coverageInclude` 只有 host.ts / lib 与 src
// 那两枚），而它管的是「解释器不可用就把门禁顶红」。只靠现场跑一遍「解释器在」的那条路，
// 改错分支条件、把 errno 全说成「不存在」、或误删同步写 stderr 都不会红。

import { describe, expect, it } from "vitest";
import { interpreterRefusal } from "./global-setup.ts";

const TARGET = "/tmp/dsh-scrapling-test/_env/.venv/bin/python";

/** 一份「是普通文件 / 不是普通文件」的最小 Stats 替身：本文件只读 isFile 这一位。 */
function statsOf(isFile: boolean): { isFile: () => boolean } {
  return { isFile: () => isFile };
}

/** 造一个带 errno 的抛错值（Node 的 fs 错误就是这样带 code 的）。 */
function errnoOf(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: mocked`), { code });
}

describe("interpreterRefusal", () => {
  it("statSync 抛 ENOENT 时说「不存在」", () => {
    const refusal = interpreterRefusal(undefined, errnoOf("ENOENT"), "darwin", TARGET);
    expect(refusal).toBe(`缺少探针解释器：${TARGET} 不存在。`);
  });

  it("statSync 抛的不是 ENOENT 时点名 errno，而不是教人去重建 venv", () => {
    const refusal = interpreterRefusal(undefined, errnoOf("EACCES"), "darwin", TARGET);
    expect(refusal).toContain("EACCES");
    expect(refusal).toContain("读不到");
    expect(refusal).not.toContain("不存在");
  });

  it("拿不到 errno 时按「不存在」处理：那时没有更多可说的", () => {
    expect(interpreterRefusal(undefined, "boom", "darwin", TARGET)).toBe(
      `缺少探针解释器：${TARGET} 不存在。`,
    );
    expect(interpreterRefusal(undefined, null, "darwin", TARGET)).toBe(
      `缺少探针解释器：${TARGET} 不存在。`,
    );
  });

  it("同名目录不算解释器（POSIX 上目录常带可执行位）", () => {
    const refusal = interpreterRefusal(statsOf(false), undefined, "darwin", TARGET);
    expect(refusal).toBe(
      `探针解释器不是一个普通文件：${TARGET}（目录与指向目录的符号链接都不算）。`,
    );
  });

  it("是普通文件、路径其实不存在（accessSync 抛 ENOENT）时点名不可执行", () => {
    const refusal = interpreterRefusal(statsOf(true), undefined, "darwin", TARGET);
    expect(refusal).toBe(`探针解释器不可执行：${TARGET} 没有可执行位（这是坏掉的机器本地态）。`);
  });

  it("win32 不判可执行位：那边 X_OK 等同 F_OK", () => {
    expect(interpreterRefusal(statsOf(true), undefined, "win32", TARGET)).toBeUndefined();
  });
});
