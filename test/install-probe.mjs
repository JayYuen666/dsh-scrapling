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

/** 出货面禁止出现的路径片段。
 * `tests?` 而不是 `test`：Python 用例目录是 `py/tests/`，只匹配 `test/` 会把它当干净面放过。 */
const FORBIDDEN = [/(?:^|\/)tests?\//u, /(?:^|\/)_env\//u, /site-packages/u, /chromium/iu];

const repo = path.resolve(import.meta.dirname, "..");

/**
 * 跑一个外部命令并交回回执。
 *
 * 每一步都带超时：pack / install / 载入里任何一条挂住，没有超时就会一直挂到 CI job
 * 自己的上限，看不出一句话说明是哪一步。失败时把命令本身与回执一起带进错误，
 * 否则断言只剩「Command failed」而看不到是哪个程序、什么输出。
 *
 * @param {string} command - 程序
 * @param {readonly string[]} args - 参数
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options - 工作目录、环境与超时
 * @returns {Promise<{ stdout: string, stderr: string }>} 回执
 */
async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd: options.cwd ?? repo,
      env: { ...process.env, ...options.env },
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? 10 * 60 * 1000,
    });
    return { stdout, stderr };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

/**
 * 主流程。
 */
async function main() {
  // 本探针的承诺面是「在本仓唯一支持的平台上证装出去能用」：托管包的判据按 darwin/arm64 走
  // （lib/installer.ts），换了架构时后面那条 packs.core 断言会红成 missing 与 blocked 的差异，
  // 从回执里看不出是 runner 镜像换了。平台先判，红在第一行。
  assert.equal(
    `${process.platform}/${process.arch}`,
    "darwin/arm64",
    "出货探针要跑在 macOS arm64 上：那是本仓唯一有已验证运行时资产的平台",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-install-probe-"));
  try {
    // 必须用 pnpm pack：本仓的运行期依赖以 `catalog:` 书写，npm pack 原样保留这个协议，
    // 干净目录里 `npm install` 会直接 EUNSUPPORTEDPROTOCOL；pnpm pack 会把它落成版本号。
    const packed = await run("pnpm", ["pack", "--pack-destination", root]);
    // 只认「最后一行是个 .tgz 路径」：pnpm 换了回执格式、或者最后一行是进度与警告时，
    // 空串会被 path.join 折成 root 目录本身，stat 照样过，真正报错要到 readFile 才以
    // EISDIR 出现 —— 离成因隔着两步。判据直接拿原始回执说话。
    const packedPath = packed.stdout.trim().split("\n").at(-1);
    assert.match(packedPath, /\.tgz$/u, `pnpm pack 没有输出 tarball 路径，回执：${packed.stdout}`);
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
    // dsh-llm，安装因此必冲突。`@deepseek-ai/dsh` 本体的 peer 范围不以 `dsh-` 收尾，
    // 上面那条前缀判据已经把它排除在名单之外（host.js 不 import 它）。
    // --legacy-peer-deps：peer 写的是支持窗口，dev 线的精确版落在窗口文本外——宿主自己
    // 按 engines.dsh 以 includePrerelease 单独判兼容、不比较 peer，npm 的严格 peer 解析
    // 不认 includePrerelease，会把这组钉版当成冲突拒装；探针要验的是出货面可装可载，
    // 不是 npm 的 peer 视图。
    const hostPeers = Object.keys(manifest.peerDependencies ?? {})
      .filter((name) => name.startsWith("@deepseek-ai/dsh-"))
      .map((name) => {
        // peer 在列而 dev 没有同名钉版 = 本仓自己的「peer 与 dev 同时出现」那条约定破了。
        // 拿 dsh-tools 的版本号顶上去会把另一个包钉到与它无关的那一格，装出来的树与宿主线
        // 不一致，冲突时报错还会伪装成版本不匹配 —— 这里宁可点名缺哪一条声明。
        const pinned = manifest.devDependencies?.[name];
        assert.equal(
          typeof pinned,
          "string",
          `package.json 缺 ${name} 的 devDependency 精确钉版，探针不许用别的包的版本顶替`,
        );
        return `${name}@${pinned}`;
      });
    await run(
      "npm",
      [
        "install",
        tgz,
        ...hostPeers,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
      ],
      { cwd: install },
    );

    // --legacy-peer-deps 同时关掉了 npm 的自动 peer 安装：显式装进来的宿主包自己还有
    // peer（dsh-tools 要 dsh-agent / dsh-llm / dsh-session 等，dsh-typert-protocol 要
    // cordis），漏一个装载就是 ERR_MODULE_NOT_FOUND。所以装载驱动地补：报错点名谁，
    // 就按同一条版本规则（本仓 devDeps 同名钉版，缺则退宿主线锚点）补装谁，直到装载
    // 通过；点不出名的失败照常抛出。
    const hostLoad = () =>
      run(
        "node",
        [
          "-e",
          [
            `import(${JSON.stringify(manifest.name)}).then((m) => {`,
            '  if (typeof m.apply !== "function") throw new Error("host 产物没有 apply 入口");',
            '  if (!Array.isArray(m.inject)) throw new Error("host 产物没有 inject 声明");',
            '  if (typeof m.name !== "string" || m.name.length === 0) {',
            '    throw new Error("host 产物没有插件名");',
            "  }",
            '  console.info("HOST_OK");',
            "});",
          ].join("\n"),
        ],
        { cwd: install },
      );
    let host;
    for (let round = 0; ; round += 1) {
      try {
        // 每轮装载都要等上一轮补装完成，串行是循环的语义。
        // oxlint-disable-next-line eslint/no-await-in-loop
        host = await hostLoad();
        break;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const names = [
          ...new Set(
            Array.from(
              detail.matchAll(/Cannot find package '(?<missing>@deepseek-ai\/[^']+)'/gu),
              (match) => match.groups?.missing,
            ),
          ),
        ];
        if (round >= 6 || names.length === 0) {
          throw error;
        }
        const missing = names.map(
          (name) => `${name}@${manifest.devDependencies?.[name] ?? hostTools}`,
        );
        console.info(`装载缺 peer，补装：${missing.join(" ")}`);
        // 补装循环本质串行：装 → 载 → 再装，后一步依赖前一步的报错点名，无法并行。
        // oxlint-disable-next-line eslint/no-await-in-loop
        await run(
          "npm",
          [
            "install",
            ...missing,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--legacy-peer-deps",
          ],
          { cwd: install },
        );
      }
    }
    // 装载断言判的是「插件入口在不在」，不是「导出有几枚」：原来的 `HOST <数字>` 对 0 枚导出
    // 同样打绿，产物被裁空、导出名改动都看不出来。三件入口在被载进程里判掉，错误文本经
    // 子进程的非零退出原路抛回（那个循环只在报错点名缺包时才补装，其余照常抛）。
    assert.match(host.stdout, /HOST_OK/u);

    const loaderProbe = path.join(root, "client-probe.mjs");
    await writeFile(
      loaderProbe,
      [
        "globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.__entry = entry; } } };",
        `const client = new URL(${JSON.stringify(`./install/node_modules/${manifest.name}/client.js`)}, import.meta.url);`,
        "await import(client.href);",
        "const entry = globalThis.__entry;",
        'if (entry === undefined || typeof entry.factory !== "function") {',
        '  throw new Error("client bundle did not call __ModuleLoader__.load with a factory");',
        "}",
        // 贡献 id 就是包名：在本进程外判掉，改名或裁空都会以非零退出抛回 run()。
        `if (entry.id !== ${JSON.stringify(manifest.name)}) {`,
        `  throw new Error("client 贡献 id 与包名不一致：" + String(entry.id));`,
        "}",
        'console.info("CLIENT_OK");',
        "",
      ].join("\n"),
    );
    const client = await run("node", [loaderProbe]);
    assert.match(client.stdout, /CLIENT_OK/u);

    // 不走 node_modules/.bin 那一层垫片：POSIX 上它是可执行的软链，Windows 上 npm 给的是
    // .cmd / .ps1 加一个无扩展名的 sh 垫片，execFile 直调无扩展名那份会 ENOENT（本仓的构建
    // 脚本已经踩过同一条）。改成用 node 跑 manifest.bin 自己指向的那个文件，顺带证明 bin
    // 字段的目标真的随 tarball 落了地。
    const binEntry = manifest.bin?.["dsh-scrapling"];
    assert.equal(typeof binEntry, "string", "package.json 的 bin 里没有 dsh-scrapling 这一条");
    const cli = await run(
      process.execPath,
      [
        path.join(install, "node_modules", ...manifest.name.split("/"), binEntry),
        "setup",
        "--status",
      ],
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
    // 回执必须是纯 JSON：CLI 往 stdout 多打一行告警或进度时，裸 JSON.parse 抛的是没有上下文的
    // SyntaxError，读不出装出去的 CLI 到底说了什么，所以两个流都带进报错。
    let status;
    try {
      status = JSON.parse(cli.stdout);
    } catch (error) {
      throw new Error(`CLI stdout 不是 JSON：${cli.stdout}\nstderr：${cli.stderr}`, {
        cause: error,
      });
    }
    // 空数据目录 => core 未装：这一位的取值来自 lib/runtime-shape.ts 的 PACK_STATES。
    assert.equal(status.packs?.core, "missing", `packs.core 不是 missing：${cli.stdout}`);
    assert.equal(
      typeof status.runtime?.pythonPath,
      "string",
      `runtime.pythonPath 缺失：${cli.stdout}`,
    );
    assert.ok(status.runtime.pythonPath.length > 0, `runtime.pythonPath 是空串：${cli.stdout}`);
    console.info("PROBE OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
