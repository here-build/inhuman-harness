// normalizer/hint-door — the STRINGLY-COLLECTION teaching door (Montessori: teach on
// contact, model decides). Wired as substrate's
// generic `RunInput.errorEnricher` hook (runner.ts): when a collection op (take/map/
// vector-ref/reduce/car/…) refuses a STRING operand that ACTUALLY round-trip-parses as a
// known format — or DERIVES from a tool response that does — the error observation gains
// a hint rider teaching the parser functions, instead of leaving the model to guess or
// silently confabulate structure that was never there.
//
// Two probes, tried in order:
//   1. FRAGMENT — does the offending string itself parse (`detectParse`)? The common
//      case: the model bound a tool's raw response and applied a collection op to it
//      directly, never parsing first.
//   2. ORIGIN — the offending string does NOT parse on its own, but carries non-empty
//      `.provenance` back to a tool-response invocation whose OWN resolved value parses
//      (or is already structured). The reconstruction move: the model sliced/derived a
//      fragment (`substring`, `string-append`, …) before ever parsing the whole thing.
//
// Neither probe succeeds → `undefined` (no hint). The floor: prose is prose — never
// phrase a guess as a fact (errors-as-doors discipline).
//
// Escalation: verbose (three-line, teaching) once per (toolName × format) PER ENRICHER
// INSTANCE — `createStringlyCollectionEnricher` is constructed once per `ManifoldEnv`
// (manifold-tool.ts, same lifetime as the `EvalTrace` it closes over), so this is
// effectively once per session. Every later occurrence of the SAME (tool, format) pair
// renders one terse line instead — mirroring substrate's `DoorSession` per-shape
// first-occurrence verbosity gate (doors.ts), reimplemented here as a plain `Set<string>`
// because this closure has no access to that session's shared gate (it's a standalone
// function handed to `RunInput.errorEnricher`, not a `Door` rendered through `DoorSession`).

import { EMPTY_PROVENANCE } from "@here.build/arrival";
import type { EvalTrace } from "@here.build/arrival/provenance";
import { AString, offendingValueOf } from "@here.build/arrival/reflect-internals";

import { detectParse } from "./detect.js";

/** Bounded walk over an offending value's provenance set when hunting for a parsing
 *  ORIGIN — mirrors `OFFENDING_VALUE_MAX_CAUSE_DEPTH`'s "bounded, not unbounded" shape
 *  (errors.ts): a pathological fan-in provenance set must never turn one error render
 *  into an unbounded trace walk. */
const MAX_ORIGIN_POINTS_CHECKED = 3;

/** Every scheme-callable parser this door ever points the model at (normalizer/prelude.ts's
 *  bound names) — rendered verbatim in the verbose hint's "Available:" line. */
const AVAILABLE_PARSERS = "parse-json, parse-csv, parse-toon, parse-py-literal, detect-parse, detect-envelope";

/** The offending value's JS string form + its provenance, or `undefined` when the value
 *  isn't a string at all (boxed or plain) — the door only ever teaches about STRINGS. An
 *  `AString` carries the provenance the origin probe needs; a plain (unboxed) JS string —
 *  reachable post bare-value-purge on some call paths — carries none, so the origin probe
 *  simply never fires for it (fragment probe still can). */
function offendingStringOf(value: unknown): { text: string; provenance: ReadonlySet<number> } | undefined {
  if (value instanceof AString) return { text: value.valueOf(), provenance: value.provenance };
  if (typeof value === "string") return { text: value, provenance: EMPTY_PROVENANCE };
  return undefined;
}

/** The scheme prelude function name (normalizer/prelude.ts) for a `ParseOutcome.format`
 *  tag — csv/tsv share ONE parser (`parse-csv` takes an optional delimiter internally;
 *  the door never needs to distinguish them), everything else is 1:1. `detect-parse` is
 *  the fallback for a format tag this door doesn't recognize (defensive — every real
 *  `detectParse`/`detectEnvelope` outcome, and the synthetic "structured" tag below, are
 *  covered by name; nothing else should reach here). */
function parseFnNameFor(format: string): string {
  switch (format) {
    case "json":
      return "parse-json";
    case "csv":
    case "tsv":
      return "parse-csv";
    case "toon":
      return "parse-toon";
    case "python-literal":
      return "parse-py-literal";
    default:
      return "detect-parse";
  }
}

/** Human-facing record/key count for the verbose hint's parenthetical — an array counts
 *  as records (CSV/TOON/NDJSON/a JSON array), a plain object counts as keys (a JSON
 *  object), anything else (a JSON scalar can never reach here — `detectParse` refuses
 *  scalar-yield) falls back to a neutral "1 value". */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} record${value.length === 1 ? "" : "s"}`;
  if (value !== null && typeof value === "object") {
    const n = Object.keys(value as Record<string, unknown>).length;
    return `${n} key${n === 1 ? "" : "s"}`;
  }
  return "1 value";
}

/** First bound tool name reachable from `provenance` — the fragment probe's tool
 *  attribution (the offending string IS the tool response, no reconstruction needed). */
function firstToolName(provenance: ReadonlySet<number>, trace: EvalTrace): string | undefined {
  for (const pointId of provenance) {
    const name = trace.toolNameFor(pointId);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** One resolved parsing origin: the tool that produced it, the format its FULL resolved
 *  value parses as (or the synthetic `"structured"` tag when the resolved value was never
 *  a string to begin with — the model sliced a stringified view of an already-structured
 *  response), and the parsed/structured value itself (for the shape count). */
interface ParsingOrigin {
  toolName: string;
  format: string;
  value: unknown;
}

/** THE ORIGIN PROBE — walk `provenance` (bounded) looking for a producing invocation whose
 *  OWN resolved value (retained on the invocation because it's a provenance point — see
 *  `trace.ts`'s `#pruneChildProvenance`, which explicitly SPARES a point's own value from
 *  the leaf-GC pass) parses, or is already structured. First hit wins; an unresolvable or
 *  nameless point is skipped rather than aborting the walk (a mixed-provenance value, e.g.
 *  `string-append`ing two tool responses, should still find whichever source parses). */
function firstParsingOrigin(provenance: ReadonlySet<number>, trace: EvalTrace): ParsingOrigin | undefined {
  let checked = 0;
  for (const pointId of provenance) {
    if (checked >= MAX_ORIGIN_POINTS_CHECKED) break;
    checked++;
    const invocation = trace.invocationById(pointId);
    if (invocation === undefined) continue;
    const toolName = trace.toolNameFor(pointId);
    if (toolName === undefined) continue;

    const resolved = offendingStringOf(invocation.value);
    if (resolved !== undefined) {
      const outcome = detectParse(resolved.text);
      if (outcome.ok) return { toolName, format: outcome.format, value: outcome.value };
      continue;
    }
    // The origin's OWN resolved value isn't a string at all — the model took a STRING
    // derived from an ALREADY-STRUCTURED tool response (e.g. sliced a display/debug
    // stringification). Origin is structured; no parse needed, hint directly.
    if (invocation.value !== undefined) {
      return { toolName, format: "structured", value: invocation.value };
    }
  }
  return undefined;
}

/** Render the verbose (first-occurrence, teaching) hint. */
function renderVerbose(toolName: string | undefined, format: string, shape: string, derived: boolean): string {
  const toolRef = toolName === undefined ? "a tool" : `(${toolName} …)`;
  const firstLine =
    derived || format === "structured"
      ? `;; hint: this string DERIVES from ${toolRef}'s response; the FULL response ${
          format === "structured" ? "is already structured" : `parses as ${format}`
        } — parse the response itself before slicing.`
      : `;; hint: this string came from ${toolRef}'s response and parses as ${format} (${shape}).`;
  if (format === "structured") {
    return [firstLine, `;;   Read the tool's response directly — it's already a dict/vector, never a string.`].join(
      "\n",
    );
  }
  return [
    firstLine,
    `;;   (detect-parse resp) parses it — or (${parseFnNameFor(format)} resp) for the specific reason on refusal.`,
    `;;   Available: ${AVAILABLE_PARSERS}.`,
  ].join("\n");
}

/** Render the terse (repeat-occurrence) one-liner — same (tool, format) pair already
 *  taught in full this session. */
function renderTerse(toolName: string | undefined, format: string, derived: boolean): string {
  const toolRef = toolName === undefined ? "the tool's" : `${toolName}'s`;
  return format === "structured"
    ? `;; hint (again): this string derives from ${toolRef} response, which is already structured — read it directly.`
    : derived
      ? `;; hint (again): this string derives from ${toolRef} response, which parses as ${format} — see (detect-parse resp).`
      : `;; hint (again): this string parses as ${format} — see (${parseFnNameFor(format)} resp) / (detect-parse resp).`;
}

/** Build the STRINGLY-COLLECTION enricher for one session's `EvalTrace` — the
 *  `RunInput.errorEnricher` (substrate runner.ts) closure. Construct ONCE per
 *  `ManifoldEnv` (manifold-tool.ts wires it alongside `trace`'s own opt-in) so the
 *  per-(tool,format) escalation state is session-scoped, matching the trace it reads. */
export function createStringlyCollectionEnricher(trace: EvalTrace): (error: unknown) => string | undefined {
  const seen = new Set<string>();

  const render = (toolName: string | undefined, format: string, shape: string, derived: boolean): string => {
    const key = `${toolName ?? "?"}::${format}`;
    if (seen.has(key)) return renderTerse(toolName, format, derived);
    seen.add(key);
    return renderVerbose(toolName, format, shape, derived);
  };

  return (error: unknown): string | undefined => {
    const offending = offendingStringOf(offendingValueOf(error));
    if (offending === undefined) return undefined;

    // FRAGMENT PROBE — the offending string parses on its own.
    const fragment = detectParse(offending.text);
    if (fragment.ok) {
      const toolName = firstToolName(offending.provenance, trace);
      return render(toolName, fragment.format, shapeOf(fragment.value), false);
    }

    // ORIGIN PROBE — the fragment refuses; walk provenance for a parsing (or already-
    // structured) ancestor. No provenance ⇒ nothing to reconstruct from — floor: prose
    // is prose, never phrase a guess as a fact.
    if (offending.provenance.size === 0) return undefined;
    const origin = firstParsingOrigin(offending.provenance, trace);
    if (origin === undefined) return undefined;
    return render(origin.toolName, origin.format, shapeOf(origin.value), true);
  };
}
