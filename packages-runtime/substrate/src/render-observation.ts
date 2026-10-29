// render-observation — render dict/list results using brace syntax `{:k v}` / `[a b]`
//
// The arrival reader accepts this notation as first-class literals, so models see
// results in the same surface syntax they write. This also saves tokens vs the
// `(dict ...)` / `(list ...)` constructor form.
//
// Implemented as a thin formatter over arrival-serializer's `toSExpr` tree. Only the
// "dict" and "list" heads are rewritten to braces; other heads (map, set, values, etc.)
// keep their `(head ...)` form but their children are still processed for nested
// collections. Primitives delegate to the serializer.

import {
  formatSExpr,
  type ElisionRecord,
  type SerializeOpts,
  toSExprString,
  toSExprStringWithElisions,
  type SExpr,
} from "@here.build/arrival-serializer";

/** Default total observation budget. Overridable per server via the `observation.maxTotalChars`
 *  config knob (config.ts → manifold-tool.ts). 20k is the best-performing budget across the
 *  tested range — +2.8pp pass rate over an 8k budget, 95% CI [0.0, +5.6]. */
export const DEFAULT_OBSERVATION_MAX_TOTAL_CHARS = 20_000;

/** Streaming-cap seeds for the normal (under-budget) case: generous enough that a real
 *  tool observation is never truncated below the total budget (a single string may consume
 *  the whole budget; 10k items of anything overflow it), so the caps only ever BITE via
 *  the shrink-to-fit loop once the render actually exceeds `maxTotalChars`. */
const SEED_MAX_ITEMS = 10_000;

/** arrival-serializer's truncation marker (module-private there; shared by `Symbol.for`
 *  registry key). A capped dict's `+N more of TOTAL` marker arrives as a trailing ODD
 *  entry in the `(dict …)` tail — `formatDict` must render it verbatim instead of
 *  dropping it as a key with no value. */
const TRUNCATED_MARKER = Symbol.for("arrival:truncated");
const isTruncationMarker = (x: SExpr): boolean =>
  typeof x === "object" && x !== null && !Array.isArray(x) && TRUNCATED_MARKER in x;

const isKeyToken = (x: SExpr): boolean => typeof x === "string" && x.startsWith(":");

/** A dict key from `toSExpr` is always the string `":name"` (toSExprDispatch always
 *  emits `` `:${key}` ``, for both plain objects and Maps — serializer.ts's plain-object
 *  and Map branches never emit a bare/quoted string key). Render it as the bare
 *  keyword `:name` when `name` reads back as one — the same "looks like a symbol"
 *  heuristic formatSExpr itself uses for primitive strings (`/^[a-z][\w-]*$/i`,
 *  serializer.ts ~line 529) — else fall back to the OTHER key shape the `{}` reader
 *  admits, a quoted string,
 *  so an odd key (spaces, punctuation) still round-trips instead of emitting an
 *  unreadable bare token. */
function renderKey(key: SExpr): string {
  if (typeof key === "string" && key.startsWith(":")) {
    const name = key.slice(1);
    if (/^[a-z][\w-]*$/i.test(name)) return key;
    const escaped = name.replaceAll('"', String.raw`\"`);
    return `"${escaped}"`;
  }
  return format(key, 0);
}

function formatDict(tail: SExpr[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < tail.length; i += 2) {
    const item = tail[i] as SExpr;
    // A capped dict carries a trailing truncation marker as one ODD entry — render it
    // verbatim (a `#| … |#` comment, so the braces still parse), never pair it with a value.
    if (isTruncationMarker(item)) {
      pairs.push(formatSExpr(item, 0));
      i -= 1; // consumed ONE entry, not a pair
      continue;
    }
    const value = tail[i + 1];
    if (value !== undefined) pairs.push(`${renderKey(item)} ${format(value, 0)}`);
  }
  return `{${pairs.join(" ")}}`;
}

/** One-line rendering. `headWord === null` ⇒ bracket collection (no word); otherwise
 *  the classic `(word ...)` operator-application shape. */
function renderFlat(headWord: string | null, tail: SExpr[]): string {
  const strTail = tail.map((item) => format(item, 0)).join(" ");
  if (headWord === null) return `[${strTail}]`;
  return strTail ? `(${headWord} ${strTail})` : `(${headWord})`;
}

/** Multi-line rendering — ported from formatSExpr's generic complex-array branch
 *  (serializer.ts, the final `else` in its array handling), recursing through
 *  `format` instead of `formatSExpr` so nested dict/list keep braces/brackets at any
 *  depth. */
function renderBlock(headWord: string | null, tail: SExpr[], indent: number): string {
  const spaces = " ".repeat(indent);
  const strTail = tail
    .map((item, index) => {
      const formatted = format(item, indent + 2);
      // A `:key` groups with the NEXT item only when that item is a real VALUE (not
      // another keyword) — consecutive keywords are standalone flags and must stand
      // on their own line.
      if (isKeyToken(item) && index + 1 < tail.length) {
        const nextItem = tail[index + 1] as SExpr;
        const nextFormatted = format(nextItem, 0);
        if (!isKeyToken(nextItem) && !Array.isArray(nextItem) && nextFormatted.length < 40) return null;
      }
      // Emit a `:key value` pair: the preceding key was skipped above, so this value
      // carries it on one line.
      const prev = index > 0 ? tail[index - 1] : undefined;
      if (
        prev !== undefined &&
        isKeyToken(prev) &&
        !isKeyToken(item) &&
        !Array.isArray(item) &&
        formatted.length < 40
      ) {
        return `${spaces}  ${format(prev, 0)} ${formatted}`;
      }
      return `${spaces}  ${formatted}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
  if (headWord === null) return strTail ? `[\n${strTail}]` : "[]";
  return strTail ? `(${headWord}\n${strTail})` : `(${headWord})`;
}

function formatList(tail: SExpr[], indent: number): string {
  if (tail.length === 0) return "[]";
  // Mirrors formatSExpr's dedicated "list" one-liner heuristic (serializer.ts, the
  // reference/definition/diagnostic/symbol/type/list block): stay on one line unless
  // a string is long or a nested structure is non-trivial.
  const hasLongString = tail.some((item) => typeof item === "string" && item.length > 80 && !item.startsWith(":"));
  const hasComplexStructure = tail.some((item) => Array.isArray(item) && item.length > 3);
  if (!hasLongString && !hasComplexStructure) return renderFlat(null, tail);
  const isSimple = tail.length <= 3 && tail.every((item) => !Array.isArray(item) || item.length <= 2);
  return isSimple ? renderFlat(null, tail) : renderBlock(null, tail, indent);
}

/** formatSExpr's "map" head — head-preserving, word+parens; ported so nested dict/list
 *  values still get braces/brackets via `format`. */
function formatMap(strHead: string, tail: SExpr[], indent: number): string {
  const pairs: string[] = [];
  for (let i = 0; i < tail.length; i += 2) {
    const keyItem = tail[i] as SExpr;
    if (isTruncationMarker(keyItem)) {
      // Same trailing-odd-marker handling as formatDict — never drop a truncation note.
      pairs.push(formatSExpr(keyItem, 0));
      i -= 1;
      continue;
    }
    const valueItem = tail[i + 1];
    if (valueItem === undefined) continue;
    const key = format(keyItem, 0);
    const isComplexValue = Array.isArray(valueItem) || (typeof valueItem === "string" && valueItem.length > 40);
    const value = isComplexValue ? format(valueItem, indent + 2 + key.length + 1) : format(valueItem, 0);
    pairs.push(`${key} ${value}`);
  }
  const totalLength = pairs.reduce((sum, p) => sum + p.length, 0) + pairs.length * 2;
  if (pairs.length <= 2 && totalLength < 60) return `(${strHead} ${pairs.join(" ")})`;
  const spaces = " ".repeat(indent);
  const indentedPairs = pairs.map((p) => `${spaces}  ${p}`).join("\n");
  return `(${strHead}\n${indentedPairs})`;
}

/** formatSExpr's `Stateful`/`Calculator` unquoted-bare-symbol special case, or `null`
 *  when this node doesn't match that shape (the caller falls through to the generic
 *  path). Vanishingly rare in observation data — ported for parity, not because
 *  manifold results are expected to hit it. */
function formatStatefulLike(head: SExpr, strHead: string, tail: SExpr[]): string | null {
  if (typeof head !== "string" || head.startsWith(":") || head.startsWith('"')) return null;
  if (head !== "Stateful" && head !== "Calculator") return null;
  const isSymbol = tail.some((item) => typeof item === "string" && !item.startsWith(":") && !item.includes(" "));
  if (!isSymbol) return null;
  const formattedTail = tail
    .map((item) => (typeof item === "string" && !item.startsWith(":") && !item.includes(" ") ? item : format(item, 0)))
    .join(" ");
  return `(${strHead} ${formattedTail})`;
}

/** Everything except dict/list — ported from formatSExpr's generic-head path
 *  (serializer.ts), minus the dict/list special cases (handled above, before this is
 *  ever reached), recursing through `format` so a rare nested dict/list under e.g.
 *  `values`/`map` still gets braces/brackets. */
function formatOther(head: SExpr, tail: SExpr[], indent: number): string {
  const strHead = typeof head === "string" && !head.startsWith(":") ? head : format(head, 0);

  if (head === "map") return formatMap(strHead, tail, indent);
  if (strHead === "<function>") return "<function>";

  const statefulLike = formatStatefulLike(head, strHead, tail);
  if (statefulLike !== null) return statefulLike;

  if (head === "reference" || head === "definition" || head === "diagnostic" || head === "symbol" || head === "type") {
    const hasLongString = tail.some((item) => typeof item === "string" && item.length > 80 && !item.startsWith(":"));
    const hasComplexStructure = tail.some((item) => Array.isArray(item) && item.length > 3);
    if (!hasLongString && !hasComplexStructure) return renderFlat(strHead, tail);
  }

  const isSimple = tail.length <= 3 && tail.every((item) => !Array.isArray(item) || item.length <= 2);
  return isSimple ? renderFlat(strHead, tail) : renderBlock(strHead, tail, indent);
}

/** Formatter over `toSExpr`'s intermediate tree: "dict"/"list" heads render braced/
 *  bracketed; every other node delegates as documented in the file header. */
function format(node: SExpr, indent = 0): string {
  if (!Array.isArray(node)) return formatSExpr(node, indent);
  if (node.length === 0) return "()";
  const [head, ...tail] = node;
  if (head === "dict") return formatDict(tail);
  if (head === "list") return formatList(tail, indent);
  return formatOther(head as SExpr, tail, indent);
}

/**
 * Render an arrival `exec()` result the same way the model WRITES collections — the
 * `{}`/`[]` reader grammar it already emits itself — instead of the constructor-call
 * form `(dict ...)`/`(list ...)`. Every rendered observation still PARSES under the
 * committed grammar (round-trip test: __tests__/render-observation.test.ts).
 *
 * Truncation: this formatter rides `toSExprString`'s OWN caps machinery via
 * `SerializeOpts.format` — streaming per-collection/per-string caps, the fair
 * shrink-to-fit loop, and `#| +N more of TOTAL |#` markers all apply NATIVELY to the
 * brace rendering. The seeds are sized so the caps only ever bite once the
 * total budget is actually exceeded: a single string may span the whole budget, and any
 * collection past SEED_MAX_ITEMS items overflows it anyway. An under-budget observation
 * renders byte-identically to the uncapped formatter.
 */
export function renderObservation(value: unknown, opts: { maxTotalChars?: number } = {}): string {
  // A top-level RAW JS string (a provenance-less native return — e.g. substring/
  // string-append over literals) hits the SExpr intermediate as a bare TOKEN and renders
  // unquoted, while the same value provenance-boxed (AString) renders quoted — breaking
  // the preamble's round-trip claim inconsistently. Normalize here: quote + escape,
  // capped like any other string. (Nested raw strings inside raw containers share the
  // token fate at the serializer level — no interpreter path produces those today.)
  //
  // The elision itself is still signaled INLINE (errors-as-doors: a truncation must never
  // be silent) — the `…(+N chars)` style suffix a boxed AString gets from the serializer's
  // own `capString` — mirrored here for the raw-string shortcut so both paths carry the
  // same honest signal without a separate top-of-output banner.
  if (typeof value === "string") {
    const cap = opts.maxTotalChars ?? DEFAULT_OBSERVATION_MAX_TOTAL_CHARS;
    if (value.length <= cap) return JSON.stringify(value);
    const sliced = JSON.stringify(value.slice(0, cap));
    return `${sliced}…(+${value.length - cap} chars)`;
  }
  // The `SerializeOptsPending` intersection covers the window where the serializer's
  // PUBLISHED dist .d.ts predates a SerializeOpts seam its src already has (`format` —
  // live benchmark runners hold the current dist, the orchestrator rebuilds after they
  // drain). Redundant — and harmless — once the dist catches up.
  const serializeOpts: SerializeOptsPending = {
    ...observationCaps(opts.maxTotalChars),
    format: (sexpr) => format(sexpr),
  };
  return toSExprString(value, serializeOpts);
}

/**
 * The `{text, elisions}` sibling of `renderObservation` (serializer-elision plan §6) — same
 * brace/bracket rendering, additionally threading `SerializeOpts.elideHead`/`elideTail` (and
 * the per-array limit knobs) through `toSExprStringWithElisions` so a caller can build a
 * trailing note from the collected `ElisionRecord`s. `renderObservation` itself is UNCHANGED
 * (never sets these knobs) — this is purely additive.
 *
 * A top-level raw string never elides (there's no array to elide) — it reuses
 * `renderObservation`'s own shortcut and returns an empty `elisions` list.
 */
export function renderObservationWithElisions(
  value: unknown,
  opts: { maxTotalChars?: number } & ObservationElisionOpts = {},
): { text: string; elisions: ElisionRecord[] } {
  if (typeof value === "string") {
    return { text: renderObservation(value, opts), elisions: [] };
  }
  const { maxTotalChars, ...elision } = opts;
  const serializeOpts: SerializeOptsPending = {
    ...observationCaps(maxTotalChars, elision),
    format: (sexpr) => format(sexpr),
  };
  return toSExprStringWithElisions(value, serializeOpts);
}

/** See the `SerializeOptsPending` note above `renderObservation`: the published dist's
 *  `SerializeOpts` may not yet declare `format` even though this function always sets it — a
 *  structural superset, never a literal assigned where the narrower type is checked, so this
 *  widens safely regardless of which dist shape a consumer holds. */
type SerializeOptsPending = SerializeOpts & {
  format?: (sexpr: SExpr) => string;
};

/** Middle-elision knobs (serializer-elision plan §7) — OPT-IN by presence, same rule as the
 *  serializer's own `SerializeOpts`. `undefined` (the default) means every field below stays
 *  unset and `observationCaps` behaves exactly as before; the manifold is the one caller that
 *  passes these (its own calibration surface — arrival-manifold/src/manifold-tool.ts). */
export interface ObservationElisionOpts {
  /** Real per-array item cap when elision is ON — NOT the same knob as the generous
   *  `SEED_MAX_ITEMS` seed below (that seed exists so array-count truncation never bites
   *  before the char budget does; this is the deliberate small per-array display limit). */
  maxItems?: number;
  topLevelArrayLimit?: number;
  secondLevelArrayLimit?: number;
  elideHead?: number;
  elideTail?: number;
}

/** Observation budget + truncation seeds for the serializer.
 *
 *  Seeds are sized so they only trigger after the total char budget is the real limiter.
 *  `elision` is OPT-IN (see `ObservationElisionOpts`) — omitted, `maxItems` stays the
 *  generous `SEED_MAX_ITEMS` seed and every new knob stays unset, so behaviour is
 *  byte-for-byte what it was before this parameter existed. */
export function observationCaps(
  maxTotalChars: number = DEFAULT_OBSERVATION_MAX_TOTAL_CHARS,
  elision?: ObservationElisionOpts,
): SerializeOptsPending {
  return {
    maxTotalChars,
    maxItems: elision?.maxItems ?? SEED_MAX_ITEMS,
    maxStringChars: maxTotalChars,
    topLevelArrayLimit: elision?.topLevelArrayLimit,
    secondLevelArrayLimit: elision?.secondLevelArrayLimit,
    elideHead: elision?.elideHead,
    elideTail: elision?.elideTail,
  };
}
