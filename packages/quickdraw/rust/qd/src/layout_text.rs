//! Text wrap and the display-column measure of one text node.
//!
//! [`wrap_text`] is the only wrap, ellipsis, and line clamp. [`WrapOpts`] is its
//! input: a column budget, a [`WhiteSpace`] mode, an optional ellipsis flag, an
//! optional line clamp, and an optional measure. `measure: None` calls
//! [`crate::measure::display_width`]. A custom measure is used for fit checks
//! and for ellipsis; [`split_at_width`] always measures with `display_width`,
//! matching `splitAtWidth` in `measure/index.ts`.
//!
//! [`WrapOpts::width`] below 1 is treated as 1 inside [`wrap_text`]
//! (`Math.max(1, opts.width)` for an integer budget). Edge spaces are kept.
//! Nothing is trimmed. `normal` and `pre-line` collapse runs of U+0020 and
//! U+0009 only.
//!
//! White space (terminal, not full CSS):
//! - [`WhiteSpace::Normal`] — collapse space/tab runs inside a line; hard
//!   newlines stay breaks.
//! - [`WhiteSpace::Nowrap`] — one line; each newline becomes a space. Ellipsis
//!   only when [`WrapOpts::ellipsis`] is `Some(true)`. A cluster wider than the
//!   budget is dropped, not forced onto the line.
//! - [`WhiteSpace::PreWrap`] — keep every space and hard newline; soft-wrap on
//!   columns. A break prefers the last space in the fitted head.
//! - [`WhiteSpace::PreLine`] — same collapse as normal. Hard newlines stay.
//!
//! Line clamp: `None` or `<= 0` keeps every line. A clamp that drops lines
//! appends `…` unless ellipsis is `Some(false)`. `None` still ellipsizes a
//! clamp (TypeScript `opts.ellipsis !== false`) and does not ellipsize nowrap.
//!
//! ASCII and other unit-width runs (printable ASCII, box/block U+2500–U+259F)
//! are sliced by scalar. They do not build a grapheme iterator. Wide text uses
//! [`display_width`] and extended grapheme clusters.
//!
//! [`wrap_layout_text`] wraps a [`TextNode`] and reports [`WrappedText::max_line`],
//! the widest display column among the lines. [`measure_text_node`] is the
//! `type: "text"` arm of `measureNode`, including the `measured.atW` stamp that
//! sits in front of that arm. A caller-owned [`WrapMemo`] keeps eight widths
//! for one content key. Unset, the walk wraps every time.
//!
//! Ellipsis prefixes are Unicode scalar boundaries. That matches JavaScript
//! `slice` on BMP text (every oracle string). A lone UTF-16 surrogate is not
//! representable here.

use std::cell::RefCell;

use unicode_segmentation::UnicodeSegmentation;

use crate::measure::{display_width, is_unit_width_run};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WhiteSpace {
    Normal,
    Nowrap,
    /// `"pre-wrap"`.
    PreWrap,
    /// `"pre-line"`.
    PreLine,
}

/// Options for [`wrap_text`].
///
/// `ellipsis` and `line_clamp` use `Option` because TypeScript `undefined` is
/// not the same as `false` / `0` on every path. `None` means the field was
/// omitted. `measure: None` means [`display_width`].
#[derive(Clone, Copy)]
pub struct WrapOpts<'a> {
    /// Requested columns. Values below 1 become 1 before wrapping.
    pub width: i64,
    /// Defaults to [`WhiteSpace::Normal`] from [`WrapOpts::new`].
    pub white_space: WhiteSpace,
    /// `Some(true)` / `Some(false)` / omitted (`None`).
    pub ellipsis: Option<bool>,
    /// `Some(n)` with `n > 0` keeps at most `n` lines. `None` and `<= 0` do not clamp.
    pub line_clamp: Option<i64>,
    /// Fit and ellipsis measure. `None` is [`display_width`]. Not used by [`split_at_width`].
    pub measure: Option<&'a dyn Fn(&str) -> usize>,
}

impl<'a> WrapOpts<'a> {
    /// Integer column budget, normal white space, no clamp, default measure.
    pub fn new(width: i64) -> Self {
        Self {
            width,
            white_space: WhiteSpace::Normal,
            ellipsis: None,
            line_clamp: None,
            measure: None,
        }
    }
}

impl std::fmt::Debug for WrapOpts<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WrapOpts")
            .field("width", &self.width)
            .field("white_space", &self.white_space)
            .field("ellipsis", &self.ellipsis)
            .field("line_clamp", &self.line_clamp)
            .field(
                "measure",
                &self.measure.map(|_| "custom").unwrap_or("display_width"),
            )
            .finish()
    }
}

const ELLIPSIS: &str = "…";

/// One layout text node, the fields [`wrap_text`] and [`measure_text_node`] read.
///
/// `measured` is ignored by [`wrap_layout_text`]. It is the `measureNode` stamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextNode<'a> {
    pub content: &'a str,
    pub white_space: Option<WhiteSpace>,
    pub ellipsis: Option<bool>,
    pub line_clamp: Option<i64>,
    pub measured: Option<MeasuredStamp>,
}

/// `node.measured` from `measureNode`. `at_w` is the TypeScript `atW`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeasuredStamp {
    pub w: i64,
    pub h: i64,
    pub at_w: i64,
}

/// Lines from one wrap, plus the widest display column among them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrappedText {
    pub lines: Vec<String>,
    /// Widest `measure(line)`. Zero when every line is empty.
    pub max_line: usize,
}

/// `measureNode` result for a text node. Integer cell units.
///
/// The stamp hit runs through `clamp0`. The recompute arm does not: a negative
/// `max_w` / `max_h` stays negative, matching `Math.min` in the text arm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextExtent {
    pub w: i64,
    pub h: i64,
}

fn column_width(width: i64) -> usize {
    if width < 1 {
        1
    } else {
        usize::try_from(width).unwrap_or(usize::MAX)
    }
}

fn measure_text(measure: Option<&dyn Fn(&str) -> usize>, text: &str) -> usize {
    match measure {
        Some(measure) => measure(text),
        None => display_width(text),
    }
}

fn as_i64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn clamp0(n: i64) -> i64 {
    n.max(0)
}

/// Collapse U+0020 / U+0009 runs to a single space. Every other scalar stays.
fn collapse_space_tab(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_run = false;
    for c in line.chars() {
        if c == ' ' || c == '\t' {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

fn newlines_to_spaces(content: &str) -> String {
    if !content.contains('\n') {
        return content.to_string();
    }
    let mut out = String::with_capacity(content.len());
    for c in content.chars() {
        out.push(if c == '\n' { ' ' } else { c });
    }
    out
}

/// Split `text` so `head` fits in `max_columns` display columns.
///
/// Never splits a grapheme cluster. `max_columns <= 0` yields an empty head.
/// A unit-width run is sliced by scalar and does not build a grapheme iterator.
/// Width is always [`display_width`], never a [`WrapOpts`] measure.
pub fn split_at_width(text: &str, max_columns: i64) -> (&str, &str) {
    if max_columns <= 0 {
        return ("", text);
    }
    let max_columns = usize::try_from(max_columns).unwrap_or(usize::MAX);
    if is_unit_width_run(text) {
        let mut end = 0;
        let mut count = 0;
        for c in text.chars() {
            if count == max_columns {
                break;
            }
            end += c.len_utf8();
            count += 1;
        }
        return (&text[..end], &text[end..]);
    }

    let mut used = 0usize;
    let mut head_end = 0usize;
    for (index, segment) in text.grapheme_indices(true) {
        let w = display_width(segment);
        if used + w > max_columns {
            return (&text[..head_end], &text[head_end..]);
        }
        used += w;
        head_end = index + segment.len();
    }
    (text, "")
}

/// First grapheme cluster, kept whole even when it is wider than one column.
///
/// A unit-width run returns the first scalar and does not build a grapheme iterator.
/// Empty input returns two empty slices.
pub fn take_grapheme(text: &str) -> (&str, &str) {
    if text.is_empty() {
        return ("", "");
    }
    if is_unit_width_run(text) {
        let ch = text.chars().next().expect("unit-width run is non-empty");
        let end = ch.len_utf8();
        return (&text[..end], &text[end..]);
    }
    let cluster = text
        .graphemes(true)
        .next()
        .expect("non-empty text has a grapheme");
    let end = cluster.len();
    (&text[..end], &text[end..])
}

/// `prefix + "…"` at a scalar boundary, cut from the end until it fits.
/// At a zero-length prefix the ellipsis is kept even when it is still wider.
fn fit_with_ellipsis(line: &str, width: usize, measure: Option<&dyn Fn(&str) -> usize>) -> String {
    let mut end = line.len();
    loop {
        let prefix = &line[..end];
        let mut candidate = String::with_capacity(prefix.len() + ELLIPSIS.len());
        candidate.push_str(prefix);
        candidate.push_str(ELLIPSIS);
        if end == 0 || measure_text(measure, &candidate) <= width {
            return candidate;
        }
        let Some((prev, _)) = prefix.char_indices().next_back() else {
            return ELLIPSIS.to_string();
        };
        end = prev;
    }
}

fn soft_wrap_exact(
    line: &str,
    width: usize,
    measure: Option<&dyn Fn(&str) -> usize>,
) -> Vec<String> {
    if line.is_empty() {
        return vec![String::new()];
    }
    if measure_text(measure, line) <= width {
        return vec![line.to_string()];
    }

    let mut lines = Vec::new();
    let mut start = 0usize;
    while start < line.len() {
        debug_assert!(line.is_char_boundary(start));
        let rest = &line[start..];
        if measure_text(measure, rest) <= width {
            lines.push(rest.to_string());
            break;
        }
        let (head, _) = split_at_width(rest, as_i64(width));
        if head.is_empty() {
            let cluster = take_grapheme(rest).0;
            if cluster.is_empty() {
                break;
            }
            lines.push(cluster.to_string());
            start += cluster.len();
            continue;
        }
        if let Some(sp) = head.rfind(' ') {
            if sp + 1 < head.len() {
                lines.push(head[..=sp].to_string());
                start += sp + 1;
                continue;
            }
            if head.len() > 1 {
                lines.push(head.to_string());
                start += head.len();
                continue;
            }
        }
        lines.push(head.to_string());
        start += head.len();
    }
    if lines.is_empty() {
        vec![String::new()]
    } else {
        lines
    }
}

fn soft_wrap_collapsed(
    line: &str,
    width: usize,
    measure: Option<&dyn Fn(&str) -> usize>,
) -> Vec<String> {
    let collapsed = collapse_space_tab(line);
    if collapsed.is_empty() {
        return vec![String::new()];
    }
    if measure_text(measure, &collapsed) <= width {
        return vec![collapsed];
    }

    let parts: Vec<&str> = collapsed.split(' ').collect();
    let mut lines = Vec::new();
    let mut cur: Vec<&str> = Vec::new();

    for part in parts {
        let candidate = if cur.is_empty() {
            part.to_string()
        } else {
            let mut trial = cur.join(" ");
            trial.push(' ');
            trial.push_str(part);
            trial
        };
        if measure_text(measure, &candidate) <= width {
            cur.push(part);
            continue;
        }
        if !cur.is_empty() {
            lines.push(cur.join(" "));
            cur.clear();
        }
        if measure_text(measure, part) <= width {
            cur.push(part);
            continue;
        }
        let mut at = 0usize;
        while measure_text(measure, &part[at..]) > width {
            let rest = &part[at..];
            let (head, _) = split_at_width(rest, as_i64(width));
            if head.is_empty() {
                let cluster = take_grapheme(rest).0;
                if cluster.is_empty() {
                    break;
                }
                lines.push(cluster.to_string());
                at += cluster.len();
            } else {
                lines.push(head.to_string());
                at += head.len();
            }
        }
        if at < part.len() {
            cur.push(&part[at..]);
        }
    }
    if !cur.is_empty() {
        lines.push(cur.join(" "));
    }
    if lines.is_empty() {
        vec![String::new()]
    } else {
        lines
    }
}

fn apply_clamp(
    mut lines: Vec<String>,
    ellipsis: Option<bool>,
    line_clamp: Option<i64>,
    width: usize,
    measure: Option<&dyn Fn(&str) -> usize>,
) -> Vec<String> {
    let clamp = line_clamp.unwrap_or(0);
    if clamp <= 0 || lines.len() as i64 <= clamp {
        if lines.is_empty() {
            return vec![String::new()];
        }
        return lines;
    }
    let keep = usize::try_from(clamp).unwrap_or(usize::MAX);
    lines.truncate(keep);
    if ellipsis != Some(false) {
        let last = lines.last().map(String::as_str).unwrap_or("");
        let fitted = fit_with_ellipsis(last, width, measure);
        if let Some(slot) = lines.last_mut() {
            *slot = fitted;
        }
    }
    lines
}

fn wrap_nowrap(
    content: &str,
    width: usize,
    ellipsis: Option<bool>,
    measure: Option<&dyn Fn(&str) -> usize>,
) -> Vec<String> {
    let line = newlines_to_spaces(content);
    if measure_text(measure, &line) <= width {
        return vec![line];
    }
    // `width` is already at least 1, matching `opts.ellipsis && width >= 1`.
    if ellipsis == Some(true) {
        return vec![fit_with_ellipsis(&line, width, measure)];
    }
    let (head, _) = split_at_width(&line, as_i64(width));
    if head.is_empty() {
        vec![String::new()]
    } else {
        vec![head.to_string()]
    }
}

/// Wrap `content` into display lines of at most [`WrapOpts::width`] columns.
///
/// Hard newlines break in every mode except [`WhiteSpace::Nowrap`]. See the
/// module comment for [`WrapOpts`] and the white-space modes.
pub fn wrap_text(content: &str, opts: &WrapOpts<'_>) -> Vec<String> {
    let width = column_width(opts.width);
    let measure = opts.measure;
    if opts.white_space == WhiteSpace::Nowrap {
        return wrap_nowrap(content, width, opts.ellipsis, measure);
    }
    let mut out = Vec::new();
    for hard in content.split('\n') {
        if opts.white_space == WhiteSpace::PreWrap {
            out.extend(soft_wrap_exact(hard, width, measure));
        } else {
            out.extend(soft_wrap_collapsed(hard, width, measure));
        }
    }
    apply_clamp(out, opts.ellipsis, opts.line_clamp, width, measure)
}

fn widest_line(lines: &[String], measure: Option<&dyn Fn(&str) -> usize>) -> usize {
    let mut max = 0usize;
    for line in lines {
        let width = measure_text(measure, line);
        if width > max {
            max = width;
        }
    }
    max
}

/// Caller-owned wrap cache. At most eight widths per content key.
/// A ninth width replaces the last slot. There is no process-wide map.
#[derive(Debug, Default)]
pub struct WrapMemo {
    slots: RefCell<Vec<MemoSlot>>,
}

#[derive(Clone, Debug)]
struct MemoSlot {
    content: String,
    white_space: WhiteSpace,
    ellipsis: Option<bool>,
    line_clamp: Option<i64>,
    token: Option<u64>,
    widths: Vec<WidthHit>,
}

#[derive(Clone, Debug)]
struct WidthHit {
    width: i64,
    lines: Vec<String>,
    max_line: usize,
}

impl WrapMemo {
    fn find(&self, node: &TextNode<'_>, token: Option<u64>, width: i64) -> Option<WrappedText> {
        let slots = self.slots.borrow();
        let slot = slots.iter().find(|slot| slot.matches(node, token))?;
        let hit = slot.widths.iter().find(|hit| hit.width == width)?;
        Some(WrappedText {
            lines: hit.lines.clone(),
            max_line: hit.max_line,
        })
    }

    fn store(&self, node: &TextNode<'_>, token: Option<u64>, width: i64, wrapped: &WrappedText) {
        let mut slots = self.slots.borrow_mut();
        let entry = WidthHit {
            width,
            lines: wrapped.lines.clone(),
            max_line: wrapped.max_line,
        };
        if let Some(slot) = slots.iter_mut().find(|slot| slot.matches(node, token)) {
            if let Some(hit) = slot.widths.iter_mut().find(|hit| hit.width == width) {
                *hit = entry;
                return;
            }
            if slot.widths.len() == 8 {
                let last = slot.widths.len() - 1;
                slot.widths[last] = entry;
            } else {
                slot.widths.push(entry);
            }
            return;
        }
        slots.push(MemoSlot {
            content: node.content.to_string(),
            white_space: node.white_space.unwrap_or(WhiteSpace::Normal),
            ellipsis: node.ellipsis,
            line_clamp: node.line_clamp,
            token,
            widths: vec![entry],
        });
    }
}

impl MemoSlot {
    fn matches(&self, node: &TextNode<'_>, token: Option<u64>) -> bool {
        self.content == node.content
            && self.white_space == node.white_space.unwrap_or(WhiteSpace::Normal)
            && self.ellipsis == node.ellipsis
            && self.line_clamp == node.line_clamp
            && self.token == token
    }
}

/// Wrap a text node at `width` and measure the widest line once.
///
/// `width` below 1 becomes 1. The returned `lines` vec is owned; callers may mutate it.
pub fn wrap_layout_text(
    node: &TextNode<'_>,
    width: i64,
    measure: Option<&dyn Fn(&str) -> usize>,
) -> WrappedText {
    wrap_cached(node, width, measure, None, None)
}

pub(crate) fn wrap_cached(
    node: &TextNode<'_>,
    width: i64,
    measure: Option<&dyn Fn(&str) -> usize>,
    memo: Option<&WrapMemo>,
    token: Option<u64>,
) -> WrappedText {
    let budget = as_i64(column_width(width));
    if let Some(memo) = memo {
        if let Some(hit) = memo.find(node, token, budget) {
            return hit;
        }
    }
    let opts = WrapOpts {
        width: budget,
        white_space: node.white_space.unwrap_or(WhiteSpace::Normal),
        ellipsis: node.ellipsis,
        line_clamp: node.line_clamp,
        measure,
    };
    let lines = wrap_text(node.content, &opts);
    let max_line = widest_line(&lines, measure);
    let wrapped = WrappedText { lines, max_line };
    if let Some(memo) = memo {
        memo.store(node, token, budget, &wrapped);
    }
    wrapped
}

/// Display-column measure of a text node: `{ w, h }` in cell units.
///
/// When `node.measured.at_w == max_w`, the stamp is returned through `clamp0`
/// and the string is not wrapped. Otherwise `w` is `min(max_w, max(1, max_line))`
/// and `h` is `min(max_h, lines.len())`, with no `clamp0`.
pub fn measure_text_node(
    node: &TextNode<'_>,
    max_w: i64,
    max_h: i64,
    measure: Option<&dyn Fn(&str) -> usize>,
) -> TextExtent {
    measure_text_cached(node, max_w, max_h, measure, None, None)
}

pub(crate) fn measure_text_cached(
    node: &TextNode<'_>,
    max_w: i64,
    max_h: i64,
    measure: Option<&dyn Fn(&str) -> usize>,
    memo: Option<&WrapMemo>,
    token: Option<u64>,
) -> TextExtent {
    if let Some(stamp) = node.measured {
        if stamp.at_w == max_w {
            return TextExtent {
                w: clamp0(max_w.min(stamp.w)),
                h: clamp0(max_h.min(stamp.h)),
            };
        }
    }
    let wrapped = wrap_cached(node, max_w, measure, memo, token);
    TextExtent {
        w: max_w.min(as_i64(wrapped.max_line.max(1))),
        h: max_h.min(as_i64(wrapped.lines.len())),
    }
}
