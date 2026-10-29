import { syncing } from "@here.build/plexus";
import { prompt, asUserPrompt, type SystemPrompt, type UserPrompt } from "@inhuman.tools/harness-commons";
import { WorkExpectation } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { PromptMessage } from "./PromptMessage.js";
import { assertResponseMatchesSchema } from "./response-schema.js";
import { ResponseCall } from "./ResponseCall.js";
import { serializingInto } from "../../json-record.js";
import type { ReasoningEffort } from "../../reasoning-effort.js";
import { parseStoredBlob, type StoredText } from "../blob-ref.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { CompletionJob, tapeCompletion } from "../jobs/CompletionJob.js";
import type { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { tapeTurn } from "../jobs/tape-continuation.js";
import type { ToolCallJob } from "../jobs/ToolCallJob.js";
import type { TurnApprovalNoteChunk } from "../turn/approval-note-chunk.js";
import type { TurnNotificationChunk } from "../turn/notification-chunk.js";
import { reactChunks, SessionTurn } from "../turn/session-turn.js";
import type { TurnSteerChunk } from "../turn/steer-chunk.js";

export type CompletionResult = {
  readonly text: string;
  readonly thought?: string;
  /** `summary` when the provider sent a reasoning summary instead of CoT. */
  readonly thoughtKind?: string;
};

export type CompletionReport = {
  readonly text?: string;
  readonly thought?: string;
  readonly thoughtKind?: string;
  readonly startedAt?: number;
  /** Epoch ms. Omit when not waiting. */
  readonly retryUntilMs?: number;
  /** Prefix-cache hit from this round's usage. Null until usage reports it. */
  readonly cacheHit?: boolean | null;
  /** True when a prior live-tape completion was still within prompt-cache TTL. */
  readonly expectedCacheHit?: boolean;
};

/**
 * System strings; prior completions, tool calls, and scheme programs event-source the rest.
 * A `CompactJob` is the compaction card: a typed cell, so a later compaction can tell
 * "this is a prior card" from a plain string (its text is `standIn`).
 */
export type CompletionMessage =
  | string
  | CompactJob
  | CompletionExpectation
  | CompletionJob
  | ToolCallJob
  | ProgrammaticJob
  | TurnNotificationChunk
  | TurnSteerChunk
  | TurnApprovalNoteChunk;

/** `DEBUG` set — the `dev` script. Cache-mismatch tape marks are debug-only. */
export function debugMode(): boolean {
  const value = process.env.DEBUG;
  return value !== undefined && value.trim() !== "";
}

/** Grok prefix-cache block. One block is a shared crumb, not a conversation hit. */
const PROMPT_CACHE_BLOCK_TOKENS = 128;

/**
 * Hit was expected and usage is a miss: 0 cached, or only the 128-token
 * crumb. Tape must paint this — the crumb exception must not swallow it.
 */
export function tapeCacheMiss(chunk: CompletionExpectation): boolean {
  if (!chunk.expectedCacheHit || chunk.cacheHit === null) return false;
  return chunk.cacheHit === false || chunk.cachedTokens <= PROMPT_CACHE_BLOCK_TOKENS;
}

/**
 * Per-round cache status for debug paint. Empty until usage reports
 * `cached_tokens`. A miss that was expected to hit always paints — including
 * Grok's 128-token crumb. The crumb exception is unexpected-hit only.
 */
export function cacheStatusNote(chunk: CompletionExpectation): string {
  if (chunk.cacheHit === null) return "";
  if (tapeCacheMiss(chunk)) {
    return `cache miss · expected hit · ${chunk.cachedTokens} cached`;
  }
  if (!chunk.cacheMisaligned()) return "";
  return `cache hit · unexpected · ${chunk.cachedTokens} cached`;
}

/** File/stderr line. Named even when aligned — tape still uses {@link cacheStatusNote}. */
export function cacheStatusLog(chunk: CompletionExpectation): string {
  if (chunk.cacheHit === null) return "cache unreported";
  if (chunk.cacheMisaligned()) return cacheStatusNote(chunk);
  const cached = chunk.cachedTokens;
  return chunk.cacheHit ? `cache hit · ${cached} cached` : `cache miss · ${cached} cached`;
}

@syncing("harness:expectation:completion")
export class CompletionExpectation extends WorkExpectation<CompletionResult, CompletionReport> {
  @syncing accessor background: boolean = false;
  /**
   * Stored user line for a session round. Isolated rounds leave this empty
   * and keep the messages; the line to read is {@link userPrompt}. Holds only the
   * head once the line went to the blob bucket ({@link promptTextBlobJson}).
   */
  @syncing accessor promptText: UserPrompt = prompt.user``;
  /**
   * The line's blob reference (a `StoredBlob` as JSON) when it was too large to stay inline;
   * {@link promptText} then holds the head. Null while the line is inline, and in documents
   * from before lines could leave.
   */
  @syncing accessor promptTextBlobJson: string | null = null;
  /** Isolated completions use only promptMessages, without ambient session context or tools. */
  @syncing accessor completionMode: "session" | "isolated" = "session";
  /** Ordered authored messages. The joined user line is {@link userPrompt}. */
  @syncing.child.list accessor promptMessages: PromptMessage[] = [];
  /** Host system line for this round only. Empty = omit. */
  @syncing accessor systemNote: SystemPrompt = prompt.system``;
  @syncing accessor model: string = "";
  /**
   * Canonical reasoning effort for this round. Null = omit (vendor default).
   * `none` disables when the dialect allows; otherwise the driver clamps.
   */
  @syncing accessor reasoningEffort: ReasoningEffort | null = null;
  /** Compiled JSON Schema text. Null = unstructured. */
  @syncing accessor responseSchemaJson: string | null = null;

  /** JSON Schema for this round's response. Null is unstructured. */
  @serializingInto("responseSchemaJson")
  accessor responseSchema: ReadonlyDeep<Record<string, unknown>> | null = null;

  @syncing accessor responseText: string = "";
  @syncing accessor responseThought: string = "";
  /**
   * How {@link responseThought} was produced. `raw` = as-is CoT;
   * `summary` = provider summary. Null = none or unknown.
   */
  @syncing accessor responseThoughtKind: "raw" | "summary" | null = null;
  /**
   * Responses `reasoning.encrypted_content` for this round. Empty on Chat
   * Completions. Echoed on the next Responses input with `summary` (required);
   * item `id` stays off the wire (`store: false` 400s unknown ids).
   */
  @syncing accessor responseReasoningEncrypted: string = "";
  @syncing.child.list accessor responseCalls: ResponseCall[] = [];
  @syncing accessor failReason: string | null = null;
  /**
   * The provider's stop reason for the answer: `stop`, `tool_calls`, `length`,
   * `content_filter`. Empty until the provider reports one.
   */
  @syncing accessor finishReason: string = "";
  /** Transient-error retry budget in force, recorded when the round starts. 0 is no limit. */
  @syncing accessor retryMaxMs: number = 0;
  @syncing accessor retryMaxAttempts: number = 0;
  /** Window occupancy after this call — a gauge, not a spend weight. Null until usage reports it. */
  @syncing accessor totalTokens: number | null = null;
  /** Prefix-cache *read* size. 0 until reported or on miss. Included in input, not extra. */
  @syncing accessor cachedTokens: number = 0;
  /** Prompt/input tokens. Null until usage reports them. Cache-read is included. */
  @syncing accessor inputTokens: number | null = null;
  /** Completion/output tokens. Null until usage reports them. Reasoning is a subset, not extra. */
  @syncing accessor outputTokens: number | null = null;
  /** Cache-creation / cache-write tokens. Null until usage reports them. */
  @syncing accessor cacheWriteTokens: number | null = null;
  /** Thinking/reasoning tokens (subset of output). Null until usage reports them. */
  @syncing accessor reasoningTokens: number | null = null;
  /**
   * Provider-billed USD for this round. Null until usage reports a cost.
   * 0 is free, not omitted. Never list-price fallback.
   */
  @syncing accessor costUsd: number | null = null;
  /**
   * Whether this round's usage reported a prefix-cache hit.
   * Null = provider omitted `cached_tokens` (do not compare).
   */
  @syncing accessor cacheHit: boolean | null = null;
  /**
   * Whether a hit was expected when the round was sent: a prior live-tape
   * completion still within TTL, and this round did not follow a cutoff.
   */
  @syncing accessor expectedCacheHit: boolean = false;
  /** Model window. Null until usage reports one. */
  @syncing accessor contextLimit: number | null = null;
  /** Epoch ms. `warmUntil` is the Date face; Plexus cannot store Date. */
  @syncing accessor warmUntilMs: number | null = null;
  /**
   * Epoch ms. Write-once. When speech first arrives, or on settlement if
   * there was never speech. Reasoning duration is this minus `startedAtMs`,
   * not the completion's end.
   */
  @syncing accessor thoughtEndedAtMs: number | null = null;
  @syncing.list accessor messages: CompletionMessage[] = [];
  /**
   * R3. The retention clock read once at round open:
   * `{at: <completion uuid>, reason, coldByMs?, freedTokens?}`. Empty =
   * unstamped (no deep expiry). The projection reads only `at`.
   */
  @syncing accessor retentionClockJson: string = "";

  /**
   * User line. Authored user messages win, so an isolated round does not
   * also persist the joined string. With no user message, this is {@link promptText}.
   *
   * It joins the stored `content`, so a body that went to the blob bucket reads here as its
   * head: a stub, never the whole text. The wire projection and any reader that needs every
   * character resolve {@link PromptMessage.body} / {@link promptTextBody} through the blob reader.
   */
  @computed
  get userPrompt(): UserPrompt {
    const users = this.promptMessages.filter((row) => row.role === "user");
    if (users.length === 0) return this.promptText;
    return asUserPrompt(users.map((row) => row.content).join("\n\n"));
  }

  /** {@link promptText}, inline or by reference. A reference that does not parse is no reference. */
  get promptTextBody(): StoredText {
    const blob = parseStoredBlob(this.promptTextBlobJson);
    return blob === null ? { kind: "inline", text: this.promptText } : { kind: "blob", blob };
  }

  get warmUntil(): Date | null {
    return this.warmUntilMs == null ? null : new Date(this.warmUntilMs);
  }

  set warmUntil(value: Date | null) {
    this.warmUntilMs = value == null ? null : value.getTime();
  }

  /** Live clock — not `@computed`; a cached true would outlive the deadline. */
  get isWarm(): boolean {
    return this.warmUntilMs != null && this.warmUntilMs > Date.now();
  }

  /**
   * A hit is expected when a prior completion on the live tape is still
   * within TTL. A cutoff rewrites the prefix — that next round
   * is a miss even if the snapshot cells are warm.
   */
  expectPromptCacheHit(): boolean {
    if (followsCutoff(this)) return false;
    for (const prior of this.spine()) {
      if (prior === this) continue;
      if (prior.isWarm) return true;
    }
    return false;
  }

  /**
   * Usage disagrees with {@link expectedCacheHit} for tape paint.
   * Expected-hit miss (0 or ≤128 crumb) always misaligns. Unexpected
   * one-block crumb does not.
   */
  cacheMisaligned(): boolean {
    if (this.cacheHit === null) return false;
    if (tapeCacheMiss(this)) return true;
    if (this.expectedCacheHit) return false;
    return this.cacheHit === true && this.cachedTokens > PROMPT_CACHE_BLOCK_TOKENS;
  }

  constructor(
    props:
      | symbol
      | {
          connectionId: string;
          promptText?: UserPrompt;
          promptTextBlobJson?: string | null;
          systemNote?: SystemPrompt;
          completionMode?: "session" | "isolated";
          promptMessages?: PromptMessage[];
          model?: string;
          reasoningEffort?: ReasoningEffort | null;
          messages?: CompletionMessage[];
          retentionClockJson?: string;
          responseSchema?: Readonly<Record<string, unknown>> | null;
          responseCalls?: ResponseCall[];
        },
  ) {
    if (typeof props === "symbol") {
      super(props);
      return;
    }
    const { responseSchema, ...rest } = props;
    // `JSON.stringify(null)` is the string "null", which would read back as a schema.
    const init = {
      ...rest,
      responseSchemaJson: responseSchema == null ? null : JSON.stringify(responseSchema),
    };
    super(init);
  }

  /**
   * Clear the previous attempt's wire. `expectedCacheHit` is decided by the
   * caller — this method must not walk the spine.
   */
  @syncing.action
  beginAttempt(expectedCacheHit: boolean): void {
    this.setResponseCalls([]);
    this.responseReasoningEncrypted = "";
    this.responseThoughtKind = null;
    this.failReason = null;
    this.finishReason = "";
    this.totalTokens = null;
    this.cachedTokens = 0;
    this.cacheHit = null;
    this.inputTokens = null;
    this.outputTokens = null;
    this.cacheWriteTokens = null;
    this.reasoningTokens = null;
    this.costUsd = null;
    this.expectedCacheHit = expectedCacheHit;
  }

  @syncing.action
  stampAnswer(next: {
    readonly calls: readonly ResponseCall[];
    readonly text: string;
    readonly thought?: string;
    readonly thoughtKind?: string;
    readonly finishReason?: string;
  }): void {
    this.setResponseCalls(next.calls);
    if (next.finishReason !== undefined) this.finishReason = next.finishReason;
    this.responseText = next.text;
    if (next.thought !== undefined) this.responseThought = next.thought;
    if (next.thoughtKind !== undefined) this.responseThoughtKind = thoughtKindOf(next.thoughtKind);
  }

  /** Record the retry budget once, when the round is first driven. */
  @syncing.action
  stampRetryLimits(limits: { readonly maxMs: number; readonly maxAttempts: number }): void {
    if (this.retryMaxMs === 0) this.retryMaxMs = limits.maxMs;
    if (this.retryMaxAttempts === 0) this.retryMaxAttempts = limits.maxAttempts;
  }

  /** Homed `child.list` — replace in place; a new array is not adopted. */
  setResponseCalls(calls: readonly ResponseCall[]): void {
    this.responseCalls.splice(0, this.responseCalls.length, ...calls);
  }

  markThoughtEnded(now = Date.now()): void {
    if (this.thoughtEndedAtMs != null) return;
    this.thoughtEndedAtMs = now;
  }

  /**
   * Prior completions on the parent turn tape, compact-aware, plus this node.
   * Parent that is not a SessionTurn (judge PEW) is `[this]`.
   * A successful CompactJob drops every completion before it — the card is
   * not a completion, so the wire lead is built elsewhere.
   */
  spine(): CompletionExpectation[] {
    if (this.completionMode === "isolated") return [this];
    const turn = owningTurn(this);
    if (turn === null) return [this];
    const heads = turnHeads(turn);
    const mark = latestCutoffMark(heads);
    const kept = heads.slice(keptFromIndex(heads, mark));
    const out: CompletionExpectation[] = [];
    for (const head of kept) {
      const tape = reactChunks(head);
      const afterCutoff = mark?.turn === head ? tape.slice(Math.max(0, tape.indexOf(mark.compact) + 1)) : tape;
      const prior = completionsOf(afterCutoff).filter((chunk) => chunk !== this);
      if (head === turn) {
        for (const child of prior) out.push(child);
        out.push(this);
        continue;
      }
      for (const child of prior) out.push(child);
    }
    return out;
  }

  /** Thinking span only. Null if start was never stamped. */
  thoughtDurationMs(now = Date.now()): number | null {
    if (this.startedAtMs == null || !Number.isFinite(this.startedAtMs)) return null;
    const end =
      this.thoughtEndedAtMs != null && Number.isFinite(this.thoughtEndedAtMs)
        ? this.thoughtEndedAtMs
        : this.endedAtMs != null && Number.isFinite(this.endedAtMs)
          ? this.endedAtMs
          : now;
    return Math.max(0, end - this.startedAtMs);
  }

  override applySettlement(result: CompletionResult): void {
    this.responseText = result.text;
    if (typeof result.thought === "string") this.responseThought = result.thought;
    if (typeof result.thoughtKind === "string") this.responseThoughtKind = thoughtKindOf(result.thoughtKind);
    this.markThoughtEnded();
    const schema = this.responseSchema;
    assertResponseMatchesSchema(result.text, schema == null ? null : JSON.stringify(schema));
  }
}

function thoughtKindOf(value: unknown): "raw" | "summary" | null {
  return value === "raw" || value === "summary" ? value : null;
}

type CutoffMark = { readonly compact: CompactJob; readonly turn: SessionTurn };

function turnHeads(turn: SessionTurn): SessionTurn[] {
  const heads: SessionTurn[] = [];
  const seen = new Set<SessionTurn>();
  let cell: SessionTurn | null = turn;
  while (cell != null && !seen.has(cell)) {
    seen.add(cell);
    heads.push(cell);
    cell = cell.turnTail instanceof SessionTurn ? cell.turnTail : null;
  }
  heads.reverse();
  return heads;
}

/** Newest successful compact cutoff on this turn's tail chain. */
export function latestCompactCutoff(
  turn: SessionTurn,
): { readonly job: CompactJob; readonly turn: SessionTurn } | null {
  const mark = latestCutoffMark(turnHeads(turn));
  if (mark == null) return null;
  return { job: mark.compact, turn: mark.turn };
}

/** Newest successful cutoff. */
export function latestCutoffMark(headsOldestFirst: readonly SessionTurn[]): CutoffMark | null {
  for (let index = headsOldestFirst.length - 1; index >= 0; index -= 1) {
    const turn = headsOldestFirst[index]!;
    const tape = reactChunks(turn);
    for (let cellIndex = tape.length - 1; cellIndex >= 0; cellIndex -= 1) {
      const chunk = tape[cellIndex];
      if (chunk instanceof CompactJob && chunk.cutoff) return { compact: chunk, turn };
    }
  }
  return null;
}

function keptFromIndex(headsOldestFirst: readonly SessionTurn[], mark: CutoffMark | null): number {
  if (mark == null) return 0;
  const index = headsOldestFirst.indexOf(mark.turn);
  return Math.max(0, index);
}

export function owningTurn(pew: CompletionExpectation): SessionTurn | null {
  const parent = pew.parent;
  if (parent instanceof SessionTurn) return parent;
  if (parent instanceof CompletionJob) return tapeTurn(parent);
  return null;
}

function completionOnTape(chunk: unknown): CompletionExpectation | null {
  return tapeCompletion(chunk) ?? (chunk instanceof CompletionExpectation ? chunk : null);
}

function completionsOf(chunks: readonly unknown[]): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of chunks) {
    const pew = completionOnTape(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

function tapeIndexOf(tape: readonly unknown[], pew: CompletionExpectation): number {
  for (let i = 0; i < tape.length; i += 1) {
    const cell = tape[i];
    if (cell === pew || tapeCompletion(cell) === pew) return i;
  }
  return -1;
}

function followsCutoff(expectation: CompletionExpectation): boolean {
  const turn = owningTurn(expectation);
  if (turn === null) return false;
  const tape = reactChunks(turn);
  const index = tapeIndexOf(tape, expectation);
  if (index <= 0) return false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const cell = tape[i];
    if (completionOnTape(cell) != null) return false;
    if (cell instanceof CompactJob && cell.cutoff) return true;
  }
  return false;
}
