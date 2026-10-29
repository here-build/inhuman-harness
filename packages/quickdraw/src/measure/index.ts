/**
 * ./index.js — display-column text width (terminal columns).
 * Thin façade over string-width + grapheme-aware split.
 *
 * Dependency choice (2026-07 npm survey): string-width@8 — grapheme clusters
 * via Intl.Segmenter, RGI/ZWJ emoji → 2 cols, combining/format → 0, TR11
 * ambiguous-narrow default.
 * Rejected: eastasianwidth (Ambiguous→2 breaks combining), wcwidth (stale),
 * kitchen-sink TUI kits, Bun-only stringWidth.
 *
 * One module-level Segmenter. Per-call `new Intl.Segmenter` was ~27 ms of a
 * 200×50 catalog paintFrame. ASCII + box/block drawing (U+2500–259F) is
 * width-1 per code unit — slice, do not segment.
 *
 * TWO_COLUMN_SYMBOLS are Neutral under UAX #11 (string-width → 1) but the
 * fonts we paint ink two cells. Layout width is 2. The mate is an emitted
 * space, not a CJK placeholder: emit skips placeholders, and a wcwidth-1
 * TTY would then draw the next glyph on top of the ink (⏎: Confirm).
 */

import stringWidth from "string-width";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Code points that occupy two columns in product fonts while remaining
 * East-Asian-width Neutral. Add a code point here when a glyph overlaps
 * the next cell; do not add true double-width (CJK / RGI emoji).
 */
const TWO_COLUMN_SYMBOLS = new Set<number>([
  0x23_ce, // RETURN SYMBOL
  0x24_aa, // scheme_repl
  0x24_b2, // scheme_watch
]);

/** Printable ASCII, or box-drawing / block elements — one column per code unit. */
export function isUnitWidthRun(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0x25_00 && c <= 0x25_9f) continue;
    return false;
  }
  return true;
}

/** Width-2 Neutral cluster whose mate must be an emitted space, not a CJK placeholder. */
export function isTwoColumnSymbol(cluster: string): boolean {
  if (cluster.length === 0) return false;
  const cp = cluster.codePointAt(0);
  if (cp === undefined || !TWO_COLUMN_SYMBOLS.has(cp)) return false;
  return cluster.length === String.fromCodePoint(cp).length;
}

export type MeasureOpts = {
  ambiguousIsNarrow?: boolean; // default true
  countAnsiEscapeCodes?: boolean; // default false
};

export type Measure = (text: string) => number;

function stringWidthOf(text: string, opts?: MeasureOpts): number {
  return stringWidth(text, {
    ambiguousIsNarrow: opts?.ambiguousIsNarrow ?? true,
    countAnsiEscapeCodes: opts?.countAnsiEscapeCodes ?? false,
  });
}

export function displayWidth(text: string, opts?: MeasureOpts): number {
  const w = stringWidthOf(text, opts);
  if (w === 0 || isUnitWidthRun(text)) return w;
  let boost = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !TWO_COLUMN_SYMBOLS.has(cp)) continue;
    const native = stringWidthOf(ch, opts);
    if (native < 2) boost += 2 - native;
  }
  return w + boost;
}

/** Width of a single grapheme cluster (0 | 1 | 2+ via string-width). */
export function graphemeWidth(cluster: string): number {
  return displayWidth(cluster);
}

/**
 * First grapheme cluster. Unlike {@link splitAtWidth}(text, 1), a wide
 * cluster is returned whole — paint walks must not drop ⏎ / CJK.
 */
export function takeGrapheme(text: string): [cluster: string, rest: string] {
  if (text.length === 0) return ["", ""];
  if (isUnitWidthRun(text)) return [text[0]!, text.slice(1)];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    return [segment, text.slice(segment.length)];
  }
  return ["", ""];
}

/**
 * Split `text` so `head` fits in `maxColumns` display columns.
 * Never splits mid-grapheme-cluster.
 */
export function splitAtWidth(text: string, maxColumns: number): [head: string, tail: string] {
  if (maxColumns <= 0) {
    return ["", text];
  }

  if (isUnitWidthRun(text)) {
    if (text.length <= maxColumns) return [text, ""];
    return [text.slice(0, maxColumns), text.slice(maxColumns)];
  }

  let used = 0;
  let headEnd = 0;

  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    const w = displayWidth(segment);
    if (used + w > maxColumns) {
      return [text.slice(0, headEnd), text.slice(headEnd)];
    }
    used += w;
    headEnd = index + segment.length;
  }

  return [text, ""];
}

export const defaultMeasure: Measure = (t) => displayWidth(t);
