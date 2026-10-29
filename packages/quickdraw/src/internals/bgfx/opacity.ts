/**
 * Global opacity for procedural backgrounds (quiet wash).
 *
 * Transparency means mix toward the **terminal ground color** (OSC 11),
 * not toward pure black — so light terminals and tinted themes stay coherent.
 *
 *   out = mix(ground, field, opacity)
 *   0 → ground · 1 → full field
 */

import { clampByte, mix } from "./types.js";
import { type Rgb, BgP } from "../../lexicon/index.js";

/**
 * Fallback only when OSC 11 was never set — not "the" ground.
 * Hosts should call `setBgFxGround` from probeOsc11 / theme.
 */
export const BGFX_DEFAULT_GROUND: Rgb = { r: 10, g: 10, b: 14 };

/**
 * Fixed per-channel nudge from ground for the "no field sample here"
 * sentinel (registry unknown-id, shadertoy null frame, shader-frame-host
 * bad-copy fill). Keeps the sentinel one truth with the live ground instead
 * of a hardcoded near-black that clashes with light terminals, while staying
 * non-zero so a zero-filled buffer is never mistaken for valid shader output
 * (see M1 note in shader-frame-host.ts).
 */
const NULL_FIELD_DELTA: Rgb = { r: 4, g: 4, b: 6 };

let opacity: number = BgP.mist;
let ground: Rgb = { ...BGFX_DEFAULT_GROUND };

export function setBgFxOpacity(o: number): void {
  if (!Number.isFinite(o)) return;
  opacity = Math.min(1, Math.max(0, o));
}

export function getBgFxOpacity(): number {
  return opacity;
}

/** Terminal background (0–255 sRGB), typically from OSC 11. */
export function setBgFxGround(rgb: Rgb): void {
  ground = {
    r: clampByte(rgb.r),
    g: clampByte(rgb.g),
    b: clampByte(rgb.b),
  };
}

/**
 * The `BGFX_NULL_FIELD` sentinel (color-hygiene plan, enabler 10) — the
 * single "nothing here" color for all bgFx no-field paths, replacing five
 * independent near-black literals. Ground-derived + `NULL_FIELD_DELTA`, so it
 * is a function (not a frozen constant): it must track `setBgFxGround` calls
 * rather than assume a dark terminal.
 */
export function getBgFxNullField(): Rgb {
  return {
    r: clampByte(ground.r + NULL_FIELD_DELTA.r),
    g: clampByte(ground.g + NULL_FIELD_DELTA.g),
    b: clampByte(ground.b + NULL_FIELD_DELTA.b),
  };
}

/**
 * Blend field sample toward terminal ground.
 * Per-cell `opacity` multiplies global opacity.
 * Explicit `ground` overrides the OSC11-attuned default for this call only.
 */
export function blendBgFx(
  field: Rgb,
  opts?: {
    opacity?: number;
    ground?: Rgb;
  },
): Rgb {
  const o = Math.min(1, Math.max(0, (opts?.opacity ?? 1) * opacity));
  const g = opts?.ground ?? ground;
  if (o >= 0.999) return field;
  if (o <= 0.001) return { ...g };
  return {
    r: clampByte(mix(g.r, field.r, o)),
    g: clampByte(mix(g.g, field.g, o)),
    b: clampByte(mix(g.b, field.b, o)),
  };
}
