//! Theme solve: a [`Role`], a prominence, and the terminal ground become a concrete color.
//!
//! Paint calls [`resolve_style`] with a [`StyleIntent`] and a [`ResolveCtx`].
//! Build a [`Theme`] once per ground with [`build_theme`]. Do not cache the
//! resolved RGB across a ground change — call resolve again. [`Role::parse`]
//! is the only string parse; the solver does not re-check names.
//!
//! `Rgb` here is three bytes. It is not the grid's f64 `buffer::Rgb`.
//!
//! Pipeline, fixed order:
//! 1. Seeds are solved into the theme (`tier` + hue + ground), H-K compensated.
//! 2. Prominence composes `own * region` and fades toward the local surface.
//! 3. Bold pulls foreground apparent lightness toward ground.
//! 4. `bg_role` elevates ground toward the role. It is not a faded text color.
//! 5. Selection recolors that RGB.
//! 6. Depth emits truecolor, ansi256, an ansi16 slot, or mono (no color).
//!    Ghost foreground prominence sets `dim` only at ansi16 and mono.
//!
//! `tests/theme_oracle.rs` includes the oracle against this public door.

mod ansi16;
mod ansi256;
mod ground;
mod lexicon;
mod region;
mod resolver;
mod salience;
mod seeds;
mod selection;
mod theme;

pub use crate::capabilities::ColorDepth;
pub use ansi16::{
    ansi16_slot, ansi16_to_rgb, canvas_polarity, nearest_ansi16, nearest_ansi16_from_rgb,
    CanvasPolarity, ANSI16_ROLE, LOUD_THRESHOLD,
};
pub use ansi256::{ansi256_to_rgb, nearest_ansi256, nearest_ansi256_from_rgb};
pub use ground::ground_from_rgb;
pub use lexicon::{BgP, FgP, Oklch, Polarity, Rgb, Role, Tier};
pub use resolver::{
    make_style_resolver, resolve_style, ResolveCtx, StyleIntent, StyleResolver,
    BOLD_AL_COMPENSATION,
};
pub use salience::{
    apparent_lightness, fit_oklch_to_srgb, hex_to_oklch, hex_to_rgb, hk_compensation, hue_factor,
    in_srgb, oklch_to_hex, rgb_to_oklch, solve, solve_lightness, solve_palette, tier_delta,
    tier_target, Seed, SolveOpts, HK_K, REFERENCE_GROUND,
};
pub use seeds::{seed_hue_rgb, DEFAULT_SEEDS};
pub(crate) use selection::{selection_fill_rgb, selection_recolor_bg_rgb};
pub use selection::{
    selection_fill_target_al, selection_recolor_rgb, selection_target_al, SELECTION_FILL_AL_DELTA,
    SELECTION_FILL_CHROMA, SELECTION_FILL_HUE, SELECTION_SHIFT,
};
pub use theme::{build_theme, default_theme, BuildThemeOpts, Theme};
