/**
 * TTY caret park for the composer omnibox + click→offset inverse.
 *
 * Enter-alt hides the cursor (`?25l`). Every present tick must re-park/show
 * when focused, or the caret vanishes after first paint ("losing focus").
 *
 * Prefer laid-out body hit for `composer:frame` (text column). Click→offset
 * shares visualDraftLines with paint via widgets offsetAtVisualCell (not a
 * local char-wrap walk).
 */
import { offsetAfterVisualCell, offsetAtVisualCell } from "./composer-click.js";
import { visualCaretGeometry, type Frame } from "../layout/index.js";

export type CaretPark = {
  readonly row: number;
  readonly col: number;
  readonly show: boolean;
};

const DEFAULT_COMPOSER_FRAME_KEY = "composer:frame";

function localCell(
  col0: number,
  row0: number,
  origin: { col: number; row: number },
): { localCol: number; localRow: number } {
  return {
    localCol: Math.max(0, col0 - origin.col),
    localRow: Math.max(0, row0 - origin.row),
  };
}

export function composerOffsetAtCell(
  draft: string,
  col0: number,
  row0: number,
  origin: { col: number; row: number },
  textW: number,
): number {
  const w = Math.max(1, textW);
  const { localCol, localRow } = localCell(col0, row0, origin);
  return offsetAtVisualCell(draft, w, localRow, localCol);
}

/** Exclusive end of the grapheme at this body cell (padding stays put). */
export function composerOffsetAfterCell(
  draft: string,
  col0: number,
  row0: number,
  origin: { col: number; row: number },
  textW: number,
): number {
  const w = Math.max(1, textW);
  const { localCol, localRow } = localCell(col0, row0, origin);
  return offsetAfterVisualCell(draft, w, localRow, localCol);
}

/**
 * Visual composer selection → draft mark/cursor (textarea `[start, end)`).
 * Cell hits land *before* a grapheme; the later endpoint is exclusive.
 */
export function composerDraftSelectionFromCells(
  draft: string,
  anchor: { col: number; row: number },
  active: { col: number; row: number },
  origin: { col: number; row: number },
  textW: number,
): { cursor: number; mark: number } | null {
  const before = (cell: { col: number; row: number }) => composerOffsetAtCell(draft, cell.col, cell.row, origin, textW);
  const after = (cell: { col: number; row: number }) =>
    composerOffsetAfterCell(draft, cell.col, cell.row, origin, textW);
  const anchorFirst = anchor.row < active.row || (anchor.row === active.row && anchor.col <= active.col);
  const mark = anchorFirst ? before(anchor) : after(anchor);
  const cursor = anchorFirst ? after(active) : before(active);
  if (mark === cursor) return null;
  return { cursor, mark };
}

/** 1-based CUP for the draft caret. termFocused false → hide. */
export function parkComposerCaret(opts: {
  readonly draft: string;
  readonly cursor: number;
  readonly frame: Frame | null;
  readonly cols: number;
  readonly rows: number;
  readonly termFocused: boolean;
  /** Layout key for the chrome_frame draft surface. Default `composer:frame`. */
  readonly composerFrameKey?: string;
}): CaretPark {
  if (!opts.termFocused) return { row: 1, col: 1, show: false };

  const draft = opts.draft;
  const cursor = Math.max(0, Math.min(draft.length, opts.cursor));
  const frameKey = opts.composerFrameKey ?? DEFAULT_COMPOSER_FRAME_KEY;
  const hit = opts.frame?.byKey.get(frameKey)?.hitRect;

  // chrome_frame text column: hit.w (outer − 4: │ mark gap │), else estimate.
  const textW = hit && hit.w > 0 ? hit.w : Math.max(8, opts.cols - 4);
  // Same soft-wrap as ↑/↓: wrap-boundary offsets park on *next* row col 0,
  // not trailing past the last glyph of the prior row.
  const geom = visualCaretGeometry(draft, cursor, textW);
  const line = geom.line;
  const colInContent = geom.colInContent;

  if (hit && hit.h > 0) {
    // Never park on right border `│` (col === textW). Virtual line past bodyH
    // → last body row, last cell.
    const maxLine = Math.max(0, hit.h - 1);
    const lineClamped = Math.min(line, maxLine);
    const colIn = line > maxLine || colInContent >= textW ? Math.max(0, textW - 1) : colInContent;
    const row = Math.min(opts.rows, Math.max(1, hit.y + 1 + lineClamped));
    const col = Math.min(opts.cols, Math.max(1, hit.x + 1 + colIn));
    return { row, col, show: true };
  }

  // Laid-out frame without composer:frame — hide. A fallback CUP+?25h on a
  // catalog/demo paint is a visible hop every live tick (no draft to park).
  if (opts.frame !== null) return { row: 1, col: 1, show: false };

  // BOOT: caret must exist before first layout. Enter-alt hides (`?25l`);
  // hiding here leaves the cursor gone until a frame exists. Floor is
  // `rows-2` / `6+col` — a CUP into the composer band, not (1,1).
  return {
    row: Math.max(1, opts.rows - 2),
    col: Math.min(opts.cols, 6 + colInContent),
    show: true,
  };
}

export const SHOW_CURSOR = "\u001B[?25h";
export const HIDE_CURSOR = "\u001B[?25l";

export function caretAnsi(park: CaretPark): string {
  if (!park.show) return HIDE_CURSOR;
  return `\u001B[${park.row};${park.col}H${SHOW_CURSOR}`;
}
