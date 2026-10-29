/**
 * Terminal ground attunement (theme math).
 *
 * OSC 11 parse lives in ../capabilities/index.js; OKLCH L conversion here.
 */

import { rgbToOklch } from "./salience.js";

/** OKLCH L from OSC 11 / any sRGB background (0–255 channels). */
export function groundFromRgb(r: number, g: number, b: number): number {
  return rgbToOklch(r, g, b).l;
}
