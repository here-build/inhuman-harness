//! Chrome-frame geometry, edge paint, and the selection coverage mask.
//!
//! This is not the layout walk. [`crate::layout_engine::Node::Chrome`] measures
//! and paints through this module. [`crate::layout_engine::Node::Skipped`] stays
//! the raw hole.
//!
//! `outer_w` is at least 8. `text_w` is `outer_w - 4` (│, mark, gap, │), at
//! least 1. `total_h` is body rows plus 2 chrome rows, or plus 1 when
//! `omit_top`. A non-finite progress budget or ratio contributes no cells.
//! `body_hit` is the text column, not the border.
//! The coverage mask is topmost-first. `userSelect: none` in `by_key` stamps
//! chrome over ancestors; a leaf (`contain`, `all`, or `text` with
//! `element_kind == "text"`) is restored on top.
//!
//! Offsets and ellipsis cuts are Unicode scalars. That matches JavaScript
//! `length` / `slice` on BMP text (every chrome oracle string). A lone UTF-16
//! surrogate is not representable here. Wrap is [`crate::layout_text::wrap_text`]
//! in `pre-wrap`. Column measure is [`crate::measure::display_width`] (⏎ is 2).
//! Prominence numbers are [`crate::theme::FgP`].
//!
//! Float-to-cell conversions go through [`floor_cell`]: non-finite input is 0,
//! and the floor is clamped to `i64`.

use crate::layout_text::{wrap_text, WhiteSpace, WrapOpts};
use crate::measure::display_width;
use crate::theme::{FgP, Role};
use crate::{Rgb, Style};

/// Top + bottom chrome rows when the top rule is not omitted.
pub const CHROME_FRAME_CHROME_ROWS: i64 = 2;
/// Mark cell when the frame does not set a glyph. Picker rows pass `›`.
pub const CHROME_FRAME_DEFAULT_GLYPH: &str = " ";
/// │ + mark + gap + │. Subtracted from `outer_w` to get the draft column.
pub const CHROME_FRAME_BODY_CHROME: i64 = 4;
/// Default progress hue. Chroma is the warning tint, not this role.
pub const CHROME_FRAME_DEFAULT_PROGRESS_ROLE: &str = "foreground";
/// Remaining fraction where the fill starts mixing warning.
pub const CHROME_FRAME_DEFAULT_PROGRESS_GLOW_AT: f64 = 0.75;
/// Hot hue mixed in below [`CHROME_FRAME_DEFAULT_PROGRESS_GLOW_AT`].
pub const CHROME_FRAME_PROGRESS_GLOW_ROLE: &str = "warning";

/// Rounded corners. Light arcs, not `┌┐└┘`.
pub struct ChromeFrameCorners {
    pub tl: &'static str,
    pub tr: &'static str,
    pub bl: &'static str,
    pub br: &'static str,
}

pub const CHROME_FRAME_CORNERS: ChromeFrameCorners = ChromeFrameCorners {
    tl: "╭",
    tr: "╮",
    bl: "╰",
    br: "╯",
};

/// T-junctions when two frames stack.
pub struct ChromeFrameJoin {
    pub left: &'static str,
    pub right: &'static str,
}

pub const CHROME_FRAME_JOIN: ChromeFrameJoin = ChromeFrameJoin {
    left: "├",
    right: "┤",
};

/// Occupied right rails append this before the corner, so the ink is ` ─╮` / ` ─╯`.
const RIGHT_SLOT_PAD: &str = " ─";
const ELLIPSIS: &str = "…";

/// Cell rect. Half-open on the right and bottom when a mask indexes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

impl Rect {
    pub fn new(x: i64, y: i64, w: i64, h: i64) -> Self {
        Self { x, y, w, h }
    }
}

/// One binding. Paint rewrites `Enter` / `Ctrl` / `Cmd`; storage does not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChromeHotkey {
    pub key: String,
    pub action: String,
}

impl ChromeHotkey {
    pub fn new(key: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            action: action.into(),
        }
    }
}

/// Composer status chip. A bare string is furniture. A signal carries a role.
#[derive(Clone, Debug, PartialEq)]
pub enum ChromeStatusItem {
    Furniture(String),
    Signal {
        text: String,
        role: Option<String>,
        prominence: Option<f64>,
    },
}

impl ChromeStatusItem {
    pub fn furniture(text: impl Into<String>) -> Self {
        Self::Furniture(text.into())
    }

    pub fn signal(text: impl Into<String>, role: impl Into<String>) -> Self {
        Self::Signal {
            text: text.into(),
            role: Some(role.into()),
            prominence: None,
        }
    }
}

/// Cmd/Ctrl quota window. `reset_at` is Unix seconds. `None` paints the percent only.
#[derive(Clone, Debug, PartialEq)]
pub struct ChromeQuotaWindow {
    pub remaining_percent: f64,
    pub reset_at: Option<f64>,
}

/// Quota live decoration carried on a status segment. Hz is the present rate.
#[derive(Clone, Debug, PartialEq)]
pub enum ChromeLive {
    Quota {
        windows: Vec<ChromeQuotaWindow>,
        /// Occupancy prefix (`10k/500k`). `None` when the prefix is empty.
        prefix: Option<String>,
        hz: i64,
    },
}

/// One painted run. `live` replaces a text op in [`segs_to_paint_ops`].
#[derive(Clone, Debug, PartialEq)]
pub struct ChromeSeg {
    pub text: String,
    pub style: Style,
    pub live: Option<ChromeLive>,
}

impl ChromeSeg {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style: Style::default(),
            live: None,
        }
    }

    fn new(text: impl Into<String>, style: Style) -> Self {
        Self {
            text: text.into(),
            style,
            live: None,
        }
    }
}

/// Author-supplied segment before it becomes a [`ChromeSeg`]. Omitted flags stay off.
#[derive(Clone, Debug, PartialEq)]
pub struct ChromeSegSpec {
    pub text: String,
    pub role: Option<String>,
    pub prominence: Option<f64>,
    pub bold: Option<bool>,
    pub dim: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub href: Option<String>,
    pub fg_rgb: Option<Rgb>,
}

impl ChromeSegSpec {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            role: None,
            prominence: None,
            bold: None,
            dim: None,
            italic: None,
            underline: None,
            href: None,
            fg_rgb: None,
        }
    }
}

/// Measure result. `body_lines` stay the unclipped wrap; paint may show fewer rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChromeFrameGeom {
    pub outer_w: i64,
    pub text_w: i64,
    pub body_lines: Vec<String>,
    pub body_h: i64,
    pub total_h: i64,
    pub glyph: String,
}

/// One visual body line and its scalar offset into the draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BodyLine {
    pub text: String,
    pub start: i64,
}

/// Active-run cells, the partial leading cell, and the unfilled contour.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProgressFillSegments {
    pub full: i64,
    pub frac: f64,
    pub rest: i64,
    pub total: i64,
}

/// Top-rule options. Empty `hotkeys` and empty `annotation` are an absent hint.
#[derive(Clone, Debug, Default)]
pub struct ChromeTopOpts {
    pub join: bool,
    pub bottom: bool,
    pub annotation: Option<String>,
    pub annotation_role: Option<String>,
    pub annotation_segs: Vec<ChromeSeg>,
    pub contour_role: Option<String>,
    pub contour_prominence: Option<f64>,
    pub mod_held: bool,
}

/// Bottom-rule options. `progress: None` is an omitted rail, not a zero fill.
#[derive(Clone, Debug, Default)]
pub struct ChromeBottomOpts {
    pub progress: Option<f64>,
    pub progress_role: Option<String>,
    pub progress_glow_at: Option<f64>,
    pub status_items: Vec<ChromeStatusItem>,
    pub quota_windows: Vec<ChromeQuotaWindow>,
    pub context_used: Option<f64>,
    pub context_limit: Option<f64>,
    pub mod_held: bool,
    /// `None` reads the wall clock, matching `Date.now()` when paint omits `nowMs`.
    pub now_ms: Option<f64>,
    pub join: bool,
    pub plain: bool,
    pub contour_role: Option<String>,
    pub contour_prominence: Option<f64>,
}

/// Draft body-row options. `line_start` is the scalar offset of `line` in the draft.
#[derive(Clone, Debug, Default)]
pub struct ChromeBodyRowOpts {
    pub placeholder: bool,
    pub line_start: Option<i64>,
    pub sel_a: Option<i64>,
    pub sel_b: Option<i64>,
    pub draft_length: Option<i64>,
    pub right_coverage: Option<f64>,
    pub contour_role: Option<String>,
    pub contour_prominence: Option<f64>,
}

/// Content-seg body row. `glyph` is this row's mark cell (`›`, a counter, or space).
#[derive(Clone, Debug, Default)]
pub struct ChromeBodyContentOpts {
    pub glyph: Option<String>,
    pub right_coverage: Option<f64>,
    pub contour_role: Option<String>,
    pub contour_prominence: Option<f64>,
}

/// One chrome frame. Defaults match an omitted TypeScript field, not a zero fill.
#[derive(Clone, Debug, Default)]
pub struct ChromeFrame {
    /// `0` selects `max_w` (`Math.floor(width) || maxW` on the TypeScript frame).
    pub width: i64,
    pub draft: String,
    pub cursor: Option<i64>,
    pub mark: Option<i64>,
    pub placeholder: Option<String>,
    pub placeholder_mode: bool,
    pub hotkeys: Vec<ChromeHotkey>,
    pub hotkeys_bottom: bool,
    pub mod_held: bool,
    pub top_segs: Vec<ChromeSegSpec>,
    pub body_seg_rows: Vec<Vec<ChromeSegSpec>>,
    pub body_glyphs: Vec<Option<String>>,
    pub speculative_draft: Option<String>,
    pub completion: Option<String>,
    pub annotation: Option<String>,
    pub annotation_role: Option<String>,
    pub join_annotation: Option<String>,
    pub join_annotation_role: Option<String>,
    pub status_items: Vec<ChromeStatusItem>,
    pub quota_windows: Vec<ChromeQuotaWindow>,
    pub context_used: Option<f64>,
    pub context_limit: Option<f64>,
    pub contour_role: Option<String>,
    pub selected: bool,
    pub progress: Option<f64>,
    pub progress_role: Option<String>,
    pub progress_glow_at: Option<f64>,
    pub glyph: Option<String>,
    /// `None` is omitted. Only `Some(false)` whispers the draft.
    pub interactive: Option<bool>,
    pub read_only: bool,
    pub join_bottom: bool,
    pub join_top: bool,
    pub omit_top: bool,
    pub plain_bottom: bool,
    pub body_right_coverage: Vec<Option<f64>>,
}

impl ChromeFrame {
    pub fn new(width: i64, draft: impl Into<String>) -> Self {
        Self {
            width,
            draft: draft.into(),
            ..Self::default()
        }
    }
}

/// User recap pin. The draft is the speech text. Annotation and hotkeys ride this frame.
pub fn speech_recap_frame(
    width: i64,
    draft: impl Into<String>,
    annotation: &str,
    hotkeys: Vec<ChromeHotkey>,
) -> ChromeFrame {
    let mut frame = ChromeFrame::new(width.max(8), draft);
    frame.interactive = Some(false);
    frame.read_only = true;
    frame.plain_bottom = true;
    frame.selected = true;
    if !annotation.is_empty() {
        frame.annotation = Some(annotation.to_string());
    }
    frame.hotkeys = hotkeys;
    frame
}

/// Paint op at a fixed cell rect. Quota segments are [`ChromePaintOp::Live`].
#[derive(Clone, Debug, PartialEq)]
pub enum ChromePaintOp {
    Text {
        rect: Rect,
        lines: Vec<String>,
        style: Style,
    },
    Live {
        rect: Rect,
        style: Style,
        live: ChromeLive,
    },
}

/// [`chrome_frame_paint_ops`] result. `body_hit` is the text column, not the border.
#[derive(Clone, Debug, PartialEq)]
pub struct ChromePaint {
    pub ops: Vec<ChromePaintOp>,
    pub body_hit: Rect,
    pub progress_hit: Rect,
    pub geom: ChromeFrameGeom,
}

/// `userSelect` for the coverage mask. [`UserSelect::Auto`] is not selectable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserSelect {
    None,
    Text,
    All,
    Contain,
    Auto,
}

/// One hit the mask can see. `element_kind` is `element.kind` (`"text"` is a leaf).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskHit {
    pub key: String,
    pub hit_rect: Rect,
    pub user_select: UserSelect,
    pub phantom: bool,
    pub element_kind: Option<String>,
}

/// `hit_list` is topmost-first. `by_key` includes chrome that never entered the hit list.
#[derive(Clone, Debug, Default)]
pub struct MaskFrame {
    pub hit_list: Vec<MaskHit>,
    pub by_key: Vec<MaskHit>,
}

const UNCLAIMED: u8 = 0;
const CHROME: u8 = 1;
const SELECTABLE: u8 = 2;
const OPAQUE: u8 = 3;

/// Per-cell coverage. Out-of-rect queries are unclaimed.
#[derive(Clone, Debug)]
pub struct CoverageMask {
    origin_x: i64,
    origin_y: i64,
    cols: i64,
    rows: i64,
    state: Vec<u8>,
    keys: Vec<String>,
}

impl CoverageMask {
    pub fn is_chrome(&self, col: i64, row: i64) -> bool {
        self.kind_at(col, row) == Some(CHROME)
    }

    pub fn is_selectable(&self, col: i64, row: i64) -> bool {
        self.kind_at(col, row) == Some(SELECTABLE)
    }

    /// Topmost selectable key, or `""` when the cell is not selectable.
    pub fn selectable_key(&self, col: i64, row: i64) -> &str {
        match self.index(col, row).and_then(|i| self.keys.get(i)) {
            Some(key) => key.as_str(),
            None => "",
        }
    }

    fn kind_at(&self, col: i64, row: i64) -> Option<u8> {
        self.index(col, row)
            .and_then(|i| self.state.get(i).copied())
    }

    fn index(&self, col: i64, row: i64) -> Option<usize> {
        if self.cols <= 0 || self.rows <= 0 {
            return None;
        }
        if col < self.origin_x || row < self.origin_y {
            return None;
        }
        let dx = col - self.origin_x;
        let dy = row - self.origin_y;
        if dx >= self.cols || dy >= self.rows {
            return None;
        }
        (dy as usize)
            .checked_mul(self.cols as usize)?
            .checked_add(dx as usize)
    }
}

/// Empty mask. Every cell is unclaimed.
pub fn no_chrome() -> CoverageMask {
    CoverageMask {
        origin_x: 0,
        origin_y: 0,
        cols: 0,
        rows: 0,
        state: Vec::new(),
        keys: Vec::new(),
    }
}

/// Floor a finite float into `i64`. Non-finite input is 0. The floor is clamped to `i64`.
fn floor_cell(n: f64) -> i64 {
    if !n.is_finite() {
        return 0;
    }
    let f = n.floor();
    if f >= i64::MAX as f64 {
        i64::MAX
    } else if f <= i64::MIN as f64 {
        i64::MIN
    } else {
        f as i64
    }
}

/// `Math.round` for a non-negative finite float. Anything else is 0.
fn round_nonneg(n: f64) -> i64 {
    if !n.is_finite() || n <= 0.0 {
        return 0;
    }
    let shifted = n + 0.5;
    if !shifted.is_finite() {
        return i64::MAX;
    }
    floor_cell(shifted).max(0)
}

fn cell_as_f64(n: i64) -> f64 {
    if n <= 0 {
        return 0.0;
    }
    const EXACT: i64 = 1 << 53;
    if n > EXACT {
        EXACT as f64
    } else {
        n as f64
    }
}

/// Non-finite maps to 0, then clamp to `[0, 1]`. Matches chrome `clamp01`, not the theme clamp.
fn clamp01(n: f64) -> f64 {
    if !n.is_finite() {
        0.0
    } else {
        n.clamp(0.0, 1.0)
    }
}

fn measure_cols(text: &str) -> i64 {
    i64::try_from(display_width(text)).unwrap_or(i64::MAX)
}

fn unit_len(text: &str) -> i64 {
    i64::try_from(text.chars().count()).unwrap_or(i64::MAX)
}

fn pop_owned(text: &str) -> String {
    match text.char_indices().next_back() {
        Some((i, _)) => text[..i].to_string(),
        None => String::new(),
    }
}

fn shift_owned(text: &str) -> String {
    match text.chars().next() {
        Some(ch) => text[ch.len_utf8()..].to_string(),
        None => String::new(),
    }
}

fn repeat_unit(unit: &str, n: i64) -> String {
    if n <= 0 || unit.is_empty() {
        return String::new();
    }
    let Ok(count) = usize::try_from(n) else {
        return String::new();
    };
    if unit.len().checked_mul(count).is_none() {
        return String::new();
    }
    unit.repeat(count)
}

fn fg_style(role: &str, prominence: f64, bold: bool) -> Style {
    Style {
        role: Some(role.to_string()),
        prominence: Some(prominence),
        bold,
        ..Style::default()
    }
}

fn default_contour() -> Style {
    fg_style("foreground", FgP::GHOST, false)
}

fn box_contour(role: Option<&str>, prominence: f64) -> Style {
    let role = match role {
        Some(role) if !role.is_empty() => role,
        _ => "foreground",
    };
    fg_style(role, prominence, false)
}

fn prominence_of(prominence: Option<f64>) -> f64 {
    prominence.unwrap_or(FgP::GHOST)
}

fn shortcut_key() -> Style {
    fg_style("foreground", FgP::PRIMARY, false)
}

fn shortcut_action() -> Style {
    fg_style("foreground", FgP::GHOST, false)
}

fn body_style() -> Style {
    fg_style("foreground", FgP::PRIMARY, false)
}

fn placeholder_style() -> Style {
    fg_style("muted", FgP::GHOST, false)
}

fn glyph_style() -> Style {
    fg_style("foreground", FgP::PRIMARY, true)
}

fn counter_style() -> Style {
    fg_style("muted", FgP::GHOST, false)
}

fn mark_cell_style(mark: &str) -> Style {
    if mark == "›" {
        glyph_style()
    } else {
        counter_style()
    }
}

/// `fgProgress`: non-finite `t` is 0, then lerp. Not a branded step.
fn fg_progress(from: f64, to: f64, t: f64) -> f64 {
    let t = clamp01(t);
    from + (to - from) * t
}

fn wrap_pre(text: &str, width: i64) -> Vec<String> {
    wrap_text(
        text,
        &WrapOpts {
            width,
            white_space: WhiteSpace::PreWrap,
            ellipsis: None,
            line_clamp: None,
            measure: None,
        },
    )
}

fn hotkey_token(part: &str) -> String {
    match part.to_ascii_lowercase().as_str() {
        "enter" | "return" => "⏎".to_string(),
        "shift" => "⇧".to_string(),
        "cmd" | "command" | "meta" | "super" => "⌘".to_string(),
        "ctrl" | "control" => "⌃".to_string(),
        "tab" => "⇥".to_string(),
        "escape" | "esc" => "Esc".to_string(),
        _ => part.to_string(),
    }
}

fn replace_hotkey_tokens(chord: &str) -> String {
    let chars: Vec<char> = chord.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i].is_ascii_alphanumeric() {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            out.push_str(&hotkey_token(&word));
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn replace_c_dash(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let boundary = i == 0 || chars[i - 1] == '+';
        if boundary
            && i + 1 < chars.len()
            && chars[i].eq_ignore_ascii_case(&'C')
            && chars[i + 1] == '-'
        {
            out.push('⌃');
            out.push('-');
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn paint_hotkey_chord(chord: &str) -> String {
    let painted = replace_hotkey_tokens(chord);
    replace_c_dash(&painted)
        .replace('+', " ")
        .replace("⌃-", "⌃")
}

/// Parsed chord. The four flags are present, not omitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChordMods {
    pub key: String,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
    pub shift: bool,
}

pub fn format_hotkey(hotkey: &ChromeHotkey) -> String {
    let key = hotkey.key.trim();
    let action = hotkey.action.trim();
    if key.is_empty() {
        return String::new();
    }
    if action.is_empty() {
        key.to_string()
    } else {
        format!("{key}: {action}")
    }
}

fn normalize_key_name(part: &str) -> String {
    let lower = part.to_ascii_lowercase();
    match lower.as_str() {
        "esc" | "escape" => "Escape".to_string(),
        "enter" | "return" => "Enter".to_string(),
        "tab" => "Tab".to_string(),
        "space" => " ".to_string(),
        _ if part.chars().count() == 1 => lower,
        _ => part.to_string(),
    }
}

/// Modifier-only tokens and an empty chord are `None`.
pub fn parse_chord(chord: &str) -> Option<ChordMods> {
    let raw = chord.trim();
    if raw.is_empty() {
        return None;
    }
    let mut body = raw.to_string();
    let mut ctrl = false;
    let mut alt = false;
    let mut meta = false;
    let mut shift = false;
    let lower = body.to_ascii_lowercase();
    let named = lower.starts_with("ctrl")
        || lower.starts_with("control")
        || lower.starts_with("cmd")
        || lower.starts_with("command");
    if !named && lower.starts_with("c-") {
        ctrl = true;
        body = body[2..].to_string();
    }
    let mut key = None;
    for part in body.split(|ch| ch == '+' || ch == '-').filter(|part| !part.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "cmd" | "command" | "meta" | "super" => meta = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            _ => key = Some(normalize_key_name(part)),
        }
    }
    Some(ChordMods {
        key: key?,
        ctrl,
        alt,
        meta,
        shift,
    })
}

pub fn event_matches_chord(event: &ChordMods, chord: &str) -> bool {
    let Some(parsed) = parse_chord(chord) else {
        return false;
    };
    event.key.eq_ignore_ascii_case(&parsed.key)
        && event.ctrl == parsed.ctrl
        && event.meta == parsed.meta
        && event.alt == parsed.alt
        && event.shift == parsed.shift
}

fn is_mod_chord(key: &str) -> bool {
    let key = key.trim().to_ascii_lowercase();
    if key.starts_with("c-") {
        return true;
    }
    for prefix in ["command", "cmd", "control", "ctrl", "super", "meta"] {
        if let Some(rest) = key.strip_prefix(prefix) {
            if rest.is_empty() || rest.starts_with('+') || rest.starts_with('-') {
                return true;
            }
        }
    }
    false
}

fn more_token(mods: &[ChromeHotkey]) -> String {
    let word = mods
        .first()
        .map(|hotkey| hotkey.key.trim().split(['+', '-']).next().unwrap_or(""))
        .unwrap_or("");
    match word.to_ascii_lowercase().as_str() {
        "cmd" | "command" | "meta" | "super" => "Cmd".to_string(),
        _ => "Ctrl".to_string(),
    }
}

pub fn reveal_hotkeys(hotkeys: &[ChromeHotkey], mod_held: bool) -> Vec<ChromeHotkey> {
    let mut defaults = Vec::new();
    let mut mods = Vec::new();
    for hotkey in hotkeys {
        if is_mod_chord(&hotkey.key) {
            mods.push(hotkey.clone());
        } else {
            defaults.push(hotkey.clone());
        }
    }
    if defaults.is_empty() || mods.is_empty() {
        return hotkeys.to_vec();
    }
    if mod_held {
        return mods;
    }
    defaults.push(ChromeHotkey::new(more_token(&mods), "More"));
    defaults
}

fn match_bold(rest: &str) -> Option<(usize, String)> {
    let body = rest.strip_prefix("**")?;
    let end = body.find("**")?;
    let inner = &body[..end];
    if inner.is_empty() || inner.contains('*') {
        return None;
    }
    Some((4 + end, inner.to_string()))
}

fn match_italic(rest: &str) -> Option<(usize, String)> {
    let body = rest.strip_prefix('*')?;
    if body.starts_with('*') {
        return None;
    }
    let end = body.find('*')?;
    let inner = &body[..end];
    if inner.is_empty() {
        return None;
    }
    Some((2 + end, inner.to_string()))
}

fn match_code(rest: &str) -> Option<(usize, String)> {
    let body = rest.strip_prefix('`')?;
    let end = body.find('`')?;
    let inner = &body[..end];
    if inner.is_empty() {
        return None;
    }
    Some((2 + end, inner.to_string()))
}

fn match_link(rest: &str) -> Option<(usize, String)> {
    let body = rest.strip_prefix('[')?;
    let close = body.find(']')?;
    let label = &body[..close];
    if label.is_empty() {
        return None;
    }
    let after = body.get(close + 1..)?;
    let paren = after.strip_prefix('(')?;
    let end = paren.find(')')?;
    if paren[..end].is_empty() {
        return None;
    }
    Some((close + 1 + 1 + end + 1 + 1, label.to_string()))
}

fn markdown_inline_segs(line: &str, base: &Style) -> Vec<ChromeSeg> {
    let mut segs = Vec::new();
    let mut last = 0usize;
    let mut i = 0usize;
    while i < line.len() {
        let Some(ch) = line[i..].chars().next() else {
            break;
        };
        let rest = &line[i..];
        let matched = if let Some((consumed, inner)) = match_bold(rest) {
            let mut style = base.clone();
            style.bold = true;
            Some((consumed, inner, style))
        } else if let Some((consumed, inner)) = match_italic(rest) {
            let mut style = base.clone();
            style.italic = true;
            Some((consumed, inner, style))
        } else if let Some((consumed, inner)) = match_code(rest) {
            let mut style = base.clone();
            style.role = Some("code".to_string());
            Some((consumed, inner, style))
        } else if let Some((consumed, inner)) = match_link(rest) {
            let mut style = base.clone();
            style.role = Some("accent".to_string());
            style.underline = true;
            Some((consumed, inner, style))
        } else {
            None
        };
        if let Some((consumed, text, style)) = matched {
            if i > last {
                segs.push(ChromeSeg::new(&line[last..i], base.clone()));
            }
            let end = i + consumed;
            segs.push(ChromeSeg::new(text, style));
            last = end;
            i = end;
        } else {
            i += ch.len_utf8();
        }
    }
    if last < line.len() {
        segs.push(ChromeSeg::new(&line[last..], base.clone()));
    }
    if segs.is_empty() {
        segs.push(ChromeSeg::new(line, base.clone()));
    }
    segs
}

fn ellipsize_to(text: &str, max_w: i64) -> String {
    if max_w <= 0 {
        return String::new();
    }
    if measure_cols(text) <= max_w {
        return text.to_string();
    }
    if max_w == 1 {
        return ELLIPSIS.to_string();
    }
    let mut head = text.to_string();
    while measure_cols(&format!("{head}{ELLIPSIS}")) > max_w && !head.is_empty() {
        head = pop_owned(&head);
    }
    if head.is_empty() {
        ELLIPSIS.to_string()
    } else {
        format!("{head}{ELLIPSIS}")
    }
}

fn ellipsize_affix_to(text: &str, max_w: i64) -> String {
    if max_w <= 0 {
        return String::new();
    }
    if measure_cols(text) <= max_w {
        return text.to_string();
    }
    if max_w == 1 {
        return ELLIPSIS.to_string();
    }
    let mut prefix = text.to_string();
    while measure_cols(&prefix) > 3 && !prefix.is_empty() {
        prefix = pop_owned(&prefix);
    }
    if prefix.is_empty() {
        let mut tail = text.to_string();
        while measure_cols(&format!("{ELLIPSIS}{tail}")) > max_w && !tail.is_empty() {
            tail = shift_owned(&tail);
        }
        return if tail.is_empty() {
            ELLIPSIS.to_string()
        } else {
            format!("{ELLIPSIS}{tail}")
        };
    }
    let head = format!("{prefix}{ELLIPSIS}");
    let head_w = measure_cols(&head);
    if head_w > max_w {
        let mut shrunk = prefix;
        while measure_cols(&format!("{shrunk}{ELLIPSIS}")) > max_w && !shrunk.is_empty() {
            shrunk = pop_owned(&shrunk);
        }
        return if shrunk.is_empty() {
            ELLIPSIS.to_string()
        } else {
            format!("{shrunk}{ELLIPSIS}")
        };
    }
    if head_w == max_w {
        return head;
    }
    let tail_budget = max_w - head_w;
    let mut tail = text.to_string();
    while measure_cols(&tail) > tail_budget && !tail.is_empty() {
        tail = shift_owned(&tail);
    }
    if unit_len(text) - unit_len(&tail) < unit_len(&prefix) {
        tail = text.chars().skip(prefix.chars().count()).collect();
        while measure_cols(&tail) > tail_budget && !tail.is_empty() {
            tail = shift_owned(&tail);
        }
    }
    if tail.is_empty() {
        head
    } else {
        format!("{head}{tail}")
    }
}

fn segs_width(segs: &[ChromeSeg]) -> i64 {
    segs.iter()
        .fold(0i64, |sum, seg| sum.saturating_add(measure_cols(&seg.text)))
}

fn trim_segs_to(segs: &[ChromeSeg], max_w: i64, affix: bool) -> Vec<ChromeSeg> {
    if max_w <= 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut used = 0i64;
    for seg in segs {
        let width = measure_cols(&seg.text);
        if used.saturating_add(width) <= max_w {
            out.push(seg.clone());
            used += width;
            continue;
        }
        let room = max_w - used;
        if room <= 0 {
            break;
        }
        let clipped = if affix {
            ellipsize_affix_to(&seg.text, room)
        } else {
            ellipsize_to(&seg.text, room)
        };
        if !clipped.is_empty() {
            out.push(ChromeSeg {
                text: clipped,
                style: seg.style.clone(),
                live: seg.live.clone(),
            });
        }
        break;
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HintKind {
    Key,
    Colon,
    Action,
    Sep,
}

struct HintPiece {
    text: String,
    style: Style,
    hint: HintKind,
}

fn hint_pieces(hotkeys: &[ChromeHotkey]) -> Vec<HintPiece> {
    let mut out = Vec::new();
    for hotkey in hotkeys {
        let key = hotkey.key.trim();
        if key.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(HintPiece {
                text: " · ".to_string(),
                style: default_contour(),
                hint: HintKind::Sep,
            });
        }
        let action = hotkey.action.trim();
        out.push(HintPiece {
            text: paint_hotkey_chord(key),
            style: shortcut_key(),
            hint: HintKind::Key,
        });
        if action.is_empty() {
            continue;
        }
        out.push(HintPiece {
            text: ": ".to_string(),
            style: shortcut_key(),
            hint: HintKind::Colon,
        });
        out.push(HintPiece {
            text: action.to_string(),
            style: shortcut_action(),
            hint: HintKind::Action,
        });
    }
    out
}

fn hint_width(pieces: &[HintPiece]) -> i64 {
    pieces.iter().fold(0i64, |sum, piece| {
        sum.saturating_add(measure_cols(&piece.text))
    })
}

fn emit_hint_pieces(pieces: &[HintPiece]) -> Vec<ChromeSeg> {
    pieces
        .iter()
        .map(|piece| ChromeSeg::new(piece.text.clone(), piece.style.clone()))
        .collect()
}

fn drop_trailing_hint_bindings(mut pieces: Vec<HintPiece>, max_w: i64) -> Vec<HintPiece> {
    while !pieces.is_empty() && hint_width(&pieces) > max_w {
        let cut = pieces.iter().rposition(|piece| piece.hint == HintKind::Sep);
        let Some(cut) = cut else {
            return Vec::new();
        };
        pieces.truncate(cut);
    }
    pieces
}

fn fit_hint_and_annotation(
    hotkeys: &[ChromeHotkey],
    right: &[ChromeSeg],
    budget: i64,
    affix: bool,
) -> (Vec<ChromeSeg>, Vec<ChromeSeg>) {
    let pieces = if hotkeys.is_empty() {
        Vec::new()
    } else {
        hint_pieces(hotkeys)
    };
    let right_want = segs_width(right);
    if pieces.is_empty() {
        let fitted = if right_want <= budget {
            right.to_vec()
        } else {
            trim_segs_to(right, budget, affix)
        };
        return (Vec::new(), fitted);
    }
    let left = emit_hint_pieces(&drop_trailing_hint_bindings(pieces, budget));
    let ann_w = (budget - segs_width(&left)).max(0);
    let fitted = if right_want <= ann_w {
        right.to_vec()
    } else {
        trim_segs_to(right, ann_w, affix)
    };
    (left, fitted)
}

fn style_from_spec(spec: &ChromeSegSpec) -> Style {
    Style {
        role: spec.role.clone(),
        prominence: spec.prominence,
        bold: spec.bold.unwrap_or(false),
        dim: spec.dim.unwrap_or(false),
        italic: spec.italic.unwrap_or(false),
        underline: spec.underline.unwrap_or(false),
        href: spec.href.clone(),
        fg_rgb: spec.fg_rgb,
        ..Style::default()
    }
}

fn spec_to_seg(spec: &ChromeSegSpec) -> ChromeSeg {
    ChromeSeg::new(spec.text.clone(), style_from_spec(spec))
}

fn chip_text(item: &ChromeStatusItem) -> String {
    match item {
        ChromeStatusItem::Furniture(text) | ChromeStatusItem::Signal { text, .. } => {
            text.trim().to_string()
        }
    }
}

fn normalize_status(items: &[ChromeStatusItem]) -> Vec<ChromeStatusItem> {
    items
        .iter()
        .filter(|item| !chip_text(item).is_empty())
        .cloned()
        .collect()
}

/// String chips use the default contour, not the frame's contour role.
fn status_chip_style(item: &ChromeStatusItem, box_style: &Style) -> Style {
    match item {
        ChromeStatusItem::Furniture(_) => default_contour(),
        ChromeStatusItem::Signal {
            role, prominence, ..
        } => match role {
            Some(role) if !role.is_empty() => {
                fg_style(role, prominence.unwrap_or(FgP::SECONDARY), false)
            }
            _ => box_style.clone(),
        },
    }
}

fn count_word(n: i64, unit: &str) -> String {
    if n == 1 {
        format!("{n} {unit}")
    } else {
        format!("{n} {unit}s")
    }
}

fn hours_phrase(hours: i64) -> String {
    if hours >= 24 {
        count_word(hours / 24, "day")
    } else {
        count_word(hours, "hour")
    }
}

fn format_remaining_spelled(remaining_ms: f64) -> String {
    if !remaining_ms.is_finite() {
        return String::new();
    }
    let seconds = round_nonneg(remaining_ms / 1000.0);
    let mins = if seconds == 0 {
        0
    } else {
        1.max(seconds.saturating_add(30) / 60)
    };
    if mins == 0 {
        return String::new();
    }
    if mins < 60 {
        return count_word(mins, "minute");
    }
    if mins < 1440 {
        let hours = mins / 60;
        let minutes = mins % 60;
        if minutes == 0 || minutes == 1 {
            return hours_phrase(hours);
        }
        if minutes == 59 {
            return hours_phrase(hours + 1);
        }
        return format!(
            "{} and {}",
            count_word(hours, "hour"),
            count_word(minutes, "minute")
        );
    }
    let days = mins / 1440;
    let hours = (mins % 1440) / 60;
    if hours == 0 {
        count_word(days, "day")
    } else {
        format!(
            "{} and {}",
            count_word(days, "day"),
            count_word(hours, "hour")
        )
    }
}

fn format_token_count(n: f64) -> String {
    if !n.is_finite() || n < 0.0 {
        return "0".to_string();
    }
    let rounded = round_nonneg(n);
    if rounded < 1000 {
        return rounded.to_string();
    }
    let kilo = rounded as f64 / 1000.0;
    if kilo < 10.0 {
        let tenths = round_nonneg(kilo * 10.0);
        let whole = tenths / 10;
        let frac = tenths % 10;
        if frac == 0 {
            format!("{whole}k")
        } else {
            format!("{whole}.{frac}k")
        }
    } else {
        format!("{}k", round_nonneg(kilo))
    }
}

fn format_context_occupancy(used: f64, limit: f64) -> String {
    let has_limit = limit.is_finite() && limit > 0.0;
    let has_used = used.is_finite() && used > 0.0;
    if !has_limit && !has_used {
        return String::new();
    }
    if !has_limit {
        return format_token_count(used);
    }
    let used = if used.is_finite() && used > 0.0 {
        used
    } else {
        0.0
    };
    format!("{}/{}", format_token_count(used), format_token_count(limit))
}

fn format_quota_window(window: &ChromeQuotaWindow, now_ms: f64) -> String {
    if !window.remaining_percent.is_finite() {
        return String::new();
    }
    let left = format!("{}%", round_nonneg(window.remaining_percent.max(0.0)));
    let Some(reset_at) = window.reset_at else {
        return left;
    };
    if !reset_at.is_finite() {
        return left;
    }
    let deadline = reset_at * 1000.0;
    if !deadline.is_finite() {
        return left;
    }
    if deadline <= now_ms {
        return String::new();
    }
    let until = format_remaining_spelled(deadline - now_ms);
    if until.is_empty() {
        left
    } else {
        format!("{left} left for {until}")
    }
}

fn format_quota_windows(windows: &[ChromeQuotaWindow], now_ms: f64) -> String {
    windows
        .iter()
        .map(|window| format_quota_window(window, now_ms))
        .filter(|bit| !bit.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

const SPINNER_FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

fn spinner_hz(profile: &str) -> f64 {
    if profile == "working" {
        10.0
    } else {
        12.0
    }
}

/// Braille frame for `profile` at `now_ms`. Thinking and tool run at 12 Hz.
pub fn resolve_spinner_glyph(profile: &str, now_ms: f64) -> String {
    let now = if now_ms.is_finite() { now_ms.max(0.0) } else { 0.0 };
    let index = ((now * spinner_hz(profile)) / 1000.0).floor();
    let index = if index.is_finite() && index >= 0.0 {
        (index as usize) % SPINNER_FRAMES.len()
    } else {
        0
    };
    SPINNER_FRAMES[index].to_string()
}

/// Compact duration. Below a minute the tenths place stays, including `3.0s`.
pub fn format_elapsed_compact(ms: f64) -> String {
    if !ms.is_finite() || ms < 0.0 {
        return String::new();
    }
    let seconds = ms / 1000.0;
    if seconds < 1.0 {
        return "<1s".to_string();
    }
    if seconds < 60.0 {
        return format!("{seconds:.1}s");
    }
    let minutes = (seconds / 60.0).floor() as i64;
    let rem = (seconds % 60.0).round() as i64;
    if rem > 0 {
        format!("{minutes}m {rem}s")
    } else {
        format!("{minutes}m")
    }
}

/// Retry copy. One second is singular.
pub fn format_retry_countdown(until_ms: f64, now_ms: f64) -> String {
    let raw = (until_ms - now_ms) / 1000.0;
    let seconds = if raw.is_finite() {
        let capped = raw.ceil().max(0.0);
        if capped >= i64::MAX as f64 {
            i64::MAX
        } else {
            capped as i64
        }
    } else {
        0
    };
    let unit = if seconds == 1 { "second" } else { "seconds" };
    format!("Failed to request; retrying in {seconds} {unit}")
}

/// One live decoration. `now_ms` is the caller clock.
pub enum LiveFace<'a> {
    Spinner {
        profile: &'a str,
    },
    Elapsed {
        started_at: f64,
        label: Option<&'a str>,
        prefix: Option<&'a str>,
    },
    Countdown {
        until_ms: f64,
    },
    Quota {
        windows: &'a [ChromeQuotaWindow],
        prefix: Option<&'a str>,
    },
}

/// Glyph or label at `now_ms`. The same face at a later clock is not frozen.
pub fn resolve_live_text(live: LiveFace<'_>, now_ms: f64) -> String {
    match live {
        LiveFace::Spinner { profile } => resolve_spinner_glyph(profile, now_ms),
        LiveFace::Elapsed {
            started_at,
            label,
            prefix,
        } => {
            let elapsed = if started_at.is_finite() && now_ms.is_finite() {
                (now_ms - started_at).max(0.0)
            } else {
                0.0
            };
            let compact = format_elapsed_compact(elapsed);
            if let Some(prefix) = prefix {
                return format!("{prefix}{compact}");
            }
            let label = label.unwrap_or("thinking");
            if elapsed < 500.0 {
                label.to_string()
            } else {
                format!("{label} · {compact}")
            }
        }
        LiveFace::Countdown { until_ms } => format_retry_countdown(until_ms, now_ms),
        LiveFace::Quota { windows, prefix } => format_held_status(prefix.unwrap_or(""), windows, now_ms),
    }
}

fn format_held_status(prefix: &str, windows: &[ChromeQuotaWindow], now_ms: f64) -> String {
    let occupancy = prefix.trim();
    let quota = format_quota_windows(windows, now_ms);
    if occupancy.is_empty() {
        quota
    } else if quota.is_empty() {
        occupancy.to_string()
    } else {
        format!("{occupancy} · {quota}")
    }
}

fn format_held_status_fit(
    prefix: &str,
    windows: &[ChromeQuotaWindow],
    now_ms: f64,
    max_columns: i64,
) -> String {
    let full = format_held_status(prefix, windows, now_ms);
    if max_columns <= 0 || measure_cols(&full) <= max_columns {
        return full;
    }
    let occupancy = prefix.trim();
    if occupancy.is_empty() || occupancy == full {
        return full;
    }
    if measure_cols(occupancy) <= max_columns {
        occupancy.to_string()
    } else {
        full
    }
}

fn quota_live(windows: &[ChromeQuotaWindow], prefix: &str) -> ChromeLive {
    let prefix = prefix.trim();
    ChromeLive::Quota {
        windows: windows.to_vec(),
        prefix: if prefix.is_empty() {
            None
        } else {
            Some(prefix.to_string())
        },
        hz: 1,
    }
}

struct StatusRail {
    items: Vec<ChromeStatusItem>,
    live: Option<ChromeLive>,
}

/// Unix epoch milliseconds.
///
/// Quota `reset_at` is unix seconds. The present loop must pass this clock.
/// Milliseconds since process start spell that deadline as days since 1970.
pub fn unix_now_ms() -> u64 {
    let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return 0;
    };
    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
}

fn wall_now_ms() -> f64 {
    let ms = unix_now_ms();
    const EXACT_MAX: u64 = 1 << 53;
    if ms > EXACT_MAX {
        EXACT_MAX as f64
    } else {
        ms as f64
    }
}

fn status_rail(opts: &ChromeBottomOpts, max_columns: Option<i64>) -> StatusRail {
    let base = normalize_status(&opts.status_items);
    if !opts.mod_held {
        return StatusRail {
            items: base,
            live: None,
        };
    }
    let windows: Vec<ChromeQuotaWindow> = opts
        .quota_windows
        .iter()
        .filter(|window| window.remaining_percent.is_finite())
        .cloned()
        .collect();
    let prefix = format_context_occupancy(
        opts.context_used.unwrap_or(0.0),
        opts.context_limit.unwrap_or(0.0),
    );
    let now_ms = opts.now_ms.unwrap_or_else(wall_now_ms);
    let full = format_held_status(&prefix, &windows, now_ms);
    let text = match max_columns {
        None => full.clone(),
        Some(max_columns) => format_held_status_fit(&prefix, &windows, now_ms, max_columns),
    };
    if text.is_empty() {
        return StatusRail {
            items: base,
            live: None,
        };
    }
    let occupancy_only = text != full;
    let live = if !windows.is_empty() && !occupancy_only {
        Some(quota_live(&windows, &prefix))
    } else {
        None
    };
    let mut items = vec![ChromeStatusItem::Furniture(text)];
    items.extend(
        base.into_iter()
            .filter(|item| matches!(item, ChromeStatusItem::Signal { .. })),
    );
    StatusRail { items, live }
}

fn joined_chip_text(items: &[ChromeStatusItem]) -> String {
    let texts: Vec<String> = items
        .iter()
        .map(chip_text)
        .filter(|text| !text.is_empty())
        .collect();
    if texts.is_empty() {
        String::new()
    } else {
        format!(" {}", texts.join(" · "))
    }
}

/// Joined status for measure. A leading space matches paint. `now_ms` defaults to the wall clock.
pub fn status_right_text(opts: &ChromeBottomOpts) -> String {
    joined_chip_text(&status_rail(opts, None).items)
}

fn status_right_segs(opts: &ChromeBottomOpts, box_style: &Style, max_w: i64) -> Vec<ChromeSeg> {
    if max_w <= 0 {
        return Vec::new();
    }
    let StatusRail {
        items: mut chips,
        live,
    } = status_rail(opts, Some((max_w - 1).max(0)));
    if chips.is_empty() {
        return Vec::new();
    }
    let build = |list: &[ChromeStatusItem]| -> Vec<ChromeSeg> {
        let mut segs = vec![ChromeSeg::new(" ", box_style.clone())];
        for (index, chip) in list.iter().enumerate() {
            if index > 0 {
                segs.push(ChromeSeg::new(" · ", box_style.clone()));
            }
            let mut seg = ChromeSeg::new(chip_text(chip), status_chip_style(chip, box_style));
            if live.is_some() && matches!(chip, ChromeStatusItem::Furniture(_)) && index == 0 {
                seg.live = live.clone();
            }
            segs.push(seg);
        }
        segs
    };
    let mut segs = build(&chips);
    while segs_width(&segs) > max_w && chips.len() > 1 {
        chips.remove(0);
        segs = build(&chips);
    }
    if segs_width(&segs) > max_w {
        let clipped = ellipsize_to(&joined_chip_text(&chips), max_w);
        if clipped.is_empty() {
            Vec::new()
        } else {
            vec![ChromeSeg::new(clipped, box_style.clone())]
        }
    } else {
        segs
    }
}

fn pad_dash(n: i64) -> String {
    repeat_unit("─", n)
}

fn right_bar_style(coverage: Option<f64>, contour_role: Option<&str>, prominence: f64) -> Style {
    let box_style = box_contour(contour_role, prominence);
    let Some(t) = coverage else {
        return box_style;
    };
    let role = match contour_role {
        Some(role) if !role.is_empty() => role,
        _ => "foreground",
    };
    fg_style(role, fg_progress(prominence, FgP::PRIMARY, t), false)
}

/// Draft column width inside `│ · text │`.
pub fn chrome_frame_text_width(outer_w: i64) -> i64 {
    outer_w.saturating_sub(CHROME_FRAME_BODY_CHROME).max(1)
}

/// Columns from the body left edge to the first text cell: `│ · ` is 3.
pub fn chrome_frame_text_inset() -> i64 {
    CHROME_FRAME_BODY_CHROME - 1
}

/// Text column width. Same budget as [`chrome_frame_text_width`].
pub fn chrome_frame_content_width(outer_w: i64) -> i64 {
    chrome_frame_text_width(outer_w)
}

/// Wrapped draft lines. An empty draft is one space, or the placeholder when one is set.
pub fn chrome_frame_body_lines(
    draft: &str,
    outer_w: i64,
    placeholder: Option<&str>,
) -> Vec<String> {
    let width = chrome_frame_text_width(outer_w);
    if draft.is_empty() {
        let placeholder = placeholder.unwrap_or("").trim_end();
        if !placeholder.is_empty() {
            let lines = wrap_pre(placeholder, width);
            return if lines.is_empty() {
                vec![" ".to_string()]
            } else {
                lines
            };
        }
        return vec![" ".to_string()];
    }
    let lines = wrap_pre(draft, width);
    if lines.is_empty() {
        vec![" ".to_string()]
    } else {
        lines
    }
}

/// Visual lines plus scalar starts. An empty draft is `{ " ", 0 }`.
pub fn chrome_frame_body_lines_with_starts(draft: &str, outer_w: i64) -> Vec<BodyLine> {
    let width = chrome_frame_text_width(outer_w);
    if draft.is_empty() {
        return vec![BodyLine {
            text: " ".to_string(),
            start: 0,
        }];
    }
    let hard_lines: Vec<&str> = draft.split('\n').collect();
    let mut out = Vec::new();
    let mut pos = 0i64;
    for (index, hard) in hard_lines.iter().enumerate() {
        let mut hard_pos = 0i64;
        for line in wrap_pre(hard, width) {
            let len = unit_len(&line);
            out.push(BodyLine {
                text: line,
                start: pos.saturating_add(hard_pos),
            });
            hard_pos = hard_pos.saturating_add(len);
        }
        pos = pos.saturating_add(unit_len(hard));
        if index + 1 < hard_lines.len() {
            pos = pos.saturating_add(1);
        }
    }
    if out.is_empty() {
        vec![BodyLine {
            text: " ".to_string(),
            start: 0,
        }]
    } else {
        out
    }
}

fn chrome_frame_paint_body_lines(draft: &str, completion: &str, outer_w: i64) -> Vec<BodyLine> {
    let draft_lines = chrome_frame_body_lines_with_starts(draft, outer_w);
    if completion.is_empty() {
        return draft_lines;
    }
    let text_w = chrome_frame_text_width(outer_w);
    let Some(last) = draft_lines.last() else {
        return draft_lines;
    };
    let wrapped = wrap_pre(&format!("{}{completion}", last.text), text_w);
    let head = wrapped.first().map(String::as_str).unwrap_or("");
    if head.starts_with(&last.text) {
        let mut out = draft_lines[..draft_lines.len() - 1].to_vec();
        let mut pos = last.start;
        for line in wrapped {
            let len = unit_len(&line);
            out.push(BodyLine {
                text: line,
                start: pos,
            });
            pos = pos.saturating_add(len);
        }
        return if out.is_empty() { draft_lines } else { out };
    }
    let mut overflow = completion.to_string();
    let mut skip = 0i64;
    if overflow.starts_with(' ') {
        overflow = shift_owned(&overflow);
        skip = 1;
    }
    if overflow.is_empty() {
        return draft_lines;
    }
    let extra = wrap_pre(&overflow, text_w);
    let mut out = draft_lines.clone();
    let mut pos = last
        .start
        .saturating_add(unit_len(&last.text))
        .saturating_add(skip);
    for line in extra {
        if line.is_empty() {
            continue;
        }
        let len = unit_len(&line);
        out.push(BodyLine {
            text: line,
            start: pos,
        });
        pos = pos.saturating_add(len);
    }
    out
}

/// Placeholder chrome is not draft text. `placeholder_mode` forces that even with an empty hint.
pub fn is_chrome_frame_showing_placeholder(frame: &ChromeFrame) -> bool {
    if frame.placeholder_mode {
        return true;
    }
    let draft = frame
        .speculative_draft
        .as_deref()
        .unwrap_or(frame.draft.as_str());
    if !draft.is_empty() {
        return false;
    }
    frame
        .placeholder
        .as_ref()
        .is_some_and(|placeholder| !placeholder.is_empty())
}

/// Body rows plus top (unless omitted) and bottom. `body_h` below 1 still counts as one row.
pub fn chrome_frame_total_height(body_h: i64, omit_top: bool) -> i64 {
    let chrome = if omit_top {
        1
    } else {
        CHROME_FRAME_CHROME_ROWS
    };
    body_h.max(1).saturating_add(chrome)
}

/// Shortcuts, annotation, or join annotation ride the rule above the draft.
pub fn chrome_frame_has_hint(frame: &ChromeFrame) -> bool {
    if !frame.hotkeys.is_empty() {
        return true;
    }
    if frame
        .annotation
        .as_ref()
        .is_some_and(|text| !text.trim().is_empty())
    {
        return true;
    }
    frame
        .join_annotation
        .as_ref()
        .is_some_and(|text| !text.trim().is_empty())
}

/// Partition `budget` cells into a right-aligned fill and a left contour remainder.
pub fn progress_fill_segments(budget: f64, ratio: f64) -> ProgressFillSegments {
    let total = floor_cell(budget).max(0);
    if total <= 0 {
        return ProgressFillSegments {
            full: 0,
            frac: 0.0,
            rest: 0,
            total: 0,
        };
    }
    let used_exact = clamp01(ratio) * cell_as_f64(total);
    let mut full = floor_cell(used_exact + 1e-9).max(0);
    let mut frac = used_exact - cell_as_f64(full);
    if frac < 1e-6 {
        frac = 0.0;
    } else if frac > 1.0 - 1e-6 {
        full = total.min(full.saturating_add(1));
        frac = 0.0;
    }
    full = total.min(full);
    let used = full + if frac > 0.0 { 1 } else { 0 };
    ProgressFillSegments {
        full,
        frac,
        rest: (total - used).max(0),
        total,
    }
}

/// Ramp along the active run. `t = 0` is fused into the contour; `t = 1` is primary.
pub fn progress_ramp_prominence(t: f64) -> f64 {
    FgP::PRIMARY * clamp01(t)
}

/// Warning mix for remaining fill. `0` at or above `glow_at`, `1` when the runway is empty.
pub fn progress_glow_tint(progress: f64, glow_at: f64) -> f64 {
    let at = clamp01(glow_at);
    if at <= 0.0 {
        return 0.0;
    }
    let remaining = clamp01(progress);
    if remaining >= at {
        0.0
    } else {
        (at - remaining) / at
    }
}

fn progress_hue(raw: Option<&str>) -> Option<Role> {
    match raw {
        None | Some("") => Some(Role::Foreground),
        Some(name) => Role::parse(name),
    }
}

fn progress_ramp_segs(
    fill: ProgressFillSegments,
    role: Option<Role>,
    fuse_role: Role,
    glow: f64,
) -> Vec<ChromeSeg> {
    let n = fill.full + if fill.frac > 0.0 { 1 } else { 0 };
    if n <= 0 {
        return Vec::new();
    }
    let tint = glow.max(0.0);
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let t = if n == 1 {
            1.0
        } else {
            cell_as_f64(i) / cell_as_f64(n - 1)
        };
        let tt = if i == 0 && fill.frac > 0.0 {
            t * fill.frac
        } else {
            t
        };
        let mut style = Style {
            role: role.map(|role| role.as_str().to_string()),
            prominence: Some(progress_ramp_prominence(tt)),
            ..Style::default()
        };
        style.fuse_role = Some(fuse_role.as_str().to_string());
        style.fuse_prominence = Some(FgP::GHOST);
        if tint > 0.0 {
            style.tint_role = Some(CHROME_FRAME_PROGRESS_GLOW_ROLE.to_string());
            style.tint = Some(tint);
        }
        out.push(ChromeSeg::new("─", style));
    }
    out
}

fn glyph_cell(glyph: Option<&str>) -> String {
    match glyph {
        Some(glyph) if !glyph.is_empty() => glyph.chars().take(2).collect(),
        _ => CHROME_FRAME_DEFAULT_GLYPH.to_string(),
    }
}

fn paint_source(frame: &ChromeFrame) -> (String, String, i64) {
    let draft = frame
        .speculative_draft
        .clone()
        .unwrap_or_else(|| frame.draft.clone());
    let completion = if draft.is_empty() {
        String::new()
    } else {
        frame
            .completion
            .clone()
            .filter(|text| !text.is_empty())
            .unwrap_or_default()
    };
    let draft_len = unit_len(&draft);
    (draft, completion, draft_len)
}

fn outer_width(width: i64, max_w: i64) -> i64 {
    let chosen = if width == 0 { max_w } else { width };
    8.max(max_w.min(chosen))
}

/// Measure one frame at `max_w` × `max_h`. Height is clamped; `body_lines` is not.
pub fn measure_chrome_frame(frame: &ChromeFrame, max_w: i64, max_h: i64) -> ChromeFrameGeom {
    let outer_w = outer_width(frame.width, max_w);
    let glyph = glyph_cell(frame.glyph.as_deref());
    let body_lines = if !frame.body_seg_rows.is_empty() {
        frame
            .body_seg_rows
            .iter()
            .map(|_| " ".to_string())
            .collect()
    } else if is_chrome_frame_showing_placeholder(frame) {
        chrome_frame_body_lines("", outer_w, frame.placeholder.as_deref())
    } else {
        let (draft, completion, _) = paint_source(frame);
        chrome_frame_paint_body_lines(&draft, &completion, outer_w)
            .into_iter()
            .map(|line| line.text)
            .collect()
    };
    let body_h = (body_lines.len() as i64).max(1);
    let total_h = max_h
        .min(chrome_frame_total_height(body_h, frame.omit_top))
        .max(1);
    ChromeFrameGeom {
        outer_w,
        text_w: chrome_frame_text_width(outer_w),
        body_lines,
        body_h,
        total_h,
        glyph,
    }
}

fn annotation_right(opts: &ChromeTopOpts) -> (Vec<ChromeSeg>, bool) {
    let fault = matches!(opts.annotation_role.as_deref(), Some("error" | "warning"));
    let role = if fault {
        opts.annotation_role.as_deref().unwrap_or("foreground")
    } else if opts
        .annotation_role
        .as_ref()
        .is_some_and(|role| !role.is_empty())
    {
        opts.annotation_role.as_deref().unwrap_or("foreground")
    } else {
        "foreground"
    };
    let ann_style = fg_style(role, if fault { FgP::PRIMARY } else { FgP::GHOST }, false);
    let mut right: Vec<ChromeSeg> = opts
        .annotation_segs
        .iter()
        .filter(|seg| !seg.text.is_empty())
        .cloned()
        .collect();
    if right.is_empty() {
        let annotation = opts.annotation.as_deref().unwrap_or("").trim();
        if !annotation.is_empty() {
            right = markdown_inline_segs(annotation, &ann_style)
                .into_iter()
                .map(|mut seg| {
                    if !fault && seg.style.bold {
                        seg.style.bold = false;
                        seg.style.prominence = Some(FgP::PRIMARY);
                    }
                    seg
                })
                .collect();
        }
    }
    (right, fault)
}

/// One full-width rule. Solo frames use ╭╮. `join` uses ├┤. `bottom` uses ╰╯.
pub fn chrome_frame_top_segs(
    outer_w: i64,
    hotkeys: &[ChromeHotkey],
    opts: &ChromeTopOpts,
) -> Vec<ChromeSeg> {
    let w = outer_w.max(4);
    let box_style = box_contour(
        opts.contour_role.as_deref(),
        prominence_of(opts.contour_prominence),
    );
    let hint = reveal_hotkeys(hotkeys, opts.mod_held);
    let has_hint = !hint.is_empty();
    let (left_corner, right_corner) = if opts.join {
        (CHROME_FRAME_JOIN.left, CHROME_FRAME_JOIN.right)
    } else if opts.bottom {
        (CHROME_FRAME_CORNERS.bl, CHROME_FRAME_CORNERS.br)
    } else {
        (CHROME_FRAME_CORNERS.tl, CHROME_FRAME_CORNERS.tr)
    };
    let (right, fault) = annotation_right(opts);
    let mut segs = vec![ChromeSeg::new(left_corner, box_style.clone())];
    if !has_hint && right.is_empty() {
        segs.push(ChromeSeg::new(pad_dash(w - 2), box_style.clone()));
        segs.push(ChromeSeg::new(right_corner, box_style));
        return segs;
    }
    let left_prefix = if has_hint { "─ " } else { "" };
    let right_prefix = if right.is_empty() { "" } else { " " };
    let right_suffix = if right.is_empty() { "" } else { RIGHT_SLOT_PAD };
    let trail = if has_hint { 1 } else { 0 };
    let min_fill = if has_hint && !right.is_empty() { 1 } else { 0 };
    let chrome = 2
        + measure_cols(left_prefix)
        + trail
        + measure_cols(right_prefix)
        + measure_cols(right_suffix)
        + min_fill;
    let budget = (w - chrome).max(0);
    let (left_segs, right_fit) = fit_hint_and_annotation(&hint, &right, budget, !fault);
    if !left_prefix.is_empty() {
        segs.push(ChromeSeg::new(left_prefix, box_style.clone()));
    }
    segs.extend(left_segs.iter().cloned());
    if has_hint {
        segs.push(ChromeSeg::new(" ", box_style.clone()));
    }
    let used = 2
        + measure_cols(left_prefix)
        + segs_width(&left_segs)
        + if has_hint { 1 } else { 0 }
        + measure_cols(right_prefix)
        + segs_width(&right_fit)
        + measure_cols(right_suffix);
    let fill = (w - used).max(0);
    if fill > 0 {
        segs.push(ChromeSeg::new(pad_dash(fill), box_style.clone()));
    }
    if !right_prefix.is_empty() {
        segs.push(ChromeSeg::new(right_prefix, box_style.clone()));
    }
    segs.extend(right_fit);
    if !right_suffix.is_empty() {
        segs.push(ChromeSeg::new(right_suffix, box_style.clone()));
    }
    segs.push(ChromeSeg::new(right_corner, box_style));
    segs
}

/// Plain bottom rule. `join` swaps ╰╯ for ├┤.
pub fn chrome_frame_plain_bottom_segs(
    outer_w: i64,
    join: bool,
    contour_role: Option<&str>,
    contour_prominence: Option<f64>,
) -> Vec<ChromeSeg> {
    let w = outer_w.max(4);
    let box_style = box_contour(contour_role, prominence_of(contour_prominence));
    let (left, right) = if join {
        (CHROME_FRAME_JOIN.left, CHROME_FRAME_JOIN.right)
    } else {
        (CHROME_FRAME_CORNERS.bl, CHROME_FRAME_CORNERS.br)
    };
    vec![
        ChromeSeg::new(left, box_style.clone()),
        ChromeSeg::new(pad_dash(w - 2), box_style.clone()),
        ChromeSeg::new(right, box_style),
    ]
}

/// Top edge from content segs between ╭╮. Overflow content is dropped, not clipped mid-seg.
pub fn chrome_frame_top_from_content_segs(
    outer_w: i64,
    content: &[ChromeSeg],
    contour_role: Option<&str>,
    contour_prominence: Option<f64>,
) -> Vec<ChromeSeg> {
    let w = outer_w.max(4);
    let box_style = box_contour(contour_role, prominence_of(contour_prominence));
    let mut segs = vec![ChromeSeg::new(CHROME_FRAME_CORNERS.tl, box_style.clone())];
    let mut used = 2i64;
    for seg in content {
        let width = measure_cols(&seg.text);
        if used.saturating_add(width) > w {
            break;
        }
        segs.push(seg.clone());
        used += width;
    }
    let fill = (w - used).max(0);
    if fill > 0 {
        segs.push(ChromeSeg::new(pad_dash(fill), box_style.clone()));
    }
    segs.push(ChromeSeg::new(CHROME_FRAME_CORNERS.tr, box_style));
    segs
}

/// Bottom edge. A contour role suppresses the progress ramp. `plain` is a bare rule.
pub fn chrome_frame_bottom_segs(outer_w: i64, opts: &ChromeBottomOpts) -> Vec<ChromeSeg> {
    let w = outer_w.max(4);
    let box_style = box_contour(
        opts.contour_role.as_deref(),
        prominence_of(opts.contour_prominence),
    );
    if opts.plain {
        return chrome_frame_plain_bottom_segs(
            w,
            opts.join,
            opts.contour_role.as_deref(),
            opts.contour_prominence,
        );
    }
    let boxed = opts
        .contour_role
        .as_ref()
        .is_some_and(|role| !role.is_empty());
    let has_progress = !boxed && opts.progress.is_some_and(|progress| progress.is_finite());
    let (left, right) = if opts.join {
        (CHROME_FRAME_JOIN.left, CHROME_FRAME_JOIN.right)
    } else {
        (CHROME_FRAME_CORNERS.bl, CHROME_FRAME_CORNERS.br)
    };
    let min_rail = if has_progress { 6 } else { 0 };
    let reserve = measure_cols(RIGHT_SLOT_PAD);
    let chip_budget = (w
        .saturating_sub(2)
        .saturating_sub(min_rail)
        .saturating_sub(reserve))
    .max(0);
    let right_segs = status_right_segs(opts, &box_style, chip_budget);
    let right_w = segs_width(&right_segs);
    let trail_pad = if right_w > 0 {
        measure_cols(RIGHT_SLOT_PAD)
    } else {
        0
    };
    let mut segs = vec![ChromeSeg::new(left, box_style.clone())];
    if !has_progress {
        let mid = (w
            .saturating_sub(2)
            .saturating_sub(right_w)
            .saturating_sub(trail_pad))
        .max(0);
        if mid > 0 {
            segs.push(ChromeSeg::new(pad_dash(mid), box_style.clone()));
        }
        segs.extend(right_segs);
        if trail_pad > 0 {
            segs.push(ChromeSeg::new(RIGHT_SLOT_PAD, box_style.clone()));
        }
        segs.push(ChromeSeg::new(right, box_style));
        return segs;
    }
    let ratio = clamp01(opts.progress.unwrap_or(0.0));
    let role = progress_hue(opts.progress_role.as_deref());
    let fill_budget = (w
        .saturating_sub(2)
        .saturating_sub(right_w)
        .saturating_sub(trail_pad))
    .max(0);
    let fill = progress_fill_segments(cell_as_f64(fill_budget), ratio);
    let glow_at = opts
        .progress_glow_at
        .filter(|glow| glow.is_finite())
        .unwrap_or(CHROME_FRAME_DEFAULT_PROGRESS_GLOW_AT);
    let ramp = progress_ramp_segs(
        fill,
        role,
        Role::Foreground,
        progress_glow_tint(ratio, glow_at),
    );
    if fill.rest > 0 {
        segs.push(ChromeSeg::new(pad_dash(fill.rest), box_style.clone()));
    }
    let painted =
        fill.full + if fill.frac > 0.0 { 1 } else { 0 } + fill.rest + right_w + trail_pad + 2;
    if painted < w {
        segs.push(ChromeSeg::new(pad_dash(w - painted), box_style.clone()));
    }
    segs.extend(ramp);
    segs.extend(right_segs);
    if trail_pad > 0 {
        segs.push(ChromeSeg::new(RIGHT_SLOT_PAD, box_style.clone()));
    }
    segs.push(ChromeSeg::new(right, box_style));
    segs
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyRun {
    Draft,
    Selected,
    Completion,
}

fn body_run_kind(abs: i64, opts: &ChromeBodyRowOpts) -> BodyRun {
    if opts.draft_length.is_some_and(|len| abs >= len) {
        return BodyRun::Completion;
    }
    if let (Some(sel_a), Some(sel_b)) = (opts.sel_a, opts.sel_b) {
        if abs >= sel_a && abs < sel_b {
            return BodyRun::Selected;
        }
    }
    BodyRun::Draft
}

fn split_body_runs(
    body: &str,
    line_start: i64,
    opts: &ChromeBodyRowOpts,
    draft_style: &Style,
    pad: i64,
) -> Vec<ChromeSeg> {
    let chars: Vec<char> = body.chars().collect();
    let mut segs = Vec::new();
    let mut index = 0usize;
    while index < chars.len() {
        let kind = body_run_kind(line_start.saturating_add(index as i64), opts);
        let mut end = index + 1;
        while end < chars.len()
            && body_run_kind(line_start.saturating_add(end as i64), opts) == kind
        {
            end += 1;
        }
        let text: String = chars[index..end].iter().collect();
        let style = match kind {
            BodyRun::Completion => placeholder_style(),
            BodyRun::Selected => {
                let mut style = draft_style.clone();
                style.selected = true;
                style
            }
            BodyRun::Draft => draft_style.clone(),
        };
        segs.push(ChromeSeg::new(text, style));
        index = end;
    }
    if pad > 0 {
        segs.push(ChromeSeg::new(repeat_unit(" ", pad), draft_style.clone()));
    }
    if segs.is_empty() {
        segs.push(ChromeSeg::new(" ", draft_style.clone()));
    }
    segs
}

/// One body row `│ · text │`, always `outer_w` columns when the mark is one cell.
pub fn chrome_frame_body_row_segs(
    line: &str,
    row: i64,
    outer_w: i64,
    glyph: &str,
    opts: &ChromeBodyRowOpts,
) -> Vec<ChromeSeg> {
    let box_style = box_contour(
        opts.contour_role.as_deref(),
        prominence_of(opts.contour_prominence),
    );
    let text_w = chrome_frame_text_width(outer_w);
    let mut body = line.to_string();
    while measure_cols(&body) > text_w && !body.is_empty() {
        body = pop_owned(&body);
    }
    if body.is_empty() {
        body = " ".to_string();
    }
    let pad = (text_w - measure_cols(&body)).max(0);
    let text_style = if opts.placeholder {
        placeholder_style()
    } else {
        body_style()
    };
    let split = !opts.placeholder
        && opts.line_start.is_some()
        && (opts.draft_length.is_some()
            || matches!((opts.sel_a, opts.sel_b), (Some(a), Some(b)) if a < b));
    let text_segs = if split {
        split_body_runs(&body, opts.line_start.unwrap_or(0), opts, &text_style, pad)
    } else {
        let mut text = body;
        if pad > 0 {
            text.push_str(&repeat_unit(" ", pad));
        }
        vec![ChromeSeg::new(text, text_style)]
    };
    let mark = if row == 0 { glyph } else { " " };
    let marked = !mark.trim().is_empty();
    let mut segs = vec![
        ChromeSeg::new("│", box_style.clone()),
        ChromeSeg::new(
            if marked { mark } else { " " },
            if marked {
                mark_cell_style(mark)
            } else {
                Style::default()
            },
        ),
        ChromeSeg::new(" ", Style::default()),
    ];
    segs.extend(text_segs);
    segs.push(ChromeSeg::new(
        "│",
        right_bar_style(
            opts.right_coverage,
            opts.contour_role.as_deref(),
            prominence_of(opts.contour_prominence),
        ),
    ));
    segs
}

/// Body row from content segs. Selection marks belong in `glyph`, not in the text.
pub fn chrome_frame_body_from_content_segs(
    content: &[ChromeSeg],
    outer_w: i64,
    opts: &ChromeBodyContentOpts,
) -> Vec<ChromeSeg> {
    let w = outer_w.max(4);
    let prominence = prominence_of(opts.contour_prominence);
    let box_style = box_contour(opts.contour_role.as_deref(), prominence);
    let content_budget = chrome_frame_text_width(w);
    let glyph = glyph_cell(opts.glyph.as_deref());
    let marked = !glyph.trim().is_empty();
    let mut segs = vec![
        ChromeSeg::new("│", box_style),
        ChromeSeg::new(
            if marked { glyph.as_str() } else { " " },
            if marked {
                mark_cell_style(&glyph)
            } else {
                Style::default()
            },
        ),
        ChromeSeg::new(" ", Style::default()),
    ];
    let mut content_used = 0i64;
    for seg in content {
        let width = measure_cols(&seg.text);
        if content_used.saturating_add(width) > content_budget {
            break;
        }
        segs.push(seg.clone());
        content_used += width;
    }
    let pad = (content_budget - content_used).max(0);
    if pad > 0 {
        segs.push(ChromeSeg::new(repeat_unit(" ", pad), Style::default()));
    }
    segs.push(ChromeSeg::new(
        "│",
        right_bar_style(
            opts.right_coverage,
            opts.contour_role.as_deref(),
            prominence,
        ),
    ));
    segs
}

/// Mark for body row `row`. `body_glyphs` wins; otherwise only row 0 carries `frame_glyph`.
pub fn chrome_frame_row_glyph(frame: &ChromeFrame, row: i64, frame_glyph: &str) -> String {
    if row >= 0 {
        if let Some(slot) = frame.body_glyphs.get(row as usize) {
            if let Some(glyph) = slot {
                return if glyph.is_empty() {
                    " ".to_string()
                } else {
                    glyph.chars().take(2).collect()
                };
            }
        }
    }
    if row == 0 {
        frame_glyph.to_string()
    } else {
        " ".to_string()
    }
}

fn clip_cols(text: &str, remaining: i64) -> String {
    let mut clipped = text.to_string();
    while !clipped.is_empty() && measure_cols(&clipped) > remaining {
        clipped = pop_owned(&clipped);
    }
    clipped
}

/// Horizontal runs at `(x, y)`, clipped to `clip_w` columns.
pub fn segs_to_paint_ops(segs: &[ChromeSeg], x: i64, y: i64, clip_w: i64) -> Vec<ChromePaintOp> {
    let mut ops = Vec::new();
    let mut cursor = x;
    let mut remaining = clip_w;
    for seg in segs {
        if remaining <= 0 {
            break;
        }
        let text = if measure_cols(&seg.text) > remaining {
            clip_cols(&seg.text, remaining)
        } else {
            seg.text.clone()
        };
        let width = measure_cols(&text);
        if text.is_empty() || width <= 0 {
            continue;
        }
        let rect = Rect::new(cursor, y, width, 1);
        if let Some(live) = &seg.live {
            ops.push(ChromePaintOp::Live {
                rect,
                style: seg.style.clone(),
                live: live.clone(),
            });
        } else {
            ops.push(ChromePaintOp::Text {
                rect,
                lines: vec![text],
                style: seg.style.clone(),
            });
        }
        cursor += width;
        remaining -= width;
    }
    ops
}

fn contour_prominence_of(frame: &ChromeFrame) -> f64 {
    if frame.selected {
        FgP::PRIMARY
    } else {
        FgP::GHOST
    }
}

fn coverage_at(frame: &ChromeFrame, row: i64) -> Option<f64> {
    if row < 0 {
        return None;
    }
    frame
        .body_right_coverage
        .get(row as usize)
        .copied()
        .flatten()
}

/// Paint ops for `frame` placed at `rect`.
///
/// Row map: optional top rule, body rows, then the bottom rule when the rect has room.
/// A stacked frame keeps the annotation on ╭╮ and moves shortcuts to the ├┤ join.
/// `hotkeys_bottom` parks shortcuts on ╰╯. Non-interactive drafts whisper; `read_only` does not.
pub fn chrome_frame_paint_ops(frame: &ChromeFrame, rect: Rect) -> ChromePaint {
    let geom = measure_chrome_frame(frame, rect.w, rect.h);
    let w = rect.w.min(geom.outer_w);
    let max_rows = rect.h.max(1);
    let omit_top = frame.omit_top;
    let join_hint = frame.join_bottom && chrome_frame_has_hint(frame);
    let contour_p = contour_prominence_of(frame);
    let chrome_top = if omit_top { 0 } else { 1 };
    let line_count = geom.body_lines.len() as i64;
    let chrome_min = chrome_top + 1;
    let body_budget = if max_rows <= chrome_min {
        (max_rows - chrome_top).max(0)
    } else {
        line_count.min(max_rows - chrome_min)
    };
    let body_h = if max_rows <= chrome_top {
        0
    } else if max_rows == chrome_top + 1 {
        1.min(line_count)
    } else {
        body_budget.max(if omit_top { 0 } else { 1 })
    };
    let mut ops = Vec::new();
    let hotkeys_on_top = !join_hint && !frame.hotkeys_bottom;
    if !omit_top {
        let top = if !frame.top_segs.is_empty() {
            let content: Vec<ChromeSeg> = frame.top_segs.iter().map(spec_to_seg).collect();
            chrome_frame_top_from_content_segs(
                w,
                &content,
                frame.contour_role.as_deref(),
                Some(contour_p),
            )
        } else {
            chrome_frame_top_segs(
                w,
                if hotkeys_on_top {
                    frame.hotkeys.as_slice()
                } else {
                    &[]
                },
                &ChromeTopOpts {
                    join: frame.join_top,
                    annotation: frame.annotation.clone(),
                    annotation_role: frame.annotation_role.clone(),
                    contour_role: frame.contour_role.clone(),
                    contour_prominence: Some(contour_p),
                    mod_held: frame.mod_held,
                    ..ChromeTopOpts::default()
                },
            )
        };
        ops.extend(segs_to_paint_ops(&top, rect.x, rect.y, w));
    }
    let body_y0 = rect.y + chrome_top;
    let placeholder = is_chrome_frame_showing_placeholder(frame);
    let (draft, completion, draft_len) = paint_source(frame);
    let with_starts = if placeholder {
        None
    } else {
        Some(chrome_frame_paint_body_lines(&draft, &completion, w))
    };
    for i in 0..body_h {
        let row = i as usize;
        let right_coverage = coverage_at(frame, i);
        if frame.body_seg_rows.get(row).is_some() {
            let content: Vec<ChromeSeg> =
                frame.body_seg_rows[row].iter().map(spec_to_seg).collect();
            let row_glyph = chrome_frame_row_glyph(frame, i, &geom.glyph);
            let segs = chrome_frame_body_from_content_segs(
                &content,
                w,
                &ChromeBodyContentOpts {
                    glyph: Some(row_glyph),
                    right_coverage,
                    contour_role: frame.contour_role.clone(),
                    contour_prominence: Some(contour_p),
                },
            );
            ops.extend(segs_to_paint_ops(&segs, rect.x, body_y0 + i, w));
        } else {
            let row_info = with_starts.as_ref().and_then(|lines| lines.get(row));
            let line = row_info
                .map(|info| info.text.as_str())
                .or_else(|| geom.body_lines.get(row).map(String::as_str))
                .unwrap_or(" ");
            let (sel_a, sel_b) = match (frame.cursor, frame.mark) {
                (Some(cursor), Some(mark)) if cursor != mark => {
                    (Some(cursor.min(mark)), Some(cursor.max(mark)))
                }
                _ => (None, None),
            };
            let segs = chrome_frame_body_row_segs(
                line,
                i,
                w,
                &geom.glyph,
                &ChromeBodyRowOpts {
                    placeholder,
                    line_start: if placeholder {
                        None
                    } else {
                        row_info.map(|info| info.start)
                    },
                    sel_a,
                    sel_b,
                    draft_length: if placeholder { None } else { Some(draft_len) },
                    right_coverage,
                    contour_role: frame.contour_role.clone(),
                    contour_prominence: Some(contour_p),
                },
            );
            ops.extend(segs_to_paint_ops(&segs, rect.x, body_y0 + i, w));
        }
    }
    let bot_y = body_y0 + body_h;
    let mut progress_hit = Rect::new(rect.x + 1, bot_y, (w - 2).max(0), 1);
    let bottom_painted = bot_y < rect.y + max_rows;
    if bottom_painted {
        let bottom = if join_hint {
            chrome_frame_top_segs(
                w,
                &frame.hotkeys,
                &ChromeTopOpts {
                    join: true,
                    annotation: frame.join_annotation.clone(),
                    annotation_role: frame.join_annotation_role.clone(),
                    contour_role: frame.contour_role.clone(),
                    contour_prominence: Some(contour_p),
                    mod_held: frame.mod_held,
                    ..ChromeTopOpts::default()
                },
            )
        } else if frame.hotkeys_bottom {
            chrome_frame_top_segs(
                w,
                &frame.hotkeys,
                &ChromeTopOpts {
                    bottom: true,
                    contour_role: frame.contour_role.clone(),
                    contour_prominence: Some(contour_p),
                    mod_held: frame.mod_held,
                    ..ChromeTopOpts::default()
                },
            )
        } else {
            chrome_frame_bottom_segs(
                w,
                &ChromeBottomOpts {
                    progress: frame.progress,
                    progress_role: frame.progress_role.clone(),
                    progress_glow_at: frame.progress_glow_at,
                    status_items: frame.status_items.clone(),
                    quota_windows: frame.quota_windows.clone(),
                    context_used: frame.context_used,
                    context_limit: frame.context_limit,
                    mod_held: frame.mod_held,
                    join: frame.join_bottom,
                    plain: frame.plain_bottom,
                    contour_role: frame.contour_role.clone(),
                    contour_prominence: Some(contour_p),
                    ..ChromeBottomOpts::default()
                },
            )
        };
        if bottom.len() >= 2 {
            let middle = &bottom[1..bottom.len() - 1];
            let right_w = (segs_width(middle) - (w - 2)).max(0);
            progress_hit.w = (w - 2 - right_w).max(0);
        }
        ops.extend(segs_to_paint_ops(&bottom, rect.x, bot_y, w));
    }
    let body_hit = Rect::new(
        rect.x + chrome_frame_text_inset(),
        body_y0,
        chrome_frame_content_width(w),
        body_h.max(1),
    );
    if frame.interactive == Some(false) && !frame.read_only {
        let body_y1 = body_y0 + body_h;
        for op in &mut ops {
            if let ChromePaintOp::Text { rect, style, .. } = op {
                if rect.y >= body_y0 && rect.y < body_y1 {
                    style.prominence = Some(FgP::WHISPER);
                }
            }
        }
    }
    let painted_body = if body_h == 0 { 1 } else { body_h };
    ChromePaint {
        ops,
        body_hit,
        progress_hit,
        geom: ChromeFrameGeom {
            outer_w: w,
            body_h: painted_body,
            total_h: chrome_top + painted_body + if bottom_painted { 1 } else { 0 },
            ..geom
        },
    }
}

/// Axis-aligned intersection. `None` when the overlap is empty or disjoint.
pub fn intersect_rects(a: Rect, b: Rect) -> Option<Rect> {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = a.x.saturating_add(a.w).min(b.x.saturating_add(b.w));
    let y2 = a.y.saturating_add(a.h).min(b.y.saturating_add(b.h));
    if x2 <= x1 || y2 <= y1 {
        return None;
    }
    Some(Rect::new(x1, y1, x2 - x1, y2 - y1))
}

fn kind_of(user_select: UserSelect) -> u8 {
    match user_select {
        UserSelect::None => CHROME,
        UserSelect::Text | UserSelect::All | UserSelect::Contain => SELECTABLE,
        UserSelect::Auto => OPAQUE,
    }
}

fn is_leaf_content(hit: &MaskHit) -> bool {
    match hit.user_select {
        UserSelect::Contain | UserSelect::All => true,
        UserSelect::Text => hit.element_kind.as_deref() == Some("text"),
        UserSelect::None | UserSelect::Auto => false,
    }
}

fn cell_index(origin: Rect, cols: i64, x: i64, y: i64) -> Option<usize> {
    if x < origin.x || y < origin.y || cols <= 0 {
        return None;
    }
    let dx = x - origin.x;
    let dy = y - origin.y;
    if dx >= cols || dy >= origin.h {
        return None;
    }
    (dy as usize)
        .checked_mul(cols as usize)?
        .checked_add(dx as usize)
}

fn for_each_cell(region: Rect, bounds: Rect, mut visit: impl FnMut(i64, i64)) {
    let y0 = region.y.max(bounds.y);
    let y1 = region
        .y
        .saturating_add(region.h)
        .min(bounds.y.saturating_add(bounds.h));
    let x0 = region.x.max(bounds.x);
    let x1 = region
        .x
        .saturating_add(region.w)
        .min(bounds.x.saturating_add(bounds.w));
    let mut y = y0;
    while y < y1 {
        let mut x = x0;
        while x < x1 {
            visit(x, y);
            x += 1;
        }
        y += 1;
    }
}

/// Coverage over the inclusive cell bounds, clipped to `width` × `height`.
///
/// First writer in `hit_list` wins. `by_key` chrome (`user_select: none`) then
/// overwrites ancestors. Leaf content is stamped back on top of that chrome.
pub fn build_chrome_mask(
    frame: &MaskFrame,
    tl_col: i64,
    tl_row: i64,
    br_col: i64,
    br_row: i64,
    width: i64,
    height: i64,
) -> CoverageMask {
    let origin_x = tl_col.max(0);
    let origin_y = tl_row.max(0);
    let right = br_col.min(width.saturating_sub(1));
    let bottom = br_row.min(height.saturating_sub(1));
    let cols = (right - origin_x + 1).max(0);
    let rows = (bottom - origin_y + 1).max(0);
    if cols <= 0 || rows <= 0 {
        return no_chrome();
    }
    let Some(len) = (cols as usize).checked_mul(rows as usize) else {
        return no_chrome();
    };
    let bounds = Rect::new(origin_x, origin_y, cols, rows);
    let mut state = vec![UNCLAIMED; len];
    let mut keys = vec![String::new(); len];
    let write = |state: &mut [u8],
                 keys: &mut [String],
                 region: Rect,
                 kind: u8,
                 key: &str,
                 overwrite: bool| {
        for_each_cell(region, bounds, |x, y| {
            let Some(index) = cell_index(bounds, cols, x, y) else {
                return;
            };
            if !overwrite && state[index] != UNCLAIMED {
                return;
            }
            state[index] = kind;
            keys[index] = if kind == SELECTABLE {
                key.to_string()
            } else {
                String::new()
            };
        });
    };
    for hit in &frame.hit_list {
        if hit.phantom {
            continue;
        }
        let Some(overlap) = intersect_rects(hit.hit_rect, bounds) else {
            continue;
        };
        let kind = kind_of(hit.user_select);
        let key = if kind == SELECTABLE {
            hit.key.as_str()
        } else {
            ""
        };
        write(&mut state, &mut keys, overlap, kind, key, false);
    }
    for hit in &frame.by_key {
        if hit.phantom || hit.user_select != UserSelect::None {
            continue;
        }
        let Some(overlap) = intersect_rects(hit.hit_rect, bounds) else {
            continue;
        };
        write(&mut state, &mut keys, overlap, CHROME, "", true);
    }
    for hit in &frame.hit_list {
        if hit.phantom || !is_leaf_content(hit) {
            continue;
        }
        let Some(overlap) = intersect_rects(hit.hit_rect, bounds) else {
            continue;
        };
        write(&mut state, &mut keys, overlap, SELECTABLE, &hit.key, true);
    }
    CoverageMask {
        origin_x,
        origin_y,
        cols,
        rows,
        state,
        keys,
    }
}

/// How many picker rows stay on screen when the caller omits a viewport.
pub const COMPOSER_COMMAND_MAX_VISIBLE: i64 = 8;

/// One slash-picker or choice row. An empty `key` is assigned at paint time.
#[derive(Clone, Debug)]
pub struct PickerRow {
    pub key: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub annotation: Option<String>,
    pub description: Option<String>,
    pub href: Option<String>,
}

impl PickerRow {
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            key: None,
            name: name.into(),
            status: None,
            annotation: None,
            description: None,
            href: None,
        }
    }
}

/// Scroll and hover for [`paint_picker`]. `None` viewport is eight rows.
pub struct PickerPaintInput<'a> {
    pub rows: &'a [PickerRow],
    pub selected_key: Option<&'a str>,
    pub scroll_offset: i64,
    pub hover_key: Option<&'a str>,
    pub press_key: Option<&'a str>,
    pub viewport: Option<i64>,
    pub text_w: Option<i64>,
}

/// Body rows for a chrome frame. Geometry stays [`chrome_frame_paint_ops`].
#[derive(Clone, Debug)]
pub struct PickerPaint {
    pub body_seg_rows: Vec<Vec<ChromeSegSpec>>,
    pub body_glyphs: Vec<Option<String>>,
    pub body_right_coverage: Vec<Option<f64>>,
    pub paint_row_to_key: Vec<Option<String>>,
    pub selected_index: i64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NameKind {
    Selected,
    PressFull,
    Half,
    Idle,
}

/// Command list for a chrome frame. The selected row's mark is `›`.
pub fn paint_picker(input: &PickerPaintInput<'_>) -> PickerPaint {
    let keyed = keyed_rows(input.rows);
    let n = keyed.len() as i64;
    let viewport = input.viewport.unwrap_or(COMPOSER_COMMAND_MAX_VISIBLE).max(0);
    let text_w = input.text_w.unwrap_or(40).max(1);
    let max_s = (n - viewport).max(0);
    let scroll = input.scroll_offset.clamp(0, max_s);
    let start = scroll.max(0) as usize;
    let end = (scroll + viewport).max(0) as usize;
    let visible = if start >= keyed.len() {
        &[][..]
    } else {
        &keyed[start..end.min(keyed.len())]
    };
    let coverage = thumb_coverage(n, viewport, scroll);
    let selected_index = match input.selected_key {
        Some(key) => keyed
            .iter()
            .position(|(row_key, _)| row_key == key)
            .map(|index| index as i64)
            .unwrap_or(-1),
        None => -1,
    };
    let mut body_seg_rows = Vec::new();
    let mut body_glyphs = Vec::new();
    let mut body_right_coverage = Vec::new();
    let mut paint_row_to_key = Vec::new();
    for (i, (key, row)) in visible.iter().enumerate() {
        let kind = name_kind(key, input);
        let name_lines = wrap_text(
            &row_display_name(row),
            &WrapOpts {
                width: text_w,
                white_space: WhiteSpace::Normal,
                ellipsis: None,
                line_clamp: None,
                measure: None,
            },
        );
        let name_lines = if name_lines.is_empty() {
            vec![" ".to_string()]
        } else {
            name_lines
        };
        for (li, line) in name_lines.iter().enumerate() {
            let glyph = if li == 0 && kind == NameKind::Selected {
                "›"
            } else {
                " "
            };
            let segs = if li == 0 && name_lines.len() == 1 {
                command_row_segs(row, text_w, kind)
            } else {
                vec![styled_seg(
                    if line.is_empty() { " " } else { line },
                    &name_style(kind),
                )]
            };
            body_glyphs.push(Some(glyph.to_string()));
            body_seg_rows.push(segs);
            let cell = if li == 0 {
                coverage.get(i).copied().unwrap_or(0.0)
            } else {
                0.0
            };
            body_right_coverage.push(Some(cell));
            paint_row_to_key.push(Some(key.clone()));
        }
        let href = row.href.as_deref().unwrap_or("").trim();
        if !href.is_empty() {
            body_glyphs.push(Some(" ".to_string()));
            body_seg_rows.push(link_row_segs(href, text_w));
            body_right_coverage.push(Some(0.0));
            paint_row_to_key.push(Some(key.clone()));
        }
    }
    PickerPaint {
        body_seg_rows,
        body_glyphs,
        body_right_coverage,
        paint_row_to_key,
        selected_index,
    }
}

/// Ask or queue text for a chrome frame. Same T-join as [`paint_picker`].
///
/// `viewport` `<= 0` shows every wrapped line. A positive viewport is the
/// window, and `scroll_offset` moves inside it. Numbered rows put the counter
/// on the first wrap of each line: the first line is primary, the rest ghost.
/// A language paints tokens when a run has color or weight. A cold or plain
/// language stays the muted lines.
pub struct StackedBodyInput<'a> {
    pub text: &'a str,
    pub lang: &'a str,
    pub numbered: bool,
    pub scroll_offset: i64,
    pub viewport: i64,
    pub text_w: i64,
}

/// Visible overlay rows. Glyphs are a space, or the queue counter.
pub struct StackedBodyPaint {
    pub body_seg_rows: Vec<Vec<ChromeSegSpec>>,
    pub body_glyphs: Vec<Option<String>>,
    pub body_right_coverage: Vec<Option<f64>>,
}

pub fn paint_stacked_body(input: &StackedBodyInput<'_>) -> StackedBodyPaint {
    let text_w = input.text_w.max(1);
    let (rows, glyphs) = if input.numbered {
        numbered_overlay_rows(input.text, text_w)
    } else if let Some(painted) = syntax_overlay_rows(input.text, input.lang, text_w) {
        painted
    } else {
        plain_overlay_rows(input.text, text_w)
    };
    window_overlay(rows, glyphs, input.viewport, input.scroll_offset)
}

fn plain_overlay_rows(text: &str, text_w: i64) -> (Vec<Vec<ChromeSegSpec>>, Vec<Option<String>>) {
    let mut lines = wrap_pre(text, text_w);
    if lines.is_empty() {
        lines.push(" ".to_string());
    }
    let mut rows = Vec::new();
    let mut glyphs = Vec::new();
    for line in lines {
        rows.push(vec![overlay_seg(if line.is_empty() { " " } else { &line }, false)]);
        glyphs.push(Some(" ".to_string()));
    }
    (rows, glyphs)
}

fn numbered_overlay_rows(text: &str, text_w: i64) -> (Vec<Vec<ChromeSegSpec>>, Vec<Option<String>>) {
    let mut rows = Vec::new();
    let mut glyphs = Vec::new();
    for (index, row) in text.split('\n').enumerate() {
        let mut lines = wrap_pre(row, text_w);
        if lines.is_empty() {
            lines.push(" ".to_string());
        }
        for (wrap_index, line) in lines.iter().enumerate() {
            rows.push(vec![overlay_seg(
                if line.is_empty() { " " } else { line },
                index == 0,
            )]);
            let glyph = if wrap_index == 0 {
                (index + 1).to_string()
            } else {
                " ".to_string()
            };
            glyphs.push(Some(glyph));
        }
    }
    if rows.is_empty() {
        rows.push(vec![overlay_seg(" ", false)]);
        glyphs.push(Some(" ".to_string()));
    }
    (rows, glyphs)
}

fn syntax_overlay_rows(
    text: &str,
    lang: &str,
    text_w: i64,
) -> Option<(Vec<Vec<ChromeSegSpec>>, Vec<Option<String>>)> {
    let lang = lang.trim();
    if lang.is_empty() {
        return None;
    }
    let source = text.strip_suffix('\n').unwrap_or(text);
    let painted = crate::syntax::highlight(source, lang);
    let colored = painted.iter().any(|line| {
        line.iter()
            .any(|run| run.color.is_some() || run.bold || run.italic)
    });
    if !colored {
        return None;
    }
    let mut rows = Vec::new();
    let mut glyphs = Vec::new();
    for line in &painted {
        for segs in wrap_token_runs(line, text_w) {
            let segs = if segs.is_empty() {
                vec![code_seg(" ")]
            } else {
                segs
            };
            rows.push(segs);
            glyphs.push(Some(" ".to_string()));
        }
    }
    if rows.is_empty() {
        None
    } else {
        Some((rows, glyphs))
    }
}

fn overlay_seg(text: &str, primary: bool) -> ChromeSegSpec {
    ChromeSegSpec {
        text: if text.is_empty() {
            " ".to_string()
        } else {
            text.to_string()
        },
        role: Some(if primary { "foreground" } else { "muted" }.to_string()),
        prominence: Some(if primary { FgP::PRIMARY } else { FgP::GHOST }),
        bold: None,
        dim: None,
        italic: None,
        underline: None,
        href: None,
        fg_rgb: None,
    }
}

fn code_seg(text: &str) -> ChromeSegSpec {
    ChromeSegSpec {
        text: if text.is_empty() {
            " ".to_string()
        } else {
            text.to_string()
        },
        role: Some("code".to_string()),
        prominence: Some(FgP::SECONDARY),
        bold: None,
        dim: None,
        italic: None,
        underline: None,
        href: None,
        fg_rgb: None,
    }
}

fn run_seg(run: &crate::syntax::TokenRun) -> ChromeSegSpec {
    let mut style = Style::default();
    crate::syntax::apply_run(&mut style, run);
    ChromeSegSpec {
        text: if run.text.is_empty() {
            " ".to_string()
        } else {
            run.text.clone()
        },
        role: Some("code".to_string()),
        prominence: Some(FgP::SECONDARY),
        bold: if run.bold { Some(true) } else { None },
        dim: None,
        italic: if run.italic { Some(true) } else { None },
        underline: None,
        href: None,
        fg_rgb: style.fg_rgb,
    }
}

fn wrap_token_runs(runs: &[crate::syntax::TokenRun], width: i64) -> Vec<Vec<ChromeSegSpec>> {
    let joined: String = runs.iter().map(|run| run.text.as_str()).collect();
    let lines = wrap_pre(&joined, width);
    if lines.is_empty() {
        return vec![Vec::new()];
    }
    // wrap_pre drops the hard newline. The next slice starts after that byte.
    let mut out = Vec::new();
    let mut offset = 0usize;
    let mut first = true;
    for line in &lines {
        if !first && joined.as_bytes().get(offset) == Some(&b'\n') {
            offset += 1;
        }
        first = false;
        let end = offset + line.len();
        out.push(slice_token_runs(runs, offset, end));
        offset = end;
    }
    out
}

fn slice_token_runs(runs: &[crate::syntax::TokenRun], start: usize, end: usize) -> Vec<ChromeSegSpec> {
    if end <= start {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for run in runs {
        let run_end = cursor + run.text.len();
        if run_end <= start {
            cursor = run_end;
            continue;
        }
        if cursor >= end {
            break;
        }
        let from = char_floor(&run.text, start.saturating_sub(cursor));
        let to = char_floor(&run.text, end.saturating_sub(cursor).min(run.text.len()));
        if to > from {
            let mut piece = run.clone();
            piece.text = run.text[from..to].to_string();
            out.push(run_seg(&piece));
        }
        cursor = run_end;
    }
    out
}

fn char_floor(text: &str, mut index: usize) -> usize {
    if index > text.len() {
        return text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn window_overlay(
    mut rows: Vec<Vec<ChromeSegSpec>>,
    mut glyphs: Vec<Option<String>>,
    viewport: i64,
    scroll_offset: i64,
) -> StackedBodyPaint {
    let n = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let viewport = if viewport <= 0 {
        n.max(1)
    } else {
        1.max(n.min(viewport))
    };
    let max_s = (n - viewport).max(0);
    let scroll = scroll_offset.clamp(0, max_s);
    let start = usize::try_from(scroll.max(0)).unwrap_or(0).min(rows.len());
    let end = usize::try_from((scroll + viewport).max(0))
        .unwrap_or(usize::MAX)
        .min(rows.len());
    let end = end.max(start);
    rows.truncate(end);
    if glyphs.len() > end {
        glyphs.truncate(end);
    }
    if start > 0 {
        rows.drain(..start);
        if glyphs.len() >= start {
            glyphs.drain(..start);
        }
    }
    while glyphs.len() < rows.len() {
        glyphs.push(Some(" ".to_string()));
    }
    let visible = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let coverage = thumb_coverage(n, visible, scroll);
    StackedBodyPaint {
        body_seg_rows: rows,
        body_glyphs: glyphs,
        body_right_coverage: coverage.into_iter().map(Some).collect(),
    }
}

fn keyed_rows(rows: &[PickerRow]) -> Vec<(String, &PickerRow)> {
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let key = row
                .key
                .as_ref()
                .filter(|key| !key.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("choice:{index}:{}", row.name));
            (key, row)
        })
        .collect()
}

fn name_kind(key: &str, input: &PickerPaintInput<'_>) -> NameKind {
    if input.selected_key.is_some_and(|selected| selected == key) {
        return NameKind::Selected;
    }
    if input.press_key.is_some_and(|press| press == key) && input.hover_key == input.press_key {
        return NameKind::PressFull;
    }
    if input.hover_key.is_some_and(|hover| hover == key) || input.press_key.is_some_and(|press| press == key) {
        return NameKind::Half;
    }
    NameKind::Idle
}

struct SegStyle {
    role: &'static str,
    prominence: f64,
    bold: bool,
}

fn name_style(kind: NameKind) -> SegStyle {
    match kind {
        NameKind::Selected | NameKind::PressFull => SegStyle {
            role: "foreground",
            prominence: FgP::PRIMARY,
            bold: true,
        },
        NameKind::Half => SegStyle {
            role: "muted",
            prominence: FgP::SECONDARY,
            bold: false,
        },
        NameKind::Idle => SegStyle {
            role: "muted",
            prominence: FgP::GHOST,
            bold: false,
        },
    }
}

fn desc_style(kind: NameKind) -> SegStyle {
    if kind == NameKind::Idle {
        SegStyle {
            role: "muted",
            prominence: FgP::GHOST,
            bold: false,
        }
    } else {
        SegStyle {
            role: "muted",
            prominence: FgP::SECONDARY,
            bold: false,
        }
    }
}

fn styled_seg(text: &str, style: &SegStyle) -> ChromeSegSpec {
    ChromeSegSpec {
        text: text.to_string(),
        role: Some(style.role.to_string()),
        prominence: Some(style.prominence),
        bold: if style.bold { Some(true) } else { None },
        dim: None,
        italic: None,
        underline: None,
        href: None,
        fg_rgb: None,
    }
}

fn row_display_name(row: &PickerRow) -> String {
    let mut name = row.name.clone();
    let annotation = row.annotation.as_deref().unwrap_or("").trim();
    if !annotation.is_empty() {
        name = format!("{name} · {annotation}");
    }
    let status = row.status.as_deref().unwrap_or("").trim();
    if !status.is_empty() {
        name = format!("{name} · {status}");
    }
    if name.is_empty() {
        " ".to_string()
    } else {
        name
    }
}

fn command_row_segs(row: &PickerRow, text_w: i64, kind: NameKind) -> Vec<ChromeSegSpec> {
    let left = name_style(kind);
    let right_style = desc_style(kind);
    let dim = SegStyle {
        role: "muted",
        prominence: FgP::GHOST,
        bold: false,
    };
    let mut name = row_display_name(row);
    let description = row.description.as_deref().unwrap_or("").trim().to_string();
    let mut right = if !description.is_empty() && description != row.name {
        description
    } else {
        String::new()
    };
    let min_gap = 1i64;
    let mut used = char_len(&name);
    if !right.is_empty() {
        used += min_gap + char_len(&right);
    }
    if used > text_w && !right.is_empty() {
        let room = text_w - char_len(&name) - min_gap;
        right = if room > 0 {
            take_chars(&right, room)
        } else {
            String::new()
        };
        used = char_len(&name) + if right.is_empty() { 0 } else { min_gap + char_len(&right) };
    }
    if used > text_w {
        while char_len(&name) > text_w && !name.is_empty() {
            name.pop();
        }
        right.clear();
    }
    let mut segs = vec![styled_seg(if name.is_empty() { " " } else { &name }, &left)];
    if !right.is_empty() {
        let gap = min_gap.max(text_w - char_len(&name) - char_len(&right));
        let spaces = " ".repeat(usize::try_from(gap).unwrap_or(0));
        segs.push(styled_seg(&spaces, &dim));
        segs.push(styled_seg(&right, &right_style));
    }
    segs
}

fn link_row_segs(href: &str, text_w: i64) -> Vec<ChromeSegSpec> {
    let mut label = href.to_string();
    if char_len(&label) > text_w {
        label = if text_w <= 1 {
            "…".to_string()
        } else {
            format!("{}…", take_chars(&label, text_w - 1))
        };
    }
    let mut seg = styled_seg(if label.is_empty() { " " } else { &label }, &name_style(NameKind::Idle));
    seg.role = Some("accent".to_string());
    seg.underline = Some(true);
    seg.href = Some(href.to_string());
    vec![seg]
}

fn char_len(text: &str) -> i64 {
    i64::try_from(text.chars().count()).unwrap_or(i64::MAX)
}

fn take_chars(text: &str, n: i64) -> String {
    if n <= 0 {
        return String::new();
    }
    text.chars().take(n as usize).collect()
}

pub(crate) fn thumb_coverage(n: i64, viewport: i64, scroll_offset: i64) -> Vec<f64> {
    let viewport = viewport.max(0);
    let mut coverage = vec![0.0; usize::try_from(viewport).unwrap_or(0)];
    if n <= viewport || viewport <= 0 {
        return coverage;
    }
    let max_s = n - viewport;
    let scroll = scroll_offset.clamp(0, max_s);
    let start_num = scroll * (viewport - 1);
    let end_num = start_num + max_s;
    for i in 0..viewport {
        let lo = start_num.max(i * max_s);
        let hi = end_num.min((i + 1) * max_s);
        coverage[i as usize] = (hi - lo).max(0) as f64 / max_s as f64;
    }
    coverage
}
