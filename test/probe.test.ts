// test/probe.test.ts —— runProbe 的启动失败分支必须点名解释器路径。
//
// 启动失败只有 `error` 事件、永远没有 `close`，`events.once(child, "close")` 会以同一个错误
// 拒绝，所以实现必须把那句拒绝包成点名解释器的话；否则用户读到的是只有 EACCES 的一句，分不清是
// 解释器不可执行还是别的权限问题。
//
// 这里造一个**存在但不可执行**的解释器（不能用不存在的路径：那会在 existsSync 预检就被换成
// 「缺少探针解释器」，根本走不到 spawn）。POSIX 权限位在 Windows 不成立，那一条整条跳过。
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { runProbe } from "./probe.ts";

/**
 * 建一份临时目录跑 body，跑完（含抛错）一定拆掉。
 *
 * 目录建好之后的第一步就是进 `try`：写脚本这一步自己也会失败（磁盘满、tmpdir 权限、路径被
 * 抢占），那时 `finally` 还没接管，整份目录就留在 /tmp 里。这份文件每条用例都建一份，漏一次
 * 叠一次，最后红的是别的东西。
 *
 * @param prefix - 临时目录名前缀
 * @param body - 拿到目录后用它的用例体
 * @returns body 的结果
 */
async function withTempDir<TResult>(
  prefix: string,
  body: (dir: string) => Promise<TResult>,
): Promise<TResult> {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 本机现在能不能执行这个路径。
 *
 * @param target - 待判的路径
 * @returns 可执行为 true
 */
function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 拒绝值上的那句话；不是 Error 时也给出原文。
 *
 * @param value - 拒绝值或成功值
 * @returns 可读文案
 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * 取 `Error.cause` 上这一位要判的两个字段。
 *
 * 不走 `toMatchObject({ cause: … })`：匹配器怎么比较 Error 的自有属性随版本变，红了也说不清
 * 是 cause 没了还是匹配器换了规则。这里把 cause 当成未知值读，缺席就是 undefined。
 *
 * @param error - 拒绝值
 * @returns `code` 与 `path`；不是带这俩字段的 Error 时给空对象
 */
function causeFields(error: unknown): { code?: unknown; path?: unknown } {
  if (!(error instanceof Error)) {
    return {};
  }
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null) {
    return {};
  }
  const record = cause as Record<string, unknown>;
  return { code: record["code"], path: record["path"] };
}

/** 起一份「假解释器 + 假探针」：脚本自己决定往 stdout / stderr 写什么、以几号退出。 */
function fakeProbe(dir: string, body: string): string {
  const script = path.join(dir, "fake-probe.mjs");
  writeFileSync(script, body, { mode: 0o644 });
  return script;
}

/** 按行写脚本：换行由 join 给，字符串字面量里就不需要再夹转义换行。 */
function fakeProbeLines(dir: string, lines: readonly string[]): string {
  return fakeProbe(
    dir,
    `${lines.join("\n")}
`,
  );
}

/** 一份形状齐了但内容空的报告：单独看某一位缺省时不必再抄十七个字段。 */
const MINIMAL_REPORT = {
  checked: {},
  calls: [],
  violations: [],
  silentAtSessionFetch: [],
  stealthInvariants: [],
  fetchLevelKeysDrift: [],
  reads: {},
  methods: [],
  facts: {
    fetcherVerbs: [],
    selectorCssParams: [],
    selectorCssDefaultPercentage: 50,
    responseMarkdownParams: [],
    convertorPrivates: [],
    noiseTagsActuallyStripped: [],
    storageInitParams: [],
    stealthArgCount: 0,
    stealthArgsTotal: 0,
    defaultArgsTotal: 0,
    defaultStealthUnionTotal: 0,
    responseInitParams: [],
    spiderDefaults: {
      robots_txt_obey: true,
      autothrottle_enabled: false,
      download_delay: 0,
      concurrent_requests: 1,
      max_pages: 10,
      output_dir: null,
      main_content_only: true,
    },
    spiderAttrs: [],
    sessionManagerAddParams: [],
    crawlHooks: [],
    redactionTargets: [],
  },
};

describe("runProbe 的启动失败分支", () => {
  it.skipIf(process.platform === "win32")(
    "解释器在但不可执行时，报一句点名整条路径的话，并把 spawn 那个错误挂在 cause 上",
    async (context) => {
      await withTempDir("dsh-probe-", async (dir) => {
        const interpreter = path.join(dir, "python-not-executable");
        writeFileSync(interpreter, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
        // 前置条件：这份权限位在本机上确实等于「不可执行」。某些挂载选项或容器策略下
        // access(X_OK) 反而会成功，那时 spawn 会跑起来、给的也可能是别的 errno —— 用例要判的
        // 东西根本不存在，跳过比把环境差异读成一句缺陷诚实。
        if (isExecutable(interpreter)) {
          context.skip();
          return;
        }
        // 只起一次：两次调用会 spawn 两个子进程，而第一条断言一红第二条就不执行，等于
        // 白多起一个进程还得再等一次启动失败。
        const failure: unknown = await runProbe({ pythonPath: interpreter }).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        // 整条路径点名：只匹配 basename 时 tmpdir 前缀不参与判据，「点名解释器路径」这条需求
        // 其实没被钉住。
        expect(messageOf(failure)).toContain(`探针起不来：${interpreter}`);
        const cause = causeFields(failure);
        expect(cause.code).toBe("EACCES");
        expect(cause.path).toBe(interpreter);
      });
    },
  );

  it("探测脚本挂住时超时保护杀掉它并点名预算", async () => {
    // 拿 node 当「解释器」、一份永不退出的脚本当探针：这条要判的是「有界」，不是探针内容。
    // 没有超时保护时这一跑会一直挂着 ——契约测试在模块顶层 await 探测脚本，收集期就冻结了。
    await withTempDir("dsh-probe-hang-", async (dir) => {
      const script = path.join(dir, "hang.mjs");
      writeFileSync(script, "setInterval(() => {}, 1000);\n", { mode: 0o644 });
      await expect(
        runProbe({
          pythonPath: process.execPath,
          probePath: script,
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/超过 300ms.*SIGKILL/u);
    });
  });
});

describe("runProbe 的输出判据", () => {
  it("探针少的字段会被点名，而不是让下游对着 undefined 判", async () => {
    // 报告形状是本仓唯一的判据来源：`as ProbeReport` 只骗过编译期，探针改字段名或漏写一项
    // 时下游拿到 undefined —— 有的断言会安静通过，有的报一句与契约无关的 TypeError。
    await withTempDir("dsh-probe-shape-", async (dir) => {
      const broken: Record<string, unknown> = { ...MINIMAL_REPORT };
      // Reflect 而不是 delete：`delete obj.calls` 在这个形状上会被 TS 要求字段可选。
      Reflect.deleteProperty(broken, "calls");
      const script = fakeProbe(dir, `console.log(${JSON.stringify(JSON.stringify(broken))});\n`);
      await expect(runProbe({ pythonPath: process.execPath, probePath: script })).rejects.toThrow(
        /calls 应为数组，实际是 undefined/u,
      );
    });
  });

  it("形状齐的报告直接交回去：校验不是又一道会误伤的关卡", async () => {
    await withTempDir("dsh-probe-ok-", async (dir) => {
      const script = fakeProbe(
        dir,
        `console.log(${JSON.stringify(JSON.stringify(MINIMAL_REPORT))});\n`,
      );
      const report = await runProbe({ pythonPath: process.execPath, probePath: script });
      expect(report.facts.selectorCssDefaultPercentage).toBe(50);
      expect(report.methods).toStrictEqual([]);
    });
  });

  it("stdout 不是 JSON 时报错带着头几行，而不是整段刷屏", async () => {
    await withTempDir("dsh-probe-nojson-", async (dir) => {
      const script = fakeProbe(dir, 'console.log("INFO first line");');
      await expect(runProbe({ pythonPath: process.execPath, probePath: script })).rejects.toThrow(
        /探针输出不是 JSON[\s\S]*INFO first line/u,
      );
    });
  });

  it("stdout 超过字节上限时点名上限，不让 JSON.parse 报一句语法错", async () => {
    // 上游往 stdout 刷日志（而不是写那一行结论）时，两种红话指向完全不同的排查方向。
    await withTempDir("dsh-probe-blowup-", async (dir) => {
      const script = fakeProbe(dir, 'process.stdout.write("x".repeat(9 * 1024 * 1024));\n');
      await expect(runProbe({ pythonPath: process.execPath, probePath: script })).rejects.toThrow(
        /stdout 超过 \d+ 字节上限/u,
      );
    });
  });

  it("失败文案只留 stderr 的尾巴：头几行被丢掉、最后一行必须在", async () => {
    await withTempDir("dsh-probe-tail-", async (dir) => {
      const script = fakeProbeLines(dir, [
        'for (let i = 0; i < 400; i += 1) { console.error("FILLER-" + String(i).padStart(3, "0")); }',
        'console.error("LAST-STDERR-LINE");',
        // 用 exitCode 而不是 process.exit(3)：管道上的 console.error 是异步写，后者会在
        // 事件循环清空前直接退进程，最后一行会被丢掉——本用例要判的是尾巴收集器，不是
        // Node 的退出时序。
        "process.exitCode = 3;",
      ]);
      const failure = await runProbe({ pythonPath: process.execPath, probePath: script }).catch(
        (error: unknown) => error,
      );
      const message = messageOf(failure);
      expect(message).toContain("LAST-STDERR-LINE");
      expect(message).not.toContain("FILLER-000");
    });
  });
});
