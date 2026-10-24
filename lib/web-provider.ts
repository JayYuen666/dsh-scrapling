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
        // provider 特有码：调用方只保证能容忍「不认识但可路由」的 code。把 sidecar 的码
        // 带进去 —— 「被安全闸门拦下」（URL_BLOCKED）、「sidecar 超时」（SIDECAR_TIMEOUT）、
        // 「sidecar 没起来」（SIDECAR_UNAVAILABLE）要采取的行动完全不同，只留一个
        // SCRAPLING_FETCH_FAILED 就把这三种压成同一件事。
        // WebError 的构造签名是 (message, code) —— 顺序反了的话，这段文案会跑到 code 上，
        // 而 code 会变成一整段错误文本，调用方按码路由就全废了。
        // 与 host 的 probeFailure 一致，统一 String()：Error 会变成 "Error: msg"，
        // 少一条永远走不到的分支，消息里还多一个错误类名。
        const code = error instanceof SidecarError ? `${error.code}: ` : "";
        throw new WebError(`${code}${String(error)}`, "SCRAPLING_FETCH_FAILED");
      }

      const payload = isRecord(raw) ? raw : undefined;
      // 回包形状不对就报失败，而不是补成「一个空的 200 页面」交上去：调用方会把
      // statusCode: 0 当成一个真实的状态码、把空正文当成「这个页面确实没有内容」，
      // 于是对端协议一坏，结果就是一片看起来完全正常的空结果。
      if (
        payload === undefined ||
        typeof payload["url"] !== "string" ||
        typeof payload["status"] !== "number" ||
        typeof payload["content"] !== "string"
      ) {
        throw new WebError(
          `sidecar returned a malformed fetch reply: ${JSON.stringify(raw).slice(0, 120)}`,
          "SCRAPLING_FETCH_FAILED",
        );
      }
      const { content } = payload;
      // 真正裁剪而不仅是标一个 truncated：超长正文原样返回的话，它会照样进上下文与会话
      // 日志，而 truncated: true 反而让调用方以为已经裁过了。与本仓各工具同一收口
      // （lib/output.ts 的 capText，按字节头尾截断）。
      const capped = capText(content, deps.maxOutputBytes, RECOVERY_HINT);
      // 两种截断都算：sidecar 自己截的，和我们自己按预算截的 ——
      // 对调用方而言语义一样，都是「正文没拿全」。
      const truncated = payload["truncated"] === true || capped.truncated;
      const body: WebFetchBody = { kind: toBodyKind(extractionType), content: capped.text };
      return { url: payload["url"], statusCode: payload["status"], body, truncated };
    },
  };
}
