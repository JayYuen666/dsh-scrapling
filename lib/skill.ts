// lib/skill.ts —— 把十六段工具指引注册成一枚**虚拟 skill**（rc.2 的 `ctx.skills.register()`）。
//
// 为什么要有这一层：指引全文（`guidanceFor` 的产物）原本整段常驻 systemPrompt，全开时中文
// 2.3KB、英文 2.9KB，每个会话都要背。而其中「选错抓取方式会白花时间或漏内容」的只有少数几条
// （静态优先、渲染更慢更吃内存、整站走 crawl），其余是二十个工具各自「什么时候换到它」的细则，
// 只在真要用的时候才需要。所以拆成两份：
//   · systemPrompt 只留摘要（`messages.guidanceSummary`），逐条对应「不做就会走错路」；
//   · 全文注册成 skill，模型按名加载（`skill({ name: "scrapling" })`）。
//
// **注册动作本身已经收进 shared**：`@jayyuen66/dsh-plugin-shared/lib/skill` 的
// `registerSkill(ctx, spec)` 承担「取可选服务 → 判形状 → 空正文不注册 → register → 回布尔」。
// 本文件只剩两样本仓自己的东西：skill 名，与把正文收成 spec 的那一层。
//
// 与另外两个带 skill 的插件相比有一处关键差别：那两仓注册的是**静态规则全文**，而这里的
// 全文依赖运行环境 —— 没装 Chromium 的机器上 render / capture_xhr 那几句本来就不该出现
// （README 承诺「关掉某个工具时它的指引段一并消失」）。所以正文由调用点算好再传进来，
// 本模块只负责注册，不自己去拼。
//
// 正文为空时不注册（**这条判据现在由 shared 承担**）：一句指引都没有时（全关，或 sidecar
// 没起来的降级装配）注册一枚空 skill 只会往模型目录里塞一条点开什么都没有的条目。
//
// 服务是**可选**的：`@deepseek-ai/dsh-skill` 未装载（精简 profile）时注册只是回 false ——
// systemPrompt 那段摘要照旧生效，工具照旧可用。shared 那边因此只收 `get`、不要求 skills 进
// inject 依赖表：进了就把「有 skill 服务」变成插件的硬性前提。
//
// 但上下文类型不能只收 `get`：shared 的 `registerSkill` 还会用可选的 `effect` 接管注册的
// 撤销权（宿主的 `skills.register()` 交回一枚 disposer，不交给 fiber 的话插件卸载后 skill
// 仍留在模型目录里，下一次装配再注册同名条目只会被 first-wins 忽略）。本文件的入参因此
// 直接用 shared 的 `SkillRegistryContext`——写成 `{ get }` 会让**类型**看不见 `effect`，
// 运行期那把 `ctx` 明明带着它，撤销权却被静默丢掉。
//
// 名字用 kebab-case（`isSkillName` 的语法），与工具名区分开：工具是 scrapling_fetch /
// scrapling_render 这些下划线名，skill 是 scrapling。
import { registerSkill } from "@jayyuen66/dsh-plugin-shared/lib/skill";
import type { SkillRegistryContext } from "@jayyuen66/dsh-plugin-shared/lib/skill";

/** skill 名：kebab-case，也是模型用 skill 工具加载时的入参。 */
export const SKILL_NAME = "scrapling";

/**
 * 注册（或重新注册）本包的指引 skill。
 *
 * 正文随调用点传入而不是在这里取，两件事都要求这样：语言由 apply 时的官方 locale 偏好决定
 * （与工具描述、参数说明同源，三处各取一次就会出现「工具描述是中文、skill 正文是英文」的
 * 错位），可见性由装配时的注册状态决定（没装浏览器的机器不该读到 render 那几句）。
 *
 * @param ctx - 只需 `get`（读可选服务），不要求 skills 进 inject；带上 `effect` 时注册的
 *   撤销权交给插件 fiber（见文件头）
 * @param content - 指引全文（装配时 `guidanceFor` 的产物）
 * @param description - skill 目录里那行说明（模型据此决定要不要加载）
 * @returns 注册成功与否；未装载 skill 服务、或正文为空时为 false（不抛，摘要段照旧生效）
 */
export function registerGuidanceSkill(
  ctx: SkillRegistryContext,
  content: string,
  description: string,
): boolean {
  // 兜住 `get` 本身抛错的那一态：本函数的契约是「不抛」。shared 的 `registerSkill` 已经把
  // `register` 与 `effect` 各自包了 try/catch，但**取服务这一步在它之外**——宿主装配期
  // `ctx.get` 打在一个正在卸载的 fiber 上时是会抛的（服务被摘掉与取用同拍）。让它穿出去
  // 的后果不是「少一枚 skill」，而是整条 `apply` 落 failed、插件装不上。
  try {
    return registerSkill(ctx, { name: SKILL_NAME, description, content });
  } catch {
    return false;
  }
}
