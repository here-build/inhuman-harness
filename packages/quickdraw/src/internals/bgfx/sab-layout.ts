/**
 * SharedArrayBuffer layout for off-thread field frames (bg only).
 *
 * Double-buffered RGBA + seqlocks. Dimensions are cell grid (1 sample / cell).
 */

export const HDR_W = 0;
export const HDR_H = 1;
export const HDR_FRONT = 2;
export const HDR_SEQ0 = 3;
export const HDR_SEQ1 = 4;
export const HDR_FRAME_MS = 5;
export const HDR_STATUS = 6;
export const HDR_GEN = 7;
export const HDR_SLOTS = 16;

export const STATUS_BOOT = 0;
export const STATUS_OK = 1;
export const STATUS_ERR = 2;

export const ENV_T = 0;
export const ENV_MX = 1;
export const ENV_MY = 2;
export const ENV_MZ = 3;
export const ENV_MW = 4;
/** +1 dark canvas, −1 light — Shadertoy iPolarity. */
export const ENV_POLARITY = 5;
export const ENV_FLOATS = 8;

export const ENV_W = 0;
export const ENV_H = 1;
export const ENV_INTS = 4;

export function headerBytes(): number {
  return HDR_SLOTS * 4;
}

export function slotBytes(w: number, h: number): number {
  return Math.max(1, w) * Math.max(1, h) * 4;
}

export function pixelSabBytes(w: number, h: number): number {
  return headerBytes() + 2 * slotBytes(w, h);
}

export function envSabBytes(): number {
  return ENV_FLOATS * 4 + ENV_INTS * 4;
}

export function slotOffset(w: number, h: number, slot: 0 | 1): number {
  return headerBytes() + slot * slotBytes(w, h);
}

export type PixelViews = {
  sab: SharedArrayBuffer;
  hdr: Int32Array;
  bytes: Uint8Array;
};

export function openPixelViews(sab: SharedArrayBuffer): PixelViews {
  return {
    sab,
    hdr: new Int32Array(sab, 0, HDR_SLOTS),
    bytes: new Uint8Array(sab),
  };
}

export type EnvViews = {
  sab: SharedArrayBuffer;
  f32: Float32Array;
  i32: Int32Array;
};

export function openEnvViews(sab: SharedArrayBuffer): EnvViews {
  const f32 = new Float32Array(sab, 0, ENV_FLOATS);
  const i32 = new Int32Array(sab, ENV_FLOATS * 4, ENV_INTS);
  return { sab, f32, i32 };
}

export function writeEnv(
  env: EnvViews,
  opts: {
    t: number;
    w: number;
    h: number;
    mouse?: { x: number; y: number; z: number; w: number };
    polarity?: "dark" | "light";
  },
): void {
  const m = opts.mouse ?? { x: 0, y: 0, z: 0, w: 0 };
  env.f32[ENV_T] = opts.t;
  env.f32[ENV_MX] = m.x;
  env.f32[ENV_MY] = m.y;
  env.f32[ENV_MZ] = m.z;
  env.f32[ENV_MW] = m.w;
  env.f32[ENV_POLARITY] = opts.polarity === "light" ? -1 : 1;
  Atomics.store(env.i32, ENV_W, opts.w);
  Atomics.store(env.i32, ENV_H, opts.h);
  // ENV_RESERVED left untouched — no reader; avoid false "change" noise.
}

export function beginSlotWrite(hdr: Int32Array, slot: 0 | 1): void {
  const seqIdx = slot === 0 ? HDR_SEQ0 : HDR_SEQ1;
  const seq = Atomics.load(hdr, seqIdx);
  Atomics.store(hdr, seqIdx, seq | 1);
}

export function endSlotWrite(hdr: Int32Array, slot: 0 | 1, frameMs: number): void {
  const seqIdx = slot === 0 ? HDR_SEQ0 : HDR_SEQ1;
  const seq = Atomics.load(hdr, seqIdx);
  Atomics.store(hdr, seqIdx, (seq | 1) + 1);
  Atomics.store(hdr, HDR_FRONT, slot);
  Atomics.store(hdr, HDR_FRAME_MS, Math.round(frameMs));
  Atomics.add(hdr, HDR_GEN, 1);
  Atomics.store(hdr, HDR_STATUS, STATUS_OK);
}

export function copyFrontFrame(views: PixelViews, out: Uint8Array, expectW: number, expectH: number): boolean {
  const { hdr, bytes } = views;
  const w = Atomics.load(hdr, HDR_W);
  const h = Atomics.load(hdr, HDR_H);
  if (w !== expectW || h !== expectH || w <= 0 || h <= 0) return false;

  const need = w * h * 4;
  if (out.length < need) return false;

  for (let attempt = 0; attempt < 8; attempt++) {
    const front = Atomics.load(hdr, HDR_FRONT) as 0 | 1;
    if (front !== 0 && front !== 1) return false;
    const seqIdx = front === 0 ? HDR_SEQ0 : HDR_SEQ1;
    const s1 = Atomics.load(hdr, seqIdx);
    if (s1 & 1) continue;
    const off = slotOffset(w, h, front);
    out.set(bytes.subarray(off, off + need));
    const s2 = Atomics.load(hdr, seqIdx);
    if (s1 === s2 && (s2 & 1) === 0) return true;
  }
  return false;
}
