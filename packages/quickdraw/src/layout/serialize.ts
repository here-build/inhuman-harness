/**
 * Phase 2b — cell→text serialization for text selection copy.
 *
 * Global layer:
 *   1. Chrome exclusion (`userSelect: "none"`)
 *   2. Per-row column range via {@link rowRange}
 *   3. Wide-char reassembly (placeholder cells skipped)
 *   4. Right-trim per line
 *
 * Grid tables (semantic):
 *   Painted tables are wide (cell pad, │ bars, ─/┼ rules). Copy rebuilds a
 *   **minimal markdown table** from {@link HitMeta.tableCell} stamps:
 *   - only columns that have selected content
 *   - half-selected cells → only the selected substring
 *   - omitted leading columns → leading `|` (e.g. `| 2 | 3` from `1│2│3`)
 *   - separators are compact `---` / `|---|---` (not terminal-width rules)
 *   - mid-row bar rows are never emitted as raw ─/┼ runs
 *
 * Diff lines (semantic):
 *   Painted diffs have ▌ gutters, line numbers, dual split halves. Copy
 *   rebuilds **git-format** lines from {@link HitMeta.diffLine}:
 *   - character-granular slice of source `text` (full line when wholly selected)
 *   - incomplete lines: ASCII `...` lead/trail ellipsis
 *   - prefix ` ` / `-` / `+` from kind
 *   - split context L/R share lineIndex → one emit (never doubled)
 *   - change halves keep separate lineIndex in git order (dels then adds)
 */

import { buildChromeMask, type CoverageMask } from "./chrome_mask.js";
import { rowRange, selectionRect, type SelectionState } from "./selection.js";
import type { DiffLineRef, Frame, HitMeta, Rect, TableCellRef, UserSelect } from "./types.js";
import type { Cell as BufferCell } from "../buffer/index.js";

/** Structural shape we need from the buffer — a slice of the Buffer type. */
type CellGrid = {
  cells: BufferCell[];
  width: number;
  height: number;
};

type EmitBlock = {
  /** First buffer row this block occupies (sort key). */
  y: number;
  lines: string[];
  /** Buffer rows this block owns (skip free-text walk). */
  ownedRows: ReadonlySet<number>;
};

/**
 * Serialize the selection to clipboard text.
 */
export function serializeSelection(buffer: CellGrid, frame: Frame, sel: SelectionState): string {
  const { width, height } = buffer;

  const envelope = selectionRect(sel, width);
  const tlRow = envelope.y;
  const brRow = envelope.y + envelope.h - 1;
  const tlCol = envelope.x;
  const brCol = envelope.x + envelope.w - 1;

  const lastRow = Math.min(brRow, height - 1);
  if (lastRow < tlRow || tlRow > height - 1) return "";

  const chromeMask = buildChromeMask(frame, tlCol, tlRow, brCol, brRow, width, height);

  const tableBlocks = serializeTables(buffer, frame, sel, chromeMask, tlRow, lastRow);
  const diffBlocks = serializeDiffs(buffer, frame, sel, tlRow, lastRow);
  const ownedSemantic = new Set<number>();
  for (const b of tableBlocks) {
    for (const r of b.ownedRows) ownedSemantic.add(r);
  }
  for (const b of diffBlocks) {
    for (const r of b.ownedRows) ownedSemantic.add(r);
  }

  const freeBlocks: EmitBlock[] = [];
  let freeLines: string[] = [];
  let freeStartY = -1;

  const flushFree = () => {
    if (freeLines.length === 0) return;
    freeBlocks.push({
      y: freeStartY,
      lines: freeLines,
      ownedRows: new Set(),
    });
    freeLines = [];
    freeStartY = -1;
  };

  for (let row = tlRow; row <= lastRow; row++) {
    if (ownedSemantic.has(row)) {
      flushFree();
      continue;
    }
    const line = serializeFreeRow(buffer, sel, chromeMask, row, width);
    if (line === null) continue;
    if (freeStartY < 0) freeStartY = row;
    freeLines.push(line);
  }
  flushFree();

  const blocks = [...tableBlocks, ...diffBlocks, ...freeBlocks].sort((a, b) => a.y - b.y);
  const lines: string[] = [];
  for (const b of blocks) lines.push(...b.lines);

  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) return "";
  // CLIPBOARD: lines plus exactly one terminating `\n`. `join("\n")` alone
  // has no final line; a second `\n` pastes a blank last line.
  return `${lines.join("\n")}\n`;
}

// ── Free (non-table) row ────────────────────────────────────────────────────

/** null = row outside selection; "" = selected but empty after trim. */
function serializeFreeRow(
  buffer: CellGrid,
  sel: SelectionState,
  chromeMask: CoverageMask,
  row: number,
  width: number,
): string | null {
  const range = rowRange(sel, row, width);
  if (!range) return null;
  const [startCol, endCol] = range;
  const colStart = Math.max(0, startCol);
  const colEnd = Math.min(endCol, width - 1);
  const rowBase = row * width;
  let line = "";
  for (let col = colStart; col <= colEnd; col++) {
    if (chromeMask.isChrome(col, row)) continue;
    const cell = buffer.cells[rowBase + col];
    if (!cell) continue;
    if (cell.placeholder) continue;
    line += cell.ch === "" ? " " : cell.ch;
  }
  return line.replace(/\s+$/u, "");
}

// ── Grid → compact markdown ─────────────────────────────────────────────────

type CellPick = {
  ref: TableCellRef;
  meta: HitMeta;
  text: string;
};

function serializeTables(
  buffer: CellGrid,
  frame: Frame,
  sel: SelectionState,
  chromeMask: CoverageMask,
  tlRow: number,
  lastRow: number,
): EmitBlock[] {
  // Collect selected table cells (partial text per cell).
  const byGrid = new Map<string, CellPick[]>();
  for (const meta of frame.byKey.values()) {
    const tc = meta.tableCell;
    if (!tc || meta.phantom) continue;
    const text = extractSelectedInRect(buffer, sel, chromeMask, meta.hitRect);
    if (text === null) continue;
    // Cell must touch the envelope vertically
    if (meta.hitRect.y + meta.hitRect.h - 1 < tlRow) continue;
    if (meta.hitRect.y > lastRow) continue;
    let list = byGrid.get(tc.gridKey);
    if (!list) {
      list = [];
      byGrid.set(tc.gridKey, list);
    }
    list.push({ ref: tc, meta, text });
  }
  if (byGrid.size === 0) return [];

  const blocks: EmitBlock[] = [];
  for (const [gridKey, picks] of byGrid) {
    const block = formatGridMarkdown(gridKey, picks, frame);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Extract selected text inside a content rect, or null if nothing selected.
 * Half-selected cells keep only the intersecting substring (per-row).
 */
function extractSelectedInRect(
  buffer: CellGrid,
  sel: SelectionState,
  chromeMask: CoverageMask,
  rect: Rect,
): string | null {
  const { cells, width, height } = buffer;
  if (rect.w <= 0 || rect.h <= 0) return null;
  const lines: string[] = [];
  let any = false;
  const y0 = Math.max(0, rect.y);
  const y1 = Math.min(height - 1, rect.y + rect.h - 1);
  for (let row = y0; row <= y1; row++) {
    const range = rowRange(sel, row, width);
    if (!range) continue;
    const c0 = Math.max(range[0], rect.x, 0);
    const c1 = Math.min(range[1], rect.x + rect.w - 1, width - 1);
    if (c1 < c0) continue;
    const rowBase = row * width;
    let line = "";
    for (let col = c0; col <= c1; col++) {
      if (chromeMask.isChrome(col, row)) continue;
      const cell = cells[rowBase + col];
      if (!cell || cell.placeholder) continue;
      any = true;
      line += cell.ch === "" ? " " : cell.ch;
    }
    lines.push(line.replace(/\s+$/u, ""));
  }
  if (!any) return null;
  // nowrap table cells are single-line; multi-line cells join with space
  return lines.join(" ").replace(/\s+$/u, "");
}

function formatGridMarkdown(gridKey: string, picks: CellPick[], frame: Frame): EmitBlock | null {
  if (picks.length === 0) return null;
  const nCols = picks[0]!.ref.nCols;
  const nRows = picks[0]!.ref.nRows;

  // row -> col -> text
  const grid = new Map<number, Map<number, string>>();
  let minY = Infinity;
  let maxY = -Infinity;
  const ownedRows = new Set<number>();

  for (const p of picks) {
    let rowMap = grid.get(p.ref.row);
    if (!rowMap) {
      rowMap = new Map();
      grid.set(p.ref.row, rowMap);
    }
    // First pick wins if duplicates (shouldn't happen)
    if (!rowMap.has(p.ref.col)) rowMap.set(p.ref.col, p.text);
    const r = p.meta.hitRect;
    minY = Math.min(minY, r.y);
    maxY = Math.max(maxY, r.y + r.h - 1);
  }

  // Own all buffer rows under the grid's painted area so free-walk skips
  // separator rules (─/┼) and padded bar runs.
  const gridMeta = frame.byKey.get(gridKey);
  if (gridMeta) {
    const gr = gridMeta.hitRect;
    for (let y = gr.y; y < gr.y + gr.h; y++) ownedRows.add(y);
  } else {
    for (let y = minY; y <= maxY; y++) ownedRows.add(y);
  }

  const selectedRows = [...grid.keys()].sort((a, b) => a - b);
  if (selectedRows.length === 0) return null;

  // Columns that appear in any selected cell (omitted cols drop out of MD)
  const usedCols = new Set<number>();
  for (const rowMap of grid.values()) {
    for (const c of rowMap.keys()) usedCols.add(c);
  }
  const cols = [...usedCols].sort((a, b) => a - b);
  if (cols.length === 0) return null;
  const minCol = cols[0]!;
  const leadingOmit = minCol > 0;

  const mdLines: string[] = [];
  for (let i = 0; i < selectedRows.length; i++) {
    const gr = selectedRows[i]!;
    const rowMap = grid.get(gr)!;
    const parts: string[] = [];
    for (const c of cols) {
      // Missing col in this row (selected elsewhere only) → empty cell
      parts.push(rowMap.has(c) ? rowMap.get(c)! : "");
    }
    mdLines.push(formatMdDataRow(parts, leadingOmit));
    // Compact separator between consecutive selected data rows (not between
    // every painted ─ rule — only once per adjacent selected pair).
    if (i < selectedRows.length - 1) {
      mdLines.push(formatMdSep(parts.length, leadingOmit));
    }
  }

  // Silence unused dims (kept for future full-table export)
  void nCols;
  void nRows;

  return { y: minY, lines: mdLines, ownedRows };
}

/**
 * Format one markdown table data row.
 * leadingOmit → prefix `|` so omitted leading cells read as `| 2 | 3`.
 */
export function formatMdDataRow(parts: string[], leadingOmit: boolean): string {
  const body = parts.join(" | ");
  return leadingOmit ? `| ${body}` : body;
}

/** Compact separator matching column count (not terminal-width ─ runs). */
export function formatMdSep(nCols: number, leadingOmit: boolean): string {
  const n = Math.max(1, nCols);
  const body = Array.from({ length: n }, () => "---").join("|");
  return leadingOmit ? `|${body}` : body;
}

// ── Diff → git-format lines ─────────────────────────────────────────────────

const SELECTABLE: ReadonlySet<UserSelect> = new Set(["text", "all", "contain"]);

function gitPrefix(kind: DiffLineRef["kind"]): string {
  if (kind === "del") return "-";
  if (kind === "add") return "+";
  return " ";
}

/**
 * Rebuild selected diff lines as unified git patch lines.
 *
 * - Dedups split context L/R by (diffKey, lineIndex).
 * - Character-granular: only the selected slice of each line.
 * - Incomplete lines get `...` lead/trail ellipsis (not terminal chrome).
 * - Full lines use stamp `text` (source of truth; painted wrap/gutter ignored).
 */
function serializeDiffs(
  buffer: CellGrid,
  frame: Frame,
  sel: SelectionState,
  tlRow: number,
  lastRow: number,
): EmitBlock[] {
  type Pick = {
    ref: DiffLineRef;
    y: number;
    /** Prefer L for ctx so both halves don't double-work. */
    side: "L" | "R" | "U";
  };

  // logical id → best pick
  const byLogical = new Map<string, Pick>();
  // all code-text hits for a logical line (for cell enumeration)
  const hitsByLogical = new Map<string, HitMeta[]>();

  for (const meta of frame.byKey.values()) {
    const dl = meta.diffLine;
    if (!dl || meta.phantom) continue;
    if (!SELECTABLE.has(meta.userSelect)) continue;
    if (meta.element?.kind !== "text") continue;

    const id = `${dl.diffKey}\0${dl.lineIndex}`;
    let list = hitsByLogical.get(id);
    if (!list) {
      list = [];
      hitsByLogical.set(id, list);
    }
    list.push(meta);

    if (!hitParticipates(sel, meta, buffer.width)) continue;
    if (meta.hitRect.y + meta.hitRect.h - 1 < tlRow) continue;
    if (meta.hitRect.y > lastRow) continue;

    const side = dl.side ?? "U";
    const prev = byLogical.get(id);
    // Prefer L over R for ctx; lower y wins as sort key
    if (!prev || meta.hitRect.y < prev.y || (side === "L" && prev.side === "R")) {
      byLogical.set(id, { ref: dl, y: meta.hitRect.y, side });
    }
  }

  if (byLogical.size === 0) return [];

  const byDiff = new Map<string, Pick[]>();
  for (const p of byLogical.values()) {
    let list = byDiff.get(p.ref.diffKey);
    if (!list) {
      list = [];
      byDiff.set(p.ref.diffKey, list);
    }
    list.push(p);
  }

  const blocks: EmitBlock[] = [];
  for (const picks of byDiff.values()) {
    picks.sort((a, b) => a.ref.lineIndex - b.ref.lineIndex);
    const lines: string[] = [];
    const blockOwned = new Set<number>();
    let minY = Infinity;

    for (const p of picks) {
      const id = `${p.ref.diffKey}\0${p.ref.lineIndex}`;
      const hits = hitsByLogical.get(id) ?? [];
      // Prefer the pick's side for cell stream; fall back to any
      const sideHits = hits.filter((h) => (h.diffLine!.side ?? "U") === p.side);
      const useHits = sideHits.length > 0 ? sideHits : hits;

      const formatted = formatDiffLineSelection(buffer, sel, p.ref, useHits);
      if (formatted === null) continue;
      lines.push(formatted);
      minY = Math.min(minY, p.y);
      for (const h of useHits) {
        for (let y = h.hitRect.y; y < h.hitRect.y + h.hitRect.h; y++) {
          blockOwned.add(y);
        }
      }
    }
    if (lines.length === 0) continue;
    blocks.push({ y: minY, lines, ownedRows: blockOwned });
  }
  return blocks;
}

function hitParticipates(sel: SelectionState, meta: HitMeta, width: number): boolean {
  const r = meta.hitRect;
  for (let row = r.y; row < r.y + r.h; row++) {
    const range = rowRange(sel, row, width);
    if (!range) continue;
    if (range[1] < r.x || range[0] >= r.x + r.w) continue;
    return true;
  }
  return false;
}

function cellSelected(sel: SelectionState, col: number, row: number, width: number): boolean {
  const range = rowRange(sel, row, width);
  if (!range) return false;
  return col >= range[0] && col <= range[1];
}

/**
 * Content cells of a line in reading order (row-major).
 */
function enumerateContentCells(hits: HitMeta[]): Array<{ col: number; row: number }> {
  const cells: Array<{ col: number; row: number }> = [];
  const seen = new Set<string>();
  const sorted = [...hits].sort((a, b) => a.hitRect.y - b.hitRect.y || a.hitRect.x - b.hitRect.x);
  for (const h of sorted) {
    const r = h.hitRect;
    for (let row = r.y; row < r.y + r.h; row++) {
      for (let col = r.x; col < r.x + r.w; col++) {
        const id = `${col},${row}`;
        if (seen.has(id)) continue;
        seen.add(id);
        cells.push({ col, row });
      }
    }
  }
  return cells;
}

/**
 * Format one git line from character-granular selection.
 * Incomplete ends get ASCII `...` ellipsis.
 */
function formatDiffLineSelection(
  buffer: CellGrid,
  sel: SelectionState,
  ref: DiffLineRef,
  hits: HitMeta[],
): string | null {
  const { width, cells } = buffer;
  const all = enumerateContentCells(hits);
  if (all.length === 0) {
    // Empty line (e.g. pure blank del) — if any hit participated, emit prefix only
    return gitPrefix(ref.kind) + ref.text;
  }

  const selected = all.filter((c) => cellSelected(sel, c.col, c.row, width));
  if (selected.length === 0) return null;

  const lead = selected[0] !== all[0];
  const trail = selected.at(-1) !== all.at(-1);

  let body: string;
  if (!lead && !trail) {
    // Full line — stamp is source of truth (not painted wrap)
    body = ref.text;
  } else {
    // Partial — buffer slice of selected content cells
    body = "";
    for (const c of selected) {
      const cell = cells[c.row * width + c.col];
      if (!cell || cell.placeholder) continue;
      if (cell.ch === "") continue;
      body += cell.ch;
    }
  }

  const ell = "...";
  return gitPrefix(ref.kind) + (lead ? ell : "") + body + (trail ? ell : "");
}
