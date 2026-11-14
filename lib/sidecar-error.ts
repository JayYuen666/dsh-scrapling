// dsh-scrapling/lib/sidecar-error.ts —— sidecar 生命周期相关的错误类型。
//
// 单独成文件是为了满足「一个文件一个类」。

// 继承宿主的 `HarnessError` 而不是 `Error`，为的是让 `code` 真的到得了模型面前。
//
// 宿主在 `packages/core/tools/src/pipeline.ts` 的 `errorInfo()` 里判的是
// `error instanceof HarnessError`，命中才把 `{ name, code }` 写进工具失败的
// `ToolFailure.info`（持久化契约，客户端与策略层都按 `code` 分流）；判不中时
// 那一格整块消失，模型与界面只看得到一句 message —— 本类自带的 `code` 就在那里
// 白白丢掉，而丢法是完全静默的。
//
// 类身份是这条判据的全部：`@deepseek-ai/dsh-error` 必须是 **peer**（构建期外部化），
// 否则 rolldown 会把整包内联进 host.js，于是本类继承的是产物里那份**另一个**类，
// 宿主的 `instanceof` 恒为 false。实测两份副本的类互不相等，也实测宿主自己的
// `dsh-llm` 转出的 `HarnessError` 与 `dsh-error` 是同一个（同一模块实例）。
import { HarnessError } from "@deepseek-ai/dsh-error";

/**
 * sidecar 错误的机器可读码。
 *
 * 宿主生命周期码与 Python 协议码（BAD_ARGS / WRITE_DISABLED / SEARCH_* / ACTION_FAILED /
 * DOWNLOAD_* …）共用这一格：对端回什么码就原样透出什么码，调用方按码分流。
 */
export type SidecarErrorCode = string;

/** sidecar 错误，带机器可读码。 */
export class SidecarError extends HarnessError {
  /** Python 侧附带的机器可读细节（例如动作失败的下标）。 */
  public readonly details: Record<string, unknown>;

  /**
   * `details` 排在 `options` **之前**：两者都是可选的对象位，而只想带 details 的调用方
   * 若要把 options 空着，就得写一枚 `undefined` 占位；占位与实参记反时，details 会被当成
   * cause 静默吞掉（`ErrorOptions` 只有一个可选成员，类型上拦不住这种错位）。
   *
   * @param code - 机器可读错误码（同时是宿主 `ToolFailure.info.code` 的取值）
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
    // `code` 交给 `HarnessError` 持有（它是 `readonly code: string` 的唯一定义处），
    // 本类不再声明同名字段 —— 声明了会遮住父类那一位，两处各存一份。
    super(message, code, options);
    this.name = "SidecarError";
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
