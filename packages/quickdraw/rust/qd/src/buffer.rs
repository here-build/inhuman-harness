//! Dual-frame cell grid, row damage, ANSI emit, content guard.
//! Wide glyphs occupy a glyph cell plus placeholder mates. Emit skips
//! placeholders. U+23CE's mate is a real space. Undefined background is
//! transparent and inherits; it is not black.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

use crate::measure::{grapheme_width, is_two_column_symbol, is_unit_width_run};

static OSC_OR_DCS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\u{001B}\][^\u{0007}\u{001B}]*(?:\u{0007}|\u{001B}\\)|\u{001B}[PX^_][^\u{001B}]*\u{001B}\\")
        .expect("OSC/DCS pattern is a valid regex")
});
static OSC_OR_DCS_PARTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\u{001B}[\]PX^_]").expect("partial OSC/DCS pattern is a valid regex")
});
static CSI_OR_ESC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\u{001B}\[[0-9;?]*[ -/]*[@-~]|\u{001B}.").expect("CSI pattern is a valid regex")
});
static C1_CSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\u{009B}[0-9;?]*[ -/]*[@-~]").expect("C1 CSI pattern is a valid regex")
});

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    pub bold: bool,
    pub dim: bool,
    pub strike: bool,
    pub italic: bool,
    pub underline: bool,
    pub href: Option<String>,
    pub fg: Option<f64>,
    pub fg_rgb: Option<Rgb>,
    pub bg: Option<f64>,
    pub bg_rgb: Option<Rgb>,
    pub cast_transparent: bool,
    pub bg_fx: Option<String>,
    pub bg_fx_u: Option<f64>,
    pub bg_fx_v: Option<f64>,
    pub bg_fx_opacity: Option<f64>,
    pub role: Option<String>,
    pub prominence: Option<f64>,
    pub bg_role: Option<String>,
    pub bg_prominence: Option<f64>,
    pub surface_role: Option<String>,
    pub surface_rgb: Option<Rgb>,
    pub surface_prominence: Option<f64>,
    pub fuse_role: Option<String>,
    pub fuse_prominence: Option<f64>,
    pub tint_role: Option<String>,
    pub tint: Option<f64>,
    pub region_prominence: Option<f64>,
    pub selected: bool,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            bold: false,
            dim: false,
            strike: false,
            italic: false,
            underline: false,
            href: None,
            fg: None,
            fg_rgb: None,
            bg: None,
            bg_rgb: None,
            cast_transparent: false,
            bg_fx: None,
            bg_fx_u: None,
            bg_fx_v: None,
            bg_fx_opacity: None,
            role: None,
            prominence: None,
            bg_role: None,
            bg_prominence: None,
            surface_role: None,
            surface_rgb: None,
            surface_prominence: None,
            fuse_role: None,
            fuse_prominence: None,
            tint_role: None,
            tint: None,
            region_prominence: None,
            selected: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Cell {
    pub ch: String,
    pub style: Style,
    pub placeholder: bool,
}

#[derive(Clone, Debug)]
pub struct Buffer {
    width: usize,
    height: usize,
    cells: Vec<Cell>,
}

impl Buffer {
    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// Length is `width * height`. Callers do not resize this slice.
    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }

    pub fn cells_mut(&mut self) -> &mut [Cell] {
        &mut self.cells
    }
}

fn blank() -> Cell {
    Cell {
        ch: " ".to_string(),
        style: Style::default(),
        placeholder: false,
    }
}

pub fn create_buffer(width: usize, height: usize) -> Buffer {
    Buffer {
        width,
        height,
        cells: vec![blank(); width * height],
    }
}

pub fn clone_buffer(buf: &Buffer) -> Buffer {
    buf.clone()
}

pub fn guard_content(text: &str) -> String {
    if !text.contains('\u{001B}') && !text.contains('\u{009B}') {
        return text.to_string();
    }
    let mut out = OSC_OR_DCS.replace_all(text, "").into_owned();
    out = OSC_OR_DCS_PARTIAL.replace_all(&out, "").into_owned();
    out = CSI_OR_ESC.replace_all(&out, "").into_owned();
    out = C1_CSI.replace_all(&out, "").into_owned();
    out.replace('\u{001B}', "")
}

fn claims_bg(style: &Style) -> bool {
    style.bg.is_some() || style.bg_rgb.is_some() || style.bg_fx.is_some()
}

pub fn merge_style(under: &Style, over: &Style) -> Style {
    let mut out = over.clone();
    if claims_bg(over) || over.cast_transparent {
        return out;
    }
    if under.bg_fx.is_some() {
        out.bg_fx.clone_from(&under.bg_fx);
        out.bg_fx_u = under.bg_fx_u;
        out.bg_fx_v = under.bg_fx_v;
        out.bg_fx_opacity = under.bg_fx_opacity;
        out.bg_rgb = under.bg_rgb;
    } else if under.bg_rgb.is_some() {
        out.bg_rgb = under.bg_rgb;
    } else if under.bg.is_some() {
        out.bg = under.bg;
    }
    out
}

fn write_cell(buf: &mut Buffer, x: isize, y: isize, cell: Cell) {
    if x < 0 || y < 0 || x >= buf.width as isize || y >= buf.height as isize {
        return;
    }
    let x = x as usize;
    let y = y as usize;
    let i = y * buf.width + x;
    let prev_placeholder = buf.cells[i].placeholder;
    if !prev_placeholder {
        let row_end = (y + 1) * buf.width;
        let mut j = i + 1;
        while j < row_end && buf.cells[j].placeholder {
            buf.cells[j] = blank();
            j += 1;
        }
    }
    let prev_style = buf.cells[i].style.clone();
    buf.cells[i] = Cell {
        ch: cell.ch,
        style: merge_style(&prev_style, &cell.style),
        placeholder: cell.placeholder,
    };
}

pub fn put(buf: &mut Buffer, x: isize, y: isize, text: &str, style: &Style) {
    if y < 0 || y >= buf.height as isize {
        return;
    }
    let text = guard_content(text);
    let mut cx = x;
    if is_unit_width_run(&text) {
        for ch in text.chars() {
            if cx >= buf.width as isize {
                break;
            }
            if cx >= 0 {
                write_cell(
                    buf,
                    cx,
                    y,
                    Cell {
                        ch: ch.to_string(),
                        style: style.clone(),
                        placeholder: false,
                    },
                );
            }
            cx += 1;
        }
        return;
    }
    for segment in text.graphemes(true) {
        let w = grapheme_width(segment);
        if w == 0 {
            continue;
        }
        if cx + w as isize > buf.width as isize {
            if cx >= buf.width as isize || w > 1 {
                break;
            }
        }
        if cx < 0 {
            cx += w as isize;
            continue;
        }
        write_cell(
            buf,
            cx,
            y,
            Cell {
                ch: segment.to_string(),
                style: style.clone(),
                placeholder: false,
            },
        );
        let pad = is_two_column_symbol(segment);
        for k in 1..w {
            write_cell(
                buf,
                cx + k as isize,
                y,
                Cell {
                    ch: if pad { " ".to_string() } else { String::new() },
                    style: style.clone(),
                    placeholder: !pad,
                },
            );
        }
        cx += w as isize;
    }
}

fn rgb_eq(a: Option<Rgb>, b: Option<Rgb>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.r == b.r && a.g == b.g && a.b == b.b,
        _ => false,
    }
}

fn opt_eq<T: PartialEq>(a: &Option<T>, b: &Option<T>) -> bool {
    a == b
}

fn cell_eq(a: &Cell, b: &Cell) -> bool {
    let sa = &a.style;
    let sb = &b.style;
    a.ch == b.ch
        && a.placeholder == b.placeholder
        && sa.bold == sb.bold
        && sa.dim == sb.dim
        && sa.strike == sb.strike
        && sa.italic == sb.italic
        && sa.underline == sb.underline
        && sa.href == sb.href
        && opt_eq(&sa.fg, &sb.fg)
        && opt_eq(&sa.bg, &sb.bg)
        && sa.bg_fx == sb.bg_fx
        && opt_eq(&sa.bg_fx_u, &sb.bg_fx_u)
        && opt_eq(&sa.bg_fx_v, &sb.bg_fx_v)
        && sa.role == sb.role
        && opt_eq(&sa.prominence, &sb.prominence)
        && sa.bg_role == sb.bg_role
        && opt_eq(&sa.bg_prominence, &sb.bg_prominence)
        && sa.surface_role == sb.surface_role
        && opt_eq(&sa.surface_prominence, &sb.surface_prominence)
        && sa.fuse_role == sb.fuse_role
        && opt_eq(&sa.fuse_prominence, &sb.fuse_prominence)
        && sa.tint_role == sb.tint_role
        && opt_eq(&sa.tint, &sb.tint)
        && opt_eq(&sa.region_prominence, &sb.region_prominence)
        && opt_eq(&sa.bg_fx_opacity, &sb.bg_fx_opacity)
        && sa.cast_transparent == sb.cast_transparent
        && rgb_eq(sa.fg_rgb, sb.fg_rgb)
        && rgb_eq(sa.bg_rgb, sb.bg_rgb)
        && sa.selected == sb.selected
}

pub fn dirty_rows(prev: Option<&Buffer>, next: &Buffer) -> Vec<usize> {
    let Some(prev) = prev else {
        return (0..next.height).collect();
    };
    if prev.width != next.width || prev.height != next.height {
        return (0..next.height).collect();
    }
    (0..next.height)
        .filter(|y| {
            let base = y * next.width;
            (0..next.width).any(|x| !cell_eq(&prev.cells[base + x], &next.cells[base + x]))
        })
        .collect()
}

fn clamp_byte(n: f64) -> u8 {
    if !n.is_finite() {
        return 0;
    }
    n.round().clamp(0.0, 255.0) as u8
}

fn clamp_index(n: f64) -> Option<u8> {
    if !n.is_finite() {
        return None;
    }
    Some(n.round().clamp(0.0, 255.0) as u8)
}

fn osc8_href(href: &Option<String>) -> String {
    let Some(href) = href else {
        return String::new();
    };
    if href.is_empty() {
        return String::new();
    }
    let lower = href.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return String::new();
    }
    if href.chars().any(|c| c <= '\u{001F}' || c == '\u{007F}') {
        return String::new();
    }
    href.clone()
}

const RESET_SGR: &str = "\u{001B}[0m";

fn sgr(style: &Style) -> Cow<'static, str> {
    // The reset sequence is the common cell. Returning it borrowed keeps
    // one function as the SGR authority and does not allocate per cell.
    if !style.bold
        && !style.dim
        && !style.italic
        && !style.underline
        && !style.strike
        && style.fg.is_none()
        && style.fg_rgb.is_none()
        && style.bg.is_none()
        && style.bg_rgb.is_none()
    {
        return Cow::Borrowed(RESET_SGR);
    }
    let mut parts = vec!["0".to_string()];
    if style.bold {
        parts.push("1".into());
    }
    if style.dim {
        parts.push("2".into());
    }
    if style.italic {
        parts.push("3".into());
    }
    if style.underline {
        parts.push("4".into());
    }
    if style.strike {
        parts.push("9".into());
    }
    if let Some(rgb) = style.fg_rgb {
        parts.push(format!(
            "38;2;{};{};{}",
            clamp_byte(rgb.r),
            clamp_byte(rgb.g),
            clamp_byte(rgb.b)
        ));
    } else if let Some(fg) = style.fg {
        if let Some(c) = clamp_index(fg) {
            parts.push(format!("38;5;{c}"));
        }
    }
    if let Some(rgb) = style.bg_rgb {
        parts.push(format!(
            "48;2;{};{};{}",
            clamp_byte(rgb.r),
            clamp_byte(rgb.g),
            clamp_byte(rgb.b)
        ));
    } else if let Some(bg) = style.bg {
        if let Some(c) = clamp_index(bg) {
            parts.push(format!("48;5;{c}"));
        }
    }
    Cow::Owned(format!("\u{001B}[{}m", parts.join(";")))
}

pub struct EmitAnsiOpts {
    pub sync2026: bool,
    pub force_full: bool,
}

impl Default for EmitAnsiOpts {
    fn default() -> Self {
        Self {
            sync2026: false,
            force_full: false,
        }
    }
}

pub struct EmitAnsiStats {
    pub ansi: String,
    pub dirty_rows: usize,
    pub bytes: usize,
}

pub fn emit_ansi_detailed(
    prev: Option<&Buffer>,
    next: &Buffer,
    opts: &EmitAnsiOpts,
) -> EmitAnsiStats {
    let rows: Vec<usize> = if opts.force_full {
        (0..next.height).collect()
    } else {
        dirty_rows(prev, next)
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
        let mut run_href = String::new();
        let mut run = String::new();
        let flush = |ansi: &mut String, run_style: &str, run_href: &str, run: &mut String| {
            if run.is_empty() {
                return;
            }
            if !run_href.is_empty() {
                ansi.push_str(&format!("\u{001B}]8;;{run_href}\u{001B}\\"));
            }
            ansi.push_str(run_style);
            ansi.push_str(run);
            ansi.push_str("\u{001B}[0m");
            if !run_href.is_empty() {
                ansi.push_str("\u{001B}]8;;\u{001B}\\");
            }
            run.clear();
        };
        for x in 0..next.width {
            let cell = &next.cells[y * next.width + x];
            if cell.placeholder {
                continue;
            }
            let st = sgr(&cell.style);
            let href = osc8_href(&cell.style.href);
            if st != run_style || href != run_href {
                flush(&mut ansi, &run_style, &run_href, &mut run);
                run_style.clear();
                run_style.push_str(&st);
                run_href = href;
            }
            run.push_str(&cell.ch);
        }
        flush(&mut ansi, &run_style, &run_href, &mut run);
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

pub fn emit_ansi(prev: Option<&Buffer>, next: &Buffer, opts: &EmitAnsiOpts) -> String {
    emit_ansi_detailed(prev, next, opts).ansi
}
