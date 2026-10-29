// type-hints contracts — the public seam for optional type-hint delivery.
//
// This file defines the stable interfaces (modes, whitelists, lens, selection, rendering).
// Changes here should be accompanied by updates to the design documentation.

/** Whole-feature gate (doc §6/G9): config-level kill switch, default "telemetry".
 *  No per-code granularity by design (G14) — the whitelist is a static constant. */
export type TypeHintsMode = "off" | "telemetry" | "on-error";

/** The whitelisted TS diagnostic codes — each entry below states the mistake class it
 *  covers and its shadowing relationship to sibling codes. Static constant — demotion is a
 *  code edit driven by per-bench-run displaced-rate, never runtime mutation. */
export const HINT_WHITELIST = [
  2322, // kwarg WRONG VALUE TYPE / enum violation — TS fires this code for the mistake, NOT
  // 2345; confirmed by the probe case `(get_route :origin 5 …)`
  2561, // typo'd kwarg, a near name exists (did-you-mean) — shadows 2353 whenever TS finds
  // one; without this whitelist entry the kwargs dividend is structurally unreachable
  2551, // typo'd PROPERTY READ, a near name exists (did-you-mean) — shadows 2339 the same
  // way; needs arrival's diagnose.ts extractPayload arm
  2345, // argument type mismatch / missing required kwarg
  2554, // arg count — too few
  2555, // arg count — too many
  2353, // unknown kwarg, NO near name (object-literal excess property) — fires only after
  // kwargs-shape lowering; 2561 shadows this whenever a near name exists
  2339, // property does not exist, NO near name — 2551 shadows this whenever a near name exists
  2349, // not callable — kept because the quote-datum handling eliminates the one known
  // false-positive class (a nested quoted list's string-literal head getting CALLED, e.g.
  // '(("a" 1)) lowering to a call on "a"); the remaining 2349s are true positives (JSON-bracket
  // arrays, string-head applications)
] as const;

/** A span in the CURRENT PROGRAM's source coordinates (post span-map — scheme offsets,
 *  never TS offsets). */
export interface SchemeSpan {
  readonly start: number;
  readonly end: number;
}

/** One diagnostic as the lens returns it: already span-mapped to scheme coordinates of
 *  the LOWERED UNIT (prelude/context/program concatenation — select.ts applies the
 *  programStartOffset boundary, doc §2/G4). */
export interface MappedDiagnostic {
  readonly code: number;
  /** Span in lowered-unit scheme coordinates. */
  readonly span: SchemeSpan;
  /** The raw TS message — INTERNAL ONLY, never rendered (doc §4: TS never leaks). */
  readonly tsMessage: string;
  /** Structured payload for back-translation, extracted by the lens adapter. */
  readonly expected?: string; // TS type string of the expected type, when applicable
  readonly actual?: string; //  TS type string of the actual type, when applicable
  readonly propertyName?: string; // for 2353/2339
  readonly candidateProperties?: readonly string[]; // closed key set, for did-you-mean
  /** For arity diagnostics (2554/2555): the callee's parameter list, pre-rendered by the
   *  lens adapter in scheme-facing vocabulary — render.ts restates it verbatim. NOTE:
   *  tool calls lower to ONE kwargs object literal (§5), so arity codes fire only for
   *  scheme-defined functions; tool argument mistakes surface as property diagnostics. */
  readonly signatureText?: string;
}

/** The lowered unit descriptor select.ts needs (doc §2). */
export interface LoweredUnit {
  /** Offset where the current program begins — diagnostics before it are suppressed. */
  readonly programStartOffset: number;
  /** Per-statement spans of the CURRENT program, in lowered-unit coordinates, in
   *  statement order (mirrors manifold-tool's splitTopLevel). */
  readonly statementSpans: readonly SchemeSpan[];
}

/** The lens seam (doc §1/G6). One implementation is the spine adapter; tests inject
 *  stubs. diagnose() is called ONCE per manifold call, post statement-loop, only when
 *  ≥1 statement errored (or always, in "telemetry" mode). */
export interface TypeHintLens {
  diagnose(
    programSource: string,
    contextDefines: readonly string[],
  ): Promise<{
    unit: LoweredUnit;
    diagnostics: readonly MappedDiagnostic[];
  }>;
}

/** select() output: at most ONE per errored statement (doc §3/G5), tagged with the
 *  statement index it diagnoses. */
export interface SelectedHint {
  readonly statementIndex: number;
  readonly diagnostic: MappedDiagnostic;
}

/** Selection contract (pure — Ring 1):
 *  1. drop diagnostics with span.start < unit.programStartOffset (context/prelude, G4)
 *  2. drop codes not in HINT_WHITELIST (§3, whitelist-never-blacklist)
 *  3. keep only diagnostics whose span intersects an ERRORED statement's span (§3)
 *  4. per errored statement keep the ONE nearest to the statement start (cap-1, G5) */
export type SelectHints = (
  unit: LoweredUnit,
  diagnostics: readonly MappedDiagnostic[],
  erroredStatementIndexes: readonly number[],
) => readonly SelectedHint[];

/** Rendering contract (pure — Ring 1; doc §4). Returns null when ANY part is
 *  unrenderable (back-translation miss, depth, carrier leak risk) — a skipped hint is
 *  invisible, a wrong hint is poison. The returned string must never contain the TS
 *  carrier vocabulary (Cons<, readonly, Promise<, TS\d{4}, "undefined") — pinned by the
 *  vocabulary-blacklist test. `statementHead` is the failing form's head for the
 *  trailing-block naming (G12), e.g. ":total" or "shop/list-orders". */
export type RenderHint = (hint: SelectedHint, statementHead: string) => string | null;

/** Context-ring contract (Ring 1; doc §2/G3/G13). Lives on the per-rebuild world object
 *  — NOT DoorSession — so listChanged clearing is automatic (G13.2). */
export interface ContextRing {
  /** Record a top-level define whose own evaluation SUCCEEDED. `source` is the statement
   *  text; when it references any tool symbol (a `/`-qualified head anywhere in the
   *  form), the stored entry MUST degrade to `declare const <name>: unknown` (G13.1).
   *  Rebinding an existing name replaces its entry (last-wins). */
  push(name: string, source: string): void;
  /** Entries in insertion order, total length capped at ~8k chars (FIFO eviction,
   *  G13.3). */
  entries(): readonly string[];
}

/** Telemetry event shape (doc §3/G7 + §6). EVERY lens outcome logs exactly one. */
export interface TypeHintTelemetry {
  readonly door: "envelope/type-hint";
  readonly rendered: boolean;
  /** Present iff rendered=false. */
  readonly skip?: "crash" | "race" | "unmappable" | "unrenderable" | "no-diag" | "mode-off";
  readonly code?: number;
  readonly latencyMs?: number;
  /** The manifold call's sequence number (the lens generation counter, G6) — makes
   *  staleness assertable by identity. */
  readonly callSeq?: number;
}

/** Race budget (doc §1/G6): lens result must land within this window of the statement
 *  loop completing, else skip:"race". */
export const HINT_RACE_BUDGET_MS = 300;
