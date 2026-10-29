// normalizer/detect — the composition layer over the four strict recognizers
// (json.ts, csv.ts, toon.ts, python-literal.ts): whole-string format detection
// (`detectParse`) and the end-anchored prose+embedded-STRUCTURE envelope recognizer
// (`detectEnvelope`).
//
// Design law inherited from every recognizer this module composes: strict-or-refuse. A
// refusal is free (the caller still has the raw text); a misparse is silent corruption
// the model has no way to detect. Neither export here adds parsing logic of its own —
// `detectParse` is pure delegation in a fixed priority order, and `detectEnvelope`'s only
// original logic is *where to cut* a prose/structure boundary, never *how to parse* what's
// on either side of the cut (that's always delegated back to `detectParse`/`parseJsonStrict`).

import { parseCsvStrict } from "./csv.js";
import { parseJsonStrict, parseNdjsonStrict, type ParseOutcome } from "./json.js";
import { parsePythonLiteralStrict } from "./python-literal.js";
import { parseToonStrict } from "./toon.js";

/**
 * Whole-string format detection (the inferred zone's `detect-parse`). Pure delegation — every recognizer already validates and refuses
 * on its own terms; this function owns no parsing logic, only the priority order recognizers
 * are attempted in.
 *
 * Priority is significant, not arbitrary:
 *   1. JSON            — cheapest check (`JSON.parse` + typeof) and by far the most common
 *                         shape (§3: `structuredContent`/A2 already prefers this everywhere).
 *                         A JSON array of N objects IS JSON, full stop — it must never fall
 *                         through to NDJSON just because each element also looks like an
 *                         NDJSON row (that would be format ambiguity presented as certainty).
 *   2. NDJSON           — only reachable once whole-string JSON has already refused. A
 *                         single JSON document (even a multi-line-formatted one, or a bare
 *                         array) is caught by #1 first; NDJSON requires ≥2 lines that are
 *                         each independently a JSON *object* and nothing more.
 *   3. CSV/TSV          — tabular text recognizer (header-plausibility gated, §4.1).
 *   4. TOON             — token-dense tabular format; checked after CSV since TOON requires
 *                         its own distinctive `[N]{...}:` header syntax that CSV text would
 *                         never falsely satisfy.
 *   5. Python-literal   — `str(dict)`/`str(list)` reprs; checked last as the loosest of the
 *                         five grammars (single-quote strings, bare True/False/None) and the
 *                         narrowest in applicability (§4.2: "systemic on Python/FastMCP").
 *
 * First `ok:true` wins. All five refusing is not a distinct outcome — it's the same
 * refusal shape every recognizer already returns, generalized to "no recognized format".
 */
export function detectParse(s: string): ParseOutcome {
  const json = parseJsonStrict(s);
  if (json.ok) return json;

  const ndjson = parseNdjsonStrict(s);
  if (ndjson.ok) return ndjson;

  const csv = parseCsvStrict(s);
  if (csv.ok) return csv;

  const toon = parseToonStrict(s);
  if (toon.ok) return toon;

  const pythonLiteral = parsePythonLiteralStrict(s);
  if (pythonLiteral.ok) return pythonLiteral;

  return { ok: false, reason: "no recognized format" };
}

/** The `{raw,value,prefix|suffix}` envelope shell. The
 *  shell's own keys never enter Stage C/D's observed type `T` — callers must read `.value`
 *  for that, and only surface `raw`/`prefix`/`suffix` for model-visibility/faithfulness.
 *  `format` names which recognizer matched the structural span (`detectParse`'s own
 *  `ParseOutcome.format`) — carried through so a caller latching an observed-signature
 *  annotation (server.ts's auto-present) doesn't have to re-derive it. */
export type EnvelopeValue = { raw: string; value: unknown; format: string; prefix?: string; suffix?: string };

export type EnvelopeOutcome = { ok: true; value: EnvelopeValue } | { ok: false; reason: string };

/** Half-open `[start, end)` span of a top-level, JSON-string-quote-aware balanced
 *  bracket group (`{...}` or `[...]`) within a larger string. */
interface Span {
  start: number;
  end: number;
}

/** A validated structure or line-run candidate anchored at one end of the string. */
interface Candidate {
  /** Index (in the ORIGINAL string) where the candidate's own text starts. */
  spanStart: number;
  /** Index (in the ORIGINAL string) one past where the candidate's own text ends. */
  spanEnd: number;
  raw: string;
  value: unknown;
  format: string;
}

/**
 * Finds every top-level (nesting depth 0→1→0) `{...}`/`[...]` bracket span in `s`,
 * respecting JSON string quoting/escapes so a brace inside a string literal is never
 * mistaken for structure (the "`}\nfoo` inside a JSON string value" hazard). Bracket TYPE
 * matching is deliberately not enforced here (a `[`...`}` mismatch still forms a
 * candidate span) — that correctness is `parseJsonStrict`'s job on the extracted text;
 * this scanner only needs to find *candidate* boundaries, never decide validity.
 *
 * Multiple adjacent top-level spans are possible (`{"a":1} and also {"b":2}` yields two) —
 * that plurality is exactly the signal the ambiguity check downstream needs.
 */
function findTopLevelBracketSpans(s: string): Span[] {
  const spans: Span[] = [];
  let inString = false;
  let depth = 0;
  let spanStart = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      if (ch === "\\") {
        i++; // skip the escaped character; the `for` loop's own i++ advances past the backslash
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) spanStart = i;
      depth++;
      continue;
    }
    if ((ch === "}" || ch === "]") && depth > 0) {
      depth--;
      if (depth === 0 && spanStart !== -1) {
        spans.push({ start: spanStart, end: i + 1 });
        spanStart = -1;
      }
    }
  }
  return spans;
}

/** Only the FIRST bracket span can possibly be BOF-anchored (it's the earliest-occurring
 *  one); it qualifies only if nothing but whitespace precedes it AND its text passes
 *  `parseJsonStrict` (structure only, never a scalar — §4.2, audit F4). */
function tryBracketPrefixCandidate(s: string, spans: readonly Span[]): Candidate | undefined {
  const first = spans[0];
  if (first === undefined) return undefined;
  const leadingWhitespace = s.length - s.trimStart().length;
  if (first.start !== leadingWhitespace) return undefined;
  const text = s.slice(first.start, first.end);
  const outcome = parseJsonStrict(text);
  if (!outcome.ok) return undefined;
  return { spanStart: first.start, spanEnd: first.end, raw: text, value: outcome.value, format: outcome.format };
}

/** Mirror of {@link tryBracketPrefixCandidate}: only the LAST bracket span can be
 *  EOF-anchored. */
function tryBracketSuffixCandidate(s: string, spans: readonly Span[]): Candidate | undefined {
  const last = spans.at(-1);
  if (last === undefined) return undefined;
  const trailingWhitespace = s.length - s.trimEnd().length;
  if (last.end !== s.length - trailingWhitespace) return undefined;
  const text = s.slice(last.start, last.end);
  const outcome = parseJsonStrict(text);
  if (!outcome.ok) return undefined;
  return { spanStart: last.start, spanEnd: last.end, raw: text, value: outcome.value, format: outcome.format };
}

/** Splits `s` into physical lines, each line INCLUDING its own trailing `\n` (the final
 *  line omits one only if the string doesn't end in a newline). Concatenating the pieces
 *  losslessly reconstructs `s` — required so line-run boundaries map back to exact
 *  character offsets in the original string for prefix/suffix slicing. */
function splitLinesKeepingNewlines(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charAt(i) === "\n") {
      lines.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

/** Character offset (in `s`) where each line starts; `offsets[i]` is the start of
 *  `lines[i]`, and `offsets[lines.length]` is `s.length`. */
function lineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [0];
  let offset = 0;
  for (const line of lines) {
    offset += line.length;
    offsets.push(offset);
  }
  return offsets;
}

/**
 * The line-based mirror of the bracket scan, for formats that aren't bracket-delimited
 * (CSV/TOON, §4.2's "Trials:\n<csv>" / "logs\n\nresults:\n{…}" bullet — the latter is
 * actually bracket-anchored and caught above; this path exists for CSV/TOON line-runs).
 * Strips leading prose LINES one at a time (fewest-stripped first, so the maximum
 * possible line-run is preferred) and retries `detectParse` on what's left, anchored at
 * EOF. Requires at least 2 lines total (a single line has no prose/structure boundary to
 * find).
 */
function findSuffixLineRunCandidate(s: string): Candidate | undefined {
  const lines = splitLinesKeepingNewlines(s);
  if (lines.length < 2) return undefined;
  const offsets = lineStartOffsets(lines);
  for (let i = 1; i < lines.length; i++) {
    const candidateStart = offsets[i]!;
    const candidateText = s.slice(candidateStart);
    const outcome = detectParse(candidateText);
    if (outcome.ok) {
      return {
        spanStart: candidateStart,
        spanEnd: s.length,
        raw: candidateText,
        value: outcome.value,
        format: outcome.format,
      };
    }
  }
  return undefined;
}

/** Mirror of {@link findSuffixLineRunCandidate}: strips trailing prose LINES one at a
 *  time (fewest-stripped first) and retries `detectParse` on what's left, anchored at BOF. */
function findPrefixLineRunCandidate(s: string): Candidate | undefined {
  const lines = splitLinesKeepingNewlines(s);
  if (lines.length < 2) return undefined;
  const offsets = lineStartOffsets(lines);
  for (let i = lines.length - 1; i >= 1; i--) {
    const candidateEnd = offsets[i]!;
    const candidateText = s.slice(0, candidateEnd);
    const outcome = detectParse(candidateText);
    if (outcome.ok) {
      return { spanStart: 0, spanEnd: candidateEnd, raw: candidateText, value: outcome.value, format: outcome.format };
    }
  }
  return undefined;
}

/**
 * The end-anchored prose+embedded-STRUCTURE recognizer
 * ("Prose + end-anchored embedded STRUCTURE"). Rules, exactly as specced:
 *
 *   1. Try `detectParse` on the WHOLE string first. If it succeeds, the response has no
 *      prose at all — return the envelope with no `prefix`/`suffix`.
 *   2. Else scan for an end-anchored span: a **suffix-struct** (a balanced `{…}`/`[…]`
 *      bracket span that reaches EOF — leading prose becomes `prefix`) OR a
 *      **prefix-struct** (a balanced bracket span that starts at BOF — trailing prose
 *      becomes `suffix`). The candidate span must independently pass `parseJsonStrict` —
 *      STRUCTURE only, never a scalar (a bracket span, by construction, can only parse to
 *      an object or array anyway, but this also closes the door on any span whose bracket
 *      TYPES don't actually match).
 *   3. The same two anchors are also tried via a line-based fallback, for formats that
 *      aren't bracket-delimited (CSV/TOON line-runs) — strip prose LINES from one end and
 *      retry `detectParse` on the remaining line-run.
 *   4. Prefix XOR suffix, NEVER both — if a valid BOF-anchored structure AND a valid
 *      EOF-anchored structure both exist (whether found via bracket-scan or line-run),
 *      that's two fuzzy boundaries firing on what might be payload internals: refuse as
 *      ambiguous.
 *   5. An empty/whitespace-only leftover on the prose side is not reported as `prefix`/
 *      `suffix` at all — it's insignificant, so the field is simply omitted.
 */
export function detectEnvelope(s: string): EnvelopeOutcome {
  const whole = detectParse(s);
  if (whole.ok) {
    return { ok: true, value: { raw: s, value: whole.value, format: whole.format } };
  }

  const spans = findTopLevelBracketSpans(s);
  const prefixCandidate = tryBracketPrefixCandidate(s, spans) ?? findPrefixLineRunCandidate(s);
  const suffixCandidate = tryBracketSuffixCandidate(s, spans) ?? findSuffixLineRunCandidate(s);

  if (prefixCandidate !== undefined && suffixCandidate !== undefined) {
    return {
      ok: false,
      reason:
        "ambiguous: both a BOF-anchored and an EOF-anchored structure exist — a mid-string span would " +
        "need two fuzzy boundaries, so neither is trusted (response-normalizer.md §4.2)",
    };
  }

  if (prefixCandidate !== undefined) {
    const suffixText = s.slice(prefixCandidate.spanEnd);
    const value: EnvelopeValue = {
      raw: prefixCandidate.raw,
      value: prefixCandidate.value,
      format: prefixCandidate.format,
    };
    if (suffixText.trim() !== "") value.suffix = suffixText;
    return { ok: true, value };
  }

  if (suffixCandidate !== undefined) {
    const prefixText = s.slice(0, suffixCandidate.spanStart);
    const value: EnvelopeValue = {
      raw: suffixCandidate.raw,
      value: suffixCandidate.value,
      format: suffixCandidate.format,
    };
    if (prefixText.trim() !== "") value.prefix = prefixText;
    return { ok: true, value };
  }

  return { ok: false, reason: "no recognized format and no end-anchored embedded structure found" };
}

/**
 * Block-level envelope algebra — the
 * string-level envelope rule above, lifted one level, over an MCP `CallToolResult`'s TEXT
 * block ARRAY instead of one block's text.
 *
 * This is an ARITY gate, not a shape gate. The simpler rule "exactly 1 block ⇒ maybe parse
 * it, 2+ blocks ⇒ always raw passthrough" makes `detectParse` provably unreachable for any
 * tool that structurally emits more than one text block — cli-mcp-server's `run_command`
 * (payload block + an invariant `"\nCommand completed with return code: 0"` trailer on
 * EVERY call) and pubmed's JSONL-by-blocks search results (one complete JSON object per
 * block) both land there, their payloads never parsed.
 *
 * STRICTLY SAFER than the single-string {@link detectEnvelope}: that function's
 * prefix-XOR-suffix ambiguity guard exists only because a single string's prose/structure
 * cut point is fuzzy (a mid-string brace could be a payload internal). MCP block
 * boundaries are EXACT — the upstream server itself handed us the cuts — so prose
 * blocks on BOTH sides of the one structural block are unambiguous and never refused.
 *
 * Three outcomes (first match wins; `detectParse` is the sole per-block classifier —
 * this function owns no parsing logic of its own, only the partition):
 *   - exactly ONE block parses (STRUCTURE), the rest don't (PROSE, in any position) →
 *     `{kind:"envelope", value:{raw,value,format,prefix?,suffix?}}` — the cli-mcp-server
 *     shape: `prefix`/`suffix` are the OTHER blocks' texts, joined, on each side of the
 *     structural one (present only when non-blank after trimming).
 *   - EVERY block parses AND they share the same top-level KIND (object vs. array) →
 *     `{kind:"vector", value: unknown[]}` — `content[]` genuinely IS a collection
 *     (pubmed's JSONL-by-blocks: 5 blocks, each one complete JSON object).
 *   - anything else (zero structural blocks, or 2+ structural blocks of MIXED kind —
 *     never silently coerced into one shape) → `{kind:"raw"}`, the caller's signal to
 *     fall through to the untouched block-array passthrough. Strict-or-refuse holds at
 *     the block level exactly as it does at the string level: a miss costs nothing.
 */
export type BlockEnvelopeOutcome =
  { kind: "envelope"; value: EnvelopeValue } | { kind: "vector"; format: string; value: unknown[] } | { kind: "raw" };

function topLevelKind(value: unknown): "array" | "object" {
  return Array.isArray(value) ? "array" : "object";
}

export function detectBlockEnvelope(texts: readonly string[]): BlockEnvelopeOutcome {
  const parsed = texts.map((text) => ({ text, outcome: detectParse(text) }));
  const structuralIndices = parsed.reduce<number[]>((acc, p, i) => (p.outcome.ok ? [...acc, i] : acc), []);

  // "Exactly one structural block" is checked FIRST and takes priority over "all
  // structural" — the two conditions coincide only when there's a single block total
  // (structuralIndices.length === 1 === texts.length), and that degenerate case reads as
  // an envelope with no prefix/suffix, never a one-element "vector" (server.ts only ever
  // calls this for blocks.length > 1; this ordering just makes the boundary unambiguous).
  if (structuralIndices.length === 1) {
    const idx = structuralIndices[0]!;
    const structural = parsed[idx]!.outcome as { ok: true; value: unknown; format: string };
    const prefix = texts.slice(0, idx).join("\n");
    const suffix = texts.slice(idx + 1).join("\n");
    const value: EnvelopeValue = { raw: parsed[idx]!.text, value: structural.value, format: structural.format };
    if (prefix.trim() !== "") value.prefix = prefix;
    if (suffix.trim() !== "") value.suffix = suffix;
    return { kind: "envelope", value };
  }

  if (structuralIndices.length > 1 && structuralIndices.length === texts.length) {
    // ALL (2+) structural — vector iff every block's top-level KIND agrees (a mix of
    // object and array blocks is not "the array of records" §4.2 promises; refuse rather
    // than silently flattening two different shapes into one vector).
    const values = parsed.map((p) => (p.outcome as { ok: true; value: unknown; format: string }).value);
    const kinds = new Set(values.map(topLevelKind));
    if (kinds.size === 1) {
      const format = (parsed[0]!.outcome as { ok: true; value: unknown; format: string }).format;
      return { kind: "vector", format, value: values };
    }
    return { kind: "raw" };
  }

  return { kind: "raw" };
}
