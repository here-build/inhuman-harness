//! Terminal capability probe: query bytes, reply parser, and env color depth.
//!
//! The first frame calls [`terminal_caps`] and does not wait on this module.
//! [`settle_probe`] is a pure function of replies already read plus the timeout
//! the caller supplies. It does not open a TTY and does not sleep.
//! [`ProbeOutcome::Pending`] means that wait is still open.
//! The caller writes the query bytes. Nothing here touches a file descriptor.
//!
//! `tty` means stdin and stdout are both TTYs. Otherwise the result is the env
//! snapshot, leftover is empty, and `received` is ignored.
//! `elapsed_ms >= timeout_ms` is the caller's timer. Pass a smaller `elapsed_ms`
//! to keep the probe open. A budget of 0 settles on the bytes already in hand.
//! A batch settles early only when a terminated OSC 11 and a DA1 reply are both
//! present. DECRQM alone does not finish: the DA1 reply must not be left for
//! the shell. `batch: false` settles on OSC 11 alone.
//! On timeout, whatever arrived is parsed. An unterminated OSC stays in
//! [`DetectResult::leftover`].
//! `write_failed` keeps the env caps (no ground, no sync) and still strips
//! complete replies out of the leftover.

/// OSC 11 background-color query, BEL-terminated.
pub const OSC11_QUERY: &str = "\u{001B}]11;?\u{0007}";

/// Mode 2031 on: terminal color-scheme reports.
pub const THEME_REPORT_ENABLE: &str = "\u{001B}[?2031h";

/// Mode 2031 off.
pub const THEME_REPORT_DISABLE: &str = "\u{001B}[?2031l";

/// OSC 10 foreground-color query, BEL-terminated.
pub const OSC10_QUERY: &str = "\u{001B}]10;?\u{0007}";

/// DECRQM for mode 2026. Reply is `CSI ? 2026 ; Ps $ y`.
pub const DECRQM_2026: &str = "\u{001B}[?2026$p";

/// Primary device attributes. Probe batch ends with this.
pub const DA1_QUERY: &str = "\u{001B}[c";

pub const XTVERSION_QUERY: &str = "\u{001B}[>0q";

/// OSC 11, then DECRQM 2026, then DA1.
pub const PROBE_BATCH: &str = "\u{001B}]11;?\u{0007}\u{001B}[?2026$p\u{001B}[c";

/// TypeScript `detectCapabilities` budget when the caller omits one.
pub const DEFAULT_PROBE_TIMEOUT_MS: u64 = 100;

/// 8-bit channel color from an OSC payload. Not the paint grid's float `Rgb`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Probe guess and the depth paint matches on. [`crate::theme`] reexports this
/// enum. The order is [`guess_color_depth`]: first match wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ColorDepth {
    #[default]
    Truecolor,
    Ansi256,
    Ansi16,
    Mono,
}

/// Keys read by [`guess_color_depth`]. Absent and empty are different:
/// `NO_COLOR=""` is mono, `WT_SESSION=""` is not a truecolor host.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityEnv {
    pub no_color: Option<String>,
    pub colorterm: Option<String>,
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub wt_session: Option<String>,
}

/// Detected or guessed capabilities. Unknown probe fields stay `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalCaps {
    pub tty: bool,
    pub color_depth: ColorDepth,
    pub ground_rgb: Option<Rgb>,
    pub sync_2026: Option<bool>,
}

/// OSC 52 clipboard selector. `Both` is the wire default `cp`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ClipboardSelect {
    Clipboard,
    Primary,
    #[default]
    Both,
}

/// One scan of a probe reply buffer.
///
/// `osc11_payload` is the first terminated OSC 11 body. `ground_rgb` is that
/// body parsed as a color; a terminated body that is not a color is still
/// `Some` payload and `None` rgb. `sync_2026` is the first DECRQM 2026 report.
/// `da1` is searched on the original bytes. `leftover` then removes OSC 11,
/// DECRQM, and DA1 in that order, so a reply split around another reply can
/// vanish from the leftover without having counted as present.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeReplies<'a> {
    pub osc11_payload: Option<&'a str>,
    pub ground_rgb: Option<Rgb>,
    pub sync_2026: Option<bool>,
    pub da1: bool,
    pub leftover: String,
}

/// Already-received probe input. The caller owns the clock.
#[derive(Clone, Copy, Debug)]
pub struct SettleInput<'a> {
    /// Stdin and stdout are both TTYs.
    pub tty: bool,
    /// `true` sends [`PROBE_BATCH`] and waits for DA1. `false` is OSC 11 only.
    pub batch: bool,
    pub env: &'a CapabilityEnv,
    /// UTF-8 accumulation, the same bytes Node would concatenate with
    /// `chunk.toString("utf8")`. Not a read.
    pub received: &'a str,
    pub timeout_ms: u64,
    /// Milliseconds since the query was written, measured by the caller.
    pub elapsed_ms: u64,
    /// The query write threw. Caps stay the env guess.
    pub write_failed: bool,
}

/// Caps plus stdin bytes that were not capability replies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetectResult {
    pub caps: TerminalCaps,
    pub leftover: String,
}

/// Whether the caller's probe wait is over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// Still open. Paint the env snapshot; do not block the first frame.
    Pending,
    Ready(DetectResult),
}

/// Query bytes for this probe, or empty when there is nothing to write.
pub fn probe_query(tty: bool, batch: bool) -> &'static str {
    if !tty {
        ""
    } else if batch {
        PROBE_BATCH
    } else {
        OSC11_QUERY
    }
}

/// What the copy door was given. Image bytes are not a string and are not encoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyPayload<'a> {
    Text(&'a str),
    Image,
}

/// OSC 52 for text. An image stays [`CopyWrite::UnportedImage`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CopyWrite {
    Osc(String),
    UnportedImage,
    Empty,
}

/// The copy door. Text becomes OSC 52. An image payload is named and not encoded.
pub fn copy_selection(payload: CopyPayload<'_>) -> CopyWrite {
    match payload {
        CopyPayload::Image => CopyWrite::UnportedImage,
        CopyPayload::Text("") => CopyWrite::Empty,
        CopyPayload::Text(text) => CopyWrite::Osc(osc52_set(text, ClipboardSelect::Both)),
    }
}

/// OSC 52 clipboard write, BEL-terminated. `text` is encoded as UTF-8 base64.
pub fn osc52_set(text: &str, select: ClipboardSelect) -> String {
    let pc = match select {
        ClipboardSelect::Clipboard => "c",
        ClipboardSelect::Primary => "p",
        ClipboardSelect::Both => "cp",
    };
    let mut out = String::with_capacity(16 + text.len().div_ceil(3) * 4);
    out.push_str("\u{001B}]52;");
    out.push_str(pc);
    out.push(';');
    append_base64(&mut out, text.as_bytes());
    out.push('\u{0007}');
    out
}

/// `rgb:…` / `#rrggbb` / `rrggbb`. Anything else is `None`, not an error.
pub fn parse_osc_color_payload(payload: &str) -> Option<Rgb> {
    let text = payload.trim();
    if let Some(body) = text.strip_prefix("rgb:") {
        let mut parts = body.split('/');
        let r = parts.next()?;
        let g = parts.next()?;
        let b = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        if !is_hex_channel(r) || !is_hex_channel(g) || !is_hex_channel(b) {
            return None;
        }
        return Some(Rgb {
            r: scale_channel(r),
            g: scale_channel(g),
            b: scale_channel(b),
        });
    }

    let hex = text.strip_prefix('#').unwrap_or(text);
    if hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Some(Rgb {
            r: channel_byte(&hex[0..2]),
            g: channel_byte(&hex[2..4]),
            b: channel_byte(&hex[4..6]),
        });
    }
    None
}

/// OSC 11 uses the same color grammar as OSC 10.
pub fn parse_osc11_payload(payload: &str) -> Option<Rgb> {
    parse_osc_color_payload(payload)
}

/// First terminated OSC 11 payload, without the BEL or ST.
/// An empty or unterminated chunk is `None`. Whether the probe is still open
/// is [`settle_probe`]'s timeout, which still settles.
pub fn extract_osc11_from_buffer(buf: &str) -> Option<&str> {
    let (payload, _, _) = classify(buf);
    payload.map(|(start, end)| &buf[start..end])
}

/// First DECRQM reply for mode 2026 on `buf`.
/// Ps 1 or 3 is set (`Some(true)`), 2 or 4 is reset (`Some(false)`),
/// and any other Ps, including a missing reply, is `None`.
pub fn parse_decrqm_2026(buf: &str) -> Option<bool> {
    let (_, sync, _) = classify(buf);
    sync
}

/// `CSI ? … c` somewhere in `buf`. Searches the original bytes, before strip.
pub fn has_da1_reply(buf: &str) -> bool {
    let (_, _, da1) = classify(buf);
    da1
}

/// Drop complete OSC 11, DECRQM 2026, and DA1 replies, in that order.
/// A removal can reveal a later reply; partial fragments stay.
pub fn strip_probe_replies(buf: &str) -> String {
    let without_osc = remove_matches(buf, MatchKind::Osc11);
    let without_sync = remove_matches(&without_osc, MatchKind::Decrqm);
    remove_matches(&without_sync, MatchKind::Da1)
}

/// Classify `buf` once for decisions and strip it for the input re-inject.
pub fn parse_probe_replies(buf: &str) -> ProbeReplies<'_> {
    let (payload_at, sync_2026, da1) = classify(buf);
    let osc11_payload = payload_at.map(|(start, end)| &buf[start..end]);
    ProbeReplies {
        ground_rgb: osc11_payload.and_then(parse_osc_color_payload),
        osc11_payload,
        sync_2026,
        da1,
        leftover: strip_probe_replies(buf),
    }
}

/// Color depth from the environment. First match wins, and a later signal
/// does not promote:
///
/// - `NO_COLOR` set to any value, including `""`, is [`ColorDepth::Mono`].
/// - `COLORTERM` of `truecolor` or `24bit` is [`ColorDepth::Truecolor`].
/// - `TERM` containing `256color`, `truecolor`, or `direct`: `truecolor` or
///   `direct` is truecolor, otherwise [`ColorDepth::Ansi256`]. This beats iTerm.
/// - `TERM_PROGRAM=iTerm.app` is truecolor.
/// - A non-empty `WT_SESSION` is truecolor. `WT_SESSION=""` is not.
/// - Anything else is [`ColorDepth::Ansi16`]: bare `xterm`, `screen`, `tmux`,
///   `rxvt`, `vt100`, an unknown `TERM`, and Terminal.app.
///   `xterm-256color` already returned ansi256 above.
pub fn guess_color_depth(env: &CapabilityEnv) -> ColorDepth {
    if env.no_color.is_some() {
        return ColorDepth::Mono;
    }

    if let Some(colorterm) = env.colorterm.as_deref() {
        let colorterm = colorterm.to_lowercase();
        if colorterm == "truecolor" || colorterm == "24bit" {
            return ColorDepth::Truecolor;
        }
    }

    if let Some(term) = env.term.as_deref() {
        let term = term.to_lowercase();
        let named =
            term.contains("256color") || term.contains("truecolor") || term.contains("direct");
        if named {
            if term.contains("truecolor") || term.contains("direct") {
                return ColorDepth::Truecolor;
            }
            return ColorDepth::Ansi256;
        }
    }

    if env.term_program.as_deref() == Some("iTerm.app") {
        return ColorDepth::Truecolor;
    }
    if matches!(env.wt_session.as_deref(), Some(session) if !session.is_empty()) {
        return ColorDepth::Truecolor;
    }

    ColorDepth::Ansi16
}

/// Pre-probe snapshot. This is what the first frame paints with.
pub fn terminal_caps(tty: bool, env: &CapabilityEnv) -> TerminalCaps {
    TerminalCaps {
        tty,
        color_depth: guess_color_depth(env),
        ground_rgb: None,
        sync_2026: None,
    }
}

/// Settle a probe from bytes already received. Does not block.
pub fn settle_probe(input: SettleInput<'_>) -> ProbeOutcome {
    let caps = terminal_caps(input.tty, input.env);
    if !input.tty {
        return ProbeOutcome::Ready(DetectResult {
            caps,
            leftover: String::new(),
        });
    }

    let replies = parse_probe_replies(input.received);
    if input.write_failed {
        return ProbeOutcome::Ready(DetectResult {
            caps,
            leftover: replies.leftover,
        });
    }

    let ground_arrived = replies.osc11_payload.is_some();
    let batch_done = ground_arrived && (!input.batch || replies.da1);
    if !batch_done && input.elapsed_ms < input.timeout_ms {
        return ProbeOutcome::Pending;
    }

    ProbeOutcome::Ready(DetectResult {
        caps: TerminalCaps {
            ground_rgb: replies.ground_rgb,
            sync_2026: replies.sync_2026,
            ..caps
        },
        leftover: replies.leftover,
    })
}

#[derive(Clone, Copy)]
enum MatchKind {
    Osc11,
    Decrqm,
    Da1,
}

/// First OSC 11 payload range, first DECRQM report, and whether any DA1 is present.
/// Ranges point at `buf`. A failed introducer is not consumed, so a later reply
/// still matches.
fn classify(buf: &str) -> (Option<(usize, usize)>, Option<bool>, bool) {
    let bytes = buf.as_bytes();
    let mut index = 0;
    let mut payload = None;
    let mut sync_2026 = None;
    let mut sync_seen = false;
    let mut da1 = false;

    while index < bytes.len() {
        if bytes[index] != 0x1b {
            index += 1;
            continue;
        }
        if let Some((end, start, stop)) = match_osc11(bytes, index) {
            if payload.is_none() {
                payload = Some((start, stop));
            }
            index = end;
            continue;
        }
        if let Some((end, report)) = match_decrqm(bytes, index) {
            if !sync_seen {
                sync_2026 = report;
                sync_seen = true;
            }
            index = end;
            continue;
        }
        if let Some(end) = match_da1(bytes, index) {
            da1 = true;
            index = end;
            continue;
        }
        index += 1;
    }

    (payload, sync_2026, da1)
}

fn remove_matches(buf: &str, kind: MatchKind) -> String {
    let bytes = buf.as_bytes();
    let mut out = String::with_capacity(buf.len());
    let mut index = 0;
    let mut copy_from = 0;

    while index < bytes.len() {
        if bytes[index] != 0x1b {
            index += 1;
            continue;
        }
        let end = match kind {
            MatchKind::Osc11 => match_osc11(bytes, index).map(|(end, _, _)| end),
            MatchKind::Decrqm => match_decrqm(bytes, index).map(|(end, _)| end),
            MatchKind::Da1 => match_da1(bytes, index),
        };
        if let Some(end) = end {
            out.push_str(&buf[copy_from..index]);
            copy_from = end;
            index = end;
        } else {
            index += 1;
        }
    }

    out.push_str(&buf[copy_from..]);
    out
}

/// `(end, payload_start, payload_end)` for a terminated OSC 11 at `index`.
fn match_osc11(bytes: &[u8], index: usize) -> Option<(usize, usize, usize)> {
    const PREFIX: &[u8] = b"\x1b]11;";
    let rest = bytes.get(index..)?;
    if !rest.starts_with(PREFIX) {
        return None;
    }
    let mut cursor = index + PREFIX.len();
    let start = cursor;
    while cursor < bytes.len() && bytes[cursor] != 0x07 && bytes[cursor] != 0x1b {
        cursor += 1;
    }
    // Empty or unterminated payload is not a reply.
    // Whether the probe is still open is `settle_probe`'s timeout.
    if cursor == start || cursor >= bytes.len() {
        return None;
    }
    if bytes[cursor] == 0x07 {
        return Some((cursor + 1, start, cursor));
    }
    if bytes.get(cursor + 1) == Some(&b'\\') {
        return Some((cursor + 2, start, cursor));
    }
    None
}

/// `(end, report)` for `CSI ? 2026 ; Ps $ y`.
/// Ps 1 or 3 is `Some(true)`, 2 or 4 is `Some(false)`.
/// Unknown or overflowing Ps is `None`, and the reply is still consumed.
fn match_decrqm(bytes: &[u8], index: usize) -> Option<(usize, Option<bool>)> {
    const PREFIX: &[u8] = b"\x1b[?2026;";
    let rest = bytes.get(index..)?;
    if !rest.starts_with(PREFIX) {
        return None;
    }
    let mut cursor = index + PREFIX.len();
    let digits = cursor;
    while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
        cursor += 1;
    }
    if cursor == digits || bytes.get(cursor) != Some(&b'$') || bytes.get(cursor + 1) != Some(&b'y')
    {
        return None;
    }
    let text = std::str::from_utf8(&bytes[digits..cursor]).expect("DECRQM Ps digits are ASCII");
    let report = match text.parse::<u32>() {
        Ok(1) | Ok(3) => Some(true),
        Ok(2) | Ok(4) => Some(false),
        _ => None,
    };
    Some((cursor + 2, report))
}

/// End offset of `CSI ? [digits;]* c` at `index`.
fn match_da1(bytes: &[u8], index: usize) -> Option<usize> {
    const PREFIX: &[u8] = b"\x1b[?";
    let rest = bytes.get(index..)?;
    if !rest.starts_with(PREFIX) {
        return None;
    }
    let mut cursor = index + PREFIX.len();
    while cursor < bytes.len() && (bytes[cursor].is_ascii_digit() || bytes[cursor] == b';') {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'c') {
        Some(cursor + 1)
    } else {
        None
    }
}

fn is_hex_channel(text: &str) -> bool {
    let len = text.len();
    (1..=4).contains(&len) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn channel_byte(hex: &str) -> u8 {
    u8::from_str_radix(hex, 16).expect("channel hex is ASCII digits")
}

/// XParseColor: `n / (2^(digits*4) - 1) * 255`, rounded half away from zero.
fn scale_channel(hex: &str) -> u8 {
    let n = u32::from_str_radix(hex, 16).expect("channel hex is ASCII digits");
    let max = (1u32 << (hex.len() * 4)) - 1;
    let scaled = (f64::from(n) / f64::from(max)) * 255.0;
    let rounded = scaled.round();
    let byte = rounded as i64;
    u8::try_from(byte).expect("scaled channel stays inside 0..=255")
}

fn append_base64(out: &mut String, data: &[u8]) {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut index = 0;
    while index + 3 <= data.len() {
        let word = (u32::from(data[index]) << 16)
            | (u32::from(data[index + 1]) << 8)
            | u32::from(data[index + 2]);
        push_b64(out, ALPHABET, word);
        index += 3;
    }
    let rest = &data[index..];
    if rest.len() == 1 {
        let word = u32::from(rest[0]) << 16;
        out.push(ALPHABET[((word >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((word >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest.len() == 2 {
        let word = (u32::from(rest[0]) << 16) | (u32::from(rest[1]) << 8);
        out.push(ALPHABET[((word >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((word >> 12) & 0x3f) as usize] as char);
        out.push(ALPHABET[((word >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
}

fn push_b64(out: &mut String, alphabet: &[u8; 64], word: u32) {
    out.push(alphabet[((word >> 18) & 0x3f) as usize] as char);
    out.push(alphabet[((word >> 12) & 0x3f) as usize] as char);
    out.push(alphabet[((word >> 6) & 0x3f) as usize] as char);
    out.push(alphabet[(word & 0x3f) as usize] as char);
}
