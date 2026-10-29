//! Markdown and diff priors become layout nodes.
//!
//! `expand_markdown(text) -> Node` parses a markdown subset into a
//! [`crate::layout_engine::Node`] tree. [`expand_markdown_with`] adds a key,
//! a soft-wrap column budget, and a body [`crate::Style`].
//!
//! `expand_diff(...) -> Node` reads [`DiffExpand`] (`old`, `new`, width, path,
//! mode, context) and returns an
//! [`IndentKind::Diff`](crate::layout_engine::IndentKind) indentation
//! exception: a header plus lines. The tree is not the JSON text
//! `{"type":"diff"}`.
//!
//! A paired line that is only a deletion or only an insertion collapses to
//! one `diff_mod` row. Deleted spans use ghost prominence. Added spans use a
//! green panel. Mixed pairs stay two rows, or one split row when Auto fits.
//!
//! The markdown token is an enum (`text`, `strong`, `code`, `fence`,
//! `paragraph`, and the other inline and block kinds below). The layout walk
//! matches that enum. It does not scan the source for markers again.
//!
//! Fenced code and diff lines call [`crate::syntax::highlight`]. Until
//! [`crate::syntax::warm`], each line is one uncolored run and the fence
//! keeps `role: code`. `language` selects the grammar. `no_highlight` skips
//! the call, so the diff stays uncolored. A fence with no info string uses
//! [`crate::embed::guess_lang`].
//!
//! [`MarkdownStream`] re-parses the buffer on each [`MarkdownStream::nodes`]
//! call. The last character is visible, and an unclosed backtick still shows
//! its body. A lone trailing tick stays text.
//!
//! [`parse_patch`] reads a unified diff into one [`PatchFile`] per hunk.
//! [`parse_patch_to_layout`] keeps every hunk of a file under one header.
//! The gap before a hunk is `collapsed_before`, including before the first
//! hunk when that hunk starts past line 1.

use crate::guard_content;
use crate::layout_engine::{
    BoxStyle, Gutter, IndentKind, Node, Overflow, SqueezePins, INDICATION_CONTENT_INSET,
};
pub use crate::layout_engine::{DiffContext, DiffMode};
use crate::layout_flex::{CellPad, FlexDirection, FlexStyle, GridLines, GridStyle, Length};
use crate::layout_text::{wrap_text, WhiteSpace, WrapOpts};
use crate::measure::display_width;
use crate::syntax::{self, TokenRun};
use crate::syntax_diff;
use crate::theme::{BgP, FgP};
use crate::Style;

const BULLET: &str = "\u{2022} ";
const RULE: &str = "\u{2500}\u{2500}\u{2500}";
const QUOTE_BAR: &str = "\u{2502}";
const GUTTER: &str = "\u{258C}";
const MIDDOT: char = '\u{00B7}';

/// Markdown that is still arriving. Each [`MarkdownStream::write`] appends,
/// and [`MarkdownStream::nodes`] expands the buffer so far, including the
/// last character.
pub struct MarkdownStream {
    buf: String,
    key: String,
    width: Option<i64>,
}

impl MarkdownStream {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            buf: String::new(),
            key: key.into(),
            width: None,
        }
    }

    pub fn width(mut self, width: i64) -> Self {
        self.width = Some(width);
        self
    }

    pub fn write(&mut self, chunk: &str) {
        self.buf.push_str(chunk);
    }

    pub fn nodes(&self) -> Node {
        let mut opts = MarkdownExpand::new(&self.buf);
        opts.key = &self.key;
        opts.width = self.width;
        expand_markdown_with(&opts)
    }
}

/// One hunk from a unified diff. `old` and `new` are that hunk's lines only.
/// A file with two hunks is two values, so each keeps its own `@@` origins.
/// [`parse_patch_to_layout`] keeps those hunks under one file header.
pub struct PatchFile {
    pub path: String,
    pub old: String,
    pub new: String,
    /// Old-side origin from `@@ -N`.
    pub line_start: i64,
    /// New-side origin from `@@ +N`.
    pub new_line_start: i64,
}

/// Split a `git diff` or a unified diff into hunks.
pub fn parse_patch(patch: &str) -> Vec<PatchFile> {
    crate::pierre::parse_patch_files(patch)
        .into_iter()
        .flat_map(|file| {
            let name = file.name;
            file.hunks.into_iter().map(move |hunk| PatchFile {
                path: name.clone(),
                old: hunk_side(&hunk, false),
                new: hunk_side(&hunk, true),
                line_start: hunk.deletion_start,
                new_line_start: hunk.addition_start,
            })
        })
        .collect()
}

/// One layout node per file. A header with no hunk is an empty file.
/// `collapsed_before` is an elision between hunks, under that one header.
pub fn parse_patch_to_layout(patch: &str, width: i64) -> Node {
    let files = crate::pierre::parse_patch_files(patch);
    if files.is_empty() {
        return expand_diff(&DiffExpand::new("", "", width));
    }
    if files.len() == 1 {
        return layout_patch_file(&files[0], width, "patch");
    }
    let children = files
        .iter()
        .enumerate()
        .map(|(index, file)| layout_patch_file(file, width, &format!("patch:{index}")))
        .collect();
    flex_node("patch".to_string(), column_style(width.max(1)), children)
}

fn hunk_side(hunk: &crate::pierre::Hunk, addition: bool) -> String {
    let mut out = String::new();
    for block in &hunk.blocks {
        let lines = match block {
            crate::pierre::HunkBlock::Context { lines } => lines,
            crate::pierre::HunkBlock::Change {
                deletions,
                additions,
            } => {
                if addition {
                    additions
                } else {
                    deletions
                }
            }
        };
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn layout_patch_file(file: &crate::pierre::PatchFileMeta, width: i64, key: &str) -> Node {
    if file.hunks.is_empty() {
        return empty_diff(key, &file.name, false);
    }
    let lang = syntax::lang_for_path(&file.name).unwrap_or("");
    let mut rows = Vec::new();
    for (index, hunk) in file.hunks.iter().enumerate() {
        let gap = usize::try_from(hunk.collapsed_before).unwrap_or(0);
        if gap > 0 {
            rows.push(elide_row(gap, &format!("{key}:gap{index}"), width));
        }
        rows.extend(paint_hunk(hunk, width, &format!("{key}:h{index}"), lang));
    }
    let body = flex_node(format!("{key}:body"), column_style(width.max(1)), rows);
    diff_root(key, &file.name, false, body)
}

fn paint_hunk(hunk: &crate::pierre::Hunk, width: i64, key: &str, lang: &str) -> Vec<Node> {
    let mut lines = Vec::new();
    let mut old_no = hunk.deletion_start;
    let mut new_no = hunk.addition_start;
    for block in &hunk.blocks {
        match block {
            crate::pierre::HunkBlock::Context { lines: text } => {
                for line in text {
                    lines.push(raw_line(LineKind::Ctx, line, Some(old_no), Some(new_no)));
                    old_no = old_no.saturating_add(1);
                    new_no = new_no.saturating_add(1);
                }
            }
            crate::pierre::HunkBlock::Change {
                deletions,
                additions,
            } => {
                let mut run = Vec::new();
                let mut del_no = old_no;
                for line in deletions {
                    run.push(raw_line(LineKind::Del, line, Some(del_no), None));
                    del_no = del_no.saturating_add(1);
                }
                let mut add_no = new_no;
                for line in additions {
                    run.push(raw_line(LineKind::Add, line, None, Some(add_no)));
                    add_no = add_no.saturating_add(1);
                }
                paint_word_alt(&mut run);
                old_no = del_no;
                new_no = add_no;
                lines.extend(run);
            }
        }
    }
    let old_hl = highlight_side(&hunk_side(hunk, false), lang, false);
    let new_hl = highlight_side(&hunk_side(hunk, true), lang, false);
    let hl = Hl {
        old: &old_hl,
        new: &new_hl,
        old_origin: hunk.deletion_start,
        new_origin: hunk.addition_start,
    };
    let mut best = 1i64;
    for line in &lines {
        if let Some(number) = line.old_no {
            best = best.max(number);
        }
        if let Some(number) = line.new_no {
            best = best.max(number);
        }
    }
    let num_w = num_width(best);
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            make_row(
                line,
                &format!("{key}:r{index}"),
                width,
                num_w,
                hl.runs(line),
            )
        })
        .collect()
}

/// Teach the layout walk to expand markdown and diff nodes.
pub fn install_realize() {
    crate::layout_engine::set_realize(realize_node);
}

fn realize_node(node: &Node) -> Option<Node> {
    match node {
        Node::Markdown { text, key, width } => {
            let mut opts = MarkdownExpand::new(text);
            if let Some(key) = key {
                opts.key = key;
            }
            opts.width = *width;
            Some(expand_markdown_with(&opts))
        }
        Node::Diff {
            old,
            new,
            path,
            key,
            width,
            mode,
            context,
            line_start,
            new_line_start,
            hide_header,
        } => {
            let mut opts = DiffExpand::new(old, new, *width);
            if let Some(path) = path {
                opts.path = path;
            }
            if let Some(key) = key {
                opts.key = key;
            }
            if let Some(mode) = mode {
                opts.mode = *mode;
            }
            if let Some(context) = context {
                opts.context = *context;
            }
            opts.line_start = *line_start;
            opts.new_line_start = *new_line_start;
            opts.hide_header = *hide_header;
            Some(expand_diff(&opts))
        }
        _ => None,
    }
}

/// One-shot markdown expand. Key `md`, no soft-wrap budget, default voice.
pub fn expand_markdown(text: &str) -> Node {
    expand_markdown_with(&MarkdownExpand::new(text))
}

/// Markdown expand with a key, a column budget, and an optional body voice.
pub fn expand_markdown_with(opts: &MarkdownExpand<'_>) -> Node {
    let key = if opts.key.is_empty() { "md" } else { opts.key };
    let mut owned = String::new();
    let lines = source_lines(opts.text, &mut owned);
    let tokens = parse_lines(&lines);
    let mut ctx = Ctx {
        key,
        seq: 0,
        base: voice_base(opts.style),
    };
    let width = positive_width(opts.width);
    let kids = materialize_blocks(&tokens, &mut ctx, width);
    let children = if kids.is_empty() {
        vec![leaf(
            format!("{key}:empty"),
            String::new(),
            Style::default(),
            None,
        )]
    } else {
        with_flow_margins(kids, key)
    };
    box_node(key.to_string(), BoxStyle::default(), children)
}

/// Body text plus the optional expand budget.
pub struct MarkdownExpand<'a> {
    pub text: &'a str,
    pub key: &'a str,
    /// Soft-wrap columns. `None` or `<= 0` leaves a pre-wrap text node.
    pub width: Option<i64>,
    pub style: Option<&'a Style>,
}

impl<'a> MarkdownExpand<'a> {
    pub fn new(text: &'a str) -> Self {
        Self {
            text,
            key: "md",
            width: None,
            style: None,
        }
    }
}

/// `expand_diff(...) -> Node`. Old and new are whole file sides, not a patch.
pub fn expand_diff(opts: &DiffExpand<'_>) -> Node {
    let key = if opts.key.is_empty() {
        "diff"
    } else {
        opts.key
    };
    let path = opts.path;
    let width = if opts.width < 1 { 1 } else { opts.width };
    if opts.old.is_empty() && opts.new.is_empty() {
        return empty_diff(key, path, opts.hide_header);
    }
    let old = normalize_diff_side(opts.old);
    let new = normalize_diff_side(opts.new);
    if old == new {
        return no_changes_diff(key, path, width, opts.hide_header);
    }
    let old_lines = split_source_lines(&old);
    let new_lines = split_source_lines(&new);
    let from_path = syntax::lang_for_path(opts.path).unwrap_or("");
    let lang = opts
        .language
        .filter(|lang| !lang.is_empty())
        .unwrap_or(from_path);
    let old_origin = line_origin(opts.line_start);
    let new_origin = line_origin(opts.new_line_start.unwrap_or(opts.line_start));
    let old_hl = highlight_side(&old, lang, opts.no_highlight);
    let new_hl = highlight_side(&new, lang, opts.no_highlight);
    let hl = Hl {
        old: &old_hl,
        new: &new_hl,
        old_origin,
        new_origin,
    };
    let mut raw = number_lines(&lcs_ops(&old_lines, &new_lines), old_origin, new_origin);
    paint_word_alt(&mut raw);
    let context = match opts.context {
        DiffContext::All => None,
        DiffContext::Lines(n) => Some(n as usize),
    };
    let painted = apply_fold(&raw, context);
    let num_w = num_width(max_line_no(&painted));
    let body_rows = match opts.mode {
        DiffMode::Split => project_split(&painted, width, num_w, key, &hl),
        DiffMode::Unified => {
            project_ladder(&painted, width, num_w, key, &hl, false, lang, path)
        }
        DiffMode::Auto => project_ladder(&painted, width, num_w, key, &hl, true, lang, path),
    };
    let sticky = if opts.sticky_bottom > 0 {
        opts.sticky_bottom
    } else {
        0
    };
    let body = if sticky > 0 && !body_rows.is_empty() {
        let mut style = BoxStyle::default();
        style.width = Some(Length::Cells(width));
        style.squeeze = Some(SqueezePins {
            head: sticky,
            tail: sticky,
        });
        box_node(format!("{key}:squeeze"), style, body_rows)
    } else {
        flex_node(format!("{key}:body"), column_style(width), body_rows)
    };
    diff_root(key, path, opts.hide_header, body)
}

/// Old/new pair passed to [`expand_diff`].
pub struct DiffExpand<'a> {
    pub old: &'a str,
    pub new: &'a str,
    pub path: &'a str,
    pub width: i64,
    pub mode: DiffMode,
    pub context: DiffContext,
    pub key: &'a str,
    pub hide_header: bool,
    /// 1-based file line of the first old-side row. Values below 2 start at 1.
    pub line_start: i64,
    /// New-side origin. `None` uses [`DiffExpand::line_start`].
    pub new_line_start: Option<i64>,
    /// Ask-pin squeeze. `0` leaves the body as a column.
    pub sticky_bottom: i64,
    /// Grammar name. Empty uses the path. Until [`crate::syntax::warm`],
    /// each line is one uncolored run.
    pub language: Option<&'a str>,
    /// Skips [`crate::syntax::highlight`]. The diff stays uncolored.
    pub no_highlight: bool,
}

impl<'a> DiffExpand<'a> {
    pub fn new(old: &'a str, new: &'a str, width: i64) -> Self {
        Self {
            old,
            new,
            path: "file",
            width,
            mode: DiffMode::Auto,
            context: DiffContext::Lines(3),
            key: "diff",
            hide_header: false,
            line_start: 1,
            new_line_start: None,
            sticky_bottom: 0,
            language: None,
            no_highlight: false,
        }
    }
}

/// Markdown token. Layout matches this; it does not re-parse marker strings.
#[derive(Debug)]
enum Token {
    Text(String),
    Strong(Vec<Token>),
    Em(Vec<Token>),
    Code(String),
    Strike(Vec<Token>),
    Link {
        label: Vec<Token>,
        href: String,
    },
    Image {
        alt: String,
        src: String,
    },
    HardBreak,
    Paragraph(Vec<Token>),
    Heading {
        level: u8,
        inline: Vec<Token>,
    },
    Fence {
        lang: String,
        body: String,
    },
    Quote(Vec<Token>),
    Rule,
    ListItem {
        ordered: bool,
        number: usize,
        inline: Vec<Token>,
    },
    Table {
        cols: usize,
        cells: Vec<Vec<Token>>,
    },
}

#[derive(Clone)]
struct Part {
    text: String,
    style: Style,
}

struct Ctx<'a> {
    key: &'a str,
    seq: usize,
    base: Style,
}

impl Ctx<'_> {
    fn next_key(&mut self, kind: &str) -> String {
        let key = format!("{}:{kind}-{}", self.key, self.seq);
        self.seq += 1;
        key
    }
}

fn voice_base(style: Option<&Style>) -> Style {
    let mut out = match style {
        Some(style) => style.clone(),
        None => Style::default(),
    };
    if out.role.is_none() {
        out.role = Some("foreground".to_string());
    }
    if out.prominence.is_none() {
        out.prominence = Some(FgP::SECONDARY);
    }
    out
}

fn heading_style(base: &Style) -> Style {
    let mut style = base.clone();
    style.prominence = Some(FgP::PRIMARY);
    style
}

fn fence_style(base: &Style) -> Style {
    let mut style = Style::default();
    style.role = Some("code".to_string());
    style.prominence = Some(base.prominence.unwrap_or(FgP::SECONDARY));
    style
}

fn border_ghost() -> Style {
    let mut style = Style::default();
    style.role = Some("border".to_string());
    style.prominence = Some(FgP::GHOST);
    style
}

fn with_bold(base: &Style) -> Style {
    let mut style = base.clone();
    style.bold = true;
    style
}

fn with_italic(base: &Style) -> Style {
    let mut style = base.clone();
    style.italic = true;
    style
}

fn with_strike(base: &Style) -> Style {
    let mut style = base.clone();
    style.strike = true;
    style
}

fn with_code(base: &Style) -> Style {
    let mut style = base.clone();
    style.role = Some("code".to_string());
    style
}

fn with_link(base: &Style, href: &str) -> Style {
    let mut style = base.clone();
    style.role = Some("accent".to_string());
    style.underline = true;
    style.href = Some(href.to_string());
    style
}

fn positive_width(width: Option<i64>) -> Option<usize> {
    match width {
        Some(w) if w > 0 => usize::try_from(w).ok(),
        _ => None,
    }
}

fn source_lines<'a>(text: &'a str, owned: &'a mut String) -> Vec<&'a str> {
    let needs_guard = text.contains('\u{001b}') || text.contains('\u{009b}');
    let needs_cr = text.contains('\r');
    if !needs_guard && !needs_cr {
        return split_source_lines(text);
    }
    let guarded = if needs_guard {
        guard_content(text)
    } else {
        text.to_string()
    };
    if guarded.contains('\r') {
        *owned = normalize_cr(&guarded);
    } else {
        *owned = guarded;
    }
    split_source_lines(owned)
}

fn split_source_lines(src: &str) -> Vec<&str> {
    if src.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = src.split('\n').collect();
    if src.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn normalize_cr(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            out.push('\n');
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn normalize_diff_side(src: &str) -> String {
    let mut text = if src.contains('\r') {
        normalize_cr(src)
    } else {
        src.to_string()
    };
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

fn parse_lines(lines: &[&str]) -> Vec<Token> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if is_fence_line(line) {
            out.push(take_fence(lines, &mut i));
            continue;
        }
        if is_hr(line) {
            out.push(Token::Rule);
            i += 1;
            continue;
        }
        if let Some((level, rest)) = is_heading(line) {
            out.push(Token::Heading {
                level,
                inline: parse_inlines(rest),
            });
            i += 1;
            continue;
        }
        if is_quote_line(line) {
            let start = i;
            i += 1;
            while i < lines.len() && is_quote_line(lines[i]) {
                i += 1;
            }
            let inner: Vec<String> = lines[start..i]
                .iter()
                .map(|line| strip_quote(line).to_string())
                .collect();
            let refs: Vec<&str> = inner.iter().map(String::as_str).collect();
            out.push(Token::Quote(parse_lines(&refs)));
            continue;
        }
        if looks_like_table(lines, i) {
            out.push(take_table(lines, &mut i));
            continue;
        }
        if let Some((ordered, number, content)) = list_marker(line) {
            out.push(Token::ListItem {
                ordered,
                number,
                inline: parse_inlines(content),
            });
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < lines.len() && !is_block_start(lines[i]) {
            i += 1;
        }
        out.push(make_paragraph(&lines[start..i]));
    }
    out
}

fn is_block_start(line: &str) -> bool {
    line.trim().is_empty()
        || is_fence_line(line)
        || is_hr(line)
        || is_heading(line).is_some()
        || is_quote_line(line)
        || is_table_line(line)
        || list_marker(line).is_some()
}

fn is_fence_line(line: &str) -> bool {
    line.trim_start().starts_with("```")
}

fn is_quote_line(line: &str) -> bool {
    line.trim_start().starts_with('>')
}

fn is_heading(line: &str) -> Option<(u8, &str)> {
    let bytes = line.as_bytes();
    let mut n = 0;
    while n < bytes.len() && n < 6 && bytes[n] == b'#' {
        n += 1;
    }
    if n == 0 || bytes.get(n) != Some(&b' ') {
        return None;
    }
    Some((n as u8, &line[n + 1..]))
}

fn is_hr(line: &str) -> bool {
    let trimmed = line.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 {
        return false;
    }
    let marker = bytes[0];
    if marker != b'-' && marker != b'*' && marker != b'_' {
        return false;
    }
    let mut count = 0usize;
    for byte in bytes {
        if *byte == marker {
            count += 1;
        } else if *byte != b' ' && *byte != b'\t' {
            return false;
        }
    }
    count >= 3
}

fn is_table_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') && trimmed.matches('|').count() >= 2
}

fn looks_like_table(lines: &[&str], start: usize) -> bool {
    if start >= lines.len() || !is_table_line(lines[start]) {
        return false;
    }
    let mut i = start;
    while i < lines.len() && is_table_line(lines[i]) {
        if is_sep_row(&split_table_cells(lines[i])) {
            return true;
        }
        i += 1;
    }
    false
}

fn list_marker(line: &str) -> Option<(bool, usize, &str)> {
    let trimmed = line.trim_start();
    let bytes = trimmed.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    if matches!(bytes[0], b'-' | b'*' | b'+') {
        if bytes.get(1) == Some(&b' ') || bytes.get(1) == Some(&b'\t') {
            return Some((false, 0, trimmed[1..].trim_start()));
        }
        return None;
    }
    let mut j = 0;
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
        if j > 9 {
            return None;
        }
    }
    if j == 0 {
        return None;
    }
    if bytes.get(j) != Some(&b'.') && bytes.get(j) != Some(&b')') {
        return None;
    }
    if bytes.get(j + 1) != Some(&b' ') && bytes.get(j + 1) != Some(&b'\t') {
        return None;
    }
    let number = match trimmed[..j].parse::<usize>() {
        Ok(number) => number,
        Err(_) => return None,
    };
    Some((true, number, trimmed[j + 1..].trim_start()))
}

fn strip_quote(line: &str) -> &str {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('>').unwrap_or(trimmed);
    rest.strip_prefix(' ').unwrap_or(rest)
}

fn take_fence(lines: &[&str], i: &mut usize) -> Token {
    let lang = fence_lang(lines[*i]);
    *i += 1;
    let start = *i;
    while *i < lines.len() && !is_fence_line(lines[*i]) {
        *i += 1;
    }
    let body = lines[start..*i].join("\n");
    if *i < lines.len() {
        *i += 1;
    }
    Token::Fence { lang, body }
}

fn fence_lang(open_line: &str) -> String {
    let trimmed = open_line.trim_start();
    let rest = trimmed.strip_prefix("```").unwrap_or(trimmed).trim();
    rest.strip_prefix("language-")
        .unwrap_or(rest)
        .trim()
        .to_string()
}

fn make_paragraph(lines: &[&str]) -> Token {
    let mut tokens = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if idx > 0 {
            let prev = lines[idx - 1];
            if prev.ends_with("  ") {
                tokens.push(Token::HardBreak);
            } else {
                tokens.push(Token::Text(" ".to_string()));
            }
        }
        let cooked = if line.ends_with("  ") {
            line.trim_end()
        } else {
            *line
        };
        tokens.extend(parse_inlines(cooked));
    }
    Token::Paragraph(merge_text(tokens))
}

fn take_table(lines: &[&str], i: &mut usize) -> Token {
    let start = *i;
    let mut data = Vec::new();
    while *i < lines.len() && is_table_line(lines[*i]) {
        let cells = split_table_cells(lines[*i]);
        *i += 1;
        if !is_sep_row(&cells) {
            data.push(cells);
        }
    }
    if data.is_empty() {
        let raw = lines[start..*i].join("\n");
        return Token::Paragraph(parse_inlines(&raw));
    }
    // First row sets the track count. Later rows pad or trim to it.
    let cols = data.first().map(Vec::len).unwrap_or(1).max(1);
    let mut flat = Vec::new();
    for mut row in data {
        if row.len() > cols {
            row.truncate(cols);
        }
        let missing = cols - row.len();
        for cell in row {
            flat.push(parse_inlines(&cell));
        }
        for _ in 0..missing {
            flat.push(Vec::new());
        }
    }
    Token::Table { cols, cells: flat }
}

fn split_table_cells(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let trimmed = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('|').unwrap_or(trimmed);
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect()
}

fn is_sep_row(cells: &[String]) -> bool {
    !cells.is_empty() && cells.iter().all(|cell| is_sep_cell(cell))
}

fn is_sep_cell(cell: &str) -> bool {
    let bytes = cell.trim().as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    if bytes[i] == b':' {
        i += 1;
    }
    let dashes = i;
    while i < bytes.len() && bytes[i] == b'-' {
        i += 1;
    }
    if i == dashes {
        return false;
    }
    if i < bytes.len() && bytes[i] == b':' {
        i += 1;
    }
    i == bytes.len()
}

fn parse_inlines(src: &str) -> Vec<Token> {
    if src.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let next = next_special(src, i);
        if next > i {
            out.push(Token::Text(src[i..next].to_string()));
            i = next;
            if i >= src.len() {
                break;
            }
        }
        match try_marker(src, i) {
            Some((token, end)) if end > i => {
                out.push(token);
                i = end;
            }
            _ => {
                let Some(ch) = src[i..].chars().next() else {
                    break;
                };
                let end = i + ch.len_utf8();
                if let Some(Token::Text(prev)) = out.last_mut() {
                    prev.push(ch);
                } else {
                    out.push(Token::Text(ch.to_string()));
                }
                i = end;
            }
        }
    }
    merge_text(out)
}

fn merge_text(tokens: Vec<Token>) -> Vec<Token> {
    let mut out = Vec::new();
    for token in tokens {
        match token {
            Token::Text(text) if text.is_empty() => {}
            Token::Text(text) => {
                if let Some(Token::Text(prev)) = out.last_mut() {
                    prev.push_str(&text);
                } else {
                    out.push(Token::Text(text));
                }
            }
            other => out.push(other),
        }
    }
    out
}

fn next_special(src: &str, from: usize) -> usize {
    let bytes = src.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'*' | b'_' | b'`' | b'~' | b'[' | b'!' | b'\\' => return i,
            _ => i += 1,
        }
    }
    src.len()
}

fn try_marker(src: &str, i: usize) -> Option<(Token, usize)> {
    let rest = src.get(i..)?;
    let bytes = rest.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    if bytes[0] == b'\\' {
        let ch = rest[1..].chars().next()?;
        return Some((Token::Text(ch.to_string()), i + 1 + ch.len_utf8()));
    }
    if rest.starts_with("***") {
        if let Some(close) = find_seq(src, i + 3, "***") {
            if close > i + 3 {
                let inner = src.get(i + 3..close)?;
                return Some((
                    Token::Strong(vec![Token::Em(parse_inlines(inner))]),
                    close + 3,
                ));
            }
        }
    }
    if rest.starts_with("**") || rest.starts_with("__") {
        let marker = if rest.starts_with("**") { "**" } else { "__" };
        if let Some(close) = find_seq(src, i + 2, marker) {
            if close > i + 2 {
                let inner = src.get(i + 2..close)?;
                return Some((Token::Strong(parse_inlines(inner)), close + 2));
            }
        }
    }
    if rest.starts_with("~~") {
        if let Some(close) = find_seq(src, i + 2, "~~") {
            if close > i + 2 {
                let inner = src.get(i + 2..close)?;
                return Some((Token::Strike(parse_inlines(inner)), close + 2));
            }
        }
    }
    if bytes[0] == b'`' {
        if let Some(close) = find_byte(src, i + 1, b'`') {
            if close > i + 1 {
                let inner = src.get(i + 1..close)?;
                return Some((Token::Code(inner.to_string()), close + 1));
            }
        } else if src.len() > i + 1 {
            // Unclosed code still shows the body. A lone trailing tick stays text.
            let inner = src.get(i + 1..)?;
            return Some((Token::Code(inner.to_string()), src.len()));
        }
    }
    if rest.starts_with("![") {
        if let Some((alt, src_url, consumed)) = parse_link_like(src, i + 1) {
            return Some((Token::Image { alt, src: src_url }, i + 1 + consumed));
        }
    }
    if bytes[0] == b'[' {
        if let Some((label, href, consumed)) = parse_link_like(src, i) {
            return Some((
                Token::Link {
                    label: parse_inlines(&label),
                    href,
                },
                i + consumed,
            ));
        }
    }
    if (bytes[0] == b'*' || bytes[0] == b'_') && left_flank_ok(src, i) {
        if let Some(close) = find_em_closer(src, i, bytes[0]) {
            let inner = src.get(i + 1..close)?;
            return Some((Token::Em(parse_inlines(inner)), close + 1));
        }
    }
    None
}

fn find_seq(src: &str, from: usize, marker: &str) -> Option<usize> {
    let bytes = src.as_bytes();
    let marker = marker.as_bytes();
    if from > bytes.len() || marker.is_empty() {
        return None;
    }
    let horizon = match bytes[from..].iter().position(|byte| *byte == b'\n') {
        Some(pos) => from + pos,
        None => bytes.len(),
    };
    let mut j = from;
    while j + marker.len() <= horizon {
        if &bytes[j..j + marker.len()] == marker {
            return Some(j);
        }
        j += 1;
    }
    None
}

fn find_byte(src: &str, from: usize, marker: u8) -> Option<usize> {
    let bytes = src.as_bytes();
    if from > bytes.len() {
        return None;
    }
    for (offset, byte) in bytes[from..].iter().enumerate() {
        if *byte == b'\n' {
            return None;
        }
        if *byte == marker {
            return Some(from + offset);
        }
    }
    None
}

fn find_em_closer(src: &str, open: usize, marker: u8) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut j = open + 1;
    while j < bytes.len() && bytes[j] != b'\n' {
        if bytes[j] == marker {
            if j + 1 < bytes.len() && bytes[j + 1] == marker && bytes[j + 1] != b'\n' {
                j += 2;
                continue;
            }
            if j > open + 1 && right_flank_ok(src, j + 1) {
                return Some(j);
            }
        }
        j += 1;
    }
    None
}

fn left_flank_ok(src: &str, i: usize) -> bool {
    if i == 0 {
        return true;
    }
    match src[..i].chars().next_back() {
        Some(ch) if ch.is_ascii_alphanumeric() => false,
        _ => true,
    }
}

fn right_flank_ok(src: &str, end: usize) -> bool {
    if end >= src.len() {
        return true;
    }
    match src[end..].chars().next() {
        Some(ch) if ch.is_ascii_alphanumeric() => false,
        _ => true,
    }
}

fn parse_link_like(src: &str, bracket: usize) -> Option<(String, String, usize)> {
    let bytes = src.as_bytes();
    if bracket >= bytes.len() || bytes[bracket] != b'[' {
        return None;
    }
    let mut label_end = bracket + 1;
    while label_end < bytes.len() && bytes[label_end] != b'\n' && bytes[label_end] != b']' {
        label_end += 1;
    }
    if label_end >= bytes.len() || bytes[label_end] != b']' {
        return None;
    }
    let paren = label_end + 1;
    if paren >= bytes.len() || bytes[paren] != b'(' {
        return None;
    }
    let mut href_end = paren + 1;
    while href_end < bytes.len() && bytes[href_end] != b'\n' && bytes[href_end] != b')' {
        href_end += 1;
    }
    if href_end >= bytes.len() || bytes[href_end] != b')' {
        return None;
    }
    let label = src.get(bracket + 1..label_end)?.to_string();
    let href = src.get(paren + 1..href_end)?.to_string();
    Some((label, href, href_end + 1 - bracket))
}

fn materialize_blocks(tokens: &[Token], ctx: &mut Ctx<'_>, width: Option<usize>) -> Vec<Node> {
    tokens
        .iter()
        .map(|token| block_node(token, ctx, width))
        .collect()
}

fn block_node(token: &Token, ctx: &mut Ctx<'_>, width: Option<usize>) -> Node {
    match token {
        Token::Paragraph(inline) => {
            let key = ctx.next_key("p");
            let parts = inline_parts(inline, &ctx.base);
            parts_to_node(&parts, &key, width)
        }
        Token::Heading { level: _, inline } => {
            // Markdown level is not a paint tier. Every heading uses primary.
            let key = ctx.next_key("h");
            let style = heading_style(&ctx.base);
            let parts = inline_parts(inline, &style);
            parts_to_node(&parts, &key, width)
        }
        Token::Fence { lang, body } => fence_node(lang, body, ctx),
        Token::Quote(inner) => quote_node(inner, ctx, width),
        Token::Rule => {
            let key = ctx.next_key("hr");
            leaf(key, RULE.to_string(), border_ghost(), None)
        }
        Token::ListItem {
            ordered,
            number,
            inline,
        } => list_node(*ordered, *number, inline, ctx, width),
        Token::Table { cols, cells } => table_node(*cols, cells, ctx),
        Token::Text(_)
        | Token::Strong(_)
        | Token::Em(_)
        | Token::Code(_)
        | Token::Strike(_)
        | Token::Link { .. }
        | Token::Image { .. }
        | Token::HardBreak => {
            let key = ctx.next_key("p");
            let parts = inline_parts(std::slice::from_ref(token), &ctx.base);
            parts_to_node(&parts, &key, width)
        }
    }
}

fn inline_parts(tokens: &[Token], style: &Style) -> Vec<Part> {
    let mut parts = Vec::new();
    for token in tokens {
        match token {
            Token::Text(text) => parts.push(Part {
                text: text.clone(),
                style: style.clone(),
            }),
            Token::Strong(inner) => parts.extend(inline_parts(inner, &with_bold(style))),
            Token::Em(inner) => parts.extend(inline_parts(inner, &with_italic(style))),
            Token::Strike(inner) => parts.extend(inline_parts(inner, &with_strike(style))),
            Token::Code(text) => parts.push(Part {
                text: text.clone(),
                style: with_code(style),
            }),
            Token::Link { label, href } => {
                parts.extend(inline_parts(label, &with_link(style, href)));
            }
            Token::Image { alt, src } => {
                let text = if src.is_empty() {
                    format!("![{alt}]")
                } else {
                    format!("![{alt}]({src})")
                };
                let mut image = Style::default();
                image.role = Some("muted".to_string());
                image.prominence = Some(FgP::GHOST);
                parts.push(Part { text, style: image });
            }
            Token::HardBreak => parts.push(Part {
                text: "\n".to_string(),
                style: style.clone(),
            }),
            Token::Paragraph(inner)
            | Token::Heading { inline: inner, .. }
            | Token::Quote(inner) => {
                parts.extend(inline_parts(inner, style));
            }
            Token::ListItem { inline, .. } => parts.extend(inline_parts(inline, style)),
            Token::Fence { body, .. } => parts.push(Part {
                text: body.clone(),
                style: style.clone(),
            }),
            Token::Rule => parts.push(Part {
                text: RULE.to_string(),
                style: style.clone(),
            }),
            Token::Table { .. } => {}
        }
    }
    parts
}

fn list_node(
    ordered: bool,
    number: usize,
    inline: &[Token],
    ctx: &mut Ctx<'_>,
    width: Option<usize>,
) -> Node {
    let key = ctx.next_key("li");
    let prefix = if ordered {
        format!("{number}. ")
    } else {
        BULLET.to_string()
    };
    let mut parts = vec![Part {
        text: prefix,
        style: ctx.base.clone(),
    }];
    parts.extend(inline_parts(inline, &ctx.base));
    parts_to_node(&parts, &key, width)
}

fn quote_node(inner: &[Token], ctx: &mut Ctx<'_>, width: Option<usize>) -> Node {
    let kids = materialize_blocks(inner, ctx, inset_width(width));
    let flow_key = ctx.next_key("bq-flow");
    let kids = with_flow_margins(kids, &flow_key);
    Node::Indication {
        gutter: Gutter::Rule {
            glyph: QUOTE_BAR.to_string(),
        },
        children: kids,
        style: border_ghost(),
        key: Some(ctx.next_key("bq")),
        measured: None,
        region_prominence: None,
    }
}

fn inset_width(width: Option<usize>) -> Option<usize> {
    let inset = usize::try_from(INDICATION_CONTENT_INSET).unwrap_or(0);
    width.map(|value| value.saturating_sub(inset).max(1))
}

fn fence_node(lang: &str, body: &str, ctx: &mut Ctx<'_>) -> Node {
    let kind = if lang.is_empty() {
        "fence".to_string()
    } else {
        format!("fence-{lang}")
    };
    let key = ctx.next_key(&kind);
    let style = fence_style(&ctx.base);
    let source = body.strip_suffix('\n').unwrap_or(body);
    let guessed = if lang.is_empty() {
        crate::embed::guess_lang(source).unwrap_or("")
    } else {
        lang
    };
    let painted = if guessed.is_empty() {
        Vec::new()
    } else {
        syntax::highlight(source, guessed)
    };
    let colored = painted
        .iter()
        .flatten()
        .any(|run| run.color.is_some() || run.bold || run.italic);
    let lines = fence_lines(body);
    let children = lines
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            if colored {
                runs_node(
                    format!("{key}:{index}"),
                    &line,
                    painted.get(index).map(Vec::as_slice),
                    style.clone(),
                )
            } else {
                leaf(
                    format!("{key}:{index}"),
                    line,
                    style.clone(),
                    Some(WhiteSpace::PreWrap),
                )
            }
        })
        .collect();
    Node::IndentationException {
        kind: IndentKind::CodePad,
        children,
        key: Some(key),
        measured: None,
        region_prominence: None,
    }
}

fn fence_lines(body: &str) -> Vec<String> {
    if body.is_empty() {
        return vec![" ".to_string()];
    }
    let trimmed = body.strip_suffix('\n').unwrap_or(body);
    if trimmed.is_empty() {
        return vec![" ".to_string()];
    }
    trimmed
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                " ".to_string()
            } else {
                line.to_string()
            }
        })
        .collect()
}

fn table_node(cols: usize, cells: &[Vec<Token>], ctx: &mut Ctx<'_>) -> Node {
    let n = cols.max(1);
    let key = ctx.next_key("table");
    let mut children = Vec::with_capacity(cells.len());
    for (index, cell) in cells.iter().enumerate() {
        let cell_key = ctx.next_key("td");
        let parts = inline_parts(cell, &ctx.base);
        let node = parts_to_node(&parts, &cell_key, None);
        if index < n {
            children.push(as_header(node));
        } else {
            children.push(node);
        }
    }
    Node::Grid {
        style: GridStyle {
            columns: vec![Length::Auto; n],
            column_gap: Some(1),
            row_gap: Some(1),
            lines: GridLines::Inner,
            cell_pad: Some(CellPad::Axes {
                x: Some(1),
                y: None,
            }),
            width: None,
            height: None,
        },
        line_style: Some(border_ghost()),
        children,
        key: Some(key),
        measured: None,
        region_prominence: None,
    }
}

fn as_header(node: Node) -> Node {
    match node {
        Node::Text {
            content,
            white_space,
            ellipsis,
            line_clamp,
            measured,
            mut style,
            key,
            live,
            region_prominence,
        } => {
            style.bold = true;
            style.prominence = Some(FgP::PRIMARY);
            Node::Text {
                content,
                white_space,
                ellipsis,
                line_clamp,
                measured,
                style,
                key,
                live,
                region_prominence,
            }
        }
        Node::Flex {
            style,
            children,
            key,
            measured,
            region_prominence,
        } => Node::Flex {
            style,
            children: children.into_iter().map(as_header).collect(),
            key,
            measured,
            region_prominence,
        },
        Node::Box {
            style,
            children,
            key,
            id,
            measured,
            region_prominence,
        } => Node::Box {
            style,
            children: children.into_iter().map(as_header).collect(),
            key,
            id,
            measured,
            region_prominence,
        },
        other => other,
    }
}

fn parts_to_node(parts: &[Part], key: &str, width: Option<usize>) -> Node {
    let merged = merge_parts(parts);
    if merged.is_empty() {
        return leaf(key.to_string(), String::new(), Style::default(), None);
    }
    if let Some(width) = width {
        if width > 0 {
            let rows = soft_wrap_parts(&merged, width);
            if rows.len() == 1 {
                return row_to_node(&rows[0], key);
            }
            let children = rows
                .iter()
                .enumerate()
                .map(|(index, row)| row_to_node(row, &format!("{key}:w{index}")))
                .collect();
            return box_node(key.to_string(), BoxStyle::default(), children);
        }
    }
    if merged.len() == 1 {
        return leaf(
            key.to_string(),
            merged[0].text.clone(),
            merged[0].style.clone(),
            Some(WhiteSpace::PreWrap),
        );
    }
    row_to_node(&merged, key)
}

fn row_to_node(parts: &[Part], key: &str) -> Node {
    let merged = merge_parts(parts);
    if merged.is_empty() {
        return leaf(
            key.to_string(),
            " ".to_string(),
            Style::default(),
            Some(WhiteSpace::Nowrap),
        );
    }
    if merged.len() == 1 {
        return leaf(
            key.to_string(),
            merged[0].text.clone(),
            merged[0].style.clone(),
            Some(WhiteSpace::Nowrap),
        );
    }
    let children = merged
        .into_iter()
        .enumerate()
        .map(|(index, part)| {
            leaf(
                format!("{key}:{index}"),
                part.text,
                part.style,
                Some(WhiteSpace::Nowrap),
            )
        })
        .collect();
    flex_node(key.to_string(), row_style(None), children)
}

fn soft_wrap_parts(parts: &[Part], width: usize) -> Vec<Vec<Part>> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let merged = merge_parts(parts);
    let budget = i64::try_from(width).unwrap_or(i64::MAX);
    for hard in split_hard_lines(&merged) {
        let text = join_parts(&hard);
        let mut opts = WrapOpts::new(budget);
        opts.white_space = WhiteSpace::PreWrap;
        let lines = wrap_text(&text, &opts);
        let mut offset = 0usize;
        for line in &lines {
            let end = offset + line.len();
            let slice = slice_parts(&hard, offset, end);
            if slice.is_empty() {
                rows.push(vec![Part {
                    text: " ".to_string(),
                    style: Style::default(),
                }]);
            } else {
                rows.push(slice);
            }
            offset = end;
        }
    }
    if rows.is_empty() {
        rows.push(vec![Part {
            text: " ".to_string(),
            style: Style::default(),
        }]);
    }
    rows
}

fn split_hard_lines(parts: &[Part]) -> Vec<Vec<Part>> {
    let mut lines = vec![Vec::new()];
    for part in parts {
        let mut pieces = part.text.split('\n');
        if let Some(first) = pieces.next() {
            push_chunk(&mut lines, first, &part.style);
            for piece in pieces {
                lines.push(Vec::new());
                push_chunk(&mut lines, piece, &part.style);
            }
        }
    }
    lines
}

fn push_chunk(lines: &mut Vec<Vec<Part>>, text: &str, style: &Style) {
    if text.is_empty() {
        return;
    }
    if let Some(line) = lines.last_mut() {
        line.push(Part {
            text: text.to_string(),
            style: style.clone(),
        });
    }
}

fn slice_parts(parts: &[Part], start: usize, end: usize) -> Vec<Part> {
    if end <= start {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for part in parts {
        let part_end = cursor + part.text.len();
        if part_end <= start {
            cursor = part_end;
            continue;
        }
        if cursor >= end {
            break;
        }
        let from = snap_boundary(&part.text, start.saturating_sub(cursor));
        let to = snap_boundary(&part.text, end.saturating_sub(cursor).min(part.text.len()));
        if to > from {
            out.push(Part {
                text: part.text[from..to].to_string(),
                style: part.style.clone(),
            });
        }
        cursor = part_end;
    }
    out
}

fn snap_boundary(text: &str, mut index: usize) -> usize {
    if index > text.len() {
        return text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn join_parts(parts: &[Part]) -> String {
    let mut out = String::new();
    for part in parts {
        out.push_str(&part.text);
    }
    out
}

fn merge_parts(parts: &[Part]) -> Vec<Part> {
    let mut out: Vec<Part> = Vec::new();
    for part in parts {
        if part.text.is_empty() {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if last.style == part.style {
                last.text.push_str(&part.text);
                continue;
            }
        }
        out.push(part.clone());
    }
    out
}

fn needs_flow(node: &Node) -> bool {
    match node {
        Node::Grid { .. } | Node::Indication { .. } => true,
        other => node_key(other).is_some_and(is_paragraph_key),
    }
}

fn is_paragraph_key(key: &str) -> bool {
    let Some(index) = key.rfind(":p-") else {
        return false;
    };
    let rest = &key[index + 3..];
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}

fn node_key(node: &Node) -> Option<&str> {
    match node {
        Node::Text { key, .. }
        | Node::Box { key, .. }
        | Node::Flex { key, .. }
        | Node::Grid { key, .. }
        | Node::Indication { key, .. }
        | Node::Overlay { key, .. }
        | Node::Disclosure { key, .. }
        | Node::Squeeze { key, .. }
        | Node::Viewport { key, .. }
        | Node::IndentationException { key, .. }
        | Node::Chrome { key, .. } => key.as_deref(),
        Node::Markdown { .. } | Node::Diff { .. } | Node::Skipped => None,
    }
}

fn with_flow_margins(kids: Vec<Node>, key: &str) -> Vec<Node> {
    let mut out = Vec::new();
    for node in kids {
        if let Some(prev) = out.last() {
            if needs_flow(prev) || needs_flow(&node) {
                let gap = format!("{key}:flow-gap-{}", out.len());
                out.push(leaf(
                    gap,
                    " ".to_string(),
                    Style::default(),
                    Some(WhiteSpace::Nowrap),
                ));
            }
        }
        out.push(node);
    }
    out
}

fn highlight_side(source: &str, lang: &str, no_highlight: bool) -> Vec<Vec<TokenRun>> {
    if no_highlight || lang.is_empty() {
        return Vec::new();
    }
    let source = source.trim_end_matches('\n');
    if source.is_empty() {
        return Vec::new();
    }
    syntax::highlight(source, lang)
}

/// Token runs for one source line. A wrapped visual row does not use these:
/// the runs belong to the unwrapped line.
struct Hl<'a> {
    old: &'a [Vec<TokenRun>],
    new: &'a [Vec<TokenRun>],
    old_origin: i64,
    new_origin: i64,
}

impl Hl<'_> {
    fn runs(&self, line: &RawLine) -> Option<&[TokenRun]> {
        let (table, number, origin) = match line.kind {
            LineKind::Add => (self.new, line.new_no?, self.new_origin),
            LineKind::Del => (self.old, line.old_no?, self.old_origin),
            LineKind::Mod => {
                if line.inline_old {
                    (self.old, line.old_no?, self.old_origin)
                } else {
                    (self.new, line.new_no?, self.new_origin)
                }
            }
            LineKind::Ctx => (self.old, line.old_no.or(line.new_no)?, self.old_origin),
            LineKind::Blank => return None,
        };
        let index = usize::try_from(number.checked_sub(origin)?).ok()?;
        table.get(index).map(Vec::as_slice)
    }
}

fn runs_node(key: String, fallback: &str, runs: Option<&[TokenRun]>, base: Style) -> Node {
    let Some(runs) = runs.filter(|runs| runs.iter().any(|run| !run.text.is_empty())) else {
        return leaf(key, fallback.to_string(), base, Some(WhiteSpace::PreWrap));
    };
    if runs.len() == 1 {
        let mut style = base;
        syntax::apply_run(&mut style, &runs[0]);
        let text = if runs[0].text.is_empty() {
            fallback.to_string()
        } else {
            runs[0].text.clone()
        };
        return leaf(key, text, style, Some(WhiteSpace::PreWrap));
    }
    let children = runs
        .iter()
        .enumerate()
        .filter(|(_, run)| !run.text.is_empty())
        .map(|(index, run)| {
            let mut style = base.clone();
            syntax::apply_run(&mut style, run);
            leaf(
                format!("{key}:{index}"),
                run.text.clone(),
                style,
                Some(WhiteSpace::Nowrap),
            )
        })
        .collect();
    flex_node(key, row_style(None), children)
}

fn leaf(key: String, content: String, style: Style, white_space: Option<WhiteSpace>) -> Node {
    Node::Text {
        content,
        white_space,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style,
        key: Some(key),
        live: None,
        region_prominence: None,
    }
}

fn box_node(key: String, style: BoxStyle, children: Vec<Node>) -> Node {
    Node::Box {
        style,
        children,
        key: Some(key),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn flex_node(key: String, style: FlexStyle, children: Vec<Node>) -> Node {
    Node::Flex {
        style,
        children,
        key: Some(key),
        measured: None,
        region_prominence: None,
    }
}

fn row_style(width: Option<i64>) -> FlexStyle {
    FlexStyle {
        direction: FlexDirection::Row,
        gap: 0,
        width: width.map(Length::Cells),
        ..FlexStyle::default()
    }
}

fn column_style(width: i64) -> FlexStyle {
    FlexStyle {
        direction: FlexDirection::Column,
        gap: 0,
        width: Some(Length::Cells(width)),
        ..FlexStyle::default()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LineKind {
    Ctx,
    Del,
    Add,
    Blank,
    /// One polarity collapsed onto the surviving line.
    Mod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpanTone {
    Plain,
    Emphasized,
    GhostDel,
    Added,
}

#[derive(Clone, Debug)]
struct RawLine {
    kind: LineKind,
    text: String,
    old_no: Option<i64>,
    new_no: Option<i64>,
    spans: Vec<Span>,
    /// `Mod` paints this side. Other kinds leave it false.
    inline_old: bool,
}

#[derive(Clone, Debug)]
struct Span {
    text: String,
    tone: SpanTone,
}

#[derive(Clone, Debug)]
enum Painted {
    Line(RawLine),
    Elided(usize),
}

enum Op<'a> {
    Keep(&'a str),
    Del(&'a str),
    Add(&'a str),
}

fn lcs_ops<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<Op<'a>> {
    let n = old.len();
    let m = new.len();
    if n == 0 {
        return new.iter().copied().map(Op::Add).collect();
    }
    if m == 0 {
        return old.iter().copied().map(Op::Del).collect();
    }
    // The n×m table is the exact diff. Past 250_000 cells, unique lines
    // anchor the match and only the gaps use the table. A gap with no
    // shared unique line is a rewrite of that gap, not of the whole file.
    if n.saturating_mul(m) > 250_000 {
        return anchored(old, new);
    }
    let cols = m + 1;
    let mut dp = vec![0u32; (n + 1) * cols];
    let at = |i: usize, j: usize| i * cols + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[at(i, j)] = if old[i] == new[j] {
                dp[at(i + 1, j + 1)].saturating_add(1)
            } else {
                dp[at(i + 1, j)].max(dp[at(i, j + 1)])
            };
        }
    }
    let mut ops = Vec::new();
    let mut i = 0;
    let mut j = 0;
    while i < n && j < m {
        if old[i] == new[j] {
            ops.push(Op::Keep(old[i]));
            i += 1;
            j += 1;
        } else if dp[at(i + 1, j)] >= dp[at(i, j + 1)] {
            ops.push(Op::Del(old[i]));
            i += 1;
        } else {
            ops.push(Op::Add(new[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(Op::Del(old[i]));
        i += 1;
    }
    while j < m {
        ops.push(Op::Add(new[j]));
        j += 1;
    }
    ops
}

fn anchored<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<Op<'a>> {
    if old.is_empty() {
        return new.iter().copied().map(Op::Add).collect();
    }
    if new.is_empty() {
        return old.iter().copied().map(Op::Del).collect();
    }
    if old.len().saturating_mul(new.len()) <= 250_000 {
        return lcs_ops(old, new);
    }
    let mut prefix = 0usize;
    while prefix < old.len() && prefix < new.len() && old[prefix] == new[prefix] {
        prefix += 1;
    }
    let mut old_end = old.len();
    let mut new_end = new.len();
    while old_end > prefix && new_end > prefix && old[old_end - 1] == new[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }
    let mut ops = Vec::new();
    for line in &old[..prefix] {
        ops.push(Op::Keep(line));
    }
    let mid_old = &old[prefix..old_end];
    let mid_new = &new[prefix..new_end];
    let anchors = unique_anchors(mid_old, mid_new);
    if anchors.is_empty() {
        ops.extend(mid_old.iter().copied().map(Op::Del));
        ops.extend(mid_new.iter().copied().map(Op::Add));
    } else {
        let mut prev_i = 0usize;
        let mut prev_j = 0usize;
        for (old_at, new_at) in anchors {
            ops.extend(anchored(&mid_old[prev_i..old_at], &mid_new[prev_j..new_at]));
            ops.push(Op::Keep(mid_old[old_at]));
            prev_i = old_at + 1;
            prev_j = new_at + 1;
        }
        ops.extend(anchored(&mid_old[prev_i..], &mid_new[prev_j..]));
    }
    for line in &old[old_end..] {
        ops.push(Op::Keep(line));
    }
    ops
}

fn unique_anchors(old: &[&str], new: &[&str]) -> Vec<(usize, usize)> {
    use std::collections::HashMap;
    let mut old_at: HashMap<&str, Option<usize>> = HashMap::new();
    for (index, line) in old.iter().enumerate() {
        old_at
            .entry(*line)
            .and_modify(|slot| *slot = None)
            .or_insert(Some(index));
    }
    let mut new_at: HashMap<&str, Option<usize>> = HashMap::new();
    for (index, line) in new.iter().enumerate() {
        new_at
            .entry(*line)
            .and_modify(|slot| *slot = None)
            .or_insert(Some(index));
    }
    let mut pairs = Vec::new();
    for (line, old_index) in &old_at {
        let Some(old_index) = *old_index else {
            continue;
        };
        let Some(Some(new_index)) = new_at.get(line) else {
            continue;
        };
        pairs.push((old_index, *new_index));
    }
    pairs.sort_by_key(|pair| pair.0);
    patience(&pairs)
}

fn patience(pairs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut tails: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None; pairs.len()];
    for (index, &(_, new_index)) in pairs.iter().enumerate() {
        let pos = tails.partition_point(|&tail| pairs[tail].1 < new_index);
        if pos > 0 {
            prev[index] = Some(tails[pos - 1]);
        }
        if pos == tails.len() {
            tails.push(index);
        } else {
            tails[pos] = index;
        }
    }
    let mut out = Vec::new();
    let mut current = tails.last().copied();
    while let Some(index) = current {
        out.push(pairs[index]);
        current = prev[index];
    }
    out.reverse();
    out
}

fn raw_line(kind: LineKind, text: &str, old_no: Option<i64>, new_no: Option<i64>) -> RawLine {
    RawLine {
        kind,
        spans: vec![Span {
            text: text.to_string(),
            tone: SpanTone::Plain,
        }],
        text: text.to_string(),
        old_no,
        new_no,
        inline_old: false,
    }
}

fn paint_word_alt(lines: &mut [RawLine]) {
    let mut index = 0usize;
    while index < lines.len() {
        if lines[index].kind != LineKind::Del && lines[index].kind != LineKind::Add {
            index += 1;
            continue;
        }
        let start = index;
        while index < lines.len() && lines[index].kind == LineKind::Del {
            index += 1;
        }
        let del_end = index;
        while index < lines.len() && lines[index].kind == LineKind::Add {
            index += 1;
        }
        let add_end = index;
        let del_n = del_end - start;
        let add_n = add_end - del_end;
        let paired = del_n.min(add_n);
        for pair in 0..paired {
            let old = lines[start + pair].text.clone();
            let new = lines[del_end + pair].text.clone();
            lines[start + pair].spans = word_alt(&old, &new, true);
            lines[del_end + pair].spans = word_alt(&old, &new, false);
        }
        for pair in paired..del_n {
            emphasize(&mut lines[start + pair]);
        }
        for pair in paired..add_n {
            emphasize(&mut lines[del_end + pair]);
        }
    }
}

fn emphasize(line: &mut RawLine) {
    line.spans = vec![Span {
        text: line.text.clone(),
        tone: SpanTone::Emphasized,
    }];
}

fn word_alt(old_line: &str, new_line: &str, deleted: bool) -> Vec<Span> {
    if old_line.len() > 1000 || new_line.len() > 1000 {
        return vec![Span {
            text: if deleted { old_line } else { new_line }.to_string(),
            tone: SpanTone::Emphasized,
        }];
    }
    let old_tokens = word_tokens(old_line);
    let new_tokens = word_tokens(new_line);
    let ops = lcs_ops(&old_tokens, &new_tokens);
    let mut joined: Vec<(String, bool, bool)> = Vec::new();
    for op in ops {
        let (text, added, removed) = match op {
            Op::Keep(text) => (text.to_string(), false, false),
            Op::Add(text) => (text.to_string(), true, false),
            Op::Del(text) => (text.to_string(), false, true),
        };
        if let Some((last, last_added, last_removed)) = joined.last_mut() {
            let same = *last_added == added && *last_removed == removed && (added || removed);
            let fuse = same
                && ((!last.ends_with(' ') && !text.starts_with(' '))
                    || (last.ends_with(' ') && !text.starts_with(' ')));
            if fuse {
                last.push_str(&text);
                continue;
            }
        }
        joined.push((text, added, removed));
    }
    let mut out = Vec::new();
    for (text, added, removed) in joined {
        if deleted {
            if added {
                continue;
            }
            out.push(Span {
                text,
                tone: if removed {
                    SpanTone::Emphasized
                } else {
                    SpanTone::Plain
                },
            });
        } else if !removed {
            out.push(Span {
                text,
                tone: if added {
                    SpanTone::Emphasized
                } else {
                    SpanTone::Plain
                },
            });
        }
    }
    if out.is_empty() {
        vec![Span {
            text: if deleted { old_line } else { new_line }.to_string(),
            tone: SpanTone::Plain,
        }]
    } else {
        out
    }
}

fn word_tokens(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut in_space: Option<bool> = None;
    for (index, ch) in line.char_indices() {
        let space = ch.is_whitespace();
        if in_space != Some(space) {
            if index > start {
                out.push(&line[start..index]);
            }
            start = index;
            in_space = Some(space);
        }
    }
    if start < line.len() {
        out.push(&line[start..]);
    }
    out
}

/// Emphasized slices keep the highlighter run and set bold on that slice only.
fn emphasized_line(key: String, spans: &[Span], runs: Option<&[TokenRun]>, base: Style) -> Node {
    let Some(runs) = runs.filter(|runs| runs.iter().any(|run| !run.text.is_empty())) else {
        return span_line(key, spans, base);
    };
    let mut children = Vec::new();
    let mut span_at = 0usize;
    let mut span_off = 0usize;
    let mut run_at = 0usize;
    let mut run_off = 0usize;
    while span_at < spans.len() && run_at < runs.len() {
        if span_off >= spans[span_at].text.len() {
            span_at += 1;
            span_off = 0;
            continue;
        }
        if run_off >= runs[run_at].text.len() {
            run_at += 1;
            run_off = 0;
            continue;
        }
        let span_rest = &spans[span_at].text[span_off..];
        let run_rest = &runs[run_at].text[run_off..];
        let n = aligned_len(span_rest, run_rest);
        if n == 0 {
            break;
        }
        children.push(run_piece(
            &key,
            children.len(),
            span_rest[..n].to_string(),
            &runs[run_at],
            spans[span_at].tone,
            &base,
        ));
        span_off += n;
        run_off += n;
    }
    while span_at < spans.len() {
        if span_off >= spans[span_at].text.len() {
            span_at += 1;
            span_off = 0;
            continue;
        }
        let text = spans[span_at].text[span_off..].to_string();
        let tone = spans[span_at].tone;
        children.push(run_piece(
            &key,
            children.len(),
            text,
            &plain_run(""),
            tone,
            &base,
        ));
        span_at += 1;
        span_off = 0;
    }
    if children.is_empty() {
        return span_line(key, spans, base);
    }
    flex_node(key, row_style(None), children)
}

fn run_piece(
    key: &str,
    index: usize,
    text: String,
    run: &TokenRun,
    tone: SpanTone,
    base: &Style,
) -> Node {
    let mut style = base.clone();
    syntax::apply_run(&mut style, run);
    apply_span_tone(&mut style, tone);
    leaf(
        format!("{key}:{index}"),
        text,
        style,
        Some(WhiteSpace::Nowrap),
    )
}

fn apply_span_tone(style: &mut Style, tone: SpanTone) {
    match tone {
        SpanTone::Plain => {}
        SpanTone::Emphasized => style.bold = true,
        SpanTone::GhostDel => {
            style.bold = false;
            style.strike = false;
            style.role = Some("diff_del".to_string());
            style.prominence = Some(FgP::GHOST);
            style.bg_role = Some("diff_del".to_string());
            style.bg_prominence = Some(BgP::PANEL);
        }
        SpanTone::Added => {
            style.role = Some("diff_add".to_string());
            style.prominence = Some(FgP::PRIMARY);
            style.bg_role = Some("diff_add".to_string());
            style.bg_prominence = Some(BgP::PANEL);
        }
    }
}

fn plain_run(text: &str) -> TokenRun {
    TokenRun {
        text: text.to_string(),
        color: None,
        bold: false,
        italic: false,
    }
}

fn aligned_len(left: &str, right: &str) -> usize {
    let mut n = left.len().min(right.len());
    while n > 0 && (!left.is_char_boundary(n) || !right.is_char_boundary(n)) {
        n -= 1;
    }
    n
}

fn span_line(key: String, spans: &[Span], base: Style) -> Node {
    let children = spans
        .iter()
        .enumerate()
        .map(|(index, span)| {
            let mut style = base.clone();
            apply_span_tone(&mut style, span.tone);
            leaf(
                format!("{key}:{index}"),
                span.text.clone(),
                style,
                Some(WhiteSpace::PreWrap),
            )
        })
        .collect();
    flex_node(
        key,
        FlexStyle {
            direction: FlexDirection::Row,
            gap: 0,
            ..FlexStyle::default()
        },
        children,
    )
}

fn line_origin(start: i64) -> i64 {
    if start > 1 {
        start
    } else {
        1
    }
}

fn number_lines(ops: &[Op<'_>], old_origin: i64, new_origin: i64) -> Vec<RawLine> {
    let mut old_no = old_origin;
    let mut new_no = new_origin;
    let mut lines = Vec::with_capacity(ops.len());
    for op in ops {
        match op {
            Op::Keep(text) => {
                lines.push(raw_line(LineKind::Ctx, text, Some(old_no), Some(new_no)));
                old_no = old_no.saturating_add(1);
                new_no = new_no.saturating_add(1);
            }
            Op::Del(text) => {
                lines.push(raw_line(LineKind::Del, text, Some(old_no), None));
                old_no = old_no.saturating_add(1);
            }
            Op::Add(text) => {
                lines.push(raw_line(LineKind::Add, text, None, Some(new_no)));
                new_no = new_no.saturating_add(1);
            }
        }
    }
    lines
}

fn apply_fold(lines: &[RawLine], context: Option<usize>) -> Vec<Painted> {
    let Some(context) = context else {
        return lines.iter().cloned().map(Painted::Line).collect();
    };
    let n = lines.len();
    let mut keep = vec![false; n];
    for (index, line) in lines.iter().enumerate() {
        if line.kind == LineKind::Ctx {
            continue;
        }
        let from = index.saturating_sub(context);
        let to = (index + context + 1).min(n);
        for slot in &mut keep[from..to] {
            *slot = true;
        }
    }
    let mut out = Vec::new();
    let mut index = 0;
    while index < n {
        if keep[index] {
            out.push(Painted::Line(lines[index].clone()));
            index += 1;
            continue;
        }
        let start = index;
        while index < n && !keep[index] {
            index += 1;
        }
        out.push(Painted::Elided(index - start));
    }
    out
}

fn max_line_no(lines: &[Painted]) -> i64 {
    let mut best = 1i64;
    for line in lines {
        let Painted::Line(line) = line else {
            continue;
        };
        if let Some(number) = line.old_no {
            best = best.max(number);
        }
        if let Some(number) = line.new_no {
            best = best.max(number);
        }
    }
    best
}

fn num_width(value: i64) -> usize {
    let mut width = 1usize;
    let mut rest = value;
    while rest >= 10 {
        rest /= 10;
        width += 1;
    }
    width
}

fn split_half_width(width: i64) -> i64 {
    ((width - 1) / 2).max(8)
}

fn row_chrome(num_w: usize) -> i64 {
    1 + i64::try_from(num_w).unwrap_or(i64::MAX) + 1
}

fn split_content_width(width: i64, num_w: usize) -> i64 {
    (split_half_width(width) - row_chrome(num_w)).max(1)
}

/// Unified floor. A pair that is one polarity becomes one blue row. Auto
/// then splits a pair that still has both polarities when both sides fit
/// the half pane. A leftover line stays a full row.
fn project_ladder(
    lines: &[Painted],
    width: i64,
    num_w: usize,
    key: &str,
    hl: &Hl<'_>,
    split_rung: bool,
    lang: &str,
    path: &str,
) -> Vec<Node> {
    let budget = usize::try_from(split_content_width(width, num_w)).unwrap_or(usize::MAX);
    let mut rows = Vec::new();
    let mut index = 0usize;
    let mut seq = 0usize;
    while index < lines.len() {
        match &lines[index] {
            Painted::Elided(count) => {
                rows.push(elide_row(*count, &format!("{key}:f{seq}"), width));
                seq += 1;
                index += 1;
            }
            Painted::Line(line) if line.kind == LineKind::Ctx || line.kind == LineKind::Blank => {
                rows.push(make_row(
                    line,
                    &format!("{key}:r{seq}"),
                    width,
                    num_w,
                    hl.runs(line),
                ));
                seq += 1;
                index += 1;
            }
            Painted::Line(_) => {
                let start = index;
                index += 1;
                while index < lines.len() {
                    match &lines[index] {
                        Painted::Line(line)
                            if line.kind == LineKind::Del || line.kind == LineKind::Add =>
                        {
                            index += 1;
                        }
                        _ => break,
                    }
                }
                seq = emit_change(
                    &lines[start..index],
                    &mut rows,
                    width,
                    num_w,
                    key,
                    hl,
                    split_rung,
                    budget,
                    lang,
                    path,
                    seq,
                );
            }
        }
    }
    rows
}

fn emit_change(
    block: &[Painted],
    rows: &mut Vec<Node>,
    width: i64,
    num_w: usize,
    key: &str,
    hl: &Hl<'_>,
    split_rung: bool,
    budget: usize,
    lang: &str,
    path: &str,
    mut seq: usize,
) -> usize {
    let mut dels: Vec<&RawLine> = Vec::new();
    let mut adds: Vec<&RawLine> = Vec::new();
    for line in block {
        let Painted::Line(line) = line else {
            continue;
        };
        match line.kind {
            LineKind::Del => dels.push(line),
            LineKind::Add => adds.push(line),
            LineKind::Ctx | LineKind::Blank | LineKind::Mod => {}
        }
    }
    let permute = same_multiset(&dels, &adds);
    let paired = dels.len().min(adds.len());
    for slot in 0..paired {
        let old = dels[slot];
        let new = adds[slot];
        if !permute {
            if let Some(edit) = syntax_diff::inline_edit(&old.text, &new.text, lang, path) {
                let painted = inline_line(old, new, &edit);
                rows.push(make_row(
                    &painted,
                    &format!("{key}:r{seq}"),
                    width,
                    num_w,
                    hl.runs(&painted),
                ));
                seq += 1;
                continue;
            }
        }
        if split_rung
            && display_width(&old.text) <= budget
            && display_width(&new.text) <= budget
        {
            let half = split_half_width(width);
            let left = make_row(old, &format!("{key}:L{seq}"), half, num_w, hl.runs(old));
            let right = make_row(new, &format!("{key}:R{seq}"), half, num_w, hl.runs(new));
            rows.push(pair_row(left, right, width, &format!("{key}:p{seq}")));
            seq += 1;
        } else {
            rows.push(make_row(
                old,
                &format!("{key}:r{seq}"),
                width,
                num_w,
                hl.runs(old),
            ));
            seq += 1;
            rows.push(make_row(
                new,
                &format!("{key}:r{seq}"),
                width,
                num_w,
                hl.runs(new),
            ));
            seq += 1;
        }
    }
    for line in dels.iter().skip(paired) {
        rows.push(make_row(
            line,
            &format!("{key}:r{seq}"),
            width,
            num_w,
            hl.runs(line),
        ));
        seq += 1;
    }
    for line in adds.iter().skip(paired) {
        rows.push(make_row(
            line,
            &format!("{key}:r{seq}"),
            width,
            num_w,
            hl.runs(line),
        ));
        seq += 1;
    }
    seq
}

fn same_multiset(dels: &[&RawLine], adds: &[&RawLine]) -> bool {
    if dels.is_empty() || dels.len() != adds.len() {
        return false;
    }
    let mut left: Vec<&str> = dels.iter().map(|line| line.text.as_str()).collect();
    let mut right: Vec<&str> = adds.iter().map(|line| line.text.as_str()).collect();
    left.sort_unstable();
    right.sort_unstable();
    left == right
}

fn inline_line(old: &RawLine, new: &RawLine, edit: &syntax_diff::InlineEdit) -> RawLine {
    let text = if edit.paint_old {
        old.text.clone()
    } else {
        new.text.clone()
    };
    let tone = if edit.paint_old {
        SpanTone::GhostDel
    } else {
        SpanTone::Added
    };
    RawLine {
        kind: LineKind::Mod,
        text: text.clone(),
        old_no: old.old_no,
        new_no: new.new_no,
        spans: spans_from_marks(&text, &edit.marks, tone),
        inline_old: edit.paint_old,
    }
}

fn spans_from_marks(text: &str, marks: &[std::ops::Range<usize>], tone: SpanTone) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut cursor = 0usize;
    for mark in marks {
        let start = mark.start.min(text.len());
        let end = mark.end.min(text.len());
        if start < cursor || start > end {
            continue;
        }
        if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
            continue;
        }
        if cursor < start {
            spans.push(Span {
                text: text[cursor..start].to_string(),
                tone: SpanTone::Plain,
            });
        }
        if start < end {
            spans.push(Span {
                text: text[start..end].to_string(),
                tone,
            });
        }
        cursor = end;
    }
    if cursor < text.len() {
        spans.push(Span {
            text: text[cursor..].to_string(),
            tone: SpanTone::Plain,
        });
    }
    if spans.is_empty() {
        spans.push(Span {
            text: text.to_string(),
            tone: SpanTone::Plain,
        });
    }
    spans
}

fn project_split(lines: &[Painted], width: i64, num_w: usize, key: &str, hl: &Hl<'_>) -> Vec<Node> {
    let half = split_half_width(width);
    let mut rows = Vec::new();
    let mut index = 0;
    let mut seq = 0usize;
    while index < lines.len() {
        match &lines[index] {
            Painted::Elided(count) => {
                rows.push(elide_row(*count, &format!("{key}:f{seq}"), width));
                seq += 1;
                index += 1;
            }
            Painted::Line(line) if line.kind == LineKind::Ctx => {
                let runs = hl.runs(line);
                let left = make_row(line, &format!("{key}:L{seq}"), half, num_w, runs);
                let right_line = RawLine {
                    kind: LineKind::Ctx,
                    text: line.text.clone(),
                    old_no: line.new_no,
                    new_no: line.new_no,
                    spans: line.spans.clone(),
                    inline_old: false,
                };
                let right = make_row(&right_line, &format!("{key}:R{seq}"), half, num_w, runs);
                rows.push(pair_row(left, right, width, &format!("{key}:p{seq}")));
                seq += 1;
                index += 1;
            }
            Painted::Line(_) => {
                let start = index;
                index += 1;
                while index < lines.len() {
                    match &lines[index] {
                        Painted::Line(line)
                            if line.kind == LineKind::Del || line.kind == LineKind::Add =>
                        {
                            index += 1;
                        }
                        _ => break,
                    }
                }
                let run = &lines[start..index];
                let dels: Vec<&RawLine> = run
                    .iter()
                    .filter_map(|line| match line {
                        Painted::Line(line) if line.kind == LineKind::Del => Some(line),
                        _ => None,
                    })
                    .collect();
                let adds: Vec<&RawLine> = run
                    .iter()
                    .filter_map(|line| match line {
                        Painted::Line(line) if line.kind == LineKind::Add => Some(line),
                        _ => None,
                    })
                    .collect();
                let count = dels.len().max(adds.len());
                for slot in 0..count {
                    let left = if let Some(line) = dels.get(slot) {
                        make_row(line, &format!("{key}:L{seq}"), half, num_w, hl.runs(line))
                    } else {
                        blank_row(&format!("{key}:L{seq}"), half, num_w)
                    };
                    let right = if let Some(line) = adds.get(slot) {
                        make_row(line, &format!("{key}:R{seq}"), half, num_w, hl.runs(line))
                    } else {
                        blank_row(&format!("{key}:R{seq}"), half, num_w)
                    };
                    rows.push(pair_row(left, right, width, &format!("{key}:p{seq}")));
                    seq += 1;
                }
            }
        }
    }
    rows
}

fn pair_row(left: Node, right: Node, width: i64, key: &str) -> Node {
    flex_node(
        key.to_string(),
        FlexStyle {
            direction: FlexDirection::Row,
            gap: 1,
            width: Some(Length::Cells(width)),
            ..FlexStyle::default()
        },
        vec![left, right],
    )
}

fn blank_row(key: &str, width: i64, num_w: usize) -> Node {
    make_row(
        &RawLine {
            kind: LineKind::Blank,
            text: " ".to_string(),
            old_no: None,
            new_no: None,
            spans: vec![Span {
                text: " ".to_string(),
                tone: SpanTone::Plain,
            }],
            inline_old: false,
        },
        key,
        width,
        num_w,
        None,
    )
}

fn make_row(
    line: &RawLine,
    key: &str,
    row_w: i64,
    num_w: usize,
    runs: Option<&[TokenRun]>,
) -> Node {
    let wash = match line.kind {
        LineKind::Add => Some(row_wash("diff_add")),
        LineKind::Del => Some(row_wash("diff_del")),
        LineKind::Mod => Some(row_wash("diff_mod")),
        LineKind::Ctx | LineKind::Blank => None,
    };
    let gutter_style = match line.kind {
        LineKind::Add => role_wash("diff_add"),
        LineKind::Del => role_wash("diff_del"),
        LineKind::Mod => role_wash("diff_mod"),
        LineKind::Ctx | LineKind::Blank => chrome_style(),
    };
    let number_style = chrome_over(wash.as_ref());
    let code_style = match line.kind {
        LineKind::Add => role_wash("diff_add"),
        LineKind::Del => role_wash("diff_del"),
        LineKind::Mod => {
            let mut style = row_wash("diff_mod");
            style.role = Some("foreground".to_string());
            style.prominence = Some(FgP::PRIMARY);
            style
        }
        LineKind::Ctx => {
            let mut style = Style::default();
            style.role = Some("foreground".to_string());
            style.prominence = Some(FgP::SECONDARY);
            style
        }
        LineKind::Blank => chrome_style(),
    };
    let gutter_char = match line.kind {
        LineKind::Add | LineKind::Del | LineKind::Mod => GUTTER,
        LineKind::Ctx | LineKind::Blank => " ",
    };
    let number = match line.kind {
        LineKind::Del => line.old_no,
        LineKind::Add => line.new_no,
        LineKind::Mod | LineKind::Ctx => line.old_no.or(line.new_no),
        LineKind::Blank => None,
    };
    let num_text = format!("{} ", pad_num(number, num_w));
    let content_w = (row_w - row_chrome(num_w)).max(1);
    let visual = visual_lines(&line.text, content_w);
    let mut children = Vec::with_capacity(visual.len());
    for (index, text) in visual.iter().enumerate() {
        let gutter = if index == 0 {
            gutter_char.to_string()
        } else {
            " ".to_string()
        };
        let nums = if index == 0 {
            num_text.clone()
        } else {
            " ".repeat(num_text.len())
        };
        let row_children = vec![
            leaf(
                format!("{key}:g{index}"),
                gutter,
                gutter_style.clone(),
                Some(WhiteSpace::Nowrap),
            ),
            leaf(
                format!("{key}:n{index}"),
                nums,
                number_style.clone(),
                Some(WhiteSpace::Nowrap),
            ),
            if visual.len() == 1 && line.spans.iter().any(|span| span.tone != SpanTone::Plain) {
                emphasized_line(
                    format!("{key}:t{index}"),
                    &line.spans,
                    runs,
                    code_style.clone(),
                )
            } else if visual.len() == 1 {
                runs_node(format!("{key}:t{index}"), text, runs, code_style.clone())
            } else {
                leaf(
                    format!("{key}:t{index}"),
                    text.clone(),
                    code_style.clone(),
                    Some(WhiteSpace::PreWrap),
                )
            },
        ];
        children.push(flex_node(
            format!("{key}:row{index}"),
            row_style(Some(row_w)),
            row_children,
        ));
    }
    let mut style = BoxStyle::default();
    style.width = Some(Length::Cells(row_w));
    style.overflow = Some(Overflow::Hidden);
    style.background = Some(wash.unwrap_or_else(transparent_style));
    box_node(key.to_string(), style, children)
}

fn visual_lines(text: &str, width: i64) -> Vec<String> {
    let mut opts = WrapOpts::new(width);
    opts.white_space = WhiteSpace::PreWrap;
    let lines = wrap_text(text, &opts);
    if lines.is_empty() {
        return vec![" ".to_string()];
    }
    lines
        .into_iter()
        .map(|line| {
            if line.is_empty() {
                " ".to_string()
            } else {
                line
            }
        })
        .collect()
}

fn pad_num(number: Option<i64>, width: usize) -> String {
    match number {
        Some(number) if number > 0 => format!("{number:>width$}"),
        _ => " ".repeat(width),
    }
}

fn elide_row(count: usize, key: &str, row_w: i64) -> Node {
    let mut style = BoxStyle::default();
    style.width = Some(Length::Cells(row_w));
    style.height = Some(Length::Cells(1));
    style.background = Some(transparent_style());
    box_node(
        key.to_string(),
        style,
        vec![leaf(
            format!("{key}:c"),
            format!("{MIDDOT}{MIDDOT} {count} unchanged {MIDDOT}{MIDDOT}"),
            chrome_style(),
            Some(WhiteSpace::Nowrap),
        )],
    )
}

fn row_wash(role: &str) -> Style {
    let mut style = Style::default();
    style.bg_role = Some(role.to_string());
    style.bg_prominence = Some(BgP::MIST);
    style
}

fn role_wash(role: &str) -> Style {
    let mut style = row_wash(role);
    style.role = Some(role.to_string());
    style
}

fn chrome_style() -> Style {
    let mut style = Style::default();
    style.role = Some("chrome".to_string());
    style.prominence = Some(FgP::GHOST);
    style
}

fn chrome_over(wash: Option<&Style>) -> Style {
    let mut style = chrome_style();
    if let Some(wash) = wash {
        style.bg_role.clone_from(&wash.bg_role);
        style.bg_prominence = wash.bg_prominence;
    }
    style
}

fn header_style() -> Style {
    let mut style = Style::default();
    style.role = Some("chrome".to_string());
    style.bold = true;
    style
}

fn transparent_style() -> Style {
    let mut style = Style::default();
    style.cast_transparent = true;
    style
}

fn diff_root(key: &str, path: &str, hide_header: bool, body: Node) -> Node {
    let mut children = Vec::new();
    if !hide_header {
        children.push(leaf(
            format!("{key}:hdr"),
            format!("{path} {MIDDOT} proposed"),
            header_style(),
            Some(WhiteSpace::Nowrap),
        ));
    }
    children.push(body);
    Node::IndentationException {
        kind: IndentKind::Diff,
        children,
        key: Some(key.to_string()),
        measured: None,
        region_prominence: None,
    }
}

fn empty_diff(key: &str, path: &str, hide_header: bool) -> Node {
    let empty = leaf(
        format!("{key}:empty"),
        "(empty)".to_string(),
        chrome_style(),
        None,
    );
    let mut children = Vec::new();
    if !hide_header {
        children.push(leaf(
            format!("{key}:hdr"),
            format!("{path} {MIDDOT} proposed"),
            header_style(),
            Some(WhiteSpace::Nowrap),
        ));
    }
    children.push(empty);
    Node::IndentationException {
        kind: IndentKind::Diff,
        children,
        key: Some(key.to_string()),
        measured: None,
        region_prominence: None,
    }
}

fn no_changes_diff(key: &str, path: &str, width: i64, hide_header: bool) -> Node {
    let body = flex_node(
        format!("{key}:body"),
        column_style(width),
        vec![leaf(
            format!("{key}:empty"),
            "no changes".to_string(),
            chrome_style(),
            None,
        )],
    );
    diff_root(key, path, hide_header, body)
}
