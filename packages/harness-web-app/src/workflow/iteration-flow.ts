/**
 * Iteration flow — what a loop's passes say about each other, derived from the regions they
 * already carry with NO model change: how a fanout's passes ran (parallel, series, loop),
 * whether its frame is redundant chrome around a single node, and the TCO recurrence — the
 * value that loops back into the next pass.
 *
 * The recurrence leaves a real producer on a promote/genetic pass, but a skip/discard pass
 * recurs the pool by IDENTITY — no producer, no provenance edge. That identity case is why
 * gepa-full has 540 edges but zero crossing iterations, and why a "last producer" structural
 * anchor lies. We detect it from INTRA-iteration edges + membership instead.
 */
import type { Region } from "@here.build/arrival-provenance";

/** Every region id in a body (leaves, fanouts, outputs), descending into nested
 *  fanout iterations — the "is this endpoint inside this iteration?" membership set. */
function collectRegionIds(regions: readonly Region[], out: Set<number> = new Set()): Set<number> {
  for (const r of regions) {
    out.add(r.id);
    if (r.kind === "fanout") for (const it of r.iterations) collectRegionIds(it, out);
  }
  return out;
}

/**
 * A fanout (`map`/`filter`/loop) whose every iteration body is a SINGLE node — after
 * absorption-nesting collapses a producer chain into one card, the iteration is just
 * that one container, and the surrounding frame box is redundant chrome. Such a fanout
 * MERGES: its label + Z-tabs render as a hat directly on the single child, no separate
 * bordered box. (An empty iteration doesn't count as single — `=== 1`, not `<= 1`.)
 */
export function mergedFanout(region: Extract<Region, { kind: "fanout" }>): boolean {
  return region.iterations.length > 0 && region.iterations.every((it) => it.length === 1);
}

/** The folds: each pass waits on the accumulator the last one returned. */
const SERIAL_HEADS: ReadonlySet<string> = new Set(["fold", "fold-left", "fold-right"]);

/**
 * How a fanout's passes ran, which is all its head says. `map`/`filter`/`for-each` start
 * every application before awaiting any (arrival's `promise_all`); a fold feeds each pass
 * into the next, and a TCO loop is a fold that decides for itself when to stop. A fused
 * chain is serial as soon as one stage is.
 */
export function fanoutOrder(region: Extract<Region, { kind: "fanout" }>): "in parallel" | "in series" | "in loop" {
  if (region.loop) return "in loop";
  return region.stages.some((s) => SERIAL_HEADS.has(s.label)) ? "in series" : "in parallel";
}

/** All LEAF ids in a body, descending into nested fanouts. Leaves are the only real
 *  value emitters — a fanout container never appears as an edge source, so escape is
 *  judged on its leaves, not the container id. */
function leafIds(body: readonly Region[], out: Set<number> = new Set()): Set<number> {
  for (const r of body) {
    if (r.kind === "leaf") out.add(r.id);
    else if (r.kind === "fanout") for (const it of r.iterations) leafIds(it, out);
  }
  return out;
}

/**
 * The TCO recurrence source for one iteration: the producer whose value escapes into
 * the next loop pass, or `passthrough` when the pool recurs by identity.
 *
 * Derived from INTRA-iteration edges + membership ONLY — never a cross-iteration edge
 * (there are none). A producer ESCAPES iff none of its outgoing edges land on a region
 * inside this iteration: its value was used by nothing here, so it left. The batch
 * `evaluate` that feeds a consumer in the same pass is consumed-within (→ doesn't escape); the
 * full-set `assess`/`merge` that feeds only `frontier`/`cons` plumbing escapes. When NO
 * producer escapes (skip/discard — every producer feeds an in-iteration consumer), the
 * recurrence is identity → `passthrough`, and the render docks the loop-back on the
 * loop's ENTRANCE port, not a fabricated interior anchor.
 *
 * When several producers escape, the LAST in body order wins (the cumulative result);
 * `body`-level only (not lifted into a fanout) — the caller lifts to the map container.
 */
export function recurrenceSource(
  body: readonly Region[],
  edges: readonly { from: number; to: number }[],
): { kind: "producer"; id: number } | { kind: "passthrough" } {
  const members = collectRegionIds(body);
  // A LEAF escapes iff none of its outgoing edges land inside this iteration — its
  // value was used by nothing here, so it left toward the recurrence.
  const escaping = new Set([...leafIds(body)].filter((lid) => !edges.some((e) => e.from === lid && members.has(e.to))));
  // The last top-level body region whose subtree holds an escaping leaf is the
  // recurrence source (cumulative tail result). None ⇒ identity passthrough.
  for (let i = body.length - 1; i >= 0; i--) {
    const r = body[i]!;
    if (r.kind !== "leaf" && r.kind !== "fanout") continue;
    const sub = r.kind === "fanout" ? leafIds([r]) : new Set([r.id]);
    if ([...sub].some((lid) => escaping.has(lid))) return { kind: "producer", id: r.id };
  }
  return { kind: "passthrough" };
}
