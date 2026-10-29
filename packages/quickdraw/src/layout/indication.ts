/**
 * Indication gutter (Law 6) — engine paint lineage.
 *
 * Grid: `[lead][gutter|void][gap][content]` — content at column 3.
 * Diff / code_pad stay `indentation_exception` (full-bleed wash).
 *
 * Single lineage:
 *   contentH = sum(measureNode(child))
 *   barH     = max(1, min(allocH, contentH))
 *   lines    = indicationGutterLines(node, barH)
 *
 * Paint must call these — never invent fill columns / triple anchors.
 */

import type { LayoutNode } from "./types.js";
import { isTwoColumnSymbol } from "../measure/index.js";

/** Empty mark cell. Lead + void + gap still parks content at column 3. */
export const INDICATION_VOID_GLYPH = " ";
/** Cells before content: lead + gutter + gap. */
export const INDICATION_CONTENT_INSET = 3;
/**
 * Extra-body gutter on expand — U+2503 BOX DRAWINGS HEAVY VERTICAL.
 * Centered, joins row-to-row. Not `│` (blockquote) and not `▎`/`▌` (left-sided).
 */
export const INDICATION_EXPAND_GLYPH = "┃";

export type IndicationNode = Extract<LayoutNode, { type: "indication" }>;

/** Wide sigils take the lead cell plus the gutter. Narrow glyphs stay in column 1. */
export function indicationGutterWide(gutter: IndicationNode["gutter"] | undefined): boolean {
  if (gutter == null || gutter.kind === "spinner") return false;
  const glyph = gutter.kind === "corners" ? gutter.top : gutter.glyph;
  return isTwoColumnSymbol(glyph);
}

/**
 * One glyph per body row for the indication gutter (column 1).
 * `height` is content-measured barH — not flex stretch allocation.
 */
export function indicationGutterLines(node: IndicationNode, height: number): string[] {
  const h = Math.max(1, height);
  const g = node.gutter;
  if (g.kind === "spinner") {
    // Geometry only — paint emits `live` ops; placeholder keeps measure stable.
    const rows = g.rows ?? "top";
    if (rows === "all") {
      return Array.from({ length: h }, () => "·");
    }
    return Array.from({ length: h }, (_, i) => (i === 0 ? "·" : " "));
  }
  if (g.kind === "top") {
    const gl = (g.glyph || "·").slice(0, 2);
    return Array.from({ length: h }, (_, i) => (i === 0 ? gl : " "));
  }
  if (g.kind === "rule") {
    const gl = (g.glyph || "·").slice(0, 2);
    return Array.from({ length: h }, () => gl);
  }
  const top = (g.top || "∵").slice(0, 2);
  const mid = (g.mid ?? "·").slice(0, 2);
  const bottom = g.bottom == null || g.bottom === "" ? mid : String(g.bottom).slice(0, 2);
  if (h === 1) {
    return [g.bottom != null && g.bottom !== "" ? bottom : top];
  }
  return Array.from({ length: h }, (_, i) => {
    if (i === 0) return top;
    if (i === h - 1) return bottom;
    return mid;
  });
}
