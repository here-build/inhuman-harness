//! WorkCell widget for tool calls, scheme REPL, loop, ask, wait, sigils, and quarter-block rule.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{StatefulWidget, Widget};
use unicode_width::UnicodeWidthStr;

use crate::syntax;
use crate::widgets::pierre_diff::PierreDiffWidget;

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
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
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
            Span::styled(
                format!("{arrow} {} ", self.kind.sigil()),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{}: ", self.kind.label()),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled(
                self.name.as_str(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
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
                Span::styled(
                    self.input_summary.as_str(),
                    Style::default().fg(Color::Cyan),
                ),
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
                Span::styled(
                    "  ⟳ streaming output...",
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::ITALIC),
                ),
            ]);
            buf.set_line(area.left(), y, &stream_line, area.width);
        }
    }
}

/// Replica work cell item constructed from `PaintReplica` `Tool`/`Scheme`/`Loop`/`Ask`/`Wait` nodes.
#[derive(Debug, Clone)]
pub struct ReplicaWorkCellItem {
    pub id: u32,
    pub kind_str: String,
    pub name: String,
    pub object: String,
    pub status_text: String,
    pub caption: String,
    pub state: String,
    pub indent: usize,
    pub agent: bool,
    pub pretty_block: String,
    pub receipt_kind: String,
    pub receipt_text: String,
    pub diff_old: String,
    pub diff_new: String,
    pub diff_path: String,
    pub diff_line_start: usize,
    pub collapsed: bool,
}

impl ReplicaWorkCellItem {
    #[allow(clippy::too_many_arguments)]
    pub fn from_replica_fields(
        id: u32,
        kind_str: &str,
        name: &str,
        object: &str,
        status_text: &str,
        caption: &str,
        state: &str,
        indent: usize,
        agent: bool,
        pretty_block: &str,
        receipt_kind: &str,
        receipt_text: &str,
        diff_old: &str,
        diff_new: &str,
        diff_path: &str,
        diff_line_start: usize,
        collapsed: bool,
    ) -> Self {
        Self {
            id,
            kind_str: kind_str.to_string(),
            name: name.to_string(),
            object: object.to_string(),
            status_text: status_text.to_string(),
            caption: caption.to_string(),
            state: state.to_string(),
            indent,
            agent,
            pretty_block: pretty_block.to_string(),
            receipt_kind: receipt_kind.to_string(),
            receipt_text: receipt_text.to_string(),
            diff_old: diff_old.to_string(),
            diff_new: diff_new.to_string(),
            diff_path: diff_path.to_string(),
            diff_line_start,
            collapsed,
        }
    }
}

pub struct ReplicaWorkCellWidget<'a> {
    pub cell: &'a ReplicaWorkCellItem,
    pub max_receipt_lines: usize,
}

impl<'a> ReplicaWorkCellWidget<'a> {
    pub fn new(cell: &'a ReplicaWorkCellItem) -> Self {
        Self {
            cell,
            max_receipt_lines: 18,
        }
    }

    pub fn height(&self) -> u16 {
        let mut h = 1u16;
        if !self.cell.caption.is_empty() {
            h = h.saturating_add(1);
        }
        if !self.cell.pretty_block.trim().is_empty() && !self.cell.collapsed {
            let pb = self.cell.pretty_block.lines().count().min(12) as u16;
            h = h.saturating_add(pb);
        }
        if !self.cell.collapsed {
            match self.cell.receipt_kind.as_str() {
                "diff" => {
                    let dw = PierreDiffWidget::from_old_new(
                        &self.cell.diff_path,
                        &self.cell.diff_old,
                        &self.cell.diff_new,
                        self.cell.diff_line_start,
                    );
                    h = h.saturating_add(dw.height().min(self.max_receipt_lines as u16));
                }
                "shell" | "scheme" | "text" | "error" => {
                    let lines = self
                        .cell
                        .receipt_text
                        .lines()
                        .count()
                        .min(self.max_receipt_lines);
                    h = h.saturating_add(lines as u16);
                }
                _ => {}
            }
        }
        h
    }
}

fn parse_hex_color(hex: &str) -> Option<Color> {
    let s = hex.strip_prefix('#').unwrap_or(hex);
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(Color::Rgb(r, g, b))
}

impl Widget for ReplicaWorkCellWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let indent_pad = "  ".repeat(self.cell.indent);
        let is_shell = self.cell.name == "shell"
            || self.cell.name == "Bash"
            || self.cell.receipt_kind == "shell";
        let (sigil, sigil_color) = match self.cell.state.as_str() {
            "failed" => ("■", Color::Red),
            "live" => {
                let s = match self.cell.kind_str.as_str() {
                    "scheme" => "λ",
                    "loop" => "↻",
                    "ask" => "?",
                    "wait" => "·",
                    _ if is_shell => "$",
                    _ => "·",
                };
                (s, Color::Cyan)
            }
            _ => {
                let s = match self.cell.kind_str.as_str() {
                    "scheme" => "λ",
                    "loop" => "↻",
                    "ask" => "?",
                    _ if is_shell => "$",
                    _ => "✓",
                };
                (s, Color::Green)
            }
        };

        let mut y = area.top();
        let mut hdr = vec![
            Span::raw(format!("  {indent_pad}")),
            Span::styled(
                format!("{sigil} "),
                Style::default()
                    .fg(sigil_color)
                    .add_modifier(Modifier::BOLD),
            ),
        ];
        if self.cell.agent {
            hdr.push(Span::styled(
                "◈ ",
                Style::default()
                    .fg(Color::LightMagenta)
                    .add_modifier(Modifier::BOLD),
            ));
        }

        let title = if self.cell.name.is_empty() {
            self.cell.kind_str.as_str()
        } else {
            self.cell.name.as_str()
        };
        hdr.push(Span::styled(
            title.to_string(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ));
        if !self.cell.object.is_empty() {
            hdr.push(Span::raw(" "));
            if is_shell || self.cell.kind_str == "scheme" {
                let lang = if self.cell.kind_str == "scheme" {
                    "scheme"
                } else {
                    "bash"
                };
                if let Some(first_toks) =
                    syntax::highlight(&self.cell.object, lang).into_iter().next()
                {
                    for tok in first_toks {
                        let st = Style::default().fg(
                            tok.color
                                .as_deref()
                                .and_then(parse_hex_color)
                                .unwrap_or(Color::Gray),
                        );
                        hdr.push(Span::styled(tok.text, st));
                    }
                } else {
                    hdr.push(Span::styled(
                        self.cell.object.clone(),
                        Style::default().fg(Color::Gray),
                    ));
                }
            } else {
                hdr.push(Span::styled(
                    self.cell.object.clone(),
                    Style::default().fg(Color::Gray),
                ));
            }
        }
        buf.set_line(area.left(), y, &Line::from(hdr), area.width);

        if !self.cell.status_text.is_empty() {
            let st_w = self.cell.status_text.width() as u16;
            if st_w + 4 < area.width {
                let st_color = if self.cell.state == "failed" {
                    Color::Red
                } else {
                    Color::DarkGray
                };
                buf.set_stringn(
                    area.right().saturating_sub(st_w),
                    y,
                    &self.cell.status_text,
                    st_w as usize,
                    Style::default().fg(st_color),
                );
            }
        }
        y += 1;

        if !self.cell.caption.is_empty() && y < area.bottom() {
            let cap_line = Line::from(vec![
                Span::raw(format!("    {indent_pad}")),
                Span::styled(
                    self.cell.caption.as_str(),
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::ITALIC),
                ),
            ]);
            buf.set_line(area.left(), y, &cap_line, area.width);
            y += 1;
        }

        if self.cell.collapsed || y >= area.bottom() {
            return;
        }

        let rule_color = if self.cell.state == "failed" {
            Color::Red
        } else {
            Color::DarkGray
        };

        if !self.cell.pretty_block.trim().is_empty() {
            let lang = if self.cell.kind_str == "scheme" {
                "scheme"
            } else {
                "bash"
            };
            for tl in syntax::highlight(&self.cell.pretty_block, lang)
                .into_iter()
                .take(12)
            {
                if y >= area.bottom() {
                    break;
                }
                let mut row_spans = vec![
                    Span::raw(format!("  {indent_pad}")),
                    Span::styled("▌ ", Style::default().fg(rule_color)),
                ];
                for tok in tl {
                    let st = Style::default().fg(
                        tok.color
                            .as_deref()
                            .and_then(parse_hex_color)
                            .unwrap_or(Color::White),
                    );
                    row_spans.push(Span::styled(tok.text, st));
                }
                buf.set_line(area.left(), y, &Line::from(row_spans), area.width);
                y += 1;
            }
        }

        if y >= area.bottom() {
            return;
        }

        match self.cell.receipt_kind.as_str() {
            "diff" => {
                let left_pad = (2 + self.cell.indent * 2) as u16;
                if area.width > left_pad + 4 {
                    let diff_rect = Rect::new(
                        area.left() + left_pad,
                        y,
                        area.width - left_pad,
                        area.bottom() - y,
                    );
                    PierreDiffWidget::from_old_new(
                        &self.cell.diff_path,
                        &self.cell.diff_old,
                        &self.cell.diff_new,
                        self.cell.diff_line_start,
                    )
                    .render(diff_rect, buf);
                }
            }
            "shell" | "scheme" => {
                let lang = if self.cell.receipt_kind == "scheme" {
                    "scheme"
                } else {
                    "bash"
                };
                for tl in syntax::highlight(&self.cell.receipt_text, lang)
                    .into_iter()
                    .take(self.max_receipt_lines)
                {
                    if y >= area.bottom() {
                        break;
                    }
                    let mut spans = vec![
                        Span::raw(format!("  {indent_pad}")),
                        Span::styled("▌ ", Style::default().fg(rule_color)),
                    ];
                    for tok in tl {
                        let st = Style::default().fg(
                            tok.color
                                .as_deref()
                                .and_then(parse_hex_color)
                                .unwrap_or(Color::Gray),
                        );
                        spans.push(Span::styled(tok.text, st));
                    }
                    buf.set_line(area.left(), y, &Line::from(spans), area.width);
                    y += 1;
                }
            }
            "text" | "error" => {
                let text_fg = if self.cell.receipt_kind == "error" || self.cell.state == "failed" {
                    Color::LightRed
                } else {
                    Color::Gray
                };
                for raw in self
                    .cell
                    .receipt_text
                    .lines()
                    .take(self.max_receipt_lines)
                {
                    if y >= area.bottom() {
                        break;
                    }
                    let row = Line::from(vec![
                        Span::raw(format!("  {indent_pad}")),
                        Span::styled("▌ ", Style::default().fg(rule_color)),
                        Span::styled(raw.to_string(), Style::default().fg(text_fg)),
                    ]);
                    buf.set_line(area.left(), y, &row, area.width);
                    y += 1;
                }
            }
            _ => {}
        }
    }
}
