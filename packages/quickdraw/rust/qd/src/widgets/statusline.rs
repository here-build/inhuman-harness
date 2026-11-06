//! Statusline widget rendering cwd, active model/connection, permission mode badge, and quota windows.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;

const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

#[derive(Debug, Clone)]
pub struct StatuslineWidget {
    pub cwd: String,
    pub model: String,
    pub connection: Option<String>,
    pub permission_mode: String,
    pub quota: Option<String>,
    pub spinner_phase: Option<usize>,
}

impl Default for StatuslineWidget {
    fn default() -> Self {
        Self {
            cwd: String::new(),
            model: "default".to_string(),
            connection: None,
            permission_mode: "ask".to_string(),
            quota: None,
            spinner_phase: None,
        }
    }
}

impl StatuslineWidget {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = cwd.into();
        self
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn connection(mut self, conn: impl Into<String>) -> Self {
        self.connection = Some(conn.into());
        self
    }

    pub fn permission_mode(mut self, mode: impl Into<String>) -> Self {
        self.permission_mode = mode.into();
        self
    }

    pub fn quota(mut self, quota: impl Into<String>) -> Self {
        self.quota = Some(quota.into());
        self
    }

    pub fn spinner_phase(mut self, phase: usize) -> Self {
        self.spinner_phase = Some(phase);
        self
    }
}

impl Widget for StatuslineWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        let bar_style = Style::default().bg(Color::Rgb(30, 32, 40)).fg(Color::Gray);
        for x in area.left()..area.right() {
            buf.get_mut(x, area.top()).set_symbol(" ").set_style(bar_style);
        }

        // Left section: cwd + model/connection
        let mut left_spans = Vec::new();
        if let Some(phase) = self.spinner_phase {
            let frame = SPINNER_FRAMES[phase % SPINNER_FRAMES.len()];
            left_spans.push(Span::styled(
                format!(" {frame} "),
                Style::default().fg(Color::Cyan).bg(Color::Rgb(30, 32, 40)).add_modifier(Modifier::BOLD),
            ));
        } else {
            left_spans.push(Span::raw(" "));
        }

        if !self.cwd.is_empty() {
            left_spans.push(Span::styled(
                &self.cwd,
                Style::default().fg(Color::White).bg(Color::Rgb(30, 32, 40)),
            ));
            left_spans.push(Span::styled(
                " │ ",
                Style::default().fg(Color::DarkGray).bg(Color::Rgb(30, 32, 40)),
            ));
        }

        left_spans.push(Span::styled(
            &self.model,
            Style::default().fg(Color::Cyan).bg(Color::Rgb(30, 32, 40)).add_modifier(Modifier::BOLD),
        ));

        if let Some(conn) = &self.connection {
            left_spans.push(Span::styled(
                format!(" ({conn})"),
                Style::default().fg(Color::DarkGray).bg(Color::Rgb(30, 32, 40)),
            ));
        }

        let left_line = Line::from(left_spans);
        buf.set_line(area.left(), area.top(), &left_line, area.width);

        // Right section: permission mode badge + quota
        let mode_color = match self.permission_mode.as_str() {
            "auto" => Color::Green,
            "ask" | "confirm" => Color::Yellow,
            _ => Color::Gray,
        };

        let mut right_spans = Vec::new();
        right_spans.push(Span::styled(
            format!("[{}]", self.permission_mode),
            Style::default().fg(mode_color).bg(Color::Rgb(30, 32, 40)).add_modifier(Modifier::BOLD),
        ));

        if let Some(quota) = &self.quota {
            right_spans.push(Span::raw(" "));
            right_spans.push(Span::styled(
                quota,
                Style::default().fg(Color::DarkGray).bg(Color::Rgb(30, 32, 40)),
            ));
        }
        right_spans.push(Span::raw(" "));

        let right_line = Line::from(right_spans);
        let right_width = right_line.width() as u16;
        if right_width < area.width {
            let right_x = area.right().saturating_sub(right_width);
            buf.set_line(right_x, area.top(), &right_line, right_width);
        }
    }
}
