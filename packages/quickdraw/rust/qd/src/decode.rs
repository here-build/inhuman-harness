//! Terminal text to [`InputEvent`]s.
//!
//! Variant names are the TypeScript `type` strings in PascalCase
//! (`shift_enter` → [`InputEvent::ShiftEnter`], `ctrl_c` → [`InputEvent::CtrlC`]).
//! A false modifier or `select` is the TypeScript field being absent.
//! Kitty `mod.persist` is always `true`, matching the literal type.
//!
//! [`consume_keys`] holds a trailing bare ESC in `pending`. The host turns that
//! one tail into [`InputEvent::Esc`] with [`flush_pending_esc`]. Any other
//! pending bytes stay pending. Indexing is by Unicode scalar, which matches
//! the JavaScript decoder on the BMP sequences this path emits.
//!
//! [`LayoutTable::Off`] skips both the ЙЦУКЕН ladder and the kitty flag-4
//! base-layout key. The caller parses `QD_NO_LAYOUT_TABLE` once.
//! [`layout_table`] maps `Some("1")` to off and every other value to on.
//! The TypeScript union's `unknown` variant is never emitted: a CSI this
//! decoder does not understand is swallowed.

/// Bytes of an OSC body (after `ESC ]`) before an unterminated sequence is dropped.
pub const MAX_OSC_BODY: usize = 512;

/// OSC ground color. The parser is [`crate::capabilities::parse_osc_color_payload`].
pub use crate::capabilities::Rgb;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputEvent {
    Char {
        ch: String,
    },
    Enter {
        shift: bool,
        alt: bool,
        ctrl: bool,
        meta: bool,
    },
    ShiftEnter,
    Esc {
        shift: bool,
        alt: bool,
        ctrl: bool,
        meta: bool,
    },
    Tab,
    ShiftTab,
    Backspace,
    Delete,
    Up {
        select: bool,
    },
    Down {
        select: bool,
    },
    Left {
        select: bool,
    },
    Right {
        select: bool,
    },
    Home {
        select: bool,
    },
    End {
        select: bool,
    },
    PageUp,
    PageDown,
    WordLeft {
        select: bool,
    },
    WordRight {
        select: bool,
    },
    WordBackspace,
    KillToStart,
    KillToEnd,
    CtrlC,
    CtrlX,
    CtrlO,
    CtrlV,
    Undo,
    Redo,
    SelectAll,
    Paste {
        text: String,
    },
    FocusIn,
    FocusOut,
    OscGround {
        rgb: Rgb,
    },
    ThemeChanged,
    Mouse {
        button: i64,
        col: i64,
        row: i64,
        release: bool,
    },
    /// Kitty report-all-keys Control/Super/Meta. `persist` is always true.
    Mod {
        persist: bool,
        down: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsumeKeysResult {
    pub events: Vec<InputEvent>,
    pub pending: String,
}

#[derive(Clone, Copy, Debug)]
struct Mod {
    shift: bool,
    alt: bool,
    ctrl: bool,
    meta: bool,
    caps_lock: bool,
}

impl Mod {
    fn none() -> Self {
        Self {
            shift: false,
            alt: false,
            ctrl: false,
            meta: false,
            caps_lock: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct KeyField {
    main: f64,
    shifted: Option<f64>,
    base: Option<f64>,
}

enum Step {
    Hold,
    Next(usize),
}

/// Whether a Ctrl/Alt/Super chord may rewrite a key through the layout table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum LayoutTable {
    #[default]
    On,
    Off,
}

/// `Some("1")` is off. Unset and every other value stay on.
pub fn layout_table(raw: Option<&str>) -> LayoutTable {
    if raw == Some("1") {
        LayoutTable::Off
    } else {
        LayoutTable::On
    }
}

/// `raw` is the next stdin chunk. `pending` is the previous incomplete tail
/// (empty string on the first chunk).
pub fn consume_keys(raw: &str, pending: &str, table: LayoutTable) -> ConsumeKeysResult {
    let mut text = String::with_capacity(pending.len() + raw.len());
    text.push_str(pending);
    text.push_str(raw);
    let chars: Vec<char> = text.chars().collect();
    let mut events = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match step(&chars, i, &mut events, table) {
            Step::Hold => {
                return ConsumeKeysResult {
                    events,
                    pending: chars[i..].iter().collect(),
                };
            }
            Step::Next(next) => i = next,
        }
    }
    ConsumeKeysResult {
        events,
        pending: String::new(),
    }
}

/// Bare `"\u{1b}"` becomes Esc. Every other tail, including empty, is unchanged.
pub fn flush_pending_esc(pending: &str) -> ConsumeKeysResult {
    if pending == "\u{1b}" {
        ConsumeKeysResult {
            events: vec![InputEvent::Esc {
                shift: false,
                alt: false,
                ctrl: false,
                meta: false,
            }],
            pending: String::new(),
        }
    } else {
        ConsumeKeysResult {
            events: Vec::new(),
            pending: pending.to_string(),
        }
    }
}

/// Bracketed-paste body: CRLF to LF, drop leading blank lines and trailing
/// whitespace, then strip the shared indent of the non-blank lines.
pub fn normalize_paste(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = strip_trailing_ws(strip_leading_blank_lines(&unified));
    if trimmed.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let mut min_indent: Option<usize> = None;
    for line in &lines {
        if is_blank_line(line) {
            continue;
        }
        let indent = leading_ws_len(line);
        min_indent = Some(match min_indent {
            Some(prev) if prev <= indent => prev,
            _ => indent,
        });
    }
    if let Some(indent) = min_indent {
        if indent > 0 {
            return lines
                .into_iter()
                .map(|line| {
                    if is_blank_line(line) {
                        String::new()
                    } else {
                        slice_chars(line, indent).to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    trimmed.to_string()
}

fn strip_leading_blank_lines(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut cut = 0;
    while i < bytes.len() {
        let mut j = i;
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'\n' {
            i = j + 1;
            cut = i;
        } else {
            break;
        }
    }
    &text[cut..]
}

fn strip_trailing_ws(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut end = bytes.len();
    while end > 0 {
        let b = bytes[end - 1];
        if b == b'\n' || b == b' ' || b == b'\t' {
            end -= 1;
        } else {
            break;
        }
    }
    &text[..end]
}

fn is_blank_line(line: &str) -> bool {
    line.bytes().all(|b| b == b' ' || b == b'\t')
}

fn leading_ws_len(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').count()
}

fn slice_chars(text: &str, count: usize) -> &str {
    match text.char_indices().nth(count) {
        Some((index, _)) => &text[index..],
        None => "",
    }
}

fn step(chars: &[char], i: usize, out: &mut Vec<InputEvent>, table: LayoutTable) -> Step {
    let ch = chars[i];
    if ch == '\u{1b}' {
        return step_esc(chars, i, out, table);
    }
    if ch == '\r' {
        out.push(bare_enter());
        let skip = if chars.get(i + 1) == Some(&'\n') {
            2
        } else {
            1
        };
        return Step::Next(i + skip);
    }
    if ch == '\n' {
        out.push(InputEvent::ShiftEnter);
        return Step::Next(i + 1);
    }
    if ch == '\u{7f}' || ch == '\u{8}' {
        out.push(InputEvent::Backspace);
        return Step::Next(i + 1);
    }
    if ch == '\u{3}' {
        out.push(InputEvent::CtrlC);
        return Step::Next(i + 1);
    }
    if let Some(event) = c0_event(ch) {
        out.push(event);
        return Step::Next(i + 1);
    }
    if ch == '\t' {
        out.push(InputEvent::Tab);
        return Step::Next(i + 1);
    }
    if ch >= ' ' {
        out.push(InputEvent::Char { ch: ch.to_string() });
        return Step::Next(i + 1);
    }
    Step::Next(i + 1)
}

fn c0_event(ch: char) -> Option<InputEvent> {
    Some(match ch {
        '\u{1}' => InputEvent::Home { select: false },
        '\u{4}' => InputEvent::Delete,
        '\u{5}' => InputEvent::End { select: false },
        '\u{b}' => InputEvent::KillToEnd,
        '\u{f}' => InputEvent::CtrlO,
        '\u{15}' => InputEvent::KillToStart,
        '\u{16}' => InputEvent::CtrlV,
        '\u{17}' => InputEvent::WordBackspace,
        '\u{18}' => InputEvent::CtrlX,
        '\u{19}' => InputEvent::Redo,
        '\u{1a}' => InputEvent::Undo,
        _ => return None,
    })
}

fn step_esc(chars: &[char], i: usize, out: &mut Vec<InputEvent>, table: LayoutTable) -> Step {
    if i + 1 >= chars.len() {
        return Step::Hold;
    }
    let n1 = chars[i + 1];
    if n1 == ']' {
        return step_osc(chars, i, out);
    }
    if n1 == '[' {
        return step_csi(chars, i, out, table);
    }
    if n1 == 'O' {
        if i + 2 >= chars.len() {
            return Step::Hold;
        }
        if let Some(event) = arrow_from_final(chars[i + 2], &Mod::none()) {
            out.push(event);
        }
        return Step::Next(i + 3);
    }
    if n1 == '\u{7f}' || n1 == '\u{8}' {
        out.push(InputEvent::WordBackspace);
        return Step::Next(i + 2);
    }
    if n1 == '\r' || n1 == '\n' {
        out.push(InputEvent::ShiftEnter);
        return Step::Next(i + 2);
    }
    if n1 == 'b' || n1 == 'B' {
        out.push(InputEvent::WordLeft { select: false });
        return Step::Next(i + 2);
    }
    if n1 == 'f' || n1 == 'F' {
        out.push(InputEvent::WordRight { select: false });
        return Step::Next(i + 2);
    }
    if n1 >= ' ' && n1 != '\u{7f}' {
        return Step::Next(i + 2);
    }
    out.push(bare_esc());
    Step::Next(i + 1)
}

fn step_osc(chars: &[char], i: usize, out: &mut Vec<InputEvent>) -> Step {
    let mut j = i + 2;
    let body_start = j;
    loop {
        if j >= chars.len() {
            if j - body_start >= MAX_OSC_BODY {
                return Step::Next(j);
            }
            return Step::Hold;
        }
        if j - body_start >= MAX_OSC_BODY {
            return Step::Next(j);
        }
        let c = chars[j];
        if c == '\u{7}' {
            push_osc_ground(out, &chars[body_start..j]);
            return Step::Next(j + 1);
        }
        if c == '\u{1b}' && j + 1 < chars.len() && chars[j + 1] == '\\' {
            push_osc_ground(out, &chars[body_start..j]);
            return Step::Next(j + 2);
        }
        if c == '\u{1b}' {
            return Step::Hold;
        }
        j += 1;
    }
}

fn push_osc_ground(out: &mut Vec<InputEvent>, body: &[char]) {
    let body: String = body.iter().collect();
    let Some(rest) = body.strip_prefix("11;") else {
        return;
    };
    if let Some(rgb) = crate::capabilities::parse_osc_color_payload(rest) {
        out.push(InputEvent::OscGround { rgb });
    }
}

fn step_csi(chars: &[char], i: usize, out: &mut Vec<InputEvent>, table: LayoutTable) -> Step {
    let mut j = i + 2;
    loop {
        if j >= chars.len() {
            return Step::Hold;
        }
        let code = chars[j] as u32;
        if (0x40..=0x7e).contains(&code) {
            let params: String = chars[i + 2..j].iter().collect();
            let final_b = chars[j];
            if final_b == '~' {
                let marker = first_number(&params);
                if is_key_opt(marker, 200) {
                    let body_start = j + 1;
                    let end_mark = ['\u{1b}', '[', '2', '0', '1', '~'];
                    let Some(end_at) = find_chars(chars, body_start, &end_mark) else {
                        return Step::Hold;
                    };
                    let raw: String = chars[body_start..end_at].iter().collect();
                    let text = normalize_paste(&raw);
                    if !text.is_empty() {
                        out.push(InputEvent::Paste { text });
                    }
                    return Step::Next(end_at + end_mark.len());
                }
                if is_key_opt(marker, 201) {
                    return Step::Next(j + 1);
                }
            }
            if let Some(event) = map_csi(&params, final_b, table) {
                out.push(event);
            }
            return Step::Next(j + 1);
        }
        if !(0x20..=0x3f).contains(&code) {
            return Step::Next(i + 1);
        }
        j += 1;
    }
}

fn find_chars(hay: &[char], start: usize, needle: &[char]) -> Option<usize> {
    if needle.is_empty() || start > hay.len() || hay.len() - start < needle.len() {
        return None;
    }
    let last = hay.len() - needle.len();
    let mut i = start;
    while i <= last {
        if &hay[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn map_csi(params: &str, final_b: char, table: LayoutTable) -> Option<InputEvent> {
    if final_b == 'n' && (params == "?997;1" || params == "?997;2") {
        return Some(InputEvent::ThemeChanged);
    }
    let parts = csi_parts(params);
    let p0 = csi_field_main(parts.first().copied());
    let p1 = csi_field_main(parts.get(1).copied());
    let p2 = csi_field_main(parts.get(2).copied());
    let event_type = csi_event_type(parts.get(1).copied().or(parts.first().copied()));
    if is_key(event_type, 3) {
        if final_b == 'u' && kitty_persist_mod(p0.unwrap_or(0.0)) {
            return Some(InputEvent::Mod {
                persist: true,
                down: false,
            });
        }
        return None;
    }
    if final_b == 'I' && parts.is_empty() {
        return Some(InputEvent::FocusIn);
    }
    if final_b == 'O' && parts.is_empty() {
        return Some(InputEvent::FocusOut);
    }
    if (final_b == 'M' || final_b == 'm') && params.starts_with('<') {
        return map_mouse(params, final_b == 'm');
    }
    if matches!(final_b, 'A' | 'B' | 'C' | 'D' | 'H' | 'F' | 'f') {
        return map_arrow(final_b, &parts, p0, p1);
    }
    if final_b == 'u' {
        return map_csi_u(&parts, p0, p1, table);
    }
    if final_b == '~' {
        return map_tilde(p0, p1, p2);
    }
    if final_b == 'Z' {
        return Some(InputEvent::ShiftTab);
    }
    None
}

fn csi_parts(params: &str) -> Vec<&str> {
    if params.is_empty() {
        Vec::new()
    } else {
        params.split(';').collect()
    }
}

fn map_mouse(params: &str, release: bool) -> Option<InputEvent> {
    let rest = params.strip_prefix('<')?;
    let fields: Vec<&str> = rest.split(';').collect();
    let button = js_floor_i64(js_number(*fields.first()?)?)?;
    let col = js_floor_i64(js_number(*fields.get(1)?)?)?;
    let row = js_floor_i64(js_number(*fields.get(2)?)?)?;
    if col < 1 || row < 1 {
        return None;
    }
    Some(InputEvent::Mouse {
        button,
        col,
        row,
        release,
    })
}

fn map_arrow(
    final_b: char,
    parts: &[&str],
    p0: Option<f64>,
    p1: Option<f64>,
) -> Option<InputEvent> {
    if parts.len() >= 2 {
        return arrow_from_final(final_b, &parse_mod(p1));
    }
    if parts.len() == 1 {
        if let Some(n) = p0 {
            if n > 1.0 && n < 20.0 {
                return arrow_from_final(final_b, &parse_mod(Some(n)));
            }
        }
    }
    arrow_from_final(final_b, &parse_mod(None))
}

fn map_csi_u(
    parts: &[&str],
    p0: Option<f64>,
    p1: Option<f64>,
    table: LayoutTable,
) -> Option<InputEvent> {
    let key_field = parts.first().copied().and_then(parse_key_field);
    let raw_key = key_field
        .as_ref()
        .map(|field| field.main)
        .or(p0)
        .unwrap_or(0.0);
    let modifiers = parse_mod(p1);
    let key = physical_latin(raw_key, key_field.as_ref(), &modifiers, table);
    let associated = parse_associated_text(parts.get(2).copied());
    if kitty_persist_mod(raw_key) {
        return Some(InputEvent::Mod {
            persist: true,
            down: true,
        });
    }
    if is_key(key, 13) {
        return Some(enter_event(&modifiers));
    }
    if is_key(key, 27) {
        return Some(esc_event(&modifiers));
    }
    if is_key(key, 127) {
        return Some(backspace_family(&modifiers));
    }
    if is_key(key, 9) {
        return Some(tab_family(&modifiers));
    }
    if let Some(event) = letter_chord(key, &modifiers) {
        return Some(event);
    }
    csi_printable(raw_key, &modifiers, key_field.as_ref(), associated)
}

fn map_tilde(p0: Option<f64>, p1: Option<f64>, p2: Option<f64>) -> Option<InputEvent> {
    if is_key_opt(p0, 27) && p2.is_some() {
        let modifiers = parse_mod(p1);
        let key = p2.unwrap_or(0.0);
        if is_key(key, 13) {
            return Some(enter_event(&modifiers));
        }
        if is_key(key, 27) {
            return Some(esc_event(&modifiers));
        }
        if is_key(key, 127) || is_key(key, 8) {
            return Some(backspace_family(&modifiers));
        }
        if let Some(event) = letter_chord(key, &modifiers) {
            return Some(event);
        }
        return csi_printable(key, &modifiers, None, None);
    }
    let code = exact_i64(p0.unwrap_or(0.0)).unwrap_or(i64::MIN);
    let modifiers = parse_mod(p1);
    match code {
        1 | 7 => Some(if modifiers.alt {
            InputEvent::WordLeft { select: false }
        } else {
            InputEvent::Home { select: false }
        }),
        4 | 8 => Some(if modifiers.alt {
            InputEvent::WordRight { select: false }
        } else {
            InputEvent::End { select: false }
        }),
        3 => Some(InputEvent::Delete),
        5 => Some(InputEvent::PageUp),
        6 => Some(InputEvent::PageDown),
        13 => Some(enter_event(&modifiers)),
        200 | 201 => None,
        _ => None,
    }
}

fn arrow_from_final(final_b: char, modifiers: &Mod) -> Option<InputEvent> {
    let select = modifiers.shift;
    Some(match final_b {
        'A' | 'a' => InputEvent::Up { select },
        'B' | 'b' => InputEvent::Down { select },
        'C' | 'c' => horizontal(false, select, modifiers),
        'D' | 'd' => horizontal(true, select, modifiers),
        'H' | 'h' => InputEvent::Home { select },
        'F' | 'f' => InputEvent::End { select },
        _ => return None,
    })
}

/// Left/right, or the word and line motions those arrows become under Alt/Ctrl/Super.
fn horizontal(left: bool, select: bool, modifiers: &Mod) -> InputEvent {
    if modifiers.meta || (modifiers.ctrl && !modifiers.alt) {
        if left {
            InputEvent::Home { select }
        } else {
            InputEvent::End { select }
        }
    } else if modifiers.alt {
        if left {
            InputEvent::WordLeft { select }
        } else {
            InputEvent::WordRight { select }
        }
    } else if left {
        InputEvent::Left { select }
    } else {
        InputEvent::Right { select }
    }
}

fn kitty_persist_mod(key: f64) -> bool {
    matches!(
        exact_i64(key),
        Some(57_442 | 57_444 | 57_446 | 57_448 | 57_450 | 57_452)
    )
}

fn letter_chord(keycode: f64, modifiers: &Mod) -> Option<InputEvent> {
    let keycode = exact_i64(keycode)?;
    let key = if (65..=90).contains(&keycode) {
        keycode + 32
    } else {
        keycode
    };
    if !(97..=122).contains(&key) {
        return None;
    }
    if modifiers.meta && !modifiers.ctrl {
        return match key {
            97 => Some(InputEvent::SelectAll),
            111 => Some(InputEvent::CtrlO),
            122 => Some(if modifiers.shift {
                InputEvent::Redo
            } else {
                InputEvent::Undo
            }),
            121 => Some(InputEvent::Redo),
            _ => None,
        };
    }
    if modifiers.ctrl {
        return ctrl_letter(key, modifiers);
    }
    None
}

fn ctrl_letter(key: i64, modifiers: &Mod) -> Option<InputEvent> {
    Some(match key {
        99 => InputEvent::CtrlC,
        120 => InputEvent::CtrlX,
        111 => InputEvent::CtrlO,
        118 => InputEvent::CtrlV,
        97 => InputEvent::Home { select: false },
        101 => InputEvent::End { select: false },
        117 => InputEvent::KillToStart,
        107 => InputEvent::KillToEnd,
        119 => InputEvent::WordBackspace,
        100 => InputEvent::Delete,
        106 => InputEvent::ShiftEnter,
        // CSI-u 109 is Ctrl+M. The event is a bare enter.
        // `decode.ts:334` returns `{ type: "enter" }` and does not spread `mod`.
        // The comment on `decode.ts:333` says "keep modifiers".
        // Copying `mod` here would reverse that return.
        109 => bare_enter(),
        122 => {
            if modifiers.shift {
                InputEvent::Redo
            } else {
                InputEvent::Undo
            }
        }
        121 => InputEvent::Redo,
        _ => return None,
    })
}

fn csi_printable(
    key: f64,
    modifiers: &Mod,
    field: Option<&KeyField>,
    associated: Option<String>,
) -> Option<InputEvent> {
    if modifiers.ctrl || modifiers.alt || modifiers.meta {
        return None;
    }
    if let Some(text) = associated {
        if !text.is_empty() {
            return Some(InputEvent::Char { ch: text });
        }
    }
    if is_key(key, 9) {
        return Some(tab_family(modifiers));
    }
    let key_i = exact_i64(key)?;
    if key_i < 32 || key_i == 127 {
        return None;
    }
    if (0xE000..=0xF8FF).contains(&key_i) {
        return None;
    }
    Some(InputEvent::Char {
        ch: resolve_glyph(key_i, modifiers, field)?,
    })
}

fn resolve_glyph(main: i64, modifiers: &Mod, field: Option<&KeyField>) -> Option<String> {
    let ch = char::from_u32(u32::try_from(main).ok()?)?;
    let cased = is_cased_letter(ch);
    let caps = cased && modifiers.caps_lock;
    let want_shift = modifiers.shift != caps;
    if !want_shift {
        return Some(ch.to_string());
    }
    if let Some(shifted) = field.and_then(|item| item.shifted) {
        let same = exact_i64(shifted) == Some(main);
        if !same {
            return Some(codepoint_char(shifted).unwrap_or_else(|| ch.to_string()));
        }
    }
    if cased {
        let upper: String = ch.to_uppercase().collect();
        if upper.chars().count() == 1 {
            return Some(upper);
        }
    }
    Some(ch.to_string())
}

fn codepoint_char(n: f64) -> Option<String> {
    let code = exact_i64(n)?;
    Some(char::from_u32(u32::try_from(code).ok()?)?.to_string())
}

fn is_cased_letter(ch: char) -> bool {
    let lower: String = ch.to_lowercase().collect();
    let upper: String = ch.to_uppercase().collect();
    lower != upper
}

fn parse_associated_text(field: Option<&str>) -> Option<String> {
    let field = field?;
    if field.is_empty() {
        return None;
    }
    let mut text = String::new();
    for part in field.split(':') {
        if part.is_empty() {
            return None;
        }
        let n = js_number(part)?;
        let code = exact_i64(n)?;
        if code < 0x20 || code == 0x7f || (0x80..=0x9f).contains(&code) {
            return None;
        }
        let ch = char::from_u32(u32::try_from(code).ok()?)?;
        text.push(ch);
    }
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn parse_key_field(field: &str) -> Option<KeyField> {
    if field.is_empty() {
        return None;
    }
    let subs: Vec<&str> = field.split(':').collect();
    let main = js_number(subs.first().copied().unwrap_or(""))?;
    let shifted = subs.get(1).copied().and_then(empty_as_none);
    let base = subs.get(2).copied().and_then(empty_as_none);
    Some(KeyField {
        main,
        shifted,
        base,
    })
}

fn empty_as_none(text: &str) -> Option<f64> {
    if text.is_empty() {
        None
    } else {
        js_number(text)
    }
}

fn csi_field_main(field: Option<&str>) -> Option<f64> {
    let field = field?;
    if field.is_empty() {
        return None;
    }
    let main = field.split(':').next().unwrap_or("");
    if main.is_empty() {
        return None;
    }
    js_number(main)
}

fn csi_event_type(field: Option<&str>) -> f64 {
    let Some(field) = field else {
        return 1.0;
    };
    if field.is_empty() {
        return 1.0;
    }
    let mut parts = field.split(':');
    let _main = parts.next();
    match parts.next() {
        None | Some("") => 1.0,
        Some(token) => js_number(token).unwrap_or(1.0),
    }
}

fn first_number(params: &str) -> Option<f64> {
    csi_field_main(Some(params.split(';').next().unwrap_or("")))
}

fn parse_mod(n: Option<f64>) -> Mod {
    let n = n.unwrap_or(1.0);
    let raw = if n.is_finite() {
        (n - 1.0).max(0.0)
    } else {
        0.0
    };
    let bits = js_to_int32(raw) as u32;
    Mod {
        shift: bits & 1 != 0,
        alt: bits & 2 != 0,
        ctrl: bits & 4 != 0,
        meta: bits & (8 | 16 | 32) != 0,
        caps_lock: bits & 64 != 0,
    }
}

fn enter_event(modifiers: &Mod) -> InputEvent {
    InputEvent::Enter {
        shift: modifiers.shift,
        alt: modifiers.alt,
        ctrl: modifiers.ctrl,
        meta: modifiers.meta,
    }
}

fn esc_event(modifiers: &Mod) -> InputEvent {
    InputEvent::Esc {
        shift: modifiers.shift,
        alt: modifiers.alt,
        ctrl: modifiers.ctrl,
        meta: modifiers.meta,
    }
}

fn bare_enter() -> InputEvent {
    InputEvent::Enter {
        shift: false,
        alt: false,
        ctrl: false,
        meta: false,
    }
}

fn bare_esc() -> InputEvent {
    InputEvent::Esc {
        shift: false,
        alt: false,
        ctrl: false,
        meta: false,
    }
}

fn tab_family(modifiers: &Mod) -> InputEvent {
    if modifiers.shift {
        InputEvent::ShiftTab
    } else {
        InputEvent::Tab
    }
}

fn backspace_family(modifiers: &Mod) -> InputEvent {
    if modifiers.meta {
        InputEvent::KillToStart
    } else if modifiers.alt {
        InputEvent::WordBackspace
    } else {
        InputEvent::Backspace
    }
}

fn physical_latin(
    raw_key: f64,
    field: Option<&KeyField>,
    modifiers: &Mod,
    table: LayoutTable,
) -> f64 {
    if !modifiers.ctrl && !modifiers.alt && !modifiers.meta {
        return raw_key;
    }
    if table == LayoutTable::Off {
        return raw_key;
    }
    if let Some(base) = base_layout_keycode(field) {
        return base;
    }
    if let Some(cp) = exact_u32(raw_key) {
        if let Some(latin) = layout_latin(cp) {
            return f64::from(latin);
        }
    }
    raw_key
}

fn base_layout_keycode(field: Option<&KeyField>) -> Option<f64> {
    let field = field?;
    let base = field.base?;
    if let Some(shifted) = field.shifted {
        if shifted == field.main {
            return None;
        }
    }
    Some(base)
}

/// Physical Latin key under the same finger on a ЙЦУКЕН layout.
/// Both cases map to the lowercase Latin codepoint.
fn layout_latin(cp: u32) -> Option<u32> {
    let ch = char::from_u32(cp)?;
    let latin = match ch {
        '\u{0439}' | '\u{0419}' => b'q',
        '\u{0446}' | '\u{0426}' => b'w',
        '\u{0443}' | '\u{0423}' => b'e',
        '\u{043a}' | '\u{041a}' => b'r',
        '\u{0435}' | '\u{0415}' => b't',
        '\u{043d}' | '\u{041d}' => b'y',
        '\u{0433}' | '\u{0413}' => b'u',
        '\u{0448}' | '\u{0428}' => b'i',
        '\u{0449}' | '\u{0429}' => b'o',
        '\u{0437}' | '\u{0417}' => b'p',
        '\u{0445}' | '\u{0425}' => b'[',
        '\u{044a}' | '\u{042a}' => b']',
        '\u{0444}' | '\u{0424}' => b'a',
        '\u{044b}' | '\u{042b}' => b's',
        '\u{0432}' | '\u{0412}' => b'd',
        '\u{0430}' | '\u{0410}' => b'f',
        '\u{043f}' | '\u{041f}' => b'g',
        '\u{0440}' | '\u{0420}' => b'h',
        '\u{043e}' | '\u{041e}' => b'j',
        '\u{043b}' | '\u{041b}' => b'k',
        '\u{0434}' | '\u{0414}' => b'l',
        '\u{0436}' | '\u{0416}' => b';',
        '\u{044d}' | '\u{042d}' => b'\'',
        '\u{044f}' | '\u{042f}' => b'z',
        '\u{0447}' | '\u{0427}' => b'x',
        '\u{0441}' | '\u{0421}' => b'c',
        '\u{043c}' | '\u{041c}' => b'v',
        '\u{0438}' | '\u{0418}' => b'b',
        '\u{0442}' | '\u{0422}' => b'n',
        '\u{044c}' | '\u{042c}' => b'm',
        '\u{0431}' | '\u{0411}' => b',',
        '\u{044e}' | '\u{042e}' => b'.',
        '\u{0451}' | '\u{0401}' => b'`',
        _ => return None,
    };
    Some(u32::from(latin))
}

/// JavaScript `Number` for a CSI token. Empty and whitespace-only are 0.
/// Non-finite results are `None` (callers that reject `""` do so first).
fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let n: f64 = trimmed.parse().ok()?;
    n.is_finite().then_some(n)
}

fn exact_i64(n: f64) -> Option<i64> {
    if !n.is_finite() || n.fract() != 0.0 {
        return None;
    }
    if !(i64::MIN as f64..=i64::MAX as f64).contains(&n) {
        return None;
    }
    Some(n as i64)
}

fn exact_u32(n: f64) -> Option<u32> {
    u32::try_from(exact_i64(n)?).ok()
}

fn is_key(n: f64, key: i64) -> bool {
    exact_i64(n) == Some(key)
}

fn is_key_opt(n: Option<f64>, key: i64) -> bool {
    n.is_some_and(|value| is_key(value, key))
}

fn js_floor_i64(n: f64) -> Option<i64> {
    if !n.is_finite() {
        return None;
    }
    let floored = n.floor();
    if !(i64::MIN as f64..=i64::MAX as f64).contains(&floored) {
        return None;
    }
    Some(floored as i64)
}

/// ECMAScript ToInt32, used by kitty modifier bit tests (`bits & mask`).
fn js_to_int32(n: f64) -> i32 {
    if !n.is_finite() || n == 0.0 {
        return 0;
    }
    let pos = n.abs().floor();
    let wrapped = pos % 4_294_967_296.0;
    let bits = wrapped as u32;
    let bits = if n.is_sign_negative() {
        bits.wrapping_neg()
    } else {
        bits
    };
    bits as i32
}
