//! Compensated-Darcula seeds. Hue and chroma are calibration; tiers are vocabulary.

use super::lexicon::{Rgb, Role, Tier};
use super::salience::{hex_to_rgb, oklch_to_hex, Seed};

pub const DEFAULT_SEEDS: [Seed; Role::COUNT] = [
    Seed {
        role: Role::Foreground,
        h: 250.0,
        c: 0.022,
        tier: Tier::Baseline,
    },
    Seed {
        role: Role::Accent,
        h: 242.0,
        c: 0.074,
        tier: Tier::Differentiate,
    },
    Seed {
        role: Role::Error,
        h: 25.0,
        c: 0.16,
        tier: Tier::Alarm,
    },
    Seed {
        role: Role::Warning,
        h: 62.0,
        c: 0.17,
        tier: Tier::Baseline,
    },
    Seed {
        role: Role::Success,
        h: 134.0,
        c: 0.075,
        tier: Tier::Differentiate,
    },
    Seed {
        role: Role::Emphasis,
        h: 77.0,
        c: 0.125,
        tier: Tier::Anchor,
    },
    Seed {
        role: Role::Muted,
        h: 250.0,
        c: 0.0,
        tier: Tier::Recede,
    },
    Seed {
        role: Role::Border,
        h: 250.0,
        c: 0.0,
        tier: Tier::Recede,
    },
    Seed {
        role: Role::Chrome,
        h: 250.0,
        c: 0.01,
        tier: Tier::Recede,
    },
    Seed {
        role: Role::Surface,
        h: 250.0,
        c: 0.0,
        tier: Tier::Recede,
    },
    Seed {
        role: Role::Code,
        h: 270.0,
        c: 0.065,
        tier: Tier::Baseline,
    },
    Seed {
        role: Role::DiffAdd,
        h: 134.0,
        c: 0.09,
        tier: Tier::Differentiate,
    },
    Seed {
        role: Role::DiffDel,
        h: 25.0,
        c: 0.14,
        tier: Tier::Alarm,
    },
    Seed {
        role: Role::Running,
        h: 320.0,
        c: 0.1,
        tier: Tier::Differentiate,
    },
    Seed {
        role: Role::Auto,
        h: 211.0,
        c: 0.12,
        tier: Tier::Baseline,
    },
    Seed {
        role: Role::Attention,
        h: 110.0,
        c: 0.16,
        tier: Tier::Anchor,
    },
    Seed {
        role: Role::DiffMod,
        h: 230.0,
        c: 0.04,
        tier: Tier::Recede,
    },
];

/// Hue and chroma of a seed at a dummy L=0.5. Paint recasts apparent lightness.
pub fn seed_hue_rgb(role: Role) -> Rgb {
    let seed = DEFAULT_SEEDS
        .iter()
        .find(|row| row.role == role)
        .expect("unknown seed role");
    hex_to_rgb(&oklch_to_hex(0.5, seed.c, seed.h))
}
