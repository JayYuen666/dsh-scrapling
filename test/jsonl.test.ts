// dsh-scrapling/test/jsonl.test.ts —— 帧编解码与切帧。

import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  FRAME_ERROR_KINDS,
  FrameSplitter,
  MAX_FRAME_CHARS,
  pumpFrames,
} from "../lib/jsonl.ts";
import { FrameError } from "../lib/frame-error.ts";

/** 什么都不做的替身。 */
const noop = (): void => undefined;

/** 把转交过来的错误攒进一个数组。 */
function collectErrors(sink: unknown[]): (error: unknown) => void {
  return (error: unknown): void => {
    sink.push(error);
  };
}

/**
 * 记下转交过来的错误、然后再抛一次的 onError 替身。
 *
 * 「onError 自己抛了也不往上抛」这条得先证明转交**发生了**，再证明第二次抛被吃掉 ——
 * 只断言流安静收尾时，实现把异常整个吞掉也算通过。
 *
 * @param sink - 收账的数组
 * @returns 可直接交给 `pumpFrames` 的 onError
 */
function recordThenThrow(sink: unknown[]): (error: unknown) => void {
  return (error: unknown): void => {
    sink.push(error);
    throw new Error("second");
  };
}

/** 反复出现的样例帧，抽成常量免得重复字面量。 */
const FRAME_A = '{"a":1}';
const FRAME_B = '{"b":2}';

/**
 * 把若干片段喂给切帧器，收齐所有帧。
 *
 * 片段可以是文本，也可以是 `Buffer`：`pumpFrames` 在挂监听之前先 `setEncoding("utf8")`，
 * 所以字节案由 Node 的解码器收口，跨片段的半个多字节字符正是走这条路（见下面那条用例）。
 * 用 `finished(stream)` 而不是 `new Promise` 包 `end` 事件：前者是官方封装，也不会
 * 触发本仓对 `new Promise` 的那条规则。
 *
 * @param chunks - 任意切片的文本或字节
 * @returns 收到的帧序列
 */
async function collect(chunks: readonly (string | Buffer)[]): Promise<string[]> {
  const stream = Readable.from(chunks);
  const seen: string[] = [];
  pumpFrames(stream, (line) => {
    seen.push(line);
  });
  await finished(stream);
  return seen;
}

/**
 * 跑一段代码并报出它抛出的 FrameError 分类。
 *
 * 把 try/catch 收进 helper，是为了让 `expect` 待在条件语句之外 —— `expect` 写在 catch
 * 里只有一部分分支会跑到，失败时会给出误导性的「没有断言」。
 *
 * @param run - 待执行的代码
 * @returns 错误分类；没抛则给 "no-throw"
 */
function kindOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof FrameError ? error.kind : "not-a-frame-error";
  }
  return "no-throw";
}

describe("encodeFrame", () => {
  it("产出不含裸换行的单行", () => {
    expect(encodeFrame({ id: "1", note: "a\nb" })).not.toContain("\n");
  });

  it("序列化失败时立刻抛 FrameError，而不是拖到写管道时才炸", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(kindOf(() => encodeFrame(cyclic))).toBe(FRAME_ERROR_KINDS.unparsableJson);
  });

  it("序列化成 undefined 的载荷同样抛 FrameError", () => {
    // JSON.stringify 对 undefined、函数、Symbol 不抛错，而是返回 undefined。把那个
    // undefined 当字符串交给管道，写出的是字面量 "undefined"，对端解析成标量后按
    // 「不是对象」丢掉 —— 症状是一帧凭空消失，而不是一条能定位的报错。
    expect(kindOf(() => encodeFrame(undefined))).toBe(FRAME_ERROR_KINDS.unparsableJson);
  });
});

describe("帧错误分类表（FRAME_ERROR_KINDS）", () => {
  it("这份表在运行时也不可改写：类型派生与实际取值不会分叉", () => {
    // `as const` 只给编译期只读；`jsonl.ts` 把它原样 re-export，任何导入方都能改属性，
    // 改了之后 FrameErrorKind 仍允许旧值 —— 症状是「类型允许、运行时对不上」。
    expect(Object.isFrozen(FRAME_ERROR_KINDS)).toBe(true);
    const mutable = FRAME_ERROR_KINDS as { unparsableJson: string };
    expect(() => {
      mutable.unparsableJson = "mutated";
    }).toThrow(TypeError);
    expect(FRAME_ERROR_KINDS.unparsableJson).toBe("unparsable-json");
  });
});

describe("decodeFrame", () => {
  it("解析对象帧", () => {
    expect(decodeFrame('{"id":"1","ok":true}')).toStrictEqual({ id: "1", ok: true });
  });

  it("非法 json 抛 unparsable-json", () => {
    expect(kindOf(() => decodeFrame("not json"))).toBe(FRAME_ERROR_KINDS.unparsableJson);
  });

  it("解码失败的消息只报长度，不带帧原文（原文可能含凭据/页面正文）", () => {
    const secret = "sk-live-abcdef123456";
    let message = "";
    try {
      decodeFrame(`{"api_key":"${secret}",`);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("length=");
    expect(message).not.toContain(secret);
  });

  it("数组与标量都算 not-an-object", () => {
    for (const line of ["[]", "123", '"x"', "null", "true"]) {
      expect(kindOf(() => decodeFrame(line))).toBe(FRAME_ERROR_KINDS.notAnObject);
    }
  });
});

describe("frame splitter", () => {
  it("整帧一次到位", () => {
    expect(new FrameSplitter().push(`${FRAME_A}\n${FRAME_B}\n`)).toStrictEqual([FRAME_A, FRAME_B]);
  });

  it("跨切片拼接：残片留在缓冲里等下一段", () => {
    const splitter = new FrameSplitter();
    expect(splitter.push('{"a":')).toStrictEqual([]);
    expect(splitter.push("1}\n")).toStrictEqual([FRAME_A]);
  });

  it("空行被丢弃", () => {
    expect(new FrameSplitter().push(`\n\n${FRAME_A}\n\n`)).toStrictEqual([FRAME_A]);
  });

  it("flush 吐出没有尾随换行的最后一帧", () => {
    const splitter = new FrameSplitter();
    expect(splitter.push(`${FRAME_A}\n${FRAME_B}`)).toStrictEqual([FRAME_A]);
    expect(splitter.flush()).toStrictEqual([FRAME_B]);
    expect(splitter.flush()).toStrictEqual([]);
  });
});

describe("pumpFrames", () => {
  it("把任意切片的字节流还原成帧序列", async () => {
    await expect(collect([`${FRAME_A}\n{"b`, `":2}\n${FRAME_B}\n`])).resolves.toStrictEqual([
      FRAME_A,
      '{"b":2}',
      FRAME_B,
    ]);
  });

  it("数据不在挂监听的那一 tick 里吐出（回调里引用 stop 靠的就是这一点）", () => {
    // 两处用例在回调闭包里调用 `stop()`，而 `stop` 是 `const`：不炸只可能因为 `Readable.from`
    // 的 data 落在 pumpFrames 返回之后。这个假设现在由本条钉住 —— 哪天实现改成同步吐缓冲，
    // 这里会以一条对得上的断言红，而不是在别处抛 `Cannot access 'stop' before initialization`。
    const seen: string[] = [];
    let stop: () => void = noop;
    stop = pumpFrames(Readable.from([`${FRAME_A}\n`]), (line) => {
      seen.push(line);
      stop();
    });
    expect(seen).toStrictEqual([]);
  });

  it("多字节字符被切在两个 Buffer 片段之间时仍然解出一帧", async () => {
    // 正文里的中文按 UTF-8 是三字节；`setEncoding("utf8")` 之前把字节切成两半，
    // 解码器要把半个字符留到下一段。走 `Readable.from(string[])` 一辈子碰不到这条路径。
    const bytes = Buffer.from(`${FRAME_A}\n{"note":"中"}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("中", "utf8")) + 1;
    await expect(collect([bytes.subarray(0, cut), bytes.subarray(cut)])).resolves.toStrictEqual([
      FRAME_A,
      '{"note":"中"}',
    ]);
  });

  it("流被 close 而没有 end 时，残留的最后一帧仍被投递", async () => {
    const seen: string[] = [];
    const stream = new Readable({ read: noop });
    const stop = pumpFrames(stream, (line) => {
      seen.push(line);
    });
    stream.emit("data", `{"tail":1}`);
    stream.emit("close");
    expect(seen).toStrictEqual(['{"tail":1}']);
    stop();
  });

  it("流末尾没有换行时靠 end 事件补出最后一帧", async () => {
    await expect(collect([`${FRAME_A}\n${FRAME_B}`])).resolves.toStrictEqual([FRAME_A, FRAME_B]);
  });

  it("停止后连收尾的残帧也不投递", async () => {
    const seen: string[] = [];
    // 故意留一个没有尾随换行的残帧：end 时的 flush 会捞到它，而此时已停止。
    const stream = Readable.from([`${FRAME_A}\n{"c":3`]);
    const stop = pumpFrames(stream, (line) => {
      seen.push(line);
      stop();
    });
    await finished(stream);
    expect(seen).toStrictEqual([FRAME_A]);
  });

  it("停止后不再回调", async () => {
    const seen: string[] = [];
    const stream = Readable.from([`${FRAME_A}\n${FRAME_B}\n`]);
    const stop = pumpFrames(stream, (line) => {
      seen.push(line);
      stop();
    });
    await finished(stream);
    expect(seen).toStrictEqual([FRAME_A]);
  });

  it("stop() 之后 end 与 error 都不再回调，且报错不会变成未捕获异常", async () => {
    const frames: string[] = [];
    const errors: unknown[] = [];
    const stream = new Readable({ read: noop });
    const stop = pumpFrames(
      stream,
      (line) => {
        frames.push(line);
      },
      collectErrors(errors),
    );
    stop();
    // 停止之后再喂 data / end / error：契约是「调用后不再回调」。error 还必须有人接住，
    // 否则 EventEmitter 会把它抛成未捕获异常。
    stream.emit("data", `${FRAME_A}\n`);
    stream.emit("end");
    expect(() => stream.emit("error", new Error("late pipe broke"))).not.toThrow();
    // 「没收到回调」是断言缺失，等一 tick 并不能证明什么；能证明的是 stop() 把三个监听器
    // 都摘了（这是它承诺的机制），然后再读两位收集器。
    await vi.waitFor(() => {
      expect(stream.listenerCount("data")).toBe(0);
      expect(stream.listenerCount("end")).toBe(0);
    });
    expect(frames).toStrictEqual([]);
    expect(errors).toStrictEqual([]);
  });

  it("某一帧回调抛错不耽误同一个 chunk 里后面的帧", async () => {
    const delivered: string[] = [];
    const errors: unknown[] = [];
    const stream = Readable.from([`${FRAME_A}\n${FRAME_B}\n`]);
    pumpFrames(
      stream,
      (line) => {
        delivered.push(line);
        if (line === FRAME_A) {
          throw new Error("first frame blew up");
        }
      },
      collectErrors(errors),
    );
    await finished(stream);
    // 帧已经被 splitter 消费掉，不会重放：让异常中断循环等于静默丢掉后面那帧。
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(delivered).toStrictEqual([FRAME_A, FRAME_B]);
    expect(String(errors[0])).toContain("first frame blew up");
  });

  it("残帧超限时把 FrameError 转交 onError，而不是从 data 监听器里抛出去", async () => {
    const frames: string[] = [];
    const errors: unknown[] = [];
    const stream = new Readable({ read: noop });
    pumpFrames(
      stream,
      (line) => {
        frames.push(line);
      },
      collectErrors(errors),
    );
    // 只喂不带换行的一大段：切帧器攒到字符上限就抛 frame-too-large，泵必须把它
    // 交给 onError（从 data 监听器里抛出去就是宿主进程的未捕获异常）。
    stream.emit("data", "x".repeat(MAX_FRAME_CHARS + 1));
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(frames).toStrictEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FrameError);
    expect(errors[0]).toMatchObject({ kind: FRAME_ERROR_KINDS.frameTooLarge });
  });
});

describe("frame splitter 上限", () => {
  it("残片超过上限时抛独立的 frame-too-large 分类，而不是冒充协议损坏", () => {
    // 限流/长度一类与「JSON 解析失败」要采取的行动相反：下游按 kind 决定丢连接或重试时，
    // 两者混成一个分类会把限流误判成对端坏了。
    const splitter = new FrameSplitter();
    // 上限从实现导出，测试直接构造「比上限多一个字符」：用循环逼近阈值等于把
    // `MAX_FRAME_CHARS` 又抄了一遍，改档时这条会悄悄失效。
    const kind = kindOf(() => {
      splitter.push("x".repeat(MAX_FRAME_CHARS + 1));
    });
    expect(kind).toBe(FRAME_ERROR_KINDS.frameTooLarge);
  });

  it("超长帧与换行落在同一个 chunk 里同样判超限（只看残片会漏掉）", () => {
    const splitter = new FrameSplitter();
    expect(kindOf(() => splitter.push(`${"x".repeat(MAX_FRAME_CHARS + 1)}\n`))).toBe(
      FRAME_ERROR_KINDS.frameTooLarge,
    );
    // 超限后缓冲被清空，后续正常帧不粘上半截坏内容。
    expect(splitter.push(`${FRAME_B}\n`)).toStrictEqual([FRAME_B]);
  });

  it("超限后缓冲被丢弃，下一帧正常，不会永远卡在坏状态里", () => {
    const splitter = new FrameSplitter();
    expect(kindOf(() => splitter.push("x".repeat(MAX_FRAME_CHARS + 1)))).toBe(
      FRAME_ERROR_KINDS.frameTooLarge,
    );
    expect(splitter.push(`${FRAME_B}\n`)).toStrictEqual([FRAME_B]);
  });
});

describe("pumpFrames 的错误通道", () => {
  it("流的 error 事件被转交给 onError，不会变成未捕获异常掀翻宿主", async () => {
    const seen: unknown[] = [];
    const stream = new Readable({ read: noop });
    pumpFrames(stream, noop, collectErrors(seen));
    stream.emit("error", new Error("pipe broke"));
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(String(seen[0])).toContain("pipe broke");
  });

  it("onFrame 抛错被吃掉并转交，不从 data 事件里逃出去", async () => {
    const seen: unknown[] = [];
    const stream = Readable.from([`${FRAME_A}\n`]);
    pumpFrames(
      stream,
      () => {
        throw new Error("consumer blew up");
      },
      collectErrors(seen),
    );
    await finished(stream);
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(String(seen[0])).toContain("consumer blew up");
  });

  it("收尾那一帧里回调抛错也走 onError", async () => {
    const seen: unknown[] = [];
    // 流以「没有尾随换行的半帧」结束，帧在 end 事件里由 flush() 吐出 —— 那时抛的错
    // 同样不能从事件回调里逃出去。
    const stream = Readable.from([`{"c":1`]);
    pumpFrames(
      stream,
      () => {
        throw new Error("flush consumer blew up");
      },
      collectErrors(seen),
    );
    await finished(stream);
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(String(seen[0])).toContain("flush consumer blew up");
  });

  it("onError 自己抛了也不会再往上抛 —— 此时已经在事件回调的栈上", async () => {
    const stream = Readable.from([`${FRAME_A}\n`]);
    const forwarded: unknown[] = [];
    pumpFrames(
      stream,
      () => {
        throw new Error("first");
      },
      // 先记账再抛：这条判的是「转交发生了、接收方又炸了也没冒出去」。
      recordThenThrow(forwarded),
    );
    await expect(finished(stream)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(forwarded).toHaveLength(1);
    });
    expect(String(forwarded[0])).toContain("first");
  });

  it("不给 onError 时错误被安静丢弃，默认参数让旧调用点继续成立", async () => {
    const stream = new Readable({ read: noop });
    pumpFrames(stream, noop);
    expect(() => stream.emit("error", new Error("x"))).not.toThrow();
  });
});
