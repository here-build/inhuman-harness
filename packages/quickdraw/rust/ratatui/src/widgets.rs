use bitflags::bitflags;

use crate::buffer::Buffer;
use crate::layout::{Alignment, Margin, Rect};
use crate::style::Style;
use crate::text::{Line, Text};

pub trait Widget {
    fn render(self, area: Rect, buf: &mut Buffer);
}

pub trait StatefulWidget {
    type State;
    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State);
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
    pub struct Borders: u8 {
        const NONE   = 0b0000;
        const TOP    = 0b0001;
        const RIGHT  = 0b0010;
        const BOTTOM = 0b0100;
        const LEFT   = 0b1000;
        const ALL    = Self::TOP.bits() | Self::RIGHT.bits() | Self::BOTTOM.bits() | Self::LEFT.bits();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub enum BorderType {
    #[default]
    Plain,
    Rounded,
    Double,
    Thick,
}

impl BorderType {
    pub const fn border_symbols(self) -> BorderSymbols {
        match self {
            BorderType::Plain => BorderSymbols {
                vertical: "│",
                horizontal: "─",
                top_left: "┌",
                top_right: "┐",
                bottom_left: "└",
                bottom_right: "┘",
            },
            BorderType::Rounded => BorderSymbols {
                vertical: "│",
                horizontal: "─",
                top_left: "╭",
                top_right: "╮",
                bottom_left: "╰",
                bottom_right: "╯",
            },
            BorderType::Double => BorderSymbols {
                vertical: "║",
                horizontal: "═",
                top_left: "╔",
                top_right: "╗",
                bottom_left: "╚",
                bottom_right: "╝",
            },
            BorderType::Thick => BorderSymbols {
                vertical: "┃",
                horizontal: "━",
                top_left: "┏",
                top_right: "┓",
                bottom_left: "┗",
                bottom_right: "┛",
            },
        }
    }
}

pub struct BorderSymbols {
    pub vertical: &'static str,
    pub horizontal: &'static str,
    pub top_left: &'static str,
    pub top_right: &'static str,
    pub bottom_left: &'static str,
    pub bottom_right: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Block<'a> {
    pub title: Option<Line<'a>>,
    pub title_alignment: Alignment,
    pub borders: Borders,
    pub border_style: Style,
    pub border_type: BorderType,
    pub style: Style,
}

impl<'a> Block<'a> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn title<T: Into<Line<'a>>>(mut self, title: T) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn title_alignment(mut self, alignment: Alignment) -> Self {
        self.title_alignment = alignment;
        self
    }

    pub fn borders(mut self, borders: Borders) -> Self {
        self.borders = borders;
        self
    }

    pub fn border_style(mut self, style: Style) -> Self {
        self.border_style = style;
        self
    }

    pub fn border_type(mut self, border_type: BorderType) -> Self {
        self.border_type = border_type;
        self
    }

    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    pub fn inner(&self, area: Rect) -> Rect {
        if area.is_empty() {
            return area;
        }
        let margin = Margin {
            horizontal: if self.borders.contains(Borders::LEFT) || self.borders.contains(Borders::RIGHT) {
                1
            } else {
                0
            },
            vertical: if self.borders.contains(Borders::TOP) || self.borders.contains(Borders::BOTTOM) {
                1
            } else {
                0
            },
        };
        area.inner(margin)
    }
}

impl<'a> Widget for Block<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        // Fill background
        for y in area.top()..area.bottom() {
            for x in area.left()..area.right() {
                buf.get_mut(x, y).set_style(self.style);
            }
        }

        let sym = self.border_type.border_symbols();

        if self.borders.contains(Borders::LEFT) {
            for y in area.top()..area.bottom() {
                let cell = buf.get_mut(area.left(), y);
                cell.set_symbol(sym.vertical);
                cell.set_style(self.border_style);
            }
        }
        if self.borders.contains(Borders::RIGHT) && area.width > 0 {
            for y in area.top()..area.bottom() {
                let cell = buf.get_mut(area.right().saturating_sub(1), y);
                cell.set_symbol(sym.vertical);
                cell.set_style(self.border_style);
            }
        }
        if self.borders.contains(Borders::TOP) {
            for x in area.left()..area.right() {
                let cell = buf.get_mut(x, area.top());
                cell.set_symbol(sym.horizontal);
                cell.set_style(self.border_style);
            }
        }
        if self.borders.contains(Borders::BOTTOM) && area.height > 0 {
            for x in area.left()..area.right() {
                let cell = buf.get_mut(x, area.bottom().saturating_sub(1));
                cell.set_symbol(sym.horizontal);
                cell.set_style(self.border_style);
            }
        }

        // Corners
        if self.borders.contains(Borders::LEFT | Borders::TOP) {
            let cell = buf.get_mut(area.left(), area.top());
            cell.set_symbol(sym.top_left);
            cell.set_style(self.border_style);
        }
        if self.borders.contains(Borders::RIGHT | Borders::TOP) && area.width > 0 {
            let cell = buf.get_mut(area.right().saturating_sub(1), area.top());
            cell.set_symbol(sym.top_right);
            cell.set_style(self.border_style);
        }
        if self.borders.contains(Borders::LEFT | Borders::BOTTOM) && area.height > 0 {
            let cell = buf.get_mut(area.left(), area.bottom().saturating_sub(1));
            cell.set_symbol(sym.bottom_left);
            cell.set_style(self.border_style);
        }
        if self.borders.contains(Borders::RIGHT | Borders::BOTTOM)
            && area.width > 0
            && area.height > 0
        {
            let cell = buf.get_mut(area.right().saturating_sub(1), area.bottom().saturating_sub(1));
            cell.set_symbol(sym.bottom_right);
            cell.set_style(self.border_style);
        }

        // Title
        if let Some(title) = self.title {
            let title_width = title.width() as u16;
            let available_width = area.width.saturating_sub(2);
            if title_width > 0 && available_width > 0 {
                let x = match self.title_alignment {
                    Alignment::Left => area.left().saturating_add(1),
                    Alignment::Center => {
                        let center_offset = (available_width.saturating_sub(title_width)) / 2;
                        area.left().saturating_add(1).saturating_add(center_offset)
                    }
                    Alignment::Right => area
                        .right()
                        .saturating_sub(1)
                        .saturating_sub(title_width)
                        .max(area.left().saturating_add(1)),
                };
                buf.set_line(x, area.top(), &title, available_width);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Wrap {
    pub trim: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Paragraph<'a> {
    pub text: Text<'a>,
    pub style: Style,
    pub block: Option<Block<'a>>,
    pub wrap: Option<Wrap>,
    pub alignment: Alignment,
    pub scroll: (u16, u16),
}

impl<'a> Paragraph<'a> {
    pub fn new<T: Into<Text<'a>>>(text: T) -> Self {
        Self {
            text: text.into(),
            style: Style::default(),
            block: None,
            wrap: None,
            alignment: Alignment::Left,
            scroll: (0, 0),
        }
    }

    pub fn style(mut self, style: Style) -> Self {
        self.style = style;
        self
    }

    pub fn block(mut self, block: Block<'a>) -> Self {
        self.block = Some(block);
        self
    }

    pub fn wrap(mut self, wrap: Wrap) -> Self {
        self.wrap = Some(wrap);
        self
    }

    pub fn alignment(mut self, alignment: Alignment) -> Self {
        self.alignment = alignment;
        self
    }

    pub fn scroll(mut self, scroll: (u16, u16)) -> Self {
        self.scroll = scroll;
        self
    }
}

impl<'a> Widget for Paragraph<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let text_area = match &self.block {
            Some(b) => {
                let inner = b.inner(area);
                b.clone().render(area, buf);
                inner
            }
            None => area,
        };

        if text_area.is_empty() {
            return;
        }

        let (scroll_x, scroll_y) = self.scroll;
        let mut y = text_area.top();

        for line in self.text.lines.into_iter().skip(scroll_y as usize) {
            if y >= text_area.bottom() {
                break;
            }
            let line_width = line.width() as u16;
            let effective_alignment = line.alignment.unwrap_or(self.alignment);

            let x = match effective_alignment {
                Alignment::Left => text_area.left().saturating_sub(scroll_x),
                Alignment::Center => {
                    let offset = (text_area.width.saturating_sub(line_width)) / 2;
                    text_area.left().saturating_add(offset).saturating_sub(scroll_x)
                }
                Alignment::Right => text_area
                    .right()
                    .saturating_sub(line_width)
                    .saturating_sub(scroll_x)
                    .max(text_area.left()),
            };

            buf.set_line(x, y, &line, text_area.width);
            y = y.saturating_add(1);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScrollbarOrientation {
    #[default]
    VerticalRight,
    VerticalLeft,
    HorizontalBottom,
    HorizontalTop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScrollbarState {
    pub content_length: usize,
    pub position: usize,
    pub viewport_content_length: usize,
}

impl ScrollbarState {
    pub fn new(content_length: usize) -> Self {
        Self {
            content_length,
            position: 0,
            viewport_content_length: 0,
        }
    }

    pub fn position(mut self, position: usize) -> Self {
        self.position = position;
        self
    }

    pub fn viewport_content_length(mut self, length: usize) -> Self {
        self.viewport_content_length = length;
        self
    }

    pub fn prev(&mut self) {
        self.position = self.position.saturating_sub(1);
    }

    pub fn next(&mut self) {
        self.position = self.position.saturating_add(1).min(self.content_length);
    }

    pub fn first(&mut self) {
        self.position = 0;
    }

    pub fn last(&mut self) {
        self.position = self.content_length;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scrollbar<'a> {
    pub orientation: ScrollbarOrientation,
    pub thumb_style: Style,
    pub track_style: Style,
    pub thumb_symbol: &'a str,
    pub track_symbol: Option<&'a str>,
}

impl<'a> Default for Scrollbar<'a> {
    fn default() -> Self {
        Self {
            orientation: ScrollbarOrientation::VerticalRight,
            thumb_style: Style::default(),
            track_style: Style::default(),
            thumb_symbol: "█",
            track_symbol: Some("░"),
        }
    }
}

impl<'a> Scrollbar<'a> {
    pub fn new(orientation: ScrollbarOrientation) -> Self {
        Self {
            orientation,
            ..Default::default()
        }
    }

    pub fn thumb_style(mut self, style: Style) -> Self {
        self.thumb_style = style;
        self
    }

    pub fn track_style(mut self, style: Style) -> Self {
        self.track_style = style;
        self
    }

    pub fn thumb_symbol(mut self, symbol: &'a str) -> Self {
        self.thumb_symbol = symbol;
        self
    }

    pub fn track_symbol(mut self, symbol: Option<&'a str>) -> Self {
        self.track_symbol = symbol;
        self
    }
}

impl<'a> StatefulWidget for Scrollbar<'a> {
    type State = ScrollbarState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State) {
        if area.is_empty() || state.content_length == 0 {
            return;
        }

        let is_vertical = matches!(
            self.orientation,
            ScrollbarOrientation::VerticalRight | ScrollbarOrientation::VerticalLeft
        );

        let track_len = if is_vertical { area.height } else { area.width };
        if track_len == 0 {
            return;
        }

        let vp = state.viewport_content_length.max(1);
        let thumb_size = ((track_len as f64 * (vp as f64 / state.content_length as f64)).round()
            as u16)
            .clamp(1, track_len);
        let max_pos = state.content_length.saturating_sub(vp).max(1);
        let curr_pos = state.position.min(max_pos);
        let thumb_offset =
            ((track_len.saturating_sub(thumb_size) as f64 * (curr_pos as f64 / max_pos as f64))
                .round() as u16)
                .min(track_len.saturating_sub(thumb_size));

        for i in 0..track_len {
            let (x, y) = match self.orientation {
                ScrollbarOrientation::VerticalRight => (area.right().saturating_sub(1), area.top() + i),
                ScrollbarOrientation::VerticalLeft => (area.left(), area.top() + i),
                ScrollbarOrientation::HorizontalBottom => (area.left() + i, area.bottom().saturating_sub(1)),
                ScrollbarOrientation::HorizontalTop => (area.left() + i, area.top()),
            };

            if i >= thumb_offset && i < thumb_offset + thumb_size {
                let cell = buf.get_mut(x, y);
                cell.set_symbol(self.thumb_symbol);
                cell.set_style(self.thumb_style);
            } else if let Some(sym) = self.track_symbol {
                let cell = buf.get_mut(x, y);
                cell.set_symbol(sym);
                cell.set_style(self.track_style);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Clear;

impl Widget for Clear {
    fn render(self, area: Rect, buf: &mut Buffer) {
        for y in area.top()..area.bottom() {
            for x in area.left()..area.right() {
                buf.get_mut(x, y).reset();
            }
        }
    }
}
