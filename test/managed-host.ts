// 安装器与 runtime 解析只承诺 macOS arm64（`installerSupported()`），而这两条腿的用例
// 在任何 CI 上都要跑：Linux 上按真实平台跑，量到的是「六个包全 blocked」，不是安装逻辑。
// 所以用例显式把自己伪装成承诺平台，另外单独留一条用例钉「非承诺平台 → blocked」。
//
// 用 defineProperty 而不是 vi.spyOn：同一进程里可能嵌套（文件级伪装 + 单条用例改成
// linux），保存/恢复原始描述符才能嵌套而不互相踩。

/** 一处伪装的三件事实：属性名、伪装前那份自有描述符、要交出去的值。 */
interface MockedProp {
  readonly key: "platform" | "arch";
  /** 伪装之前该属性的自有描述符；`undefined` 表示它当时不是自有属性。 */
  readonly before: PropertyDescriptor | undefined;
  readonly value: string;
}

/**
 * 装上一处伪装。
 *
 * `enumerable` 必须写出来：`defineProperty` 对**已存在的**自有属性只改给出的那几位，所以
 * 平时它跟着 Node 自己的 `enumerable: true` 走；而 `before` 缺席时这一步是在**新建**属性，
 * 省掉的位默认 false —— 那时 `Object.keys(process)`、`{...process}` 这类读法就会看不见
 * platform，而本仓的用例与日志快照不该跟着夹具变。
 *
 * @param item - 待装的伪装
 */
function applyMock(item: MockedProp): void {
  Object.defineProperty(process, item.key, {
    configurable: true,
    enumerable: item.before?.enumerable ?? true,
    get: () => item.value,
  });
}

/**
 * 按安装的反序撤掉伪装。
 *
 * 伪装前不是自有属性时，新建的那一份要**删掉**而不是留着：留着的话恢复函数跑完
 * `process.platform` 还是那个 getter，伪装就泄漏给后面的用例了。
 *
 * @param items - 已经装过（或打算装）的伪装
 */
function undoMocks(items: readonly MockedProp[]): void {
  for (const item of items.toReversed()) {
    if (item.before === undefined) {
      Reflect.deleteProperty(process, item.key);
    } else {
      Object.defineProperty(process, item.key, item.before);
    }
  }
}

/**
 * 把 process.platform / process.arch 伪装成给定值，返回恢复函数。
 *
 * 类型收到 Node 的那两个联合上：参数写成 `string` 时，`mockPlatform("darwin ", "arm64")`
 * 这种带一个空格的笔误会编译通过，而它判出来的支持性与标题说的不是一回事。
 *
 * @param platform - 要伪装成的平台
 * @param arch - 要伪装成的架构
 * @returns 恢复到伪装前状态的函数
 */
export function mockPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture): () => void {
  const items: MockedProp[] = [
    {
      key: "platform",
      before: Object.getOwnPropertyDescriptor(process, "platform"),
      value: platform,
    },
    {
      key: "arch",
      before: Object.getOwnPropertyDescriptor(process, "arch"),
      value: arch,
    },
  ];
  // 第二条装不上时第一条不能留在身上：调用方拿到的是抛错，压根没拿到恢复函数。
  const installed: MockedProp[] = [];
  try {
    for (const item of items) {
      applyMock(item);
      installed.push(item);
    }
  } catch (error) {
    undoMocks(installed);
    throw error;
  }
  return () => {
    undoMocks(items);
  };
}
