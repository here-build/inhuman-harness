/**
 * Color value shapes — the raw material the vocabulary is spoken in.
 * SSOT for these types.
 */

/** sRGB triple, 0–255 per channel. */
export type Rgb = { r: number; g: number; b: number };

/** OKLCH: l 0–1, c ≥ 0, h degrees 0–360. */
export type Oklch = { l: number; c: number; h: number };

/**
 * Solve direction relative to ground: `up` = lighter than ground (dark
 * terminals), `down` = darker (light terminals), `auto` = pick by ground.
 */
export type Polarity = "auto" | "up" | "down";
