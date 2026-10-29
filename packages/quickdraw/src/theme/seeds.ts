/**
 * Semantic seed table — hue carries identity, tier carries importance.
 * Compensated-Darcula family (same seeds as SalienceTheme).
 *
 * Role names and default tiers are vocabulary
 * (../lexicon/index.js); the hue/chroma numbers are palette
 * calibration and live here.
 */

import invariant from "tiny-invariant";

import { hexToRgb, oklchToHex, type Seed } from "./salience.js";
import type { Rgb, SemanticRole } from "../lexicon/index.js";

export type SeedRow = Seed & { name: SemanticRole };

/**
 * Core semantic seeds. Hues: orange 62 (warning, Apple systemOrange
 * #FF9500 → OKLCH h≈62.6; 15° from emphasis 77), yellow 77 (emphasis),
 * yellow-green 110 (attention), green 134 (success), blue 211
 * (auto classifier-on), blue 242 (accent), azure 270 (code),
 * neutral-blue 250 (text), red 25.
 * Warning is baseline so orange stays orange — differentiate L collapses
 * it to rust, which reads as dim error. `code` is baseline: same
 * apparent-lightness as body; azure is identity, not recede.
 * `auto` is baseline cyan-blue so the chip cannot mute into accent.
 * `attention` is anchor yellow-green — look-here must stay brighter than
 * classifier-on; alarm L turns 110 olive.
 */
export const DEFAULT_SEEDS = [
  { name: "foreground", h: 250, c: 0.022, tier: "baseline" },
  { name: "accent", h: 242, c: 0.074, tier: "differentiate" },
  { name: "error", h: 25, c: 0.16, tier: "alarm" },
  { name: "warning", h: 62, c: 0.17, tier: "baseline" },
  { name: "success", h: 134, c: 0.075, tier: "differentiate" },
  { name: "emphasis", h: 77, c: 0.125, tier: "anchor" },
  { name: "muted", h: 250, c: 0, tier: "recede" },
  { name: "border", h: 250, c: 0, tier: "recede" },
  // extended roles (same hue families as ANSI16 pins)
  { name: "chrome", h: 250, c: 0.01, tier: "recede" },
  { name: "surface", h: 250, c: 0, tier: "recede" },
  { name: "code", h: 270, c: 0.065, tier: "baseline" },
  { name: "diff_add", h: 134, c: 0.09, tier: "differentiate" },
  { name: "diff_del", h: 25, c: 0.14, tier: "alarm" },
  { name: "running", h: 320, c: 0.1, tier: "differentiate" },
  { name: "auto", h: 211, c: 0.12, tier: "baseline" },
  { name: "attention", h: 110, c: 0.16, tier: "anchor" },
] as const satisfies SeedRow[];

/**
 * Role hue/chroma as an RGB sample. Apparent lightness is dummy (L=0.5);
 * paint pairs this with a surrounding role so the resolver recasts AL.
 */
export function seedHueRgb(role: SemanticRole): Rgb {
  const seed = DEFAULT_SEEDS.find((row) => row.name === role);
  invariant(seed, `unknown seed role: ${role}`);
  return hexToRgb(oklchToHex(0.5, seed.c, seed.h));
}
