use bitflags::bitflags;

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
    pub struct Modifier: u16 {
        const BOLD              = 1 << 0;
        const DIM               = 1 << 1;
        const ITALIC            = 1 << 2;
        const UNDERLINED        = 1 << 3;
        const SLOW_BLINK        = 1 << 4;
        const RAPID_BLINK       = 1 << 5;
        const REVERSED          = 1 << 6;
        const HIDDEN            = 1 << 7;
        const CROSSED_OUT       = 1 << 8;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub enum Color {
    #[default]
    Reset,
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    Gray,
    DarkGray,
    LightRed,
    LightGreen,
    LightYellow,
    LightBlue,
    LightMagenta,
    LightCyan,
    White,
    Rgb(u8, u8, u8),
    Indexed(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Style {
    pub fg: Option<Color>,
    pub bg: Option<Color>,
    pub add_modifier: Modifier,
    pub sub_modifier: Modifier,
}

impl Style {
    pub const fn new() -> Self {
        Self {
            fg: None,
            bg: None,
            add_modifier: Modifier::empty(),
            sub_modifier: Modifier::empty(),
        }
    }

    pub const fn reset() -> Self {
        Self::new()
    }

    pub const fn fg(mut self, color: Color) -> Self {
        self.fg = Some(color);
        self
    }

    pub const fn bg(mut self, color: Color) -> Self {
        self.bg = Some(color);
        self
    }

    pub const fn add_modifier(mut self, modifier: Modifier) -> Self {
        self.add_modifier = self.add_modifier.union(modifier);
        self.sub_modifier = self.sub_modifier.difference(modifier);
        self
    }

    pub const fn remove_modifier(mut self, modifier: Modifier) -> Self {
        self.sub_modifier = self.sub_modifier.union(modifier);
        self.add_modifier = self.add_modifier.difference(modifier);
        self
    }

    pub fn patch(mut self, other: Self) -> Self {
        if let Some(fg) = other.fg {
            self.fg = Some(fg);
        }
        if let Some(bg) = other.bg {
            self.bg = Some(bg);
        }
        self.add_modifier.remove(other.sub_modifier);
        self.add_modifier.insert(other.add_modifier);
        self.sub_modifier.remove(other.add_modifier);
        self.sub_modifier.insert(other.sub_modifier);
        self
    }
}

pub trait Stylize: Sized {
    fn set_style(self, style: Style) -> Self;

    fn fg(self, color: Color) -> Self;
    fn bg(self, color: Color) -> Self;

    fn bold(self) -> Self {
        self.modifier(Modifier::BOLD)
    }

    fn dim(self) -> Self {
        self.modifier(Modifier::DIM)
    }

    fn italic(self) -> Self {
        self.modifier(Modifier::ITALIC)
    }

    fn underlined(self) -> Self {
        self.modifier(Modifier::UNDERLINED)
    }

    fn reversed(self) -> Self {
        self.modifier(Modifier::REVERSED)
    }

    fn modifier(self, modifier: Modifier) -> Self;
}

impl Stylize for Style {
    fn set_style(self, style: Style) -> Self {
        self.patch(style)
    }

    fn fg(self, color: Color) -> Self {
        self.fg(color)
    }

    fn bg(self, color: Color) -> Self {
        self.bg(color)
    }

    fn modifier(self, modifier: Modifier) -> Self {
        self.add_modifier(modifier)
    }
}
