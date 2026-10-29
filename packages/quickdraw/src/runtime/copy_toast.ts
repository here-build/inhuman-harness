/**
 * Copy-confirmation chrome — a present-path overlay, not a LayoutNode.
 *
 * Layout `overlay` participates in hit (backdrop dismiss). This plaque does
 * not: mousedown is passthrough, serialize/word-snap read the pre-overlay
 * buffer. Host paints it after selection recolor, onto a clone.
 *
 * Rim uses chrome_frame corners (╭╮╰╯), furniture weight. Label is primary.
 * Glyphs only — no fill. Under-cell bg shows through (`put` mergeStyle).
 *
 * Place: outside the range-end side of the selection (below when active is
 * down/same-row, above when selecting upward). Flip when that side does not
 * fit the viewport. Horizontal center-anchor on the end cell, then clamp.
 */
import { put, type Buffer, type Style } from "../buffer/index.js";
import { CHROME_FRAME_CORNERS } from "../layout/index.js";
import { FgP } from "../lexicon/index.js";
import { displayWidth } from "../measure/index.js";

export const COPY_TOAST_TEXT = "Copied";
/** Move / key / scroll may dismiss after this. Press dismisses immediately. */
export const COPY_TOAST_ARM_MS = 3000;
/** Hard cap — toast never outlives this, even with no input. */
export const COPY_TOAST_HOLD_MS = 10_000;

export type CopyToastPlace = {
  x: number;
  y: number;
  w: number;
  h: number;
  side: "below" | "above";
};

export function copyToastSize(cols: number, rows: number, text: string = COPY_TOAST_TEXT): { w: number; h: number } {
  const inner = Math.max(1, displayWidth(text));
  const padded = inner + 4;
  const tight = inner + 2;
  const w = cols >= padded ? padded : Math.min(Math.max(2, cols), tight);
  const h = Math.min(3, Math.max(1, rows));
  return { w, h };
}

export function placeCopyToast(args: {
  end: { col: number; row: number };
  anchor: { col: number; row: number };
  cols: number;
  rows: number;
  text?: string;
}): CopyToastPlace {
  const { w, h } = copyToastSize(args.cols, args.rows, args.text);
  const preferAbove = args.end.row < args.anchor.row;
  const belowY = args.end.row + 1;
  const aboveY = args.end.row - h;
  const belowFits = belowY >= 0 && belowY + h <= args.rows;
  const aboveFits = aboveY >= 0 && aboveY + h <= args.rows;
  let side: "below" | "above";
  let y: number;
  if (preferAbove) {
    if (aboveFits) {
      side = "above";
      y = aboveY;
    } else if (belowFits) {
      side = "below";
      y = belowY;
    } else {
      side = "above";
      y = clamp(aboveY, 0, Math.max(0, args.rows - h));
    }
  } else if (belowFits) {
    side = "below";
    y = belowY;
  } else if (aboveFits) {
    side = "above";
    y = aboveY;
  } else {
    side = "below";
    y = clamp(belowY, 0, Math.max(0, args.rows - h));
  }
  const x = clamp(args.end.col - Math.floor((w - 1) / 2), 0, Math.max(0, args.cols - w));
  return { x, y, w, h, side };
}

export function paintCopyToast(
  buf: Buffer,
  place: CopyToastPlace,
  resolveStyle: (style: Style) => Style,
  text: string = COPY_TOAST_TEXT,
): void {
  const { x, y, w, h } = place;
  if (w < 1 || h < 1) return;
  const rim = resolveStyle({ role: "foreground", prominence: FgP.ghost });
  const ink = resolveStyle({ role: "foreground", prominence: FgP.primary });
  if (h === 1) {
    put(buf, x, y, clipToWidth(text, w), ink);
    return;
  }
  const bar = "─".repeat(Math.max(0, w - 2));
  const top = w >= 2 ? `${CHROME_FRAME_CORNERS.tl}${bar}${CHROME_FRAME_CORNERS.tr}` : "│";
  put(buf, x, y, top.slice(0, w), rim);
  if (h >= 3) {
    const bot = w >= 2 ? `${CHROME_FRAME_CORNERS.bl}${bar}${CHROME_FRAME_CORNERS.br}` : "│";
    put(buf, x, y + h - 1, bot.slice(0, w), rim);
  }
  const bodyY = y + 1;
  if (bodyY >= y + h) return;
  if (w < 2) {
    put(buf, x, bodyY, "│", rim);
    return;
  }
  put(buf, x, bodyY, "│", rim);
  put(buf, x + w - 1, bodyY, "│", rim);
  const inner = w - 2;
  if (inner > 0) put(buf, x + 1, bodyY, " ".repeat(inner), {});
  const label = clipToWidth(text, inner);
  const labelW = displayWidth(label);
  const left = Math.max(0, Math.floor((inner - labelW) / 2));
  put(buf, x + 1 + left, bodyY, label, ink);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clipToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let t = text;
  while (t.length > 0 && displayWidth(t) > width) t = t.slice(0, -1);
  return t;
}
