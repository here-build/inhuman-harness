/**
 * ./markdown-expand.js — streaming-markdown → LayoutNode trees.
 * Custom renderer builds layout nodes (not HTML).
 */

import {
  type Attr,
  BLOCKQUOTE,
  CHECKBOX,
  CHECKED,
  CODE_BLOCK,
  CODE_FENCE,
  CODE_INLINE,
  DOCUMENT,
  EQUATION_BLOCK,
  EQUATION_INLINE,
  HEADING_1,
  HEADING_2,
  HEADING_3,
  HEADING_4,
  HEADING_5,
  HEADING_6,
  HREF,
  IMAGE,
  ITALIC_AST,
  ITALIC_UND,
  LANG,
  LINE_BREAK,
  LINK,
  LIST_ITEM,
  LIST_ORDERED,
  LIST_UNORDERED,
  type Parser,
  PARAGRAPH,
  parser as smdParser,
  parser_end,
  parser_write,
  RAW_URL,
  type Renderer,
  RULE,
  SRC,
  START,
  STRIKE,
  STRONG_AST,
  STRONG_UND,
  TABLE,
  TABLE_CELL,
  TABLE_ROW,
  type Token,
} from "streaming-markdown";

import { guessLang, highlightCodeSync, runsToStyle } from "./syntax.js";
import { guardContent, type Style } from "../../buffer/index.js";
import { INDICATION_CONTENT_INSET, type GridStyle, type LayoutNode } from "../../layout/index.js";
import { measureGridDims } from "../../layout/measure.js";
import { wrapText } from "../../layout/text.js";
import { FgP } from "../../lexicon/index.js";

export type StreamMarkdown = {
  write(chunk: string): void;
  end(): void;
  nodes(): LayoutNode[];
  root(opts?: { key?: string }): LayoutNode;
};

export function createStreamingMarkdown(opts?: {
  key?: string;
  /**
   * When true, code fences stay plain. Default false: fences highlight via
   * highlightCodeSync (sync-safe — falls back to plain until warmHighlighter
   * resolves; hosts warm at boot), with `guessLang` filling missing info
   * strings.
   */
  plainCode?: boolean;
  /**
   * Remaining content columns for soft-wrap. `partsToNode(width)` freezes
   * nowrap rows — nested containers that inset (blockquote indication,
   * table column tracks) wrap to *their* inner budget, not this figure.
   * Callers that put markdown inside an indication subtract
   * `INDICATION_CONTENT_INSET` first. Without this, multi-style runs fall
   * back to pre-wrap join (styles merge).
   */
  width?: number;
  /**
   * Voice for body text. Default foreground @ secondary. Headings keep the
   * role and lift to primary.
   */
  style?: Style;
}): StreamMarkdown {
  const key = opts?.key ?? "md";
  const plainCode = opts?.plainCode ?? false;
  const builder = createBuilder(key, plainCode, opts?.width, opts?.style);
  const renderer: Renderer<BuilderData> = {
    data: builder,
    add_token: builderAddToken,
    end_token: builderEndToken,
    add_text: builderAddText,
    set_attr: builderSetAttr,
  };
  const p = smdParser(renderer);
  // Thread the parser into the builder so `snapshotNodes`/`projectOpen` can
  // read the SMD look-ahead buffer (p.text + p.pending) to compensate for the
  // trailing char(s) SMD holds back until the next write resolves the token.
  builder.parser = p;

  return {
    write(chunk: string) {
      // Guard BEFORE parser_write: CSI bodies contain `[` which streaming-markdown
      // treats as link openers ("before\x1b[2Jafter" → "before2Jafter", fg=link).
      // Buffer put also guards at paint; this keeps the MD AST itself honest.
      parser_write(p, guardContent(chunk));
    },
    end() {
      parser_end(p);
      // streaming-markdown may leave the last block open; commit it.
      flushOpenFrames(builder);
    },
    nodes() {
      return snapshotNodes(builder);
    },
    root(rootOpts) {
      return {
        type: "box",
        key: rootOpts?.key ?? key,
        children: snapshotNodes(builder),
      };
    },
  };
}

/** One-shot: write all + end, return root LayoutNode. */
export function markdownToLayout(src: string, opts?: { key?: string; width?: number; style?: Style }): LayoutNode {
  const stream = createStreamingMarkdown({
    key: opts?.key,
    width: opts?.width,
    style: opts?.style,
  });
  stream.write(src);
  stream.end();
  return stream.root({ key: opts?.key });
}

// ── builder ─────────────────────────────────────────────────────────────────

type Part = { text: string; style: Style };

type Frame = {
  token: Token;
  parts: Part[];
  children: LayoutNode[];
  /** list item counter (ordered / unordered) */
  itemCount: number;
  /**
   * Remaining wrap budget for this frame's inline content. Blockquotes
   * subtract {@link INDICATION_CONTENT_INSET} from the parent; everyone else
   * inherits. Undefined → no expand-time wrap (pre-wrap at measure).
   */
  wrapWidth?: number;
  href?: string;
  src?: string;
  lang?: string;
  checked?: boolean;
  start?: number;
  /** TABLE: column count from first body row (SMD skips |---| separator). */
  colCount?: number;
};

type BuilderData = {
  key: string;
  plainCode: boolean;
  /** Soft-wrap width for inline runs; undefined → pre-wrap single node. */
  width?: number;
  /** Body voice (role + prominence). Headings lift prominence only. */
  baseStyle: Style;
  stack: Frame[];
  seq: number;
  /**
   * The SMD parser, threaded in so live snapshots can read its look-ahead
   * buffer (parser.text + parser.pending) and compensate for the trailing
   * char(s) SMD defers until the next write. Set in createStreamingMarkdown.
   */
  parser?: Parser;
};

function createBuilder(key: string, plainCode: boolean, width?: number, style?: Style): BuilderData {
  const wrapWidth = width !== undefined && width > 0 ? Math.floor(width) : undefined;
  return {
    key,
    plainCode,
    width: wrapWidth,
    baseStyle: voiceBase(style),
    stack: [
      {
        token: DOCUMENT as Token,
        parts: [],
        children: [],
        itemCount: 0,
        wrapWidth,
      },
    ],
    seq: 0,
  };
}

/** Remaining wrap budget after an indication gutter (lead + glyph + gap). */
function insetWrapWidth(width: number | undefined): number | undefined {
  if (width === undefined || width <= 0) return undefined;
  return Math.max(1, width - INDICATION_CONTENT_INSET);
}

/** Commit any frames still open after parser_end (final unterminated block). */
function flushOpenFrames(data: BuilderData): void {
  while (data.stack.length > 1) {
    const frame = data.stack.pop()!;
    materialize(data, frame, top(data));
  }
}

function nextKey(data: BuilderData, kind: string): string {
  return `${data.key}:${kind}-${data.seq++}`;
}

function top(data: BuilderData): Frame {
  return data.stack.at(-1)!;
}

/** Body voice — one HK-adjusted prominence. Headings lift to primary. */
function voiceBase(style?: Style): Style {
  return {
    ...style,
    role: style?.role ?? "foreground",
    prominence: style?.prominence ?? FgP.secondary,
  };
}

function fenceStyle(base: Style): Style {
  return { role: "code", prominence: base.prominence ?? FgP.secondary };
}

function styleFromStack(data: BuilderData): Style {
  const s: Style = { ...data.baseStyle };
  for (const f of data.stack) {
    switch (f.token) {
      case HEADING_1:
      case HEADING_2:
      case HEADING_3:
      case HEADING_4:
      case HEADING_5:
      case HEADING_6:
        // Same role as body — hierarchy is prominence, not a heading hue.
        s.prominence = FgP.primary;
        break;
      case STRONG_AST:
      case STRONG_UND:
        s.bold = true;
        break;
      case ITALIC_AST:
      case ITALIC_UND:
        // Real SGR 3 (voice inflection) — dim-as-italic proxy dies.
        s.italic = true;
        break;
      case STRIKE:
        // Real crossed-out (SGR 9), not dim-as-proxy — dim is italic/quote.
        s.strike = true;
        break;
      case CODE_INLINE:
        // Unspecified / unhighlighted source: code role (azure).
        // Same prominence as body so H-K keeps it level with prose.
        s.role = "code";
        break;
      case BLOCKQUOTE:
        // Aside stays the body voice; gutter is furniture.
        break;
      case LINK:
      case RAW_URL:
        s.role = "accent";
        s.underline = true;
        break;
      default:
        break;
    }
  }
  return s;
}

function isMdTable(node: LayoutNode): boolean {
  return node.type === "grid";
}

function isMdQuote(node: LayoutNode): boolean {
  return node.type === "indication";
}

/** Committed paragraph keys (`md:p-3`). Wrap rows are `p-3:w0` and stay nested. */
function isMdParagraph(node: LayoutNode): boolean {
  return typeof node.key === "string" && /:p-\d+$/.test(node.key);
}

/** Paragraphs, tables, and quotes — 1-cell gap when not first/last. */
function needsFlowMargin(node: LayoutNode): boolean {
  return isMdTable(node) || isMdQuote(node) || isMdParagraph(node);
}

function withFlowMargins(kids: readonly LayoutNode[], key: string): LayoutNode[] {
  const out: LayoutNode[] = [];
  for (const n of kids) {
    const prev = out.at(-1);
    if (prev && (needsFlowMargin(prev) || needsFlowMargin(n))) {
      out.push({
        type: "text",
        key: `${key}:flow-gap-${out.length}`,
        content: " ",
        whiteSpace: "nowrap",
      });
    }
    out.push(n);
  }
  return out;
}

function isHeading(t: Token): boolean {
  return t >= HEADING_1 && t <= HEADING_6;
}

function isInline(t: Token): boolean {
  switch (t) {
    case CODE_INLINE:
    case ITALIC_AST:
    case ITALIC_UND:
    case STRONG_AST:
    case STRONG_UND:
    case STRIKE:
    case LINK:
    case RAW_URL:
    case IMAGE:
    case EQUATION_INLINE:
    case LINE_BREAK:
    case CHECKBOX:
      return true;
    default:
      return false;
  }
}

function mergeParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = out.at(-1);
    if (last && styleEqual(last.style, p.style)) {
      last.text += p.text;
    } else {
      out.push({ text: p.text, style: { ...p.style } });
    }
  }
  return out;
}

function rgbEqual(a?: { r: number; g: number; b: number }, b?: { r: number; g: number; b: number }): boolean {
  if (!a || !b) return a === b;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function styleEqual(a: Style, b: Style): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.underline === b.underline &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    rgbEqual(a.fgRgb, b.fgRgb) &&
    rgbEqual(a.bgRgb, b.bgRgb) &&
    a.role === b.role &&
    a.prominence === b.prominence &&
    a.bgRole === b.bgRole &&
    a.bgProminence === b.bgProminence &&
    a.href === b.href
  );
}

function joinParts(parts: Part[]): string {
  return parts.map((p) => p.text).join("");
}

/**
 * Soft-wrap styled parts to `width` display columns.
 * Break offsets come from wrapText pre-wrap (last space, then grapheme) so
 * mixed-style runs and plain text share one wrap. Independent column-cut
 * splits words. Hard `\n` always break.
 */
export function softWrapParts(parts: Part[], width: number): Part[][] {
  const w = Math.max(1, width);
  const rows: Part[][] = [];
  for (const hard of splitHardLines(mergeParts(parts))) {
    const text = joinParts(hard);
    const lines = wrapText(text, { width: w, whiteSpace: "pre-wrap" });
    let offset = 0;
    for (const line of lines) {
      const slice = sliceParts(hard, offset, offset + line.length);
      rows.push(slice.length > 0 ? slice : [{ text: " ", style: {} }]);
      offset += line.length;
    }
  }
  return rows.length > 0 ? rows : [[{ text: " ", style: {} }]];
}

function splitHardLines(parts: Part[]): Part[][] {
  const lines: Part[][] = [[]];
  for (const p of parts) {
    const chunks = p.text.split("\n");
    for (const [ci, chunk_] of chunks.entries()) {
      if (ci > 0) lines.push([]);
      const chunk = chunk_!;
      if (chunk.length > 0) {
        lines.at(-1)!.push({ text: chunk, style: p.style });
      }
    }
  }
  return lines;
}

function sliceParts(parts: Part[], start: number, end: number): Part[] {
  if (end <= start) return [];
  const out: Part[] = [];
  let i = 0;
  for (const p of parts) {
    const pe = i + p.text.length;
    if (pe <= start) {
      i = pe;
      continue;
    }
    if (i >= end) break;
    const a = Math.max(0, start - i);
    const b = Math.min(p.text.length, end - i);
    if (b > a) out.push({ text: p.text.slice(a, b), style: p.style });
    i = pe;
  }
  return out;
}

function rowToNode(parts: Part[], key: string): LayoutNode {
  const merged = mergeParts(parts);
  if (merged.length === 0) {
    return { type: "text", key, content: " ", whiteSpace: "nowrap" };
  }
  if (merged.length === 1) {
    const only = merged[0]!;
    return {
      type: "text",
      key,
      content: only.text,
      // Row already width-cut — nowrap preserves edge spaces within the segment.
      whiteSpace: "nowrap",
      style: only.style,
    };
  }
  return {
    type: "flex",
    key,
    style: { direction: "row", gap: 0 },
    children: merged.map((p, i) => ({
      type: "text" as const,
      key: `${key}:${i}`,
      content: p.text,
      whiteSpace: "nowrap" as const,
      style: p.style,
    })),
  };
}

function partsToNode(parts: Part[], key: string, width?: number): LayoutNode {
  const merged = mergeParts(parts);
  if (merged.length === 0) {
    return { type: "text", key, content: "" };
  }

  // Soft-wrap when we know the content column budget (preserves mid-line styles).
  if (width !== undefined && width > 0) {
    const rows = softWrapParts(merged, width);
    if (rows.length === 1) return rowToNode(rows[0]!, key);
    return {
      type: "box",
      key,
      children: rows.map((row, i) => rowToNode(row, `${key}:w${i}`)),
    };
  }

  // No width: single style → pre-wrap (layout soft-wraps at measure).
  // Multi-style → nowrap flex row (style-preserving; callers should pass width
  // so long mixed paragraphs soft-wrap instead of clipping).
  if (merged.length === 1) {
    const only = merged[0]!;
    return {
      type: "text",
      key,
      content: only.text,
      whiteSpace: "pre-wrap",
      style: only.style,
    };
  }
  return rowToNode(merged, key);
}

/** Trim leading/trailing whitespace across part runs (GFM table cell padding). */
function trimParts(parts: Part[]): Part[] {
  if (parts.length === 0) return parts;
  const copy = parts.map((p) => ({ text: p.text, style: { ...p.style } }));
  // leading
  while (copy.length > 0 && copy[0]!.text.trimStart() !== copy[0]!.text) {
    copy[0]!.text = copy[0]!.text.trimStart();
    if (!copy[0]!.text) copy.shift();
  }
  // trailing
  while (copy.length > 0) {
    const last = copy.at(-1)!;
    const trimmed = last.text.trimEnd();
    if (trimmed === last.text) break;
    if (!trimmed) {
      copy.pop();
      continue;
    }
    last.text = trimmed;
    break;
  }
  return copy;
}

function asTableHeaderCell(node: LayoutNode): LayoutNode {
  if (node.type === "text") {
    return {
      ...node,
      style: { ...node.style, prominence: FgP.primary, bold: true },
    };
  }
  if (node.type === "flex" || node.type === "box") {
    return {
      ...node,
      children: (node.children ?? []).map(asTableHeaderCell),
    };
  }
  return node;
}

/**
 * Fence lines → styled rows. Sync-safe: highlightCodeSync falls back to plain
 * when the highlighter isn't warm, and `guessLang` fills in when the fence has
 * no info string. Returns undefined when there is nothing beyond plain text —
 * callers keep the cheaper single-node-per-line path.
 */
function highlightedFenceRows(
  data: BuilderData,
  code: string,
  lang: string | undefined,
  width: number | undefined = data.width,
): Part[][] | undefined {
  if (data.plainCode) return undefined;
  const effLang = lang || guessLang(code);
  if (!effLang) return undefined;
  const stripped = code.replace(/\n$/, "");
  const hl = highlightCodeSync(stripped, { lang: effLang });
  if (!hl.some((line) => line.some((run) => run.color || run.bold || run.italic))) {
    return undefined;
  }
  const rows: Part[][] = [];
  for (const line of hl) {
    const parts: Part[] = line.map((run) => ({
      text: run.text,
      style: { ...fenceStyle(data.baseStyle), ...runsToStyle(run) },
    }));
    if (width === undefined) {
      rows.push(parts);
    } else {
      rows.push(...softWrapParts(parts, width));
    }
  }
  return rows;
}

function plainCodeNode(
  data: BuilderData,
  code: string,
  lang: string | undefined,
  width: number | undefined = data.width,
): Extract<LayoutNode, { type: "indentation_exception" }> {
  const lines = code.replace(/\n$/, "").split("\n");
  const fenceKey = nextKey(data, lang ? `fence-${lang}` : "fence");
  const rows = highlightedFenceRows(data, code, lang, width);
  if (rows) {
    return {
      type: "indentation_exception",
      key: fenceKey,
      kind: "code_pad",
      children: rows.map((parts, j) => rowToNode(parts, `${fenceKey}:${j}`)),
    };
  }
  const node: Extract<LayoutNode, { type: "indentation_exception" }> = {
    type: "indentation_exception",
    key: fenceKey,
    kind: "code_pad",
    children: lines.map((l, j) => ({
      type: "text" as const,
      key: `${fenceKey}:${j}`,
      content: l.length > 0 ? l : " ",
      // Soft-wrap long fence lines at measure width (not nowrap clip).
      whiteSpace: "pre-wrap" as const,
      style: fenceStyle(data.baseStyle),
    })),
  };
  return node;
}

// ── renderer callbacks ──────────────────────────────────────────────────────

function builderAddToken(data: BuilderData, type: Token): void {
  if (type === DOCUMENT) return;
  const parent = top(data);
  data.stack.push({
    token: type,
    parts: [],
    children: [],
    itemCount: 0,
    wrapWidth: type === BLOCKQUOTE ? insetWrapWidth(parent.wrapWidth) : parent.wrapWidth,
  });
}

function builderSetAttr(data: BuilderData, type: Attr, value: string): void {
  const frame = top(data);
  switch (type) {
    case HREF:
      // Guard so CSI/OSC in URL cannot leak into displayed text / paint.
      frame.href = guardContent(value);
      break;
    case SRC:
      frame.src = guardContent(value);
      break;
    case LANG:
      // streaming-markdown sets class-like lang on fence; may be bare "ts".
      // Sanitize BEFORE stripping the `language-` prefix so the regex runs
      // on clean text (CSI bodies can contain `[` etc.).
      frame.lang = guardContent(value)
        .replace(/^language-/, "")
        .trim();
      break;
    case CHECKED:
      frame.checked = true;
      break;
    case START: {
      const n = Number.parseInt(value, 10);
      frame.start = Number.isFinite(n) ? n : 1;
      break;
    }
    default:
      break;
  }
}

function builderAddText(data: BuilderData, text: string): void {
  const frame = top(data);
  frame.parts.push({ text, style: styleFromStack(data) });
}

function builderEndToken(data: BuilderData): void {
  if (data.stack.length <= 1) return;
  const frame = data.stack.pop()!;
  const parent = top(data);
  materialize(data, frame, parent);
}

function materialize(data: BuilderData, frame: Frame, parent: Frame): void {
  const t = frame.token;

  // void / inline tokens that bubble parts upward
  if (t === LINE_BREAK) {
    parent.parts.push({ text: "\n", style: styleFromStack(data) });
    return;
  }

  if (t === CHECKBOX) {
    const mark = frame.checked ? "[x] " : "[ ] ";
    parent.parts.push({
      text: mark,
      style: styleFromStack(data),
    });
    return;
  }

  if (
    t === CODE_INLINE ||
    t === ITALIC_AST ||
    t === ITALIC_UND ||
    t === STRONG_AST ||
    t === STRONG_UND ||
    t === STRIKE ||
    t === EQUATION_INLINE
  ) {
    parent.parts.push(...frame.parts);
    return;
  }

  if (t === LINK || t === RAW_URL) {
    // Label (or autolink text) only. Destination rides OSC 8 on the
    // accent run — HREF arrives after body text, so stamp at close.
    if (frame.href) {
      for (const p of frame.parts) {
        p.style = { ...p.style, href: frame.href };
      }
    }
    parent.parts.push(...frame.parts);
    return;
  }

  if (t === IMAGE) {
    const alt = joinParts(frame.parts) || "image";
    parent.parts.push({
      text: frame.src ? `![${alt}](${frame.src})` : `![${alt}]`,
      // Alt/src stay visible — image has no OSC 8 cell to hide behind.
      style: { role: "muted", prominence: FgP.ghost },
    });
    return;
  }

  if (isHeading(t) || t === PARAGRAPH || t === EQUATION_BLOCK) {
    // headings → bold text; paragraphs → text (styles already in parts)
    if (frame.parts.length > 0 || frame.children.length === 0) {
      parent.children.push(partsToNode(frame.parts, nextKey(data, isHeading(t) ? "h" : "p"), frame.wrapWidth));
    }
    parent.children.push(...frame.children);
    return;
  }

  if (t === CODE_FENCE || t === CODE_BLOCK) {
    const code = joinParts(frame.parts);
    parent.children.push(plainCodeNode(data, code, frame.lang, frame.wrapWidth));
    return;
  }

  if (t === BLOCKQUOTE) {
    const rawKids =
      frame.children.length > 0
        ? frame.children
        : frame.parts.length > 0
          ? [partsToNode(frame.parts, nextKey(data, "p"), frame.wrapWidth)]
          : [];
    // Blank `>` lines are paragraph separators, not empty paragraphs.
    // Paragraph flow-margin reifies the 1-cell bar-only row:
    //   │ first
    //   │          ← gap
    //   │ second
    const kids = withFlowMargins(rawKids, nextKey(data, "bq-flow"));
    parent.children.push({
      type: "indication",
      key: nextKey(data, "bq"),
      gutter: { kind: "rule", glyph: "│" },
      // Furniture — not the body voice. Ghost so the bar recedes
      // instead of inheriting paragraph prominence.
      style: { role: "border", prominence: FgP.ghost },
      children: kids,
    });
    return;
  }

  if (t === RULE) {
    parent.children.push({
      type: "text",
      key: nextKey(data, "hr"),
      content: "───",
      style: { role: "border", prominence: FgP.ghost },
    });
    return;
  }

  if (t === LIST_ITEM) {
    const ordered = parent.token === LIST_ORDERED;
    const start = parent.start ?? 1;
    const idx = parent.itemCount;
    parent.itemCount += 1;
    const prefix = ordered ? `${start + idx}. ` : "• ";
    const body = joinParts(frame.parts);
    // If nested block children exist without leading text, still show prefix line
    const lineKey = nextKey(data, "li");
    if (body || frame.children.length === 0) {
      parent.children.push(
        partsToNode([{ text: prefix, style: data.baseStyle }, ...frame.parts], lineKey, frame.wrapWidth),
      );
    } else {
      parent.children.push({
        type: "text",
        key: lineKey,
        content: prefix.trimEnd(),
        style: data.baseStyle,
      });
    }
    parent.children.push(...frame.children);
    return;
  }

  if (t === LIST_ORDERED || t === LIST_UNORDERED) {
    // pass children up; list itself is transparent container
    parent.children.push(...frame.children);
    return;
  }

  if (t === TABLE_CELL) {
    // Prefer structured children (nested blocks rare); else parts → text/flex.
    // SMD cell text includes GFM padding spaces — trim edges.
    // Do not wrap at document width here — tableGridNode wraps to column tracks.
    const cellKey = nextKey(data, "td");
    if (frame.children.length > 0 && frame.parts.length === 0) {
      parent.children.push({
        type: "box",
        key: cellKey,
        children: frame.children,
      });
    } else {
      parent.children.push(partsToNode(trimParts(frame.parts), cellKey));
    }
    return;
  }

  if (t === TABLE_ROW) {
    // Cells are already LayoutNodes on frame.children (one per TABLE_CELL).
    const cells = frame.children;
    if (parent.colCount === undefined) {
      parent.colCount = Math.max(1, cells.length);
    }
    const cols = parent.colCount;
    // Pad / trim to column count so grid stays rectangular
    const normalized: LayoutNode[] = [];
    for (let i = 0; i < cols; i++) {
      normalized.push(
        cells[i] ?? {
          type: "text",
          key: nextKey(data, "td-empty"),
          content: "",
        },
      );
    }
    parent.children.push(...normalized);
    return;
  }

  if (t === TABLE) {
    parent.children.push(
      tableGridNode(nextKey(data, "table"), frame.children, Math.max(1, frame.colCount ?? 1), frame.wrapWidth),
    );
    return;
  }

  // fallback: bubble children + parts
  if (frame.parts.length > 0) {
    parent.children.push(partsToNode(frame.parts, nextKey(data, "blk"), frame.wrapWidth));
  }
  parent.children.push(...frame.children);
}

// ── partial snapshot for live streaming ─────────────────────────────────────

function snapshotNodes(data: BuilderData): LayoutNode[] {
  if (data.stack.length === 1) {
    const kids = data.stack[0]!.children;
    return kids.length > 0
      ? withFlowMargins(kids, data.key)
      : [{ type: "text", key: `${data.key}:empty`, content: "" }];
  }

  // Project open frames into a temporary tree without mutating stack.
  const committed = [...data.stack[0]!.children];
  const open = projectOpen(data, 1, pendingTail(data));
  const merged = committed.concat(open);
  return merged.length > 0
    ? withFlowMargins(merged, data.key)
    : [{ type: "text", key: `${data.key}:empty`, content: "" }];
}

/**
 * SMD holds the most recent char(s) in a look-ahead buffer and only resolves
 * `add_text` when the NEXT char determines the token. So the deepest open
 * frame's `parts` is always missing the trailing text the user just typed.
 *
 * `parser.text` = accumulated text awaiting flush; `parser.pending` = the
 * residual look-ahead (the last char(s) consumed but not yet committed). After
 * `parser_write` returns, `parser.text` is already flushed (so usually ""),
 * while `parser.pending` holds the dangling tail. We project BOTH onto the
 * deepest frame so a live snapshot shows the full input — without mutating the
 * real `frame.parts` or the parser state.
 */
function pendingTail(data: BuilderData): string {
  const p = data.parser;
  if (!p) return "";
  return (p.text ?? "") + (p.pending ?? "");
}

/** `frame.parts` with the SMD pending tail appended (projection-only copy). */
function partsWithTail(frame: Frame, data: BuilderData, tail: string, isDeepest: boolean): Part[] {
  if (!isDeepest || !tail) return frame.parts;
  // Append as literal text styled like the current stack (matches what SMD
  // would emit once the token resolves). Partial syntax (lone `[`, `*`, …)
  // is treated as literal — that's what renders once flushed, which is the
  // goal: the last typed char appears.
  return [...frame.parts, { text: tail, style: styleFromStack(data) }];
}

/**
 * Open inlines keep parts on their own frames until end_token bubbles them
 * into the parent. Live snapshot must splice the same way: projecting each
 * inline as a sibling layout node stacks box rows, so the word after an
 * unclosed ` / * / ** jumps to the next line until the closer arrives.
 */
function partsThroughOpenInlines(data: BuilderData, idx: number, tail: string): Part[] {
  const parts: Part[] = [];
  for (let i = idx; i < data.stack.length; i++) {
    const frame = data.stack[i]!;
    if (i > idx && !isInline(frame.token)) break;
    parts.push(...partsWithTail(frame, data, tail, i === data.stack.length - 1));
  }
  return parts;
}

function skipOpenInlines(data: BuilderData, idx: number): number {
  let i = idx;
  while (i < data.stack.length && isInline(data.stack[i]!.token)) i++;
  return i;
}

function mdTableGridStyle(cols: number): GridStyle {
  return {
    columns: Array.from({ length: Math.max(1, cols) }, () => "auto" as const),
    lines: "inner",
    // Furniture, not voice — no outer frame (lines=inner).
    lineStyle: { role: "border", prominence: FgP.ghost },
    cellPad: { x: 1 },
    columnGap: 1,
    rowGap: 1,
  };
}

function isInlineCell(node: LayoutNode): boolean {
  if (node.type === "text") return true;
  if (node.type === "flex" || node.type === "box") {
    return (node.children ?? []).every(isInlineCell);
  }
  return false;
}

function flattenParts(node: LayoutNode): Part[] {
  if (node.type === "text") return [{ text: node.content, style: node.style ?? {} }];
  if (node.type === "flex" || node.type === "box") {
    return (node.children ?? []).flatMap(flattenParts);
  }
  return [];
}

function wrapCellToWidth(node: LayoutNode, width: number): LayoutNode {
  if (isInlineCell(node)) {
    const parts = flattenParts(node);
    if (parts.length === 0) return node;
    return partsToNode(parts, node.key ?? "td", width);
  }
  if (node.type === "indication") {
    const inner = Math.max(1, width - INDICATION_CONTENT_INSET);
    return { ...node, children: (node.children ?? []).map((c) => wrapCellToWidth(c, inner)) };
  }
  if (node.type === "box" || node.type === "flex" || node.type === "indentation_exception") {
    return { ...node, children: (node.children ?? []).map((c) => wrapCellToWidth(c, width)) };
  }
  return node;
}

/**
 * Wrap inline cells to the same column inner widths layout will assign.
 * `partsToNode(width)` freezes nowrap rows — doing that at document width
 * makes the grid clip instead of reflowing the long column.
 */
function wrapTableCells(cells: readonly LayoutNode[], cols: number, width?: number): LayoutNode[] {
  const body = [...cells];
  const n = Math.max(1, cols);
  if (width === undefined || width <= 0 || body.length === 0) return body;
  const dims = measureGridDims(
    {
      type: "grid",
      style: mdTableGridStyle(n),
      children: body,
    },
    width,
  );
  return body.map((cell, i) => {
    const innerW = Math.max(1, (dims.colWidths[i % n] ?? 1) - dims.padX * 2);
    return wrapCellToWidth(cell, innerW);
  });
}

/** GFM table as a grid. Header row (first `cols` cells) is bold. */
function tableGridNode(key: string, cells: readonly LayoutNode[], cols: number, width?: number): LayoutNode {
  const n = Math.max(1, cols);
  const body = wrapTableCells(cells, n, width);
  for (let i = 0; i < n && i < body.length; i++) {
    body[i] = asTableHeaderCell(body[i]!);
  }
  return {
    type: "grid",
    key,
    style: mdTableGridStyle(n),
    children: body,
  };
}

/** SMD holds `|` / newline until the next char; those are delimiters, not cell text. */
function tableCellTail(tail: string): string {
  if (/^[|\n]+$/.test(tail)) return "";
  return tail;
}

/**
 * Live TABLE snapshot: closed cells already sit on the table frame (full rows)
 * and the open row. Incomplete last cell is included when it has text; leftover
 * columns stay empty (grid pads). Separator pending on TABLE is ignored.
 */
function projectLiveTable(data: BuilderData, idx: number, tail: string): LayoutNode[] {
  const table = data.stack[idx]!;
  const openCells: LayoutNode[] = [];
  const row = data.stack[idx + 1];
  if (row?.token === TABLE_ROW) {
    openCells.push(...row.children);
    const cellIdx = idx + 2;
    if (data.stack[cellIdx]?.token === TABLE_CELL) {
      const live = projectLiveTableCell(data, cellIdx, tail);
      if (live) openCells.push(live);
    }
    if (table.colCount !== undefined) {
      openCells.length = Math.min(openCells.length, table.colCount);
    }
  }
  const cells = [...table.children, ...openCells];
  if (cells.length === 0) return [];
  const cols = Math.max(1, table.colCount ?? cells.length);
  return [tableGridNode(`${data.key}:live-table`, cells, cols, table.wrapWidth)];
}

function projectLiveTableCell(data: BuilderData, cellIdx: number, tail: string): LayoutNode | undefined {
  const cell = data.stack[cellIdx]!;
  const parts: Part[] = [];
  for (let i = cellIdx; i < data.stack.length; i++) {
    const isDeepest = i === data.stack.length - 1;
    const cellTail = isDeepest ? tableCellTail(tail) : "";
    parts.push(...partsWithTail(data.stack[i]!, data, cellTail, isDeepest));
  }
  const trimmed = trimParts(parts);
  if (trimmed.length === 0 && cell.children.length === 0) return undefined;
  if (cell.children.length === 0) {
    return partsToNode(trimmed, `${data.key}:live-td`);
  }
  return {
    type: "box",
    key: `${data.key}:live-td`,
    children: [...(trimmed.length > 0 ? [partsToNode(trimmed, `${data.key}:live-td-p`)] : []), ...cell.children],
  };
}

function projectOpen(data: BuilderData, idx: number, tail: string): LayoutNode[] {
  if (idx >= data.stack.length) return [];
  const frame = data.stack[idx]!;
  const t = frame.token;

  // Open TABLE never materializes a grid (that happens on end_token). Project
  // closed cells + the current cell into a grid; drop empty in-progress cells
  // and never paint the `|---` separator / trailing `|` as prose.
  if (t === TABLE) {
    return projectLiveTable(data, idx, tail);
  }
  if (t === TABLE_ROW || t === TABLE_CELL) {
    return [];
  }

  // Skip still-open inlines: they splice into this frame's parts (see
  // partsThroughOpenInlines). Recursing into them used to emit a sibling
  // layout node, which a box stacks as a new row.
  const deeper = projectOpen(data, skipOpenInlines(data, idx + 1), tail);

  if (t === CODE_FENCE || t === CODE_BLOCK) {
    const parts = partsThroughOpenInlines(data, idx, tail);
    const code = joinParts(parts);
    return [plainCodeNodeLive(data, code, frame.lang, frame.wrapWidth), ...deeper];
  }

  if (isHeading(t) || t === PARAGRAPH) {
    const parts = partsThroughOpenInlines(data, idx, tail);
    const nodes: LayoutNode[] = [];
    if (parts.length > 0) {
      nodes.push(partsToNode(parts, `${data.key}:live-${idx}`, frame.wrapWidth));
    }
    nodes.push(...frame.children, ...deeper);
    return nodes;
  }

  if (t === LIST_ITEM) {
    const parent = data.stack[idx - 1];
    const ordered = parent?.token === LIST_ORDERED;
    const start = parent?.start ?? 1;
    const n = parent?.itemCount ?? 0;
    const prefix = ordered ? `${start + n}. ` : "• ";
    const parts = partsThroughOpenInlines(data, idx, tail);
    return [
      partsToNode([{ text: prefix, style: data.baseStyle }, ...parts], `${data.key}:live-li-${idx}`, frame.wrapWidth),
      ...frame.children,
      ...deeper,
    ];
  }

  if (t === BLOCKQUOTE) {
    const parts = partsThroughOpenInlines(data, idx, tail);
    return [
      {
        type: "indication",
        key: `${data.key}:live-bq-${idx}`,
        gutter: { kind: "rule", glyph: "│" },
        style: { role: "border", prominence: FgP.ghost },
        children: [
          ...frame.children,
          ...(parts.length > 0 ? [partsToNode(parts, `${data.key}:live-bq-p-${idx}`, frame.wrapWidth)] : []),
          ...deeper,
        ],
      },
    ];
  }

  if (isInline(t)) {
    // First open frame is an inline (no paragraph yet). Fold nested inlines
    // into one node — never a sibling per span.
    const parts = partsThroughOpenInlines(data, idx, tail);
    if (parts.length > 0) {
      return [partsToNode(parts, `${data.key}:live-in-${idx}`, frame.wrapWidth), ...deeper];
    }
    return deeper;
  }

  const parts = partsThroughOpenInlines(data, idx, tail);
  return [
    ...frame.children,
    ...(parts.length > 0 ? [partsToNode(parts, `${data.key}:live-${idx}`, frame.wrapWidth)] : []),
    ...deeper,
  ];
}

/** Live code fence for open-block snapshot projection (no key seq bump). */
function plainCodeNodeLive(
  data: BuilderData,
  code: string,
  lang: string | undefined,
  width: number | undefined = data.width,
): LayoutNode {
  const lines = code.replace(/\n$/, "").split("\n");
  const fenceKey = `${data.key}:live-fence${lang ? `-${lang}` : ""}`;
  const rows = highlightedFenceRows(data, code, lang, width);
  if (rows) {
    return {
      type: "indentation_exception",
      key: fenceKey,
      kind: "code_pad",
      children: rows.map((parts, j) => rowToNode(parts, `${fenceKey}:${j}`)),
    };
  }
  return {
    type: "indentation_exception",
    key: fenceKey,
    kind: "code_pad",
    children: lines.map((l, j) => ({
      type: "text" as const,
      key: `${fenceKey}:${j}`,
      content: l,
      style: fenceStyle(data.baseStyle),
    })),
  };
}
