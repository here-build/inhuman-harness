//! Selection recolor. Foreground keeps hue and chroma and shifts apparent
//! lightness. Background is a fill, not that same shift. Do not feed
//! [`SELECTION_SHIFT`] through the region chroma exponent.

use super::lexicon::{Polarity, Rgb, Tier};
use super::salience::{
    apparent_lightness, hex_to_rgb, oklch_to_hex, rgb_to_oklch, solve_lightness, tier_target,
};

pub const SELECTION_SHIFT: f64 = 0.09;
pub const SELECTION_FILL_AL_DELTA: f64 = 0.16;
pub const SELECTION_FILL_CHROMA: f64 = 0.045;
pub const SELECTION_FILL_HUE: f64 = 242.0;
const SELECTION_BG_SHIFT: f64 = 0.55;
const SELECTION_BG_MIN_AL_STEP: f64 = SELECTION_FILL_AL_DELTA;

pub fn selection_target_al(ground: f64) -> f64 {
    tier_target(Tier::Anchor, ground, Polarity::Auto)
}

pub fn selection_fill_target_al(ground: f64) -> f64 {
    if ground < 0.5 {
        (ground + SELECTION_FILL_AL_DELTA).min(0.55)
    } else {
        (ground - SELECTION_FILL_AL_DELTA).max(0.45)
    }
}

/// `shift == None` uses [`SELECTION_SHIFT`]. `shift <= 0` is byte identity.
pub fn selection_recolor_rgb(rgb: Rgb, ground: f64, shift: Option<f64>) -> Rgb {
    let shift = shift.unwrap_or(SELECTION_SHIFT);
    if !shift.is_finite() || shift <= 0.0 {
        return rgb;
    }
    let t = shift.min(1.0);
    let o = rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b));
    let al = apparent_lightness(o.l, o.c, o.h);
    let new_al = al + (selection_target_al(ground) - al) * t;
    let new_l = solve_lightness(new_al, o.c, o.h);
    hex_to_rgb(&oklch_to_hex(new_l, o.c, o.h))
}

pub(crate) fn selection_fill_rgb(ground: f64) -> Rgb {
    let al = selection_fill_target_al(ground);
    let l = solve_lightness(al, SELECTION_FILL_CHROMA, SELECTION_FILL_HUE);
    hex_to_rgb(&oklch_to_hex(l, SELECTION_FILL_CHROMA, SELECTION_FILL_HUE))
}

pub(crate) fn selection_recolor_bg_rgb(rgb: Rgb, ground: f64) -> Rgb {
    let shift = SELECTION_BG_SHIFT;
    let t = shift.min(1.0);
    let o = rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b));
    let al = apparent_lightness(o.l, o.c, o.h);
    let target_al = selection_fill_target_al(ground);
    let toward_fill = al + (target_al - al) * t;
    let dark = ground < 0.5;
    let stepped = if dark {
        al + SELECTION_BG_MIN_AL_STEP
    } else {
        al - SELECTION_BG_MIN_AL_STEP
    };
    let new_al = if dark {
        toward_fill.max(stepped)
    } else {
        toward_fill.min(stepped)
    };
    let achromatic = o.c < 0.01;
    let new_h = if achromatic { SELECTION_FILL_HUE } else { o.h };
    let new_c = if achromatic {
        SELECTION_FILL_CHROMA
    } else {
        o.c + (SELECTION_FILL_CHROMA - o.c) * (t * 0.5)
    };
    let new_l = solve_lightness(new_al, new_c, new_h);
    hex_to_rgb(&oklch_to_hex(new_l, new_c, new_h))
}
