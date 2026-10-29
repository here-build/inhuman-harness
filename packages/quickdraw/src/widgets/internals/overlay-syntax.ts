/**
 * Syntax-colored overlay rows for a chrome_frame stack (shell ask).
 * Same T-join chrome as paintOverlayLines; tokens ride fgRgb + role `code`.
 * Null when the highlighter is cold or the lang paints as plain — callers
 * keep the muted overlay.
 */
import { wrapText } from "../../layout/text.js";
import { FgP, type Rgb } from "../../lexicon/index.js";
import { thumbCoverage } from "../composer-picker.js";
import { highlightCodeSync, isHighlighterReady, runsToStyle, type TokenRun } from "./syntax.js";

export type OverlaySyntaxPaint = {
  readonly bodySegRows: Array<
    Array<{
      text: string;
      role?: string;
      prominence?: number;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      href?: string;
      fgRgb?: Rgb;
    }>
  >;
  readonly bodyGlyphs: string[];
  readonly bodyRightCoverage: number[];
  readonly lineCount: number;
};

const DEFAULT_TEXT_W = 40;

export function paintSyntaxOverlayLines(input: {
  readonly text: string;
  readonly lang: string;
  readonly scrollOffset: number;
  readonly viewport: number;
  readonly textW?: number;
}): OverlaySyntaxPaint | null {
  if (!isHighlighterReady() || input.lang.trim() === "") return null;
  const hl = highlightCodeSync(input.text.replace(/\n$/, ""), { lang: input.lang });
  if (!hl.some((line) => line.some((run) => run.color || run.bold || run.italic))) {
    return null;
  }
  const textW = input.textW ?? DEFAULT_TEXT_W;
  const rows: OverlaySyntaxPaint["bodySegRows"] = [];
  for (const line of hl) {
    for (const wrapped of wrapRuns(line, textW)) {
      const segs = wrapped.map(runToSeg);
      rows.push(segs.length > 0 ? segs : [{ text: " ", role: "code", prominence: FgP.secondary }]);
    }
  }
  const n = rows.length;
  const viewport = input.viewport <= 0 ? Math.max(1, n) : Math.max(1, Math.min(n, input.viewport));
  const maxS = Math.max(0, n - viewport);
  const scroll = Math.min(maxS, Math.max(0, input.scrollOffset));
  const visible = n <= viewport ? rows : rows.slice(scroll, scroll + viewport);
  return {
    bodySegRows: visible,
    bodyGlyphs: visible.map(() => " "),
    bodyRightCoverage: thumbCoverage(n, visible.length, scroll),
    lineCount: n,
  };
}

function runToSeg(run: TokenRun): OverlaySyntaxPaint["bodySegRows"][number][number] {
  const style = runsToStyle(run);
  return {
    text: run.text.length > 0 ? run.text : " ",
    role: "code",
    prominence: FgP.secondary,
    ...(style.fgRgb === undefined ? {} : { fgRgb: style.fgRgb }),
    ...(style.bold === true ? { bold: true } : {}),
    ...(style.italic === true ? { italic: true } : {}),
  };
}

function wrapRuns(runs: TokenRun[], width: number): TokenRun[][] {
  const text = runs.map((run) => run.text).join("");
  const lines = wrapText(text, { width: Math.max(1, width), whiteSpace: "pre-wrap" });
  const out: TokenRun[][] = [];
  let offset = 0;
  for (const line of lines) {
    out.push(sliceRuns(runs, offset, offset + line.length));
    offset += line.length;
  }
  return out.length > 0 ? out : [[]];
}

function sliceRuns(runs: TokenRun[], start: number, end: number): TokenRun[] {
  if (end <= start) return [];
  const out: TokenRun[] = [];
  let i = 0;
  for (const run of runs) {
    const pe = i + run.text.length;
    if (pe <= start) {
      i = pe;
      continue;
    }
    if (i >= end) break;
    const from = Math.max(0, start - i);
    const to = Math.min(run.text.length, end - i);
    if (to > from) {
      const piece: TokenRun = { text: run.text.slice(from, to) };
      if (run.color) piece.color = run.color;
      if (run.bold) piece.bold = true;
      if (run.italic) piece.italic = true;
      out.push(piece);
    }
    i = pe;
  }
  return out;
}
