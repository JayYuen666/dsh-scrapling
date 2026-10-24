// dsh-scrapling/lib/frame-error.ts —— 帧编解码阶段的错误类型。
//
// 单独成文件是为了满足「一个文件一个类」；顺带让 jsonl.ts 只剩编解码与切帧。

/**
 * FrameErrorKind 各取值的单一来源。
 *
 * 调用侧从这里取，不再各自写字面量：字面量散开后，加一个分类或改一个取值就得靠人记得
 * 逐处对齐，漏掉的那处只会表现为「分支永远走不到」。类型从这份表派生，两边不可能走散。
 */
export const FRAME_ERROR_KINDS = {
  /** 不是合法 JSON（解析失败、序列化失败）。 */
  unparsableJson: "unparsable-json",
  /** 是合法 JSON 但不是对象。 */
  notAnObject: "not-an-object",
  /** 残帧超过长度上限：资源/限流一类，不是协议损坏。 */
  frameTooLarge: "frame-too-large",
} as const;

/** 帧处理失败的分类。 */
export type FrameErrorKind = (typeof FRAME_ERROR_KINDS)[keyof typeof FRAME_ERROR_KINDS];

/** 帧处理失败时抛出的错误，带机器可读分类。 */
export class FrameError extends Error {
  /** 失败分类。 */
  public readonly kind: FrameErrorKind;

  /**
   * @param kind - 失败分类
   * @param message - 人读信息
   * @param options - 承载 `cause` 的选项包；原始异常放在 `options.cause` 里
   */
  public constructor(kind: FrameErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrameError";
    this.kind = kind;
  }
}
