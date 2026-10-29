/**
 * Every usage-reporting completion round is persisted under
 * `{workspace}/.harness/cache/<session>/<startedAt>-<kind>/` so a miss
 * diffs against the previous timestamped folder. Dumping only mismatches
 * left that prior round off disk.
 *
 * `request.json` is the HTTP round (redacted headers + body).
 * `response.json` is the last payload that still has output/choices/items;
 * a trailing usage-only `response.completed` does not wipe them.
 * `meta.json` is expected vs actual plus which assistant rows omit
 * `reasoning_content` — xAI's top cache-miss cause on reasoning models.
 * Auth / API-key headers stay off the dump.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asRecord, readField } from "./json-read.js";

export type CacheDumpKind = "unexpected-hit" | "unexpected-miss" | "aligned-hit" | "aligned-miss" | "unreported";

const REDACT_HEADER = /^(authorization|cookie|set-cookie|x-api-key)$/i;

export function cacheDumpKind(expected: boolean, cacheHit: boolean | null): CacheDumpKind {
  if (cacheHit === null) return "unreported";
  if (cacheHit && expected) return "aligned-hit";
  if (cacheHit && !expected) return "unexpected-hit";
  if (!cacheHit && expected) return "unexpected-miss";
  return "aligned-miss";
}

export function cacheDumpDir(workspacePath: string, sessionId: string, startedAt: number, kind: CacheDumpKind): string {
  return join(workspacePath, ".harness", "cache", sessionId, `${startedAt}-${kind}`);
}

export function redactCacheHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = REDACT_HEADER.test(key) ? "[redacted]" : value;
  }
  return out;
}

export type ReasoningGap = {
  readonly index: number;
  readonly contentChars: number;
  readonly calls: number;
};

function fieldPresent(rec: Record<string, unknown> | null, key: string): boolean {
  if (rec == null) return false;
  const value = rec[key];
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value !== "";
  return true;
}

/**
 * SSE last-wins would dump `response.completed` with empty `output` / empty
 * `choices`. Keep the last payload that still has the model's items.
 */
function payloadHasItems(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (rec == null) return false;
  const inner = asRecord(rec.response) ?? rec;
  return (
    fieldPresent(inner, "output") ||
    fieldPresent(inner, "choices") ||
    fieldPresent(rec, "delta") ||
    fieldPresent(rec, "item") ||
    fieldPresent(inner, "delta") ||
    fieldPresent(inner, "item")
  );
}

export function preferCacheResponse(prior: unknown, next: unknown): unknown {
  if (next == null) return prior;
  if (prior == null) return next;
  if (payloadHasItems(next)) return next;
  return payloadHasItems(prior) ? prior : next;
}

export function reasoningSurvey(body: unknown): {
  readonly assistants: number;
  readonly missingReasoning: readonly ReasoningGap[];
} {
  const rec = asRecord(body);
  const messages = rec == null ? undefined : readField(rec, "messages");
  const input = rec == null ? undefined : readField(rec, "input");
  const rows = Array.isArray(messages) ? messages : Array.isArray(input) ? input : [];
  const missing: ReasoningGap[] = [];
  let assistants = 0;
  for (const [index, row] of rows.entries()) {
    if (typeof row !== "object" || row === null) continue;
    if (readField(row, "role") !== "assistant") continue;
    assistants += 1;
    const reasoning = readField(row, "reasoning_content");
    if (typeof reasoning === "string" && reasoning !== "") continue;
    const content = readField(row, "content");
    const toolCalls = readField(row, "tool_calls");
    missing.push({
      index,
      contentChars: typeof content === "string" ? content.length : 0,
      calls: Array.isArray(toolCalls) ? toolCalls.length : 0,
    });
  }
  return { assistants, missingReasoning: missing };
}

export function writeCacheDump(input: {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly kind: CacheDumpKind;
  readonly expectedCacheHit: boolean;
  readonly cacheHit: boolean | null;
  readonly cachedTokens: number;
  readonly totalTokens: number | null;
  readonly request: unknown;
  readonly response: unknown;
  readonly answer?: {
    readonly content: string;
    readonly reasoning: string;
    readonly calls: number;
  };
}): string | null {
  const workspace = input.workspacePath.trim();
  if (workspace === "" || !isDirectory(workspace)) return null;
  const sessionId = input.sessionId.trim() === "" ? "session" : input.sessionId.trim();
  const sessionDir = join(workspace, ".harness", "cache", sessionId);
  const dir = cacheDumpDir(workspace, sessionId, input.startedAt, input.kind);
  const request = redactRequest(input.request ?? null);
  const body = typeof request === "object" && request !== null ? readField(request, "body") : undefined;
  const survey = reasoningSurvey(body);
  const meta = {
    kind: input.kind,
    expectedCacheHit: input.expectedCacheHit,
    cacheHit: input.cacheHit,
    cachedTokens: input.cachedTokens,
    totalTokens: input.totalTokens,
    startedAt: input.startedAt,
    answer: input.answer ?? null,
    wire: survey,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
    writeFileSync(join(dir, "response.json"), `${JSON.stringify(input.response ?? null, null, 2)}\n`);
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    appendFileSync(
      join(sessionDir, "index.jsonl"),
      `${JSON.stringify({ ...meta, dir: `${input.startedAt}-${input.kind}` })}\n`,
    );
    return dir;
  } catch {
    return null;
  }
}

function redactRequest(request: unknown): unknown {
  if (typeof request !== "object" || request === null) return request;
  const rec = asRecord(request);
  if (rec == null) return request;
  const headers = asRecord(rec.headers);
  if (headers == null) return request;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") strings[key] = value;
  }
  return { ...rec, headers: redactCacheHeaders(strings) };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
