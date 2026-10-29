// render — Ring 1 pure rendering.
// The bifunctor discipline: the model never learns the program was lowered to TypeScript, so
// the TS carrier vocabulary (`Cons<T> | null`, `readonly T[]`, `Promise<R>`, `TS\d{4}`,
// literal "undefined") must NEVER surface. Two fixed tables:
//   1. type back-translation — a TS type STRING → a scheme-facing phrase, or null when the
//      shape is unrenderable (conditional / mapped / depth>3). A skipped hint is invisible;
//      a wrong hint is poison — so ANY unrenderable part collapses the whole hint to null.
//   2. action-by-mismatch-kind — the recovery action comes from the mismatch SHAPE, never
//      free-composed prose.
// The output is a single sibling line naming the failing form's head (G12 trailing-block
// naming). It is pinned carrier-clean by the vocabulary-blacklist test (render.test.ts).

import type { MappedDiagnostic, RenderHint } from "./types.js";

// ─── unrenderability gates (doc §4: conditional / mapped / depth>3 → skip) ───

function maxAngleDepth(ts: string): number {
  let depth = 0;
  let max = 0;
  for (const ch of ts) {
    if (ch === "<") {
      depth += 1;
      max = Math.max(max, depth);
    } else if (ch === ">") {
      depth -= 1;
    }
  }
  return max;
}

function isUnrenderable(ts: string): boolean {
  if (/\bextends\b/.test(ts) && ts.includes("?")) return true; // conditional type
  if (/\[\s*\w+\s+in\s+/.test(ts)) return true; // mapped type
  return maxAngleDepth(ts) > 3;
}

// ─── depth-aware splitters (a top-level `|` is a union; `<>`/`{}`/`[]` nest) ───

function splitTopLevel(ts: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < ts.length; i++) {
    const ch = ts[i]!;
    if (ch === "<" || ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === ">" || ch === "}" || ch === "]" || ch === ")") depth -= 1;
    if (depth === 0 && ts.startsWith(separator, i)) {
      parts.push(current.trim());
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

// ─── the shape probes (all operate on a null-stripped CORE type) ───

const NIL_MEMBERS = new Set(["null", "undefined"]);

function stripNil(ts: string): { core: string; hadNil: boolean } {
  const parts = splitTopLevel(ts, " | ");
  const nonNil = parts.filter((p) => !NIL_MEMBERS.has(p));
  return { core: nonNil.join(" | ").trim() || ts, hadNil: nonNil.length < parts.length };
}

const LIST_RE = /^(?:readonly\s+)?(?:List|Cons)<([\s\S]+)>$/;
// `ts` is one harvested TS type string per call (bounded length, never attacker-scaled) — the
// `\s+`/`[\s\S]+` overlap is real in the abstract, but this is a small fixed shape probe, not a
// hot path over untrusted input.
// eslint-disable-next-line regexp/no-super-linear-backtracking
const VECTOR_RE = /^(?:readonly\s+)?([\s\S]+)\[\]$/;
const OBJECT_RE = /^\{([\s\S]*)\}$/;
const NUMERIC_RE = /^(?:number|integer|bigint)$/;

function listElement(core: string): string | undefined {
  return LIST_RE.exec(core)?.[1]?.trim();
}
function vectorElement(core: string): string | undefined {
  return VECTOR_RE.exec(core)?.[1]?.trim();
}
function isListLike(core: string): boolean {
  return listElement(core) !== undefined || vectorElement(core) !== undefined;
}
function isDictLike(core: string): boolean {
  return OBJECT_RE.test(core.trim());
}

// ─── table 1: type back-translation (TS type string → scheme-facing phrase | null) ───

/** Plural noun for a list/vector element type: "numbers", "strings", "dicts", … */
function pluralNoun(elementTs: string): string {
  const { core } = stripNil(elementTs.trim());
  if (isDictLike(core)) return "dicts";
  if (isListLike(core)) return "lists";
  if (NUMERIC_RE.test(core)) return "numbers";
  if (core === "string") return "strings";
  if (core === "boolean") return "booleans";
  return "values";
}

/** Short token for a dict value's type (kept primitive — the dict phrase is a sketch). */
function fieldToken(ts: string): string {
  const { core } = stripNil(ts.trim());
  if (NUMERIC_RE.test(core)) return core === "bigint" ? "number" : core;
  if (core === "string" || core === "boolean") return core;
  if (isListLike(core)) return "list";
  if (isDictLike(core)) return "dict";
  return "value";
}

function renderDict(inner: string): string {
  const fields = splitTopLevel(inner, ";")
    .flatMap((f) => splitTopLevel(f, ","))
    .map((field) => {
      const colon = field.indexOf(":");
      if (colon === -1) return undefined;
      const key = field.slice(0, colon).trim().replace(/\?$/, "");
      const type = field.slice(colon + 1).trim();
      if (key.length === 0) return undefined;
      return `:${key} ${fieldToken(type)}`;
    })
    .filter((f): f is string => f !== undefined);
  const shown = fields.length > 4 ? [...fields.slice(0, 4), "..."] : fields;
  return `{${shown.join(" ")}}`;
}

function scalarPhrase(core: string): string | null {
  if (NUMERIC_RE.test(core)) return "a number";
  if (core === "string") return "a string";
  if (core === "boolean") return "a boolean";
  return null; // an unknown scalar name — skip rather than echo raw TS vocabulary
}

/** TS type string → scheme-facing phrase, or null when any part is unrenderable. */
function backTranslate(ts: string): string | null {
  const trimmed = ts.trim();
  if (trimmed.length === 0 || isUnrenderable(trimmed)) return null;

  const { core, hadNil } = stripNil(trimmed);
  if (hadNil) {
    const inner = backTranslate(core);
    return inner === null ? null : `${inner} or nil`;
  }

  // A residual top-level union (no nil member) — back-translate each arm.
  const unionArms = splitTopLevel(core, " | ");
  if (unionArms.length > 1) {
    const arms = unionArms.map(backTranslate);
    if (arms.includes(null)) return null;
    return arms.join(" or ");
  }

  const listEl = listElement(core);
  if (listEl !== undefined) return `a list of ${pluralNoun(listEl)}`;
  const vecEl = vectorElement(core);
  if (vecEl !== undefined) return `a vector of ${pluralNoun(vecEl)}`;
  const objMatch = OBJECT_RE.exec(core);
  if (objMatch) return renderDict(objMatch[1]!);

  return scalarPhrase(core);
}

// ─── table 2: action-by-mismatch-kind (the action comes from the SHAPE, never composed) ───

function actionFor(expectedTs: string, actualTs: string): string {
  const expected = stripNil(expectedTs.trim()).core;
  const actual = stripNil(actualTs.trim()).core;
  // string-where-number → the standard conversion.
  if (actual === "string" && NUMERIC_RE.test(expected)) return "convert it with (string->number x).";
  // list/vector-where-non-list → reach the element fields per item.
  if (isListLike(actual) && !isListLike(expected)) {
    return "map over it to reach the element fields — e.g. (map (cut :field <>) it).";
  }
  // dict-where-list → wrap the single dict in a one-element list.
  if (isDictLike(actual) && isListLike(expected)) return "wrap it in a list: (list it).";
  return "";
}

// ─── did-you-mean over a closed key set (2353), reused for unknown-property routing ───

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i, ...Array.from({ length: n }, () => 0)];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[n]!;
}

function nearestKey(attempted: string, candidates: readonly string[]): string {
  return candidates.reduce((best, c) => (editDistance(attempted, c) < editDistance(attempted, best) ? c : best));
}

// ─── per-code bodies ───

function unknownPropertyBody(d: MappedDiagnostic): string | null {
  if (d.propertyName === undefined || d.candidateProperties === undefined || d.candidateProperties.length === 0) {
    return null;
  }
  const nearest = nearestKey(d.propertyName, d.candidateProperties);
  return `there is no :${d.propertyName} parameter — did you mean :${nearest}?`;
}

function arityBody(d: MappedDiagnostic): string | null {
  // The parameter list is pre-rendered in scheme-facing vocabulary by the lens adapter
  // (signatureText); when a fixture carries the callee's key set instead, restate from
  // candidateProperties; failing both, an already scheme-facing `expected` signature string
  // (e.g. "(toy/add :a number :b number)") stands in. Never free-compose it.
  if (d.signatureText !== undefined && d.signatureText.length > 0) {
    return `wrong number of arguments — the parameters are ${d.signatureText}.`;
  }
  if (d.candidateProperties !== undefined && d.candidateProperties.length > 0) {
    return `wrong number of arguments — the parameters are: ${d.candidateProperties.join(", ")}.`;
  }
  if (d.expected !== undefined && d.expected.length > 0) {
    return `wrong number of arguments — the parameters are ${d.expected}.`;
  }
  return null;
}

function mismatchBody(d: MappedDiagnostic): string | null {
  if (d.expected === undefined || d.actual === undefined) return null;
  const expectedPhrase = backTranslate(d.expected);
  const actualPhrase = backTranslate(d.actual);
  if (expectedPhrase === null || actualPhrase === null) return null;
  const action = actionFor(d.expected, d.actual);
  const base = `expected ${expectedPhrase}, but received ${actualPhrase}`;
  return action.length > 0 ? `${base}; ${action}` : `${base}.`;
}

/** Carrier-leak guard (doc §4/§7 blacklist): a rendered hint must never contain TS carrier
 *  vocabulary. Belt-and-braces — the tables above are constructed not to emit it, but a
 *  leak is poison, so a would-be leak collapses the hint to null (skip) rather than ship. */
const CARRIER_LEAK = /Cons<|readonly|Promise<|TS\d{4}|undefined/;

export const renderHint: RenderHint = (hint, statementHead) => {
  const d = hint.diagnostic;
  let body: string | null;
  switch (d.code) {
    case 2353: {
      body = unknownPropertyBody(d);
      break;
    }
    case 2554:
    case 2555: {
      body = arityBody(d);
      break;
    }
    default: {
      // 2345 / 2339 / 2349 — an argument/type mismatch driven by expected vs actual.
      body = mismatchBody(d);
    }
  }
  if (body === null) return null;
  const rendered = `Type (${statementHead}): ${body}`;
  return CARRIER_LEAK.test(rendered) ? null : rendered;
};
