// dsh-scrapling/lib/frame-error.ts —— 帧编解码阶段的错误类型。
//
// 单独成文件是为了满足「一个文件一个类」；顺带让 jsonl.ts 只剩编解码与切帧。

/** 帧处理失败的分类。 */
export type FrameErrorKind = "unparsable-json" | "not-an-object";

/** 帧处理失败时抛出的错误，带机器可读分类。 */
export class FrameError extends Error {
  /** 失败分类。 */
  public readonly kind: FrameErrorKind;

  /**
   * @param kind - 失败分类
   * @param message - 人读信息
   * @param options - 原始异常
   */
  public constructor(kind: FrameErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FrameError";
    this.kind = kind;
  }
}
