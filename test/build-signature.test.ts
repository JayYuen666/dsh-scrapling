// test/build-signature.test.ts —— 打包产物里的 Remote 方法参数名必须与客户端描述符一致。
//
// 宿主网关在没有 typert strict 描述符时按 SRC 回退，wire 名取自**产物的运行期函数参数名**
// （deepseek-harness 的 api/gateway/src/index.ts 里 methodParameterNames 用
// Function.prototype.toString 读参数表）；客户端描述符把参数名本身声明成 wire
// （src/runtime-reader.ts 的 RUNTIME_DESCRIPTORS）。构建一旦打开 mangle，参数名被压成单字母，
// 客户端按 request 发、宿主按单字母收，每次调用都被 gateway/arguments-invalid 拒绝 —— 而
// 源码侧类型检查、其余单测、设置卡数据面全部照绿，所以判据只能落在打包后的文本上。
//
// 这里对**内存构建**取签名，不读磁盘上的 host.js：磁盘产物可能是陈旧的，那样测到的是上一次
// 构建的运气，而不是这次构建会发出去的东西。
import { beforeAll, describe, expect, it } from "vitest";
import { buildHost } from "../build-host.ts";
import { RUNTIME_DESCRIPTORS } from "../src/runtime-reader.ts";

/** 宿主侧挂上 Remote 标记的四个方法；与 lib/runtime-remote.ts 的 markRemote 调用一一对应。 */
const REMOTE_METHODS = ["status", "installPack", "repairPack", "cancelJob"] as const;

/**
 * 从打包文本里取某个方法的参数表。
 *
 * 判据是「方法名 + 括号 + 紧接左花括号」，且**整份产物里只许命中一次**：产物是打包后的整棵
 * 依赖树，第三方层里只要有一个同名定义排在前面，取第一处就等于拿别人的参数表来判本包这四
 * 个 Remote 方法的契约 —— 那正是「假绿」的形态。名字前一位不许是 `.`，于是 `n.status(){`
 * 这类调用点形状也不会算命中。
 *
 * @param code - 打包后的整份文本
 * @param method - 方法名
 * @returns 参数名列表
 * @throws 命中数不是一时点名方法名与命中数
 */
function signatureOf(code: string, method: string): readonly string[] {
  const hits = [...code.matchAll(new RegExp(`[^.\\w$]${method}\\(([^)]*)\\)\\{`, "gu"))];
  if (hits.length !== 1) {
    throw new Error(
      `产物里 ${method}(...){ 应只命中一次，实际 ${String(hits.length)} 次：这条判据的来源不可信`,
    );
  }
  const body = (hits[0]?.[1] ?? "").trim();
  return body.length === 0 ? [] : body.split(",").map((part) => part.trim());
}

describe("signatureOf 自身的命中判据", () => {
  // 这四条不打产物，只喂合成文本：整份产物里同名定义只许出现一次这件事，在今天的产物上
  // 看不出差别（各命中一次），只有把形状造出来才判得动。
  it("命中一次时按逗号拆出参数名", () => {
    expect(signatureOf("{status(a, b){}}", "status")).toStrictEqual(["a", "b"]);
  });

  it("参数表为空时回空列表", () => {
    expect(signatureOf("{status(){}}", "status")).toStrictEqual([]);
  });

  it("只有调用点形状时点名「0 次」，而不是把别人的形状当契约", () => {
    expect(() => signatureOf("n.status(){}x.status(a){}", "status")).toThrow(/实际 0 次/u);
  });

  it("同名定义出现两次时点名命中数，不拿第一处当契约", () => {
    expect(() => signatureOf("{status(a){}};{status(b,c){}}", "status")).toThrow(/实际 2 次/u);
  });
});
describe("build-host 产物与 Remote 描述符的参数名契约", () => {
  // 两条用例判的是同一份产物，构建只跑一次：跑两遍等于把整份打包重复一遍，而两次构建之间
  // 读到的「契约」属于两个产物，红话说不清是哪一次的运气。
  const built = { code: "" };
  beforeAll(async () => {
    built.code = await buildHost();
  });

  it("四个 Remote 方法的参数名与客户端描述符的 wire 名逐字一致", () => {
    for (const method of REMOTE_METHODS) {
      const descriptor = RUNTIME_DESCRIPTORS.find((candidate) => candidate.method === method);
      if (descriptor === undefined) {
        throw new Error(`缺少 ${method} 的客户端描述符`);
      }
      const wires = descriptor.parameters.map((parameter) => parameter.wire);
      expect(
        signatureOf(built.code, method),
        `${method} 的产物参数名与描述符 wire 不一致`,
      ).toStrictEqual(wires);
    }
  });

  it("参数名没有被压成单字母（mangle 关闭的直接证据）", () => {
    // 这张表按字面钉 wire 名，与上一条不是重复：上一条比的是「产物与描述符一致」，两边一起
    // 改名（mangle 打开把参数压成单字母、描述符跟着改）它不会红，这一条会。
    expect(signatureOf(built.code, "installPack")).toStrictEqual(["request"]);
    expect(signatureOf(built.code, "repairPack")).toStrictEqual(["request"]);
    expect(signatureOf(built.code, "cancelJob")).toStrictEqual(["request"]);
    expect(signatureOf(built.code, "status")).toStrictEqual([]);
  });
});
