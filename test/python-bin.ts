// test/python-bin.ts —— 测试侧 Python 解释器路径的单一来源。
//
// 用 venv 里不带版本后缀的那个名字：POSIX 是 `bin/python`，Windows 是 `Scripts/python.exe`
// （venv 只在那一边生成 .exe 入口）。`lib/runtime.ts` 的 repoPythonPath 与根
// `py-launcher.mjs` 解析的都是这一条，门禁量到的必须就是插件真会拉起的那支解释器。

import path from "node:path";

const VENV = path.resolve(import.meta.dirname, "..", "_env", ".venv");

/** 仓内 venv 解释器的绝对路径；只在 `_env/.venv` 已建好时存在（伞根 `pnpm py:setup`）。 */
export const LOCAL_PYTHON =
  process.platform === "win32"
    ? path.join(VENV, "Scripts", "python.exe")
    : path.join(VENV, "bin", "python");
