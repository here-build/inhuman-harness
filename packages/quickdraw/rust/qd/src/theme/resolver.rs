//! Role + prominence + ground → concrete color.
//!
//! Fixed order: solved theme, prominence × region, bold compensation,
//! background elevation, selection, then depth. Region is how present the
//! room is. Background prominence is how solid the furniture is. They multiply
//! for a fill and never substitute for each other.
//!
//! Call [`resolve_style`] again when the theme or depth changes. Leaving the
//! role on the result means a second call fades again.

use super::ansi16::{
    ansi16_slot, ansi16_to_rgb, canvas_polarity, nearest_ansi16_from_rgb, CanvasPolarity,
};
use super::ansi256::{ansi256_to_rgb, nearest_ansi256_from_rgb};
use super::lexicon::{clamp01, FgP, Rgb, Role};
use super::region::{fade_toward_surface_rgb, mix_toward_tint_rgb, region_dim_rgb};
use super::salience::{
    apparent_lightness, hex_to_rgb, oklch_to_hex, rgb_to_oklch, solve_lightness,
};
use super::selection::{selection_fill_rgb, selection_recolor_bg_rgb, selection_recolor_rgb};
use super::theme::Theme;
use super::ColorDepth;

/// Bold pulls apparent lightness toward ground so weight is not an accent bump.
pub const BOLD_AL_COMPENSATION: f64 = 0.04;
const BG_ELEVATION_MAX: f64 = 0.09;
const BG_CHROMA_BASE: f64 = 0.12;
const BG_CHROMA_SLOPE: f64 = 0.35;
const DIM_THRESHOLD: f64 = FgP::GHOST;

/// Intent in, concrete color out. The same carrier so a later paint can round-trip
/// fields it does not interpret. `None` means the field was not emitted.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct StyleIntent {
    pub bold: bool,
    /// `None` is unset. Ansi16 and mono set `Some(true)` at ghost prominence and below.
    /// A role does not keep an authored dim; a literal fg does.
    pub dim: Option<bool>,
    pub strike: bool,
    pub italic: bool,
    pub underline: bool,
    pub href: Option<String>,
    pub fg: Option<u16>,
    pub fg_rgb: Option<Rgb>,
    pub bg: Option<u16>,
    pub bg_rgb: Option<Rgb>,
    pub bg_fx: Option<String>,
    pub bg_fx_u: Option<f64>,
    pub bg_fx_v: Option<f64>,
    pub role: Option<Role>,
    pub prominence: Option<f64>,
    pub bg_role: Option<Role>,
    pub bg_prominence: Option<f64>,
    pub surface_role: Option<Role>,
    /// Read as a fade target. Not copied onto the resolved style.
    pub surface_rgb: Option<Rgb>,
    pub surface_prominence: Option<f64>,
    pub fuse_role: Option<Role>,
    pub fuse_prominence: Option<f64>,
    pub tint_role: Option<Role>,
    pub tint: Option<f64>,
    pub region_prominence: Option<f64>,
    pub selected: bool,
    pub cast_transparent: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct ResolveCtx<'a> {
    pub theme: &'a Theme,
    pub depth: ColorDepth,
    pub region_prominence: Option<f64>,
}

impl<'a> ResolveCtx<'a> {
    pub fn new(theme: &'a Theme, depth: ColorDepth) -> Self {
        Self {
            theme,
            depth,
            region_prominence: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StyleResolver<'a> {
    ctx: ResolveCtx<'a>,
}

impl<'a> StyleResolver<'a> {
    pub fn new(ctx: ResolveCtx<'a>) -> Self {
        Self { ctx }
    }

    pub fn resolve(&self, style: &StyleIntent) -> StyleIntent {
        resolve_style(style, &self.ctx)
    }
}

pub fn make_style_resolver(ctx: ResolveCtx<'_>) -> StyleResolver<'_> {
    StyleResolver::new(ctx)
}

pub fn resolve_style(style: &StyleIntent, ctx: &ResolveCtx<'_>) -> StyleIntent {
    let depth = ctx.depth;
    let region_p = clamp01(
        style
            .region_prominence
            .or(ctx.region_prominence)
            .unwrap_or(1.0),
    );
    let own_p = clamp01(style.prominence.unwrap_or(1.0));
    let effective_p = own_p * region_p;
    let ground = ctx.theme.ground();

    let mut out = StyleIntent {
        bold: style.bold,
        strike: style.strike,
        italic: style.italic,
        underline: style.underline,
        href: style.href.clone(),
        role: style.role,
        prominence: style.prominence,
        bg_role: style.bg_role,
        bg_prominence: style.bg_prominence,
        surface_role: style.surface_role,
        surface_prominence: style.surface_prominence,
        fuse_role: style.fuse_role,
        fuse_prominence: style.fuse_prominence,
        tint_role: style.tint_role,
        tint: style.tint,
        region_prominence: style.region_prominence,
        selected: style.selected,
        cast_transparent: style.cast_transparent,
        bg_fx: style.bg_fx.clone(),
        bg_fx_u: style.bg_fx_u,
        bg_fx_v: style.bg_fx_v,
        ..StyleIntent::default()
    };

    let mut bg_rgb = None;
    let mut bg_index_passthrough = None;
    if let Some(bg_role) = style.bg_role {
        let bg_own = clamp01(style.bg_prominence.unwrap_or(1.0));
        bg_rgb = Some(elevate_bg_rgb(
            ctx.theme.rgb(bg_role),
            ground,
            bg_own * region_p,
        ));
    } else if let Some(rgb) = style.bg_rgb {
        bg_rgb = Some(if region_p < 1.0 {
            region_dim_rgb(rgb, ground, region_p)
        } else {
            rgb
        });
    } else if let Some(bg) = style.bg {
        if style.selected {
            bg_rgb = Some(indexed_rgb(bg));
        } else {
            bg_index_passthrough = Some(bg);
        }
    }

    let fade_surface = if let Some(fuse_role) = style.fuse_role {
        let fp = clamp01(style.fuse_prominence.unwrap_or(FgP::GHOST)) * region_p;
        let full = ctx.theme.rgb(fuse_role);
        if fp >= 1.0 {
            full
        } else {
            region_dim_rgb(full, ground, fp)
        }
    } else if let Some(surface_role) = style.surface_role {
        let sp = clamp01(style.surface_prominence.unwrap_or(1.0));
        elevate_bg_rgb(ctx.theme.rgb(surface_role), ground, sp * region_p)
    } else if let Some(rgb) = bg_rgb {
        rgb
    } else if let Some(rgb) = style.surface_rgb {
        rgb
    } else {
        ctx.theme.ground_rgb()
    };

    let tinted = |rgb: Rgb| -> Rgb {
        let amount = match style.tint {
            Some(t) if t.is_finite() => clamp01(t),
            _ => 0.0,
        };
        if amount <= 0.0 {
            return rgb;
        }
        let Some(tint_role) = style.tint_role else {
            return rgb;
        };
        let Some(hot) = ctx.theme.try_rgb(tint_role) else {
            return rgb;
        };
        mix_toward_tint_rgb(rgb, hot, amount)
    };
    let fade = |rgb: Rgb, p: f64| -> Rgb {
        if p >= 1.0 {
            return rgb;
        }
        let chroma_exp = style.fuse_role.map(|_| 2.0);
        fade_toward_surface_rgb(rgb, fade_surface, p, chroma_exp)
    };

    let mut fg_rgb = None;
    let mut fg_role = None;
    let mut fg_is_role = false;
    let low_dim =
        matches!(depth, ColorDepth::Ansi16 | ColorDepth::Mono) && effective_p <= DIM_THRESHOLD;

    if let Some(mut literal) = style.fg_rgb {
        if let Some(role) = style.role {
            literal = recast_to_role_al(literal, ctx.theme.rgb(role));
        }
        literal = tinted(literal);
        if effective_p < 1.0 {
            literal = fade(literal, effective_p);
        }
        if style.role.is_some() && style.bold {
            literal = compensate_bold_rgb(literal, ground);
        }
        out.dim = if style.role.is_some() && low_dim {
            Some(true)
        } else {
            style.dim
        };
        fg_rgb = Some(literal);
    } else if let Some(role) = style.role {
        let _baked = ctx.theme.color(role);
        fg_role = Some(role);
        fg_is_role = true;
        let mut rgb = tinted(ctx.theme.rgb(role));
        if effective_p < 1.0 {
            rgb = fade(rgb, effective_p);
        }
        if style.bold {
            rgb = compensate_bold_rgb(rgb, ground);
        }
        if low_dim {
            out.dim = Some(true);
        }
        fg_rgb = Some(rgb);
    } else if let Some(fg) = style.fg {
        if style.selected {
            fg_rgb = Some(indexed_rgb(fg));
        } else {
            out.fg = Some(fg);
        }
        out.dim = style.dim;
    } else {
        out.dim = style.dim;
    }

    if style.selected {
        if let Some(rgb) = fg_rgb {
            fg_rgb = Some(selection_recolor_rgb(rgb, ground, None));
        }
    }

    if let Some(rgb) = fg_rgb {
        let emit_role = if style.selected && fg_is_role {
            None
        } else {
            fg_role
        };
        emit_fg(rgb, depth, emit_role, effective_p, ground, &mut out);
    }

    if style.selected {
        bg_rgb = Some(match bg_rgb {
            Some(rgb) => selection_recolor_bg_rgb(rgb, ground),
            None => selection_fill_rgb(ground),
        });
    }

    if let Some(rgb) = bg_rgb {
        emit_bg(rgb, depth, &mut out);
    } else if let Some(index) = bg_index_passthrough {
        out.bg = Some(index);
    }

    out
}

fn indexed_rgb(index: u16) -> Rgb {
    if index <= 15 {
        ansi16_to_rgb(u8::try_from(index).expect("ansi index <= 15 fits u8"))
    } else {
        ansi256_to_rgb(index)
    }
}

fn emit_fg(
    rgb: Rgb,
    depth: ColorDepth,
    role: Option<Role>,
    effective_p: f64,
    ground: f64,
    out: &mut StyleIntent,
) {
    match depth {
        ColorDepth::Mono => {}
        ColorDepth::Ansi16 => {
            let slot = match role {
                Some(role) => ansi16_slot(role, canvas_polarity(Some(ground)), effective_p),
                None => nearest_ansi16_from_rgb(rgb),
            };
            out.fg = Some(u16::from(slot));
        }
        ColorDepth::Ansi256 => out.fg = Some(u16::from(nearest_ansi256_from_rgb(rgb))),
        ColorDepth::Truecolor => out.fg_rgb = Some(rgb),
    }
}

fn emit_bg(rgb: Rgb, depth: ColorDepth, out: &mut StyleIntent) {
    match depth {
        ColorDepth::Mono => {}
        ColorDepth::Truecolor => out.bg_rgb = Some(rgb),
        ColorDepth::Ansi16 => out.bg = Some(u16::from(nearest_ansi16_from_rgb(rgb))),
        ColorDepth::Ansi256 => out.bg = Some(u16::from(nearest_ansi256_from_rgb(rgb))),
    }
}

fn compensate_bold_rgb(rgb: Rgb, ground: f64) -> Rgb {
    let o = rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b));
    let al = apparent_lightness(o.l, o.c, o.h);
    let sign = if canvas_polarity(Some(ground)) == CanvasPolarity::Dark {
        1.0
    } else {
        -1.0
    };
    let new_al = al - sign * BOLD_AL_COMPENSATION;
    let new_l = solve_lightness(new_al, o.c, o.h);
    hex_to_rgb(&oklch_to_hex(new_l, o.c, o.h))
}

fn recast_to_role_al(literal: Rgb, role_rgb: Rgb) -> Rgb {
    let tok = rgb_to_oklch(
        f64::from(literal.r),
        f64::from(literal.g),
        f64::from(literal.b),
    );
    let role = rgb_to_oklch(
        f64::from(role_rgb.r),
        f64::from(role_rgb.g),
        f64::from(role_rgb.b),
    );
    let target_al = apparent_lightness(role.l, role.c, role.h);
    let l = solve_lightness(target_al, tok.c, tok.h);
    hex_to_rgb(&oklch_to_hex(l, tok.c, tok.h))
}

fn elevate_bg_rgb(role_rgb: Rgb, ground: f64, solidity: f64) -> Rgb {
    let p = clamp01(solidity);
    let o = rgb_to_oklch(
        f64::from(role_rgb.r),
        f64::from(role_rgb.g),
        f64::from(role_rgb.b),
    );
    let sign = if canvas_polarity(Some(ground)) == CanvasPolarity::Dark {
        1.0
    } else {
        -1.0
    };
    let target_al = ground + sign * BG_ELEVATION_MAX * p;
    let bg_c = o.c * (BG_CHROMA_BASE + BG_CHROMA_SLOPE * p);
    let l = solve_lightness(target_al, bg_c, o.h);
    hex_to_rgb(&oklch_to_hex(l, bg_c, o.h))
}
