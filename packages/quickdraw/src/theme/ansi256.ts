/**
 * xterm 256-color nearest match for non-truecolor terminals.
 *
 * Palette: 0–15 system (skipped for matching — cube+gray only for
 * semantic colors; 16–231 6³ cube; 232–255 grayscale). Matching in
 * sRGB Euclidean distance is good enough for TUI chrome; OKLCH match
 * would be nicer but cube steps dominate error either way.
 */

import invariant from "tiny-invariant";

import type { Rgb } from "../lexicon/index.js";

/** Build the 240 matchable entries (cube + gray). System 0–15 omitted. */
function buildPalette(): { index: number; r: number; g: number; b: number }[] {
  const out: { index: number; r: number; g: number; b: number }[] = [];
  // 6×6×6 cube: levels 0,95,135,175,215,255
  const levels = [0, 95, 135, 175, 215, 255];
  for (let ri = 0; ri < 6; ri++) {
    for (let gi = 0; gi < 6; gi++) {
      for (let bi = 0; bi < 6; bi++) {
        const index = 16 + 36 * ri + 6 * gi + bi;
        out.push({
          index,
          r: levels[ri]!,
          g: levels[gi]!,
          b: levels[bi]!,
        });
      }
    }
  }
  // grayscale ramp 232–255
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push({ index: 232 + i, r: v, g: v, b: v });
  }
  return out;
}

const PALETTE = buildPalette();

/** Nearest xterm-256 index for an sRGB triple (0–255). */
export function nearestAnsi256(r: number, g: number, b: number): number {
  let best = 16;
  let bestD = Infinity;
  for (const p of PALETTE) {
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = p.index;
      if (d === 0) return best;
    }
  }
  return best;
}

export function nearestAnsi256FromRgb(rgb: Rgb): number {
  return nearestAnsi256(rgb.r, rgb.g, rgb.b);
}

/** Decode a 256-index back to approximate RGB (for tests / dimming). */
export function ansi256ToRgb(index: number): Rgb {
  invariant(index >= 0, `ansi256 index cannot be negative: ${index}`);
  invariant(index <= 255, `ansi256 index cannot overflow: ${index}`);
  if (index < 16) {
    // classic + bright — xterm defaults
    const basic: Rgb[] = [
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
    return basic[index]!;
  }
  if (index < 232) {
    const n = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const ri = Math.floor(n / 36);
    const gi = Math.floor((n % 36) / 6);
    const bi = n % 6;
    return { r: levels[ri]!, g: levels[gi]!, b: levels[bi]! };
  }
  const v = 8 + (index - 232) * 10;
  return { r: v, g: v, b: v };
}
