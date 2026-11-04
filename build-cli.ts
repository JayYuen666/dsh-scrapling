#!/usr/bin/env node
// dsh-scrapling/build-cli.ts —— 把 cli-main.ts 与它依赖的 lib/*.ts 打成可直接执行的 ESM。
//
// 为什么单独打包：发布包只有 .js，Node 在 node_modules 里不会对 .ts 做类型擦除；
// CLI 也不能 import host.js（那会把宿主 peer 依赖一起拉进来）。这里把入口、参数编排与
// installer/runtime 打成单文件，只留 node: 内置模块外部。

import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { bundleChunkText, invokedDirectly, writeArtifact } from "./build-helpers.ts";

const root = import.meta.dirname;

/**
 * 生成 bin/dsh-scrapling.mjs 的完整文本。
 *
 * 导出是为了 `test/artifact-freshness.test.ts` 能拿内存构建与仓库里那份产物逐字节比：
 * 这份 bin 是被提交的，源码改了而产物没重跑时，两者一旦分叉没有任何门禁会响。
 *
 * @returns 产物文本
 */
export async function buildCli(): Promise<string> {
  const code = await bundleChunkText({
    root,
    input: path.join(root, "cli-main.ts"),
    label: "build-cli",
    platform: "node",
    format: "esm",
    minify: true,
    extensions: [".ts", ".mjs", ".js"],
    // 只有 node: 内置留在外部：CLI 是自带全部逻辑的单文件可执行件，宿主包一个都不许打进来
    // （由 build-helpers 的 assertNoHostPackageInlined 兜住）。
    external: () => false,
    // ESM 顶层直接执行，指令本来就在指令位；摘出去再拼回去只会多两个字节。
    hoistStrict: false,
  });
  return `#!/usr/bin/env node\n${code}\n`;
}

async function main(): Promise<void> {
  const code = await buildCli();
  const target = path.join(root, "bin", "dsh-scrapling.mjs");
  // 这是会随包发布的产物：直接覆盖时，进程被杀 / CI 取消 / 磁盘写满都会在目标位置留下半截 JS，
  // 而 npm pack 照样把它发出去。与 host.js / client.js 同一套原子写（临时文件 + 同目录 rename）。
  // bin/ 只因产物被提交才存在，干净检出或从 files 白名单重组目录时不会有这个目录，所以先建出来。
  await mkdir(path.dirname(target), { recursive: true });
  writeArtifact(target, code);
  await chmod(target, 0o755);
  console.info("bin/dsh-scrapling.mjs written:", code.length, "chars");
}

if (invokedDirectly(import.meta.filename, import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
