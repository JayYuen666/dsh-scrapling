// test/python-bin.ts —— 测试侧 Python 解释器路径的单一来源。
//
// 路径由 `lib/runtime.ts` 的 `repoPythonPath` 算：POSIX 是 `bin/python`，Windows 是
// `Scripts/python.exe`（venv 只在那一边生成 .exe 入口）。插件解析与门禁读的是同一个函数，
// 门禁量到的就是插件真会拉起的那支解释器。
//
// 「单一来源」是**这份文件要守住的目标**，不是既成事实：`test/py-launcher.test.ts` 的
// 「三处解析对同一棵树给出同一支」拿独立写死的布局常量（`VENV_DIR` / `VENV_EXE`）跟这里的
// 输出对齐，`test/e2e/byte-pipe.e2e.test.ts` 与 `test/platform/interpreter.platform.test.ts`
// 也都 import 本文件而不是自己拼 `_env/.venv/...`。改布局时只有 `repoPythonPath` 一处要动；
// 谁再手拼一遍，那条对表就会红。

import path from "node:path";
import { repoPythonPath } from "../lib/runtime.ts";

const REPO = path.resolve(import.meta.dirname, "..");

/** 仓内 venv 解释器的绝对路径；只在 `_env/.venv` 已建好时存在（伞根 `pnpm py:setup`）。 */
export const LOCAL_PYTHON = repoPythonPath(REPO);
