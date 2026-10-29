/**
 * Region prominence dimming — fade colors toward terminal ground.
 *
 * When a region is de-emphasized (modal backdrop, unfocused pane), both
 * fg and bg fade: apparent lightness toward ground, chroma by p^γ.
 * γ = ln(0.65)/ln(0.45): at overlay keep 0.45, chroma is 0.65 of source
 * (0.45^γ = 0.65).
 *
 * p == 1.0 is identity (no work). Transparent bg (absent) never dims.
 */

import { apparentLightness, hexToOklch, hexToRgb, oklchToHex, rgbToOklch, solveLightness } from "./salience.js";
import { type Rgb } from "../lexicon/index.js";

/** Closed-form chroma exponent: ln(0.65)/ln(0.45). */
export const REGION_GAMMA = Math.log(0.65) / Math.log(0.45);

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 1;
  return Math.min(1, Math.max(0, p));
}

function rgbToHex(rgb: Rgb): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((x) =>
      Math.max(0, Math.min(255, Math.round(x)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Fade a hex color toward ground OKLCH L at prominence p.
 * Returns new hex. At p=1 returns input unchanged (byte-identity path).
 */
export function regionDimHex(hex: string, groundL: number, prominence: number): string {
  const p = clamp01(prominence);
  if (p >= 1) return hex;
  if (p <= 0) {
    return oklchToHex(groundL, 0, 0);
  }
  const { l, c, h } = hexToOklch(hex);
  const al = apparentLightness(l, c, h);
  const fadedAl = groundL + (al - groundL) * p;
  const fadedC = c * p ** REGION_GAMMA;
  const fadedL = solveLightness(fadedAl, fadedC, h);
  return oklchToHex(fadedL, fadedC, h);
}

export function regionDimRgb(rgb: Rgb, groundL: number, prominence: number): Rgb {
  const p = clamp01(prominence);
  if (p >= 1) return rgb;
  return hexToRgb(regionDimHex(rgbToHex(rgb), groundL, p));
}

/**
 * Opacity substitute over an arbitrary **local surface** (panel, wash, cell
 * bg) — not only the terminal theme ground.
 *
 * At `p = 1` the fg is identity; at `p = 0` the result is the surface color
 * (true "into opacity" against that backdrop). Intermediate: apparent
 * lightness and chroma lerp toward the surface (chroma with REGION_GAMMA);
 * hue stays the fg's until fully dissolved so identity reads while fading.
 *
 * Use this whenever text sits on painted furniture. {@link regionDimRgb}
 * toward theme ground is wrong there — it dissolves into a different
 * color than the cell behind the glyph.
 */
export function fadeTowardSurfaceRgb(fg: Rgb, surface: Rgb, prominence: number, opts?: { chromaExp?: number }): Rgb {
  const p = clamp01(prominence);
  if (p >= 1) return { ...fg };
  if (p <= 0) return { ...surface };

  const f = rgbToOklch(fg.r, fg.g, fg.b);
  const s = rgbToOklch(surface.r, surface.g, surface.b);
  const fgAl = apparentLightness(f.l, f.c, f.h);
  const sAl = apparentLightness(s.l, s.c, s.h);
  const fadedAl = sAl + (fgAl - sAl) * p;
  // Default: region-dim γ (sublinear — chroma lingers). Fuse-into-contour
  // passes 2 so chroma dies faster than lightness (no late orange step).
  const exp = opts?.chromaExp ?? REGION_GAMMA;
  const tC = p ** exp;
  const fadedC = s.c + (f.c - s.c) * tC;
  // Hue: keep fg identity while any of the ink remains.
  const fadedH = f.h;
  const fadedL = solveLightness(fadedAl, fadedC, fadedH);
  return hexToRgb(oklchToHex(fadedL, fadedC, fadedH));
}

/**
 * Mix a fill toward a hotter role. Hue takes the tint's identity immediately
 * so chroma growth reads as one glow, not a hue sweep through red. Chroma
 * and apparent lightness lerp with `t`.
 */
export function mixTowardTintRgb(base: Rgb, tint: Rgb, t: number): Rgb {
  const p = typeof t === "number" && Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  if (p <= 0) return { ...base };
  if (p >= 1) return { ...tint };
  const b = rgbToOklch(base.r, base.g, base.b);
  const hot = rgbToOklch(tint.r, tint.g, tint.b);
  const bAl = apparentLightness(b.l, b.c, b.h);
  const hotAl = apparentLightness(hot.l, hot.c, hot.h);
  const fadedAl = bAl + (hotAl - bAl) * p;
  const fadedC = b.c + (hot.c - b.c) * p;
  const fadedH = hot.h;
  const fadedL = solveLightness(fadedAl, fadedC, fadedH);
  return hexToRgb(oklchToHex(fadedL, fadedC, fadedH));
}
