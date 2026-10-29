/**
 * Composer click→caret — the inverse of {@link composerVisualGeometry}.
 *
 * Given a clicked cell inside the composer body, map it back to a character
 * offset in the draft string. This is the #1 missing feature in AI-TUI peers
 * (Claude Code, Gemini CLI, Codex all lack click-to-position-cursor).
 *
 * Uses the same visual line partition as paint/caret park:
 * {@link visualDraftLines} → `wrapText` with `pre-wrap` (word-preferring soft
 * wrap). Prior char-by-char walk disagreed with the renderer on space breaks
 * (audit C5).
 *
 * CJK convention (neovim `vcol2col`): a wide char occupies 2 cells. Click on
 * EITHER half of a wide char lands the cursor BEFORE it — never split a wide
 * char.
 *
 * Padding clamps follow the browser `<textarea>` convention: clicks in the
 * left padding clamp to line start; clicks past the line end clamp to the end
 * of the logical line.
 */

import { visualDraftLines } from "../layout/index.js";
import { displayWidth } from "../measure/index.js";

/**
 * Map (visualLine, visualCol) → UTF-16 offset using the same line breaks as paint.
 */
export function offsetAtVisualCell(draft: string, contentWidth: number, targetLine: number, targetCol: number): number {
  const lines = visualDraftLines(draft, contentWidth);
  if (lines.length === 0) return 0;

  if (targetLine >= lines.length) {
    return lines.at(-1)!.end;
  }

  const line = lines[targetLine]!;
  if (targetCol <= 0) return line.start;
  if (line.text.length === 0) return line.start;

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let colInLine = 0;
  let offset = line.start;

  for (const seg of segmenter.segment(line.text)) {
    const segWidth = displayWidth(seg.segment);
    // Click at or before this grapheme → land before it.
    if (targetCol <= colInLine) {
      return offset;
    }
    // Click inside a wide grapheme → land before it (don't split CJK).
    if (targetCol < colInLine + segWidth) {
      return offset;
    }
    colInLine += segWidth;
    offset += seg.segment.length;
  }

  // Past end of visual line → clamp to line end (exclusive of following soft-wrap text).
  return line.end;
}

function firstGraphemeLength(s: string): number {
  if (s.length === 0) return 0;
  try {
    const it = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)[Symbol.iterator]();
    const first = it.next();
    return first.done ? 0 : first.value.segment.length;
  } catch {
    const cp = s.codePointAt(0);
    return cp !== undefined && cp > 0xff_ff ? 2 : 1;
  }
}

/**
 * Exclusive end of the grapheme painted at this cell.
 * Padding / past-line cells stay at {@link offsetAtVisualCell} (already exclusive).
 */
export function offsetAfterVisualCell(
  draft: string,
  contentWidth: number,
  targetLine: number,
  targetCol: number,
): number {
  const start = offsetAtVisualCell(draft, contentWidth, targetLine, targetCol);
  const next = offsetAtVisualCell(draft, contentWidth, targetLine, targetCol + 1);
  if (next > start) return next;
  const lines = visualDraftLines(draft, Math.max(1, contentWidth));
  if (lines.length === 0) return start;
  const line = lines[Math.min(Math.max(0, targetLine), lines.length - 1)]!;
  if (start >= line.end) return start;
  if (targetCol >= displayWidth(line.text)) return start;
  return start + firstGraphemeLength(draft.slice(start, line.end));
}
