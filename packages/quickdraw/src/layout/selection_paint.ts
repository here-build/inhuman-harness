/**
 * Selection highlight enumeration — the cells that should actually paint as
 * selected (not the loose envelope).
 *
 * Geometry comes from {@link rowRange} (stream / line / rect laws). Then:
 *  1. Only cells under a **selectable** hit meta (`text`/`all`/`contain`).
 *     Unclaimed cells (flex gaps, inter-pane gutters) are skipped.
 *  2. Chrome (`userSelect: "none"`) is excluded (gutters, line numbers, box
 *     borders stamped via `*:chrome` hits).
 *  3. **Non-diff free text** (per selectable entity, first..last glyph):
 *     Group geometric cells by `selectableKey`. For each entity find its local
 *     last glyph and paint non-empty cells up through that col (leading spaces
 *     of the entity included; trailing pad past its last glyph dropped — text
 *     hits often stretch to the parent width). Space-only leaf text entities
 *     (syntax token runs that are just `" "`) paint when they fall inside the
 *     row's global first..last glyph span. Container-only stage claims with no
 *     glyphs never paint — so flex gaps between split halves stay dark.
 *  4. **Diff code content (character-granular):**
 *     - Only code-text cells light (never gutters / line numbers).
 *     - Split **ctx**: stream geometry runs to EOL and would full-select the
 *       opposite half. Primary paint is **clipped to the anchor side**
 *       (half under {@link SelectionState.anchor}); the partner half lights
 *       only via content-relative column mirror — dual, not independent
 *       line-select.
 *     - del/add halves: geometry ∩ that side's code cells (no cross-half).
 */

import { buildChromeMask } from "./chrome_mask.js";
import { rowRange, selectionRect, type Cell, type SelectionState } from "./selection.js";
import type { Frame, HitMeta, UserSelect } from "./types.js";
import type { Cell as BufferCell } from "../buffer/index.js";

type CellGrid = {
  cells: Array<Pick<BufferCell, "ch" | "placeholder"> | undefined>;
  width: number;
  height: number;
};

type Side = "L" | "R";

function isGlyph(cells: CellGrid["cells"], rowBase: number, col: number): boolean {
  const cell = cells[rowBase + col];
  if (!cell || cell.placeholder) return false;
  const ch = cell.ch;
  return ch !== "" && ch !== " ";
}

const SELECTABLE_US: ReadonlySet<UserSelect> = new Set(["text", "all", "contain"]);

/** Selectable DiffLineRef code-text hit (not chrome, not phantom). */
function isDiffCodeHit(meta: HitMeta): boolean {
  if (!meta.diffLine || meta.phantom) return false;
  if (!SELECTABLE_US.has(meta.userSelect)) return false;
  return meta.element?.kind === "text";
}

/**
 * Which split half owns the selection anchor. Partner-side cells are never
 * primary-painted from stream geometry (EOL would line-select them).
 */
function resolveAnchorSide(sel: SelectionState, codeAt: Map<string, HitMeta>, codeHits: HitMeta[]): Side | null {
  const at = codeAt.get(`${sel.anchor.col},${sel.anchor.row}`);
  if (at?.diffLine?.side === "L" || at?.diffLine?.side === "R") {
    return at.diffLine.side;
  }
  // Anchor on gutter/gap: nearest code hit on the same row
  let best: Side | null = null;
  let bestDist = Infinity;
  for (const meta of codeHits) {
    const side = meta.diffLine?.side;
    if (side !== "L" && side !== "R") continue;
    const r = meta.hitRect;
    if (sel.anchor.row < r.y || sel.anchor.row >= r.y + r.h) continue;
    const mid = r.x + r.w / 2;
    const dist = Math.abs(sel.anchor.col - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = side;
    }
  }
  return best;
}

/**
 * Walk every cell that should receive the selection highlight.
 */
export function forEachHighlightCell(
  sel: SelectionState,
  buffer: CellGrid,
  frame: Frame,
  visit: (col: number, row: number) => void,
): void {
  const { cells, width, height } = buffer;
  if (width <= 0 || height <= 0) return;

  const envelope = selectionRect(sel, width);
  const tlRow = Math.max(0, envelope.y);
  const brRow = Math.min(height - 1, envelope.y + envelope.h - 1);
  if (brRow < tlRow) return;

  const cover = buildChromeMask(frame, 0, tlRow, width - 1, brRow, width, height);

  const codeHits: HitMeta[] = [];
  const codeAt = new Map<string, HitMeta>();
  for (const meta of frame.byKey.values()) {
    if (!isDiffCodeHit(meta)) continue;
    codeHits.push(meta);
    const r = meta.hitRect;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        codeAt.set(`${x},${y}`, meta);
      }
    }
  }

  const originKey = (diffKey: string, lineIndex: number, side: string, row: number) =>
    `${diffKey}\0${lineIndex}\0${side}\0${row}`;
  const contentOrigin = new Map<string, number>();
  for (const meta of codeHits) {
    const dl = meta.diffLine!;
    const side = dl.side ?? "U";
    const r = meta.hitRect;
    for (let y = r.y; y < r.y + r.h; y++) {
      const k = originKey(dl.diffKey, dl.lineIndex, side, y);
      const prev = contentOrigin.get(k);
      if (prev === undefined || r.x < prev) contentOrigin.set(k, r.x);
    }
  }

  const anchorSide = resolveAnchorSide(sel, codeAt, codeHits);

  const seen = new Set<string>();
  const mark = (col: number, row: number) => {
    if (col < 0 || col >= width || row < 0 || row >= height) return;
    const id = `${col},${row}`;
    if (seen.has(id)) return;
    seen.add(id);
    visit(col, row);
  };

  // Primary geometric pass
  for (let row = tlRow; row <= brRow; row++) {
    const range = rowRange(sel, row, width);
    if (!range) continue;
    let [startCol, endCol] = range;
    startCol = Math.max(0, startCol);
    endCol = Math.min(endCol, width - 1);
    if (endCol < startCol) continue;

    const rowBase = row * width;

    // Diff code: character-granular on the primary (anchor) side only for ctx.
    for (let col = startCol; col <= endCol; col++) {
      const meta = codeAt.get(`${col},${row}`);
      if (!meta) continue;
      if (cover.isChrome(col, row)) continue;
      const dl = meta.diffLine!;
      // Split ctx: never primary-paint the partner half from stream EOL.
      if (dl.kind === "ctx" && dl.side && anchorSide && dl.side !== anchorSide) {
        continue;
      }
      mark(col, row);
    }

    // Non-diff free text — per selectable entity (see file header).
    let globalFirstG = -1;
    let globalLastG = -1;
    const byKey = new Map<string, number[]>();
    for (let col = startCol; col <= endCol; col++) {
      if (codeAt.has(`${col},${row}`)) continue;
      if (!cover.isSelectable(col, row)) continue;
      if (cover.isChrome(col, row)) continue;
      const k = cover.selectableKey(col, row);
      if (!k) continue;
      let list = byKey.get(k);
      if (!list) {
        list = [];
        byKey.set(k, list);
      }
      list.push(col);
      if (isGlyph(cells, rowBase, col)) {
        if (globalFirstG < 0) globalFirstG = col;
        globalLastG = col;
      }
    }
    if (globalFirstG < 0) continue;

    for (const [key, cols] of byKey) {
      let localFirstG = -1;
      let localLastG = -1;
      for (const col of cols) {
        if (!isGlyph(cells, rowBase, col)) continue;
        if (localFirstG < 0) localFirstG = col;
        localLastG = col;
      }
      if (localFirstG >= 0) {
        for (const col of cols) {
          if (col < globalFirstG || col > globalLastG) continue;
          // Drop trailing pad past this entity's last glyph (wide text hits).
          if (col > localLastG) continue;
          const cell = cells[rowBase + col];
          if (!cell || cell.placeholder) continue;
          if (cell.ch === "") continue;
          mark(col, row);
        }
      } else if (isLeafContentKey(key, frame)) {
        // Space-only leaf (e.g. a `" "` syntax run between tokens).
        for (const col of cols) {
          if (col < globalFirstG || col > globalLastG) continue;
          const cell = cells[rowBase + col];
          if (!cell || cell.placeholder) continue;
          if (cell.ch === "") continue;
          mark(col, row);
        }
      }
    }
  }

  // Split ctx mirror from anchor side only → partner (char-isomorphic)
  if (anchorSide) {
    mirrorDiffContext(sel, codeHits, contentOrigin, codeAt, anchorSide, width, height, mark);
  }
}

/**
 * Mirror primary (anchor-side) selected content cols onto the partner half.
 */
function mirrorDiffContext(
  sel: SelectionState,
  codeHits: HitMeta[],
  contentOrigin: Map<string, number>,
  codeAt: Map<string, HitMeta>,
  anchorSide: Side,
  width: number,
  height: number,
  mark: (col: number, row: number) => void,
): void {
  const originKey = (diffKey: string, lineIndex: number, side: string, row: number) =>
    `${diffKey}\0${lineIndex}\0${side}\0${row}`;

  const partner: Side = anchorSide === "L" ? "R" : "L";

  for (const meta of codeHits) {
    const dl = meta.diffLine!;
    if (dl.kind !== "ctx" || dl.side !== anchorSide) continue;
    const r = meta.hitRect;

    for (let row = r.y; row < r.y + r.h; row++) {
      const range = rowRange(sel, row, width);
      if (!range) continue;
      // Clip geometry to this half's content — not to EOL across the gap
      const c0 = Math.max(range[0], r.x, 0);
      const c1 = Math.min(range[1], r.x + r.w - 1, width - 1);
      if (c1 < c0) continue;

      const oSelf = contentOrigin.get(originKey(dl.diffKey, dl.lineIndex, anchorSide, row));
      const oPartner = contentOrigin.get(originKey(dl.diffKey, dl.lineIndex, partner, row));
      if (oSelf === undefined || oPartner === undefined) continue;

      for (let col = c0; col <= c1; col++) {
        if (!codeAt.has(`${col},${row}`)) continue;
        // Only cells that belong to this half's content (meta may be multi-span)
        const here = codeAt.get(`${col},${row}`);
        if (here?.diffLine?.side !== anchorSide) continue;
        if (here.diffLine.lineIndex !== dl.lineIndex) continue;
        if (here.diffLine.diffKey !== dl.diffKey) continue;

        const rel = col - oSelf;
        const pCol = oPartner + rel;
        if (pCol < 0 || pCol >= width || row < 0 || row >= height) continue;
        const pMeta = codeAt.get(`${pCol},${row}`);
        if (!pMeta?.diffLine) continue;
        if (pMeta.diffLine.diffKey !== dl.diffKey) continue;
        if (pMeta.diffLine.lineIndex !== dl.lineIndex) continue;
        if (pMeta.diffLine.side !== partner) continue;
        mark(pCol, row);
      }
    }
  }
}

/**
 * Highlight cell the copy plaque anchors to — not the pointer.
 * Trailing pad past the last glyph is not selected; `active` can sit in that
 * empty space (short line, release to the right). Clamp onto the lit span on
 * the active row; if that row is dark, use the drag-direction extreme.
 */
export function selectionRangeEnd(sel: SelectionState, buffer: CellGrid, frame: Frame): Cell {
  const acc: { lo: number; hi: number; hit: boolean; first: Cell | null; last: Cell | null } = {
    lo: Infinity,
    hi: -Infinity,
    hit: false,
    first: null,
    last: null,
  };
  forEachHighlightCell(sel, buffer, frame, (col, row) => {
    const cell = { col, row };
    if (!acc.first || row < acc.first.row || (row === acc.first.row && col < acc.first.col)) acc.first = cell;
    if (!acc.last || row > acc.last.row || (row === acc.last.row && col > acc.last.col)) acc.last = cell;
    if (row !== sel.active.row) return;
    acc.hit = true;
    if (col < acc.lo) acc.lo = col;
    if (col > acc.hi) acc.hi = col;
  });
  if (acc.hit) {
    return {
      col: Math.min(acc.hi, Math.max(acc.lo, sel.active.col)),
      row: sel.active.row,
    };
  }
  const towardStart =
    sel.active.row < sel.anchor.row || (sel.active.row === sel.anchor.row && sel.active.col < sel.anchor.col);
  return (towardStart ? acc.first : acc.last) ?? sel.active;
}

/** Leaf content keys may contribute space-only runs; container stage may not. */
function isLeafContentKey(key: string, frame: Frame): boolean {
  const meta = frame.byKey.get(key);
  if (!meta) return false;
  if (meta.userSelect === "contain" || meta.userSelect === "all") return true;
  return meta.element?.kind === "text";
}
