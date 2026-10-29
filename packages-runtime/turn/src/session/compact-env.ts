/**
 * Compact env is an EnvCapability, not a bag of names.
 *
 * Five keys (`writing-capabilities.md`, `environments.md` §CAPABILITY):
 * configuration, resources, prelude, symbols, deps. Symbols are the membrane
 * crossing (honest codecs). Prelude is Scheme bootstrap that PERSISTS into the
 * strategy eval — derived names are `(define …)` over primitives, not a second
 * JS verb. User code may call prelude defines; it may not name a `preludeOnly`
 * symbol (those exist only while the prelude runs).
 *
 * Compact is not a classify walk. `applyCompact` loads the strategy with
 * `execState` and calls `compact` / `forced-compact` as host functions,
 * passing `Transcript` instances as arguments. Occupancy primitives are
 * `tokens/used` and `tokens/total`; remaining and relative live in the prelude.
 * `user-rounds/count` is a primitive (prompt nonempty). `message/ack` is a
 * primitive so the cell is marked synthetic.
 *
 * Membrane: `Transcript` is `@arrival.private` — opaque `z.instance(Transcript)`.
 * Eat cells are a union of host classes, so they cross as `z.box` (non-opaque)
 * — `z.instance` unions throw on the first arm instead of falling through.
 *
 * Provenance: config-readers (`chunks`, `reason`, `kv/get`, …) are `source` —
 * external data crossing in. Meters and slicers over a transcript ARGUMENT
 * are `pipe` — pure transforms that mint nothing. `transcript/warm?` is the
 * one argument-reader that stays `source`: `isWarm` reads the live clock.
 */
import { dirname } from "node:path";

import {
  EnvCapability,
  execState,
  jsToScheme,
  makeCallCtx,
  toJS,
  type RunContext,
  type SchemeValue,
} from "@here.build/arrival";
import { applyCallback, is_callable_value } from "@here.build/arrival/host-internals";
import { arrivalLoaderCapability } from "@here.build/arrival-modules";
import { promptIsolatedCapability, type PromptComplete } from "@inhuman.tools/env-capability-module-prompt";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  ProgrammaticJob,
  tapeCompletion,
  ToolCallJob,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnSteerChunk,
} from "@inhuman.tools/harness-model";
import { Job } from "@inhuman.tools/plexus-expectations";
import { programSourceLoader } from "@inhuman.tools/scheme-program/fs";
import invariant from "tiny-invariant";
import { z } from "zod";

import {
  contentTokensOf,
  MessageChunk,
  payloadSuffix,
  textOfCell,
  toolCallRepresentation,
  Transcript,
  type EatCell,
} from "../context/index.js";
import { charsOf } from "../context/transcript.js";

/** Same door as scheme_repl `load`: last-write-wins over `require`. */
const schemeLoadAliasCapability = EnvCapability.define("harness/scheme-repl-load", {
  deps: [arrivalLoaderCapability],
  symbols: (symbol) => ({
    load: symbol.defineSyntax`load: alias of require; spills .scm defines into this run`(
      "(lambda (specifier) `(require ,specifier))",
    ),
  }),
});

const hostChunk = z.union([
  z.instanceof(CompactJob),
  z.instanceof(CompletionExpectation),
  z.instanceof(CompletionJob),
  z.instanceof(ToolCallJob),
  z.instanceof(ProgrammaticJob),
  z.instanceof(TurnNotificationChunk),
  z.instanceof(TurnApprovalNoteChunk),
  z.instanceof(TurnSteerChunk),
  z.instanceof(MessageChunk),
  z.string(),
]);

export type CompactStrategyOpts = {
  readonly reason?: string;
  readonly focus?: string;
  readonly kv?: Readonly<Record<string, string>>;
  readonly plan?: string | null;
  readonly forced?: boolean;
  /**
   * Absolute path the program source was read from. Enables `(require "…")` —
   * `.prompt` pretreats ship next to the strategy — jailed under its dirname.
   * Null for the inline fallback: no `require` surface.
   */
  readonly sourcePath?: string | null;
  /**
   * Live completion wiring for the summarizer call a `.prompt` performs. The
   * prompt capability admits an agent/ask on this job; absent → the strategy
   * renders but cannot run a model call (bench/stub path).
   */
  readonly job?: Job;
  readonly complete?: PromptComplete;
  readonly connectionId?: string;
  readonly completionModel?: string;
  /** Abort rejects at once and hands the abort to each summarizer round through `complete`. */
  readonly signal?: AbortSignal;
};

export type CompactFailure = {
  readonly ok: false;
  readonly reason: "empty-check-in" | "did-not-shrink";
};

export type CompactSuccess = {
  readonly ok: true;
  readonly checkIn: EatCell[];
};

export type CompactApplyResult = CompactSuccess | CompactFailure;

type CompactConfig = {
  chunks: Array<z.infer<typeof hostChunk>>;
  reason: string;
  focus: string;
  kv: Record<string, string>;
  plan: string | null;
};

export const compactReducerCapability = EnvCapability.define("harness/compact", {
  configuration: {
    chunks: z.array(hostChunk).default([]),
    reason: z.string().default("overflow"),
    focus: z.string().default(""),
    kv: z.record(z.string(), z.string()).default({}),
    plan: z.string().nullable().optional(),
  },
  symbols: (symbol, sz) => {
    const chunk = sz.union([sz.box, sz.string]);
    const transcript = sz.instance(Transcript);
    const cells = sz.list(chunk);
    // "value or #f" — the R7RS search-sentinel union (r7rs/lists.ts), never z.dynamic.
    const stringOrFalse = sz.union([sz.string, sz.booleanFalse]);
    return {
      chunks: symbol.rosetta`chunks: current eat; completions and tool calls`(
        { input: [], output: [cells], provenance: "source" },
        function () {
          return this.configuration.chunks;
        },
      ),

      "tokens/used": symbol.rosetta`tokens/used: occupancy of a transcript`(
        // Gauge diff at the slice boundary — never a per-cell sum of the
        // window gauge (transcript.ts preamble).
        { input: [transcript], output: [sz.number], provenance: "pipe" },
        (t: Transcript) => t.tokensUsed(),
      ),
      "tokens/total": symbol.rosetta`tokens/total: cap attached to a transcript`(
        { input: [transcript], output: [sz.number], provenance: "pipe" },
        (t: Transcript) => t.cap,
      ),
      "tokens/count": symbol.rosetta`tokens/count: raw content meter of a cell or list`(
        { input: [transcript], output: [sz.number], provenance: "pipe" },
        (t: Transcript) => contentTokensOf(t.cells),
      ),
      "chars/count": symbol.rosetta`chars/count: JSON-char meter (Gemini)`(
        { input: [transcript], output: [sz.number], provenance: "pipe" },
        (t: Transcript) => charsOf(t.cells),
      ),
      "rounds/count": symbol.rosetta`rounds/count: ReACT rounds in a transcript`(
        { input: [transcript], output: [sz.number], provenance: "pipe" },
        (t: Transcript) => t.rounds().length,
      ),
      "user-rounds/count": symbol.rosetta`user-rounds/count: rounds whose prompt is nonempty`(
        { input: [transcript], output: [sz.number], provenance: "pipe" },
        (t: Transcript) => t.rounds().filter((round) => round.prompt !== "").length,
      ),

      "transcript/warm?": symbol.rosetta`transcript/warm?: any completion still in the prompt cache`(
        { input: [transcript], output: [sz.boolean], provenance: "source" },
        (t: Transcript) =>
          t.cells.some((cell) => {
            const pew = tapeCompletion(cell) ?? (cell instanceof CompletionExpectation ? cell : null);
            return pew != null && pew.isWarm;
          }),
      ),
      // Frontier direction: preserve runs frontier → newest, compact runs
      // oldest → frontier. The frontier is preserve's OLDEST round and
      // compact's NEWEST — newer drops the oldest, older drops the newest.
      "transcript/round": symbol.rosetta`transcript/round: frontier as a one-round transcript`(
        { input: [transcript], output: [transcript], provenance: "pipe" },
        (t: Transcript) => t.frontierRound(),
      ),
      "transcript/newer": symbol.rosetta`transcript/newer: preserve without the frontier`(
        { input: [transcript], output: [transcript], provenance: "pipe" },
        (t: Transcript) => t.withoutFrontier(),
      ),
      "transcript/older": symbol.rosetta`transcript/older: compact without the frontier`(
        { input: [transcript], output: [transcript], provenance: "pipe" },
        (t: Transcript) => t.withoutNewest(),
      ),
      "transcript/tools": symbol.rosetta`transcript/tools: flattened tool cells`(
        { input: [transcript], output: [cells], provenance: "pipe" },
        (t: Transcript) => t.cells.filter((cell) => cell instanceof ToolCallJob || cell instanceof ProgrammaticJob),
      ),
      "transcript/cells": symbol.rosetta`transcript/cells: flattened eat cells`(
        { input: [transcript], output: [cells], provenance: "pipe" },
        (t: Transcript) => [...t.cells],
      ),
      "transcript/compaction-results":
        symbol.rosetta`transcript/compaction-results: prior compact check-ins, oldest to newest`(
          { input: [transcript], output: [cells], provenance: "pipe" },
          (t: Transcript) => t.checkInCells(),
        ),
      "transcript/payload": symbol.rosetta`transcript/payload: t without its prior compact cards`(
        { input: [transcript], output: [transcript], provenance: "pipe" },
        (t: Transcript) => t.withoutCheckIns(),
      ),
      "transcript/complete-rounds": symbol.rosetta`transcript/complete-rounds: rounds in t that ended`(
        { input: [transcript], output: [transcript], provenance: "pipe" },
        (t: Transcript) => t.completeRounds(),
      ),
      "transcript/partial-round": symbol.rosetta`transcript/partial-round: unfinished last round, or #f`(
        {
          input: [transcript],
          output: [sz.union([transcript, sz.nil])],
          provenance: "pipe",
        },
        (t: Transcript) => t.partialRound(),
      ),
      "transcript/concat": symbol.rosetta`transcript/concat: join two transcripts`(
        {
          input: [transcript, transcript],
          output: [transcript],
          provenance: "pipe",
        },
        (a: Transcript, b: Transcript) => a.concat(b),
      ),
      "transcript/empty": symbol.rosetta`transcript/empty: empty transcript`(
        { input: [], output: [transcript], provenance: "pipe" },
        () => Transcript.empty(),
      ),

      "payload/suffix": symbol.rosetta`payload/suffix: pair-safe last n cells that are not compact check-ins`(
        {
          input: [transcript, sz.number],
          output: [cells],
          provenance: "pipe",
        },
        (t: Transcript, n: number) => payloadSuffix(t, n),
      ),

      "message/user": symbol.rosetta`message/user: user cell or user-shaped check-in`(
        { input: [sz.string], output: [chunk], provenance: "pipe" },
        (text: string) => new MessageChunk("user", text),
      ),
      "message/assistant": symbol.rosetta`message/assistant: assistant cell or assistant-shaped check-in`(
        { input: [sz.string], output: [chunk], provenance: "pipe" },
        (text: string) => new MessageChunk("assistant", text),
      ),
      "message/ack": symbol.rosetta`message/ack: synthetic turn-taking cell`(
        {
          input: [sz.foldName.pipe(sz.enum(["user", "assistant"])), sz.string],
          output: [chunk],
          provenance: "pipe",
        },
        (role, text: string) => new MessageChunk(role, text, { ack: true }),
      ),
      "message/user?": symbol.rosetta`message/user?: eat cell is user-shaped`(
        { input: [chunk], output: [sz.boolean], provenance: "pipe" },
        (cell: unknown) => typeof cell === "string" || (cell instanceof MessageChunk && cell.role === "user"),
      ),
      "message/assistant?": symbol.rosetta`message/assistant?: eat cell is assistant-shaped`(
        { input: [chunk], output: [sz.boolean], provenance: "pipe" },
        (cell: unknown) => {
          const pew = tapeCompletion(cell) ?? (cell instanceof CompletionExpectation ? cell : null);
          return pew != null || (cell instanceof MessageChunk && cell.role === "assistant");
        },
      ),
      "message/tool?": symbol.rosetta`message/tool?: eat cell is a tool call`(
        { input: [chunk], output: [sz.boolean], provenance: "pipe" },
        (cell: unknown) => cell instanceof ToolCallJob || cell instanceof ProgrammaticJob,
      ),
      "pair-id": symbol.rosetta`pair-id: toolCallId, or #f`(
        { input: [chunk], output: [stringOrFalse], provenance: "pipe" },
        (cell: unknown) => {
          if (cell instanceof ToolCallJob && cell.toolCallId !== "") return cell.toolCallId;
          if (cell instanceof ProgrammaticJob && cell.toolCallId !== "") return cell.toolCallId;
          return false;
        },
      ),
      "tool-name": symbol.rosetta`tool-name: Read / Bash / Shell / …`(
        { input: [chunk], output: [sz.string], provenance: "pipe" },
        (cell: unknown) =>
          cell instanceof ToolCallJob ? cell.name : cell instanceof ProgrammaticJob ? cell.toolName : "",
      ),
      "chunk-text": symbol.rosetta`chunk-text: cell text, or #f`(
        { input: [chunk], output: [stringOrFalse], provenance: "pipe" },
        (cell: unknown) => textOfCell(cell) || false,
      ),
      "message/transcript-as-single-prompt":
        symbol.rosetta`message/transcript-as-single-prompt: paint a transcript as one summarizer blob`(
          { input: [transcript], output: [sz.string], provenance: "pipe" },
          (t: Transcript) =>
            t.cells
              .map(function (cell: EatCell): string {
                if (typeof cell === "string") return cell;
                if (cell instanceof CompactJob) return `user: ${textOfCell(cell)}`;
                if (cell instanceof MessageChunk) return `${cell.role}: ${cell.text}`;
                if (cell instanceof TurnNotificationChunk) return textOfCell(cell);
                if (cell instanceof TurnApprovalNoteChunk) return `user: ${cell.approvalNoteText()}`;
                if (cell instanceof TurnSteerChunk) return `user: ${cell.completionMessage}`;
                if (cell instanceof ToolCallJob) {
                  const scheme = cell.children.find(
                    (child): child is ProgrammaticJob => child instanceof ProgrammaticJob,
                  );
                  if (scheme !== undefined) {
                    return `[scheme ${scheme.toolCallId}]\n${scheme.expr}\n${scheme.resultText()}`.trim();
                  }
                  const painted = toolCallRepresentation(cell);
                  return `[${painted.name} ${painted.id}]\n${painted.args}\n${painted.result}`.trim();
                }
                if (cell instanceof ProgrammaticJob) {
                  return `[scheme ${cell.toolCallId}]\n${cell.expr}\n${cell.resultText()}`.trim();
                }
                const pew = tapeCompletion(cell) ?? (cell instanceof CompletionExpectation ? cell : null);
                if (pew == null) return "";
                const parts: string[] = [];
                if (pew.userPrompt !== "") parts.push(`user: ${pew.userPrompt}`);
                if (pew.responseText !== "") parts.push(`assistant: ${pew.responseText}`);
                return parts.join("\n");
              })
              .filter((line) => line !== "")
              .join("\n\n"),
        ),

      reason: symbol.rosetta`reason: why classify was invoked; overflow, reactive, context-exceeded`(
        { input: [], output: [sz.foldName], provenance: "source" },
        function () {
          return this.configuration.reason;
        },
      ),
      focus: symbol.rosetta`focus: /compact instructions; empty on auto`(
        { input: [], output: [sz.string], provenance: "source" },
        function () {
          return this.configuration.focus;
        },
      ),
      "kv/get": symbol.rosetta`kv/get: session kv value, or #f`(
        {
          input: [sz.foldName],
          output: [sz.union([sz.string, sz.number, sz.booleanFalse])],
          provenance: "source",
        },
        function (key: string) {
          return kvGet(this.configuration.kv, key);
        },
      ),
      "plan/get": symbol.rosetta`plan/get: working plan text, or #f`(
        { input: [], output: [stringOrFalse], provenance: "source" },
        function () {
          return this.configuration.plan ?? false;
        },
      ),
    };
  },
  prelude: `
(define (tokens/remaining t)
  (- (tokens/total t) (tokens/used t)))

(define (tokens/relative/used t)
  (let ((total (tokens/total t)))
    (if (zero? total) 0 (/ (tokens/used t) total))))

(define (tokens/relative/total t)
  1)

(define (tokens/relative/remaining t)
  (- (tokens/relative/total t) (tokens/relative/used t)))

(define (cells/count t)
  (length (transcript/cells t)))

(define (starts-with s prefix)
  (string-prefix? prefix s))
`,
});

/**
 * Load the strategy with `execState`, then call `compact` / `forced-compact`
 * as host functions with the prefix and full transcripts as arguments. Empty or
 * non-shrinking cards are typed failures — the kernel's "failed to compact"
 * path is the caller's.
 */
export async function applyCompact(
  program: string,
  compactTranscript: Transcript,
  fullTranscript: Transcript,
  opts: CompactStrategyOpts = {},
): Promise<CompactApplyResult> {
  invariant(program.trim() !== "", "compact strategy program is empty");
  const names = opts.forced === true ? (["forced-compact", "compact"] as const) : (["compact"] as const);
  // `(require "compact.prompt")` — the threaded-snapshot strategy is a
  // `.scm` + `.prompt` pair. `require` is a loader symbol, and the loader is
  // jailed under the strategy file's directory (same rule as scheme_repl:
  // `programSourceLoader`). Without these the strategy throws
  // `Unbound variable require` and the compact silently degrades to the fallback.
  const moduleRoot = opts.sourcePath != null && opts.sourcePath !== "" ? dirname(opts.sourcePath) : undefined;
  // `require` only needs the loader. The isolated host is assembled when a
  // parent job and a connection exist; without them a stub strategy still
  // loads, and `dotprompt/run` is not a symbol.
  const connectionId = opts.connectionId ?? "";
  const isolated = moduleRoot != null && opts.job != null && connectionId !== "";
  const state = await execState(program, {
    capabilities:
      moduleRoot == null
        ? [compactReducerCapability]
        : isolated
          ? [compactReducerCapability, promptIsolatedCapability, schemeLoadAliasCapability]
          : [compactReducerCapability, schemeLoadAliasCapability],
    config: {
      ...compactConfig(opts, fullTranscript.cells),
      ...(moduleRoot == null
        ? {}
        : {
            loader: programSourceLoader(moduleRoot),
            dirname: "",
            ...(isolated
              ? {
                  job: opts.job,
                  connectionId,
                  completionModel: opts.completionModel ?? "",
                }
              : {}),
          }),
    },
  });
  const fn = names.map((name) => state.scope.lookup(name)).find(is_callable_value);
  invariant(fn !== undefined, `compact strategy: program does not define ${names.join(" or ")}`);
  const raw = await abortable(() => callLoaded(state.runCtx, fn, compactTranscript, fullTranscript), opts);
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "empty-check-in" };
  }
  const checkIn = raw
    .filter((cell): cell is EatCell => isEatCellValue(cell))
    .map((cell) => (cell instanceof MessageChunk ? cell.asCheckIn() : cell));
  if (checkIn.length === 0) return { ok: false, reason: "empty-check-in" };
  // Prefix occupancy is the gauge; the check-in is fresh content with no gauge.
  const prefixTokens = compactTranscript.tokensUsed();
  const checkInTokens = contentTokensOf(checkIn);
  if (checkInTokens >= prefixTokens) return { ok: false, reason: "did-not-shrink" };
  return { ok: true, checkIn };
}

/**
 * The strategy cannot be interrupted mid-eval, so abort stops waiting for it.
 * A summarizer round it opened joins the abort; the driver owns that round.
 */
async function abortable(run: () => Promise<unknown>, opts: CompactStrategyOpts): Promise<unknown> {
  const signal = opts.signal;
  if (signal == null) return run();
  const before = new Set(opts.job?.children);
  const pending = run();
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      for (const child of opts.job?.children ?? []) {
        if (before.has(child) || !(child instanceof CompletionJob)) continue;
        const round = child.expectation;
        if (round == null || round.isDone) continue;
        void opts.complete?.({ connectionId: round.connectionId, model: round.model, round, signal }).catch(() => {});
      }
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isEatCellValue(value: unknown): value is EatCell {
  return (
    typeof value === "string" ||
    value instanceof CompactJob ||
    value instanceof CompletionExpectation ||
    value instanceof CompletionJob ||
    value instanceof ToolCallJob ||
    value instanceof ProgrammaticJob ||
    value instanceof TurnNotificationChunk ||
    value instanceof TurnApprovalNoteChunk ||
    value instanceof TurnSteerChunk ||
    value instanceof MessageChunk
  );
}

function kvGet(kv: Record<string, string>, key: string): string | number | false {
  const folded = key.startsWith(":") ? key.slice(1) : key;
  const raw = kv[folded] ?? kv[key] ?? kv[`:${folded}`];
  if (raw === undefined) return false;
  if (folded === "compact.keep-tokens" || folded === "compact.keep-turns") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

function compactConfig(opts: CompactStrategyOpts, cells: readonly EatCell[]): CompactConfig {
  return {
    chunks: [...cells],
    reason: opts.reason ?? "overflow",
    focus: opts.focus ?? "",
    kv: { ...(opts.kv ?? {}) },
    plan: opts.plan ?? null,
  };
}

async function callLoaded(
  runCtx: RunContext,
  fn: Parameters<typeof applyCallback>[0],
  compactTranscript: Transcript,
  fullTranscript: Transcript,
): Promise<unknown> {
  const boxed = await applyCallback(
    fn,
    [jsToScheme(runCtx, compactTranscript) as SchemeValue, jsToScheme(runCtx, fullTranscript) as SchemeValue],
    makeCallCtx(runCtx),
  );
  return toJS(boxed);
}
