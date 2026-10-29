//! Hit testing and selection on top of the committed place walk.
//!
//! It does not re-solve flex, grid, text wrap, or chrome-frame measure.
//! [`layout_hits`] lowers a [`HitNode`] through [`crate::layout_engine::layout`]
//! and joins `Frame::placed` rects with the select / intent / parent fields
//! that walk does not store.
//! Chrome frames call [`crate::layout_chrome::chrome_frame_paint_ops`] for
//! `body_hit`. A sticky-top subtree that shares a cell with a later hit is
//! moved to the end of its viewport before the hit list is reversed, matching
//! `flushStuckLifts` in `layout/engine.ts`.
//!
//! [`element_at`] is topmost-first. [`element_at_path`] is root-first and
//! drops non-admissible ancestors. Soft-wrap caret offsets are Unicode
//! scalars, which match UTF-16 on the BMP fixtures (`visual_draft.ts`).
//!
//! Flex and grid phantoms are not emitted. The committed frame does not store
//! the container rect `pushHit` used for `${key}:flex` / the grid phantom.
//! Paint colors and the cell buffer are not read here.
//!
//! [`Hit::Target`] is what `elementAt` can return: non-`none` intent, or
//! `userSelect` of `text` / `all` / `contain`. `auto` and `none` with intent
//! `none` stay [`Hit::Structural`]. `inert` targets stay in the list and are
//! skipped, same as the admission gate. Overlay backdrops are intent
//! [`Intent::Dismiss`] and select [`UserSelect::Auto`] (not inherited).
//! A chrome-frame body is intent [`Intent::Focus`]; select is `contain`
//! unless the frame is showing a placeholder or `body_user_select` is set.

use std::collections::{HashMap, HashSet};

use unicode_segmentation::UnicodeSegmentation;

use crate::layout_chrome::{
    chrome_frame_paint_ops, is_chrome_frame_showing_placeholder, measure_chrome_frame, ChromeFrame,
    Rect as ChromeRect,
};
use crate::layout_engine::{
    layout, measure_tree, BoxStyle, LayoutOpts, Node, Origin, OverflowAnchor, Sticky, Viewport,
};
use crate::layout_flex::{Length, Padding, Rect};
use crate::layout_text::{wrap_text, MeasuredStamp, WhiteSpace, WrapOpts};
use crate::measure::display_width;
use crate::Style;

/// `Number.MAX_SAFE_INTEGER`. The default row width of `selectionRect`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

const MULTI_CLICK_MS: i64 = 500;
const MOVE_TOLERANCE: i64 = 5;
const UNBOUNDED_H: i64 = 10_000;

/// 0-indexed buffer cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub col: i64,
    pub row: i64,
}

/// CSS `user-select`. `auto` is not selectable on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserSelect {
    Auto,
    None,
    Text,
    All,
    Contain,
}

/// Hit intent. Not a string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    None,
    Activate,
    Dismiss,
    Focus,
}

/// Drag / extend granularity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Granularity {
    Char,
    Word,
    Line,
    Rect,
    Structural,
}

/// Host click carried on a hit. Not a free-form string bag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Click {
    Press,
    ToggleCollapsed { block_id: String },
}

/// `element.kind` plus the viewport scroll stamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElementKind {
    Box,
    BoxChrome,
    Text,
    Raw,
    Viewport { scroll_y: i64, max_scroll: i64 },
    Disclosure,
    OverlayBackdrop,
    ChromeFrame,
    ChromeFrameChrome,
    ChromeFrameProgress,
}

impl ElementKind {
    /// TypeScript `element.kind` string. Viewport scroll is not part of the name.
    pub fn as_str(self) -> &'static str {
        match self {
            ElementKind::Box => "box",
            ElementKind::BoxChrome => "box_chrome",
            ElementKind::Text => "text",
            ElementKind::Raw => "raw",
            ElementKind::Viewport { .. } => "viewport",
            ElementKind::Disclosure => "disclosure",
            ElementKind::OverlayBackdrop => "overlay-backdrop",
            ElementKind::ChromeFrame => "chrome_frame",
            ElementKind::ChromeFrameChrome => "chrome_frame_chrome",
            ElementKind::ChromeFrameProgress => "chrome_frame_progress",
        }
    }
}

/// One hit record. `Target` is on the hit list; `Structural` is `by_key` only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hit {
    Target {
        key: String,
        intent: Intent,
        rect: Rect,
        user_select: UserSelect,
        kind: ElementKind,
        parent: Option<String>,
        click: Option<Click>,
        inert: bool,
    },
    Structural {
        key: String,
        rect: Rect,
        user_select: UserSelect,
        kind: ElementKind,
        parent: Option<String>,
    },
}

impl Hit {
    pub fn key(&self) -> &str {
        match self {
            Hit::Target { key, .. } | Hit::Structural { key, .. } => key,
        }
    }

    pub fn intent(&self) -> Intent {
        match self {
            Hit::Target { intent, .. } => *intent,
            Hit::Structural { .. } => Intent::None,
        }
    }

    pub fn rect(&self) -> Rect {
        match self {
            Hit::Target { rect, .. } | Hit::Structural { rect, .. } => *rect,
        }
    }

    pub fn user_select(&self) -> UserSelect {
        match self {
            Hit::Target { user_select, .. } | Hit::Structural { user_select, .. } => *user_select,
        }
    }

    pub fn kind(&self) -> ElementKind {
        match self {
            Hit::Target { kind, .. } | Hit::Structural { kind, .. } => *kind,
        }
    }

    pub fn parent(&self) -> Option<&str> {
        match self {
            Hit::Target { parent, .. } | Hit::Structural { parent, .. } => parent.as_deref(),
        }
    }

    pub fn click(&self) -> Option<&Click> {
        match self {
            Hit::Target { click, .. } => click.as_ref(),
            Hit::Structural { .. } => None,
        }
    }

    pub fn inert(&self) -> bool {
        match self {
            Hit::Target { inert, .. } => *inert,
            Hit::Structural { .. } => false,
        }
    }

    /// `isAdmissibleHit`: not inert, and either a non-none intent, a selectable
    /// `userSelect`, or a click. Structural rows fail this. Inert targets fail it.
    pub fn is_admissible(&self) -> bool {
        match self {
            Hit::Target {
                inert,
                intent,
                user_select,
                click,
                ..
            } => !inert && (*intent != Intent::None || selectable(*user_select) || click.is_some()),
            Hit::Structural { .. } => false,
        }
    }
}

/// `layout_hits` result. [`HitFrame::hit_list`] is topmost-first.
#[derive(Clone, Debug)]
pub struct HitFrame {
    hits: Vec<Hit>,
    records: Vec<Hit>,
    index: HashMap<String, usize>,
}

impl HitFrame {
    /// Topmost first, the reversed hit list.
    pub fn hit_list(&self) -> &[Hit] {
        &self.hits
    }

    pub fn get(&self, key: &str) -> Option<&Hit> {
        self.index.get(key).map(|&i| &self.records[i])
    }

    pub fn hit_listed(&self, key: &str) -> bool {
        self.hits.iter().any(|hit| hit.key() == key)
    }

    /// Every record, including structural chrome that never entered the hit list.
    pub fn records(&self) -> &[Hit] {
        &self.records
    }
}

/// Optional select / intent / click. `None` means the attribute was omitted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HitExtra {
    pub user_select: Option<UserSelect>,
    pub intent: Option<Intent>,
    pub inert: Option<bool>,
    pub click: Option<Click>,
}

impl HitExtra {
    pub fn select(user_select: UserSelect) -> Self {
        Self {
            user_select: Some(user_select),
            ..Self::default()
        }
    }
}

/// Layout tree the hit walk understands. Geometry comes from [`layout_hits`].
#[derive(Clone, Debug)]
pub enum HitNode {
    Text {
        content: String,
        key: Option<String>,
        white_space: Option<WhiteSpace>,
        ellipsis: Option<bool>,
        line_clamp: Option<i64>,
        measured: Option<MeasuredStamp>,
        extra: HitExtra,
    },
    Box {
        key: Option<String>,
        id: Option<String>,
        style: BoxStyle,
        extra: HitExtra,
        measured: Option<MeasuredStamp>,
        children: Vec<HitNode>,
    },
    Raw {
        key: Option<String>,
        w: i64,
        h: i64,
        extra: HitExtra,
    },
    Overlay {
        key: Option<String>,
        center: bool,
        origin: Option<Origin>,
        backdrop: bool,
        backdrop_style: Option<Style>,
        extra: HitExtra,
        children: Vec<HitNode>,
    },
    Viewport {
        id: String,
        key: Option<String>,
        anchor: OverflowAnchor,
        scroll: i64,
        children: Vec<HitNode>,
    },
    Disclosure {
        key: Option<String>,
        collapsed: bool,
        extra: HitExtra,
        summary: Box<HitNode>,
        children: Vec<HitNode>,
    },
    /// Root chrome is hit-tested from the chrome painter. A nested frame uses
    /// the rect the engine placed and the same three hits.
    Chrome {
        key: String,
        frame: ChromeFrame,
        body_user_select: Option<UserSelect>,
        inert: bool,
    },
}

/// Active selection. `contain` clamps every endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub anchor: Cell,
    pub active: Cell,
    pub granularity: Granularity,
    pub anchor_key: Option<String>,
    pub contain: Option<Rect>,
}

/// Document-order ends of a char / word selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamEnds {
    pub start: Cell,
    pub end: Cell,
}

/// `userSelect: contain` region covering a cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainRegion {
    pub key: String,
    pub rect: Rect,
}

/// Spatial caret inside a soft-wrapped draft.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VisualCaret {
    pub line: usize,
    pub col_in_content: i64,
    pub total_lines: usize,
}

/// One painted draft row. `start` / `end` are scalar offsets into the draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisualDraftLine {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Arrow / home / end motion over visual rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VisualMotion {
    LineUp,
    LineDown,
    LineHome,
    LineEnd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GestureKind {
    Press,
    Release,
    Drag,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeScroll {
    Up,
    Down,
}

/// One mouse event. `t_ms` is the multi-click clock. `key` is optional.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GestureEvent {
    pub kind: GestureKind,
    pub col: i64,
    pub row: i64,
    pub t_ms: i64,
    pub shift: bool,
    pub alt: bool,
    pub key: Option<String>,
}

impl GestureEvent {
    pub fn at(kind: GestureKind, col: i64, row: i64, t_ms: i64) -> Self {
        Self {
            kind,
            col,
            row,
            t_ms,
            shift: false,
            alt: false,
            key: None,
        }
    }
}

/// Gesture result. `copy_ready` is `Some` only on release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GestureOutput {
    pub selection: Option<Selection>,
    pub scroll: Option<EdgeScroll>,
    pub copy_ready: Option<bool>,
}

/// Down, with no extent yet. Line is not a held grain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeldGrain {
    Char,
    Word,
    Rect,
}

/// An extent exists. Char is the tolerance reset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MovedGrain {
    Char,
    Word,
    Line,
    Rect,
}

/// One phase. Held cannot be a line. Moved cannot mean "not moved".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GesturePhase {
    Held(HeldGrain),
    Moved(MovedGrain),
}

fn held_phase(gran: Granularity) -> GesturePhase {
    match gran {
        Granularity::Word => GesturePhase::Held(HeldGrain::Word),
        Granularity::Rect => GesturePhase::Held(HeldGrain::Rect),
        Granularity::Char | Granularity::Line | Granularity::Structural => {
            GesturePhase::Held(HeldGrain::Char)
        }
    }
}

fn moved_phase(gran: Granularity) -> GesturePhase {
    match gran {
        Granularity::Word => GesturePhase::Moved(MovedGrain::Word),
        Granularity::Line => GesturePhase::Moved(MovedGrain::Line),
        Granularity::Rect => GesturePhase::Moved(MovedGrain::Rect),
        Granularity::Char | Granularity::Structural => GesturePhase::Moved(MovedGrain::Char),
    }
}

/// Press / drag / release machine. Closures resolve words and contain rects.
pub struct GestureMachine {
    viewport_h: Option<i64>,
    viewport_w: Option<i64>,
    row_cells: Option<Box<dyn Fn(i64) -> Option<Vec<String>>>>,
    contain_at: Option<Box<dyn Fn(Cell) -> Option<ContainRegion>>>,
    sel: Option<Selection>,
    last_press: Option<Cell>,
    last_key: Option<String>,
    contain: Option<Rect>,
    last_ms: Option<i64>,
    clicks: i64,
    phase: GesturePhase,
}

impl GestureMachine {
    pub fn new() -> Self {
        Self {
            viewport_h: None,
            viewport_w: None,
            row_cells: None,
            contain_at: None,
            sel: None,
            last_press: None,
            last_key: None,
            contain: None,
            last_ms: None,
            clicks: 0,
            phase: GesturePhase::Held(HeldGrain::Char),
        }
    }

    fn phase_moved(&self) -> bool {
        matches!(self.phase, GesturePhase::Moved(_))
    }

    fn phase_grain(&self) -> Granularity {
        match self.phase {
            GesturePhase::Held(HeldGrain::Char) | GesturePhase::Moved(MovedGrain::Char) => {
                Granularity::Char
            }
            GesturePhase::Held(HeldGrain::Word) | GesturePhase::Moved(MovedGrain::Word) => {
                Granularity::Word
            }
            GesturePhase::Moved(MovedGrain::Line) => Granularity::Line,
            GesturePhase::Held(HeldGrain::Rect) | GesturePhase::Moved(MovedGrain::Rect) => {
                Granularity::Rect
            }
        }
    }

    pub fn viewport(mut self, w: Option<i64>, h: Option<i64>) -> Self {
        self.viewport_w = w;
        self.viewport_h = h;
        self
    }

    pub fn row_cells(mut self, rows: impl Fn(i64) -> Option<Vec<String>> + 'static) -> Self {
        self.row_cells = Some(Box::new(rows));
        self
    }

    pub fn contain_at(mut self, contain: impl Fn(Cell) -> Option<ContainRegion> + 'static) -> Self {
        self.contain_at = Some(Box::new(contain));
        self
    }

    pub fn set_viewport(&mut self, w: i64, h: i64) {
        self.viewport_w = Some(w);
        self.viewport_h = Some(h);
    }

    pub fn selection(&self) -> Option<Selection> {
        self.sel.clone().filter(|sel| has_visible(sel))
    }

    pub fn clear(&mut self) -> Option<Selection> {
        self.sel = clear_selection();
        self.clicks = 0;
        self.last_press = None;
        self.last_key = None;
        self.contain = None;
        self.phase = GesturePhase::Held(HeldGrain::Char);
        self.sel.clone()
    }

    pub fn handle(&mut self, ev: GestureEvent) -> GestureOutput {
        let rows = self.row_cells.take();
        let contain = self.contain_at.take();
        let out = self.handle_with(ev, rows.as_deref(), contain.as_deref());
        self.row_cells = rows;
        self.contain_at = contain;
        out
    }

    /// One gesture step. `None` is the missing resolver, not an empty row.
    pub fn handle_with(
        &mut self,
        ev: GestureEvent,
        row_cells: Option<&dyn Fn(i64) -> Option<Vec<String>>>,
        contain_at: Option<&dyn Fn(Cell) -> Option<ContainRegion>>,
    ) -> GestureOutput {
        if ev.kind == GestureKind::Press {
            return self.press(ev, row_cells, contain_at);
        }
        if ev.kind == GestureKind::Drag {
            return self.drag(ev);
        }
        if ev.kind == GestureKind::Release {
            return self.release(ev);
        }
        GestureOutput {
            selection: self.selection(),
            scroll: None,
            copy_ready: None,
        }
    }

    fn press(
        &mut self,
        ev: GestureEvent,
        row_cells: Option<&dyn Fn(i64) -> Option<Vec<String>>>,
        contain_at: Option<&dyn Fn(Cell) -> Option<ContainRegion>>,
    ) -> GestureOutput {
        if ev.shift {
            if let Some(sel) = self.sel.clone() {
                if has_visible(&sel) {
                    self.contain = sel.contain;
                    let cell = clamp_to(
                        Cell {
                            col: ev.col,
                            row: ev.row,
                        },
                        self.contain,
                    );
                    let grain = sel.granularity;
                    self.sel = extend_selection(Some(sel), cell);
                    self.phase = moved_phase(grain);
                    self.last_press = Some(cell);
                    self.last_ms = Some(ev.t_ms);
                    return GestureOutput {
                        selection: self.sel.clone(),
                        scroll: None,
                        copy_ready: None,
                    };
                }
            }
        }
        let raw = Cell {
            col: ev.col,
            row: ev.row,
        };
        let within = self.within(ev.t_ms);
        let same_spot = self
            .last_press
            .is_some_and(|press| same_cell(press, clamp_to(raw, self.contain)));
        let cell = if within && same_spot && self.contain.is_some() {
            clamp_to(raw, self.contain)
        } else {
            self.arm_contain(raw, ev.key.clone(), contain_at)
        };
        self.clicks = if within && same_spot {
            self.clicks + 1
        } else {
            1
        };
        self.last_press = Some(cell);
        self.last_ms = Some(ev.t_ms);
        let gran = if ev.alt {
            Granularity::Rect
        } else {
            clicks_to_gran(self.clicks)
        };
        self.phase = held_phase(gran);
        self.sel = self.materialize(cell, gran, row_cells);
        GestureOutput {
            selection: self.sel.clone().filter(|sel| has_visible(sel)),
            scroll: None,
            copy_ready: None,
        }
    }

    fn drag(&mut self, ev: GestureEvent) -> GestureOutput {
        let raw = Cell {
            col: ev.col,
            row: ev.row,
        };
        let clamped = clamp_to(raw, self.contain);
        let cell = if !in_contain(raw, self.contain)
            && self
                .sel
                .as_ref()
                .is_some_and(|sel| same_cell(clamped, sel.anchor))
        {
            self.sel.as_ref().map(|sel| sel.active).unwrap_or(clamped)
        } else {
            clamped
        };
        if self.clicks > 1 {
            if let Some(press) = self.last_press {
                if manhattan(press, cell) > MOVE_TOLERANCE {
                    self.clicks = 1;
                    self.phase = if same_cell(press, cell) {
                        GesturePhase::Held(HeldGrain::Char)
                    } else {
                        GesturePhase::Moved(MovedGrain::Char)
                    };
                    self.sel = Some(start_selection(
                        press,
                        Granularity::Char,
                        self.last_key.clone(),
                        self.contain,
                    ));
                }
            }
        }
        let gran = if self.phase_grain() == Granularity::Rect {
            Granularity::Rect
        } else {
            self.sel
                .as_ref()
                .map(|sel| sel.granularity)
                .unwrap_or_else(|| self.phase_grain())
        };
        if self.sel.is_none() {
            let origin = self.last_press.unwrap_or(cell);
            self.sel = Some(start_selection(
                origin,
                gran,
                self.last_key.clone(),
                self.contain,
            ));
        }
        if self
            .sel
            .as_ref()
            .is_some_and(|sel| !same_cell(sel.active, cell))
        {
            self.phase = moved_phase(gran);
        }
        if let Some(mut sel) = self.sel.clone() {
            sel.granularity = gran;
            self.sel = extend_selection(Some(sel), cell);
        }
        let scroll = self.edge_scroll(ev.row);
        if self.sel.as_ref().is_some_and(|sel| !has_visible(sel)) {
            return GestureOutput {
                selection: None,
                scroll,
                copy_ready: None,
            };
        }
        GestureOutput {
            selection: self.sel.clone(),
            scroll,
            copy_ready: None,
        }
    }

    fn release(&mut self, ev: GestureEvent) -> GestureOutput {
        let raw = Cell {
            col: ev.col,
            row: ev.row,
        };
        let clamped = clamp_to(raw, self.contain);
        let cell = if !in_contain(raw, self.contain)
            && self
                .sel
                .as_ref()
                .is_some_and(|sel| same_cell(clamped, sel.anchor))
        {
            self.sel.as_ref().map(|sel| sel.active).unwrap_or(clamped)
        } else {
            clamped
        };
        if self.sel.as_ref().is_some_and(|sel| has_visible(sel)) && self.clicks <= 1 {
            if self
                .sel
                .as_ref()
                .is_some_and(|sel| !same_cell(sel.active, cell))
            {
                self.sel = extend_selection(self.sel.clone(), cell);
                self.phase = moved_phase(
                    self.sel
                        .as_ref()
                        .map(|sel| sel.granularity)
                        .unwrap_or(Granularity::Char),
                );
            }
        }
        if self.sel.as_ref().is_none_or(|sel| !has_visible(sel)) {
            self.sel = None;
            self.phase = GesturePhase::Held(HeldGrain::Char);
            self.contain = None;
            return GestureOutput {
                selection: None,
                scroll: None,
                copy_ready: Some(false),
            };
        }
        let copy_ready =
            self.phase_moved() || self.sel.as_ref().is_some_and(|sel| has_visible(sel));
        self.phase = GesturePhase::Held(HeldGrain::Char);
        GestureOutput {
            selection: self.sel.clone(),
            scroll: None,
            copy_ready: Some(copy_ready),
        }
    }

    fn materialize(
        &mut self,
        cell: Cell,
        gran: Granularity,
        row_cells: Option<&dyn Fn(i64) -> Option<Vec<String>>>,
    ) -> Option<Selection> {
        let key = self.last_key.clone();
        let contain = self.contain;
        if gran == Granularity::Word {
            let Some(row_cells) = row_cells else {
                return None;
            };
            self.phase = GesturePhase::Moved(MovedGrain::Word);
            return Some(expand_to_word_at(cell, row_cells, key, contain));
        }
        if gran == Granularity::Line {
            self.phase = GesturePhase::Moved(MovedGrain::Line);
            return Some(expand_to_line_at(
                cell,
                self.viewport_w.unwrap_or(1),
                key,
                contain,
            ));
        }
        None
    }

    fn arm_contain(
        &mut self,
        cell: Cell,
        ev_key: Option<String>,
        contain_at: Option<&dyn Fn(Cell) -> Option<ContainRegion>>,
    ) -> Cell {
        let region = contain_at.and_then(|contain_at| contain_at(cell));
        if let Some(region) = region {
            self.contain = Some(region.rect);
            self.last_key = Some(region.key);
        } else {
            self.contain = None;
            self.last_key = ev_key;
        }
        clamp_to(cell, self.contain)
    }

    fn within(&self, t_ms: i64) -> bool {
        self.last_ms
            .is_some_and(|prev| t_ms.saturating_sub(prev) <= MULTI_CLICK_MS)
    }

    fn edge_scroll(&self, row: i64) -> Option<EdgeScroll> {
        if self.contain.is_some() {
            return None;
        }
        let Some(h) = self.viewport_h else {
            return None;
        };
        if row < 0 {
            return Some(EdgeScroll::Up);
        }
        if row >= h {
            return Some(EdgeScroll::Down);
        }
        None
    }
}

impl Default for GestureMachine {
    fn default() -> Self {
        Self::new()
    }
}

fn selectable(select: UserSelect) -> bool {
    matches!(
        select,
        UserSelect::Text | UserSelect::All | UserSelect::Contain
    )
}

fn clicks_to_gran(count: i64) -> Granularity {
    if count >= 4 {
        return Granularity::Char;
    }
    match count {
        2 => Granularity::Word,
        3 => Granularity::Line,
        _ => Granularity::Char,
    }
}

fn same_cell(a: Cell, b: Cell) -> bool {
    a.col == b.col && a.row == b.row
}

fn manhattan(a: Cell, b: Cell) -> i64 {
    (a.col - b.col).saturating_abs() + (a.row - b.row).saturating_abs()
}

fn has_visible(sel: &Selection) -> bool {
    match sel.granularity {
        Granularity::Line | Granularity::Structural => true,
        Granularity::Char | Granularity::Word | Granularity::Rect => {
            !same_cell(sel.anchor, sel.active)
        }
    }
}

fn clamp_to(cell: Cell, contain: Option<Rect>) -> Cell {
    match contain {
        Some(rect) => clamp_cell(cell, rect),
        None => cell,
    }
}

fn in_contain(cell: Cell, contain: Option<Rect>) -> bool {
    let Some(rect) = contain else {
        return true;
    };
    let max_c = rect.x + rect.w.max(1) - 1;
    let max_r = rect.y + rect.h.max(1) - 1;
    cell.col >= rect.x && cell.col <= max_c && cell.row >= rect.y && cell.row <= max_r
}

/// Clamp a cell into `rect` (inclusive). Width and height below 1 count as 1.
pub fn clamp_cell(cell: Cell, rect: Rect) -> Cell {
    let max_c = rect.x + rect.w.max(1) - 1;
    let max_r = rect.y + rect.h.max(1) - 1;
    Cell {
        col: cell.col.clamp(rect.x, max_c),
        row: cell.row.clamp(rect.y, max_r),
    }
}

/// Anchor and active both start at `cell`. `contain` clamps and sticks.
pub fn start_selection(
    cell: Cell,
    granularity: Granularity,
    anchor_key: Option<String>,
    contain: Option<Rect>,
) -> Selection {
    let cell = clamp_to(cell, contain);
    Selection {
        anchor: cell,
        active: cell,
        granularity,
        anchor_key,
        contain,
    }
}

/// Move the active end. `None` stays `None`.
pub fn extend_selection(sel: Option<Selection>, cell: Cell) -> Option<Selection> {
    let mut sel = sel?;
    sel.active = clamp_to(cell, sel.contain);
    Some(sel)
}

/// No selection.
pub fn clear_selection() -> Option<Selection> {
    None
}

/// `None` is collapsed. Same cell is collapsed.
pub fn is_collapsed(sel: Option<&Selection>) -> bool {
    match sel {
        None => true,
        Some(sel) => same_cell(sel.anchor, sel.active),
    }
}

/// Line and structural always have extent. Char / word / rect need two cells.
pub fn has_copyable_extent(sel: Option<&Selection>) -> bool {
    let Some(sel) = sel else {
        return false;
    };
    match sel.granularity {
        Granularity::Line | Granularity::Structural => true,
        Granularity::Char | Granularity::Word | Granularity::Rect => !is_collapsed(Some(sel)),
    }
}

fn doc_before(a: Cell, b: Cell) -> bool {
    a.row < b.row || (a.row == b.row && a.col < b.col)
}

/// Stream ends in document order.
pub fn stream_endpoints(sel: &Selection) -> StreamEnds {
    if doc_before(sel.active, sel.anchor) {
        StreamEnds {
            start: sel.active,
            end: sel.anchor,
        }
    } else {
        StreamEnds {
            start: sel.anchor,
            end: sel.active,
        }
    }
}

/// Envelope. A `contain` selection's envelope is the contain rect itself.
pub fn selection_rect(sel: &Selection, row_width: i64) -> Rect {
    let w = row_width.max(1);
    if let Some(contain) = sel.contain {
        return contain;
    }
    match sel.granularity {
        Granularity::Rect | Granularity::Structural => {
            let c0 = sel.anchor.col.min(sel.active.col);
            let c1 = sel.anchor.col.max(sel.active.col);
            let r0 = sel.anchor.row.min(sel.active.row);
            let r1 = sel.anchor.row.max(sel.active.row);
            Rect {
                x: c0,
                y: r0,
                w: c1 - c0 + 1,
                h: r1 - r0 + 1,
            }
        }
        Granularity::Line => {
            let r0 = sel.anchor.row.min(sel.active.row);
            let r1 = sel.anchor.row.max(sel.active.row);
            Rect {
                x: 0,
                y: r0,
                w,
                h: r1 - r0 + 1,
            }
        }
        Granularity::Char | Granularity::Word => {
            let ends = stream_endpoints(sel);
            if ends.start.row == ends.end.row {
                let c0 = ends.start.col.min(ends.end.col);
                let c1 = ends.start.col.max(ends.end.col);
                Rect {
                    x: c0,
                    y: ends.start.row,
                    w: c1 - c0 + 1,
                    h: 1,
                }
            } else {
                Rect {
                    x: 0,
                    y: ends.start.row,
                    w,
                    h: ends.end.row - ends.start.row + 1,
                }
            }
        }
    }
}

/// Inclusive column range on `row`, or `None` when the row is outside.
pub fn row_range(sel: &Selection, row: i64, row_width: i64) -> Option<(i64, i64)> {
    if row_width <= 0 {
        return None;
    }
    let last_col = row_width - 1;
    let range = match sel.granularity {
        Granularity::Line => {
            let r0 = sel.anchor.row.min(sel.active.row);
            let r1 = sel.anchor.row.max(sel.active.row);
            if row < r0 || row > r1 {
                return None;
            }
            (0, last_col)
        }
        Granularity::Rect | Granularity::Structural => {
            let c0 = sel.anchor.col.min(sel.active.col);
            let c1 = sel.anchor.col.max(sel.active.col);
            let r0 = sel.anchor.row.min(sel.active.row);
            let r1 = sel.anchor.row.max(sel.active.row);
            if row < r0 || row > r1 {
                return None;
            }
            (c0, c1)
        }
        Granularity::Char | Granularity::Word => {
            let ends = stream_endpoints(sel);
            if row < ends.start.row || row > ends.end.row {
                return None;
            }
            if ends.start.row == ends.end.row {
                (
                    ends.start.col.min(ends.end.col),
                    ends.start.col.max(ends.end.col),
                )
            } else if row == ends.start.row {
                (ends.start.col, last_col)
            } else if row == ends.end.row {
                (0, ends.end.col)
            } else {
                (0, last_col)
            }
        }
    };
    clip_range(range, row, sel.contain)
}

/// Clipboard text for `sel`. Placeholder cells are skipped. Each row is
/// right-trimmed. The result is the lines plus one trailing newline.
/// `is_chrome` drops a cell the way a chrome mask does.
pub fn serialize_selection(
    buf: &crate::buffer::Buffer,
    sel: &Selection,
    is_chrome: impl Fn(i64, i64) -> bool,
) -> String {
    if !has_copyable_extent(Some(sel)) {
        return String::new();
    }
    let width = i64::try_from(buf.width()).unwrap_or(0);
    let height = i64::try_from(buf.height()).unwrap_or(0);
    if width <= 0 || height <= 0 {
        return String::new();
    }
    let envelope = selection_rect(sel, width);
    let last_row = (envelope.y + envelope.h - 1).min(height - 1);
    if last_row < envelope.y || envelope.y > height - 1 {
        return String::new();
    }
    let mut lines = Vec::new();
    let mut row = envelope.y;
    while row <= last_row {
        if let Some(line) = serialize_free_row(buf, sel, &is_chrome, row, width) {
            lines.push(line);
        }
        row += 1;
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn serialize_free_row(
    buf: &crate::buffer::Buffer,
    sel: &Selection,
    is_chrome: &impl Fn(i64, i64) -> bool,
    row: i64,
    width: i64,
) -> Option<String> {
    let (start_col, end_col) = row_range(sel, row, width)?;
    let col_start = start_col.max(0);
    let col_end = end_col.min(width - 1);
    if col_end < col_start {
        return Some(String::new());
    }
    let mut line = String::new();
    let mut col = col_start;
    while col <= col_end {
        if !is_chrome(col, row) {
            if let Some(cell) = cell_at(buf, col, row) {
                if !cell.placeholder {
                    if cell.ch.is_empty() {
                        line.push(' ');
                    } else {
                        line.push_str(&cell.ch);
                    }
                }
            }
        }
        col += 1;
    }
    while line
        .chars()
        .next_back()
        .is_some_and(|ch| ch.is_whitespace())
    {
        line.pop();
    }
    Some(line)
}

fn cell_at(buf: &crate::buffer::Buffer, col: i64, row: i64) -> Option<&crate::buffer::Cell> {
    let x = usize::try_from(col).ok()?;
    let y = usize::try_from(row).ok()?;
    if x >= buf.width() || y >= buf.height() {
        return None;
    }
    buf.cells().get(y * buf.width() + x)
}

fn clip_range(range: (i64, i64), row: i64, contain: Option<Rect>) -> Option<(i64, i64)> {
    let Some(contain) = contain else {
        return Some(range);
    };
    if row < contain.y || row >= contain.y.saturating_add(contain.h) {
        return None;
    }
    let start = range.0.max(contain.x);
    let end = range.1.min(contain.x + contain.w - 1);
    if end < start {
        None
    } else {
        Some((start, end))
    }
}

fn is_word_char(ch: char) -> bool {
    if ch.is_ascii_alphanumeric() || ch == '_' {
        return true;
    }
    ch.is_alphanumeric()
}

fn is_word_cell(cell: &str) -> bool {
    cell.chars().next().is_some_and(is_word_char)
}

/// Inclusive word span on one row of cell strings. A separator is one cell.
pub fn word_bounds_on_row(cells: &[String], col: i64) -> (i64, i64) {
    if col < 0 || col as usize >= cells.len() {
        let col = col.max(0);
        return (col, col);
    }
    let col_us = col as usize;
    if !is_word_cell(&cells[col_us]) {
        return (col, col);
    }
    let mut start = col_us;
    while start > 0 && is_word_cell(&cells[start - 1]) {
        start -= 1;
    }
    let mut end = col_us;
    while end + 1 < cells.len() && is_word_cell(&cells[end + 1]) {
        end += 1;
    }
    (start as i64, end as i64)
}

/// Snap anchor/active to the word under `cell`. Empty rows stay collapsed.
pub fn expand_to_word_at(
    cell: Cell,
    row_cells: impl Fn(i64) -> Option<Vec<String>>,
    anchor_key: Option<String>,
    contain: Option<Rect>,
) -> Selection {
    let cell = clamp_to(cell, contain);
    let Some(cells) = row_cells(cell.row).filter(|cells| !cells.is_empty()) else {
        return start_selection(cell, Granularity::Word, anchor_key, contain);
    };
    let (mut a, mut b) = word_bounds_on_row(&cells, cell.col);
    if let Some(rect) = contain {
        a = a.max(rect.x);
        b = b.min(rect.x + rect.w - 1);
    }
    Selection {
        anchor: Cell {
            col: a,
            row: cell.row,
        },
        active: Cell {
            col: b,
            row: cell.row,
        },
        granularity: Granularity::Word,
        anchor_key,
        contain,
    }
}

/// Triple-click line. `contain` limits the line to that box, not the terminal.
pub fn expand_to_line_at(
    cell: Cell,
    row_width: i64,
    anchor_key: Option<String>,
    contain: Option<Rect>,
) -> Selection {
    if let Some(rect) = contain {
        let row = clamp_cell(cell, rect).row;
        return Selection {
            anchor: Cell { col: rect.x, row },
            active: Cell {
                col: rect.x + rect.w - 1,
                row,
            },
            granularity: Granularity::Line,
            anchor_key,
            contain: Some(rect),
        };
    }
    let last = (row_width - 1).max(0);
    Selection {
        anchor: Cell {
            col: 0,
            row: cell.row,
        },
        active: Cell {
            col: last,
            row: cell.row,
        },
        granularity: Granularity::Line,
        anchor_key,
        contain: None,
    }
}

fn char_count(text: &str) -> usize {
    text.chars().count()
}

fn nth_char_byte(text: &str, n: usize) -> usize {
    text.char_indices()
        .nth(n)
        .map(|(i, _)| i)
        .unwrap_or(text.len())
}

fn slice_chars(text: &str, start: usize, end: usize) -> &str {
    let from = nth_char_byte(text, start);
    let to = nth_char_byte(text, end.max(start));
    &text[from..to]
}

/// Painted rows at `text_w` columns, `pre-wrap`. Empty draft is one empty row.
pub fn visual_draft_lines(draft: &str, text_w: i64) -> Vec<VisualDraftLine> {
    let w = text_w.max(1);
    if draft.is_empty() {
        return vec![VisualDraftLine {
            start: 0,
            end: 0,
            text: String::new(),
        }];
    }
    let opts = WrapOpts {
        width: w,
        white_space: WhiteSpace::PreWrap,
        ellipsis: None,
        line_clamp: None,
        measure: None,
    };
    let hard_lines: Vec<&str> = draft.split('\n').collect();
    let mut out = Vec::new();
    let mut pos = 0usize;
    for (hi, hard) in hard_lines.iter().enumerate() {
        let soft = wrap_text(hard, &opts);
        if soft.is_empty() {
            out.push(VisualDraftLine {
                start: pos,
                end: pos,
                text: String::new(),
            });
        }
        let mut hard_pos = 0usize;
        for line in &soft {
            let len = line.chars().count();
            let start = pos + hard_pos;
            out.push(VisualDraftLine {
                start,
                end: start + len,
                text: line.clone(),
            });
            hard_pos += len;
        }
        pos += hard.chars().count();
        if hi + 1 < hard_lines.len() {
            pos += 1;
        }
    }
    if out.is_empty() {
        vec![VisualDraftLine {
            start: 0,
            end: 0,
            text: String::new(),
        }]
    } else {
        out
    }
}

/// Visual row of `cursor`. `lines.len()` is the virtual row after a full last line.
pub fn visual_line_index(lines: &[VisualDraftLine], cursor: usize, text_w: Option<i64>) -> usize {
    if lines.is_empty() {
        return 0;
    }
    let w = text_w.map(|w| w.max(1));
    for (i, line) in lines.iter().enumerate() {
        if cursor < line.start || cursor > line.end {
            continue;
        }
        if cursor == line.end {
            if lines.get(i + 1).is_some_and(|next| next.start == cursor) {
                continue;
            }
            if let Some(w) = w {
                if i + 1 == lines.len() && display_width(&line.text) as i64 >= w {
                    return lines.len();
                }
            }
        }
        return i;
    }
    lines.len() - 1
}

fn visual_col_in_line(draft: &str, line: &VisualDraftLine, cursor: usize) -> i64 {
    let c = cursor.max(line.start).min(line.end);
    display_width(slice_chars(draft, line.start, c)) as i64
}

fn offset_at_visual_col(draft: &str, line: &VisualDraftLine, target_col: i64) -> usize {
    if target_col <= 0 {
        return line.start;
    }
    let segment = slice_chars(draft, line.start, line.end);
    let mut col = 0i64;
    let mut offset = line.start;
    for grapheme in segment.graphemes(true) {
        let w = display_width(grapheme) as i64;
        if col + w > target_col {
            return offset;
        }
        col += w;
        offset += grapheme.chars().count();
        if col >= target_col {
            return offset;
        }
    }
    line.end
}

/// Byte offset of a click in the composer body.
///
/// `col0` / `row0` are terminal cells. `origin_*` is the body-hit origin.
/// A click on either half of a wide grapheme lands before it. A cell past
/// the line clamps to that line's end. The result is a char boundary, the
/// same index [`crate::draft::DraftState`] stores.
pub fn composer_offset_at_cell(
    draft: &str,
    col0: i64,
    row0: i64,
    origin_x: i64,
    origin_y: i64,
    text_w: i64,
) -> usize {
    let lines = visual_draft_lines(draft, text_w.max(1));
    if lines.is_empty() {
        return 0;
    }
    let local_col = (col0 - origin_x).max(0);
    let local_row = (row0 - origin_y).max(0);
    let scalar = match usize::try_from(local_row) {
        Ok(idx) if idx < lines.len() => offset_at_visual_col(draft, &lines[idx], local_col),
        _ => lines.last().map(|line| line.end).unwrap_or(0),
    };
    nth_char_byte(draft, scalar)
}

/// Exclusive end of the grapheme at this body cell. Padding stays at the click offset.
pub fn composer_offset_after_cell(
    draft: &str,
    col0: i64,
    row0: i64,
    origin_x: i64,
    origin_y: i64,
    text_w: i64,
) -> usize {
    let start = composer_offset_at_cell(draft, col0, row0, origin_x, origin_y, text_w);
    let next = composer_offset_at_cell(draft, col0 + 1, row0, origin_x, origin_y, text_w);
    if next > start {
        return next;
    }
    let lines = visual_draft_lines(draft, text_w.max(1));
    if lines.is_empty() {
        return start;
    }
    let local_row = (row0 - origin_y).max(0);
    let idx = usize::try_from(local_row)
        .unwrap_or(usize::MAX)
        .min(lines.len() - 1);
    let line = &lines[idx];
    let line_end = nth_char_byte(draft, line.end);
    if start >= line_end {
        return start;
    }
    let local_col = (col0 - origin_x).max(0);
    if local_col >= i64::try_from(display_width(&line.text)).unwrap_or(0) {
        return start;
    }
    let Some(grapheme) = draft[start..line_end].graphemes(true).next() else {
        return start;
    };
    start + grapheme.len()
}

/// Caret park. A soft-wrap boundary sits on the next row at column 0.
pub fn visual_caret_geometry(draft: &str, cursor: usize, text_w: i64) -> VisualCaret {
    let w = text_w.max(1);
    let lines = visual_draft_lines(draft, w);
    let c = cursor.min(char_count(draft));
    let idx = visual_line_index(&lines, c, Some(w));
    if idx >= lines.len() {
        return VisualCaret {
            line: lines.len(),
            col_in_content: 0,
            total_lines: lines.len() + 1,
        };
    }
    let col = visual_col_in_line(draft, &lines[idx], c);
    if col >= w {
        return VisualCaret {
            line: idx,
            col_in_content: (w - 1).max(0),
            total_lines: lines.len().max(1),
        };
    }
    VisualCaret {
        line: idx,
        col_in_content: col,
        total_lines: lines.len().max(1),
    }
}

/// Move `cursor` by one visual row, or to the row's home / end.
pub fn move_visual_draft(draft: &str, cursor: usize, text_w: i64, motion: VisualMotion) -> usize {
    let w = text_w.max(1);
    let lines = visual_draft_lines(draft, w);
    let c = cursor.min(char_count(draft));
    let idx = visual_line_index(&lines, c, Some(w));
    if idx >= lines.len() {
        return match motion {
            VisualMotion::LineHome | VisualMotion::LineEnd | VisualMotion::LineDown => c,
            VisualMotion::LineUp => {
                let Some(prev) = lines.last() else {
                    return c;
                };
                offset_at_visual_col(draft, prev, 0)
            }
        };
    }
    let line = &lines[idx];
    match motion {
        VisualMotion::LineHome => line.start,
        VisualMotion::LineEnd => line.end,
        VisualMotion::LineUp => {
            if idx == 0 {
                return c;
            }
            let col = visual_col_in_line(draft, line, c);
            offset_at_visual_col(draft, &lines[idx - 1], col)
        }
        VisualMotion::LineDown => {
            if idx + 1 >= lines.len() {
                return c;
            }
            let col = visual_col_in_line(draft, line, c);
            offset_at_visual_col(draft, &lines[idx + 1], col)
        }
    }
}

/// Place `root` and build the hit list. Viewport `w` / `h` below 1 become 1.
pub fn layout_hits(root: &HitNode, viewport: Viewport) -> HitFrame {
    let w = viewport.w.max(1);
    let h = viewport.h.max(1);
    let viewport = Viewport { w, h };
    if let HitNode::Chrome {
        key,
        frame,
        body_user_select,
        inert,
    } = root
    {
        return chrome_hits(key, frame, *body_user_select, *inert, viewport);
    }
    let engine = lower(root);
    let frame = layout(&engine, viewport, LayoutOpts::default());
    hits_from_placed(
        root,
        frame.placed.into_iter().map(|hit| (hit.key, hit.rect)),
        Rect { x: 0, y: 0, w, h },
    )
}

/// Hit list for a tree already placed. `placed` is the paint frame's rects,
/// so a click uses the cells on screen rather than a second layout.
pub fn hits_from_placed(
    root: &HitNode,
    placed: impl IntoIterator<Item = (String, Rect)>,
    clip: Rect,
) -> HitFrame {
    let mut map = HashMap::new();
    for (key, rect) in placed {
        map.insert(key, rect);
    }
    let mut builder = Builder::new(map, clip);
    let inherit = Inherit {
        user_select: UserSelect::Auto,
        inert: false,
    };
    builder.walk(root, None, inherit, &[], clip);
    builder.finish()
}

/// Topmost admissible hit whose rect contains `(x, y)`.
pub fn element_at(frame: &HitFrame, x: i64, y: i64) -> Option<&Hit> {
    for hit in &frame.hits {
        let Hit::Target { rect, inert, .. } = hit else {
            continue;
        };
        if *inert || !contains(*rect, x, y) {
            continue;
        }
        return Some(hit);
    }
    for hit in &frame.records {
        if hit.is_admissible() && contains(hit.rect(), x, y) {
            return Some(hit);
        }
    }
    None
}

/// Root-first admissible chain. The leaf is always kept.
pub fn element_at_path(frame: &HitFrame, x: i64, y: i64) -> Option<Vec<Hit>> {
    let leaf = element_at(frame, x, y)?.clone();
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let cap = frame.records.len() + 1;
    let mut steps = 0usize;
    let mut current = Some(leaf);
    while let Some(hit) = current {
        if steps >= cap || !seen.insert(hit.key().to_string()) {
            break;
        }
        let parent = hit.parent().map(str::to_string);
        chain.push(hit);
        steps += 1;
        current = parent.and_then(|key| frame.get(&key).cloned());
    }
    chain.reverse();
    let last = chain.len().saturating_sub(1);
    Some(
        chain
            .into_iter()
            .enumerate()
            .filter(|(i, hit)| *i == last || hit.is_admissible())
            .map(|(_, hit)| hit)
            .collect(),
    )
}

/// Innermost contain region on the hit path, leaf first.
pub fn contain_region_at(frame: &HitFrame, x: i64, y: i64) -> Option<ContainRegion> {
    let path = element_at_path(frame, x, y)?;
    for hit in path.iter().rev() {
        if hit.user_select() == UserSelect::Contain {
            return Some(ContainRegion {
                key: hit.key().to_string(),
                rect: hit.rect(),
            });
        }
    }
    None
}

#[derive(Clone, Copy)]
struct Inherit {
    user_select: UserSelect,
    inert: bool,
}

struct Lift {
    start: usize,
    end: usize,
}

struct Builder {
    placed: HashMap<String, Rect>,
    list: Vec<Hit>,
    records: Vec<Hit>,
    index: HashMap<String, usize>,
    scopes: Vec<Vec<Lift>>,
    path: Vec<&'static str>,
    clip: Rect,
}

impl Builder {
    fn new(placed: HashMap<String, Rect>, clip: Rect) -> Self {
        Self {
            placed,
            list: Vec::new(),
            records: Vec::new(),
            index: HashMap::new(),
            scopes: vec![Vec::new()],
            path: Vec::new(),
            clip,
        }
    }

    fn finish(mut self) -> HitFrame {
        while !self.scopes.is_empty() {
            self.flush_top();
        }
        self.list.reverse();
        HitFrame {
            hits: self.list,
            records: self.records,
            index: self.index,
        }
    }

    fn note_lift(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        if let Some(scope) = self.scopes.last_mut() {
            scope.push(Lift { start, end });
        }
    }

    fn flush_top(&mut self) {
        let Some(lifts) = self.scopes.pop() else {
            return;
        };
        let len = self.list.len();
        let mut keep = Vec::new();
        for lift in lifts {
            if lift.start >= lift.end || lift.end > len {
                continue;
            }
            let overlap = self.list[lift.end..len].iter().any(|later| {
                self.list[lift.start..lift.end]
                    .iter()
                    .any(|hit| rects_overlap(hit.rect(), later.rect()))
            });
            if overlap {
                keep.push((lift.start, lift.end));
            }
        }
        apply_lifts(&mut self.list, &keep);
    }

    fn store(&mut self, hit: Hit, listed: bool) {
        let key = hit.key().to_string();
        if let Some(&i) = self.index.get(&key) {
            self.records[i] = hit.clone();
        } else {
            self.index.insert(key, self.records.len());
            self.records.push(hit.clone());
        }
        if listed {
            self.list.push(hit);
        }
    }

    fn push(
        &mut self,
        key: String,
        intent: Intent,
        user_select: UserSelect,
        inert: bool,
        kind: ElementKind,
        parent: Option<String>,
        click: Option<Click>,
        rect: Rect,
    ) {
        let listed = intent != Intent::None || selectable(user_select) || click.is_some();
        if listed {
            self.store(
                Hit::Target {
                    key,
                    intent,
                    rect,
                    user_select,
                    kind,
                    parent,
                    click,
                    inert,
                },
                true,
            );
        } else {
            self.store(
                Hit::Structural {
                    key,
                    rect,
                    user_select,
                    kind,
                    parent,
                },
                false,
            );
        }
    }

    fn walk(
        &mut self,
        node: &HitNode,
        parent: Option<&str>,
        inherit: Inherit,
        _unused_path: &[String],
        slot: Rect,
    ) {
        self.path.push(type_name(node));
        match node {
            HitNode::Text {
                content: _,
                key,
                extra,
                ..
            } => {
                let resolved = key_of(key, None, &self.path);
                let Some(rect) = self.placed.get(&resolved).copied() else {
                    self.path.pop();
                    return;
                };
                // Unkeyed text is paint-only. A path key is not in `placed`.
                if key.as_ref().is_none_or(|k| k.is_empty()) {
                    self.path.pop();
                    return;
                }
                let select = extra.user_select.unwrap_or(inherit.user_select);
                let inert = extra.inert.unwrap_or(inherit.inert);
                self.push(
                    resolved,
                    Intent::None,
                    select,
                    inert,
                    ElementKind::Text,
                    parent.map(str::to_string),
                    None,
                    rect,
                );
            }
            HitNode::Box {
                key,
                id,
                style,
                extra,
                children,
                ..
            } => {
                let resolved = key_of(key, id.as_deref(), &self.path);
                let select = extra.user_select.unwrap_or(inherit.user_select);
                let inert = extra.inert.unwrap_or(inherit.inert);
                let intent = if inert {
                    Intent::None
                } else {
                    match extra.intent {
                        Some(intent) => intent,
                        None if extra.click.is_some() => Intent::Activate,
                        None => Intent::None,
                    }
                };
                let next = Inherit {
                    user_select: select,
                    inert,
                };
                let placed_rect = self.placed.get(&resolved).copied();
                let start = self.list.len();
                if let Some(rect) = placed_rect {
                    if style.border {
                        self.push(
                            format!("{resolved}:chrome"),
                            Intent::None,
                            UserSelect::None,
                            inert,
                            ElementKind::BoxChrome,
                            parent.map(str::to_string),
                            None,
                            rect,
                        );
                    }
                    self.push(
                        resolved.clone(),
                        intent,
                        select,
                        inert,
                        ElementKind::Box,
                        parent.map(str::to_string),
                        extra.click.clone(),
                        rect,
                    );
                }
                let content = placed_rect
                    .map(|rect| content_box(style, rect))
                    .unwrap_or(slot);
                for child in children {
                    self.walk(child, Some(&resolved), next, &[], content);
                }
                if style.sticky == Some(Sticky::Top) && placed_rect.is_some() {
                    self.note_lift(start, self.list.len());
                }
            }
            HitNode::Raw { key, extra, .. } => {
                let resolved = key_of(key, None, &self.path);
                let Some(rect) = self.placed.get(&resolved).copied() else {
                    self.path.pop();
                    return;
                };
                let select = extra.user_select.unwrap_or(inherit.user_select);
                let inert = extra.inert.unwrap_or(inherit.inert);
                let intent = if inert {
                    Intent::None
                } else {
                    extra.intent.unwrap_or(Intent::None)
                };
                self.push(
                    resolved,
                    intent,
                    select,
                    inert,
                    ElementKind::Raw,
                    parent.map(str::to_string),
                    extra.click.clone(),
                    rect,
                );
            }
            HitNode::Overlay {
                key,
                backdrop,
                extra,
                children,
                ..
            } => {
                let resolved = key_of(key, None, &self.path);
                let select = extra.user_select.unwrap_or(inherit.user_select);
                let inert = extra.inert.unwrap_or(inherit.inert);
                let next = Inherit {
                    user_select: select,
                    inert,
                };
                if *backdrop {
                    if let Some(rect) = intersection(slot, self.clip) {
                        self.push(
                            format!("{resolved}:backdrop"),
                            extra.intent.unwrap_or(Intent::Dismiss),
                            UserSelect::Auto,
                            inert,
                            ElementKind::OverlayBackdrop,
                            parent.map(str::to_string),
                            extra.click.clone(),
                            rect,
                        );
                    }
                }
                for child in children {
                    self.walk(child, Some(&resolved), next, &[], slot);
                }
            }
            HitNode::Viewport {
                id,
                key,
                anchor,
                scroll,
                children,
            } => {
                let resolved = key_of(key, Some(id), &self.path);
                let select = inherit.user_select;
                let inert = inherit.inert;
                let next = inherit;
                if let Some(rect) = self.placed.get(&resolved).copied() {
                    let (scroll_y, max_scroll) =
                        viewport_scroll(children, rect.w, rect.h, *anchor, *scroll);
                    self.push(
                        resolved.clone(),
                        Intent::None,
                        select,
                        inert,
                        ElementKind::Viewport {
                            scroll_y,
                            max_scroll,
                        },
                        parent.map(str::to_string),
                        None,
                        rect,
                    );
                }
                let child_slot = self.placed.get(&resolved).copied().unwrap_or(slot);
                self.scopes.push(Vec::new());
                for child in children {
                    self.walk(child, Some(&resolved), next, &[], child_slot);
                }
                self.flush_top();
            }
            HitNode::Disclosure {
                key,
                extra,
                summary,
                children,
                ..
            } => {
                let resolved = key_of(key, None, &self.path);
                let select = extra.user_select.unwrap_or(inherit.user_select);
                let inert = extra.inert.unwrap_or(inherit.inert);
                let intent = if inert {
                    Intent::None
                } else {
                    extra.intent.unwrap_or(Intent::None)
                };
                let next = Inherit {
                    user_select: select,
                    inert,
                };
                if let Some(rect) = self.placed.get(&resolved).copied() {
                    self.push(
                        resolved.clone(),
                        intent,
                        select,
                        inert,
                        ElementKind::Disclosure,
                        parent.map(str::to_string),
                        extra.click.clone(),
                        rect,
                    );
                }
                self.walk(summary, Some(&resolved), next, &[], slot);
                for child in children {
                    self.walk(child, Some(&resolved), next, &[], slot);
                }
            }
            HitNode::Chrome {
                key,
                frame,
                body_user_select,
                inert,
            } => {
                if key.is_empty() {
                    self.path.pop();
                    return;
                }
                let Some(rect) = self.placed.get(key).copied() else {
                    self.path.pop();
                    return;
                };
                push_chrome_hits(
                    self,
                    key,
                    frame,
                    *body_user_select,
                    *inert,
                    ChromeRect::new(rect.x, rect.y, rect.w, rect.h),
                    self.clip,
                    parent.map(str::to_string),
                );
            }
        }
        self.path.pop();
    }
}

fn push_chrome_hits(
    builder: &mut Builder,
    key: &str,
    frame: &ChromeFrame,
    body_user_select: Option<UserSelect>,
    inert: bool,
    place: ChromeRect,
    clip: Rect,
    parent: Option<String>,
) {
    if key.is_empty() {
        return;
    }
    let paint = chrome_frame_paint_ops(frame, place);
    let showing = is_chrome_frame_showing_placeholder(frame);
    let select = body_user_select.unwrap_or(if showing {
        UserSelect::None
    } else {
        UserSelect::Contain
    });
    let intent = if inert { Intent::None } else { Intent::Focus };
    if let Some(rect) = intersection(to_flex(place), clip) {
        builder.push(
            format!("{key}:chrome"),
            Intent::None,
            UserSelect::None,
            inert,
            ElementKind::ChromeFrameChrome,
            parent.clone(),
            None,
            rect,
        );
    }
    if let Some(rect) = intersection(to_flex(paint.body_hit), clip) {
        builder.push(
            key.to_string(),
            intent,
            select,
            inert,
            ElementKind::ChromeFrame,
            parent.clone(),
            None,
            rect,
        );
    }
    if let Some(rect) = intersection(to_flex(paint.progress_hit), clip) {
        if rect.w > 0 && rect.h > 0 {
            builder.push(
                format!("{key}:progress"),
                Intent::None,
                UserSelect::None,
                inert,
                ElementKind::ChromeFrameProgress,
                parent,
                None,
                rect,
            );
        }
    }
}

fn chrome_hits(
    key: &str,
    frame: &ChromeFrame,
    body_user_select: Option<UserSelect>,
    inert: bool,
    viewport: Viewport,
) -> HitFrame {
    let mut builder = Builder::new(
        HashMap::new(),
        Rect {
            x: 0,
            y: 0,
            w: viewport.w,
            h: viewport.h,
        },
    );
    if key.is_empty() {
        return builder.finish();
    }
    let geom = measure_chrome_frame(frame, viewport.w, viewport.h);
    let place = ChromeRect::new(
        0,
        0,
        viewport.w.min(geom.outer_w),
        viewport.h.min(geom.total_h).max(1),
    );
    let clip = Rect {
        x: 0,
        y: 0,
        w: viewport.w,
        h: viewport.h,
    };
    push_chrome_hits(
        &mut builder,
        key,
        frame,
        body_user_select,
        inert,
        place,
        clip,
        None,
    );
    builder.finish()
}

fn type_name(node: &HitNode) -> &'static str {
    match node {
        HitNode::Text { .. } => "text",
        HitNode::Box { .. } | HitNode::Raw { .. } => "box",
        HitNode::Overlay { .. } => "overlay",
        HitNode::Viewport { .. } => "viewport",
        HitNode::Disclosure { .. } => "disclosure",
        HitNode::Chrome { .. } => "chrome_frame",
    }
}

fn key_of(key: &Option<String>, id: Option<&str>, path: &[&str]) -> String {
    if let Some(key) = key.as_ref().filter(|key| !key.is_empty()) {
        return key.clone();
    }
    if let Some(id) = id.filter(|id| !id.is_empty()) {
        return id.to_string();
    }
    path.join("/")
}

fn lower(node: &HitNode) -> Node {
    match node {
        HitNode::Text {
            content,
            key,
            white_space,
            ellipsis,
            line_clamp,
            measured,
            ..
        } => Node::Text {
            content: content.clone(),
            white_space: *white_space,
            ellipsis: *ellipsis,
            line_clamp: *line_clamp,
            measured: *measured,
            style: Style::default(),
            key: key.clone(),
            live: None,
            region_prominence: None,
        },
        HitNode::Box {
            key,
            id,
            style,
            children,
            measured,
            ..
        } => Node::Box {
            style: style.clone(),
            children: children.iter().map(lower).collect(),
            key: key.clone(),
            id: id.clone(),
            measured: *measured,
            region_prominence: None,
        },
        HitNode::Raw { key, w, h, .. } => Node::Box {
            style: BoxStyle {
                width: Some(Length::Cells(*w)),
                height: Some(Length::Cells(*h)),
                ..BoxStyle::default()
            },
            children: Vec::new(),
            key: key.clone(),
            id: None,
            measured: None,
            region_prominence: None,
        },
        HitNode::Overlay {
            key,
            center,
            origin,
            backdrop,
            backdrop_style,
            children,
            ..
        } => Node::Overlay {
            center: *center,
            origin: *origin,
            backdrop: *backdrop,
            backdrop_style: backdrop_style.clone(),
            children: children.iter().map(lower).collect(),
            key: key.clone(),
            measured: None,
            region_prominence: None,
        },
        HitNode::Viewport {
            id,
            key,
            anchor,
            scroll,
            children,
        } => Node::Viewport {
            id: id.clone(),
            key: key.clone(),
            children: children.iter().map(lower).collect(),
            anchor: *anchor,
            scroll: *scroll,
            width: None,
            height: None,
            measured: None,
            region_prominence: None,
        },
        HitNode::Disclosure {
            key,
            collapsed,
            summary,
            children,
            ..
        } => Node::Disclosure {
            collapsed: *collapsed,
            summary: Box::new(lower(summary)),
            children: children.iter().map(lower).collect(),
            key: key.clone(),
            measured: None,
            region_prominence: None,
        },
        HitNode::Chrome { key, frame, .. } => Node::Chrome {
            key: if key.is_empty() {
                None
            } else {
                Some(key.clone())
            },
            frame: frame.clone(),
        },
    }
}

fn viewport_scroll(
    children: &[HitNode],
    w: i64,
    h: i64,
    anchor: OverflowAnchor,
    scroll: i64,
) -> (i64, i64) {
    let mut total: i128 = 0;
    for child in children {
        let ch = match child {
            HitNode::Box {
                measured: Some(stamp),
                ..
            }
            | HitNode::Text {
                measured: Some(stamp),
                ..
            } if stamp.at_w == w => stamp.h.max(0).min(UNBOUNDED_H),
            _ => {
                let node = lower(child);
                measure_tree(&node, w, UNBOUNDED_H, None).h
            }
        };
        total += i128::from(ch);
    }
    let total = if total > i128::from(i64::MAX) {
        i64::MAX
    } else {
        total as i64
    };
    let max_scroll = total.saturating_sub(h).max(0);
    let scroll_y = match anchor {
        OverflowAnchor::Auto => max_scroll,
        OverflowAnchor::None => scroll.clamp(0, max_scroll),
    };
    (scroll_y, max_scroll)
}

fn pad_edges(padding: Option<Padding>) -> (i64, i64, i64, i64) {
    match padding {
        None => (0, 0, 0, 0),
        Some(Padding::Uniform(n)) => {
            let n = n.max(0);
            (n, n, n, n)
        }
        Some(Padding::Edges { t, r, b, l }) => (
            t.unwrap_or(0).max(0),
            r.unwrap_or(0).max(0),
            b.unwrap_or(0).max(0),
            l.unwrap_or(0).max(0),
        ),
    }
}

fn content_box(style: &BoxStyle, rect: Rect) -> Rect {
    let (t, r, b, l) = pad_edges(style.padding);
    let border = if style.border { 1 } else { 0 };
    Rect {
        x: rect.x.saturating_add(l).saturating_add(border),
        y: rect.y.saturating_add(t).saturating_add(border),
        w: rect
            .w
            .saturating_sub(l)
            .saturating_sub(r)
            .saturating_sub(border.saturating_mul(2))
            .max(0),
        h: rect
            .h
            .saturating_sub(t)
            .saturating_sub(b)
            .saturating_sub(border.saturating_mul(2))
            .max(0),
    }
}

fn to_flex(rect: ChromeRect) -> Rect {
    Rect {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
    }
}

fn intersection(a: Rect, b: Rect) -> Option<Rect> {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = a.x.saturating_add(a.w).min(b.x.saturating_add(b.w));
    let y2 = a.y.saturating_add(a.h).min(b.y.saturating_add(b.h));
    if x2 <= x1 || y2 <= y1 {
        None
    } else {
        Some(Rect {
            x: x1,
            y: y1,
            w: x2 - x1,
            h: y2 - y1,
        })
    }
}

fn contains(rect: Rect, x: i64, y: i64) -> bool {
    rect.w > 0
        && rect.h > 0
        && x >= rect.x
        && y >= rect.y
        && x < rect.x.saturating_add(rect.w)
        && y < rect.y.saturating_add(rect.h)
}

fn rects_overlap(a: Rect, b: Rect) -> bool {
    contains_origin(a, b) && contains_origin(b, a)
}

fn contains_origin(a: Rect, b: Rect) -> bool {
    a.w > 0
        && a.h > 0
        && b.w > 0
        && b.h > 0
        && a.x < b.x.saturating_add(b.w)
        && a.y < b.y.saturating_add(b.h)
}

fn apply_lifts(list: &mut Vec<Hit>, lifts: &[(usize, usize)]) {
    let mut slices = Vec::with_capacity(lifts.len());
    for &(start, end) in lifts.iter().rev() {
        if start >= list.len() || start >= end {
            slices.push(Vec::new());
            continue;
        }
        let end = end.min(list.len());
        slices.push(list.drain(start..end).collect());
    }
    for slice in slices.into_iter().rev() {
        list.extend(slice);
    }
}
