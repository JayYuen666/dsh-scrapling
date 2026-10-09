// dsh-scrapling/test/jsonl.test.ts —— 帧编解码与切帧。

import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  FrameSplitter,
  isFrameObject,
  pumpFrames,
} from "../lib/jsonl.ts";
import { FrameError } from "../lib/frame-error.ts";

/** 反复出现的样例帧，抽成常量免得重复字面量。 */
const FRAME_A = '{"a":1}';
const FRAME_B = '{"b":2}';

/**
 * 把若干片段当成一条字节流喂给切帧器，收齐所有帧。
 *
 * 用 `finished(stream)` 而不是 `new Promise` 包 `end` 事件：前者是官方封装，也不会
 * 触发本仓对 `new Promise` 的那条规则。
 *
 * @param chunks - 任意切片的文本
 * @returns 收到的帧序列
 */
async function collect(chunks: string[]): Promise<string[]> {
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
    expect(kindOf(() => encodeFrame(cyclic))).toBe("unparsable-json");
  });
});

describe("decodeFrame", () => {
  it("解析对象帧", () => {
    expect(decodeFrame('{"id":"1","ok":true}')).toStrictEqual({ id: "1", ok: true });
  });

  it("非法 json 抛 unparsable-json", () => {
    expect(kindOf(() => decodeFrame("not json"))).toBe("unparsable-json");
  });

  it("数组与标量都算 not-an-object", () => {
    for (const line of ["[]", "123", '"x"', "null", "true"]) {
      expect(kindOf(() => decodeFrame(line))).toBe("not-an-object");
    }
  });
});

describe("isFrameObject", () => {
  it("只接受普通对象", () => {
    expect(isFrameObject({})).toBe(true);
    for (const value of [[], null, 1, "x", undefined]) {
      expect(isFrameObject(value)).toBe(false);
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
});
