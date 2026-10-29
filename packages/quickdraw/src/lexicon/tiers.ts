/**
 * Salience tiers — how strongly a color separates from the terminal ground.
 *
 * A tier names a *contrast intent*, not a lightness: the solver
 * (../theme/index.js salience.ts) turns tier + hue + measured
 * ground into an OKLCH lightness via H-K-compensated apparent-lightness
 * deltas. The numeric deltas live with the solver; the names live here.
 *
 * - `alarm`         — lowest lightness separation, highest chroma budget:
 *                     salience comes from color, not brightness (error/danger).
 * - `recede`        — furniture: chrome, borders, surfaces. Present, unheard.
 * - `differentiate` — distinguishable at a glance without dominating.
 * - `baseline`      — body text. The reference reading contrast.
 * - `anchor`        — headings and landmarks the eye returns to.
 */
export const TIERS = ["alarm", "recede", "differentiate", "baseline", "anchor"] as const;

export type Tier = (typeof TIERS)[number];
