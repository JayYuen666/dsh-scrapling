// dsh-scrapling/lib/jsonl.ts —— JSON-lines 帧编解码。
//
// 注意别和 `@jayyuen66/dsh-plugin-shared/lib/jsonl` 搞混：那个是**日志文件尾部收缩**
// （shrinkJsonlTail），与本模块无关。
//
// 这里只解决一件事：把「字节流」和「一帧一个 JSON 对象」互相转换。切分规则必须与
// Python 侧的 bridge.py 对齐（一帧一行、行内不得有裸换行）。

import type { Readable } from "node:stream";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { FrameError } from "./frame-error.ts";

/** 「不是合法 JSON」这一类帧错误的 kind；抽成常量是因为它在三处出现。 */
const UNPARSABLE = "unparsable-json";

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
    throw new FrameError(UNPARSABLE, "frame is not JSON-serialisable", {
      cause: error,
    });
  }
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
    throw new FrameError(UNPARSABLE, `frame is not valid JSON: ${line.slice(0, 120)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new FrameError("not-an-object", `frame must be a JSON object: ${line.slice(0, 120)}`);
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
      if (line.trim().length > 0) {
        lines.push(line);
      }
      newlineAt = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.#buffer = "";
      throw new FrameError(
        UNPARSABLE,
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
}

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
    try {
      for (const line of splitter.push(text)) {
        if (state.stopped) {
          return;
        }
        onFrame(line);
      }
    } catch (error) {
      report(error);
    }
  };

  stream.setEncoding("utf8");
  stream.on("data", handle);
  stream.on("end", () => {
    try {
      for (const line of splitter.flush()) {
        // stop() 之后连收尾的残帧也不再投递：调用方既然已经收摊，就不该再收到东西。
        if (!state.stopped) {
          onFrame(line);
        }
      }
    } catch (error) {
      report(error);
    }
  });
  stream.on("error", (error: unknown) => {
    report(error);
  });

  return () => {
    state.stopped = true;
    stream.off("data", handle);
  };
}

export { FrameError } from "./frame-error.ts";
export type { FrameErrorKind } from "./frame-error.ts";
