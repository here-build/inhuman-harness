/**
 * Discrete prominence ladders — branded so app/TEA code cannot pass free floats.
 *
 * The brand is a number subtype: `FgP.*` / `BgP.*` assign to Style's bare
 * `number` fields. Interpolated values (`fgProgress`) stay unbranded numbers.
 *
 * Two axes:
 * - **Fg** — glyph/text weight (ghost → rising → secondary → primary)
 * - **Bg** — region / panel fill weight (wash → panel → solid)
 */

declare const __fgProminence: unique symbol;
declare const __bgProminence: unique symbol;

/** Branded foreground prominence (text / border glyphs). */
export type FgProminence = number & { readonly [__fgProminence]: true };
/** Branded background / region prominence. */
export type BgProminence = number & { readonly [__bgProminence]: true };

export type FgProminenceStep = "whisper" | "ghost" | "rising" | "secondary" | "primary";
export type BgProminenceStep = "mist" | "wash" | "panel" | "solid";

/**
 * FG numeric ladder (resolved into Style.prominence) — proximity to the
 * reader: primary in hand, secondary on the desk, rising approaching,
 * ghost in the periphery, whisper a memory trace.
 * - whisper    — disabled rows, deep age-fade floor (identity stays on hue)
 * - ghost      — ambient unfilled, gutters, whispers
 * - rising     — partial fill mid-step (between ambient and contour)
 * - secondary  — contour, meta, filled context, secondary labels
 * - primary    — draft body, chevron, selected / primary labels
 */
const FG_VALUES = {
  whisper: 0.28,
  ghost: 0.42,
  rising: 0.57,
  secondary: 0.72,
  primary: 1,
} as const satisfies Record<FgProminenceStep, number>;

/**
 * BG numeric ladder (regionProminence / panel fills) — depth of matter:
 * solid object, panel furniture, wash atmosphere, mist weather.
 * - mist   — procedural-field weight (bgfx wash strength)
 * - wash   — soft backdrop fade
 * - panel  — modal / solid-ish panel
 * - solid  — full opacity region
 */
const BG_VALUES = {
  mist: 0.28,
  wash: 0.5,
  panel: 0.85,
  solid: 1,
} as const satisfies Record<BgProminenceStep, number>;

function brandFg(n: number): FgProminence {
  return n as FgProminence;
}
function brandBg(n: number): BgProminence {
  return n as BgProminence;
}

/** Named FG steps — only legal prominence sources for TEA fg styles. */
export const FgP = {
  whisper: brandFg(FG_VALUES.whisper),
  ghost: brandFg(FG_VALUES.ghost),
  rising: brandFg(FG_VALUES.rising),
  secondary: brandFg(FG_VALUES.secondary),
  primary: brandFg(FG_VALUES.primary),
} as const satisfies Record<FgProminenceStep, FgProminence>;

/** Named BG steps — only legal prominence sources for region/panel fills. */
export const BgP = {
  mist: brandBg(BG_VALUES.mist),
  wash: brandBg(BG_VALUES.wash),
  panel: brandBg(BG_VALUES.panel),
  solid: brandBg(BG_VALUES.solid),
} as const satisfies Record<BgProminenceStep, BgProminence>;

/**
 * Continuous progress **between two branded endpoints** (render boundary only).
 * Returns a bare number for Style.prominence — not a new brand.
 * Partial fill: `fgProgress(FgP.ghost, FgP.secondary, frac)` so frac→1 matches
 * filled contour and frac→0 matches ambient free (no discrete step jumps).
 */
export function fgProgress(from: FgProminence, to: FgProminence, t: number): number {
  const f = typeof t === "number" && Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  return from + (to - from) * f;
}
