// bin/dsh-scrapling.mjs 的入口。build-cli.ts 以它为打包输入，bin 里那份是产物。

import { runCli } from "./lib/cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
