// 工具级墙钟与 sidecar 内层超时之间的固定余量。

import type { ToolSettings } from "./tools.ts";

/**
 * 注册给宿主的工具级墙钟，比本包内层那道请求超时多给的一分钟。
 *
 * **为什么必须严格大于内层**：宿主 `@deepseek-ai/dsh-tool-call-timeout-policy`
 * 在 `tools/execute` 外面套一道截止（`ctx.tools.get(name)?.timeoutMs`），而本包
 * 每次 sidecar 请求自己也有一道同长的截止（`CallOptions.timeoutMs`）。两者取同一个
 * 数时，宿主的截止起点更早（它在 execute 之前就装好了），于是永远是宿主先到期：
 * 结果被换成一句 `tool call timed out after Nms`，本包那条带出路说明的
 * `SidecarError`（`BROWSER_TIMEOUT` / `REQUEST_TIMEOUT` 之类）根本没机会说话。
 * 留一分钟，让内层永远先到期、先归因。内层自己已经把话说清楚，这一枚只兜
 * 「sidecar 完全不响应」那一类挂死。
 */
const TOOL_TIMEOUT_MARGIN_MS = 60_000;

/** 交给宿主的工具级墙钟：内层请求超时 + 余量。 */
export function toolTimeoutOf(settings: ToolSettings): number {
  return settings.timeoutMs + TOOL_TIMEOUT_MARGIN_MS;
}
