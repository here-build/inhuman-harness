/**
 * Click → caret on a run-array draft.
 *
 * Display text is text runs unchanged plus each chip's clipboard label.
 * Visual lines come from the same partition as composer paint
 * ({@link visualDraftLines}). A chip label is atomic: the left half of its
 * cells (a tie included) lands on the boundary before the chip, the right
 * half on the boundary after it. Ordinary text follows the wide-grapheme
 * rule in {@link offsetAtVisualCell}: either half lands before the grapheme.
 */

import type { RichPoint, RichRun } from "./rich-draft.js";
import { visualDraftLines } from "../layout/index.js";
import { displayWidth } from "../measure/index.js";

function displayOf(runs: readonly RichRun[]): string {
  let out = "";
  for (const run of runs) out += typeof run === "string" ? run : run.clipboard;
  return out;
}

function beforeChip(runs: readonly RichRun[], chipRun: number): RichPoint {
  const prev = chipRun - 1;
  const piece = prev >= 0 ? runs[prev] : undefined;
  return {
    run: Math.max(prev, 0),
    offset: typeof piece === "string" ? piece.length : 0,
  };
}

/**
 * Map (visualLine, visualCol) → a boundary {@link RichPoint}.
 * Never returns an offset inside a chip label.
 */
export function richPointAtCell(runs: readonly RichRun[], contentWidth: number, line: number, col: number): RichPoint {
  const display = displayOf(runs);
  const lines = visualDraftLines(display, contentWidth);
  if (lines.length === 0 || display.length === 0) return { run: 0, offset: 0 };

  const row = line >= lines.length ? lines.at(-1)! : lines[Math.max(0, line)]!;
  const targetCol = Math.max(0, col);

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let unit = 0;
  let colInLine = 0;
  let onRow = false;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const text = typeof run === "string" ? run : run.clipboard;
    const chip = typeof run !== "string";
    if (text.length === 0) continue;

    const runStart = unit;
    const runEnd = unit + text.length;
    unit = runEnd;
    if (runEnd <= row.start) continue;
    if (runStart >= row.end) break;
    onRow = true;

    const from = Math.max(0, row.start - runStart);
    const to = Math.min(text.length, row.end - runStart);
    const slice = text.slice(from, to);

    if (chip) {
      const cells = displayWidth(slice);
      const into = targetCol - colInLine;
      if (into < cells || (runEnd >= row.end && targetCol >= colInLine)) {
        // Tie (into * 2 === cells) lands before the chip.
        if (into * 2 <= cells) return beforeChip(runs, i);
        return { run: i + 1, offset: 0 };
      }
      colInLine += cells;
      continue;
    }

    let unitsIn = from;
    for (const seg of segmenter.segment(slice)) {
      const segWidth = displayWidth(seg.segment);
      if (targetCol <= colInLine || targetCol < colInLine + segWidth) {
        return { run: i, offset: unitsIn };
      }
      colInLine += segWidth;
      unitsIn += seg.segment.length;
    }
  }

  if (!onRow) return { run: 0, offset: 0 };
  const last = runs.at(-1);
  return {
    run: Math.max(0, runs.length - 1),
    offset: typeof last === "string" ? last.length : 0,
  };
}
