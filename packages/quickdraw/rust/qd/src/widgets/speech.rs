//! Speech widget for assistant/user speech with thinking, recall, syntax spans, and hotkeys.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThinkingBlock {
    pub thoughts: Vec<String>,
    pub elapsed_ms: u64,
    pub collapsed: bool,
}

impl ThinkingBlock {
    pub fn new(thoughts: Vec<String>, elapsed_ms: u64) -> Self {
        Self {
            thoughts,
            elapsed_ms,
            collapsed: false,
        }
    }

    pub fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecallBlock {
    pub summary: String,
    pub keys: Vec<String>,
}

impl RecallBlock {
    pub fn new(summary: impl Into<String>, keys: Vec<String>) -> Self {
        Self {
            summary: summary.into(),
            keys,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SpeechWidget {
    pub role: SpeechRole,
    pub content: String,
    pub thinking: Option<ThinkingBlock>,
    pub recall: Option<RecallBlock>,
    pub hotkeys: Vec<(char, String)>,
    pub rail_width: u16,
    pub style: Style,
}

impl SpeechWidget {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: SpeechRole::User,
            content: content.into(),
            thinking: None,
            recall: None,
            hotkeys: Vec::new(),
            rail_width: 2,
            style: Style::default(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: SpeechRole::Assistant,
            content: content.into(),
            thinking: None,
            recall: None,
            hotkeys: Vec::new(),
            rail_width: 2,
            style: Style::default(),
        }
    }

    pub fn with_thinking(mut self, thinking: ThinkingBlock) -> Self {
        self.thinking = Some(thinking);
        self
    }

    pub fn with_recall(mut self, recall: RecallBlock) -> Self {
        self.recall = Some(recall);
        self
    }

    pub fn with_hotkey(mut self, key: char, action: impl Into<String>) -> Self {
        self.hotkeys.push((key, action.into()));
        self
    }

    pub fn rail_width(mut self, width: u16) -> Self {
        self.rail_width = width;
        self
    }
}

impl Widget for SpeechWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        let rail_str = match self.role {
            SpeechRole::User => "❯ ",
            SpeechRole::Assistant => "│ ",
        };
        let rail_style = match self.role {
            SpeechRole::User => Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            SpeechRole::Assistant => Style::default().fg(Color::DarkGray),
        };

        let mut y = area.top();

        if let Some(thinking) = &self.thinking {
            if y < area.bottom() {
                let arrow = if thinking.collapsed { "▶" } else { "▼" };
                let sec = (thinking.elapsed_ms as f64) / 1000.0;
                let header = format!("  {arrow} Thought for {sec:.1}s");
                buf.set_stringn(
                    area.left(),
                    y,
                    header,
                    area.width as usize,
                    Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
                );
                y += 1;
            }

            if !thinking.collapsed {
                for thought in &thinking.thoughts {
                    if y >= area.bottom() {
                        break;
                    }
                    let line = format!("    │ {thought}");
                    buf.set_stringn(
                        area.left(),
                        y,
                        line,
                        area.width as usize,
                        Style::default().fg(Color::Gray),
                    );
                    y += 1;
                }
            }
        }

        if let Some(recall) = &self.recall {
            if y < area.bottom() {
                let text = format!("  [Recall: {} (keys: {})]", recall.summary, recall.keys.join(", "));
                buf.set_stringn(
                    area.left(),
                    y,
                    text,
                    area.width as usize,
                    Style::default().fg(Color::LightMagenta),
                );
                y += 1;
            }
        }

        let content_width = area.width.saturating_sub(self.rail_width) as usize;
        let mut first = true;
        for raw_line in self.content.lines() {
            if y >= area.bottom() {
                break;
            }
            let glyph = if first {
                first = false;
                rail_str
            } else {
                "  "
            };

            buf.set_stringn(area.left(), y, glyph, self.rail_width as usize, rail_style);
            buf.set_stringn(
                area.left() + self.rail_width,
                y,
                raw_line,
                content_width,
                self.style,
            );
            y += 1;
        }

        if !self.hotkeys.is_empty() && y < area.bottom() {
            let mut hotkey_spans = Vec::new();
            hotkey_spans.push(Span::raw("  "));
            for (i, (key, label)) in self.hotkeys.iter().enumerate() {
                if i > 0 {
                    hotkey_spans.push(Span::raw("  "));
                }
                hotkey_spans.push(Span::styled(
                    format!("[{key}]"),
                    Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
                ));
                hotkey_spans.push(Span::raw(" "));
                hotkey_spans.push(Span::styled(
                    label.as_str(),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            buf.set_line(area.left(), y, &Line::from(hotkey_spans), area.width);
        }
    }
}
