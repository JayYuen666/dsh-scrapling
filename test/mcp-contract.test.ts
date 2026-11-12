// lib/mcp-contract.ts 的 URL 与客户端钉版判据：两侧逐字相同才有「装得上也生效」。

import { describe, expect, it } from "vitest";
import {
  clientInstallCommand,
  isMcpMode,
  MCP_CLIENT_PINS,
  MCP_DEFAULT_CLIENT_PIN,
  mcpUrl,
} from "../lib/mcp-contract.ts";

describe("mcpUrl", () => {
  it("ipv4 主机原样拼接", () => {
    expect(mcpUrl(39_217, "127.0.0.1")).toBe("http://127.0.0.1:39217/mcp");
  });

  it("ipv6 字面量必须带方括号，已带的不重复", () => {
    expect(mcpUrl(39_217, "::1")).toBe("http://[::1]:39217/mcp");
    expect(mcpUrl(39_217, "[::1]")).toBe("http://[::1]:39217/mcp");
  });

  it("端口越界或非整数直接抛错，不拼出连不上的 URL", () => {
    for (const port of [0, 65_536, 1.5, Number.NaN]) {
      expect(() => mcpUrl(port, "127.0.0.1")).toThrow(/1\.\.65535/u);
    }
  });
});

describe("客户端钉版", () => {
  // 期望值逐字写死，不从 MCP_DEFAULT_CLIENT_PIN 派生：常量本身改坏时这一条必须红。
  const DEV_LINE = "0.2.2-rc.2";
  const RELEASED_LINES: readonly string[] = [DEV_LINE, "0.2.2-rc.1"];

  it("默认命令钉开发线同版", () => {
    expect(clientInstallCommand()).toContain(`@deepseek-ai/dsh-mcp-client@${DEV_LINE}`);
    expect(MCP_DEFAULT_CLIENT_PIN).toBe(DEV_LINE);
  });

  it("窗口内每个宿主预发布的同版都放行", () => {
    for (const pin of RELEASED_LINES) {
      expect(clientInstallCommand(pin as never)).toContain(`@deepseek-ai/dsh-mcp-client@${pin}`);
    }
  });

  it("next 标签在放行名单内", () => {
    expect(clientInstallCommand("next")).toContain("@deepseek-ai/dsh-mcp-client@next");
  });

  it("白名单之外的钉版在运行期也拒绝（JS 调用者没有联合类型保护）", () => {
    expect(MCP_CLIENT_PINS).toStrictEqual([...RELEASED_LINES, "next"]);
    for (const bad of ["latest", "0.2.2-alpha.2", "0.2.2-alpha.3", "0.2.1-rc.5", `^${DEV_LINE}`]) {
      expect(() => clientInstallCommand(bad as never)).toThrow(/unsupported MCP client pin/u);
    }
  });
});

describe("isMcpMode", () => {
  it("只认三个精确模式名", () => {
    for (const mode of ["native", "mcp", "official-mcp"]) {
      expect(isMcpMode(mode)).toBe(true);
    }
    for (const value of ["MCP", " mcp", "official", ""]) {
      expect(isMcpMode(value)).toBe(false);
    }
  });
});
