/**
 * region-nesting's smaller helpers — `planNesting`'s own composition is covered end-to-end
 * in `region-nesting.test.ts`; this file locks in the individual building blocks it stands
 * on (the region index, the scope-body keying, the whole-value-flow test, the absorbable-hop
 * topology gate, and the post-plan tree prune).
 */
import type { Region, RegionGraph } from "@here.build/arrival-provenance";
import { describe, expect, it } from "vitest";

import {
  absorbableHops,
  containerPathOf,
  edgeKey,
  indexRegions,
  indexScopes,
  pruneRegions,
  wholeValueFlow,
} from "../workflow/region-nesting.js";

const leaf = (
  id: number,
  inputs: Record<string, unknown> = {},
  value?: unknown,
): Extract<Region, { kind: "leaf" }> => ({
  kind: "leaf",
  id,
  label: `n${id}`,
  scope: `n${id}@1:1`,
  nodeKind: "prompt",
  meta: { kind: "prompt", path: `n${id}.prompt`, model: "m", inputs },
  value: value ?? { v: id },
  state: "resolved",
});

const fanout = (id: number, iterations: Region[][], scope = `map@${id}`): Extract<Region, { kind: "fanout" }> => ({
  kind: "fanout",
  id,
  scope,
  stages: [{ label: "map", id }],
  iterations,
  incoming: iterations.length,
  inputs: [],
  outputs: [],
});

describe("edgeKey", () => {
  it("keys an edge by from/to/field", () => {
    expect(edgeKey({ from: 1, to: 2, field: "seed" })).toBe("1->2:seed");
  });
  it("uses an empty field slot when the edge carries no field", () => {
    expect(edgeKey({ from: 1, to: 2 })).toBe("1->2:");
  });
});

describe("indexRegions — id → region, recursing into every fanout iteration", () => {
  it("indexes root leaves and every nested iteration's leaves", () => {
    const a = leaf(1);
    const b = leaf(2);
    const inner = fanout(3, [[leaf(4)], [leaf(5)]]);
    const idx = indexRegions([a, b, inner]);
    expect([...idx.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
    expect(idx.get(4)).toMatchObject({ id: 4, kind: "leaf" });
  });
  it("accumulates into a caller-provided `out` map", () => {
    const out = new Map<number, Region>([[99, leaf(99)]]);
    indexRegions([leaf(1)], out);
    expect([...out.keys()].sort((x, y) => x - y)).toEqual([1, 99]);
  });
});

describe("indexScopes — region id → the body key it lives in", () => {
  it("roots share the empty body key", () => {
    const a = leaf(1);
    const b = leaf(2);
    const idx = indexScopes([a, b], "");
    expect(idx.get(1)).toBe("");
    expect(idx.get(2)).toBe("");
  });
  it("each fanout iteration opens a fresh, scope-keyed body under the CUMULATIVE chain", () => {
    const inner = fanout(1, [[leaf(10)], [leaf(11)]], "map@1");
    const idx = indexScopes([inner], "");
    expect(idx.get(1)).toBe(""); // the fanout node itself is at root
    expect(idx.get(10)).toBe("map@1#0"); // iteration 0's body key
    expect(idx.get(11)).toBe("map@1#1"); // iteration 1's body key — distinct from #0
  });
  it("nests body keys two levels deep with the ▸ separator", () => {
    const grandchild = leaf(20);
    const child = fanout(2, [[grandchild]], "filter@2");
    const outer = fanout(1, [[child]], "map@1");
    const idx = indexScopes([outer], "");
    expect(idx.get(20)).toBe("map@1#0▸filter@2#0");
  });
});

describe("containerPathOf — strips iteration indices from a body key, keeping the container chain", () => {
  it("returns the empty container for the root body key", () => {
    expect(containerPathOf("")).toBe("");
  });
  it("strips the #index suffix at each ▸-separated step", () => {
    expect(containerPathOf("map@1#0▸filter@2#3")).toBe("map@1▸filter@2");
  });
});

describe("wholeValueFlow — does a consumer's field hold the producer's ENTIRE result?", () => {
  it("true for a direct chain (the field IS the producer's value)", () => {
    const p = leaf(1, {}, { idea: "x" });
    const c = leaf(2, { seed: { idea: "x" } });
    expect(wholeValueFlow(c, "seed", p)).toBe(true);
  });
  it("true when the slot holds the producer's value list-wrapped, `(list b)`", () => {
    const p = leaf(1, {}, { idea: "x" });
    const c = leaf(2, { seed: [{ idea: "x" }] });
    expect(wholeValueFlow(c, "seed", p)).toBe(true);
  });
  it("false for a field-PLUCK — the slot holds only ONE field of the producer, not the whole value", () => {
    const p = leaf(1, {}, { idea: "x", energy: 0.7 });
    const c = leaf(2, { idea: "x" }); // slot holds the plucked string, not {idea,energy}
    expect(wholeValueFlow(c, "idea", p)).toBe(false);
  });
  it("false when the consumer isn't a leaf", () => {
    const p = leaf(1, {}, { idea: "x" });
    const c = fanout(2, []);
    expect(wholeValueFlow(c, "seed", p)).toBe(false);
  });
  it("false when the field isn't present in the consumer's inputs at all", () => {
    const p = leaf(1, {}, { idea: "x" });
    const c = leaf(2, { other: "y" });
    expect(wholeValueFlow(c, "seed", p)).toBe(false);
  });
  it("false when the producer's value can't be JSON-compared (e.g. undefined)", () => {
    const p = leaf(1, {}, undefined);
    const c = leaf(2, { seed: "anything" });
    expect(wholeValueFlow(c, "seed", p)).toBe(false);
  });
});

describe("absorbableHops — the STACKABLE scope-hops (producer out-degree 1, consumer in-degree 1)", () => {
  it("marks a single-file producer→consumer hop inside a container as absorbable", () => {
    const a = leaf(1, {}, { idea: "x" });
    const b = leaf(2, { seed: { idea: "x" } });
    const graph: RegionGraph = {
      roots: [fanout(9, [[a, b]])],
      edges: [{ from: 1, to: 2, field: "seed", kind: "data" }],
      warnings: [],
    };
    const hops = absorbableHops(graph);
    expect(hops.has(`map@9|${a.scope}|${b.scope}|seed`)).toBe(true);
  });
  it("excludes the root container — the top-level chain is never absorbable", () => {
    const a = leaf(1, {}, { idea: "x" });
    const b = leaf(2, { seed: { idea: "x" } });
    const graph: RegionGraph = {
      roots: [a, b],
      edges: [{ from: 1, to: 2, field: "seed", kind: "data" }],
      warnings: [],
    };
    expect(absorbableHops(graph).size).toBe(0);
  });
  it("excludes a fan-out producer (out-degree 2) — the matryoshka-bug hop is never absorbable", () => {
    const a = leaf(1, {}, { idea: "x" });
    const b = leaf(2, { seed: { idea: "x" } });
    const c = leaf(3, { also: { idea: "x" } });
    const graph: RegionGraph = {
      roots: [fanout(9, [[a, b, c]])],
      edges: [
        { from: 1, to: 2, field: "seed", kind: "data" },
        { from: 1, to: 3, field: "also", kind: "data" },
      ],
      warnings: [],
    };
    expect(absorbableHops(graph).size).toBe(0);
  });
});

describe("pruneRegions — removes nested producers, recursing into every fanout iteration", () => {
  it("drops a matching root-level region", () => {
    const a = leaf(1);
    const b = leaf(2);
    expect(pruneRegions([a, b], new Set([1])).map((r) => r.id)).toEqual([2]);
  });
  it("drops a matching region buried inside a fanout iteration, rebuilding that iteration's array", () => {
    const inner = fanout(1, [[leaf(10), leaf(11)], [leaf(12)]]);
    const pruned = pruneRegions([inner], new Set([11]));
    const [prunedFanout] = pruned as Extract<Region, { kind: "fanout" }>[];
    expect(prunedFanout.iterations[0]!.map((r) => r.id)).toEqual([10]);
    expect(prunedFanout.iterations[1]!.map((r) => r.id)).toEqual([12]);
  });
  it("passes through non-fanout regions untouched when nothing in them is dropped", () => {
    const a = leaf(1);
    expect(pruneRegions([a], new Set())).toEqual([a]);
  });
});
