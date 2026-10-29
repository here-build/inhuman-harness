/**
 * Per-cell coverage for selection paint + clipboard.
 *
 * Each cell is classified by the topmost covering non-phantom hit meta:
 *  - **chrome** (`userSelect: "none"`) — borders, gutters, sidebars, half-boxes
 *  - **selectable** (`text` / `all` / `contain`) — content that may highlight
 *  - **unclaimed** — flex gaps, padding outside any hit meta
 *
 * Unclaimed space is the inter-layout gap (e.g. `flex gap: 1` between panes).
 * It must not highlight — free-text paint breaks runs at unclaimed/chrome so
 * a selectable ancestor (storybook stage) cannot bridge split-diff halves.
 *
 * Pure-chrome nodes never enter hitList (admission gate); those are still
 * found via byKey. Chrome stamps **override** ancestor selectable on cells
 * the chrome node covers, but never clobber a leaf-selectable claim already
 * written by a text child (content under a `userSelect: none` half-box).
 *
 * `hitList` is already topmost-first (`engine` reverses after DFS push).
 * First-writer-wins therefore prefers leaves over ancestors.
 */

import type { Frame, Rect, UserSelect } from "./types.js";

export type CoverageMask = {
  isChrome(col: number, row: number): boolean;
  /** Topmost meta is selectable content (text/all/contain). */
  isSelectable(col: number, row: number): boolean;
  /**
   * Stable id of the topmost selectable hit at this cell, or "" if none.
   * Free-text paint uses this to keep glyph-spans inside one entity — so a
   * stage body and two split halves never merge into one fill run.
   */
  selectableKey(col: number, row: number): string;
};

const SELECTABLE: ReadonlySet<UserSelect> = new Set(["text", "all", "contain"]);

const Unclaimed = 0;
const Chrome = 1;
const Selectable = 2;
const Opaque = 3;

export const NO_CHROME: CoverageMask = {
  isChrome: () => false,
  isSelectable: () => false,
  selectableKey: () => "",
};

/** Axis-aligned rect intersection; null when disjoint or zero-area. */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Build a coverage mask over the given inclusive cell bounds (clipped to buffer).
 */
export function buildChromeMask(
  frame: Frame,
  tlCol: number,
  tlRow: number,
  brCol: number,
  brRow: number,
  width: number,
  height: number,
): CoverageMask {
  const rect: Rect = {
    x: Math.max(0, tlCol),
    y: Math.max(0, tlRow),
    w: Math.max(0, Math.min(brCol, width - 1) - Math.max(0, tlCol) + 1),
    h: Math.max(0, Math.min(brRow, height - 1) - Math.max(0, tlRow) + 1),
  };
  if (rect.w <= 0 || rect.h <= 0) return NO_CHROME;

  const cols = rect.w;
  const n = cols * rect.h;
  const state = new Uint8Array(n);
  /** Parallel to state: hit key for selectable cells (for free-text run breaks). */
  const keys: string[] = new Array(n).fill("");

  /** First-writer-wins — caller must walk topmost-first. */
  const claim = (r: Rect, kind: typeof Chrome | typeof Selectable | typeof Opaque, key = "") => {
    for (let y = Math.max(r.y, rect.y); y < Math.min(r.y + r.h, rect.y + rect.h); y++) {
      for (let x = Math.max(r.x, rect.x); x < Math.min(r.x + r.w, rect.x + rect.w); x++) {
        const idx = (y - rect.y) * cols + (x - rect.x);
        if (state[idx] === Unclaimed) {
          state[idx] = kind;
          if (kind === Selectable) keys[idx] = key;
        }
      }
    }
  };

  /** Last-writer — chrome and leaf-text restore use this. */
  const stamp = (r: Rect, kind: typeof Chrome | typeof Selectable, key = "") => {
    for (let y = Math.max(r.y, rect.y); y < Math.min(r.y + r.h, rect.y + rect.h); y++) {
      for (let x = Math.max(r.x, rect.x); x < Math.min(r.x + r.w, rect.x + rect.w); x++) {
        const idx = (y - rect.y) * cols + (x - rect.x);
        state[idx] = kind;
        keys[idx] = kind === Selectable ? key : "";
      }
    }
  };

  const kindOf = (us: UserSelect): typeof Chrome | typeof Selectable | typeof Opaque => {
    if (us === "none") return Chrome;
    if (SELECTABLE.has(us)) return Selectable;
    return Opaque;
  };

  /** Content that must win over chrome of an ancestor half-box. */
  const isLeafContent = (meta: { userSelect: UserSelect; element?: { kind: string } }): boolean => {
    if (!SELECTABLE.has(meta.userSelect)) return false;
    if (meta.userSelect === "contain" || meta.userSelect === "all") return true;
    return meta.element?.kind === "text";
  };

  // 1) hitList topmost-first (engine already reversed). Containers + leaves.
  for (const meta of frame.hitList) {
    if (meta.phantom) continue;
    const ix = intersectRects(meta.hitRect, rect);
    if (!ix) continue;
    const kind = kindOf(meta.userSelect);
    claim(ix, kind, kind === Selectable ? meta.key : "");
  }
  // 2) byKey chrome FORCE — gutters / half-boxes never entered hitList, and
  //    must override ancestor stage/diff `userSelect: text` claims.
  for (const meta of frame.byKey.values()) {
    if (meta.phantom) continue;
    if (meta.userSelect !== "none") continue;
    const ix = intersectRects(meta.hitRect, rect);
    if (!ix) continue;
    stamp(ix, Chrome);
  }
  // 3) Restore leaf content over chrome (code text under a none half-box).
  for (const meta of frame.hitList) {
    if (meta.phantom) continue;
    if (!isLeafContent(meta)) continue;
    const ix = intersectRects(meta.hitRect, rect);
    if (!ix) continue;
    stamp(ix, Selectable, meta.key);
  }

  const idxAt = (col: number, row: number): number => {
    if (col < rect.x || col >= rect.x + rect.w || row < rect.y || row >= rect.y + rect.h) {
      return -1;
    }
    return (row - rect.y) * cols + (col - rect.x);
  };

  return {
    isChrome(col, row) {
      const i = idxAt(col, row);
      return i >= 0 && state[i] === Chrome;
    },
    isSelectable(col, row) {
      const i = idxAt(col, row);
      return i >= 0 && state[i] === Selectable;
    },
    selectableKey(col, row) {
      const i = idxAt(col, row);
      return i >= 0 ? keys[i]! : "";
    },
  };
}
