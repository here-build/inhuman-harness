//! AgentsMeter widget rendering background subagent activity meter.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentStatus {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub step_count: usize,
    pub description: Option<String>,
}

impl SubagentStatus {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            active: true,
            step_count: 0,
            description: None,
        }
    }

    pub fn with_steps(mut self, steps: usize) -> Self {
        self.step_count = steps;
        self
    }

    pub fn completed(mut self) -> Self {
        self.active = false;
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct AgentsMeterWidget {
    pub agents: Vec<SubagentStatus>,
}

impl AgentsMeterWidget {
    pub fn new(agents: Vec<SubagentStatus>) -> Self {
        Self { agents }
    }

    pub fn push(&mut self, agent: SubagentStatus) {
        self.agents.push(agent);
    }
}

impl Widget for AgentsMeterWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        let active_count = self.agents.iter().filter(|a| a.active).count();
        let total_count = self.agents.len();

        let mut spans = Vec::new();
        spans.push(Span::styled(
            "Subagents: ",
            Style::default().fg(Color::DarkGray),
        ));
        spans.push(Span::styled(
            format!("{active_count}/{total_count} active "),
            Style::default()
                .fg(if active_count > 0 {
                    Color::Cyan
                } else {
                    Color::Gray
                })
                .add_modifier(Modifier::BOLD),
        ));

        for agent in &self.agents {
            let (sym, color) = if agent.active {
                ("●", Color::Cyan)
            } else {
                ("✓", Color::Green)
            };
            let chip = format!("[{sym} {}: {} steps] ", agent.name, agent.step_count);
            spans.push(Span::styled(chip, Style::default().fg(color)));
        }

        buf.set_line(area.left(), area.top(), &Line::from(spans), area.width);
    }
}

/// Replica-facing 1-row closed subagent meter (`PaintReplica::render_ratatui`).
pub struct AgentsMeterReplicaWidget<'a> {
    pub left: &'a str,
    pub right: &'a str,
}

impl<'a> AgentsMeterReplicaWidget<'a> {
    pub fn new(left: &'a str, right: &'a str) -> Self {
        Self { left, right }
    }
}

impl Widget for AgentsMeterReplicaWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let line = Line::from(vec![
            Span::styled(
                "  ◈ ",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(self.left, Style::default().fg(Color::White)),
        ]);
        buf.set_line(area.left(), area.top(), &line, area.width);

        if !self.right.is_empty() {
            let rw = self.right.width() as u16;
            if rw + 4 < area.width {
                buf.set_stringn(
                    area.right().saturating_sub(rw),
                    area.top(),
                    self.right,
                    rw as usize,
                    Style::default().fg(Color::DarkGray),
                );
            }
        }
    }
}
