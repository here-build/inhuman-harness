/**
 * Pure LayoutNode measure — single lineage for engine place/measure and structure HTML.
 * No paint, no hits. Geometry only.
 */

import { measureChromeFrame } from "./chrome_frame.js";
import { cellPadXY, resolveColumnTracks, tracksExtent } from "./grid.js";
import { INDICATION_CONTENT_INSET } from "./indication.js";
import { resolveLength } from "./length.js";
import { markdownToNodes } from "./markdown.js";
import { wrapLayoutText } from "./text.js";
import type { BoxStyle, FlexStyle, LayoutNode } from "./types.js";
import { defaultMeasure } from "../measure/index.js";

export type MeasureFn = (text: string) => number;

export function pad(p: BoxStyle["padding"] | FlexStyle["padding"]): {
  t: number;
  r: number;
  b: number;
  l: number;
} {
  if (p === undefined) return { t: 0, r: 0, b: 0, l: 0 };
  if (typeof p === "number") {
    const n = Math.max(0, Math.floor(p));
    return { t: n, r: n, b: n, l: n };
  }
  return {
    t: Math.max(0, p.t ?? 0),
    r: Math.max(0, p.r ?? 0),
    b: Math.max(0, p.b ?? 0),
    l: Math.max(0, p.l ?? 0),
  };
}

export function clamp0(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Longest space-delimited token — wrapText's unbreakable unit. */
function longestToken(text: string, measure: MeasureFn): number {
  let max = 0;
  for (const token of text.split(/\s+/)) {
    if (token.length > 0) max = Math.max(max, measure(token));
  }
  return max;
}

function cellPlainText(node: LayoutNode): string {
  switch (node.type) {
    case "text":
      return node.content;
    case "box":
    case "flex":
    case "grid":
    case "viewport":
    case "indication":
    case "indentation_exception":
    case "overlay":
      return (node.children ?? []).map(cellPlainText).join("");
    case "disclosure":
      return node.collapsed === false ? (node.children ?? []).map(cellPlainText).join("") : cellPlainText(node.summary);
    case "markdown":
      return node.content;
    default:
      return "";
  }
}

/** Min-content of a cell: longest unbreakable token in display columns. */
function minContentWidth(node: LayoutNode, measure: MeasureFn): number {
  return longestToken(cellPlainText(node), measure);
}

/**
 * Measure a LayoutNode into cell units — same algorithm as engine layout.
 */
export function measureNode(
  node: LayoutNode,
  maxW: number,
  maxH: number,
  measure: MeasureFn = defaultMeasure,
): { w: number; h: number } {
  const stamp = node.measured;
  if (stamp && stamp.atW === maxW) {
    return { w: clamp0(Math.min(maxW, stamp.w)), h: clamp0(Math.min(maxH, stamp.h)) };
  }
  switch (node.type) {
    case "text": {
      const wrapped = wrapLayoutText(node, maxW, measure);
      const w = Math.min(maxW, Math.max(1, wrapped.maxLine));
      return { w, h: Math.min(maxH, wrapped.lines.length) };
    }
    case "raw":
      return {
        w: Math.min(maxW, node.w ?? maxW),
        h: Math.min(maxH, node.h ?? 1),
      };
    case "box": {
      const style = node.style ?? {};
      const pd = pad(style.padding);
      const border = style.border ? 1 : 0;
      const innerW = Math.max(0, maxW - pd.l - pd.r - border * 2);
      const innerH = Math.max(0, maxH - pd.t - pd.b - border * 2);
      let cw = 0;
      let ch = 0;
      for (const child of node.children ?? []) {
        const m = measureNode(child, innerW, innerH, measure);
        cw = Math.max(cw, m.w);
        ch += m.h;
      }
      let w =
        resolveLength(style.width, maxW) === "auto"
          ? cw + pd.l + pd.r + border * 2
          : (resolveLength(style.width, maxW) as number);
      let h =
        resolveLength(style.height, maxH) === "auto"
          ? ch + pd.t + pd.b + border * 2
          : (resolveLength(style.height, maxH) as number);
      w = clamp0(Math.min(maxW, w));
      h = clamp0(Math.min(maxH, h));
      return { w, h };
    }
    case "flex": {
      const style = node.style ?? {};
      const dir = style.direction === "column" || style.direction === "column_reverse" ? "column" : "row";
      const gap = clamp0(style.gap ?? 0);
      const pd = pad(style.padding);
      const innerW = Math.max(0, maxW - pd.l - pd.r);
      const innerH = Math.max(0, maxH - pd.t - pd.b);
      const children = node.children ?? [];
      if (dir === "row") {
        let sum = 0;
        let maxCross = 0;
        for (const [i, c] of children.entries()) {
          const m = measureNode(c, innerW, innerH, measure);
          sum += m.w + (i > 0 ? gap : 0);
          maxCross = Math.max(maxCross, m.h);
        }
        return {
          w: Math.min(maxW, sum + pd.l + pd.r),
          h: Math.min(maxH, maxCross + pd.t + pd.b),
        };
      }
      let sum = 0;
      let maxCross = 0;
      for (const [i, c] of children.entries()) {
        const m = measureNode(c, innerW, innerH, measure);
        sum += m.h + (i > 0 ? gap : 0);
        maxCross = Math.max(maxCross, m.w);
      }
      const w =
        resolveLength(style.width, maxW) === "auto"
          ? maxCross + pd.l + pd.r
          : (resolveLength(style.width, maxW) as number);
      const h =
        resolveLength(style.height, maxH) === "auto"
          ? sum + pd.t + pd.b
          : (resolveLength(style.height, maxH) as number);
      return {
        w: clamp0(Math.min(maxW, w)),
        h: clamp0(Math.min(maxH, h)),
      };
    }
    case "grid": {
      return measureGrid(node, maxW, maxH, measure);
    }
    case "viewport": {
      const style = node.style ?? {};
      const w = resolveLength(style.width, maxW) === "auto" ? maxW : (resolveLength(style.width, maxW) as number);
      const h = resolveLength(style.height, maxH) === "auto" ? maxH : (resolveLength(style.height, maxH) as number);
      return { w: clamp0(w), h: clamp0(h) };
    }
    case "indication": {
      const innerW = Math.max(1, maxW - INDICATION_CONTENT_INSET);
      let ch = 0;
      let cw = 0;
      for (const child of node.children ?? []) {
        const m = measureNode(child, innerW, maxH, measure);
        cw = Math.max(cw, m.w);
        ch += m.h;
      }
      return {
        w: Math.min(maxW, cw + INDICATION_CONTENT_INSET),
        h: Math.min(maxH, Math.max(1, ch)),
      };
    }
    case "indentation_exception": {
      let ch = 0;
      let cw = 0;
      for (const child of node.children ?? []) {
        const m = measureNode(child, maxW, maxH, measure);
        cw = Math.max(cw, m.w);
        ch += m.h;
      }
      return { w: Math.min(maxW, cw), h: Math.min(maxH, Math.max(1, ch)) };
    }
    case "disclosure": {
      const kids = node.collapsed === false ? (node.children ?? []) : [node.summary];
      let ch = 0;
      let cw = 0;
      for (const child of kids) {
        const m = measureNode(child, maxW, maxH, measure);
        cw = Math.max(cw, m.w);
        ch += m.h;
      }
      return { w: Math.min(maxW, cw), h: Math.min(maxH, Math.max(1, ch)) };
    }
    case "markdown": {
      const kids = markdownToNodes(node.content, {
        key: node.key,
        baseStyle: node.style,
      });
      let ch = 0;
      let cw = 0;
      for (const child of kids) {
        const m = measureNode(child, maxW, maxH, measure);
        cw = Math.max(cw, m.w);
        ch += m.h;
      }
      return {
        w: Math.min(maxW, Math.max(1, cw)),
        h: Math.min(maxH, Math.max(1, ch)),
      };
    }
    case "diff": {
      // Hole: product render expands before layout. Direct layout() → empty.
      const w = Math.min(maxW, Math.max(1, node.width | 0));
      return { w, h: 1 };
    }
    case "chrome_frame": {
      // Fixed-width chrome; height from wrap lineage (chrome_frame.ts).
      const g = measureChromeFrame(node, maxW, maxH);
      return { w: g.outerW, h: g.totalH };
    }
    case "overlay":
      return { w: maxW, h: maxH };
    default: {
      const _x: never = node;
      void _x;
      return { w: 0, h: 0 };
    }
  }
}

/** Shared grid geometry for measure + place (engine imports measureGridDims). */
export function measureGrid(
  node: Extract<LayoutNode, { type: "grid" }>,
  maxW: number,
  maxH: number,
  measure: MeasureFn = defaultMeasure,
): { w: number; h: number } {
  const dims = measureGridDims(node, maxW, measure);
  const w =
    resolveLength(node.style.width, maxW) === "auto" ? dims.totalW : (resolveLength(node.style.width, maxW) as number);
  const h =
    resolveLength(node.style.height, maxH) === "auto"
      ? dims.totalH
      : (resolveLength(node.style.height, maxH) as number);
  return {
    w: clamp0(Math.min(maxW, w)),
    h: clamp0(Math.min(maxH, h)),
  };
}

export type GridDims = {
  colWidths: number[];
  rowHeights: number[];
  colGap: number;
  rowGap: number;
  padX: number;
  padY: number;
  nCols: number;
  nRows: number;
  totalW: number;
  totalH: number;
};

/**
 * Resolve grid tracks + row heights. Place reuses this so measure/paint agree.
 */
export function measureGridDims(
  node: Extract<LayoutNode, { type: "grid" }>,
  maxW: number,
  measure: MeasureFn = defaultMeasure,
): GridDims {
  const style = node.style;
  // Empty columns: synthesize one `auto` track so nCols and colWidths stay aligned.
  // resolveColumnTracks([]) returns [] while we still floor nCols to ≥1; indexing
  // colWidths[0] then yields undefined → NaN cell geometry (totalW/innerW).
  const tracks = style.columns.length > 0 ? style.columns : (["auto"] as "auto"[]);
  const nCols = tracks.length;
  const lines = style.lines ?? "none";
  const colGap = clamp0(style.columnGap ?? (lines === "inner" ? 1 : 0));
  const rowGap = clamp0(style.rowGap ?? (lines === "inner" ? 1 : 0));
  const { x: padX, y: padY } = cellPadXY(style.cellPad);
  const children = node.children ?? [];
  const nRows = Math.max(1, Math.ceil(children.length / nCols));

  // Max-content: unconstrained cell width. Min-content: longest unbreakable
  // token. Pad is on both so auto tracks include breathing room.
  const contentMax = new Array<number>(nCols).fill(0);
  const contentMin = new Array<number>(nCols).fill(0);
  const cellHs: number[] = [];
  const probeW = Math.max(maxW, 10_000);
  for (const [i, child] of children.entries()) {
    const col = i % nCols;
    const m = measureNode(child!, probeW, 10_000, measure);
    contentMax[col] = Math.max(contentMax[col]!, m.w + padX * 2);
    contentMin[col] = Math.max(contentMin[col]!, minContentWidth(child!, measure) + padX * 2);
    cellHs[i] = m.h + padY * 2;
  }
  for (let c = 0; c < nCols; c++) {
    contentMin[c] = Math.min(contentMin[c]!, contentMax[c]!);
  }
  // empty cells still need a row height floor
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const idx = r * nCols + c;
      if (cellHs[idx] === undefined) cellHs[idx] = Math.max(1, padY * 2 || 1);
    }
  }

  const availableW = resolveLength(style.width, maxW) === "auto" ? maxW : (resolveLength(style.width, maxW) as number);

  const colWidths = resolveColumnTracks(tracks, contentMax, availableW, colGap, contentMin);

  // Re-measure cells against assigned column inner width for multi-line height
  const rowHeights = new Array<number>(nRows).fill(1);
  for (let r = 0; r < nRows; r++) {
    let rh = 1;
    for (let c = 0; c < nCols; c++) {
      const idx = r * nCols + c;
      const child = children[idx];
      if (!child) {
        rh = Math.max(rh, Math.max(1, padY * 2 || 1));
        continue;
      }
      const innerW = Math.max(1, colWidths[c]! - padX * 2);
      const m = measureNode(child, innerW, 10_000, measure);
      rh = Math.max(rh, m.h + padY * 2);
    }
    rowHeights[r] = rh;
  }

  return {
    colWidths,
    rowHeights,
    colGap,
    rowGap,
    padX,
    padY,
    nCols,
    nRows,
    totalW: tracksExtent(colWidths, colGap),
    totalH: tracksExtent(rowHeights, rowGap),
  };
}
