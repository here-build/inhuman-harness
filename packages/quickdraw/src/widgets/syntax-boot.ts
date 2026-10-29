/**
 * Render-only syntax boot. The only public-face widgets file that
 * touches widgets/internals/syntax.ts (and overlay-syntax, which is
 * that same highlighter).
 */
import { Text } from "./text.js";
import type { LayoutNode } from "../layout/index.js";
import { FgP } from "../lexicon/index.js";
import { displayWidth, splitAtWidth } from "../measure/index.js";
import {
  highlightCodeSync,
  isHighlighterReady,
  runsToStyle,
  setHighlightPolarity,
  warmHighlighter,
  type HighlightLine,
  type SyntaxPolarity,
  type TokenRun,
} from "./internals/syntax.js";

export function bootSyntax(polarity: SyntaxPolarity): Promise<void> {
  setHighlightPolarity(polarity);
  return warmHighlighter();
}

export type SyntaxPaintOpts = {
  key: string;
  width: number;
  lang?: string;
  theme?: string;
};

/**
 * One clipped highlighted line. Cold highlighter is plain `code` role.
 * Newlines flatten to spaces — identity rows are one line.
 * `runs` skips the highlighter (host tokenizer).
 */
export function SyntaxLine(code: string, opts: SyntaxPaintOpts & { runs?: TokenRun[] }): LayoutNode {
  const squeezed = code.replaceAll("\n", " ");
  const source =
    opts.runs ??
    (isHighlighterReady() && opts.lang
      ? (highlightCodeSync(squeezed, { lang: opts.lang, theme: opts.theme })[0] ?? [{ text: squeezed }])
      : [{ text: squeezed }]);
  const { runs, ellipsis } = clipRuns(source, Math.max(1, opts.width));
  const children = runNodes(runs, opts.key);
  if (ellipsis) {
    children.push(
      Text("…", {
        key: `${opts.key}:ellipsis`,
        whiteSpace: "nowrap",
        style: { role: "muted" },
      }),
    );
  }
  if (children.length === 0) {
    children.push(Text(" ", { key: `${opts.key}:empty`, whiteSpace: "nowrap" }));
  }
  return {
    type: "flex",
    key: opts.key,
    style: { direction: "row" },
    children,
  };
}

/**
 * Wrapped highlighted block. Hard newlines stay rows; long rows wrap.
 * `lines` skips the highlighter (host tokenizer).
 */
export function SyntaxBlock(code: string, opts: SyntaxPaintOpts & { lines?: HighlightLine[] }): LayoutNode {
  const hl =
    opts.lines ??
    (isHighlighterReady() && opts.lang
      ? highlightCodeSync(code, { lang: opts.lang, theme: opts.theme })
      : code.split("\n").map((line) => [{ text: line }]));
  const width = Math.max(1, opts.width);
  const children: LayoutNode[] = [];
  for (const [i, line] of hl.entries()) {
    const source = line.length > 0 ? line : [{ text: "" }];
    const wrapped = wrapRuns(source, width);
    for (const [j, piece] of wrapped.entries()) {
      const key = `${opts.key}:${i}:${j}`;
      const row = runNodes(piece, key);
      children.push({
        type: "flex",
        key,
        style: { direction: "row" },
        children: row.length > 0 ? row : [Text(" ", { key: `${key}:empty`, whiteSpace: "nowrap" })],
      });
    }
  }
  if (children.length === 0) {
    children.push(Text(" ", { key: `${opts.key}:empty`, whiteSpace: "nowrap" }));
  }
  return {
    type: "flex",
    key: opts.key,
    style: { direction: "column", width },
    children,
  };
}

function runNodes(runs: TokenRun[], key: string): LayoutNode[] {
  return runs.map((run, i) => {
    const style = runsToStyle(run);
    return Text(run.text.length > 0 ? run.text : " ", {
      key: `${key}:${i}`,
      whiteSpace: "nowrap",
      style: {
        role: "code",
        prominence: FgP.secondary,
        ...style,
      },
    });
  });
}

function copyRun(run: TokenRun, text: string): TokenRun {
  const next: TokenRun = { text };
  if (run.color) next.color = run.color;
  if (run.bold) next.bold = true;
  if (run.italic) next.italic = true;
  return next;
}

function wrapRuns(runs: TokenRun[], width: number): TokenRun[][] {
  const rows: TokenRun[][] = [];
  let row: TokenRun[] = [];
  let used = 0;
  const flush = (): void => {
    rows.push(row);
    row = [];
    used = 0;
  };
  for (const run of runs) {
    let rest = run.text;
    if (rest.length === 0 && row.length === 0) continue;
    while (rest.length > 0) {
      const room = width - used;
      if (room <= 0) {
        flush();
        continue;
      }
      const w = displayWidth(rest);
      if (w <= room) {
        row.push(copyRun(run, rest));
        used += w;
        rest = "";
        continue;
      }
      const [head, tail] = splitAtWidth(rest, room);
      if (head.length === 0) {
        if (used === 0) {
          const [one, more] = splitAtWidth(rest, Math.max(1, width));
          if (one.length > 0) row.push(copyRun(run, one));
          flush();
          rest = more;
        } else {
          flush();
        }
        continue;
      }
      row.push(copyRun(run, head));
      flush();
      rest = tail;
    }
  }
  if (row.length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

function clipRuns(runs: TokenRun[], width: number): { runs: TokenRun[]; ellipsis: boolean } {
  const out: TokenRun[] = [];
  let used = 0;
  for (const run of runs) {
    const w = displayWidth(run.text);
    if (used + w <= width) {
      if (run.text.length > 0) out.push(run);
      used += w;
      continue;
    }
    const room = width - used;
    if (room <= 1) return { runs: out, ellipsis: true };
    const [head] = splitAtWidth(run.text, room - 1);
    if (head.length > 0) {
      const piece: TokenRun = { text: head };
      if (run.color) piece.color = run.color;
      if (run.bold) piece.bold = true;
      if (run.italic) piece.italic = true;
      out.push(piece);
    }
    return { runs: out, ellipsis: true };
  }
  return { runs: out, ellipsis: false };
}
