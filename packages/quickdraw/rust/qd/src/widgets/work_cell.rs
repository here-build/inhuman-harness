//! WorkCell widget for tool calls, scheme REPL, loop, ask, wait, sigils, and quarter-block rule.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::StatefulWidget;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkCellKind {
    Tool,
    Scheme,
    Loop,
    Ask,
    Wait,
}

impl WorkCellKind {
    pub const fn sigil(self) -> &'static str {
        match self {
            WorkCellKind::Tool => "⚙",
            WorkCellKind::Scheme => "λ",
            WorkCellKind::Loop => "↺",
            WorkCellKind::Ask => "?",
            WorkCellKind::Wait => "⏳",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            WorkCellKind::Tool => "tool",
            WorkCellKind::Scheme => "scheme",
            WorkCellKind::Loop => "loop",
            WorkCellKind::Ask => "ask",
            WorkCellKind::Wait => "wait",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkCellStatus {
    Running,
    Success,
    Failure,
    Cancelled,
}

impl WorkCellStatus {
    pub fn badge(self) -> Span<'static> {
        match self {
            WorkCellStatus::Running => Span::styled(
                "● running",
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            ),
            WorkCellStatus::Success => Span::styled("✓ done", Style::default().fg(Color::Green)),
            WorkCellStatus::Failure => Span::styled(
                "✕ failed",
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ),
            WorkCellStatus::Cancelled => {
                Span::styled("⊘ cancelled", Style::default().fg(Color::DarkGray))
            }
        }
    }

    pub const fn border_color(self) -> Color {
        match self {
            WorkCellStatus::Running => Color::Yellow,
            WorkCellStatus::Success => Color::Green,
            WorkCellStatus::Failure => Color::Red,
            WorkCellStatus::Cancelled => Color::DarkGray,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkCellState {
    pub collapsed: bool,
    pub scroll_offset: usize,
}

impl WorkCellState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn toggle_collapsed(&mut self) {
        self.collapsed = !self.collapsed;
    }
}

#[derive(Debug, Clone)]
pub struct WorkCellWidget {
    pub id: String,
    pub kind: WorkCellKind,
    pub name: String,
    pub status: WorkCellStatus,
    pub input_summary: String,
    pub output_lines: Vec<String>,
    pub streaming: bool,
}

impl WorkCellWidget {
    pub fn new(
        id: impl Into<String>,
        kind: WorkCellKind,
        name: impl Into<String>,
        status: WorkCellStatus,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            name: name.into(),
            status,
            input_summary: String::new(),
            output_lines: Vec::new(),
            streaming: false,
        }
    }

    pub fn with_input(mut self, input: impl Into<String>) -> Self {
        self.input_summary = input.into();
        self
    }

    pub fn with_output_lines(mut self, lines: Vec<String>) -> Self {
        self.output_lines = lines;
        self
    }

    pub fn streaming(mut self, streaming: bool) -> Self {
        self.streaming = streaming;
        self
    }
}

impl StatefulWidget for WorkCellWidget {
    type State = WorkCellState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State) {
        if area.is_empty() {
            return;
        }

        let rule_style = Style::default().fg(self.status.border_color());
        let arrow = if state.collapsed { "▶" } else { "▼" };

        let mut y = area.top();

        let mut header_spans = vec![
            Span::styled("▌ ", rule_style),
            Span::styled(format!("{arrow} {} ", self.kind.sigil()), Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(format!("{}: ", self.kind.label()), Style::default().fg(Color::DarkGray)),
            Span::styled(self.name.as_str(), Style::default().add_modifier(Modifier::BOLD)),
            Span::raw("  "),
            self.status.badge(),
        ];
        if !self.input_summary.is_empty() && state.collapsed {
            header_spans.push(Span::raw("  "));
            header_spans.push(Span::styled(
                format!("({})", self.input_summary),
                Style::default().fg(Color::DarkGray),
            ));
        }

        buf.set_line(area.left(), y, &Line::from(header_spans), area.width);
        y += 1;

        if state.collapsed || y >= area.bottom() {
            return;
        }

        if !self.input_summary.is_empty() {
            let input_line = Line::from(vec![
                Span::styled("▌ ", rule_style),
                Span::styled("  arg: ", Style::default().fg(Color::DarkGray)),
                Span::styled(self.input_summary.as_str(), Style::default().fg(Color::Cyan)),
            ]);
            buf.set_line(area.left(), y, &input_line, area.width);
            y += 1;
        }

        for out in &self.output_lines {
            if y >= area.bottom() {
                break;
            }
            let out_line = Line::from(vec![
                Span::styled("▌ ", rule_style),
                Span::styled("  ", Style::default()),
                Span::styled(out.as_str(), Style::default().fg(Color::Gray)),
            ]);
            buf.set_line(area.left(), y, &out_line, area.width);
            y += 1;
        }

        if self.streaming && y < area.bottom() {
            let stream_line = Line::from(vec![
                Span::styled("▌ ", rule_style),
                Span::styled("  ⟳ streaming output...", Style::default().fg(Color::Yellow).add_modifier(Modifier::ITALIC)),
            ]);
            buf.set_line(area.left(), y, &stream_line, area.width);
        }
    }
}
