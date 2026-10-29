//! Hue-preserving ANSI16 slots. Nearest-RGB is for literal color only.

use super::lexicon::{Rgb, Role};
use super::salience::REFERENCE_GROUND;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanvasPolarity {
    Dark,
    Light,
}

/// Prominence at or above this is the loud slot tier.
pub const LOUD_THRESHOLD: f64 = 0.8;

/// Classic plus bright xterm defaults, indices 0–15.
pub(crate) const ANSI16_RGB: [Rgb; 16] = [
    Rgb { r: 0, g: 0, b: 0 },
    Rgb { r: 205, g: 0, b: 0 },
    Rgb { r: 0, g: 205, b: 0 },
    Rgb {
        r: 205,
        g: 205,
        b: 0,
    },
    Rgb { r: 0, g: 0, b: 238 },
    Rgb {
        r: 205,
        g: 0,
        b: 205,
    },
    Rgb {
        r: 0,
        g: 205,
        b: 205,
    },
    Rgb {
        r: 229,
        g: 229,
        b: 229,
    },
    Rgb {
        r: 127,
        g: 127,
        b: 127,
    },
    Rgb { r: 255, g: 0, b: 0 },
    Rgb { r: 0, g: 255, b: 0 },
    Rgb {
        r: 255,
        g: 255,
        b: 0,
    },
    Rgb {
        r: 92,
        g: 92,
        b: 255,
    },
    Rgb {
        r: 255,
        g: 0,
        b: 255,
    },
    Rgb {
        r: 0,
        g: 255,
        b: 255,
    },
    Rgb {
        r: 255,
        g: 255,
        b: 255,
    },
];

/// Slot index → role whose hue that slot stands in for. Bright and dim share a role.
pub const ANSI16_ROLE: [Role; 16] = [
    Role::Muted,
    Role::Error,
    Role::Success,
    Role::Warning,
    Role::Code,
    Role::Running,
    Role::Auto,
    Role::Foreground,
    Role::Muted,
    Role::Error,
    Role::Success,
    Role::Emphasis,
    Role::Code,
    Role::Running,
    Role::Accent,
    Role::Foreground,
];

pub fn nearest_ansi16(r: u8, g: u8, b: u8) -> u8 {
    let mut best = 0u8;
    let mut best_d = i32::MAX;
    for (i, p) in ANSI16_RGB.iter().enumerate() {
        let dr = i32::from(r) - i32::from(p.r);
        let dg = i32::from(g) - i32::from(p.g);
        let db = i32::from(b) - i32::from(p.b);
        let d = dr * dr + dg * dg + db * db;
        if d < best_d {
            best_d = d;
            best = u8::try_from(i).expect("ansi16 palette length fits in u8");
            if d == 0 {
                return best;
            }
        }
    }
    best
}

pub fn nearest_ansi16_from_rgb(rgb: Rgb) -> u8 {
    nearest_ansi16(rgb.r, rgb.g, rgb.b)
}

pub fn ansi16_to_rgb(index: u8) -> Rgb {
    *ANSI16_RGB
        .get(usize::from(index))
        .expect("ansi16 index cannot overflow")
}

/// `None` uses the reference ground, which is dark.
pub fn canvas_polarity(ground_lightness: Option<f64>) -> CanvasPolarity {
    let g = ground_lightness.unwrap_or(REFERENCE_GROUND);
    if g < 0.5 {
        CanvasPolarity::Dark
    } else {
        CanvasPolarity::Light
    }
}

pub fn ansi16_slot(role: Role, polarity: CanvasPolarity, prominence: f64) -> u8 {
    let loud = prominence >= LOUD_THRESHOLD;
    match (polarity, loud, role) {
        (CanvasPolarity::Dark, true, Role::Error | Role::DiffDel) => 9,
        (CanvasPolarity::Dark, true, Role::Success | Role::DiffAdd) => 10,
        (CanvasPolarity::Dark, true, Role::Warning | Role::Attention) => 11,
        (CanvasPolarity::Dark, true, Role::Accent | Role::Auto | Role::DiffMod) => 14,
        (CanvasPolarity::Dark, true, Role::Running) => 13,
        (CanvasPolarity::Dark, true, Role::Emphasis) => 15,
        (CanvasPolarity::Dark, true, Role::Code) => 12,
        (CanvasPolarity::Dark, true, Role::Foreground | Role::Chrome) => 7,
        (CanvasPolarity::Dark, true, Role::Surface | Role::Muted | Role::Border) => 8,

        (CanvasPolarity::Dark, false, Role::Error | Role::DiffDel) => 1,
        (CanvasPolarity::Dark, false, Role::Success | Role::DiffAdd) => 2,
        (CanvasPolarity::Dark, false, Role::Warning | Role::Attention) => 3,
        (CanvasPolarity::Dark, false, Role::Accent | Role::Auto | Role::DiffMod) => 6,
        (CanvasPolarity::Dark, false, Role::Running) => 5,
        (CanvasPolarity::Dark, false, Role::Emphasis) => 7,
        (CanvasPolarity::Dark, false, Role::Code) => 4,
        (
            CanvasPolarity::Dark,
            false,
            Role::Foreground | Role::Chrome | Role::Surface | Role::Muted | Role::Border,
        ) => 8,

        (CanvasPolarity::Light, true, Role::Error | Role::DiffDel) => 1,
        (CanvasPolarity::Light, true, Role::Success | Role::DiffAdd) => 2,
        (CanvasPolarity::Light, true, Role::Warning | Role::Attention) => 3,
        (CanvasPolarity::Light, true, Role::Accent | Role::Code) => 4,
        (CanvasPolarity::Light, true, Role::Running) => 5,
        (CanvasPolarity::Light, true, Role::Auto | Role::DiffMod) => 6,
        (CanvasPolarity::Light, true, Role::Emphasis) => 0,
        (CanvasPolarity::Light, true, Role::Foreground | Role::Chrome) => 8,
        (CanvasPolarity::Light, true, Role::Surface | Role::Muted | Role::Border) => 7,

        (CanvasPolarity::Light, false, Role::Error | Role::DiffDel) => 9,
        (CanvasPolarity::Light, false, Role::Success | Role::DiffAdd) => 2,
        (CanvasPolarity::Light, false, Role::Warning | Role::Attention) => 3,
        (CanvasPolarity::Light, false, Role::Accent | Role::Code) => 12,
        (CanvasPolarity::Light, false, Role::Running) => 5,
        (CanvasPolarity::Light, false, Role::Auto | Role::DiffMod) => 6,
        (CanvasPolarity::Light, false, Role::Emphasis | Role::Foreground | Role::Chrome) => 8,
        (CanvasPolarity::Light, false, Role::Surface | Role::Muted | Role::Border) => 7,
    }
}
