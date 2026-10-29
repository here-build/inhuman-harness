/**
 * Flex free-space distribution with terminal-pragmatic divergences:
 * - flex:n sugar → grow n, shrink 1, basis 0, min_main 0
 * - integer factors only
 * - reverse directions accepted but no-op
 * - exact free-space via largest remainder
 */

export type FlexItemInput = {
  /** preferred main size before grow/shrink */
  base: number;
  min: number;
  max: number;
  grow: number;
  shrink: number;
};

/** Largest-remainder apportionment of `total` across non-negative weights. */
export function distributeExact(weights: number[], total: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  // H1: Math.max(0, NaN) === NaN poisons sum → NaN tracks corrupt the layout.
  // Coerce non-finite/negative weights to 0 before they enter the sum.
  const finiteW = (w: number): number => (Number.isFinite(w) && w > 0 ? w : 0);
  const sum = weights.reduce((a, b) => a + finiteW(b), 0);
  if (sum <= 0 || !Number.isFinite(total) || total <= 0) return weights.map(() => 0);

  const raw = weights.map((w) => (finiteW(w) / sum) * total);
  const floors = raw.map((x) => Math.floor(x));
  let rem = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < order.length && rem > 0; k++) {
    out[order[k]!.i]! += 1;
    rem -= 1;
  }
  return out;
}

export function resolveFlexItem(
  style:
    | {
        flex?: number | { grow?: number; shrink?: number; basis?: number };
        flexGrow?: number;
        flexShrink?: number;
        flexBasis?: number;
        minMain?: number;
        maxMain?: number;
        explicitMain?: number;
      }
    | undefined,
  contentMain: number,
): FlexItemInput {
  let grow = 0;
  let shrink = 1;
  let basis: number | "auto" = "auto";
  let minMain = contentMain; // auto min = content (min-content-ish for v1)
  let maxMain = Number.POSITIVE_INFINITY;

  if (style?.flex === undefined) {
    if (style?.flexGrow !== undefined) grow = Math.max(0, Math.floor(style.flexGrow));
    if (style?.flexShrink !== undefined) shrink = Math.max(0, Math.floor(style.flexShrink));
    if (style?.flexBasis !== undefined) basis = style.flexBasis;
  } else {
    if (typeof style.flex === "number") {
      // sugar: grow n, shrink 1, basis 0, min 0
      grow = Math.max(0, Math.floor(style.flex));
      shrink = 1;
      basis = 0;
      minMain = 0;
    } else {
      grow = Math.max(0, Math.floor(style.flex.grow ?? 0));
      shrink = Math.max(0, Math.floor(style.flex.shrink ?? 1));
      if (style.flex.basis !== undefined) basis = style.flex.basis;
    }
  }

  if (style?.minMain !== undefined) minMain = style.minMain;
  if (style?.maxMain !== undefined) maxMain = style.maxMain;

  let base = style?.explicitMain === undefined ? (basis === "auto" ? contentMain : basis) : style.explicitMain;

  base = Math.max(minMain, Math.min(maxMain, base));
  return { base, min: minMain, max: maxMain, grow, shrink };
}

/**
 * Assign main sizes for a single flex line.
 * free = containerMain - sum(base) - gaps; distribute grow/shrink exactly.
 */
export function flexMainSizes(items: FlexItemInput[], containerMain: number, gap: number): number[] {
  const n = items.length;
  if (n === 0) return [];
  const gaps = gap * Math.max(0, n - 1);
  const bases = items.map((it) => it.base);
  const used = bases.reduce((a, b) => a + b, 0) + gaps;
  const free = containerMain - used;

  const sizes = [...bases];

  if (free > 0) {
    const weights = items.map((it) => it.grow);
    const add = distributeExact(weights, free);
    for (let i = 0; i < n; i++) {
      const next = sizes[i]! + add[i]!;
      sizes[i] = Math.min(items[i]!.max, next);
    }
    // if max clamped leftover, re-distribute among growers still below max (one pass)
  } else if (free < 0) {
    const need = -free;
    const weights = items.map((it) => it.shrink * Math.max(1, it.base));
    const sub = distributeExact(weights, need);
    for (let i = 0; i < n; i++) {
      sizes[i] = Math.max(items[i]!.min, sizes[i]! - sub[i]!);
    }
  }

  // Final clamp; ensure total ≤ container (clip overflow, no overlap)
  const total = sizes.reduce((a, b) => a + b, 0) + gaps;
  if (total > containerMain) {
    // shrink proportionally extra from largest
    let overflow = total - containerMain;
    for (let i = n - 1; i >= 0 && overflow > 0; i--) {
      const room = sizes[i]! - items[i]!.min;
      const cut = Math.min(room, overflow);
      sizes[i]! -= cut;
      overflow -= cut;
    }
  }

  return sizes;
}
