/**
 * 把一个「取快照的函数」包成**活视图对象**：属性读一次现算一次，不是装配时的值。
 *
 * 为什么需要它：宿主对设置卡的改动只提交给已装好的那份 volatile 引用
 * （`cordis-plugin-loader` 的 `_commitVolatile()` → `cosmokit` 的 `updateVolatile` 原地换值），
 * **不会重跑 `apply`**。于是任何在装配时把 `.get()` 结果收成常量、再传给「只在装配时调用一次」
 * 的消费方（工具 builder 就是：`ctx.tools.register(spec.build(deps));` 每个工具只跑一次），
 * 那份值此后永不更新 —— 卡片上保存成功了、刷新也持久，工具行为却纹丝不动。
 *
 * 为什么不用 Proxy：`const { extractionType } = settings` 这种直接解构在 Proxy 上会拿到
 * `undefined`（非 own 键），而各 builder 的第一行多半正是 `const { settings } = deps;`
 * 之后逐属性读（不写具体条数：注册表增减工具时那个数字就会失真，而这段注释的读者要判断的
 * 是「我这一处会不会受 getter 视图保护」，与总数无关）。`Object.defineProperty` 挂出来的
 * getter 是**真实自有属性**，`Object.keys`、解构、对象展开的行为都与普通对象一致。
 *
 * **调用侧注意**：传给 builder 的必须是这个对象本体。写成 `{ ...liveView(read) }` 会把每个
 * getter 当场求值成快照（对象展开读的是属性值），等于白改。
 *
 * **代价**：每次属性读都会把整个 `read()` 重算一遍。生产侧的 `read` 是一份设置快照
 * （含 `path.join` 与十几个 volatile 取值），所以**别把 getter 当普通字段在同一段逻辑里
 * 反复读**：一次 execute 里读它四五次就是四五份快照。要复用就先把需要的几个值取到局部
 * 变量里。
 *
 * **前提**：`read()` 的**键集必须恒定**（工具设置的键集是编译期常量）。视图的形状取自第一次
 * `read()`，之后不再同步；`read()` 返回的键集若在运行期变化，新增的键在视图里不存在
 * （消费方解构到 `undefined`，而 TS 仍按 `Value` 放行）。
 *
 * getter 声明为不可重配置：本文件要防的正是「某处把活视图退化成快照」，允许
 * `Object.defineProperty` 覆盖会让那种误用静默成功。
 *
 * @param read - 现取一份完整数据的函数；每次属性访问都会调用它一次
 * @returns 键集固定（取自第一次 `read()`）、每个键都是 getter 的视图对象
 */
export function liveView<Value extends Record<string, unknown>>(read: () => Value): Value {
  // 键名从第一次读取的键集里取：视图的**形状**装配时定一次就够了（工具设置的键集是编译期
  // 常量），会变的是每个键的**值**。用 Record 承接可以完全不写断言地挂 getter。
  const view: Record<string, unknown> = {};
  for (const key of Object.keys(read())) {
    Object.defineProperty(view, key, {
      enumerable: true,
      // 不设 `configurable`：允许重定义就等于允许把活视图替换成定值，而这正是本文件防的
      // 那类缺陷（`test/live-view.test.ts` 只断言 `Object.keys` 与解构，不依赖可重定义）。
      configurable: false,
      get: () => read()[key],
    });
  }
  // 视图的键集与 Value 的键集一致（都来自同一次 read()），但这一致性只有运行期能证明：
  // 逐个键挂 getter 之后没有静态办法让 TS 相信「每个键都在」。断言收在这一处。
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return view as unknown as Value;
}
