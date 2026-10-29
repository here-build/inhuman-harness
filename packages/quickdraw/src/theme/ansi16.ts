/**
 * Polarity-preserving ANSI16 degradation for semantic roles.
 *
 * Nearest-RGB quantization collapses hue (error→yellow, etc.). This table
 * pins each role to a hue-preserving slot so category is never lost.
 * Legibility > category preservation > tier separation.
 *
 * Literal RGB (syntax highlight, no role) degrades via nearest-RGB on the
 * classic 0–15 xterm palette — hue-preserving slots stay role-only.
 */

import invariant from "tiny-invariant";

import { REFERENCE_GROUND } from "./salience.js";
import type { Rgb, SemanticRole } from "../lexicon/index.js";

export type CanvasPolarity = "dark" | "light";
export type Ansi16Slot = number; // 0–15

/**
 * Named ANSI slot → theme role whose hue/chroma we keep. Bright and dim
 * share a role; SGR 1 is weight. Inverse of {@link ansi16Slot} (role → slot).
 * Black/white land on furniture/voice, not a claimed gray RGB.
 */
export const ANSI16_ROLE = [
  "muted",
  "error",
  "success",
  "warning",
  "code",
  "running",
  "auto",
  "foreground",
  "muted",
  "error",
  "success",
  "emphasis",
  "code",
  "running",
  "accent",
  "foreground",
] as const satisfies readonly SemanticRole[];

/** Prominence ≥ this → loud tier; below → soft. */
export const LOUD_THRESHOLD = 0.8;

/** Classic + bright xterm defaults for indices 0–15 (same as ansi256 decode). */
const ANSI16_RGB: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 0, b: 0 },
  { r: 0, g: 205, b: 0 },
  { r: 205, g: 205, b: 0 },
  { r: 0, g: 0, b: 238 },
  { r: 205, g: 0, b: 205 },
  { r: 0, g: 205, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 127, g: 127, b: 127 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 92, g: 92, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

/** Nearest ANSI16 index for an sRGB triple (0–255). Euclidean in sRGB. */
export function nearestAnsi16(r: number, g: number, b: number): Ansi16Slot {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 16; i++) {
    const p = ANSI16_RGB[i]!;
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
      if (d === 0) return best;
    }
  }
  return best;
}

export function nearestAnsi16FromRgb(rgb: Rgb): Ansi16Slot {
  return nearestAnsi16(rgb.r, rgb.g, rgb.b);
}

/** Decode ANSI16 index to approximate RGB (xterm defaults). */
export function ansi16ToRgb(index: number): Rgb {
  invariant(index >= 0, `ansi16 index cannot be negative: ${index}`);
  invariant(index <= 15, `ansi16 index cannot overflow: ${index}`);
  return { ...ANSI16_RGB[index]! };
}

type TierMap = Record<SemanticRole, Ansi16Slot>;

const SLOT_TABLE: Record<CanvasPolarity, { loud: TierMap; soft: TierMap }> = {
  dark: {
    loud: {
      error: 9,
      diff_del: 9,
      success: 10,
      diff_add: 10,
      warning: 11,
      accent: 14,
      running: 13,
      auto: 14,
      attention: 11,
      emphasis: 15,
      code: 12,
      foreground: 7,
      chrome: 7,
      surface: 8,
      muted: 8,
      border: 8,
    },
    soft: {
      error: 1,
      diff_del: 1,
      success: 2,
      diff_add: 2,
      warning: 3,
      accent: 6,
      running: 5,
      auto: 6,
      attention: 3,
      emphasis: 7,
      code: 4,
      foreground: 8,
      chrome: 8,
      surface: 8,
      muted: 8,
      border: 8,
    },
  },
  light: {
    loud: {
      error: 1,
      diff_del: 1,
      success: 2,
      diff_add: 2,
      warning: 3,
      accent: 4,
      running: 5,
      auto: 6,
      attention: 3,
      emphasis: 0,
      code: 4,
      foreground: 8,
      chrome: 8,
      surface: 7,
      muted: 7,
      border: 7,
    },
    soft: {
      error: 9,
      diff_del: 9,
      success: 2,
      diff_add: 2,
      warning: 3,
      accent: 12,
      running: 5,
      auto: 6,
      attention: 3,
      emphasis: 8,
      code: 12,
      foreground: 8,
      chrome: 8,
      surface: 7,
      muted: 7,
      border: 7,
    },
  },
};

/**
 * Canvas polarity from ground OKLCH L.
 * `null` / undefined → reference ground polarity (dark).
 */
export function canvasPolarity(groundLightness: number | null | undefined): CanvasPolarity {
  const g = groundLightness ?? REFERENCE_GROUND;
  return g < 0.5 ? "dark" : "light";
}

function tierOf(prominence: number): "loud" | "soft" {
  return prominence >= LOUD_THRESHOLD ? "loud" : "soft";
}

/** Resolve role → ANSI16 slot for polarity + prominence. */
export function ansi16Slot(role: SemanticRole, polarity: CanvasPolarity, prominence = 1): Ansi16Slot {
  const tier = tierOf(prominence);
  const slot = SLOT_TABLE[polarity][tier][role];
  invariant(slot !== undefined, `unknown ANSI16 role: ${role}`);
  return slot;
}
