// PDF 阅读工具：调用 document.read，并校验跨语言回包。

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { capText } from "./output.ts";
import { format, messagesOf } from "./messages.ts";
import { callSidecar, SidecarError } from "./sidecar.ts";
import { toolTimeoutOf } from "./tool-timeout.ts";
import type { ToolDeps } from "./tools.ts";

/** PDF 文本读取结果。 */
export interface DocumentResult {
  url: string;
  bytes: number;
  pageCount: number;
  pagesRead: number;
  content: string;
  truncated: boolean;
}

function documentText(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string") {
    throw new SidecarError(
      "SIDECAR_REQUEST_FAILED",
      `sidecar result is missing a string field: ${field}`,
    );
  }
  return value;
}

function documentInt(raw: Record<string, unknown>, field: string): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SidecarError(
      "SIDECAR_REQUEST_FAILED",
      `sidecar result is missing an integer field: ${field}`,
    );
  }
  return value;
}

/** 建 `scrapling_read_document`：流式取 PDF，逐页抽取文本并限制输出。 */
export function createDocumentTool(deps: ToolDeps): ToolDefinition {
  const { sidecar, settings } = deps;
  const messages = messagesOf(deps);
  return defineTool({
    name: "scrapling_read_document",
    description: messages.documentToolDescription,
    parameters: {
      url: { type: "string", required: true, description: messages.documentUrlDescription },
      maxBytes: { type: "integer", description: messages.documentMaxBytesDescription },
      maxPages: { type: "integer", description: messages.documentMaxPagesDescription },
      maxOutputChars: { type: "integer", description: messages.documentMaxOutputCharsDescription },
      headers: { type: "json", description: messages.documentHeadersDescription },
      cookies: { type: "json", description: messages.documentCookiesDescription },
      impersonate: { type: "string", description: messages.documentImpersonateDescription },
      timeoutSeconds: { type: "integer", description: messages.documentTimeoutSecondsDescription },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          bytes: { type: "integer", required: true },
          pageCount: { type: "integer", required: true },
          pagesRead: { type: "integer", required: true },
          content: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `${format(messages.outputDocumentHead, { url: value.url, pages: String(value.pagesRead) })}\n\n${value.content}${value.truncated ? `\n\n${messages.documentTruncationHint}` : ""}`,
        },
      ],
      presentationMeta: (_args, value) => ({
        url: value.url,
        bytes: value.bytes,
        pageCount: value.pageCount,
        truncated: value.truncated,
      }),
    },
    timeoutMs: toolTimeoutOf(settings),
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolRunContext): Promise<DocumentResult> {
      const requestedBytes =
        typeof args["maxBytes"] === "number" ? args["maxBytes"] : settings.documentMaxBytes;
      const requestedPages =
        typeof args["maxPages"] === "number" ? args["maxPages"] : settings.documentMaxPages;
      const requestedOutput =
        typeof args["maxOutputChars"] === "number"
          ? args["maxOutputChars"]
          : settings.maxOutputBytes;
      const raw = await callSidecar(
        sidecar,
        "document.read",
        {
          url: args["url"],
          maxBytes: Math.min(requestedBytes, settings.documentMaxBytes),
          maxPages: Math.min(requestedPages, settings.documentMaxPages),
          maxOutputChars: Math.min(requestedOutput, settings.maxOutputBytes),
          headers: args["headers"] ?? null,
          cookies: args["cookies"] ?? null,
          impersonate: args["impersonate"] ?? "",
          timeoutSeconds: args["timeoutSeconds"] ?? settings.requestTimeoutSeconds,
          deployment: {
            documentMaxBytes: settings.documentMaxBytes,
            documentMaxPages: settings.documentMaxPages,
            documentMaxOutputChars: settings.maxOutputBytes,
          },
        },
        { signal: exec.signal, timeoutMs: settings.timeoutMs },
      );
      if (!isRecord(raw)) {
        throw new SidecarError("SIDECAR_REQUEST_FAILED", "document.read returned a non-object");
      }
      const capped = capText(
        documentText(raw, "content"),
        settings.maxOutputBytes,
        messages.documentTruncationHint,
      );
      const { truncated } = raw;
      if (typeof truncated !== "boolean") {
        throw new SidecarError(
          "SIDECAR_REQUEST_FAILED",
          "sidecar result is missing a boolean field: truncated",
        );
      }
      return {
        url: documentText(raw, "url"),
        bytes: documentInt(raw, "bytes"),
        pageCount: documentInt(raw, "pageCount"),
        pagesRead: documentInt(raw, "pagesRead"),
        content: capped.text,
        truncated: truncated || capped.truncated,
      };
    },
    presentCall: (args) => ({ card: "generic", title: args["url"], kind: "fetch" }),
  });
}
