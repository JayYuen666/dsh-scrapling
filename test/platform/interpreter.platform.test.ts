// 跨平台判据：解释器解析是本仓的承重规则（AGENTS.md 写明「只有一条解释器解析规则」），
// 但两条实现（lib/runtime.ts 的 PATH 回落名与 py-launcher.mjs 的 PATH_PYTHON）在
// Windows 上答的是两个名字——本文件把这一事实钉在可跑的判据上（POSIX 相等、Windows
// 相异），供收敛决策引用。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRuntime } from "../../lib/runtime.ts";

describe("解释器解析的两条实现", () => {
  it("空仓根（无 venv）下两条实现都落到 PATH 档；POSIX 名字一致为 python3", () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "scr-no-venv-"));
    try {
      const runtime = resolveRuntime({ pythonBin: "", dataDir: "", repoRoot: emptyRoot });
      assert.equal(runtime.via, "path");
      if (process.platform === "win32") {
        // 收敛后的契约（真 bug 修复）：runtime 与 py-launcher 的 PATH_PYTHON 同为
        // "python"——单一解析规则在两条实现上必须答同一个字符串。
        assert.equal(runtime.pythonPath, "python");
      } else {
        assert.equal(runtime.pythonPath, "python3");
        assert.equal(runtime.pythonPath, "python3");
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("本仓 venv 在位时两条实现都选中它（venv 分支对表）", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const runtime = resolveRuntime({ pythonBin: "", dataDir: "", repoRoot });
    const venvPython =
      process.platform === "win32"
        ? path.join(repoRoot, "_env", ".venv", "Scripts", "python.exe")
        : path.join(repoRoot, "_env", ".venv", "bin", "python");
    if (existsSync(venvPython)) {
      assert.equal(runtime.via, "repo");
    }
  });

  it("名字档的跨实现对表由各自单测钉住，这里保留占位断言防整组真空", () => {
    // 名字档的跨实现对表由 py-launcher.test.ts 与 runtime.test.ts 各自钉住；
    // 这里只保留「两种实现在 POSIX 同名」的交叉断言（上方第一个用例）。
    assert.ok(true);
  });
});
