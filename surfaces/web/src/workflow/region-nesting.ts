/**
 * region-nesting — the absorption-nesting planner for the blueprint render ("funny trick"): when a leaf producer's WHOLE result is the value sitting in a consumer's
 * input field, `planNesting` marks the producer to render INSIDE that field row instead of
 * as a sibling joined by a wire. Pure region-graph analysis — no React/DOM/store. Ported from
 * studio's trace view; not yet consumed by the workflow graph.
 */
import type { Region, RegionGraph } from "@here.build/arrival-provenance";

import { buildScopeDags, stacksOf } from "./scope-dag.js";

/** The leaf-region case of `Region`'s discriminated union — a resolved/pending/rejected
 *  `(infer …)` invocation, as opposed to a `fanout`/`output` container node. */
export type Leaf = Extract<Region, { kind: "leaf" }>;

/** Absorption nesting (V's "funny trick"). When a leaf producer's WHOLE result is the
 *  value sitting in a consumer's input field — which is exactly what a `data` edge with a
 *  `field` records (the edge exists because `inputs[field] === producer.value`) — render
 *  the producer card INSIDE that field row instead of as a sibling joined by a wire. The
 *  producer keeps its own result block: if its value ALSO flows to other consumers, those
 *  stay drawn as wires leaving the nested card (V's special case).
 *
 *  Scope (deliberately small): direct chains only — a leaf producer, full absorption, one
 *  home per producer (its first absorbing field), cycle-guarded so a chain can't eat its
 *  own tail. The nested producer is removed from the ELK graph (its DOM lives inside the
 *  consumer, so the consumer's measured size already accounts for it). */
export interface NestPlan {
  /** Producer ids rendered nested — excluded from ELK, positioned by DOM measurement. */
  nested: Set<number>;
  /** Consumer id → (input field → the producer region to render in that row). */
  childOf: Map<number, Map<string, Region>>;
  /** The home edges (producer→consumer at its home field) — dropped, not drawn as wires. */
  homeEdge: Set<string>;
}
export const edgeKey = (e: { from: number; to: number; field?: string }): string =>
  `${e.from}->${e.to}:${e.field ?? ""}`;

export function indexRegions(regions: readonly Region[], out: Map<number, Region> = new Map()): Map<number, Region> {
  for (const r of regions) {
    out.set(r.id, r);
    if (r.kind === "fanout") for (const it of r.iterations) indexRegions(it, out);
  }
  return out;
}

/** Each region → a key identifying the body it lives in. Roots share `""`; every fanout
 *  iteration opens a fresh body key — the CUMULATIVE chain `<outer>#<i>▸…▸<scope>#<iterIndex>`
 *  (scope-keyed per step so the container part matches `buildScopeDags`' scope-PATH keys —
 *  id-keying would scatter a nested map's passes apart from the fold, the matryoshka bug;
 *  bare-scope keying would EQUATE two different instantiations of one source-level map, the
 *  real-gepa phantom). Two regions nest only when their body keys match — a loop/map/filter
 *  is a NESTING BOUNDARY (its leaves run per-pass, so absorbing one into an outside consumer
 *  would be a category error, collapsing a whole iteration's worth of values into a field). */
export function indexScopes(
  regions: readonly Region[],
  scope: string,
  out: Map<number, string> = new Map(),
): Map<number, string> {
  for (const r of regions) {
    out.set(r.id, scope);
    if (r.kind === "fanout")
      for (const [i, it] of r.iterations.entries())
        indexScopes(it, `${scope === "" ? "" : `${scope}▸`}${r.scope}#${i}`, out);
  }
  return out;
}

/** A body key (`<scope>#<i>▸…`) → its container's scope-PATH dag key (iter indices stripped
 *  per step) — the key `buildScopeDags` files that body's folded DAG under. */
export const containerPathOf = (bodyKey: string): string =>
  bodyKey === ""
    ? ""
    : bodyKey
        .split("▸")
        .map((s) => s.split("#")[0])
        .join("▸");

/** True when consumer `c`'s `field` slot holds the producer `p`'s WHOLE result — either
 *  the value itself (a direct chain `b`) or that value as the sole/an element of a list
 *  (`(list b)`). This is the absorption premise: the field IS the producer, so nesting the
 *  producer card into the field row loses nothing. A field-PLUCK (the slot holds one field
 *  OF the producer) fails this and stays a wire. valueOf-unwrapped + JSON-compared because
 *  scheme values box their primitives. */
export function wholeValueFlow(c: Region, field: string, p: Extract<Region, { kind: "leaf" }>): boolean {
  if (c.kind !== "leaf") return false;
  const inputs = (c.meta as { inputs?: Record<string, unknown> } | undefined)?.inputs;
  if (!inputs || !(field in inputs)) return false;
  const unwrap = (v: unknown): unknown =>
    v != null && typeof (v as { valueOf?: () => unknown }).valueOf === "function"
      ? (v as { valueOf: () => unknown }).valueOf()
      : v;
  const json = (v: unknown): string | undefined => {
    try {
      return JSON.stringify(unwrap(v));
    } catch {
      return undefined;
    }
  };
  const pv = json(p.value);
  if (pv === undefined || pv === "null") return false;
  const slot = unwrap(inputs[field]);
  if (json(slot) === pv) return true; // direct chain: field === producer value
  if (Array.isArray(slot)) return slot.some((e) => json(e) === pv); // (list b): producer is an element
  return false;
}

/** The set of absorbable scope-hops, keyed `container|fromScope|toScope|field`. A hop is
 *  absorbable iff it is STACKABLE in its container's folded DAG — the producer has
 *  out-degree 1 and the consumer in-degree 1 (`stacksOf`). This is the topology gate the
 *  old value-equality walk lacked: a producer feeding two consumers has out-degree 2, so
 *  no hop out of it is stackable and it is never absorbed (the matryoshka bug, structurally
 *  gone). Root container (`""`) is excluded — the top-level chain stays wired, never nested.
 *  The whole-value-vs-pluck discrimination (`wholeValueFlow`) still applies downstream; this
 *  gate only answers "is the flow single-file here", which value-equality cannot. */
export function absorbableHops(graph: RegionGraph): Set<string> {
  const out = new Set<string>();
  for (const [container, dag] of buildScopeDags(graph)) {
    if (container === "") continue; // top level never nests — the chain is the point
    for (const stack of stacksOf(dag))
      for (const e of stack.edges) {
        if (e.field === undefined || e.fromField !== undefined) continue; // need a slot; plucks wire
        if (dag.nodes.get(e.from)?.kind !== "leaf") continue; // only leaf producers nest
        out.add(`${container}|${e.from}|${e.to}|${e.field}`);
      }
  }
  return out;
}

export function planNesting(graph: RegionGraph): NestPlan {
  const byId = indexRegions(graph.roots);
  const scopeOf = indexScopes(graph.roots, "");
  const absorbable = absorbableHops(graph);
  const nested = new Set<number>();
  const childOf = new Map<number, Map<string, Region>>();
  const homeEdge = new Set<string>();
  const parent = new Map<number, number>(); // producer → its home consumer (the nesting tree)
  // Is `a` an ancestor-or-self of `b` in the nesting tree? Guards against a chain (A in B in
  // C…) ever looping back to nest a node inside one of its own descendants.
  const isAncestor = (a: number, b: number): boolean => {
    for (let cur: number | undefined = b; cur !== undefined; cur = parent.get(cur)) if (cur === a) return true;
    return false;
  };
  for (const e of graph.edges) {
    if (e.kind !== "data" || e.field === undefined) continue; // full-absorption edges only
    // GRANULAR wins over absorption. The producer's whole value may sit list-packed in the
    // slot (`(list (pick n))`), but if the consumer reads only a SUBSET of its fields
    // (`fromField` set), the honest render is a per-field wire from that output row — not a
    // box absorbed into the slot that hides which field actually crossed.
    if (e.fromField !== undefined) continue;
    if (nested.has(e.from)) continue; // a producer nests at its FIRST absorbing field
    const p = byId.get(e.from);
    if (p?.kind !== "leaf") continue; // direct chains: only leaf producers nest
    const c = byId.get(e.to);
    if (!c) continue;
    // TOP LEVEL stays unwrapped: at root scope the execution chain is the point — show
    // it ordered one-by-one, wired, never absorbed. Nesting is a CONTAINER trick (map /
    // tco / filter) where packing `{inf>inf>inf}` per iteration earns its density.
    if (scopeOf.get(e.to) === "") continue;
    if (scopeOf.get(e.from) !== scopeOf.get(e.to)) continue; // fanout boundary — no cross-scope nesting
    // TOPOLOGY GATE. The folded DAG says whether this flow is single-file: the producer's
    // scope has out-degree 1 and the consumer's in-degree 1 (`stacksOf`). A fan-out producer
    // (out-degree > 1) is absent from `absorbable`, so it stays a wired sibling and BOTH its
    // wires draw — the matryoshka bug, gone as a corollary instead of an absorb-first guess.
    const container = containerPathOf(scopeOf.get(e.to) ?? "");
    const fromScope = byId.get(e.from)?.kind === "leaf" ? (byId.get(e.from) as Leaf).scope : "";
    const toScope = c.kind === "leaf" ? c.scope : "";
    if (!absorbable.has(`${container}|${fromScope}|${toScope}|${e.field}`)) continue;
    // WHOLE-VALUE only. A `field` edge now also covers a field-PLUCK (`(field a "idea")`
    // lands one of spark's fields in refine's slot) — that's a value flow, drawn as a WIRE
    // to the field-row, NOT an absorption. Absorb solely when the producer's ENTIRE result
    // is what the field holds (direct chain `b`, or list-wrapped `(list b)`), matching the
    // absorption doc's own premise (`inputs[field] === producer.value`).
    if (!wholeValueFlow(c, e.field, p)) continue;
    const cm = childOf.get(e.to);
    if (cm?.has(e.field)) continue; // that field already hosts a producer
    if (isAncestor(e.from, e.to)) continue; // cycle guard
    nested.add(e.from);
    parent.set(e.from, e.to);
    (cm ?? childOf.set(e.to, new Map()).get(e.to)!).set(e.field, p);
    homeEdge.add(edgeKey(e));
  }
  return { nested, childOf, homeEdge };
}

/** The region tree with nested producers removed (they render inside their consumer, so
 *  ELK must not place them as siblings). Recurses into fanout iterations. */
export function pruneRegions(regions: readonly Region[], drop: ReadonlySet<number>): Region[] {
  return regions
    .filter((r) => !drop.has(r.id))
    .map((r) => (r.kind === "fanout" ? { ...r, iterations: r.iterations.map((it) => pruneRegions(it, drop)) } : r));
}
