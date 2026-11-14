// lib/skill.ts 的单元测试：把十五段工具指引注册成一枚虚拟 skill。
//
// 这个模块只有两条判据：① skill 服务在不在都**不许抛**——它是可选服务，精简 profile
// 里根本没有 `@deepseek-ai/dsh-skill`；② 在的时候必须用**本包的名字**与调用点传进来的
// 两份文本调 `register`，一个字段错就会变成「skill 目录里写着别的插件的话」或者
// 「模型按名加载拿到空正文」，而这两件事都不会让宿主报错。
//
// 与 zvec-grep / ocr-review 同名的模块相比多一条判据：**空正文不注册**。那两仓的正文是
// 静态规则全文，永远是同一份非空文本；这里按装配时的注册计划算，一个工具都没注册时
// （sidecar 没起来的降级装配）它会算成空串，注册一枚空 skill 只会往模型目录里塞一条
// 点开什么都没有的条目。
import { describe, expect, it } from "vitest";
import { registerGuidanceSkill, SKILL_NAME } from "../lib/skill.ts";

/** 一次 `register` 调用的实参快照（判据面：名字、说明、正文三样各自对得上）。 */
interface Recorded {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

/** `register` 的返回值：一枚什么都不做的 disposer。 */
function noop(): void {
  // 故意什么都不做。
}

/** skill 服务的替身：只实现本包用到的 `register`，把实参原样收进数组。 */
function fakeSkills(recorded: Recorded[]): { readonly get: (name: string) => unknown } {
  const service = {
    register: (skill: Recorded): (() => void) => {
      recorded.push(skill);
      return noop;
    },
  };
  return {
    get: (name: string): unknown => (name === "skills" ? service : undefined),
  };
}

/** `get` 什么都不给的上下文（服务缺席）。 */
const EMPTY_CTX = { get: (): unknown => undefined };

describe("registerGuidanceSkill（指引全文注册成虚拟 skill）", () => {
  it("skill 服务缺席时返回 false 且不抛（精简 profile 没有 dsh-skill）", () => {
    let threw: unknown;
    let registered = true;
    try {
      registered = registerGuidanceSkill(EMPTY_CTX, "正文", "说明");
    } catch (error) {
      threw = error;
    }
    expect(threw, "缺服务不该抛：它是可选依赖，不进 inject 表").toBeUndefined();
    expect(registered).toBe(false);
  });

  it("服务在时用本包的名字与调用点给的说明、正文调一次 register", () => {
    const recorded: Recorded[] = [];
    const ok = registerGuidanceSkill(fakeSkills(recorded), "指引全文", "目录那行说明");
    expect(ok).toBe(true);
    expect(recorded, "每次装配只注册一次").toHaveLength(1);
    expect(recorded[0]).toStrictEqual({
      name: SKILL_NAME,
      description: "目录那行说明",
      content: "指引全文",
    });
  });

  it("名字是 kebab-case 的 scrapling（与 scrapling_* 工具名区别开）", () => {
    // 独立写死，不从 SKILL_NAME 自己推——写成 scrapling_fetch 这种工具名会让 skill 工具按名加载不到
    expect(SKILL_NAME).toBe("scrapling");
  });

  it("正文为空时不注册（一个工具都没注册的降级装配）", () => {
    const recorded: Recorded[] = [];
    expect(registerGuidanceSkill(fakeSkills(recorded), "", "目录那行说明")).toBe(false);
    expect(recorded, "空 skill 只会让模型目录里多一条点开什么都没有的条目").toStrictEqual([]);
  });

  it("空对象不能冒充 skill 服务（没有 register）", () => {
    expect(
      registerGuidanceSkill({ get: (): unknown => ({}) }, "正文", "说明"),
      "只有 register 是函数才算数",
    ).toBe(false);
  });

  it("register 存在但不是函数时也不认", () => {
    expect(
      registerGuidanceSkill(
        { get: (): unknown => ({ register: "not-a-function" }) },
        "正文",
        "说明",
      ),
    ).toBe(false);
  });

  it("服务返回 null 时不抛（宿主退化态）", () => {
    expect(registerGuidanceSkill({ get: (): unknown => null }, "正文", "说明")).toBe(false);
  });
});
