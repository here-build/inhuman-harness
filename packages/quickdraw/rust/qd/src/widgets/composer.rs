//! Composer widget wrapping draft state, multi-line grapheme cursor, command popup, and ask approval cover.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, StatefulWidget, Widget};

use crate::composer_command::ComposerCommand;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskPromptState {
    pub question: String,
    pub choices: Vec<String>,
    pub selected_choice: usize,
}

impl AskPromptState {
    pub fn new(question: impl Into<String>) -> Self {
        Self {
            question: question.into(),
            choices: vec!["[y] Yes".into(), "[n] No".into(), "[c] Comment".into()],
            selected_choice: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComposerState {
    pub text: String,
    pub cursor: usize,
    pub selection_anchor: Option<usize>,
    pub command_picker_open: bool,
    pub selected_command_index: usize,
    pub ask_approval_cover: Option<AskPromptState>,
}

impl ComposerState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert_char(&mut self, ch: char) {
        let graphemes: Vec<&str> = self.text.graphemes(true).collect();
        let idx = self.cursor.min(graphemes.len());
        let mut new_text = String::new();
        for (i, g) in graphemes.iter().enumerate() {
            if i == idx {
                new_text.push(ch);
            }
            new_text.push_str(g);
        }
        if idx == graphemes.len() {
            new_text.push(ch);
        }
        self.text = new_text;
        self.cursor = idx + 1;
        self.selection_anchor = None;
        self.command_picker_open = self.text.starts_with('/');
    }

    pub fn delete_backwards(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let graphemes: Vec<&str> = self.text.graphemes(true).collect();
        let idx = self.cursor.min(graphemes.len());
        let mut new_text = String::new();
        for (i, g) in graphemes.iter().enumerate() {
            if i + 1 != idx {
                new_text.push_str(g);
            }
        }
        self.text = new_text;
        self.cursor = self.cursor.saturating_sub(1);
        self.selection_anchor = None;
        self.command_picker_open = self.text.starts_with('/');
    }

    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_right(&mut self) {
        let count = self.text.graphemes(true).count();
        self.cursor = (self.cursor + 1).min(count);
    }

    pub fn select_all(&mut self) {
        self.selection_anchor = Some(0);
        self.cursor = self.text.graphemes(true).count();
    }
}

#[derive(Debug, Clone)]
pub struct ComposerWidget {
    pub placeholder: String,
    pub max_height: u16,
    pub commands: Vec<ComposerCommand>,
}

impl Default for ComposerWidget {
    fn default() -> Self {
        Self {
            placeholder: "Send a message or /command...".to_string(),
            max_height: 5,
            commands: Vec::new(),
        }
    }
}

impl ComposerWidget {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn placeholder(mut self, text: impl Into<String>) -> Self {
        self.placeholder = text.into();
        self
    }

    pub fn commands(mut self, commands: Vec<ComposerCommand>) -> Self {
        self.commands = commands;
        self
    }
}

impl StatefulWidget for ComposerWidget {
    type State = ComposerState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State) {
        if area.is_empty() {
            return;
        }

        if let Some(ask) = &state.ask_approval_cover {
            Clear.render(area, buf);
            let block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(Color::Yellow))
                .title(" Action Approval Required ");
            let inner = block.inner(area);
            block.render(area, buf);

            if inner.height > 0 {
                buf.set_stringn(
                    inner.left(),
                    inner.top(),
                    &ask.question,
                    inner.width as usize,
                    Style::default().add_modifier(Modifier::BOLD),
                );
            }
            if inner.height > 1 {
                let mut choice_spans = Vec::new();
                for (i, choice) in ask.choices.iter().enumerate() {
                    let is_active = i == ask.selected_choice;
                    let style = if is_active {
                        Style::default()
                            .fg(Color::Black)
                            .bg(Color::Yellow)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::Yellow)
                    };
                    choice_spans.push(Span::styled(format!(" {choice} "), style));
                    choice_spans.push(Span::raw("  "));
                }
                buf.set_line(inner.left(), inner.top() + 1, &Line::from(choice_spans), inner.width);
            }
            return;
        }

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(Color::DarkGray));
        let inner = block.inner(area);
        block.render(area, buf);

        if inner.is_empty() {
            return;
        }

        let graphemes: Vec<&str> = state.text.graphemes(true).collect();
        let prompt_prefix = "❯ ";
        let prompt_style = Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD);
        buf.set_stringn(inner.left(), inner.top(), prompt_prefix, 2, prompt_style);

        let input_x = inner.left() + 2;
        let input_width = inner.width.saturating_sub(2);

        if graphemes.is_empty() {
            buf.set_stringn(
                input_x,
                inner.top(),
                &self.placeholder,
                input_width as usize,
                Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
            );
        } else {
            let (sel_min, sel_max) = match state.selection_anchor {
                Some(anchor) => (anchor.min(state.cursor), anchor.max(state.cursor)),
                None => (usize::MAX, usize::MAX),
            };

            let mut cur_x = input_x;
            for (i, g) in graphemes.iter().enumerate() {
                let w = g.width() as u16;
                if cur_x + w > inner.right() {
                    break;
                }
                let mut style = Style::default();
                if i >= sel_min && i < sel_max {
                    style = style.bg(Color::Blue).fg(Color::White);
                }
                if i == state.cursor && state.selection_anchor.is_none() {
                    style = style.add_modifier(Modifier::REVERSED);
                }
                buf.set_stringn(cur_x, inner.top(), *g, w as usize, style);
                cur_x += w;
            }

            if state.cursor >= graphemes.len() && state.selection_anchor.is_none() && cur_x < inner.right() {
                buf.get_mut(cur_x, inner.top()).set_symbol(" ").set_style(Style::default().add_modifier(Modifier::REVERSED));
            }
        }

        if state.command_picker_open && !self.commands.is_empty() {
            let filter = state.text.trim_start_matches('/');
            let matching: Vec<&ComposerCommand> = self
                .commands
                .iter()
                .filter(|c| c.name.starts_with(filter))
                .collect();

            if !matching.is_empty() {
                let popup_height = (matching.len() as u16 + 2).min(area.top().saturating_sub(1).max(3));
                let popup_y = area.top().saturating_sub(popup_height);
                let popup_area = Rect::new(area.left() + 1, popup_y, area.width.saturating_sub(2), popup_height);

                Clear.render(popup_area, buf);
                let pblock = Block::default()
                    .borders(Borders::ALL)
                    .border_type(BorderType::Plain)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" Commands ");
                let pinner = pblock.inner(popup_area);
                pblock.render(popup_area, buf);

                for (i, cmd) in matching.iter().take(pinner.height as usize).enumerate() {
                    let is_sel = i == state.selected_command_index;
                    let style = if is_sel {
                        Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::Cyan)
                    };
                    let line = format!("/{} {}", cmd.name, cmd.description.as_deref().unwrap_or(""));
                    buf.set_stringn(pinner.left(), pinner.top() + i as u16, line, pinner.width as usize, style);
                }
            }
        }
    }
}
