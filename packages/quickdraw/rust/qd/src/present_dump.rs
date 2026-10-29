//! One snapshot painted headless. Stdin is the request. The runs are the cells a frame would show.

use serde_json::{Map, Value};

use crate::decode::LayoutTable;
use crate::measure::display_width;
use crate::paint_replica::{PaintReplica, ReplicaNote};
use crate::present::{Down, Present, PresentEnv, PresentOpts, Up};
use crate::syntax;

/// Host frame body for one [`Up`]. False modifiers are omitted. Kinds match the `qd` process frames.
pub fn up_json(message: &Up) -> String {
    match message {
        Up::Resize { cols, rows } => format!(r#"{{"kind":"resize","cols":{cols},"rows":{rows}}}"#),
        Up::Activate { key } => format!(r#"{{"kind":"activate","key":{}}}"#, json_string(key)),
        Up::PickerScroll { delta } => format!(r#"{{"kind":"picker_scroll","delta":{delta}}}"#),
        Up::AgentsScroll { delta } => format!(r#"{{"kind":"agents_scroll","delta":{delta}}}"#),
        Up::AgentsHover { key } => {
            let key = match key {
                Some(key) => json_string(key),
                None => "null".to_string(),
            };
            format!(r#"{{"kind":"agents_hover","key":{key}}}"#)
        }
        Up::InputEvents { events } => {
            let mut body = String::from(r#"{"kind":"input_events","events":["#);
            for (index, event) in events.iter().enumerate() {
                if index > 0 {
                    body.push(',');
                }
                body.push_str(r#"{"key":"#);
                body.push_str(&json_string(&event.key));
                if event.ctrl {
                    body.push_str(r#","ctrl":true"#);
                }
                if event.alt {
                    body.push_str(r#","alt":true"#);
                }
                if event.shift {
                    body.push_str(r#","shift":true"#);
                }
                if event.meta {
                    body.push_str(r#","meta":true"#);
                }
                body.push('}');
            }
            body.push_str("]}");
            body
        }
    }
}

/// Why a dump request produced no picture.
#[derive(Debug)]
pub enum DumpError {
    Request { detail: String },
    Snapshot { detail: String },
}

impl std::fmt::Display for DumpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Request { detail } | Self::Snapshot { detail } => f.write_str(detail),
        }
    }
}

/// One visible span. `ink` is the authored prominence bucket. `dim` is region prominence below 0.99.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DumpRun {
    pub y: u32,
    pub x: u32,
    pub text: String,
    pub role: String,
    pub ink: &'static str,
    pub dim: bool,
}

/// A resolved background span, including cells whose glyph is a space.
/// The picture uses this the way `bufferToPng` uses `bgRgb`. The run assertion does not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DumpFill {
    pub y: u32,
    pub x: u32,
    pub w: u32,
    pub bg: String,
}

/// Glyphs split where the resolved foreground changes.
/// The picture uses this the way `bufferToPng` uses `fgRgb`. The run assertion does not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DumpInk {
    pub y: u32,
    pub x: u32,
    pub text: String,
    pub fg: String,
}

/// Posted host messages and the visible runs of one frame.
#[derive(Clone, Debug)]
pub struct Dump {
    posted: Vec<Up>,
    pub runs: Vec<DumpRun>,
    pub fills: Vec<DumpFill>,
    pub inks: Vec<DumpInk>,
}

impl Dump {
    /// `{"posted":[...],"runs":[...]}` with no extra whitespace.
    pub fn json(&self) -> String {
        let mut out = String::from(r#"{"posted":["#);
        for (index, message) in self.posted.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&up_json(message));
        }
        out.push_str(r#"],"runs":["#);
        for (index, run) in self.runs.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&run_json(run));
        }
        out.push_str(r#"],"fills":["#);
        for (index, fill) in self.fills.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&fill_json(fill));
        }
        out.push_str(r#"],"inks":["#);
        for (index, ink) in self.inks.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&ink_json(ink));
        }
        out.push_str("]}");
        out
    }
}

struct Request {
    cols: u16,
    rows: u16,
    now_ms: u64,
    paint: String,
    input: Vec<String>,
}

/// Paint `raw` the way the process publishes a snapshot. Does not open a tty.
pub fn dump(raw: &str) -> Result<Dump, DumpError> {
    let request = parse_request(raw)?;
    let mut present = Present::boot(PresentOpts {
        cols: request.cols,
        rows: request.rows,
        tty: false,
        env: PresentEnv {
            colorterm: Some("truecolor".to_string()),
            ..PresentEnv::default()
        },
        layout_table: LayoutTable::On,
        ..PresentOpts::default()
    });
    let mut replica = PaintReplica::new();
    replica
        .apply(request.paint.as_bytes())
        .map_err(|error| DumpError::Snapshot {
            detail: error.to_string(),
        })?;
    replica.note_replica(ReplicaNote::Init);
    present.push_down(vec![Down::PaintInit]);
    syntax::warm();
    let width = i64::from(request.cols);
    let rows = i64::from(request.rows);
    let node = replica.frame(width).map_err(|error| DumpError::Snapshot {
        detail: error.to_string(),
    })?;
    if let Some(face) = replica.composer_face() {
        present.set_composer(face);
    }
    present.set_retained_scene(node);
    present.set_seat_rim(replica.seat_rim());
    present.set_agents_plaque(replica.agents_plaque());
    present.set_agents_preview(replica.agents_preview_open());
    present.set_preview_overlay(replica.preview_overlay(width, rows));
    for text in &request.input {
        present.push_input(text, request.now_ms);
    }
    let posted = present.take_posted();
    let buffer = present.painted_buffer(request.now_ms);
    Ok(Dump {
        posted,
        runs: collapse(&buffer),
        fills: collapse_fills(&buffer),
        inks: collapse_inks(&buffer),
    })
}

fn parse_request(raw: &str) -> Result<Request, DumpError> {
    let value: Value = serde_json::from_str(raw).map_err(|_| request("request is not json"))?;
    let Some(obj) = value.as_object() else {
        return Err(request("request is not an object"));
    };
    Ok(Request {
        cols: u16_field(obj, "cols")?,
        rows: u16_field(obj, "rows")?,
        now_ms: u64_field(obj, "nowMs")?,
        paint: string_field(obj, "paint")?,
        input: input_field(obj)?,
    })
}

fn request(detail: impl Into<String>) -> DumpError {
    DumpError::Request {
        detail: detail.into(),
    }
}

fn u16_field(obj: &Map<String, Value>, key: &str) -> Result<u16, DumpError> {
    let Some(value) = obj.get(key) else {
        return Err(request(format!("missing {key}")));
    };
    let Some(n) = value.as_u64() else {
        return Err(request(format!("{key} must be an integer")));
    };
    let Ok(n) = u16::try_from(n) else {
        return Err(request(format!("{key} is out of range")));
    };
    if n == 0 {
        return Err(request(format!("{key} is out of range")));
    }
    Ok(n)
}

fn u64_field(obj: &Map<String, Value>, key: &str) -> Result<u64, DumpError> {
    let Some(value) = obj.get(key) else {
        return Err(request(format!("missing {key}")));
    };
    value
        .as_u64()
        .ok_or_else(|| request(format!("{key} must be an integer")))
}

fn string_field(obj: &Map<String, Value>, key: &str) -> Result<String, DumpError> {
    let Some(value) = obj.get(key) else {
        return Err(request(format!("missing {key}")));
    };
    let Some(text) = value.as_str() else {
        return Err(request(format!("{key} must be a string")));
    };
    Ok(text.to_string())
}

fn input_field(obj: &Map<String, Value>) -> Result<Vec<String>, DumpError> {
    let Some(value) = obj.get("input") else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(request("input must be an array"));
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(request("input must be strings"));
        };
        out.push(text.to_string());
    }
    Ok(out)
}

struct OpenRun {
    x: usize,
    y: usize,
    text: String,
    role: String,
    ink: &'static str,
    dim: bool,
    end: usize,
}

// Left to right, top to bottom. A cell joins the open run when it starts on the
// previous glyph's advance and the role, ink, and dim match. Placeholder mates
// and empty cells are holes. Trailing spaces leave the run.
fn collapse(buf: &crate::Buffer) -> Vec<DumpRun> {
    let width = buf.width();
    let cells = buf.cells();
    let mut runs = Vec::new();
    for y in 0..buf.height() {
        let mut open: Option<OpenRun> = None;
        let mut x = 0usize;
        while x < width {
            let cell = &cells[y * width + x];
            if cell.placeholder || cell.ch.is_empty() {
                x += 1;
                continue;
            }
            let advance = display_width(&cell.ch).max(1);
            let role = cell.style.role.as_deref().unwrap_or("");
            let ink = ink_name(cell.style.prominence);
            let dim = cell
                .style
                .region_prominence
                .is_some_and(|prominence| prominence < 0.99);
            if let Some(run) = open.as_mut() {
                if run.end == x && run.role == role && run.ink == ink && run.dim == dim {
                    run.text.push_str(&cell.ch);
                    run.end = x + advance;
                    x += advance;
                    continue;
                }
            }
            flush_run(&mut runs, open.take());
            open = Some(OpenRun {
                x,
                y,
                text: cell.ch.clone(),
                role: role.to_string(),
                ink,
                dim,
                end: x + advance,
            });
            x += advance;
        }
        flush_run(&mut runs, open);
    }
    runs
}

fn flush_run(out: &mut Vec<DumpRun>, open: Option<OpenRun>) {
    let Some(run) = open else {
        return;
    };
    let text = run.text.trim_end_matches(' ');
    if text.is_empty() {
        return;
    }
    let x = u32::try_from(run.x).expect("buffer column fits u32");
    let y = u32::try_from(run.y).expect("buffer row fits u32");
    out.push(DumpRun {
        y,
        x,
        text: text.to_string(),
        role: run.role,
        ink: run.ink,
        dim: run.dim,
    });
}

fn ink_name(prominence: Option<f64>) -> &'static str {
    let Some(prominence) = prominence else {
        return "primary";
    };
    if prominence >= 0.86 {
        "primary"
    } else if prominence >= 0.64 {
        "secondary"
    } else if prominence >= 0.50 {
        "rising"
    } else if prominence >= 0.35 {
        "ghost"
    } else {
        "whisper"
    }
}

fn fill_json(fill: &DumpFill) -> String {
    format!(
        r#"{{"y":{},"x":{},"w":{},"bg":{}}}"#,
        fill.y,
        fill.x,
        fill.w,
        json_string(&fill.bg),
    )
}

fn ink_json(ink: &DumpInk) -> String {
    format!(
        r#"{{"y":{},"x":{},"text":{},"fg":{}}}"#,
        ink.y,
        ink.x,
        json_string(&ink.text),
        json_string(&ink.fg),
    )
}

fn run_json(run: &DumpRun) -> String {
    format!(
        r#"{{"y":{},"x":{},"text":{},"role":{},"ink":{},"dim":{}}}"#,
        run.y,
        run.x,
        json_string(&run.text),
        json_string(&run.role),
        json_string(run.ink),
        if run.dim { "true" } else { "false" },
    )
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if other.is_control() => out.push_str(&format!("\\u{:04x}", u32::from(other))),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

struct OpenFill {
    x: usize,
    w: usize,
    bg: String,
}

// Background is the wash under a diff row, including the spaces the text run trims.
fn collapse_fills(buf: &crate::Buffer) -> Vec<DumpFill> {
    let width = buf.width();
    let cells = buf.cells();
    let mut fills = Vec::new();
    for y in 0..buf.height() {
        let mut open: Option<OpenFill> = None;
        for x in 0..width {
            let bg = cells[y * width + x].style.bg_rgb.as_ref().map(hex_rgb);
            let extended = match (&open, bg.as_ref()) {
                (Some(span), Some(color)) if span.x + span.w == x && span.bg == *color => {
                    Some(OpenFill {
                        x: span.x,
                        w: span.w + 1,
                        bg: span.bg.clone(),
                    })
                }
                _ => None,
            };
            if let Some(span) = extended {
                open = Some(span);
                continue;
            }
            flush_fill(&mut fills, y, open.take());
            if let Some(color) = bg {
                open = Some(OpenFill { x, w: 1, bg: color });
            }
        }
        flush_fill(&mut fills, y, open);
    }
    fills
}

fn flush_fill(out: &mut Vec<DumpFill>, y: usize, open: Option<OpenFill>) {
    let Some(span) = open else {
        return;
    };
    out.push(DumpFill {
        y: u32::try_from(y).expect("buffer row fits u32"),
        x: u32::try_from(span.x).expect("buffer column fits u32"),
        w: u32::try_from(span.w).expect("buffer width fits u32"),
        bg: span.bg,
    });
}

struct OpenInk {
    x: usize,
    text: String,
    fg: String,
    end: usize,
}

// Split where the resolved foreground changes, so a syntax token keeps its own hue.
fn collapse_inks(buf: &crate::Buffer) -> Vec<DumpInk> {
    let width = buf.width();
    let cells = buf.cells();
    let mut inks = Vec::new();
    for y in 0..buf.height() {
        let mut open: Option<OpenInk> = None;
        let mut x = 0usize;
        while x < width {
            let cell = &cells[y * width + x];
            if cell.placeholder || cell.ch.is_empty() {
                x += 1;
                continue;
            }
            let advance = display_width(&cell.ch).max(1);
            let Some(fg) = cell.style.fg_rgb.as_ref().map(hex_rgb) else {
                flush_ink(&mut inks, y, open.take());
                x += advance;
                continue;
            };
            if let Some(run) = open.as_mut() {
                if run.end == x && run.fg == fg {
                    run.text.push_str(&cell.ch);
                    run.end = x + advance;
                    x += advance;
                    continue;
                }
            }
            flush_ink(&mut inks, y, open.take());
            open = Some(OpenInk {
                x,
                text: cell.ch.clone(),
                fg,
                end: x + advance,
            });
            x += advance;
        }
        flush_ink(&mut inks, y, open);
    }
    inks
}

fn flush_ink(out: &mut Vec<DumpInk>, y: usize, open: Option<OpenInk>) {
    let Some(run) = open else {
        return;
    };
    let text = run.text.trim_end_matches(' ');
    if text.is_empty() {
        return;
    }
    out.push(DumpInk {
        y: u32::try_from(y).expect("buffer row fits u32"),
        x: u32::try_from(run.x).expect("buffer column fits u32"),
        text: text.to_string(),
        fg: run.fg,
    });
}

fn hex_rgb(rgb: &crate::Rgb) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        channel_u8(rgb.r),
        channel_u8(rgb.g),
        channel_u8(rgb.b)
    )
}

fn channel_u8(channel: f64) -> u8 {
    if !channel.is_finite() {
        return 0;
    }
    let rounded = channel.round();
    if rounded <= 0.0 {
        0
    } else if rounded >= 255.0 {
        255
    } else {
        rounded as u8
    }
}
