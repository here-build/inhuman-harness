// deliver — Ring 2 orchestration. The post-loop lens race: ONE lens run per manifold call,
// started after the statement loop completes, bounded by HINT_RACE_BUDGET_MS, tagged with a
// per-process generation counter so a call-N result never renders for call N+1.
//
// Exactly ONE telemetry event per lens outcome (G7). Delivery returns the trailing content
// blocks to append (G12 — statement blocks stay byte-identical; a hit arrives as an extra
// block naming its form's head); an empty array means "no hint" (race lost / crash / no-diag
// / mode-suppressed / unrenderable), and the reason is always logged.

import { renderHint } from "./render.js";
import { selectHints } from "./select.js";
import {
  HINT_RACE_BUDGET_MS,
  type MappedDiagnostic,
  type LoweredUnit,
  type TypeHintLens,
  type TypeHintsMode,
  type TypeHintTelemetry,
} from "./types.js";

const DOOR = "envelope/type-hint" as const;

export interface TypeHintDeliveryInput {
  readonly lens: TypeHintLens;
  /** Never "off" — the caller gates that before invoking delivery. */
  readonly mode: TypeHintsMode;
  readonly programSource: string;
  readonly contextDefines: readonly string[];
  /** The current program's statements, in order (mirrors the loop). */
  readonly statements: readonly string[];
  readonly erroredStatementIndexes: readonly number[];
  /** This call's sequence number = the lens generation (G6). */
  readonly callSeq: number;
  /** True iff no LATER call has started since this one (staleness gate, G6). */
  readonly isLatest: () => boolean;
  readonly logTelemetry: (event: TypeHintTelemetry) => void;
}

type Settled = { ok: true; unit: LoweredUnit; diagnostics: readonly MappedDiagnostic[] } | { ok: false };

interface TextBlock {
  type: "text";
  text: string;
}

/** The failing form's HEAD for trailing-block naming (G12): the first token after the
 *  opening paren (`:total`, `shop/list-orders`), or the whole trimmed atom when headless. */
function headOf(statement: string): string {
  const match = /^\(?\s*([^\s()]+)/.exec(statement.trim());
  return match?.[1] ?? statement.trim();
}

/** True iff the diagnostic carries ANY structured payload render.ts can enrich from. A
 *  diagnostic with payload that renderHint still declines (null) has an UNRENDERABLE type
 *  (conditional/mapped/depth>3) — the doc §4 poison-avoidance case, skipped entirely. A
 *  diagnostic with NO payload at all has no type to mistranslate, so a safe generic line is
 *  delivered instead (the wiring surfaces the coinciding whitelisted diagnostic). */
function hasTypePayload(d: MappedDiagnostic): boolean {
  return (
    d.expected !== undefined ||
    d.actual !== undefined ||
    d.propertyName !== undefined ||
    d.candidateProperties !== undefined ||
    d.signatureText !== undefined
  );
}

/** The minimal, carrier-clean fallback line for a payload-less whitelisted diagnostic — a
 *  TRUE, non-specific restatement keyed only on the code family (never a mistranslated type,
 *  so never poison). Production spine diagnostics always carry payload; this is the wiring's
 *  floor so a coinciding whitelisted diagnostic always surfaces SOMETHING.
 *
 *  Each branch ALSO carries a recovery action — the only fact this floor has to work with is
 *  the code family and the failing form's head, so the action names what's already known
 *  (mirrors render.ts's actionFor/unknownPropertyBody/arityBody prose: an action clause, not
 *  free-composed guidance) rather than leaving a bare restatement with nothing to DO next. */
function genericHint(head: string, code: number): string {
  const detail =
    code === 2353
      ? `an unexpected keyword was passed to ${head} — remove the unknown :keyword or check the ` +
        "signature's declared keys"
      : code === 2554 || code === 2555
        ? `${head} was called with the wrong number of arguments — check (${head} ...)'s signature ` +
          "in the tool catalog and match its parameter list"
        : code === 2349
          ? `${head} is not callable — check the tool catalog for the correct symbol name, or a ` +
            "local binding shadowing it"
          : code === 2339
            ? `a field accessed on ${head}'s value does not exist — check the tool catalog for the ` +
              "field this value actually returns"
            : `the arguments to ${head} do not match its expected types — check (${head} ...)'s ` +
              "signature in the tool catalog";
  return `Type (${head}): ${detail}.`;
}

function firstSelectedCode(settled: Settled, input: TypeHintDeliveryInput): number | undefined {
  if (!settled.ok) return undefined;
  const selected = selectHints(settled.unit, settled.diagnostics, input.erroredStatementIndexes);
  return selected[0]?.diagnostic.code;
}

export async function deliverTypeHints(input: TypeHintDeliveryInput): Promise<TextBlock[]> {
  const start = Date.now();
  const latency = (): number => Date.now() - start;

  // The lens run — one in-flight computation, wrapped so a throw becomes {ok:false} (crash)
  // rather than a rejection that could escape as an unhandled rejection.
  const lensRun: Promise<Settled> = input.lens
    .diagnose(input.programSource, input.contextDefines)
    .then((r): Settled => ({ ok: true, unit: r.unit, diagnostics: r.diagnostics }))
    .catch((): Settled => ({ ok: false }));

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"budget">((resolve) => {
    budgetTimer = setTimeout(() => resolve("budget"), HINT_RACE_BUDGET_MS);
  });

  const winner = await Promise.race([lensRun, budget]);

  if (winner === "budget") {
    // Race lost: return no trailing block now; the lens is NOT cancelled (bounded leak, doc
    // §1) — it lands late and still records its outcome (G7), tagged skip:"race". Deliberately
    // fire-and-forget below (the leading `void` already signals this): logging telemetry for a
    // late-arriving result has no value to hand back to a caller who already returned.
    // eslint-disable-next-line promise/always-return
    void lensRun.then((settled) => {
      input.logTelemetry({
        door: DOOR,
        rendered: false,
        skip: "race",
        code: firstSelectedCode(settled, input),
        callSeq: input.callSeq,
        latencyMs: latency(),
      });
    });
    return [];
  }
  if (budgetTimer !== undefined) clearTimeout(budgetTimer);

  const settled = winner;
  if (!settled.ok) {
    input.logTelemetry({ door: DOOR, rendered: false, skip: "crash", callSeq: input.callSeq, latencyMs: latency() });
    return [];
  }
  if (!input.isLatest()) {
    // A newer call superseded this one — its result is stale and must never render (G6).
    input.logTelemetry({
      door: DOOR,
      rendered: false,
      skip: "race",
      code: firstSelectedCode(settled, input),
      callSeq: input.callSeq,
      latencyMs: latency(),
    });
    return [];
  }

  const selected = selectHints(settled.unit, settled.diagnostics, input.erroredStatementIndexes);
  if (selected.length === 0) {
    input.logTelemetry({ door: DOOR, rendered: false, skip: "no-diag", callSeq: input.callSeq, latencyMs: latency() });
    return [];
  }

  if (input.mode === "telemetry") {
    // Config says never render (precision-calibration corpus only, §1) — a would-be hit.
    input.logTelemetry({
      door: DOOR,
      rendered: false,
      skip: "mode-off",
      code: selected[0]!.diagnostic.code,
      callSeq: input.callSeq,
      latencyMs: latency(),
    });
    return [];
  }

  // "on-error", latest, has selectable hits → render each (cap-1 per errored statement).
  const blocks: TextBlock[] = [];
  let renderedCode: number | undefined;
  for (const hint of selected) {
    const head = headOf(input.statements[hint.statementIndex] ?? "");
    const rich = renderHint(hint, head);
    if (rich !== null) {
      blocks.push({ type: "text", text: rich });
      renderedCode ??= hint.diagnostic.code;
    } else if (!hasTypePayload(hint.diagnostic)) {
      // No payload to mistranslate → deliver the safe generic floor.
      blocks.push({ type: "text", text: genericHint(head, hint.diagnostic.code) });
      renderedCode ??= hint.diagnostic.code;
    }
    // else: payload present but its type is UNRENDERABLE (poison risk) → skip this hint.
  }
  if (blocks.length === 0) {
    // Every selected hint had an unrenderable type — a skipped hint is invisible (doc §4).
    input.logTelemetry({
      door: DOOR,
      rendered: false,
      skip: "unrenderable",
      code: selected[0]!.diagnostic.code,
      callSeq: input.callSeq,
      latencyMs: latency(),
    });
    return [];
  }

  input.logTelemetry({ door: DOOR, rendered: true, code: renderedCode, callSeq: input.callSeq, latencyMs: latency() });
  return blocks;
}
