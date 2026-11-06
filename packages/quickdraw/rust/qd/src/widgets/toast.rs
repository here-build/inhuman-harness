//! Toast widget wrapping copy toast and host overlay notifications.

use unicode_width::UnicodeWidthStr;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Widget};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToastKind {
    #[default]
    Success,
    Info,
    Warning,
    Error,
}

impl ToastKind {
    pub const fn icon(self) -> &'static str {
        match self {
            ToastKind::Success => "✓ ",
            ToastKind::Info => "ℹ ",
            ToastKind::Warning => "⚠ ",
            ToastKind::Error => "✕ ",
        }
    }

    pub const fn color(self) -> Color {
        match self {
            ToastKind::Success => Color::Green,
            ToastKind::Info => Color::Cyan,
            ToastKind::Warning => Color::Yellow,
            ToastKind::Error => Color::Red,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToastPlacement {
    #[default]
    TopRight,
    BottomRight,
    Center,
}

#[derive(Debug, Clone)]
pub struct ToastWidget {
    pub message: String,
    pub kind: ToastKind,
    pub placement: ToastPlacement,
}

impl ToastWidget {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ToastKind::default(),
            placement: ToastPlacement::default(),
        }
    }

    pub fn success(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ToastKind::Success,
            placement: ToastPlacement::default(),
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ToastKind::Error,
            placement: ToastPlacement::default(),
        }
    }

    pub fn kind(mut self, kind: ToastKind) -> Self {
        self.kind = kind;
        self
    }

    pub fn placement(mut self, placement: ToastPlacement) -> Self {
        self.placement = placement;
        self
    }
}

impl Widget for ToastWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        let full_text = format!("{}{}", self.kind.icon(), self.message);
        let text_width = full_text.width() as u16;
        let box_width = (text_width + 4).min(area.width);
        let box_height = 3u16.min(area.height);

        let (x, y) = match self.placement {
            ToastPlacement::TopRight => (
                area.right().saturating_sub(box_width).saturating_sub(1),
                area.top() + 1,
            ),
            ToastPlacement::BottomRight => (
                area.right().saturating_sub(box_width).saturating_sub(1),
                area.bottom().saturating_sub(box_height).saturating_sub(1),
            ),
            ToastPlacement::Center => (
                area.left() + (area.width.saturating_sub(box_width)) / 2,
                area.top() + (area.height.saturating_sub(box_height)) / 2,
            ),
        };

        let toast_area = Rect::new(x, y, box_width, box_height);
        Clear.render(toast_area, buf);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(self.kind.color()));
        let inner = block.inner(toast_area);
        block.render(toast_area, buf);

        if inner.height > 0 && inner.width > 0 {
            buf.set_stringn(
                inner.left() + 1,
                inner.top(),
                full_text,
                inner.width.saturating_sub(2) as usize,
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
            );
        }
    }
}
