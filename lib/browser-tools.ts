// 浏览器会话读页、结构化动作、截图与下载。单独成文件，避免 lib/tools.ts 超过行数上限。

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { capText } from "./output.ts";
import { callSidecar, SidecarError } from "./sidecar.ts";
import type { ToolDeps } from "./tools.ts";

/** 宿主 attachment 服务的最小面；截图工具只调这一项。 */
export interface AttachmentSaver {
  saveImage: (input: {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg";
    name?: string;
  }) => Promise<Record<string, unknown>>;
}

const RECOVERY_HINT = "要拿被省略的部分，请用 cssSelector 收窄范围，或分多次读取。";

function textOf(raw: unknown, field: string): string {
  if (!isRecord(raw) || typeof raw[field] !== "string") {
    throw new SidecarError(
      "SIDECAR_REQUEST_FAILED",
      `sidecar result is missing a string field: ${field}`,
    );
  }
  return raw[field];
}

function boolOf(raw: unknown, field: string): boolean {
  if (!isRecord(raw) || typeof raw[field] !== "boolean") {
    throw new SidecarError(
      "SIDECAR_REQUEST_FAILED",
      `sidecar result is missing a boolean field: ${field}`,
    );
  }
  return raw[field];
}

function intOf(raw: unknown, field: string): number {
  if (!isRecord(raw) || typeof raw[field] !== "number" || !Number.isInteger(raw[field])) {
    throw new SidecarError(
      "SIDECAR_REQUEST_FAILED",
      `sidecar result is missing an integer field: ${field}`,
    );
  }
  return raw[field];
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function jsonOf(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonOf(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOf(item)]));
  }
  return null;
}

function jsonRecordOf(value: unknown): Record<string, Json> | undefined {
  const converted = jsonOf(value);
  return converted !== null && typeof converted === "object" && !Array.isArray(converted)
    ? converted
    : undefined;
}

/** 读会话当前页。 */
export function createSessionReadTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_session_read",
    description:
      "读浏览器会话当前页的正文，不再发一次网络请求。适合在动作之后确认页面状态；" +
      "还没打开页面的会话会报 NO_CURRENT_PAGE。",
    parameters: {
      sessionId: { type: "string", required: true, description: "浏览器会话 id。" },
      extractionType: { type: "string", description: "输出形态：markdown（默认）/ html / text。" },
      cssSelector: { type: "string", description: "只取匹配的部分；留空取整页。" },
      mainContentOnly: { type: "boolean", description: "只保留 body 内容，默认 true。" },
      includeMetadata: { type: "boolean", description: "回传安全响应元数据。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          content: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          notice: { type: "string", required: true },
          metadata: { type: "object", additionalProperties: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `# ${value.title}\n${value.url}\n\n${value.content}\n\n${value.notice}`,
        },
      ],
      presentationMeta: (_args, value) => ({ url: value.url, truncated: value.truncated }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext) {
      const raw = await callSidecar(
        sidecar,
        "session.read",
        {
          sessionId: args["sessionId"],
          extractionType: args["extractionType"] ?? settings.extractionType,
          cssSelector: args["cssSelector"] ?? null,
          mainContentOnly: args["mainContentOnly"] ?? settings.mainContentOnly,
          includeMetadata: args["includeMetadata"] === true,
          maxContentChars: settings.maxOutputBytes,
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      if (!isRecord(raw)) {
        throw new SidecarError("SIDECAR_REQUEST_FAILED", "session.read returned a non-object");
      }
      const content = textOf(raw, "content");
      const capped = capText(content, settings.maxOutputBytes, RECOVERY_HINT);
      const rawNotice = raw["notice"];
      const notice = [typeof rawNotice === "string" ? rawNotice : "", capped.notice]
        .filter((part) => part.length > 0)
        .join("\n");
      const metadata = jsonRecordOf(raw["metadata"]);
      return {
        url: textOf(raw, "url"),
        title: textOf(raw, "title"),
        content: capped.text,
        truncated: boolOf(raw, "truncated") || capped.truncated,
        notice,
        ...(metadata === undefined ? {} : { metadata }),
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["sessionId"], kind: "fetch" }),
  });
}

/** 在会话当前页上执行结构化动作。 */
export function createSessionActTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_session_act",
    description:
      "在已开会话的当前页上按顺序执行结构化动作（点击、输入、等待等）。" +
      "只接受白名单动作，不执行任意 JavaScript；首个失败会点名动作序号。",
    parameters: {
      sessionId: { type: "string", required: true, description: "浏览器会话 id。" },
      actions: { type: "json", required: true, description: "动作数组，按顺序执行。" },
      slowly: { type: "boolean", description: "每个动作之间等 100ms。" },
      maxActions: { type: "integer", description: "最多多少个动作，默认 20，上限 50。" },
      timeoutMs: { type: "integer", description: "单个动作的超时（毫秒）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          completed: { type: "integer", required: true },
          finalUrl: { type: "string", required: true },
          title: { type: "string", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `completed ${value.completed} action(s); now at ${value.finalUrl} (${value.title})`,
        },
      ],
      presentationMeta: (_args, value) => ({ count: value.completed }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext) {
      const raw = await callSidecar(
        sidecar,
        "session.act",
        {
          sessionId: args["sessionId"],
          actions: args["actions"],
          slowly: args["slowly"] === true,
          maxActions: args["maxActions"] ?? 20,
          timeoutMs: args["timeoutMs"] ?? settings.timeoutMs,
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      return {
        completed: intOf(raw, "completed"),
        finalUrl: textOf(raw, "finalUrl"),
        title: textOf(raw, "title"),
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["sessionId"], kind: "search" }),
  });
}

/** 下载一个 URL 到 dataDir/downloads。 */
export function createDownloadTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  return defineTool({
    name: "scrapling_download",
    description:
      "把一个 URL 的字节写进插件的下载目录，返回路径、大小与 sha256。" +
      "不覆盖已有文件；不返回文件内容。",
    parameters: {
      url: { type: "string", required: true, description: "要下载的 HTTP(S) URL。" },
      filename: { type: "string", description: "保存的文件名；留空从 URL 推导。" },
      maxBytes: { type: "integer", description: "本次下载的字节上限。" },
      headers: { type: "json", description: "请求头（对象）。" },
      cookies: { type: "json", description: "Cookie 键值对（对象）。" },
      impersonate: { type: "string", description: "TLS 指纹伪装目标。" },
      useBrowser: { type: "boolean", description: "用真实浏览器取字节，默认 false。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          bytes: { type: "integer", required: true },
          sha256: { type: "string", required: true },
          contentType: { type: "string", required: true },
          status: { type: "integer", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `saved ${value.bytes}B to ${value.path}\nsha256: ${value.sha256}\ncontent-type: ${value.contentType || "(unknown)"} (HTTP ${value.status})`,
        },
      ],
      presentationMeta: (_args, value) => ({ url: value.path, statusCode: value.status }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolRunContext) {
      // downloadMaxBytes 是部署侧的天花板，maxBytes 是模型可提的参数：后者只能在前者之内。
      // 只压上限，不动非法值（0 / 负数原样透下去，由 Python 侧 _max_bytes 报 BAD_ARGS）——
      // 静默夹成 1 等于把一个明确的参数错误换成一个静默跑起来的下载。NaN / Infinity 到不了
      // 这里：defineTool 的 integer 参数校验在 execute 之前就拒收（JSON 也没有这两个值）。
      const requested =
        typeof args["maxBytes"] === "number" ? args["maxBytes"] : settings.downloadMaxBytes;
      const maxBytes = Math.min(requested, settings.downloadMaxBytes);
      const raw = await callSidecar(
        sidecar,
        "download",
        {
          url: args["url"],
          filename: args["filename"] ?? "",
          maxBytes,
          headers: args["headers"] ?? null,
          cookies: args["cookies"] ?? null,
          impersonate: args["impersonate"] ?? "",
          useBrowser: args["useBrowser"] === true,
          timeoutSeconds: settings.requestTimeoutSeconds,
          deployment: {
            downloadDir: settings.downloadDir,
            downloadMaxBytes: settings.downloadMaxBytes,
          },
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      return {
        path: textOf(raw, "path"),
        bytes: intOf(raw, "bytes"),
        sha256: textOf(raw, "sha256"),
        contentType: textOf(raw, "contentType"),
        status: intOf(raw, "status"),
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "fetch" }),
  });
}

/** 截会话当前页，并把字节交给宿主 attachment。 */
export function createScreenshotTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings, attachments } = deps;
  return defineTool({
    name: "scrapling_screenshot",
    description:
      "对已开会话的当前页或页内单个元素截图，作为图片附件返回。" +
      "截图不经文本清洗，可能包含页面上的敏感视觉信息。",
    parameters: {
      sessionId: { type: "string", required: true, description: "浏览器会话 id。" },
      imageType: { type: "string", enum: ["png", "jpeg"], description: "图片格式，默认 png。" },
      fullPage: { type: "boolean", description: "截整页，默认 false。" },
      quality: { type: "integer", description: "JPEG 质量 1–100；PNG 不可用。" },
      selector: { type: "string", description: "只截这一个元素；与 fullPage 互斥。" },
      timeoutMs: { type: "integer", description: "截图超时（毫秒）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          mediaType: { type: "string", required: true },
          width: { type: "integer", required: true },
          height: { type: "integer", required: true },
          attachment: { type: "json", required: true },
        },
      },
      render: (_args, value) => [
        // 本包不直接依赖定义 ImageBlock 的内部宿主包；attachment 已在执行侧落库，
        // 这里交给 defineTool 的结构类型。
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        { type: "image", attachment: value.attachment as never },
        {
          type: "text",
          text: `screenshot of ${value.url} (${value.width}x${value.height}, ${value.mediaType})`,
        },
      ],
      presentationMeta: (_args, value) => ({ url: value.url }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext) {
      if (attachments === undefined) {
        throw new SidecarError("ATTACHMENT_UNAVAILABLE", "no attachment service is mounted");
      }
      const raw = await callSidecar(
        sidecar,
        "screenshot",
        {
          sessionId: args["sessionId"],
          imageType: args["imageType"] ?? "png",
          fullPage: args["fullPage"] === true,
          quality: args["quality"] ?? null,
          selector: args["selector"] ?? null,
          timeoutMs: args["timeoutMs"] ?? settings.timeoutMs,
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      const mediaType = textOf(raw, "mediaType");
      if (mediaType !== "image/png" && mediaType !== "image/jpeg") {
        throw new SidecarError("SIDECAR_REQUEST_FAILED", `unexpected media type: ${mediaType}`);
      }
      const data = Buffer.from(textOf(raw, "base64"), "base64");
      const attachment = jsonOf(
        await attachments.saveImage({
          data: new Uint8Array(data),
          mediaType,
          name: mediaType === "image/png" ? "screenshot.png" : "screenshot.jpg",
        }),
      );
      return {
        url: textOf(raw, "url"),
        mediaType,
        width: intOf(raw, "width"),
        height: intOf(raw, "height"),
        attachment,
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["sessionId"], kind: "fetch" }),
  });
}
