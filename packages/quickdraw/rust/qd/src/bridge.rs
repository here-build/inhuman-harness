//! Bridge between `ratatui` (buffer, style, widgets) and `qd::buffer`.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier};
use ratatui::widgets::{StatefulWidget, Widget};

use crate::buffer::{
    create_buffer, emit_ansi_detailed, put, Buffer as QdBuffer, EmitAnsiOpts, EmitAnsiStats,
    Rgb, Style as QdStyle,
};

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
        for x in 0..src.area.width {
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

/// Emit ANSI sequence directly from a `ratatui::buffer::Buffer` using `qd::emit_ansi_detailed`.
pub fn emit_ratatui_ansi(
    buf: &ratatui::buffer::Buffer,
    prev: Option<&ratatui::buffer::Buffer>,
    opts: &EmitAnsiOpts,
) -> EmitAnsiStats {
    let current_qd = ratatui_to_qd_buffer(buf);
    let prev_qd = prev.map(ratatui_to_qd_buffer);
    emit_ansi_detailed(prev_qd.as_ref(), &current_qd, opts)
}
