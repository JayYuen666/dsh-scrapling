// 浏览器会话读页、结构化动作、截图与下载。单独成文件，避免 lib/tools.ts 超过行数上限。

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { capText } from "./output.ts";
import { callSidecar, SidecarError } from "./sidecar.ts";
import { callNumber } from "./tool-params.ts";
import { messagesOf, toolTimeoutOf } from "./tools.ts";
import type { ToolDeps } from "./tools.ts";

/** 宿主 attachment 服服务的最小类型；截图工具只调这一项。 */
export interface AttachmentSaver {
  saveImage: (input: {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg";
    name?: string;
  }) => Promise<Record<string, unknown>>;
}

/**
 * 标准 base64 的形态：四位一组，尾部允许一枚或两枚 `=`。
 *
 * 判形态而不是只判「能解出字节」：`Buffer.from(str, "base64")` 会跳过字母表以外的字符，
 * 于是带 `data:` 前缀或被截断的串也能解出一点东西，而解出来的是半张图。
 */
const BASE64_SHAPE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

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

/**
 * 单个动作 / 单次截图的超时，夹在本次调用的截止之内。
 *
 * 只许往下调：发一个比截止大的值，先到期的是 JS 侧的 SIDECAR_TIMEOUT，而超时按设计
 * 会拆掉常驻进程重连 —— 于是一次点击或截图超时换成全部浏览器会话陪葬。
 */
function actionTimeoutMs(value: unknown, deadlineMs: number): number {
  return callNumber(value, deadlineMs, deadlineMs);
}

/** 读会话当前页。 */
export function createSessionReadTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  const messages = messagesOf(deps);
  return defineTool({
    name: "scrapling_session_read",
    description: messages.sessionReadToolDescription,
    parameters: {
      sessionId: {
        type: "string",
        required: true,
        description: messages.sessionReadSessionIdDescription,
      },
      extractionType: { type: "string", description: messages.extractionTypeDescription },
      cssSelector: { type: "string", description: messages.sessionReadCssSelectorDescription },
      mainContentOnly: {
        type: "boolean",
        description: messages.sessionReadMainContentOnlyDescription,
      },
      includeMetadata: {
        type: "boolean",
        description: messages.sessionReadIncludeMetadataDescription,
      },
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
    timeoutMs: toolTimeoutOf(settings),
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
      const capped = capText(content, settings.maxOutputBytes, messages.contentRecoveryHint);
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
  const messages = messagesOf(deps);
  return defineTool({
    name: "scrapling_session_act",
    description: messages.sessionActToolDescription,
    parameters: {
      sessionId: {
        type: "string",
        required: true,
        description: messages.sessionReadSessionIdDescription,
      },
      actions: { type: "json", required: true, description: messages.sessionActActionsDescription },
      slowly: { type: "boolean", description: messages.sessionActSlowlyDescription },
      maxActions: { type: "integer", description: messages.sessionActMaxActionsDescription },
      timeoutMs: { type: "integer", description: messages.sessionActTimeoutMsDescription },
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
    timeoutMs: toolTimeoutOf(settings),
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
          timeoutMs: actionTimeoutMs(args["timeoutMs"], settings.timeoutMs),
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
  const messages = messagesOf(deps);
  return defineTool({
    name: "scrapling_download",
    description: messages.downloadToolDescription,
    parameters: {
      url: { type: "string", required: true, description: messages.downloadUrlDescription },
      filename: { type: "string", description: messages.downloadFilenameDescription },
      maxBytes: { type: "integer", description: messages.downloadMaxBytesDescription },
      headers: { type: "json", description: messages.downloadHeadersDescription },
      cookies: { type: "json", description: messages.downloadCookiesDescription },
      impersonate: { type: "string", description: messages.downloadImpersonateDescription },
      useBrowser: { type: "boolean", description: messages.downloadUseBrowserDescription },
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
          text: `saved ${value.bytes}B to ${value.path}\nsha256: ${value.sha256}\ncontent-type: ${value.contentType || "(unknown)"} (HTTP ${value.status})\n${messages.downloadSavedHint}`,
        },
      ],
      presentationMeta: (_args, value) => ({ url: value.path, statusCode: value.status }),
    },
    timeoutMs: toolTimeoutOf(settings),
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
  const messages = messagesOf(deps);
  return defineTool({
    name: "scrapling_screenshot",
    description: messages.screenshotToolDescription,
    parameters: {
      sessionId: {
        type: "string",
        required: true,
        description: messages.sessionReadSessionIdDescription,
      },
      imageType: {
        type: "string",
        enum: ["png", "jpeg"],
        description: messages.screenshotImageTypeDescription,
      },
      fullPage: { type: "boolean", description: messages.screenshotFullPageDescription },
      quality: { type: "integer", description: messages.screenshotQualityDescription },
      selector: { type: "string", description: messages.screenshotSelectorDescription },
      timeoutMs: { type: "integer", description: messages.screenshotTimeoutMsDescription },
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
    timeoutMs: toolTimeoutOf(settings),
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
          timeoutMs: actionTimeoutMs(args["timeoutMs"], settings.timeoutMs),
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      const mediaType = textOf(raw, "mediaType");
      if (mediaType !== "image/png" && mediaType !== "image/jpeg") {
        throw new SidecarError("SIDECAR_REQUEST_FAILED", `unexpected media type: ${mediaType}`);
      }
      const encoded = textOf(raw, "base64");
      // `Buffer.from(str, "base64")` 对非法输入是宽容的：不在字母表里的字符被跳过，于是
      // 半帧、带 `data:` 前缀或已被截断的串会解出一小段的图，然后照样落库成一张坏图。
      // 这条路径的正文来自自家 sidecar 的 b64encode，形态不合就说明回包已经不是这张图；
      // 判形态也顺手排除了「解出零字节」那一档（空串与纯 `=` 都不合形）。
      // 解码后的字节上限不在这一层：落库处是宿主的 attachment 服务，容量与清理归它，
      // 模型从这一枚工具看到的只有引用。
      if (encoded.length === 0 || !BASE64_SHAPE.test(encoded)) {
        throw new SidecarError(
          "SIDECAR_REQUEST_FAILED",
          "screenshot payload is not a well-formed base64 string",
        );
      }
      const data = Buffer.from(encoded, "base64");
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
