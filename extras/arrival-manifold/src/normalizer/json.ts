// normalizer/json — strict JSON and NDJSON recognizers for the response normalizer.
// Pure, zero-dependency, refusal-first:
// every function here either returns a confidently-typed value or refuses with a reason —
// never a best-effort guess. A refusal costs the caller nothing but a fallback path; a
// silent misparse costs the model a corrupted value it will trust. That asymmetry is the
// whole design law (strict-or-refuse), so ambiguous input always loses to REFUSED.
//
// This module holds the shared `ParseOutcome` contract every other normalizer recognizer
// (CSV/TSV, TOON, Python-literal, prose-envelope) imports.

/** Every recognizer in the normalizer returns this shape. `ok:true` carries the parsed
 *  value and a `format` tag (used by Stage D / the shape store, §8, to detect a format
 *  flip); `ok:false` carries a reason a caller can surface verbatim — never a thrown
 *  exception, since a refusal here is a routine "try the next recognizer" outcome, not
 *  an error. */
export type ParseOutcome = { ok: true; value: unknown; format: string } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names a JSON value's top-level kind for refusal reasons — never invents a fourth
 *  bucket; every JSON value is exactly one of these four. */
function jsonKind(value: unknown): "array" | "null" | "object" | string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Strict JSON: `JSON.parse` succeeds AND the top-level result is an object or array.
 *
 * Scalar-yield (number/string/boolean/null) is REFUSED, not returned as-is. A text block
 * `"123"` is a quoted id or a zip code — its author chose the string form. Parsing it to
 * the number `123` while a sibling `"0123"` fails to parse (JSON numbers forbid leading
 * zeros) makes the outcome depend on digit content: two structurally-identical-looking
 * values, one silently retyped and one not. That's the exact corruption the normalizer
 * audit (F3, NEW-6) called out, and the reason strict-or-refuse exists —
 * a refused scalar costs a caller nothing (it already had the raw string); a coerced one
 * is silent type drift the model has no way to detect. */
export function parseJsonStrict(s: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(s);
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${(error as Error).message}` };
  }
  // typeof narrows out every scalar (number/string/boolean) in one check; JSON.parse's
  // scalar `null` is also typeof "object" so it needs the explicit === null arm.
  if (value === null || typeof value !== "object") {
    return {
      ok: false,
      reason: `JSON parsed to a scalar (${jsonKind(value)}), not an object or array — scalar-yield is refused, never silently coerced`,
    };
  }
  return { ok: true, value, format: "json" };
}

/** Strict NDJSON/JSONL: at least 2 non-empty lines,
 *  and EVERY non-empty line parses as a JSON OBJECT — never an array, never a scalar.
 *
 *  One non-object line disqualifies the whole payload as NDJSON (the caller falls back to
 *  parseJsonStrict on the single line it actually is, or leaves the payload opaque) — a
 *  loose "most lines look like JSON" reading would silently drop or mistype the odd line
 *  instead of refusing the misclassification outright. A single object line is plain JSON,
 *  not a series; the ≥2 gate is what makes NDJSON's own claim ("this is a series of
 *  records") true rather than assumed from one sample.
 *
 *  Blank lines between records are TOLERATED (filtered out before the line-count and
 *  per-line checks) — an NDJSON emitter's trailing/interstitial blank lines are formatting,
 *  not payload. */
export function parseNdjsonStrict(s: string): ParseOutcome {
  const lines = s.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return {
      ok: false,
      reason: `NDJSON requires at least 2 non-empty lines, found ${lines.length} — a single line is plain JSON, use parseJsonStrict`,
    };
  }

  const objects: Record<string, unknown>[] = [];
  for (const [i, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return { ok: false, reason: `NDJSON line ${i + 1} is not valid JSON: ${(error as Error).message}` };
    }
    if (!isPlainObject(value)) {
      return {
        ok: false,
        reason: `NDJSON line ${i + 1} parsed to a ${jsonKind(value)}, not an object — every line must be an object, else it isn't NDJSON`,
      };
    }
    objects.push(value);
  }
  return { ok: true, value: objects, format: "jsonl" };
}
