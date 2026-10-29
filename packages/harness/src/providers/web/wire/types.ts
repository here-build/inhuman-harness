/** Shared search/extract wire types. Product driver IDs stay with registrations. */

export const WEB_SEARCH_CAN = "web-search";
export const WEB_EXTRACT_CAN = "web-extract";

export const KEYLESS_RING = ["exa", "parallel", "firecrawl", "keenable", "tavily"] as const;
export type KeylessVendor = (typeof KEYLESS_RING)[number];

export type SearchHit = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

export type SearchOk = {
  readonly ok: true;
  readonly hits: readonly SearchHit[];
  readonly vendor: KeylessVendor | "grok";
};

export type SearchErr = {
  readonly ok: false;
  readonly error: string;
  readonly throttled: boolean;
  readonly retryable?: boolean;
  readonly vendor: KeylessVendor | "grok" | "keyless";
};

export type SearchOutcome = SearchOk | SearchErr;

export type SearchRequest = {
  readonly query: string;
  readonly limit: number;
  readonly signal: AbortSignal;
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly sessionId: string;
};

export function hitsOf(
  rows: ReadonlyArray<{ title?: unknown; url?: unknown; snippet?: unknown }>,
  limit: number,
): SearchHit[] {
  const out: SearchHit[] = [];
  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (url === "") continue;
    out.push({
      title: typeof row.title === "string" ? row.title : "",
      url,
      snippet: typeof row.snippet === "string" ? row.snippet : "",
    });
    if (out.length >= limit) break;
  }
  return out;
}
