import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";

/** OpenAI-compatible tool call; arguments ALWAYS a JSON string. */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type KnownDialectId =
  | "openai"
  | "hermes"
  | "qwen_xml"
  | "longcat"
  | "llama3_json"
  | "mistral"
  | "pythonic"
  | "deepseek_v3"
  | "deepseek_v31"
  | "glm_xml";

export type DialectId = KnownDialectId | "auto" | (string & {});

export type JsonSchema = Record<string, unknown>;

export type ToolDef = {
  name: string;
  parameters?: JsonSchema;
};

export type NormalizeMode = "pass" | "detect" | "repair" | "strict";
export type NativePolicy = "skip" | "merge" | "rescan";

export type DropReason = "unknown_name" | "ambiguous_name" | "unparseable_args" | "empty_name" | "truncated";

/**
 * Stream-only drop reasons (audit-011 C2). Extends DropReason for live IR.
 * Batch meta.dropped still uses DropReason; stream tool_call_drop uses this.
 */
export type StreamDropReason =
  DropReason | "duplicate_native" | "duplicate_recovered" | "irreparable_args" | "fenced" | "aborted";

export type NormalizeOptions = {
  modelHint?: string;
  dialect?: DialectId;
  mode?: NormalizeMode;
  nativePolicy?: NativePolicy;
  /**
   * Tool catalog. When non-empty, enables name resolution, schema repair,
   * and (by default) requireKnownTool for recovered calls.
   */
  tools?: ToolDef[];
  /**
   * When true (default **if** `tools?.length`): drop recovered tool_calls
   * whose resolved name is not in the catalog. When false: keep unknown
   * recovered names. No effect when `tools` is empty/absent.
   * Natives are not dropped by this flag (strict still drops unknown natives).
   */
  requireKnownTool?: boolean;
  thinkTags?: string[];
  toolsInThinking?: "ignore" | "extract";
  idStyle?: "uuid" | "call" | "mistral9" | "stable";
  nameAliases?: Record<string, string>;
  argAliases?: Record<string, Record<string, string>>;
  maxBufferChars?: number;
  finishReasonIn?: string | null;
};

export type NormalizeMeta = {
  dialect: string;
  estimated: boolean;
  toolsInThinkingCount: number;
  dropped: Array<{ name: string; reason: DropReason; rawSpan?: string }>;
  ambiguous: Array<{ name: string; candidates: string[] }>;
  partial: number[];
  candidates?: Array<{
    dialect: string;
    start: number;
    end: number;
    note?: string;
  }>;
  untypedArgs: boolean;
  renamed: Array<{ from: string; to: string }>;
};

export type FinishReason = "tool_calls" | "stop" | "length" | "content_filter" | "error" | "aborted" | null;

/** finish event on IR — same as FinishReason without null. */
export type StreamFinishReason = Exclude<FinishReason, null>;

export type NormalizeMessageResult = {
  content: string | null;
  tool_calls: ToolCall[];
  reasoning_content?: string | null;
  finish_reason: FinishReason;
  meta: NormalizeMeta;
};

export type MessageInput =
  | string
  | {
      content?: string | null;
      tool_calls?: ToolCall[] | null;
      reasoning_content?: string | null;
    };

export type RawToolCall =
  | {
      form: "json";
      bodyJson: string;
      rawName: "";
    }
  | {
      form: "tagged";
      rawName: string;
      argsTagged: Record<string, string>;
    };

export type ExtractResult = {
  content: string | null;
  raw_calls: RawToolCall[];
  toolSpans: Array<{ start: number; end: number }>;
  /** Indices into raw_calls that were truncated (open marker, no close at EOS). */
  truncated?: number[];
};

export type StreamStepResult = {
  consumed: number;
  events: NormalizeEvent[];
  holding: boolean;
};

/**
 * Extract context. `original` is the unmasked text with identity offsets to
 * `text` (same-length fence mask). Dialects match on `text`, slice bodies from
 * `original` so fence interiors inside args stay intact (audit-005 R1).
 */
export type DialectContext = {
  original?: string;
};

/**
 * A dialect's own argument-value delimiter pair (task D1). The HOST masks
 * every occurrence it finds — a dialect that declares these never has to
 * remember to mask its own values before scanning for its outer close
 * markers; a dialect with none (e.g. Hermes' JSON body) declares `[]` and
 * gets a no-op pass-through. See `maskArgValues` in dialects/step-common.ts.
 */
export type ValueDelimiter = { open: RegExp; close: RegExp };

export type Dialect<S = unknown> = {
  id: string;
  /**
   * Open markers for auto/hold. Prefer openMarkers when set (2b-1).
   * `markers` remains the union used by batch auto cascade.
   */
  markers: string[];
  /** Stream open markers (default: markers). */
  openMarkers?: string[];
  /** Stream close markers (e.g. </tool_call>). Empty → dialect step owns close. */
  closeMarkers?: string[];
  /**
   * Argument-value delimiter pairs this dialect's markup uses (task D1).
   * Declared data, not per-dialect masking code — the host (findCloseEnd /
   * findCloseMarkerLen, and any dialect's own extract()) masks every
   * occurrence before scanning for THIS dialect's own open/close markers,
   * so an embedded close-marker-lookalike inside a value can never
   * truncate the outer scan. Default (absent/empty): no value masking.
   */
  valueDelimiters?: ValueDelimiter[];
  autoPriority: number;
  allowAuto: boolean;
  allowStreamAuto: boolean;
  claim?(text: string, pos: number): boolean;
  extract(text: string, ctx: DialectContext): ExtractResult;
  createStreamState?(): S;
  step?(state: S, buffer: string, ctx: DialectContext): StreamStepResult;
};

/**
 * Streaming IR events (audit-011 §9.3).
 *
 * Ordering:
 * - Exactly one finish, terminal; meta immediately precedes finish.
 * - Per call: start → 0..n args_delta → end | drop.
 * - tool_call_end.arguments is authoritative; args_delta is display preview only.
 * - index is IR-local commit order, not provider delta.tool_calls[].index.
 */
/**
 * Absolute character offsets into the concatenated raw input text of the
 * stream (all pieces passed to the session's `ingest`, in arrival order).
 * Best-effort: populated where the live probe path has the data; left
 * undefined where an event is assembled from the EOS assemble without a
 * traceable offset (task C1 — conservation ledger surfaces the gap).
 */
export type RawSpan = { start: number; end: number };

export type NormalizeEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "tool_call_start";
      index: number;
      id: string;
      name: string;
      span?: RawSpan;
    }
  | {
      type: "tool_call_args_delta";
      index: number;
      id: string;
      /** Display preview only — do not assemble for execution. */
      argumentsDelta: string;
    }
  | {
      type: "tool_call_end";
      index: number;
      id: string;
      name: string;
      /** Authoritative JSON string after §5.1.7 ladder. */
      arguments: string;
      partial?: boolean;
      span?: RawSpan;
    }
  | {
      type: "tool_call_drop";
      index: number;
      id: string;
      name: string | null;
      reason: StreamDropReason;
      span?: RawSpan;
    }
  | { type: "finish"; finish_reason: StreamFinishReason }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "meta"; meta: NormalizeMeta }
  | { type: "usage"; input?: number; output?: number };

export type OpenAiChatChunk = {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
};

export class NormalizeError extends ErrorWithInvariant {
  constructor(
    public code: "strict_without_tools" | "unknown_dialect" | "rescan_not_streamable" | "double_commit",
    message: string,
  ) {
    super(message);
    this.name = "NormalizeError";
  }
}
