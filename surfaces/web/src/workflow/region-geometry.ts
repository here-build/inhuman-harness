/**
 * region-geometry — the pure point/path math behind the blueprint render: folding
 * ELK's parent-relative layout into absolute wrapper coordinates, resolving a wire terminal
 * (a card anchor or a boundary port) to an absolute point, and drawing the blueprint's
 * bezier/rounded-polyline wire paths. No React, no DOM, no store — every function here takes
 * plain data (regions, layouts, maps of measured anchors) in and returns plain data out.
 */
import type { Region } from "@here.build/arrival-provenance";

import type { PositionedRegion, RegionLayout, WireEnd } from "./region-elk-layout.js";

/** A node positioned in absolute wrapper coords (parent frame offsets folded in). */
export interface PlacedRegion extends PositionedRegion {
  ax: number;
  ay: number;
}

/** Nested cards aren't ELK-placed; their absolute position in the wrap coordinate space is
 *  read from the DOM (they live inside a placed consumer). */
export interface AbsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in absolute wrapper coords. */
export interface Pt {
  x: number;
  y: number;
}

/** Per-leaf measured wire anchors, in card-relative y (folded to absolute via `ay`).
 *  `result` = the result block's vertical center (the producer's output port);
 *  `fields` = each input row's center, keyed by kwarg name (a consumer's input port). */
export interface LeafAnchors {
  result?: number;
  fields: Map<string, number>;
}

/** A card's fallback output-port y when its result block hasn't been measured yet —
 *  the header row, so wires stay tidy as cards vary in height. */
export const PORT_Y = 17;
/** Boundary ports: the first slot sits below the frame header (label + Z-tabs), and
 *  successive slots step down 12px (V's spec) on the right (`out`) / left (`in`) edge. */
export const PORT_TOP = 48;
export const PORT_STEP = 12;

/** TCO wrap geometry: the wire bows `LOOP_D` outside the frame contour; its corners use a
 *  FIXED curvature radius `LOOP_R * 2` — bounded, NOT one that grows with the side it spans
 *  ("max width it can take" — V). */
export const LOOP_D = 18;
export const LOOP_R = 9;

/** The frame's own corner radius (`.frame` border-radius) — the wire uses it so it BLENDS with
 *  the loop's border contour rather than bowing outside it. */
export const FRAME_R = 8;

/** Fold ELK's parent-relative coords into absolute wrapper coords. The layout list
 *  is parents-first (ELK walk order), so each node's parent origin is known when we
 *  reach it. Returns placed nodes + the content bounds used to size the wrapper. */
export const WRAP_MARGIN = 24;

/** Depth-banded stacking — the fix for "nested wires draw under the boxes". The render is
 *  FLAT (every node + the wires share one absolute coordinate space; a frame is drawn
 *  behind its children, not as their DOM parent), so a single bottom wire layer puts ALL
 *  spaghetti beneath ALL boxes — and a wire living inside a matryoshka box vanishes under
 *  the opaque cards/frames of the shallower scopes it crosses. Instead we band by
 *  nesting depth `d`: within a band, the box floor sits lowest, its own wires above it, its
 *  cards on top; a child band (d+1) sits entirely above the parent band (d). So a deep
 *  wire draws OVER its ancestor frames (`zWire(d) > zBox(<d)`) yet still tucks BEHIND a
 *  same-level card it merely crosses (`zCard(d) > zWire(d)`). */
export const Z_STEP = 10;
export const zBox = (d: number): number => d * Z_STEP + 1;
export const zWire = (d: number): number => d * Z_STEP + 2;
export const zCard = (d: number): number => d * Z_STEP + 3;

export const portKey = (w: Extract<WireEnd, { kind: "port" }>): string => `${w.frame}${w.side}${w.slot}`;

/** Resolve a CARD terminal to an absolute point: the producer side (`from`) docks at
 *  the result-block center, the consumer side (`to`) at the matched input-field row —
 *  block-to-block, falling back to the header port when unmeasured. Null when the
 *  card isn't placed (hidden behind a tab / not yet laid out). */
export function cardPoint(
  w: Extract<WireEnd, { kind: "card" }>,
  role: "from" | "to",
  byId: Map<number, PlacedRegion>,
  anchors: Map<number, LeafAnchors>,
  nestedAbs?: Map<number, AbsRect>,
): Pt | null {
  const a = anchors.get(w.id);
  // A NESTED producer (absorbed into a consumer field) has no ELK rect — its absolute
  // position is the DOM rect measured inside its host. Anchors stay card-relative, folded
  // onto that absolute origin exactly like the ELK-placed case.
  // The producer (`from`) docks at the result-block center by default, but a GRANULAR
  // wire carries the producer's output FIELD (`spark.idea`) — dock it at that output row
  // so the wire visibly leaves the `idea` line, not the whole box.
  // The `from` end docks at an OUTPUT row (`out:field`), the `to` end at an INPUT slot
  // (`in:field`). Keying by role keeps a card's same-named input/output rows distinct.
  const fieldY = w.field !== undefined ? a?.fields.get(`${role === "from" ? "out" : "in"}:${w.field}`) : undefined;
  const fromY = fieldY ?? a?.result;
  const abs = nestedAbs?.get(w.id);
  if (abs) {
    if (role === "from") return { x: abs.x + abs.width, y: abs.y + (fromY ?? Math.min(PORT_Y, abs.height / 2)) };
    return { x: abs.x, y: abs.y + (fieldY ?? Math.min(PORT_Y, abs.height / 2)) };
  }
  const p = byId.get(w.id);
  if (!p) return null;
  if (role === "from") return { x: p.ax + p.width, y: p.ay + (fromY ?? Math.min(PORT_Y, p.height / 2)) };
  return { x: p.ax, y: p.ay + (fieldY ?? Math.min(PORT_Y, p.height / 2)) };
}

/** Resolve a wire terminal to an absolute point — a card via `cardPoint`, a boundary
 *  port via the precomputed `portPts` map (its y follows the emitter/sink it docks to,
 *  see `resolvePortPts`). Null when the referenced node isn't placed. */
export function endPoint(
  w: WireEnd,
  role: "from" | "to",
  byId: Map<number, PlacedRegion>,
  anchors: Map<number, LeafAnchors>,
  portPts: Map<string, Pt>,
  nestedAbs?: Map<number, AbsRect>,
): Pt | null {
  return w.kind === "card" ? cardPoint(w, role, byId, anchors, nestedAbs) : (portPts.get(portKey(w)) ?? null);
}

/** Place every boundary port. The x is fixed (the frame's right `out` / left `in`
 *  edge); the y sits at the MIDDLE of the emitter↔consumer span — the average of the
 *  endpoints on BOTH sides of the port, not just the inner one. That does two jobs at
 *  once:
 *   - the wires into AND out of the port both run as flat as the geometry allows (the
 *     port meets its producer and consumer halfway), instead of the inner side pinning
 *     the port and the outer wire slanting to reach it;
 *   - ports end up SORTED by their connection centroid — a port whose producer and
 *     consumer both sit high lands high, both low lands low — which is the crossing
 *     reduction: two cards feeding two ports stop swapping order at the frame edge.
 *  Each connected endpoint is resolved at the right dock (a producer at its result
 *  `from`, a consumer at its input row `to`); a neighbouring port recurses. A port with
 *  NO resolvable endpoint on either side (both hidden behind tabs) falls back to the
 *  frame-relative slot grid. A cycle guard returns null on the rare back-edge (the
 *  exit↔entrance chain of a crossing wire), so each port still resolves on its other
 *  neighbours. */
export function resolvePortPts(
  segments: readonly { from: WireEnd; to: WireEnd }[],
  byId: Map<number, PlacedRegion>,
  anchors: Map<number, LeafAnchors>,
  nestedAbs?: Map<number, AbsRect>,
): Map<string, Pt> {
  const ends = new Map<string, Extract<WireEnd, { kind: "port" }>>();
  // port key → its connected neighbours on BOTH sides, each tagged with the role to
  // dock a CARD at: a value leaves its producer at the result block (`from`) and enters
  // its consumer at an input row (`to`). A segment flows from→to, so for a port that is
  // a segment's TARGET the source is a producer (`from`); for a port that is a segment's
  // SOURCE the target is a consumer (`to`). Every boundary port is BOTH (it has an
  // inbound and an outbound segment), so it gathers both sides.
  const neigh = new Map<string, { end: WireEnd; role: "from" | "to" }[]>();
  const add = (k: string, end: WireEnd, role: "from" | "to"): void => {
    let a = neigh.get(k);
    if (!a) neigh.set(k, (a = []));
    a.push({ end, role });
  };
  for (const seg of segments) {
    if (seg.from.kind === "port") ends.set(portKey(seg.from), seg.from);
    if (seg.to.kind === "port") ends.set(portKey(seg.to), seg.to);
    if (seg.to.kind === "port") add(portKey(seg.to), seg.from, "from"); // upstream of the port
    if (seg.from.kind === "port") add(portKey(seg.from), seg.to, "to"); // downstream of the port
  }
  const yMemo = new Map<string, number | null>();
  const resolveY = (key: string, stack: Set<string>): number | null => {
    const cached = yMemo.get(key);
    if (cached !== undefined) return cached;
    if (stack.has(key)) return null; // cycle back-edge — bail, let the other side carry it
    stack.add(key);
    const port = ends.get(key)!;
    const ys: number[] = [];
    for (const { end, role } of neigh.get(key) ?? []) {
      if (end.kind === "card") {
        const pt = cardPoint(end, role, byId, anchors, nestedAbs);
        if (pt) ys.push(pt.y);
      } else {
        const ny = resolveY(portKey(end), stack);
        if (ny !== null) ys.push(ny);
      }
    }
    stack.delete(key);
    const f = byId.get(port.frame);
    let y: number | null = null;
    if (ys.length > 0) {
      y = ys.reduce((s, v) => s + v, 0) / ys.length;
      // A boundary port physically sits on its frame's edge, so its y must stay within
      // the frame's body span. When the only resolvable neighbour is a far node on the
      // OPPOSITE side — e.g. a loop/map whose producer is hidden behind a Z-tab, leaving
      // the out-port with just the distant OUTPUT card — the bare average drags the port
      // off its own frame (it floats up to the output's height, and the loop reads as
      // unwired). Clamp it back onto the frame so the wire visibly leaves the block.
      if (f) y = Math.min(Math.max(y, f.ay + PORT_TOP), f.ay + f.height);
    } else if (f) y = f.ay + PORT_TOP + port.slot * PORT_STEP; // both sides hidden → slot grid
    yMemo.set(key, y);
    return y;
  };
  const out = new Map<string, Pt>();
  for (const [key, port] of ends) {
    const f = byId.get(port.frame);
    if (!f) continue;
    const y = resolveY(key, new Set());
    if (y !== null) out.set(key, { x: port.side === "out" ? f.ax + f.width : f.ax, y });
  }
  return out;
}

/** A blueprint S-curve between two points with horizontal tangents — the node-editor
 *  "spaghetti" look, independent of whether each end is a card anchor or a port. */
export function wirePath(a: Pt, b: Pt): string {
  const dx = Math.max(24, Math.min(90, Math.abs(b.x - a.x) * 0.5));
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** Point `t`px from `a` toward `b`. */
export function towards(a: Pt, b: Pt, t: number): Pt {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + ((b.x - a.x) / d) * t, y: a.y + ((b.y - a.y) / d) * t };
}

/** A polyline drawn with each interior vertex rounded to a FIXED radius `r` (a quadratic
 *  corner — the squircle-ish round), clamped to half the shorter adjacent segment so a
 *  short side can't blow the corner out. The curvature is bounded, not proportional to the
 *  side length. */
export function roundedPolyline(pts: Pt[], r: number): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const rr = Math.min(r, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2);
    const a = towards(p1, p0, rr);
    const b = towards(p1, p2, rr);
    d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** The TCO recursion wire, FUSED with the loop contour: it leaves the recurring output ROW,
 *  curves right until it reaches the frame's RIGHT border, then traces the border itself — down
 *  the right side, across the bottom, up the left — and rises into the consumer `joint` FROM
 *  BELOW (a vertical approach up the left border), not horizontally from outside. Corner radius
 *  matches the frame so the wire reads as the contour carrying the value back around. */
export function loopRecursionPath(f: PlacedRegion, srcPt: Pt, joint: Pt): string {
  const xR = f.ax + f.width; // ON the right border
  const xL = f.ax; // ON the left border
  const yB = f.ay + f.height; // ON the bottom border
  return roundedPolyline(
    [
      { x: srcPt.x, y: srcPt.y }, // the recurring output ROW's right edge (the value fed to next round)
      { x: xR, y: srcPt.y }, // curve right, over the right border
      { x: xR, y: yB }, // down the right border — fused with the contour
      { x: xL, y: yB }, // across the bottom border
      { x: joint.x, y: joint.y }, // up the left border into the consumer dot — FROM BELOW
    ],
    FRAME_R,
  );
}

/** The single output field a value exposes (unwrapping the 1-element array the render unfolds) —
 *  the row a loop-carried value leaves from, when the recurrence source ships one field. */
export function singleOutField(v: unknown): string | undefined {
  let u = v;
  while (Array.isArray(u) && u.length === 1) u = u[0];
  if (u !== null && typeof u === "object" && !Array.isArray(u)) {
    const ks = Object.keys(u as object);
    if (ks.length === 1) return ks[0];
  }
  return undefined;
}

/** Every leaf id in a region list (DFS) — a loop's membership across all iterations, or one
 *  iteration's leaves. Used to spot a recursion edge: an edge whose producer AND consumer are
 *  both inside the same loop. */
export function collectLeafIds(regions: readonly Region[], out: Set<number> = new Set()): Set<number> {
  for (const r of regions) {
    if (r.kind === "leaf") out.add(r.id);
    else if (r.kind === "fanout") for (const it of r.iterations) collectLeafIds(it, out);
  }
  return out;
}

/** The TCO IDENTITY loop-back: a skip/discard pass recurs the pool UNCHANGED (no
 *  producer transformed it — see `recurrenceSource`'s passthrough case). The wire is a
 *  compact LEFT-side arc from the frame's entrance-mid back to the joint, distinct from
 *  the big around-the-frame producer wrap — it reads as "the input recirculated, nothing
 *  inside touched it", which is exactly why these passes carry no cross-iteration edge. */
export function loopIdentityPath(f: PlacedRegion, joint: Pt, D = LOOP_D): string {
  const xL = f.ax - D;
  const sy = f.ay + f.height / 2;
  return roundedPolyline(
    [
      { x: f.ax, y: sy }, // entrance-side mid (the unchanged pool)
      { x: xL, y: sy }, // out to the left
      { x: xL, y: joint.y }, // to the joint's height
      { x: joint.x, y: joint.y }, // into the joint
    ],
    LOOP_R * 2,
  );
}

/** The TCO recursion wire for a loop with a known SINK row, FUSED with the frame contour like
 *  `loopRecursionPath`: it leaves the source's `out:field` row, curves right over the right
 *  border, traces the border down and across the bottom, rises UP THE LEFT BORDER to the sink
 *  row's HEIGHT (the consumer dot sits ON the contour there, entered from below), then turns and
 *  ENTERS the slot — the final hop from the border into the consumer row, so the wire and its
 *  consumer stay CONNECTED (the rise never runs up the card's own edge through its other rows;
 *  only the last hop leaves the contour, at the row it feeds). Flush card (sink on the border,
 *  the fused single-card loop) ⇒ no hop needed. */
export function loopFieldRecursionPath(f: PlacedRegion, src: Pt, sink: Pt): string {
  const xR = f.ax + f.width; // ON the right border
  const xL = f.ax; // ON the left border
  const yB = f.ay + f.height; // ON the bottom border
  const pts = [
    { x: src.x, y: src.y }, // out:field row, right edge
    { x: xR, y: src.y }, // curve right, over the right border
    { x: xR, y: yB }, // down the right border — fused with the contour
    { x: xL, y: yB }, // across the bottom border
    { x: xL, y: sink.y }, // up the left border to the sink row's height
  ];
  if (sink.x - xL > 1) pts.push({ x: sink.x, y: sink.y }); // the hop: border → into the slot
  return roundedPolyline(pts, FRAME_R);
}

/** Anchors equal within 1px — avoids re-rendering wires on sub-pixel measurement jitter. */
export function sameAnchors(a: LeafAnchors, b: LeafAnchors): boolean {
  if (Math.abs((a.result ?? -1) - (b.result ?? -1)) > 1) return false;
  if (a.fields.size !== b.fields.size) return false;
  for (const [k, v] of b.fields) {
    const av = a.fields.get(k);
    if (av === undefined || Math.abs(av - v) > 1) return false;
  }
  return true;
}

/** Fold ELK's parent-relative coords into absolute wrapper coords. The layout list
 *  is parents-first (ELK walk order), so each node's parent origin is known when we
 *  reach it. Returns placed nodes + the content bounds used to size the wrapper. */
export function placeRegions(layout: RegionLayout): {
  placed: PlacedRegion[];
  width: number;
  height: number;
  depthOf: Map<number, number>;
} {
  const origin = new Map<number, { x: number; y: number }>();
  // Nesting depth per region (roots = 0, a child frame's contents = parent + 1). The
  // layout list is parents-first, so each parent's depth is known when we reach a child.
  const depthOf = new Map<number, number>();
  let maxX = 0;
  let maxY = 0;
  const placed = layout.nodes.map((p) => {
    const base = p.parentId != null ? (origin.get(p.parentId) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    const ax = base.x + p.x;
    const ay = base.y + p.y;
    origin.set(p.region.id, { x: ax, y: ay });
    depthOf.set(p.region.id, p.parentId != null ? (depthOf.get(p.parentId) ?? 0) + 1 : 0);
    maxX = Math.max(maxX, ax + p.width);
    maxY = Math.max(maxY, ay + p.height);
    return { ...p, ax, ay };
  });
  return { placed, width: maxX + WRAP_MARGIN, height: maxY + WRAP_MARGIN, depthOf };
}
