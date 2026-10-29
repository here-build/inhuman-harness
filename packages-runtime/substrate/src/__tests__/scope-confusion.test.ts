// scopeConfusionDoor covers names the MODEL ITSELF defined but couldn't reach: a same-program
// cascade (an earlier statement failed so a later top-level define never ran), a cross-scope
// reference (X was only ever let/lambda-bound, never at top level), or the ≥2-local case where
// neither binding is forced as the intended one. It is a SIBLING of the unbound-in-expr
// did-you-mean door, on this disjoint name class, and runs LAST in the unbound-in-expr
// classifier — after the three-tier tool-name door and the data-literal quoting hint, and after
// arrival's own polyglot-rich-errors enrichment (which rides inline in the raw message by the
// time this door would run).
//
// Pure unit coverage only (no MCP wiring) — the e2e-through-a-real-manifold-tool half lives in
// the sibling arrival-manifold package.

import { describe, expect, it } from "vitest";

import { scopeConfusionDoor } from "../doors.js";
import { createLocalBindingTracker } from "../session-history.js";

describe("scopeConfusionDoor — pure unit tests (doors.ts)", () => {
  it("cascade: names the FIRST failing statement, not the symptom", () => {
    const door = scopeConfusionDoor({
      name: "b",
      topLevelDefineStatementNumber: 2,
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [],
      currentCallIndex: 5,
    });
    expect(door?.fact).toBe(
      "`b' was defined above in this program, but an earlier statement failed, so its (define) " +
        "never ran — every statement after the first error is skipped. Fix the FIRST error (see " +
        "the error at statement 1) and the rest will bind.",
    );
    expect(door?.code).toBe("envelope/scope-confusion");
  });

  it("cross-scope: exactly one prior local occurrence — 'N message(s) ago' / 'this message'", () => {
    const oneAgo = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1],
      currentCallIndex: 2,
    });
    expect(oneAgo?.fact).toBe(
      "`z' was defined inside a local scope (a let/lambda body) 1 message ago, not globally — a " +
        "local binding doesn't survive its form. Re-declare it at top level with (define z …), " +
        "or bind it locally with (let ((z …)) …) in the statement that uses it.",
    );
    const threeAgo = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1],
      currentCallIndex: 4,
    });
    expect(threeAgo?.fact).toContain("3 messages ago");
    const sameMessage = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [2],
      currentCallIndex: 2,
    });
    expect(sameMessage?.fact).toContain("earlier in this message");
  });

  it("≥2-local: both paths acknowledged, neither forced (V's don't-force-an-implementation flag)", () => {
    const door = scopeConfusionDoor({
      name: "z",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1, 2],
      currentCallIndex: 3,
    });
    expect(door?.fact).toBe(
      "`z' is a local binding you've used before — it doesn't persist across statements. Either " +
        "bind it in the same statement that uses it, or (define z …) it at top level to reuse it " +
        "across calls.",
    );
  });

  it("cascade wins over local-binding history when both are present (priority order)", () => {
    const door = scopeConfusionDoor({
      name: "z",
      topLevelDefineStatementNumber: 3,
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [1, 2],
      currentCallIndex: 5,
    });
    expect(door?.fact).toContain("was defined above in this program");
  });

  it("none of (a)/(b)/(c) → undefined (case (d) — not this door's job)", () => {
    expect(
      scopeConfusionDoor({
        name: "csv-thing",
        firstErrorStatementNumber: 1,
        localBindingCallIndexes: [],
        currentCallIndex: 1,
      }),
    ).toBeUndefined();
  });
});

describe("createLocalBindingTracker (session-history.ts)", () => {
  it("records occurrences per call index, deduping repeats within one call", () => {
    const tracker = createLocalBindingTracker();
    tracker.record(["z", "z"], 1);
    tracker.record(["z"], 1); // same call again — no duplicate
    tracker.record(["z"], 2);
    expect(tracker.occurrences("z")).toEqual([1, 2]);
    expect(tracker.occurrences("never-seen")).toEqual([]);
  });
});
