//! Region fade. `p == 1` is byte identity. Chroma uses `ln(0.65)/ln(0.45)`.

use super::lexicon::{clamp01, Rgb};
use super::salience::{
    apparent_lightness, hex_to_rgb, oklch_to_hex, rgb_to_oklch, solve_lightness,
};

pub(crate) fn region_gamma() -> f64 {
    0.65_f64.ln() / 0.45_f64.ln()
}

pub(crate) fn region_dim_rgb(rgb: Rgb, ground_l: f64, prominence: f64) -> Rgb {
    let p = clamp01(prominence);
    if p >= 1.0 {
        return rgb;
    }
    if p <= 0.0 {
        return hex_to_rgb(&oklch_to_hex(ground_l, 0.0, 0.0));
    }
    let o = rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b));
    let al = apparent_lightness(o.l, o.c, o.h);
    let faded_al = ground_l + (al - ground_l) * p;
    let faded_c = o.c * p.powf(region_gamma());
    let faded_l = solve_lightness(faded_al, faded_c, o.h);
    hex_to_rgb(&oklch_to_hex(faded_l, faded_c, o.h))
}

pub(crate) fn fade_toward_surface_rgb(
    fg: Rgb,
    surface: Rgb,
    prominence: f64,
    chroma_exp: Option<f64>,
) -> Rgb {
    let p = clamp01(prominence);
    if p >= 1.0 {
        return fg;
    }
    if p <= 0.0 {
        return surface;
    }
    let f = rgb_to_oklch(f64::from(fg.r), f64::from(fg.g), f64::from(fg.b));
    let s = rgb_to_oklch(
        f64::from(surface.r),
        f64::from(surface.g),
        f64::from(surface.b),
    );
    let fg_al = apparent_lightness(f.l, f.c, f.h);
    let s_al = apparent_lightness(s.l, s.c, s.h);
    let faded_al = s_al + (fg_al - s_al) * p;
    let exp = chroma_exp.unwrap_or_else(region_gamma);
    let faded_c = s.c + (f.c - s.c) * p.powf(exp);
    let faded_h = f.h;
    let faded_l = solve_lightness(faded_al, faded_c, faded_h);
    hex_to_rgb(&oklch_to_hex(faded_l, faded_c, faded_h))
}

pub(crate) fn mix_toward_tint_rgb(base: Rgb, tint: Rgb, t: f64) -> Rgb {
    let p = if t.is_finite() {
        t.clamp(0.0, 1.0)
    } else {
        0.0
    };
    if p <= 0.0 {
        return base;
    }
    if p >= 1.0 {
        return tint;
    }
    let b = rgb_to_oklch(f64::from(base.r), f64::from(base.g), f64::from(base.b));
    let hot = rgb_to_oklch(f64::from(tint.r), f64::from(tint.g), f64::from(tint.b));
    let b_al = apparent_lightness(b.l, b.c, b.h);
    let hot_al = apparent_lightness(hot.l, hot.c, hot.h);
    let faded_al = b_al + (hot_al - b_al) * p;
    let faded_c = b.c + (hot.c - b.c) * p;
    let faded_h = hot.h;
    let faded_l = solve_lightness(faded_al, faded_c, faded_h);
    hex_to_rgb(&oklch_to_hex(faded_l, faded_c, faded_h))
}
