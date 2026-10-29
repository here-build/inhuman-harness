/**
 * HTTP helpers for web-search adapters. Rate-limit shape is the ring hop signal.
 */
import { describeHttpFailure, wrapFetchFailure } from "./fetch-failure.js";

/** Same 60s budget as the process fetch timer; this package does not install that dispatcher. */
export const SEARCH_TIMEOUT_MS = 60_000;
export const SEARCH_USER_AGENT = "harness";

const RATE_LIMIT_MARKERS = [
  "rate limit",
  "rate-limit",
  "ratelimit",
  "too many requests",
  "429",
  "quota exceeded",
  "slow down",
];

export class SearchHttpError extends Error {
  readonly status: number | undefined;
  readonly throttled: boolean;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts?: {
      readonly status?: number;
      readonly throttled?: boolean;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.status = opts?.status;
    this.retryable =
      opts?.retryable === true || opts?.status === 408 || (opts?.status !== undefined && opts.status >= 500);
    this.throttled = opts?.throttled === true || opts?.status === 429 || isRateLimitish(message);
  }
}

export function isRateLimitish(message: string): boolean {
  const lower = message.toLowerCase();
  return RATE_LIMIT_MARKERS.some((marker) => lower.includes(marker));
}

export function searchSignal(signal: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return signal.aborted ? signal : timeout;
}

export async function getJson(opts: {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}): Promise<{ readonly status: number; readonly text: string }> {
  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": SEARCH_USER_AGENT,
        ...opts.headers,
      },
      signal: searchSignal(opts.signal),
    });
  } catch (error) {
    if (opts.signal.aborted) throw error;
    throw new SearchHttpError(wrapFetchFailure(error, { method: "GET", url: opts.url }).message, {
      cause: error,
      retryable: true,
    });
  }
  const text = await res.text();
  if (res.status >= 400) {
    throw new SearchHttpError(
      describeHttpFailure({
        method: "GET",
        url: opts.url,
        status: res.status,
        detail: text.trim().slice(0, 300),
      }),
      { status: res.status, throttled: res.status === 429 },
    );
  }
  return { status: res.status, text };
}

export async function postJson(opts: {
  readonly url: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}): Promise<{ readonly status: number; readonly text: string }> {
  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": SEARCH_USER_AGENT,
        ...opts.headers,
      },
      body: JSON.stringify(opts.body),
      signal: searchSignal(opts.signal),
    });
  } catch (error) {
    if (opts.signal.aborted) throw error;
    throw new SearchHttpError(wrapFetchFailure(error, { method: "POST", url: opts.url }).message, {
      cause: error,
      retryable: true,
    });
  }
  const text = await res.text();
  if (res.status >= 400) {
    throw new SearchHttpError(
      describeHttpFailure({
        method: "POST",
        url: opts.url,
        status: res.status,
        detail: text.trim().slice(0, 300),
      }),
      { status: res.status, throttled: res.status === 429 },
    );
  }
  return { status: res.status, text };
}

/** First text content item from an MCP tools/call JSON or SSE body. */
export function parseMcpToolText(body: string): string {
  const stripped = body.trim();
  const candidates = stripped.startsWith("{") ? [stripped] : [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) candidates.push(line.slice("data: ".length));
  }
  for (const candidate of candidates) {
    try {
      const data: unknown = JSON.parse(candidate);
      if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
      const rec = data as {
        error?: { message?: unknown };
        result?: { isError?: unknown; content?: unknown };
      };
      if (rec.error !== undefined) {
        const message = typeof rec.error.message === "string" ? rec.error.message : String(rec.error);
        throw new SearchHttpError(message, {
          throttled: isRateLimitish(message),
        });
      }
      const result = rec.result ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const texts = content
        .filter(
          (item): item is { text: string } =>
            item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string",
        )
        .map((item) => item.text);
      if (result.isError === true) {
        const message = texts.filter(Boolean).join(" ") || "MCP tool call failed";
        throw new SearchHttpError(message, {
          throttled: isRateLimitish(message),
        });
      }
      const text = texts.find((item) => item !== "");
      if (text !== undefined) return text;
    } catch (error) {
      if (error instanceof SearchHttpError) throw error;
    }
  }
  throw new SearchHttpError("Unrecognized MCP response shape", {
    retryable: true,
  });
}

export async function mcpToolCall(opts: {
  readonly url: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { text } = await postJson({
    url: opts.url,
    headers: opts.headers,
    signal: opts.signal,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: opts.tool, arguments: opts.arguments },
    },
  });
  return parseMcpToolText(text);
}

/** Transport and response-decoding failures may succeed at another provider. */
export function isRetryableFailure(error: unknown): boolean {
  return error instanceof SearchHttpError ? error.retryable : error instanceof SyntaxError;
}
