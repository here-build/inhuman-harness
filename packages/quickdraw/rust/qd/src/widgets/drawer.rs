//! Interactive drawer widget for /connect, /model, /mcp, /skills, and /agents pickers.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, StatefulWidget, Widget};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawerKind {
    Connect,
    Model,
    Mcp,
    Skills,
    Agents,
}

impl DrawerKind {
    pub const fn default_title(self) -> &'static str {
        match self {
            DrawerKind::Connect => " Connect Providers ",
            DrawerKind::Model => " Select Model ",
            DrawerKind::Mcp => " MCP Tool Servers ",
            DrawerKind::Skills => " Loaded Skills ",
            DrawerKind::Agents => " Active Subagents ",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrawerItem {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub badge: Option<String>,
    pub active: bool,
}

impl DrawerItem {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            subtitle: None,
            badge: None,
            active: false,
        }
    }

    pub fn with_subtitle(mut self, sub: impl Into<String>) -> Self {
        self.subtitle = Some(sub.into());
        self
    }

    pub fn with_badge(mut self, badge: impl Into<String>) -> Self {
        self.badge = Some(badge.into());
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DrawerState {
    pub selected_index: usize,
    pub filter_query: String,
    pub scroll_offset: usize,
}

impl DrawerState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn select_next(&mut self, total: usize) {
        if total > 0 {
            self.selected_index = (self.selected_index + 1).min(total - 1);
        }
    }

    pub fn select_prev(&mut self) {
        self.selected_index = self.selected_index.saturating_sub(1);
    }
}

#[derive(Debug, Clone)]
pub struct DrawerWidget {
    pub kind: DrawerKind,
    pub title: Option<String>,
    pub items: Vec<DrawerItem>,
    pub width: u16,
}

impl DrawerWidget {
    pub fn new(kind: DrawerKind, items: Vec<DrawerItem>) -> Self {
        Self {
            kind,
            title: None,
            items,
            width: 48,
        }
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn width(mut self, width: u16) -> Self {
        self.width = width;
        self
    }
}

impl StatefulWidget for DrawerWidget {
    type State = DrawerState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State) {
        if area.is_empty() {
            return;
        }

        let drawer_w = self.width.min(area.width);
        let drawer_h = area.height.saturating_sub(2).max(4);
        let x = area.right().saturating_sub(drawer_w);
        let y = area.top() + 1;
        let drawer_rect = Rect::new(x, y, drawer_w, drawer_h);

        Clear.render(drawer_rect, buf);

        let title = self
            .title
            .as_deref()
            .unwrap_or_else(|| self.kind.default_title());

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(Color::Cyan))
            .title(title);
        let inner = block.inner(drawer_rect);
        block.render(drawer_rect, buf);

        if inner.is_empty() {
            return;
        }

        let mut row_y = inner.top();

        if !state.filter_query.is_empty() {
            let filter_line = Line::from(vec![
                Span::styled("filter: ", Style::default().fg(Color::DarkGray)),
                Span::styled(&state.filter_query, Style::default().fg(Color::Yellow)),
            ]);
            buf.set_line(inner.left(), row_y, &filter_line, inner.width);
            row_y += 1;
        }

        let filtered: Vec<&DrawerItem> = self
            .items
            .iter()
            .filter(|it| {
                if state.filter_query.is_empty() {
                    true
                } else {
                    it.title.to_lowercase().contains(&state.filter_query.to_lowercase())
                }
            })
            .collect();

        if state.selected_index >= filtered.len() && !filtered.is_empty() {
            state.selected_index = filtered.len() - 1;
        }

        for (i, item) in filtered.into_iter().enumerate() {
            if row_y >= inner.bottom() {
                break;
            }
            let is_sel = i == state.selected_index;
            let pointer = if is_sel { "› " } else { "  " };

            let mut spans = vec![
                Span::styled(
                    pointer,
                    if is_sel {
                        Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default()
                    },
                ),
                Span::styled(
                    &item.title,
                    if is_sel {
                        Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::Gray)
                    },
                ),
            ];

            if let Some(badge) = &item.badge {
                spans.push(Span::raw(" "));
                spans.push(Span::styled(
                    format!("[{badge}]"),
                    Style::default().fg(if item.active { Color::Green } else { Color::DarkGray }),
                ));
            }

            if let Some(sub) = &item.subtitle {
                spans.push(Span::raw("  "));
                spans.push(Span::styled(sub, Style::default().fg(Color::DarkGray)));
            }

            buf.set_line(inner.left(), row_y, &Line::from(spans), inner.width);
            row_y += 1;
        }
    }
}
