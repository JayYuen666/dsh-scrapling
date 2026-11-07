// 协议层的属性测试：FrameSplitter 是「对端任意切块 → 完整帧」的唯一入口，url-policy 的
// 脱敏是「URL 凭据不进文案」的闸门。期望值来自 lib/jsonl.ts / lib/url-policy.ts 头注
// 写明的契约，不从实现派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import { FrameSplitter, FrameError, encodeFrame } from "../../lib/jsonl.ts";
import { redactUrlSecrets } from "../../lib/url-policy.ts";

/** 帧载荷：单行 JSON 对象（不含换行）。 */
const framePayloadArb = fc.record(
  { id: fc.stringMatching(/^h\d{1,3}$/u), seq: fc.integer({ min: 0, max: 999 }) },
  { requiredKeys: [] },
);

describe("frame 切块重组的性质", () => {
  it("任意切块方式喂入，吐出的帧序列与整段喂入完全一致", () => {
    fc.assert(
      fc.property(
        fc.array(framePayloadArb, { maxLength: 6 }),
        fc.integer({ min: 1, max: 12 }),
        (frames, sliceCount) => {
          const stream = frames.map((frame) => `${encodeFrame(frame)}\n`).join("");
          // 随机切块：按 sliceCount 个等宽窗切开（切块边界与帧边界刻意不对齐）。
          const width = Math.max(1, Math.ceil(stream.length / sliceCount));
          const splitter = new FrameSplitter();
          const received: string[] = [];
          for (let index = 0; index < stream.length; index += width) {
            received.push(...splitter.push(stream.slice(index, index + width)));
          }
          received.push(...splitter.flush());
          assert.deepEqual(
            received,
            frames.map((frame) => encodeFrame(frame)),
          );
        },
      ),
    );
  });

  it("空行与纯空白行不产帧；flush 幂等（第二次 flush 为空）", () => {
    const splitter = new FrameSplitter();
    assert.deepEqual(splitter.push(`${encodeFrame({ id: "h1" })}\n\n   \n`), [
      encodeFrame({ id: "h1" }),
    ]);
    assert.deepEqual(splitter.flush(), []);
    assert.deepEqual(splitter.flush(), []);
  });

  it("超长帧（>8MiB）按 frameTooLarge 抛，且缓冲被清空（连接判死后的干净态）", () => {
    const splitter = new FrameSplitter();
    const oversize = `${"x".repeat(8 * 1024 * 1024 + 1)}\n`;
    assert.throws(() => splitter.push(oversize), FrameError);
    // 清空后的缓冲还能继续用：下一帧正常吐出。
    assert.deepEqual(splitter.push(`${encodeFrame({ ok: true })}\n`), [encodeFrame({ ok: true })]);
  });
});

describe("url 脱敏的性质", () => {
  const userArb = fc.stringMatching(/^[a-z0-9]{3,8}$/u);
  const secretArb = fc.stringMatching(/^[A-Za-z0-9]{8,16}$/u);
  const hostArb = fc.stringMatching(/^example-[a-z0-9]{1,6}\.invalid$/u);

  it("任意带 userinfo 的 URL，产物永不含明文口令；scheme 与路径保留", () => {
    fc.assert(
      fc.property(
        userArb,
        secretArb,
        hostArb,
        fc.boolean(),
        fc.boolean(),
        (user, secret, host, https, trailing) => {
          const scheme = https ? "https" : "http";
          const url = `${scheme}://${user}:${secret}@${host}/a/b${trailing ? "/" : ""}`;
          const redacted = redactUrlSecrets(url);
          assert.equal(redacted.includes(secret), false, `明文口令泄漏：${redacted}`);
          assert.ok(redacted.startsWith(`${scheme}://`));
          assert.ok(redacted.includes("***@"));
          assert.ok(redacted.includes(`${host}/a/b`));
        },
      ),
    );
  });

  it("路径里的普通 @ 不是 userinfo（探针实测的负例面）", () => {
    fc.assert(
      fc.property(hostArb, (host) => {
        const plain = `https://${host}/a@b/c`;
        assert.equal(redactUrlSecrets(plain), plain, "路径中的 @ 被误抹");
      }),
    );
  });

  it("无 scheme 形态（user:pass@host 与协议相对）同样脱敏", () => {
    fc.assert(
      fc.property(userArb, secretArb, hostArb, (user, secret, host) => {
        assert.equal(redactUrlSecrets(`${user}:${secret}@${host}/x`).includes(secret), false);
        assert.equal(redactUrlSecrets(`//${user}:${secret}@${host}/x`).includes(secret), false);
      }),
    );
  });
});
