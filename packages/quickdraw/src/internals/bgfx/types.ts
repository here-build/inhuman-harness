/**
 * Procedural cell backgrounds = GLSL color-field shaders.
 *
 * Product path: headless-gl (`renderFrame`) via shadertoy catalog / worker.
 */

/** Shader program id. Open string — not a closed enum. */
export type BgFxId = string;

/** Re-export — single source of truth is ../../capabilities/index.js. */

/**
 * Frame uniforms — Shadertoy-shaped so ports map 1:1 in spirit:
 *   iTime ← t, iResolution ← resolution, iMouse ← mouse
 */
export type BgFxEnv = {
  /** Seconds (iTime). */
  t: number;
  /** Field size in cells or pixels of the region (iResolution.xy). */
  resolution: { x: number; y: number };
  /**
   * Optional pointer (iMouse): xy = current, zw = click anchor / press.
   * Absent → program uses zeros.
   */
  mouse?: { x: number; y: number; z: number; w: number };
  /**
   * Canvas polarity. Shadertoy `iPolarity` is +1 on dark ground, −1 on light
   * so mixes/steering invert with the theme instead of staying "lighter = up".
   */
  polarity?: "dark" | "light";
};

/** Full-frame RGBA (top-left origin) from a frame shader. */
export type BgFxFrame = {
  width: number;
  height: number;
  /** length = width * height * 4 */
  rgba: Uint8Array;
};

/** One registered color field — `renderFrame` is required. */
export type BgFxProgram = {
  id: BgFxId;
  renderFrame: (w: number, h: number, env: BgFxEnv) => BgFxFrame;
};

export function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
