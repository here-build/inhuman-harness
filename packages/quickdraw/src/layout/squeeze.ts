/**
 * Ask-Diff clip squeeze. Natural height stays the sum of children — the
 * scroller still walks the full body. Paint occupies an overlay rect:
 *
 * - Overlay shorter than the body and not filling the viewport (overview):
 *   first `head` lines, `·· N lines omitted ··`, last `tail` lines. Extra
 *   overlay rows grow the head.
 * - Overlay fills the viewport (tour): the same pins stay on the clip; the
 *   inner window follows scroll. Interior is head / omit / body / omit / tail.
 *
 * A Diff leaving through the clip bottom (including fully below) sticks a
 * peek of `head + 1 + tail` — replacement for sticky-bottom last-N, which
 * hid the head. Fully above paints nothing. Place fills the overlay with a
 * transparent cast so void cells (split gap, context, short lines) cover
 * tape without a surface tint.
 *
 * NOT hunk-context elision (`·· N unchanged ··` in diff-expand). That is source
 * context, not clip squeeze.
 */

export type SqueezeSlot =
  | { kind: "child"; index: number; y: number; h: number }
  | { kind: "omit"; count: number; y: number; h: 1; edge: "above" | "below" | "mid" };

export type RectLike = { x: number; y: number; w: number; h: number };

export function omittedLabel(n: number): string {
  const count = Math.max(0, Math.floor(n));
  return count === 1 ? "·· 1 line omitted ··" : `·· ${count} lines omitted ··`;
}

function sumRange(heights: readonly number[], lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += heights[i] ?? 0;
  return s;
}

/** Tight peek: pin heights plus one omit row when anything sits between. */
export function minPeekHeight(heights: readonly number[], head: number, tail: number): number {
  const n = heights.length;
  if (n === 0) return 0;
  const headN = Math.min(Math.max(0, Math.floor(head)), n);
  const tailN = Math.min(Math.max(0, Math.floor(tail)), n - headN);
  const h = sumRange(heights, 0, headN) + sumRange(heights, n - tailN, n);
  return n > headN + tailN ? h + 1 : h;
}

function intersect(a: RectLike, b: RectLike): RectLike | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Overlay the squeeze paints into. Intersection when the body is in clip
 * and tall enough; otherwise a bottom-stuck peek while leaving through the
 * clip floor. Null when fully above the clip.
 */
export function squeezeOverlay(rect: RectLike, clip: RectLike, naturalH: number, minPeek: number): RectLike | null {
  const peek = Math.max(0, Math.min(minPeek, naturalH, clip.h));
  if (rect.y + rect.h <= clip.y) return null;

  const inter = intersect(rect, clip);
  const overflowsBottom = rect.y + rect.h > clip.y + clip.h;

  if (inter && !(overflowsBottom && inter.h < peek)) {
    return { x: rect.x, y: inter.y, w: rect.w, h: inter.h };
  }

  if (overflowsBottom || rect.y >= clip.y + clip.h) {
    if (peek <= 0) return inter;
    return { x: rect.x, y: clip.y + clip.h - peek, w: rect.w, h: peek };
  }

  return inter;
}

function takePrefix(
  heights: readonly number[],
  start: number,
  end: number,
  budget: number,
): { from: number; to: number; used: number } {
  if (budget <= 0 || start >= end) return { from: start, to: start, used: 0 };
  let used = 0;
  let to = start;
  while (to < end) {
    const h = Math.max(0, heights[to] ?? 0);
    if (used + h > budget) {
      if (to === start) return { from: start, to: start + 1, used: budget };
      break;
    }
    used += h;
    to += 1;
    if (used >= budget) break;
  }
  return { from: start, to, used };
}

function takeSuffix(
  heights: readonly number[],
  start: number,
  end: number,
  budget: number,
): { from: number; to: number; used: number } {
  if (budget <= 0 || start >= end) return { from: end, to: end, used: 0 };
  let used = 0;
  let from = end;
  while (from > start) {
    const h = Math.max(0, heights[from - 1] ?? 0);
    if (used + h > budget) {
      if (from === end) return { from: end - 1, to: end, used: budget };
      break;
    }
    used += h;
    from -= 1;
    if (used >= budget) break;
  }
  return { from, to: end, used };
}

function shrinkPins(
  heights: readonly number[],
  overlayH: number,
  headMax: number,
  tailMax: number,
): { headN: number; tailN: number } {
  const n = heights.length;
  let headN = Math.min(Math.max(0, Math.floor(headMax)), n);
  let tailN = Math.min(Math.max(0, Math.floor(tailMax)), n - headN);

  const needed = (): number => {
    const omitted = n - headN - tailN;
    return sumRange(heights, 0, headN) + sumRange(heights, n - tailN, n) + (omitted > 0 ? 1 : 0);
  };

  while (needed() > overlayH && (headN > 0 || tailN > 0)) {
    if (headN > tailN && headN > 1) headN -= 1;
    else if (tailN > 1) tailN -= 1;
    else if (headN > 1) headN -= 1;
    else if (tailN > 0) tailN -= 1;
    else if (headN > 0) headN -= 1;
    else break;
  }
  return { headN, tailN };
}

function pushChildren(
  slots: SqueezeSlot[],
  heights: readonly number[],
  from: number,
  to: number,
  y0: number,
  cap: number,
): number {
  let y = y0;
  for (let i = from; i < to; i++) {
    const natural = Math.max(0, heights[i] ?? 0);
    const h = Math.max(0, Math.min(natural, cap - (y - y0)));
    if (h <= 0) break;
    slots.push({ kind: "child", index: i, y, h });
    y += h;
  }
  return y;
}

export function planSqueeze(input: {
  heights: readonly number[];
  overlay: { y: number; h: number };
  naturalY: number;
  clipH: number;
  head: number;
  tail: number;
}): SqueezeSlot[] {
  const heights = input.heights;
  const n = heights.length;
  const overlay = input.overlay;
  if (n === 0 || overlay.h <= 0) return [];

  const H = sumRange(heights, 0, n);
  if (H <= overlay.h) {
    const slots: SqueezeSlot[] = [];
    pushChildren(slots, heights, 0, n, overlay.y, overlay.h);
    return slots;
  }

  const { headN, tailN } = shrinkPins(heights, overlay.h, input.head, input.tail);
  const headH = sumRange(heights, 0, headN);
  const tailH = sumRange(heights, n - tailN, n);
  const middleFrom = headN;
  const middleTo = n - tailN;

  const slots: SqueezeSlot[] = [];
  pushChildren(slots, heights, 0, headN, overlay.y, overlay.h);

  const innerY = overlay.y + headH;
  const innerH = overlay.h - headH - tailH;
  const tailY = overlay.y + overlay.h - tailH;

  if (innerH <= 0 || middleFrom >= middleTo) {
    if (tailN > 0 && tailY >= overlay.y) {
      pushChildren(slots, heights, n - tailN, n, Math.max(tailY, overlay.y), overlay.h);
    }
    return slots;
  }

  const omittedTotal = middleTo - middleFrom;
  if (innerH === 1 || omittedTotal <= 0) {
    if (omittedTotal > 0) {
      slots.push({ kind: "omit", count: omittedTotal, y: innerY, h: 1, edge: "mid" });
    }
    pushChildren(slots, heights, n - tailN, n, tailY, overlay.h);
    return slots;
  }

  const tour = overlay.h >= input.clipH && H > overlay.h;
  const contentTop = overlay.y - input.naturalY;
  const effectiveTop = tour ? Math.max(0, contentTop) : 0;
  const atStart = effectiveTop <= 0;
  const atEnd = effectiveTop + overlay.h >= H;

  let bodyFrom: number;
  let bodyTo: number;
  let omitAbove: number;
  let omitBelow: number;

  if (atEnd && !atStart) {
    const body = takeSuffix(heights, middleFrom, middleTo, innerH - 1);
    bodyFrom = body.from;
    bodyTo = body.to;
    omitAbove = bodyFrom - middleFrom;
    omitBelow = 0;
  } else if (atStart) {
    const body = takePrefix(heights, middleFrom, middleTo, innerH - 1);
    bodyFrom = body.from;
    bodyTo = body.to;
    omitAbove = 0;
    omitBelow = middleTo - bodyTo;
  } else {
    const bodyOrigin = effectiveTop + headH;
    let prefix = headH;
    let firstRest = middleFrom;
    while (firstRest < middleTo && prefix + (heights[firstRest] ?? 0) <= bodyOrigin) {
      prefix += heights[firstRest] ?? 0;
      firstRest += 1;
    }
    omitAbove = firstRest - middleFrom;
    const needAbove = omitAbove > 0 ? 1 : 0;
    const restH = sumRange(heights, firstRest, middleTo);
    const left = innerH - needAbove;
    if (restH <= left) {
      bodyFrom = firstRest;
      bodyTo = middleTo;
      omitBelow = 0;
    } else {
      const body = takePrefix(heights, firstRest, middleTo, Math.max(0, left - 1));
      bodyFrom = body.from;
      bodyTo = body.to;
      omitBelow = middleTo - bodyTo;
    }
  }

  let y = innerY;
  if (omitAbove > 0) {
    slots.push({ kind: "omit", count: omitAbove, y, h: 1, edge: "above" });
    y += 1;
  }
  y = pushChildren(slots, heights, bodyFrom, bodyTo, y, tailY - y);
  if (omitBelow > 0 && y < tailY) {
    slots.push({ kind: "omit", count: omitBelow, y, h: 1, edge: "below" });
  }

  pushChildren(slots, heights, n - tailN, n, tailY, overlay.h);
  return slots;
}
