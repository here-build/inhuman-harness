/**
 * Helmholtz–Kohlrausch salience solver.
 *
 * Palette seeds are (hue, chroma, tier). Each tier is an apparent-lightness
 * contrast delta from ground; the solver compensates H-K so chromatic colors
 * match achromatic brightness on the same tier.
 *
 *   perceived_AL = L + 0.14 · C · hue_factor(h)   // chromatic looks brighter
 *   L_nominal    = target_AL − 0.14 · C · hue_factor(h)
 *
 * Hue weight is the **Nayatani 3-harmonic** (SSOT: Delta foundation.css +
 * postcss-oklch-plus / helmholtz-kohlrausch-models.md).
 *
 * Ground is runtime input — pair with OSC 11 for terminal-attuned palettes.
 * Color math via culori (OKLCH ↔ sRGB).
 */

import { converter, formatHex, parse } from "culori";
import invariant from "tiny-invariant";

// SSOT is ../lexicon/index.js; import for local use + re-export.
import type { Oklch, Polarity, Rgb, Tier } from "../lexicon/index.js";

const toOklch = converter("oklch");
const toRgb = converter("rgb");

/** H-K chroma scale (≈ Fairchild–Pirrotta k; magnitude is Delta's budget). */
export const HK_K = 0.14;

/**
 * Apparent-lightness contrast deltas per tier at the reference ground.
 * At L_ground = 0.2 these target recede≈0.55 … anchor≈0.85.
 * Tier names are vocabulary (../lexicon/index.js); the deltas are
 * solver calibration and live here.
 */
export const TIER_DELTAS = {
  alarm: 0.33,
  recede: 0.35,
  differentiate: 0.42,
  baseline: 0.57,
  anchor: 0.65,
} as const satisfies Record<Tier, number>;

/** Reference near-black ground the tier deltas were derived against. */
export const REFERENCE_GROUND = 0.2;

const AL_MIN = 0.03;
const AL_MAX = 0.97;
const MAX_DELTA = 0.65;

/**
 * Nayatani-1997 VAC hue weight — 3-harmonic Fourier fit in OKLCH hue degrees.
 * SSOT coefficients: delta/delta-css foundation.css `--🧮hue-factor` and
 * commons/packages/postcss-oklch-plus `nayataniHueFactor` (R²≈0.98 vs VAC q(θ),
 * mean 0.779 preserves Delta compensation budget).
 * Inherently ~[0.54, 0.92] — no clamp.
 */
const NAY_A0 = 0.779_11;
const NAY_COS = [0.080_91, 0.062_02, -0.014_15] as const;
const NAY_SIN = [-0.135_93, -0.003_65, 0.033_77] as const;

export function hueFactor(h: number): number {
  let v = NAY_A0;
  const rad = (h * Math.PI) / 180;
  for (let k = 1; k <= 3; k++) {
    const r = k * rad;
    v += NAY_COS[k - 1]! * Math.cos(r) + NAY_SIN[k - 1]! * Math.sin(r);
  }
  return v;
}

/** Amount of L to subtract so a chromatic color sits level with gray at same L. */
export function hkCompensation(c: number, h: number): number {
  return HK_K * Math.max(0, c) * hueFactor(h);
}

/**
 * Perceived / apparent lightness (chromatic looks *brighter* than measured L).
 * Inverse of solveLightness for fixed (C,h).
 */
export function apparentLightness(l: number, c: number, h: number): number {
  return l + hkCompensation(c, h);
}

/**
 * Nominal OKLCH L that lands (C, h) on a target apparent lightness.
 * Chromatic → lower measured L (same as bake-darcula / Delta CSS subtract).
 */
export function solveLightness(targetAl: number, c: number, h: number): number {
  return targetAl - hkCompensation(c, h);
}

function resolvePolaritySign(ground: number, polarity: Polarity): 1 | -1 {
  if (polarity === "up") return 1;
  if (polarity === "down") return -1;
  return ground < 0.5 ? 1 : -1;
}

/**
 * Target apparent lightness for a tier against ground, with headroom
 * compression when the ground leaves less than the full delta range.
 */
export function tierTarget(tier: Tier, ground: number, polarity: Polarity = "auto"): number {
  const sign = resolvePolaritySign(ground, polarity);
  const headroom = sign === 1 ? AL_MAX - ground : ground - AL_MIN;
  const scale = Math.min(1, Math.max(0, headroom / MAX_DELTA));
  return ground + sign * TIER_DELTAS[tier] * scale;
}

export type SolveOpts = {
  ground?: number;
  polarity?: Polarity;
};

/**
 * Solve (C, h) on a salience tier against ground → sRGB hex.
 */
export function solve(tier: Tier, c: number, h: number, opts: SolveOpts = {}): string {
  const ground = opts.ground ?? REFERENCE_GROUND;
  const polarity = opts.polarity ?? "auto";
  const target = tierTarget(tier, ground, polarity);
  const l = solveLightness(target, c, h);
  return oklchToHex(l, c, h);
}

export type Seed = {
  name: string;
  h: number;
  c: number;
  tier: Tier;
};

/** Solve a seed list into `{ name → hex }`. */
export function solvePalette(seeds: readonly Seed[], opts: SolveOpts = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of seeds) {
    out[s.name] = solve(s.tier, s.c, s.h, opts);
  }
  return out;
}

/**
 * True when OKLCH (l,c,h) is inside sRGB (linear channels in [0,1]).
 * Culori `formatHex` / RGB conversion is *not* this check — it channel-clips.
 */
export function inSrgb(l: number, c: number, h: number): boolean {
  const rgb = toRgb({
    mode: "oklch",
    l,
    c: Math.max(0, c),
    h,
  });
  if (!rgb) return false;
  const eps = 1e-4;
  return rgb.r >= -eps && rgb.r <= 1 + eps && rgb.g >= -eps && rgb.g <= 1 + eps && rgb.b >= -eps && rgb.b <= 1 + eps;
}

/**
 * Map OKLCH into sRGB by shrinking chroma at fixed hue, then re-solving L
 * so H-K apparent lightness matches the request. Channel-clip (culori
 * formatHex, nearest-legal RGB) rotates hue — yellow at low L becomes
 * rust `#542400` (h 77 → 51). We never do that.
 */
export function fitOklchToSrgb(l: number, c: number, h: number): { l: number; c: number; h: number } {
  const clampedL = Math.min(0.999, Math.max(0.001, l));
  const reqC = Math.max(0, c);
  if (reqC === 0 || inSrgb(clampedL, reqC, h)) {
    return { l: clampedL, c: reqC, h };
  }
  const targetAl = apparentLightness(clampedL, reqC, h);
  let lo = 0;
  let hi = reqC;
  let bestL = Math.min(0.999, Math.max(0.001, solveLightness(targetAl, 0, h)));
  let bestC = 0;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const lMid = Math.min(0.999, Math.max(0.001, solveLightness(targetAl, mid, h)));
    if (inSrgb(lMid, mid, h)) {
      bestC = mid;
      bestL = lMid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { l: bestL, c: bestC, h };
}

export function oklchToHex(l: number, c: number, h: number): string {
  const fitted = fitOklchToSrgb(l, c, h);
  const hex = formatHex({
    mode: "oklch",
    l: fitted.l,
    c: fitted.c,
    h: fitted.h,
  });
  if (!hex) {
    return formatHex({ mode: "oklch", l: fitted.l, c: 0, h: 0 }) ?? "#808080";
  }
  return hex;
}

export function hexToOklch(hex: string): Oklch {
  const parsed = parse(hex.startsWith("#") ? hex : `#${hex}`);
  invariant(parsed, `invalid hex color: ${hex}`);
  const o = toOklch(parsed);
  invariant(o, `oklch convert failed: ${hex}`);
  invariant(o.l !== undefined, `oklch convert missing L: ${hex}`);
  return {
    l: o.l,
    c: o.c ?? 0,
    h: o.h ?? 0,
  };
}

export function hexToRgb(hex: string): Rgb {
  const parsed = parse(hex.startsWith("#") ? hex : `#${hex}`);
  invariant(parsed, `invalid hex color: ${hex}`);
  const r = toRgb(parsed);
  invariant(r, `rgb convert failed: ${hex}`);
  return {
    r: Math.round(Math.min(1, Math.max(0, r.r ?? 0)) * 255),
    g: Math.round(Math.min(1, Math.max(0, r.g ?? 0)) * 255),
    b: Math.round(Math.min(1, Math.max(0, r.b ?? 0)) * 255),
  };
}

/** sRGB → OKLCH L from 0–255 channel triple (OSC 11 ground path). */
export function rgbToOklch(r: number, g: number, b: number): Oklch {
  const o = toOklch({
    mode: "rgb",
    r: r / 255,
    g: g / 255,
    b: b / 255,
  });
  invariant(o, `oklch convert failed for rgb(${r},${g},${b})`);
  invariant(o.l !== undefined, `oklch convert missing L for rgb(${r},${g},${b})`);
  return { l: o.l, c: o.c ?? 0, h: o.h ?? 0 };
}
