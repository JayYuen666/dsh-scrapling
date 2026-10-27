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
import { describe, expect, it } from "vitest";
import { buildHost } from "../build-host.ts";
import { RUNTIME_DESCRIPTORS } from "../src/runtime-reader.ts";

/** 宿主侧挂上 Remote 标记的四个方法；与 lib/runtime-remote.ts 的 markRemote 调用一一对应。 */
const REMOTE_METHODS = ["status", "installPack", "repairPack", "cancelJob"] as const;

/**
 * 从打包文本里取某个方法的参数表。
 *
 * 判据用「方法名 + 括号 + 紧接左花括号」，于是只会命中方法定义，不会命中字符串常量、属性
 * 访问或调用点。压缩后的方法体一定是 name(params){...} 这个形状（空白已压掉）。
 *
 * @param code - 打包后的整份文本
 * @param method - 方法名
 * @returns 参数名列表
 */
function signatureOf(code: string, method: string): readonly string[] {
  const pattern = new RegExp(`\\b${method}\\(([^)]*)\\)\\{`, "u");
  const match = pattern.exec(code);
  if (match === null) {
    throw new Error(`产物里找不到方法定义 ${method}(...){`);
  }
  const body = (match[1] ?? "").trim();
  return body.length === 0 ? [] : body.split(",").map((part) => part.trim());
}

describe("build-host 产物与 Remote 描述符的参数名契约", () => {
  it("四个 Remote 方法的参数名与客户端描述符的 wire 名逐字一致", async () => {
    const code = await buildHost();
    for (const method of REMOTE_METHODS) {
      const descriptor = RUNTIME_DESCRIPTORS.find((candidate) => candidate.method === method);
      expect(descriptor, `缺少 ${method} 的客户端描述符`).toBeDefined();
      const wires = (descriptor?.parameters ?? []).map((parameter) => parameter.wire);
      expect(signatureOf(code, method), `${method} 的产物参数名与描述符 wire 不一致`).toStrictEqual(
        wires,
      );
    }
  });

  it("参数名没有被压成单字母（mangle 关闭的直接证据）", async () => {
    const code = await buildHost();
    expect(signatureOf(code, "installPack")).toStrictEqual(["request"]);
    expect(signatureOf(code, "repairPack")).toStrictEqual(["request"]);
    expect(signatureOf(code, "cancelJob")).toStrictEqual(["request"]);
    expect(signatureOf(code, "status")).toStrictEqual([]);
  });
});
