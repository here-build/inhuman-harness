//! Place and measure walk for a layout tree.
//!
//! [`layout`] is `layout` in `layout/engine.ts`: one viewport rect, then
//! [`place`](self) preorder. [`measure_tree`] is `measureNode` for the kinds
//! this walk knows. Text columns go through
//! [`crate::layout_text::measure_text_node`] / [`crate::layout_text::wrap_layout_text`].
//! Flex main sizes go through [`crate::layout_flex::resolve_flex_item`] and
//! [`crate::layout_flex::flex_main_sizes`]. Grid tracks go through
//! [`crate::layout_flex::resolve_column_tracks`], [`crate::layout_flex::track_offsets`],
//! and [`crate::layout_flex::tracks_extent`]. This module does not re-solve
//! free space.
//!
//! [`Frame::placed`] is the rect `pushHit` stored as `hitRect` (clipped box,
//! visible text, disclosure, indication, viewport). It is not a hit test:
//! `elementAt`, selection, and phantom flex/grid hits are not produced.
//! [`Frame::paint_order`] is paint order after sticky-top lifts move to the
//! end of their viewport. Region dim is the backdrop multiply (`0.4`), not a
//! theme-role lookup.
//!
//! A [`Node::Skipped`] is a raw node with no payload.
//! The walk measures it as `0×0` and paints nothing.
//! A [`Node::Chrome`] measures and paints through the chrome frame painter.
//! The session composer stays the present overlay.
//! [`Node::Markdown`] and [`Node::Diff`] expand only when [`set_realize`]
//! has installed an expander. [`measure_tree`] and [`place`] call that hook
//! first. When it is unset, those variants take the same `0×0` / no-paint
//! arm as [`Node::Skipped`]. [`crate::present`] installs the expander.
//! A direct call does not.

use std::sync::OnceLock;

use crate::layout_chrome::{
    chrome_frame_paint_ops, measure_chrome_frame, ChromeFrame, ChromeLive, ChromePaintOp,
    ChromeQuotaWindow, Rect as ChromeRect,
};
use crate::layout_flex::{
    cell_pad_xy, flex_main_sizes, resolve_column_tracks, resolve_flex_item, resolve_length,
    track_offsets, tracks_extent, Extent, FlexFactor, FlexItemStyle, FlexStyle, GridLines,
    GridStyle, JustifyContent, Length, Padding, Rect, ResolvedLength,
};
use crate::layout_text::{MeasuredStamp, TextNode, WhiteSpace};
use crate::measure::{display_width, is_two_column_symbol};
use crate::Style;

type Measure<'a> = Option<&'a dyn Fn(&str) -> usize>;

/// Cells before indication content: lead + gutter + gap.
pub const INDICATION_CONTENT_INSET: i64 = 3;

const UNBOUNDED_H: i64 = 10_000;
pub(crate) const BACKDROP_REGION_PROMINENCE: f64 = 0.4;
const GHOST_PROMINENCE: f64 = 0.42;

/// `{ w, h }` passed to [`layout`]. `w` and `h` below 1 become 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Viewport {
    pub w: i64,
    pub h: i64,
}

/// Optional measure and frame version. `measure: None` is [`display_width`].
pub struct LayoutOpts<'a> {
    pub measure: Measure<'a>,
    /// `frameVersion`. `None` is the walk's own counter, which starts at 1.
    pub frame_version: Option<i64>,
    /// `None` wraps every time. The caller owns the map for the layouts that share it.
    pub wrap_memo: Option<&'a mut crate::layout_text::WrapMemo>,
    /// Distinguishes two measure closures that must not share wrapped lines.
    pub measure_token: Option<u64>,
}

impl Default for LayoutOpts<'_> {
    fn default() -> Self {
        Self {
            measure: None,
            frame_version: None,
            wrap_memo: None,
            measure_token: None,
        }
    }
}

#[derive(Clone, Copy)]
struct Cache<'a> {
    memo: Option<&'a crate::layout_text::WrapMemo>,
    token: Option<u64>,
}

impl Cache<'_> {
    fn empty() -> Self {
        Self {
            memo: None,
            token: None,
        }
    }
}

/// One placed key. `rect` is the clipped rect `pushHit` would store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placed {
    pub key: String,
    pub rect: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiveDemand {
    pub max_hz: i64,
    pub spinners: i64,
    pub elapsed: i64,
    pub quota: i64,
    pub birth: i64,
}

impl LiveDemand {
    fn zero() -> Self {
        Self {
            max_hz: 0,
            spinners: 0,
            elapsed: 0,
            quota: 0,
            birth: 0,
        }
    }
}

/// Live decoration carried on a paint op. Hz is the present rate.
/// Birth `t` is the newest line's ink mass. The host steps the wavefront.
#[derive(Clone, Debug, PartialEq)]
pub enum LivePaint {
    Spinner {
        profile: SpinnerProfile,
        hz: i64,
    },
    Elapsed {
        hz: i64,
        started_at: f64,
        label: Option<String>,
        prefix: Option<String>,
    },
    Countdown {
        hz: i64,
        until_ms: f64,
    },
    Quota {
        hz: i64,
        windows: Vec<ChromeQuotaWindow>,
        prefix: Option<String>,
    },
    Birth {
        hz: i64,
        t: i64,
        offset: i64,
        site_id: String,
    },
}

impl LivePaint {
    fn hz(&self) -> i64 {
        match self {
            LivePaint::Spinner { hz, .. }
            | LivePaint::Elapsed { hz, .. }
            | LivePaint::Countdown { hz, .. }
            | LivePaint::Quota { hz, .. }
            | LivePaint::Birth { hz, .. } => *hz,
        }
    }
}

/// Spinner profile. Default on an omitted indication profile is working.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpinnerProfile {
    Thinking,
    Tool,
    Working,
}

/// Which indication rows carry the spinner. Omitted is top.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpinnerRows {
    Top,
    All,
}

/// `overflow`. Omitted is visible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overflow {
    Visible,
    Hidden,
    Clip,
    Auto,
    Scroll,
}

/// `overflowAnchor`. Omitted is auto (pin to the bottom).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum OverflowAnchor {
    #[default]
    Auto,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sticky {
    Top,
    Bottom,
}

/// Clip-squeeze pins. `head` / `tail` are child counts, not row counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SqueezePins {
    pub head: i64,
    pub tail: i64,
}

/// Box fields place and measure read, including flex factors for a flex child.
#[derive(Clone, Debug, PartialEq)]
pub struct BoxStyle {
    pub width: Option<Length>,
    pub height: Option<Length>,
    pub min_width: Option<Length>,
    pub min_height: Option<Length>,
    pub padding: Option<Padding>,
    pub border: bool,
    pub background: Option<Style>,
    pub overflow: Option<Overflow>,
    pub overflow_x: Option<Overflow>,
    pub overflow_y: Option<Overflow>,
    pub flex: Option<FlexFactor>,
    pub flex_grow: Option<f64>,
    pub flex_shrink: Option<f64>,
    pub flex_basis: Option<Length>,
    pub sticky: Option<Sticky>,
    pub squeeze: Option<SqueezePins>,
}

impl Default for BoxStyle {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            min_width: None,
            min_height: None,
            padding: None,
            border: false,
            background: None,
            overflow: None,
            overflow_x: None,
            overflow_y: None,
            flex: None,
            flex_grow: None,
            flex_shrink: None,
            flex_basis: None,
            sticky: None,
            squeeze: None,
        }
    }
}

/// Indication gutter. Glyphs are sliced to two scalars the way `slice(0, 2)`
/// slices BMP text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gutter {
    Top {
        glyph: String,
    },
    Rule {
        glyph: String,
    },
    Corners {
        top: String,
        mid: Option<String>,
        /// `None` or `""` means the closer is still open: the last row uses mid.
        bottom: Option<String>,
    },
    Spinner {
        profile: Option<SpinnerProfile>,
        rows: Option<SpinnerRows>,
    },
}

/// `indentation_exception` kind. Place does not branch on it; measure joins
/// the children either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndentKind {
    Diff,
    CodePad,
    RawFull,
}

/// Overlay-local origin. Wins over center.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Origin {
    pub x: i64,
    pub y: i64,
}

/// Unified, split, or the auto rule from `diff-expand.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DiffMode {
    #[default]
    Auto,
    Unified,
    Split,
}

/// How many unchanged lines stay around a change. `Lines` is the count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffContext {
    Lines(u32),
    All,
}

/// A layout node. The kind is the variant, not a string.
///
/// [`Node::Squeeze`] is a column whose children go through [`plan_squeeze`].
/// A [`Node::Box`] with [`BoxStyle::squeeze`] does the same after padding and
/// border, matching `style.squeeze` on a box. [`Node::Skipped`] does not paint.
#[derive(Clone, Debug)]
pub enum Node {
    Text {
        content: String,
        white_space: Option<WhiteSpace>,
        ellipsis: Option<bool>,
        line_clamp: Option<i64>,
        measured: Option<MeasuredStamp>,
        style: Style,
        key: Option<String>,
        live: Option<LivePaint>,
        region_prominence: Option<f64>,
    },
    Box {
        style: BoxStyle,
        children: Vec<Node>,
        key: Option<String>,
        id: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    Flex {
        style: FlexStyle,
        children: Vec<Node>,
        key: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    Grid {
        style: GridStyle,
        /// `lineStyle`. `None` is border / ghost, the engine default.
        line_style: Option<Style>,
        children: Vec<Node>,
        key: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    Indication {
        gutter: Gutter,
        children: Vec<Node>,
        style: Style,
        key: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    Overlay {
        center: bool,
        origin: Option<Origin>,
        backdrop: bool,
        backdrop_style: Option<Style>,
        children: Vec<Node>,
        key: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    Disclosure {
        /// `collapsed === false` is open. `true` shows `summary` only.
        collapsed: bool,
        summary: Box<Node>,
        children: Vec<Node>,
        key: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    /// Column placed with [`plan_squeeze`] in the rect it was given.
    Squeeze {
        head: i64,
        tail: i64,
        children: Vec<Node>,
        key: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    Viewport {
        id: String,
        key: Option<String>,
        children: Vec<Node>,
        anchor: OverflowAnchor,
        scroll: i64,
        width: Option<Length>,
        height: Option<Length>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    /// Transparent stack. Children keep their measured width; the clip is the
    /// parent's clip, not a fresh intersection. Needed so a squeeze nested
    /// under an ask-diff wrapper still peeks.
    IndentationException {
        kind: IndentKind,
        children: Vec<Node>,
        key: Option<String>,
        measured: Option<MeasuredStamp>,
        region_prominence: Option<f64>,
    },
    /// Markdown source. [`set_realize`] may replace it before measure.
    /// With no expander installed, measure is `0×0`.
    Markdown {
        text: String,
        key: Option<String>,
        width: Option<i64>,
    },
    /// Old and new file sides. Same expander rule as [`Node::Markdown`].
    /// `mode` and `context` of `None` use auto and three lines.
    Diff {
        old: String,
        new: String,
        path: Option<String>,
        key: Option<String>,
        width: i64,
        mode: Option<DiffMode>,
        context: Option<DiffContext>,
        /// Old-side origin. Values below 2 start at 1.
        line_start: i64,
        /// New-side origin. `None` uses `line_start`.
        new_line_start: Option<i64>,
        hide_header: bool,
    },
    /// Nested chrome frame. The session composer is the present overlay, not this node.
    Chrome {
        key: Option<String>,
        frame: ChromeFrame,
    },
    /// Raw node with no payload. No paint, no panic.
    Skipped,
}

/// One paint op. `style` is what the walk wrote. Theme roles are not resolved
/// to colors here.
#[derive(Clone, Debug, PartialEq)]
pub enum PaintOp {
    Text {
        rect: Rect,
        lines: Vec<String>,
        style: Style,
    },
    Border {
        rect: Rect,
        style: Style,
    },
    Fill {
        rect: Rect,
        style: Style,
    },
    Live {
        rect: Rect,
        style: Style,
        live: LivePaint,
        content: Option<String>,
    },
}

impl PaintOp {
    fn style_mut(&mut self) -> &mut Style {
        match self {
            PaintOp::Text { style, .. }
            | PaintOp::Border { style, .. }
            | PaintOp::Fill { style, .. }
            | PaintOp::Live { style, .. } => style,
        }
    }

    /// Borrowed style. Every op this walk emits has one.
    pub fn style(&self) -> &Style {
        match self {
            PaintOp::Text { style, .. }
            | PaintOp::Border { style, .. }
            | PaintOp::Fill { style, .. }
            | PaintOp::Live { style, .. } => style,
        }
    }

    pub fn rect(&self) -> Rect {
        match self {
            PaintOp::Text { rect, .. }
            | PaintOp::Border { rect, .. }
            | PaintOp::Fill { rect, .. }
            | PaintOp::Live { rect, .. } => *rect,
        }
    }
}

/// One scissored paint group.
#[derive(Clone, Debug, PartialEq)]
pub struct Positioned {
    pub key: String,
    pub rect: Rect,
    pub paint: Vec<PaintOp>,
    pub clip: Rect,
}

/// `layout()` result. `placed` is geometry, not `elementAt`.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub version: i64,
    pub paint_order: Vec<Positioned>,
    pub placed: Vec<Placed>,
    pub viewport: Viewport,
    pub live_demand: LiveDemand,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SqueezeSlot {
    Child { index: usize, y: i64, h: i64 },
    Omit { count: i64, y: i64, edge: OmitEdge },
}

/// Which omit label a squeeze slot is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OmitEdge {
    Above,
    Below,
    Mid,
}

impl OmitEdge {
    fn as_str(self) -> &'static str {
        match self {
            OmitEdge::Above => "above",
            OmitEdge::Below => "below",
            OmitEdge::Mid => "mid",
        }
    }
}

fn floor_nonneg_f64(n: f64) -> i64 {
    if !n.is_finite() {
        return 0;
    }
    let f = n.floor();
    if f <= 0.0 {
        0
    } else if f >= i64::MAX as f64 {
        i64::MAX
    } else {
        f as i64
    }
}

fn floor_f64_i64(n: f64) -> i64 {
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

fn floor_div(num: i64, den: i64) -> i64 {
    if den <= 0 {
        return 0;
    }
    let q = num / den;
    let r = num % den;
    if r != 0 && num < 0 {
        q - 1
    } else {
        q
    }
}

fn as_i64(n: i128) -> i64 {
    if n > i128::from(i64::MAX) {
        i64::MAX
    } else if n < i128::from(i64::MIN) {
        i64::MIN
    } else {
        n as i64
    }
}

fn add_i64(a: i64, b: i64) -> i64 {
    as_i64(i128::from(a) + i128::from(b))
}

fn sub_i64(a: i64, b: i64) -> i64 {
    as_i64(i128::from(a) - i128::from(b))
}

fn clamp0_i64(n: i64) -> i64 {
    n.max(0)
}

fn clamp_extent(max: i64, v: f64) -> i64 {
    let v = if v.is_finite() { v } else { 0.0 };
    floor_nonneg_f64((max as f64).min(v))
}

fn usize_from_i64(n: i64) -> usize {
    if n <= 0 {
        0
    } else {
        usize::try_from(n).unwrap_or(usize::MAX)
    }
}

struct Pad {
    t: i64,
    r: i64,
    b: i64,
    l: i64,
}

fn pad_edges(padding: Option<Padding>) -> Pad {
    match padding {
        None => Pad {
            t: 0,
            r: 0,
            b: 0,
            l: 0,
        },
        Some(Padding::Uniform(n)) => {
            let n = clamp0_i64(n);
            Pad {
                t: n,
                r: n,
                b: n,
                l: n,
            }
        }
        Some(Padding::Edges { t, r, b, l }) => Pad {
            t: t.unwrap_or(0).max(0),
            r: r.unwrap_or(0).max(0),
            b: b.unwrap_or(0).max(0),
            l: l.unwrap_or(0).max(0),
        },
    }
}

fn chrome_line_style() -> Style {
    Style {
        role: Some("border".to_string()),
        prominence: Some(GHOST_PROMINENCE),
        ..Style::default()
    }
}

fn type_name(node: &Node) -> &'static str {
    match node {
        Node::Text { .. } => "text",
        Node::Box { .. } => "box",
        Node::Flex { .. } => "flex",
        Node::Grid { .. } => "grid",
        Node::Indication { .. } => "indication",
        Node::Overlay { .. } => "overlay",
        Node::Disclosure { .. } => "disclosure",
        Node::Squeeze { .. } => "squeeze",
        Node::Viewport { .. } => "viewport",
        Node::IndentationException { .. } => "indentation_exception",
        Node::Markdown { .. } => "markdown",
        Node::Diff { .. } => "diff",
        Node::Chrome { .. } => "chrome_frame",
        Node::Skipped => "skipped",
    }
}

fn own_key(node: &Node) -> Option<&str> {
    let slot = match node {
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
        | Node::Markdown { key, .. }
        | Node::Diff { key, .. }
        | Node::Chrome { key, .. } => key.as_deref(),
        Node::Skipped => None,
    };
    slot.filter(|key| !key.is_empty())
}

fn own_id(node: &Node) -> Option<&str> {
    let slot = match node {
        Node::Box { id, .. } => id.as_deref(),
        Node::Viewport { id, .. } => Some(id.as_str()),
        _ => None,
    };
    slot.filter(|id| !id.is_empty())
}

fn key_of(node: &Node, path: &[&str]) -> String {
    if let Some(key) = own_key(node) {
        return key.to_string();
    }
    if let Some(id) = own_id(node) {
        return id.to_string();
    }
    path.join("/")
}

fn stamp_of(node: &Node) -> Option<MeasuredStamp> {
    match node {
        Node::Text { measured, .. }
        | Node::Box { measured, .. }
        | Node::Flex { measured, .. }
        | Node::Grid { measured, .. }
        | Node::Indication { measured, .. }
        | Node::Overlay { measured, .. }
        | Node::Disclosure { measured, .. }
        | Node::Squeeze { measured, .. }
        | Node::Viewport { measured, .. }
        | Node::IndentationException { measured, .. } => *measured,
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => None,
    }
}

fn region_of(node: &Node) -> Option<f64> {
    match node {
        Node::Text {
            region_prominence, ..
        }
        | Node::Box {
            region_prominence, ..
        }
        | Node::Flex {
            region_prominence, ..
        }
        | Node::Grid {
            region_prominence, ..
        }
        | Node::Indication {
            region_prominence, ..
        }
        | Node::Overlay {
            region_prominence, ..
        }
        | Node::Disclosure {
            region_prominence, ..
        }
        | Node::Squeeze {
            region_prominence, ..
        }
        | Node::Viewport {
            region_prominence, ..
        }
        | Node::IndentationException {
            region_prominence, ..
        } => *region_prominence,
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => None,
    }
}

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = add_i64(a.x, a.w).min(add_i64(b.x, b.w));
    let y2 = add_i64(a.y, a.h).min(add_i64(b.y, b.h));
    if x2 <= x1 || y2 <= y1 {
        None
    } else {
        Some(Rect {
            x: x1,
            y: y1,
            w: sub_i64(x2, x1),
            h: sub_i64(y2, y1),
        })
    }
}

fn axis_tight(value: Option<Overflow>) -> bool {
    matches!(
        value,
        Some(Overflow::Hidden | Overflow::Clip | Overflow::Auto | Overflow::Scroll)
    )
}

fn overflow_tight(style: &BoxStyle) -> bool {
    axis_tight(style.overflow) || axis_tight(style.overflow_x) || axis_tight(style.overflow_y)
}

fn is_sticky_top(node: &Node) -> bool {
    matches!(
        node,
        Node::Box {
            style: BoxStyle {
                sticky: Some(Sticky::Top),
                ..
            },
            ..
        }
    )
}

fn places_fully_below(node: &Node) -> bool {
    match node {
        Node::Overlay { .. } | Node::Squeeze { .. } => true,
        Node::Box { style, .. } => style.sticky == Some(Sticky::Bottom) || style.squeeze.is_some(),
        _ => false,
    }
}

fn pins_from_above(node: &Node, child: Rect, clip: Rect) -> bool {
    is_sticky_top(node) && add_i64(child.y, child.h) <= clip.y
}

fn sticky_bottom_rect(node: &Node, rect: Rect, clip: Rect) -> Rect {
    let Node::Box { style, .. } = node else {
        return rect;
    };
    if style.sticky != Some(Sticky::Bottom) {
        return rect;
    }
    let overflow = sub_i64(add_i64(rect.y, rect.h), add_i64(clip.y, clip.h));
    if overflow <= 0 {
        return rect;
    }
    Rect {
        y: sub_i64(rect.y, overflow),
        ..rect
    }
}

fn sticky_top_rect(node: &Node, rect: Rect, clip: Rect, floor: Option<i64>) -> Rect {
    if !is_sticky_top(node) {
        return rect;
    }
    if rect.y >= clip.y {
        return rect;
    }
    let left = add_i64(rect.y, rect.h) <= clip.y;
    if !left && rect.h >= clip.h {
        return rect;
    }
    let squeezed = left && rect.h >= clip.h;
    let h = if squeezed { 1 } else { rect.h };
    let bottom = floor.unwrap_or_else(|| add_i64(clip.y, clip.h));
    let room = sub_i64(bottom, clip.y);
    if h > room {
        return rect;
    }
    let limit = sub_i64(bottom, h);
    let y = rect.y.max(clip.y.min(limit));
    if y == rect.y && h == rect.h {
        return rect;
    }
    Rect { y, h, ..rect }
}

/// Lead column plus one cell for a wide sigil. Narrow glyphs keep column 1.
fn gutter_slot(gutter: &Gutter) -> (i64, i64) {
    let glyph = match gutter {
        Gutter::Top { glyph } | Gutter::Rule { glyph } => glyph.as_str(),
        Gutter::Corners { top, .. } => top.as_str(),
        Gutter::Spinner { .. } => return (1, 1),
    };
    if is_two_column_symbol(glyph) {
        (0, 2)
    } else {
        (1, 1)
    }
}

fn glyph_cols(raw: &str, default_glyph: &str) -> String {
    let src = if raw.is_empty() { default_glyph } else { raw };
    src.chars().take(2).collect()
}

/// `indicationGutterLines`. `height` is the content bar, not the flex cell.
pub fn indication_gutter_lines(gutter: &Gutter, height: i64) -> Vec<String> {
    let h = usize_from_i64(height.max(1));
    match gutter {
        Gutter::Spinner { rows, .. } => {
            let all = *rows == Some(SpinnerRows::All);
            (0..h)
                .map(|i| {
                    if all || i == 0 {
                        "·".to_string()
                    } else {
                        " ".to_string()
                    }
                })
                .collect()
        }
        Gutter::Top { glyph } => {
            let gl = glyph_cols(glyph, "·");
            (0..h)
                .map(|i| if i == 0 { gl.clone() } else { " ".to_string() })
                .collect()
        }
        Gutter::Rule { glyph } => {
            let gl = glyph_cols(glyph, "·");
            vec![gl; h]
        }
        Gutter::Corners { top, mid, bottom } => {
            let top = glyph_cols(top, "∵");
            let mid = glyph_cols(mid.as_deref().unwrap_or("·"), "·");
            let bottom_src = bottom.as_deref().unwrap_or("");
            let bottom_gl = if bottom_src.is_empty() {
                mid.clone()
            } else {
                glyph_cols(bottom_src, &mid)
            };
            if h == 1 {
                let only = if !bottom_src.is_empty() {
                    bottom_gl
                } else {
                    top
                };
                return vec![only];
            }
            (0..h)
                .map(|i| {
                    if i == 0 {
                        top.clone()
                    } else if i + 1 == h {
                        bottom_gl.clone()
                    } else {
                        mid.clone()
                    }
                })
                .collect()
        }
    }
}

fn spinner_hz(profile: SpinnerProfile) -> i64 {
    match profile {
        SpinnerProfile::Thinking | SpinnerProfile::Tool => 12,
        SpinnerProfile::Working => 10,
    }
}

pub fn omitted_label(n: i64) -> String {
    let count = clamp0_i64(n);
    if count == 1 {
        "·· 1 line omitted ··".to_string()
    } else {
        format!("·· {count} lines omitted ··")
    }
}

fn sum_range(heights: &[i64], lo: usize, hi: usize) -> i64 {
    let hi = hi.min(heights.len());
    let lo = lo.min(hi);
    let mut sum = 0i128;
    for height in &heights[lo..hi] {
        sum += i128::from(*height);
    }
    as_i64(sum)
}

fn nonneg_count(n: i64, limit: usize) -> usize {
    usize_from_i64(n).min(limit)
}

/// Tight peek: pin heights plus one omit row when anything sits between.
pub fn min_peek_height(heights: &[i64], head: i64, tail: i64) -> i64 {
    let n = heights.len();
    if n == 0 {
        return 0;
    }
    let head_n = nonneg_count(head, n);
    let tail_n = nonneg_count(tail, n - head_n);
    let h = add_i64(
        sum_range(heights, 0, head_n),
        sum_range(heights, n - tail_n, n),
    );
    if n > head_n + tail_n {
        add_i64(h, 1)
    } else {
        h
    }
}

/// Overlay the squeeze paints into. `None` when the body is fully above the clip.
pub fn squeeze_overlay(rect: Rect, clip: Rect, natural_h: i64, min_peek: i64) -> Option<Rect> {
    let peek = 0.max(min_peek.min(natural_h).min(clip.h));
    if add_i64(rect.y, rect.h) <= clip.y {
        return None;
    }
    let inter = intersect(rect, clip);
    let overflows_bottom = add_i64(rect.y, rect.h) > add_i64(clip.y, clip.h);
    if let Some(hit) = inter {
        if !(overflows_bottom && hit.h < peek) {
            return Some(Rect {
                x: rect.x,
                y: hit.y,
                w: rect.w,
                h: hit.h,
            });
        }
    }
    if overflows_bottom || rect.y >= add_i64(clip.y, clip.h) {
        if peek <= 0 {
            return inter;
        }
        return Some(Rect {
            x: rect.x,
            y: sub_i64(add_i64(clip.y, clip.h), peek),
            w: rect.w,
            h: peek,
        });
    }
    inter
}

struct Take {
    from: usize,
    to: usize,
}

fn take_prefix(heights: &[i64], start: usize, end: usize, budget: i64) -> Take {
    if budget <= 0 || start >= end {
        return Take {
            from: start,
            to: start,
        };
    }
    let mut used = 0i64;
    let mut to = start;
    while to < end {
        let h = heights.get(to).copied().unwrap_or(0).max(0);
        if add_i64(used, h) > budget {
            if to == start {
                return Take {
                    from: start,
                    to: start + 1,
                };
            }
            break;
        }
        used = add_i64(used, h);
        to += 1;
        if used >= budget {
            break;
        }
    }
    Take { from: start, to }
}

fn take_suffix(heights: &[i64], start: usize, end: usize, budget: i64) -> Take {
    if budget <= 0 || start >= end {
        return Take { from: end, to: end };
    }
    let mut used = 0i64;
    let mut from = end;
    while from > start {
        let h = heights.get(from - 1).copied().unwrap_or(0).max(0);
        if add_i64(used, h) > budget {
            if from == end {
                return Take {
                    from: end - 1,
                    to: end,
                };
            }
            break;
        }
        used = add_i64(used, h);
        from -= 1;
        if used >= budget {
            break;
        }
    }
    Take { from, to: end }
}

fn shrink_pins(heights: &[i64], overlay_h: i64, head_max: i64, tail_max: i64) -> (usize, usize) {
    let n = heights.len();
    let mut head_n = nonneg_count(head_max, n);
    let mut tail_n = nonneg_count(tail_max, n - head_n);
    let needed = |head_n: usize, tail_n: usize| -> i64 {
        let omitted = n - head_n - tail_n;
        let pins = add_i64(
            sum_range(heights, 0, head_n),
            sum_range(heights, n - tail_n, n),
        );
        if omitted > 0 {
            add_i64(pins, 1)
        } else {
            pins
        }
    };
    while needed(head_n, tail_n) > overlay_h && (head_n > 0 || tail_n > 0) {
        if head_n > tail_n && head_n > 1 {
            head_n -= 1;
        } else if tail_n > 1 {
            tail_n -= 1;
        } else if head_n > 1 {
            head_n -= 1;
        } else if tail_n > 0 {
            tail_n -= 1;
        } else if head_n > 0 {
            head_n -= 1;
        } else {
            break;
        }
    }
    (head_n, tail_n)
}

fn push_children(
    slots: &mut Vec<SqueezeSlot>,
    heights: &[i64],
    from: usize,
    to: usize,
    y0: i64,
    cap: i64,
) -> i64 {
    let mut y = y0;
    let mut i = from;
    while i < to {
        let natural = heights.get(i).copied().unwrap_or(0).max(0);
        let used = sub_i64(y, y0);
        let h = 0.max(natural.min(sub_i64(cap, used)));
        if h <= 0 {
            break;
        }
        slots.push(SqueezeSlot::Child { index: i, y, h });
        y = add_i64(y, h);
        i += 1;
    }
    y
}

/// `planSqueeze`. Heights are per direct child. `overlay_h <= 0` or an empty
/// child list yields no slots.
pub fn plan_squeeze(
    heights: &[i64],
    overlay_y: i64,
    overlay_h: i64,
    natural_y: i64,
    clip_h: i64,
    head: i64,
    tail: i64,
) -> Vec<SqueezeSlot> {
    let n = heights.len();
    if n == 0 || overlay_h <= 0 {
        return Vec::new();
    }
    let total = sum_range(heights, 0, n);
    if total <= overlay_h {
        let mut slots = Vec::new();
        push_children(&mut slots, heights, 0, n, overlay_y, overlay_h);
        return slots;
    }
    let (head_n, tail_n) = shrink_pins(heights, overlay_h, head, tail);
    let head_h = sum_range(heights, 0, head_n);
    let tail_h = sum_range(heights, n - tail_n, n);
    let middle_from = head_n;
    let middle_to = n - tail_n;
    let mut slots = Vec::new();
    push_children(&mut slots, heights, 0, head_n, overlay_y, overlay_h);
    let inner_y = add_i64(overlay_y, head_h);
    let inner_h = sub_i64(sub_i64(overlay_h, head_h), tail_h);
    let tail_y = sub_i64(add_i64(overlay_y, overlay_h), tail_h);
    if inner_h <= 0 || middle_from >= middle_to {
        if tail_n > 0 && tail_y >= overlay_y {
            push_children(
                &mut slots,
                heights,
                n - tail_n,
                n,
                tail_y.max(overlay_y),
                overlay_h,
            );
        }
        return slots;
    }
    let omitted_total = middle_to - middle_from;
    if inner_h == 1 || omitted_total == 0 {
        if omitted_total > 0 {
            slots.push(SqueezeSlot::Omit {
                count: omitted_total as i64,
                y: inner_y,
                edge: OmitEdge::Mid,
            });
        }
        push_children(&mut slots, heights, n - tail_n, n, tail_y, overlay_h);
        return slots;
    }
    let tour = overlay_h >= clip_h && total > overlay_h;
    let content_top = sub_i64(overlay_y, natural_y);
    let effective_top = if tour { content_top.max(0) } else { 0 };
    let at_start = effective_top <= 0;
    let at_end = add_i64(effective_top, overlay_h) >= total;
    let (body_from, body_to, omit_above, omit_below) = if at_end && !at_start {
        let body = take_suffix(heights, middle_from, middle_to, sub_i64(inner_h, 1));
        (body.from, body.to, body.from - middle_from, 0)
    } else if at_start {
        let body = take_prefix(heights, middle_from, middle_to, sub_i64(inner_h, 1));
        (body.from, body.to, 0, middle_to - body.to)
    } else {
        let body_origin = add_i64(effective_top, head_h);
        let mut prefix = head_h;
        let mut first_rest = middle_from;
        while first_rest < middle_to
            && add_i64(prefix, heights.get(first_rest).copied().unwrap_or(0)) <= body_origin
        {
            prefix = add_i64(prefix, heights.get(first_rest).copied().unwrap_or(0));
            first_rest += 1;
        }
        let omit_above = first_rest - middle_from;
        let need_above = if omit_above > 0 { 1 } else { 0 };
        let rest_h = sum_range(heights, first_rest, middle_to);
        let left = sub_i64(inner_h, need_above);
        if rest_h <= left {
            (first_rest, middle_to, omit_above, 0)
        } else {
            let body = take_prefix(heights, first_rest, middle_to, sub_i64(left, 1).max(0));
            (body.from, body.to, omit_above, middle_to - body.to)
        }
    };
    let mut y = inner_y;
    if omit_above > 0 {
        slots.push(SqueezeSlot::Omit {
            count: omit_above as i64,
            y,
            edge: OmitEdge::Above,
        });
        y = add_i64(y, 1);
    }
    y = push_children(
        &mut slots,
        heights,
        body_from,
        body_to,
        y,
        sub_i64(tail_y, y),
    );
    if omit_below > 0 && y < tail_y {
        slots.push(SqueezeSlot::Omit {
            count: omit_below as i64,
            y,
            edge: OmitEdge::Below,
        });
    }
    push_children(&mut slots, heights, n - tail_n, n, tail_y, overlay_h);
    slots
}

fn measure_cols(measure: Measure<'_>, text: &str) -> i64 {
    let width = match measure {
        Some(measure) => measure(text),
        None => display_width(text),
    };
    i64::try_from(width).unwrap_or(i64::MAX)
}

fn longest_token(text: &str, measure: Measure<'_>) -> i64 {
    let mut max_w = 0i64;
    let mut start: Option<usize> = None;
    for (i, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if let Some(from) = start.take() {
                max_w = max_w.max(measure_cols(measure, &text[from..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(from) = start {
        max_w = max_w.max(measure_cols(measure, &text[from..]));
    }
    max_w
}

fn append_plain(node: &Node, out: &mut String) {
    match node {
        Node::Text { content, .. } => out.push_str(content),
        Node::Disclosure {
            collapsed,
            summary,
            children,
            ..
        } => {
            if *collapsed {
                append_plain(summary, out);
            } else {
                for child in children {
                    append_plain(child, out);
                }
            }
        }
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children {
                append_plain(child, out);
            }
        }
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => {}
    }
}

fn min_content_width(node: &Node, measure: Measure<'_>) -> i64 {
    let mut buf = String::new();
    append_plain(node, &mut buf);
    longest_token(&buf, measure)
}

fn text_ref(node: &Node) -> Option<TextNode<'_>> {
    let Node::Text {
        content,
        white_space,
        ellipsis,
        line_clamp,
        measured,
        ..
    } = node
    else {
        return None;
    };
    Some(TextNode {
        content,
        white_space: *white_space,
        ellipsis: *ellipsis,
        line_clamp: *line_clamp,
        measured: *measured,
    })
}

fn gap_size(explicit: Option<i64>, lines: GridLines) -> i64 {
    explicit
        .unwrap_or(if lines == GridLines::Inner { 1 } else { 0 })
        .max(0)
}

fn vacant_row_floor(pad_y: i64) -> i64 {
    let doubled = pad_y.saturating_mul(2);
    let inner = if doubled == 0 { 1 } else { doubled };
    inner.max(1)
}

struct GridGeom {
    col_widths: Vec<i64>,
    row_heights: Vec<i64>,
    col_gap: i64,
    row_gap: i64,
    pad_x: i64,
    pad_y: i64,
    n_cols: usize,
    n_rows: usize,
    total_w: i64,
    total_h: i64,
}

fn grid_geom(
    style: &GridStyle,
    children: &[Node],
    max_w: i64,
    measure: Measure<'_>,
    cache: Cache<'_>,
) -> GridGeom {
    let synthetic = [Length::Auto];
    let tracks: &[Length] = if style.columns.is_empty() {
        &synthetic
    } else {
        &style.columns
    };
    let n_cols = tracks.len();
    let col_gap = gap_size(style.column_gap, style.lines);
    let row_gap = gap_size(style.row_gap, style.lines);
    let (pad_x, pad_y) = cell_pad_xy(style.cell_pad);
    let n_rows = if children.is_empty() {
        1
    } else {
        children.len().div_ceil(n_cols)
    };
    let mut content_max = vec![0i64; n_cols];
    let mut content_min = vec![0i64; n_cols];
    let probe_w = max_w.max(UNBOUNDED_H);
    for (i, child) in children.iter().enumerate() {
        let col = i % n_cols;
        let measured = measure_cached(child, probe_w, UNBOUNDED_H, measure, cache);
        content_max[col] = content_max[col].max(add_i64(measured.w, pad_x.saturating_mul(2)));
        content_min[col] = content_min[col].max(add_i64(
            min_content_width(child, measure),
            pad_x.saturating_mul(2),
        ));
    }
    for col in 0..n_cols {
        content_min[col] = content_min[col].min(content_max[col]);
    }
    let available = match resolve_length(style.width, max_w) {
        ResolvedLength::Auto => max_w,
        ResolvedLength::Cells(v) => floor_nonneg_f64(v),
    };
    let col_widths =
        resolve_column_tracks(tracks, &content_max, available, col_gap, Some(&content_min));
    let mut row_heights = vec![1i64; n_rows];
    for r in 0..n_rows {
        let mut rh = 1i64;
        for c in 0..n_cols {
            let idx = r.saturating_mul(n_cols).saturating_add(c);
            let Some(child) = children.get(idx) else {
                rh = rh.max(vacant_row_floor(pad_y));
                continue;
            };
            let col_w = col_widths.get(c).copied().unwrap_or(0);
            let inner_w = sub_i64(col_w, pad_x.saturating_mul(2)).max(1);
            let measured = measure_cached(child, inner_w, UNBOUNDED_H, measure, cache);
            rh = rh.max(add_i64(measured.h, pad_y.saturating_mul(2)));
        }
        row_heights[r] = rh;
    }
    let total_w = tracks_extent(&col_widths, col_gap);
    let total_h = tracks_extent(&row_heights, row_gap);
    GridGeom {
        col_widths,
        row_heights,
        col_gap,
        row_gap,
        pad_x,
        pad_y,
        n_cols,
        n_rows,
        total_w,
        total_h,
    }
}

fn stack_extent(
    children: &[Node],
    max_w: i64,
    max_h: i64,
    measure: Measure<'_>,
    cache: Cache<'_>,
) -> (i64, i64) {
    let mut cw = 0i64;
    let mut ch = 0i128;
    for child in children {
        let measured = measure_cached(child, max_w, max_h, measure, cache);
        cw = cw.max(measured.w);
        ch += i128::from(measured.h);
    }
    (cw, as_i64(ch))
}

/// `measureNode` for this walk's kinds.
///
/// A stamp whose `at_w` equals `max_w` wins before the kind arm and is
/// `clamp0`'d. Text that misses the stamp uses [`measure_text_node`], which
/// does not `clamp0` a negative max. Overlay returns `max_w × max_h` raw.
static REALIZE: OnceLock<fn(&Node) -> Option<Node>> = OnceLock::new();

/// Install the markdown and diff expander. The layout walk calls it.
pub fn set_realize(realize: fn(&Node) -> Option<Node>) {
    let _ = REALIZE.set(realize);
}

fn realize(node: &Node) -> Option<Node> {
    REALIZE.get().and_then(|realize| realize(node))
}

/// Markdown and diff, once [`set_realize`] is installed. `None` leaves `node` as it is.
pub(crate) fn expand_realized(node: &Node) -> Option<Node> {
    realize(node)
}

/// [`Node::Skipped`] is `0×0`. Markdown and diff expand only when
/// [`set_realize`] is set; otherwise they are `0×0` too.
pub fn measure_tree(node: &Node, max_w: i64, max_h: i64, measure: Measure<'_>) -> Extent {
    measure_cached(node, max_w, max_h, measure, Cache::empty())
}

fn measure_cached(
    node: &Node,
    max_w: i64,
    max_h: i64,
    measure: Measure<'_>,
    cache: Cache<'_>,
) -> Extent {
    if let Some(next) = realize(node) {
        return measure_cached(&next, max_w, max_h, measure, cache);
    }
    if let Some(stamp) = stamp_of(node) {
        if stamp.at_w == max_w {
            return Extent {
                w: clamp0_i64(max_w.min(stamp.w)),
                h: clamp0_i64(max_h.min(stamp.h)),
            };
        }
    }
    match node {
        Node::Text { .. } => {
            let Some(text) = text_ref(node) else {
                return Extent { w: 0, h: 0 };
            };
            let measured = crate::layout_text::measure_text_cached(
                &text,
                max_w,
                max_h,
                measure,
                cache.memo,
                cache.token,
            );
            Extent {
                w: measured.w,
                h: measured.h,
            }
        }
        Node::Box {
            style, children, ..
        } => {
            let pd = pad_edges(style.padding);
            let border: i64 = if style.border { 1 } else { 0 };
            let inner_w = sub_i64(
                sub_i64(max_w, add_i64(pd.l, pd.r)),
                border.saturating_mul(2),
            )
            .max(0);
            let inner_h = sub_i64(
                sub_i64(max_h, add_i64(pd.t, pd.b)),
                border.saturating_mul(2),
            )
            .max(0);
            let (cw, ch) = stack_extent(children, inner_w, inner_h, measure, cache);
            let w = match resolve_length(style.width, max_w) {
                ResolvedLength::Auto => {
                    (add_i64(cw, add_i64(pd.l, pd.r)) + border.saturating_mul(2)) as f64
                }
                ResolvedLength::Cells(v) => v,
            };
            let h = match resolve_length(style.height, max_h) {
                ResolvedLength::Auto => {
                    (add_i64(ch, add_i64(pd.t, pd.b)) + border.saturating_mul(2)) as f64
                }
                ResolvedLength::Cells(v) => v,
            };
            Extent {
                w: clamp_extent(max_w, w),
                h: clamp_extent(max_h, h),
            }
        }
        Node::Flex {
            style, children, ..
        } => measure_flex(style, children, max_w, max_h, measure, cache),
        Node::Grid {
            style, children, ..
        } => {
            let dims = grid_geom(style, children, max_w, measure, cache);
            let w = match resolve_length(style.width, max_w) {
                ResolvedLength::Auto => dims.total_w as f64,
                ResolvedLength::Cells(v) => v,
            };
            let h = match resolve_length(style.height, max_h) {
                ResolvedLength::Auto => dims.total_h as f64,
                ResolvedLength::Cells(v) => v,
            };
            Extent {
                w: clamp_extent(max_w, w),
                h: clamp_extent(max_h, h),
            }
        }
        Node::Viewport { width, height, .. } => {
            let w = match resolve_length(*width, max_w) {
                ResolvedLength::Auto => max_w as f64,
                ResolvedLength::Cells(v) => v,
            };
            let h = match resolve_length(*height, max_h) {
                ResolvedLength::Auto => max_h as f64,
                ResolvedLength::Cells(v) => v,
            };
            Extent {
                w: floor_nonneg_f64(w),
                h: floor_nonneg_f64(h),
            }
        }
        Node::Indication { children, .. } => {
            let inner_w = sub_i64(max_w, INDICATION_CONTENT_INSET).max(1);
            let (cw, ch) = stack_extent(children, inner_w, max_h, measure, cache);
            Extent {
                w: max_w.min(add_i64(cw, INDICATION_CONTENT_INSET)),
                h: max_h.min(ch.max(1)),
            }
        }
        Node::IndentationException { children, .. } => {
            let (cw, ch) = stack_extent(children, max_w, max_h, measure, cache);
            Extent {
                w: max_w.min(cw),
                h: max_h.min(ch.max(1)),
            }
        }
        Node::Disclosure {
            collapsed,
            summary,
            children,
            ..
        } => {
            if *collapsed {
                let measured = measure_cached(summary, max_w, max_h, measure, cache);
                Extent {
                    w: max_w.min(measured.w),
                    h: max_h.min(measured.h.max(1)),
                }
            } else {
                let (cw, ch) = stack_extent(children, max_w, max_h, measure, cache);
                Extent {
                    w: max_w.min(cw),
                    h: max_h.min(ch.max(1)),
                }
            }
        }
        Node::Squeeze { children, .. } => {
            let (cw, ch) = stack_extent(children, max_w, max_h, measure, cache);
            Extent {
                w: max_w.min(cw).max(0),
                h: max_h.min(ch).max(0),
            }
        }
        Node::Overlay { .. } => Extent { w: max_w, h: max_h },
        Node::Chrome { frame, .. } => {
            let geom = measure_chrome_frame(frame, max_w, max_h);
            Extent {
                w: clamp0_i64(max_w.min(geom.outer_w)),
                h: clamp0_i64(max_h.min(geom.total_h)),
            }
        }
        Node::Markdown { .. } | Node::Diff { .. } | Node::Skipped => Extent { w: 0, h: 0 },
    }
}

/// One chrome-frame progress target. The host eases toward `progress`.
#[derive(Clone, Debug, PartialEq)]
pub struct ProgressSite {
    pub key: String,
    pub progress: f64,
    pub role: Option<String>,
}

/// Chrome frames with a key and a progress value. `plain_bottom` is the picker and is skipped.
pub fn collect_progress_sites(node: &Node) -> Vec<ProgressSite> {
    let mut out = Vec::new();
    walk_progress(node, &mut out);
    out
}

fn walk_progress(node: &Node, out: &mut Vec<ProgressSite>) {
    if let Node::Chrome { key, frame } = node {
        if let (Some(key), Some(progress)) =
            (key.as_ref().filter(|key| !key.is_empty()), frame.progress)
        {
            if !frame.plain_bottom {
                out.push(ProgressSite {
                    key: key.clone(),
                    progress,
                    role: frame.progress_role.clone(),
                });
            }
        }
    }
    match node {
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children {
                walk_progress(child, out);
            }
        }
        Node::Disclosure {
            summary, children, ..
        } => {
            for child in children {
                walk_progress(child, out);
            }
            walk_progress(summary, out);
        }
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => {}
    }
}

fn measure_flex(
    style: &FlexStyle,
    children: &[Node],
    max_w: i64,
    max_h: i64,
    measure: Measure<'_>,
    cache: Cache<'_>,
) -> Extent {
    let pd = pad_edges(style.padding);
    let gap = style.gap.max(0);
    let inner_w = sub_i64(max_w, add_i64(pd.l, pd.r)).max(0);
    let inner_h = sub_i64(max_h, add_i64(pd.t, pd.b)).max(0);
    let column = matches!(
        style.direction,
        crate::layout_flex::FlexDirection::Column
            | crate::layout_flex::FlexDirection::ColumnReverse
    );
    if !column {
        let mut sum = 0i128;
        let mut max_cross = 0i64;
        for (i, child) in children.iter().enumerate() {
            let measured = measure_cached(child, inner_w, inner_h, measure, cache);
            sum += i128::from(measured.w);
            if i > 0 {
                sum += i128::from(gap);
            }
            max_cross = max_cross.max(measured.h);
        }
        return Extent {
            w: max_w.min(add_i64(as_i64(sum), add_i64(pd.l, pd.r))),
            h: max_h.min(add_i64(max_cross, add_i64(pd.t, pd.b))),
        };
    }
    let mut sum = 0i128;
    let mut max_cross = 0i64;
    for (i, child) in children.iter().enumerate() {
        let measured = measure_cached(child, inner_w, inner_h, measure, cache);
        sum += i128::from(measured.h);
        if i > 0 {
            sum += i128::from(gap);
        }
        max_cross = max_cross.max(measured.w);
    }
    let w = match resolve_length(style.width, max_w) {
        ResolvedLength::Auto => add_i64(max_cross, add_i64(pd.l, pd.r)) as f64,
        ResolvedLength::Cells(v) => v,
    };
    let h = match resolve_length(style.height, max_h) {
        ResolvedLength::Auto => add_i64(as_i64(sum), add_i64(pd.t, pd.b)) as f64,
        ResolvedLength::Cells(v) => v,
    };
    Extent {
        w: clamp_extent(max_w, w),
        h: clamp_extent(max_h, h),
    }
}

/// Count live ops the way `collectLiveDemand` does. Elapsed and countdown share
/// the elapsed bucket. Birth is every other live kind.
pub fn collect_live_demand(paint_order: &[Positioned]) -> LiveDemand {
    let mut demand = LiveDemand::zero();
    for pos in paint_order {
        for op in &pos.paint {
            let PaintOp::Live { live, .. } = op else {
                continue;
            };
            demand.max_hz = demand.max_hz.max(live.hz());
            match live {
                LivePaint::Spinner { .. } => demand.spinners = add_i64(demand.spinners, 1),
                LivePaint::Elapsed { .. } | LivePaint::Countdown { .. } => {
                    demand.elapsed = add_i64(demand.elapsed, 1);
                }
                LivePaint::Quota { .. } => demand.quota = add_i64(demand.quota, 1),
                LivePaint::Birth { .. } => demand.birth = add_i64(demand.birth, 1),
            }
        }
    }
    demand
}

struct StuckLift {
    paint_at: usize,
    paint_to: usize,
}

struct Ctx<'m> {
    measure: Measure<'m>,
    cache: Cache<'m>,
    path: Vec<&'static str>,
    paint_order: Vec<Positioned>,
    placed: Vec<Placed>,
    stuck: Vec<StuckLift>,
    hold_tail: bool,
    sticky_floor: Option<i64>,
}

fn record(ctx: &mut Ctx<'_>, key: &str, rect: Rect) {
    ctx.placed.push(Placed {
        key: key.to_string(),
        rect,
    });
}

fn stamp_region(paint: &mut [Positioned], region_p: f64) {
    for pos in paint {
        for op in &mut pos.paint {
            let style = op.style_mut();
            let prev = style.region_prominence;
            let next = match prev {
                None => region_p,
                Some(value) => value * region_p,
            };
            if prev == Some(next) {
                continue;
            }
            style.region_prominence = Some(next);
        }
    }
}

fn flush_stuck(ctx: &mut Ctx<'_>, from: usize) {
    if from > ctx.stuck.len() {
        return;
    }
    let lifts: Vec<StuckLift> = ctx.stuck.drain(from..).collect();
    let mut slices: Vec<Vec<Positioned>> = Vec::with_capacity(lifts.len());
    for lift in lifts.iter().rev() {
        let start = lift.paint_at.min(ctx.paint_order.len());
        let end = lift.paint_to.min(ctx.paint_order.len()).max(start);
        slices.push(ctx.paint_order.drain(start..end).collect());
    }
    for slice in slices.into_iter().rev() {
        ctx.paint_order.extend(slice);
    }
}

fn repeat_glyph(glyph: &str, n: i64) -> String {
    if n <= 0 {
        return String::new();
    }
    glyph.repeat(usize_from_i64(n))
}

fn paint_inner_grid_bars(rect: Rect, dims: &GridGeom, line_style: &Style) -> Vec<PaintOp> {
    let mut paints = Vec::new();
    let col_off = track_offsets(&dims.col_widths, dims.col_gap);
    let row_off = track_offsets(&dims.row_heights, dims.row_gap);
    if dims.n_rows > 0 {
        for r in 0..dims.n_rows - 1 {
            if dims.row_gap <= 0 {
                continue;
            }
            let y = add_i64(
                rect.y,
                add_i64(
                    row_off.get(r).copied().unwrap_or(0),
                    dims.row_heights.get(r).copied().unwrap_or(0),
                ),
            );
            for g in 0..dims.row_gap {
                let mut line = String::new();
                for c in 0..dims.n_cols {
                    line.push_str(&repeat_glyph(
                        "─",
                        dims.col_widths.get(c).copied().unwrap_or(0).max(0),
                    ));
                    if c + 1 < dims.n_cols {
                        let mark = if g == 0 { "┼" } else { "│" };
                        line.push_str(&repeat_glyph(mark, dims.col_gap.max(0)));
                    }
                }
                if !line.is_empty() {
                    let width = i64::try_from(line.chars().count()).unwrap_or(i64::MAX);
                    paints.push(PaintOp::Text {
                        rect: Rect {
                            x: rect.x,
                            y: add_i64(y, g),
                            w: width,
                            h: 1,
                        },
                        lines: vec![line],
                        style: line_style.clone(),
                    });
                }
            }
        }
    }
    if dims.n_cols > 0 {
        for c in 0..dims.n_cols - 1 {
            if dims.col_gap <= 0 {
                continue;
            }
            let x = add_i64(
                rect.x,
                add_i64(
                    col_off.get(c).copied().unwrap_or(0),
                    dims.col_widths.get(c).copied().unwrap_or(0),
                ),
            );
            for r in 0..dims.n_rows {
                let y = add_i64(rect.y, row_off.get(r).copied().unwrap_or(0));
                let h = dims.row_heights.get(r).copied().unwrap_or(0);
                for g in 0..dims.col_gap {
                    let lines = vec!["│".to_string(); usize_from_i64(h)];
                    paints.push(PaintOp::Text {
                        rect: Rect {
                            x: add_i64(x, g),
                            y,
                            w: 1,
                            h,
                        },
                        lines,
                        style: line_style.clone(),
                    });
                }
            }
        }
    }
    paints
}

fn cached_h(
    node: &Node,
    slot: &mut Option<i64>,
    max_w: i64,
    max_h: i64,
    measure: Measure<'_>,
    cache: Cache<'_>,
) -> i64 {
    if matches!(node, Node::Overlay { .. }) {
        return 0;
    }
    if let Some(height) = *slot {
        return height;
    }
    let height = measure_cached(node, max_w, max_h, measure, cache).h;
    *slot = Some(height);
    height
}

fn definite_cells(len: Option<Length>, containing: i64) -> Option<i64> {
    match resolve_length(len, containing) {
        ResolvedLength::Auto => None,
        ResolvedLength::Cells(v) => Some(floor_nonneg_f64(v)),
    }
}

fn flex_item(
    child: &Node,
    row: bool,
    content: Rect,
    measured: Extent,
) -> crate::layout_flex::FlexItemInput {
    let content_main = if row { measured.w } else { measured.h };
    let along = if row { content.w } else { content.h };
    let style = match child {
        Node::Box { style, .. } => Some(style),
        _ => None,
    };
    let explicit_main = style.and_then(|style| {
        let len = if row { style.width } else { style.height };
        definite_cells(len, along)
    });
    let min_main = style.and_then(|style| {
        let len = if row {
            style.min_width
        } else {
            style.min_height
        };
        definite_cells(len, along)
    });
    let flex_basis = style.and_then(|style| match style.flex_basis {
        Some(Length::Cells(n)) => Some(n),
        _ => None,
    });
    resolve_flex_item(
        &FlexItemStyle {
            flex: style.and_then(|style| style.flex),
            flex_grow: style.and_then(|style| style.flex_grow),
            flex_shrink: style.and_then(|style| style.flex_shrink),
            flex_basis,
            min_main,
            max_main: None,
            explicit_main,
        },
        content_main,
    )
}

fn place_text(node: &Node, rect: Rect, clip: Rect, ctx: &mut Ctx<'_>, key: &str) {
    let Node::Text {
        content,
        white_space,
        ellipsis,
        line_clamp,
        style,
        key: own,
        live,
        ..
    } = node
    else {
        return;
    };
    let Some(vis) = intersect(rect, clip) else {
        return;
    };
    if let Some(live) = live {
        let birth_text = matches!(live, LivePaint::Birth { .. });
        ctx.paint_order.push(Positioned {
            key: key.to_string(),
            rect,
            paint: vec![PaintOp::Live {
                rect,
                style: style.clone(),
                live: live.clone(),
                content: if birth_text {
                    Some(content.clone())
                } else {
                    None
                },
            }],
            clip,
        });
        return;
    }
    let wrapped = crate::layout_text::wrap_cached(
        &TextNode {
            content,
            white_space: *white_space,
            ellipsis: *ellipsis,
            line_clamp: *line_clamp,
            measured: None,
        },
        rect.w,
        ctx.measure,
        ctx.cache.memo,
        ctx.cache.token,
    );
    let top_skip = sub_i64(vis.y, rect.y).max(0);
    let visible: Vec<String> = wrapped
        .lines
        .into_iter()
        .skip(usize_from_i64(top_skip))
        .take(usize_from_i64(vis.h))
        .collect();
    let paint_h = i64::try_from(visible.len()).unwrap_or(i64::MAX);
    ctx.paint_order.push(Positioned {
        key: key.to_string(),
        rect,
        paint: vec![PaintOp::Text {
            rect: Rect {
                x: rect.x,
                y: add_i64(rect.y, top_skip),
                w: rect.w,
                h: paint_h,
            },
            lines: visible,
            style: style.clone(),
        }],
        clip,
    });
    if own.as_ref().is_some_and(|key| !key.is_empty()) {
        record(ctx, key, vis);
    }
}

fn place_squeezed(
    children: &[Node],
    content: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    parent_key: &str,
    head: i64,
    tail: i64,
) {
    if children.is_empty() {
        return;
    }
    let measure = ctx.measure;
    let mut heights = Vec::with_capacity(children.len());
    let mut natural = 0i128;
    for child in children {
        let height = measure_cached(child, content.w, UNBOUNDED_H, measure, ctx.cache).h;
        natural += i128::from(height);
        heights.push(height);
    }
    let natural_h = as_i64(natural);
    let peek = min_peek_height(&heights, head, tail);
    let Some(overlay) = squeeze_overlay(content, clip, natural_h, peek) else {
        return;
    };
    ctx.paint_order.push(Positioned {
        key: format!("{parent_key}:void"),
        rect: overlay,
        paint: vec![PaintOp::Fill {
            rect: overlay,
            style: Style {
                cast_transparent: true,
                ..Style::default()
            },
        }],
        clip,
    });
    let slots = plan_squeeze(
        &heights, overlay.y, overlay.h, content.y, clip.h, head, tail,
    );
    for slot in slots {
        match slot {
            SqueezeSlot::Child { index, y, h } => {
                let Some(child) = children.get(index) else {
                    continue;
                };
                place(
                    child,
                    Rect {
                        x: content.x,
                        y,
                        w: content.w,
                        h,
                    },
                    clip,
                    ctx,
                );
            }
            SqueezeSlot::Omit { count, y, edge } => {
                let omit_key = format!("{parent_key}:omit-{}", edge.as_str());
                let omit = Node::Text {
                    content: omitted_label(count),
                    white_space: Some(WhiteSpace::Nowrap),
                    ellipsis: Some(true),
                    line_clamp: Some(1),
                    measured: None,
                    style: Style {
                        role: Some("chrome".to_string()),
                        prominence: Some(GHOST_PROMINENCE),
                        ..Style::default()
                    },
                    key: Some(omit_key),
                    live: None,
                    region_prominence: None,
                };
                place(
                    &omit,
                    Rect {
                        x: content.x,
                        y,
                        w: content.w,
                        h: 1,
                    },
                    clip,
                    ctx,
                );
            }
        }
    }
}

fn place_box(
    style: &BoxStyle,
    children: &[Node],
    rect: Rect,
    natural_y: i64,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    key: &str,
) {
    let clipped = intersect(rect, clip);
    let pinned = rect.y != natural_y && style.sticky == Some(Sticky::Top);
    let mut paints = Vec::new();
    if let (Some(hit), Some(background)) = (clipped, style.background.as_ref()) {
        let fill_rect = if pinned { hit } else { rect };
        paints.push(PaintOp::Fill {
            rect: fill_rect,
            style: background.clone(),
        });
    }
    if clipped.is_some() && style.border {
        paints.push(PaintOp::Border {
            rect,
            style: chrome_line_style(),
        });
    }
    if !paints.is_empty() {
        ctx.paint_order.push(Positioned {
            key: key.to_string(),
            rect,
            paint: paints,
            clip,
        });
    }
    if let Some(hit) = clipped {
        record(ctx, key, hit);
    }
    let pd = pad_edges(style.padding);
    let border = if style.border { 1 } else { 0 };
    let content = Rect {
        x: add_i64(rect.x, add_i64(pd.l, border)),
        y: add_i64(rect.y, add_i64(pd.t, border)),
        w: sub_i64(
            sub_i64(rect.w, add_i64(pd.l, pd.r)),
            border.saturating_mul(2),
        )
        .max(0),
        h: sub_i64(
            sub_i64(rect.h, add_i64(pd.t, pd.b)),
            border.saturating_mul(2),
        )
        .max(0),
    };
    let prev_floor = ctx.sticky_floor;
    ctx.sticky_floor = Some(add_i64(rect.y, rect.h));
    if let Some(pin) = style.squeeze {
        if (pin.head > 0 || pin.tail > 0) && !children.is_empty() {
            place_squeezed(children, content, clip, ctx, key, pin.head, pin.tail);
            ctx.sticky_floor = prev_floor;
            return;
        }
    }
    let child_clip = if overflow_tight(style) {
        intersect(content, clip)
    } else {
        Some(clip)
    };
    let n = children.len();
    let mut special_after = false;
    let mut special_tail = vec![false; n];
    for i in (0..n).rev() {
        special_tail[i] = special_after;
        if places_fully_below(&children[i]) {
            special_after = true;
        }
    }
    let mut height_at = vec![None; n];
    let measure = ctx.measure;
    let mut cy = content.y;
    for i in 0..n {
        let Some(child_clip) = child_clip else {
            break;
        };
        if matches!(children[i], Node::Overlay { .. }) {
            place(&children[i], content, child_clip, ctx);
            continue;
        }
        let mh = cached_h(
            &children[i],
            &mut height_at[i],
            content.w,
            content.h,
            measure,
            ctx.cache,
        );
        let remain = sub_i64(content.h, sub_i64(cy, content.y));
        let child_rect = Rect {
            x: content.x,
            y: cy,
            w: content.w,
            h: remain.min(mh),
        };
        let held_tail = ctx.hold_tail && i + 1 == n;
        if !held_tail
            && intersect(child_rect, child_clip).is_none()
            && !pins_from_above(&children[i], child_rect, child_clip)
            && !places_fully_below(&children[i])
        {
            cy = add_i64(cy, mh);
            if cy >= add_i64(child_clip.y, child_clip.h) && !special_tail[i] {
                if ctx.hold_tail && i + 1 < n {
                    continue;
                }
                break;
            }
            continue;
        }
        let mut next_turn = add_i64(rect.y, rect.h);
        if is_sticky_top(&children[i]) {
            let mut look_y = add_i64(cy, mh);
            let mut j = i + 1;
            while j < n {
                if matches!(children[j], Node::Overlay { .. }) {
                    j += 1;
                    continue;
                }
                if is_sticky_top(&children[j]) {
                    next_turn = look_y;
                    break;
                }
                let next_h = cached_h(
                    &children[j],
                    &mut height_at[j],
                    content.w,
                    content.h,
                    measure,
                    ctx.cache,
                );
                look_y = add_i64(look_y, next_h);
                j += 1;
            }
        }
        let prev_hold = ctx.hold_tail;
        let saved_floor = ctx.sticky_floor;
        ctx.hold_tail = held_tail;
        if is_sticky_top(&children[i]) {
            ctx.sticky_floor = Some(next_turn);
        }
        place(&children[i], child_rect, child_clip, ctx);
        ctx.sticky_floor = saved_floor;
        ctx.hold_tail = prev_hold;
        cy = add_i64(cy, mh);
    }
    ctx.sticky_floor = prev_floor;
}

fn place_flex(style: &FlexStyle, children: &[Node], rect: Rect, clip: Rect, ctx: &mut Ctx<'_>) {
    let n = children.len();
    if n == 0 {
        return;
    }
    let pd = pad_edges(style.padding);
    let content = Rect {
        x: add_i64(rect.x, pd.l),
        y: add_i64(rect.y, pd.t),
        w: sub_i64(rect.w, add_i64(pd.l, pd.r)).max(0),
        h: sub_i64(rect.h, add_i64(pd.t, pd.b)).max(0),
    };
    let row = !matches!(
        style.direction,
        crate::layout_flex::FlexDirection::Column
            | crate::layout_flex::FlexDirection::ColumnReverse
    );
    let gap = style.gap.max(0);
    let main_size = if row { content.w } else { content.h };
    let cross_size = if row { content.h } else { content.w };
    let measure = ctx.measure;
    let mut measured = Vec::with_capacity(n);
    for child in children {
        measured.push(measure_cached(
            child, content.w, content.h, measure, ctx.cache,
        ));
    }
    let mut inputs = Vec::with_capacity(n);
    for i in 0..n {
        inputs.push(flex_item(&children[i], row, content, measured[i]));
    }
    let mains = flex_main_sizes(&inputs, main_size, gap);
    let used_main = {
        let mut sum = 0i128;
        for main in &mains {
            sum += i128::from(*main);
        }
        sum += i128::from(gap) * i128::from((n as i64 - 1).max(0));
        as_i64(sum)
    };
    let free_main = sub_i64(main_size, used_main).max(0);
    let mut start_off = 0i64;
    let mut betweens = vec![gap; n - 1];
    if free_main > 0 {
        match style.justify_content {
            JustifyContent::FlexStart => {}
            JustifyContent::FlexEnd => start_off = free_main,
            JustifyContent::Center => start_off = floor_div(free_main, 2),
            JustifyContent::SpaceBetween => {
                if n > 1 {
                    let weights = vec![1.0; n - 1];
                    let extras = crate::layout_flex::distribute_exact(&weights, free_main as f64);
                    for i in 0..n - 1 {
                        betweens[i] = add_i64(gap, extras.get(i).copied().unwrap_or(0));
                    }
                }
            }
            JustifyContent::SpaceAround => {
                let mut weights = vec![2.0; n + 1];
                weights[0] = 1.0;
                weights[n] = 1.0;
                let parts = crate::layout_flex::distribute_exact(&weights, free_main as f64);
                start_off = parts.first().copied().unwrap_or(0);
                for i in 0..n - 1 {
                    betweens[i] = add_i64(gap, parts.get(i + 1).copied().unwrap_or(0));
                }
            }
            JustifyContent::SpaceEvenly => {
                let weights = vec![1.0; n + 1];
                let parts = crate::layout_flex::distribute_exact(&weights, free_main as f64);
                start_off = parts.first().copied().unwrap_or(0);
                for i in 0..n - 1 {
                    betweens[i] = add_i64(gap, parts.get(i + 1).copied().unwrap_or(0));
                }
            }
        }
    }
    let mut cursor = add_i64(if row { content.x } else { content.y }, start_off);
    for i in 0..n {
        let main = mains.get(i).copied().unwrap_or(0);
        let mut cross = if row { measured[i].h } else { measured[i].w };
        if style.align_items == crate::layout_flex::AlignItems::Stretch {
            cross = cross_size;
        }
        let mut cross_off = 0i64;
        if style.align_items == crate::layout_flex::AlignItems::Center {
            cross_off = floor_div(sub_i64(cross_size, cross), 2);
        }
        if style.align_items == crate::layout_flex::AlignItems::FlexEnd {
            cross_off = sub_i64(cross_size, cross);
        }
        let child_rect = if row {
            Rect {
                x: cursor,
                y: add_i64(content.y, cross_off),
                w: main,
                h: cross.min(content.h),
            }
        } else {
            Rect {
                x: add_i64(content.x, cross_off),
                y: cursor,
                w: cross.min(content.w),
                h: main,
            }
        };
        let held_tail = ctx.hold_tail && i + 1 == n;
        if !row
            && !held_tail
            && child_rect.h > 0
            && (add_i64(child_rect.y, child_rect.h) <= clip.y
                || child_rect.y >= add_i64(clip.y, clip.h))
            && !pins_from_above(&children[i], child_rect, clip)
            && !places_fully_below(&children[i])
        {
            if i + 1 < n {
                cursor = add_i64(cursor, add_i64(main, betweens[i]));
            }
            continue;
        }
        let prev_hold = ctx.hold_tail;
        ctx.hold_tail = held_tail;
        place(&children[i], child_rect, clip, ctx);
        ctx.hold_tail = prev_hold;
        if i + 1 < n {
            cursor = add_i64(cursor, add_i64(main, betweens[i]));
        }
    }
}

fn place_grid(
    style: &GridStyle,
    line_style: Option<&Style>,
    children: &[Node],
    rect: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    key: &str,
) {
    let dims = grid_geom(style, children, rect.w, ctx.measure, ctx.cache);
    let grid_clip = intersect(rect, clip);
    if style.lines == GridLines::Inner {
        if let Some(grid_clip) = grid_clip {
            let style_owned = line_style.cloned().unwrap_or_else(chrome_line_style);
            let paints = paint_inner_grid_bars(rect, &dims, &style_owned);
            if !paints.is_empty() {
                ctx.paint_order.push(Positioned {
                    key: format!("{key}:lines"),
                    rect,
                    paint: paints,
                    clip: grid_clip,
                });
            }
        }
    }
    let col_off = track_offsets(&dims.col_widths, dims.col_gap);
    let row_off = track_offsets(&dims.row_heights, dims.row_gap);
    for r in 0..dims.n_rows {
        for c in 0..dims.n_cols {
            let idx = r.saturating_mul(dims.n_cols).saturating_add(c);
            let Some(child) = children.get(idx) else {
                continue;
            };
            let cell = Rect {
                x: add_i64(rect.x, col_off.get(c).copied().unwrap_or(0)),
                y: add_i64(rect.y, row_off.get(r).copied().unwrap_or(0)),
                w: dims.col_widths.get(c).copied().unwrap_or(0),
                h: dims.row_heights.get(r).copied().unwrap_or(0),
            };
            let content = Rect {
                x: add_i64(cell.x, dims.pad_x),
                y: add_i64(cell.y, dims.pad_y),
                w: sub_i64(cell.w, dims.pad_x.saturating_mul(2)).max(0),
                h: sub_i64(cell.h, dims.pad_y.saturating_mul(2)).max(0),
            };
            let Some(child_clip) = intersect(content, clip) else {
                continue;
            };
            place(child, content, child_clip, ctx);
        }
    }
}

fn place_indication(
    gutter: &Gutter,
    style: &Style,
    children: &[Node],
    rect: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    key: &str,
) {
    let Some(clipped) = intersect(rect, clip) else {
        return;
    };
    let content_w = sub_i64(rect.w, INDICATION_CONTENT_INSET).max(0);
    let measure = ctx.measure;
    let mut child_ms = Vec::with_capacity(children.len());
    let mut content_h = 0i128;
    for child in children {
        let measured = measure_cached(child, content_w, UNBOUNDED_H, measure, ctx.cache);
        content_h += i128::from(measured.h);
        child_ms.push(measured);
    }
    let content_h = as_i64(content_h);
    let bar_h = content_h.max(1);
    // A two-cell sigil starts in the lead column. A one-cell glyph stays at column 1, and content stays at column 3.
    let (gutter_x, gutter_w) = gutter_slot(gutter);
    let gutter_rect = Rect {
        x: add_i64(rect.x, gutter_x),
        y: rect.y,
        w: gutter_w,
        h: bar_h,
    };
    if let Some(gutter_clipped) = intersect(gutter_rect, clipped) {
        match gutter {
            Gutter::Spinner { profile, rows } => {
                let profile = profile.unwrap_or(SpinnerProfile::Working);
                let live = LivePaint::Spinner {
                    profile,
                    hz: spinner_hz(profile),
                };
                let all = *rows == Some(SpinnerRows::All);
                let mut bold = style.clone();
                bold.bold = true;
                let top_skip = sub_i64(gutter_clipped.y, gutter_rect.y).max(0);
                let mut paint = Vec::new();
                for i in 0..gutter_clipped.h {
                    let row_in_bar = add_i64(top_skip, i);
                    let cell = Rect {
                        x: gutter_clipped.x,
                        y: add_i64(gutter_clipped.y, i),
                        w: 1,
                        h: 1,
                    };
                    if all || row_in_bar == 0 {
                        paint.push(PaintOp::Live {
                            rect: cell,
                            style: bold.clone(),
                            live: live.clone(),
                            content: None,
                        });
                    } else {
                        paint.push(PaintOp::Text {
                            rect: cell,
                            lines: vec![" ".to_string()],
                            style: bold.clone(),
                        });
                    }
                }
                if !paint.is_empty() {
                    ctx.paint_order.push(Positioned {
                        key: format!("{key}:glyph"),
                        rect: gutter_clipped,
                        paint,
                        clip: clipped,
                    });
                }
            }
            _ => {
                let lines = indication_gutter_lines(gutter, bar_h);
                if !lines.is_empty() {
                    let top_skip = sub_i64(gutter_clipped.y, gutter_rect.y).max(0);
                    let visible: Vec<String> = lines
                        .into_iter()
                        .skip(usize_from_i64(top_skip))
                        .take(usize_from_i64(gutter_clipped.h))
                        .collect();
                    ctx.paint_order.push(Positioned {
                        key: format!("{key}:glyph"),
                        rect: gutter_clipped,
                        paint: vec![PaintOp::Text {
                            rect: gutter_clipped,
                            lines: visible,
                            style: style.clone(),
                        }],
                        clip: clipped,
                    });
                }
            }
        }
    }
    record(ctx, key, clipped);
    let mut cy = rect.y;
    for (i, child) in children.iter().enumerate() {
        let measured = child_ms.get(i).copied().unwrap_or(Extent { w: 0, h: 0 });
        place(
            child,
            Rect {
                x: add_i64(rect.x, INDICATION_CONTENT_INSET),
                y: cy,
                w: content_w.min(measured.w),
                h: measured.h,
            },
            clipped,
            ctx,
        );
        cy = add_i64(cy, measured.h);
    }
}

fn place_disclosure(
    collapsed: bool,
    summary: &Node,
    children: &[Node],
    rect: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    key: &str,
) {
    let Some(clipped) = intersect(rect, clip) else {
        return;
    };
    record(ctx, key, clipped);
    if collapsed {
        place_measured_stack(std::slice::from_ref(summary), rect, clipped, ctx, true);
    } else {
        place_measured_stack(children, rect, clipped, ctx, true);
    }
}

fn place_measured_stack(
    children: &[Node],
    rect: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    skip_outside: bool,
) {
    let measure = ctx.measure;
    let mut cy = rect.y;
    for child in children {
        let measured = measure_cached(child, rect.w, UNBOUNDED_H, measure, ctx.cache);
        if skip_outside && add_i64(cy, measured.h) <= clip.y {
            cy = add_i64(cy, measured.h);
            continue;
        }
        if skip_outside && cy >= add_i64(clip.y, clip.h) {
            break;
        }
        place(
            child,
            Rect {
                x: rect.x,
                y: cy,
                w: rect.w.min(measured.w),
                h: measured.h,
            },
            clip,
            ctx,
        );
        cy = add_i64(cy, measured.h);
    }
}

fn place_overlay(
    center: bool,
    origin: Option<Origin>,
    backdrop: bool,
    backdrop_style: Option<&Style>,
    children: &[Node],
    rect: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    key: &str,
) {
    let Some(full) = intersect(rect, clip) else {
        return;
    };
    if backdrop {
        if let Some(style) = backdrop_style {
            ctx.paint_order.push(Positioned {
                key: format!("{key}:backdrop"),
                rect,
                paint: vec![PaintOp::Fill {
                    rect,
                    style: style.clone(),
                }],
                clip,
            });
        } else {
            stamp_region(&mut ctx.paint_order, BACKDROP_REGION_PROMINENCE);
        }
    }
    if let Some(origin) = origin {
        if children.is_empty() {
            return;
        }
        let ox = add_i64(rect.x, clamp0_i64(origin.x));
        let oy = add_i64(rect.y, clamp0_i64(origin.y));
        let measure = ctx.measure;
        for child in children {
            let max_w = sub_i64(add_i64(rect.x, rect.w), ox).max(0);
            let max_h = sub_i64(add_i64(rect.y, rect.h), oy).max(0);
            let measured = measure_cached(child, max_w, max_h, measure, ctx.cache);
            place(
                child,
                Rect {
                    x: ox,
                    y: oy,
                    w: max_w.min(measured.w),
                    h: max_h.min(measured.h),
                },
                full,
                ctx,
            );
        }
        return;
    }
    if center && !children.is_empty() {
        let child = &children[0];
        let max_w = floor_f64_i64((rect.w as f64) * 0.8);
        let max_h = floor_f64_i64((rect.h as f64) * 0.6);
        let measured = measure_cached(child, max_w, max_h, ctx.measure, ctx.cache);
        let cx = add_i64(rect.x, floor_div(sub_i64(rect.w, measured.w), 2));
        let cy = add_i64(rect.y, floor_div(sub_i64(rect.h, measured.h), 2));
        place(
            child,
            Rect {
                x: cx,
                y: cy,
                w: measured.w,
                h: measured.h,
            },
            full,
            ctx,
        );
        return;
    }
    let measure = ctx.measure;
    let mut cy = add_i64(rect.y, 1);
    let inner_w = sub_i64(rect.w, 2);
    for child in children {
        let measured = measure_cached(child, inner_w, rect.h, measure, ctx.cache);
        place(
            child,
            Rect {
                x: add_i64(rect.x, 1),
                y: cy,
                w: inner_w.min(measured.w),
                h: measured.h,
            },
            full,
            ctx,
        );
        cy = add_i64(cy, measured.h);
    }
}

fn place_viewport(
    anchor: OverflowAnchor,
    scroll: i64,
    children: &[Node],
    rect: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
    key: &str,
) {
    let Some(clipped) = intersect(rect, clip) else {
        return;
    };
    let measure = ctx.measure;
    let mut heights = Vec::with_capacity(children.len());
    let mut total = 0i128;
    for child in children {
        let height = measure_cached(child, rect.w, UNBOUNDED_H, measure, ctx.cache).h;
        total += i128::from(height);
        heights.push(height);
    }
    let total_h = as_i64(total);
    let max_scroll = sub_i64(total_h, rect.h).max(0);
    let scroll_y = match anchor {
        OverflowAnchor::Auto => max_scroll,
        OverflowAnchor::None => scroll.clamp(0, max_scroll),
    };
    let floor_gap = if children.len() >= 2 && total_h < rect.h {
        sub_i64(rect.h, total_h)
    } else {
        0
    };
    record(ctx, key, clipped);
    let mut y = sub_i64(rect.y, scroll_y);
    let lift_mark = ctx.stuck.len();
    for i in 0..children.len() {
        let last = i + 1 == children.len();
        if last {
            y = add_i64(y, floor_gap);
        }
        let h = heights[i];
        if !last && add_i64(y, h) <= clipped.y {
            y = add_i64(y, h);
            continue;
        }
        if !last && y >= add_i64(clipped.y, clipped.h) {
            break;
        }
        let prev_hold = ctx.hold_tail;
        ctx.hold_tail = last && y >= add_i64(clipped.y, clipped.h);
        place(
            &children[i],
            Rect {
                x: rect.x,
                y,
                w: rect.w,
                h,
            },
            clipped,
            ctx,
        );
        ctx.hold_tail = prev_hold;
        y = add_i64(y, h);
    }
    flush_stuck(ctx, lift_mark);
}

fn chrome_to_flex(rect: ChromeRect) -> Rect {
    Rect {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
    }
}

fn chrome_op_to_paint(op: &ChromePaintOp) -> PaintOp {
    match op {
        ChromePaintOp::Text { rect, lines, style } => PaintOp::Text {
            rect: chrome_to_flex(*rect),
            lines: lines.clone(),
            style: style.clone(),
        },
        ChromePaintOp::Live { rect, style, live } => {
            let ChromeLive::Quota {
                windows,
                prefix,
                hz,
            } = live;
            PaintOp::Live {
                rect: chrome_to_flex(*rect),
                style: style.clone(),
                live: LivePaint::Quota {
                    hz: *hz,
                    windows: windows.clone(),
                    prefix: prefix.clone(),
                },
                content: None,
            }
        }
    }
}

fn place_chrome(
    key: &Option<String>,
    frame: &ChromeFrame,
    rect: Rect,
    clip: Rect,
    ctx: &mut Ctx<'_>,
) {
    if intersect(rect, clip).is_none() {
        return;
    }
    let geom = measure_chrome_frame(frame, rect.w, rect.h);
    let place_rect = Rect {
        x: rect.x,
        y: rect.y,
        w: rect.w.min(geom.outer_w),
        h: rect.h.min(geom.total_h).max(1),
    };
    let paint = chrome_frame_paint_ops(
        frame,
        ChromeRect::new(place_rect.x, place_rect.y, place_rect.w, place_rect.h),
    );
    let ops: Vec<PaintOp> = paint.ops.iter().map(chrome_op_to_paint).collect();
    if !ops.is_empty() {
        let paint_key = match key.as_deref().filter(|key| !key.is_empty()) {
            Some(key) => format!("{key}:frame"),
            None => "chrome_frame:frame".to_string(),
        };
        ctx.paint_order.push(Positioned {
            key: paint_key,
            rect: place_rect,
            paint: ops,
            clip,
        });
    }
    if let Some(key) = key.as_deref().filter(|key| !key.is_empty()) {
        record(ctx, key, place_rect);
    }
}

fn place(node: &Node, rect: Rect, clip: Rect, ctx: &mut Ctx<'_>) {
    if let Some(next) = realize(node) {
        place(&next, rect, clip, ctx);
        return;
    }
    let region_start = ctx.paint_order.len();
    let natural_y = rect.y;
    let rect = sticky_bottom_rect(node, rect, clip);
    let rect = sticky_top_rect(node, rect, clip, ctx.sticky_floor);
    ctx.path.push(type_name(node));
    let key = key_of(node, &ctx.path);
    match node {
        Node::Text { .. } => place_text(node, rect, clip, ctx, &key),
        Node::Box {
            style, children, ..
        } => {
            place_box(style, children, rect, natural_y, clip, ctx, &key);
        }
        Node::Flex {
            style, children, ..
        } => place_flex(style, children, rect, clip, ctx),
        Node::Grid {
            style,
            line_style,
            children,
            ..
        } => place_grid(style, line_style.as_ref(), children, rect, clip, ctx, &key),
        Node::Indication {
            gutter,
            style,
            children,
            ..
        } => place_indication(gutter, style, children, rect, clip, ctx, &key),
        Node::Overlay {
            center,
            origin,
            backdrop,
            backdrop_style,
            children,
            ..
        } => place_overlay(
            *center,
            *origin,
            *backdrop,
            backdrop_style.as_ref(),
            children,
            rect,
            clip,
            ctx,
            &key,
        ),
        Node::Disclosure {
            collapsed,
            summary,
            children,
            ..
        } => place_disclosure(*collapsed, summary, children, rect, clip, ctx, &key),
        Node::Squeeze {
            head,
            tail,
            children,
            ..
        } => {
            if let Some(hit) = intersect(rect, clip) {
                record(ctx, &key, hit);
            }
            place_squeezed(children, rect, clip, ctx, &key, *head, *tail);
        }
        Node::Viewport {
            anchor,
            scroll,
            children,
            ..
        } => place_viewport(*anchor, *scroll, children, rect, clip, ctx, &key),
        Node::IndentationException { children, .. } => {
            if let Some(hit) = intersect(rect, clip) {
                record(ctx, &key, hit);
            }
            place_measured_stack(children, rect, clip, ctx, false);
        }
        Node::Chrome { key, frame } => place_chrome(key, frame, rect, clip, ctx),
        Node::Markdown { .. } | Node::Diff { .. } | Node::Skipped => {}
    }
    if let Some(region) = region_of(node) {
        stamp_region(&mut ctx.paint_order[region_start..], region);
    }
    if rect.y != natural_y && is_sticky_top(node) {
        ctx.stuck.push(StuckLift {
            paint_at: region_start,
            paint_to: ctx.paint_order.len(),
        });
    }
    ctx.path.pop();
}

/// `layout`. The root is placed in `(0, 0, max(1, w), max(1, h))` and clipped
/// to that same rect. Sticky-top lifts that no viewport flushed are moved to
/// the end of [`Frame::paint_order`].
pub fn layout(root: &Node, viewport: Viewport, opts: LayoutOpts<'_>) -> Frame {
    let LayoutOpts {
        measure,
        frame_version,
        wrap_memo,
        measure_token,
    } = opts;
    let mut ctx = Ctx {
        measure,
        cache: Cache {
            memo: wrap_memo.as_deref(),
            token: measure_token,
        },
        path: Vec::new(),
        paint_order: Vec::new(),
        placed: Vec::new(),
        stuck: Vec::new(),
        hold_tail: false,
        sticky_floor: None,
    };
    let w = viewport.w.max(1);
    let h = viewport.h.max(1);
    let rect = Rect { x: 0, y: 0, w, h };
    place(root, rect, rect, &mut ctx);
    flush_stuck(&mut ctx, 0);
    let live_demand = collect_live_demand(&ctx.paint_order);
    Frame {
        version: frame_version.unwrap_or(1),
        paint_order: ctx.paint_order,
        placed: ctx.placed,
        viewport: Viewport { w, h },
        live_demand,
    }
}
