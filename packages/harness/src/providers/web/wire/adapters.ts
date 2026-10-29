/**
 * Vendor HTTP adapters. Keyless and keyed share one mapper per vendor.
 */
import { randomUUID } from "node:crypto";

import { isRetryableFailure, isRateLimitish, mcpToolCall, postJson, SearchHttpError } from "./http.js";
import { parseJsonUnknown, readField } from "./json.js";
import { hitsOf, type KeylessVendor, type SearchHit, type SearchOutcome, type SearchRequest } from "./types.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const FIRECRAWL_CLOUD_URL = "https://api.firecrawl.dev";
export const FIRECRAWL_NOUS_GATEWAY_URL = "https://firecrawl-gateway.nousresearch.com";
export const KEENABLE_API_URL = "https://api.keenable.ai";
export const EXA_API_URL = "https://api.exa.ai/search";
export const PARALLEL_API_URL = "https://api.parallel.ai/v1beta/search";
export const TAVILY_API_URL = "https://api.tavily.com";
export const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
export const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";

const KEENABLE_TITLE = "harness";

/** Per-process anonymous id for Parallel rate-limit correlation. Not a user identifier. */
export const KEYLESS_SESSION_ID = randomUUID().replaceAll("-", "");

function fail(vendor: KeylessVendor, error: unknown): SearchOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const throttled = error instanceof SearchHttpError ? error.throttled : isRateLimitish(message);
  return {
    ok: false,
    error: message,
    throttled,
    retryable: isRetryableFailure(error),
    vendor,
  };
}

function ok(vendor: KeylessVendor, hits: readonly SearchHit[]): SearchOutcome {
  return { ok: true, hits, vendor };
}

const EXA_LABELS = ["Title:", "URL:", "Highlights:", "Published:", "Author:"];

function after(line: string, prefix: string): string {
  return line.slice(prefix.length).trim();
}

export function parseExaSearchText(text: string, limit: number): SearchHit[] {
  const results: SearchHit[] = [];
  for (const block of text.split("\n---\n")) {
    let title = "";
    let url = "";
    const highlightLines: string[] = [];
    let inHighlights = false;
    for (const stripped of block.split("\n").map((line) => line.trim())) {
      if (stripped.startsWith("Title:")) title = after(stripped, "Title:");
      else if (stripped.startsWith("URL:")) url = after(stripped, "URL:");
      else if (inHighlights && stripped !== "" && !EXA_LABELS.some((label) => stripped.startsWith(label))) {
        highlightLines.push(stripped);
      }
      if (EXA_LABELS.some((label) => stripped.startsWith(label))) {
        inHighlights = stripped.startsWith("Highlights:");
      }
    }
    if (url !== "") {
      results.push({ title, url, snippet: highlightLines.join(" ") });
    }
    if (results.length >= limit) break;
  }
  return results;
}

function objectResults(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const results = readField(data, "results");
  return Array.isArray(results) ? results : [];
}

function stringJoin(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join(" ");
}

function hitFields(item: unknown, snippet: unknown): { title?: unknown; url?: unknown; snippet?: unknown } {
  if (item === null || typeof item !== "object") return { title: "", url: "", snippet: "" };
  return {
    title: readField(item, "title"),
    url: readField(item, "url"),
    snippet,
  };
}

function firecrawlHits(payload: unknown, limit: number): SearchHit[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
  const data = readField(payload, "data");
  const lists = [data, readField(payload, "web"), readField(payload, "results")];
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    lists.push(readField(data, "web"), readField(data, "results"));
  }
  if (Array.isArray(data)) lists.push(data);
  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const mapped = list.map((item) => {
      if (item === null || typeof item !== "object") return { title: "", url: "", snippet: "" };
      return hitFields(item, readField(item, "description") ?? readField(item, "snippet"));
    });
    const hits = hitsOf(mapped, limit);
    if (hits.length > 0) return hits;
  }
  return [];
}

export async function searchExa(req: SearchRequest): Promise<SearchOutcome> {
  try {
    if (req.apiKey !== undefined && req.apiKey !== "") {
      const { text } = await postJson({
        url: EXA_API_URL,
        signal: req.signal,
        headers: { "x-api-key": req.apiKey },
        body: {
          query: req.query,
          numResults: req.limit,
          contents: { highlights: true },
        },
      });
      const data = parseJsonUnknown(text);
      return ok(
        "exa",
        hitsOf(
          objectResults(data).map((row) =>
            typeof row === "object" && row !== null ? hitFields(row, stringJoin(readField(row, "highlights"))) : {},
          ),
          req.limit,
        ),
      );
    }
    const text = await mcpToolCall({
      url: EXA_MCP_URL,
      tool: "web_search_exa",
      arguments: {
        query: req.query,
        objective: req.query,
        numResults: req.limit,
      },
      signal: req.signal,
    });
    return ok("exa", parseExaSearchText(text, req.limit));
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("exa", error);
  }
}

export async function searchParallel(req: SearchRequest): Promise<SearchOutcome> {
  try {
    if (req.apiKey !== undefined && req.apiKey !== "") {
      const { text } = await postJson({
        url: PARALLEL_API_URL,
        signal: req.signal,
        headers: { authorization: `Bearer ${req.apiKey}` },
        body: {
          objective: req.query,
          search_queries: [req.query],
          max_results: req.limit,
          mode: "fast",
        },
      });
      const data = parseJsonUnknown(text);
      return ok(
        "parallel",
        hitsOf(
          objectResults(data).map((row) =>
            typeof row === "object" && row !== null ? hitFields(row, stringJoin(readField(row, "excerpts"))) : {},
          ),
          req.limit,
        ),
      );
    }
    const text = await mcpToolCall({
      url: PARALLEL_MCP_URL,
      tool: "web_search",
      arguments: {
        objective: req.query,
        search_queries: [req.query],
        session_id: req.sessionId,
      },
      signal: req.signal,
    });
    const data = parseJsonUnknown(text);
    return ok(
      "parallel",
      hitsOf(
        objectResults(data).map((row) =>
          typeof row === "object" && row !== null ? hitFields(row, stringJoin(readField(row, "excerpts"))) : {},
        ),
        req.limit,
      ),
    );
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("parallel", error);
  }
}

export async function searchFirecrawl(req: SearchRequest): Promise<SearchOutcome> {
  const base = (req.apiUrl ?? FIRECRAWL_CLOUD_URL).replace(/\/$/, "");
  try {
    const { text } = await postJson({
      url: `${base}/v2/search`,
      signal: req.signal,
      headers: req.apiKey !== undefined && req.apiKey !== "" ? { authorization: `Bearer ${req.apiKey}` } : {},
      body: { query: req.query, limit: req.limit },
    });
    return ok("firecrawl", firecrawlHits(parseJsonUnknown(text), req.limit));
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("firecrawl", error);
  }
}

export function tavilyHeaders(apiKey: string | undefined): Record<string, string> {
  if (apiKey !== undefined && apiKey !== "") return { authorization: `Bearer ${apiKey}` };
  return { "x-tavily-access-mode": "keyless" };
}

export async function searchTavily(req: SearchRequest): Promise<SearchOutcome> {
  try {
    const { text } = await postJson({
      url: `${TAVILY_API_URL}/search`,
      signal: req.signal,
      headers: tavilyHeaders(req.apiKey),
      body: { query: req.query, max_results: req.limit },
    });
    const data = parseJsonUnknown(text);
    return ok(
      "tavily",
      hitsOf(
        objectResults(data).map((row) =>
          typeof row === "object" && row !== null
            ? hitFields(row, readField(row, "content") ?? readField(row, "snippet"))
            : {},
        ),
        req.limit,
      ),
    );
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("tavily", error);
  }
}

export async function searchKeenable(req: SearchRequest): Promise<SearchOutcome> {
  const keyed = req.apiKey !== undefined && req.apiKey !== "";
  try {
    const { text } = await postJson({
      url: keyed ? `${KEENABLE_API_URL}/v1/search` : `${KEENABLE_API_URL}/v1/search/public`,
      signal: req.signal,
      headers: {
        "x-keenable-title": KEENABLE_TITLE,
        ...(keyed ? { authorization: `Bearer ${req.apiKey}` } : {}),
      },
      body: { query: req.query, max_results: req.limit },
    });
    const data = parseJsonUnknown(text);
    return ok(
      "keenable",
      hitsOf(
        objectResults(data).map((row) =>
          typeof row === "object" && row !== null
            ? hitFields(row, readField(row, "snippet") ?? readField(row, "description"))
            : {},
        ),
        req.limit,
      ),
    );
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("keenable", error);
  }
}

export async function searchVendor(vendor: KeylessVendor, req: SearchRequest): Promise<SearchOutcome> {
  switch (vendor) {
    case "exa":
      return searchExa(req);
    case "parallel":
      return searchParallel(req);
    case "firecrawl":
      return searchFirecrawl(req);
    case "keenable":
      return searchKeenable(req);
    case "tavily":
      return searchTavily(req);
  }
}
