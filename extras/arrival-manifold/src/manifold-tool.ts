// manifold-tool — the ONE MCP tool a manifold server exposes. THIN WRAPPER: `describe()`
// owns the MCP tool schema (binder-side concern); `call()` builds a `RunInput` and
// delegates every statement-eval / door / futility / session-history / type-hints
// mechanism to a `DoorsRunner` (@inhuman.tools/substrate), constructed ONCE per tool.

import type { EnvCapability, LexicalScope, RunContext } from "@here.build/arrival";
import type { EvalTrace } from "@here.build/arrival/provenance";
import {
  createDoorsRunner,
  DEFAULT_CALIBRATION,
  DEFAULT_OBSERVATION_MAX_TOTAL_CHARS,
  DoorSession,
  invalidArgsDoor,
  KWARGS_STRATEGIES,
  type ArgsFailureTracker,
  type BoundTool,
  type CalibrationOptions,
  type ContentBlock,
  type DoorsRunner,
  type FutilityTracker,
  type ObservationElisionCalibration,
  type TypeHintLens,
  type TypeHintsMode,
} from "@inhuman.tools/substrate";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  DEFAULT_PASSTHROUGH_ATTACHMENTS,
  MAX_PASSTHROUGH_ATTACHMENTS,
  type AttachmentCollector,
} from "./attachments.js";
import { findArgsRejection, toolSchemasForRun, type BypassResolution } from "./bind.js";
import {
  ARG_NAME,
  EVAL_TIMEOUT_ARG_NAME,
  RESPONSE_ATTACHMENTS_ARG_NAME,
  RESPONSE_SIZE_ARG_NAME,
  TOOL_NAME,
} from "./names.js";
import { createStringlyCollectionEnricher } from "./normalizer/hint-door.js";

/** Default per-eval wall-clock budget (10 min). Sized so a genuinely slow upstream tool
 *  (a slow PubMed/ClinicalTrials call inside a multi-statement program) finishes rather than
 *  the REPL seam converting slow-tool-latency into a hard eval timeout the native arm never
 *  sees. Divergent compute (`(define (f) (f)) (f)`) is caught by the same whole-call clock.
 *  Per-call adjustable via the `eval-timeout-ms` arg. */
const DEFAULT_EVAL_TIMEOUT_MS = 600_000;

/** Clamp bounds for the optional per-call `eval-timeout-ms` argument. Same "clamp silently +
 *  banner states the applied budget" shape as `clampResponseSize`. */
export const EVAL_TIMEOUT_MIN_MS = 1000;
export const EVAL_TIMEOUT_MAX_MS = 1_800_000;

function clampEvalTimeout(requested: number): number {
  return Math.min(EVAL_TIMEOUT_MAX_MS, Math.max(EVAL_TIMEOUT_MIN_MS, Math.trunc(requested)));
}

/** Clamp bounds for the optional per-call `response-size` argument. Out-of-range
 *  requests clamp SILENTLY (never a call-blocking error), but the banner states the
 *  applied budget verbatim, so a clamp is never a silent reinterpretation (doors
 *  discipline). */
export const RESPONSE_SIZE_MIN_CHARS = 1000;
export const RESPONSE_SIZE_MAX_CHARS = 40_000;

function clampResponseSize(requested: number): number {
  return Math.min(RESPONSE_SIZE_MAX_CHARS, Math.max(RESPONSE_SIZE_MIN_CHARS, Math.trunc(requested)));
}

/** Clamp bounds for the optional per-call `response-attachments` argument (per-call
 *  only; never mutates the world default; same "clamp silently + banner" shape as
 *  `clampResponseSize`). */
const RESPONSE_ATTACHMENTS_MIN = 0;
const RESPONSE_ATTACHMENTS_MAX = MAX_PASSTHROUGH_ATTACHMENTS;

function clampAttachmentQuota(requested: number): number {
  return Math.min(RESPONSE_ATTACHMENTS_MAX, Math.max(RESPONSE_ATTACHMENTS_MIN, Math.trunc(requested)));
}

/** Tool naming threaded into the runner (replaces doors.ts's direct names.ts import). */
const TOOL_NAMING = { toolName: TOOL_NAME, argName: ARG_NAME };

/** The manifold's own middle-elision defaults. A 100-item array rendered ~93-deep with a
 *  tiny `+N more` marker buried at the very end reads to the model as a complete result,
 *  with the answer sitting in the hidden tail — the failure mode these defaults exist to
 *  prevent. A small per-array display cap (`maxItems`) plus a generous
 *  `topLevelArrayLimit`/`secondLevelArrayLimit` means a moderately-sized array (≤100) still
 *  renders in FULL — only genuinely long arrays middle-elide, with a loud marker + a trailing
 *  note (runner.ts) instead of a buried footnote. ADJUSTABLE: a caller overrides via
 *  `options.calibration.observationElision` (any subset — unset fields keep the default). */
export const DEFAULT_MANIFOLD_OBSERVATION_ELISION: ObservationElisionCalibration = {
  maxItems: 20,
  topLevelArrayLimit: 50,
  secondLevelArrayLimit: 50,
  elideHead: 5,
  elideTail: 5,
};

export interface ManifoldToolOptions {
  /** Per-CALL wall-clock budget in ms (the WHOLE multi-statement call, never reset
   *  per statement). Default {@link DEFAULT_EVAL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Observation rendering: "braces" (default) uses the model-facing observation
   *  formatter; "sexpr" uses Arrival serializer-native notation. */
  rendering?: "braces" | "sexpr";
  /** Observation size budget. Defaults to {@link DEFAULT_OBSERVATION_MAX_TOTAL_CHARS}. */
  observation?: { maxTotalChars?: number };
  /** Opt-in metadata prompt-fields on the schema. Both default OFF (the focused-
   *  reasoning substrate helps weaker models; dead weight on strong ones). Never
   *  parsed/executed — purely advisory strings to the model. */
  promptFields?: { intent?: boolean; successCriteria?: boolean };
  /** Per-server-process door session (verbosity gate + follow telemetry); survives a
   *  listChanged rebuild. Absent ⇒ private per-tool. */
  session?: DoorSession;
  /** Per-server-process futility tracker; survives a listChanged rebuild. Absent ⇒ no
   *  futility detection. */
  tracker?: FutilityTracker;
  /** Per-server-process args-misuse escalation tracker; survives a listChanged rebuild.
   *  Must be the SAME instance `buildManifoldEnv` received (its reset-on-success fires at
   *  the invoke seam). Absent ⇒ the runner constructs a private one (escalation still works
   *  within this tool's lifetime; success-resets never fire). */
  argsTracker?: ArgsFailureTracker;
  /** Per-server-process attachment collector; adapted to the runner's SDK-free
   *  `AttachmentSink` seam below. Absent ⇒ binary blocks still stub in-value but
   *  nothing passes through as a response content block. */
  attachments?: AttachmentCollector;
  /** The bound-tool registry (`toBoundTools(bindEnv)`). Absent ⇒ empty registry
   *  (every door degrades to its "nothing bound" fallback). */
  tools?: ReadonlyMap<string, BoundTool>;
  /** Env-side bypass-resolution map, serialized onto `describe()`'s returned Tool
   *  at `_meta.bypassResolution` for the python bridge. */
  bypassResolution?: ReadonlyMap<string, BypassResolution>;
  /** Type hints — the type-layer as an error-reporting surface. Absent ⇒ entirely inert. */
  typeHints?: { mode: TypeHintsMode; lens: TypeHintLens };
  /** Deployment calibration override (futility ring size, response-size clamp,
   *  timeout, observation budget, hint race budget). Absent ⇒
   *  `DEFAULT_CALIBRATION`. */
  calibration?: Partial<CalibrationOptions>;
  /** EXPLICIT OPT-IN — the world's per-session provenance tap (bind.ts's
   *  `ManifoldEnv.trace`), threaded straight into every `runner.run()` call as
   *  `RunInput.tap`. Deliberately a caller-supplied OPTION rather than a structural
   *  field on `ManifoldWorldEnv`: a `ManifoldEnv` (bind.ts) carries a `trace` of its
   *  own, but auto-inheriting it whenever a caller happens to pass the WHOLE build
   *  product (not a destructured `{ ambient, scope }` pair) would silently arm
   *  provenance for every existing call site — and arrival-serializer's rendering is
   *  provenance-AWARE by design (serializer.ts: a non-empty-provenance AValue keeps
   *  its `{provenance, kind, ...}` envelope instead of unwrapping to plain JS), so
   *  arming changes the model-visible OBSERVATION TEXT, not just internal state.
   *  Pass `manifoldEnv.trace` here only when the caller actually wants that. Absent
   *  ⇒ no tap — `ctx.currentInvocation` never populates and rosetta wrappers mint no
   *  provenance points (today's unarmed behavior, byte-identical rendering). */
  trace?: EvalTrace;
}

export interface ManifoldTool {
  describe(): Tool;
  /** `seedNotes` is INTERNAL (the binder's auto-exec bypass): facts the binder learned about this
   *  call OUTSIDE the interpreter, which must land in the run's consolidated notes footer rather
   *  than as a separate block prepended to the answer. Not part of the model-facing tool schema. */
  /** `args` is the raw MCP call arguments object — deliberately `Record<string, unknown>`,
   *  not a typed bag: every field this reads is runtime-guarded at the point of use
   *  (`typeof === "number"` for the numeric knobs, `invalidArgsDoor` for the program
   *  itself), so a precise interface here would only be an unverified claim about
   *  wire data. `undefined` when the call carries no arguments. */
  call(args: Record<string, unknown> | undefined, seedNotes?: readonly string[]): Promise<CallToolResult>;
}

/** Plain-JSON shape of {@link BypassResolution}, one entry per bare-name form. */
export type SerializedBypassResolution = Record<
  string,
  { kind: "unique"; qualified: string } | { kind: "ambiguous"; candidates: readonly string[]; globalCollision?: string }
>;

function serializeBypassResolution(resolution: ReadonlyMap<string, BypassResolution>): SerializedBypassResolution {
  return Object.fromEntries(resolution);
}

/** Adapt manifold's `AttachmentCollector` (CallToolResult-shaped, SDK-facing) to the
 *  runner's SDK-free `AttachmentSink` seam. `ContentBlockish` is a duck-typed
 *  superset of `ContentBlock` (both `{type, text, data, mimeType, resource}`);
 *  every captured block came from a REAL `CallToolResult`, so it already conforms. */
function toAttachmentSink(attachments: AttachmentCollector | undefined) {
  return {
    beginCall(quota?: number): void {
      attachments?.beginCall(quota ?? DEFAULT_PASSTHROUGH_ATTACHMENTS);
    },
    drainBlocks(): readonly ContentBlock[] {
      return (attachments?.drainBlocks() ?? []) as readonly ContentBlock[];
    },
    drainNote(): string | undefined {
      return attachments?.drainNote();
    },
  };
}

/** The tuple a manifold world hands `createManifoldTool` — the assembled capability set
 *  (stdlib + every bound tool), the shared config bag, the world's run, and the
 *  persistent lexical root a REPL session's top-level `define`s accumulate into. A
 *  `ManifoldEnv` (bind.ts) satisfies this structurally (it carries all four fields, plus
 *  signatures/toolParts unused here), so callers may pass either the narrowed tuple or
 *  the whole `ManifoldEnv`. */
export interface ManifoldWorldEnv {
  capabilities: readonly EnvCapability[];
  config: Record<string, unknown>;
  runCtx: RunContext;
  scope: LexicalScope;
}

/** MVP fallback: recover the roster of bound-tool NAMES straight off `runCtx`'s world via
 *  `toolSchemasForRun`. Deliberately narrower than a full registry — `options.tools`
 *  (server.ts's `toBoundTools(manifoldEnv)`) powers the signature echo, which is an
 *  explicit OPT-IN (pinned by `signature-echo.test.ts`: a tool built WITHOUT a
 *  registry never echoes). Feeding this roster into `options.tools` too would silently
 *  flip that opt-in into an always-on the moment the world has real bound tools. */
function knownToolNamesFromRun(runCtx: RunContext): readonly string[] {
  return (toolSchemasForRun(runCtx) ?? []).map(([name]) => name);
}

export function createManifoldTool(
  worldEnv: ManifoldWorldEnv,
  catalog: string,
  options: ManifoldToolOptions = {},
): ManifoldTool {
  const { capabilities, config, runCtx, scope } = worldEnv;
  const { trace } = options;
  // Same opt-in gate as `trace` itself (SAME field: no trace ⇒ no enricher, byte-identical
  // default behavior) — constructed ONCE per tool so the stringly-collection door's
  // per-(tool,format) escalation state is session-scoped, matching the trace it reads.
  const stringlyCollectionEnricher = trace ? createStringlyCollectionEnricher(trace) : undefined;
  const maxTotalChars = options.observation?.maxTotalChars;
  const responseSizeDefault = maxTotalChars ?? DEFAULT_OBSERVATION_MAX_TOTAL_CHARS;
  const tools: ReadonlyMap<string, BoundTool> = options.tools ?? new Map();
  // Only used when the caller didn't opt into a real registry (see above for why this
  // is narrower than `tools`).
  const knownToolNames = options.tools ? undefined : knownToolNamesFromRun(runCtx);

  const calibration: Partial<CalibrationOptions> = {
    ...options.calibration,
    defaultEvalTimeoutMs: options.timeoutMs ?? options.calibration?.defaultEvalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS,
    observationMaxTotalChars:
      maxTotalChars ?? options.calibration?.observationMaxTotalChars ?? DEFAULT_CALIBRATION.observationMaxTotalChars,
    observationElision: options.calibration?.observationElision ?? DEFAULT_MANIFOLD_OBSERVATION_ELISION,
  };

  // Resolve `session` HERE (not via the runner's fallback) so the SAME instance backs
  // both the runner's internal door rendering AND the envelope/invalid-args door
  // below — invalid-args validation happens in THIS wrapper (the shape of `raw` is a
  // binder-owned concern), but its verbosity gate must share the runner's per-session
  // first-occurrence Set, not a second independent one.
  const session = options.session ?? new DoorSession();

  const runner: DoorsRunner = createDoorsRunner({
    toolNaming: TOOL_NAMING,
    // The kwargs defaults + the ONE binder-owned addition: the membrane-metadata read
    // (bind.ts attaches {qualifiedName, sentArgs} to a rejected invoke; findArgsRejection
    // walks the evaluator's Error.cause wrap) — the args-misuse door's sent-args ground truth.
    strategies: { ...KWARGS_STRATEGIES, argsOfError: findArgsRejection },
    attachmentSink: toAttachmentSink(options.attachments),
    calibration,
    session,
    tracker: options.tracker,
    argsTracker: options.argsTracker,
    typeHints: options.typeHints,
    rendering: options.rendering,
  });

  return {
    describe(): Tool {
      const properties: Record<string, { type?: string; description: string }> = {};
      if (options.promptFields?.intent) {
        properties.intent = {
          type: "string",
          description:
            "Optional but recommended. A compact, one-line description of what you plan to do with " +
            "this call — for observability and tracing.",
        };
      }
      if (options.promptFields?.successCriteria) {
        properties.successCriteria = {
          type: "string",
          description:
            "Optional but recommended. What would make the series of calls you are running DONE — " +
            'the concrete condition you are working toward (e.g. "have the venue name and two ' +
            'restaurants within 100m"). Restate it on each call; when your results already satisfy ' +
            "it, stop calling tools and give your final answer. Never parsed or executed.",
        };
      }
      const program = {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description:
          'A Scheme program: one or more expressions to evaluate, e.g. (github/search-issues :query "bug" :limit 5). ' +
          "Pass either one string, or an array of expression strings — an array is executed all at once " +
          "as the same single program, in order. One result is returned per top-level form.",
      };
      properties[RESPONSE_SIZE_ARG_NAME] = {
        type: "integer",
        description:
          `Optional. Response character budget for this call (default ${responseSizeDefault}, ` +
          `max ${RESPONSE_SIZE_MAX_CHARS}). Responses are smart-compacted by default: collections and ` +
          "long strings are structurally reduced to fit, with an inline marker (e.g. `N items were not " +
          "rendered; total array length is TOTAL`, `…(+N chars)`) showing exactly what was cut — a long " +
          "array shows only its head and tail, never a near-complete-looking dump; this structural cap " +
          "does not lift with a bigger budget. " +
          "Only increase this if you have a specific, rationalized need to see a bigger response at once — " +
          "larger responses can cause attention drift and increase costs for the user. " +
          "Prefer filtering/reducing in the REPL over raising the budget.",
      };
      properties[RESPONSE_ATTACHMENTS_ARG_NAME] = {
        type: "integer",
        description:
          "Optional. How many image/binary attachments from tool results to include in this response " +
          `(default ${DEFAULT_PASSTHROUGH_ATTACHMENTS}, max ${MAX_PASSTHROUGH_ATTACHMENTS}). Attachments cost ` +
          "tokens on every subsequent turn — request more only when you specifically need to see them.",
      };
      properties[EVAL_TIMEOUT_ARG_NAME] = {
        type: "integer",
        description:
          `Optional. Evaluation time budget for THIS call in milliseconds (default ${calibration.defaultEvalTimeoutMs}, ` +
          `max ${EVAL_TIMEOUT_MAX_MS}). The default is already generous for slow upstream tools; the budget covers ` +
          "the WHOLE program (all statements). Raise it only when a specific tool is known to be very slow; " +
          "lower it to fail fast.",
      };
      return {
        name: TOOL_NAME,
        description: catalog,
        inputSchema: { type: "object", properties: { ...properties, [ARG_NAME]: program }, required: [ARG_NAME] },
        ...(options.bypassResolution
          ? { _meta: { bypassResolution: serializeBypassResolution(options.bypassResolution) } }
          : {}),
      };
    },

    async call(args: Record<string, unknown> | undefined, seedNotes?: readonly string[]): Promise<CallToolResult> {
      const requestedResponseAttachments = args?.[RESPONSE_ATTACHMENTS_ARG_NAME];
      const attachmentQuota =
        typeof requestedResponseAttachments === "number" && Number.isFinite(requestedResponseAttachments)
          ? clampAttachmentQuota(requestedResponseAttachments)
          : DEFAULT_PASSTHROUGH_ATTACHMENTS;

      const raw: unknown = args?.[ARG_NAME] ?? args?.expr;
      // ENVELOPE DOOR (invalid args) — binder-owned: the shape of `raw` depends on the
      // binder's call-args convention, not the runner (RunInput.expr is a plain joined
      // string once this gate passes). Renders through the SAME `session` as the
      // runner, so the first-occurrence verbosity gate is shared.
      const isStringArray = Array.isArray(raw) && raw.every((s) => typeof s === "string");
      if (typeof raw !== "string" && !isStringArray) {
        const text = session.render(invalidArgsDoor(raw, TOOL_NAMING), TOOL_NAME);
        return { content: [{ type: "text", text }], isError: true };
      }
      const expr = typeof raw === "string" ? raw : (raw as string[]).join("\n");

      const requestedResponseSize = args?.[RESPONSE_SIZE_ARG_NAME];
      const responseSizeMaxChars =
        typeof requestedResponseSize === "number" && Number.isFinite(requestedResponseSize)
          ? clampResponseSize(requestedResponseSize)
          : undefined;

      const requestedTimeout = args?.[EVAL_TIMEOUT_ARG_NAME];
      const timeoutMs =
        typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout)
          ? clampEvalTimeout(requestedTimeout)
          : undefined;

      try {
        // Arm the runaway-loop cap for THIS run. The tap is per-SESSION (shared across every REPL
        // call so provenance resolves across them), so without this the cap counts session-lifetime
        // steps — and a single legitimate runaway loop pinned it at the ceiling FOREVER, killing every
        // later call including `(+ 1 2)` and every MCP tool (see EvalTrace.beginRun). The guard must
        // be able to end a program, never a session.
        trace?.beginRun();
        // Deliberately OMITS `runCtx`: the world's `runCtx` (above) is a probe run, read only
        // for its `.vocabulary` (knownToolNamesFromRun) — reusing it here would freeze every
        // call's abort signal at THAT mint (`RunContext.signal` is fixed at construction; see
        // `RunInput.runCtx`'s own doc), silently breaking bind.ts's `rosettaDef` forwarding
        // (`tool.invoke(args, this.runCtx.signal)`) to the REAL upstream MCP request — the
        // wire-level cancellation `server.test.ts`'s abort-signal suite proves. Manifold's
        // "manifold" capability declares no per-run `resources` needing cross-call continuity,
        // so a FRESH `RunContext` per call (still resolving the SAME memoized Vocabulary off
        // `{capabilities, config}`) costs nothing and keeps the live signal correct; `scope`
        // alone already gives REPL-style top-level `define` continuity.
        const result = await runner.run({
          expr,
          capabilities,
          config,
          scope,
          tools,
          responseSizeMaxChars,
          timeoutMs,
          attachmentQuota,
          knownToolNames,
          tap: trace,
          errorEnricher: stringlyCollectionEnricher,
          seedNotes,
        });
        return { content: result.content as CallToolResult["content"], ...(result.isError ? { isError: true } : {}) };
      } finally {
        // Provenance GC (execute → consume → dump): every consumer of this call's trace
        // (the stringly-collection enricher, door rendering) has run inside runner.run,
        // so the invocation graph — which retains every tool call's FULL boxed value at
        // its provenance point — is dumped here, bounding heap at single-call scale (the
        // OOM driver is WITHIN-task accumulation, not across-task). Session semantics
        // survive by design: the session's truth is the statement log + effect cache
        // (re-execution model), never the trace. clear() throws while an
        // eval is still open — exactly the timeout path, whose abandoned eval finishes
        // in the background; skipping the dump there is correct (the next call's finally
        // clears), so the guard exception is swallowed deliberately.
        try {
          trace?.clear();
        } catch {
          /* abandoned-timeout eval still running — next call's clear() takes it */
        }
      }
    },
  };
}
