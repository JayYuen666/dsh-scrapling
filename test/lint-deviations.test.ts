// 本仓 lint 例外的自检：关规则的声明与关规则的理由必须是同一件事的两半。
//
// 「关了就必须有理由、note 不许为空」这一半由 shared 的 `assertOffsDocumented` 在配置装载时
// 强制，并由 shared 自己的用例钉着：删掉一条理由或把 note 掏空，下面那句 `import` 当场抛，
// 整个文件红成 `Tests no tests`，`pnpm lint` 同步红。这里不把它再写一遍 —— 在两个层各写
// 一遍同一条判断，将来只会有一边跟着实现走。
//
// 这里管装载门查不到的两件事：
// 1. 记在册的理由不许已经查无实据。规则被基线改掉、或那处写法被修好之后，留下的理由是一条
//    指不到任何地方的说明，而它比缺说明更容易骗过下一个人。
// 2. override 与 node/no-sync scope 点名的文件不许已经改名或消失。那样的块是永不生效的死配置，
//    读的人却会以为例外还在那几个文件上。
//
// 单行抑制（`oxlint-disable-next-line`）不在射程内：oxlint 自己会对「写了却没命中」报
// `Unused oxlint-disable directive`，它自带反向判据。
//
// `measured` 也不在这里复核：那要在用例里重做一遍配置、再跑一次 oxlint。复跑的动作写在
// `OFF_REASONS` 的头注释里，动过配置的人照着量一次。

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRA_OVERRIDES, OFF_REASONS, SYNC_IO_SCOPES } from "../oxlint.config.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** 本仓 override 里被关成 `off` 的规则名（同一条规则在两个文件块里各关一次算一个名字）。 */
function offRuleNames(): string[] {
  const names: string[] = [];
  for (const block of EXTRA_OVERRIDES) {
    // 档位在本文件里被 `satisfies` 收窄成了字面量 "off"；标成 string 是为了让下面那次比较
    // 在「有人把某条规则改成 error 收紧、而不是 off」时仍然有意义，而不是被类型判成永真。
    const rules: Record<string, string> = block.rules;
    for (const [rule, level] of Object.entries(rules)) {
      if (level === "off") {
        names.push(rule);
      }
    }
  }
  return names;
}

/** `files` 里的一个模式在本仓命中几个真实文件（目录不算命中）。 */
function countFiles(pattern: string): number {
  return fs
    .globSync(pattern, { cwd: repoRoot })
    .filter((hit) => fs.statSync(path.join(repoRoot, hit)).isFile()).length;
}

describe("lint 例外的登记表与实际配置", () => {
  it("记了理由的规则，配置里必须真的还有一处把它关着", () => {
    const stillOff = new Set(offRuleNames());
    const ungrounded = Object.keys(OFF_REASONS).filter((rule) => !stillOff.has(rule));
    expect(ungrounded).toStrictEqual([]);
  });

  it("override 与 node/no-sync 的 scope 点名的文件模式都还命中得到真实文件", () => {
    const patterns = [
      ...EXTRA_OVERRIDES.flatMap((block) => block.files),
      ...SYNC_IO_SCOPES.flatMap((scope) => scope.files),
    ];
    const dead = patterns.filter((pattern) => countFiles(pattern) === 0);
    expect(dead).toStrictEqual([]);
  });
});
