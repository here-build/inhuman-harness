/**
 * Headless present: LayoutNode → cells. Screenshots force truecolor so
 * CI NO_COLOR cannot demote the palette. Clock is frozen.
 */
import { bufferToPng } from "./screenshot.js";
import { clear, createBuffer, type Buffer as CellBuffer } from "../buffer/index.js";
import { attuneTheme, layout, paintFrame, type LayoutNode } from "../layout/index.js";
import { expandWidgetPriors } from "../widgets/expand.js";

/** Frozen clock for screenshots. Same epoch as storybook paint. */
export const SCREENSHOT_NOW_MS = 1_700_000_000_000;

export type RasterFrame = {
  buffer: CellBuffer;
  chars: string[];
  groundHex: string;
};

export function rasterFrame(
  node: LayoutNode,
  cols: number,
  rows: number,
  opts: { nowMs?: number; birth?: ReadonlyMap<string, number> } = {},
): RasterFrame {
  const { paint, theme } = attuneTheme({ depth: "truecolor" });
  const expanded = expandWidgetPriors(node, { width: cols });
  const frame = layout(expanded, { w: cols, h: rows });
  const buf = createBuffer(cols, rows);
  clear(buf);
  paintFrame(frame, buf, paint, {
    nowMs: opts.nowMs ?? SCREENSHOT_NOW_MS,
    birth: opts.birth,
  });
  return { buffer: buf, chars: bufferRows(buf), groundHex: theme.groundHex };
}

export function rasterLayout(
  node: LayoutNode,
  cols: number,
  rows: number,
  opts: { nowMs?: number; birth?: ReadonlyMap<string, number> } = {},
): string[] {
  return rasterFrame(node, cols, rows, opts).chars;
}

/** Truecolor PNG of the product column. No TTY. */
export function rasterPng(
  node: LayoutNode,
  cols: number,
  rows: number,
  opts: { nowMs?: number; birth?: ReadonlyMap<string, number> } = {},
): Buffer {
  const frame = rasterFrame(node, cols, rows, opts);
  return bufferToPng(frame.buffer, frame.groundHex);
}

export function bufferRows(buf: CellBuffer): string[] {
  const rows: string[] = [];
  for (let y = 0; y < buf.height; y += 1) {
    let row = "";
    for (let x = 0; x < buf.width; x += 1) {
      const cell = buf.cells[y * buf.width + x];
      row += cell?.placeholder ? "" : (cell?.ch ?? " ");
    }
    rows.push(row.replace(/\s+$/u, ""));
  }
  return rows;
}
