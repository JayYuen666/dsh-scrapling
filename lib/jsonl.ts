// dsh-scrapling/lib/jsonl.ts —— JSON-lines 帧编解码。
//
// 注意别和 `@jayyuen66/dsh-plugin-shared/lib/jsonl` 搞混：那个是**日志文件尾部收缩**
// （shrinkJsonlTail），与本模块无关。
//
// 这里只解决一件事：把「字节流」和「一帧一个 JSON 对象」互相转换。切分规则必须与
// Python 侧的 bridge.py 对齐（一帧一行、行内不得有裸换行）。

import type { Readable } from "node:stream";
import { FrameError } from "./frame-error.ts";

/**
 * 把任意值编码成一帧。
 *
 * 序列化失败必须在这里就炸出来，而不是等到写进管道之后：管道是异步的，写失败只会
 * 以一个语焉不详的 EPIPE 呈现，排查成本高得多。
 *
 * @param value - 要编码的对象
 * @returns 不含换行的单行 JSON
 */
export function encodeFrame(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new FrameError("unparsable-json", "frame is not JSON-serialisable", {
      cause: error,
    });
  }
}

/**
 * 判断一个 JSON 值是不是「帧对象」。
 *
 * 用类型谓词而不是 `as Record<string, unknown>` 断言：断言出来的类型编译器并不认可，
 * 断言错了要等到运行时才发现。
 *
 * @param value - JSON.parse 的结果
 * @returns 是否是普通对象
 */
export function isFrameObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解析一帧。
 *
 * @param line - 单行文本
 * @returns 解析出的对象
 */
export function decodeFrame(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new FrameError("unparsable-json", `frame is not valid JSON: ${line.slice(0, 120)}`, {
      cause: error,
    });
  }
  if (!isFrameObject(parsed)) {
    throw new FrameError("not-an-object", `frame must be a JSON object: ${line.slice(0, 120)}`);
  }
  return parsed;
}

/** 增量切帧器：喂进任意切片的文本，吐出完整的一行。 */
export class FrameSplitter {
  #buffer = "";

  /**
   * 喂一段文本进去，把其中完整的行收走。
   *
   * 末尾没换行的残片会留在缓冲里等下一段 —— 这正是「对端分多次 write」时要处理的情况。
   *
   * @param chunk - 任意长度的文本片段
   * @returns 完整的帧文本列表
   */
  public push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let newlineAt = this.#buffer.indexOf("\n");
    while (newlineAt >= 0) {
      const line = this.#buffer.slice(0, newlineAt);
      this.#buffer = this.#buffer.slice(newlineAt + 1);
      if (line.trim().length > 0) {
        lines.push(line);
      }
      newlineAt = this.#buffer.indexOf("\n");
    }
    return lines;
  }

  /**
   * 收尾：把缓冲区里剩下的内容当成最后一帧吐出来。
   *
   * 对端异常退出而不补换行时，靠它不至于丢掉最后一帧。
   *
   * @returns 残留的帧文本；没有则空数组
   */
  public flush(): string[] {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}

/**
 * 把一个 Readable 持续切成帧并回调。
 *
 * @param stream - 输入流
 * @param onFrame - 每收到一帧调用一次
 * @returns 停止函数；调用后不再回调
 */
export function pumpFrames(stream: Readable, onFrame: (line: string) => void): () => void {
  const splitter = new FrameSplitter();
  // 共享状态放对象里而不是裸 let：stop() 由调用方持有，会在 for 循环**两次迭代之间**
  // 把标志翻掉。用裸 let 时 TS 的控制流分析会把它窄化成 false，于是那句守卫看起来
  // 「永远不成立」被判掉 —— 那是分析器的错觉，不是代码里真的没这个分支。
  const state = { stopped: false };

  const handle = (chunk: string | Buffer): void => {
    // stop() 已经 off("data") 摘掉监听器，所以这里正常路径不会命中；留着是防
    // 「onFrame 内部调 stop() 后，同一个 chunk 的后续帧仍被投递」。
    /* v8 ignore next 3 */
    if (state.stopped) {
      return;
    }
    // setEncoding("utf8") 之后 data 事件给的永远是 string，Buffer 那一侧到不了；
    // 保留判断是为了不依赖调用方一定先设了编码。
    /* v8 ignore next 1 */
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of splitter.push(text)) {
      if (state.stopped) {
        return;
      }
      onFrame(line);
    }
  };

  stream.setEncoding("utf8");
  stream.on("data", handle);
  stream.on("end", () => {
    for (const line of splitter.flush()) {
      // stop() 之后连收尾的残帧也不再投递：调用方既然已经收摊，就不该再收到东西。
      if (!state.stopped) {
        onFrame(line);
      }
    }
  });

  return () => {
    state.stopped = true;
    stream.off("data", handle);
  };
}

export { FrameError } from "./frame-error.ts";
export type { FrameErrorKind } from "./frame-error.ts";
