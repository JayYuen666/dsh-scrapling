import { once } from "node:events";
import { WebError } from "@deepseek-ai/dsh-web";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import type { Reader } from "./config-reader.ts";

export const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
export const DEEPSEEK_MAX_RESULTS = 50;
export const DEEPSEEK_SEARCH_REQUESTS_PER_SECOND = 5;

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const timeout = AbortSignal.timeout(ms);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  combined.throwIfAborted();
  await once(combined, "abort");
}

export class DeepSeekRateLimiter {
  private readonly starts: number[] = [];

  public async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const now = Date.now();
    let [oldest] = this.starts;
    while (oldest !== undefined && oldest < now - 1000) {
      this.starts.shift();
      [oldest] = this.starts;
    }
    if (oldest === undefined || this.starts.length < DEEPSEEK_SEARCH_REQUESTS_PER_SECOND) {
      this.starts.push(now);
      return;
    }
    await abortableDelay(oldest + 1001 - now, signal);
    return this.wait(signal);
  }
}

export interface DeepSeekAuthorizationLike {
  readonly kind: "api-key" | "account";
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly reject?: () => Promise<void>;
  readonly revoked?: AbortSignal;
}

export interface DeepSeekAuthCandidateLike {
  readonly kind: "api-key" | "account";
  readonly endpoint: string;
  readonly configured: () => Promise<boolean>;
  readonly resolve: (signal?: AbortSignal) => Promise<DeepSeekAuthorizationLike | undefined>;
}

export interface DeepSeekAuthUnresolvedLike {
  readonly kind: "api-key" | "account";
  readonly unresolved: "connection" | "deployment";
  readonly error: unknown;
}

export interface DeepSeekAuthRequestLike {
  readonly consumer: string;
  readonly accepts: readonly ("api-key" | "account")[];
  readonly billing: "auto" | "api-key" | "account";
  readonly route?: string | undefined;
  readonly destination: { readonly url: string };
  readonly connections?: Readonly<
    Partial<Record<"api-key" | "account", { readonly baseURL: string }>>
  >;
  readonly apiKeyHeaders: readonly ("authorization" | "x-api-key")[];
}

export interface DeepSeekAuthLike {
  readonly candidates: (
    request: DeepSeekAuthRequestLike,
  ) => readonly (DeepSeekAuthCandidateLike | DeepSeekAuthUnresolvedLike)[];
  readonly authorize: (
    request: DeepSeekAuthRequestLike,
    signal?: AbortSignal,
  ) => Promise<DeepSeekAuthorizationLike | undefined>;
}

export interface DeepSeekSearchDeps {
  readonly deepseekAuth?: DeepSeekAuthLike | undefined;
  readonly deepseekEndpoint: Reader<string>;
  readonly fetchImpl: typeof fetch;
  readonly rateLimiter?: DeepSeekRateLimiter | undefined;
}

export interface DeepSeekHit {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly summary?: string;
  readonly publishedAt?: string;
}

export function isDeepSeekAuth(value: unknown): value is DeepSeekAuthLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "candidates" in value &&
    typeof value.candidates === "function" &&
    "authorize" in value &&
    typeof value.authorize === "function"
  );
}

function requestFor(endpoint: string, route: string | undefined): DeepSeekAuthRequestLike {
  return {
    consumer: "@jayyuen66/dsh-scrapling",
    accepts: ["account", "api-key"],
    billing: "auto",
    route,
    destination: { url: endpoint },
    connections: { "api-key": { baseURL: endpoint } },
    apiKeyHeaders: ["x-api-key", "authorization"],
  };
}

function endpointOf(deps: DeepSeekSearchDeps): string {
  const endpoint = deps.deepseekEndpoint().trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
      throw new Error("invalid endpoint");
    }
    return url.toString();
  } catch (error) {
    throw new WebError(
      `invalid DeepSeek search endpoint: ${String(error)}`,
      "SCRAPLING_SEARCH_FAILED",
    );
  }
}

async function candidateReady(
  candidates: readonly (DeepSeekAuthCandidateLike | DeepSeekAuthUnresolvedLike)[],
  index = 0,
): Promise<boolean> {
  const candidate = candidates[index];
  if (candidate === undefined) {
    return false;
  }
  if ("unresolved" in candidate) {
    return false;
  }
  if (await candidate.configured()) {
    return true;
  }
  return candidateReady(candidates, index + 1);
}

export async function deepseekReady(
  deps: DeepSeekSearchDeps,
  route: string | undefined,
): Promise<boolean> {
  if (deps.deepseekAuth === undefined) {
    return false;
  }
  try {
    const endpoint = endpointOf(deps);
    const candidates = deps.deepseekAuth.candidates(requestFor(endpoint, route));
    return await candidateReady(candidates);
  } catch {
    return false;
  }
}

function invalidResponse(): WebError {
  return new WebError("DeepSeek search returned an invalid response", "SCRAPLING_SEARCH_FAILED");
}

function hitsOf(response: unknown): DeepSeekHit[] {
  if (!isRecord(response) || !Array.isArray(response["results"])) {
    throw invalidResponse();
  }
  return response["results"].map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item["url"] !== "string" ||
      item["url"].length === 0 ||
      typeof item["title"] !== "string" ||
      typeof item["snippet"] !== "string" ||
      (item["summary"] !== undefined && typeof item["summary"] !== "string") ||
      (item["date"] !== null && typeof item["date"] !== "string")
    ) {
      throw invalidResponse();
    }
    return {
      url: item["url"],
      ...(item["title"].length > 0 ? { title: item["title"] } : {}),
      ...(item["snippet"].length > 0 ? { snippet: item["snippet"] } : {}),
      ...(typeof item["summary"] === "string" && item["summary"].length > 0
        ? { summary: item["summary"] }
        : {}),
      ...(typeof item["date"] === "string" && item["date"].length > 0
        ? { publishedAt: item["date"] }
        : {}),
    };
  });
}

function requestSignal(
  signal: AbortSignal | undefined,
  revoked: AbortSignal | undefined,
): AbortSignal | undefined {
  if (signal === undefined) {
    return revoked;
  }
  if (revoked === undefined) {
    return signal;
  }
  return AbortSignal.any([signal, revoked]);
}

interface SendRequestOptions {
  readonly deps: DeepSeekSearchDeps;
  readonly authorization: DeepSeekAuthorizationLike;
  readonly query: string;
  readonly count: number;
  readonly signal: AbortSignal | undefined;
  readonly callerSignal: AbortSignal | undefined;
}

async function sendRequest(options: SendRequestOptions): Promise<Response> {
  const { deps, authorization, query, count, signal, callerSignal } = options;
  const init: RequestInit = {
    method: "POST",
    redirect: "error",
    headers: { ...authorization.headers, "content-type": "application/json" },
    body: JSON.stringify({ query, count, need_content: false }),
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await deps.fetchImpl(authorization.endpoint, init);
  } catch (error) {
    if (callerSignal?.aborted === true) {
      throw error;
    }
    if (authorization.revoked?.aborted === true) {
      throw new WebError("DeepSeek credential was revoked", "SEARCH_AUTH");
    }
    throw new WebError(`DeepSeek search failed: ${String(error)}`, "SCRAPLING_SEARCH_FAILED");
  }
}

async function ensureOk(
  response: Response,
  authorization: DeepSeekAuthorizationLike,
): Promise<void> {
  if (response.ok) {
    return;
  }
  if (response.status === 401) {
    try {
      await authorization.reject?.();
    } catch {
      // HTTP 401 已确认凭据失效；清理失败不改变本次错误。
    }
    throw new WebError("DeepSeek rejected the search credential", "SEARCH_AUTH");
  }
  if (response.status === 429) {
    throw new WebError("DeepSeek search is rate limited", "SEARCH_RATE_LIMIT");
  }
  throw new WebError(`DeepSeek search returned HTTP ${response.status}`, "SCRAPLING_SEARCH_FAILED");
}

async function decodeResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new WebError(
      `DeepSeek search returned invalid JSON: ${String(error)}`,
      "SCRAPLING_SEARCH_FAILED",
    );
  }
}

export interface DeepSeekDiscoveryOptions {
  readonly maxResults: number;
  readonly offset?: number;
  readonly route?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function discoverDeepSeek(
  deps: DeepSeekSearchDeps,
  query: string,
  options: DeepSeekDiscoveryOptions,
): Promise<{ hits: DeepSeekHit[]; truncated: boolean }> {
  const { maxResults, offset = 0, route, signal } = options;
  if (deps.deepseekAuth === undefined) {
    throw new WebError("DeepSeek authentication is unavailable", "SEARCH_AUTH");
  }
  const endpoint = endpointOf(deps);
  signal?.throwIfAborted();
  await deps.rateLimiter?.wait(signal);
  const authorization = await deps.deepseekAuth.authorize(requestFor(endpoint, route), signal);
  if (authorization === undefined) {
    throw new WebError("DeepSeek authentication is not configured", "SEARCH_AUTH");
  }
  const response = await sendRequest({
    deps,
    authorization,
    query,
    count: Math.min(maxResults + offset, DEEPSEEK_MAX_RESULTS),
    signal: requestSignal(signal, authorization.revoked),
    callerSignal: signal,
  });
  await ensureOk(response, authorization);
  const hits = hitsOf(await decodeResponse(response));
  return {
    hits: hits.slice(offset, offset + maxResults),
    truncated: maxResults + offset > DEEPSEEK_MAX_RESULTS || hits.length > offset + maxResults,
  };
}
