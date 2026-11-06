use std::borrow::Cow;
use unicode_width::UnicodeWidthStr;

use crate::layout::Alignment;
use crate::style::{Color, Modifier, Style, Stylize};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Span<'a> {
    pub content: Cow<'a, str>,
    pub style: Style,
}

impl<'a> Span<'a> {
    pub fn raw<T: Into<Cow<'a, str>>>(content: T) -> Self {
        Self {
            content: content.into(),
            style: Style::default(),
        }
    }

    pub fn styled<T: Into<Cow<'a, str>>>(content: T, style: Style) -> Self {
        Self {
            content: content.into(),
            style,
        }
    }

    pub fn width(&self) -> usize {
        self.content.width()
    }
}

impl<'a> From<&'a str> for Span<'a> {
    fn from(s: &'a str) -> Self {
        Span::raw(s)
    }
}

impl<'a> From<String> for Span<'a> {
    fn from(s: String) -> Self {
        Span::raw(s)
    }
}

impl<'a> From<Cow<'a, str>> for Span<'a> {
    fn from(s: Cow<'a, str>) -> Self {
        Span::raw(s)
    }
}

impl<'a> Stylize for Span<'a> {
    fn set_style(mut self, style: Style) -> Self {
        self.style = self.style.patch(style);
        self
    }

    fn fg(mut self, color: Color) -> Self {
        self.style = self.style.fg(color);
        self
    }

    fn bg(mut self, color: Color) -> Self {
        self.style = self.style.bg(color);
        self
    }

    fn modifier(mut self, modifier: Modifier) -> Self {
        self.style = self.style.add_modifier(modifier);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Line<'a> {
    pub spans: Vec<Span<'a>>,
    pub style: Style,
    pub alignment: Option<Alignment>,
}

impl<'a> Line<'a> {
    pub fn raw<T: Into<Cow<'a, str>>>(content: T) -> Self {
        Self {
            spans: vec![Span::raw(content)],
            style: Style::default(),
            alignment: None,
        }
    }

    pub fn styled<T: Into<Cow<'a, str>>>(content: T, style: Style) -> Self {
        Self {
            spans: vec![Span::styled(content, style)],
            style: Style::default(),
            alignment: None,
        }
    }

    pub fn alignment(mut self, alignment: Alignment) -> Self {
        self.alignment = Some(alignment);
        self
    }

    pub fn width(&self) -> usize {
        self.spans.iter().map(|s| s.width()).sum()
    }
}

impl<'a> From<Vec<Span<'a>>> for Line<'a> {
    fn from(spans: Vec<Span<'a>>) -> Self {
        Self {
            spans,
            style: Style::default(),
            alignment: None,
        }
    }
}

impl<'a> From<&'a str> for Line<'a> {
    fn from(s: &'a str) -> Self {
        Line::raw(s)
    }
}

impl<'a> From<String> for Line<'a> {
    fn from(s: String) -> Self {
        Line::raw(s)
    }
}

impl<'a> From<Span<'a>> for Line<'a> {
    fn from(span: Span<'a>) -> Self {
        Self {
            spans: vec![span],
            style: Style::default(),
            alignment: None,
        }
    }
}

impl<'a> Stylize for Line<'a> {
    fn set_style(mut self, style: Style) -> Self {
        self.style = self.style.patch(style);
        self
    }

    fn fg(mut self, color: Color) -> Self {
        self.style = self.style.fg(color);
        self
    }

    fn bg(mut self, color: Color) -> Self {
        self.style = self.style.bg(color);
        self
    }

    fn modifier(mut self, modifier: Modifier) -> Self {
        self.style = self.style.add_modifier(modifier);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Text<'a> {
    pub lines: Vec<Line<'a>>,
    pub style: Style,
    pub alignment: Option<Alignment>,
}

impl<'a> Text<'a> {
    pub fn raw<T: Into<Cow<'a, str>>>(content: T) -> Self {
        let cow: Cow<'a, str> = content.into();
        let lines = match cow {
            Cow::Borrowed(s) => s.lines().map(Line::from).collect(),
            Cow::Owned(s) => s.lines().map(|l| Line::raw(l.to_string())).collect(),
        };
        Self {
            lines,
            style: Style::default(),
            alignment: None,
        }
    }

    pub fn styled<T: Into<Cow<'a, str>>>(content: T, style: Style) -> Self {
        let mut t = Self::raw(content);
        t.style = style;
        t
    }

    pub fn alignment(mut self, alignment: Alignment) -> Self {
        self.alignment = Some(alignment);
        self
    }

    pub fn width(&self) -> usize {
        self.lines.iter().map(|l| l.width()).max().unwrap_or(0)
    }

    pub fn height(&self) -> usize {
        self.lines.len()
    }
}

impl<'a> From<Vec<Line<'a>>> for Text<'a> {
    fn from(lines: Vec<Line<'a>>) -> Self {
        Self {
            lines,
            style: Style::default(),
            alignment: None,
        }
    }
}

impl<'a> From<&'a str> for Text<'a> {
    fn from(s: &'a str) -> Self {
        Text::raw(s)
    }
}

impl<'a> From<String> for Text<'a> {
    fn from(s: String) -> Self {
        Text::raw(s)
    }
}

impl<'a> From<Line<'a>> for Text<'a> {
    fn from(line: Line<'a>) -> Self {
        Self {
            lines: vec![line],
            style: Style::default(),
            alignment: None,
        }
    }
}

impl<'a> From<Span<'a>> for Text<'a> {
    fn from(span: Span<'a>) -> Self {
        Self {
            lines: vec![Line::from(span)],
            style: Style::default(),
            alignment: None,
        }
    }
}

impl<'a> Stylize for Text<'a> {
    fn set_style(mut self, style: Style) -> Self {
        self.style = self.style.patch(style);
        self
    }

    fn fg(mut self, color: Color) -> Self {
        self.style = self.style.fg(color);
        self
    }

    fn bg(mut self, color: Color) -> Self {
        self.style = self.style.bg(color);
        self
    }

    fn modifier(mut self, modifier: Modifier) -> Self {
        self.style = self.style.add_modifier(modifier);
        self
    }
}
