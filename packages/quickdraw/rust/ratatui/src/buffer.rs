use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::layout::{Position, Rect};
use crate::style::{Color, Modifier, Style};
use crate::text::{Line, Span};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub symbol: String,
    pub fg: Color,
    pub bg: Color,
    pub modifier: Modifier,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            symbol: " ".to_string(),
            fg: Color::Reset,
            bg: Color::Reset,
            modifier: Modifier::empty(),
        }
    }
}

impl Cell {
    pub fn symbol(&self) -> &str {
        &self.symbol
    }

    pub fn set_symbol(&mut self, symbol: &str) -> &mut Self {
        self.symbol.clear();
        self.symbol.push_str(symbol);
        self
    }

    pub fn set_char(&mut self, ch: char) -> &mut Self {
        self.symbol.clear();
        self.symbol.push(ch);
        self
    }

    pub fn set_fg(&mut self, color: Color) -> &mut Self {
        self.fg = color;
        self
    }

    pub fn set_bg(&mut self, color: Color) -> &mut Self {
        self.bg = color;
        self
    }

    pub fn set_style(&mut self, style: Style) -> &mut Self {
        if let Some(fg) = style.fg {
            self.fg = fg;
        }
        if let Some(bg) = style.bg {
            self.bg = bg;
        }
        self.modifier.remove(style.sub_modifier);
        self.modifier.insert(style.add_modifier);
        self
    }

    pub fn reset(&mut self) {
        self.symbol.clear();
        self.symbol.push(' ');
        self.fg = Color::Reset;
        self.bg = Color::Reset;
        self.modifier = Modifier::empty();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Buffer {
    pub area: Rect,
    pub content: Vec<Cell>,
}

impl Buffer {
    pub fn empty(area: Rect) -> Self {
        let size = area.area() as usize;
        Self {
            area,
            content: vec![Cell::default(); size],
        }
    }

    pub fn filled(area: Rect, cell: &Cell) -> Self {
        let size = area.area() as usize;
        Self {
            area,
            content: vec![cell.clone(); size],
        }
    }

    pub fn area(&self) -> &Rect {
        &self.area
    }

    pub fn index_of(&self, x: u16, y: u16) -> usize {
        debug_assert!(
            self.area.contains(Position::new(x, y)),
            "Coordinates ({}, {}) out of bounds {:?}",
            x,
            y,
            self.area
        );
        ((y - self.area.y) as usize * self.area.width as usize) + (x - self.area.x) as usize
    }

    pub fn get(&self, x: u16, y: u16) -> &Cell {
        let idx = self.index_of(x, y);
        &self.content[idx]
    }

    pub fn get_mut(&mut self, x: u16, y: u16) -> &mut Cell {
        let idx = self.index_of(x, y);
        &mut self.content[idx]
    }

    pub fn set_string<S: AsRef<str>>(&mut self, x: u16, y: u16, string: S, style: Style) {
        self.set_stringn(x, y, string, usize::MAX, style);
    }

    pub fn set_stringn<S: AsRef<str>>(
        &mut self,
        x: u16,
        y: u16,
        string: S,
        max_width: usize,
        style: Style,
    ) {
        let mut curr_x = x;
        let mut rem_width = max_width;
        let s = string.as_ref();

        for grapheme in s.graphemes(true) {
            let width = grapheme.width();
            if width == 0 {
                continue;
            }
            if rem_width < width || curr_x >= self.area.right() || y >= self.area.bottom() {
                break;
            }
            if curr_x >= self.area.left() && y >= self.area.top() {
                let cell = self.get_mut(curr_x, y);
                cell.set_symbol(grapheme);
                cell.set_style(style);

                // Handle double-width characters
                for i in 1..width {
                    if curr_x + (i as u16) < self.area.right() {
                        let follower = self.get_mut(curr_x + (i as u16), y);
                        follower.reset();
                        follower.set_style(style);
                    }
                }
            }
            curr_x = curr_x.saturating_add(width as u16);
            rem_width = rem_width.saturating_sub(width);
        }
    }

    pub fn set_span(&mut self, x: u16, y: u16, span: &Span, max_width: u16) {
        self.set_stringn(x, y, &span.content, max_width as usize, span.style);
    }

    pub fn set_line(&mut self, x: u16, y: u16, line: &Line, max_width: u16) {
        let mut curr_x = x;
        let mut rem_width = max_width;
        for span in &line.spans {
            if rem_width == 0 {
                break;
            }
            let span_style = line.style.patch(span.style);
            let span_to_draw = Span::styled(span.content.clone(), span_style);
            let drawn_width = span.width().min(rem_width as usize) as u16;
            self.set_span(curr_x, y, &span_to_draw, rem_width);
            curr_x = curr_x.saturating_add(drawn_width);
            rem_width = rem_width.saturating_sub(drawn_width);
        }
    }

    pub fn reset(&mut self) {
        for cell in &mut self.content {
            cell.reset();
        }
    }

    pub fn resize(&mut self, area: Rect) {
        if self.area != area {
            self.area = area;
            self.content.resize(area.area() as usize, Cell::default());
            self.reset();
        }
    }

    pub fn merge(&mut self, other: &Buffer) {
        let inter = self.area.intersection(other.area);
        if inter.is_empty() {
            return;
        }
        for y in inter.top()..inter.bottom() {
            for x in inter.left()..inter.right() {
                let cell = other.get(x, y).clone();
                *self.get_mut(x, y) = cell;
            }
        }
    }
}
