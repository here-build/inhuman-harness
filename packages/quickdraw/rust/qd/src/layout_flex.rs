//! Flex free-space and CSS-grid track sizing for terminal cells.
//!
//! [`Length`] is a cell length. `fr`, percent, `ch`, and `lh` are enum
//! variants — this module does not re-parse `"1fr"` or `"50%"`.
//! [`resolve_length`] matches `resolveLength` in `layout/length.ts` (the
//! unused `axis` argument is omitted). `fr` stays [`ResolvedLength::Auto`]
//! until the flex or grid free-space pass. [`ResolvedLength::cells`] floors
//! a definite length the way `clamp0` does.
//!
//! [`distribute_exact`] is largest-remainder apportionment (`distributeExact`).
//! Non-finite and non-positive weights are 0 before the sum, so NaN and
//! Infinity cannot poison a track. [`resolve_flex_item`] / [`flex_main_sizes`]
//! are one flex line. `flex: n` ([`FlexFactor::Sugar`]) is grow `n`, shrink 1,
//! basis 0, min main 0. [`FlexItemInput::max`] `None` is +∞.
//!
//! [`FlexDirection::RowReverse`] is laid out as a row and
//! [`FlexDirection::ColumnReverse`] as a column. Child order is not reversed.
//! [`flex_child_rects`] is the flex arm of `place`: main sizes, then
//! `justifyContent`. The rect is the child's border box in the rect `place`
//! was given. A flex node's own `width` / `height` do not change that rect.
//! The TS placer does not pass `maxWidth` / `maxHeight` into `resolveFlexItem`,
//! so a box has no max-main unless [`FlexItemStyle::max_main`] is set on a
//! direct call.
//!
//! [`resolve_column_tracks`] sizes one column row (`resolveColumnTracks`).
//! Auto and `fr` start at max-content. Leftover container space goes only to
//! `fr` — auto does not stretch. A deficit drains every track from its size
//! down toward content min, in proportion to that slack, then toward 1.
//! A fixed or percent size is the start, not a floor. [`tracks_extent`] and
//! [`track_offsets`] are the gap math. [`cell_pad_xy`] splits `cellPad`.
//!
//! [`measure_grid_dims`] is the shared grid geometry. Empty `columns`
//! synthesize one `auto` track so `n_cols` and `col_widths` stay aligned.
//! [`GridLines::Inner`] defaults an omitted gap to 1. [`measure_node`] is the
//! `text` / `box` / `flex` / `grid` arms of `measureNode` — the nodes those
//! functions measure. Text columns go through
//! [`crate::layout_text::measure_text_node`]. [`measure_grid`] is the grid
//! arm (measured size clamped to the max, which can be smaller than the
//! track extent when the grid is later placed in a larger rect).
//! [`grid_cell_rects`] is the grid arm of `place`: track offset plus pad.
//! The rects are unclipped; `place` drops a content box that misses the clip.
//!
//! This module does not paint, hit-test, or walk overlay, sticky, viewport,
//! chrome, or markdown. Those assertions are listed as BLOCKED in
//! `tests/layout_flex_oracle.rs`.

use crate::layout_text::{measure_text_node, TextNode};
use crate::measure::display_width;

type Measure<'a> = Option<&'a dyn Fn(&str) -> usize>;

/// Cell-grid length. Not a string.
///
/// [`Length::Cells`] is an integer count. A fractional cell count is
/// [`Length::Ch`] or [`Length::Lh`], which `resolveLength` does not floor.
/// [`Length::Pct`] floors in [`resolve_length`]. [`Length::Fr`] is free space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Length {
    Auto,
    /// Already-integral cells. Negatives resolve to 0.
    Cells(i64),
    /// `fr` weight. Resolved in the flex/grid free-space pass, not here.
    Fr(f64),
    /// Percent of the containing block. Floored.
    Pct(f64),
    /// `ch` cells. Not floored until a track or `clamp0` consumer.
    Ch(f64),
    /// `lh` cells. Same resolution as [`Length::Ch`].
    Lh(f64),
}

impl Length {
    /// True for every `fr` track, including a zero or negative weight.
    pub fn is_fr(self) -> bool {
        matches!(self, Length::Fr(_))
    }
}

pub fn is_fr(len: Length) -> bool {
    len.is_fr()
}

/// Result of [`resolve_length`]. `fr` is [`ResolvedLength::Auto`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ResolvedLength {
    /// Indefinite: omitted, `"auto"`, or `fr`.
    Auto,
    /// Definite cells. `ch` / `lh` may be fractional; percent and [`Length::Cells`] are not.
    Cells(f64),
}

impl ResolvedLength {
    pub fn is_auto(self) -> bool {
        matches!(self, ResolvedLength::Auto)
    }

    /// `clamp0` of a definite length. [`ResolvedLength::Auto`] is 0 — branch
    /// on [`Self::is_auto`] first. Non-finite values are 0.
    pub fn cells(self) -> i64 {
        match self {
            ResolvedLength::Auto => 0,
            ResolvedLength::Cells(v) => floor_nonneg_f64(v),
        }
    }
}

/// Resolve `len` against a containing block in cells.
///
/// `None` is omitted CSS (`undefined`), which is `"auto"`.
pub fn resolve_length(len: Option<Length>, containing_block: i64) -> ResolvedLength {
    match len {
        None | Some(Length::Auto) | Some(Length::Fr(_)) => ResolvedLength::Auto,
        Some(Length::Cells(n)) => ResolvedLength::Cells((n.max(0)) as f64),
        Some(Length::Pct(pct)) => {
            let v = (containing_block as f64) * pct / 100.0;
            ResolvedLength::Cells(finite_nonneg(v.floor()))
        }
        Some(Length::Ch(ch)) => ResolvedLength::Cells(finite_nonneg(ch)),
        Some(Length::Lh(lh)) => ResolvedLength::Cells(finite_nonneg(lh)),
    }
}

/// Largest-remainder split of `total` across non-negative weights.
///
/// Non-finite or non-positive weights contribute 0. A non-finite or
/// non-positive `total`, or a non-positive weight sum, yields zeros.
/// The returned values are integers. Equal fractional parts keep earlier
/// indexes first (stable descending sort), matching `Array#sort`.
pub fn distribute_exact(weights: &[f64], total: f64) -> Vec<i64> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let finite_w = |w: f64| -> f64 {
        if w.is_finite() && w > 0.0 {
            w
        } else {
            0.0
        }
    };
    let mut sum = 0.0;
    for w in weights {
        sum += finite_w(*w);
    }
    if sum <= 0.0 || !total.is_finite() || total <= 0.0 {
        return vec![0; n];
    }

    let mut raw = Vec::with_capacity(n);
    let mut floors = Vec::with_capacity(n);
    for w in weights {
        let x = finite_w(*w) / sum * total;
        raw.push(x);
        floors.push(f64_floor_i64(x));
    }
    let floor_sum: i128 = floors.iter().copied().map(i128::from).sum();
    let mut rem = total - (floor_sum as f64);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        let fa = raw[a] - raw[a].floor();
        let fb = raw[b] - raw[b].floor();
        fb.total_cmp(&fa)
    });
    let mut out = floors;
    let mut k = 0;
    while k < order.len() && rem > 0.0 {
        out[order[k]] += 1;
        rem -= 1.0;
        k += 1;
    }
    out
}

/// `flex: n` or the longhand `{ grow, shrink, basis }`.
///
/// Basis on the longhand is a cell count (`typeof === "number"`). A length
/// object is not a number; the TS engine drops those the same way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FlexFactor {
    /// `flex: n` — grow `floor(n)`, shrink 1, basis 0, min main 0.
    Sugar(f64),
    /// `flex: { grow, shrink, basis }`. Omitted grow is 0, omitted shrink is 1.
    Longhand {
        grow: Option<f64>,
        shrink: Option<f64>,
        basis: Option<i64>,
    },
}

/// Fields [`resolve_flex_item`] reads. Omitted options are `undefined`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlexItemStyle {
    pub flex: Option<FlexFactor>,
    pub flex_grow: Option<f64>,
    pub flex_shrink: Option<f64>,
    pub flex_basis: Option<i64>,
    pub min_main: Option<i64>,
    pub max_main: Option<i64>,
    pub explicit_main: Option<i64>,
}

/// One flex item after [`resolve_flex_item`].
///
/// `max: None` is +∞. `base` is clamped into `[min, max]` when max is finite,
/// and up to `min` when max is below min (same as `Math.max(min, Math.min(max, base))`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlexItemInput {
    pub base: i64,
    pub min: i64,
    pub max: Option<i64>,
    pub grow: i64,
    pub shrink: i64,
}

/// Resolve grow, shrink, basis, and the clamped base.
///
/// `content_main` is the measured main size. It is the min main until sugar
/// or [`FlexItemStyle::min_main`] replaces it, and the base when basis is auto
/// and there is no explicit main.
pub fn resolve_flex_item(style: &FlexItemStyle, content_main: i64) -> FlexItemInput {
    let mut grow = 0i64;
    let mut shrink = 1i64;
    let mut basis: Option<i64> = None;
    let mut min_main = content_main;
    let mut max_main: Option<i64> = None;

    match style.flex {
        None => {
            if let Some(value) = style.flex_grow {
                grow = floor_factor(value);
            }
            if let Some(value) = style.flex_shrink {
                shrink = floor_factor(value);
            }
            if let Some(value) = style.flex_basis {
                basis = Some(value);
            }
        }
        Some(FlexFactor::Sugar(n)) => {
            grow = floor_factor(n);
            shrink = 1;
            basis = Some(0);
            min_main = 0;
        }
        Some(FlexFactor::Longhand {
            grow: g,
            shrink: s,
            basis: b,
        }) => {
            grow = floor_factor(g.unwrap_or(0.0));
            shrink = floor_factor(s.unwrap_or(1.0));
            if let Some(value) = b {
                basis = Some(value);
            }
        }
    }

    if let Some(value) = style.min_main {
        min_main = value;
    }
    if let Some(value) = style.max_main {
        max_main = Some(value);
    }

    let unresolved = if let Some(explicit) = style.explicit_main {
        explicit
    } else {
        basis.unwrap_or(content_main)
    };
    let capped = match max_main {
        Some(max) => unresolved.min(max),
        None => unresolved,
    };
    let base = min_main.max(capped);
    FlexItemInput {
        base,
        min: min_main,
        max: max_main,
        grow,
        shrink,
    }
}

/// Main sizes for one flex line.
///
/// `free = container_main - sum(base) - gaps`. Positive free grows by `grow`.
/// Negative free shrinks by `shrink * max(1, base)`, then clamps to min.
/// A max clamp does not run a second grow pass. If the line is still wider
/// than the container, the overflow is cut from the last item backward, not
/// below `min`.
pub fn flex_main_sizes(items: &[FlexItemInput], container_main: i64, gap: i64) -> Vec<i64> {
    let n = items.len();
    if n == 0 {
        return Vec::new();
    }
    let gaps = gap * (n as i64 - 1).max(0);
    let mut sizes: Vec<i64> = items.iter().map(|it| it.base).collect();
    let used = sizes.iter().sum::<i64>() + gaps;
    let free = container_main - used;

    if free > 0 {
        let weights: Vec<f64> = items.iter().map(|it| it.grow as f64).collect();
        let add = distribute_exact(&weights, free as f64);
        for i in 0..n {
            let next = sizes[i] + add[i];
            sizes[i] = match items[i].max {
                Some(max) => next.min(max),
                None => next,
            };
        }
    } else if free < 0 {
        let need = -free;
        let weights: Vec<f64> = items
            .iter()
            .map(|it| (it.shrink * it.base.max(1)) as f64)
            .collect();
        let sub = distribute_exact(&weights, need as f64);
        for i in 0..n {
            sizes[i] = items[i].min.max(sizes[i] - sub[i]);
        }
    }

    let total = sizes.iter().sum::<i64>() + gaps;
    if total > container_main {
        let mut overflow = total - container_main;
        for i in (0..n).rev() {
            if overflow <= 0 {
                break;
            }
            let room = sizes[i] - items[i].min;
            let cut = room.min(overflow);
            sizes[i] -= cut;
            overflow -= cut;
        }
    }
    sizes
}

/// `lines` on a grid. Omitted CSS is [`GridLines::None`], not inner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GridLines {
    #[default]
    None,
    Inner,
}

/// `cellPad`: one number, or `{ x, y }` with omitted axes as 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellPad {
    Uniform(i64),
    Axes { x: Option<i64>, y: Option<i64> },
}

/// Horizontal and vertical cell pad, each `max(0, floor)`.
pub fn cell_pad_xy(cell_pad: Option<CellPad>) -> (i64, i64) {
    match cell_pad {
        None => (0, 0),
        Some(CellPad::Uniform(n)) => {
            let n = n.max(0);
            (n, n)
        }
        Some(CellPad::Axes { x, y }) => (x.unwrap_or(0).max(0), y.unwrap_or(0).max(0)),
    }
}

/// Column widths for one grid row.
///
/// `content_max` / `content_min` are per column. A missing min uses that
/// column's max (no wrap slack). Lengths past `tracks` are ignored; a short
/// slice reads as 0 max-content. `container_w` and `column_gap` are cells.
pub fn resolve_column_tracks(
    tracks: &[Length],
    content_max: &[i64],
    container_w: i64,
    column_gap: i64,
    content_min: Option<&[i64]>,
) -> Vec<i64> {
    resolve_column_tracks_f64(
        tracks,
        content_max,
        container_w as f64,
        column_gap,
        content_min,
    )
}

fn resolve_column_tracks_f64(
    tracks: &[Length],
    content_max: &[i64],
    container_w: f64,
    column_gap: i64,
    content_min: Option<&[i64]>,
) -> Vec<i64> {
    let n = tracks.len();
    if n == 0 {
        return Vec::new();
    }
    let gaps = if n <= 1 {
        0.0
    } else {
        column_gap as f64 * (n - 1) as f64
    };
    let container = if container_w.is_finite() {
        container_w
    } else {
        0.0
    };
    let free_budget = (container - gaps).max(0.0);

    let mut sizes = vec![0.0; n];
    let mut mins = vec![0.0; n];
    let mut fr_weights = vec![0.0; n];
    let mut fixed_sum = 0.0;
    let mut fr_count = 0i64;

    for i in 0..n {
        let cmax = finite_nonneg(content_max.get(i).copied().unwrap_or(0) as f64);
        let cmin = match content_min.and_then(|mins| mins.get(i)).copied() {
            Some(raw) => finite_nonneg(raw as f64).min(cmax),
            None => cmax,
        };
        mins[i] = cmin;

        match tracks[i] {
            Length::Auto => {
                sizes[i] = cmax;
                fixed_sum += cmax;
            }
            Length::Fr(fr) => {
                fr_weights[i] = finite_nonneg(fr);
                fr_count += 1;
                sizes[i] = cmax;
                fixed_sum += cmax;
            }
            Length::Pct(pct) => {
                // Containing block is the gap-excluded budget, not the outer width.
                let resolved = finite_nonneg(((free_budget * pct) / 100.0).floor());
                let v = cmax.max(resolved);
                sizes[i] = v;
                fixed_sum += v;
            }
            Length::Cells(_) | Length::Ch(_) | Length::Lh(_) => {
                // `ch` / `lh` ignore the containing block; cells are already counts.
                let resolved = match resolve_length(Some(tracks[i]), 0) {
                    ResolvedLength::Cells(v) => finite_nonneg(v),
                    ResolvedLength::Auto => cmax,
                };
                let v = cmax.max(resolved);
                sizes[i] = v;
                fixed_sum += v;
            }
        }
    }

    let free = free_budget - fixed_sum;
    if free > 0.0 && fr_count > 0 {
        let add = distribute_exact(&fr_weights, free);
        for i in 0..n {
            sizes[i] += add[i] as f64;
        }
    } else if free < 0.0 {
        let mut need = -free;
        let slack: Vec<f64> = sizes
            .iter()
            .zip(mins.iter())
            .map(|(size, min)| (size - min).max(0.0))
            .collect();
        need = drain(&mut sizes, &slack, need);
        if need > 0.0 {
            let toward_one: Vec<f64> = sizes.iter().map(|size| (size - 1.0).max(0.0)).collect();
            drain(&mut sizes, &toward_one, need);
        }
    }

    sizes.into_iter().map(floor_nonneg_f64).collect()
}

/// Sum of track sizes plus the gaps between them. Empty is 0.
pub fn tracks_extent(sizes: &[i64], gap: i64) -> i64 {
    if sizes.is_empty() {
        return 0;
    }
    sizes.iter().sum::<i64>() + gap * (sizes.len() as i64 - 1).max(0)
}

/// `offset[i]` is the start of track `i`.
pub fn track_offsets(sizes: &[i64], gap: i64) -> Vec<i64> {
    let mut out = Vec::with_capacity(sizes.len());
    let mut x = 0i64;
    for (i, size) in sizes.iter().enumerate() {
        out.push(x);
        if i + 1 < sizes.len() {
            x += size + gap;
        }
    }
    out
}

/// Subtract `need` in proportion to `weights`, never more than each weight or size.
///
/// Returns the unmet remainder. Largest-remainder can hand a part bigger than
/// its weight; the cut is capped, and the cap stays in the remainder.
fn drain(sizes: &mut [f64], weights: &[f64], need: f64) -> f64 {
    if !(need > 0.0) {
        return 0.0;
    }
    let mut cap = 0.0;
    for w in weights {
        if w.is_finite() && *w > 0.0 {
            cap += *w;
        }
    }
    let take = need.min(cap);
    if !(take > 0.0) {
        return need;
    }
    let cut = distribute_exact(weights, take);
    let mut actual = 0.0;
    for i in 0..sizes.len() {
        let cut_i = if i < cut.len() { cut[i] as f64 } else { 0.0 };
        let w = weights.get(i).copied().unwrap_or(0.0);
        let w = if w.is_finite() { w.max(0.0) } else { 0.0 };
        let c = cut_i.min(w).min(sizes[i]);
        sizes[i] -= c;
        actual += c;
    }
    need - actual
}

/// Padding. A bare number is all four edges, floored at 0. Per-edge values
/// are `max(0, _)` and are not floored again (they are already cells).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Padding {
    Uniform(i64),
    Edges {
        t: Option<i64>,
        r: Option<i64>,
        b: Option<i64>,
        l: Option<i64>,
    },
}

#[derive(Clone, Copy, Debug)]
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
            let n = n.max(0);
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

/// Main axis. Reverse values do not flip child order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FlexDirection {
    #[default]
    Row,
    Column,
    RowReverse,
    ColumnReverse,
}

/// `justify-content`. Default is start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum JustifyContent {
    #[default]
    FlexStart,
    FlexEnd,
    Center,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}

/// `align-items`. Default is stretch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AlignItems {
    FlexStart,
    FlexEnd,
    Center,
    #[default]
    Stretch,
}

/// Flex container style. `gap` is cells; the placer clamps negatives to 0.
/// `width` / `height` affect [`measure_node`] of a column, not [`flex_child_rects`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlexStyle {
    pub direction: FlexDirection,
    pub gap: i64,
    pub justify_content: JustifyContent,
    pub align_items: AlignItems,
    pub padding: Option<Padding>,
    pub width: Option<Length>,
    pub height: Option<Length>,
}

/// Box fields the flex placer and box measure read.
///
/// `flex_basis` is honored only for [`Length::Cells`] (`typeof === "number"`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BoxStyle {
    pub width: Option<Length>,
    pub height: Option<Length>,
    pub min_width: Option<Length>,
    pub min_height: Option<Length>,
    pub padding: Option<Padding>,
    pub border: bool,
    pub flex: Option<FlexFactor>,
    pub flex_grow: Option<f64>,
    pub flex_shrink: Option<f64>,
    pub flex_basis: Option<Length>,
}

/// Grid container style. `columns` empty means one synthesized `auto` track.
#[derive(Clone, Debug, PartialEq)]
pub struct GridStyle {
    pub columns: Vec<Length>,
    pub column_gap: Option<i64>,
    pub row_gap: Option<i64>,
    pub lines: GridLines,
    pub cell_pad: Option<CellPad>,
    pub width: Option<Length>,
    pub height: Option<Length>,
}

impl GridStyle {
    /// No lines, no pad, gaps omitted (0 unless `lines` is later set to inner).
    pub fn columns(columns: Vec<Length>) -> Self {
        Self {
            columns,
            column_gap: None,
            row_gap: None,
            lines: GridLines::None,
            cell_pad: None,
            width: None,
            height: None,
        }
    }
}

/// A node [`measure_node`], [`flex_child_rects`], and [`grid_cell_rects`] can see.
///
/// Text is a [`TextNode`]. There is no overlay, viewport, chrome, markdown, or
/// disclosure arm — those stay in the layout engine.
pub enum Node<'a> {
    Text(TextNode<'a>),
    Box {
        style: BoxStyle,
        children: Vec<Node<'a>>,
    },
    Flex {
        style: FlexStyle,
        children: Vec<Node<'a>>,
    },
    Grid {
        style: GridStyle,
        children: Vec<Node<'a>>,
    },
}

/// `{ w, h }` in cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Extent {
    pub w: i64,
    pub h: i64,
}

/// Border box or content box, in cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// One placed grid child. `cell` is the track box; `content` is inside the pad.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellRect {
    pub index: usize,
    pub row: usize,
    pub col: usize,
    pub cell: Rect,
    pub content: Rect,
}

/// Resolved grid geometry. `n_cols` matches `col_widths.len()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GridDims {
    pub col_widths: Vec<i64>,
    pub row_heights: Vec<i64>,
    pub col_gap: i64,
    pub row_gap: i64,
    pub pad_x: i64,
    pub pad_y: i64,
    pub n_cols: usize,
    pub n_rows: usize,
    pub total_w: i64,
    pub total_h: i64,
}

/// Measure `text` / `box` / `flex` / `grid`.
///
/// `measure: None` is [`display_width`]. A text stamp is honored inside
/// [`measure_text_node`]. The row-flex arm does not `clamp0` (a negative max
/// stays negative). Column, box, and grid do.
pub fn measure_node(node: &Node<'_>, max_w: i64, max_h: i64, measure: Measure<'_>) -> Extent {
    match node {
        Node::Text(text) => {
            let measured = measure_text_node(text, max_w, max_h, measure);
            Extent {
                w: measured.w,
                h: measured.h,
            }
        }
        Node::Box { style, children } => measure_box(style, children, max_w, max_h, measure),
        Node::Flex { style, children } => measure_flex(style, children, max_w, max_h, measure),
        Node::Grid { style, children } => measure_grid(style, children, max_w, max_h, measure),
    }
}

/// Grid arm of `measureNode`: track extent, or the resolved `width` / `height`,
/// then `clamp0(min(max, _))`.
pub fn measure_grid(
    style: &GridStyle,
    children: &[Node<'_>],
    max_w: i64,
    max_h: i64,
    measure: Measure<'_>,
) -> Extent {
    let dims = measure_grid_dims(style, children, max_w, measure);
    let w = match resolve_length(style.width, max_w) {
        ResolvedLength::Auto => dims.total_w as f64,
        ResolvedLength::Cells(v) => v,
    };
    let h = match resolve_length(style.height, max_h) {
        ResolvedLength::Auto => dims.total_h as f64,
        ResolvedLength::Cells(v) => v,
    };
    Extent {
        w: floor_nonneg_f64((max_w as f64).min(w)),
        h: floor_nonneg_f64((max_h as f64).min(h)),
    }
}

/// Track widths, row heights, gaps, and pad for one grid.
///
/// Max-content is measured at `max(max_w, 10_000)`. Min-content is the longest
/// whitespace-delimited token, then clamped to max-content. Row height is a
/// second measure at the column's inner width. A missing cell's row floor is
/// `max(1, padY * 2 || 1)` — a zero pad is falsy, so the floor stays 1.
pub fn measure_grid_dims(
    style: &GridStyle,
    children: &[Node<'_>],
    max_w: i64,
    measure: Measure<'_>,
) -> GridDims {
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
        (children.len() + n_cols - 1) / n_cols
    };

    let mut content_max = vec![0i64; n_cols];
    let mut content_min = vec![0i64; n_cols];
    let probe_w = max_w.max(10_000);
    for (i, child) in children.iter().enumerate() {
        let col = i % n_cols;
        let measured = measure_node(child, probe_w, 10_000, measure);
        content_max[col] = content_max[col].max(measured.w + pad_x * 2);
        content_min[col] = content_min[col].max(min_content_width(child, measure) + pad_x * 2);
    }
    for col in 0..n_cols {
        content_min[col] = content_min[col].min(content_max[col]);
    }

    let available_w = match resolve_length(style.width, max_w) {
        ResolvedLength::Auto => max_w as f64,
        ResolvedLength::Cells(v) => finite_nonneg(v),
    };
    let col_widths = resolve_column_tracks_f64(
        tracks,
        &content_max,
        available_w,
        col_gap,
        Some(&content_min),
    );

    let mut row_heights = vec![1i64; n_rows];
    for r in 0..n_rows {
        let mut rh = 1i64;
        for c in 0..n_cols {
            let idx = r * n_cols + c;
            let Some(child) = children.get(idx) else {
                rh = rh.max(vacant_row_floor(pad_y));
                continue;
            };
            let inner_w = (col_widths[c] - pad_x * 2).max(1);
            let measured = measure_node(child, inner_w, 10_000, measure);
            rh = rh.max(measured.h + pad_y * 2);
        }
        row_heights[r] = rh;
    }

    let total_w = tracks_extent(&col_widths, col_gap);
    let total_h = tracks_extent(&row_heights, row_gap);
    GridDims {
        n_cols,
        n_rows,
        col_widths,
        row_heights,
        col_gap,
        row_gap,
        pad_x,
        pad_y,
        total_w,
        total_h,
    }
}

/// Unclipped content boxes for each grid child, in row-major order.
///
/// `rect.w` is the container width passed to [`measure_grid_dims`] (for a root
/// grid, the viewport width — not the measured extent).
pub fn grid_cell_rects(
    style: &GridStyle,
    children: &[Node<'_>],
    rect: Rect,
    measure: Measure<'_>,
) -> Vec<CellRect> {
    let dims = measure_grid_dims(style, children, rect.w, measure);
    let col_off = track_offsets(&dims.col_widths, dims.col_gap);
    let row_off = track_offsets(&dims.row_heights, dims.row_gap);
    let mut out = Vec::new();
    for r in 0..dims.n_rows {
        for c in 0..dims.n_cols {
            let idx = r * dims.n_cols + c;
            if idx >= children.len() {
                continue;
            }
            let cell = Rect {
                x: rect.x + col_off[c],
                y: rect.y + row_off[r],
                w: dims.col_widths[c],
                h: dims.row_heights[r],
            };
            let content = Rect {
                x: cell.x + dims.pad_x,
                y: cell.y + dims.pad_y,
                w: (cell.w - dims.pad_x * 2).max(0),
                h: (cell.h - dims.pad_y * 2).max(0),
            };
            out.push(CellRect {
                index: idx,
                row: r,
                col: c,
                cell,
                content,
            });
        }
    }
    out
}

/// Border boxes of a flex container's direct children.
///
/// Both directions measure children against the content box. Justify uses
/// [`distribute_exact`] for `space_between`, `space_around`, and `space_evenly`.
/// Only a [`Node::Box`] contributes flex factors; its `width` (row) or
/// `height` (column) is the explicit main when that length is definite.
pub fn flex_child_rects(
    style: &FlexStyle,
    children: &[Node<'_>],
    rect: Rect,
    measure: Measure<'_>,
) -> Vec<Rect> {
    let n = children.len();
    if n == 0 {
        return Vec::new();
    }
    let pd = pad_edges(style.padding);
    let content = Rect {
        x: rect.x + pd.l,
        y: rect.y + pd.t,
        w: (rect.w - pd.l - pd.r).max(0),
        h: (rect.h - pd.t - pd.b).max(0),
    };
    let row = !matches!(
        style.direction,
        FlexDirection::Column | FlexDirection::ColumnReverse
    );
    let gap = style.gap.max(0);
    let main_size = if row { content.w } else { content.h };
    let cross_size = if row { content.h } else { content.w };

    // The engine's row/column ternaries both pass the content box.
    let mut measured = Vec::with_capacity(n);
    for child in children {
        measured.push(measure_node(child, content.w, content.h, measure));
    }
    let mut inputs = Vec::with_capacity(n);
    for i in 0..n {
        inputs.push(flex_input_for_child(
            &children[i],
            row,
            content,
            measured[i],
        ));
    }
    let mains = flex_main_sizes(&inputs, main_size, gap);

    let used_main = mains.iter().sum::<i64>() + gap * (n as i64 - 1).max(0);
    let free_main = (main_size - used_main).max(0);
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
                    let extras = distribute_exact(&weights, free_main as f64);
                    for i in 0..n - 1 {
                        betweens[i] = gap + extras[i];
                    }
                }
            }
            JustifyContent::SpaceAround => {
                let mut weights = vec![2.0; n + 1];
                weights[0] = 1.0;
                weights[n] = 1.0;
                let parts = distribute_exact(&weights, free_main as f64);
                start_off = parts[0];
                for i in 0..n - 1 {
                    betweens[i] = gap + parts[i + 1];
                }
            }
            JustifyContent::SpaceEvenly => {
                let weights = vec![1.0; n + 1];
                let parts = distribute_exact(&weights, free_main as f64);
                start_off = parts[0];
                for i in 0..n - 1 {
                    betweens[i] = gap + parts[i + 1];
                }
            }
        }
    }

    let mut cursor = (if row { content.x } else { content.y }) + start_off;
    let mut rects = Vec::with_capacity(n);
    for i in 0..n {
        let main = mains[i];
        let mut cross = if row { measured[i].h } else { measured[i].w };
        if style.align_items == AlignItems::Stretch {
            cross = cross_size;
        }
        let mut cross_off = 0i64;
        if style.align_items == AlignItems::Center {
            cross_off = floor_div(cross_size - cross, 2);
        }
        if style.align_items == AlignItems::FlexEnd {
            cross_off = cross_size - cross;
        }
        let child_rect = if row {
            Rect {
                x: cursor,
                y: content.y + cross_off,
                w: main,
                h: cross.min(content.h),
            }
        } else {
            Rect {
                x: content.x + cross_off,
                y: cursor,
                w: cross.min(content.w),
                h: main,
            }
        };
        rects.push(child_rect);
        if i + 1 < n {
            cursor += main + betweens[i];
        }
    }
    rects
}

fn flex_input_for_child(
    child: &Node<'_>,
    row: bool,
    content: Rect,
    measured: Extent,
) -> FlexItemInput {
    let content_main = if row { measured.w } else { measured.h };
    let along = if row { content.w } else { content.h };
    let style = match child {
        Node::Box { style, .. } => Some(style),
        _ => None,
    };
    let explicit_main = style.and_then(|s| {
        let len = if row { s.width } else { s.height };
        definite_cells(len, along)
    });
    let min_main = style.and_then(|s| {
        let len = if row { s.min_width } else { s.min_height };
        definite_cells(len, along)
    });
    let flex_basis = style.and_then(|s| match s.flex_basis {
        Some(Length::Cells(n)) => Some(n),
        _ => None,
    });
    resolve_flex_item(
        &FlexItemStyle {
            flex: style.and_then(|s| s.flex),
            flex_grow: style.and_then(|s| s.flex_grow),
            flex_shrink: style.and_then(|s| s.flex_shrink),
            flex_basis,
            min_main,
            max_main: None,
            explicit_main,
        },
        content_main,
    )
}

fn definite_cells(len: Option<Length>, containing_block: i64) -> Option<i64> {
    match resolve_length(len, containing_block) {
        ResolvedLength::Auto => None,
        ResolvedLength::Cells(v) => Some(floor_nonneg_f64(v)),
    }
}

fn measure_box(
    style: &BoxStyle,
    children: &[Node<'_>],
    max_w: i64,
    max_h: i64,
    measure: Measure<'_>,
) -> Extent {
    let pd = pad_edges(style.padding);
    let border = if style.border { 1 } else { 0 };
    let inner_w = (max_w - pd.l - pd.r - border * 2).max(0);
    let inner_h = (max_h - pd.t - pd.b - border * 2).max(0);
    let mut cw = 0i64;
    let mut ch = 0i64;
    for child in children {
        let measured = measure_node(child, inner_w, inner_h, measure);
        cw = cw.max(measured.w);
        ch += measured.h;
    }
    let w = match resolve_length(style.width, max_w) {
        ResolvedLength::Auto => (cw + pd.l + pd.r + border * 2) as f64,
        ResolvedLength::Cells(v) => v,
    };
    let h = match resolve_length(style.height, max_h) {
        ResolvedLength::Auto => (ch + pd.t + pd.b + border * 2) as f64,
        ResolvedLength::Cells(v) => v,
    };
    Extent {
        w: floor_nonneg_f64((max_w as f64).min(w)),
        h: floor_nonneg_f64((max_h as f64).min(h)),
    }
}

fn measure_flex(
    style: &FlexStyle,
    children: &[Node<'_>],
    max_w: i64,
    max_h: i64,
    measure: Measure<'_>,
) -> Extent {
    let pd = pad_edges(style.padding);
    let gap = style.gap.max(0);
    let inner_w = (max_w - pd.l - pd.r).max(0);
    let inner_h = (max_h - pd.t - pd.b).max(0);
    let column = matches!(
        style.direction,
        FlexDirection::Column | FlexDirection::ColumnReverse
    );
    if !column {
        let mut sum = 0i64;
        let mut max_cross = 0i64;
        for (i, child) in children.iter().enumerate() {
            let measured = measure_node(child, inner_w, inner_h, measure);
            sum += measured.w;
            if i > 0 {
                sum += gap;
            }
            max_cross = max_cross.max(measured.h);
        }
        // Row measure ignores width and height. The column arm below uses them.
        return Extent {
            w: max_w.min(sum + pd.l + pd.r),
            h: max_h.min(max_cross + pd.t + pd.b),
        };
    }
    let mut sum = 0i64;
    let mut max_cross = 0i64;
    for (i, child) in children.iter().enumerate() {
        let measured = measure_node(child, inner_w, inner_h, measure);
        sum += measured.h;
        if i > 0 {
            sum += gap;
        }
        max_cross = max_cross.max(measured.w);
    }
    let w = match resolve_length(style.width, max_w) {
        ResolvedLength::Auto => (max_cross + pd.l + pd.r) as f64,
        ResolvedLength::Cells(v) => v,
    };
    let h = match resolve_length(style.height, max_h) {
        ResolvedLength::Auto => (sum + pd.t + pd.b) as f64,
        ResolvedLength::Cells(v) => v,
    };
    Extent {
        w: floor_nonneg_f64((max_w as f64).min(w)),
        h: floor_nonneg_f64((max_h as f64).min(h)),
    }
}

fn gap_size(explicit: Option<i64>, lines: GridLines) -> i64 {
    explicit
        .unwrap_or(if lines == GridLines::Inner { 1 } else { 0 })
        .max(0)
}

fn vacant_row_floor(pad_y: i64) -> i64 {
    let doubled = pad_y * 2;
    let inner = if doubled == 0 { 1 } else { doubled };
    inner.max(1)
}

fn min_content_width(node: &Node<'_>, measure: Measure<'_>) -> i64 {
    match node {
        Node::Text(text) => longest_token(text.content, measure),
        Node::Box { children, .. } | Node::Flex { children, .. } | Node::Grid { children, .. } => {
            let mut buf = String::new();
            for child in children {
                append_plain(child, &mut buf);
            }
            longest_token(&buf, measure)
        }
    }
}

fn append_plain(node: &Node<'_>, out: &mut String) {
    match node {
        Node::Text(text) => out.push_str(text.content),
        Node::Box { children, .. } | Node::Flex { children, .. } | Node::Grid { children, .. } => {
            for child in children {
                append_plain(child, out);
            }
        }
    }
}

fn longest_token(text: &str, measure: Measure<'_>) -> i64 {
    let mut max_w = 0i64;
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                max_w = max_w.max(measure_cols(measure, &text[s..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        max_w = max_w.max(measure_cols(measure, &text[s..]));
    }
    max_w
}

fn measure_cols(measure: Measure<'_>, text: &str) -> i64 {
    let w = match measure {
        Some(measure) => measure(text),
        None => display_width(text),
    };
    i64::try_from(w).unwrap_or(i64::MAX)
}

fn finite_nonneg(n: f64) -> f64 {
    if n.is_finite() {
        n.max(0.0)
    } else {
        0.0
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

fn f64_floor_i64(n: f64) -> i64 {
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

/// `Math.floor` of a non-finite grow/shrink factor is not a usable weight.
/// `distribute_exact` would drop it; store 0 so the factor stays an integer.
fn floor_factor(n: f64) -> i64 {
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

/// `Math.floor(num / den)` for a positive denominator.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_div_matches_math_floor_for_negative_halves() {
        assert_eq!(floor_div(7, 2), 3);
        assert_eq!(floor_div(-1, 2), -1);
        assert_eq!(floor_div(-2, 2), -1);
    }
}
