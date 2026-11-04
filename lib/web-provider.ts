// dsh-scrapling/lib/web-provider.ts —— 把 Scrapling 注册成 ctx.web 的 fetch provider。
//
// 目的：让 **dsh 内置的 web_fetch 工具**在部署侧把 fetchProvider 指到本插件后，实际由
// Scrapling 执行 —— 这才是「替代 dsh 自带的」真正落点，而不是再加一个同名工具。
//
// 两个必须知道的事实（都从 dsh-web 的类型与源码确认，不是推测）：
//
// `WebFetchBody` 是封闭联合，只有 `html` 与 `text`，没有 `markdown`。它由 dsh-web 拥有，
// 注释写明「新增一种 kind 是跨包的协同改动，而不是插件扩展」。所以本插件自己的
// `markdown` 抽取在这里必须降级成 `text` —— 上游只认得这两种，而 markdown 本质就是一段
// 纯文本，dsh-tool-web 对 text 的渲染路径照样能显示。
//
// 注册 provider 不等于接管。ctx.web 的选择规则：配了 id 就用它；没配置而「恰好一个」可用
// provider 时自动选；多个可用 provider 且没配置 id 就报 `WEB_PROVIDER_AMBIGUOUS`，内置的
// web_fetch 会直接不可用。所以本插件默认**注册**（provideWebFetch 默认 true）；要真正接管
// 仍必须两件事同时做：开关开着，且在部署配置里写 `fetchProvider: "scrapling"` —— 只开开关
// 时 base bundle 那条 `fetchProvider: http` 仍然赢。

import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
} from "@deepseek-ai/dsh-web";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { capText } from "./output.ts";
import { SidecarError } from "./sidecar-error.ts";
import type { SidecarClient } from "./sidecar.ts";

/** 一次 web_fetch 被裁掉之后，模型怎么把没拿到的部分再要回来。 */
const RECOVERY_HINT =
  "要拿被省略的部分，请把 fetchMaxOutputChars 调大，或改用 scrapling_fetch 配 cssSelector 收窄范围。";

/** 建 fetch provider 需要的参数。 */
export interface WebProviderDeps {
  /** 已握手的 sidecar 客户端。 */
  readonly sidecar: SidecarClient;
  /**
   * 单次抓取的输出上限。
   *
   * 同一个数有两个去处：作为 `maxContentChars` 发给 sidecar（字符），以及作为
   * `capText` 的字节预算（见 lib/output.ts 说明为什么最终收口按字节）。这与本仓各工具
   * 走的是同一条口径，代价是非 ASCII 页面在字节预算下会被裁得更早 —— 但预算必须真的
   * 收口，只标一个 truncated 而把超长正文原样放行等于没有预算。
   */
  readonly maxOutputBytes: number;
  /** 单次抓取的协同超时（毫秒）。 */
  readonly timeoutMs: number;
}

/** 本 provider 在 ctx.web 里的 id。 */
export const PROVIDER_ID = "scrapling";

/**
 * 把本插件的抽取形态映射到 dsh-web 认识的 kind。
 *
 * `markdown` 在这里降级成 `text`：上游联合里没有它。
 *
 * @param extractionType 本插件侧的形态
 * @returns dsh-web 认识的 kind
 */
export function toBodyKind(extractionType: string): WebFetchBody["kind"] {
  return extractionType === "html" ? "html" : "text";
}

/**
 * 把回包原值压成一段可读的一行，供「形状不对」的错误文案使用。
 *
 * 不能直接 `JSON.stringify(raw).slice(...)`：`JSON.stringify` 对不可序列化的值
 * （`undefined`、函数、symbol）**返回 undefined**，对循环引用会抛。两种情况下
 * 那一行的 `.slice` 会先炸成 TypeError，于是本该报「sidecar 回包坏了」的路径
 * 变成了一条没有 code 的崩溃 —— 调用方按码路由就失去了这条失败。
 *
 * @param raw - sidecar 回来的原值
 * @returns 最多 120 字符的描述
 */
function describeRaw(raw: unknown): string {
  try {
    const text = JSON.stringify(raw);
    if (typeof text === "string") {
      return text.slice(0, 120);
    }
  } catch {
    // 循环引用一类不可序列化的形状：落到下面的 String() 兜底。
  }
  return String(raw).slice(0, 120);
}

/** 一次 fetch 回包里本层要用的那几件。 */
interface FetchReply {
  readonly url: string;
  readonly status: number;
  readonly content: string;
  /** sidecar 自己有没有截过正文（与 `capText` 的截断并列，共同决定 `truncated`）。 */
  readonly sourceTruncated: boolean;
}

/**
 * 状态码是否可用：必须是 100..599 之间的整数。
 *
 * `typeof === "number"` 单看类型会放行 NaN、Infinity、0、负数与 999，而宿主把这一枚原样
 * 印进模型看到的标题行（`Fetched <url> (HTTP <status>)`）。区间取 HTTP 的合法状态码：这条
 * 路径的 status 来自 `py/adapters.py` 的 `response.status`，一次真 HTTP 响应给不出别的数，
 * 给得出别的数就说明回包已经不是这条协议。
 *
 * @param status - 回包里的 status
 * @returns 是否可当状态码交出去
 */
function isUsableStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
}

/**
 * 读 sidecar 的 fetch 回包；类型与取值一起判。
 *
 * 判不过就报「回包坏了」，而不是补成「一个空的 200 页面」交上去：调用方会把 statusCode
 * 当成一个真实的状态码、把空正文当成「这个页面确实没有内容」，于是对端协议一坏，
 * 结果就是一片看起来完全正常的空结果。
 *
 * @param raw - sidecar 回来的原值
 * @returns 判过的那几件
 * @throws WebError - 形状或取值不合这条协议（`SCRAPLING_FETCH_FAILED`）
 */
function replyOf(raw: unknown): FetchReply {
  if (isRecord(raw)) {
    const { url, status, content, truncated } = raw;
    if (
      typeof url === "string" &&
      url.length > 0 &&
      isUsableStatus(status) &&
      typeof content === "string"
    ) {
      return { url, status, content, sourceTruncated: truncated === true };
    }
  }
  throw new WebError(
    `sidecar returned a malformed fetch reply: ${describeRaw(raw)}`,
    "SCRAPLING_FETCH_FAILED",
  );
}

/**
 * 建一个 ctx.web fetch provider。
 *
 * @param deps - 依赖
 * @returns provider
 */
export function createWebFetchProvider(deps: WebProviderDeps): WebFetchProvider {
  const { sidecar } = deps;
  return {
    id: PROVIDER_ID,

    /**
     * 本地可用性判断。契约要求**不得发网络请求**，所以只看 sidecar 是否已握手成功。
     *
     * @returns 是否可用
     */
    available(): boolean {
      return sidecar.alive && sidecar.capabilities?.scrapling === true;
    },

    /**
     * 抓一个 URL。
     *
     * `ctx.web` 的请求里只有 url，所以抽取策略来自本 provider 自己的配置；
     * 需要 cssSelector / render / stealth 的走本插件那七个工具，不要用这条路径。
     *
     * @param request - 请求
     * @param signal - 取消信号
     * @returns 归一后的抓取结果
     */
    async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
      const extractionType = "markdown";
      let raw: unknown;
      try {
        raw = await sidecar.call(
          "fetch",
          {
            url: request.url,
            cssSelector: null,
            extractionType,
            mainContentOnly: true,
            maxContentChars: deps.maxOutputBytes,
          },
          // exactOptionalPropertyTypes 下不能直接透传可选的 signal。
          { ...(signal === undefined ? {} : { signal }), timeoutMs: deps.timeoutMs },
        );
      } catch (error: unknown) {
        // 取消不是故障：sidecar 在 signal 中止时抛的是 SIDECAR_ABORTED，包成抓取失败
        // 之后调用方看到的是「这个页面抓坏了」，于是会重试一个用户已经放弃的请求。
        // 与 search-provider 同一口径：原样抛出。
        if (signal?.aborted === true) {
          throw error;
        }
        // code 交回本 provider 自己的那一枚（SCRAPLING_FETCH_FAILED），sidecar 的原始码走
        // 两条路：文案前缀给模型看，`cause` 给程序读。宿主对 WebError 的契约是「按 code
        // 路由、绝不解析 message」，而 provider 特有码只要求调用方**容得下**，所以把
        // URL_BLOCKED / SIDECAR_TIMEOUT / SIDECAR_UNAVAILABLE 直接抬成 code 等于改这份契约
        // 的取值面；带在 cause 上既不撑大取值域，也不把三种情况压成一件。
        // WebError 的构造签名是 (message, code, options) —— 顺序反了的话，这段文案会跑到
        // code 上，而 code 会变成一整段错误文本，调用方按码路由就全废了。
        // 与 host 的 probeFailure 一致，统一 String()：Error 会变成 "Error: msg"，
        // 少一条永远走不到的分支，消息里还多一个错误类名。
        const code = error instanceof SidecarError ? `${error.code}: ` : "";
        throw new WebError(`${code}${String(error)}`, "SCRAPLING_FETCH_FAILED", { cause: error });
      }

      const payload = replyOf(raw);
      // 真正裁剪而不仅是标一个 truncated：超长正文原样返回的话，它会照样进上下文与会话
      // 日志，而 truncated: true 反而让调用方以为已经裁过了。与本仓各工具同一收口
      // （lib/output.ts 的 capText，按字节头尾截断）。
      const capped = capText(payload.content, deps.maxOutputBytes, RECOVERY_HINT);
      // 两种截断都算：sidecar 自己截的，和我们自己按预算截的 ——
      // 对调用方而言语义一样，都是「正文没拿全」。宿主把这一位翻成它自己的那句
      // 截断告知（`packages/web/tool-web/src/fetch.ts` 的 TRUNCATION_FOOTER），所以
      // capText 那份 `notice` 在这里刻意不进正文：并进去就是同一句告知说两遍，
      // 还会把「页面内容」与「怎么再要一次」混成一坨。
      const truncated = payload.sourceTruncated || capped.truncated;
      const body: WebFetchBody = { kind: toBodyKind(extractionType), content: capped.text };
      return { url: payload.url, statusCode: payload.status, body, truncated };
    },
  };
}
