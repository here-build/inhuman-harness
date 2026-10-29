import type { Region, RegionGraph } from "@here.build/arrival-provenance";
import { describe, expect, it } from "vitest";

import { causalGraph, hasTools } from "../workflow/causal.js";

const leaf = (id: number, kind: "agent" | "tool"): Region => ({
  kind: "leaf",
  id,
  label: kind,
  scope: `${kind}@${id}`,
  nodeKind: "direct",
  state: "resolved",
  meta: { kind, verb: kind === "agent" ? "agent/call" : "read_file", name: `n${id}` },
});
const fanout = (id: number, iterations: Region[][]): Extract<Region, { kind: "fanout" }> => ({
  kind: "fanout",
  id,
  scope: `map@${id}`,
  stages: [{ label: "map", id }],
  incoming: iterations.length,
  iterations,
  inputs: [],
  outputs: [],
});
const decision: Region = { kind: "decision", id: 9, label: "if", scope: "if@9", condition: "ok" };

// read (tool 1) → scout (agent 2) → lint (tool 3) → lead (agent 4), with a decision gating a map of one more read.
const graph: RegionGraph = {
  roots: [
    leaf(1, "tool"),
    leaf(2, "agent"),
    leaf(3, "tool"),
    decision,
    fanout(20, [[leaf(5, "tool")], [leaf(4, "agent")]]),
  ],
  edges: [
    { from: 1, to: 2, kind: "data" },
    { from: 2, to: 3, kind: "data", fromField: "plan" },
    { from: 3, to: 4, kind: "data", field: "report" },
    { from: 2, to: 9, kind: "data" },
    { from: 9, to: 20, kind: "control" },
  ],
  warnings: [],
};
const ids = (regions: readonly Region[]): number[] =>
  regions.flatMap((r) => (r.kind === "fanout" ? [r.id, ...r.iterations.flatMap(ids)] : [r.id]));

describe("causalGraph", () => {
  it("drops decisions and every wire that touches one", () => {
    const shown = causalGraph(graph, { tools: true });
    expect(ids(shown.roots)).toEqual([1, 2, 3, 20, 5, 4]);
    expect(shown.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["1>2", "2>3", "3>4"]);
  });

  it("contracts hidden tools: what fed one wires to what read it, keeping both ends' slots", () => {
    const shown = causalGraph(graph, { tools: false });
    expect(ids(shown.roots)).toEqual([2, 20, 4]);
    expect(shown.edges).toEqual([{ from: 2, to: 4, kind: "data", fromField: "plan", field: "report" }]);
  });

  it("re-derives a frame's ports from the wires that survive", () => {
    const frame = causalGraph(graph, { tools: false }).roots[1] as Extract<Region, { kind: "fanout" }>;
    expect(frame.inputs).toEqual([{ producer: "agent@2", field: "report" }]);
    expect(frame.outputs).toEqual([]);
  });

  it("leaves the analysis graph untouched", () => {
    causalGraph(graph, { tools: false });
    expect((graph.roots[4] as Extract<Region, { kind: "fanout" }>).iterations).toHaveLength(2);
    expect(hasTools(graph.roots)).toBe(true);
    expect(hasTools([leaf(2, "agent")])).toBe(false);
  });
});
