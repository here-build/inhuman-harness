//! Helmholtz–Kohlrausch solver.
//!
//! Apparent lightness is `L + 0.14 · C · hue_factor(h)`. Chromatic seeds are
//! solved down in L so they sit level with gray on the same tier.
//! OKLCH ↔ sRGB uses the culori matrices. `formatHex` channel-clips and
//! rotates hue; [`fit_oklch_to_srgb`] shrinks chroma instead.

use super::lexicon::Polarity;
use super::lexicon::{Oklch, Rgb, Role, Tier};

/// H-K chroma scale (Fairchild–Pirrotta magnitude, Delta's budget).
pub const HK_K: f64 = 0.14;

/// Apparent-lightness contrast deltas at the reference ground.
pub fn tier_delta(tier: Tier) -> f64 {
    match tier {
        Tier::Alarm => 0.33,
        Tier::Recede => 0.35,
        Tier::Differentiate => 0.42,
        Tier::Baseline => 0.57,
        Tier::Anchor => 0.65,
    }
}

/// Near-black ground the tier deltas were derived against.
pub const REFERENCE_GROUND: f64 = 0.2;

const AL_MIN: f64 = 0.03;
const AL_MAX: f64 = 0.97;
const MAX_DELTA: f64 = 0.65;

/// Nayatani-1997 VAC hue weight, 3-harmonic fit. Inherently ~[0.54, 0.92].
const NAY_A0: f64 = 0.77911;
const NAY_COS: [f64; 3] = [0.08091, 0.06202, -0.01415];
const NAY_SIN: [f64; 3] = [-0.13593, -0.00365, 0.03377];

pub fn hue_factor(h: f64) -> f64 {
    let mut v = NAY_A0;
    let rad = (h * std::f64::consts::PI) / 180.0;
    for k in 1..=3 {
        let r = k as f64 * rad;
        v += NAY_COS[k - 1] * r.cos() + NAY_SIN[k - 1] * r.sin();
    }
    v
}

pub fn hk_compensation(c: f64, h: f64) -> f64 {
    HK_K * c.max(0.0) * hue_factor(h)
}

pub fn apparent_lightness(l: f64, c: f64, h: f64) -> f64 {
    l + hk_compensation(c, h)
}

pub fn solve_lightness(target_al: f64, c: f64, h: f64) -> f64 {
    target_al - hk_compensation(c, h)
}

fn polarity_sign(ground: f64, polarity: Polarity) -> f64 {
    match polarity {
        Polarity::Up => 1.0,
        Polarity::Down => -1.0,
        Polarity::Auto => {
            if ground < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
    }
}

pub fn tier_target(tier: Tier, ground: f64, polarity: Polarity) -> f64 {
    let sign = polarity_sign(ground, polarity);
    let headroom = if sign == 1.0 {
        AL_MAX - ground
    } else {
        ground - AL_MIN
    };
    let scale = (headroom / MAX_DELTA).clamp(0.0, 1.0);
    ground + sign * tier_delta(tier) * scale
}

#[derive(Clone, Copy, Debug)]
pub struct SolveOpts {
    pub ground: Option<f64>,
    pub polarity: Polarity,
}

impl Default for SolveOpts {
    fn default() -> Self {
        Self {
            ground: None,
            polarity: Polarity::Auto,
        }
    }
}

pub fn solve(tier: Tier, c: f64, h: f64, opts: SolveOpts) -> String {
    let ground = opts.ground.unwrap_or(REFERENCE_GROUND);
    let target = tier_target(tier, ground, opts.polarity);
    let l = solve_lightness(target, c, h);
    oklch_to_hex(l, c, h)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Seed {
    pub role: Role,
    pub h: f64,
    pub c: f64,
    pub tier: Tier,
}

pub fn solve_palette(seeds: &[Seed], opts: SolveOpts) -> [Option<String>; Role::COUNT] {
    let mut out = std::array::from_fn(|_| None);
    for seed in seeds {
        out[seed.role.index()] = Some(solve(seed.tier, seed.c, seed.h, opts));
    }
    out
}

/// Encoded sRGB channels inside `[-1e-4, 1+1e-4]`. Culori's `converter("rgb")`
/// is gamma-encoded, not linear — the gamut check follows that, not the comment.
pub fn in_srgb(l: f64, c: f64, h: f64) -> bool {
    let (r, g, b) = oklch_to_encoded(l, c.max(0.0), h);
    const EPS: f64 = 1e-4;
    r.is_finite()
        && g.is_finite()
        && b.is_finite()
        && r >= -EPS
        && r <= 1.0 + EPS
        && g >= -EPS
        && g <= 1.0 + EPS
        && b >= -EPS
        && b <= 1.0 + EPS
}

pub fn fit_oklch_to_srgb(l: f64, c: f64, h: f64) -> Oklch {
    let clamped_l = l.clamp(0.001, 0.999);
    let req_c = c.max(0.0);
    if req_c == 0.0 || in_srgb(clamped_l, req_c, h) {
        return Oklch {
            l: clamped_l,
            c: req_c,
            h,
        };
    }
    let target_al = apparent_lightness(clamped_l, req_c, h);
    let mut lo = 0.0;
    let mut hi = req_c;
    let mut best_l = solve_lightness(target_al, 0.0, h).clamp(0.001, 0.999);
    let mut best_c = 0.0;
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        let l_mid = solve_lightness(target_al, mid, h).clamp(0.001, 0.999);
        if in_srgb(l_mid, mid, h) {
            best_c = mid;
            best_l = l_mid;
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Oklch {
        l: best_l,
        c: best_c,
        h,
    }
}

pub fn oklch_to_hex(l: f64, c: f64, h: f64) -> String {
    let fitted = fit_oklch_to_srgb(l, c, h);
    let (r, g, b) = oklch_to_encoded(fitted.l, fitted.c, fitted.h);
    if r.is_finite() && g.is_finite() && b.is_finite() {
        return format_hex(r, g, b);
    }
    let (r, g, b) = oklch_to_encoded(fitted.l, 0.0, 0.0);
    if r.is_finite() && g.is_finite() && b.is_finite() {
        return format_hex(r, g, b);
    }
    "#808080".to_owned()
}

pub fn hex_to_oklch(hex: &str) -> Oklch {
    let (r, g, b) = parse_hex_channels(hex).expect("invalid hex color");
    let (l, a, b_) = rgb_encoded_to_oklab(r, g, b);
    lab_to_lch(l, a, b_)
}

pub fn hex_to_rgb(hex: &str) -> Rgb {
    let (r, g, b) = parse_hex_channels(hex).expect("invalid hex color");
    Rgb {
        r: round_u8(r),
        g: round_u8(g),
        b: round_u8(b),
    }
}

pub fn rgb_to_oklch(r: f64, g: f64, b: f64) -> Oklch {
    let (l, a, b_) = rgb_encoded_to_oklab(r / 255.0, g / 255.0, b / 255.0);
    lab_to_lch(l, a, b_)
}

fn parse_hex_channels(hex: &str) -> Option<(f64, f64, f64)> {
    let s = hex.strip_prefix('#').unwrap_or(hex);
    if s.len() != 6 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(s, 16).ok()?;
    let r = f64::from((n >> 16) & 0xff) / 255.0;
    let g = f64::from((n >> 8) & 0xff) / 255.0;
    let b = f64::from(n & 0xff) / 255.0;
    Some((r, g, b))
}

fn format_hex(r: f64, g: f64, b: f64) -> String {
    format!("#{:02x}{:02x}{:02x}", round_u8(r), round_u8(g), round_u8(b))
}

/// `channel` is encoded sRGB in about `0..=1`. Clamp proves the `as u8`.
fn round_u8(channel: f64) -> u8 {
    let scaled = (channel.clamp(0.0, 1.0) * 255.0).round();
    scaled as u8
}

fn lch_to_lab(l: f64, c: f64, h: f64) -> (f64, f64, f64) {
    if c != 0.0 {
        let rad = (h / 180.0) * std::f64::consts::PI;
        (l, c * rad.cos(), c * rad.sin())
    } else {
        (l, 0.0, 0.0)
    }
}

fn lab_to_lch(l: f64, a: f64, b: f64) -> Oklch {
    let c = (a * a + b * b).sqrt();
    let h = if c != 0.0 {
        normalize_hue((b.atan2(a) * 180.0) / std::f64::consts::PI)
    } else {
        0.0
    };
    Oklch { l, c, h }
}

fn normalize_hue(hue: f64) -> f64 {
    let hue = hue % 360.0;
    if hue < 0.0 {
        hue + 360.0
    } else {
        hue
    }
}

fn oklch_to_encoded(l: f64, c: f64, h: f64) -> (f64, f64, f64) {
    let (l, a, b) = lch_to_lab(l, c, h);
    let (lr, lg, lb) = oklab_to_lrgb(l, a, b);
    (linear_to_srgb(lr), linear_to_srgb(lg), linear_to_srgb(lb))
}

fn oklab_to_lrgb(l: f64, a: f64, b: f64) -> (f64, f64, f64) {
    let l_ = l + 0.3963377773761749 * a + 0.2158037573099136 * b;
    let m_ = l - 0.1055613458156586 * a - 0.0638541728258133 * b;
    let s_ = l - 0.0894841775298119 * a - 1.2914855480194092 * b;
    let l3 = l_ * l_ * l_;
    let m3 = m_ * m_ * m_;
    let s3 = s_ * s_ * s_;
    let r = 4.0767416360759574 * l3 - 3.3077115392580616 * m3 + 0.2309699031821044 * s3;
    let g = -1.2684379732850317 * l3 + 2.6097573492876887 * m3 - 0.3413193760026573 * s3;
    let b = -0.0041960761386756 * l3 - 0.7034186179359362 * m3 + 1.7076146940746117 * s3;
    (r, g, b)
}

fn lrgb_to_oklab(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let l = (0.412221469470763 * r + 0.5363325372617348 * g + 0.0514459932675022 * b).cbrt();
    let m = (0.2119034958178252 * r + 0.6806995506452344 * g + 0.1073969535369406 * b).cbrt();
    let s = (0.0883024591900564 * r + 0.2817188391361215 * g + 0.6299787016738222 * b).cbrt();
    let l_ = 0.210454268309314 * l + 0.7936177747023054 * m - 0.0040720430116193 * s;
    let a = 1.9779985324311684 * l - 2.4285922420485799 * m + 0.450593709617411 * s;
    let b_ = 0.0259040424655478 * l + 0.7827717124575296 * m - 0.8086757549230774 * s;
    (l_, a, b_)
}

fn rgb_encoded_to_oklab(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let (l, a, b_) = lrgb_to_oklab(srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b));
    if r == g && g == b {
        (l, 0.0, 0.0)
    } else {
        (l, a, b_)
    }
}

fn linear_to_srgb(c: f64) -> f64 {
    let abs = c.abs();
    if abs > 0.0031308 {
        let sign = if c < 0.0 { -1.0 } else { 1.0 };
        sign * (1.055 * abs.powf(1.0 / 2.4) - 0.055)
    } else {
        c * 12.92
    }
}

fn srgb_to_linear(c: f64) -> f64 {
    let abs = c.abs();
    if abs <= 0.04045 {
        c / 12.92
    } else {
        let sign = if c < 0.0 { -1.0 } else { 1.0 };
        sign * ((abs + 0.055) / 1.055).powf(2.4)
    }
}
