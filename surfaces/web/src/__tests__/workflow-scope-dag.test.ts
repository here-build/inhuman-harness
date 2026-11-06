/**
 * buildScopeDags — the AST-grounded fold behind the blueprint render. Three properties:
 *
 *  1. FAN-OUT is topology, not a guess. A producer feeding two consumers has out-degree 2
 *     in its container's data DAG — the fact the old value-equality `planNesting` was blind
 *     to (it absorbed the producer into the first matching field, burying the second wire).
 *  2. DIRECT TCO folds N passes of one AST site onto one node; the tail re-entry `A→A` is
 *     lifted out of the interior (it's the loop-back arc, not a stackable edge).
 *  3. TICK-TACK (mutual recursion) folds to a two-node interior `A→B` with the re-entry
 *     `B→A` lifted — the same rule, just a 2-node loop body. No special case.
 */
import type { Region, RegionGraph } from "@here.build/arrival-provenance";
import { describe, expect, it } from "vitest";

import { buildScopeDags, stacksOf } from "../workflow/scope-dag.js";

const leaf = (id: number, scope: string, value?: unknown): Region => ({
  kind: "leaf",
  id,
  label: `n${id}`,
  scope,
  nodeKind: "prompt",
  meta: { kind: "prompt", path: `${scope}.prompt`, model: "m", inputs: {} },
  value: value ?? { v: id },
  state: "resolved",
});

const fanout = (id: number, scope: string, iterations: Region[][], loop = false): Region => ({
  kind: "fanout",
  id,
  scope,
  stages: [{ label: loop ? "loop" : "map", id }],
  iterations,
  incoming: iterations.length,
  loop,
  inputs: [],
  outputs: [],
});

describe("buildScopeDags", () => {
  it("captures a fan-out producer as out-degree 2 (the matryoshka bug, structurally)", () => {
    // profile's WHOLE value flows BOTH into extract-axis's `profile` field AND into the
    // separate extract-identity chain. The old absorption buried the second wire; here it's
    // simply two outgoing data edges from one folded node.
    const profile = leaf(1, "P@1:1");
    const extractAxis = leaf(2, "X@2:1");
    const extractIdentity = leaf(3, "I@3:1");
    const graph: RegionGraph = {
      roots: [profile, extractAxis, extractIdentity],
      edges: [
        { from: 1, to: 2, field: "profile", kind: "data" },
        { from: 1, to: 3, kind: "data" },
      ],
      warnings: [],
    };
    const root = buildScopeDags(graph).get("")!;
    const fromProfile = root.dataEdges.filter((e) => e.from === "P@1:1");
    expect(fromProfile.map((e) => e.to).sort()).toEqual(["I@3:1", "X@2:1"]);
    expect(root.reentry).toEqual([]);
  });

  it("folds direct TCO: N passes → one node, self re-entry lifted out of the interior", () => {
    // A loop body of one `(infer …)` site, run twice; the tail call feeds pass 0 → pass 1.
    const a0 = leaf(1, "A@1:1");
    const a1 = leaf(2, "A@1:1");
    const graph: RegionGraph = {
      roots: [fanout(9, "L@9:1", [[a0], [a1]], true)],
      edges: [{ from: 1, to: 2, kind: "data" }],
      warnings: [],
    };
    const dag = buildScopeDags(graph).get("L@9:1")!;
    expect([...dag.nodes.keys()]).toEqual(["A@1:1"]);
    expect(dag.nodes.get("A@1:1")!.instances.map((r) => r.id)).toEqual([1, 2]);
    expect(dag.dataEdges).toEqual([]);
    expect(dag.reentry).toEqual([{ from: "A@1:1", to: "A@1:1", field: undefined, fromField: undefined }]);
  });

  it("folds tick-tack mutual recursion: A→B interior, B→A re-entry lifted", () => {
    // Two AST sites A, B alternating across passes. Same-pass A→B is the interior DAG; the
    // cross-pass tail call B(pass0)→A(pass1) is the loop-back.
    const a0 = leaf(1, "A@1:1");
    const b0 = leaf(2, "B@2:1");
    const a1 = leaf(3, "A@1:1");
    const b1 = leaf(4, "B@2:1");
    const graph: RegionGraph = {
      roots: [
        fanout(
          9,
          "L@9:1",
          [
            [a0, b0],
            [a1, b1],
          ],
          true,
        ),
      ],
      edges: [
        { from: 1, to: 2, kind: "data" }, // A→B pass 0
        { from: 3, to: 4, kind: "data" }, // A→B pass 1 (folds onto the same edge)
        { from: 2, to: 3, kind: "data" }, // B(pass0)→A(pass1) — the re-entry
      ],
      warnings: [],
    };
    const dag = buildScopeDags(graph).get("L@9:1")!;
    expect([...dag.nodes.keys()].sort()).toEqual(["A@1:1", "B@2:1"]);
    expect(dag.dataEdges).toEqual([{ from: "A@1:1", to: "B@2:1", field: undefined, fromField: undefined }]);
    expect(dag.reentry).toEqual([{ from: "B@2:1", to: "A@1:1", field: undefined, fromField: undefined }]);
  });

  it("preserves per-container body order (first-instance appearance), folding iterations onto one node", () => {
    // A loop body of two AST sites A, B run twice. The fold gives two nodes; `order` is
    // the single-pass body order A, B (NOT four entries) — iterations collapse, order
    // survives.
    const a0 = leaf(1, "A@1:1");
    const b0 = leaf(2, "B@2:1");
    const a1 = leaf(3, "A@1:1");
    const b1 = leaf(4, "B@2:1");
    const graph: RegionGraph = {
      roots: [
        fanout(
          9,
          "L@9:1",
          [
            [a0, b0],
            [a1, b1],
          ],
          true,
        ),
      ],
      edges: [],
      warnings: [],
    };
    const dag = buildScopeDags(graph).get("L@9:1")!;
    expect(dag.order.map((n) => n.key)).toEqual(["A@1:1", "B@2:1"]);
    expect(dag.order.map((n) => n.instances.map((r) => r.id))).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it("represents a nested fanout as a single container node in its parent DAG", () => {
    // Root holds a leaf feeding into a nested loop; the loop is ONE node (`#c9`) in the root
    // DAG, with its own interior DAG keyed "9".
    const seed = leaf(1, "S@1:1");
    const inner = leaf(2, "K@2:1");
    const graph: RegionGraph = {
      roots: [seed, fanout(9, "M@9:1", [[inner]], true)],
      edges: [{ from: 1, to: 2, field: "seed", kind: "data" }],
      warnings: [],
    };
    const dags = buildScopeDags(graph);
    const root = dags.get("")!;
    expect(root.nodes.get("#cM@9:1")?.kind).toBe("container");
    // The S→K edge crosses into the loop: at root it lands on the container node #cM@9:1.
    expect(root.dataEdges).toEqual([{ from: "S@1:1", to: "#cM@9:1", field: "seed", fromField: undefined }]);
    expect(dags.get("M@9:1")!.nodes.get("K@2:1")?.kind).toBe("leaf");
  });
});

describe("stacksOf", () => {
  it("does NOT stack a fan-out producer (out-degree 2 terminates the chain)", () => {
    // The matryoshka bug as a theorem: profile feeds two consumers, so neither hop out of
    // it is stackable — it stays a wired sibling, never absorbed.
    const graph: RegionGraph = {
      roots: [leaf(1, "P@1:1"), leaf(2, "X@2:1"), leaf(3, "I@3:1")],
      edges: [
        { from: 1, to: 2, field: "profile", kind: "data" },
        { from: 1, to: 3, kind: "data" },
      ],
      warnings: [],
    };
    expect(stacksOf(buildScopeDags(graph).get("")!)).toEqual([]);
  });

  it("contracts a single-file chain into one stack in dataflow order", () => {
    // a → b → c, each hop out/in-degree 1 → one maximal stack [a,b,c]; c is the sink.
    const graph: RegionGraph = {
      roots: [leaf(1, "A@1:1"), leaf(2, "B@2:1"), leaf(3, "C@3:1")],
      edges: [
        { from: 1, to: 2, field: "a", kind: "data" },
        { from: 2, to: 3, field: "b", kind: "data" },
      ],
      warnings: [],
    };
    const stacks = stacksOf(buildScopeDags(graph).get("")!);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.members).toEqual(["A@1:1", "B@2:1", "C@3:1"]);
    expect(stacks[0]!.edges.map((e) => e.field)).toEqual(["a", "b"]);
  });

  it("terminates a stack at a merge vertex (in-degree 2)", () => {
    // a → c and b → c: c has in-degree 2, so neither hop into it is stackable — a and b
    // stay wired siblings, c is not a stack member.
    const graph: RegionGraph = {
      roots: [leaf(1, "A@1:1"), leaf(2, "B@2:1"), leaf(3, "C@3:1")],
      edges: [
        { from: 1, to: 3, field: "a", kind: "data" },
        { from: 2, to: 3, field: "b", kind: "data" },
      ],
      warnings: [],
    };
    expect(stacksOf(buildScopeDags(graph).get("")!)).toEqual([]);
  });
});
