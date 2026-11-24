import { describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_MAX_RESULTS,
  DEEPSEEK_SEARCH_REQUESTS_PER_SECOND,
  DeepSeekRateLimiter,
  DEEPSEEK_SEARCH_ENDPOINT,
  deepseekReady,
  discoverDeepSeek,
  isDeepSeekAuth,
} from "../lib/deepseek-search.ts";
import type {
  DeepSeekAuthLike,
  DeepSeekAuthorizationLike,
  DeepSeekSearchDeps,
} from "../lib/deepseek-search.ts";

const ENDPOINT = "https://api.deepseek.test/v1/tools/search";
const PAGE_A = "https://a.test";
const PAGE_B = "https://b.test";
const AUTHORIZATION: DeepSeekAuthorizationLike = {
  kind: "api-key",
  endpoint: ENDPOINT,
  headers: { authorization: "Bearer secret" },
};

function auth(over: Partial<DeepSeekAuthLike> = {}): DeepSeekAuthLike {
  return {
    candidates: () => [],
    authorize: () => Promise.resolve(AUTHORIZATION),
    ...over,
  };
}

function deps(over: Partial<DeepSeekSearchDeps> = {}): DeepSeekSearchDeps {
  return {
    deepseekAuth: auth(),
    deepseekEndpoint: () => ENDPOINT,
    fetchImpl: () => Promise.resolve(Response.json({ results: [] })),
    ...over,
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected rejection");
}

describe("deepseek auth shape", () => {
  it("accepts only objects with callable candidates and authorize", () => {
    expect(DEEPSEEK_SEARCH_ENDPOINT).toBe("https://api.deepseek.com/v1/tools/search");
    expect(isDeepSeekAuth(undefined)).toBe(false);
    expect(isDeepSeekAuth(null)).toBe(false);
    expect(isDeepSeekAuth({})).toBe(false);
    expect(isDeepSeekAuth({ candidates: 1 })).toBe(false);
    expect(isDeepSeekAuth({ candidates: () => [] })).toBe(false);
    expect(isDeepSeekAuth({ candidates: () => [], authorize: 1 })).toBe(false);
    expect(isDeepSeekAuth(auth())).toBe(true);
  });
});

describe("deepseek ready", () => {
  it("returns false without auth or with invalid endpoint", async () => {
    await expect(deepseekReady(deps({ deepseekAuth: undefined }), undefined)).resolves.toBe(false);
    await expect(
      deepseekReady(deps({ deepseekEndpoint: () => "http://api.deepseek.test/search" }), undefined),
    ).resolves.toBe(false);
    await expect(
      deepseekReady(
        deps({ deepseekEndpoint: () => "https://user:pass@api.deepseek.test/search" }),
        undefined,
      ),
    ).resolves.toBe(false);
    await expect(
      deepseekReady(deps({ deepseekEndpoint: () => "not a url" }), undefined),
    ).resolves.toBe(false);
  });

  it("walks candidates in order and stops at the first configured credential", async () => {
    const calls: string[] = [];
    const service = auth({
      candidates: () => [
        {
          kind: "account",
          endpoint: ENDPOINT,
          configured: () => {
            calls.push("account");
            return Promise.resolve(false);
          },
          resolve: () => Promise.resolve(undefined),
        },
        {
          kind: "api-key",
          endpoint: ENDPOINT,
          configured: () => {
            calls.push("api-key");
            return Promise.resolve(true);
          },
          resolve: () => Promise.resolve(AUTHORIZATION),
        },
        {
          kind: "account",
          endpoint: ENDPOINT,
          configured: () => {
            calls.push("unused");
            return Promise.resolve(true);
          },
          resolve: () => Promise.resolve(undefined),
        },
      ],
    });

    await expect(deepseekReady(deps({ deepseekAuth: service }), "route")).resolves.toBe(true);
    expect(calls).toStrictEqual(["account", "api-key"]);
  });

  it("returns false for empty, unresolved, or throwing candidates", async () => {
    await expect(deepseekReady(deps(), undefined)).resolves.toBe(false);
    const unresolved = auth({
      candidates: () => [
        { kind: "account", unresolved: "connection", error: new Error("missing") },
      ],
    });
    await expect(deepseekReady(deps({ deepseekAuth: unresolved }), undefined)).resolves.toBe(false);
    const throwingCandidate = auth({
      candidates: () => [
        {
          kind: "api-key",
          endpoint: ENDPOINT,
          configured: () => Promise.reject(new Error("store failed")),
          resolve: () => Promise.resolve(undefined),
        },
      ],
    });
    await expect(deepseekReady(deps({ deepseekAuth: throwingCandidate }), undefined)).resolves.toBe(
      false,
    );
    const throwingCandidates = auth({
      candidates: () => {
        throw new Error("connection failed");
      },
    });
    await expect(
      deepseekReady(deps({ deepseekAuth: throwingCandidates }), undefined),
    ).resolves.toBe(false);
  });
});

describe("deepseek discovery", () => {
  it("paces the sixth request in a one-second window", async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const rateLimiter = new DeepSeekRateLimiter();
      const pending = Array.from({ length: DEEPSEEK_SEARCH_REQUESTS_PER_SECOND + 1 }, () =>
        discoverDeepSeek(
          deps({
            rateLimiter,
            fetchImpl: () => {
              starts.push(Date.now());
              return Promise.resolve(Response.json({ results: [] }));
            },
          }),
          "q",
          { maxResults: 1 },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toHaveLength(DEEPSEEK_SEARCH_REQUESTS_PER_SECOND);
      await vi.advanceTimersByTimeAsync(1001);
      await Promise.all(pending);
      expect(starts).toHaveLength(DEEPSEEK_SEARCH_REQUESTS_PER_SECOND + 1);
      expect((starts[5] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1001);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a request waiting for a rate-limit slot without dispatching it", async () => {
    vi.useFakeTimers();
    try {
      const rateLimiter = new DeepSeekRateLimiter();
      let dispatched = 0;
      const base = deps({
        rateLimiter,
        fetchImpl: () => {
          dispatched += 1;
          return Promise.resolve(Response.json({ results: [] }));
        },
      });
      const fillWindow = async (remaining: number): Promise<void> => {
        if (remaining === 0) {
          return;
        }
        await discoverDeepSeek(base, "q", { maxResults: 1 });
        return fillWindow(remaining - 1);
      };
      await fillWindow(DEEPSEEK_SEARCH_REQUESTS_PER_SECOND);
      const controller = new AbortController();
      const waiting = discoverDeepSeek(base, "q", {
        maxResults: 1,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(dispatched).toBe(DEEPSEEK_SEARCH_REQUESTS_PER_SECOND);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects missing auth, pre-aborted calls, and unresolved authorization", async () => {
    const missing = await failureOf(() =>
      discoverDeepSeek(deps({ deepseekAuth: undefined }), "q", { maxResults: 10 }),
    );
    expect(missing.code).toBe("SEARCH_AUTH");

    const controller = new AbortController();
    controller.abort();
    const aborted = await failureOf(() =>
      discoverDeepSeek(deps(), "q", { maxResults: 10, signal: controller.signal }),
    );
    expect(aborted.name).toBe("AbortError");

    const unresolved = await failureOf(() =>
      discoverDeepSeek(
        deps({ deepseekAuth: auth({ authorize: () => Promise.resolve(undefined) }) }),
        "q",
        { maxResults: 10 },
      ),
    );
    expect(unresolved.code).toBe("SEARCH_AUTH");
  });

  it("maps results, preserves optional metadata, and caps count at 50", async () => {
    let body: unknown;
    const result = await discoverDeepSeek(
      deps({
        fetchImpl: (_input, init) => {
          if (typeof init?.body !== "string") {
            return Promise.reject(new TypeError("expected JSON body"));
          }
          body = JSON.parse(init.body);
          return Promise.resolve(
            Response.json({
              results: [
                {
                  url: PAGE_A,
                  title: "A",
                  snippet: "snippet",
                  summary: "summary",
                  date: "2026-11-20",
                },
                { url: PAGE_B, title: "", snippet: "", date: null },
              ],
            }),
          );
        },
      }),
      "query",
      { maxResults: 100, route: "deepseek-official" },
    );

    expect(body).toStrictEqual({
      query: "query",
      count: DEEPSEEK_MAX_RESULTS,
      need_content: false,
    });
    expect(result.truncated).toBe(true);
    expect(result.hits).toStrictEqual([
      {
        url: PAGE_A,
        title: "A",
        snippet: "snippet",
        summary: "summary",
        publishedAt: "2026-11-20",
      },
      { url: PAGE_B },
    ]);
  });

  it("applies offset after over-fetching and reports the capped count", async () => {
    let body: unknown;
    const result = await discoverDeepSeek(
      deps({
        fetchImpl: (_input, init) => {
          if (typeof init?.body !== "string") {
            return Promise.reject(new TypeError("expected JSON body"));
          }
          body = JSON.parse(init.body);
          return Promise.resolve(
            Response.json({
              results: [
                { url: PAGE_A, title: "A", snippet: "A", date: null },
                { url: PAGE_B, title: "B", snippet: "B", date: null },
                { url: "https://c.test", title: "C", snippet: "C", date: null },
              ],
            }),
          );
        },
      }),
      "q",
      { maxResults: 1, offset: 1 },
    );
    expect(body).toStrictEqual({ query: "q", count: 2, need_content: false });
    expect(result.truncated).toBe(true);
    expect(result.hits).toStrictEqual([{ url: PAGE_B, title: "B", snippet: "B" }]);
  });

  it("rejects malformed roots and items", async () => {
    const payloads: unknown[] = [
      null,
      {},
      { results: "nope" },
      { results: [null] },
      { results: [{ title: "A", snippet: "S", date: null }] },
      { results: [{ url: "", title: "A", snippet: "S", date: null }] },
      { results: [{ url: PAGE_A, snippet: "S", date: null }] },
      { results: [{ url: PAGE_A, title: "A", date: null }] },
      {
        results: [{ url: PAGE_A, title: "A", snippet: "S", summary: 1, date: null }],
      },
      {
        results: [{ url: PAGE_A, title: "A", snippet: "S", date: undefined }],
      },
    ];
    const errors = await Promise.all(
      payloads.map((payload) =>
        failureOf(() =>
          discoverDeepSeek(
            deps({ fetchImpl: () => Promise.resolve(Response.json(payload)) }),
            "q",
            { maxResults: 10 },
          ),
        ),
      ),
    );
    expect(errors.map((error) => error.code)).toStrictEqual(
      payloads.map(() => "SCRAPLING_SEARCH_FAILED"),
    );
  });

  it("maps 401, rejected cleanup, 429, 5xx, network failure, and invalid JSON", async () => {
    const rejected: DeepSeekAuthorizationLike = {
      ...AUTHORIZATION,
      reject: () => Promise.reject(new Error("cleanup failed")),
    };
    const unauthorized = await failureOf(() =>
      discoverDeepSeek(
        deps({
          deepseekAuth: auth({ authorize: () => Promise.resolve(rejected) }),
          fetchImpl: () => Promise.resolve(new Response("no", { status: 401 })),
        }),
        "q",
        { maxResults: 10 },
      ),
    );
    expect(unauthorized.code).toBe("SEARCH_AUTH");

    const noReject = await failureOf(() =>
      discoverDeepSeek(
        deps({ fetchImpl: () => Promise.resolve(new Response("no", { status: 401 })) }),
        "q",
        { maxResults: 10 },
      ),
    );
    expect(noReject.code).toBe("SEARCH_AUTH");

    const limited = await failureOf(() =>
      discoverDeepSeek(
        deps({ fetchImpl: () => Promise.resolve(new Response("no", { status: 429 })) }),
        "q",
        { maxResults: 10 },
      ),
    );
    expect(limited.code).toBe("SEARCH_RATE_LIMIT");

    const server = await failureOf(() =>
      discoverDeepSeek(
        deps({ fetchImpl: () => Promise.resolve(new Response("no", { status: 503 })) }),
        "q",
        { maxResults: 10 },
      ),
    );
    expect(server.code).toBe("SCRAPLING_SEARCH_FAILED");

    const network = await failureOf(() =>
      discoverDeepSeek(deps({ fetchImpl: () => Promise.reject(new Error("offline")) }), "q", {
        maxResults: 10,
      }),
    );
    expect(network.code).toBe("SCRAPLING_SEARCH_FAILED");

    const json = await failureOf(() =>
      discoverDeepSeek(
        deps({ fetchImpl: () => Promise.resolve(new Response("not-json", { status: 200 })) }),
        "q",
        { maxResults: 10 },
      ),
    );
    expect(json.code).toBe("SCRAPLING_SEARCH_FAILED");
  });

  it("preserves caller aborts and maps credential revocation", async () => {
    const caller = new AbortController();
    const callerAbort = await failureOf(() =>
      discoverDeepSeek(
        deps({
          fetchImpl: () => {
            caller.abort();
            return Promise.reject(new DOMException("aborted", "AbortError"));
          },
        }),
        "q",
        { maxResults: 10, signal: caller.signal },
      ),
    );
    expect(callerAbort.name).toBe("AbortError");

    const revoked = new AbortController();
    const revokedError = await failureOf(() =>
      discoverDeepSeek(
        deps({
          deepseekAuth: auth({
            authorize: () => Promise.resolve({ ...AUTHORIZATION, revoked: revoked.signal }),
          }),
          fetchImpl: () => {
            revoked.abort();
            return Promise.reject(new DOMException("aborted", "AbortError"));
          },
        }),
        "q",
        { maxResults: 10 },
      ),
    );
    expect(revokedError.code).toBe("SEARCH_AUTH");
  });

  it("combines caller and revocation signals and supports signal-free requests", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    await discoverDeepSeek(
      deps({
        deepseekAuth: auth({
          authorize: () =>
            Promise.resolve({ ...AUTHORIZATION, revoked: new AbortController().signal }),
        }),
        fetchImpl: (_input, init) => {
          seen.push(init?.signal);
          return Promise.resolve(Response.json({ results: [] }));
        },
      }),
      "q",
      { maxResults: 10, signal: new AbortController().signal },
    );
    expect(seen[0]).toBeInstanceOf(AbortSignal);

    await discoverDeepSeek(deps(), "q", { maxResults: 10 });
    expect(seen[1]).toBeUndefined();
  });
});
