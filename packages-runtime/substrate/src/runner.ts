// runner — the central stateful orchestrator for the doors teaching system.
//
// `createDoorsRunner(options)` returns a `DoorsRunner` with a `run(input)` method that executes
// Scheme expressions against an assembled ambient + persistent lexical scope, enriches errors
// with structured teaching doors, tracks session history, applies futility detection, and
// (optionally) delivers type hints.
//
// The runner owns cross-call state (via injected `session` and `tracker`) so that per-process
// teaching state survives world rebuilds (e.g. tools/listChanged). It is env-lifecycle-agnostic
// and model-agnostic.

import {
  execState,
  parse,
  type EnvCapability,
  type EvalTap,
  type LexicalScope,
  type RunContext,
  type SchemeValue,
} from "@here.build/arrival";
import { createDisplaySink, createNoteSink } from "@here.build/arrival/host-internals";
import { tokenize } from "@here.build/arrival/lsp-internals";
import { APair, AVoid } from "@here.build/arrival/reflect-internals";
import { toSExprString, toSExprStringWithElisions, type ElisionRecord } from "@here.build/arrival-serializer";

import { ArgsFailureTracker } from "./args-failure-tracker.js";
import { renderArgsMisuseTeaching, renderFullSchemaTeaching } from "./args-misuse-door.js";
import { localizeFailingParam } from "./args-misuse.js";
import type { AttachmentSink } from "./attachment-sink.js";
import type { BoundTool, ToolNaming } from "./bound-tool.js";
import { type CalibrationOptions, DEFAULT_CALIBRATION } from "./calibration.js";
import type { ContentBlock } from "./content-block.js";
import { stripTopLevelDisplay } from "./display.js";
import {
  DoorSession,
  emptyExprDoor,
  importDoor,
  isUnterminatedDictLiteral,
  scopeConfusionDoor,
  signatureEchoFor,
  unboundInExprDoor,
  unterminatedDictDoor,
} from "./doors.js";
import { FutilityTracker } from "./futility.js";
import { observationCaps, renderObservationWithElisions } from "./render-observation.js";
import { parseSessionBlob, type SessionBlob } from "./schemas/session-blob.js";
import { createLocalBindingTracker, createSessionHistory, type SessionHistory } from "./session-history.js";
import type { AsyncSessionStore } from "./session-store.js";
import { analyzeStatement, type StatementFacts } from "./statement-facts.js";
import type { DoorStrategies } from "./strategies.js";
import type { ToolJsonSchema } from "./tool-schema.js";
import { createContextRing, type SerializableContextRing } from "./type-hints/context-ring.js";
import { deliverTypeHints } from "./type-hints/deliver.js";
import type { TypeHintLens, TypeHintsMode } from "./type-hints/types.js";
import { unwrapTopLevelBegins } from "./unwrap-begin.js";

/** Extra grace period for the outer timeout race. Used only when evaluation is parked inside
 * a host await (e.g. a stuck upstream tool) that the in-band budget check cannot reach. */
const PARKED_GRACE_MS = 250;

const UNBOUND_VARIABLE = /Unbound variable [`']?([^`'\s]+)/;

const timeoutMessage = (timeoutMs: number): string =>
  `evaluation timed out after ${timeoutMs}ms — the expr did not finish within the evaluation budget. ` +
  `Likely an infinite loop/recursion, or a stuck tool call. The environment is still usable: ` +
  `fix the runaway expression and try again, splitting the work into smaller exprs if needed.`;

// ─── REPL statement splitting ───
const isOpen = (tok: string): boolean =>
  tok === "(" || tok === "[" || tok === "{" || (tok.startsWith("#") && !tok.startsWith("#\\") && tok.endsWith("("));
const CLOSE = new Set([")", "]", "}"]);
const QUOTE_PREFIX = new Set(["'", "`", ",", ",@"]);
const isSkippable = (tok: string): boolean =>
  /^\s+$/.test(tok) || tok.startsWith(";") || tok.startsWith("#|") || tok.startsWith("#;");

function splitTopLevel(source: string): string[] {
  const tokens = tokenize(source, true) as { token: string; offset: number }[];
  const starts: number[] = [];
  let depth = 0;
  let between = true;
  for (const { token, offset } of tokens) {
    if (isSkippable(token)) continue;
    if (between) {
      starts.push(offset);
      between = false;
    }
    if (isOpen(token)) depth++;
    else if (CLOSE.has(token)) {
      if (depth > 0) depth--;
      if (depth === 0) between = true;
    } else if (depth === 0 && !QUOTE_PREFIX.has(token)) {
      between = true;
    }
  }
  return starts.map((s, i) => source.slice(s, starts[i + 1] ?? source.length).trim()).filter(Boolean);
}

/** End offset of the form that starts at `start` — its own closer, not the
 *  enclosing `(begin …)` closer. Used when location-anchored display text would
 *  otherwise slice to EOF after a splice. */
function formEndOffset(source: string, start: number): number {
  const tokens = tokenize(source, true) as { token: string; offset: number }[];
  let depth = 0;
  let end = start;
  let started = false;
  for (const { token, offset } of tokens) {
    if (offset < start) continue;
    if (isSkippable(token)) continue;
    const tokenEnd = offset + token.length;
    started = true;
    if (isOpen(token)) depth++;
    else if (CLOSE.has(token)) {
      if (depth > 0) depth--;
      end = tokenEnd;
      if (depth === 0) return end;
    } else if (depth === 0 && !QUOTE_PREFIX.has(token)) {
      return tokenEnd;
    } else {
      end = tokenEnd;
    }
  }
  return started ? end : start;
}

// ─── Form display text ───
//
// The execution/analysis loop works directly on `forms` (the real parsed `SchemeValue[]` from
// arrival's reader). `splitTopLevel` is retained only to produce human-readable text for
// session history, context rings, signature echoes, and type hints.
//
// Alignment: `forms.length` may differ from the text split count because `#;` datum comments
// are dropped by the real parser but still appear in the lexer split, and because a spliced
// top-level begin keeps inner forms whose source still sits inside the wrapper. The call site
// trusts the text split only when unwrap was a no-op AND the counts match; otherwise it falls
// back to location-anchored slicing (capped at the form's own closer) or `toSExprString`.
// Display text is never used for execution or semantic analysis.

/** The next form (from `fromIndex` onward) that carries `[LOCATION]` metadata, or `undefined` if
 *  none of the remaining forms have one. Looking ahead past location-less forms (rather than only
 *  checking the IMMEDIATE next form) guarantees a form's display-text slice never crosses into a
 *  LATER form's own located text, however many location-less atoms/vectors sit in between. */
function nextLocatedOffset(forms: readonly SchemeValue[], fromIndex: number): number | undefined {
  for (let i = fromIndex; i < forms.length; i++) {
    const f = forms[i];
    if (f instanceof APair) {
      const loc = f.getLocation();
      if (loc !== undefined) return loc.offset;
    }
  }
  return undefined;
}

/** Cosmetic display text for one form — NEVER consulted by `exec`/`analyzeStatement` (both read
 *  `forms` directly at the call site). Prefers a location-anchored slice into the original `expr`
 *  (preserving the statement's exact original formatting/comments); falls back to `toSExprString`
 *  for a form with no location metadata. */
function displayTextFor(form: SchemeValue, index: number, forms: readonly SchemeValue[], expr: string): string {
  if (form instanceof APair) {
    const loc = form.getLocation();
    if (loc !== undefined) {
      const next = nextLocatedOffset(forms, index + 1);
      const end = next ?? formEndOffset(expr, loc.offset);
      return expr.slice(loc.offset, end).trim();
    }
  }
  return toSExprString(form);
}

/** Find the statement number of an earlier top-level `(define name ...)` for the given name. */
function topLevelDefineStatementNumber(
  name: string,
  facts: readonly StatementFacts[],
  beforeIndex: number,
): number | undefined {
  for (let i = 0; i < beforeIndex; i++) {
    if (facts[i]!.definedName === name) return i + 1;
  }
  return undefined;
}

/** True if the error is the bare "Unbound variable" form for a library symbol (not a tool). */
function isLibraryEnriched(raw: string, name: string): boolean {
  const bareWall = `Unbound variable \`${name}'`;
  return raw.startsWith(bareWall) && raw.length > bareWall.length;
}

/** The environment-notes channel's preamble label (E3,
 *  experimental/arrival/packages/arrival-bench/docs/benchmark-defect-register.md §E) — makes
 *  the trailing block unmistakably not part of the answer. */
const NOTES_HEADER = "── environment notes ──";

/** Wrap the accumulated note LINES into ONE trailing content block: a `#| ... |#` reader block
 *  comment (parses to zero forms — pasting it back is a harmless no-op) carrying the labelled
 *  header plus one line per contributing producer. */
function renderEnvironmentNotes(notes: readonly string[]): string {
  return [`#| ${NOTES_HEADER}`, ...notes, "|#"].join("\n");
}

/** ONE line for a call that middle-elided one or more arrays/entries (serializer-elision plan
 *  §6), regardless of how many collections/forms contributed — E2/S5
 *  (experimental/arrival/packages/arrival-bench/docs/benchmark-defect-register.md §E/ADDENDUM).
 *  Per-collection enumeration is the rejected alternative: arrival-serializer already emits an
 *  inline `#| N similar items were not rendered… |#` marker at the exact elision site (strictly
 *  better placement), and a separate enumeration both bloats the output (measured at 33% of one
 *  benchmark file) and READS AS DATA LOSS — both models in the corpus concluded the VALUE itself
 *  had been cut and abandoned the REPL for python. This line's only job is the one fact that
 *  matters: the value is intact. */
function renderElisionNote(elisions: readonly ElisionRecord[]): string | undefined {
  if (elisions.length === 0) return undefined;
  return (
    "large results were sampled for display — the full value is intact in the session; " +
    "bind it and filter/aggregate in-program rather than reading it all."
  );
}

export interface RunInput {
  expr: string;
  /** The call's capability set (stdlib + every bound tool) this call resolves builtins/tools
   *  through — caller-owned. Threaded explicitly on EVERY call (including ones reusing
   *  `runCtx`): `execState` rebuilds/looks up the memoized Vocabulary from
   *  `{capabilities, config}` every time, and a reused `runCtx`'s tuple-identity invariant
   *  checks the result against the run's ORIGINAL vocabulary — a mismatched tuple throws. */
  capabilities: readonly EnvCapability[];
  /** THE SAME config object used to mint `runCtx` — reference identity, not a fresh per-call
   *  object (the vocabulary memo + the reused-runCtx tuple check are both identity-keyed on it). */
  config: Record<string, unknown>;
  /** The call's run — CALLER-owned; this runner never disposes it. Warm-reuse and per-call
   *  disposal are the caller's responsibility (mirrors DiscoveryTool's `warm` map). OPTIONAL:
   *  omit it to let `execState` mint a FRESH `RunContext` for every call (still resolving the
   *  SAME memoized Vocabulary off `{capabilities, config}`) — the right choice whenever a
   *  caller's capabilities declare no per-run resources needing cross-call continuity AND a
   *  per-call live signal must reach a native/rosetta impl's `this.runCtx.signal` (a REUSED
   *  `runCtx`'s `.signal` is fixed at its ORIGINAL mint — see `RunContext`'s own doc — so a
   *  later call's `signal` option never reaches an impl reading `this.runCtx.signal`, only
   *  the trampoline's own per-call budget check). Pass a warm `runCtx` (a session owner mints
   *  one via `execState("(begin)", {capabilities, config, scope})` and holds it) when a
   *  capability's `resources`/cache/effects genuinely need to survive across calls (e.g. the
   *  loader's require-cache) — session continuity for top-level `define`s comes from `scope`
   *  alone either way. */
  runCtx?: RunContext;
  /** The persistent lexical root this call's top-level `define`s land in. Pass the SAME
   *  scope object across calls for REPL-style multi-statement accumulation (a session
   *  owner mints one via `LexicalScope.fresh()` and holds it for the world's lifetime). */
  scope: LexicalScope;
  tools: ReadonlyMap<string, BoundTool>;
  /** Notes the CALLER already knows about this call, seeded into the run's note channel before the
   *  program runs — so a fact the binder learned OUTSIDE the interpreter (the auto-exec bypass's
   *  "I rewrote your bare tool call as X") lands in the SAME consolidated footer as every note the
   *  interpreter itself produces, instead of being stapled on as a bare block ahead of the answer.
   *
   *  A caller that prepends its own block is not merely untidy — it is a SECOND, unlabelled channel.
   *  The model has to learn twice where bookkeeping lives, and the one place it is guaranteed to
   *  look (the answer) gets a non-answer at the top of it. */
  seedNotes?: readonly string[];
  /** Per-call override of `calibration.observationMaxTotalChars`. */
  responseSizeMaxChars?: number;
  /** Per-call evaluation time budget in ms (the WHOLE multi-statement call), already
   *  clamped by the caller. Absent ⇒ `calibration.defaultEvalTimeoutMs`. Same per-call-only,
   *  never-mutates-the-world-default shape as `responseSizeMaxChars`. */
  timeoutMs?: number;
  /** Per-call override for the attachment pass-through quota (manifold's `response-attachments`
   *  arg); irrelevant to a caller with a no-op `AttachmentSink`. */
  attachmentQuota?: number;
  /** OPTIONAL, ADDITIVE — the roster used ONLY to seed context-ring's
   *  tool-valued-define detection (the "have I seen a real tool call in this define's source"
   *  heuristic). Distinct from `tools` because manifold's pre-split behavior kept these two
   *  concerns independent: schema/roster recovery was ALWAYS derived straight off the env
   *  (bind.ts's `toolSchemasForEnv` WeakMap), while `tools`-driven unbound-in-expr resolution
   *  and signature-echo were an explicit OPT-IN the caller had to wire in separately (a
   *  frozen contract — see arrival-manifold's `signature-echo.test.ts`, "a tool built WITHOUT a
   *  signature map never echoes"). Reusing `tools` for both would silently turn that opt-in into
   *  an always-on whenever a caller's `env` merely has real bound tools, which is exactly the
   *  regression this field avoids. Defaults to `tools.keys()` when omitted — a caller that
   *  passes a real `tools` registry needs nothing extra. */
  knownToolNames?: Iterable<string>;
  /** Optional per-form evaluation tap (e.g. an `EvalTrace` — see @here.build/arrival's
   *  `provenance/trace.ts`), threaded straight into every `execState` call this run makes.
   *  The runner is per-CALL and never constructs one: a caller wanting provenance points
   *  to resolve ACROSS calls (a value minted in call 1, read back in call 3) must pass the
   *  SAME tap instance every time — provenance-point ids are minted by the tap itself
   *  (monotonic per tap instance, never global), so a fresh tap per call would both lose
   *  cross-call resolution and risk id collisions with a prior tap's ids read out of
   *  stale values. Absent ⇒ `ctx.currentInvocation` never populates and rosetta wrappers
   *  never mint provenance points (today's behavior, unarmed). */
  tap?: EvalTap;
  /** OPTIONAL, ADDITIVE, substrate-agnostic hook — consulted for every eval error this
   *  call catches, AFTER the built-in doors (unbound-variable / args-misuse) have already
   *  built their teaching text. A returned string is APPENDED to the error observation,
   *  separated by a newline; `undefined` appends nothing (today's behavior, unarmed).
   *  Wrapped in try/catch here — an enricher crash must NEVER mask the real error the
   *  runner is already reporting. The runner stays normalizer-agnostic: this is the one
   *  seam a caller (e.g. arrival-manifold's stringly-collection hint) uses to teach
   *  something about the THROWN error without the substrate knowing what a "collection
   *  op" or a "response format" is. */
  errorEnricher?: (error: unknown) => string | undefined;
}

export interface RunResult {
  content: readonly ContentBlock[];
  isError?: boolean;
}

export interface DoorsRunnerOptions {
  toolNaming: ToolNaming;
  strategies: DoorStrategies;
  attachmentSink: AttachmentSink;
  calibration?: Partial<CalibrationOptions>;
  sessionStore?: AsyncSessionStore;
  sessionId?: string;
  /** Observation rendering mode. "braces" (default) uses `{:k v ...}` / `[a b ...]`.
   *  "sexpr" uses the constructor form `(dict :k v ...)` / `(list a b ...)`. */
  rendering?: "braces" | "sexpr";
  /** Optional type-hints delivery configuration. When present and not "off", type diagnostics
   *  are delivered as trailing content after statement results. */
  typeHints?: { mode: TypeHintsMode; lens: TypeHintLens };
  /** Optional shared `DoorSession` (controls per-shape verbosity and follow telemetry).
   *  Injected by the host so teaching state survives `DoorsRunner` reconstruction on world
   *  rebuilds. If omitted, a private instance is used. */
  session?: DoorSession;
  /** Optional shared `FutilityTracker`. If omitted, futility doors are disabled for this runner. */
  tracker?: FutilityTracker;
  /** Optional shared `ArgsFailureTracker` (args-misuse escalation state, design doc §2.4).
   *  UNLIKE `tracker`, a private instance is constructed when omitted (the `session` precedent,
   *  not the futility one): escalation is intrinsic to the args-misuse door's correctness —
   *  without state every failure would render the lean L1 forever. Inject the host's instance
   *  when reset-on-success must fire (the binder sees tool successes, the runner doesn't) or
   *  when state must survive a world rebuild. */
  argsTracker?: ArgsFailureTracker;
}

/** The serializable teaching state for a `DoorsRunner`. Defined by the Zod schema in
 *  `schemas/session-blob.ts` — the blob is untrusted persisted input, so the schema is
 *  the source of truth for its shape (see that file for the format's forward-compat
 *  rules) and `parseSessionBlob` is the only way in. */

/** Session-scoped stateful runner — NOT a pure function. Holds door session, local-binding
 *  tracker, session-history, context-ring, and call/generation counters across calls to `run()`. */
export interface DoorsRunner {
  run(input: RunInput): Promise<RunResult>;
  /** Serializes the FULL teaching-state bundle to one JSON blob (history, cache, futility rings,
   *  DoorSession dedup, context-ring) — everything `AsyncSessionStore` round-trips. */
  exportSession(): string;
  restoreSession(blob: string): void;
}

export function createDoorsRunner(options: DoorsRunnerOptions): DoorsRunner {
  const calibration: CalibrationOptions = { ...DEFAULT_CALIBRATION, ...options.calibration };
  const { toolNaming, strategies, attachmentSink } = options;

  const session = options.session ?? new DoorSession();
  const tracker = options.tracker;
  const argsTracker = options.argsTracker ?? new ArgsFailureTracker();
  const localBindingTracker = createLocalBindingTracker();
  let callCounter = 0;
  let generation = 0;

  // Context ring needs the tool roster at construction for tool-valued-define degradation.
  // The runner is env-lifecycle-agnostic (tools arrive fresh per call); both stores are
  // seeded lazily from the first call's roster and reused. If the roster varies per call,
  // it is frozen to whatever was seen first.
  let sessionHistory: SessionHistory | undefined;
  let contextRing: SerializableContextRing | undefined;
  let rosterSeeded = false;
  function ensureRosterSeeded(knownToolNames: Iterable<string>): void {
    if (rosterSeeded) return;
    rosterSeeded = true;
    const names = [...knownToolNames];
    sessionHistory = createSessionHistory();
    if (options.typeHints !== undefined) contextRing = createContextRing(names);
  }

  async function run(input: RunInput): Promise<RunResult> {
    ensureRosterSeeded(input.knownToolNames ?? input.tools.keys());
    const history = sessionHistory!;

    const thisCallIndex = ++callCounter;
    attachmentSink.beginCall(input.attachmentQuota);
    // C1b (futility trigger surgery) — mark the call boundary so FutilityTracker can tell
    // "several statements this ONE program wrote, blind to each other's results" apart from
    // "several genuinely separate, model-observed retries" (futility.ts's `beginCall` doc).
    tracker?.beginCall();

    const expr = input.expr;
    if (expr.trim() === "") {
      return {
        content: [{ type: "text", text: session.render(emptyExprDoor(toolNaming), toolNaming.toolName) }],
        isError: true,
      };
    }

    const callMaxTotalChars = input.responseSizeMaxChars ?? calibration.observationMaxTotalChars;
    const timeoutMs = input.timeoutMs ?? calibration.defaultEvalTimeoutMs;

    // Middle-elision (serializer-elision plan) is OPT-IN via `calibration.observationElision` —
    // `render` always returns `elisions` (empty when the knob is unset), so accumulation below
    // is unconditional and costs nothing when the feature is off.
    const render = (value: unknown, maxTotalCharsOverride?: number): { text: string; elisions: ElisionRecord[] } => {
      const effectiveMax = maxTotalCharsOverride ?? calibration.observationMaxTotalChars;
      return options.rendering === "sexpr"
        ? toSExprStringWithElisions(value, observationCaps(effectiveMax, calibration.observationElision))
        : renderObservationWithElisions(value, { maxTotalChars: effectiveMax, ...calibration.observationElision });
    };

    // Derived FRESH from this call's tools (never cached across calls — RunInput.tools is the
    // env-lifecycle-agnostic source of truth for the current world's roster).
    const toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined> = new Map(
      [...input.tools].map(([name, tool]) => [name, tool.schema]),
    );
    const signatureByName: ReadonlyMap<string, string> = new Map(
      [...input.tools].map(([name, tool]) => [name, tool.signature().signatureText]),
    );

    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = (): RunResult => {
      controller.abort();
      return { content: [{ type: "text", text: `Error: ${timeoutMessage(timeoutMs)}` }], isError: true };
    };
    try {
      let forms: readonly SchemeValue[];
      try {
        forms = await parse(expr);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isUnterminatedDictLiteral(message)) {
          return {
            content: [{ type: "text", text: session.render(unterminatedDictDoor(), toolNaming.toolName) }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Error: ${message} — check bracket balance near that point (a stray or missing closer ` +
                "is the usual cause), fix, and resend.",
            },
          ],
          isError: true,
        };
      }

      const parsed = forms;
      forms = unwrapTopLevelBegins(forms);
      if (forms.length === 0) {
        return { content: [] };
      }

      // See the FORM DISPLAY TEXT block above `splitTopLevel` for the alignment rationale.
      // Unwrap returns the same array when it is a no-op; a splice (even one that keeps
      // the form count) must not reuse the text split of the wrapping begin.
      const statements = splitTopLevel(expr);
      const textAligned = forms === parsed && statements.length === forms.length;
      const displayText = forms.map((form, i) => (textAligned ? statements[i]! : displayTextFor(form, i, forms, expr)));

      const statementFacts = forms.map((form) => analyzeStatement(form));
      localBindingTracker.record(
        statementFacts.flatMap((f) => f.localBindings),
        thisCallIndex,
      );

      const parked = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs + PARKED_GRACE_MS);
      });

      const blocks: ContentBlock[] = [];
      let failures = 0;
      const erroredStatementIndexes: number[] = [];
      // Names this program binds into the persistent session scope. Collected to lead the
      // response with a persistence note (below) — the void-result trap: a program
      // ending in `(define x (search …))` otherwise renders NOTHING (the void `define` result
      // is filtered at `!== theVoid`), which a model reads as "the search returned empty" and
      // confabulates from that assumption. Announcing the binding both kills that trap and
      // teaches cross-call persistence proactively.
      const introduced: string[] = [];
      // Elisions collected across EVERY rendered observation this call, from every form —
      // rendered as ONE line in the trailing environment-notes block below (never per-array,
      // never per-form).
      const allElisions: ElisionRecord[] = [];
      // The run's MODEL-FACING NOTE CHANNEL (arrival's values/note-sink.ts). Minted PER CALL and
      // handed to every statement's `execState`, so a tolerance that fires deep inside the
      // interpreter (the kwargs drop, today) can reach the consolidated footer — the only reason
      // that note was invisible before is that it had nowhere to go.
      const noteSink = createNoteSink();
      // The DISPLAY channel (display.ts). A model writes `(display x)` reflexively — the natural
      // Scheme spelling of "show me this". Arrival has no IO (the door is intact for a bare
      // `display` used as a VALUE); the HOST honors the intent instead, so a reflexive display
      // neither errors nor wastes a round.
      const displaySink = createDisplaySink();
      for (const line of input.seedNotes ?? []) noteSink.push(line);

      for (const [index, form] of forms.entries()) {
        const statementText = displayText[index]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return timeoutResult();
        try {
          // COMPLEX tier on purpose: the runner is JS-side TOOLING, not a membrane exit.
          // `exec` (SIMPLE tier) toJS-unwraps every result, which breaks BOTH consumers
          // downstream — the `!== theVoid` filter (box identity gone: void renders as a
          // spurious observation) and the serializer's provenance-aware rendering
          // (ASymbol/AString/Values duck-typing sees plain JS instead of boxed values).
          // `execState` hands back the boxed per-form values this loop actually renders.
          // TOP-LEVEL `(display X)` → X (pass-through: the model asked to see X, and X becomes the
          // answer). NESTED `(display X)` → identity + a recorded echo. A form with no display at
          // all is returned BY IDENTITY, so the common case costs nothing.
          const running = execState(stripTopLevelDisplay(form), {
            capabilities: input.capabilities,
            config: input.config,
            runCtx: input.runCtx,
            scope: input.scope,
            budgetMs: remaining,
            signal: controller.signal,
            tap: input.tap,
            // The run's MODEL-FACING NOTE CHANNEL. Shared across every statement of this call, so a
            // tolerance that fires in statement 1 and again in statement 3 is reported ONCE (the
            // sink dedupes) — the model needs the fact, not a tally.
            notes: noteSink,
            display: displaySink,
          });
          const raced = await Promise.race([running, parked]);
          if (raced === "timeout") {
            const result = timeoutResult();
            running.catch(() => {});
            return result;
          }
          const facts = statementFacts[index]!;
          for (const r of raced.values) {
            // instance-aware, NOT `=== theVoid` — `AVoid.withProvenance()` mints a fresh heap
            // object (AVoid.ts:48-50), so a void re-stamped crossing a tap (provenance tracing)
            // is no longer identity-equal to the singleton. Matches AVoid's own Setoid
            // (`arrival/tagless-final/equals`: `other instanceof AVoid`) and the documented trap
            // in `values/structural-equal.ts` ("provenance-clone trap... use instance-aware
            // checks"). A void that slips through here renders as the JS-unwrapped literal text
            // "undefined".
            if (r instanceof AVoid) continue;
            const { text, elisions } = render(r, callMaxTotalChars);
            blocks.push({ type: "text", text });
            allElisions.push(...elisions);
          }
          // THE DISPLAY ECHO — after THIS statement's own result, because that is when the display
          // happened. A NESTED `(display X)` returned X untouched (composition unaffected) and
          // recorded what it saw; here we show the model what it asked to see, carrying the ORIGINAL
          // EXPRESSION so several displays in one statement stay distinguishable:
          //
          //     #| (display (list 1 2 3)):  (1 2 3) |#
          //
          // A TOP-LEVEL `(display X)` produces NOTHING here — the wrap was stripped before eval, so
          // X's value IS the statement's result above. Echoing it beside itself would be noise.
          // Rendered inside `#| … |#`, a reader comment that parses to ZERO forms: the model can
          // paste the whole observation back and it remains a no-op.
          for (const rec of displaySink.drain()) {
            const shown = render(rec.value as SchemeValue, callMaxTotalChars).text;
            blocks.push({ type: "text", text: `#| ${rec.src}:  ${shown} |#` });
          }
          if (facts.definedName !== undefined) {
            history.push(facts.definedName, statementText);
            contextRing?.push(facts.definedName, statementText);
            introduced.push(facts.definedName);
          }
        } catch (error) {
          erroredStatementIndexes.push(index);
          const raw = error instanceof Error ? error.message : String(error);
          if (raw.includes("execution budget exceeded")) return timeoutResult();
          let text = `Error: ${raw}`;
          const unbound = UNBOUND_VARIABLE.exec(raw);
          if (unbound) {
            const attempted = unbound[1]!;
            const qualifiedToolNames = [...signatureByName.keys()];
            const door = unboundInExprDoor(
              attempted,
              qualifiedToolNames,
              input.tools,
              toolNaming,
              toolSchemas,
              calibration.doorsTier3Top,
            );
            if (door) {
              text += session.enrichInline(door, attempted);
            } else if (!isLibraryEnriched(raw, attempted)) {
              // THE IMPORT-FORM DOOR (doors.ts's `importDoor`) — consulted after unboundInExprDoor
              // (a tool literally named `import`/`scheme` is implausible, but a tool-resolution
              // door still takes precedence by design) and before scopeConfusionDoor (an
              // import/scheme unbound was never top-level-defined or locally bound by the model,
              // so that classifier would fall through to undefined anyway — this catches it first
              // with the actually-relevant lesson instead of leaving the bare wall untaught).
              const importForm = importDoor(attempted);
              if (importForm) {
                text += session.enrichInline(importForm, attempted);
              } else {
                const scopeDoor = scopeConfusionDoor({
                  name: attempted,
                  topLevelDefineStatementNumber: topLevelDefineStatementNumber(attempted, statementFacts, index),
                  firstErrorStatementNumber: Math.min(...erroredStatementIndexes) + 1,
                  localBindingCallIndexes: localBindingTracker.occurrences(attempted),
                  currentCallIndex: thisCallIndex,
                });
                if (scopeDoor) text += session.enrichInline(scopeDoor, attempted);
              }
            }
          } else {
            // THE ARGS-MISUSE PIPELINE (design doc §2.1-§2.4). Gated by the same
            // signature-echo decision as before (misuse shape + exactly one implicated tool
            // + a known signature — the strategies.ts seams a positional consumer overrides).
            // When the failure LOCALIZES to one param (args-misuse.ts, fed by the binder's
            // membrane metadata via strategies.argsOfError), the L1/L2/L3 teaching replaces
            // the generic Example line — the model's own call beats a stub — and `Signature:`
            // still rides below it. When it doesn't, today's Signature + Example fallback is
            // byte-identical (the do-no-harm guard), with the ⊥ counter escalating a
            // repeatedly-unlocalizable tool to the full-schema backstop at L2+.
            const echo = signatureEchoFor(statementText, raw, signatureByName, input.tools, strategies.isMisuseError);
            if (echo) {
              const schema = toolSchemas.get(echo.tool);
              const metadata = strategies.argsOfError?.(error);
              const sentArgs = metadata?.qualifiedName === echo.tool ? metadata.sentArgs : undefined;
              const localized = localizeFailingParam(raw, sentArgs, schema);
              if (localized) {
                const level = argsTracker.recordFailure(echo.tool, localized.path);
                const body = renderArgsMisuseTeaching({ qualifiedName: echo.tool, sentArgs, localized, level });
                text += session.appendArgsTeaching(echo.tool, localized.path.join("."), level, body);
                text += session.echoSignature(echo.tool, echo.signatureText);
              } else {
                const level = argsTracker.recordFailure(echo.tool, undefined);
                const example = strategies.synthesizeExample(echo.tool, schema);
                text += session.echoSignature(echo.tool, echo.signatureText, example);
                if (level >= 2) {
                  text += session.appendArgsTeaching(
                    echo.tool,
                    "⊥",
                    level,
                    renderFullSchemaTeaching(echo.tool, schema),
                  );
                }
              }
            }
          }
          // GENERIC ERROR-ENRICHER HOOK (RunInput.errorEnricher) — consulted last, after
          // every built-in door has already had its say, so a hint rider never displaces
          // the unbound-variable/args-misuse teaching (both are additive on `text`
          // already; this is one more addition, never a replacement). Never throws: an
          // enricher crash must not mask the real error this catch is already reporting.
          if (input.errorEnricher) {
            try {
              const hint = input.errorEnricher(error);
              if (hint) text += `\n${hint}`;
            } catch {
              // Swallow — see comment above.
            }
          }
          blocks.push({ type: "text", text });
          failures += 1;
        }
      }

      // E3 (experimental/arrival/packages/arrival-bench/docs/benchmark-defect-register.md §E) —
      // every note-shaped producer accumulates here instead of interleaving PEER TEXT BLOCKS with
      // real data, and renders as exactly ONE trailing block (`renderEnvironmentNotes`, below).
      // Order is declaration order — introduced-binding first, then elision, then
      // futility/duplicate advisories, then the attachment sink's note.
      const notes: string[] = [];

      // The persistence note when this program bound anything into session scope (see
      // `introduced` above) — renders the binding FACT even when every bound form was a void
      // `define` with no other observation (the void-result trap). Deduped, declared order.
      // B3 (ADDENDUM) — when NOTHING else was observed this call (no value, no error — every
      // statement was a bare binding), say so explicitly: without it a model reads the bare
      // banner as success and loses a round assuming something executed.
      if (introduced.length > 0) {
        const names = [...new Set(introduced)].join(", ");
        const nothingElseRan = blocks.length === 0 ? " (nothing was executed — these are bindings only)" : "";
        notes.push(`${names} — also available in subsequent calls.${nothingElseRan}`);
      }

      // ONE line for every array/entries collection middle-elided this call (any form, any
      // observation) — serializer-elision plan §6. Never emitted when nothing elided (the
      // `observationElision` calibration knob is off, or every observation fit).
      const elisionLine = renderElisionNote(allElisions);
      if (elisionLine !== undefined) notes.push(elisionLine);

      if (tracker) {
        for (const { tool, door } of tracker.drainPending()) {
          notes.push(session.renderNote(door, tool));
        }
      }

      if (options.typeHints !== undefined && options.typeHints.mode !== "off") {
        const callSeq = ++generation;
        const trailing = await deliverTypeHints({
          lens: options.typeHints.lens,
          mode: options.typeHints.mode,
          programSource: expr,
          contextDefines: contextRing?.entries() ?? [],
          statements: displayText,
          erroredStatementIndexes,
          callSeq,
          isLatest: () => callSeq === generation,
          logTelemetry: (event) => session.logTypeHint(event),
        });
        // Substantive per-statement type teaching, not bookkeeping — stays as its own block(s),
        // ahead of the environment-notes footer (like real attachment content, below).
        for (const block of trailing) blocks.push(block);
      }

      for (const block of attachmentSink.drainBlocks()) blocks.push(block);
      // The attachment sink's own note (e.g. "N binary attachments captured") joins the
      // consolidated channel — it is bookkeeping about this call, exactly like the others above.
      const attachmentNote = attachmentSink.drainNote();
      if (attachmentNote !== undefined) notes.push(attachmentNote);

      // Interpreter-side notes (the kwargs tolerance's dropped-key note). Bookkeeping ABOUT the
      // call, not a result OF it — so it joins the consolidated channel exactly like the others.
      for (const line of noteSink.drain()) notes.push(line);

      if (notes.length > 0) blocks.push({ type: "text", text: renderEnvironmentNotes(notes) });

      if (failures === forms.length) return { content: blocks, isError: true };
      session.observeSuccess(expr);
      return { content: blocks };
    } finally {
      clearTimeout(timer);
    }
  }

  function exportSession(): string {
    ensureRosterSeeded([]);
    const blob: SessionBlob = {
      v: 1,
      history: sessionHistory!.entries(),
      cache: {},
      futility: tracker?.exportState() ?? [],
      localBindings: localBindingTracker.exportState(),
      doorSession: session.exportState(),
      contextRing: contextRing?.exportEntries() ?? [],
      argsFailures: argsTracker.exportState(),
    };
    return JSON.stringify(blob);
  }

  function restoreSession(blob: string): void {
    const parsed = parseSessionBlob(JSON.parse(blob) as unknown);
    ensureRosterSeeded([]);
    sessionHistory!.restoreEntries(parsed.history);
    tracker?.importState(parsed.futility);
    localBindingTracker.importState(parsed.localBindings);
    session.importState(parsed.doorSession);
    contextRing?.restoreEntries(parsed.contextRing);
    argsTracker.importState(parsed.argsFailures ?? { entries: [] });
  }

  return { run, exportSession, restoreSession };
}
