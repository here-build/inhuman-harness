/**
 * Selection recolor — perception-preserving highlight via the HK salience
 * pipeline. NOT reverse-video, NOT alpha-blend of an opaque tint over content.
 *
 * Two channels, different jobs:
 *
 *  1. **FG** — identity-preserving active shift: lerp apparent lightness toward
 *     the anchor tier, **keep chroma** (hue stays exact — Zed #17313). The
 *     8–10% AL budget is for the *foreground*, not a prominence scalar.
 *
 *  2. **BG** — a real selection fill. Most terminal cells have no painted bg
 *     (transparent → terminal ground). Without a fill, selection is invisible
 *     except as a tiny fg delta. Fill is ground lifted toward a mild accent
 *     wash so the block reads as selected while remaining theme-coherent.
 *
 * The region-dim formula `c * p^γ` must NOT be reused with `p = SELECTION_SHIFT`.
 * Region prominence is "how much color remains" (1 = full, 0 = gone). Selection
 * shift is "how far to move AL" (0.09 = 9% of the way). Feeding 0.09 into the
 * prominence power law crushed chroma to ~27% and made selection look like
 * desaturated grey — the failure mode reported on the LLM-pick story.
 *
 * Shift budget (fg AL), from dark-theme design notes:
 *   "active states increase 8-10% lightness."
 */

import { apparentLightness, hexToRgb, oklchToHex, rgbToOklch, solveLightness, tierTarget } from "./salience.js";
import { type Rgb } from "../lexicon/index.js";

/**
 * Active-state lightness shift for **foreground** — fraction of the way from
 * current AL toward the selection target AL. 0.09 ≈ 9% (active-state budget).
 */
export const SELECTION_SHIFT = 0.09;

/**
 * How far to lift (dark themes) or drop (light themes) ground AL when minting
 * a selection fill. Large enough to read as a block highlight at a glance;
 * small enough not to compete with accent/emphasis content.
 */
export const SELECTION_FILL_AL_DELTA = 0.16;

/**
 * Mild chroma on the selection fill (OKLCH C). Accent-hue wash, not a neon
 * bar. 0.045 sits under most role chromas so selected text still wins.
 */
export const SELECTION_FILL_CHROMA = 0.045;

/**
 * Accent hue for the selection wash (OKLCH H). Matches seed `accent` (~242°
 * blue) so the fill feels like the same system, not a foreign reverse-video.
 */
export const SELECTION_FILL_HUE = 242;

/**
 * Target apparent lightness for selected **foreground**. Top of the tier
 * ladder (`anchor`) so selected text reads active without leaving the palette.
 */
export function selectionTargetAl(ground: number): number {
  return tierTarget("anchor", ground);
}

/**
 * Target apparent lightness for the selection **fill** (background).
 * Dark themes: lift ground up. Light themes: drop ground down. Symmetric
 * so selection remains visible under either polarity.
 */
export function selectionFillTargetAl(ground: number): number {
  if (ground < 0.5) {
    return Math.min(0.55, ground + SELECTION_FILL_AL_DELTA);
  }
  return Math.max(0.45, ground - SELECTION_FILL_AL_DELTA);
}

/**
 * Recolor a **foreground** sRGB color for selection.
 *
 * - Hue preserved EXACTLY.
 * - Chroma preserved (identity of colored content — diff-red stays red and
 *   saturated, not washed grey).
 * - Apparent lightness lerps toward the selection target by `shift`.
 * - At `shift === 0` the function is byte-identity.
 */
export function selectionRecolorRgb(rgb: Rgb, ground: number, shift: number = SELECTION_SHIFT): Rgb {
  if (!Number.isFinite(shift) || shift <= 0) return rgb;
  const t = Math.min(1, shift);
  const { l, c, h } = rgbToOklch(rgb.r, rgb.g, rgb.b);
  const al = apparentLightness(l, c, h);
  const targetAl = selectionTargetAl(ground);
  const newAl = al + (targetAl - al) * t;
  // Keep chroma. Region-dim's p^γ law does not apply here (see file header).
  const newC = c;
  const newL = solveLightness(newAl, newC, h);
  const hex = oklchToHex(newL, newC, h);
  return hexToRgb(hex);
}

/**
 * Mint a selection **fill** color from theme ground (and optional accent hue).
 * Used when a cell has no painted background (the common terminal case).
 */
export function selectionFillRgb(ground: number, opts: { hue?: number; chroma?: number } = {}): Rgb {
  const h = opts.hue ?? SELECTION_FILL_HUE;
  const c = opts.chroma ?? SELECTION_FILL_CHROMA;
  const al = selectionFillTargetAl(ground);
  const l = solveLightness(al, c, h);
  return hexToRgb(oklchToHex(l, c, h));
}

/**
/**
 * Minimum |ΔAL| between a painted bg and its selected recolor.
 * Same step as the empty-cell fill (`SELECTION_FILL_AL_DELTA`). The
 * toward-fill lerp alone lands ~0.063 on a wash — under the 0.074
 * brightness JND, so selection on a Diff row is invisible.
 */
export const SELECTION_BG_MIN_AL_STEP = SELECTION_FILL_AL_DELTA;

/**
 * Recolor an existing **background** for selection: lift/drop AL toward the
 * fill target, inject a mild accent chroma while preserving any strong
 * existing hue (so a colored panel bg stays itself, just selected).
 *
 * Painted cells cannot reuse the empty-cell fill target as the only aim —
 * elevation already sits near `ground ± 0.16`. Take the further of the
 * lerp and a minimum AL step so the block still reads as selected.
 */
export function selectionRecolorBgRgb(rgb: Rgb, ground: number, shift: number = 0.55): Rgb {
  if (!Number.isFinite(shift) || shift <= 0) return rgb;
  const t = Math.min(1, shift);
  const { l, c, h } = rgbToOklch(rgb.r, rgb.g, rgb.b);
  const al = apparentLightness(l, c, h);
  const targetAl = selectionFillTargetAl(ground);
  const towardFill = al + (targetAl - al) * t;
  const dark = ground < 0.5;
  const stepped = dark ? al + SELECTION_BG_MIN_AL_STEP : al - SELECTION_BG_MIN_AL_STEP;
  const newAl = dark ? Math.max(towardFill, stepped) : Math.min(towardFill, stepped);
  // If the bg is nearly achromatic, adopt the selection wash hue/chroma.
  // If it already carries color, keep its hue and blend chroma toward the wash.
  const achromatic = c < 0.01;
  const newH = achromatic ? SELECTION_FILL_HUE : h;
  const newC = achromatic ? SELECTION_FILL_CHROMA : c + (SELECTION_FILL_CHROMA - c) * (t * 0.5);
  const newL = solveLightness(newAl, newC, newH);
  return hexToRgb(oklchToHex(newL, newC, newH));
}
