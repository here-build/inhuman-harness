/**
 * openai-compat completion actor. The HTTP round is per PEW.
 *
 * Connection-wide `#emit` / `#abort` / `#turnModel` would make parallel
 * remainder and ReACT settle on each other's speech. The connection stays
 * the durable client: catalog, headers, inflight abort set.
 *
 * History, compact lead, frozen/live tools, and squeeze live in harness-context.
 * viewWire encodes that projection plus vendor reasoning dialect. Chat Completions
 * vs Responses (`completionBody`) is vendor wire — D4, not context.
 * System is two messages: constitution+preamble (stable), env/mode (volatile).
 * Env stays off the first string — a date or mode change must not rewrite the
 * prefix OpenAI/xAI match from the left.
 *
 * Chat Completions vs Responses is a class, chosen in `connection.resolve`
 * from `completionApi()`. The round does not branch on that token.
 */
import { randomUUID } from "node:crypto";
import { ReadableStreamReadResult } from "node:stream/web";

import { fail, step, trace } from "@inhuman.tools/harness-diagnostics";
import {
  assertResponseMatchesSchema,
  cacheStatusLog,
  CompletionExpectation,
  latestCompactCutoff,
  owningTurn,
  ResponseCall,
  JSON_SCHEMA_UNSUPPORTED,
  SessionRoot,
  SessionTurn,
  type ToolTextPart,
} from "@inhuman.tools/harness-model";
import { readBlob, readVisual } from "@inhuman.tools/harness-provider-sdk";
import {
  ConnectionMiss,
  ConnectionNotReady,
  ExpectationActor,
  ExpectationInvariant,
} from "@inhuman.tools/plexus-expectations/driver";
import {
  createStreamSession,
  mergeReasoning,
  normalizeMessage,
  type OpenAiChatChunk,
  type ToolCall,
} from "@inhuman.tools/tool-call-normalize";
import { runInAction } from "mobx";
import invariant from "tiny-invariant";

import {
  approvalNoteMessagesOf as contextApprovalNotes,
  notificationMessagesOf as contextNotifications,
  projectHistory,
  selectCompletionTools,
  steerMessagesOf as contextSteers,
  type HistoryMessage,
} from "@/context";

import { emitsCacheControl, withCacheBreakpoints } from "./anthropic-cache.js";
import { ARG_ALIASES, type OpenAiTool } from "./arg-aliases.js";
import { usesExplicitPromptCache } from "./cache-affinity.js";
import { cacheDumpKind, preferCacheResponse, redactCacheHeaders, writeCacheDump } from "./cache-dump.js";
import { completionCatalogOf, liveToolDescriptionOf } from "./completion-face.js";
import type { OpenAiCompatDriverConnection } from "./connection.js";
import { describeHttpFailure, wrapFetchFailure } from "./fetch-failure.js";
import { parseJsonUnknown, readField } from "./json-read.js";
import { usageLedger } from "./model-catalog.js";
import {
  type ReasoningChatField,
  type ReasoningDialect,
  reasoningDialectFor,
  type ReasoningEcho,
} from "./reasoning-flavor.js";
import { parseStoredToolCall, responseCallsFromToolCalls } from "./tool-call-json.js";

/** Anthropic/OpenAI prompt-cache default. */
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

const COMPLETION_FAILED_STATUS = /(?:openai-compat completion failed: |\bHTTP )(\d{3})\b/;
const TRANSIENT_CODE =
  /^(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|EPROTO|UND_ERR_)/;
const TRANSIENT_TEXT =
  /fetch failed|Failed to fetch|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|Connect Timeout|Headers Timeout|other side closed|UND_ERR_|socket hang up/i;

/** Parsed SSE `data:` only. Socket bytes reset undici's body timer, including pings (`request-timeout.ts`). */
const STREAM_STALL_MS = 60_000;

/** Longest wait between attempts, whether it comes from our backoff or from the server. */
const BACKOFF_CAP_MS = 5 * 60 * 1000;

/** A 429 or 503 that named how long to wait. The message is the ordinary HTTP failure text. */
export class RetryAfterError extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
    this.name = "RetryAfterError";
  }
}

/**
 * `Retry-After` (seconds or an HTTP date) or the OpenAI-style `retry-after-ms`, read on 429 and
 * 503 only. Undefined when the response names no usable wait.
 */
export function retryAfterMs(headers: Headers, status: number, now = Date.now()): number | undefined {
  if (status !== 429 && status !== 503) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms != null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms));
  const raw = headers.get("retry-after")?.trim();
  if (raw == null || raw === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

class StreamStallError extends Error {
  constructor(ms: number) {
    super(`stream stalled after ${ms}ms`);
    this.name = "StreamStallError";
  }
}

function isTransientCompletionError(error: unknown): boolean {
  if (error instanceof StreamStallError) return false;
  if (error instanceof ConnectionMiss) return false;
  if (error instanceof ExpectationInvariant) return false;
  if (error instanceof TypeError) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(JSON_SCHEMA_UNSUPPORTED)) return false;
  const statusMatch = COMPLETION_FAILED_STATUS.exec(message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 408 || status === 429 || status >= 500;
  }
  const seen = new Set<unknown>();
  let node: unknown = error;
  for (let depth = 0; depth < 6 && node != null; depth += 1) {
    if (seen.has(node)) break;
    seen.add(node);
    if (node instanceof TypeError) return true;
    if (typeof node !== "object") {
      if (TRANSIENT_TEXT.test(String(node))) return true;
      break;
    }
    const rec = node as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      name?: unknown;
    };
    if (typeof rec.code === "string" && TRANSIENT_CODE.test(rec.code)) return true;
    if (typeof rec.message === "string" && TRANSIENT_TEXT.test(rec.message)) return true;
    if (rec.name === "TimeoutError" || rec.name === "ConnectTimeoutError" || rec.name === "HeadersTimeoutError") {
      return true;
    }
    node = rec.cause;
  }
  return message.includes("openai-compat completion failed");
}

export type ChatImagePart = {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
};

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null | readonly (ToolTextPart | ChatImagePart)[];
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ToolCall[];
  /** Prior-turn reasoning. xAI: omitting it is the top cache miss on reasoning models. */
  readonly reasoning_content?: string;
  /** OpenRouter / Groq / Together alias. Same bytes as `reasoning_content`. */
  readonly reasoning?: string;
  /** Responses `store: false` echo. Omit item `id`. `summary` is required. */
  readonly reasoning_encrypted?: string;
};

function thoughtEcho(
  thought: string,
  field: ReasoningChatField,
  echo: ReasoningEcho,
): Pick<ChatMessage, "reasoning_content" | "reasoning"> {
  if (echo === "omit-empty" && thought === "") return {};
  return field === "reasoning" ? { reasoning: thought } : { reasoning_content: thought };
}

export function chatContentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  const lines: string[] = [];
  for (const part of content) {
    if (part.type === "text") lines.push(part.text);
  }
  return lines.join("\n");
}

function wireContent(message: HistoryMessage): ChatMessage["content"] {
  const content = message.content;
  if (typeof content === "string" || content == null) return content;
  if (message.role !== "user") {
    const texts: ToolTextPart[] = [];
    for (const part of content) {
      if (part.type === "text") texts.push({ type: "text", text: part.text });
    }
    return texts;
  }
  const parts: Array<ToolTextPart | ChatImagePart> = [];
  let image = false;
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.bytes == null) continue;
    image = true;
    parts.push({
      type: "image_url",
      image_url: { url: `data:${part.mime};base64,${Buffer.from(part.bytes).toString("base64")}` },
    });
  }
  if (!image) return chatContentText(parts);
  return parts;
}

function responsesUserContent(
  content: ChatMessage["content"],
):
  | string
  | Array<
      | { readonly type: "input_text"; readonly text: string }
      | { readonly type: "input_image"; readonly image_url: string }
    > {
  if (typeof content === "string") return content;
  if (content == null) return "";
  const parts: Array<
    | { readonly type: "input_text"; readonly text: string }
    | { readonly type: "input_image"; readonly image_url: string }
  > = [];
  let image = false;
  for (const part of content) {
    if (part.type === "text") {
      if (part.text !== "") parts.push({ type: "input_text", text: part.text });
      continue;
    }
    image = true;
    parts.push({ type: "input_image", image_url: part.image_url.url });
  }
  if (!image) return chatContentText(content);
  return parts;
}

function asChat(message: HistoryMessage): ChatMessage {
  return {
    role: message.role,
    content: wireContent(message),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
  };
}

export function notificationMessagesOf(expectation: CompletionExpectation): ChatMessage[] {
  return contextNotifications(expectation).map(asChat);
}

export function approvalNoteMessagesOf(expectation: CompletionExpectation): ChatMessage[] {
  return contextApprovalNotes(expectation).map(asChat);
}

export function steerMessagesOf(expectation: CompletionExpectation): ChatMessage[] {
  return contextSteers(expectation).map(asChat);
}

function toOpenAiTool(tool: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}): OpenAiTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Catalog tools for this completion's wire. Frozen turn set wins so MCP churn cannot rewrite the prefix. */
export function toolsFor(expectation: CompletionExpectation): readonly OpenAiTool[] {
  const root = expectation.plexus?.root;
  const live = completionCatalogOf(root);
  const tools = selectCompletionTools(expectation, live);
  const turn = owningTurn(expectation);
  if (live == null || (turn != null && turn.tools.entries.length > 0)) {
    return tools.map(toOpenAiTool);
  }
  return tools.map((tool) => {
    const description = liveToolDescriptionOf(root, tool.name, live);
    return description === undefined ? toOpenAiTool(tool) : toOpenAiTool({ ...tool, description });
  });
}

/** vLLM-family hosts (Atria) 400 `tools: []`. OpenAI treats the key as optional; absence is "no tools". */
function wireTools<T>(tools: readonly T[]): { readonly tools: readonly T[] } | undefined {
  return tools.length === 0 ? undefined : { tools };
}

/** Hashes already reported missing: every round projects again, and the head fallback is the same each time. */
const missingBlobsReported = new Set<string>();

/**
 * The blob reader the projection gets. A body the document stores beside itself and the bucket cannot give
 * reaches the model as its head (the projection's rule); this is where the log says which hash was missing.
 */
function readBlobReported(sha256: string): Uint8Array | null {
  const bytes = readBlob(sha256);
  if (bytes === null && !missingBlobsReported.has(sha256)) {
    missingBlobsReported.add(sha256);
    fail(`blob ${sha256} is missing from the bucket: the prompt carries its head`);
  }
  return bytes;
}

export function* viewWire(
  tip: CompletionExpectation,
  options: {
    readonly dialect?: Pick<ReasoningDialect, "echo" | "chatField">;
  } = {},
): Generator<ChatMessage> {
  const echo = options.dialect?.echo ?? "omit-empty";
  const field = options.dialect?.chatField ?? "reasoning_content";
  const catalog = completionCatalogOf(tip.plexus?.root);
  const root = tip.plexus?.root;
  const sessionId = root instanceof SessionRoot ? root.sessionId : "";
  for (const message of projectHistory(tip, {
    catalog,
    echoEmptyThought: echo === "always",
    readBlob: readBlobReported,
    ...(sessionId === "" ? {} : { readVisual: (id: string) => readVisual(sessionId, id) }),
  })) {
    yield encodeChat(message, field, echo);
  }
}

function encodeChat(message: HistoryMessage, field: ReasoningChatField, echo: ReasoningEcho): ChatMessage {
  const toolCalls =
    message.toolCalls == null || message.toolCalls.length === 0
      ? undefined
      : message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.argsJson },
        }));
  const content = wireContent(message);
  return {
    role: message.role,
    // Strict providers reject `content: null` unless the message carries tool_calls.
    content: content == null && toolCalls === undefined ? "" : content,
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    ...(message.role === "assistant" ? thoughtEcho(message.thought ?? "", field, echo) : {}),
    ...(message.thoughtEncrypted == null || message.thoughtEncrypted === ""
      ? {}
      : { reasoning_encrypted: message.thoughtEncrypted }),
  };
}

export interface RoundAnswer {
  readonly content: string;
  readonly reasoning: string;
  /** `raw` = as-is CoT; `summary` = provider summary. Null = none. */
  readonly thoughtKind?: string | null;
  readonly calls: readonly ToolCall[];
  /** Provider stop reason: `stop`, `tool_calls`, `length`, `content_filter`. Absent when unreported. */
  readonly finishReason?: string;
  /** Calls the stream cut off or could not parse. Never run; the model is told to re-issue them. */
  readonly dropped?: readonly DroppedCall[];
}

export interface DroppedCall {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

/** Drop reasons that mean "the model meant to call this and the call is unusable". */
const SURFACED_DROPS = new Set(["truncated", "unparseable_args", "irreparable_args"]);

/**
 * Split whole calls from cut-off ones. A call the repair pass closed (`partial`) in a response
 * that stopped on `length` ended mid-arguments, so it is as untrustworthy as a dropped one.
 */
function settleCalls(
  calls: readonly ToolCall[],
  partial: ReadonlySet<string>,
  dropped: readonly DroppedCall[],
  finishReason: string | undefined,
): { readonly calls: ToolCall[]; readonly dropped: DroppedCall[] } {
  const whole: ToolCall[] = [];
  const cut = [...dropped];
  for (const call of calls) {
    if (finishReason === "length" && (partial.has(call.id) || !parsesAsJson(call.function.arguments))) {
      cut.push({ id: call.id, name: call.function.name, reason: "truncated" });
    } else {
      whole.push(call);
    }
  }
  return { calls: whole, dropped: cut };
}

function parsesAsJson(text: string): boolean {
  if (text.trim() === "") return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function responseCallsOf(answer: RoundAnswer): ResponseCall[] {
  return [
    ...responseCallsFromToolCalls(answer.calls),
    ...(answer.dropped ?? []).map(
      (drop) => new ResponseCall({ toolCallId: drop.id, name: drop.name, argsJson: "{}", dropReason: drop.reason }),
    ),
  ];
}

function reasoningPartText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const text = readField(part, "text");
    if (typeof text === "string") texts.push(text);
  }
  return texts.join("\n\n");
}

function visibleThought(raw: string, summary: string): { thought: string; kind: "raw" | "summary" | null } {
  if (raw !== "") return { thought: raw, kind: "raw" };
  if (summary !== "") return { thought: summary, kind: "summary" };
  return { thought: "", kind: null };
}

/**
 * Responses `incomplete` + `max_output_tokens` after a reasoning item is the
 * model spending the budget on thought and stopping before a message. Not a
 * failed generation — ReACT continues. Other incomplete reasons stay fatal.
 */
function incompleteThoughtExhausted(
  reason: unknown,
  thought: {
    readonly raw: string;
    readonly summary: string;
    readonly encrypted: string;
    readonly kind: string | null;
    readonly reasoningTokens: number | null;
  },
): boolean {
  if (reason !== "max_output_tokens") return false;
  return (
    thought.raw.trim() !== "" ||
    thought.summary.trim() !== "" ||
    thought.encrypted !== "" ||
    thought.kind != null ||
    (thought.reasoningTokens ?? 0) > 0
  );
}

const THINKING_PART_TYPES = new Set(["thinking", "reasoning", "redacted_thinking", "reasoning_text"]);

function isThinkingPart(part: object): boolean {
  const type = readField(part, "type");
  if (typeof type === "string" && THINKING_PART_TYPES.has(type)) return true;
  return readField(part, "thought") === true;
}

function partThought(part: object): string {
  for (const key of ["thinking", "text", "reasoning", "content"] as const) {
    const value = readField(part, key);
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** Speech vs a thinking content part. A thinking part is not the answer. */
function splitMessageContent(value: unknown): {
  readonly text: string;
  readonly thought: string;
  readonly sawThinking: boolean;
} {
  if (typeof value === "string") return { text: value, thought: "", sawThinking: false };
  if (!Array.isArray(value)) return { text: "", thought: "", sawThinking: false };
  const text: string[] = [];
  const thought: string[] = [];
  let sawThinking = false;
  for (const part of value) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    if (isThinkingPart(part)) {
      sawThinking = true;
      const inner = partThought(part);
      if (inner !== "") thought.push(inner);
      continue;
    }
    const spoken = readField(part, "text");
    if (typeof spoken === "string") text.push(spoken);
  }
  return { text: text.join(""), thought: thought.join("\n\n"), sawThinking };
}

function argAliasesForNormalize(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [tool, aliases] of Object.entries(ARG_ALIASES)) {
    out[tool] = { ...aliases };
  }
  return out;
}

function catalogToolDefs(
  expectation: CompletionExpectation,
): Array<{ name: string; parameters: Record<string, unknown> }> {
  return toolsFor(expectation).map((tool) => ({
    name: tool.function.name,
    parameters: tool.function.parameters,
  }));
}

/** Final non-delta `message.reasoning_content` — stream ingest only reads `delta`. */
function chunkMessageReasoning(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const choices = readField(raw, "choices");
  const first = Array.isArray(choices) ? choices[0] : undefined;
  if (typeof first !== "object" || first === null) return "";
  const message = readField(first, "message");
  if (typeof message !== "object" || message === null) return "";
  const content = readField(message, "reasoning_content");
  if (typeof content === "string" && content !== "") return content;
  const alt = readField(message, "reasoning");
  return typeof alt === "string" && alt !== "" ? alt : "";
}

export async function* readSseJson(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  stallMs: number,
): AsyncGenerator<unknown> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled: StreamStallError | undefined;
  const clearArm = (): void => {
    if (armTimer === undefined) return;
    clearTimeout(armTimer);
    armTimer = undefined;
  };
  // Armed when the body opens. A comment or ping is not progress, and neither is a socket that never sends `data:`.
  const arm = (): void => {
    clearArm();
    const timer = setTimeout(() => {
      stalled = new StreamStallError(stallMs);
      void reader.cancel(stalled).catch(() => undefined);
    }, stallMs);
    timer.unref();
    armTimer = timer;
  };
  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    try {
      const next = await reader.read();
      if (stalled !== undefined) throw stalled;
      return next;
    } catch (error) {
      if (stalled !== undefined) throw stalled;
      throw error;
    }
  };
  try {
    arm();
    while (!signal.aborted) {
      const { done, value } = await read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let yielded = false;
      for (;;) {
        const sep = buf.indexOf("\n\n");
        if (sep === -1) break;
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of event.split(/\r?\n/)) {
          const trimmed = line.trimEnd();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trimStart();
          if (!data || data === "[DONE]") {
            if (data === "[DONE]") return;
            continue;
          }
          try {
            yield parseJsonUnknown(data);
            yielded = true;
          } catch {
            // skip malformed line
          }
        }
      }
      if (yielded) arm();
    }
    if (buf.trim().length > 0) {
      for (const line of buf.split(/\r?\n/)) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trimStart();
        if (!data || data === "[DONE]") continue;
        try {
          yield parseJsonUnknown(data);
        } catch {
          /* skip */
        }
      }
    }
  } finally {
    clearArm();
    try {
      reader.releaseLock();
    } catch {
      /* cancel already dropped the lock */
    }
  }
}

export abstract class OpenAiCompatActor extends ExpectationActor<CompletionExpectation> {
  #startedAt = 0;
  #backoffAbort: AbortController | undefined;
  #requestDump: unknown = null;
  #lastRaw: unknown = null;
  #answerDump: { content: string; reasoning: string; calls: number } | null = null;

  /** Same formula as LicenseScope.backoffMs. Tests override. */
  backoffMs = function (n: number): number {
    return Math.min(BACKOFF_CAP_MS, Math.max(1000, n * Math.log(n) * 1000));
  };

  stallMs = STREAM_STALL_MS;

  #spokenText = "";
  #spokenThought = "";

  constructor(
    expectation: CompletionExpectation,
    override readonly driverConnection: OpenAiCompatDriverConnection,
  ) {
    super(expectation, driverConnection);
  }

  protected abstract completionBody(messages: readonly ChatMessage[]): Record<string, unknown>;
  protected abstract readAnswer(response: Response, signal: AbortSignal): Promise<RoundAnswer | null>;

  protected reasoningDialect(): ReasoningDialect {
    return reasoningDialectFor(this.driverConnection.reasoningFlavor(), this.expectation.reasoningEffort, {
      api: this.driverConnection.completionApi(),
      model: this.effectiveModel(),
      hasTools: toolsFor(this.expectation).length > 0,
    });
  }

  /** Abort the inter-attempt sleep. No-op if not sleeping. Does not fail the PEW. */
  skipBackoff(): void {
    this.#backoffAbort?.abort();
  }

  protected async run() {
    ConnectionNotReady.invariant(this.driverConnection.alive, this.driverConnection.connectionId);

    if (this.signal.aborted) return;

    const abort = new AbortController();
    this.driverConnection.trackInflight(abort);
    const onActorAbort = (): void => {
      abort.abort();
    };
    if (this.signal.aborted) {
      abort.abort();
    } else {
      this.signal.addEventListener("abort", onActorAbort, { once: true });
    }
    const limit = this.driverConnection.state.windows[this.effectiveModel()] ?? 0;
    if (limit > 0) {
      runInAction(() => {
        this.expectation.contextLimit = limit;
      });
    }

    const runStarted = Date.now();
    let retryAfter: number | undefined;
    try {
      for (let n = 0; ; n += 1) {
        if (n > 0) {
          await this.#sleepBackoff(n, retryAfter);
          if (this.signal.aborted) return;
        }
        this.#beginAttempt();
        try {
          const turn = owningTurn(this.expectation);
          let turnIndex = 1;
          if (turn !== null) {
            let hops = 0;
            let cell: SessionTurn | null = turn;
            const seen = new Set<SessionTurn>();
            while (cell != null && !seen.has(cell)) {
              seen.add(cell);
              hops += 1;
              cell = cell.turnTail instanceof SessionTurn ? cell.turnTail : null;
            }
            turnIndex = Math.max(1, hops);
          }
          const affinity = this.driverConnection.cacheAffinity(this.cacheSessionId(), this.effectiveModel(), {
            requestId: randomUUID(),
            turnIndex,
          });
          const payload = {
            ...this.completionBody([
              ...viewWire(this.expectation, {
                dialect: this.reasoningDialect(),
              }),
            ]),
            ...affinity.body,
          };
          const headers = this.driverConnection.stamp(affinity.headers);
          const url = this.driverConnection.completionRequestUrl();
          this.#requestDump = {
            url,
            headers: redactCacheHeaders(headers),
            body: payload,
          };
          let response: Response;
          const posted = Date.now();
          trace(
            "harness:complete",
            `post ${this.expectation.uuid} connection=${this.driverConnection.connectionId} model=${this.effectiveModel()} attempt=${n}`,
          );
          try {
            response = await this.driverConnection.authorizedFetch(
              url,
              {
                method: "POST",
                headers: affinity.headers,
                body: JSON.stringify(payload),
              },
              abort.signal,
            );
          } catch (error) {
            if (error instanceof ConnectionMiss) throw error;
            throw wrapFetchFailure(error, {
              why: "completion",
              method: "POST",
              url,
            });
          }

          if (!response.ok) {
            const errorBody = await response.text();
            const detail = errorBody.trim().slice(0, 240);
            const message = describeHttpFailure({
              why: "completion",
              method: "POST",
              url,
              status: response.status,
              detail,
            });
            const waitMs = retryAfterMs(response.headers, response.status);
            if (waitMs !== undefined) throw new RetryAfterError(message, waitMs);
            const transientHttp = response.status === 408 || response.status === 429 || response.status >= 500;
            const schema = this.expectation.responseSchema;
            const schemaSent = schema != null;
            if (!transientHttp && schemaSent && response.status >= 400 && response.status < 500) {
              throw new Error(`${JSON_SCHEMA_UNSUPPORTED}: ${message}`);
            }
            throw new Error(message);
          }

          const answer = await this.readAnswer(response, abort.signal);
          trace(
            "harness:complete",
            `answer ${this.expectation.uuid} ms=${Date.now() - posted} status=${response.status} chars=${answer?.content.length ?? 0}`,
          );
          invariant(answer !== null, "openai-compat completion failed");
          this.expectation.stampAnswer({
            calls: responseCallsOf(answer),
            ...(answer.finishReason === undefined ? {} : { finishReason: answer.finishReason }),
            text: answer.content,
            ...(typeof answer.reasoning === "string" ? { thought: answer.reasoning } : {}),
            ...(typeof answer.thoughtKind === "string" ? { thoughtKind: answer.thoughtKind } : {}),
          });
          this.#answerDump = {
            content: answer.content,
            reasoning: answer.reasoning,
            calls: answer.calls.length,
          };
          this.#stampWarm();
          this.#noteCacheInvariant();
          this.speech(answer.content, answer.reasoning);
          const schema = this.expectation.responseSchema;
          if (schema != null) assertResponseMatchesSchema(answer.content, JSON.stringify(schema));
          if (this.signal.aborted) return;
          this.complete({
            text: answer.content,
            thought: answer.reasoning,
            ...(answer.thoughtKind != null ? { thoughtKind: answer.thoughtKind } : {}),
          });
          return;
        } catch (error) {
          if (this.signal.aborted) return;
          if (error instanceof ExpectationInvariant) throw error;
          if (!isTransientCompletionError(error)) {
            const reason = error instanceof Error ? error.message : String(error);
            this.expectation.failReason = reason;
            runInAction(() => {
              if (this.#spokenText !== "" || this.#spokenThought !== "") {
                this.expectation.responseText = this.#spokenText;
                this.expectation.responseThought = this.#spokenThought;
              }
              this.expectation.markThoughtEnded();
            });
            this.fail(reason);
            return;
          }
          const reason = error instanceof Error ? error.message : String(error);
          const exhausted = this.#retryExhausted(n + 1, runStarted);
          if (exhausted !== "") {
            const final = `${exhausted}: ${reason}`;
            this.expectation.failReason = final;
            runInAction(() => {
              if (this.#spokenText !== "" || this.#spokenThought !== "") {
                this.expectation.responseText = this.#spokenText;
                this.expectation.responseThought = this.#spokenThought;
              }
              this.expectation.markThoughtEnded();
            });
            this.fail(final);
            return;
          }
          retryAfter = error instanceof RetryAfterError ? error.waitMs : undefined;
          step(`completion retry ${n + 1}: ${reason}`);
        }
      }
    } finally {
      this.signal.removeEventListener("abort", onActorAbort);
      this.driverConnection.untrackInflight(abort);
      this.#backoffAbort?.abort();
      this.#backoffAbort = undefined;
    }
  }

  #beginAttempt(): void {
    this.#startedAt = Date.now();
    this.#requestDump = null;
    this.#lastRaw = null;
    this.#answerDump = null;
    this.#spokenText = "";
    this.#spokenThought = "";
    this.expectation.beginAttempt(
      this.driverConnection.cacheFlavor() !== "none" && this.expectation.expectPromptCacheHit(),
    );
    this.report({
      text: "",
      thought: "",
      startedAt: this.#startedAt,
      cacheHit: this.expectation.cacheHit,
      expectedCacheHit: this.expectation.expectedCacheHit,
    });
  }

  /**
   * Empty while the round may retry. The budget is recorded on the expectation when the round
   * starts; zero is no limit, which is the default.
   */
  #retryExhausted(attempts: number, startedAt: number): string {
    const { retryMaxAttempts: maxAttempts, retryMaxMs: maxMs } = this.expectation;
    if (maxAttempts > 0 && attempts >= maxAttempts) return `gave up after ${attempts} attempts`;
    if (maxMs > 0 && Date.now() - startedAt >= maxMs)
      return `gave up after ${Math.round((Date.now() - startedAt) / 1000)}s of retrying`;
    return "";
  }

  #sleepBackoff(n: number, retryAfter?: number): Promise<void> {
    // Retry-After is a floor on the wait. The cap still bounds it.
    const delay = Math.max(this.backoffMs(n), Math.min(retryAfter ?? 0, BACKOFF_CAP_MS));
    if (delay <= 0) return Promise.resolve();
    const backoff = new AbortController();
    this.#backoffAbort = backoff;
    const retryUntilMs = Date.now() + delay;
    this.report({
      text: "",
      thought: "",
      startedAt: this.#startedAt,
      retryUntilMs,
    });
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        backoff.signal.removeEventListener("abort", finish);
        this.signal.removeEventListener("abort", finish);
        if (this.#backoffAbort === backoff) this.#backoffAbort = undefined;
        resolve();
      };
      if (backoff.signal.aborted || this.signal.aborted) {
        finish();
        return;
      }
      timer = setTimeout(finish, delay);
      backoff.signal.addEventListener("abort", finish, { once: true });
      this.signal.addEventListener("abort", finish, { once: true });
    });
  }

  protected speech(text: string, thought: string): void {
    if (this.signal.aborted) return;
    if (text.length === 0 && thought.length === 0) return;
    this.#spokenText = text;
    this.#spokenThought = thought;
    if (text.trim() !== "") {
      runInAction(() => {
        this.expectation.markThoughtEnded();
      });
    }
    this.report({
      text,
      thought,
      thoughtKind: this.expectation.responseThoughtKind ?? undefined,
      startedAt: this.#startedAt,
      cacheHit: this.expectation.cacheHit,
      expectedCacheHit: this.expectation.expectedCacheHit,
    });
  }

  protected stampThoughtKind(kind: "raw" | "summary" | null): void {
    if (kind == null) return;
    const current = this.expectation.responseThoughtKind;
    if (current === "raw" || current === kind) return;
    runInAction(() => {
      this.expectation.responseThoughtKind = kind;
    });
  }

  #noteCacheInvariant(): void {
    const last = this.expectation.report;
    this.report({
      text: last?.text ?? "",
      thought: last?.thought ?? "",
      thoughtKind: last?.thoughtKind ?? this.expectation.responseThoughtKind ?? undefined,
      startedAt: this.#startedAt,
      cacheHit: this.expectation.cacheHit,
      expectedCacheHit: this.expectation.expectedCacheHit,
    });
    const dumped = this.#dumpCacheRound();
    const note = cacheStatusLog(this.expectation);
    step(dumped == null ? `completion ${note}` : `completion ${note} dumped ${dumped}`);
  }

  #dumpCacheRound(): string | null {
    const root = this.expectation.plexus?.root;
    const workspacePath = root instanceof SessionRoot ? root.path : "";
    return writeCacheDump({
      workspacePath,
      sessionId: this.cacheSessionId(),
      startedAt: this.#startedAt,
      kind: cacheDumpKind(this.expectation.expectedCacheHit, this.expectation.cacheHit),
      expectedCacheHit: this.expectation.expectedCacheHit,
      cacheHit: this.expectation.cacheHit,
      cachedTokens: this.expectation.cachedTokens,
      totalTokens: this.expectation.totalTokens,
      request: this.#requestDump,
      response: this.#lastRaw,
      answer: this.#answerDump ?? undefined,
    });
  }

  /**
   * Live-tape ReACT keeps the session id. Remainder / compact / other
   * off-spine PEWs share `${session}:off-spine` so they cluster with each
   * other and do not occupy the tape replica — a different prefix on the
   * same `x-grok-conv-id` evicts the tape KV (xAI cache is per-server).
   */
  protected cacheSessionId(): string {
    const root = this.expectation.plexus?.root;
    const sessionId = root instanceof SessionRoot ? root.sessionId.trim() : "";
    const base = sessionId === "" ? this.driverConnection.connectionId : sessionId;
    if (owningTurn(this.expectation) != null) return base;
    return `${base}:off-spine`;
  }

  protected effectiveModel(): string {
    const turn = this.expectation.model.trim();
    if (turn) return turn;
    const configured = (this.driverConnection.settings.model ?? "").trim();
    if (configured) return configured;
    const live = this.driverConnection.state.models.find((id) => id.trim() !== "")?.trim();
    invariant(live, "openai-compat model is required");
    return live;
  }

  protected jsonSchema(): unknown | undefined {
    return this.expectation.responseSchema ?? undefined;
  }

  protected stampConsumed(raw: unknown): void {
    const ledger = usageLedger(raw);
    this.#lastRaw = preferCacheResponse(this.#lastRaw, raw);
    runInAction(() => {
      if (ledger.totalTokens != null) this.expectation.totalTokens = ledger.totalTokens;
      if (ledger.cachedTokens != null) {
        this.expectation.cachedTokens = ledger.cachedTokens;
        this.expectation.cacheHit = ledger.cachedTokens > 0;
      }
      if (ledger.inputTokens != null) this.expectation.inputTokens = ledger.inputTokens;
      if (ledger.outputTokens != null) this.expectation.outputTokens = ledger.outputTokens;
      if (ledger.cacheWriteTokens != null) this.expectation.cacheWriteTokens = ledger.cacheWriteTokens;
      if (ledger.reasoningTokens != null) this.expectation.reasoningTokens = ledger.reasoningTokens;
      if (ledger.costUsd != null) this.expectation.costUsd = ledger.costUsd;
    });
  }

  #stampWarm(): void {
    runInAction(() => {
      this.expectation.warmUntil = new Date(Date.now() + PROMPT_CACHE_TTL_MS);
    });
  }
}

export class OpenAiCompatChatActor extends OpenAiCompatActor {
  /** Anthropic `cache_control` breakpoints, where the route takes them and the connection allows. */
  protected cacheMarked(messages: readonly ChatMessage[], model: string): readonly ChatMessage[] {
    const settings = this.driverConnection.settings;
    if (!emitsCacheControl(settings, this.driverConnection.cacheFlavor(), model)) return messages;
    const turn = owningTurn(this.expectation);
    const card = turn == null ? null : latestCompactCutoff(turn);
    return withCacheBreakpoints(messages, card?.job.standIn ?? "", settings.cacheControlTtl ?? "5m");
  }

  protected completionBody(messages: readonly ChatMessage[]): Record<string, unknown> {
    const schema = this.jsonSchema();
    const model = this.effectiveModel();
    const openaiExplicit = this.driverConnection.cacheFlavor() === "openai" && usesExplicitPromptCache(model);
    const first = messages[0];
    // GPT-5.6+ implicit mode writes through the latest eligible message. An explicit
    // breakpoint on the stable system head lets a later env/mode rewrite still reuse
    // constitution+tools. `instructions` cannot hold a breakpoint — Chat Completions
    // system parts can.
    // https://developers.openai.com/api/docs/guides/prompt-caching
    const stamped =
      openaiExplicit && first != null && first.role === "system" && typeof first.content === "string"
        ? [
            {
              ...first,
              content: [
                {
                  type: "text",
                  text: first.content,
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
            },
            ...messages.slice(1),
          ]
        : messages;
    return {
      model,
      messages: this.cacheMarked(stamped as readonly ChatMessage[], model),
      stream: true,
      stream_options: { include_usage: true },
      temperature: this.driverConnection.settings.temperature,
      ...wireTools(toolsFor(this.expectation)),
      ...this.reasoningDialect().body,
      ...(schema === undefined
        ? {}
        : {
            response_format: {
              type: "json_schema",
              json_schema: { name: "Output", schema, strict: true },
            },
          }),
    };
  }

  protected async readAnswer(response: Response, signal: AbortSignal): Promise<RoundAnswer | null> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      return this.#roundFromBulk(await response.json());
    }
    if (contentType.includes("text/event-stream") || contentType.includes("event-stream")) {
      return this.#consumeStream(readSseJson(response.body, signal, this.stallMs));
    }
    const text = await response.text();
    const head = text.trimStart();
    if (head.startsWith("{") || head.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        return this.#roundFromBulk(parsed);
      } catch {
        return null;
      }
    }
    return this.#consumeStream(
      readSseJson(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
        signal,
        this.stallMs,
      ),
    );
  }

  #roundFromBulk(payload: unknown): RoundAnswer {
    this.stampConsumed(payload);
    const choices = typeof payload === "object" && payload !== null ? readField(payload, "choices") : undefined;
    const choice =
      Array.isArray(choices) && typeof choices[0] === "object" && choices[0] !== null ? choices[0] : undefined;
    const message = choice == null ? undefined : readField(choice, "message");
    const messageRec = typeof message === "object" && message !== null ? message : undefined;
    const reasoningContent = messageRec == null ? undefined : readField(messageRec, "reasoning_content");
    const reasoningAlt = messageRec == null ? undefined : readField(messageRec, "reasoning");
    const reasoning =
      typeof reasoningContent === "string" && reasoningContent.length > 0
        ? reasoningContent
        : typeof reasoningAlt === "string" && reasoningAlt.length > 0
          ? reasoningAlt
          : "";
    const content = messageRec == null ? undefined : readField(messageRec, "content");
    const spoken = splitMessageContent(content);
    const toolCalls = messageRec == null ? undefined : readField(messageRec, "tool_calls");
    const finishReason = choice == null ? undefined : readField(choice, "finish_reason");
    const normalized = normalizeMessage(
      {
        content: spoken.text,
        tool_calls: Array.isArray(toolCalls)
          ? toolCalls.flatMap((item) => {
              const call = parseStoredToolCall(item);
              return call == null ? [] : [call];
            })
          : null,
        reasoning_content: mergeReasoning(reasoning || null, spoken.thought),
      },
      {
        mode: "repair",
        tools: catalogToolDefs(this.expectation),
        argAliases: argAliasesForNormalize(),
        modelHint: this.effectiveModel(),
        finishReasonIn: typeof finishReason === "string" ? finishReason : null,
      },
    );
    const reasoningText = normalized.reasoning_content ?? "";
    const thoughtKind = reasoningText !== "" || spoken.sawThinking ? "raw" : null;
    this.stampThoughtKind(thoughtKind);
    const answer: RoundAnswer = {
      content: normalized.content ?? "",
      reasoning: reasoningText,
      thoughtKind,
      calls: normalized.tool_calls,
      finishReason: normalized.finish_reason ?? undefined,
      dropped: normalized.meta.dropped
        .filter((drop) => SURFACED_DROPS.has(drop.reason) && drop.name !== "")
        .map((drop, index) => ({ id: `dropped_${index}`, name: drop.name, reason: drop.reason })),
    };
    this.speech(answer.content, answer.reasoning);
    return answer;
  }

  async #consumeStream(chunks: AsyncIterable<unknown>): Promise<RoundAnswer> {
    const session = createStreamSession({
      mode: "repair",
      tools: catalogToolDefs(this.expectation),
      argAliases: argAliasesForNormalize(),
      modelHint: this.effectiveModel(),
    });

    let thoughtAcc = "";
    let textAcc = "";
    let sawThinking = false;
    const calls: ToolCall[] = [];
    const partial = new Set<string>();
    const dropped: DroppedCall[] = [];
    let finishReason: string | undefined;

    const onEvent = (ev: {
      type: string;
      text?: string;
      name?: string | null;
      reason?: string;
      id?: string;
      arguments?: string;
      partial?: boolean;
      finish_reason?: string;
    }): void => {
      switch (ev.type) {
        case "reasoning_delta": {
          if (!ev.text) break;
          if (thoughtAcc === "" && textAcc === "") {
            trace("harness:complete", `first-token ${this.expectation.uuid} kind=thought`);
          }
          thoughtAcc += ev.text;
          this.stampThoughtKind("raw");
          this.speech(textAcc, thoughtAcc);
          break;
        }
        case "text_delta": {
          if (!ev.text) break;
          if (textAcc === "" && thoughtAcc === "") {
            trace("harness:complete", `first-token ${this.expectation.uuid} kind=text`);
          }
          textAcc += ev.text;
          this.speech(textAcc, thoughtAcc);
          break;
        }
        case "tool_call_end": {
          if (!ev.name || ev.arguments == null || !ev.id) break;
          if (ev.partial === true) partial.add(ev.id);
          calls.push({
            id: ev.id,
            type: "function",
            function: { name: ev.name, arguments: ev.arguments },
          });
          break;
        }
        case "tool_call_drop": {
          if (ev.id && ev.name && ev.reason !== undefined && SURFACED_DROPS.has(ev.reason)) {
            dropped.push({ id: ev.id, name: ev.name, reason: ev.reason });
          }
          break;
        }
        case "finish": {
          if (ev.finish_reason !== undefined) finishReason = ev.finish_reason;
          break;
        }
        default:
          break;
      }
    };

    for await (const raw of chunks) {
      this.stampConsumed(raw);
      if (typeof raw === "object" && raw !== null) {
        const rec = raw as OpenAiChatChunk;
        const choice = rec.choices?.[0];
        const delta = choice?.delta;
        let chunk = rec;
        if (delta != null) {
          const altRaw = readField(delta, "reasoning");
          const alt = typeof altRaw === "string" ? altRaw : "";
          const rawContent = readField(delta, "content");
          const parts = Array.isArray(rawContent) ? splitMessageContent(rawContent) : null;
          if (parts?.sawThinking === true) sawThinking = true;
          const hasReasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;
          const reasoning = hasReasoning
            ? `${delta.reasoning_content}${parts?.thought ?? ""}`
            : `${alt}${parts?.thought ?? ""}`;
          if (parts != null || (alt.length > 0 && !hasReasoning)) {
            chunk = {
              ...rec,
              choices: [
                {
                  ...choice,
                  delta: {
                    ...delta,
                    ...(parts == null ? {} : { content: parts.text }),
                    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
                  },
                },
                ...(rec.choices?.slice(1) ?? []),
              ],
            };
          }
        }
        for (const ev of session.ingest(chunk)) onEvent(ev);
      }
      if (thoughtAcc === "") thoughtAcc = chunkMessageReasoning(raw);
    }
    for (const ev of session.close()) onEvent(ev);

    const settled = settleCalls(calls, partial, dropped, finishReason);
    return {
      content: textAcc,
      reasoning: thoughtAcc,
      thoughtKind: thoughtAcc !== "" || sawThinking ? "raw" : null,
      calls: settled.calls,
      dropped: settled.dropped,
      ...(finishReason === undefined ? {} : { finishReason }),
    };
  }
}

export class OpenAiCompatResponsesActor extends OpenAiCompatActor {
  protected completionBody(messages: readonly ChatMessage[]): Record<string, unknown> {
    const schema = this.jsonSchema();
    const isolated = this.expectation.completionMode === "isolated";
    const firstSystem = messages.find((message) => message.role === "system");
    const dialect = this.reasoningDialect();
    const reasoning = dialect.body.reasoning;
    const input: unknown[] = [];
    if (isolated) {
      for (const { role, content } of messages) input.push({ role, content });
    } else {
      let skippedFirstSystem = false;
      for (const message of messages) {
        if (message.role === "system") {
          if (!skippedFirstSystem) {
            skippedFirstSystem = true;
            continue;
          }
          input.push({
            role: "developer",
            content: chatContentText(message.content),
          });
          continue;
        }
        if (message.role === "tool") {
          input.push({
            type: "function_call_output",
            call_id: message.tool_call_id,
            output: chatContentText(message.content),
          });
          continue;
        }
        if (message.role === "assistant") {
          const encrypted = message.reasoning_encrypted?.trim() ?? "";
          const thought = (message.reasoning_content ?? message.reasoning ?? "").trim();
          if (encrypted !== "") {
            input.push({
              type: "reasoning",
              // Codex 400s without this key. Empty is valid; thought becomes summary_text.
              summary: thought === "" ? [] : [{ type: "summary_text", text: thought }],
              encrypted_content: encrypted,
            });
          }
          const calls = message.tool_calls ?? [];
          const text = chatContentText(message.content);
          if (text !== "") {
            input.push({ role: "assistant", content: text });
          } else if (calls.length === 0 && encrypted === "") {
            input.push({ role: "assistant", content: "" });
          }
          for (const call of calls) {
            input.push({
              type: "function_call",
              call_id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            });
          }
          continue;
        }
        input.push({ role: "user", content: responsesUserContent(message.content) });
      }
    }
    return {
      model: this.effectiveModel(),
      instructions: isolated ? "" : typeof firstSystem?.content === "string" ? firstSystem.content : undefined,
      input,
      ...wireTools(
        toolsFor(this.expectation).map((tool) => ({
          type: "function" as const,
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      ),
      stream: true,
      // ChatGPT Codex 400s store:true. Encrypted reasoning is echoed instead.
      store: false,
      include: ["reasoning.encrypted_content"],
      // Visible thought is the summary, not the encrypted CoT. Codex CLI sends this.
      reasoning:
        typeof reasoning === "object" && reasoning !== null ? { summary: "auto", ...reasoning } : { summary: "auto" },
      // Responses structured output is text.format, not response_format.
      ...(schema === undefined
        ? {}
        : {
            text: {
              format: {
                type: "json_schema",
                name: "Output",
                strict: true,
                schema,
              },
            },
          }),
    };
  }

  protected async readAnswer(response: Response, signal: AbortSignal): Promise<RoundAnswer | null> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json") && !contentType.toLowerCase().includes("event-stream")) {
      const payload: unknown = await response.json();
      this.stampConsumed(payload);
      const parts: string[] = [];
      const rawParts: string[] = [];
      const summaryParts: string[] = [];
      const calls: ToolCall[] = [];
      let encrypted = "";
      let sawReasoning = false;
      const collectItem = (item: unknown): void => {
        if (typeof item !== "object" || item === null) return;
        const type = readField(item, "type");
        const callId = readField(item, "call_id");
        const name = readField(item, "name");
        const args = readField(item, "arguments");
        if (
          type === "function_call" &&
          typeof callId === "string" &&
          typeof name === "string" &&
          typeof args === "string"
        ) {
          calls.push({
            id: callId,
            type: "function",
            function: { name, arguments: args },
          });
          return;
        }
        if (type === "reasoning") {
          sawReasoning = true;
          const encryptedContent = readField(item, "encrypted_content");
          if (typeof encryptedContent === "string" && encryptedContent !== "") {
            encrypted = encryptedContent;
          }
          const raw = reasoningPartText(readField(item, "content"));
          const summary = reasoningPartText(readField(item, "summary"));
          if (raw !== "") rawParts.push(raw);
          if (summary !== "") summaryParts.push(summary);
        }
        const content = readField(item, "content");
        if (type === "message" && Array.isArray(content)) {
          for (const part of content) {
            if (typeof part !== "object" || part === null) continue;
            const text = readField(part, "text");
            if (readField(part, "type") === "output_text" && typeof text === "string") parts.push(text);
          }
        }
      };
      const output = typeof payload === "object" && payload !== null ? readField(payload, "output") : undefined;
      if (Array.isArray(output)) {
        for (const item of output) collectItem(item);
      }
      const text = parts.join("");
      const visible = visibleThought(rawParts.join("\n\n"), summaryParts.join("\n\n"));
      const thoughtKind = visible.kind ?? (sawReasoning || encrypted !== "" ? "raw" : null);
      this.#stampReasoningEncrypted(encrypted);
      this.stampThoughtKind(thoughtKind);
      this.speech(text, visible.thought);
      return { content: text, reasoning: visible.thought, thoughtKind, calls };
    }
    let acc: {
      text: string;
      raw: string;
      summary: string;
      lastSummaryPart: string | null;
    } = {
      text: "",
      raw: "",
      summary: "",
      lastSummaryPart: null,
    };
    const calls: ToolCall[] = [];
    let encrypted = "";
    let sawTerminal = false;
    let finish: string | undefined;
    const partial = new Set<string>();
    const emitSpeech = (): void => {
      const visible = visibleThought(acc.raw, acc.summary);
      this.stampThoughtKind(visible.kind);
      this.speech(acc.text, visible.thought);
    };
    for await (const raw of readSseJson(response.body, signal, this.stallMs)) {
      this.stampConsumed(raw);
      if (typeof raw !== "object" || raw === null) continue;
      const type = readField(raw, "type");
      const delta = readField(raw, "delta");
      switch (type) {
        case "error":
        case "response.failed": {
          const eventError = readField(raw, "error");
          const eventResponse = readField(raw, "response");
          const responseError =
            typeof eventResponse === "object" && eventResponse !== null ? readField(eventResponse, "error") : undefined;
          const eventMessage =
            typeof eventError === "object" && eventError !== null ? readField(eventError, "message") : undefined;
          const nestedMessage =
            typeof responseError === "object" && responseError !== null
              ? readField(responseError, "message")
              : undefined;
          const detail = eventMessage ?? nestedMessage;
          throw new Error(typeof detail === "string" ? detail : `Responses stream failed: ${String(type)}`);
        }
        case "response.completed":
        case "response.done": {
          sawTerminal = true;

          break;
        }
        case "response.incomplete": {
          const eventResponse = readField(raw, "response");
          const incomplete =
            typeof eventResponse === "object" && eventResponse !== null
              ? readField(eventResponse, "incomplete_details")
              : undefined;
          const details =
            typeof incomplete === "object" && incomplete !== null ? readField(incomplete, "reason") : undefined;
          const nestedOutput =
            typeof eventResponse === "object" && eventResponse !== null
              ? readField(eventResponse, "output")
              : undefined;
          if (Array.isArray(nestedOutput)) {
            for (const item of nestedOutput) {
              if (typeof item !== "object" || item === null) continue;
              const itemType = readField(item, "type");
              const callId = readField(item, "call_id");
              const name = readField(item, "name");
              const args = readField(item, "arguments");
              if (
                itemType === "function_call" &&
                typeof callId === "string" &&
                typeof name === "string" &&
                typeof args === "string" &&
                !calls.some((call) => call.id === callId)
              ) {
                partial.add(callId);
                calls.push({
                  id: callId,
                  type: "function",
                  function: { name, arguments: args },
                });
                continue;
              }
              if (itemType === "reasoning") {
                const encryptedContent = readField(item, "encrypted_content");
                if (encrypted === "" && typeof encryptedContent === "string" && encryptedContent !== "") {
                  encrypted = encryptedContent;
                }
                const thoughtRaw = reasoningPartText(readField(item, "content"));
                const summary = reasoningPartText(readField(item, "summary"));
                if (acc.raw === "" && thoughtRaw !== "") acc = { ...acc, raw: thoughtRaw };
                if (acc.summary === "" && summary !== "") acc = { ...acc, summary };
                this.stampThoughtKind("raw");
                continue;
              }
              if (itemType === "message" && acc.text === "") {
                const content = readField(item, "content");
                if (!Array.isArray(content)) continue;
                const texts: string[] = [];
                for (const part of content) {
                  if (typeof part !== "object" || part === null) continue;
                  const text = readField(part, "text");
                  if (readField(part, "type") === "output_text" && typeof text === "string") texts.push(text);
                }
                if (texts.length > 0) acc = { ...acc, text: texts.join("") };
              }
            }
          }
          if (
            incompleteThoughtExhausted(details, {
              raw: acc.raw,
              summary: acc.summary,
              encrypted,
              kind: this.expectation.responseThoughtKind,
              reasoningTokens: this.expectation.reasoningTokens,
            })
          ) {
            sawTerminal = true;
            finish = "length";
            break;
          }
          // Speech cut off by max_output_tokens stays a failed round (chatgpt-complete.test); only
          // the filter is a stop of its own.
          if (details === "content_filter") {
            sawTerminal = true;
            finish = "content_filter";
            break;
          }
          throw new Error(`Responses stream incomplete${typeof details === "string" ? `: ${details}` : ""}`);
        }
        case "response.output_item.done": {
          const item = readField(raw, "item");
          if (typeof item === "object" && item !== null) {
            const itemType = readField(item, "type");
            const callId = readField(item, "call_id");
            const name = readField(item, "name");
            const args = readField(item, "arguments");
            const encryptedContent = readField(item, "encrypted_content");
            if (
              itemType === "function_call" &&
              typeof callId === "string" &&
              typeof name === "string" &&
              typeof args === "string"
            ) {
              calls.push({
                id: callId,
                type: "function",
                function: { name, arguments: args },
              });
            } else if (itemType === "reasoning") {
              if (typeof encryptedContent === "string" && encryptedContent !== "") {
                encrypted = encryptedContent;
              }
              this.stampThoughtKind("raw");
            }
          }

          break;
        }
        default:
          if (type === "response.output_text.delta" && typeof delta === "string") {
            acc = { ...acc, text: acc.text + delta };
            emitSpeech();
          } else if (type === "response.reasoning_summary_text.delta" && typeof delta === "string") {
            const indexRaw = readField(raw, "summary_index");
            const itemIdRaw = readField(raw, "item_id");
            const index = typeof indexRaw === "number" ? indexRaw : 0;
            const itemId = typeof itemIdRaw === "string" ? itemIdRaw : "";
            const partKey = `${itemId}:${index}`;
            const gap =
              acc.lastSummaryPart !== null && partKey !== acc.lastSummaryPart && acc.summary !== "" ? "\n\n" : "";
            acc = {
              ...acc,
              summary: acc.summary + gap + delta,
              lastSummaryPart: partKey,
            };
            emitSpeech();
          } else if (type === "response.reasoning_text.delta" && typeof delta === "string") {
            acc = { ...acc, raw: acc.raw + delta };
            emitSpeech();
          }
      }
    }
    if (!sawTerminal) throw new Error("Responses stream ended before terminal response event");
    this.#stampReasoningEncrypted(encrypted);
    const visible = visibleThought(acc.raw, acc.summary);
    const thoughtKind =
      visible.kind ?? (encrypted !== "" || this.expectation.responseThoughtKind != null ? "raw" : null);
    const settled = settleCalls(calls, partial, [], finish);
    return {
      content: acc.text,
      reasoning: visible.thought,
      thoughtKind,
      calls: settled.calls,
      dropped: settled.dropped,
      finishReason: finish ?? (calls.length > 0 ? "tool_calls" : "stop"),
    };
  }

  #stampReasoningEncrypted(encrypted: string): void {
    if (encrypted === "") return;
    runInAction(() => {
      this.expectation.responseReasoningEncrypted = encrypted;
    });
  }
}
