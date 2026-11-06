//! Tape widget for virtualized turn list with sticky bottom follow and selection range.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Scrollbar, ScrollbarOrientation, ScrollbarState, StatefulWidget, Widget};

use crate::widgets::speech::format_duration_compact;

/// One rewind neighbor the host already chose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewindPin {
    pub key: String,
    pub text: String,
}

/// First line, collapsed spaces. A multiline prompt keeps an ellipsis.
pub fn compact_pin_draft(prompt: &str) -> String {
    let first = prompt.split('\n').next().unwrap_or("");
    let mut collapsed = String::new();
    let mut gap = false;
    for ch in first.chars() {
        if ch.is_whitespace() {
            gap = !collapsed.is_empty();
            continue;
        }
        if gap {
            collapsed.push(' ');
            gap = false;
        }
        collapsed.push(ch);
    }
    if prompt.contains('\n') {
        collapsed.push('…');
    }
    collapsed
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TapeRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone)]
pub struct TapeTurnItem {
    pub id: String,
    pub role: TapeRole,
    pub lines: Vec<Line<'static>>,
    pub timestamp: Option<String>,
}

impl TapeTurnItem {
    pub fn new(id: impl Into<String>, role: TapeRole, lines: Vec<Line<'static>>) -> Self {
        Self {
            id: id.into(),
            role,
            lines,
            timestamp: None,
        }
    }

    pub fn with_timestamp(mut self, ts: impl Into<String>) -> Self {
        self.timestamp = Some(ts.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TapeState {
    pub scroll_offset: usize,
    pub sticky_bottom: bool,
    pub selected_index: Option<usize>,
    pub selected_range: Option<(usize, usize)>,
}

impl Default for TapeState {
    fn default() -> Self {
        Self {
            scroll_offset: 0,
            sticky_bottom: true,
            selected_index: None,
            selected_range: None,
        }
    }
}

impl TapeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn scroll_up(&mut self, lines: usize) {
        self.sticky_bottom = false;
        self.scroll_offset = self.scroll_offset.saturating_sub(lines);
    }

    pub fn scroll_down(&mut self, lines: usize, total_lines: usize, viewport_height: usize) {
        let max_scroll = total_lines.saturating_sub(viewport_height);
        self.scroll_offset = (self.scroll_offset + lines).min(max_scroll);
        if self.scroll_offset >= max_scroll {
            self.sticky_bottom = true;
        }
    }

    pub fn scroll_to_bottom(&mut self) {
        self.sticky_bottom = true;
    }

    pub fn select_turn(&mut self, index: usize) {
        self.selected_index = Some(index);
    }

    pub fn clear_selection(&mut self) {
        self.selected_index = None;
        self.selected_range = None;
    }
}

#[derive(Debug, Clone)]
pub struct TapeWidget {
    pub turns: Vec<TapeTurnItem>,
    pub show_scrollbar: bool,
    pub divider_style: Style,
    pub selection_style: Style,
}

impl TapeWidget {
    pub fn new(turns: Vec<TapeTurnItem>) -> Self {
        Self {
            turns,
            show_scrollbar: true,
            divider_style: Style::default().fg(Color::DarkGray),
            selection_style: Style::default().bg(Color::Rgb(40, 44, 52)),
        }
    }

    pub fn show_scrollbar(mut self, show: bool) -> Self {
        self.show_scrollbar = show;
        self
    }

    pub fn divider_style(mut self, style: Style) -> Self {
        self.divider_style = style;
        self
    }

    pub fn selection_style(mut self, style: Style) -> Self {
        self.selection_style = style;
        self
    }
}

impl StatefulWidget for TapeWidget {
    type State = TapeState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State) {
        if area.is_empty() {
            return;
        }

        struct DisplayRow {
            line: Line<'static>,
            is_selected: bool,
        }

        let mut display_rows = Vec::new();
        for (idx, turn) in self.turns.iter().enumerate() {
            let is_selected = state.selected_index == Some(idx)
                || state
                    .selected_range
                    .map_or(false, |(start, end)| idx >= start && idx <= end);

            let role_badge = match turn.role {
                TapeRole::User => Span::styled(
                    "❯ User",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                TapeRole::Assistant => Span::styled(
                    "● Assistant",
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                TapeRole::System => Span::styled("■ System", Style::default().fg(Color::Yellow)),
            };
            let mut header_spans = vec![role_badge];
            if let Some(ts) = &turn.timestamp {
                header_spans.push(Span::raw(" "));
                header_spans.push(Span::styled(
                    format!("({ts})"),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            display_rows.push(DisplayRow {
                line: Line::from(header_spans),
                is_selected,
            });

            for l in &turn.lines {
                display_rows.push(DisplayRow {
                    line: l.clone(),
                    is_selected,
                });
            }

            if idx + 1 < self.turns.len() {
                let div_str = "─".repeat(area.width as usize);
                display_rows.push(DisplayRow {
                    line: Line::styled(div_str, self.divider_style),
                    is_selected: false,
                });
            }
        }

        let total_lines = display_rows.len();
        let viewport_height = area.height as usize;

        if state.sticky_bottom {
            state.scroll_offset = total_lines.saturating_sub(viewport_height);
        } else {
            let max_scroll = total_lines.saturating_sub(viewport_height);
            state.scroll_offset = state.scroll_offset.min(max_scroll);
        }

        let content_width = if self.show_scrollbar && total_lines > viewport_height {
            area.width.saturating_sub(1)
        } else {
            area.width
        };

        for (i, row) in display_rows
            .into_iter()
            .skip(state.scroll_offset)
            .take(viewport_height)
            .enumerate()
        {
            let y = area.top() + i as u16;
            if row.is_selected {
                for x in area.left()..area.left() + content_width {
                    buf.get_mut(x, y).set_style(self.selection_style);
                }
            }
            buf.set_line(area.left(), y, &row.line, content_width);
        }

        if self.show_scrollbar && total_lines > viewport_height {
            let mut sb_state = ScrollbarState::new(total_lines)
                .position(state.scroll_offset)
                .viewport_content_length(viewport_height);
            let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
                .thumb_style(Style::default().fg(Color::Gray))
                .track_style(Style::default().fg(Color::DarkGray));
            scrollbar.render(area, buf, &mut sb_state);
        }
    }
}

/// Rewind pins widget rendering past or future rewind pins at the top/bottom of the tape.
pub struct RewindPinsWidget<'a> {
    pub pins: &'a [RewindPin],
}

impl<'a> RewindPinsWidget<'a> {
    pub fn new(pins: &'a [RewindPin]) -> Self {
        Self { pins }
    }

    pub fn height(&self) -> u16 {
        self.pins.len() as u16
    }
}

impl Widget for RewindPinsWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        for (i, pin) in self.pins.iter().enumerate() {
            let y = area.top() + i as u16;
            if y >= area.bottom() {
                break;
            }
            let row_style = Style::default().fg(Color::Gray);
            let spans = vec![
                Span::styled("  │ ", Style::default().fg(Color::DarkGray)),
                Span::styled(compact_pin_draft(&pin.text), row_style),
            ];
            buf.set_line(area.left(), y, &Line::from(spans), area.width);
        }
    }
}

/// Wait/spinner pin widget rendered at the bottom of the tape when the harness is working.
pub struct WaitPinWidget<'a> {
    pub status: &'a str,
    pub error: &'a str,
    pub started_at: Option<f64>,
    pub retry_until_ms: Option<f64>,
    pub now_ms: f64,
}

impl<'a> WaitPinWidget<'a> {
    pub fn new(
        status: &'a str,
        error: &'a str,
        started_at: Option<f64>,
        retry_until_ms: Option<f64>,
        now_ms: f64,
    ) -> Self {
        Self {
            status,
            error,
            started_at,
            retry_until_ms,
            now_ms,
        }
    }
}

impl Widget for WaitPinWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let mut spans = vec![
            Span::styled(
                "  ◐ ",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                if self.status.is_empty() {
                    "Working..."
                } else {
                    self.status
                },
                Style::default().fg(Color::Gray),
            ),
        ];
        if let Some(start) = self.started_at.filter(|s| s.is_finite()) {
            if self.now_ms >= start {
                spans.push(Span::styled(
                    format!(" · {}", format_duration_compact(self.now_ms - start)),
                    Style::default().fg(Color::DarkGray),
                ));
            }
        }
        if let Some(until) = self.retry_until_ms.filter(|u| u.is_finite()) {
            if until > self.now_ms {
                spans.push(Span::styled(
                    format!(" (retry in {})", format_duration_compact(until - self.now_ms)),
                    Style::default().fg(Color::Yellow),
                ));
            }
        }
        if !self.error.is_empty() {
            spans.push(Span::styled(
                format!(" — {}", self.error),
                Style::default().fg(Color::LightRed),
            ));
        }
        buf.set_line(area.left(), area.top(), &Line::from(spans), area.width);
    }
}
