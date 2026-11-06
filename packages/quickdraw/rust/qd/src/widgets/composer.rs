//! Composer widget wrapping draft state, multi-line grapheme cursor, command popup,
//! declarative `UiNode` choice picker, parked callback overlay, and ask approval cover.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, StatefulWidget, Widget};

use crate::composer_command::ComposerCommand;
use crate::state::ui::{has_input_hole, url_from, UiHealth, UiNode};

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

/// Visual state for a parked `{ form: "ui", pending, body }` callback overlay in the omnibox.
#[derive(Debug, Clone, PartialEq)]
pub struct CallbackOverlayState {
    pub pending: String,
    pub surface: UiNode,
    pub oauth_waiting: bool,
    pub processing: bool,
}

impl CallbackOverlayState {
    pub fn new(pending: impl Into<String>, surface: UiNode) -> Self {
        Self {
            pending: pending.into(),
            surface,
            oauth_waiting: false,
            processing: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ComposerState {
    pub text: String,
    pub cursor: usize,
    pub selection_anchor: Option<usize>,
    pub command_picker_open: bool,
    pub selected_command_index: usize,
    pub ask_approval_cover: Option<AskPromptState>,
    pub ui_choices: Vec<UiNode>,
    pub callback_overlay: Option<CallbackOverlayState>,
}

impl ComposerState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_text(&mut self, text: impl Into<String>) {
        let s = text.into();
        self.cursor = s.graphemes(true).count();
        self.command_picker_open = s.starts_with('/');
        self.text = s;
        self.selection_anchor = None;
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.selection_anchor = None;
        self.command_picker_open = false;
        self.selected_command_index = 0;
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

        // 1. Parked UI callback overlay (`confirm`, `input`, `open-url`, `notice`) takes highest priority
        if let Some(cb) = &state.callback_overlay {
            Clear.render(area, buf);
            let title = if cb.oauth_waiting {
                " Waiting for browser... ".to_string()
            } else {
                format!(" {} ", cb.surface.name)
            };
            let block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(Color::Cyan))
                .title(title);
            let inner = block.inner(area);
            block.render(area, buf);

            if inner.is_empty() {
                return;
            }

            let inputting = has_input_hole(&cb.surface) && !cb.oauth_waiting && !cb.processing;
            let url = url_from(&cb.surface);
            let mut row = inner.top();

            if !cb.surface.description.is_empty() && row < inner.bottom() {
                buf.set_stringn(
                    inner.left(),
                    row,
                    &cb.surface.description,
                    inner.width as usize,
                    Style::default().fg(Color::White),
                );
                row += 1;
            }

            if let Some(u) = &url {
                if row < inner.bottom() && !cb.surface.description.contains(u) {
                    buf.set_stringn(
                        inner.left(),
                        row,
                        u,
                        inner.width as usize,
                        Style::default().fg(Color::Blue).add_modifier(Modifier::UNDERLINED),
                    );
                    row += 1;
                }
            }

            if inputting && row < inner.bottom() {
                let prefix = if cb.surface.secret { "🔒 " } else { "❯ " };
                buf.set_stringn(
                    inner.left(),
                    row,
                    prefix,
                    3,
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                );
                let display_text = if cb.surface.secret {
                    "•".repeat(state.text.graphemes(true).count())
                } else {
                    state.text.clone()
                };
                buf.set_stringn(
                    inner.left() + 2,
                    row,
                    &display_text,
                    inner.width.saturating_sub(2) as usize,
                    Style::default().fg(Color::White),
                );
                row += 1;
            }

            if row < inner.bottom() {
                let primary_label = cb
                    .surface
                    .action
                    .first()
                    .map(|a| a.name.as_str())
                    .unwrap_or("Continue");
                let cancel_label = cb
                    .surface
                    .alternate_actions
                    .first()
                    .map(|a| a.name.as_str())
                    .unwrap_or("Cancel");
                let hint = if cb.oauth_waiting {
                    format!("[Esc] {cancel_label}")
                } else if cb.surface.alternate_actions.is_empty() {
                    format!("[Enter] {primary_label}")
                } else {
                    format!("[Enter] {primary_label}  [Esc] {cancel_label}")
                };
                buf.set_stringn(
                    inner.left(),
                    row,
                    &hint,
                    inner.width as usize,
                    Style::default().fg(Color::DarkGray),
                );
            }
            return;
        }

        // 2. Ask approval cover
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
                buf.set_line(
                    inner.left(),
                    inner.top() + 1,
                    &Line::from(choice_spans),
                    inner.width,
                );
            }
            return;
        }

        // 3. Standard draft box
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
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::ITALIC),
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

            if state.cursor >= graphemes.len()
                && state.selection_anchor.is_none()
                && cur_x < inner.right()
            {
                buf.get_mut(cur_x, inner.top())
                    .set_symbol(" ")
                    .set_style(Style::default().add_modifier(Modifier::REVERSED));
            }
        }

        // 4. Command / UiNode choice picker popup above composer
        if state.command_picker_open && !state.ui_choices.is_empty() {
            let max_popup = area.top().saturating_sub(1).max(3);
            let popup_height = (state.ui_choices.len() as u16 + 2).min(max_popup);
            let popup_y = area.top().saturating_sub(popup_height);
            let popup_area = Rect::new(
                area.left() + 1,
                popup_y,
                area.width.saturating_sub(2),
                popup_height,
            );

            Clear.render(popup_area, buf);
            let pblock = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Plain)
                .border_style(Style::default().fg(Color::Cyan))
                .title(" Choices ");
            let pinner = pblock.inner(popup_area);
            pblock.render(popup_area, buf);

            for (i, node) in state
                .ui_choices
                .iter()
                .take(pinner.height as usize)
                .enumerate()
            {
                let is_sel = i == state.selected_command_index;
                let badge = match node.health {
                    UiHealth::Ok => "●",
                    UiHealth::Degraded => "◐",
                    UiHealth::Failed => "✗",
                };
                let style = if is_sel {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    match node.health {
                        UiHealth::Ok => Style::default().fg(Color::Cyan),
                        UiHealth::Degraded => Style::default().fg(Color::Yellow),
                        UiHealth::Failed => Style::default().fg(Color::Red),
                    }
                };
                let mut line = format!("{badge} {}", node.name);
                if !node.annotation.is_empty() {
                    line.push_str(&format!(" ({})", node.annotation));
                }
                if !node.description.is_empty() {
                    line.push_str(&format!(" — {}", node.description));
                }
                buf.set_stringn(
                    pinner.left(),
                    pinner.top() + i as u16,
                    &line,
                    pinner.width as usize,
                    style,
                );
            }
        } else if state.command_picker_open && !self.commands.is_empty() {
            let filter = state.text.trim_start_matches('/');
            let matching: Vec<&ComposerCommand> = self
                .commands
                .iter()
                .filter(|c| c.name.starts_with(filter))
                .collect();

            if !matching.is_empty() {
                let popup_height =
                    (matching.len() as u16 + 2).min(area.top().saturating_sub(1).max(3));
                let popup_y = area.top().saturating_sub(popup_height);
                let popup_area = Rect::new(
                    area.left() + 1,
                    popup_y,
                    area.width.saturating_sub(2),
                    popup_height,
                );

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
                        Style::default()
                            .fg(Color::Black)
                            .bg(Color::Cyan)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::Cyan)
                    };
                    let line = format!(
                        "/{} {}",
                        cmd.name,
                        cmd.description.as_deref().unwrap_or("")
                    );
                    buf.set_stringn(
                        pinner.left(),
                        pinner.top() + i as u16,
                        line,
                        pinner.width as usize,
                        style,
                    );
                }
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ComposerReplicaChoice {
    pub key: String,
    pub name: String,
    pub annotation: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct ComposerReplicaFace {
    pub draft: String,
    pub placeholder: String,
    pub annotation: String,
    pub join_annotation: String,
    pub error_message: String,
    pub completion: String,
    pub interactive: bool,
    pub read_only: bool,
    pub hotkeys: Vec<(String, String)>,
    pub stacked_rows: Vec<(String, String)>,
    pub stacked_hotkeys: Vec<(String, String)>,
    pub choices: Vec<ComposerReplicaChoice>,
    pub selected_command_key: String,
    pub status_items: Vec<String>,
    pub context_used: f64,
    pub context_limit: f64,
}

impl Default for ComposerReplicaFace {
    fn default() -> Self {
        Self {
            draft: String::new(),
            placeholder: String::new(),
            annotation: String::new(),
            join_annotation: String::new(),
            error_message: String::new(),
            completion: String::new(),
            interactive: true,
            read_only: false,
            hotkeys: Vec::new(),
            stacked_rows: Vec::new(),
            stacked_hotkeys: Vec::new(),
            choices: Vec::new(),
            selected_command_key: String::new(),
            status_items: Vec::new(),
            context_used: 0.0,
            context_limit: 0.0,
        }
    }
}

pub struct ComposerReplicaWidget<'a> {
    pub face: &'a ComposerReplicaFace,
}

impl<'a> ComposerReplicaWidget<'a> {
    pub fn new(face: &'a ComposerReplicaFace) -> Self {
        Self { face }
    }

    pub fn height(&self) -> u16 {
        let mut h: u16 = 2; // top + bottom borders
        let body_lines = self.face.draft.lines().count().max(1);
        h = h.saturating_add(body_lines as u16);

        if !self.face.stacked_rows.is_empty() {
            h = h.saturating_add((self.face.stacked_rows.len() as u16).saturating_add(1));
        }

        if !self.face.choices.is_empty() {
            h = h.saturating_add((self.face.choices.len().min(8) as u16).saturating_add(1));
        }
        h
    }
}

impl Widget for ComposerReplicaWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() || area.width < 4 || area.height < 2 {
            return;
        }
        let border_style = if !self.face.error_message.trim().is_empty() {
            Style::default().fg(Color::Rgb(240, 100, 100))
        } else if self.face.interactive {
            Style::default().fg(Color::Rgb(110, 145, 195))
        } else {
            Style::default().fg(Color::Rgb(85, 95, 115))
        };

        let mut y = area.top();

        // Top border
        buf.set_stringn(area.left(), y, "╭", 1, border_style);
        for x in (area.left() + 1)..area.right().saturating_sub(1) {
            buf.set_stringn(x, y, "─", 1, border_style);
        }
        buf.set_stringn(area.right().saturating_sub(1), y, "╮", 1, border_style);

        let top_hotkeys = if !self.face.stacked_hotkeys.is_empty() {
            &self.face.stacked_hotkeys
        } else {
            &self.face.hotkeys
        };
        if !top_hotkeys.is_empty() {
            let hints = top_hotkeys
                .iter()
                .map(|(k, a)| {
                    if a.trim().is_empty() {
                        k.trim().to_string()
                    } else {
                        format!("{}: {}", k.trim(), a.trim())
                    }
                })
                .collect::<Vec<_>>()
                .join("  ");
            let label = format!(" {hints} ");
            let w = label.chars().count() as u16;
            if w + 4 <= area.width {
                let hx = area.right().saturating_sub(w + 2);
                buf.set_stringn(
                    hx,
                    y,
                    &label,
                    w as usize,
                    Style::default().fg(Color::Rgb(165, 175, 198)),
                );
            }
        }
        y = y.saturating_add(1);

        // Optional stacked frame (numbered queue / steer / ask cover)
        if !self.face.stacked_rows.is_empty() {
            for (glyph, row_text) in &self.face.stacked_rows {
                if y >= area.bottom().saturating_sub(1) {
                    break;
                }
                buf.set_stringn(area.left(), y, "│", 1, border_style);
                buf.set_stringn(area.right().saturating_sub(1), y, "│", 1, border_style);
                let g = if glyph.is_empty() { " " } else { glyph.as_str() };
                let spans = vec![
                    Span::styled(
                        format!(" {g} "),
                        Style::default()
                            .fg(Color::Rgb(130, 190, 250))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        row_text.clone(),
                        Style::default().fg(Color::Rgb(215, 222, 238)),
                    ),
                ];
                buf.set_line(
                    area.left().saturating_add(1),
                    y,
                    &Line::from(spans),
                    area.width.saturating_sub(2),
                );
                y = y.saturating_add(1);
            }
            if y < area.bottom().saturating_sub(1) {
                buf.set_stringn(area.left(), y, "├", 1, border_style);
                for x in (area.left() + 1)..area.right().saturating_sub(1) {
                    buf.set_stringn(x, y, "─", 1, border_style);
                }
                buf.set_stringn(area.right().saturating_sub(1), y, "┤", 1, border_style);
                if !self.face.hotkeys.is_empty() {
                    let hints = self
                        .face
                        .hotkeys
                        .iter()
                        .map(|(k, a)| {
                            if a.trim().is_empty() {
                                k.trim().to_string()
                            } else {
                                format!("{}: {}", k.trim(), a.trim())
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("  ");
                    let label = format!(" {hints} ");
                    let w = label.chars().count() as u16;
                    if w + 4 <= area.width {
                        let hx = area.right().saturating_sub(w + 2);
                        buf.set_stringn(
                            hx,
                            y,
                            &label,
                            w as usize,
                            Style::default().fg(Color::Rgb(165, 175, 198)),
                        );
                    }
                }
                y = y.saturating_add(1);
            }
        }

        // Main draft / body rows
        let body_lines: Vec<String> = if self.face.draft.is_empty() {
            vec![String::new()]
        } else {
            self.face.draft.lines().map(str::to_string).collect()
        };

        for (idx, line_str) in body_lines.iter().enumerate() {
            if y >= area.bottom().saturating_sub(1) {
                break;
            }
            buf.set_stringn(area.left(), y, "│", 1, border_style);
            buf.set_stringn(area.right().saturating_sub(1), y, "│", 1, border_style);
            let glyph = if idx == 0 { "❯" } else { " " };
            let mut spans = vec![Span::styled(
                format!(" {glyph} "),
                Style::default()
                    .fg(Color::Rgb(120, 190, 255))
                    .add_modifier(Modifier::BOLD),
            )];
            if idx == 0 && line_str.is_empty() && !self.face.placeholder.is_empty() {
                spans.push(Span::styled(
                    self.face.placeholder.clone(),
                    Style::default()
                        .fg(Color::Rgb(120, 128, 146))
                        .add_modifier(Modifier::DIM),
                ));
            } else {
                spans.push(Span::styled(
                    line_str.clone(),
                    Style::default().fg(Color::Rgb(230, 236, 248)),
                ));
                if idx == 0 && !self.face.completion.is_empty() {
                    spans.push(Span::styled(
                        self.face.completion.clone(),
                        Style::default()
                            .fg(Color::Rgb(120, 128, 146))
                            .add_modifier(Modifier::DIM),
                    ));
                }
                if idx + 1 == body_lines.len() && self.face.interactive && !self.face.read_only {
                    spans.push(Span::styled(
                        "█",
                        Style::default().fg(Color::Rgb(120, 190, 255)),
                    ));
                }
            }
            buf.set_line(
                area.left().saturating_add(1),
                y,
                &Line::from(spans),
                area.width.saturating_sub(2),
            );
            y = y.saturating_add(1);
        }

        // Optional command picker inside the frame
        if !self.face.choices.is_empty() && y < area.bottom().saturating_sub(1) {
            buf.set_stringn(area.left(), y, "├", 1, border_style);
            for x in (area.left() + 1)..area.right().saturating_sub(1) {
                buf.set_stringn(x, y, "─", 1, border_style);
            }
            buf.set_stringn(area.right().saturating_sub(1), y, "┤", 1, border_style);
            y = y.saturating_add(1);

            let selected_key = self.face.selected_command_key.as_str();
            for choice in self.face.choices.iter().take(8) {
                if y >= area.bottom().saturating_sub(1) {
                    break;
                }
                buf.set_stringn(area.left(), y, "│", 1, border_style);
                buf.set_stringn(area.right().saturating_sub(1), y, "│", 1, border_style);
                let row_key = if choice.key.is_empty() {
                    choice.name.as_str()
                } else {
                    choice.key.as_str()
                };
                let is_sel = !selected_key.is_empty() && row_key == selected_key;
                let row_bg = if is_sel {
                    Color::Rgb(34, 42, 58)
                } else {
                    Color::Reset
                };
                if is_sel {
                    let st = Style::default().bg(row_bg);
                    for x in (area.left() + 1)..area.right().saturating_sub(1) {
                        buf.get_mut(x, y).set_style(st);
                    }
                }
                let cursor = if is_sel { " ▸ " } else { "   " };
                let mut spans = vec![
                    Span::styled(
                        cursor,
                        Style::default()
                            .fg(Color::Rgb(120, 190, 255))
                            .bg(row_bg)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        choice.name.clone(),
                        Style::default()
                            .fg(Color::Rgb(225, 232, 245))
                            .bg(row_bg)
                            .add_modifier(Modifier::BOLD),
                    ),
                ];
                if !choice.annotation.trim().is_empty() {
                    spans.push(Span::styled(
                        format!("  {}", choice.annotation.trim()),
                        Style::default().fg(Color::Rgb(145, 155, 178)).bg(row_bg),
                    ));
                }
                if !choice.description.trim().is_empty() {
                    spans.push(Span::styled(
                        format!("  — {}", choice.description.trim()),
                        Style::default()
                            .fg(Color::Rgb(125, 134, 152))
                            .bg(row_bg)
                            .add_modifier(Modifier::DIM),
                    ));
                }
                buf.set_line(
                    area.left().saturating_add(1),
                    y,
                    &Line::from(spans),
                    area.width.saturating_sub(2),
                );
                y = y.saturating_add(1);
            }
        }

        // Fill any remaining interior rows
        let bot_y = area.bottom().saturating_sub(1);
        while y < bot_y {
            buf.set_stringn(area.left(), y, "│", 1, border_style);
            buf.set_stringn(area.right().saturating_sub(1), y, "│", 1, border_style);
            y = y.saturating_add(1);
        }

        // Bottom border
        buf.set_stringn(area.left(), bot_y, "╰", 1, border_style);
        for x in (area.left() + 1)..area.right().saturating_sub(1) {
            buf.set_stringn(x, bot_y, "─", 1, border_style);
        }
        buf.set_stringn(area.right().saturating_sub(1), bot_y, "╯", 1, border_style);

        let left_note = if !self.face.error_message.trim().is_empty() {
            self.face.error_message.trim()
        } else if !self.face.annotation.trim().is_empty() {
            self.face.annotation.trim()
        } else {
            self.face.join_annotation.trim()
        };
        if !left_note.is_empty() {
            let label = format!(" {left_note} ");
            let w = label.chars().count() as u16;
            if w + 4 <= area.width {
                let note_style = if !self.face.error_message.trim().is_empty() {
                    Style::default()
                        .fg(Color::Rgb(240, 100, 100))
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Rgb(155, 165, 188))
                };
                buf.set_stringn(
                    area.left().saturating_add(2),
                    bot_y,
                    &label,
                    w as usize,
                    note_style,
                );
            }
        }

        let mut right_parts: Vec<String> = self
            .face
            .status_items
            .iter()
            .map(|item| item.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if self.face.context_limit > 0.0 {
            let pct = ((self.face.context_used / self.face.context_limit) * 100.0)
                .round()
                .clamp(0.0, 100.0) as u32;
            right_parts.push(format!("ctx {pct}%"));
        }
        if !right_parts.is_empty() {
            let right_label = format!(" {} ", right_parts.join(" · "));
            let rw = right_label.chars().count() as u16;
            if rw + 4 <= area.width {
                let rx = area.right().saturating_sub(rw + 2);
                buf.set_stringn(
                    rx,
                    bot_y,
                    &right_label,
                    rw as usize,
                    Style::default().fg(Color::Rgb(145, 155, 178)),
                );
            }
        }
    }
}

