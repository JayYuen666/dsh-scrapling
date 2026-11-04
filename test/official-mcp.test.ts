// lib/official-mcp.ts —— 官方 scrapling-mcp 的接入配置生成与风险确认。

import path from "node:path";
import { describe, expect, it } from "vitest";
import { officialMcpHint, officialMcpPlan, OfficialMcpError } from "../lib/official-mcp.ts";
import { MCP_DEFAULT_CLIENT_PIN } from "../lib/mcp-contract.ts";

const DATA_DIR = "/tmp/dsh-scrapling-data";
const ENABLED = { dataDir: DATA_DIR, enabled: true, acceptedRisk: true };
/** 托管 venv 的根：两条用例都要按它拼落点。 */
const VENV_DIR = path.join(DATA_DIR, "runtime", "venv");

/** 取拒绝时抛出的那个值；没抛时给一个非本模块的错误类型，让调用点的断言变红。 */
function thrown(options: Parameters<typeof officialMcpPlan>[0]): unknown {
  try {
    officialMcpPlan(options);
  } catch (error) {
    return error;
  }
  return new Error("expected a refusal");
}

function failure(options: Parameters<typeof officialMcpPlan>[0]): OfficialMcpError {
  const error = thrown(options);
  expect(error, "拒绝必须是本模块的点名错误").toBeInstanceOf(OfficialMcpError);
  return error as OfficialMcpError;
}

/** `\uXXXX` 里那四位十六进制。 */
const HEX4 = /^[0-9a-f]{4}$/iu;

/** `config:` 之下那一层的缩进；本模块写出的字段全在这里。 */
const COMMAND_INDENT = " ".repeat(8);

/** `yamlScalar` 会写出的五种具名转义；除此之外只认 `\uXXXX`，别的写法说明文本不是它产的。 */
const NAMED_ESCAPES = new Map<string, string>([
  ['"', '"'],
  ["\\", "\\"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/**
 * 按 YAML 双引号标量的规则把一个标量解回字符串。
 *
 * @param scalar - 含外层双引号的原文
 * @returns 解出来的值
 */
function readDoubleQuoted(scalar: string): string {
  if (!scalar.startsWith('"') || !scalar.endsWith('"') || scalar.length < 2) {
    throw new Error(`command 不是双引号标量：${scalar}`);
  }
  const body = scalar.slice(1, -1);
  const parts: string[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? "";
    const marker = body[index + 1] ?? "";
    const named = NAMED_ESCAPES.get(marker);
    const hex = body.slice(index + 2, index + 6);
    if (char !== "\\") {
      parts.push(char);
      index += 1;
    } else if (named !== undefined) {
      parts.push(named);
      index += 2;
    } else if (marker === "u" && HEX4.test(hex)) {
      parts.push(String.fromCodePoint(Number.parseInt(hex, 16)));
      index += 6;
    } else {
      throw new Error(`双引号标量里有本模块不会写出的转义 \\${marker}：${scalar}`);
    }
  }
  return parts.join("");
}

/** 一条 patch 读回来的三样东西：config 层的原文字段、command 的原文与解出来的值。 */
interface PatchReading {
  readonly fields: Record<string, string>;
  readonly rawCommand: string;
  readonly command: string;
}

/**
 * 读回这一条 patch：按缩进认层次，`command:` 按双引号标量解码。
 *
 * 这里没有引第三方 YAML 依赖（宿主那侧真解析用的是 js-yaml，见 deepseek-harness 的
 * packages/boot/app-boot/src/config-schema/collect.ts），所以自己实现一个只认「本模块会写出的
 * 那几种形态」的读者。它比 JSON.parse 单行反解宽的地方是整段结构：`command:` 只许一行、必须
 * 在 8 位缩进、父一级必须是 `config:`、这一层的键集必须正好是那五个——结构写坏时后面的标量
 * 断言拦不住，只有把这些形状一起读回来才拦得住。
 *
 * @param patch - 生成的 patch 文本
 * @returns 读到的结构
 */
function readPatch(patch: string): PatchReading {
  const lines = patch.split("\n");
  const commandLines = lines.filter((text) => text.trimStart().startsWith("command:"));
  expect(commandLines).toHaveLength(1);
  const line = commandLines[0] ?? "";
  expect(line.startsWith(COMMAND_INDENT)).toBe(true);
  let parent = "";
  for (let offset = lines.indexOf(line) - 1; offset >= 0; offset -= 1) {
    const above = lines[offset] ?? "";
    if (!above.startsWith(COMMAND_INDENT)) {
      parent = above;
      break;
    }
  }
  // 同层还有 serverName / transport / args 三行，它们也是 8 位缩进，所以父级是「缩进比它浅的
  // 第一行」，不是上一行。
  expect(parent.trim()).toBe("config:");
  const fields: Record<string, string> = {};
  for (const entry of lines.filter((text) => text.startsWith(COMMAND_INDENT))) {
    const colon = entry.indexOf(":");
    fields[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
  }
  expect(Object.keys(fields).toSorted()).toStrictEqual([
    "args",
    "command",
    "failOnStartupError",
    "serverName",
    "transport",
  ]);
  const rawCommand = fields["command"] ?? "";
  return { fields, rawCommand, command: readDoubleQuoted(rawCommand) };
}

describe("officialMcpPlan", () => {
  it("两项表态都给才生成：命令指向托管 venv 的 scrapling-mcp，args 为空", () => {
    const plan = officialMcpPlan(ENABLED);
    // 托管 venv 由安装器建，而安装器只在 macOS arm64 上工作；入口布局跟解释器同源：
    // POSIX 在 bin/，Windows 在 Scripts/ 且可执行体带 .exe。
    expect(plan.command).toBe(
      process.platform === "win32"
        ? path.join(VENV_DIR, "Scripts", "scrapling-mcp.exe")
        : path.join(VENV_DIR, "bin", "scrapling-mcp"),
    );
    expect(plan.args).toStrictEqual([]);
    expect(plan.serverName).toBe("scrapling");
    expect(plan.patch).toContain("- insert:");
    expect(plan.patch).toContain("'@deepseek-ai/dsh-mcp-client'");
    expect(plan.patch).toContain("transport: stdio");
  });

  it("没开 officialMcpEnabled 时拒绝，并点名缺哪一项", () => {
    const error = failure({ ...ENABLED, enabled: false });
    expect(error.code).toBe("OFFICIAL_MCP_DISABLED");
    expect(error.message).toContain("officialMcpEnabled");
  });

  it("没接受风险时拒绝，且不能靠开关联动蒙过去", () => {
    const error = failure({ ...ENABLED, acceptedRisk: false });
    expect(error.code).toBe("RISK_NOT_ACCEPTED");
    expect(error.message).toContain("--accept-risk");
  });

  it("两缺其一时，先报开关那一层", () => {
    const error = failure({ dataDir: DATA_DIR, enabled: false, acceptedRisk: false });
    expect(error.code).toBe("OFFICIAL_MCP_DISABLED");
  });

  it("风险文案点名「不经本插件守卫」与 evaluate，且不写工具条数", () => {
    const plan = officialMcpPlan(ENABLED);
    expect(plan.risk).toContain("守卫");
    expect(plan.risk).toContain("browser_evaluate");
    // 条数是官方 server 随版本变的事实：它一旦漂了，用户按这段做 `--accept-risk` 表态时
    // 读到的就是一句过期的话，而这段是唯一的披露面。
    expect(plan.risk).not.toMatch(/\d+ 个工具/u);
    expect(plan.risk).not.toMatch(/\d+ tools/u);
  });

  it("客户端安装命令钉在宿主同线版本，绝不取 latest", () => {
    const plan = officialMcpPlan(ENABLED);
    expect(plan.installCommand).toContain(`@deepseek-ai/dsh-mcp-client@${MCP_DEFAULT_CLIENT_PIN}`);
    expect(plan.installCommand).not.toContain("latest");
  });
});

describe("官方条目的 command 标量", () => {
  it("路径里的空格、#、盘符冒号都进双引号标量，不会变成 YAML 注释或映射", () => {
    const dataDir = "/tmp/dsh data #1/C:";
    const plan = officialMcpPlan({ dataDir, enabled: true, acceptedRisk: true });
    const read = readPatch(plan.patch);
    // 裸标量在这一行上会从 '#' 起被当注释，plan.command 的后半截就没了。
    expect(plan.patch).not.toContain(`command: ${plan.command}`);
    expect(read.rawCommand.startsWith('"')).toBe(true);
    expect(read.command).toBe(plan.command);
    // 同层另四个字段是 plain 标量，原文就该等于这几个字面值。
    expect(read.fields).toStrictEqual({
      serverName: "scrapling",
      transport: "stdio",
      command: read.rawCommand,
      args: "[]",
      failOnStartupError: "true",
    });
  });

  it("command 标量能按 YAML 双引号规则读回 plan.command：引号与转义不是装饰", () => {
    // backslash、双引号、换行、制表符全带上：dataDir 由部署环境给出，不是受控常量。
    const dataDir = '/tmp/a "quoted" \\ dir\nnext\tline: #';
    const plan = officialMcpPlan({ dataDir, enabled: true, acceptedRisk: true });
    const read = readPatch(plan.patch);
    expect(read.rawCommand.startsWith('"')).toBe(true);
    expect(read.command).toBe(plan.command);
  });

  it(String.raw`回车与不可打印的控制字符落成 \uXXXX 转义，读回仍是原路径`, () => {
    // `\r` 与 `\u0001` 都不能裸出现在双引号标量里：只有写成转义才真的免疫。
    const dataDir = "/tmp/cr\rctl\u0001dir";
    const plan = officialMcpPlan({ dataDir, enabled: true, acceptedRisk: true });
    const read = readPatch(plan.patch);
    expect(read.rawCommand).toContain(String.raw`\r`);
    expect(read.rawCommand).toContain(String.raw`\u0001`);
    expect(read.command).toBe(plan.command);
  });

  it(String.raw`转义集合的四个端点（\u0000、\u001F、\u007F、\u009F）也走转义`, () => {
    // 这四枚是字符类 [\u0000-\u001F\u007F-\u009F] 的边界。只测中间的 \u0001 时，把类别
    // 写成 \u0001-\u001E 这种「少掉端点」的坏法不会有任何用例红；而控制字符即便裸着写进
    // 文本，读回来也可能仍是那个值 —— 所以这里断的是转义写法本身，不只是往返相等。
    const bounds = [0, 31, 127, 159].map((code) => String.fromCodePoint(code)).join("");
    const dataDir = `/tmp/${bounds}`;
    const plan = officialMcpPlan({ dataDir, enabled: true, acceptedRisk: true });
    const read = readPatch(plan.patch);
    for (const escape of [
      String.raw`\u0000`,
      String.raw`\u001f`,
      String.raw`\u007f`,
      String.raw`\u009f`,
    ]) {
      expect(read.rawCommand).toContain(escape);
    }
    // 读者对不认识的转义是直接抛的：能读回来就说明写出的形态在这套规则里说得通。
    expect(read.command).toBe(plan.command);
  });
});

describe("officialMcpHint", () => {
  it("开着时指路 setup，并把放弃了什么一并说出来", () => {
    const hint = officialMcpHint(true);
    expect(hint).toContain("--accept-risk");
    expect(hint).toContain("browser_evaluate");
  });

  it("没开时只指那一枚开关，不提风险细节", () => {
    const hint = officialMcpHint(false);
    expect(hint).toContain("officialMcpEnabled");
    expect(hint).not.toContain("browser_evaluate");
  });
});
