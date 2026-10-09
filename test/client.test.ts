// dsh-scrapling/test/client.test.ts —— Client 半：结果行规格与 slot 注册。
//
// Client 半跑在浏览器里，没法在这里起真客户端；所以把可测的部分拆成纯函数
// （buildRow）与一段注册逻辑（apply 用假 ctx 驱动），两者都能在 Node 下验证。

import { describe, expect, it } from "vitest";
import { buildRow, ROW_TOOLS } from "../src/client-entry.ts";
import { BUNDLE_PACKAGE_NAME } from "../src/settings-fields.ts";

/** 测试里反复用到的示例地址。 */
const SAMPLE = "https://example.test/a";

describe("buildRow", () => {
  it("抓取类展示 URL 与 HTTP 状态", () => {
    const row = buildRow(
      "scrapling_fetch",
      { url: SAMPLE },
      { url: SAMPLE, statusCode: 200, truncated: false },
    );
    expect(row.title).toBe("scrapling_fetch");
    expect(row.fields).toStrictEqual([
      { label: "URL", value: SAMPLE },
      { label: "HTTP", value: "200" },
    ]);
  });

  it("投影缺失时退回参数里的 URL", () => {
    const row = buildRow("scrapling_render", { url: "https://example.test/b" }, undefined);
    expect(row.fields[0]).toStrictEqual({ label: "URL", value: "https://example.test/b" });
  });

  it("截断时明确标出来", () => {
    const row = buildRow(
      "scrapling_render",
      { url: "u" },
      { url: "u", statusCode: 200, truncated: true },
    );
    expect(row.fields.some((field) => field.value === "已截断")).toBe(true);
  });

  it("两边都是垃圾时不抛，字段为空", () => {
    const row = buildRow("scrapling_fetch", "nope", 42);
    expect(row.fields).toStrictEqual([]);
    expect(row.title).toBe("scrapling_fetch");
  });

  it("extract 带选择器标题与匹配数", () => {
    const row = buildRow("scrapling_extract", { selector: "table td" }, { count: 7 });
    expect(row.title).toBe("scrapling_extract table td");
    expect(row.fields).toStrictEqual([{ label: "匹配", value: "7" }]);
  });

  it("extract 没有选择器时只给工具名", () => {
    expect(buildRow("scrapling_extract", {}, {}).title).toBe("scrapling_extract");
  });

  it("session_open 展示类型与会话 id", () => {
    const row = buildRow("scrapling_session_open", { sessionType: "browser" }, { sessionId: "s1" });
    expect(row.fields).toStrictEqual([
      { label: "类型", value: "browser" },
      { label: "会话", value: "s1" },
    ]);
  });

  it("session_close / session_list 各有各的字段", () => {
    expect(buildRow("scrapling_session_close", { sessionId: "s1" }, {}).fields).toStrictEqual([
      { label: "会话", value: "s1" },
    ]);
    expect(buildRow("scrapling_session_list", {}, { count: 3 }).fields).toStrictEqual([
      { label: "会话数", value: "3" },
    ]);
  });

  it("crawl 展示起始、上限与作业 id", () => {
    const row = buildRow(
      "scrapling_crawl",
      { url: "https://example.test", maxPages: 20 },
      { jobId: "scrapling-1" },
    );
    expect(row.fields).toStrictEqual([
      { label: "起始", value: "https://example.test" },
      { label: "上限", value: "20" },
      { label: "作业", value: "scrapling-1" },
    ]);
  });

  it("每个登记的工具都能产出一行", () => {
    for (const tool of ROW_TOOLS) {
      const row = buildRow(tool, { url: "u", selector: "s" }, { url: "u", statusCode: 200 });
      expect(row.tool).toBe(tool);
    }
  });
});

describe("apply", () => {
  it("为每个工具注册一个 tool.call.toolview", async () => {
    const registered: string[] = [];
    const ctx = {
      slots: {
        inject: (_slot: string, register: () => void): void => {
          register();
        },
        register: (options: { name: string; key: string }): (() => void) => {
          registered.push(options.key);
          return (): void => undefined;
        },
      },
      effect: (): unknown => undefined,
    };
    // claimApply 用 globalThis 做 HMR 幂等标记，这里先复位再调。
    delete (globalThis as Record<string, unknown>)["__dshScraplingToolviewApplied"];
    const { apply, inject } = await import("../src/client-entry.ts");
    apply(ctx as never);
    expect(inject).toStrictEqual(["slots"]);
    // 十个结果行 + 一张设置卡。设置卡那条不是可有可无的：没有它，插件详情页上就没有
    // 任何能编辑本包设置的地方（宿主只投影键，不画表单）。
    expect(registered).toStrictEqual([...ROW_TOOLS, "@jayyuen66/dsh-scrapling"]);
  });

  it("设置卡挂在 plugins.bundle.config 这张 slot 上，键是包名", async () => {
    const slots: { name: string; key: string }[] = [];
    const ctx = {
      slots: {
        inject: (_slot: string, register: () => void): void => {
          register();
        },
        register: (options: { name: string; key: string }): (() => void) => {
          slots.push(options);
          return (): void => undefined;
        },
      },
      effect: (): unknown => undefined,
    };
    delete (globalThis as Record<string, unknown>)["__dshScraplingToolviewApplied"];
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    const card = slots.filter((entry) => entry.name === "plugins.bundle.config");
    expect(card).toStrictEqual([{ name: "plugins.bundle.config", key: BUNDLE_PACKAGE_NAME }]);
  });

  it("重复 apply 不会二次注册（HMR 幂等）", async () => {
    const registered: string[] = [];
    const ctx = {
      slots: {
        inject: (_slot: string, register: () => void): void => {
          register();
        },
        register: (options: { name: string; key: string }): (() => void) => {
          registered.push(options.key);
          return (): void => undefined;
        },
      },
      effect: (): unknown => undefined,
    };
    delete (globalThis as Record<string, unknown>)["__dshScraplingToolviewApplied"];
    const { apply } = await import("../src/client-entry.ts");
    apply(ctx as never);
    const first = registered.length;
    apply(ctx as never);
    expect(registered).toHaveLength(first);
  });
});
