/**
 * region-elk-layout — the blueprint's layered layout over a RegionGraph, tested
 * headlessly (ELK in-process, no DOM). Two rules:
 *
 *   1. THE NODE SET IS THE SCOPE UNION — every runtime instance of one `(infer …)`
 *      call folds onto ONE node keyed by its structural scope, so a container's node
 *      set is the UNION of scopes across all iterations and is STABLE across Z-tabs (a
 *      tab switch no longer changes which nodes mount; a 1000-iter loop folds to ONE
 *      body — all passes share scopes). The selected tab is not a node-set filter; it
 *      only leads the order.
 *   2. WIRES BREAK AT CONTAINER BOUNDARIES — a producer→consumer wire that crosses
 *      a frame edge is routed through a PORT: the value exits each enclosing
 *      container via a right-edge `out` slot and enters each target container via a
 *      left-edge `in` slot. Ports are keyed by the originating producer's SCOPE, so
 *      all consumers of one value (and all iterations of one producer) share one slot.
 */
import { readFileSync } from "node:fs";

import type { Region, RegionGraph } from "@here.build/arrival-provenance";
import { describe, expect, it } from "vitest";

import { causalGraph } from "../workflow/causal.js";
import { getElk } from "../workflow/elk.js";
import { regionElkLayout, type RegionLayout, type WireEnd } from "../workflow/region-elk-layout.js";

// The real lazy engine (`elk.bundled.js`, main thread) injected explicitly, as the view does.
const elk = await getElk();

// `scope` defaults to a per-leaf-unique string so distinct leaves get distinct
// boundary-port slots; pass an explicit shared scope to model the SAME structural
// `(infer …)` call recurring across a fanout's iterations (one dataflow, one port).
const leaf = (id: number, label: string, scope = `${label}@${id}`): Region => ({
  kind: "leaf",
  id,
  label,
  scope,
  nodeKind: "direct",
  state: "resolved",
  value: id,
});
const fanout = (id: number, label: string, iterations: Region[][], scope = `${label}@${id}`): Region => ({
  kind: "fanout",
  id,
  scope,
  stages: [{ label, id }],
  incoming: iterations.length,
  iterations,
  inputs: [],
  outputs: [],
});

const ids = (r: { nodes: { region: { id: number } }[] }) => r.nodes.map((p) => p.region.id).sort((a, b) => a - b);
const endStr = (w: WireEnd): string => (w.kind === "card" ? `c${w.id}` : `${w.frame}${w.side}${w.slot}`);
const segKeys = (r: { segments: { from: WireEnd; to: WireEnd }[] }) =>
  r.segments.map((s) => `${endStr(s.from)}>${endStr(s.to)}`).sort();

// Fanout F(1) ⊃ { tab0:[A(10), B(11)], tab1:[C(12)] };  D(20) at root.
// edges: A→B (inside tab0), B→D (crosses out), C→D (from the OTHER tab).
const GRAPH: RegionGraph = {
  roots: [fanout(1, "loop", [[leaf(10, "A"), leaf(11, "B")], [leaf(12, "C")]]), leaf(20, "D")],
  edges: [
    { from: 10, to: 11, kind: "data" },
    { from: 11, to: 20, kind: "data" },
    { from: 12, to: 20, kind: "data" },
  ],
  warnings: [],
};

describe("regionElkLayout — the scope union is the node set, ports are the boundary", () => {
  // Folded: under the scope union, A,B,C all have distinct scopes, so the fanout body's
  // node set is {A,B,C} on EVERY tab — the tab is not a node-set filter (was: tab0 →
  // [1,10,11,20], tab1 → [1,12,20]). The data layout is stable across the switch. Expected
  // wires, hand-checked against the fixture's edges A→B, B→D, C→D:
  //   c10>c11               — A→B, wholly inside F → card-to-card (no boundary crossed)
  //   c11>1out0, 1out0>c20  — B→D: the RETURN LINE (B's card → its map's exit knob,
  //                "this section is what the body returns" — drawn for non-loop
  //                fan-outs; a TCO loop's return rides the loop-back contour instead),
  //                then the region-sourced continuation (knob → D).
  //   c12>1out1, 1out1>c20  — C→D, same at C's scope slot 1
  // (B→D routes before C→D, so scope `B@11` takes exit slot 0 and `C@12` slot 1.)
  const UNION_IDS = [1, 10, 11, 12, 20];
  const UNION_SEGS = ["1out0>c20", "1out1>c20", "c10>c11", "c11>1out0", "c12>1out1"].sort();

  it("mounts the scope union (all iterations' leaves) regardless of which tab is selected", async () => {
    const r = await regionElkLayout(GRAPH, new Map(), () => undefined, undefined, elk); // tab 0
    expect(ids(r)).toEqual(UNION_IDS); // C(12) folds in too — the union, not just tab 0
    expect(segKeys(r)).toEqual(UNION_SEGS);
    for (const p of r.nodes) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
    // The frame is open (not a leaf); its child A is parented to it.
    expect(r.nodes.find((p) => p.region.id === 1)!.isLeaf).toBe(false);
    expect(r.nodes.find((p) => p.region.id === 10)!.parentId).toBe(1);
    // IN-CONTAINER dataflow still orders the frame's children: A left of B.
    const a = r.nodes.find((p) => p.region.id === 10)!;
    const b = r.nodes.find((p) => p.region.id === 11)!;
    expect(a.x).toBeLessThan(b.x);
    // Each folded node carries its iteration-ordered instances (singletons here — distinct
    // scopes, one instance each — so the representative IS the only instance).
    expect(r.nodes.find((p) => p.region.id === 10)!.instances?.map((i) => i.id)).toEqual([10]);
  });

  it("independent siblings with NO dataflow stack VERTICALLY (same causal layer), not a temporal horizontal chain", async () => {
    // Two root leaves, no edge between them — mutually independent (a `map` of independent
    // triages; parallel work). They must land in the SAME causal layer — x-ranges OVERLAP —
    // and stack at distinct y, NOT step across x. The removed `seq:` emit-order fallback used
    // to push B into a later layer, x-separating them; this locks in parallel = vertical.
    const g: RegionGraph = { roots: [leaf(1, "A"), leaf(2, "B")], edges: [], warnings: [] };
    const r = await regionElkLayout(g, new Map(), () => undefined, undefined, elk);
    const a = r.nodes.find((p) => p.region.id === 1)!;
    const b = r.nodes.find((p) => p.region.id === 2)!;
    const overlapX = a.x < b.x + b.width && b.x < a.x + a.width;
    expect(overlapX).toBe(true); // same causal layer — a temporal seq edge would have x-separated them
    expect(a.y).not.toBe(b.y); // stacked as parallel tracks
  });

  it("a folded consumer keeps its wire from an off-representative iteration (no silent drop)", async () => {
    // Two map iterations hit DIFFERENT producer sites (P@a / P@b — distinct scopes, don't fold)
    // but the SAME consumer site (C@c — folds to ONE node, rep #20 standing for #20+#21). The
    // iter-1 edge (11→21) names the folded-AWAY consumer #21, which is not itself `visible`; it
    // must re-point onto the rep #20, or `liftToVisible` climbs past it to the fanout and the
    // wire reads as an internal containment pair and is silently dropped — iteration 1's
    // producer looking like an orphan (the "a quiet idea" bug). Both producer→consumer wires
    // must draw.
    const g: RegionGraph = {
      roots: [
        fanout(1, "map", [
          [leaf(10, "P", "P@a"), leaf(20, "C", "C@c")],
          [leaf(11, "P", "P@b"), leaf(21, "C", "C@c")],
        ]),
      ],
      edges: [
        { from: 10, to: 20, field: "x", kind: "data" },
        { from: 11, to: 21, field: "x", kind: "data" },
      ],
      warnings: [],
    };
    const r = await regionElkLayout(g, new Map(), () => undefined, undefined, elk);
    const wire = (from: number, to: number) =>
      r.segments.some((s) => s.from.kind === "card" && s.from.id === from && s.to.kind === "card" && s.to.id === to);
    expect(wire(10, 20)).toBe(true); // iter-0 producer → consumer (always worked)
    expect(wire(11, 20)).toBe(true); // iter-1 producer → FOLDED consumer (the fix — was silently dropped)
  });

  it("flips to the other tab — the node set and wiring are UNCHANGED (data is folded/stable)", async () => {
    const r = await regionElkLayout(GRAPH, new Map([[1, 1]]), () => undefined, undefined, elk); // tab 1
    // Tab-switch no longer changes which nodes mount: same union, same wires as tab 0. The
    // layout no longer JUMPS — that is the whole point of folding onto scope identity.
    expect(ids(r)).toEqual(UNION_IDS);
    expect(segKeys(r)).toEqual(UNION_SEGS);
  });

  it("uses a measured rect when sizeOf provides one", async () => {
    const sizeOf = (id: number) => (id === 20 ? { width: 300, height: 140 } : undefined);
    const r = await regionElkLayout(GRAPH, new Map(), sizeOf, undefined, elk);
    const d = r.nodes.find((p) => p.region.id === 20)!;
    expect(d.width).toBe(300);
    expect(d.height).toBe(140);
  });

  it("routes an external value INTO a container through a left-edge entrance port", async () => {
    // S(30) at root feeds P(40) inside G(2): the value ENTERS G via entrance slot 0.
    const g: RegionGraph = {
      roots: [leaf(30, "S"), fanout(2, "map", [[leaf(40, "P")]])],
      edges: [{ from: 30, to: 40, kind: "data" }],
      warnings: [],
    };
    const r = await regionElkLayout(g, new Map(), () => undefined, undefined, elk);
    expect(segKeys(r)).toEqual(["2in0>c40", "c30>2in0"].sort());
  });

  it("routes container-to-container through an exit port then an entrance port", async () => {
    // X(50) inside A(2) feeds Y(60) inside B(3): exit A's right slot, cross, enter B's
    // left slot — the canonical container→container hop.
    const g: RegionGraph = {
      roots: [fanout(2, "map", [[leaf(50, "X")]]), fanout(3, "filter", [[leaf(60, "Y")]])],
      edges: [{ from: 50, to: 60, kind: "data" }],
      warnings: [],
    };
    const r = await regionElkLayout(g, new Map(), () => undefined, undefined, elk);
    expect(segKeys(r)).toEqual(["2out0>3in0", "c50>2out0", "3in0>c60"].sort());
  });

  it("shares one entrance slot when a value feeds several inner consumers (multi-consumer)", async () => {
    // S(30) feeds both P(40) and Q(41) inside G(2): ONE entrance slot, two inner taps.
    const g: RegionGraph = {
      roots: [leaf(30, "S"), fanout(2, "map", [[leaf(40, "P"), leaf(41, "Q")]])],
      edges: [
        { from: 30, to: 40, kind: "data" },
        { from: 30, to: 41, kind: "data" },
      ],
      warnings: [],
    };
    const r = await regionElkLayout(g, new Map(), () => undefined, undefined, elk);
    // c30→2in0 appears ONCE (deduped); the single slot fans to both consumers.
    expect(segKeys(r)).toEqual(["2in0>c40", "2in0>c41", "c30>2in0"].sort());
  });

  it("collapses N iteration-values of one map producer into ONE exit dataflow port", async () => {
    // map M(1) runs its body twice: P(10) on tab 0, P(11) on tab 1 — the SAME
    // structural `(infer …)` call (shared scope), so it's ONE dataflow, not two.
    // Both feed D(20). The fix keys the exit slot by producer SCOPE, so tab 0's
    // visible P and tab 1's hidden P share exit slot 0 → a single wire to D, instead
    // of one wire PER VALUE (the regression: P would take slot 0, hidden P slot 1).
    const sc = "infer@5:0";
    const g: RegionGraph = {
      roots: [fanout(1, "map", [[leaf(10, "P", sc)], [leaf(11, "P", sc)]]), leaf(20, "D")],
      edges: [
        { from: 10, to: 20, kind: "data" },
        { from: 11, to: 20, kind: "data" },
      ],
      warnings: [],
    };
    const r = await regionElkLayout(g, new Map(), () => undefined, undefined, elk); // tab 0
    // ONE exit port (slot 0): the visible P docks at it, and it carries to D. The
    // hidden iteration's value emerges from the SAME slot — no second port.
    expect(segKeys(r)).toEqual(["1out0>c20", "c10>1out0"].sort());
  });

  it("COLLAPSED fanout emits no internals — boundary wires lift to its ports (Stage 2c)", async () => {
    // Same shape as the multi-consumer case: S(30) feeds P(40)+Q(41) inside G(2).
    // Collapsing G hides BOTH inner leaves, so the box is childless and every wire
    // into it stops at its entrance port — a hermetic box reduced to a port rail.
    const g: RegionGraph = {
      roots: [leaf(30, "S"), fanout(2, "map", [[leaf(40, "P"), leaf(41, "Q")]])],
      edges: [
        { from: 30, to: 40, kind: "data" },
        { from: 30, to: 41, kind: "data" },
      ],
      warnings: [],
    };
    const r = await regionElkLayout(g, new Map(), () => undefined, new Set([2]), elk);
    // Only S(30) and the collapsed frame G(2) are emitted — P, Q never mount.
    expect(ids(r)).toEqual([2, 30]);
    // The wire stops at G's entrance port; the inner card→card hop is gone (hidden).
    expect(segKeys(r)).toEqual(["c30>2in0"]);
    // The collapsed frame is still a frame (not a leaf), sized to hold its rail.
    const frame = r.nodes.find((p) => p.region.id === 2)!;
    expect(frame.isLeaf).toBe(false);
    expect(frame.height).toBeGreaterThan(0);
  });
});

// Recorded RegionGraphs (captured from real traces), as the view lays them out: causal, so no
// decision or control edge survives — each lays out without a silent drop.

const fixture = (name: string): RegionGraph =>
  causalGraph(
    JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed fixture names from this file
      readFileSync(new URL(`../workflow/__fixtures__/${name}-graph.json`, import.meta.url), "utf8"),
    ) as RegionGraph,
    { tools: true },
  );

const auditSum = (a: RegionLayout["wireAudit"]): number => Object.values(a).reduce((x, y) => x + y, 0);

const expectSound = (graph: RegionGraph, r: RegionLayout): void => {
  expect(r.nodes.length).toBeGreaterThan(0);
  for (const p of r.nodes) {
    for (const v of [p.x, p.y, p.width, p.height]) expect(Number.isFinite(v)).toBe(true);
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
  }
  for (const root of graph.roots) expect(r.nodes.some((p) => p.region.id === root.id)).toBe(true);
  expect(r.wireAudit.unaccounted).toBe(0);
  expect(auditSum(r.wireAudit)).toBe(graph.edges.length); // wire conservation: every edge lands in one fate
};

const fanoutsOf = (rs: readonly Region[]): Extract<Region, { kind: "fanout" }>[] =>
  rs.flatMap((r) => (r.kind === "fanout" ? [r, ...r.iterations.flatMap(fanoutsOf)] : []));

describe("recorded fixtures — finite geometry, wires conserved", () => {
  for (const name of ["linear-chain", "branch-downstream", "loop-refine", "same-name-collision"]) {
    it(name, async () => {
      const graph = fixture(name);
      expectSound(graph, await regionElkLayout(graph, new Map(), () => undefined, undefined, elk));
    });
  }

  it("loop-refine re-lays out on every iteration tab, node set unchanged", async () => {
    const graph = fixture("loop-refine");
    const loop = fanoutsOf(graph.roots).find((f) => f.iterations.length > 1);
    expect(loop, "fixture has a multi-iteration fanout").toBeDefined();
    const first = await regionElkLayout(graph, new Map(), () => undefined, undefined, elk);
    for (let k = 1; k < loop!.iterations.length; k++) {
      const r = await regionElkLayout(graph, new Map([[loop!.id, k]]), () => undefined, undefined, elk);
      expectSound(graph, r);
      expect(r.nodes.map((p) => p.region.id).sort()).toEqual(first.nodes.map((p) => p.region.id).sort());
    }
  });

  it("collapsing every fanout still conserves wires", async () => {
    const graph = fixture("loop-refine");
    const collapsed = new Set(fanoutsOf(graph.roots).map((f) => f.id));
    expectSound(graph, await regionElkLayout(graph, new Map(), () => undefined, collapsed, elk));
  });
});
