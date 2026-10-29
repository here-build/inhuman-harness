// Pins the frozen SelectHints contract: a pure function, no I/O, no async. The four
// selection rules, applied in order (each is independently tested, not just as a chain —
// see the G4 test below, which deliberately constructs a pathological unit to prove rule 1
// fires as its own gate rather than being merely subsumed by rule 3's intersection check):
//   1. drop diagnostics with span.start < unit.programStartOffset   (context/prelude, G4)
//   2. drop codes not in HINT_WHITELIST                              (whitelist-never-blacklist)
//   3. keep only diagnostics whose span intersects an ERRORED statement's span
//   4. per errored statement keep the ONE nearest to the statement start (cap-1, G5)
//
// RED suite: select.ts does not exist yet, by design. See src/__red__/README.md for the
// migration path once it lands.

import { describe, expect, it } from "vitest";

import { selectHints } from "../../type-hints/select.js";
import { HINT_WHITELIST, type LoweredUnit, type MappedDiagnostic, type SchemeSpan } from "../../type-hints/types.js";

// ─── fixture factories ───

function span(start: number, end: number): SchemeSpan {
  return { start, end };
}

function unit(programStartOffset: number, statementSpans: readonly SchemeSpan[]): LoweredUnit {
  return { programStartOffset, statementSpans };
}

/** A MappedDiagnostic fixture. Defaults are innocuous placeholders — override only the
 *  fields a given test cares about. `tsMessage` is never asserted on (select.ts is
 *  span/code-driven only; tsMessage is render.ts's/internal concern). */
function diag(overrides: Partial<MappedDiagnostic> & { code: number; span: SchemeSpan }): MappedDiagnostic {
  return { tsMessage: "stub diagnostic message", ...overrides };
}

describe("§3/G4 — programStartOffset boundary (context/prelude suppression)", () => {
  it("drops a diagnostic whose span.start < programStartOffset even when whitelisted and its span intersects an errored statement's span", () => {
    // Pathological on purpose: statementSpans normally all start >= programStartOffset
    // (they describe the CURRENT program, which begins at that offset), so in practice a
    // diagnostic failing rule 1 would also fail rule 3's intersection check for free. To
    // prove rule 1 is an independent, explicit gate (not an accident of non-overlap), this
    // fixture sets programStartOffset AFTER the start of statementSpans[0] — something a
    // real LoweredUnit assembler would never produce, but which isolates exactly what G4
    // requires: the offset comparison fires on its own.
    const u = unit(50, [span(40, 80)]);
    const d = diag({ code: 2345, span: span(45, 47) }); // whitelisted; intersects [40,80]; span.start(45) < 50
    expect(selectHints(u, [d], [0])).toEqual([]);
  });
});

describe("§3 — whitelist (never blacklist)", () => {
  it("drops an off-whitelist code (e.g. TS2304) at a perfectly-coinciding errored span", () => {
    const OFF_WHITELIST_CODE = 2304; // "Cannot find name ..." — deliberately noisy/off-whitelist
    if ((HINT_WHITELIST as readonly number[]).includes(OFF_WHITELIST_CODE)) {
      throw new Error("test fixture assumption violated: OFF_WHITELIST_CODE must not be in HINT_WHITELIST");
    }
    const u = unit(0, [span(0, 20)]);
    const d = diag({ code: OFF_WHITELIST_CODE, span: span(5, 10) });
    expect(selectHints(u, [d], [0])).toEqual([]);
  });

  describe.each(HINT_WHITELIST)("code %d is IN HINT_WHITELIST", (code) => {
    it("is accepted when it coincides with an errored statement", () => {
      const u = unit(0, [span(0, 20)]);
      const d = diag({ code, span: span(5, 10) });
      const result = selectHints(u, [d], [0]);
      expect(result).toHaveLength(1);
      expect(result[0]!.diagnostic.code).toBe(code);
      expect(result[0]!.statementIndex).toBe(0);
    });
  });
});

describe("§3 — statement coincidence", () => {
  it("a diagnostic wholly inside statement 0's span, while only statement 1 errored → nothing", () => {
    const u = unit(0, [span(0, 10), span(10, 20)]);
    const d = diag({ code: 2345, span: span(2, 4) }); // inside statement 0 only
    expect(selectHints(u, [d], [1])).toEqual([]);
  });

  it("a diagnostic spanning INTO the errored statement (overlap, not containment) is kept — intersects, not contains", () => {
    const u = unit(0, [span(0, 10), span(10, 20)]);
    // Straddles the boundary: overlaps statement 0's tail [8,10) and statement 1's head [10,15).
    const d = diag({ code: 2345, span: span(8, 15) });
    const result = selectHints(u, [d], [1]);
    expect(result).toHaveLength(1);
    expect(result[0]!.statementIndex).toBe(1);
    expect(result[0]!.diagnostic).toEqual(d);
  });
});

describe("§3/G5 — cap-1 per errored statement", () => {
  it("two whitelisted diagnostics in one errored statement → only the one nearest the statement start survives", () => {
    const u = unit(0, [span(0, 20)]);
    const near = diag({ code: 2345, span: span(2, 4) }); // distance ~2 from statement start (0)
    const far = diag({ code: 2554, span: span(15, 16) }); // distance ~15 from statement start
    // Order in the input array must not matter — pass far-then-near.
    const result = selectHints(u, [far, near], [0]);
    expect(result).toHaveLength(1);
    expect(result[0]!.diagnostic).toEqual(near);
    expect(result[0]!.statementIndex).toBe(0);
  });

  it("two errored statements, each with one diagnostic → both returned, each tagged with its own statementIndex", () => {
    const u = unit(0, [span(0, 10), span(10, 20)]);
    const d0 = diag({ code: 2345, span: span(2, 4) }); // intersects statement 0 only
    const d1 = diag({ code: 2554, span: span(12, 14) }); // intersects statement 1 only
    const result = selectHints(u, [d0, d1], [0, 1]);
    expect(result).toHaveLength(2);
    // Order of the returned array is not asserted — index by statementIndex instead.
    const byStatement = new Map(result.map((r) => [r.statementIndex, r]));
    expect(byStatement.get(0)?.diagnostic).toEqual(d0);
    expect(byStatement.get(1)?.diagnostic).toEqual(d1);
  });
});

describe("§3 — empty inputs", () => {
  it("no errored statements → always [], regardless of diagnostics present", () => {
    const u = unit(0, [span(0, 10)]);
    const d = diag({ code: 2345, span: span(2, 4) });
    expect(selectHints(u, [d], [])).toEqual([]);
  });

  it("no diagnostics → [], regardless of errored statements", () => {
    const u = unit(0, [span(0, 10)]);
    expect(selectHints(u, [], [0])).toEqual([]);
  });

  it("no diagnostics AND no errored statements → []", () => {
    const u = unit(0, [span(0, 10)]);
    expect(selectHints(u, [], [])).toEqual([]);
  });
});
