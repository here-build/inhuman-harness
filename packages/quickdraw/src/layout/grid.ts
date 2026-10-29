/**
 * CSS-grid subset for terminal cells — track resolution only.
 * Used by engine place/measure for `type: "grid"`.
 *
 * Tracks: fixed cells, auto (max-content), fr (free space), pct (of container).
 * Gaps are separate (columnGap / rowGap) and not part of track sizes.
 *
 * AUTO OVERFLOW. Auto tracks start at max-content. Extra container space
 * stays trailing (no stretch). Deficit interpolates toward min-content in
 * proportion to wrap slack (max − min); only if mins still overflow do
 * tracks scale toward 1 together. Largest-first crush to 1 starves the
 * longest column into a 1-wide spine. Width interpolation only — no
 * greedy height polish.
 */

import { distributeExact } from "./flex.js";
import { type Length, isFr, resolveLength } from "./length.js";

/** Subtract `need` in proportion to `weights`, never more than each weight. */
function drain(sizes: number[], weights: number[], need: number): number {
  if (need <= 0) return 0;
  const cap = weights.reduce((a, w) => a + (Number.isFinite(w) && w > 0 ? w : 0), 0);
  const take = Math.min(need, cap);
  if (take <= 0) return need;
  const cut = distributeExact(weights, take);
  let actual = 0;
  for (const [i, size] of sizes.entries()) {
    const c = Math.min(cut[i] ?? 0, Math.max(0, weights[i] ?? 0), size!);
    sizes[i]! -= c;
    actual += c;
  }
  return need - actual;
}

/** Resolve one row of column track sizes into integer cell widths. */
export function resolveColumnTracks(
  tracks: Length[],
  /** Max-content width per column (already includes cellPad if desired). */
  contentMax: number[],
  containerW: number,
  columnGap: number,
  /**
   * Min-content width per column (longest unbreakable token + pad).
   * Omitted → same as max-content (no wrap slack; overflow still shared).
   */
  contentMin?: number[],
): number[] {
  const n = tracks.length;
  if (n === 0) return [];
  const gaps = columnGap * Math.max(0, n - 1);
  const freeBudget = Math.max(0, containerW - gaps);

  const sizes = new Array<number>(n).fill(0);
  const mins = new Array<number>(n).fill(0);
  const frWeights = new Array<number>(n).fill(0);
  let fixedSum = 0;
  let frCount = 0;

  for (let i = 0; i < n; i++) {
    const track = tracks[i]!;
    const cmax = Math.max(0, contentMax[i] ?? 0);
    const cmin = Math.max(0, Math.min(cmax, contentMin?.[i] ?? cmax));
    mins[i] = cmin;

    if (track === "auto") {
      sizes[i] = cmax;
      fixedSum += cmax;
      continue;
    }
    if (isFr(track)) {
      frWeights[i] = Math.max(0, track.fr);
      frCount += 1;
      // fr base is max-content so text isn't crushed before free-space
      sizes[i] = cmax;
      fixedSum += cmax;
      continue;
    }
    const resolved = resolveLength(track, freeBudget);
    if (resolved === "auto") {
      sizes[i] = cmax;
      fixedSum += cmax;
    } else {
      const v = Math.max(cmax, Math.max(0, resolved));
      sizes[i] = v;
      fixedSum += v;
    }
  }

  const free = freeBudget - fixedSum;

  if (free > 0 && frCount > 0) {
    const add = distributeExact(frWeights, free);
    for (let i = 0; i < n; i++) {
      sizes[i]! += add[i]!;
    }
  } else if (free < 0) {
    let need = -free;
    need = drain(
      sizes,
      sizes.map((s, i) => Math.max(0, s - (mins[i] ?? 0))),
      need,
    );
    if (need > 0) {
      drain(
        sizes,
        sizes.map((s) => Math.max(0, s - 1)),
        need,
      );
    }
  }

  return sizes.map((s) => Math.max(0, Math.floor(s)));
}

/** Sum of track sizes + gaps between them. */
export function tracksExtent(sizes: number[], gap: number): number {
  if (sizes.length === 0) return 0;
  return sizes.reduce((a, b) => a + b, 0) + gap * Math.max(0, sizes.length - 1);
}

/** Prefix offsets: offset[i] = start of track i. */
export function trackOffsets(sizes: number[], gap: number): number[] {
  const out: number[] = [];
  let x = 0;
  for (let i = 0; i < sizes.length; i++) {
    out.push(x);
    x += sizes[i]! + (i < sizes.length - 1 ? gap : 0);
  }
  return out;
}

export function cellPadXY(cellPad: number | { x?: number; y?: number } | undefined): { x: number; y: number } {
  if (cellPad === undefined) return { x: 0, y: 0 };
  if (typeof cellPad === "number") {
    const n = Math.max(0, Math.floor(cellPad));
    return { x: n, y: n };
  }
  return {
    x: Math.max(0, Math.floor(cellPad.x ?? 0)),
    y: Math.max(0, Math.floor(cellPad.y ?? 0)),
  };
}
