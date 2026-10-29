/**
 * Visual (painted) draft geometry — soft-wrap aware caret motion.
 *
 * Uses the same `pre-wrap` + display-column measure lineage as
 * {@link chromeFrameBodyLines} / composer body paint, so ↑/↓/Home/End track
 * spatial rows on screen, not only hard `\n`s.
 */
import { wrapText } from "./text.js";
import { defaultMeasure, displayWidth } from "../measure/index.js";

export type VisualDraftLine = {
  /** UTF-16 start offset into draft (inclusive). */
  readonly start: number;
  /** UTF-16 end offset into draft (exclusive); does not include a trailing `\n`. */
  readonly end: number;
  readonly text: string;
};

/**
 * Partition `draft` into painted body rows at `textW` content columns.
 * Empty draft → one empty visual line at 0 (caret-only row).
 */
export function visualDraftLines(draft: string, textW: number): readonly VisualDraftLine[] {
  const w = Math.max(1, Math.floor(textW));
  if (draft.length === 0) return [{ start: 0, end: 0, text: "" }];

  const hardLines = draft.split("\n");
  const out: VisualDraftLine[] = [];
  let pos = 0;
  for (let hi = 0; hi < hardLines.length; hi++) {
    const hard = hardLines[hi]!;
    const soft = wrapText(hard, {
      width: w,
      whiteSpace: "pre-wrap",
      measure: defaultMeasure,
    });
    let hardPos = 0;
    for (const line of soft) {
      const start = pos + hardPos;
      out.push({ start, end: start + line.length, text: line });
      hardPos += line.length;
    }
    // Empty hard line (e.g. trailing `\n` or `\n\n`) still paints a blank row.
    if (soft.length === 0) {
      out.push({ start: pos, end: pos, text: "" });
    }
    pos += hard.length;
    if (hi < hardLines.length - 1) pos += 1; // consumed `\n`
  }
  return out.length > 0 ? out : [{ start: 0, end: 0, text: "" }];
}

/**
 * Index of the visual line containing `cursor`.
 *
 * Soft-wrap / full-row law (browser textarea):
 *   - offset at end of row i that continues as row i+1 (shared boundary) → i+1
 *   - offset at end of a **full-width last** row (measure ≥ textW, no next) →
 *     a **virtual** empty continuation row at index `lines.length` (col 0).
 *     Without this, park places the caret on the right border cell (one past
 *     the text column) while paint only fills `textW` content cells.
 *
 * Hard newline is two offsets (`line.end` is the `\n`, next row starts at
 * `end+1`). Cursor on `\n` stays on this row (after the last glyph). Cursor
 * after `\n` is col 0 of the next row. Collapsing them onto the next row
 * parks the caret on the empty line while insert still splices before `\n`.
 *
 * Returns `0..lines.length` inclusive (the last value is the virtual row).
 */
export function visualLineIndex(lines: readonly VisualDraftLine[], cursor: number, textW?: number): number {
  if (lines.length === 0) return 0;
  const c = Math.max(0, cursor);
  const w = textW === undefined ? undefined : Math.max(1, Math.floor(textW));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (c >= line.start && c <= line.end) {
      // Prefer later real line at soft-wrap boundary.
      if (c === line.end && i + 1 < lines.length && lines[i + 1]!.start === c) {
        continue;
      }
      // Full last row: caret-after-last sits on a virtual next row at col 0.
      if (w !== undefined && c === line.end && i === lines.length - 1 && displayWidth(line.text) >= w) {
        return lines.length;
      }
      return i;
    }
  }
  return lines.length - 1;
}

/**
 * Display column of the caret within its visual line (0 = start of content).
 */
export function visualColInLine(draft: string, line: VisualDraftLine, cursor: number): number {
  const c = Math.max(line.start, Math.min(line.end, cursor));
  return displayWidth(draft.slice(line.start, c));
}

/**
 * Map a preferred display column onto a UTF-16 offset within `line`.
 * Lands before a grapheme when the column falls inside a wide cell.
 */
export function offsetAtVisualCol(draft: string, line: VisualDraftLine, targetCol: number): number {
  if (targetCol <= 0) return line.start;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let col = 0;
  let offset = line.start;
  for (const { segment } of segmenter.segment(draft.slice(line.start, line.end))) {
    const w = displayWidth(segment);
    if (col + w > targetCol) return offset; // inside / at this grapheme → before it
    col += w;
    offset += segment.length;
    if (col >= targetCol) return offset;
  }
  return line.end;
}

export type VisualMotion = "line_up" | "line_down" | "line_home" | "line_end";

/**
 * Spatial caret park within the content box (0-based line, display col).
 *
 * Soft-wrap boundary law (browser / textarea): when the UTF-16 offset is both
 * the end of visual row i and the start of row i+1, the caret sits on **row
 * i+1 at col 0** — not trailing past the last glyph of row i. Park and ↑/↓
 * must share this, or arrow-up from a wrap-start jumps to "after last" of
 * the previous row (preferred-col = full width) instead of its first char.
 */
export function visualCaretGeometry(
  draft: string,
  cursor: number,
  textW: number,
): {
  readonly line: number;
  readonly colInContent: number;
  readonly totalLines: number;
} {
  const w = Math.max(1, Math.floor(textW));
  const lines = visualDraftLines(draft, w);
  const c = Math.max(0, Math.min(draft.length, cursor));
  const idx = visualLineIndex(lines, c, w);

  // Virtual continuation row past a full last line: col 0.
  if (idx >= lines.length) {
    return {
      line: lines.length,
      colInContent: 0,
      totalLines: lines.length + 1,
    };
  }

  const line = lines[idx]!;
  const col = visualColInLine(draft, line, c);
  // Never park on the right border (relative col === textW) — that cell is the
  // frame's `│`. Soft-wrap / last-row overflow already moved `idx` to the next
  // (possibly virtual) row. A full row that a `\n` follows still has col === w
  // at `line.end`; next-row col 0 would show start-of-next-line while insert
  // splices before the `\n`. Clamp to the last text cell.
  if (col >= w) {
    return {
      line: idx,
      colInContent: Math.max(0, w - 1),
      totalLines: Math.max(1, lines.length),
    };
  }
  return {
    line: idx,
    colInContent: col,
    totalLines: Math.max(1, lines.length),
  };
}

/**
 * Spatial caret motion over painted draft rows.
 * `textW` must be the composer body content width (outer − chrome), same as paint.
 */
export function moveVisualDraft(draft: string, cursor: number, textW: number, motion: VisualMotion): number {
  const w = Math.max(1, Math.floor(textW));
  const lines = visualDraftLines(draft, w);
  const c = Math.max(0, Math.min(draft.length, cursor));
  const idx = visualLineIndex(lines, c, w);

  // Virtual empty row after a full last line.
  if (idx >= lines.length) {
    switch (motion) {
      case "line_home":
      case "line_end":
        return c; // empty virtual row — only one offset
      case "line_up": {
        const prev = lines.at(-1)!;
        // From col 0 of virtual row → col 0 of previous (first char), not end.
        return offsetAtVisualCol(draft, prev, 0);
      }
      case "line_down":
        return c;
    }
  }

  const line = lines[idx]!;

  switch (motion) {
    case "line_home":
      return line.start;
    case "line_end":
      return line.end;
    case "line_up": {
      if (idx <= 0) return c;
      const col = visualColInLine(draft, line, c);
      return offsetAtVisualCol(draft, lines[idx - 1]!, col);
    }
    case "line_down": {
      if (idx >= lines.length - 1) {
        // Stay, unless we're mid full-row and a virtual row would open — then
        // line_end of this row is already c when c === line.end.
        return c;
      }
      const col = visualColInLine(draft, line, c);
      return offsetAtVisualCol(draft, lines[idx + 1]!, col);
    }
  }
}
