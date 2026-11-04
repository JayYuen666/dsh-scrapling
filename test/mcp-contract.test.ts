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
  it("默认命令钉宿主同线版本", () => {
    expect(clientInstallCommand()).toContain(
      `@deepseek-ai/dsh-mcp-client@${MCP_DEFAULT_CLIENT_PIN}`,
    );
  });

  it("两条宿主线各自的同线版本都在放行名单内", () => {
    expect(clientInstallCommand("0.2.1-rc.5")).toContain("@deepseek-ai/dsh-mcp-client@0.2.1-rc.5");
  });

  it("next 标签在放行名单内", () => {
    expect(clientInstallCommand("next")).toContain("@deepseek-ai/dsh-mcp-client@next");
  });

  it("白名单之外的钉版在运行期也拒绝（JS 调用者没有联合类型保护）", () => {
    expect(MCP_CLIENT_PINS).toStrictEqual([MCP_DEFAULT_CLIENT_PIN, "0.2.1-rc.5", "next"]);
    expect(() => clientInstallCommand("latest" as never)).toThrow(/unsupported MCP client pin/u);
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
