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
  /**
   * 部署没开放写方法（`allowWriteMethods`，默认关）却有人要求 POST/PUT/DELETE。
   *
   * 两侧都会给这个码：Host 侧在把请求送出去之前就拒 —— 上游的参数校验是**开放根对象**，
   * 未声明的键不报错也不剥离，照样透传进 `execute`，所以「模型看不见 method」不等于
   * 「没人能发 method」；Python 侧再对手搓的帧拒一次。
   */
  | "WRITE_DISABLED"
  /**
   * 部署配置非法，插件拒绝加载。
   *
   * 两个来源：URL 准入闸门的策略参数非法（`nat64Prefixes` 是唯一会在构造期抛的那一项），
   * 以及 sidecar 的工作目录建不出来（`failFastOnMissingPython` 开着时走这里拒绝加载）。
   */
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
   * @param options - 承载 `cause` 的选项包；原始异常放在 `options.cause` 里
   */
  public constructor(code: SidecarErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SidecarError";
    this.code = code;
  }
}

/**
 * 从未知值里取一行可读文本，取不到就用兜底。
 *
 * 字符串只在**非空白**时算数：空串与纯空白原样放行会抛出 message 为空的错误，日志里
 * 剩下的就是一行 `[sidecar] response error:` 这种无信息行。数字、布尔与 bigint 走
 * String() 保留原文 —— 对端协议改动时发的裸值至少还能读；对象不走 String()，那种
 * "[object Object]" 进了日志等于没写。
 *
 * @param value - 任意值
 * @param fallback - 取不到可读文本时的兜底
 * @returns 字符串或兜底
 */
export function asText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}
