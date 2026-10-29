/**
 * UV-stamp a bgFx shader id onto a cell rect. Paint-time only — no GL.
 * Lives next to the cell fields so layout never imports internals/bgfx.
 */

export type BgFxMarkBuffer = {
  width: number;
  height: number;
  cells: Array<{
    ch: string;
    placeholder?: boolean;
    style: {
      bgFx?: string;
      bgFxU?: number;
      bgFxV?: number;
      bg?: number;
      bgRgb?: unknown;
      [key: string]: unknown;
    };
  }>;
};

export function fillBgFx(
  buf: BgFxMarkBuffer,
  rect: { x: number; y: number; w: number; h: number },
  id: string,
  scissor?: { x: number; y: number; w: number; h: number },
): void {
  const { x: rx, y: ry, w: rw, h: rh } = rect;
  if (rw <= 0 || rh <= 0) return;
  const { width: bw, height: bh, cells } = buf;

  for (let dy = 0; dy < rh; dy++) {
    const y = ry + dy;
    if (y < 0 || y >= bh) continue;
    if (scissor && (y < scissor.y || y >= scissor.y + scissor.h)) {
      continue;
    }
    const v = (dy + 0.5) / rh;
    for (let dx = 0; dx < rw; dx++) {
      const x = rx + dx;
      if (x < 0 || x >= bw) continue;
      if (scissor && (x < scissor.x || x >= scissor.x + scissor.w)) {
        continue;
      }
      const u = (dx + 0.5) / rw;
      const i = y * bw + x;
      const prev = cells[i]!;
      cells[i] = {
        ch: prev.ch && prev.ch !== " " ? prev.ch : " ",
        placeholder: prev.placeholder,
        style: {
          ...prev.style,
          bgFx: id,
          bgFxU: u,
          bgFxV: v,
          bg: undefined,
          bgRgb: undefined,
        },
      };
    }
  }
}
