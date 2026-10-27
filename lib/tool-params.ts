/** `mainContentOnly` 在三处工具参数表里共用同一句说明。 */
export const MAIN_CONTENT_ONLY_DESC = "只保留 body 内容，默认 true。";

/** 网络历史条目的条目 schema。 */
export const NETWORK_ITEM = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    id: { type: "integer" as const },
    url: { type: "string" as const, required: true as const },
    status: { type: "integer" as const, required: true as const },
    bytes: { type: "integer" as const, required: true as const },
    method: { type: "string" as const, required: true as const },
    resourceType: { type: "string" as const, required: true as const },
    headers: { type: "json" as const },
    bodyNote: { type: "string" as const },
    body: { type: "string" as const },
    bodyTruncated: { type: "boolean" as const },
  },
};

/**
 * 读网络历史的那几个参数，按方法分档。
 *
 * 只有 capture 与 session.network 读它们；发给 render 或会话抓取等于递过去一个对面根本
 * 不读的键。
 *
 * @param method - sidecar 方法名
 * @param args - 工具入参
 * @returns 要并进载荷的键
 */
export function networkReadParams(
  method: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (method !== "capture" && method !== "session.network") {
    return {};
  }
  return {
    urlPattern: args["urlPattern"] ?? null,
    includeBody: args["includeBody"] === true,
    networkLimit: args["networkLimit"] ?? null,
    maxBodyChars: args["maxBodyChars"] ?? null,
    method: args["method"] ?? null,
    status: args["status"] ?? null,
    resourceType: args["resourceType"] ?? null,
    includeStatic: args["includeStatic"] === true,
    afterId: args["afterId"] ?? 0,
    includeHeaders: args["includeHeaders"] === true,
    requestId: args["requestId"] ?? null,
  };
}

/** capture 与 session.network 共用的网络历史读取参数。 */
export const NETWORK_READ_PARAMS = {
  urlPattern: {
    type: "string",
    description:
      '只回 URL 匹配这个正则的条目，例如 "/api/"。留空表示全部（只含 XHR/fetch 与 HTTP 错误）。',
  },
  includeBody: {
    type: "boolean",
    description:
      "连响应体一起回，默认 false。上游只为文本类型存正文，存不下时条目上会给出原因；" +
      "单条上限由 maxBodyChars 决定。",
  },
  networkLimit: { type: "integer", description: "最多回多少条，默认 50。" },
  maxBodyChars: { type: "integer", description: "单条正文的字符上限，默认 20000。" },
  method: { type: "string", description: "按 HTTP 方法过滤，例如 POST。" },
  status: { type: "integer", description: "按状态码过滤。" },
  resourceType: {
    type: "string",
    description: "按资源类型过滤：xhr / fetch / document 等。",
  },
  includeStatic: {
    type: "boolean",
    description: "是否包含文档、脚本等静态资源，默认 false。",
  },
  afterId: { type: "integer", description: "只回记录 id 大于该值的条目。" },
  includeHeaders: {
    type: "boolean",
    description: "回传脱敏后的响应头（不含 set-cookie / authorization）。",
  },
  requestId: { type: "integer", description: "只回这一条记录 id 的详情。" },
} as const;

/**
 * 组装会话构造期的扩展参数。
 *
 * @param args - 工具入参
 * @returns 给了才出现的键
 */
export function sessionOpenExtras(args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof args["sessionId"] === "string" && args["sessionId"].length > 0
      ? { sessionId: args["sessionId"] }
      : {}),
    ...(Array.isArray(args["cookies"]) ? { cookies: args["cookies"] } : {}),
    ...(typeof args["disableResources"] === "boolean"
      ? { disableResources: args["disableResources"] }
      : {}),
    ...(typeof args["loadDom"] === "boolean" ? { loadDom: args["loadDom"] } : {}),
    ...(Array.isArray(args["blockedDomains"]) ? { blockedDomains: args["blockedDomains"] } : {}),
    ...(typeof args["googleSearch"] === "boolean" ? { googleSearch: args["googleSearch"] } : {}),
    ...(typeof args["retries"] === "number" ? { retries: args["retries"] } : {}),
    ...(typeof args["retryDelay"] === "number" ? { retryDelay: args["retryDelay"] } : {}),
    ...(typeof args["maxPages"] === "number" ? { maxPages: args["maxPages"] } : {}),
  };
}

/** 静态抓取的请求件、编码与元数据参数。 */
export const STATIC_REQUEST_PARAMS = {
  params: { type: "json", description: "GET 查询参数（对象）。" },
  form: { type: "json", description: "表单字段（对象）；与 json 互斥。" },
  json: { type: "json", description: "JSON 请求体；与 form 互斥。" },
  defaultEncoding: {
    type: "string",
    description: "响应头没有 charset 时使用的回退编码名，例如 latin-1。",
  },
  retryDelay: { type: "integer", description: "重试间隔秒，默认 1。" },
  stealthyHeaders: {
    type: "boolean",
    description: "是否给静态请求补浏览器头，默认 true。",
  },
  includeMetadata: {
    type: "boolean",
    description:
      "回传安全响应元数据（contentType / encoding / reason / redirects / method），默认 false。",
  },
} as const;

/**
 * 浏览器抓取的请求参数。
 *
 * cookies / retries / retryDelay 只在会话构造期生效；render 与 capture 自己构造一次性会话，
 * 所以它们在这两个工具上是有效入参，在 session.fetch 那一帧上则由 session_open 负责。
 */
export const BROWSER_REQUEST_PARAMS = {
  cookies: {
    type: "json",
    description: "Playwright 兼容的 cookie 数组，每项含 name 与 value 字符串。",
  },
  disableResources: {
    type: "boolean",
    description: "拦截图片、字体等静态资源，默认 false。",
  },
  loadDom: { type: "boolean", description: "是否加载 DOM，默认 true。" },
  waitSelectorState: {
    type: "string",
    description: "waitSelector 的等待状态：attached（默认）/ detached / hidden / visible。",
  },
  blockedDomains: {
    type: "json",
    description: "额外拦截的主机名数组。",
  },
  googleSearch: {
    type: "boolean",
    description: "是否注入 Google referer，默认 true。",
  },
  retries: { type: "integer", description: "会话构造期重试次数，默认 3。" },
  retryDelay: { type: "integer", description: "重试间隔秒，默认 1。" },
  includeMetadata: {
    type: "boolean",
    description:
      "回传安全响应元数据（contentType / encoding / reason / redirects / method），默认 false。",
  },
} as const;

/** `scrapling_crawl` 的 sitemap/feed 模式参数；放这里让工具函数本体保持在行数门内。 */
export const CRAWL_MODE_PARAMS = {
  mode: {
    type: "string",
    enum: ["content", "sitemap", "feed", "shopify"],
    description:
      "content 跟链接；sitemap 只抓 sitemap 里的 loc；feed 读 XML/CSV；shopify 走店铺的 collections/products JSON，按变体出行。",
  },
  sitemapUrl: {
    type: "string",
    description:
      "sitemap 或 robots.txt 地址（mode=sitemap 必填）；mode=shopify 时用它指定店铺根（可选，默认取 url 的主机）。",
  },
  sitemapFollow: { type: "string", description: "只跟进匹配这个正则的子 sitemap。" },
  feedUrl: { type: "string", description: "XML/CSV feed 地址（mode=feed 必填）。" },
  feedType: { type: "string", enum: ["xml", "csv"], description: "feed 形态。" },
  itertag: { type: "string", description: "XML feed 的条目节点名，默认 item。" },
  fields: {
    type: "json",
    description: 'feed 字段映射 {输出名: 路径}，如 {"title": "title", "price": "price"}。',
  },
} as const;
