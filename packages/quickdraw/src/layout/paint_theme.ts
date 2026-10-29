/**
 * Theme → paint binding: a {@link Theme} plus a {@link ColorDepth} become the
 * `resolveStyle` callback `paintFrame` calls per style. Dual-dirty recolor is
 * exactly re-binding this and painting the SAME frame again.
 *
 * `attuneTheme` is the explicit form and the one new callers should use: pass a
 * theme, get its paint binding, hold it. Live ground changes go through
 * {@link ThemeStore} (host reaction drops cached RGB; polarity flip drops the
 * Frame). The module-level `active` / `depth` below are an AMBIENT fallback
 * for the deprecated tree's builders, which read the theme from nowhere; they
 * are not a second source of truth for anyone who can pass an argument. A host
 * that relies on the ambient pair must SET it at boot — reading it without
 * ever calling `setActiveTheme` is how a session silently paints the untuned
 * default ground no matter what the terminal actually is.
 *
 * Lives in layout, not theme: `PaintTheme` is layout's own type and `Style` is
 * buffer's, both of which theme deliberately avoids depending on (it mirrors
 * `Style` structurally as `StyleLike` for that reason).
 */

import type { Theme as PaintTheme } from "./types.js";
import type { Style } from "../buffer/index.js";
import { guessColorDepth, type ColorDepth } from "../capabilities/index.js";
import type { Rgb } from "../lexicon/index.js";
import { buildTheme, defaultTheme, groundFromRgb, makeStyleResolver, type Theme } from "../theme/index.js";

let active: Theme = defaultTheme;
let depth: ColorDepth = "truecolor";

/** Replace active theme (e.g. after OSC 11 attunement). */
export function setActiveTheme(theme: Theme): void {
  active = theme;
}

export function setColorDepth(d: ColorDepth): void {
  depth = d;
}

/**
 * A theme and its paint binding, together.
 *
 * The pair, not either half, is what a host actually needs: `paint` goes to
 * `paintFrame`, and `theme.ground` is what selection recolor levels against.
 * Holding one of these is the explicit alternative to reading the ambient
 * globals — which is why it carries no setter.
 */
export interface ThemeBinding {
  readonly theme: Theme;
  readonly depth: ColorDepth;
  /** `resolveStyle` bound to `theme` + `depth`. Pass straight to `paintFrame`. */
  readonly paint: PaintTheme;
}

/**
 * Build a binding from an explicit theme (or a measured ground OKLCH L, which
 * rebuilds the seed table against it). Touches no module state in either
 * direction: a host that calls this owns its theme.
 *
 * Pass `depth` explicitly whenever a real answer exists — the canonical
 * source is `resolvePresentConfig().colorDepth`
 * (`../runtime/index.js`, itself falling back to
 * `guessColorDepth(env)` from capabilities when no probe ran, so `NO_COLOR`
 * still reaches `mono` without a TTY probe). When `depth` is omitted (probe
 * threw, host has no caps yet), fall back to `guessColorDepth()` — an honest
 * env read (COLORTERM/TERM/NO_COLOR), never a hard demotion to `ansi16`.
 * Hard-ansi16 was collapsing truecolor sessions to 16 colors whenever the
 * OSC probe timed out; env is the right under-claim ladder for that case.
 */
export function attuneTheme(
  opts: {
    theme?: Theme;
    /** Ground OKLCH L from OSC 11 (`groundFromOsc11`). Ignored when `theme` is given. */
    ground?: number;
    /** Probed terminal background RGB. Ignored when `theme` is given. */
    groundRgb?: Rgb;
    depth?: ColorDepth;
    /**
     * Default region prominence (backdrop fade of ALL paint) — its own axis,
     * never the BG ladder. Bare 0–1, not a {@link BgProminence}: `BgP` is fill
     * solidity of painted furniture, a call-site-level `bgProminence`, not this.
     */
    regionProminence?: number;
  } = {},
): ThemeBinding {
  const ground =
    opts.ground ??
    (opts.groundRgb === undefined ? undefined : groundFromRgb(opts.groundRgb.r, opts.groundRgb.g, opts.groundRgb.b));
  const theme =
    opts.theme ??
    (ground === undefined && opts.groundRgb === undefined
      ? defaultTheme
      : buildTheme({ ground, groundRgb: opts.groundRgb }));
  const depthUsed = opts.depth ?? guessColorDepth();
  return {
    theme,
    depth: depthUsed,
    paint: paintTheme({ theme, depth: depthUsed, regionProminence: opts.regionProminence }),
  };
}

/**
 * Layout paint Theme with ColorResolver bound to the given theme/depth, or to
 * the ambient pair when omitted (the deprecated builders' path).
 */
export function paintTheme(opts?: {
  theme?: Theme;
  depth?: ColorDepth;
  /**
   * Backdrop fade of ALL paint (fg + bg alike) — its own argument, never the
   * BG ladder. A bare 0–1, not a {@link BgProminence}: conflating the two
   * (passing `BgP.wash` here) mixes "how solid is this furniture" into "how
   * present is this whole region", which are independent per decision 1.
   */
  regionProminence?: number;
}): PaintTheme {
  const t = opts?.theme ?? active;
  const d = opts?.depth ?? depth;
  const resolve = makeStyleResolver({
    theme: t,
    depth: d,
    regionProminence: opts?.regionProminence,
  });
  return {
    resolveStyle: (style: Style) => resolve(style) as Style,
  };
}
