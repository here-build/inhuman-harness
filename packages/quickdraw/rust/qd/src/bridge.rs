//! Bridge between `ratatui` (buffer, style, widgets) and `qd::buffer`.

use std::borrow::Cow;

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier};
use ratatui::widgets::{StatefulWidget, Widget};

use crate::buffer::{
    create_buffer, put, Buffer as QdBuffer, EmitAnsiOpts, EmitAnsiStats, Rgb, Style as QdStyle,
};
use crate::measure::{grapheme_width, is_two_column_symbol};

const RESET_SGR: &str = "\u{001B}[0m";

/// Convert a `ratatui::style::Color` to quickdraw's `(Option<f64>, Option<Rgb>)` (indexed or RGB).
pub fn ratatui_color_to_qd(color: Color) -> (Option<f64>, Option<Rgb>) {
    match color {
        Color::Reset => (None, None),
        Color::Black => (Some(0.0), None),
        Color::Red => (Some(1.0), None),
        Color::Green => (Some(2.0), None),
        Color::Yellow => (Some(3.0), None),
        Color::Blue => (Some(4.0), None),
        Color::Magenta => (Some(5.0), None),
        Color::Cyan => (Some(6.0), None),
        Color::Gray => (Some(7.0), None),
        Color::DarkGray => (Some(8.0), None),
        Color::LightRed => (Some(9.0), None),
        Color::LightGreen => (Some(10.0), None),
        Color::LightYellow => (Some(11.0), None),
        Color::LightBlue => (Some(12.0), None),
        Color::LightMagenta => (Some(13.0), None),
        Color::LightCyan => (Some(14.0), None),
        Color::White => (Some(15.0), None),
        Color::Indexed(idx) => (Some(idx as f64), None),
        Color::Rgb(r, g, b) => (
            None,
            Some(Rgb {
                r: r as f64,
                g: g as f64,
                b: b as f64,
            }),
        ),
    }
}

/// Convert quickdraw color representation to `ratatui::style::Color`.
pub fn qd_color_to_ratatui(indexed: Option<f64>, rgb: Option<Rgb>) -> Color {
    if let Some(rgb) = rgb {
        Color::Rgb(rgb.r.round() as u8, rgb.g.round() as u8, rgb.b.round() as u8)
    } else if let Some(idx) = indexed {
        Color::Indexed(idx.clamp(0.0, 255.0) as u8)
    } else {
        Color::Reset
    }
}

/// Convert `ratatui::style::Style` to `qd::buffer::Style`.
pub fn ratatui_style_to_qd(style: ratatui::style::Style) -> QdStyle {
    let mut qd_style = QdStyle::default();
    if let Some(fg) = style.fg {
        let (idx, rgb) = ratatui_color_to_qd(fg);
        qd_style.fg = idx;
        qd_style.fg_rgb = rgb;
    }
    if let Some(bg) = style.bg {
        let (idx, rgb) = ratatui_color_to_qd(bg);
        qd_style.bg = idx;
        qd_style.bg_rgb = rgb;
    }
    if style.add_modifier.contains(Modifier::BOLD) {
        qd_style.bold = true;
    }
    if style.add_modifier.contains(Modifier::DIM) {
        qd_style.dim = true;
    }
    if style.add_modifier.contains(Modifier::ITALIC) {
        qd_style.italic = true;
    }
    if style.add_modifier.contains(Modifier::UNDERLINED) {
        qd_style.underline = true;
    }
    if style.add_modifier.contains(Modifier::CROSSED_OUT) {
        qd_style.strike = true;
    }
    qd_style
}

/// Convert `qd::buffer::Style` to `ratatui::style::Style`.
pub fn qd_style_to_ratatui(style: &QdStyle) -> ratatui::style::Style {
    let mut r_style = ratatui::style::Style::default();
    if style.fg.is_some() || style.fg_rgb.is_some() {
        r_style.fg = Some(qd_color_to_ratatui(style.fg, style.fg_rgb));
    }
    if style.bg.is_some() || style.bg_rgb.is_some() {
        r_style.bg = Some(qd_color_to_ratatui(style.bg, style.bg_rgb));
    }
    if style.bold {
        r_style.add_modifier = r_style.add_modifier.union(Modifier::BOLD);
    }
    if style.dim {
        r_style.add_modifier = r_style.add_modifier.union(Modifier::DIM);
    }
    if style.italic {
        r_style.add_modifier = r_style.add_modifier.union(Modifier::ITALIC);
    }
    if style.underline {
        r_style.add_modifier = r_style.add_modifier.union(Modifier::UNDERLINED);
    }
    if style.strike {
        r_style.add_modifier = r_style.add_modifier.union(Modifier::CROSSED_OUT);
    }
    r_style
}

fn copy_ratatui_to_qd(src: &ratatui::buffer::Buffer, dst: &mut QdBuffer) {
    for y in 0..src.area.height {
        let mut x = 0;
        while x < src.area.width {
            let cell = src.get(src.area.x + x, src.area.y + y);
            let style = ratatui_style_to_qd(ratatui::style::Style {
                fg: Some(cell.fg),
                bg: Some(cell.bg),
                add_modifier: cell.modifier,
                sub_modifier: Modifier::empty(),
            });
            put(
                dst,
                x as isize,
                y as isize,
                &cell.symbol,
                &style,
            );
            let w = grapheme_width(&cell.symbol);
            if w > 1 && !is_two_column_symbol(&cell.symbol) {
                x += w as u16;
            } else {
                x += 1;
            }
        }
    }
}

/// Convert a `ratatui::buffer::Buffer` to `qd::buffer::Buffer`.
pub fn ratatui_to_qd_buffer(src: &ratatui::buffer::Buffer) -> QdBuffer {
    let mut dst = create_buffer(src.area.width as usize, src.area.height as usize);
    copy_ratatui_to_qd(src, &mut dst);
    dst
}

/// Convert a `qd::buffer::Buffer` to `ratatui::buffer::Buffer`.
pub fn qd_to_ratatui_buffer(src: &QdBuffer) -> ratatui::buffer::Buffer {
    let area = Rect::new(0, 0, src.width() as u16, src.height() as u16);
    let mut dst = ratatui::buffer::Buffer::empty(area);
    let cells = src.cells();
    for y in 0..src.height() {
        for x in 0..src.width() {
            let idx = y * src.width() + x;
            if idx < cells.len() {
                let cell = &cells[idx];
                if !cell.placeholder {
                    let r_cell = dst.get_mut(x as u16, y as u16);
                    r_cell.set_symbol(&cell.ch);
                    r_cell.set_style(qd_style_to_ratatui(&cell.style));
                }
            }
        }
    }
    dst
}

/// Render any `ratatui` widget directly into a `qd::buffer::Buffer`.
pub fn render_widget_to_qd<W: Widget>(widget: W, qd_buf: &mut QdBuffer) {
    let area = Rect::new(0, 0, qd_buf.width() as u16, qd_buf.height() as u16);
    let mut r_buf = ratatui::buffer::Buffer::empty(area);
    widget.render(area, &mut r_buf);
    copy_ratatui_to_qd(&r_buf, qd_buf);
}

/// Render any `ratatui` stateful widget directly into a `qd::buffer::Buffer`.
pub fn render_stateful_widget_to_qd<W: StatefulWidget>(
    widget: W,
    qd_buf: &mut QdBuffer,
    state: &mut W::State,
) {
    let area = Rect::new(0, 0, qd_buf.width() as u16, qd_buf.height() as u16);
    let mut r_buf = ratatui::buffer::Buffer::empty(area);
    widget.render(area, &mut r_buf, state);
    copy_ratatui_to_qd(&r_buf, qd_buf);
}

fn ratatui_cell_eq(a: &ratatui::buffer::Cell, b: &ratatui::buffer::Cell) -> bool {
    a.symbol() == b.symbol() && a.fg == b.fg && a.bg == b.bg && a.modifier == b.modifier
}

/// Return row indices that differ between `prev` and `next` `ratatui::buffer::Buffer`s.
pub fn dirty_ratatui_rows(
    prev: Option<&ratatui::buffer::Buffer>,
    next: &ratatui::buffer::Buffer,
) -> Vec<usize> {
    let height = next.area.height as usize;
    let width = next.area.width as usize;
    let Some(prev) = prev else {
        return (0..height).collect();
    };
    if prev.area.width != next.area.width || prev.area.height != next.area.height {
        return (0..height).collect();
    }
    (0..height)
        .filter(|&y| {
            let py = prev.area.y + y as u16;
            let ny = next.area.y + y as u16;
            (0..width).any(|x| {
                let px = prev.area.x + x as u16;
                let nx = next.area.x + x as u16;
                !ratatui_cell_eq(prev.get(px, py), next.get(nx, ny))
            })
        })
        .collect()
}

fn color_sgr_part(color: Color, is_fg: bool) -> Option<String> {
    let prefix = if is_fg { "38" } else { "48" };
    match color {
        Color::Reset => None,
        Color::Black => Some(format!("{prefix};5;0")),
        Color::Red => Some(format!("{prefix};5;1")),
        Color::Green => Some(format!("{prefix};5;2")),
        Color::Yellow => Some(format!("{prefix};5;3")),
        Color::Blue => Some(format!("{prefix};5;4")),
        Color::Magenta => Some(format!("{prefix};5;5")),
        Color::Cyan => Some(format!("{prefix};5;6")),
        Color::Gray => Some(format!("{prefix};5;7")),
        Color::DarkGray => Some(format!("{prefix};5;8")),
        Color::LightRed => Some(format!("{prefix};5;9")),
        Color::LightGreen => Some(format!("{prefix};5;10")),
        Color::LightYellow => Some(format!("{prefix};5;11")),
        Color::LightBlue => Some(format!("{prefix};5;12")),
        Color::LightMagenta => Some(format!("{prefix};5;13")),
        Color::LightCyan => Some(format!("{prefix};5;14")),
        Color::White => Some(format!("{prefix};5;15")),
        Color::Indexed(idx) => Some(format!("{prefix};5;{idx}")),
        Color::Rgb(r, g, b) => Some(format!("{prefix};2;{r};{g};{b}")),
    }
}

/// Produce the SGR sequence for a `ratatui::buffer::Cell`, matching `qd::buffer`'s `sgr` format.
pub fn ratatui_cell_sgr(cell: &ratatui::buffer::Cell) -> Cow<'static, str> {
    let m = cell.modifier;
    let bold = m.contains(Modifier::BOLD);
    let dim = m.contains(Modifier::DIM);
    let italic = m.contains(Modifier::ITALIC);
    let underline = m.contains(Modifier::UNDERLINED);
    let strike = m.contains(Modifier::CROSSED_OUT);
    if !bold
        && !dim
        && !italic
        && !underline
        && !strike
        && matches!(cell.fg, Color::Reset)
        && matches!(cell.bg, Color::Reset)
    {
        return Cow::Borrowed(RESET_SGR);
    }
    let mut parts = vec!["0".to_string()];
    if bold {
        parts.push("1".into());
    }
    if dim {
        parts.push("2".into());
    }
    if italic {
        parts.push("3".into());
    }
    if underline {
        parts.push("4".into());
    }
    if strike {
        parts.push("9".into());
    }
    if let Some(fg) = color_sgr_part(cell.fg, true) {
        parts.push(fg);
    }
    if let Some(bg) = color_sgr_part(cell.bg, false) {
        parts.push(bg);
    }
    Cow::Owned(format!("\u{001B}[{}m", parts.join(";")))
}

/// Emit ANSI sequence directly from a `ratatui::buffer::Buffer` using native row diffing.
pub fn emit_ratatui_ansi(
    buf: &ratatui::buffer::Buffer,
    prev: Option<&ratatui::buffer::Buffer>,
    opts: &EmitAnsiOpts,
) -> EmitAnsiStats {
    let height = buf.area.height as usize;
    let width = buf.area.width as usize;
    let rows: Vec<usize> = if opts.force_full {
        (0..height).collect()
    } else {
        dirty_ratatui_rows(prev, buf)
    };
    if rows.is_empty() {
        return EmitAnsiStats {
            ansi: String::new(),
            dirty_rows: 0,
            bytes: 0,
        };
    }
    let mut ansi = String::new();
    if opts.sync2026 {
        ansi.push_str("\u{001B}[?2026h");
    }
    if opts.force_full || prev.is_none() {
        ansi.push_str("\u{001B}[2J");
    }
    for y in rows.iter().copied() {
        ansi.push_str(&format!("\u{001B}[{};1H\u{001B}[0m\u{001B}[2K", y + 1));
        let mut run_style = String::new();
        let mut run = String::new();
        let flush = |ansi: &mut String, run_style: &str, run: &mut String| {
            if run.is_empty() {
                return;
            }
            ansi.push_str(run_style);
            ansi.push_str(run);
            ansi.push_str(RESET_SGR);
            run.clear();
        };
        let mut x = 0usize;
        while x < width {
            let cell = buf.get(buf.area.x + x as u16, buf.area.y + y as u16);
            let sym = cell.symbol();
            let w = grapheme_width(sym);
            if w == 0 {
                x += 1;
                continue;
            }
            if w > 1 && x + w > width {
                break;
            }
            let st = ratatui_cell_sgr(cell);
            if st != run_style {
                flush(&mut ansi, &run_style, &mut run);
                run_style.clear();
                run_style.push_str(&st);
            }
            run.push_str(sym);
            if w > 1 {
                if is_two_column_symbol(sym) {
                    for _ in 1..w {
                        run.push(' ');
                    }
                    if x + 1 < width {
                        let next_sym = buf
                            .get(buf.area.x + (x + 1) as u16, buf.area.y + y as u16)
                            .symbol();
                        if next_sym == " " || next_sym.is_empty() {
                            x += w;
                        } else {
                            x += 1;
                        }
                    } else {
                        x += w;
                    }
                } else {
                    x += w;
                }
            } else {
                x += 1;
            }
        }
        flush(&mut ansi, &run_style, &mut run);
    }
    if opts.sync2026 {
        ansi.push_str("\u{001B}[?2026l");
    }
    let bytes = ansi.len();
    EmitAnsiStats {
        ansi,
        dirty_rows: rows.len(),
        bytes,
    }
}
