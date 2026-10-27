// lib/official-mcp.ts —— 官方 scrapling-mcp 的接入配置生成与风险确认。

import path from "node:path";
import { describe, expect, it } from "vitest";
import { officialMcpHint, officialMcpPlan, OfficialMcpError } from "../lib/official-mcp.ts";

const DATA_DIR = "/tmp/dsh-scrapling-data";
const ENABLED = { dataDir: DATA_DIR, enabled: true, acceptedRisk: true };

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

describe("officialMcpPlan", () => {
  it("两项表态都给才生成：命令指向托管 venv 的 scrapling-mcp，args 为空", () => {
    const plan = officialMcpPlan(ENABLED);
    // 托管 venv 由安装器建，而安装器只在 macOS arm64 上工作：那边就是 bin/scrapling-mcp。
    expect(plan.command).toBe(path.join(DATA_DIR, "runtime", "venv", "bin", "scrapling-mcp"));
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

  it("风险文案写明不经本插件守卫、16 个工具与 evaluate", () => {
    const plan = officialMcpPlan(ENABLED);
    expect(plan.risk).toContain("守卫");
    expect(plan.risk).toContain("16");
    expect(plan.risk).toContain("browser_evaluate");
  });

  it("客户端安装命令钉在 rc.3，绝不取 latest", () => {
    const plan = officialMcpPlan(ENABLED);
    expect(plan.installCommand).toContain("@deepseek-ai/dsh-mcp-client@0.2.1-rc.3");
    expect(plan.installCommand).not.toContain("latest");
  });
});

/** 从 patch 里取 `command:` 那一行；没有这一行说明生成的文本已经不成形。 */
function commandLine(patch: string): string {
  const line = patch.split("\n").find((text) => text.trimStart().startsWith("command:"));
  expect(line, "patch 里必须有 command 行").toBeDefined();
  return line ?? "";
}

describe("官方条目的 command 标量", () => {
  it("路径里的空格、#、盘符冒号都进双引号标量，不会变成 YAML 注释或映射", () => {
    const dataDir = "/tmp/dsh data #1/C:";
    const plan = officialMcpPlan({ dataDir, enabled: true, acceptedRisk: true });
    const line = commandLine(plan.patch);
    // 裸标量在这一行上会从 '#' 起被当注释，plan.command 的后半截就没了。
    expect(plan.patch).not.toContain(`command: ${plan.command}`);
    const scalar = line.trimStart().slice("command: ".length);
    expect(scalar.startsWith('"')).toBe(true);
    expect(scalar.endsWith('"')).toBe(true);
    expect(JSON.parse(scalar)).toBe(plan.command);
  });

  it("command 标量可以反解回 plan.command：引号与转义不是装饰", () => {
    // backslash、双引号、换行、制表符全带上：dataDir 由部署环境给出，不是受控常量。
    const dataDir = '/tmp/a "quoted" \\ dir\nnext\tline: #';
    const plan = officialMcpPlan({ dataDir, enabled: true, acceptedRisk: true });
    const scalar = commandLine(plan.patch).trimStart().slice("command: ".length);
    expect(scalar.startsWith('"')).toBe(true);
    expect(scalar.endsWith('"')).toBe(true);
    // JSON 的字符串语法是 YAML 双引号标量的子集，所以这里用 JSON.parse 独立地解一遍。
    expect(JSON.parse(scalar)).toBe(plan.command);
    // 换行不能真的断行：command 只会贡献一行。
    expect(
      plan.patch.split("\n").filter((text) => text.trimStart().startsWith("command:")),
    ).toHaveLength(1);
  });

  it(String.raw`回车与不可打印的控制字符落成 \uXXXX 转义，反解仍是原路径`, () => {
    // `\r` 与 `\u0001` 在 JSON/YAML 里都不能裸出现：只有写成转义才真的免疫。
    const dataDir = "/tmp/cr\rctl\u0001dir";
    const plan = officialMcpPlan({ dataDir, enabled: true, acceptedRisk: true });
    const scalar = commandLine(plan.patch).trimStart().slice("command: ".length);
    expect(scalar).toContain(String.raw`\r`);
    expect(scalar).toContain(String.raw`\u0001`);
    expect(JSON.parse(scalar)).toBe(plan.command);
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
