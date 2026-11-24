// lib/fetch-strategy.ts —— search 与 web_fetch 共用的正文读取策略。

import type { Reader } from "./config-reader.ts";
import type { SidecarClient } from "./sidecar.ts";

/** 正文读取策略：静态、静态优先按需渲染、直接渲染。 */
export type WebFetchStrategy = "static" | "auto" | "browser";

/** auto 只有静态正文少于此字符数时才尝试浏览器渲染。 */
export const AUTO_RENDER_MIN_CHARS = 200;

/** 两种 provider 共用的 sidecar 请求字段。 */
export interface FetchStrategyRequest {
  readonly url: string;
  readonly cssSelector: string | null;
  readonly extractionType: string;
  readonly mainContentOnly: boolean;
  readonly maxContentChars: number;
  readonly headless?: boolean;
  readonly networkIdle?: boolean;
}

/** 一次策略读取需要的热改依赖。 */
export interface FetchStrategyDeps {
  readonly sidecar: SidecarClient;
  readonly fetchStrategy: Reader<WebFetchStrategy>;
  readonly timeoutMs: Reader<number>;
}

/** provider 对完整静态回包的校验；正文是 auto 阈值唯一需要的字段。 */
export type FetchReplyValidator = (reply: unknown) => reply is { readonly content: string };

/**
 * 按配置读取正文，返回 sidecar 的原始回包。
 *
 * 网络错误与形状错误原样交给调用方处理；auto 只在 provider 校验完整静态回包通过、正文
 * 少于阈值且浏览器可用时追加渲染。这样不会把一次失败悄悄变成第二次请求。
 *
 * @param isStaticReply - provider 专属的完整静态回包校验
 */
export async function fetchWithStrategy(
  deps: FetchStrategyDeps,
  request: FetchStrategyRequest,
  isStaticReply: FetchReplyValidator,
  signal?: AbortSignal,
): Promise<unknown> {
  const strategy = deps.fetchStrategy();
  const timeoutMs = deps.timeoutMs();
  const options = { ...(signal === undefined ? {} : { signal }), timeoutMs };
  const render = (): Promise<unknown> => deps.sidecar.call("render", request, options);

  if (strategy === "browser") {
    return render();
  }

  const staticReply = await deps.sidecar.call("fetch", request, options);
  if (
    strategy === "static" ||
    deps.sidecar.capabilities?.browser !== true ||
    !isStaticReply(staticReply) ||
    staticReply.content.length >= AUTO_RENDER_MIN_CHARS
  ) {
    return staticReply;
  }
  return render();
}
