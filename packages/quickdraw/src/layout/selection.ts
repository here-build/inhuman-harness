/**
 * Selection state model — buffer-cell-space ranges with granularity.
 *
 * State lives renderer/main-side (the buffer owner). The host wires mouse
 * gestures (Phase 1d) and keyboard selection into transitions on this type;
 * paint (Phase 1c) reads it to mark cells `selected`.
 *
 * Two cooperating concepts:
 *
 *  1. GLOBAL state (this module): anchor/active cells + granularity. Knows
 *     "this cell is fully inside the selection range" — the cheap, geometry-
 *     only membership test. Does NOT know what text a cell renders.
 *
 *  2. COMPONENT-delegated serialization (Phase 2b): each widget declares how
 *     its cells map back to semantic content (markdown source, diff text,
 *     code). The global layer asks "is this cell selected?" and the component
 *     answers "what text does it produce?"
 *
 * Geometry law (the bifunctor):
 *  - `"char"` / `"word"` — **stream** range in document order (row-major).
 *    Multi-line: first row from start.col→EOL, middle rows full width, last
 *    row SOL→end.col. Same model every terminal/editor uses for drag-select.
 *  - `"line"` — full row width for every row in the vertical span.
 *  - `"rect"` — axis-aligned column block (Alt+drag / tmux rectangle).
 *  - `"structural"` — bounding box of a LayoutNode (refined by component).
 *
 * Cell coordinates are 0-indexed buffer cells (matching `elementAt`'s
 * internal rect math after the 1-based SGR subtraction).
 */

import type { Rect } from "./types.js";

/** 0-indexed buffer cell. */
export type Cell = { col: number; row: number };

/**
 * Selection granularity — what a drag or extend operation selects.
 *
 * - `"char"`       — stream range, cell-by-cell (the bare-drag default)
 * - `"word"`       — stream range, endpoints snapped to word bounds
 * - `"line"`       — whole logical lines (triple-click; code/diff/log default)
 * - `"rect"`       — rectangular/columnar block (Alt+drag, tmux rectangle-toggle)
 * - `"structural"` — a LayoutNode subtree (Ctrl+W walk; the Phase 4 moat)
 */
export type SelectionGranularity = "char" | "word" | "line" | "rect" | "structural";

/**
 * Active text selection. `null` = no selection.
 *
 * - `anchor` — where the selection started (fixed during a drag)
 * - `active` — the moving end (follows the pointer / keyboard endpoint)
 * - `granularity` — how drag/extend snaps the range
 * - `anchorKey` — the LayoutNode key the anchor started in
 * - `contain` — when set (anchor under `userSelect: "contain"`, e.g. composer
 *   input), every geometry query and endpoint clamp is confined to this rect.
 *   Selection never paints or serializes outside the input.
 */
export type SelectionState = {
  anchor: Cell;
  active: Cell;
  granularity: SelectionGranularity;
  /** LayoutNode key at the anchor (structural walk / contain node). */
  anchorKey?: string;
  /**
   * Confinement rect from `userSelect: "contain"` (buffer coords, inclusive
   * origin + size). CSS textarea model: drag cannot leave this box.
   */
  contain?: Rect;
};

/** Clamp a cell into a rect (inclusive). */
export function clampCell(cell: Cell, rect: Rect): Cell {
  const maxC = rect.x + Math.max(1, rect.w) - 1;
  const maxR = rect.y + Math.max(1, rect.h) - 1;
  return {
    col: Math.min(maxC, Math.max(rect.x, cell.col)),
    row: Math.min(maxR, Math.max(rect.y, cell.row)),
  };
}

/** Clip an inclusive column range to contain on this row; null if row outside. */
function clipRangeToContain(
  range: readonly [number, number],
  row: number,
  contain: Rect | undefined,
): readonly [number, number] | null {
  if (!contain) return range;
  if (row < contain.y || row >= contain.y + contain.h) return null;
  const c0 = contain.x;
  const c1 = contain.x + contain.w - 1;
  const start = Math.max(range[0], c0);
  const end = Math.min(range[1], c1);
  if (end < start) return null;
  return [start, end];
}

/**
 * Start a new selection at a cell. Anchor and active both start at the cell;
 * a subsequent drag/extend moves `active`. When `contain` is set, the cell is
 * clamped into that rect and the confinement rides on the state.
 */
export function startSelection(
  cell: Cell,
  granularity: SelectionGranularity = "char",
  anchorKey?: string,
  contain?: Rect,
): SelectionState {
  const c = contain ? clampCell(cell, contain) : cell;
  return { anchor: c, active: c, granularity, anchorKey, contain };
}

/** Move the active end (drag / shift-click extend / keyboard arrow). */
export function extendSelection(sel: SelectionState | null, cell: Cell): SelectionState | null {
  if (!sel) return null;
  const c = sel.contain ? clampCell(cell, sel.contain) : cell;
  return { ...sel, active: c };
}

/** Clear the selection. */
export function clearSelection(): SelectionState | null {
  return null;
}

/**
 * True when anchor and active are the same cell (collapsed caret / click
 * without drag). Copy-on-select hosts should skip OSC 52 for collapsed
 * selections unless multi-click expanded the range.
 */
export function isCollapsed(sel: SelectionState | null): boolean {
  if (!sel) return true;
  return sel.anchor.col === sel.active.col && sel.anchor.row === sel.active.row;
}

/**
 * True when the selection covers more than one cell under its geometry law.
 * For `"line"` a single-row collapsed click still selects the full line, so
 * this is true whenever granularity is line (or structural) even if collapsed.
 */
export function hasCopyableExtent(sel: SelectionState | null): boolean {
  if (!sel) return false;
  if (sel.granularity === "line" || sel.granularity === "structural") return true;
  if (sel.granularity === "word") {
    // Word may be expanded (anchor ≠ active) or still collapsed pre-snap.
    return !isCollapsed(sel);
  }
  return !isCollapsed(sel);
}

/** Document-order comparison: earlier row, then earlier col. */
function docBefore(a: Cell, b: Cell): boolean {
  return a.row < b.row || (a.row === b.row && a.col < b.col);
}

/**
 * Stream endpoints in document order (start ≤ end). Used by char/word geometry.
 * Anchor/active may be in either drag direction.
 */
export function streamEndpoints(sel: SelectionState): {
  start: Cell;
  end: Cell;
} {
  if (docBefore(sel.active, sel.anchor)) {
    return { start: sel.active, end: sel.anchor };
  }
  return { start: sel.anchor, end: sel.active };
}

/**
 * Axis-aligned corners (min/max col and row independently). Correct for
 * `"rect"`; for stream ranges this is only a loose envelope — use
 * {@link rowRange} for exact per-row membership.
 */
function axisCorners(sel: SelectionState): { tl: Cell; br: Cell } {
  return {
    tl: {
      col: Math.min(sel.anchor.col, sel.active.col),
      row: Math.min(sel.anchor.row, sel.active.row),
    },
    br: {
      col: Math.max(sel.anchor.col, sel.active.col),
      row: Math.max(sel.anchor.row, sel.active.row),
    },
  };
}

/**
 * Bounding rect envelope of the selection in buffer coordinates.
 *
 * For multi-line stream (`"char"`/`"word"`) and `"line"`, the envelope spans
 * full row width when `rowWidth` is supplied — paint loops walk this rect and
 * filter with {@link rowRange}. When `rowWidth` is omitted, multi-line
 * stream uses a conservative full-width sentinel (caller should prefer
 * providing width).
 *
 * For `"rect"` the envelope IS the selected region.
 */
export function selectionRect(sel: SelectionState, rowWidth: number = Number.MAX_SAFE_INTEGER): Rect {
  const w = Math.max(1, rowWidth);
  // When confined, the envelope is at most the contain box (input never
  // "selects" the rest of the terminal).
  if (sel.contain) {
    return { ...sel.contain };
  }

  if (sel.granularity === "rect" || sel.granularity === "structural") {
    const { tl, br } = axisCorners(sel);
    return {
      x: tl.col,
      y: tl.row,
      w: br.col - tl.col + 1,
      h: br.row - tl.row + 1,
    };
  }

  if (sel.granularity === "line") {
    const r0 = Math.min(sel.anchor.row, sel.active.row);
    const r1 = Math.max(sel.anchor.row, sel.active.row);
    return { x: 0, y: r0, w, h: r1 - r0 + 1 };
  }

  // char / word — stream envelope
  const { start, end } = streamEndpoints(sel);
  if (start.row === end.row) {
    const c0 = Math.min(start.col, end.col);
    const c1 = Math.max(start.col, end.col);
    return { x: c0, y: start.row, w: c1 - c0 + 1, h: 1 };
  }
  // Multi-line stream spans full width (first line may start mid-row; last may
  // end mid-row — rowRange filters the corners).
  return { x: 0, y: start.row, w, h: end.row - start.row + 1 };
}

/**
 * Column range selected on a given row, or `null` if the row is outside the
 * selection. Returned range is **inclusive** on both ends: `[startCol, endCol]`.
 *
 * Geometry by granularity:
 * - `"char"` / `"word"` — stream: first/middle/last row rules
 * - `"line"` — full row `[0, rowWidth-1]`
 * - `"rect"` / `"structural"` — axis box columns on every selected row
 */
export function rowRange(sel: SelectionState, row: number, rowWidth: number): readonly [number, number] | null {
  if (rowWidth <= 0) return null;
  const lastCol = rowWidth - 1;

  let range: readonly [number, number] | null = null;

  if (sel.granularity === "line") {
    const r0 = Math.min(sel.anchor.row, sel.active.row);
    const r1 = Math.max(sel.anchor.row, sel.active.row);
    if (row < r0 || row > r1) return null;
    range = [0, lastCol];
  } else if (sel.granularity === "rect" || sel.granularity === "structural") {
    const { tl, br } = axisCorners(sel);
    if (row < tl.row || row > br.row) return null;
    range = [tl.col, br.col];
  } else {
    // char / word — stream
    const { start, end } = streamEndpoints(sel);
    if (row < start.row || row > end.row) return null;
    if (start.row === end.row) {
      range = [Math.min(start.col, end.col), Math.max(start.col, end.col)];
    } else if (row === start.row) {
      range = [start.col, lastCol];
    } else if (row === end.row) {
      range = [0, end.col];
    } else {
      range = [0, lastCol];
    }
  }

  return clipRangeToContain(range, row, sel.contain);
}

// ── Word bounds (for double-click snap) ─────────────────────────────────────

/**
 * Word character class for double-click selection. Letters, marks, numbers,
 * underscore — the terminal/editor convergence set. Everything else is a
 * separator (including whitespace and punctuation).
 */
function isWordChar(ch: string): boolean {
  if (!ch) return false;
  // First code point only (cell may hold a grapheme; we still classify by it).
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  // ASCII fast path
  if (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    cp === 0x5f // _
  ) {
    return true;
  }
  // Unicode letters / marks / numbers (no full ICU; good enough for TUI copy).
  try {
    return /[\p{L}\p{M}\p{N}]/u.test(String.fromCodePoint(cp));
  } catch {
    return false;
  }
}

export function wordBoundsOnRow(cells: readonly string[], col: number): readonly [number, number] {
  if (col < 0 || col >= cells.length) return [Math.max(0, col), Math.max(0, col)];
  const ch = cells[col] ?? "";
  if (!isWordChar(ch)) return [col, col];

  let start = col;
  while (start > 0 && isWordChar(cells[start - 1] ?? "")) start--;
  let end = col;
  while (end + 1 < cells.length && isWordChar(cells[end + 1] ?? "")) end++;
  return [start, end];
}

/**
 * Expand a collapsed (or any) selection to the full word under `cell`.
 * Sets anchor to word start and active to word end on that row.
 */
export function expandToWordAt(
  cell: Cell,
  getRowCells: (row: number) => readonly string[] | null | undefined,
  anchorKey?: string,
  contain?: Rect,
): SelectionState {
  const c = contain ? clampCell(cell, contain) : cell;
  const cells = getRowCells(c.row);
  if (!cells || cells.length === 0) {
    return startSelection(c, "word", anchorKey, contain);
  }
  let [a, b] = wordBoundsOnRow(cells, c.col);
  // Word snap must not escape the input box.
  if (contain) {
    a = Math.max(a, contain.x);
    b = Math.min(b, contain.x + contain.w - 1);
  }
  return {
    anchor: { col: a, row: c.row },
    active: { col: b, row: c.row },
    granularity: "word",
    anchorKey,
    contain,
  };
}

/**
 * Expand to full line under `cell` (triple-click). Anchor at col 0, active at
 * last content-ish col when `rowWidth` known; granularity `"line"` so
 * {@link rowRange} already spans full width either way. With `contain`, the
 * "line" is the input row only (cols of the box), never the whole terminal.
 */
export function expandToLineAt(cell: Cell, rowWidth: number, anchorKey?: string, contain?: Rect): SelectionState {
  if (contain) {
    const row = clampCell(cell, contain).row;
    return {
      anchor: { col: contain.x, row },
      active: { col: contain.x + contain.w - 1, row },
      granularity: "line",
      anchorKey,
      contain,
    };
  }
  const last = Math.max(0, rowWidth - 1);
  return {
    anchor: { col: 0, row: cell.row },
    active: { col: last, row: cell.row },
    granularity: "line",
    anchorKey,
  };
}
