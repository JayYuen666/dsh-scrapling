// dsh-scrapling/lib/jsonl.ts —— JSON-lines 帧编解码。
//
// 注意别和 `@jayyuen66/dsh-plugin-shared/lib/jsonl` 搞混：那个是**日志文件尾部收缩**
// （shrinkJsonlTail），与本模块无关。
//
// 这里只解决一件事：把「字节流」和「一帧一个 JSON 对象」互相转换。切分规则必须与
// Python 侧的 bridge.py 对齐（一帧一行、行内不得有裸换行）。

import type { Readable } from "node:stream";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { FRAME_ERROR_KINDS, FrameError } from "./frame-error.ts";

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
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new FrameError(FRAME_ERROR_KINDS.unparsableJson, "frame is not JSON-serialisable", {
      cause: error,
    });
  }
  // JSON.stringify 对 undefined、函数、Symbol 不抛错而是返回 undefined：直接把它当
  // string 返回会在管道里写出字面量 "undefined" 或触发难以排查的写失败。序列化失败
  // 必须在这里就炸出来。
  if (encoded === undefined) {
    throw new FrameError(FRAME_ERROR_KINDS.unparsableJson, "frame is not JSON-serialisable");
  }
  return encoded;
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
    throw new FrameError(
      FRAME_ERROR_KINDS.unparsableJson,
      `frame is not valid JSON (length=${String(line.length)})`,
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed)) {
    throw new FrameError(
      FRAME_ERROR_KINDS.notAnObject,
      `frame must be a JSON object (length=${String(line.length)})`,
    );
  }
  return parsed;
}

/**
 * 残帧的上限，按 UTF-16 字符数计（buffer 是已解码的字符串）。
 *
 * 与 Python 侧的 8 MiB **字节**上限数值相同但口径不同：同样的数值对 CJK 文本，这里的
 * 字符数对应更多字节，所以本侧的兜底比对端更宽 —— 它只需要拦住「对端只吐不带换行的
 * 内容、缓冲按到达速度一路增长」这条失控路径，精确的协议上限由按字节判的那一侧执行。
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** 增量切帧器：喂进任意切片的文本，吐出完整的一行。 */
export class FrameSplitter {
  #buffer = "";

  /**
   * 喂一段文本进去，把其中完整的行收走。
   *
   * 末尾没换行的残片会留在缓冲里等下一段 —— 这正是「对端分多次 write」时要处理的情况。
   *
   * 残片设上限：没有上限时，对端只要一直吐不带换行的内容，这里就是一个无界增长的字符串，
   * 整条链路的内存都被它吃光。超限时丢弃残帧并抛 FrameError，由调用方按「对端协议坏了」
   * 处理 —— 继续无脑攒下去才是真正的故障。
   *
   * @param chunk - 任意长度的文本片段
   * @returns 完整的帧文本列表
   * @throws FrameError - 残片超过上限时
   */
  public push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let newlineAt = this.#buffer.indexOf("\n");
    while (newlineAt >= 0) {
      const line = this.#buffer.slice(0, newlineAt);
      this.#buffer = this.#buffer.slice(newlineAt + 1);
      if (line.length > MAX_FRAME_BYTES) {
        // 超长帧与换行落在同一个 chunk 时，只看残片会漏掉它：切行已经把它移出缓冲区。
        this.#buffer = "";
        throw new FrameError(
          FRAME_ERROR_KINDS.frameTooLarge,
          `a frame went over ${MAX_FRAME_BYTES} bytes`,
        );
      }
      if (line.trim().length > 0) {
        lines.push(line);
      }
      newlineAt = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.#buffer = "";
      // 长度超限按独立的分类抛，而不是「不是合法 JSON」：下游若按 kind 决定丢弃连接或
      // 重试，把限流一类当成对端协议损坏会走向完全相反的行动。
      throw new FrameError(
        FRAME_ERROR_KINDS.frameTooLarge,
        `a frame went over ${MAX_FRAME_BYTES} bytes without a newline`,
      );
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

  /** 丢弃缓冲区里的残片。调用方已经收摊时用，避免残片一直占着内存。 */
  public clear(): void {
    this.#buffer = "";
  }
}

/** stop() 之后流再报错时的兜底监听：吞掉，不让 EventEmitter 把它变成未捕获异常。 */
const swallowLateError = (): void => undefined;

/**
 * 把一个 Readable 持续切成帧并回调。
 *
 * **流上必须挂 error 监听。** EventEmitter 的 'error' 没有监听者时会变成未捕获异常：sidecar
 * 的管道一旦报错（进程被杀、管道被拆），异常就从这里一路抛到宿主进程，把整个 Harness 带
 * 下去。所以流上的错误一律转交给 onError，不让它冒泡。
 *
 * onFrame / onError 自己的同步异常同样在这里被吃掉再转交：回调是消费方（工具执行、作业
 * 输出），让它抛穿 'data' 监听器等于把消费方的一个 bug 升级成宿主崩溃。
 *
 * @param stream - 输入流
 * @param onFrame - 每收到一帧调用一次
 * @param onError - 流报错、切帧失败或回调抛错时调用；缺省即丢弃
 * @returns 停止函数；调用后不再回调
 */
export function pumpFrames(
  stream: Readable,
  onFrame: (line: string) => void,
  onError: (error: unknown) => void = (): void => undefined,
): () => void {
  const splitter = new FrameSplitter();
  // 共享状态放对象里而不是裸 let：stop() 由调用方持有，会在 for 循环**两次迭代之间**
  // 把标志翻掉。用裸 let 时 TS 的控制流分析会把它窄化成 false，于是那句守卫看起来
  // 「永远不成立」被判掉 —— 那是分析器的错觉，不是代码里真的没这个分支。
  const state = { stopped: false };

  const report = (error: unknown): void => {
    try {
      onError(error);
    } catch {
      // onError 自己抛了也不能再往上抛：这里已经在事件回调的栈上，再抛就是未捕获异常。
    }
  };

  // `setEncoding("utf8")` 在挂监听器之前就由本函数设好（见下面 stream.setEncoding），所以
  // 'data' 交来的只会是 string；stop() 又会把 data 监听器摘掉，停止后的流进不到这里。
  const handle = (chunk: string): void => {
    let frames: string[];
    try {
      frames = splitter.push(chunk);
    } catch (error) {
      report(error);
      return;
    }
    for (const line of frames) {
      if (state.stopped) {
        return;
      }
      try {
        onFrame(line);
      } catch (error) {
        // 单帧回调的异常只影响这一帧：它已经离开 splitter，不会重放；中断整个循环
        // 会把同一个 chunk 里后面的帧一起静默丢掉（state.stopped 还是 false，泵照旧
        // 活着），那种丢帧在消费方看来无从发现。
        report(error);
      }
    }
  };

  const handleEnd = (): void => {
    // flush() 只做 trim + 清空，没有会抛的路径，所以不套 try/catch：套一层永远进不去的
    // catch 只会给覆盖率留一条假分支。加抛错路径时记得在这里补回 try/catch。
    const frames = splitter.flush();
    // 这里不再判 state.stopped：stop() 会把 handleEnd 一起摘掉（见下面 off("end")），
    // 所以能进到这里的流一定还没停；多一个构造上不可达的守卫只会给覆盖率留假分支。
    // flush() 最多吐一帧（缓冲区里不可能含换行：push 已经把完整的行都收走了）。
    for (const line of frames) {
      try {
        onFrame(line);
      } catch (error) {
        report(error);
      }
    }
  };
  const handleError = (error: unknown): void => {
    // stop() 会把本监听器摘掉并换成 swallowLateError，所以这里不会再看到 stopped 的流；
    // 保留「只负责转交」这一条，避免多一条永远为假的早返回。
    report(error);
  };

  // end 与 close 都收尾：流被 destroy()/对端进程被杀时 close 先到、end 不会触发，
  // 只挂 end 会把已经到达的最后一帧残片丢掉。flush() 幂等，两个事件都到也只吐一次。
  stream.setEncoding("utf8");
  stream.on("data", handle);
  stream.on("end", handleEnd);
  stream.on("close", handleEnd);
  stream.on("error", handleError);

  return () => {
    state.stopped = true;
    // 三个 handler 一起摘：只摘 data 时，end/error 仍会在 stop() 之后回调，违背
    // 「调用后不再回调」的契约，也会一直持有 splitter 与回调闭包直到流销毁。
    stream.off("data", handle);
    stream.off("end", handleEnd);
    stream.off("close", handleEnd);
    stream.off("error", handleError);
    // EventEmitter 的 'error' 没有监听者时会变成未捕获异常：收摊之后流再报错
    // （进程被杀、管道被拆）不能把宿主掀翻，所以留一个不带闭包的吞错监听。
    stream.on("error", swallowLateError);
    splitter.clear();
  };
}

export { FrameError } from "./frame-error.ts";
export type { FrameErrorKind } from "./frame-error.ts";
export { FRAME_ERROR_KINDS } from "./frame-error.ts";
