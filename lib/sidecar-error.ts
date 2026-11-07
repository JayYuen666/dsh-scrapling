// dsh-scrapling/lib/sidecar-error.ts —— sidecar 生命周期相关的错误类型。
//
// 单独成文件是为了满足「一个文件一个类」。

/**
 * sidecar 错误的机器可读码。
 *
 * 宿主生命周期码与 Python 协议码（BAD_ARGS / WRITE_DISABLED / SEARCH_* / ACTION_FAILED /
 * DOWNLOAD_* …）共用这一格：对端回什么码就原样透出什么码，调用方按码分流。
 */
export type SidecarErrorCode = string;

/** sidecar 错误，带机器可读码。 */
export class SidecarError extends Error {
  /** 机器可读错误码。 */
  public readonly code: SidecarErrorCode;
  /** Python 侧附带的机器可读细节（例如动作失败的下标）。 */
  public readonly details: Record<string, unknown>;

  /**
   * `details` 排在 `options` **之前**：两者都是可选的对象位，而只想带 details 的调用方
   * 若要把 options 空着，就得写一枚 `undefined` 占位；占位与实参记反时，details 会被当成
   * cause 静默吞掉（`ErrorOptions` 只有一个可选成员，类型上拦不住这种错位）。
   *
   * @param code - 机器可读错误码
   * @param message - 人读信息
   * @param details - Python 侧附带的机器可读细节（例如动作失败的下标）
   * @param options - 承载 `cause` 的选项包；原始异常放在 `options.cause` 里
   */
  public constructor(
    code: SidecarErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SidecarError";
    this.code = code;
    this.details = details;
  }
}

/**
 * 从未知值里取一行可读文本，取不到就用兜底。
 *
 * 字符串只在**非空白**时算数：空串与纯空白原样放行会抛出 message 为空的错误，日志里
 * 剩下的就是一行 `[sidecar] response error:` 这种无信息行。数字、布尔与 bigint 走
 * String() 保留原文 —— 对端协议改动时发出的值至少还能读；对象不走 String()，那种
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
