// test/python-bin.ts —— 测试侧 Python 解释器路径的单一来源。
//
// 用 `bin/python`（不带版本后缀）而不是 `bin/python3`：host.ts 的 VENV_PYTHON、package.json
// 的 py / py:which 脚本解析的都是这一条，门禁量到的必须就是插件真会拉起的那支解释器。
// venv 布局保证 `bin/python` 与 `bin/python3` 同时存在，选哪个名字不改变行为，只改变
// 「这几处引用会不会各自漂移」。

import path from "node:path";

/** 仓内 venv 解释器的绝对路径；只在 `_env/.venv` 已建好时存在（伞根 `pnpm py:setup`）。 */
export const LOCAL_PYTHON = path.resolve(
  import.meta.dirname,
  "..",
  "_env",
  ".venv",
  "bin",
  "python",
);
