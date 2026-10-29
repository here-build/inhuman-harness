//! Solved theme. Widgets ask for a role; the ground is an input, not a paint color.

use std::sync::LazyLock;

use super::lexicon::{Polarity, Rgb, Role};
use super::salience::{hex_to_rgb, oklch_to_hex, solve_palette, Seed, SolveOpts, REFERENCE_GROUND};
use super::seeds::DEFAULT_SEEDS;

#[derive(Clone, Debug)]
pub struct Theme {
    id: String,
    name: String,
    ground: f64,
    colors: [Option<String>; Role::COUNT],
    rgb: [Option<Rgb>; Role::COUNT],
    ground_hex: String,
    ground_rgb: Rgb,
}

impl Theme {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn ground(&self) -> f64 {
        self.ground
    }

    /// Achromatic hex of `ground`. Docs and tests only — not a default cell background.
    pub fn ground_hex(&self) -> &str {
        &self.ground_hex
    }

    /// Probed terminal background, or the achromatic ground when no probe ran.
    pub fn ground_rgb(&self) -> Rgb {
        self.ground_rgb
    }

    pub fn try_rgb(&self, role: Role) -> Option<Rgb> {
        self.rgb[role.index()]
    }

    pub fn try_color(&self, role: Role) -> Option<&str> {
        self.colors[role.index()].as_deref()
    }

    pub fn rgb(&self, role: Role) -> Rgb {
        self.try_rgb(role).expect("theme missing role")
    }

    pub fn color(&self, role: Role) -> &str {
        self.try_color(role).expect("theme missing role")
    }
}

#[derive(Clone, Debug)]
pub struct BuildThemeOpts {
    pub seeds: Option<Vec<Seed>>,
    pub id: Option<String>,
    pub name: Option<String>,
    pub ground: Option<f64>,
    pub ground_rgb: Option<Rgb>,
    pub polarity: Polarity,
}

impl Default for BuildThemeOpts {
    fn default() -> Self {
        Self {
            seeds: None,
            id: None,
            name: None,
            ground: None,
            ground_rgb: None,
            polarity: Polarity::Auto,
        }
    }
}

pub fn build_theme(opts: &BuildThemeOpts) -> Theme {
    let ground = opts.ground.unwrap_or(REFERENCE_GROUND);
    let seeds = opts.seeds.as_deref().unwrap_or(&DEFAULT_SEEDS);
    let palette = solve_palette(
        seeds,
        SolveOpts {
            ground: Some(ground),
            polarity: opts.polarity,
        },
    );
    let mut colors = std::array::from_fn(|_| None);
    let mut rgb = std::array::from_fn(|_| None);
    for seed in seeds {
        let hex = palette[seed.role.index()]
            .clone()
            .expect("solve palette wrote the seed role");
        rgb[seed.role.index()] = Some(hex_to_rgb(&hex));
        colors[seed.role.index()] = Some(hex);
    }
    let ground_hex = oklch_to_hex(ground, 0.0, 0.0);
    let ground_rgb = opts.ground_rgb.unwrap_or_else(|| hex_to_rgb(&ground_hex));
    Theme {
        id: opts.id.clone().unwrap_or_else(|| "salience".to_owned()),
        name: opts.name.clone().unwrap_or_else(|| "salience".to_owned()),
        ground,
        colors,
        rgb,
        ground_hex,
        ground_rgb,
    }
}

pub fn default_theme() -> &'static Theme {
    static THEME: LazyLock<Theme> = LazyLock::new(|| {
        build_theme(&BuildThemeOpts {
            ground: Some(REFERENCE_GROUND),
            ..BuildThemeOpts::default()
        })
    });
    &THEME
}
