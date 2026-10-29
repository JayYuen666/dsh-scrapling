// 发布形态探针：npm pack → 干净目录安装 → host/client 载入 → CLI --status。
//
// 为什么不是 vitest 用例：它要跑 npm pack（prepack 会重建产物）、再装一次 tarball，
// 放进默认测试套会把单测变成分钟级。Task 1 的门禁只钉 files/bin；这里钉的是**装出去之后**
// 那一段，由 P7 的 Task 2/4 手动或 CI 跑。
//
// host.js 的 import 需要宿主提供的 peer。tarball 的必装 peer 由 npm 自动装上；可选 peer
// `@deepseek-ai/dsh-tools` 不会，所以探针显式装它来模拟宿主。client.js 是浏览器 bundle，
// Node 里没有 window：这里只用一个假的 `__ModuleLoader__` 接住 factory，证明宿主加载器
// 拿得到贡献，而不执行 React。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** tarball 必须出现的条目（相对包根的 `package/` 前缀由 tar 列出）。 */
const REQUIRED = [
  "package/host.js",
  "package/client.js",
  "package/cordis.patch.yml",
  "package/runtime-manifest.json",
  "package/bin/dsh-scrapling.mjs",
  "package/py/bridge.py",
  "package/py/adapters.py",
  "package/py/crawl.py",
  "package/py/guard.py",
  "package/py/extraction.py",
  "package/py/search.py",
  "package/py/session_page.py",
  "package/py/media.py",
  "package/py/redact.py",
  "package/py/redis_storage.py",
  "package/py/runtime-requirements.txt",
];

/** 出货面禁止出现的路径片段。 */
const FORBIDDEN = [/(?:^|\/)test\//u, /(?:^|\/)_env\//u, /site-packages/u, /chromium/iu];

const repo = path.resolve(import.meta.dirname, "..");

/**
 * 跑一个外部命令并交回回执。
 *
 * @param {string} command - 程序
 * @param {readonly string[]} args - 参数
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} options - 工作目录与环境
 * @returns {Promise<{ stdout: string, stderr: string }>} 回执
 */
async function run(command, args, options = {}) {
  const { stdout, stderr } = await exec(command, args, {
    cwd: options.cwd ?? repo,
    env: { ...process.env, ...options.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * 主流程。
 */
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-install-probe-"));
  try {
    // 必须用 pnpm pack：本仓的运行期依赖以 `catalog:` 书写，npm pack 原样保留这个协议，
    // 干净目录里 `npm install` 会直接 EUNSUPPORTEDPROTOCOL；pnpm pack 会把它落成版本号。
    const packed = await run("pnpm", ["pack", "--pack-destination", root]);
    const packedPath = packed.stdout.trim().split("\n").at(-1) ?? "";
    const tgz = path.isAbsolute(packedPath) ? packedPath : path.join(root, packedPath);
    const info = await stat(tgz);
    const bytes = await readFile(tgz);
    const digest = createHash("sha256").update(bytes).digest("hex");
    console.info(`tarball ${path.basename(tgz)} ${String(info.size)} bytes sha256:${digest}`);

    const listed = await run("tar", ["-tzf", tgz]);
    const entries = listed.stdout.trim().split("\n");
    for (const entry of REQUIRED) {
      assert.ok(entries.includes(entry), `tarball 缺 ${entry}`);
    }
    for (const pattern of FORBIDDEN) {
      const hit = entries.find((entry) => pattern.test(entry));
      assert.equal(hit, undefined, `tarball 不该含 ${String(hit)}`);
    }

    const install = path.join(root, "install");
    await mkdir(install, { recursive: true });
    await writeFile(path.join(install, "package.json"), '{"type":"module","private":true}\n');
    // 显式装可选 peer，模拟宿主；其余必装 peer 由 npm 按 tarball 的 peerDependencies 自动装。
    // 版本取本仓的 devDependency（编译与测试所对的精确宿主），不取 peer 范围：npm 会把
    // peer 范围解析成 registry 上的另一格，与 tarball 其余 peer 的解析结果互斥
    //（实测 dsh-tools rc.3 与 dsh-web rc.4 各自要求不同的 dsh-llm）。
    const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
    const hostTools = manifest.devDependencies?.["@deepseek-ai/dsh-tools"];
    assert.equal(typeof hostTools, "string", "package.json 缺 dsh-tools 的 devDependency 精确钉版");
    // 把同一宿主线的全部 dsh-* peer 一起按 devDependency 的精确版装：只装 dsh-tools 时，
    // npm 会按各自的 peer 范围解析出 rc.3/rc.4 混排的树，而这些宿主包互相要求同一个精确
    // dsh-llm，安装因此必冲突。`@deepseek-ai/dsh` 本体不参与：host.js 不 import 它。
    const hostPeers = Object.keys(manifest.peerDependencies ?? {})
      .filter((name) => name.startsWith("@deepseek-ai/dsh-") && name !== "@deepseek-ai/dsh")
      .map((name) => `${name}@${manifest.devDependencies?.[name] ?? hostTools}`);
    await run(
      "npm",
      ["install", tgz, ...hostPeers, "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: install },
    );

    const host = await run(
      "node",
      [
        "-e",
        'import("@jayyuen66/dsh-scrapling").then((m) => console.info("HOST", Object.keys(m).length))',
      ],
      { cwd: install },
    );
    assert.match(host.stdout, /HOST \d+/u);

    const loaderProbe = path.join(root, "client-probe.mjs");
    await writeFile(
      loaderProbe,
      [
        "globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.__entry = entry; } } };",
        'const client = new URL("./install/node_modules/@jayyuen66/dsh-scrapling/client.js", import.meta.url);',
        "await import(client.href);",
        "const entry = globalThis.__entry;",
        'if (entry === undefined || typeof entry.factory !== "function") {',
        '  throw new Error("client bundle did not call __ModuleLoader__.load with a factory");',
        "}",
        'console.info("CLIENT", entry.id);',
        "",
      ].join("\n"),
    );
    const client = await run("node", [loaderProbe]);
    assert.match(client.stdout, /CLIENT @jayyuen66\/dsh-scrapling/u);

    const cli = await run(
      path.join(install, "node_modules", ".bin", "dsh-scrapling"),
      ["setup", "--status"],
      {
        cwd: install,
        env: {
          DSH_SCRAPLING_DATA_DIR: path.join(root, "data"),
          // 状态读取不该联网；把代理指向一个不可用端口当反证。
          HTTPS_PROXY: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
        },
      },
    );
    const status = JSON.parse(cli.stdout);
    assert.equal(status.packs.core, "missing");
    assert.ok(status.runtime.pythonPath.length > 0);
    console.info("PROBE OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
