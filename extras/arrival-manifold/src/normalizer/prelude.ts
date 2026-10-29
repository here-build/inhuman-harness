// normalizer/prelude — the scheme-facing prelude functions for the response-normalizer's
// inferred zone ("Parsers as first-class prelude
// functions ... pure, inline-usable on any value"). Every recognizer below the declared
// zone (A2 structuredContent, the grandfathered single-text-block JSON.parse) is
// MODEL-INVOKED, never automatic — the model suspects a tool's opaque text round-trips as
// CSV/TOON/Python-literal/JSON and calls the matching function itself, or reaches for
// `detect-parse` to try all of them in priority order. This module owns none of the
// recognizer logic (that's json.ts/csv.ts/toon.ts/python-literal.ts/detect.ts) — it is
// purely the string→ParseOutcome→(value | throw) lift those recognizers
// need to become scheme-callable, values-or-conditions functions.
//
// Design law carried over unchanged from every module this one wraps: strict-or-refuse.
// The wrapped recognizers never guess; a refusal here is not an exceptional condition to
// apologize for, it is the routine "wrong format, try another" outcome — which is exactly
// why it surfaces as a THROWN recoverable Error (errors-as-doors) rather than a `{ok:...}`
// record: a scheme caller wants the parsed value or a condition it can catch/branch on,
// never a boolean it has to remember to check: the
// `(csv (read-file "x.csv"))` reads only if a bad parse throws instead of
// silently handing back a refusal record the caller forgot to test).
//
// Binding shape: this module deliberately stops at plain named JS functions plus a
// descriptor array (`NORMALIZER_PRELUDE_SYMBOLS`) — see the file-level comment on that
// export for why. Nothing here imports
// `symbol`/`scheme-zod`/`EnvCapability`; wiring these into the assembled ambient (a
// `symbol.rosetta` call per descriptor, mirroring bind.ts's `validatorDef`) is the
// maintainer's integration step, not this module's.

import { parseCsvStrict } from "./csv.js";
import { detectEnvelope, detectParse, type EnvelopeValue } from "./detect.js";
import { parseJsonStrict, type ParseOutcome } from "./json.js";
import { parsePythonLiteralStrict } from "./python-literal.js";
import { parseToonStrict } from "./toon.js";

/** Every wrapper below shares this shape: run a strict recognizer, return its value on
 *  success, else throw a recoverable Error whose message is `${formatLabel}: ${reason}` —
 *  the format name prefixed onto the recognizer's own refusal reason, so a caller who
 *  calls several of these in sequence (or reads a caught error off `detect-parse`'s
 *  hint) can tell which parser spoke without re-deriving it from message text alone. */
function valueOrThrow(formatLabel: string, outcome: ParseOutcome): unknown {
  if (outcome.ok) return outcome.value;
  throw new Error(`${formatLabel}: ${outcome.reason}`);
}

/** `(parse-json s)` — strict JSON only: object/array
 *  top-level only, scalar-yield refused. Throws (recoverable) naming why on invalid JSON
 *  or a scalar result. */
export function parseJson(s: string): unknown {
  return valueOrThrow("json", parseJsonStrict(s));
}

/** `(parse-csv s)` — strict CSV/TSV (§4.1): identifier-like header, ≥2 data rows,
 *  consistent column count > 1. Throws (recoverable) naming why — e.g. the address-list
 *  counterexample (§4.1, audit F5) refuses because its "header" row is prose, not
 *  identifiers. */
export function parseCsv(s: string): unknown {
  return valueOrThrow("csv", parseCsvStrict(s));
}

/** `(parse-toon s)` — strict TOON (`name[N]{col,col}:` + delimited rows, §4.2). Throws
 *  (recoverable) naming why, including the truncation gate: the declared `[N]` must equal
 *  the actual row count, else the text isn't TOON (or is truncated). */
export function parseToon(s: string): unknown {
  return valueOrThrow("toon", parseToonStrict(s));
}

/** `(parse-py-literal s)` — strict Python `str(dict)`/`str(list)` repr (§4.2):
 *  single-quoted strings, `True`/`False`/`None`, STRING keys only. Throws (recoverable)
 *  naming why — tuples/sets and int-keyed dicts are refused because they don't
 *  round-trip, and a bare top-level scalar stays opaque (parsing `None` to null would
 *  lie about a legitimate empty-cell readout, §4.2). */
export function parsePyLiteral(s: string): unknown {
  return valueOrThrow("py-literal", parsePythonLiteralStrict(s));
}

/** The four format-specific functions' scheme names, in the same priority order
 *  `detectParse` (detect.ts) tries them — surfaced in {@link detectParseValue}'s refusal
 *  hint so a caller who gets "no recognized format" knows exactly what to try next
 *  instead of re-deriving the family from memory. */
const FORMAT_SPECIFIC_HINT = "(parse-json s), (parse-csv s), (parse-toon s), (parse-py-literal s)";

/** `(detect-parse s)` — tries every format-specific recognizer in priority order
 *  (json → ndjson → csv → toon → python-literal, detect.ts) and returns the first
 *  match's value. Throws (recoverable) with reason "no recognized format" plus a
 *  one-line hint listing the format-specific functions to try individually (each names
 *  its OWN refusal reason; `detect-parse` alone can only report that none matched). */
export function detectParseValue(s: string): unknown {
  const outcome = detectParse(s);
  if (outcome.ok) return outcome.value;
  throw new Error(`${outcome.reason} — try one of ${FORMAT_SPECIFIC_HINT} individually for the specific reason`);
}

/** `(detect-envelope s)` — the end-anchored prose+embedded-STRUCTURE recognizer (§4.2):
 *  finds a JSON (or CSV/TOON line-run) structure anchored at one end of `s`, and returns
 *  the `{raw, value, prefix?, suffix?}` envelope as a plain object — the shell IS
 *  model-visible per §4.2 ("faithfulness in an unreachable field would be asymmetric
 *  context-stripping"), unlike Stage C/D's internal `.value`-only view of the same
 *  outcome. Throws (recoverable) when no anchor is found, or when both ends anchor
 *  (ambiguous — a mid-string span would need two fuzzy boundaries, never trusted). */
export function detectEnvelopeValue(s: string): EnvelopeValue {
  const outcome = detectEnvelope(s);
  if (outcome.ok) return outcome.value;
  throw new Error(outcome.reason);
}

/** One entry the maintainer's binder can turn into a `symbol.rosetta` (or equivalent)
 *  scheme-callable definition — `name` is the kebab-case scheme identifier, `description`
 *  is the one-line Montessori-style catalog/prelude-docs teaching string, and `fn` is the
 *  plain JS implementation: a single string argument in, the parsed value out, or a
 *  thrown recoverable Error. */
export interface NormalizerPreludeSymbol {
  name: string;
  description: string;
  fn: (s: string) => unknown;
}

/** The complete inferred-zone parser pack, as plain
 *  descriptors rather than pre-bound `SymbolDeclaration`s.
 *
 * Binding-shape decision: bind.ts's only `symbol.rosetta` call sites are
 * tool-specific — `rosettaDef` closes over a `RemoteTool.invoke`, wraps every rejection
 * in `ARGS_REJECTION` membrane metadata, and runs the attestation dance
 * (unattested-arg tracking, `CallCtx`); `validatorDef` (the closest pure-function
 * precedent, the `s/*` family) is `bind.ts`-private and built against
 * `NAME_DOC_TEMPLATE`, itself an unexported module-local constant. Neither is a general
 * "bind a pure JS function as a scheme symbol" entry point this module could call
 * without reaching into bind.ts's internals or duplicating its tagged-template
 * plumbing, and bind.ts is maintainer-owned integration territory, not something this
 * module edits or forks. So this pack stops
 * at the boundary every OTHER normalizer module already stops at (json.ts/csv.ts/
 * toon.ts/python-literal.ts/detect.ts export plain functions over `ParseOutcome`, no
 * `SymbolDeclaration` in sight): plain named functions above, plus this descriptor array
 * naming the scheme identifier and teaching line for each. The maintainer's binder maps
 * each entry through its own `symbol.rosetta(...)({input:[z.dynamic], output:[z.dynamic]}, fn)`
 * (or whatever the manifold's next capability-assembly pass consumes) exactly the way
 * `validatorDef` does for `s/*` today. */
export const NORMALIZER_PRELUDE_SYMBOLS: readonly NormalizerPreludeSymbol[] = [
  {
    name: "parse-json",
    description:
      "Strictly parse a JSON string into an object or array; refuses (throws, recoverable) on invalid JSON " +
      "or a scalar-yield result (numbers/strings/booleans stay opaque, never silently coerced) — a refusal " +
      "names why.",
    fn: parseJson,
  },
  {
    name: "parse-csv",
    description:
      "Strictly parse a CSV/TSV string into a vector of records; refuses (throws, recoverable) unless " +
      "header+rows validate — a refusal names why.",
    fn: parseCsv,
  },
  {
    name: "parse-toon",
    description:
      "Strictly parse a TOON-encoded string (`name[N]{col,col}:` + delimited rows) into a vector of records; " +
      "refuses (throws, recoverable) unless the declared [N] matches the actual row count — a refusal names " +
      "why.",
    fn: parseToon,
  },
  {
    name: "parse-py-literal",
    description:
      "Strictly parse a Python str(dict)/str(list) repr (single-quoted strings, True/False/None, string keys " +
      "only) into a value; refuses (throws, recoverable) on tuples, sets, int-keyed dicts, or a bare top-level " +
      "scalar — a refusal names why.",
    fn: parsePyLiteral,
  },
  {
    name: "detect-parse",
    description:
      "Try json, csv, toon, and py-literal in that priority order and return the first match's value; " +
      "refuses (throws, recoverable) with 'no recognized format' plus a hint listing the format-specific " +
      "functions to try individually for the specific reason.",
    fn: detectParseValue,
  },
  {
    name: "detect-envelope",
    description:
      "Find prose wrapped around an end-anchored JSON (or CSV/TOON line-run) structure and return " +
      "{raw, value, prefix?, suffix?} with the parsed value model-visible; refuses (throws, recoverable) " +
      "when nothing anchors at either end, or when both ends anchor (ambiguous).",
    fn: detectEnvelopeValue,
  },
];
