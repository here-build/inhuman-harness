/**
 * Build a solved Theme from seeds against terminal ground.
 * Request roles — never claim raw hex in widgets.
 */

import { oklchToHex, REFERENCE_GROUND, solvePalette, type SolveOpts, hexToRgb } from "./salience.js";
import { DEFAULT_SEEDS, type SeedRow } from "./seeds.js";
import type { Rgb, SemanticRole } from "../lexicon/index.js";

export type Theme = {
  id: string;
  name: string;
  /** Ground OKLCH L used to solve this theme. */
  ground: number;
  /** Solved role → hex. */
  colors: Record<SemanticRole, string>;
  /** Solved role → 0–255 RGB (truecolor paint). */
  rgb: Record<SemanticRole, Rgb>;
  /**
   * "Background" hex of ground L (achromatic) — for docs/tests only.
   * Never paint as default cell bg (TERMINAL O1: transparent inherit).
   */
  groundHex: string;
  /**
   * Terminal ground sRGB. OSC 11 when probed; otherwise the achromatic
   * ground L. Transparent FG prominence dissolves toward this, not a
   * phantom gray at the same lightness.
   */
  groundRgb: Rgb;
};

export type BuildThemeOpts = SolveOpts & {
  seeds?: readonly SeedRow[];
  id?: string;
  name?: string;
  /** Override ground; default REFERENCE_GROUND until OSC 11 wires. */
  ground?: number;
  /** Probed terminal background. When omitted, achromatic {@link ground}. */
  groundRgb?: Rgb;
};

export function buildTheme(opts: BuildThemeOpts = {}): Theme {
  const ground = opts.ground ?? REFERENCE_GROUND;
  const seeds = opts.seeds ?? DEFAULT_SEEDS;
  const palette = solvePalette(seeds, {
    ground,
    polarity: opts.polarity,
  });

  const colors = {} as Record<SemanticRole, string>;
  const rgb = {} as Record<SemanticRole, Rgb>;
  for (const s of seeds) {
    const hex = palette[s.name]!;
    colors[s.name] = hex;
    rgb[s.name] = hexToRgb(hex);
  }

  const groundHex = oklchToHex(ground, 0, 0);
  return {
    id: opts.id ?? "salience",
    name: opts.name ?? "salience",
    ground,
    colors,
    rgb,
    groundHex,
    groundRgb: opts.groundRgb ?? hexToRgb(groundHex),
  };
}

/** Default dark-reference theme (tests + headless fallback). */
export const defaultTheme: Theme = buildTheme({ ground: REFERENCE_GROUND });
