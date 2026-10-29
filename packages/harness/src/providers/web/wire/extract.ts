/**
 * Vendor extract adapters. Keyless and keyed share one mapper per vendor.
 * One URL → markdown. Transient failures hop on the keyless ring.
 */
import {
  EXA_CONTENTS_URL,
  EXA_MCP_URL,
  FIRECRAWL_CLOUD_URL,
  KEENABLE_API_URL,
  PARALLEL_EXTRACT_URL,
  PARALLEL_MCP_URL,
  TAVILY_API_URL,
  tavilyHeaders,
} from "./adapters.js";
import { isRetryableFailure, isRateLimitish, getJson, mcpToolCall, postJson, SearchHttpError } from "./http.js";
import { asRecord, parseJsonUnknown } from "./json.js";
import { publicHttpUrl } from "./ssrf.js";
import type { KeylessVendor } from "./types.js";

const KEENABLE_TITLE = "harness";

export type ExtractOk = {
  readonly ok: true;
  readonly url: string;
  readonly requestedUrl: string;
  /** Provider-reported, not independently verified. Absent when unavailable. */
  readonly sourceUrl?: string;
  readonly title: string;
  readonly markdown: string;
  readonly truncated: boolean;
  readonly vendor: KeylessVendor;
};

export type ExtractErr = {
  readonly ok: false;
  readonly error: string;
  readonly throttled: boolean;
  readonly retryable?: boolean;
  readonly vendor: KeylessVendor | "keyless";
};

export type ExtractOutcome = ExtractOk | ExtractErr;

export type ExtractRequest = {
  readonly url: string;
  readonly charLimit: number;
  readonly signal: AbortSignal;
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly sessionId: string;
};

function fail(vendor: KeylessVendor, error: unknown): ExtractErr {
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

function bound(markdown: string, limit: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= limit) return { markdown, truncated: false };
  return { markdown: markdown.slice(0, limit), truncated: true };
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pageOf(
  vendor: KeylessVendor,
  requestedUrl: string,
  sourceUrl: string,
  title: string,
  markdown: string,
  limit: number,
): ExtractOutcome {
  const trimmed = markdown.trim();
  if (trimmed === "")
    return {
      ok: false,
      error: "empty extract",
      throttled: false,
      retryable: true,
      vendor,
    };
  const cut = bound(trimmed, limit);
  if (sourceUrl !== "") {
    try {
      publicHttpUrl(sourceUrl);
    } catch {
      return {
        ok: false,
        error: "invalid extraction source URL",
        throttled: false,
        retryable: true,
        vendor,
      };
    }
  }
  return {
    ok: true,
    url: sourceUrl || requestedUrl,
    requestedUrl,
    ...(sourceUrl === "" ? {} : { sourceUrl }),
    title,
    markdown: cut.markdown,
    truncated: cut.truncated,
    vendor,
  };
}

function firstResultArray(payload: unknown, keys: readonly string[]): unknown[] {
  const rec = asRecord(payload);
  if (rec === null) return Array.isArray(payload) ? payload : [];
  for (const key of keys) {
    const value = rec[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  const data = asRecord(rec.data);
  if (data !== null) {
    for (const key of keys) {
      const value = data[key];
      if (Array.isArray(value) && value.length > 0) return value;
    }
  }
  return [];
}

function markdownFromUnknown(payload: unknown): {
  title: string;
  markdown: string;
  url: string;
} {
  if (typeof payload === "string") return { title: "", markdown: payload, url: "" };
  const rec = asRecord(payload);
  if (rec === null && !Array.isArray(payload)) return { title: "", markdown: "", url: "" };
  if (rec?.success === false || rec?.error != null)
    throw new SearchHttpError("provider reported extraction failure", {
      retryable: true,
    });
  const results = firstResultArray(payload, ["results", "data", "pages"]);
  const row = results.length > 0 ? asRecord(results[0]) : rec;
  if (row === null) return { title: "", markdown: "", url: "" };
  const data = asRecord(row.data) ?? row;
  const meta = asRecord(data.metadata);
  return {
    title: stringOf(data.title) || stringOf(meta?.title),
    markdown:
      stringOf(data.markdown) ||
      stringOf(data.raw_content) ||
      stringOf(data.content) ||
      stringOf(data.text) ||
      stringOf(data.full_content) ||
      (Array.isArray(data.excerpts) ? data.excerpts.filter((e) => typeof e === "string").join("\n\n") : ""),
    url: stringOf(data.url) || stringOf(data.sourceUrl) || stringOf(meta?.sourceURL),
  };
}

function parseMcpPage(text: string): {
  title: string;
  markdown: string;
  url: string;
} {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return markdownFromUnknown(parseJsonUnknown(trimmed));
    } catch {
      throw new SearchHttpError("Malformed MCP extraction response", {
        retryable: true,
      });
    }
  }
  // MCP text has no structured provenance. Never infer its source from the requested URL.
  return { title: "", markdown: text, url: "" };
}

export async function extractExa(req: ExtractRequest): Promise<ExtractOutcome> {
  const href = publicHttpUrl(req.url).href;
  try {
    if (req.apiKey !== undefined && req.apiKey !== "") {
      const { text } = await postJson({
        url: EXA_CONTENTS_URL,
        signal: req.signal,
        headers: { "x-api-key": req.apiKey },
        body: { urls: [href], text: { maxCharacters: req.charLimit } },
      });
      const page = markdownFromUnknown(parseJsonUnknown(text));
      return pageOf("exa", req.url, page.url, page.title, page.markdown, req.charLimit);
    }
    const text = await mcpToolCall({
      url: EXA_MCP_URL,
      tool: "web_fetch_exa",
      arguments: { urls: [href], maxCharacters: req.charLimit },
      signal: req.signal,
    });
    const page = parseMcpPage(text);
    return pageOf("exa", req.url, page.url, page.title, page.markdown, req.charLimit);
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("exa", error);
  }
}

export async function extractParallel(req: ExtractRequest): Promise<ExtractOutcome> {
  const href = publicHttpUrl(req.url).href;
  try {
    if (req.apiKey !== undefined && req.apiKey !== "") {
      const { text } = await postJson({
        url: PARALLEL_EXTRACT_URL,
        signal: req.signal,
        headers: { "x-api-key": req.apiKey },
        body: { urls: [href], full_content: true, session_id: req.sessionId },
      });
      const page = markdownFromUnknown(parseJsonUnknown(text));
      return pageOf("parallel", req.url, page.url, page.title, page.markdown, req.charLimit);
    }
    const text = await mcpToolCall({
      url: PARALLEL_MCP_URL,
      tool: "web_fetch",
      arguments: {
        urls: [href],
        full_content: true,
        session_id: req.sessionId,
      },
      signal: req.signal,
    });
    const page = parseMcpPage(text);
    return pageOf("parallel", req.url, page.url, page.title, page.markdown, req.charLimit);
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("parallel", error);
  }
}

export async function extractFirecrawl(req: ExtractRequest): Promise<ExtractOutcome> {
  const href = publicHttpUrl(req.url).href;
  const base = (req.apiUrl ?? FIRECRAWL_CLOUD_URL).replace(/\/$/, "");
  try {
    const { text } = await postJson({
      url: `${base}/v2/scrape`,
      signal: req.signal,
      headers: req.apiKey !== undefined && req.apiKey !== "" ? { authorization: `Bearer ${req.apiKey}` } : {},
      body: { url: href, formats: ["markdown"] },
    });
    const page = markdownFromUnknown(parseJsonUnknown(text));
    return pageOf("firecrawl", req.url, page.url, page.title, page.markdown, req.charLimit);
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("firecrawl", error);
  }
}

export async function extractKeenable(req: ExtractRequest): Promise<ExtractOutcome> {
  const href = publicHttpUrl(req.url).href;
  const keyed = req.apiKey !== undefined && req.apiKey !== "";
  const path = keyed ? "/v1/fetch" : "/v1/fetch/public";
  try {
    const { text } = await getJson({
      url: `${KEENABLE_API_URL}${path}?url=${encodeURIComponent(href)}&live=true`,
      signal: req.signal,
      headers: {
        "x-keenable-title": KEENABLE_TITLE,
        ...(keyed ? { authorization: `Bearer ${req.apiKey}` } : {}),
      },
    });
    const page = markdownFromUnknown(parseJsonUnknown(text));
    return pageOf("keenable", req.url, page.url, page.title, page.markdown, req.charLimit);
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("keenable", error);
  }
}

export async function extractTavily(req: ExtractRequest): Promise<ExtractOutcome> {
  const href = publicHttpUrl(req.url).href;
  try {
    const { text } = await postJson({
      url: `${TAVILY_API_URL}/extract`,
      signal: req.signal,
      headers: tavilyHeaders(req.apiKey),
      body: { urls: [href], format: "markdown" },
    });
    const data = parseJsonUnknown(text);
    const rec = asRecord(data);
    const failed = rec !== null && Array.isArray(rec.failed_results) ? rec.failed_results : [];
    if (failed.length > 0) {
      const first = asRecord(failed[0]);
      const message = stringOf(first?.error) || "extract failed";
      return fail("tavily", new Error(message));
    }
    const page = markdownFromUnknown(data);
    return pageOf("tavily", req.url, page.url, page.title, page.markdown, req.charLimit);
  } catch (error) {
    if (req.signal.aborted) throw error;
    return fail("tavily", error);
  }
}

export async function extractVendor(vendor: KeylessVendor, req: ExtractRequest): Promise<ExtractOutcome> {
  switch (vendor) {
    case "exa":
      return extractExa(req);
    case "parallel":
      return extractParallel(req);
    case "firecrawl":
      return extractFirecrawl(req);
    case "keenable":
      return extractKeenable(req);
    case "tavily":
      return extractTavily(req);
  }
}
