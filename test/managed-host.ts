// 安装器与 runtime 解析只承诺 macOS arm64（`installerSupported()`），而这两条腿的用例
// 在任何 CI 上都要跑：Linux 上按真实平台跑，量到的是「七个包全 blocked」，不是安装逻辑。
// 所以用例显式把自己伪装成承诺平台，另外单独留一条用例钉「非承诺平台 → blocked」。
//
// 用 defineProperty 而不是 vi.spyOn：同一进程里可能嵌套（文件级伪装 + 单条用例改成
// linux），保存/恢复原始描述符才能嵌套而不互相踩。

/**
 * 一处伪装的三件事实：属性名、伪装前那份自有描述符、要交出去的值。
 *
 * `key` 与 `value` 是绑在一起的判别联合：拆成两个 `string` 字段时
 * `{ key: "platform", value: "arm64" }` 这种错配也能编译通过，而对外签名（见
 * `mockPlatform`）已经收窄到 Node 的两个联合上 —— 内部一放宽，收窄就只剩一半。
 */
type MockedProp =
  | {
      readonly key: "platform";
      readonly before: PropertyDescriptor | undefined;
      readonly value: NodeJS.Platform;
    }
  | {
      readonly key: "arch";
      readonly before: PropertyDescriptor | undefined;
      readonly value: NodeJS.Architecture;
    };

/** 一处已经装上的伪装：伪装本身 + 装上去的那个 getter（判断「属性还归不归我们」用）。 */
interface InstalledMock {
  readonly item: MockedProp;
  readonly getter: () => string;
}

/** 一个属性上的伪装栈：最初那份自有描述符 + 按安装顺序叠着的伪装。 */
interface MockSlot {
  readonly original: PropertyDescriptor | undefined;
  readonly stack: InstalledMock[];
}

const slots = new Map<"platform" | "arch", MockSlot>();

/**
 * 装上一处伪装，返回它对应的栈条目。
 *
 * `enumerable` 必须写出来：`defineProperty` 对**已存在的**自有属性只改给出的那几位，所以
 * 平时它跟着 Node 自己的 `enumerable: true` 走；而 `before` 缺席时这一步是在**新建**属性，
 * 省掉的位默认 false —— 那时 `Object.keys(process)`、`{...process}` 这类读法就会看不见
 * platform，而本仓的用例与日志快照不该跟着夹具变。
 *
 * @param item - 待装的伪装
 * @returns 这次装上去的栈条目
 */
function installMock(item: MockedProp): InstalledMock {
  const existing = slots.get(item.key);
  const slot: MockSlot = existing ?? { original: item.before, stack: [] };
  if (existing === undefined) {
    slots.set(item.key, slot);
  }
  const getter = (): string => item.value;
  const entry: InstalledMock = { item, getter };
  slot.stack.push(entry);
  Object.defineProperty(process, item.key, {
    configurable: true,
    enumerable: item.before?.enumerable ?? true,
    get: getter,
  });
  return entry;
}

/**
 * 撤掉一处伪装，并把该属性重新交回**还剩的那一层**（或最初那份描述符）。
 *
 * 不能只把自己装之前捕获的 `before` 写回去。两个伪装嵌套着装上、却按非 LIFO 的顺序恢复时
 * 那条路是错的：外层捕获的是**真实**描述符、内层捕获的是**外层那个假 getter 的描述符**，
 * 先后顺序一反，最后写回的就是一个假 getter —— `process.platform` 永久停在伪装值上，而且
 * 没有任何报错。所以恢复的语义改成「从栈里摘掉自己，再把栈顶那一层重新装上」，栈空了才
 * 还原最初那份描述符。
 *
 * 属性若已被外部改过（当前 getter 不属于任何一层），这一位就跳过：那是别人的财产，
 * 我们的 `original` 已经不描述当下的真实状态。
 *
 * @param entry - 要撤掉的那一层
 */
function undoMock(entry: InstalledMock): void {
  const { item } = entry;
  const slot = slots.get(item.key);
  const index = slot?.stack.lastIndexOf(entry) ?? -1;
  if (slot === undefined || index < 0) {
    return;
  }
  const current = Object.getOwnPropertyDescriptor(process, item.key);
  const ours = slot.stack.some((candidate) => candidate.getter === current?.get);
  slot.stack.splice(index, 1);
  if (!ours) {
    // 属性已经不归我们：不再写任何东西，但栈要照实更新，免得下次恢复时按错的层数算。
    return;
  }
  const top = slot.stack.at(-1);
  if (top !== undefined) {
    Object.defineProperty(process, item.key, {
      configurable: true,
      enumerable: slot.original?.enumerable ?? true,
      get: top.getter,
    });
    return;
  }
  if (slot.original === undefined) {
    Reflect.deleteProperty(process, item.key);
  } else {
    Object.defineProperty(process, item.key, slot.original);
  }
  slots.delete(item.key);
}

/**
 * 把 process.platform / process.arch 伪装成给定值，返回恢复函数。
 *
 * 类型收到 Node 的那两个联合上：参数写成 `string` 时，`mockPlatform("darwin ", "arm64")`
 * 这种带一个空格的笔误会编译通过，而它判出来的支持性与标题说的不是一回事。
 *
 * 恢复函数可以按**任意顺序**重复调用：每次都只是从栈里摘掉自己那一层。
 *
 * @param platform - 要伪装成的平台
 * @param arch - 要伪装成的架构
 * @returns 恢复到伪装前状态的函数
 */
export function mockPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture): () => void {
  const items: readonly MockedProp[] = [
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
  //
  // 这条 catch 的前提是「被 mock 的属性当前可配置」：`process.platform` / `process.arch`
  // 在 Node 里都是 configurable 的 accessor，本文件自己装的也是 `configurable: true`，
  // 所以现实里走不到。留着是因为将来若有人把 env 之类只读属性也纳进来，这条兜底必须还在
  // —— 那时它就是唯一能保证「抛错之前不留半套伪装」的东西。
  const installed: InstalledMock[] = [];
  try {
    for (const item of items) {
      installed.push(installMock(item));
    }
  } catch (error) {
    for (const entry of installed.toReversed()) {
      undoMock(entry);
    }
    throw error;
  }
  return () => {
    for (const entry of installed.toReversed()) {
      undoMock(entry);
    }
  };
}
