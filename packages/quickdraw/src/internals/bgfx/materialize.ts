/**
 * Present-time expansion of bgFx markers → bgRgb only.
 *
 * Cells store a shader id; present shades the field and writes truecolor
 * backgrounds. No glyph / sub-cell packing — terminals that can't paint
 * dense block+fg/bg at 30fps stay out of scope.
 */

import { blendBgFx, getBgFxNullField } from "./opacity.js";
import { getBgFxShader } from "./registry.js";
import type { BgFxEnv, BgFxId } from "./types.js";
import type { Rgb } from "../../lexicon/index.js";

export type BgFxCell = {
  ch: string;
  style: {
    bgFx?: BgFxId;
    bgFxU?: number;
    bgFxV?: number;
    /** Multiplies global opacity (0–1). */
    bgFxOpacity?: number;
    bgRgb?: Rgb;
    bg?: number;
    [k: string]: unknown;
  };
  placeholder?: boolean;
};

export type BgFxBuffer = {
  width: number;
  height: number;
  cells: BgFxCell[];
};

export function bufferHasBgFx(buf: BgFxBuffer): boolean {
  for (let i = 0; i < buf.cells.length; i++) {
    if (buf.cells[i]!.style.bgFx) return true;
  }
  return false;
}

function normalizeEnv(buf: BgFxBuffer, envOrT: number | BgFxEnv): BgFxEnv {
  if (typeof envOrT === "number") {
    return {
      t: envOrT,
      resolution: { x: buf.width, y: buf.height },
    };
  }
  return {
    t: envOrT.t,
    resolution: envOrT.resolution ?? { x: buf.width, y: buf.height },
    mouse: envOrT.mouse,
    polarity: envOrT.polarity,
  };
}

type CellRef = {
  i: number;
  x: number;
  y: number;
  id: BgFxId;
};

function collectCells(buf: BgFxBuffer): CellRef[] {
  const { width: w, height: h, cells } = buf;
  const out: CellRef[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const id = cells[i]!.style.bgFx;
      if (!id) continue;
      out.push({ i, x, y, id });
    }
  }
  return out;
}

function applyRgb(buf: BgFxBuffer, i: number, field: Rgb): void {
  const cell = buf.cells[i]!;
  const per = typeof cell.style.bgFxOpacity === "number" ? cell.style.bgFxOpacity : undefined;
  // Toward terminal ground (setBgFxGround / OSC 11), not pure black
  cell.style.bgRgb = blendBgFx(field, { opacity: per });
  if (cell.style.bg !== undefined) delete cell.style.bg;
}

function materializeCollected(buf: BgFxBuffer, cells: CellRef[], env: BgFxEnv): number {
  if (cells.length === 0) return 0;

  const byId = new Map<BgFxId, CellRef[]>();
  for (const c of cells) {
    let list = byId.get(c.id);
    if (!list) {
      list = [];
      byId.set(c.id, list);
    }
    list.push(c);
  }

  let n = 0;
  const nullField = getBgFxNullField();

  for (const [id, refs] of byId) {
    const prog = getBgFxShader(id);
    if (!prog?.renderFrame) {
      for (const r of refs) {
        applyRgb(buf, r.i, nullField);
        n += 1;
      }
      continue;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const r of refs) {
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x > maxX) maxX = r.x;
      if (r.y > maxY) maxY = r.y;
    }
    const cellsW = maxX - minX + 1;
    const cellsH = maxY - minY + 1;
    const frameEnv: BgFxEnv = {
      ...env,
      resolution: { x: cellsW, y: cellsH },
    };
    const frame = prog.renderFrame(cellsW, cellsH, frameEnv);
    for (const r of refs) {
      const px = Math.min(frame.width - 1, Math.max(0, r.x - minX));
      const py = Math.min(frame.height - 1, Math.max(0, r.y - minY));
      const o = (py * frame.width + px) * 4;
      applyRgb(buf, r.i, {
        r: frame.rgba[o]!,
        g: frame.rgba[o + 1]!,
        b: frame.rgba[o + 2]!,
      });
      n += 1;
    }
  }

  return n;
}

export function materializeBgFx(buf: BgFxBuffer, envOrT: number | BgFxEnv): number {
  if (buf.width <= 0 || buf.height <= 0) return 0;
  const cells = collectCells(buf);
  if (cells.length === 0) return 0;
  return materializeCollected(buf, cells, normalizeEnv(buf, envOrT));
}
