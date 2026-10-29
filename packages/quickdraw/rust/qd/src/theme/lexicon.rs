//! Closed theme vocabulary. A wire string becomes a [`Role`] once, at the edge.

/// sRGB triple, 0–255 per channel. Not `buffer::Rgb` (that one is f64).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// OKLCH: `l` 0–1, `c` ≥ 0, `h` degrees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklch {
    pub l: f64,
    pub c: f64,
    pub h: f64,
}

/// Solve direction relative to ground.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Polarity {
    #[default]
    Auto,
    Up,
    Down,
}

/// How strongly a seed separates from the terminal ground.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Alarm,
    Recede,
    Differentiate,
    Baseline,
    Anchor,
}

impl Tier {
    pub const ALL: [Self; 5] = [
        Self::Alarm,
        Self::Recede,
        Self::Differentiate,
        Self::Baseline,
        Self::Anchor,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Alarm => "alarm",
            Self::Recede => "recede",
            Self::Differentiate => "differentiate",
            Self::Baseline => "baseline",
            Self::Anchor => "anchor",
        }
    }
}

/// Semantic role. Hue is identity; tier and prominence are importance.
///
/// Declaration order matches `ROLE_FAMILY` / `ALL_ROLES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Role {
    Foreground = 0,
    Muted,
    Emphasis,
    Code,
    Chrome,
    Border,
    Surface,
    Error,
    Warning,
    Success,
    Running,
    Auto,
    Attention,
    Accent,
    DiffAdd,
    DiffDel,
    /// Modified-line wash. Appended so the earlier discriminants stay put.
    /// The TypeScript role list does not carry this; the resolver only sees it
    /// on Rust-painted inline diff rows.
    DiffMod,
}

impl Role {
    pub const COUNT: usize = 17;

    pub const ALL: [Self; Self::COUNT] = [
        Self::Foreground,
        Self::Muted,
        Self::Emphasis,
        Self::Code,
        Self::Chrome,
        Self::Border,
        Self::Surface,
        Self::Error,
        Self::Warning,
        Self::Success,
        Self::Running,
        Self::Auto,
        Self::Attention,
        Self::Accent,
        Self::DiffAdd,
        Self::DiffDel,
        Self::DiffMod,
    ];

    pub const fn index(self) -> usize {
        self as u8 as usize
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Foreground => "foreground",
            Self::Muted => "muted",
            Self::Emphasis => "emphasis",
            Self::Code => "code",
            Self::Chrome => "chrome",
            Self::Border => "border",
            Self::Surface => "surface",
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Success => "success",
            Self::Running => "running",
            Self::Auto => "auto",
            Self::Attention => "attention",
            Self::Accent => "accent",
            Self::DiffAdd => "diff_add",
            Self::DiffDel => "diff_del",
            Self::DiffMod => "diff_mod",
        }
    }

    /// The only string parse. Unknown names are not roles (the resolver ignores them).
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "foreground" => Self::Foreground,
            "muted" => Self::Muted,
            "emphasis" => Self::Emphasis,
            "code" => Self::Code,
            "chrome" => Self::Chrome,
            "border" => Self::Border,
            "surface" => Self::Surface,
            "error" => Self::Error,
            "warning" => Self::Warning,
            "success" => Self::Success,
            "running" => Self::Running,
            "auto" => Self::Auto,
            "attention" => Self::Attention,
            "accent" => Self::Accent,
            "diff_add" => Self::DiffAdd,
            "diff_del" => Self::DiffDel,
            "diff_mod" => Self::DiffMod,
            _ => return None,
        })
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Foreground prominence ladder. Branded floats in TypeScript; plain `f64` here.
pub struct FgP;

impl FgP {
    pub const WHISPER: f64 = 0.28;
    pub const GHOST: f64 = 0.42;
    pub const RISING: f64 = 0.57;
    pub const SECONDARY: f64 = 0.72;
    pub const PRIMARY: f64 = 1.0;
}

/// Background fill solidity. Independent of region prominence.
pub struct BgP;

impl BgP {
    pub const MIST: f64 = 0.28;
    pub const WASH: f64 = 0.5;
    pub const PANEL: f64 = 0.85;
    pub const SOLID: f64 = 1.0;
}

/// Non-finite prominence is a full paint, matching the resolver clamp.
pub(crate) fn clamp01(p: f64) -> f64 {
    if p.is_finite() {
        p.clamp(0.0, 1.0)
    } else {
        1.0
    }
}
