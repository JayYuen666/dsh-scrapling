// test/managed-host.ts —— process.platform / process.arch 的伪装夹具。
//
// 这一层单独钉：夹具自己出错时症状是「某组用例按错的平台跑、或跑完之后整个进程永久停在
// 伪装值上」，而那种失败会伪装成被测代码的缺陷。

import { describe, expect, it } from "vitest";
import { mockPlatform } from "./managed-host.ts";

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
/** 模拟「属性被别的代码接过去了」时用的外来 getter（提到模块级：它不捕获任何东西）。 */
const FOREIGN_GETTER = (): string => "aix";

describe("mockPlatform", () => {
  it("装上之后两个属性都读伪装值，恢复之后回到真实值", () => {
    const restore = mockPlatform("linux", "x64");
    expect(process.platform).toBe("linux");
    expect(process.arch).toBe("x64");
    restore();
    expect(process.platform).toBe(REAL_PLATFORM);
    expect(process.arch).toBe(REAL_ARCH);
  });

  it("恢复函数可以重复调用：第二次时属性已不归自己，什么都不做", () => {
    const restore = mockPlatform("linux", "x64");
    restore();
    restore();
    restore();
    expect(process.platform).toBe(REAL_PLATFORM);
    expect(process.arch).toBe(REAL_ARCH);
  });

  it("嵌套着的两层按非 LIFO 顺序恢复时，剩下的那层仍生效、也不把假值留在进程上", () => {
    // 真实事故形态：文件级 beforeAll 装 darwin，某条用例临时装 linux，而那条用例先结束时
    // 拿到的是内层恢复函数。外层若按「写回自己捕获的描述符」恢复，就会把真实描述符写到
    // 仍在生效的内层伪装上，随后内层恢复再写回外层那个假 getter —— 整轮进程停在 darwin。
    const outer = mockPlatform("darwin", "arm64");
    const inner = mockPlatform("linux", "x64");
    expect(process.platform).toBe("linux");

    outer();
    // 外层先撤：内层还在，平台上仍是 linux（而不是被写回真实值、也不是被写回外层假值）。
    expect(process.platform).toBe("linux");
    expect(process.arch).toBe("x64");

    inner();
    expect(process.platform).toBe(REAL_PLATFORM);
    expect(process.arch).toBe(REAL_ARCH);
  });

  it("嵌套着的两层按 LIFO 恢复时，外层仍是外层、撤完才回真实值", () => {
    const outer = mockPlatform("darwin", "arm64");
    const inner = mockPlatform("linux", "x64");
    inner();
    expect(process.platform).toBe("darwin");
    expect(process.arch).toBe("arm64");
    outer();
    expect(process.platform).toBe(REAL_PLATFORM);
    expect(process.arch).toBe(REAL_ARCH);
  });

  it("属性被外部改过时不去覆盖它，但仍如实收掉自己那一层", () => {
    const restore = mockPlatform("linux", "x64");
    Object.defineProperty(process, "platform", { configurable: true, get: FOREIGN_GETTER });
    restore();
    // 别人的财产不动：这一步若把自己捕获的真实描述符写回去，就等于替别人决定了属性归属。
    expect(process.platform).toBe("aix");
    // 收尾：把真实值放回去，免得把 aix 泄漏给同进程里的后续用例。
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: REAL_PLATFORM,
      writable: false,
    });
    expect(process.platform).toBe(REAL_PLATFORM);
  });
});
