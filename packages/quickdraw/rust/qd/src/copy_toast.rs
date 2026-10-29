//! Copy confirmation. A present overlay, not a layout node.
//!
//! The caller owns the clock. [`copy_toast_phase`] reads `now_ms` and does not
//! start a timer. Hold is 10s. Arm is 3s, after which input may dismiss.
//! Press dismisses immediately.

use crate::buffer::{put, Buffer};
use crate::layout_chrome::CHROME_FRAME_CORNERS;
use crate::measure::display_width;
use crate::theme::FgP;
use crate::Style;

pub const COPY_TOAST_TEXT: &str = "Copied";
pub const COPY_TOAST_ARM_MS: u64 = 3_000;
pub const COPY_TOAST_HOLD_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastSide {
    Below,
    Above,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CopyToastPlace {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub side: ToastSide,
}

/// Shown until hold. `armed` is the moment move, key, and scroll may dismiss.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyToastPhase {
    Shown { armed: bool },
    Clear,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastNotice {
    Press,
    Move,
    Input,
    Scroll,
}

pub fn copy_toast_phase(shown_at_ms: u64, now_ms: u64) -> CopyToastPhase {
    let age = now_ms.saturating_sub(shown_at_ms);
    if age >= COPY_TOAST_HOLD_MS {
        return CopyToastPhase::Clear;
    }
    CopyToastPhase::Shown {
        armed: age >= COPY_TOAST_ARM_MS,
    }
}

/// `true` when this notice, at this clock, takes the plaque down.
pub fn copy_toast_dismissed(shown_at_ms: u64, now_ms: u64, notice: ToastNotice) -> bool {
    match copy_toast_phase(shown_at_ms, now_ms) {
        CopyToastPhase::Clear => true,
        CopyToastPhase::Shown { armed } => matches!(notice, ToastNotice::Press) || armed,
    }
}

pub fn copy_toast_size(cols: i64, rows: i64, text: &str) -> (i64, i64) {
    let inner = (display_width(text) as i64).max(1);
    let padded = inner + 4;
    let tight = inner + 2;
    let w = if cols >= padded {
        padded
    } else {
        cols.max(2).min(tight)
    };
    let h = 3.min(rows.max(1));
    (w, h)
}

pub fn place_copy_toast(
    end_col: i64,
    end_row: i64,
    anchor_row: i64,
    cols: i64,
    rows: i64,
    text: &str,
) -> CopyToastPlace {
    let (w, h) = copy_toast_size(cols, rows, text);
    let prefer_above = end_row < anchor_row;
    let below_y = end_row + 1;
    let above_y = end_row - h;
    let below_fits = below_y >= 0 && below_y + h <= rows;
    let above_fits = above_y >= 0 && above_y + h <= rows;
    let (side, y) = if prefer_above {
        if above_fits {
            (ToastSide::Above, above_y)
        } else if below_fits {
            (ToastSide::Below, below_y)
        } else {
            (ToastSide::Above, clamp_i64(above_y, 0, (rows - h).max(0)))
        }
    } else if below_fits {
        (ToastSide::Below, below_y)
    } else if above_fits {
        (ToastSide::Above, above_y)
    } else {
        (ToastSide::Below, clamp_i64(below_y, 0, (rows - h).max(0)))
    };
    let x = clamp_i64(end_col - (w - 1) / 2, 0, (cols - w).max(0));
    CopyToastPlace { x, y, w, h, side }
}

pub fn paint_copy_toast(
    buf: &mut Buffer,
    place: CopyToastPlace,
    resolve: impl Fn(&Style) -> Style,
    text: &str,
) {
    let CopyToastPlace { x, y, w, h, .. } = place;
    if w < 1 || h < 1 {
        return;
    }
    let rim = resolve(&role_style(FgP::GHOST));
    let ink = resolve(&role_style(FgP::PRIMARY));
    if h == 1 {
        put_i64(buf, x, y, &clip_to_width(text, w), &ink);
        return;
    }
    let bar = "─".repeat(usize::try_from(w.saturating_sub(2)).unwrap_or(0));
    let top = if w >= 2 {
        format!(
            "{}{bar}{}",
            CHROME_FRAME_CORNERS.tl, CHROME_FRAME_CORNERS.tr
        )
    } else {
        "│".to_string()
    };
    put_i64(buf, x, y, &clip_to_width(&top, w), &rim);
    if h >= 3 {
        let bot = if w >= 2 {
            format!(
                "{}{bar}{}",
                CHROME_FRAME_CORNERS.bl, CHROME_FRAME_CORNERS.br
            )
        } else {
            "│".to_string()
        };
        put_i64(buf, x, y + h - 1, &clip_to_width(&bot, w), &rim);
    }
    let body_y = y + 1;
    if body_y >= y + h {
        return;
    }
    if w < 2 {
        put_i64(buf, x, body_y, "│", &rim);
        return;
    }
    put_i64(buf, x, body_y, "│", &rim);
    put_i64(buf, x + w - 1, body_y, "│", &rim);
    let inner = w - 2;
    if inner > 0 {
        put_i64(
            buf,
            x + 1,
            body_y,
            &" ".repeat(usize::try_from(inner).unwrap_or(0)),
            &Style::default(),
        );
    }
    let label = clip_to_width(text, inner);
    let label_w = display_width(&label) as i64;
    let left = ((inner - label_w) / 2).max(0);
    put_i64(buf, x + 1 + left, body_y, &label, &ink);
}

fn role_style(prominence: f64) -> Style {
    Style {
        role: Some("foreground".into()),
        prominence: Some(prominence),
        ..Style::default()
    }
}

fn put_i64(buf: &mut Buffer, x: i64, y: i64, text: &str, style: &Style) {
    let Ok(x) = isize::try_from(x) else {
        return;
    };
    let Ok(y) = isize::try_from(y) else {
        return;
    };
    put(buf, x, y, text, style);
}

fn clip_to_width(text: &str, width: i64) -> String {
    if width <= 0 {
        return String::new();
    }
    let width = usize::try_from(width).unwrap_or(0);
    if display_width(text) <= width {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars() {
        let next = format!("{out}{ch}");
        if display_width(&next) > width {
            break;
        }
        out = next;
    }
    out
}

fn clamp_i64(n: i64, lo: i64, hi: i64) -> i64 {
    n.max(lo).min(hi)
}
