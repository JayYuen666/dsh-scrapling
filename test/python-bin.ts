// test/python-bin.ts —— 测试侧 Python 解释器路径的单一来源。
//
// 路径由 `lib/runtime.ts` 的 `repoPythonPath` 算：POSIX 是 `bin/python`，Windows 是
// `Scripts/python.exe`（venv 只在那一边生成 .exe 入口）。插件解析与门禁读的是同一个函数，
// 门禁量到的就是插件真会拉起的那支解释器；`py-launcher.mjs` 那份 CLI 拼接由
// `test/py-launcher.test.ts` 拿 `--root` 对同一棵树比对，见该文件头部。

import path from "node:path";
import { repoPythonPath } from "../lib/runtime.ts";

const REPO = path.resolve(import.meta.dirname, "..");

/** 仓内 venv 解释器的绝对路径；只在 `_env/.venv` 已建好时存在（伞根 `pnpm py:setup`）。 */
export const LOCAL_PYTHON = repoPythonPath(REPO);
