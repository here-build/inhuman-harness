// select — Ring 1 pure selection.
// The four selection rules, applied in the order types.ts documents them:
//   1. drop diagnostics with span.start < unit.programStartOffset   (context/prelude, G4)
//   2. drop codes not in HINT_WHITELIST                              (whitelist-never-blacklist)
//   3. keep only diagnostics whose span intersects an ERRORED statement's span
//   4. per errored statement keep the ONE nearest to the statement start (cap-1, G5)
//
// No I/O, no async — a total function over its three arguments. The lens ran; this decides
// which of its diagnostics (if any) become at most one hint per errored statement.

import { HINT_WHITELIST, type SchemeSpan, type SelectHints } from "./types.js";

const WHITELIST: ReadonlySet<number> = new Set(HINT_WHITELIST);

/** Half-open interval intersection: [a.start, a.end) overlaps [b.start, b.end).
 *  A straddling span (one that reaches INTO a statement without being contained) still
 *  intersects — the doc pins "intersects, not contains" (select.test.ts). */
function intersects(a: SchemeSpan, b: SchemeSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

export const selectHints: SelectHints = (unit, diagnostics, erroredStatementIndexes) => {
  // Rules 1 + 2 are global, per-diagnostic gates — apply them once up front.
  const eligible = diagnostics.filter((d) => d.span.start >= unit.programStartOffset && WHITELIST.has(d.code));

  return erroredStatementIndexes.flatMap((statementIndex) => {
    const statementSpan = unit.statementSpans[statementIndex];
    if (statementSpan === undefined) return [];
    // Rule 3: coincidence — only diagnostics intersecting THIS errored statement.
    const coinciding = eligible.filter((d) => intersects(d.span, statementSpan));
    if (coinciding.length === 0) return [];
    // Rule 4: cap-1 — the ONE nearest the statement start (input order is irrelevant).
    const nearest = coinciding.reduce((best, d) =>
      Math.abs(d.span.start - statementSpan.start) < Math.abs(best.span.start - statementSpan.start) ? d : best,
    );
    return [{ statementIndex, diagnostic: nearest }];
  });
};
