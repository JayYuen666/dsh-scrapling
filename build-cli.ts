#!/usr/bin/env node
// dsh-scrapling/build-cli.ts —— 把 cli-main.ts 与它依赖的 lib/*.ts 打成可直接执行的 ESM。
//
// 为什么单独打包：发布包只有 .js，Node 在 node_modules 里不会对 .ts 做类型擦除；
// CLI 也不能 import host.js（那会把宿主 peer 依赖一起拉进来）。这里把入口、参数编排与
// installer/runtime 打成单文件，只留 node: 内置模块外部。

import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { rolldown } from "rolldown";
import { singleChunkCode } from "./build-helpers.ts";

const root = import.meta.dirname;

async function buildCli(): Promise<string> {
  const bundle = await rolldown({
    input: path.join(root, "cli-main.ts"),
    platform: "node",
    resolve: { extensions: [".ts", ".mjs", ".js"] },
  });
  try {
    const { output } = await bundle.generate({ format: "esm", minify: true });
    return `#!/usr/bin/env node\n${singleChunkCode(output)}\n`;
  } finally {
    await bundle.close().catch((closeError: unknown) => {
      console.error("[build-cli] failed to close rolldown bundle:", closeError);
    });
  }
}

async function main(): Promise<void> {
  const code = await buildCli();
  const target = path.join(root, "bin", "dsh-scrapling.mjs");
  await writeFile(target, code);
  await chmod(target, 0o755);
  console.info("bin/dsh-scrapling.mjs written:", code.length, "chars");
}

await main();
