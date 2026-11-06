/**
 * region-geometry — the pure point/path math behind RegionView's blueprint render. Fixtures
 * mirror the real call shapes: `PlacedRegion` (ELK output folded to absolute coords),
 * `LeafAnchors` (measured DOM anchor rows), `WireEnd` (card/port terminals). Each test locks
 * in a boundary behavior a docstring calls out — clamped bezier tangents, radius-clamped
 * rounding, the port-y averaging/clamp/slot-grid fallback, the degenerate geometries the
 * code guards against.
 */
import type { Region } from "@here.build/arrival-provenance";
import { describe, expect, it } from "vitest";

import type { PositionedRegion, WireEnd } from "../workflow/region-elk-layout.js";
import {
  type AbsRect,
  cardPoint,
  collectLeafIds,
  endPoint,
  FRAME_R,
  type LeafAnchors,
  loopFieldRecursionPath,
  loopIdentityPath,
  loopRecursionPath,
  placeRegions,
  type PlacedRegion,
  resolvePortPts,
  roundedPolyline,
  sameAnchors,
  singleOutField,
  towards,
  wirePath,
  zBox,
  zCard,
  zWire,
} from "../workflow/region-geometry.js";

let nextId = 1;
const leaf = (overrides: Partial<Extract<Region, { kind: "leaf" }>> = {}): Extract<Region, { kind: "leaf" }> => ({
  kind: "leaf",
  id: nextId,
  label: "infer",
  scope: `infer@1:${nextId++}`,
  nodeKind: "direct",
  state: "resolved",
  ...overrides,
});
const fanout = (overrides: Partial<Extract<Region, { kind: "fanout" }>> = {}): Extract<Region, { kind: "fanout" }> => ({
  kind: "fanout",
  id: nextId,
  scope: `map@1:${nextId++}`,
  stages: [{ label: "map", id: 1 }],
  iterations: [],
  incoming: 0,
  inputs: [],
  outputs: [],
  ...overrides,
});

/** An already-placed card/frame (ax/ay set directly) — the shape `cardPoint`/`resolvePortPts`/
 *  the loop-path functions consume. */
const place = (region: Region, rect: { ax: number; ay: number; width: number; height: number }): PlacedRegion => ({
  region,
  x: rect.ax,
  y: rect.ay,
  ax: rect.ax,
  ay: rect.ay,
  width: rect.width,
  height: rect.height,
  isLeaf: region.kind === "leaf",
  parentId: null,
});

/** A raw ELK-output node (no `ax`/`ay` yet) — the shape `placeRegions` folds into absolute
 *  coords. */
const positioned = (
  region: Region,
  rect: { x: number; y: number; width: number; height: number; parentId?: number | null },
): PositionedRegion => ({
  region,
  x: rect.x,
  y: rect.y,
  width: rect.width,
  height: rect.height,
  isLeaf: region.kind === "leaf",
  parentId: rect.parentId ?? null,
});

describe("wirePath — blueprint S-curve, horizontal tangent clamped to [24, 90]", () => {
  it("clamps the tangent to a minimum of 24px on a short hop", () => {
    expect(wirePath({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe("M 0 0 C 24 0, -14 0, 10 0");
  });
  it("clamps the tangent to a maximum of 90px on a long hop", () => {
    expect(wirePath({ x: 0, y: 0 }, { x: 400, y: 20 })).toBe("M 0 0 C 90 0, 310 20, 400 20");
  });
  it("uses half the horizontal span when it falls inside [24, 90]", () => {
    expect(wirePath({ x: 0, y: 0 }, { x: 100, y: 40 })).toBe("M 0 0 C 50 0, 50 40, 100 40");
  });
});

describe("towards — point t px from a toward b", () => {
  it("moves along a straight horizontal line", () => {
    expect(towards({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)).toEqual({ x: 4, y: 0 });
  });
  it("moves the full distance along a 3-4-5 diagonal", () => {
    expect(towards({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toEqual({ x: 3, y: 4 });
  });
  it("guards divide-by-zero when a and b coincide — returns a unmoved", () => {
    expect(towards({ x: 5, y: 5 }, { x: 5, y: 5 }, 10)).toEqual({ x: 5, y: 5 });
  });
});

describe("roundedPolyline — fixed-radius interior rounding, clamped to half the shorter adjacent segment", () => {
  it("returns empty string for fewer than 2 points (the code's own degenerate guard)", () => {
    expect(roundedPolyline([], 10)).toBe("");
    expect(roundedPolyline([{ x: 0, y: 0 }], 10)).toBe("");
  });
  it("draws a plain line with no interior vertices to round (exactly 2 points)", () => {
    expect(
      roundedPolyline(
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        10,
      ),
    ).toBe("M 0 0 L 10 10");
  });
  it("rounds a right-angle corner at the requested radius when segments are long enough", () => {
    const d = roundedPolyline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      100,
    );
    expect(d).toBe("M 0 0 L 5 0 Q 10 0 10 5 L 10 10");
  });
  it("clamps the radius to half the shorter adjacent segment — the degenerate-geometry guard", () => {
    // adjacent segments are 10 and 2 long; a naive r=100 would blow the short side out.
    const d = roundedPolyline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 12, y: 0 },
      ],
      100,
    );
    expect(d).toBe("M 0 0 L 9 0 Q 10 0 11 0 L 12 0");
  });
});

describe("loopIdentityPath — the TCO IDENTITY loop-back arc (unchanged pool recirculates)", () => {
  it("bows LOOP_D left of the frame at the default D, entering the joint from below", () => {
    const f = place(fanout(), { ax: 100, ay: 50, width: 80, height: 40 });
    const d = loopIdentityPath(f, { x: 100, y: 30 });
    expect(d).toBe("M 100 70 L 91 70 Q 82 70 82 61 L 82 39 Q 82 30 91 30 L 100 30");
  });
});

describe("loopRecursionPath — TCO recursion wire fused with the frame contour", () => {
  it("starts at the recurring output row and ends at the joint, tracing 3 rounded corners", () => {
    const f = place(fanout(), { ax: 0, ay: 0, width: 120, height: 60 });
    const d = loopRecursionPath(f, { x: 90, y: 15 }, { x: 0, y: 45 });
    expect(d.startsWith("M 90 15")).toBe(true);
    expect(d.endsWith("L 0 45")).toBe(true);
    expect(d.match(/Q/g)).toHaveLength(3); // 5 waypoints → 3 interior corners
  });
});

describe("loopFieldRecursionPath — TCO recursion wire docking a known sink ROW", () => {
  const f = place(fanout(), { ax: 0, ay: 0, width: 100, height: 50 });

  it("adds the final hop when the sink sits off the border (sink.x - xL > 1)", () => {
    const d = loopFieldRecursionPath(f, { x: 80, y: 10 }, { x: 20, y: 40 });
    expect(d.startsWith("M 80 10")).toBe(true);
    expect(d.endsWith("L 20 40")).toBe(true); // the hop lands exactly on the sink
    expect(d.match(/Q/g)).toHaveLength(4); // 6 waypoints (hop pushed) → 4 interior corners
  });

  it("skips the hop for a flush card — the sink sits ON the border (sink.x - xL <= 1)", () => {
    const d = loopFieldRecursionPath(f, { x: 80, y: 10 }, { x: 0.5, y: 40 });
    // no hop pushed: the polyline's last waypoint stays at (xL=0, sink.y), NOT the sink's own x.
    expect(d.endsWith("L 0 40")).toBe(true);
    expect(d.match(/Q/g)).toHaveLength(3); // 5 waypoints (no hop) → 3 interior corners
  });

  it("FRAME_R governs the corner radius (sanity: it's the constant the module exports)", () => {
    expect(FRAME_R).toBe(8);
  });
});

describe("singleOutField — the sole output field a value exposes", () => {
  it("returns the one key of a single-field object", () => {
    expect(singleOutField({ idea: "x" })).toBe("idea");
  });
  it("unwraps a 1-element array wrapping a single-field object", () => {
    expect(singleOutField([{ idea: "x" }])).toBe("idea");
  });
  it("unwraps NESTED 1-element arrays", () => {
    expect(singleOutField([[{ idea: "x" }]])).toBe("idea");
  });
  it("returns undefined for a multi-field object", () => {
    expect(singleOutField({ idea: "x", energy: 0.7 })).toBeUndefined();
  });
  it("returns undefined for a scalar value", () => {
    expect(singleOutField("just a string")).toBeUndefined();
  });
  it("returns undefined for an empty array (unwrap guard: length must be exactly 1)", () => {
    expect(singleOutField([])).toBeUndefined();
  });
  it("returns undefined for a multi-element array (never unwrapped, stays an array)", () => {
    expect(singleOutField([{ idea: "x" }, { idea: "y" }])).toBeUndefined();
  });
});

describe("collectLeafIds — every leaf id in a region list (DFS across ALL fanout iterations)", () => {
  it("collects leaves across every iteration of a nested fanout, not just one", () => {
    const a = leaf({ id: 101 });
    const b = leaf({ id: 102 });
    const c = leaf({ id: 103 });
    const inner = fanout({ id: 104, iterations: [[leaf({ id: 105 })], [leaf({ id: 106 })]] });
    const graph = fanout({
      id: 107,
      iterations: [
        [a, inner],
        [b, c],
      ],
    });
    expect([...collectLeafIds([graph])].sort((x, y) => x - y)).toEqual([101, 102, 103, 105, 106]);
  });
  it("accumulates into a caller-provided `out` set instead of replacing it", () => {
    const out = new Set<number>([1]);
    collectLeafIds([leaf({ id: 2 })], out);
    expect([...out].sort((x, y) => x - y)).toEqual([1, 2]);
  });
});

describe("sameAnchors — anchors equal within 1px (avoids re-rendering wires on measurement jitter)", () => {
  it("treats a sub-pixel result drift as equal", () => {
    expect(sameAnchors({ result: 10, fields: new Map() }, { result: 10.5, fields: new Map() })).toBe(true);
  });
  it("treats a >1px result drift as a change", () => {
    expect(sameAnchors({ result: 10, fields: new Map() }, { result: 12, fields: new Map() })).toBe(false);
  });
  it("treats both anchors having no result as equal", () => {
    expect(sameAnchors({ fields: new Map() }, { fields: new Map() })).toBe(true);
  });
  it("treats a different field-map size as a change", () => {
    expect(sameAnchors({ fields: new Map([["in:a", 1]]) }, { fields: new Map() })).toBe(false);
  });
  it("treats a >1px field-row drift as a change", () => {
    const a: LeafAnchors = { fields: new Map([["in:a", 10]]) };
    const b: LeafAnchors = { fields: new Map([["in:a", 13]]) };
    expect(sameAnchors(a, b)).toBe(false);
  });
  it("treats a missing field key in the comparison side as a change", () => {
    const a: LeafAnchors = { fields: new Map([["in:a", 10]]) };
    const b: LeafAnchors = { fields: new Map([["in:b", 10]]) };
    expect(sameAnchors(a, b)).toBe(false);
  });
});

describe("placeRegions — folds ELK's parent-relative coords into absolute wrapper coords", () => {
  it("folds offsets through TWO levels of nesting and computes depth/bounds", () => {
    const root = fanout({ id: 1 });
    const child = leaf({ id: 2 });
    const grandchild = leaf({ id: 3 });
    const layout = {
      nodes: [
        positioned(root, { x: 0, y: 0, width: 200, height: 150, parentId: null }),
        positioned(child, { x: 10, y: 60, width: 80, height: 40, parentId: 1 }),
        positioned(grandchild, { x: 5, y: 5, width: 20, height: 10, parentId: 2 }),
      ],
      stubs: [],
      segments: [],
      wireAudit: {
        wire: 0,
        folded: 0,
        loopback: 0,
        ghost: 0,
        containment: 0,
        unaccounted: 0,
      },
    };
    const { placed, width, height, depthOf } = placeRegions(layout);
    const [pRoot, pChild, pGrandchild] = placed;
    expect(pRoot).toMatchObject({ ax: 0, ay: 0 });
    expect(pChild).toMatchObject({ ax: 10, ay: 60 }); // root origin (0,0) + its own (10,60)
    expect(pGrandchild).toMatchObject({ ax: 15, ay: 65 }); // child origin (10,60) + its own (5,5)
    expect(depthOf.get(1)).toBe(0);
    expect(depthOf.get(2)).toBe(1);
    expect(depthOf.get(3)).toBe(2);
    // bounds = max(ax+width, ay+height) over all nodes + WRAP_MARGIN(24); root's own
    // extent (200x150) dominates here.
    expect(width).toBe(200 + 24);
    expect(height).toBe(150 + 24);
  });
});

describe("cardPoint — resolve a CARD wire terminal to an absolute point", () => {
  it("docks the FROM (producer) side at the measured result-block center", () => {
    const byId = new Map<number, PlacedRegion>([
      [1, place(leaf({ id: 1 }), { ax: 10, ay: 20, width: 100, height: 50 })],
    ]);
    const anchors = new Map<number, LeafAnchors>([[1, { result: 30, fields: new Map() }]]);
    expect(cardPoint({ kind: "card", id: 1 }, "from", byId, anchors)).toEqual({ x: 110, y: 50 });
  });
  it("docks the TO (consumer) side at the left edge, at the matched input-field row", () => {
    const byId = new Map<number, PlacedRegion>([
      [1, place(leaf({ id: 1 }), { ax: 10, ay: 20, width: 100, height: 50 })],
    ]);
    const anchors = new Map<number, LeafAnchors>([[1, { fields: new Map([["in:seed", 12]]) }]]);
    expect(cardPoint({ kind: "card", id: 1, field: "seed" }, "to", byId, anchors)).toEqual({ x: 10, y: 32 });
  });
  it("falls back to the header port (min(PORT_Y, height/2)) when unmeasured", () => {
    const byId = new Map<number, PlacedRegion>([
      [1, place(leaf({ id: 1 }), { ax: 10, ay: 20, width: 100, height: 50 })],
    ]);
    // height/2 = 25 > PORT_Y = 17, so the header-row fallback (17) wins.
    expect(cardPoint({ kind: "card", id: 1 }, "from", byId, new Map())).toEqual({ x: 110, y: 37 });
  });
  it("clamps the fallback to half the card height on a very short card", () => {
    const byId = new Map<number, PlacedRegion>([[1, place(leaf({ id: 1 }), { ax: 0, ay: 0, width: 100, height: 10 })]]);
    // height/2 = 5 < PORT_Y = 17, so half-height wins.
    expect(cardPoint({ kind: "card", id: 1 }, "from", byId, new Map())).toEqual({ x: 100, y: 5 });
  });
  it("resolves a NESTED producer's absolute rect from `nestedAbs` instead of `byId`", () => {
    const nestedAbs = new Map<number, AbsRect>([[1, { x: 5, y: 5, width: 40, height: 20 }]]);
    const anchors = new Map<number, LeafAnchors>([[1, { result: 8, fields: new Map() }]]);
    expect(cardPoint({ kind: "card", id: 1 }, "from", new Map(), anchors, nestedAbs)).toEqual({ x: 45, y: 13 });
  });
  it("returns null for a card that isn't placed (hidden behind a tab / not yet laid out)", () => {
    const byId = new Map<number, PlacedRegion>([[1, place(leaf({ id: 1 }), { ax: 0, ay: 0, width: 50, height: 20 })]]);
    expect(cardPoint({ kind: "card", id: 999 }, "from", byId, new Map())).toBeNull();
  });
});

describe("endPoint — dispatch a card vs boundary-port wire terminal", () => {
  it("delegates a card terminal to cardPoint", () => {
    const byId = new Map<number, PlacedRegion>([[1, place(leaf({ id: 1 }), { ax: 0, ay: 0, width: 50, height: 20 })]]);
    const anchors = new Map<number, LeafAnchors>([[1, { result: 5, fields: new Map() }]]);
    const w: WireEnd = { kind: "card", id: 1 };
    expect(endPoint(w, "from", byId, anchors, new Map())).toEqual({ x: 50, y: 5 });
  });
  it("looks up a port terminal in the precomputed portPts map, keyed by portKey", () => {
    const portPts = new Map([["3out0", { x: 100, y: 40 }]]);
    const w: WireEnd = { kind: "port", frame: 3, side: "out", slot: 0 };
    expect(endPoint(w, "from", new Map(), new Map(), portPts)).toEqual({ x: 100, y: 40 });
  });
  it("returns null for an unresolved port", () => {
    const w: WireEnd = { kind: "port", frame: 3, side: "in", slot: 1 };
    expect(endPoint(w, "to", new Map(), new Map(), new Map())).toBeNull();
  });
});

describe("resolvePortPts — place every boundary port at the mid-span of its emitter/consumer", () => {
  it("averages both sides, then CLAMPS the result back onto the frame's own body span", () => {
    // Frame 10 spans ay=50..150 with PORT_TOP=48, so its body starts at y=98 — a port whose
    // both-side average (10) sits well ABOVE that must clamp back onto the frame edge.
    const frame = place(fanout({ id: 10 }), { ax: 100, ay: 50, width: 80, height: 100 });
    const cardA = place(leaf({ id: 1 }), { ax: 0, ay: 0, width: 50, height: 20 });
    const cardB = place(leaf({ id: 2 }), { ax: 200, ay: 0, width: 50, height: 20 });
    const byId = new Map([
      [10, frame],
      [1, cardA],
      [2, cardB],
    ]);
    const anchors = new Map<number, LeafAnchors>([
      [1, { result: 10, fields: new Map() }], // cardA "from" → y = 0 + 10 = 10
      [2, { fields: new Map() }], // cardB "to", unmeasured → header fallback y = 0 + 10 = 10 (min(17, 20/2))
    ]);
    const segments = [
      { from: { kind: "card", id: 1 } as WireEnd, to: { kind: "port", frame: 10, side: "out", slot: 0 } as WireEnd },
      { from: { kind: "port", frame: 10, side: "out", slot: 0 } as WireEnd, to: { kind: "card", id: 2 } as WireEnd },
    ];
    const pts = resolvePortPts(segments, byId, anchors);
    // average of (10, 10) = 10, clamped to [ay+PORT_TOP=98, ay+height=150] → 98.
    expect(pts.get("10out0")).toEqual({ x: 180, y: 98 }); // x = f.ax + f.width for an "out" port
  });

  it("falls back to the slot grid when NEITHER side resolves (both hidden behind tabs)", () => {
    const frame = place(fanout({ id: 40 }), { ax: 300, ay: 10, width: 60, height: 200 });
    const byId = new Map([[40, frame]]);
    // The card endpoint (999) is never placed, so its side can't resolve — the port has no
    // resolvable neighbour at all.
    const segments = [
      { from: { kind: "card", id: 999 } as WireEnd, to: { kind: "port", frame: 40, side: "in", slot: 3 } as WireEnd },
    ];
    const pts = resolvePortPts(segments, byId, new Map());
    // y = f.ay + PORT_TOP + slot * PORT_STEP = 10 + 48 + 3*12 = 94.
    expect(pts.get("40in3")).toEqual({ x: 300, y: 94 }); // x = f.ax for an "in" port
  });
});

describe("z-index bands — zBox < zWire < zCard within a depth, and every band clears the next depth's box", () => {
  it("holds the ordering invariant across several depths", () => {
    for (const d of [0, 1, 2]) {
      expect(zBox(d)).toBeLessThan(zWire(d));
      expect(zWire(d)).toBeLessThan(zCard(d));
      expect(zCard(d)).toBeLessThan(zBox(d + 1));
    }
  });
});
