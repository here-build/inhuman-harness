//! Interactive drawer widget for /connect, /model, /mcp, /skills, and /agents pickers.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, StatefulWidget, Widget};
use unicode_width::UnicodeWidthStr;

use crate::drawers::AgentRow;

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
                    it.title
                        .to_lowercase()
                        .contains(&state.filter_query.to_lowercase())
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
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default()
                    },
                ),
                Span::styled(
                    &item.title,
                    if is_sel {
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::Gray)
                    },
                ),
            ];

            if let Some(badge) = &item.badge {
                spans.push(Span::raw(" "));
                spans.push(Span::styled(
                    format!("[{badge}]"),
                    Style::default().fg(if item.active {
                        Color::Green
                    } else {
                        Color::DarkGray
                    }),
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

/// Replica-facing open subagents drawer (`PaintReplica::render_ratatui`).
pub struct AgentsReplicaDrawerWidget<'a> {
    pub header_left: &'a str,
    pub header_right: &'a str,
    pub rows: &'a [AgentRow],
    pub focus_key: &'a str,
    pub scroll: usize,
}

impl<'a> AgentsReplicaDrawerWidget<'a> {
    pub fn new(
        header_left: &'a str,
        header_right: &'a str,
        rows: &'a [AgentRow],
        focus_key: &'a str,
        scroll: usize,
    ) -> Self {
        Self {
            header_left,
            header_right,
            rows,
            focus_key,
            scroll,
        }
    }
}

impl Widget for AgentsReplicaDrawerWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let title_str = if self.header_left.is_empty() {
            " Agents ".to_string()
        } else {
            format!(" {} ", self.header_left)
        };
        let block = Block::default()
            .title(Line::from(Span::styled(
                title_str,
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )))
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(Color::DarkGray))
            .style(Style::default().bg(Color::Rgb(20, 23, 30)));
        let inner = block.inner(area);
        block.render(area, buf);
        if inner.is_empty() {
            return;
        }

        let mut y = inner.top();
        for row in self.rows.iter().skip(self.scroll) {
            if y >= inner.bottom() {
                break;
            }
            let focused = !self.focus_key.is_empty() && row.key == self.focus_key;
            let row_bg = if focused {
                Color::Rgb(36, 44, 62)
            } else {
                Color::Rgb(20, 23, 30)
            };
            if focused {
                for x in inner.left()..inner.right() {
                    buf.get_mut(x, y).set_bg(row_bg);
                }
            }
            let (sigil, sigil_fg) = match row.mark.as_str() {
                "live" | "●" => ("●", Color::Cyan),
                "waiting" | "?" => ("?", Color::Yellow),
                "failed" | "■" => ("■", Color::Red),
                _ => ("✓", Color::Green),
            };
            let tree_pad = "  ".repeat(row.indent.max(0) as usize);
            let mut spans = vec![
                Span::styled(
                    if focused { "▸ " } else { "  " },
                    Style::default().fg(Color::Cyan).bg(row_bg),
                ),
                Span::styled(tree_pad, Style::default().bg(row_bg)),
                Span::styled(format!("{sigil} "), Style::default().fg(sigil_fg).bg(row_bg)),
                Span::styled(
                    row.name.clone(),
                    Style::default()
                        .fg(Color::White)
                        .bg(row_bg)
                        .add_modifier(Modifier::BOLD),
                ),
            ];
            if !row.recap.is_empty() {
                spans.push(Span::styled(
                    format!(" — {}", row.recap),
                    Style::default().fg(Color::Gray).bg(row_bg),
                ));
            }
            buf.set_line(inner.left(), y, &Line::from(spans), inner.width);

            if !row.model.is_empty() {
                let ew = row.model.width() as u16;
                if ew + 4 < inner.width {
                    buf.set_stringn(
                        inner.right().saturating_sub(ew),
                        y,
                        &row.model,
                        ew as usize,
                        Style::default().fg(Color::DarkGray).bg(row_bg),
                    );
                }
            }
            y += 1;
        }
    }
}

/// Peek plaque widget for the focused subagent in the open Agents drawer.
pub struct AgentsPeekWidget<'a> {
    pub row: &'a AgentRow,
}

impl<'a> AgentsPeekWidget<'a> {
    pub fn new(row: &'a AgentRow) -> Self {
        Self { row }
    }
}

impl Widget for AgentsPeekWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let block = Block::default()
            .title(Line::from(Span::styled(
                format!(" {} ", self.row.name),
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )))
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(Color::DarkGray))
            .style(Style::default().bg(Color::Rgb(18, 20, 26)));
        let inner = block.inner(area);
        block.render(area, buf);
        if inner.is_empty() {
            return;
        }

        let mut y = inner.top();
        if !self.row.ask_line.is_empty() && y < inner.bottom() {
            buf.set_stringn(
                inner.left(),
                y,
                format!("? {}", self.row.ask_line),
                inner.width as usize,
                Style::default().fg(Color::Yellow),
            );
            y += 1;
        }
        if !self.row.unfinished.is_empty() && y < inner.bottom() {
            buf.set_stringn(
                inner.left(),
                y,
                &self.row.unfinished,
                inner.width as usize,
                Style::default().fg(Color::LightRed),
            );
            y += 1;
        }
        for line in self
            .row
            .result
            .lines()
            .chain(self.row.recap.lines())
            .filter(|l: &&str| !l.trim().is_empty())
        {
            if y >= inner.bottom() {
                break;
            }
            buf.set_stringn(
                inner.left(),
                y,
                line,
                inner.width as usize,
                Style::default().fg(Color::Gray),
            );
            y += 1;
        }
    }
}
