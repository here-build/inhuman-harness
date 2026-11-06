//! Speech widget for assistant/user speech with thinking, recall, compact, failure, syntax spans, and hotkeys.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;
use unicode_width::UnicodeWidthStr;

use crate::syntax;

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
    pub at_ms: Option<f64>,
    pub recap: bool,
    pub annotation: String,
    pub recap_hotkeys: Vec<(String, String)>,
    pub live: bool,
    pub failed: bool,
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
            at_ms: None,
            recap: false,
            annotation: String::new(),
            recap_hotkeys: Vec::new(),
            live: false,
            failed: false,
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
            at_ms: None,
            recap: false,
            annotation: String::new(),
            recap_hotkeys: Vec::new(),
            live: false,
            failed: false,
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

    pub fn with_at_ms(mut self, at_ms: Option<f64>) -> Self {
        self.at_ms = at_ms;
        self
    }

    pub fn with_recap(
        mut self,
        recap: bool,
        annotation: impl Into<String>,
        hotkeys: Vec<(String, String)>,
    ) -> Self {
        self.recap = recap;
        self.annotation = annotation.into();
        self.recap_hotkeys = hotkeys;
        self
    }

    pub fn live(mut self, live: bool) -> Self {
        self.live = live;
        self
    }

    pub fn failed(mut self, failed: bool) -> Self {
        self.failed = failed;
        self
    }

    pub fn height(&self) -> u16 {
        let mut rows = 0u16;
        if let Some(thinking) = &self.thinking {
            rows += 1;
            if !thinking.collapsed {
                rows += thinking.thoughts.len() as u16;
            }
        }
        if self.recall.is_some() {
            rows += 1;
        }
        let body_lines = markdown_lines(&self.content, Color::White).len().max(1) as u16;
        rows += body_lines;
        if !self.hotkeys.is_empty() || (self.recap && !self.recap_hotkeys.is_empty()) {
            rows += 1;
        }
        rows
    }
}

impl Widget for SpeechWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        let rail_str = match self.role {
            SpeechRole::User => "❯ ",
            SpeechRole::Assistant => {
                if self.failed {
                    "■ "
                } else {
                    "│ "
                }
            }
        };
        let rail_style = match self.role {
            SpeechRole::User => Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            SpeechRole::Assistant if self.failed => {
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)
            }
            SpeechRole::Assistant if self.live => {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            }
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
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::ITALIC),
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
                let text = format!(
                    "  [Recall: {} (keys: {})]",
                    recall.summary,
                    recall.keys.join(", ")
                );
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

        let base_fg = self.style.fg.unwrap_or(Color::Reset);
        let styled_lines = markdown_lines(&self.content, base_fg);
        let content_width = area.width.saturating_sub(self.rail_width);
        let mut first = true;
        for md_line in styled_lines {
            if y >= area.bottom() {
                break;
            }
            let is_first = first;
            let glyph = if first {
                first = false;
                rail_str
            } else {
                "  "
            };

            buf.set_stringn(area.left(), y, glyph, self.rail_width as usize, rail_style);
            buf.set_line(area.left() + self.rail_width, y, &md_line, content_width);

            if is_first {
                let mut right_meta = Vec::new();
                if !self.annotation.is_empty() {
                    right_meta.push(self.annotation.clone());
                }
                if let Some(ms) = self.at_ms {
                    let clk = format_clock_12h(ms);
                    if !clk.is_empty() {
                        right_meta.push(clk);
                    }
                }
                if !right_meta.is_empty() {
                    let meta_str = format!(" {}", right_meta.join(" · "));
                    let mw = meta_str.width() as u16;
                    if mw < content_width {
                        buf.set_stringn(
                            area.right().saturating_sub(mw),
                            y,
                            &meta_str,
                            mw as usize,
                            Style::default().fg(Color::DarkGray),
                        );
                    }
                }
            }

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
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD),
                ));
                hotkey_spans.push(Span::raw(" "));
                hotkey_spans.push(Span::styled(
                    label.as_str(),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            buf.set_line(area.left(), y, &Line::from(hotkey_spans), area.width);
        } else if self.recap && !self.recap_hotkeys.is_empty() && y < area.bottom() {
            let mut hotkey_spans = Vec::new();
            hotkey_spans.push(Span::raw("  "));
            for (i, (key, label)) in self.recap_hotkeys.iter().enumerate() {
                if i > 0 {
                    hotkey_spans.push(Span::raw(" · "));
                }
                hotkey_spans.push(Span::styled(
                    key.as_str(),
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD),
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

/// Replica thinking block for standalone or completion-nested thinking nodes.
#[derive(Debug, Clone)]
pub struct ReplicaThinkingBlock {
    pub text: String,
    pub collapsed: bool,
    pub sealed: bool,
    pub started_at: Option<f64>,
    pub finished_at: Option<f64>,
    pub duration_ms: Option<f64>,
    pub now_ms: Option<f64>,
    pub model: String,
    pub thought_kind: String,
}

impl ReplicaThinkingBlock {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            collapsed: true,
            sealed: true,
            started_at: None,
            finished_at: None,
            duration_ms: None,
            now_ms: None,
            model: String::new(),
            thought_kind: String::new(),
        }
    }

    pub fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }

    pub fn sealed(mut self, sealed: bool) -> Self {
        self.sealed = sealed;
        self
    }

    pub fn with_timing(
        mut self,
        started_at: Option<f64>,
        finished_at: Option<f64>,
        duration_ms: Option<f64>,
        now_ms: Option<f64>,
    ) -> Self {
        self.started_at = started_at;
        self.finished_at = finished_at;
        self.duration_ms = duration_ms;
        self.now_ms = now_ms;
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn with_thought_kind(mut self, kind: impl Into<String>) -> Self {
        self.thought_kind = kind.into();
        self
    }

    pub fn effective_elapsed_ms(&self) -> Option<f64> {
        if let Some(d) = self.duration_ms.filter(|d| d.is_finite() && *d >= 0.0) {
            return Some(d);
        }
        let start = self.started_at.filter(|s| s.is_finite())?;
        let end = self
            .finished_at
            .or(self.now_ms)
            .filter(|e| e.is_finite() && *e >= start)?;
        Some(end - start)
    }
}

pub struct ReplicaThinkingWidget<'a> {
    pub block: &'a ReplicaThinkingBlock,
}

impl<'a> ReplicaThinkingWidget<'a> {
    pub fn new(block: &'a ReplicaThinkingBlock) -> Self {
        Self { block }
    }

    pub fn height(&self) -> u16 {
        if self.block.collapsed {
            1
        } else {
            let lines = self
                .block
                .text
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count();
            (1 + lines).max(1) as u16
        }
    }
}

impl Widget for ReplicaThinkingWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let sigil = if !self.block.sealed {
            "◐ "
        } else if self.block.collapsed {
            "▸ "
        } else {
            "▾ "
        };
        let label = if !self.block.thought_kind.is_empty() {
            self.block.thought_kind.as_str()
        } else if self.block.sealed {
            "Thought"
        } else {
            "Thinking"
        };
        let mut spans = vec![
            Span::styled(
                format!("  {sigil}"),
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::DIM),
            ),
            Span::styled(
                label.to_string(),
                Style::default()
                    .fg(Color::Gray)
                    .add_modifier(Modifier::ITALIC),
            ),
        ];
        if let Some(ms) = self.block.effective_elapsed_ms() {
            spans.push(Span::styled(
                format!(" · {}", format_duration_compact(ms)),
                Style::default().fg(Color::DarkGray),
            ));
        }
        if !self.block.model.is_empty() {
            spans.push(Span::styled(
                format!(" · {}", self.block.model),
                Style::default().fg(Color::DarkGray),
            ));
        }
        let first_line = self
            .block
            .text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("");
        if self.block.collapsed && !first_line.is_empty() {
            spans.push(Span::styled(
                format!(" — {first_line}"),
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::ITALIC),
            ));
        }
        buf.set_line(area.left(), area.top(), &Line::from(spans), area.width);

        if !self.block.collapsed {
            let mut y = area.top() + 1;
            for raw in self.block.text.lines() {
                if y >= area.bottom() {
                    break;
                }
                let trimmed = raw.trim_end();
                if trimmed.is_empty() {
                    continue;
                }
                let row = Line::from(vec![
                    Span::styled("    │ ", Style::default().fg(Color::DarkGray)),
                    Span::styled(
                        trimmed.to_string(),
                        Style::default()
                            .fg(Color::Gray)
                            .add_modifier(Modifier::ITALIC),
                    ),
                ]);
                buf.set_line(area.left(), y, &row, area.width);
                y += 1;
            }
        }
    }
}

pub struct ReplicaRecallWidget<'a> {
    pub prompt: &'a str,
}

impl<'a> ReplicaRecallWidget<'a> {
    pub fn new(prompt: &'a str) -> Self {
        Self { prompt }
    }
}

impl Widget for ReplicaRecallWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let line = Line::from(vec![
            Span::styled("  ↳ ", Style::default().fg(Color::LightMagenta)),
            Span::styled("Recalled: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                self.prompt.lines().next().unwrap_or(""),
                Style::default().fg(Color::Gray),
            ),
        ]);
        buf.set_line(area.left(), area.top(), &line, area.width);
    }
}

#[derive(Debug, Clone)]
pub struct CompactBlock {
    pub summary: String,
}

pub struct CompactWidget<'a> {
    pub block: &'a CompactBlock,
}

impl<'a> CompactWidget<'a> {
    pub fn new(block: &'a CompactBlock) -> Self {
        Self { block }
    }
}

impl Widget for CompactWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let summary = self.block.summary.lines().next().unwrap_or("Compacted");
        let line = Line::from(vec![
            Span::styled("  ◈ ", Style::default().fg(Color::Cyan)),
            Span::styled(
                format!("Compacted conversation — {summary}"),
                Style::default().fg(Color::DarkGray),
            ),
        ]);
        buf.set_line(area.left(), area.top(), &line, area.width);
    }
}

#[derive(Debug, Clone)]
pub struct FailureBlock {
    pub detail: String,
    pub reason: String,
    pub at_ms: Option<f64>,
}

impl FailureBlock {
    pub fn new(detail: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            reason: reason.into(),
            at_ms: None,
        }
    }

    pub fn with_at_ms(mut self, at_ms: Option<f64>) -> Self {
        self.at_ms = at_ms;
        self
    }
}

pub struct FailureWidget<'a> {
    pub block: &'a FailureBlock,
}

impl<'a> FailureWidget<'a> {
    pub fn new(block: &'a FailureBlock) -> Self {
        Self { block }
    }
}

impl Widget for FailureWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let mut spans = vec![Span::styled(
            "  ■ ",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )];
        if !self.block.reason.is_empty() {
            spans.push(Span::styled(
                self.block.reason.as_str(),
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ));
            if !self.block.detail.is_empty() {
                spans.push(Span::styled(" — ", Style::default().fg(Color::DarkGray)));
            }
        }
        if !self.block.detail.is_empty() {
            spans.push(Span::styled(
                self.block.detail.as_str(),
                Style::default().fg(Color::LightRed),
            ));
        }
        buf.set_line(area.left(), area.top(), &Line::from(spans), area.width);

        if let Some(ms) = self.block.at_ms {
            let clk = format_clock_12h(ms);
            let cw = clk.width() as u16;
            if !clk.is_empty() && cw + 4 < area.width {
                buf.set_stringn(
                    area.right().saturating_sub(cw),
                    area.top(),
                    &clk,
                    cw as usize,
                    Style::default().fg(Color::DarkGray),
                );
            }
        }
    }
}

pub fn format_duration_compact(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0.0 {
        return "0s".to_string();
    }
    let secs = ms / 1000.0;
    if secs < 10.0 {
        format!("{secs:.1}s")
    } else if secs < 60.0 {
        format!("{}s", secs.round() as u64)
    } else {
        let mins = (secs / 60.0).floor() as u64;
        let rem = (secs % 60.0).round() as u64;
        format!("{mins}m {rem}s")
    }
}

pub fn format_clock_12h(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0.0 {
        return String::new();
    }
    let total_secs = (ms / 1000.0).floor() as i64;
    let day_secs = total_secs.rem_euclid(86_400);
    let hour24 = day_secs / 3600;
    let minute = (day_secs % 3600) / 60;
    let am_pm = if hour24 >= 12 { "PM" } else { "AM" };
    let hour12 = match hour24 % 12 {
        0 => 12,
        h => h,
    };
    format!("{hour12}:{minute:02} {am_pm}")
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

pub fn markdown_lines(text: &str, base_fg: Color) -> Vec<Line<'static>> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut in_fence = false;
    let mut fence_lang = String::new();
    let mut fence_buf: Vec<String> = Vec::new();

    for raw in text.lines() {
        let trimmed = raw.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```") {
            if in_fence {
                let code = fence_buf.join("\n");
                let token_lines = syntax::highlight(&code, &fence_lang);
                for tl in token_lines {
                    let mut spans = vec![Span::styled(
                        "│ ",
                        Style::default().fg(Color::DarkGray),
                    )];
                    for tok in tl {
                        let mut st = Style::default().fg(
                            tok.color
                                .as_deref()
                                .and_then(parse_hex_color)
                                .unwrap_or(Color::White),
                        );
                        if tok.bold {
                            st = st.add_modifier(Modifier::BOLD);
                        }
                        if tok.italic {
                            st = st.add_modifier(Modifier::ITALIC);
                        }
                        spans.push(Span::styled(tok.text, st));
                    }
                    out.push(Line::from(spans));
                }
                fence_buf.clear();
                fence_lang.clear();
                in_fence = false;
            } else {
                in_fence = true;
                fence_lang = rest.trim().to_string();
            }
            continue;
        }
        if in_fence {
            fence_buf.push(raw.to_string());
        } else {
            out.push(style_inline_markdown(raw, base_fg));
        }
    }

    if in_fence && !fence_buf.is_empty() {
        let code = fence_buf.join("\n");
        for tl in syntax::highlight(&code, &fence_lang) {
            let mut spans = vec![Span::styled("│ ", Style::default().fg(Color::DarkGray))];
            for tok in tl {
                let st = Style::default().fg(
                    tok.color
                        .as_deref()
                        .and_then(parse_hex_color)
                        .unwrap_or(Color::White),
                );
                spans.push(Span::styled(tok.text, st));
            }
            out.push(Line::from(spans));
        }
    }

    out
}

fn style_inline_markdown(line: &str, base_fg: Color) -> Line<'static> {
    if let Some(heading) = line
        .strip_prefix("### ")
        .or_else(|| line.strip_prefix("## "))
        .or_else(|| line.strip_prefix("# "))
    {
        return Line::from(Span::styled(
            heading.to_string(),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));
    }

    let mut spans = Vec::new();
    let mut rest = line;
    let normal_style = Style::default().fg(base_fg);

    while !rest.is_empty() {
        let next_code = rest.find('`');
        let next_bold = rest.find("**");

        match (next_code, next_bold) {
            (Some(c), b) if b.is_none_or(|b_idx| c <= b_idx) => {
                if c > 0 {
                    spans.push(Span::styled(rest[..c].to_string(), normal_style));
                }
                let after = &rest[c + 1..];
                if let Some(end) = after.find('`') {
                    spans.push(Span::styled(
                        after[..end].to_string(),
                        Style::default().fg(Color::LightCyan),
                    ));
                    rest = &after[end + 1..];
                } else {
                    spans.push(Span::styled(rest[c..].to_string(), normal_style));
                    break;
                }
            }
            (_, Some(b)) => {
                if b > 0 {
                    spans.push(Span::styled(rest[..b].to_string(), normal_style));
                }
                let after = &rest[b + 2..];
                if let Some(end) = after.find("**") {
                    spans.push(Span::styled(
                        after[..end].to_string(),
                        normal_style.add_modifier(Modifier::BOLD),
                    ));
                    rest = &after[end + 2..];
                } else {
                    spans.push(Span::styled(rest[b..].to_string(), normal_style));
                    break;
                }
            }
            _ => {
                spans.push(Span::styled(rest.to_string(), normal_style));
                break;
            }
        }
    }

    Line::from(spans)
}
