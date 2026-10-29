/**
 * Widget-module diff projection for prepare() and storybook.
 * The terminal projection is expand_diff in packages/quickdraw/rust/qd.
 *
 * Structure: vendored pure-parse slice of @pierre/diffs@1.2.12
 *   (`./pierre-parse` — Apache-2.0, see that directory's NOTICE).
 * Intra-line (word-alt): diffWordsWithSpace from `diff` (same algo Pierre uses).
 * Syntax: ./syntax.js (sync after warmHighlighter).
 * Visual: add/del rows carry full-pane mist wash (empty cells of the
 * half, not just glyphs). Word-alt spans step to panel. Context / elision
 * occupy with transparent cast so overlay tape does not bleed, without a
 * slab. Line numbers, ▌ gutter.
 *
 * AUTO MODE. Split only when a hunk contains an edited cluster (a change
 * block with both deletions and additions). Pure addition / removal blocks
 * stay unified even when they fit a half-pane — a blank opposite side is
 * not a comparison. Given an edited cluster, split iff every *painted*
 * line (word-alt spans, not raw source; elided context omitted) fits one
 * split pane's code column at this `width`. Pane = floor((width − 1) / 2),
 * minus gutter + line-number digits + trailing space (same chrome
 * `makeRow` subtracts). Otherwise unified. A width-only cutoff (e.g. 88
 * cols) is rejected: it keeps a 20-column edit stacked at the 80-col TUI
 * default, and it splits a 200-column rewrite on a wide terminal.
 *
 * Deleted runs stay intact. Collapsing them to a first-entity "…" hides
 * the old state, and the keep-vs-omit cut has no stable grain.
 *
 * Missing final newline is not a painted edit (git still records it). An
 * extra blank line at EOF is a real line and still shows.
 *
 * PAINT FOLD. Two-file parse keeps both sides whole (`PARSE_CONTEXT`) so
 * shiki sees real source — a hunk-sliced join is not a file, and tokens
 * go wrong on any mid-file edit. Line numbers stay the hunk `@@` origins
 * (plus `lineStart` for a span). Display context is a later elision: keep
 * change-adjacent lines, emit `·· N unchanged ··` for the rest. Leading
 * context keeps its tail; trailing keeps its head; a run between edits
 * keeps both ends. `context: "all"` skips that elision. Rejected: feeding
 * `context` into `createTwoFilesPatch` — that cuts before highlight.
 *
 * No dependency on the published @pierre/diffs barrel (which loads browser
 * CodeView and touches navigator at import time).
 */

import { diffWordsWithSpace, type Change } from "diff";

import {
  parseDiffFromFile,
  parsePatchFiles,
  type FileDiffMetadata,
  type ContextContent,
  type ChangeContent,
} from "./pierre-parse/index.js";
import { highlightCodeSync, isHighlighterReady, runsToStyle, type HighlightLine } from "./syntax.js";
import type { Style } from "../../buffer/index.js";
import type { DiffLineRef, LayoutNode } from "../../layout/index.js";
import { BgP, FgP } from "../../lexicon/index.js";
import { displayWidth } from "../../measure/index.js";

export type DiffMode = "auto" | "unified" | "split";
export type LineDiffType = "word-alt" | "word" | "char" | "none";

export type DiffViewOpts = {
  old: string;
  new: string;
  path?: string;
  language?: string | null;
  mode?: DiffMode;
  width: number;
  /**
   * Paint-time elision: unchanged lines kept next to each change. Parse and
   * highlight always see both sides whole. `"all"` skips the elision.
   */
  context?: number | "all";
  key?: string;
  /** Pierre default: word-alt. */
  lineDiffType?: LineDiffType;
  /** Skip shiki even if warm (default false). */
  noHighlight?: boolean;
  /** Omit `path · proposed` header row (sticky approval already labels the file). */
  hideHeader?: boolean;
  /**
   * Ask Diff: pin this many body rows at each end and squeeze the middle
   * (`·· N lines omitted ··`). In-tape Diff omits this.
   */
  stickyBottomRows?: number;
  /**
   * 1-based file line of the first displayed row. Span diffs (`edit_file`
   * old/new) start at 1 of the span; pass the span's origin in the file.
   */
  lineStart?: number;
};

const DEFAULT_CONTEXT = 3;
/** jsdiff context large enough that a two-file parse is one whole-file hunk. */
const PARSE_CONTEXT = 1_000_000;
const GUTTER = "▌";
const MAX_LINE_DIFF_LEN = 1000;

/** ▌ + digits + trailing space — same chrome `makeRow` subtracts from `rowW`. */
function rowChromeWidth(numW: number): number {
  return 1 + numW + 1;
}

/** One split pane, including chrome. Gap of 1 between panes. */
function splitHalfWidth(width: number): number {
  return Math.max(8, Math.floor((width - 1) / 2));
}

function splitContentWidth(width: number, numW: number): number {
  return Math.max(1, splitHalfWidth(width) - rowChromeWidth(numW));
}

// ── theme styles ────────────────────────────────────────────────────────────
// Authoring intent only — resolveStyle (paint-time) turns role/bgRole into
// concrete color. No hex/rgb baked here (Post-audit "Single resolve API").

function chromeStyle(extra: Style = {}): Style {
  // chrome is already tier "recede"; FgP.ghost is the one prominence step
  // down from that — no separate dim authoring on top.
  return { role: "chrome", prominence: FgP.ghost, ...extra };
}

function headerStyle(): Style {
  return { role: "chrome", bold: true };
}

/** Row wash for a diff side — bgRole resolved via the BG ladder. */
function rowWashStyle(role: "diff_add" | "diff_del", emphasis?: boolean): Style {
  // mist = atmosphere toward ground (the OSI-transparent trick). wash sat
  // near the selection fill target, so selected-vs-row missed the JND.
  // panel stays the intra-line word-alt step.
  return { bgRole: role, bgProminence: emphasis ? BgP.panel : BgP.mist };
}

// ── content runs ────────────────────────────────────────────────────────────

export type SpanRun = {
  text: string;
  /** changed span (word-alt) */
  emphasis?: boolean;
  /** syntax color override */
  color?: string;
  bold?: boolean;
  italic?: boolean;
};

function stripNl(s: string): string {
  return s.replace(/\r?\n$/, "");
}

/** Paint: a missing final newline is not a line edit. Empty stays empty. */
function withTrailingNl(s: string): string {
  if (s.length === 0 || s.endsWith("\n")) return s;
  return `${s}\n`;
}

function elideLabel(n: number): string {
  return `·· ${n} unchanged ··`;
}

/**
 * Soft-wrap span runs to `width` display columns.
 * Newlines always break; long runs never clip — wrap mid-span by grapheme.
 */
function softWrapSpans(spans: SpanRun[], width: number): SpanRun[][] {
  const w = Math.max(1, width);
  type Cell = {
    ch: string;
    emphasis?: boolean;
    color?: string;
    bold?: boolean;
    italic?: boolean;
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const cells: Cell[] = [];
  for (const sp of spans) {
    const chunks = sp.text.split("\n");
    for (const [ci, chunk] of chunks.entries()) {
      if (ci > 0) cells.push({ ch: "\n" });
      for (const { segment } of segmenter.segment(chunk!)) {
        if (!segment) continue;
        cells.push({
          ch: segment,
          emphasis: sp.emphasis,
          color: sp.color,
          bold: sp.bold,
          italic: sp.italic,
        });
      }
    }
  }

  const rows: SpanRun[][] = [];
  let line: Cell[] = [];
  let lineW = 0;

  const flush = () => {
    rows.push(cellsToSpans(line));
    line = [];
    lineW = 0;
  };

  for (const c of cells) {
    if (c.ch === "\n") {
      flush();
      continue;
    }
    const cw = Math.max(0, displayWidth(c.ch));
    if (cw === 0) {
      line.push(c);
      continue;
    }
    if (lineW + cw > w && line.length > 0) flush();
    // single wide grapheme wider than w: still emit (better than drop)
    line.push(c);
    lineW += cw;
  }
  if (line.length > 0 || rows.length === 0) flush();
  return rows;
}

function cellsToSpans(
  cells: {
    ch: string;
    emphasis?: boolean;
    color?: string;
    bold?: boolean;
    italic?: boolean;
  }[],
): SpanRun[] {
  if (cells.length === 0) return [{ text: " " }];
  const out: SpanRun[] = [];
  let cur: SpanRun | null = null;
  for (const c of cells) {
    if (
      cur &&
      !!cur.emphasis === !!c.emphasis &&
      cur.color === c.color &&
      !!cur.bold === !!c.bold &&
      !!cur.italic === !!c.italic
    ) {
      cur.text += c.ch;
    } else {
      if (cur) out.push(cur);
      cur = {
        text: c.ch,
        emphasis: c.emphasis,
        color: c.color,
        bold: c.bold,
        italic: c.italic,
      };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Pierre word-alt: diffWordsWithSpace + join adjacent changed clusters.
 * Mirrors computeLineDiffDecorations in @pierre/diffs.
 */
function wordAltSpans(oldLine: string, newLine: string, side: "del" | "add"): SpanRun[] {
  if (oldLine.length > MAX_LINE_DIFF_LEN || newLine.length > MAX_LINE_DIFF_LEN) {
    return [
      {
        text: side === "del" ? oldLine : newLine,
        emphasis: true as const,
      },
    ];
  }
  const parts: Change[] = diffWordsWithSpace(oldLine, newLine);
  // word-alt: join adjacent same-polarity changed items separated by single space
  const joined: Change[] = [];
  for (const item of parts) {
    const last = joined.at(-1);
    if (
      last &&
      item.added === last.added &&
      item.removed === last.removed &&
      (item.added || item.removed) &&
      last.value.endsWith(" ") === false &&
      item.value.startsWith(" ") === false
    ) {
      // fuse adjacent changed words (Pierre enableJoin)
      last.value += item.value;
      last.count = (last.count ?? 0) + (item.count ?? 0);
    } else if (
      last &&
      item.added === last.added &&
      item.removed === last.removed &&
      (item.added || item.removed) &&
      last.value.endsWith(" ") &&
      !item.value.startsWith(" ")
    ) {
      last.value += item.value;
    } else {
      joined.push({ ...item });
    }
  }

  const out: SpanRun[] = [];
  for (const item of joined) {
    if (side === "del") {
      if (item.added) continue;
      out.push({ text: item.value, emphasis: !!item.removed });
    } else {
      if (item.removed) continue;
      out.push({ text: item.value, emphasis: !!item.added });
    }
  }
  return out.length > 0 ? out : [{ text: side === "del" ? oldLine : newLine }];
}

/** Overlay syntax tokens onto word-alt spans (fg from shiki, bg from emphasis). */
function composeHighlight(spans: SpanRun[], hlLine: HighlightLine | undefined): SpanRun[] {
  if (!hlLine || hlLine.length === 0) return spans;
  // Flatten highlight to character colors, then re-slice by span boundaries
  const chars: { color?: string; bold?: boolean; italic?: boolean }[] = [];
  for (const run of hlLine) {
    for (let i = 0; i < run.text.length; i++) {
      chars.push({
        color: run.color,
        bold: run.bold,
        italic: run.italic,
      });
    }
  }
  let offset = 0;
  const out: SpanRun[] = [];
  for (const span of spans) {
    let i = 0;
    while (i < span.text.length) {
      const base = chars[offset + i] ?? {};
      let j = i + 1;
      while (
        j < span.text.length &&
        chars[offset + j]?.color === base.color &&
        chars[offset + j]?.bold === base.bold &&
        chars[offset + j]?.italic === base.italic
      ) {
        j++;
      }
      out.push({
        text: span.text.slice(i, j),
        emphasis: span.emphasis,
        color: base.color,
        bold: base.bold,
        italic: base.italic,
      });
      i = j;
    }
    offset += span.text.length;
  }
  return out;
}

function spanStyle(span: SpanRun, kind: "add" | "del" | "ctx"): Style {
  if (kind === "ctx") {
    // Context CODE is voice, not furniture: recede one prominence step, don't
    // crush to chrome/ghost — ghost turns tokens to mud. Line numbers and
    // elision rows stay chromeStyle.
    const st: Style = { role: "foreground", prominence: FgP.secondary };
    if (span.color) {
      // Token RGB is hue/chroma; resolver recasts AL onto this role.
      const rgb = runsToStyle({ text: "", color: span.color }).fgRgb;
      if (rgb) st.fgRgb = rgb;
    }
    if (span.bold) st.bold = true;
    if (span.italic) st.italic = true;
    return st;
  }
  const role = kind === "add" ? "diff_add" : "diff_del";
  const st: Style = {
    role,
    ...rowWashStyle(role, span.emphasis),
  };
  if (span.color) {
    // Token RGB is hue/chroma; resolver recasts AL onto this role.
    const rgb = runsToStyle({ text: "", color: span.color }).fgRgb;
    if (rgb) st.fgRgb = rgb;
  }
  if (span.bold) st.bold = true;
  if (span.italic) st.italic = true;
  return st;
}

// ── row layout: full-width wash box ─────────────────────────────────────────

type LineKind = "add" | "del" | "ctx" | "blank";

function padNum(n: number | null, width: number): string {
  if (n === null || n <= 0) return " ".repeat(Math.max(0, width));
  const s = String(n);
  return s.length >= width ? s : s.padStart(width, " ");
}

function maxPaintedLineNo(lines: Array<BuiltLine | { elided: number }>): number {
  let best = 1;
  for (const item of lines) {
    if ("elided" in item) continue;
    if (item.oldNo != null && item.oldNo > best) best = item.oldNo;
    if (item.newNo != null && item.newNo > best) best = item.newNo;
  }
  return best;
}

/**
 * Full-width washed row(s): soft-wrap code spans (newlines + width).
 * Never clip mid-line with nowrap overflow.
 *
 * Selection: gutter/nums are chrome (`userSelect: none`); code spans are
 * `"text"`. Optional {@link DiffLineRef} stamps the logical git line onto
 * descendants for copy (full source text, not painted wrap).
 */
function makeRow(opts: {
  kind: LineKind;
  spans: SpanRun[];
  key: string;
  rowW: number;
  oldNo: number | null;
  newNo: number | null;
  numW: number;
  /** Logical line for selection copy / split mirror. Omit for blank halves. */
  diffLine?: DiffLineRef;
}): LayoutNode {
  const { kind, spans, key, rowW, oldNo, newNo, numW, diffLine } = opts;
  const wash: Style | undefined =
    kind === "add" ? rowWashStyle("diff_add") : kind === "del" ? rowWashStyle("diff_del") : undefined;

  const gutterChar = kind === "add" || kind === "del" ? GUTTER : " ";
  const gutterStyle: Style =
    kind === "add" ? { role: "diff_add", ...wash } : kind === "del" ? { role: "diff_del", ...wash } : chromeStyle(wash);

  let numText: string;
  switch (kind) {
    case "del": {
      numText = `${padNum(oldNo, numW)} `;
      break;
    }
    case "add": {
      numText = `${padNum(newNo, numW)} `;
      break;
    }
    case "ctx": {
      numText = `${padNum(oldNo ?? newNo, numW)} `;
      break;
    }
    default:
      numText = `${" ".repeat(numW)} `;
  }

  const prefixW = rowChromeWidth(numW);
  const contentW = Math.max(1, rowW - prefixW);
  const wrapped = spans.length === 0 ? [[{ text: " " } as SpanRun]] : softWrapSpans(spans, contentW);

  const lineNodes: LayoutNode[] = wrapped.map((lineSpans, li) => {
    const kids: LayoutNode[] = [
      {
        type: "text",
        key: `${key}:g${li}`,
        content: li === 0 ? gutterChar : " ",
        whiteSpace: "nowrap",
        userSelect: "none",
        style: gutterStyle,
      },
      {
        type: "text",
        key: `${key}:n${li}`,
        content: li === 0 ? numText : " ".repeat(numText.length),
        whiteSpace: "nowrap",
        userSelect: "none",
        style: chromeStyle(wash),
      },
    ];
    for (const [i, sp] of lineSpans.entries()) {
      kids.push({
        type: "text",
        key: `${key}:t${li}_${i}`,
        content: sp.text.length > 0 ? sp.text : " ",
        whiteSpace: "nowrap",
        userSelect: kind === "blank" ? "none" : "text",
        style: spanStyle(sp, kind === "blank" ? "ctx" : kind),
      });
    }
    return {
      type: "flex",
      key: `${key}:row${li}`,
      style: { direction: "row", gap: 0, width: rowW },
      paintReady: true,
      measured: { w: rowW, h: 1, atW: rowW },
      children: kids,
    };
  });

  return {
    type: "box",
    key,
    // Structure is chrome — only `:t` code spans are selectable content.
    // If the box is `"text"`, free-path selection paints trailing empty cells
    // across the half (and the gap to the partner half in split).
    userSelect: "none",
    diffLine,
    paintReady: true,
    measured: { w: rowW, h: lineNodes.length, atW: rowW },
    style: {
      width: rowW,
      background: wash ?? { cast: "transparent" },
      overflow: "hidden",
    },
    children: lineNodes,
  };
}

function elideRow(n: number, key: string, rowW: number): LayoutNode {
  return {
    type: "box",
    key,
    userSelect: "none",
    style: { width: rowW, height: 1, background: { cast: "transparent" } },
    children: [
      {
        type: "text",
        key: `${key}:c`,
        content: elideLabel(n),
        userSelect: "none",
        style: chromeStyle(),
      },
    ],
  };
}

function diffStamp(
  diffKey: string,
  lineIndex: number,
  kind: "ctx" | "del" | "add",
  text: string,
  opts?: {
    side?: "L" | "R";
    oldNo?: number | null;
    newNo?: number | null;
  },
): DiffLineRef {
  return {
    diffKey,
    lineIndex,
    kind,
    text,
    side: opts?.side,
    oldNo: opts?.oldNo ?? null,
    newNo: opts?.newNo ?? null,
  };
}

// ── line number tracking + word-alt pairing ─────────────────────────────────

type BuiltLine = {
  kind: LineKind;
  spans: SpanRun[];
  oldNo: number | null;
  newNo: number | null;
  /** Full source line for selection copy. */
  rawText?: string;
};

function maxPaintedLineWidth(lines: Array<BuiltLine | { elided: number }>): number {
  let best = 0;
  for (const item of lines) {
    if ("elided" in item) continue;
    best = Math.max(best, displayWidth(item.spans.map((s) => s.text).join("")));
  }
  return best;
}

function hasEditedCluster(meta: FileDiffMetadata): boolean {
  for (const hunk of meta.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type === "change" && block.deletions > 0 && block.additions > 0) return true;
    }
  }
  return false;
}

function resolveDiffMode(
  mode: DiffMode,
  width: number,
  meta: FileDiffMetadata,
  lines: Array<BuiltLine | { elided: number }>,
): "unified" | "split" {
  if (mode !== "auto") return mode;
  // No in-place replacement: split would be a blank half next to pure add/del.
  if (!hasEditedCluster(meta)) return "unified";
  const numW = String(maxLineNo(meta)).length;
  return maxPaintedLineWidth(lines) <= splitContentWidth(width, numW) ? "split" : "unified";
}

type ContextEdge = "leading" | "middle" | "trailing";

function contextBlockEdge(blocks: readonly (ContextContent | ChangeContent)[], index: number): ContextEdge {
  let changeBefore = false;
  let changeAfter = false;
  for (const [i, block] of blocks.entries()) {
    if (block!.type !== "change") continue;
    if (i < index) changeBefore = true;
    if (i > index) changeAfter = true;
  }
  if (changeBefore && changeAfter) return "middle";
  if (!changeBefore && changeAfter) return "leading";
  if (changeBefore && !changeAfter) return "trailing";
  return "middle";
}

function elideContextIndices(
  count: number,
  ctx: number | "all",
  edge: ContextEdge,
): Array<{ kind: "line"; i: number } | { kind: "elide"; n: number }> {
  if (ctx === "all" || count === 0) {
    return Array.from({ length: count }, (_, i) => ({ kind: "line" as const, i }));
  }
  const all = (): Array<{ kind: "line"; i: number }> =>
    Array.from({ length: count }, (_, i) => ({ kind: "line" as const, i }));
  if (edge === "leading") {
    if (count <= ctx) return all();
    const keepFrom = count - ctx;
    return [
      { kind: "elide", n: keepFrom },
      ...Array.from({ length: ctx }, (_, i) => ({ kind: "line" as const, i: keepFrom + i })),
    ];
  }
  if (edge === "trailing") {
    if (count <= ctx) return all();
    return [
      ...Array.from({ length: ctx }, (_, i) => ({ kind: "line" as const, i })),
      { kind: "elide", n: count - ctx },
    ];
  }
  if (count <= ctx * 2 + 1) return all();
  const out: Array<{ kind: "line"; i: number } | { kind: "elide"; n: number }> = [];
  for (let i = 0; i < ctx; i++) out.push({ kind: "line", i });
  const mid = count - ctx * 2;
  if (mid > 0) out.push({ kind: "elide", n: mid });
  for (let i = count - ctx; i < count; i++) out.push({ kind: "line", i });
  return out;
}

type HlPick = (side: "add" | "del", fileLine: number | null, compactIdx: number) => HighlightLine | undefined;

function buildLines(
  meta: FileDiffMetadata,
  ctx: number | "all",
  lineDiffType: LineDiffType,
  hl: HlPick,
): Array<BuiltLine | { elided: number }> {
  const out: Array<BuiltLine | { elided: number }> = [];
  // Display line numbers are REAL 1-based file lines, not array indices.
  // `additionLines`/`deletionLines` are compact (only diff-touched + context
  // lines), so array index + 1 is wrong whenever a hunk starts past file
  // line 1. Instead, seed a per-side file-line cursor from each hunk's
  // `deletionStart` (old side) / `additionStart` (new side) — the 1-based
  // line from the `@@ -X,X +X,X @@` header — and advance it as we emit rows.

  for (let hi = 0; hi < meta.hunks.length; hi++) {
    const hunk = meta.hunks[hi]!;
    if (hunk.collapsedBefore > 0) {
      out.push({ elided: hunk.collapsedBefore });
    }
    let oldCursor = hunk.deletionStart;
    let newCursor = hunk.additionStart;
    for (const [bi, block] of hunk.hunkContent.entries()) {
      if (block.type === "context") {
        const b = block as ContextContent;
        for (const p of elideContextIndices(b.lines, ctx, contextBlockEdge(hunk.hunkContent, bi))) {
          if (p.kind === "elide") {
            // Folded lines still consume file lines on both sides even
            // though we don't render them; the cursors are advanced in
            // bulk after the loop via `+= b.lines`.
            out.push({ elided: p.n });
            continue;
          }
          const aIdx = b.additionLineIndex + p.i;
          const dIdx = b.deletionLineIndex + p.i;
          const oldNo = oldCursor + p.i;
          const newNo = newCursor + p.i;
          const text = stripNl(
            aIdx < meta.additionLines.length ? (meta.additionLines[aIdx] ?? "") : (meta.deletionLines[dIdx] ?? ""),
          );
          let spans: SpanRun[] = [{ text }];
          const tokens = aIdx < meta.additionLines.length ? hl("add", newNo, aIdx) : hl("del", oldNo, dIdx);
          if (tokens) spans = composeHighlight(spans, tokens);
          out.push({
            kind: "ctx",
            spans,
            oldNo,
            newNo,
            rawText: text,
          });
        }
        oldCursor += b.lines;
        newCursor += b.lines;
      } else {
        const b = block as ChangeContent;
        const delN = b.deletions;
        const addN = b.additions;
        // Pair min(del,add) for word-alt; remainder pure add/del
        const paired = lineDiffType === "none" ? 0 : Math.min(delN, addN);
        for (let i = 0; i < delN; i++) {
          const dIdx = b.deletionLineIndex + i;
          const dText = stripNl(meta.deletionLines[dIdx] ?? "");
          let spans: SpanRun[];
          if (i < paired) {
            const aIdx = b.additionLineIndex + i;
            const aText = stripNl(meta.additionLines[aIdx] ?? "");
            spans = wordAltSpans(dText, aText, "del");
          } else {
            spans = [{ text: dText, emphasis: true }];
          }
          const oldNo = oldCursor + i;
          spans = composeHighlight(spans, hl("del", oldNo, dIdx));
          out.push({
            kind: "del",
            spans,
            oldNo,
            newNo: null,
            rawText: dText,
          });
        }
        for (let i = 0; i < addN; i++) {
          const aIdx = b.additionLineIndex + i;
          const aText = stripNl(meta.additionLines[aIdx] ?? "");
          let spans: SpanRun[];
          if (i < paired) {
            const dIdx = b.deletionLineIndex + i;
            const dText = stripNl(meta.deletionLines[dIdx] ?? "");
            spans = wordAltSpans(dText, aText, "add");
          } else {
            spans = [{ text: aText, emphasis: true }];
          }
          const newNo = newCursor + i;
          spans = composeHighlight(spans, hl("add", newNo, aIdx));
          out.push({
            kind: "add",
            spans,
            oldNo: null,
            newNo,
            rawText: aText,
          });
        }
        oldCursor += delN;
        newCursor += addN;
      }
    }
  }
  return out;
}

function projectUnified(
  lines: Array<BuiltLine | { elided: number }>,
  rowW: number,
  numW: number,
  keyBase: string,
): LayoutNode[] {
  const rows: LayoutNode[] = [];
  let ri = 0;
  let lineIndex = 0;
  for (const item of lines) {
    if ("elided" in item) {
      rows.push(elideRow(item.elided, `${keyBase}:f${ri++}`, rowW));
      continue;
    }
    const fullText = item.spans.map((s) => s.text).join("");
    const stampKind = item.kind === "blank" ? null : (item.kind as "ctx" | "del" | "add");
    rows.push(
      makeRow({
        kind: item.kind,
        spans: item.spans,
        key: `${keyBase}:u${ri++}`,
        rowW,
        oldNo: item.oldNo,
        newNo: item.newNo,
        numW,
        diffLine: stampKind
          ? diffStamp(keyBase, lineIndex++, stampKind, item.rawText ?? fullText, {
              oldNo: item.oldNo,
              newNo: item.newNo,
            })
          : undefined,
      }),
    );
  }
  return rows;
}

function projectSplit(
  meta: FileDiffMetadata,
  ctx: number | "all",
  lineDiffType: LineDiffType,
  hl: HlPick,
  width: number,
  numW: number,
  keyBase: string,
): LayoutNode[] {
  // Build paired visual rows for split (left=old, right=new)
  const halfW = splitHalfWidth(width);
  const rows: LayoutNode[] = [];
  let ri = 0;
  // Git emission order (all dels then all adds per change block), NOT visual
  // interleave — so copy never emits -+-+.
  let lineIndex = 0;

  const leftLine = (
    kind: LineKind,
    spans: SpanRun[],
    oldNo: number | null,
    key: string,
    diffLine?: DiffLineRef,
  ): LayoutNode =>
    makeRow({
      kind,
      spans,
      key,
      rowW: halfW,
      oldNo,
      newNo: null,
      numW,
      diffLine,
    });

  const rightLine = (
    kind: LineKind,
    spans: SpanRun[],
    newNo: number | null,
    key: string,
    diffLine?: DiffLineRef,
  ): LayoutNode =>
    makeRow({
      kind,
      spans,
      key,
      rowW: halfW,
      oldNo: null,
      newNo,
      numW,
      diffLine,
    });

  const blankHalf = (key: string): LayoutNode =>
    makeRow({
      kind: "blank",
      spans: [{ text: " " }],
      key,
      rowW: halfW,
      oldNo: null,
      newNo: null,
      numW,
    });

  for (let hi = 0; hi < meta.hunks.length; hi++) {
    const hunk = meta.hunks[hi]!;
    if (hunk.collapsedBefore > 0) {
      rows.push(elideRow(hunk.collapsedBefore, `${keyBase}:sf${ri++}`, width));
    }
    // Display line numbers are REAL 1-based file lines derived from the
    // hunk's `deletionStart` (left/old) / `additionStart` (right/new), not
    // array indices into the compact per-side arrays. Advance per side.
    let oldCursor = hunk.deletionStart;
    let newCursor = hunk.additionStart;
    for (const [bi, block] of hunk.hunkContent.entries()) {
      if (block.type === "context") {
        const b = block as ContextContent;
        for (const p of elideContextIndices(b.lines, ctx, contextBlockEdge(hunk.hunkContent, bi))) {
          if (p.kind === "elide") {
            rows.push(elideRow(p.n, `${keyBase}:sf${ri++}`, width));
            continue;
          }
          const aIdx = b.additionLineIndex + p.i;
          const dIdx = b.deletionLineIndex + p.i;
          const oldNo = oldCursor + p.i;
          const newNo = newCursor + p.i;
          const lText = stripNl(meta.deletionLines[dIdx] ?? meta.additionLines[aIdx] ?? "");
          const rText = stripNl(meta.additionLines[aIdx] ?? meta.deletionLines[dIdx] ?? "");
          let lSpans: SpanRun[] = [{ text: lText }];
          let rSpans: SpanRun[] = [{ text: rText }];
          lSpans = composeHighlight(lSpans, hl("del", oldNo, dIdx) ?? hl("add", newNo, aIdx));
          rSpans = composeHighlight(rSpans, hl("add", newNo, aIdx) ?? hl("del", oldNo, dIdx));
          // Shared lineIndex: both halves are one git ` ` line (copy dedup + mirror).
          const li = lineIndex++;
          rows.push({
            type: "flex",
            key: `${keyBase}:s${ri}`,
            style: { direction: "row", gap: 1, width },
            children: [
              leftLine(
                "ctx",
                lSpans,
                oldNo,
                `${keyBase}:s${ri}:L`,
                diffStamp(keyBase, li, "ctx", lText, {
                  side: "L",
                  oldNo,
                  newNo,
                }),
              ),
              rightLine(
                "ctx",
                rSpans,
                newNo,
                `${keyBase}:s${ri}:R`,
                diffStamp(keyBase, li, "ctx", rText, {
                  side: "R",
                  oldNo,
                  newNo,
                }),
              ),
            ],
          });
          ri++;
        }
        oldCursor += b.lines;
        newCursor += b.lines;
      } else {
        const b = block as ChangeContent;
        const paired = lineDiffType === "none" ? 0 : Math.min(b.deletions, b.additions);
        const n = Math.max(b.deletions, b.additions);
        // Pre-assign git lineIndex: dels first, then adds (unified order).
        const delBase = lineIndex;
        const addBase = lineIndex + b.deletions;
        lineIndex += b.deletions + b.additions;
        for (let i = 0; i < n; i++) {
          let left: LayoutNode;
          let right: LayoutNode;
          if (i < b.deletions) {
            const dIdx = b.deletionLineIndex + i;
            const dText = stripNl(meta.deletionLines[dIdx] ?? "");
            let spans: SpanRun[];
            if (i < paired) {
              const aText = stripNl(meta.additionLines[b.additionLineIndex + i] ?? "");
              spans = wordAltSpans(dText, aText, "del");
            } else {
              spans = [{ text: dText, emphasis: true }];
            }
            spans = composeHighlight(spans, hl("del", oldCursor + i, dIdx));
            left = leftLine(
              "del",
              spans,
              oldCursor + i,
              `${keyBase}:s${ri}:L`,
              diffStamp(keyBase, delBase + i, "del", dText, {
                side: "L",
                oldNo: oldCursor + i,
                newNo: null,
              }),
            );
          } else {
            left = blankHalf(`${keyBase}:s${ri}:L`);
          }
          if (i < b.additions) {
            const aIdx = b.additionLineIndex + i;
            const aText = stripNl(meta.additionLines[aIdx] ?? "");
            let spans: SpanRun[];
            if (i < paired) {
              const dText = stripNl(meta.deletionLines[b.deletionLineIndex + i] ?? "");
              spans = wordAltSpans(dText, aText, "add");
            } else {
              spans = [{ text: aText, emphasis: true }];
            }
            spans = composeHighlight(spans, hl("add", newCursor + i, aIdx));
            right = rightLine(
              "add",
              spans,
              newCursor + i,
              `${keyBase}:s${ri}:R`,
              diffStamp(keyBase, addBase + i, "add", aText, {
                side: "R",
                oldNo: null,
                newNo: newCursor + i,
              }),
            );
          } else {
            right = blankHalf(`${keyBase}:s${ri}:R`);
          }
          rows.push({
            type: "flex",
            key: `${keyBase}:s${ri}`,
            style: { direction: "row", gap: 1, width },
            children: [left, right],
          });
          ri++;
        }
        oldCursor += b.deletions;
        newCursor += b.additions;
      }
    }
  }
  return rows;
}

function langFromPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return undefined;
  switch (path.slice(dot + 1).toLowerCase()) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "scm":
      return "scm";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "sh":
      return "bash";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "toml";
    default:
      return undefined;
  }
}

function highlightLang(language: string | null | undefined): string | undefined {
  if (!language) return undefined;
  if (language === "ts" || language === "mts" || language === "cts") return "typescript";
  if (language === "js" || language === "mjs" || language === "cjs") return "javascript";
  if (language === "scheme" || language === "arrival") return "scm";
  return language;
}

/** Drop the terminator so shiki line count matches painted file lines. */
function sourceForHighlight(code: string): string {
  const body = withTrailingNl(code);
  return body.endsWith("\n") ? body.slice(0, -1) : body;
}

function highlightCode(
  code: string,
  language: string | null | undefined,
  noHighlight?: boolean,
): HighlightLine[] | null {
  const lang = highlightLang(language);
  if (noHighlight || !lang || !isHighlighterReady() || code.length === 0) return null;
  try {
    return highlightCodeSync(sourceForHighlight(code), { lang });
  } catch {
    return null;
  }
}

function highlightSides(
  meta: FileDiffMetadata,
  language: string | null | undefined,
  noHighlight?: boolean,
): { hlAdd: HighlightLine[] | null; hlDel: HighlightLine[] | null } {
  if (noHighlight || !language || !isHighlighterReady()) {
    return { hlAdd: null, hlDel: null };
  }
  const lang = highlightLang(language);
  try {
    const addCode = meta.additionLines.map(stripNl).join("\n");
    const delCode = meta.deletionLines.map(stripNl).join("\n");
    return {
      hlAdd: meta.additionLines.length > 0 ? highlightCodeSync(addCode, { lang }) : null,
      hlDel: meta.deletionLines.length > 0 ? highlightCodeSync(delCode, { lang }) : null,
    };
  } catch {
    return { hlAdd: null, hlDel: null };
  }
}

function hlPickFromSides(
  hlAdd: HighlightLine[] | null,
  hlDel: HighlightLine[] | null,
  fileIndexed: boolean,
  lineOrigin: number,
): HlPick {
  return (side, fileLine, compactIdx) => {
    const lines = side === "add" ? hlAdd : hlDel;
    if (!lines) return undefined;
    if (fileIndexed) {
      if (fileLine == null) return undefined;
      const i = fileLine - lineOrigin;
      return i >= 0 ? lines[i] : undefined;
    }
    return lines[compactIdx];
  };
}

function maxLineNo(meta: FileDiffMetadata): number {
  // Highest display line number = the true largest file line across hunks.
  // Walk each hunk the same way the renderers do: seed per-side file-line
  // cursors from `deletionStart`/`additionStart` and advance through blocks.
  // Falls back to array length when there are no hunks (defensive).
  let best = Math.max(meta.additionLines.length, meta.deletionLines.length, 1);
  for (const hunk of meta.hunks) {
    let oldCursor = hunk.deletionStart;
    let newCursor = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        const b = block as ContextContent;
        oldCursor += b.lines;
        newCursor += b.lines;
      } else {
        const b = block as ChangeContent;
        oldCursor += b.deletions;
        newCursor += b.additions;
      }
    }
    // cursors now point one past the last line; the last line number is cursor-1
    if (oldCursor - 1 > best) best = oldCursor - 1;
    if (newCursor - 1 > best) best = newCursor - 1;
  }
  return Math.max(best, 1);
}

function projectMeta(
  meta: FileDiffMetadata,
  opts: {
    mode: DiffMode;
    width: number;
    context: number | "all";
    key: string;
    path: string;
    lineDiffType: LineDiffType;
    language?: string | null;
    noHighlight?: boolean;
    hideHeader?: boolean;
    stickyBottomRows?: number;
    sourceOld?: string;
    sourceNew?: string;
    lineOrigin?: number;
  },
): LayoutNode {
  const language = opts.language ?? meta.lang ?? langFromPath(opts.path);
  const fileIndexed = opts.sourceOld !== undefined || opts.sourceNew !== undefined;
  const sides = fileIndexed
    ? {
        hlAdd: highlightCode(opts.sourceNew ?? "", language, opts.noHighlight),
        hlDel: highlightCode(opts.sourceOld ?? "", language, opts.noHighlight),
      }
    : highlightSides(meta, language, opts.noHighlight);
  const hl = hlPickFromSides(sides.hlAdd, sides.hlDel, fileIndexed, opts.lineOrigin ?? 1);
  const header: LayoutNode = {
    type: "text",
    key: `${opts.key}:hdr`,
    content: `${opts.path} · proposed`,
    userSelect: "none",
    style: headerStyle(),
  };

  let body: LayoutNode[];
  if (meta.hunks.length === 0) {
    body = [
      {
        type: "text",
        key: `${opts.key}:empty`,
        content: meta.additionLines.length === 0 && meta.deletionLines.length === 0 ? "(empty)" : "no changes",
        style: chromeStyle(),
      },
    ];
  } else {
    const lines = buildLines(meta, opts.context, opts.lineDiffType, hl);
    const numW = String(Math.max(maxLineNo(meta), maxPaintedLineNo(lines))).length;
    const mode = resolveDiffMode(opts.mode, opts.width, meta, lines);
    body =
      mode === "split"
        ? projectSplit(meta, opts.context, opts.lineDiffType, hl, opts.width, numW, opts.key)
        : projectUnified(lines, opts.width, numW, opts.key);
  }

  const squeezeN = Math.max(0, Math.floor(opts.stickyBottomRows ?? 0));
  const bodyNode: LayoutNode =
    squeezeN > 0 && body.length > 0
      ? {
          type: "box",
          key: `${opts.key}:squeeze`,
          style: {
            width: opts.width,
            squeeze: { head: squeezeN, tail: squeezeN },
          },
          children: body,
        }
      : {
          type: "flex",
          key: `${opts.key}:body`,
          style: { direction: "column", gap: 0, width: opts.width },
          children: body,
        };
  return {
    type: "indentation_exception",
    key: opts.key,
    kind: "diff",
    children: opts.hideHeader ? [bodyNode] : [header, bodyNode],
  };
}

function emptyState(key: string, path: string, hideHeader = false): LayoutNode {
  const empty: LayoutNode = {
    type: "text",
    key: `${key}:empty`,
    content: "(empty)",
    style: chromeStyle(),
  };
  return {
    type: "indentation_exception",
    key,
    kind: "diff",
    children: hideHeader
      ? [empty]
      : [
          {
            type: "text",
            key: `${key}:hdr`,
            content: `${path} · proposed`,
            style: headerStyle(),
          },
          empty,
        ],
  };
}

/** Shift hunk `@@` origins so span diffs paint file-absolute line numbers. */
function withFileLineStart(meta: FileDiffMetadata, lineStart: number | undefined): FileDiffMetadata {
  const origin = Math.trunc(lineStart ?? 1);
  const delta = origin > 1 ? origin - 1 : 0;
  if (delta === 0 || meta.hunks.length === 0) return meta;
  return {
    ...meta,
    hunks: meta.hunks.map((hunk) => ({
      ...hunk,
      deletionStart: hunk.deletionStart + delta,
      additionStart: hunk.additionStart + delta,
    })),
  };
}

function displayContext(context: number | "all" | undefined): number | "all" {
  if (context === "all") return "all";
  if (typeof context === "number" && Number.isFinite(context) && context >= 0) return context;
  return DEFAULT_CONTEXT;
}

function lineOriginOf(lineStart: number | undefined): number {
  const origin = Math.trunc(lineStart ?? 1);
  return Math.max(origin, 1);
}

/** Sync layout — word-alt + line numbers + full-width wash; syntax if highlighter warm. */
export function buildDiffLayout(opts: DiffViewOpts): LayoutNode {
  const key = opts.key ?? "diff";
  const path = opts.path ?? "file";
  const width = Math.max(1, opts.width | 0);
  const ctxOpt = displayContext(opts.context);
  const lineDiffType = opts.lineDiffType ?? "word-alt";

  if (opts.old === "" && opts.new === "") {
    return emptyState(key, path, opts.hideHeader === true);
  }

  const meta = withFileLineStart(
    parseDiffFromFile(
      { name: path, contents: withTrailingNl(opts.old) },
      { name: path, contents: withTrailingNl(opts.new) },
      { context: PARSE_CONTEXT },
    ),
    opts.lineStart,
  );

  return projectMeta(meta, {
    mode: opts.mode ?? "auto",
    width,
    context: ctxOpt,
    key,
    path: meta.name || path,
    lineDiffType,
    language: opts.language,
    noHighlight: opts.noHighlight,
    hideHeader: opts.hideHeader === true,
    stickyBottomRows: opts.stickyBottomRows,
    sourceOld: opts.old,
    sourceNew: opts.new,
    lineOrigin: lineOriginOf(opts.lineStart),
  });
}

export function parsePatchToLayout(
  patch: string,
  width: number,
  opts: {
    mode?: DiffMode;
    context?: number | "all";
    key?: string;
    lineDiffType?: LineDiffType;
  } = {},
): LayoutNode {
  const key = opts.key ?? "patch";
  if (!patch.trim()) return emptyState(key, "patch");
  const patches = parsePatchFiles(patch);
  const files = patches.flatMap((p) => p.files);
  if (files.length === 0) return emptyState(key, "patch");

  const ctxOpt = opts.context ?? DEFAULT_CONTEXT;
  const children = files.map((meta, i) =>
    projectMeta(meta, {
      mode: opts.mode ?? "auto",
      width,
      context: ctxOpt,
      key: `${key}:${i}`,
      path: meta.name || `file-${i}`,
      lineDiffType: opts.lineDiffType ?? "word-alt",
    }),
  );
  return {
    type: "box",
    key,
    children,
  };
}
