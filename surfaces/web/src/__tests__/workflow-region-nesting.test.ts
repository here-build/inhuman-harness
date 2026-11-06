/**
 * planNesting — the absorption rule behind the blueprint render. Two invariants:
 *
 *  1. TOP LEVEL never nests. At root scope the execution chain is the point, so a
 *     producer→consumer chain renders one-by-one + wired, never absorbed (01-linear-chain:
 *     spark→refine→digest stay separate cards). Nesting is a CONTAINER trick.
 *  2. Inside a container, only WHOLE-VALUE flow nests. A field-PLUCK (`(field a "idea")`
 *     lands one field in a slot) is a wire to that field-row, not an absorption — the
 *     producer's whole result isn't what the slot holds. A direct/list-wrapped whole
 *     value (`b` / `(list b)`) IS, and packs `map>{inf>inf>inf}` densely.
 */
import type { Region, RegionGraph } from "@here.build/arrival-provenance";
import { describe, expect, it } from "vitest";

import { planNesting } from "../workflow/region-nesting.js";

const leaf = (id: number, inputs: Record<string, unknown>, value: unknown): Region => ({
  kind: "leaf",
  id,
  label: `n${id}`,
  scope: `n${id}@1:1`,
  nodeKind: "prompt",
  meta: { kind: "prompt", path: `n${id}.prompt`, model: "m", inputs },
  value,
  state: "resolved",
});

const fanout = (id: number, iterations: Region[][], scope = `map@${id}`): Region => ({
  kind: "fanout",
  id,
  scope,
  stages: [{ label: "map", id }],
  iterations,
  incoming: iterations.length,
  inputs: [],
  outputs: [],
});

describe("planNesting", () => {
  it("never nests at the top level, even on a whole-value chain", () => {
    // a produces {idea}, b's slot holds a's WHOLE value — would nest in a container, but
    // at root scope the chain stays visible.
    const a = leaf(1, { topic: "t" }, { idea: "x" });
    const b = leaf(2, { seed: { idea: "x" } }, { out: 1 });
    const graph: RegionGraph = {
      roots: [a, b],
      edges: [{ from: 1, to: 2, field: "seed", kind: "data" }],
      warnings: [],
    };
    expect(planNesting(graph).nested.size).toBe(0);
  });

  it("nests a WHOLE-value flow inside a container", () => {
    const a = leaf(1, { topic: "t" }, { idea: "x" });
    const b = leaf(2, { seed: { idea: "x" } }, { out: 1 });
    const graph: RegionGraph = {
      roots: [fanout(9, [[a, b]])],
      edges: [{ from: 1, to: 2, field: "seed", kind: "data" }],
      warnings: [],
    };
    const plan = planNesting(graph);
    expect(plan.nested.has(1)).toBe(true);
    expect(plan.childOf.get(2)?.get("seed")?.id).toBe(1);
  });

  it("does NOT nest a fan-out producer, even on whole-value flow (the matryoshka fix)", () => {
    // a's WHOLE value flows into b's `seed` field AND into a separate consumer c. The old
    // value-equality walk absorbed a into b at its first field, burying the wire to c. The
    // topology gate sees a's out-degree is 2 → a stays a wired sibling, both wires drawn.
    const a = leaf(1, { topic: "t" }, { idea: "x" });
    const b = leaf(2, { seed: { idea: "x" } }, { out: 1 });
    const c = leaf(3, { also: { idea: "x" } }, { out: 2 });
    const graph: RegionGraph = {
      roots: [fanout(9, [[a, b, c]])],
      edges: [
        { from: 1, to: 2, field: "seed", kind: "data" },
        { from: 1, to: 3, field: "also", kind: "data" },
      ],
      warnings: [],
    };
    expect(planNesting(graph).nested.has(1)).toBe(false);
  });

  it("wires (does NOT nest) a field-PLUCK inside a container", () => {
    // a is {idea, energy}; b's slot holds only the plucked `idea` string — a's whole
    // value is NOT in the slot, so it's a wire to the field-row, not an absorption.
    const a = leaf(1, { topic: "t" }, { idea: "x", energy: 0.7 });
    const b = leaf(2, { idea: "x" }, { out: 1 });
    const graph: RegionGraph = {
      roots: [fanout(9, [[a, b]])],
      edges: [{ from: 1, to: 2, field: "idea", kind: "data" }],
      warnings: [],
    };
    expect(planNesting(graph).nested.size).toBe(0);
  });
});
