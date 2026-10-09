// dsh-scrapling/lib/sidecar-error.ts —— sidecar 生命周期相关的错误类型。
//
// 单独成文件是为了满足「一个文件一个类」。

/** sidecar 错误的机器可读码。 */
export type SidecarErrorCode =
  | "SIDECAR_UNAVAILABLE"
  | "SIDECAR_HANDSHAKE_FAILED"
  | "SIDECAR_PROTOCOL_MISMATCH"
  | "SIDECAR_CRASHED"
  | "SIDECAR_REQUEST_FAILED"
  | "SIDECAR_TIMEOUT"
  | "SIDECAR_ABORTED"
  | "SIDECAR_CLOSED"
  /** Host 侧 URL 准入闸门判否（lib/url-policy.ts）；请求根本没发出去。 */
  | "URL_BLOCKED"
  /** 部署配置非法，插件拒绝加载（当前只有 nat64Prefixes 会走到这里）。 */
  | "CONFIG_INVALID"
  /** 这个 profile 没有作业后端，scrapling_crawl 无法挂后台作业。 */
  | "JOBS_UNAVAILABLE"
  /** 这个 profile 没有 ctx.llm，scrapling_answer 无法调用模型。 */
  | "ANSWER_UNAVAILABLE"
  /** 拿不到可用的模型路由（部署未配、调用不来自会话、profile 也没有默认模型）。 */
  | "ANSWER_NO_ROUTE"
  /** 模型调用本身失败：非正常收尾、空答案、流被中途掐断。 */
  | "ANSWER_FAILED";

/** sidecar 错误，带机器可读码。 */
export class SidecarError extends Error {
  /** 机器可读错误码。 */
  public readonly code: SidecarErrorCode;

  /**
   * @param code - 机器可读错误码
   * @param message - 人读信息
   * @param options - 原始异常
   */
  public constructor(code: SidecarErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SidecarError";
    this.code = code;
  }
}

/**
 * 从未知值里取字符串，取不到就用兜底。
 *
 * 直接 `String(value)` 落在对象上会得到 "[object Object]"，那种文案进了日志等于没写。
 *
 * @param value - 任意值
 * @param fallback - 取不到字符串时的兜底
 * @returns 字符串或兜底
 */
export function asText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
