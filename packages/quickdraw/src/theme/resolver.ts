/**
 * ColorResolver — single choke-point resolve of role intents → concrete
 * style fields. Dual-dirty: re-run on an existing Frame without layout().
 *
 * Style may carry:
 *   - role (+ prominence) — re-solved against current Theme + depth
 *   - bgRole (+ bgProminence) — background identity, resolved via the BG ladder
 *   - literal fg / fgRgb / bg / bgRgb — passed through, optionally region-dimmed.
 *     fgRgb + role: hue/chroma from the literal (syntax tokens), apparent
 *     lightness from the role — same weight as body at that FgP. fgRgb
 *     alone stays claimed color.
 *
 * Layout stays theme-free: it only needs a resolveStyle callback.
 *
 * ## Pipeline (fixed order — G2)
 *
 *   1. solve(role, tier, ground)      — baked into `Theme.rgb`/`colors` at
 *                                        build time (buildTheme/solvePalette);
 *                                        this resolver only *consumes* it.
 *   2. prominence compose (own × region) — `effectiveP = ownP * regionP`.
 *      Region is the multiplicative fade of ALL paint (backdrop model, decision
 *      1): a de-emphasized region fades fg AND bg by the same `regionProminence`.
 *   3. bold H-K compensation          — {@link compensateBoldRgb} on the
 *      role FG path (role alone, or fgRgb recast onto a role). Never
 *      bgRole/bgRgb, never fgRgb with no role.
 *   4. bg resolve                     — `bgRole`+`bgProminence` (BgP: fill
 *      solidity of painted furniture, composed with region only — never with
 *      FG's own prominence) via the ELEVATION law ({@link elevateBgRgb}):
 *      ground raised a small AL step toward the role's hue, never the role's
 *      text color faded. Else literal `bg`/`bgRgb` (region-faded, never
 *      role-faded).
 *   5. selection recolor              — perception-preserving highlight on
 *      the solved RGB (identity-preserving AL shift on fg, fill/recolor on
 *      bg) *before* depth emit so ansi16/256 get a real shift, not a no-op
 *      on missing fgRgb. Composing after bold compensation means a
 *      bold+selected cell shifts once, from the already-compensated base —
 *      no double-shift.
 *   6. depth degradation              — truecolor rgb → ansi256 index →
 *      ansi16 hue-preserving slot → mono (no color SGR at all, NO_COLOR);
 *      `dim` is *emitted* here as the ansi16-and-mono-shared degradation of
 *      low FG prominence, never *authored* by a role. Mono still runs the
 *      full solve upstream (tier/prominence math, bold H-K compensation,
 *      selection) — only the final color escape is withheld; bold/italic/
 *      strike/underline attributes are untouched and always pass through
 *      (capabilities/src/types.ts:5-10 is the mono attribute-policy SSOT).
 *      Selected roles at ansi16 emit via nearest-RGB (not the role slot
 *      table) so the AL shift is visible in the index.
 *
 * Region (step 2) vs bg (step 4) are never interchangeable: region says "how
 * much of the room is present", bg says "how solid is the furniture painted
 * into it". A call site names which one it means.
 */

import invariant from "tiny-invariant";

import { ansi16Slot, ansi16ToRgb, canvasPolarity, nearestAnsi16FromRgb } from "./ansi16.js";
import { ansi256ToRgb, nearestAnsi256FromRgb } from "./ansi256.js";
import { fadeTowardSurfaceRgb, mixTowardTintRgb, regionDimRgb } from "./region.js";
import { apparentLightness, hexToRgb, oklchToHex, rgbToOklch, solveLightness } from "./salience.js";
import { selectionFillRgb, selectionRecolorBgRgb, selectionRecolorRgb } from "./selection.js";
import type { Theme } from "./theme.js";
import type { ColorDepth } from "../capabilities/index.js";
import { type Rgb, FgP, ROLES, SemanticRole } from "../lexicon/index.js";

/** Buffer-compatible style fragment (mirrors ../buffer/index.js Style). */
export type StyleLike = {
  bold?: boolean;
  dim?: boolean;
  strike?: boolean;
  italic?: boolean;
  underline?: boolean;
  href?: string;
  fg?: number;
  fgRgb?: Rgb;
  bg?: number;
  bgRgb?: Rgb;
  bgFx?: string;
  bgFxU?: number;
  bgFxV?: number;
  role?: string;
  prominence?: number;
  bgRole?: string;
  bgProminence?: number;
  surfaceRole?: string;
  surfaceRgb?: Rgb;
  surfaceProminence?: number;
  fuseRole?: string;
  fuseProminence?: number;
  tintRole?: string;
  tint?: number;
  regionProminence?: number;
  selected?: boolean;
  cast?: "transparent";
};

export type ResolveCtx = {
  theme: Theme;
  depth?: ColorDepth;
  /** Default region prominence when style has none (1.0 = full). */
  regionProminence?: number;
};

/** Foreground prominence at/below which ansi16 degrades to `dim` (G2 step 6). */
const DIM_THRESHOLD = FgP.ghost;

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 1;
  return Math.min(1, Math.max(0, p));
}

/**
 * Bold H-K compensation (enabler 7). Irradiation (Helmholtz 1867, observed by
 * Galileo 1632) makes light-on-dark strokes look brighter/heavier than their
 * measured lightness; on dark surfaces this compounds with sRGB gamma
 * spreading (`typography.md`: "the double effect means dark theme display
 * text at conventional bold weights appears significantly over-weighted").
 * The resolver counters by nudging the solved apparent lightness back toward
 * ground by a fixed budget so bold reads as *weight*, not as an accent bump.
 * Polarity-aware: the shift is toward ground on EITHER polarity (dark ground
 * pulls down, light ground pushes up) — never away from it.
 *
 * Delta derivation anchor (G10): Delta's surface-adaptive weight already
 * solves the same irradiation family for font weight — `--font-weight`
 * (`delta/delta-css/src/typography.css:78-81`) linearly interpolates
 * `--⚙️weight-dark-surface` (360) → `--⚙️weight-light-surface` (420) by
 * surface lightness (`typography-configuration-properties.css:30-58`); that
 * 360/420 ratio is ≈0.85, the "0.85 multiplier" family cited in
 * design-science typography notes (CSS-Tricks anchor, irradiation
 * illusion). Font weight and terminal apparent-lightness are
 * different render channels for the same perceptual correction, so the
 * multiplier doesn't transfer directly — `BOLD_AL_COMPENSATION` is the AL
 * budget's own starting point (an ~4% AL pull, not a weight ratio), picked
 * as a small fraction of the JND (0.074, `dark-theme.md`) so it visibly
 * de-weights bold without crossing into a second contrast step. Tunable —
 * see the `bold-compensation` storybook story for the eyeball-tuning rig.
 */
export const BOLD_AL_COMPENSATION = 0.04;

function compensateBoldRgb(rgb: Rgb, ground: number): Rgb {
  const { l, c, h } = rgbToOklch(rgb.r, rgb.g, rgb.b);
  const al = apparentLightness(l, c, h);
  const sign = canvasPolarity(ground) === "dark" ? 1 : -1;
  const newAl = al - sign * BOLD_AL_COMPENSATION;
  const newL = solveLightness(newAl, c, h);
  return hexToRgb(oklchToHex(newL, c, h));
}

/** Keep token H/C; land on the role's apparent lightness (body-weight syntax). */
function recastToRoleAl(literal: Rgb, roleRgb: Rgb): Rgb {
  const tok = rgbToOklch(literal.r, literal.g, literal.b);
  const role = rgbToOklch(roleRgb.r, roleRgb.g, roleRgb.b);
  const targetAl = apparentLightness(role.l, role.c, role.h);
  const l = solveLightness(targetAl, tok.c, tok.h);
  return hexToRgb(oklchToHex(l, tok.c, tok.h));
}

/**
 * Max apparent-lightness elevation of a solid background above ground.
 * Backgrounds obey the ELEVATION law, not the contrast law: a surface is the
 * ground raised a small step toward the role's identity — never the role's
 * text color faded. Deriving bg from the FG tier solve painted panels at
 * text contrast (recede ≈ AL 0.55): huge mid-gray slabs on a dark terminal.
 * Anchors (dark-theme design notes): Material
 * elevation overlays run 5–15% lightness above base, each step clearing the
 * ~7.4% brightness JND; the reference panel (xterm 235 over a #121212
 * ground) sat ≈ +0.07 AL — reproduced here at BgP.panel (0.85 × 0.09).
 * (Historical hex above is comment prose: color-parity-ignore.)
 */
const BG_ELEVATION_MAX = 0.09;
/**
 * Background chroma budget: fraction of the role's chroma kept at p=0, plus
 * slope × p. 0.35 left even a mist Diff wash at ~45% of role C — a tinted
 * slab, not atmosphere toward ground. 0.12 lets low-p washes dissolve;
 * panel still picks up identity through the slope (0.12 + 0.35 × 0.85).
 */
const BG_CHROMA_BASE = 0.12;
const BG_CHROMA_SLOPE = 0.35;

/**
 * Elevate ground toward a role's identity: target AL = ground ± elevation
 * (away from ground on either polarity), hue kept, chroma cut to an
 * atmospheric fraction. H-K-correct via solveLightness.
 */
function elevateBgRgb(roleRgb: Rgb, ground: number, solidity: number): Rgb {
  const p = clamp01(solidity);
  const { c, h } = rgbToOklch(roleRgb.r, roleRgb.g, roleRgb.b);
  const sign = canvasPolarity(ground) === "dark" ? 1 : -1;
  const targetAl = ground + sign * BG_ELEVATION_MAX * p;
  const bgC = c * (BG_CHROMA_BASE + BG_CHROMA_SLOPE * p);
  const l = solveLightness(targetAl, bgC, h);
  return hexToRgb(oklchToHex(l, bgC, h));
}

function emitFg(
  rgb: Rgb,
  depth: ColorDepth,
  role: SemanticRole | undefined,
  effectiveP: number,
  ground: number,
  out: StyleLike,
): void {
  if (depth === "mono") {
    // NO_COLOR (capabilities/src/types.ts:5-10): role/prominence solving
    // still ran (tier math, bold H-K compensation happened upstream) but no
    // fg color escape is emitted at all — not even an index. Attributes
    // (bold/italic/strike/underline) are untouched by this function and
    // pass through on `out` unconditionally; `dim` is still applied by the
    // caller as the mono/ansi16-shared low-prominence degradation (step 5).
    return;
  }
  if (depth === "ansi16") {
    // Roles: hue-preserving slot table. Literals (syntax): nearest RGB.
    out.fg = role ? ansi16Slot(role, canvasPolarity(ground), effectiveP) : nearestAnsi16FromRgb(rgb);
    return;
  }
  if (depth === "ansi256") {
    out.fg = nearestAnsi256FromRgb(rgb);
    return;
  }
  out.fgRgb = rgb;
}

/** Emit bg at declared depth — never truecolor under ansi16/256, never any
 * color field under mono (NO_COLOR: attributes only, see emitFg). */
function emitBg(rgb: Rgb, depth: ColorDepth, out: StyleLike): void {
  if (depth === "mono") {
    return;
  }
  if (depth === "truecolor") {
    out.bgRgb = rgb;
  } else if (depth === "ansi16") {
    out.bg = nearestAnsi16FromRgb(rgb);
  } else {
    out.bg = nearestAnsi256FromRgb(rgb);
  }
}

/**
 * Resolve one style: role → concrete color at depth; apply region dim.
 * Returns a new style with concrete fg/fgRgb (role kept for dual-dirty).
 */
export function resolveStyle(style: StyleLike, ctx: ResolveCtx): StyleLike {
  const depth = ctx.depth ?? "truecolor";
  const regionP = clamp01(style.regionProminence ?? ctx.regionProminence ?? 1);
  const ownP = clamp01(style.prominence ?? 1);
  const effectiveP = ownP * regionP;

  const out: StyleLike = {
    bold: style.bold,
    strike: style.strike,
    italic: style.italic,
    underline: style.underline,
    href: style.href,
    role: style.role,
    prominence: style.prominence,
    bgRole: style.bgRole,
    bgProminence: style.bgProminence,
    surfaceRole: style.surfaceRole,
    surfaceProminence: style.surfaceProminence,
    fuseRole: style.fuseRole,
    fuseProminence: style.fuseProminence,
    tintRole: style.tintRole,
    tint: style.tint,
    regionProminence: style.regionProminence,
    selected: style.selected,
    cast: style.cast,
    // Procedural bg is present-loop concern — never resolve away
    bgFx: style.bgFx,
    bgFxU: style.bgFxU,
    bgFxV: style.bgFxV,
  };

  const ground = ctx.theme.ground;

  // ── Surface / BG first: opacity target for FG prominence ──────────────
  // Local surface (panel under ShadowStream, cell bgRole, etc.) beats theme
  // ground. Order: explicit surfaceRole → cell bgRole/bgRgb → theme ground.
  let bgRgb: Rgb | undefined;
  let bgIndexPassthrough: number | undefined;
  if (style.bgRole && ROLES.has(style.bgRole)) {
    const bgRole = style.bgRole as SemanticRole;
    invariant(ctx.theme.colors[bgRole], `theme missing role: ${bgRole}`);
    const bgOwnP = clamp01(style.bgProminence ?? 1);
    bgRgb = elevateBgRgb(ctx.theme.rgb[bgRole]!, ground, bgOwnP * regionP);
  } else if (style.bgRgb) {
    bgRgb = { ...style.bgRgb };
    if (regionP < 1) {
      bgRgb = regionDimRgb(bgRgb, ground, regionP);
    }
  } else if (style.bg !== undefined) {
    if (style.selected) {
      bgRgb = style.bg <= 15 ? ansi16ToRgb(style.bg) : ansi256ToRgb(style.bg);
    } else {
      bgIndexPassthrough = style.bg;
    }
  }

  let fadeSurface: Rgb | undefined;
  if (style.fuseRole && ROLES.has(style.fuseRole)) {
    // FG→FG fuse (progress rail into contour). Not BG elevation.
    // Target is fuseProminence × region so the dissolve matches the
    // already-dimmed contour; omitting region leaves the rail at full-room
    // brightness behind a modal.
    const fr = style.fuseRole as SemanticRole;
    invariant(ctx.theme.colors[fr], `theme missing role: ${fr}`);
    const fp = clamp01(style.fuseProminence ?? FgP.ghost) * regionP;
    const full = ctx.theme.rgb[fr]!;
    fadeSurface = fp >= 1 ? { ...full } : regionDimRgb(full, ground, fp);
  } else if (style.surfaceRole && ROLES.has(style.surfaceRole)) {
    const sr = style.surfaceRole as SemanticRole;
    invariant(ctx.theme.colors[sr], `theme missing role: ${sr}`);
    const sp = clamp01(style.surfaceProminence ?? 1);
    fadeSurface = elevateBgRgb(ctx.theme.rgb[sr]!, ground, sp * regionP);
  } else if (bgRgb) {
    fadeSurface = bgRgb;
  } else if (style.surfaceRgb) {
    fadeSurface = style.surfaceRgb;
  } else {
    fadeSurface = ctx.theme.groundRgb;
  }

  function tintFg(rgb: Rgb): Rgb {
    const amount = typeof style.tint === "number" && Number.isFinite(style.tint) ? clamp01(style.tint) : 0;
    if (!(amount > 0) || !style.tintRole || !ROLES.has(style.tintRole)) return rgb;
    const hot = ctx.theme.rgb[style.tintRole as SemanticRole];
    return hot ? mixTowardTintRgb(rgb, hot, amount) : rgb;
  }

  /** Prominence fade: toward local surface when known, else theme ground L. */
  function fadeFg(rgb: Rgb, p: number): Rgb {
    if (p >= 1) return rgb;
    if (fadeSurface) {
      return fadeTowardSurfaceRgb(rgb, fadeSurface, p, {
        // Quadratic de-chroma on FG→FG fuse so the hot hue doesn't
        // plateau then drop as a last step (region γ is sublinear).
        chromaExp: style.fuseRole ? 2 : undefined,
      });
    }
    return regionDimRgb(rgb, ground, p);
  }

  // fgRgb + role: token hue/chroma, role apparent-lightness (syntax).
  // fgRgb alone: claimed color. Role alone: semantic chrome.
  let fgRgb: Rgb | undefined;
  let fgRole: SemanticRole | undefined;
  let fgIsRole = false;

  if (style.fgRgb) {
    fgRgb = { ...style.fgRgb };
    const withRole = style.role && ROLES.has(style.role);
    if (withRole) {
      const role = style.role as SemanticRole;
      const roleRgb = ctx.theme.rgb[role];
      invariant(roleRgb, `theme missing role: ${role}`);
      fgRgb = recastToRoleAl(fgRgb, roleRgb);
      // Nearest-RGB at ansi16 — a role slot would collapse every token.
    }
    fgRgb = tintFg(fgRgb);
    if (effectiveP < 1) {
      fgRgb = fadeFg(fgRgb, effectiveP);
    }
    if (withRole && style.bold) {
      fgRgb = compensateBoldRgb(fgRgb, ground);
    }
    out.dim = withRole && (depth === "ansi16" || depth === "mono") && effectiveP <= DIM_THRESHOLD ? true : style.dim;
  } else if (style.role && ROLES.has(style.role)) {
    const role = style.role as SemanticRole;
    const fullHex = ctx.theme.colors[role];
    invariant(fullHex, `theme missing role: ${role}`);
    fgRole = role;
    fgIsRole = true;
    fgRgb = tintFg(ctx.theme.rgb[role]!);
    if (effectiveP < 1) {
      fgRgb = fadeFg(fgRgb, effectiveP);
    }
    // FG only — never touch bgRole/bgRgb (elevation law owns surfaces).
    if (style.bold) {
      fgRgb = compensateBoldRgb(fgRgb, ground);
    }
    // dim is banned as an authoring channel for roles (enabler 6).
    if ((depth === "ansi16" || depth === "mono") && effectiveP <= DIM_THRESHOLD) {
      out.dim = true;
    }
  } else if (style.fg === undefined) {
    out.dim = style.dim;
  } else {
    if (style.selected) {
      fgRgb = style.fg <= 15 ? ansi16ToRgb(style.fg) : ansi256ToRgb(style.fg);
    } else {
      out.fg = style.fg;
    }
    out.dim = style.dim;
  }

  if (style.selected && fgRgb) {
    fgRgb = selectionRecolorRgb(fgRgb, ground);
  }

  if (fgRgb) {
    const emitRole = style.selected && fgIsRole ? undefined : fgRole;
    emitFg(fgRgb, depth, emitRole, effectiveP, ground, out);
  }

  // BG emit (already resolved above for fade target).
  if (style.selected) {
    bgRgb = bgRgb ? selectionRecolorBgRgb(bgRgb, ground) : selectionFillRgb(ground);
  }

  if (bgRgb) {
    emitBg(bgRgb, depth, out);
  } else if (bgIndexPassthrough !== undefined) {
    out.bg = bgIndexPassthrough;
  }

  return out;
}

/** Bind a resolveStyle callback for paintFrame / dual-dirty. */
export function makeStyleResolver(ctx: ResolveCtx): (style: StyleLike) => StyleLike {
  return (style) => resolveStyle(style, ctx);
}
