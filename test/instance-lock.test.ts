// instance-lock 单元测试（scrapling 侧）：单实例锁的六条判据 + 一条「能力缺席不拦功能」的边界。
// 模块本体已收进 shared（@jayyuen66/dsh-plugin-shared/lib/instance-lock），本文件钉的是本仓
// 调用侧那一份键名与 shared 的判定表仍然一致。
//
// 这里**刻意不测 fiber 生命周期**：那一段由 /tmp 探针在真 cordis 上验过（重复 provide 同步
// 抛错、catch 之后同 fiber 仍健康、卸载后锁释放），而单测里没有真 cordis 上下文可造。本文件
// 钉的是本模块自己的判定表——四个分支每一格都独立写明期望，不从实现派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { claimInstance } from "@jayyuen66/dsh-plugin-shared/lib/instance-lock";

const KEY = "@jayyuen66/dsh-scrapling/instance";

/** 记录型替身：用一次「已存在的服务表」复刻 `ctx.get` 与 `reflect.provide` 的重复语义。 */
interface LockFixture {
  readonly ctx: {
    readonly get: (name: string) => unknown;
    readonly reflect: { readonly provide: (name: string) => () => void };
  };
  readonly services: Map<string, unknown>;
  readonly trace: { readonly provided: string[] };
}

function makeCtx(
  options: { readonly occupied?: boolean; readonly provideThrows?: boolean } = {},
): LockFixture {
  const services = new Map<string, unknown>();
  if (options.occupied === true) {
    services.set(KEY, {});
  }
  const trace = { provided: [] as string[] };
  const ctx = {
    get: (name: string): unknown => services.get(name),
    reflect: {
      provide: (name: string): (() => void) => {
        trace.provided.push(name);
        // 复刻 cordis 的「同作用域同名再 provide 即抛」；occupancy 由调用方用 services 表达。
        if (options.provideThrows === true || services.has(name)) {
          throw new Error(`service "${name}" has been registered`);
        }
        services.set(name, {});
        return () => {
          services.delete(name);
        };
      },
    },
  };
  return { ctx, services, trace };
}

describe("claimInstance", () => {
  it("空作用域：抢到，且真的把锁写进了服务表", () => {
    const { ctx, services, trace } = makeCtx();
    assert.equal(claimInstance(ctx, KEY), true);
    assert.deepEqual(trace.provided, [KEY], "抢到锁就该 provide 一次");
    assert.notEqual(services.get(KEY), undefined, "锁要落在服务表上才可能被后来者读到");
  });

  it("已有一份在册：让路，且不再尝试 provide（避免误导性的重复注册报错）", () => {
    const { ctx, trace } = makeCtx({ occupied: true });
    assert.equal(claimInstance(ctx, KEY), false);
    assert.deepEqual(trace.provided, [], "读到在册就该直接返回，不必再试一次 provide");
  });

  it("读与写之间被抢走（provide 抛错）：让路，不把异常抛给调用方", () => {
    const { ctx } = makeCtx({ provideThrows: true });
    // 关键：不抛。抛出去就会穿出 apply、把 fiber 打成 failed —— 那正是本模块要消除的形态。
    assert.equal(claimInstance(ctx, KEY), false);
  });

  it("上下文没有注册口（替身 / 精简宿主）：放行，因为「没有注册口」是能力缺席而不是重复", () => {
    const bare = { get: (): unknown => undefined };
    assert.equal(claimInstance(bare, KEY), true);
  });

  it("reflect 在但没有 provide 方法：同样放行（只探可不可调这一位）", () => {
    const odd = { get: (): unknown => undefined, reflect: {} };
    assert.equal(claimInstance(odd, KEY), true);
  });

  it("锁名是调用方给的：两个不同键在同一作用域互不影响", () => {
    const { ctx } = makeCtx();
    assert.equal(claimInstance(ctx, KEY), true);
    assert.equal(claimInstance(ctx, "@jayyuen66/dsh-scrapling/other"), true);
    assert.equal(claimInstance(ctx, KEY), false, "同一个键第二次必须让路");
  });
});
