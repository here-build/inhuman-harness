//! Transcript selection on the present thread: gesture, recolor, OSC 52.
//!
//! The machine does not own the last paint. The caller passes the pre-toast
//! buffer and the hit frame for the step that needs them, then takes them back.
//! Recolor runs after the scene paint and before the copy plaque, so serialize
//! never reads the plaque glyphs.
//!
//! Hits carry no diff-line identity, so a split diff follows the free-text walk.

use std::collections::{HashMap, HashSet};

use crate::buffer::{Buffer, Cell as GridCell};
use crate::capabilities::{osc52_set, ClipboardSelect};
use crate::layout_chrome::{
    build_chrome_mask, MaskFrame, MaskHit, Rect as MaskRect, UserSelect as MaskSelect,
};
use crate::layout_hit::{
    contain_region_at, has_copyable_extent, row_range, selection_rect, serialize_selection, Cell,
    ElementKind, GestureEvent, GestureKind, GestureMachine, GestureOutput, Hit, HitFrame,
    Selection, UserSelect,
};
use crate::theme::{
    ansi16_to_rgb, ansi256_to_rgb, selection_fill_rgb, selection_recolor_bg_rgb,
    selection_recolor_rgb, Rgb as ThemeRgb,
};
use crate::Rgb;

/// What an SGR mouse report is, before picker and composer policy.
pub enum MouseGesture {
    Ignore,
    Move,
    Wheel { delta: i64 },
    Event(GestureEvent),
}

/// SGR button bits. Wheel is bit 6. Any-motion is button 35 and is not a drag.
pub fn mouse_to_gesture(button: i64, col: i64, row: i64, release: bool, t_ms: i64) -> MouseGesture {
    if button & 64 != 0 {
        if release || button & 2 != 0 {
            return MouseGesture::Ignore;
        }
        let delta = if button & 1 != 0 { 1 } else { -1 };
        return MouseGesture::Wheel { delta };
    }
    if button & 32 != 0 && button & 3 == 3 {
        if release {
            return MouseGesture::Ignore;
        }
        return MouseGesture::Move;
    }
    let kind = if release {
        GestureKind::Release
    } else if button & 32 == 0 {
        GestureKind::Press
    } else {
        GestureKind::Drag
    };
    MouseGesture::Event(GestureEvent {
        kind,
        col: col - 1,
        row: row - 1,
        t_ms,
        shift: button & 4 != 0,
        alt: button & 8 != 0,
        key: None,
    })
}

pub struct SelectionHost {
    machine: GestureMachine,
    stamp: Option<String>,
    last_copied: Option<String>,
}

impl std::fmt::Debug for SelectionHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelectionHost")
            .field("stamp", &self.stamp)
            .finish_non_exhaustive()
    }
}

impl SelectionHost {
    pub fn new() -> Self {
        Self {
            machine: GestureMachine::new(),
            stamp: None,
            last_copied: None,
        }
    }

    pub fn set_viewport(&mut self, w: i64, h: i64) {
        self.machine.set_viewport(w, h);
    }

    pub fn selection(&self) -> Option<Selection> {
        self.machine.selection()
    }

    pub fn clear(&mut self) {
        self.machine.clear();
        self.stamp = None;
    }

    /// Press, drag, or release against the paint the caller still owns.
    pub fn handle(
        &mut self,
        ev: GestureEvent,
        buffer: Option<&Buffer>,
        hits: Option<&HitFrame>,
    ) -> GestureOutput {
        let out = self.machine.handle_with(
            ev,
            Some(&|row| row_cells(buffer, row)),
            Some(&|cell| hits.and_then(|hits| contain_region_at(hits, cell.col, cell.row))),
        );
        self.stamp_from(out.selection.as_ref(), buffer, hits);
        out
    }

    /// Drop the extent when the glyphs under it are no longer the stamped text.
    pub fn invalidate(&mut self, buffer: &Buffer, hits: Option<&HitFrame>) {
        let Some(stamp) = self.stamp.clone() else {
            return;
        };
        let Some(sel) = self.selection() else {
            return;
        };
        let Some(hits) = hits else {
            return;
        };
        if serialize(buffer, &sel, hits) != stamp {
            self.clear();
        }
    }

    /// Paint the highlight. Zero lit cells drop the extent.
    pub fn recolor(&mut self, buffer: &mut Buffer, hits: Option<&HitFrame>, ground: f64) -> bool {
        let Some(sel) = self.selection() else {
            return false;
        };
        let Some(hits) = hits else {
            return false;
        };
        let mut cells = Vec::new();
        for_each_highlight(&sel, buffer, hits, |col, row| cells.push((col, row)));
        let mut hit = 0usize;
        for (col, row) in cells {
            let Some(cell) = cell_mut(buffer, col, row) else {
                continue;
            };
            hit += 1;
            recolor_style(&mut cell.style, ground);
        }
        if hit == 0 {
            self.clear();
            return false;
        }
        true
    }

    /// OSC 52 when this release is copy-ready and the stamp still matches.
    pub fn copy_osc(
        &mut self,
        out: &GestureOutput,
        buffer: Option<&Buffer>,
        hits: Option<&HitFrame>,
    ) -> String {
        if out.copy_ready != Some(true) {
            return String::new();
        }
        let Some(sel) = out.selection.as_ref() else {
            return String::new();
        };
        if !has_copyable_extent(Some(sel)) || self.selection().is_none() {
            return String::new();
        }
        let (Some(buffer), Some(hits)) = (buffer, hits) else {
            return String::new();
        };
        let text = serialize(buffer, sel, hits);
        if self.stamp.as_ref().is_some_and(|stamp| stamp != &text) {
            return String::new();
        }
        if text.is_empty() {
            return String::new();
        }
        self.last_copied = Some(text.clone());
        osc52_set(&text, ClipboardSelect::Both)
    }

    /// Text the last copy wrote. Ctrl+V uses it when the OS clipboard is empty.
    pub fn copied_text(&self) -> String {
        self.last_copied.clone().unwrap_or_default()
    }

    pub fn remember_copy(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.last_copied = Some(text.to_string());
    }

    /// Last lit cell on the active end. The plaque anchors here, not on the pointer.
    pub fn range_end(&self, buffer: Option<&Buffer>, hits: Option<&HitFrame>) -> Option<Cell> {
        let sel = self.selection()?;
        let (Some(buffer), Some(hits)) = (buffer, hits) else {
            return Some(sel.active);
        };
        Some(selection_range_end(&sel, buffer, hits))
    }

    fn stamp_from(
        &mut self,
        sel: Option<&Selection>,
        buffer: Option<&Buffer>,
        hits: Option<&HitFrame>,
    ) {
        let Some(sel) = sel else {
            self.stamp = None;
            return;
        };
        let Some((buffer, hits)) = buffer.zip(hits) else {
            self.stamp = None;
            return;
        };
        let text = serialize(buffer, sel, hits);
        self.stamp = if text.is_empty() { None } else { Some(text) };
    }
}

fn row_cells(buffer: Option<&Buffer>, row: i64) -> Option<Vec<String>> {
    let buffer = buffer?;
    let y = usize::try_from(row).ok()?;
    if y >= buffer.height() {
        return None;
    }
    let width = buffer.width();
    let mut out = Vec::with_capacity(width);
    for x in 0..width {
        out.push(buffer.cells()[y * width + x].ch.clone());
    }
    Some(out)
}

fn serialize(buffer: &Buffer, sel: &Selection, hits: &HitFrame) -> String {
    let mask = coverage(sel, buffer, hits);
    serialize_selection(buffer, sel, |col, row| {
        mask.as_ref().is_some_and(|mask| mask.is_chrome(col, row))
    })
}

fn coverage(
    sel: &Selection,
    buffer: &Buffer,
    hits: &HitFrame,
) -> Option<crate::layout_chrome::CoverageMask> {
    let width = i64::try_from(buffer.width()).unwrap_or(0);
    let height = i64::try_from(buffer.height()).unwrap_or(0);
    if width <= 0 || height <= 0 {
        return None;
    }
    let envelope = selection_rect(sel, width);
    Some(build_chrome_mask(
        &mask_frame(hits),
        envelope.x,
        envelope.y,
        envelope.x + envelope.w - 1,
        envelope.y + envelope.h - 1,
        width,
        height,
    ))
}

fn mask_frame(hits: &HitFrame) -> MaskFrame {
    MaskFrame {
        hit_list: hits.hit_list().iter().map(mask_hit).collect(),
        by_key: hits.records().iter().map(mask_hit).collect(),
    }
}

fn mask_hit(hit: &Hit) -> MaskHit {
    let rect = hit.rect();
    MaskHit {
        key: hit.key().to_string(),
        hit_rect: MaskRect::new(rect.x, rect.y, rect.w, rect.h),
        user_select: match hit.user_select() {
            UserSelect::None => MaskSelect::None,
            UserSelect::Text => MaskSelect::Text,
            UserSelect::All => MaskSelect::All,
            UserSelect::Contain => MaskSelect::Contain,
            UserSelect::Auto => MaskSelect::Auto,
        },
        phantom: false,
        element_kind: Some(hit.kind().as_str().to_string()),
    }
}

fn for_each_highlight(
    sel: &Selection,
    buffer: &Buffer,
    hits: &HitFrame,
    mut visit: impl FnMut(i64, i64),
) {
    let width = i64::try_from(buffer.width()).unwrap_or(0);
    let height = i64::try_from(buffer.height()).unwrap_or(0);
    if width <= 0 || height <= 0 {
        return;
    }
    let envelope = selection_rect(sel, width);
    let tl_row = envelope.y.max(0);
    let br_row = (envelope.y + envelope.h - 1).min(height - 1);
    if br_row < tl_row {
        return;
    }
    let cover = build_chrome_mask(
        &mask_frame(hits),
        0,
        tl_row,
        width - 1,
        br_row,
        width,
        height,
    );
    let leaves = leaf_keys(hits);
    let mut seen = HashSet::new();
    let mut row = tl_row;
    while row <= br_row {
        let Some((start_col, end_col)) = row_range(sel, row, width) else {
            row += 1;
            continue;
        };
        let start_col = start_col.max(0);
        let end_col = end_col.min(width - 1);
        if end_col < start_col {
            row += 1;
            continue;
        }
        let mut global_first = -1i64;
        let mut global_last = -1i64;
        let mut by_key: HashMap<String, Vec<i64>> = HashMap::new();
        let mut col = start_col;
        while col <= end_col {
            if cover.is_selectable(col, row) && !cover.is_chrome(col, row) {
                let key = cover.selectable_key(col, row);
                if !key.is_empty() {
                    by_key.entry(key.to_string()).or_default().push(col);
                    if is_glyph(buffer, col, row) {
                        if global_first < 0 {
                            global_first = col;
                        }
                        global_last = col;
                    }
                }
            }
            col += 1;
        }
        if global_first >= 0 {
            for (key, cols) in &by_key {
                let mut local_first = -1i64;
                let mut local_last = -1i64;
                for col in cols {
                    if !is_glyph(buffer, *col, row) {
                        continue;
                    }
                    if local_first < 0 {
                        local_first = *col;
                    }
                    local_last = *col;
                }
                let leaf = local_first >= 0 || leaves.get(key).copied().unwrap_or(false);
                if !leaf {
                    continue;
                }
                for col in cols {
                    if *col < global_first || *col > global_last {
                        continue;
                    }
                    if local_first >= 0 && *col > local_last {
                        continue;
                    }
                    if !is_painted(buffer, *col, row) {
                        continue;
                    }
                    if seen.insert((*col, row)) {
                        visit(*col, row);
                    }
                }
            }
        }
        row += 1;
    }
}

fn leaf_keys(hits: &HitFrame) -> HashMap<String, bool> {
    let mut out = HashMap::new();
    for hit in hits.records() {
        let leaf = match hit.user_select() {
            UserSelect::Contain | UserSelect::All => true,
            UserSelect::Text => hit.kind() == ElementKind::Text,
            UserSelect::None | UserSelect::Auto => false,
        };
        out.insert(hit.key().to_string(), leaf);
    }
    out
}

fn is_glyph(buffer: &Buffer, col: i64, row: i64) -> bool {
    let Some(cell) = cell_ref(buffer, col, row) else {
        return false;
    };
    !cell.placeholder && !cell.ch.is_empty() && cell.ch != " "
}

fn is_painted(buffer: &Buffer, col: i64, row: i64) -> bool {
    let Some(cell) = cell_ref(buffer, col, row) else {
        return false;
    };
    !cell.placeholder && !cell.ch.is_empty()
}

fn cell_ref(buffer: &Buffer, col: i64, row: i64) -> Option<&GridCell> {
    let x = usize::try_from(col).ok()?;
    let y = usize::try_from(row).ok()?;
    if x >= buffer.width() || y >= buffer.height() {
        return None;
    }
    buffer.cells().get(y * buffer.width() + x)
}

fn cell_mut(buffer: &mut Buffer, col: i64, row: i64) -> Option<&mut GridCell> {
    let x = usize::try_from(col).ok()?;
    let y = usize::try_from(row).ok()?;
    let width = buffer.width();
    if x >= width || y >= buffer.height() {
        return None;
    }
    buffer.cells_mut().get_mut(y * width + x)
}

fn selection_range_end(sel: &Selection, buffer: &Buffer, hits: &HitFrame) -> Cell {
    let mut lo = i64::MAX;
    let mut hi = i64::MIN;
    let mut on_active = false;
    let mut first: Option<Cell> = None;
    let mut last: Option<Cell> = None;
    for_each_highlight(sel, buffer, hits, |col, row| {
        let cell = Cell { col, row };
        let before_first = first.is_none_or(|at| row < at.row || (row == at.row && col < at.col));
        if before_first {
            first = Some(cell);
        }
        let after_last = last.is_none_or(|at| row > at.row || (row == at.row && col > at.col));
        if after_last {
            last = Some(cell);
        }
        if row != sel.active.row {
            return;
        }
        on_active = true;
        lo = lo.min(col);
        hi = hi.max(col);
    });
    if on_active {
        return Cell {
            col: hi.min(lo.max(sel.active.col)),
            row: sel.active.row,
        };
    }
    let toward_start = sel.active.row < sel.anchor.row
        || (sel.active.row == sel.anchor.row && sel.active.col < sel.anchor.col);
    if toward_start {
        first.unwrap_or(sel.active)
    } else {
        last.unwrap_or(sel.active)
    }
}

pub(crate) fn recolor_resolved_cell(style: &mut crate::Style, ground: f64) {
    recolor_style(style, ground);
}

fn recolor_style(style: &mut crate::Style, ground: f64) {
    style.selected = true;
    if let Some(rgb) = resolved_fg(style) {
        style.fg_rgb = Some(buffer_rgb(selection_recolor_rgb(rgb, ground, None)));
        style.fg = None;
    }
    let bg = match resolved_bg(style) {
        Some(rgb) => selection_recolor_bg_rgb(rgb, ground),
        None => selection_fill_rgb(ground),
    };
    style.bg_rgb = Some(buffer_rgb(bg));
    style.bg = None;
}

fn resolved_fg(style: &crate::Style) -> Option<ThemeRgb> {
    style
        .fg_rgb
        .map(theme_rgb)
        .or_else(|| style.fg.and_then(index_rgb))
}

fn resolved_bg(style: &crate::Style) -> Option<ThemeRgb> {
    style
        .bg_rgb
        .map(theme_rgb)
        .or_else(|| style.bg.and_then(index_rgb))
}

fn index_rgb(index: f64) -> Option<ThemeRgb> {
    if !index.is_finite() || index < 0.0 || index > f64::from(u16::MAX) {
        return None;
    }
    let index = index.floor() as u16;
    if index <= 15 {
        Some(ansi16_to_rgb(index as u8))
    } else {
        Some(ansi256_to_rgb(index))
    }
}

fn theme_rgb(rgb: Rgb) -> ThemeRgb {
    ThemeRgb {
        r: channel(rgb.r),
        g: channel(rgb.g),
        b: channel(rgb.b),
    }
}

fn buffer_rgb(rgb: ThemeRgb) -> Rgb {
    Rgb {
        r: f64::from(rgb.r),
        g: f64::from(rgb.g),
        b: f64::from(rgb.b),
    }
}

fn channel(channel: f64) -> u8 {
    if !channel.is_finite() {
        return 0;
    }
    channel.round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffer::{create_buffer, put};
    use crate::layout_engine::Viewport;
    use crate::layout_hit::{layout_hits, HitExtra, HitNode};
    use crate::layout_text::WhiteSpace;
    use crate::Style;

    #[test]
    fn a_drag_recolors_the_glyphs_and_copies_them() {
        let node = HitNode::Text {
            content: "hello".into(),
            key: Some("line".into()),
            white_space: Some(WhiteSpace::Nowrap),
            ellipsis: None,
            line_clamp: None,
            measured: None,
            extra: HitExtra::select(UserSelect::Text),
        };
        let hits = layout_hits(&node, Viewport { w: 10, h: 3 });
        let mut buffer = create_buffer(10, 3);
        put(&mut buffer, 0, 0, "hello", &Style::default());
        let mut host = SelectionHost::new();
        host.set_viewport(10, 3);
        host.handle(
            GestureEvent::at(GestureKind::Press, 0, 0, 0),
            Some(&buffer),
            Some(&hits),
        );
        host.handle(
            GestureEvent::at(GestureKind::Drag, 3, 0, 10),
            Some(&buffer),
            Some(&hits),
        );
        let release = host.handle(
            GestureEvent::at(GestureKind::Release, 3, 0, 20),
            Some(&buffer),
            Some(&hits),
        );
        let osc = host.copy_osc(&release, Some(&buffer), Some(&hits));
        assert_eq!(osc, osc52_set("hell\n", ClipboardSelect::Both));
        assert!(host.recolor(&mut buffer, Some(&hits), 0.2));
        assert!(buffer.cells()[0].style.bg_rgb.is_some());
        assert!(buffer.cells()[3].style.bg_rgb.is_some());
        assert!(buffer.cells()[4].style.bg_rgb.is_none());
    }
}
