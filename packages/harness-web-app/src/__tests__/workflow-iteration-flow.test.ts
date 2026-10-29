/**
 * iteration-flow — the derive layer that reads a loop's passes off the regions: how a fanout
 * ran, and the honest TCO recurrence source (producer-escapes vs identity-passthrough).
 * Mirrors the gepa `evolve` shape.
 */
import type { Region } from "@here.build/arrival-provenance";
import { describe, expect, it } from "vitest";

import { fanoutOrder, recurrenceSource } from "../workflow/iteration-flow.js";

const leaf = (id: number): Region => ({
  kind: "leaf",
  id,
  label: "chat/completion",
  scope: `s@${id}`,
  nodeKind: "direct",
  state: "resolved",
  value: id,
});
const fanout = (id: number, label: string, iterations: Region[][]): Region =>
  ({
    kind: "fanout",
    id,
    scope: `${label}@${id}`,
    stages: [{ label, id }],
    incoming: iterations.length,
    iterations,
    inputs: [],
    outputs: [],
  }) as Region;

describe("recurrenceSource", () => {
  it("PROMOTE: anchors at the escaping full-set producer (assess feeds only plumbing)", () => {
    // assess#6 has no in-iteration consumer (frontier/cons are plumbing) → it escapes.
    const body: Region[] = [fanout(2, "evaluate", [[leaf(3)]]), fanout(6, "assess", [[leaf(7)]])];
    const edges = [{ from: 3, to: 6 }]; // batch evaluate feeds assess, assess feeds nothing here
    expect(recurrenceSource(body, edges)).toEqual({ kind: "producer", id: 6 });
  });

  it("DISCARD/SKIP: passthrough when every producer feeds an in-iteration consumer (the gepa-full identity case)", () => {
    // batch evaluate#2 feeds the output#1; nothing escapes → pool recurs by identity.
    const body: Region[] = [{ kind: "output", id: 1 } as Region, fanout(2, "evaluate", [[leaf(3)]])];
    const edges = [{ from: 3, to: 1 }];
    expect(recurrenceSource(body, edges)).toEqual({ kind: "passthrough" });
  });

  it("GENETIC: anchors at the merge producer that escapes to the recurrence", () => {
    const body: Region[] = [fanout(2, "merge", [[leaf(3)]])];
    expect(recurrenceSource(body, [])).toEqual({ kind: "producer", id: 2 });
  });

  it("prefers the LAST escaping producer (the cumulative tail result)", () => {
    const body: Region[] = [fanout(1, "map", [[leaf(2)]]), fanout(3, "assess", [[leaf(4)]])];
    expect(recurrenceSource(body, [])).toEqual({ kind: "producer", id: 3 });
  });
});

describe("fanoutOrder", () => {
  const order = (label: string, loop?: boolean, more: string[] = []) =>
    fanoutOrder({
      ...(fanout(1, label, [[leaf(2)]]) as Extract<Region, { kind: "fanout" }>),
      stages: [label, ...more].map((l, id) => ({ label: l, id })),
      ...(loop ? { loop } : {}),
    });

  it("reads map, filter and for-each as parallel: every application starts before any is awaited", () => {
    expect(["map", "filter", "for-each"].map((head) => order(head))).toEqual([
      "in parallel",
      "in parallel",
      "in parallel",
    ]);
  });

  it("reads a fold as serial, a fused chain as serial once one stage is, and a TCO loop as a loop", () => {
    expect(order("fold-left")).toBe("in series");
    expect(order("evolve", true)).toBe("in loop");
    expect(order("map", false, ["fold-right"])).toBe("in series");
  });
});
