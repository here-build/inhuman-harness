//! Present process: one owner, caused paints, no terminal.
//!
//! The caller writes the returned bytes. Nothing here opens a file descriptor,
//! sleeps, spawns a thread, or takes a lock. [`paint_if_needed`] borrows
//! [`Present`] as `&mut`.
//!
//! Enter and exit bytes are the ordered setup and teardown from `runtime/tty.ts`.
//! Leave-alt is last. [`Present::boot`] does not paint and does not settle a probe.
//! [`Present::feed_probe`] appends reply bytes the caller already read.
//! [`Present::stop`] drops the theme-report subscription. The caller writes
//! [`THEME_REPORT_DISABLE`](crate::capabilities::THEME_REPORT_DISABLE) and
//! then [`exit_bytes`]. [`exit_bytes`] is a static so a signal handler can
//! write it.
//!
//! Startup, fixed:
//!
//! 1. The first bytes are [`enter_bytes`] plus one default-theme frame. The frame
//!    is an empty chrome box on a grid laid out by [`crate::layout_engine::layout`],
//!    colored with [`crate::theme::default_theme`].
//! 2. That write happens while [`Present::probe_pending`] is still true. A pending
//!    probe does not block it. Theme-report subscribe and the ground query are
//!    appended after the frame, not before it.
//! 3. A later [`Present::feed_probe`] or OSC 11 only retints theme on this same
//!    [`Present`]. It does not enter the alt screen again.
//! 4. Idle (no live demand, no resize, no input, no theme change) emits nothing.
//!    A paint is caused. Live demand arms a millisecond interval the caller
//!    drives by passing `now_ms`; this module does not own a timer.
//!
//! Cadence rows that need the widget tree, a real timer, or a PTY are the
//! "Not ported, do not stub" list in `tests/present_oracle.rs`. They are not stubbed.

use std::collections::BTreeMap;

use crate::buffer::{
    clone_buffer, create_buffer, emit_ansi_detailed, put, Buffer, EmitAnsiOpts, Style,
};
use crate::capabilities::{
    guess_color_depth, osc52_set, settle_probe, CapabilityEnv, ClipboardSelect, ColorDepth,
    ProbeOutcome, SettleInput, TerminalCaps, DEFAULT_PROBE_TIMEOUT_MS, OSC11_QUERY,
    THEME_REPORT_DISABLE, THEME_REPORT_ENABLE,
};
use crate::composer_command::autocomplete_remainder;
use crate::copy_toast::{
    copy_toast_dismissed, copy_toast_phase, paint_copy_toast, place_copy_toast, CopyToastPhase,
    ToastNotice, COPY_TOAST_TEXT,
};
use crate::decode::{consume_keys, flush_pending_esc, normalize_paste, InputEvent, LayoutTable};
use crate::drawers::{self, AgentsPlaque};
use crate::layout_chrome::{
    chrome_frame_paint_ops, chrome_frame_text_inset, chrome_frame_text_width, measure_chrome_frame,
    paint_picker, paint_stacked_body, resolve_live_text, resolve_spinner_glyph, ChromeFrame,
    ChromeHotkey, ChromeLive, ChromePaintOp, ChromeQuotaWindow, ChromeStatusItem, LiveFace,
    PickerPaintInput, PickerRow, Rect as ChromeRect, StackedBodyInput,
    COMPOSER_COMMAND_MAX_VISIBLE,
};
use crate::layout_engine::{
    layout, Frame, LayoutOpts, LivePaint, Node, PaintOp, Positioned, Viewport,
    BACKDROP_REGION_PROMINENCE,
};
use crate::layout_flex::{FlexDirection, FlexStyle, Rect};
use crate::layout_hit::{
    composer_offset_after_cell, composer_offset_at_cell, element_at_path, hits_from_placed,
    layout_hits, visual_caret_geometry, Cell as SelCell, Click, HitFrame, HitNode, Intent,
};
use crate::layout_text::{split_at_width, take_grapheme};
use crate::measure::display_width;
use crate::selection_host::{mouse_to_gesture, MouseGesture, SelectionHost};
use crate::theme::{
    build_theme, default_theme, ground_from_rgb, resolve_style, BuildThemeOpts, ResolveCtx,
    Rgb as ThemeRgb, Role, StyleIntent, Theme, REFERENCE_GROUND,
};

/// Lone-ESC hold before it counts as Escape. Checked from the caller's clock.
pub const ESC_QUIET_MS: u64 = 30;

/// Ceiling used when the host omits a present rate. Not an idle loop.
pub const TARGET_FPS: u32 = 60;

/// Aesthetic clock for birth / progress / bgfx. This process does not run those.
pub const DEFAULT_FLOURISH_HZ: u32 = 30;

const KEY_KILL_LINE_START: &str = "KillLineStart";
const KEY_KILL_LINE_END: &str = "KillLineEnd";
const KEY_UNDO: &str = "Undo";
const KEY_REDO: &str = "Redo";
const KEY_SELECT_ALL: &str = "SelectAll";
const KEY_PASTE_PREFIX: &str = "Paste:";

/// `sync2026` defaults off when omitted here. [`Present`] turns it on unless
/// `QD_SYNC=0`, matching the host bracket, not this constructor's default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TtyOptions {
    pub sync2026: bool,
    pub hide_cursor: bool,
    pub no_wrap: bool,
}

impl Default for TtyOptions {
    fn default() -> Self {
        Self {
            sync2026: false,
            hide_cursor: true,
            no_wrap: true,
        }
    }
}

/// Ordered alt-screen enter. The caller writes it.
pub fn enter_bytes(opts: &TtyOptions) -> String {
    let mut out = String::from("\u{1b}[?1049h\u{1b}[2J\u{1b}[H");
    if opts.hide_cursor {
        out.push_str("\u{1b}[?25l");
    }
    if opts.no_wrap {
        out.push_str("\u{1b}[?7l");
    }
    if opts.sync2026 {
        out.push_str("\u{1b}[?2026h");
    }
    // modifyOtherKeys before kitty: iTerm clears kitty flags on that request.
    out.push_str(
        "\u{1b}[>4;2m\u{1b}[>31u\u{1b}[=31;1u\u{1b}[?2004h\u{1b}[?1004h\u{1b}[?1000h\u{1b}[?1002h\u{1b}[?1006h\u{1b}[?1007h",
    );
    out
}

macro_rules! tty_byte {
    (modes_off) => {
        "\u{1b}[?1006l\u{1b}[?1002l\u{1b}[?1000l\u{1b}[?1003l\u{1b}[?1007l\u{1b}[?1004l\u{1b}[?2004l\u{1b}[<u\u{1b}[>4;0m"
    };
    (pointer_default) => {
        "\u{1b}]22;default\u{0007}"
    };
    (pointer_hand) => {
        "\u{1b}]22;pointer\u{0007}"
    };
    (exit_tail) => {
        "\u{1b}[?2026l\u{1b}[r\u{1b}[?7h\u{1b}[?25h\u{1b}[999;1H\r\n\u{1b}[?1049l"
    };
}

/// Keyboard, paste, focus, and mouse brackets, closed.
pub fn input_modes_off_bytes() -> &'static str {
    tty_byte!(modes_off)
}

/// Teardown. `?2026l` is always present. Leave-alt is last.
///
/// A static, not a `String`: the process signal handler writes these bytes,
/// and a handler cannot allocate.
pub const EXIT_BYTES: &str = concat!(
    tty_byte!(modes_off),
    tty_byte!(pointer_default),
    tty_byte!(exit_tail),
);

/// Teardown. See [`EXIT_BYTES`].
pub fn exit_bytes() -> &'static str {
    EXIT_BYTES
}

/// 1-based CUP. Below 1 clamps to 1. The caller floors.
pub fn park_cursor(row: i64, col: i64) -> String {
    format!("\u{1b}[{};{}H", row.max(1), col.max(1))
}

/// Host-owned 1003. Enter never sends this. Off restores the enter mouse set.
pub fn mouse_any_motion_bytes(on: bool) -> String {
    if on {
        String::from("\u{1b}[?1003h")
    } else {
        String::from("\u{1b}[?1003l\u{1b}[?1000h\u{1b}[?1002h\u{1b}[?1006h")
    }
}

/// OSC 22 pointer shape. Enter never sends this. Exit restores default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MousePointer {
    Default,
    Pointer,
}

pub fn mouse_pointer_bytes(shape: MousePointer) -> &'static str {
    match shape {
        MousePointer::Default => tty_byte!(pointer_default),
        MousePointer::Pointer => tty_byte!(pointer_hand),
    }
}

/// Bytes the caller can write after the first frame. Not a gate on that frame.
pub fn capability_probe_query() -> &'static str {
    crate::capabilities::PROBE_BATCH
}

/// Ground and depth for the next paint. Omitted fields stay as they are.
#[derive(Clone, Debug, Default)]
pub struct AttuneOpts {
    pub ground: Option<f64>,
    pub ground_rgb: Option<ThemeRgb>,
    pub depth: Option<ColorDepth>,
}

/// One slash row. `actions` are the chords painted when the face has none of its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposerChoice {
    pub key: String,
    pub name: String,
    pub status: String,
    pub annotation: String,
    pub description: String,
    pub href: String,
    pub actions: Vec<ChromeHotkey>,
}

/// Slash list stacked above the draft. Absent when the catalog is closed.
///
/// `fallback` is the single `commandAction` row an empty choice list still
/// paints. That row does not complete the draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposerPicker {
    pub rows: Vec<ComposerChoice>,
    pub fallback: bool,
    pub selected_key: Option<String>,
    pub scroll_offset: i64,
}

/// Authoritative composer. The chrome frame paints this, unless an echo is standing.
///
/// Empty rail strings are absent. `progress: None` omits the ramp; `Some(0.0)` is
/// an empty one. Snapshot numbers that are not finite are dropped at the parse.
/// `picker: None` is a closed catalog. A value stacks the command list on the draft.
/// `stacked_body` is the ask or the queue above that draft. `stacked_viewport`
/// `0` shows every wrapped line. `scroll_offset` windows that body, and the
/// catalog when one is open.
#[derive(Clone, Debug, PartialEq)]
pub struct ComposerFace {
    pub draft: String,
    /// Hint shown in muted ink while the draft is empty.
    pub placeholder: String,
    pub cursor: i64,
    pub mark: Option<i64>,
    pub interactive: bool,
    pub annotation: String,
    pub join_annotation: String,
    pub hotkeys: Vec<ChromeHotkey>,
    pub status_items: Vec<ChromeStatusItem>,
    pub quota_windows: Vec<ChromeQuotaWindow>,
    pub context_used: Option<f64>,
    pub context_limit: Option<f64>,
    pub contour_role: String,
    pub progress: Option<f64>,
    pub progress_role: String,
    pub progress_glow_at: Option<f64>,
    pub picker: Option<ComposerPicker>,
    pub stacked_body: String,
    pub stacked_viewport: i64,
    pub stacked_numbered: bool,
    pub stacked_lang: String,
    pub scroll_offset: i64,
}

impl Default for ComposerFace {
    fn default() -> Self {
        Self {
            draft: String::new(),
            placeholder: String::new(),
            cursor: 0,
            mark: None,
            interactive: true,
            annotation: String::new(),
            join_annotation: String::new(),
            hotkeys: Vec::new(),
            status_items: Vec::new(),
            quota_windows: Vec::new(),
            context_used: None,
            context_limit: None,
            contour_role: String::new(),
            progress: None,
            progress_role: String::new(),
            progress_glow_at: None,
            picker: None,
            stacked_body: String::new(),
            stacked_viewport: 0,
            stacked_numbered: false,
            stacked_lang: String::new(),
            scroll_offset: 0,
        }
    }
}

/// Wire key. False modifiers are the TypeScript field being absent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedKey {
    pub key: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

impl DecodedKey {
    fn bare(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        }
    }

    fn mods(key: impl Into<String>, shift: bool, alt: bool, ctrl: bool, meta: bool) -> Self {
        Self {
            key: key.into(),
            ctrl,
            alt,
            shift,
            meta,
        }
    }
}

/// Held until the first structure or `paint_init`. Not a pass-through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputQueue<T> {
    ready: bool,
    held: Vec<T>,
}

impl<T> Default for InputQueue<T> {
    fn default() -> Self {
        empty_queue()
    }
}

impl<T> InputQueue<T> {
    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn held(&self) -> &[T] {
        &self.held
    }
}

pub fn empty_queue<T>() -> InputQueue<T> {
    InputQueue {
        ready: false,
        held: Vec::new(),
    }
}

pub fn offer<T>(mut queue: InputQueue<T>, events: Vec<T>) -> InputQueue<T> {
    if events.is_empty() {
        return queue;
    }
    queue.held.extend(events);
    queue
}

pub fn mark_ready<T>(mut queue: InputQueue<T>) -> InputQueue<T> {
    queue.ready = true;
    queue
}

pub struct Delivery<T> {
    pub queue: InputQueue<T>,
    pub events: Vec<T>,
}

pub fn deliver<T>(mut queue: InputQueue<T>) -> Delivery<T> {
    if !queue.ready || queue.held.is_empty() {
        return Delivery {
            queue,
            events: Vec::new(),
        };
    }
    Delivery {
        queue: InputQueue {
            ready: true,
            held: Vec::new(),
        },
        events: std::mem::take(&mut queue.held),
    }
}

/// Worker → UI. `tree` and box values are opaque strings. The widget snapshot
/// that turns them into a layout tree is not this process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Down {
    Structure { gen: i64, tree: String },
    BoxSet { box_id: i64, value: String },
    BoxFree { box_ids: Vec<i64> },
    PaintInit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mailbox {
    structure_gen: Option<i64>,
    tree: Option<String>,
    boxes: BTreeMap<i64, String>,
}

impl Default for Mailbox {
    fn default() -> Self {
        empty_mailbox()
    }
}

impl Mailbox {
    pub fn structure_gen(&self) -> Option<i64> {
        self.structure_gen
    }

    pub fn tree(&self) -> Option<&str> {
        self.tree.as_deref()
    }

    pub fn boxes(&self) -> &BTreeMap<i64, String> {
        &self.boxes
    }
}

pub fn empty_mailbox() -> Mailbox {
    Mailbox {
        structure_gen: None,
        tree: None,
        boxes: BTreeMap::new(),
    }
}

/// `structure` is latest-wins and does not touch boxes. `box_set` coalesces by
/// id. `box_free` is the only delete. Empty `box_free` is a no-op.
pub fn apply_box_bus_message(mut mailbox: Mailbox, message: Down) -> Mailbox {
    match message {
        Down::PaintInit => mailbox,
        Down::Structure { gen, tree } => {
            if mailbox.structure_gen.is_some_and(|have| gen <= have) {
                return mailbox;
            }
            mailbox.structure_gen = Some(gen);
            mailbox.tree = Some(tree);
            mailbox
        }
        Down::BoxSet { box_id, value } => {
            mailbox.boxes.insert(box_id, value);
            mailbox
        }
        Down::BoxFree { box_ids } => {
            if box_ids.is_empty() {
                return mailbox;
            }
            for id in box_ids {
                mailbox.boxes.remove(&id);
            }
            mailbox
        }
    }
}

pub fn apply_box_bus_batch(mailbox: Mailbox, messages: Vec<Down>) -> Mailbox {
    messages.into_iter().fold(mailbox, apply_box_bus_message)
}

/// UI → worker messages this process actually posts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Up {
    InputEvents {
        events: Vec<DecodedKey>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Activate {
        key: String,
    },
    /// One catalog notch. `delta` is `1` or `-1`. Tea adds it to `scrollOffset`.
    PickerScroll {
        delta: i64,
    },
    /// Pointer over a drawer row. `None` is a leave. Tea keeps the last key inside the panel.
    AgentsHover {
        key: Option<String>,
    },
    /// One drawer notch. `delta` is `1` or `-1`. Tea clamps the scroll.
    AgentsScroll {
        delta: i64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Local,
    Ssh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlourishMode {
    Full,
    Sparse,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorSource {
    Forced,
    Profile,
    Probe,
    Default,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresentConfig {
    pub profile: Transport,
    pub target_fps: u32,
    pub color_depth: ColorDepth,
    pub flourish: FlourishMode,
    pub flourish_hz: u32,
    pub prefer_sync_2026: bool,
    pub color_source: ColorSource,
    pub label: String,
}

/// Env keys the profile and the color guess read. Absent and empty differ:
/// `NO_COLOR=""` is mono, and an empty `SSH_CONNECTION` is not ssh.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PresentEnv {
    pub qd_profile: Option<String>,
    pub qd_fps: Option<String>,
    pub qd_color: Option<String>,
    pub qd_flourish: Option<String>,
    pub qd_sync: Option<String>,
    pub ssh_connection: Option<String>,
    pub ssh_client: Option<String>,
    pub ssh_tty: Option<String>,
    pub lc_ssh: Option<String>,
    pub remotehost: Option<String>,
    pub no_color: Option<String>,
    pub colorterm: Option<String>,
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub wt_session: Option<String>,
}

/// The keys [`guess_color_depth`] and the profile read. A missing key is
/// `None`. A set key, including `NO_COLOR=`, is `Some`.
pub fn present_env_from(var: impl Fn(&str) -> Option<String>) -> PresentEnv {
    PresentEnv {
        qd_profile: var("QD_PROFILE"),
        qd_fps: var("QD_FPS"),
        qd_color: var("QD_COLOR"),
        qd_flourish: var("QD_FLOURISH"),
        qd_sync: var("QD_SYNC"),
        ssh_connection: var("SSH_CONNECTION"),
        ssh_client: var("SSH_CLIENT"),
        ssh_tty: var("SSH_TTY"),
        lc_ssh: var("LC_SSH"),
        remotehost: var("REMOTEHOST"),
        no_color: var("NO_COLOR"),
        colorterm: var("COLORTERM"),
        term: var("TERM"),
        term_program: var("TERM_PROGRAM"),
        wt_session: var("WT_SESSION"),
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ResolvePresentOpts<'a> {
    pub env: &'a PresentEnv,
    pub probed_depth: Option<ColorDepth>,
    pub probed_sync_2026: Option<bool>,
}

pub fn detect_transport(env: &PresentEnv) -> Transport {
    if env.qd_profile.as_deref() == Some("local") {
        return Transport::Local;
    }
    if env.qd_profile.as_deref() == Some("ssh") {
        return Transport::Ssh;
    }
    if nonempty(&env.ssh_connection) || nonempty(&env.ssh_client) || nonempty(&env.ssh_tty) {
        return Transport::Ssh;
    }
    if nonempty(&env.lc_ssh) || nonempty(&env.remotehost) {
        return Transport::Ssh;
    }
    Transport::Local
}

pub fn demote_depth(have: ColorDepth, max: ColorDepth) -> ColorDepth {
    if depth_rank(have) <= depth_rank(max) {
        have
    } else {
        max
    }
}

pub fn resolve_present_config(opts: &ResolvePresentOpts<'_>) -> PresentConfig {
    let env = opts.env;
    let profile = match parse_profile(env) {
        ProfileName::Auto => detect_transport(env),
        ProfileName::Local => Transport::Local,
        ProfileName::Ssh => Transport::Ssh,
    };
    let target_fps = target_fps(env, profile);
    let flourish = parse_flourish(env, profile);
    let guessed = guess_color_depth(&capability_env(env));
    let probed = opts.probed_depth.unwrap_or(guessed);
    let (color_depth, color_source) = match parse_color_mode(env) {
        Some(forced) => (forced, ColorSource::Forced),
        None if profile == Transport::Ssh => {
            let source = if opts.probed_depth.is_some() {
                ColorSource::Probe
            } else {
                ColorSource::Profile
            };
            (demote_depth(probed, ColorDepth::Ansi256), source)
        }
        None => {
            let source = if opts.probed_depth.is_some() {
                ColorSource::Probe
            } else {
                ColorSource::Default
            };
            (probed, source)
        }
    };
    let prefer_sync_2026 = match env.qd_sync.as_deref() {
        Some("0") => false,
        Some("1") => true,
        _ => opts.probed_sync_2026 != Some(false),
    };
    let flourish_hz = flourish_hz(flourish, profile);
    let label = format!(
        "{}@{target_fps}fps {} flourish={}",
        transport_name(profile),
        depth_name(color_depth),
        flourish_name(flourish),
    );
    PresentConfig {
        profile,
        target_fps,
        color_depth,
        flourish,
        flourish_hz,
        prefer_sync_2026,
        color_source,
        label,
    }
}

#[derive(Clone, Debug)]
pub struct PresentOpts {
    pub cols: u16,
    pub rows: u16,
    pub env: PresentEnv,
    /// Stdin and stdout are both TTYs. False settles the probe as the env guess.
    pub tty: bool,
    /// `None` means on unless `QD_SYNC=0`. Probe never turns the bracket off.
    pub sync2026: Option<bool>,
    pub probe_timeout_ms: u64,
    /// Armed Ctrl-C hint. Read when a frame is painted while armed.
    pub quit_action: Option<String>,
    /// Replaces the profile rate as the live-demand ceiling.
    pub target_fps: Option<u32>,
    /// `Off` skips the ЙЦУКЕН ladder. The binary reads the env once.
    pub layout_table: LayoutTable,
}

impl Default for PresentOpts {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            env: PresentEnv::default(),
            tty: true,
            sync2026: None,
            probe_timeout_ms: DEFAULT_PROBE_TIMEOUT_MS,
            quit_action: None,
            target_fps: None,
            layout_table: LayoutTable::On,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputPush {
    /// Theme-report follow-ups. Not a frame.
    pub immediate: String,
    pub decoded: Vec<InputEvent>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paint {
    pub bytes: String,
    /// A wake ran the painter. False when the process stayed idle.
    pub caused: bool,
    pub dirty_rows: usize,
}

#[derive(Clone, Copy, Debug, Default)]
struct Cause {
    input: bool,
    resize: bool,
    theme: bool,
    scene: bool,
    live: bool,
    chrome: bool,
}

impl Cause {
    fn any(self) -> bool {
        self.input || self.resize || self.theme || self.scene || self.live || self.chrome
    }
}

#[derive(Debug)]
pub struct Present {
    cols: u16,
    rows: u16,
    env: PresentEnv,
    tty: bool,
    config: PresentConfig,
    sync_frames: bool,
    probe_timeout_ms: u64,
    probe_received: String,
    probe_elapsed: u64,
    probe_pending: bool,
    theme: Theme,
    ground: f64,
    ground_rgb: Option<ThemeRgb>,
    depth: ColorDepth,
    pending_ground: Option<ThemeRgb>,
    pending_depth: Option<ColorDepth>,
    entered: bool,
    previous: Option<Buffer>,
    cause: Cause,
    pending_keys: String,
    layout_table: LayoutTable,
    last_byte_at: u64,
    queue: InputQueue<DecodedKey>,
    mailbox: Mailbox,
    /// A `prepare()` root is on screen. Mailbox messages stay in the store.
    retained: bool,
    composer: ComposerFace,
    echo: crate::echo::EchoState,
    up: Vec<Up>,
    announced: bool,
    pending_resize: Option<(u16, u16)>,
    ready_fires: u32,
    scene: Node,
    hits: Option<HitNode>,
    /// Hit list from the last paint's placed rects. `None` after [`Self::set_hits`].
    hit_frame: Option<HitFrame>,
    live_hz: u32,
    live_due: Option<u64>,
    live_tick: u32,
    quit_action: Option<String>,
    quit_armed: bool,
    quit_actions: Vec<String>,
    quit_count: u32,
    mod_held: bool,
    term_focused: bool,
    mouse_down: bool,
    mouse_dragged: bool,
    collapsed: std::collections::BTreeMap<String, bool>,
    tape_scroll: i64,
    tape_at_bottom: bool,
    tape_max: i64,
    tape_window: i64,
    /// `:recap` key last aimed. `None` follows the tail.
    /// The same key leaves `tape_scroll` to the wheel. Clearing it, when the
    /// key disappears, follows the tail once. A parked scroll that lands on
    /// `tape_max` stays off the tail, or the next frame hides the recap.
    parked_recap: Option<String>,
    /// Composer rim. Off-tip is false unless ask, overlay, or auth stole the seat.
    seat_rim: bool,
    /// Host pin stack. prepare drops a prompt that is already on screen, then puts this back.
    rewind_seat: Option<Node>,
    stopped: bool,
    copy_toast: Option<CopyToast>,
    /// Compact tape is the default. Ctrl-O flips this. The key is not posted.
    tape_expanded: bool,
    /// Last drag-select paint. `None` until the first move in a gesture.
    selection_paint_at: Option<u64>,
    selection_paint_pending: bool,
    selection: SelectionHost,
    gesture_owner: GestureOwner,
    /// Open agents panel is in the scene. Wheel and press belong to it.
    drawer_open: bool,
    /// Host sneak-peek is open. Drawer hover, scroll, and row activate stay unposted.
    agents_preview: bool,
    /// Last hover key posted. The host paints the row from the next snapshot.
    agents_hover: Option<String>,
    /// Hoverable row under the press. `None` is a header, a bot, or outside the panel.
    agents_press: Option<String>,
    /// Plaque template. Seated after layout, because the anchor is a placed rect.
    agents_plaque: Option<AgentsPlaque>,
    /// Sneak-peek modal. Wrapped onto a clone of the scene at paint, so the
    /// retained scene does not keep the wrap.
    preview_overlay: Option<Node>,
    pointer_shape: MousePointer,
    /// Scene buffer while the plaque is up. Serialize reads this, not the emitted frame.
    selection_snap: Option<Buffer>,
    motion_on: bool,
    /// Last reported pointer cell. `None` until a move, and after focus leaves.
    ghost_pointer: Option<(i64, i64)>,
    /// Ghost chips from the last paint. Empty leaves any-motion to the toast and the drawer.
    ghost_rects: Vec<Rect>,
    /// Chip revealed by the last paint. A move that stays inside it does not repaint.
    ghost_hot: Option<Rect>,
    /// OS clipboard. The binary supplies the reader. This process does not spawn.
    clipboard_read: fn() -> Option<String>,
    /// Clipboard read before the last draft copy, and the slice that copy wrote.
    draft_copy: Option<DraftCopy>,
}

/// A draft selection writes its slice to the clipboard. This is what that write replaced.
#[derive(Debug)]
struct DraftCopy {
    prior: String,
    slice: String,
}

/// Whose press is in flight. A picker press does not arm a transcript selection.
#[derive(Debug)]
enum GestureOwner {
    None,
    Picker,
    Selection,
    Agents,
}

/// Drag-select present rate. Gesture state can move faster. Paint does not.
pub const SELECTION_PAINT_HZ: u64 = 30;

/// Milliseconds between drag-select paints. The caller clock crosses this window.
pub fn selection_paint_interval_ms() -> u64 {
    1000_u64.div_ceil(SELECTION_PAINT_HZ)
}

/// Selection end the copy plaque anchors to. The caller clock is `shown_at`.
#[derive(Clone, Debug)]
struct CopyToast {
    end_col: i64,
    end_row: i64,
    anchor_row: i64,
    shown_at: u64,
}

impl Present {
    /// Does not paint and does not wait on a probe.
    pub fn boot(opts: PresentOpts) -> Self {
        let cols = opts.cols.max(1);
        let rows = opts.rows.max(1);
        let mut config = resolve_present_config(&ResolvePresentOpts {
            env: &opts.env,
            probed_depth: None,
            probed_sync_2026: None,
        });
        if let Some(fps) = opts.target_fps {
            config.target_fps = fps.clamp(1, 240);
        }
        let sync_frames = opts
            .sync2026
            .unwrap_or(opts.env.qd_sync.as_deref() != Some("0"));
        let depth = config.color_depth;
        let theme = default_theme().clone();
        let mut present = Self {
            cols,
            rows,
            env: opts.env,
            tty: opts.tty,
            config,
            sync_frames,
            probe_timeout_ms: opts.probe_timeout_ms,
            probe_received: String::new(),
            probe_elapsed: 0,
            probe_pending: opts.tty,
            theme,
            ground: REFERENCE_GROUND,
            ground_rgb: None,
            depth,
            pending_ground: None,
            pending_depth: None,
            entered: false,
            previous: None,
            cause: Cause::default(),
            pending_keys: String::new(),
            layout_table: opts.layout_table,
            last_byte_at: 0,
            queue: empty_queue(),
            mailbox: empty_mailbox(),
            retained: false,
            composer: ComposerFace::default(),
            echo: crate::echo::EchoState::empty(),
            up: Vec::new(),
            announced: false,
            pending_resize: None,
            ready_fires: 0,
            scene: idle_scene(),
            hits: None,
            hit_frame: None,
            live_hz: 0,
            live_due: None,
            live_tick: 0,
            quit_action: opts.quit_action,
            quit_armed: false,
            quit_actions: Vec::new(),
            quit_count: 0,
            mod_held: false,
            term_focused: true,
            mouse_down: false,
            mouse_dragged: false,
            collapsed: std::collections::BTreeMap::new(),
            tape_scroll: 0,
            tape_at_bottom: true,
            tape_max: 0,
            tape_window: 1,
            parked_recap: None,
            seat_rim: true,
            rewind_seat: None,
            stopped: false,
            copy_toast: None,
            tape_expanded: false,
            selection_paint_at: None,
            selection_paint_pending: false,
            selection: SelectionHost::new(),
            gesture_owner: GestureOwner::None,
            drawer_open: false,
            agents_preview: false,
            agents_hover: None,
            agents_press: None,
            agents_plaque: None,
            preview_overlay: None,
            pointer_shape: MousePointer::Default,
            selection_snap: None,
            motion_on: false,
            ghost_pointer: None,
            ghost_rects: Vec::new(),
            ghost_hot: None,
            clipboard_read: clipboard_unread,
            draft_copy: None,
        };
        if opts.tty {
            present.recompute_probe();
        } else {
            present.probe_pending = false;
        }
        present
    }

    pub fn probe_pending(&self) -> bool {
        self.probe_pending
    }

    pub fn theme_ground(&self) -> f64 {
        self.ground
    }

    pub fn color_depth(&self) -> ColorDepth {
        self.depth
    }

    pub fn config(&self) -> &PresentConfig {
        &self.config
    }

    pub fn live_hz(&self) -> u32 {
        self.live_hz
    }

    pub fn posted(&self) -> &[Up] {
        &self.up
    }

    /// Take the messages waiting for the worker. The queue is empty after this.
    pub fn take_posted(&mut self) -> Vec<Up> {
        std::mem::take(&mut self.up)
    }

    pub fn mailbox(&self) -> &Mailbox {
        &self.mailbox
    }

    pub fn ready(&self) -> bool {
        self.queue.ready()
    }

    pub fn ready_fires(&self) -> u32 {
        self.ready_fires
    }

    pub fn held_keys(&self) -> &[DecodedKey] {
        self.queue.held()
    }

    pub fn mod_held(&self) -> bool {
        self.mod_held
    }

    pub fn quit_armed(&self) -> bool {
        self.quit_armed
    }

    pub fn quit_actions(&self) -> &[String] {
        &self.quit_actions
    }

    pub fn quit_count(&self) -> u32 {
        self.quit_count
    }

    /// Block ids the host has opened. A missing id stays collapsed, which is the wire value.
    pub fn toggled_collapsed(&self) -> Vec<String> {
        self.collapsed
            .iter()
            .filter(|(_, collapsed)| !**collapsed)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn entered(&self) -> bool {
        self.entered
    }

    /// Layout root. A node with [`crate::layout_engine::LivePaint`] arms the
    /// live interval on the next caused paint. Does not open the input gate
    /// and does not keep a later mailbox tree off the screen.
    pub fn set_scene(&mut self, node: Node) {
        if self.stopped {
            return;
        }
        self.note_drawer(&node);
        self.rewind_seat = crate::host_overlay::rewind_seat(&node);
        self.agents_plaque = None;
        self.scene = node;
        self.cause.scene = true;
    }

    /// The `prepare()` root. Opens the input gate once. A mailbox message
    /// after this updates the store and leaves this scene in place.
    /// A plaque from the previous scene is dropped. The caller sets the new one.
    pub fn set_retained_scene(&mut self, node: Node) {
        if self.stopped {
            return;
        }
        self.retained = true;
        self.note_drawer(&node);
        self.rewind_seat = crate::host_overlay::rewind_seat(&node);
        self.agents_plaque = None;
        self.scene = node;
        self.cause.scene = true;
        self.open_gate();
    }

    /// Focused-row plaque. `None` clears a stale one. The host chooses the row.
    pub fn set_agents_plaque(&mut self, plaque: Option<AgentsPlaque>) {
        if self.stopped {
            return;
        }
        self.agents_plaque = plaque;
        self.cause.scene = true;
    }

    /// Host preview is open. Drawer hover, scroll, and row activate stay unposted.
    /// A click outside the modal posts the preview backdrop.
    pub fn set_agents_preview(&mut self, open: bool) {
        if self.stopped {
            return;
        }
        self.agents_preview = open;
    }

    /// Sneak-peek modal for this frame. `None` clears a stale one.
    /// The caller passes the node [`crate::paint_replica::PaintReplica::preview_overlay`] built.
    pub fn set_preview_overlay(&mut self, overlay: Option<Node>) {
        if self.stopped {
            return;
        }
        self.preview_overlay = overlay;
        self.cause.scene = true;
    }

    /// Composer rim from the rewind snapshot. Off-tip hides the omnibox.
    pub fn set_seat_rim(&mut self, seat: bool) {
        if self.stopped {
            return;
        }
        if self.seat_rim == seat {
            return;
        }
        self.seat_rim = seat;
        self.cause.scene = true;
    }

    fn note_drawer(&mut self, node: &Node) {
        let open = drawers::scene_has_key(node, "agents:panel");
        if !open {
            self.agents_preview = false;
            self.preview_overlay = None;
            self.agents_hover = None;
            self.agents_press = None;
            if matches!(self.gesture_owner, GestureOwner::Agents) {
                self.gesture_owner = GestureOwner::None;
                self.mouse_down = false;
                self.mouse_dragged = false;
            }
        }
        self.drawer_open = open;
    }

    /// New canvas ground or depth. The next paint resolves role colors again.
    pub fn attune(&mut self, opts: AttuneOpts) {
        if self.stopped {
            return;
        }
        if let Some(rgb) = opts.ground_rgb {
            self.stage_ground(rgb);
        }
        if let Some(ground) = opts.ground {
            if (self.ground - ground).abs() > f64::EPSILON {
                self.ground = ground;
                self.theme = build_theme(&BuildThemeOpts {
                    ground: Some(ground),
                    ground_rgb: self.ground_rgb,
                    ..BuildThemeOpts::default()
                });
                self.cause.theme = true;
            }
        }
        if let Some(depth) = opts.depth {
            self.stage_depth(depth);
        }
    }

    /// Clipboard reader for Ctrl+V. `None` falls through to the last copy.
    pub fn set_clipboard_read(&mut self, read: fn() -> Option<String>) {
        self.clipboard_read = read;
    }

    /// Worker composer. Clears a standing echo. A mismatch snaps to this face.
    pub fn set_composer(&mut self, face: ComposerFace) {
        if self.stopped {
            return;
        }
        let incoming = crate::draft::DraftState::new(face.draft.clone(), face.cursor, face.mark);
        let echo = crate::echo::reconcile(&self.echo, &incoming);
        if echo == self.echo && face == self.composer {
            return;
        }
        self.echo = echo;
        self.composer = face;
        self.cause.chrome = true;
    }

    /// Local echo, when a key has rewritten the draft ahead of the worker.
    pub fn predicted_draft(&self) -> Option<&str> {
        self.echo
            .predicted
            .as_ref()
            .map(|state| state.draft.as_str())
    }

    /// Caret the chrome frame is painting. Echo wins over the worker face.
    pub fn shown_cursor(&self) -> usize {
        self.shown_draft().cursor
    }

    /// Compact is false. Ctrl-O flips it. The worker does not see that key.
    pub fn tape_expanded(&self) -> bool {
        self.tape_expanded
    }

    /// Show "Copied" until the caller clock reaches the hold. No timer here.
    pub fn note_copy(&mut self, end_col: i64, end_row: i64, anchor_row: i64, now_ms: u64) {
        if self.stopped {
            return;
        }
        self.copy_toast = Some(CopyToast {
            end_col,
            end_row,
            anchor_row,
            shown_at: now_ms,
        });
        self.cause.chrome = true;
    }

    /// Rows the next paint would show, including the chrome overlay.
    /// Does not emit and does not clear the wake.
    pub fn content_rows(&mut self) -> Vec<String> {
        let (buf, _) = self.render(0.0);
        let width = buf.width();
        let mut rows = Vec::with_capacity(buf.height());
        for y in 0..buf.height() {
            let mut row = String::new();
            for x in 0..width {
                let cell = &buf.cells()[y * width + x];
                if !cell.placeholder {
                    row.push_str(&cell.ch);
                }
            }
            while row.ends_with(' ') {
                row.pop();
            }
            rows.push(row);
        }
        rows
    }

    pub(crate) fn painted_buffer(&mut self, now_ms: u64) -> Buffer {
        self.render(now_ms as f64).0
    }

    /// Style the next paint would write at one cell.
    pub fn content_style(&mut self, x: usize, y: usize) -> Style {
        let (buf, _) = self.render(0.0);
        cell_style(&buf, x, y)
    }

    /// Hit tree for a later bare click. Geometry comes from [`layout_hits`].
    pub fn set_hits(&mut self, root: HitNode) {
        if self.stopped {
            return;
        }
        self.hits = Some(root);
        self.hit_frame = None;
    }

    /// Capability replies already read. `elapsed_ms` is the caller's clock since
    /// the query was written. Does not block and does not sleep.
    pub fn feed_probe(&mut self, chunk: &str, elapsed_ms: u64) {
        if self.stopped || !self.tty {
            return;
        }
        self.probe_elapsed = elapsed_ms;
        if self.probe_pending && !chunk.is_empty() {
            self.probe_received.push_str(chunk);
        }
        if self.probe_pending {
            self.recompute_probe();
        }
    }

    /// Decode `bytes` with [`consume_keys`]. Delivery waits until the gate opens.
    pub fn push_input(&mut self, bytes: &str, now_ms: u64) -> InputPush {
        if self.stopped {
            return InputPush {
                immediate: String::new(),
                decoded: Vec::new(),
            };
        }
        let decoded = consume_keys(bytes, &self.pending_keys, self.layout_table);
        self.pending_keys = decoded.pending;
        self.last_byte_at = now_ms;
        let immediate = self.accept_events(&decoded.events);
        InputPush {
            immediate,
            decoded: decoded.events,
        }
    }

    /// Latest size wins while the gate is closed. The boot announcement is the
    /// size at the first paint.
    pub fn push_resize(&mut self, cols: u16, rows: u16) {
        if self.stopped {
            return;
        }
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        self.previous = None;
        self.selection_snap = None;
        self.selection
            .set_viewport(i64::from(cols), i64::from(rows));
        self.selection.clear();
        self.cause.resize = true;
        if !self.announced {
            return;
        }
        if self.queue.ready() {
            self.up.push(Up::Resize { cols, rows });
        } else {
            self.pending_resize = Some((cols, rows));
        }
    }

    pub fn push_down(&mut self, batch: Vec<Down>) {
        if self.stopped {
            return;
        }
        let mut init = false;
        let mut structural = false;
        let mut mailbox_changed = false;
        for item in batch {
            match item {
                Down::PaintInit => init = true,
                Down::Structure { .. } => {
                    structural = true;
                    mailbox_changed = true;
                    self.selection.clear();
                    self.mailbox = apply_box_bus_message(std::mem::take(&mut self.mailbox), item);
                    self.cause.scene = true;
                }
                other => {
                    mailbox_changed = true;
                    self.mailbox = apply_box_bus_message(std::mem::take(&mut self.mailbox), other);
                    self.cause.scene = true;
                }
            }
        }
        if mailbox_changed && !self.retained {
            self.scene =
                crate::mailbox_scene::scene_from_mailbox(&self.mailbox, i64::from(self.cols))
                    .unwrap_or_else(idle_scene);
        }
        if init || structural {
            self.open_gate();
        }
    }

    /// Paint if a wake is pending. `now_ms` flushes a quiet Escape and, when
    /// live demand is armed, a due live frame. Idle returns empty bytes.
    pub fn paint_if_needed(&mut self, now_ms: u64) -> Paint {
        if self.stopped {
            return Paint {
                bytes: String::new(),
                caused: false,
                dirty_rows: 0,
            };
        }
        self.maybe_flush_esc(now_ms);
        self.note_live_due(now_ms);
        if self.expire_copy_toast(now_ms) {
            self.cause.chrome = true;
        }
        if self.take_selection_trailing(now_ms) {
            self.cause.scene = true;
        }
        let motion = self.motion_bytes(now_ms);
        let pointer = self.pointer_idle_bytes();
        if self.entered && !self.cause.any() && motion.is_empty() && pointer.is_empty() {
            return Paint {
                bytes: String::new(),
                caused: false,
                dirty_rows: 0,
            };
        }
        let was_live = self.cause.live;
        if was_live {
            self.live_tick = self.live_tick.wrapping_add(1);
        }
        let first = !self.entered;
        let (buf, demand) = self.render(now_ms as f64);
        // The frame just learned whether a ghost chip is on screen. The check
        // above ran on the previous frame.
        let motion_after = self.motion_bytes(now_ms);
        let stats = emit_ansi_detailed(
            self.previous.as_ref(),
            &buf,
            &EmitAnsiOpts {
                sync2026: self.sync_frames,
                force_full: self.previous.is_none(),
            },
        );
        self.previous = Some(buf);
        // Hide before the row erase. A visible cursor blinks, and the blink
        // restores the line from that `2K`, which drops a draft highlight.
        let mut bytes = if stats.dirty_rows > 0 {
            let mut hidden = String::from("\u{1b}[?25l");
            hidden.push_str(&stats.ansi);
            hidden
        } else {
            stats.ansi
        };
        if first {
            let mut entered = enter_bytes(&TtyOptions {
                sync2026: self.sync_frames,
                hide_cursor: true,
                no_wrap: true,
            });
            entered.push_str(&bytes);
            entered.push_str(THEME_REPORT_ENABLE);
            entered.push_str(OSC11_QUERY);
            bytes = entered;
            self.entered = true;
            self.announce_geometry();
        }
        let follow = if first {
            self.take_staged_theme()
        } else {
            false
        };
        self.cause = Cause::default();
        self.arm_live(now_ms, demand, was_live);
        if follow {
            self.cause.theme = true;
        }
        bytes.push_str(&motion);
        bytes.push_str(&motion_after);
        bytes.push_str(&pointer);
        bytes.push_str(&self.caret_ansi());
        Paint {
            bytes,
            caused: true,
            dirty_rows: stats.dirty_rows,
        }
    }

    /// Enter-alt hid the cursor. Focused paint parks it in the composer. Blur hides it.
    /// A draft range keeps it hidden: the blink otherwise restores the erased line.
    fn caret_ansi(&self) -> String {
        let shown = self.shown_draft();
        let ranged = shown.mark.is_some_and(|mark| mark != shown.cursor)
            || self.composer_gesture_range().is_some();
        if !self.seat_rim || !(self.term_focused && self.composer.interactive) || ranged {
            return "\u{1b}[?25l".to_string();
        }
        let cols = i64::from(self.cols);
        let rows = i64::from(self.rows);
        let overlay = self.chrome_overlay();
        let span = overlay_span(overlay.panel.as_ref(), &overlay.draft, cols, rows);
        // A solo frame starts under ╭. A catalog omits that rule, so the draft
        // body is the first row of the lower frame.
        let body = span.top + span.panel_h + if overlay.draft.omit_top { 0 } else { 1 };
        let caret = visual_caret_geometry(
            &shown.draft,
            scalar_index(&shown.draft, shown.cursor),
            chrome_frame_text_width(cols),
        );
        let row = (body + i64::try_from(caret.line).unwrap_or(0)).clamp(0, rows.saturating_sub(1));
        let col =
            (chrome_frame_text_inset() + caret.col_in_content).clamp(0, cols.saturating_sub(1));
        format!("\u{1b}[{};{}H\u{1b}[?25h", row + 1, col + 1)
    }

    /// Stop the live interval and drop the theme-report subscription.
    /// Does not write [`exit_bytes`].
    pub fn stop(&mut self) -> String {
        if self.stopped {
            return String::new();
        }
        self.stopped = true;
        self.live_hz = 0;
        self.live_due = None;
        self.cause = Cause::default();
        THEME_REPORT_DISABLE.to_string()
    }

    fn render(&mut self, now_ms: f64) -> (Buffer, i64) {
        crate::expand::install_realize();
        let cols = i64::from(self.cols);
        let rows = i64::from(self.rows);
        drawers::strip_agents_peek(&mut self.scene);
        self.prepare_host_scene(cols, rows);
        if let Some(plaque) = self.agents_plaque.clone() {
            let _ = drawers::attach_agents_peek(
                &mut self.scene,
                &plaque.node,
                &plaque.focus,
                cols,
                rows,
            );
        }
        // The modal is seated on a clone. Keeping the wrap would stack another one next paint.
        let preview = self.preview_overlay.clone();
        let wrapped;
        let root = if let Some(preview) = preview {
            wrapped = drawers::with_agents_preview(self.scene.clone(), preview);
            &wrapped
        } else {
            &self.scene
        };
        let mut frame = layout(root, Viewport { w: cols, h: rows }, LayoutOpts::default());
        self.sync_ghost_frame(&mut frame);
        let demand = frame.live_demand.max_hz;
        let mut buf = create_buffer(self.cols as usize, self.rows as usize);
        paint_frame(&frame, &mut buf, now_ms, |style| self.resolved_style(style));
        if self.quit_armed {
            if let Some(action) = self.quit_action.clone() {
                self.quit_actions.push(action);
            }
        }
        let chrome_hz = self.paint_chrome(&mut buf, now_ms);
        // A drag highlight writes the draft cells, including the ones under the panel.
        if self.seat_rim && !self.drawer_open && !self.agents_preview {
            self.highlight_composer_drag(&mut buf);
        }
        let hit_root = crate::host_overlay::hits_of(&self.scene);
        let hits = hits_from_placed(
            &hit_root,
            frame.placed.iter().map(|hit| (hit.key.clone(), hit.rect)),
            Rect {
                x: 0,
                y: 0,
                w: cols,
                h: rows,
            },
        );
        // The draft is not a scene hit. An unlit recolor drops the gesture,
        // and the next move starts at the pointer.
        if self.composer_gesture_range().is_none() {
            self.selection.invalidate(&buf, Some(&hits));
            self.selection.recolor(&mut buf, Some(&hits), self.ground);
        }
        if self.copy_toast.is_some() {
            self.selection_snap = Some(clone_buffer(&buf));
        } else {
            self.selection_snap = None;
        }
        // Chrome is painted after the scene, so it covers the modal. Paint the modal again.
        if let Some(start) = frame
            .paint_order
            .iter()
            .position(|pos| pos.key.starts_with("agents:preview"))
        {
            paint_positioned(&frame.paint_order[start..], &mut buf, now_ms, |style| {
                self.resolved_style(style)
            });
        }
        self.paint_copy_toast(&mut buf);
        self.hit_frame = Some(hits);
        self.hits = Some(hit_root);
        (buf, demand.max(chrome_hz))
    }

    fn note_selection_paint(&mut self, now_ms: u64) -> bool {
        let due = match self.selection_paint_at {
            None => true,
            Some(at) => selection_due(at, now_ms),
        };
        if due {
            self.selection_paint_at = Some(now_ms);
            self.selection_paint_pending = false;
            true
        } else {
            self.selection_paint_pending = true;
            false
        }
    }

    fn take_selection_trailing(&mut self, now_ms: u64) -> bool {
        if !self.selection_paint_pending {
            return false;
        }
        let Some(at) = self.selection_paint_at else {
            return false;
        };
        if !selection_due(at, now_ms) {
            return false;
        }
        self.selection_paint_at = Some(now_ms);
        self.selection_paint_pending = false;
        true
    }

    fn expire_copy_toast(&mut self, now_ms: u64) -> bool {
        let Some(toast) = &self.copy_toast else {
            return false;
        };
        if !matches!(
            copy_toast_phase(toast.shown_at, now_ms),
            CopyToastPhase::Clear
        ) {
            return false;
        }
        self.copy_toast = None;
        true
    }

    fn paint_copy_toast(&self, buf: &mut Buffer) {
        let Some(toast) = &self.copy_toast else {
            return;
        };
        let place = place_copy_toast(
            toast.end_col,
            toast.end_row,
            toast.anchor_row,
            i64::from(self.cols),
            i64::from(self.rows),
            COPY_TOAST_TEXT,
        );
        paint_copy_toast(
            buf,
            place,
            |style| self.resolved_style(style),
            COPY_TOAST_TEXT,
        );
    }

    fn prepare_host_scene(&mut self, cols: i64, rows: i64) {
        crate::host_overlay::apply_collapsed(&mut self.scene, &self.collapsed);
        if let Some(seat) = self.rewind_seat.clone() {
            crate::host_overlay::install_rewind_seat(&mut self.scene, seat);
        }
        let overlay = self.chrome_overlay();
        let span = overlay_span(overlay.panel.as_ref(), &overlay.draft, cols, rows);
        let chrome_h = if self.seat_rim {
            span.panel_h + span.draft_h
        } else {
            0
        };
        let recap = crate::host_overlay::recap_seat(&self.scene);
        if recap.is_none() && self.parked_recap.is_some() {
            self.tape_at_bottom = true;
            self.parked_recap = None;
        }
        // Dropping a pin grows the window, which can uncover the next prompt.
        for _ in 0..8 {
            let Some(window) = crate::host_overlay::fit_tape(&mut self.scene, rows, chrome_h)
            else {
                return;
            };
            self.tape_window = window;
            self.tape_max = crate::host_overlay::tape_max_scroll(&self.scene, window);
            if let Some(seat) = recap.as_ref() {
                self.aim_recap(seat);
            }
            let shown = if self.tape_at_bottom {
                self.tape_max
            } else {
                self.tape_scroll.min(self.tape_max.max(0))
            };
            if !crate::host_overlay::drop_visible_rewind_pins(&mut self.scene, shown, window) {
                break;
            }
        }
        let Some(window) = crate::host_overlay::fit_tape(&mut self.scene, rows, chrome_h) else {
            return;
        };
        self.tape_window = window;
        self.tape_max = crate::host_overlay::tape_max_scroll(&self.scene, window);
        if let Some(seat) = recap.as_ref() {
            self.aim_recap(seat);
        }
        if self.tape_at_bottom {
            self.tape_scroll = self.tape_max;
        } else if self.tape_scroll > self.tape_max {
            self.tape_scroll = self.tape_max;
            self.tape_at_bottom = true;
        }
        if let Some(seat) = recap.as_ref() {
            if self.parked_recap.as_deref() != Some(seat.key.as_str()) {
                self.parked_recap = Some(seat.key.clone());
            }
        }
        let scroll = if self.tape_at_bottom {
            i64::MAX
        } else {
            self.tape_scroll
        };
        crate::host_overlay::stamp_scroll(&mut self.scene, scroll);
    }

    /// Aim a recap the wheel has not already been left on.
    fn aim_recap(&mut self, seat: &crate::host_overlay::RecapSeat) {
        if self.parked_recap.as_deref() == Some(seat.key.as_str()) {
            return;
        }
        self.tape_at_bottom = false;
        let parked = crate::host_overlay::scroll_to_show_block(seat.y, seat.h, self.tape_window);
        self.tape_scroll = parked.min(self.tape_max.max(0));
    }

    fn scroll_tape(&mut self, delta: i64) {
        let from = if self.tape_at_bottom {
            self.tape_max
        } else {
            self.tape_scroll
        };
        let next = (from + delta).clamp(0, self.tape_max.max(0));
        let at_bottom = self.tape_max <= 0 || next >= self.tape_max;
        if next == self.tape_scroll && at_bottom == self.tape_at_bottom {
            return;
        }
        self.tape_scroll = next;
        self.tape_at_bottom = at_bottom;
        self.cause.scene = true;
    }

    fn paint_chrome(&self, buf: &mut Buffer, now_ms: f64) -> i64 {
        if !self.seat_rim {
            return 0;
        }
        let overlay = self.chrome_overlay();
        let cols = i64::from(self.cols);
        let rows = i64::from(self.rows);
        let span = overlay_span(overlay.panel.as_ref(), &overlay.draft, cols, rows);
        let mut hz = 0i64;
        if let Some(panel) = &overlay.panel {
            if span.panel_h > 0 {
                hz = self.paint_one_chrome(
                    buf,
                    panel,
                    ChromeRect::new(0, span.top, cols, span.panel_h),
                    now_ms,
                );
            }
        }
        hz.max(self.paint_one_chrome(
            buf,
            &overlay.draft,
            ChromeRect::new(0, span.top + span.panel_h, cols, span.draft_h.max(1)),
            now_ms,
        ))
    }

    fn paint_one_chrome(
        &self,
        buf: &mut Buffer,
        frame: &ChromeFrame,
        place: ChromeRect,
        now_ms: f64,
    ) -> i64 {
        let paint = chrome_frame_paint_ops(frame, place);
        let clip_x = self.drawer_open.then(|| (i64::from(self.cols) / 2).max(16));
        let mut hz = 0i64;
        for op in &paint.ops {
            match op {
                ChromePaintOp::Text { rect, lines, style } => {
                    let paint_style = self.resolved_style(&self.dimmed_chrome(style));
                    for (i, line) in lines.iter().enumerate() {
                        let Some(dy) = i64::try_from(i).ok() else {
                            break;
                        };
                        put_chrome_text(buf, rect.x, rect.y + dy, line, &paint_style, clip_x);
                    }
                }
                ChromePaintOp::Live { rect, style, live } => {
                    let ChromeLive::Quota {
                        windows,
                        prefix,
                        hz: live_hz,
                    } = live;
                    hz = hz.max(*live_hz);
                    let text = resolve_live_text(
                        LiveFace::Quota {
                            windows,
                            prefix: prefix.as_deref(),
                        },
                        now_ms,
                    );
                    let (head, _) = split_at_width(&text, rect.w.max(1));
                    put_chrome_text(
                        buf,
                        rect.x,
                        rect.y,
                        head,
                        &self.resolved_style(&self.dimmed_chrome(style)),
                        clip_x,
                    );
                }
            }
        }
        hz
    }

    /// Backdrop dim for chrome painted after the scene. The drawer and a
    /// sneak-peek each multiply once, including a sneak-peek with the drawer closed.
    fn dimmed_chrome(&self, style: &Style) -> Style {
        if !self.drawer_open && !self.agents_preview {
            return style.clone();
        }
        let mut factor = 1.0;
        if self.drawer_open {
            factor *= BACKDROP_REGION_PROMINENCE;
        }
        if self.agents_preview {
            factor *= BACKDROP_REGION_PROMINENCE;
        }
        let mut next = style.clone();
        let prev = next.region_prominence.unwrap_or(1.0);
        next.region_prominence = Some(prev * factor);
        next
    }

    fn shown_draft(&self) -> crate::draft::DraftState {
        self.echo.predicted.clone().unwrap_or_else(|| {
            crate::draft::DraftState::new(
                self.composer.draft.clone(),
                self.composer.cursor,
                self.composer.mark,
            )
        })
    }

    fn chrome_model(&self) -> ChromeFrame {
        let shown = self.shown_draft();
        let face = &self.composer;
        let mut frame = ChromeFrame::new(i64::from(self.cols), shown.draft.clone());
        frame.cursor = i64::try_from(scalar_index(&shown.draft, shown.cursor)).ok();
        frame.mark = shown
            .mark
            .and_then(|mark| i64::try_from(scalar_index(&shown.draft, mark)).ok());
        frame.interactive = Some(face.interactive && self.term_focused);
        frame.mod_held = self.mod_held;
        frame.placeholder = trimmed_nonempty(&face.placeholder);
        frame.annotation = trimmed_nonempty(&face.annotation);
        frame.join_annotation = trimmed_nonempty(&face.join_annotation);
        frame.hotkeys = face.hotkeys.clone();
        if self.quit_armed {
            if let Some(action) = &self.quit_action {
                frame
                    .hotkeys
                    .push(ChromeHotkey::new("Ctrl+C", action.clone()));
            }
        }
        frame.status_items = face.status_items.clone();
        frame.quota_windows = face.quota_windows.clone();
        frame.context_used = face.context_used;
        frame.context_limit = face.context_limit;
        frame.contour_role = trimmed_nonempty(&face.contour_role);
        frame.progress = face.progress.filter(|progress| progress.is_finite());
        frame.progress_role = trimmed_nonempty(&face.progress_role);
        frame.progress_glow_at = face.progress_glow_at.filter(|glow| glow.is_finite());
        frame
    }

    /// Draft frame, plus the slash list or the ask stack when the face has one.
    ///
    /// The panel keeps the annotation on ╭╮ and joins the draft with ├┤.
    /// The draft omits its top rule so the two frames are one box. The list
    /// wins over a stacked body. Face hotkeys win; otherwise the selected
    /// row's chords ride the join.
    fn chrome_overlay(&self) -> ChromeOverlay {
        let mut draft = self.chrome_model();
        if let Some(picker) = &self.composer.picker {
            if !picker.rows.is_empty() {
                let selected = picker.rows.iter().find(|row| {
                    picker
                        .selected_key
                        .as_ref()
                        .is_some_and(|key| key == &row.key)
                });
                let selected = selected.or(picker.rows.first());
                let hotkeys = if self.composer.hotkeys.is_empty() {
                    let mut hotkeys = selected.map(|row| row.actions.clone()).unwrap_or_default();
                    hotkeys.extend(draft.hotkeys.iter().cloned());
                    hotkeys
                } else {
                    draft.hotkeys.clone()
                };
                let cols = i64::from(self.cols).max(8);
                let paint_rows: Vec<PickerRow> = picker.rows.iter().map(picker_row).collect();
                let paint = paint_picker(&PickerPaintInput {
                    rows: &paint_rows,
                    selected_key: selected.map(|row| row.key.as_str()),
                    scroll_offset: picker.scroll_offset,
                    hover_key: None,
                    press_key: None,
                    viewport: Some(COMPOSER_COMMAND_MAX_VISIBLE),
                    text_w: Some(chrome_frame_text_width(cols)),
                });
                let mut panel = ChromeFrame::new(cols, "");
                panel.body_seg_rows = paint.body_seg_rows;
                panel.body_glyphs = paint.body_glyphs;
                panel.body_right_coverage = paint.body_right_coverage;
                panel.join_bottom = true;
                panel.plain_bottom = true;
                panel.hotkeys = hotkeys;
                panel.annotation = trimmed_nonempty(&self.composer.annotation);
                panel.join_annotation = trimmed_nonempty(&self.composer.join_annotation);
                panel.contour_role = trimmed_nonempty(&self.composer.contour_role);
                panel.mod_held = self.mod_held;
                draft.omit_top = true;
                if !picker.fallback {
                    if let Some(name) = selected.map(|row| row.name.as_str()) {
                        let shown = self.shown_draft();
                        let at_end = shown.cursor == shown.draft.len();
                        let mark_clear = shown.mark.is_none_or(|mark| mark == shown.cursor);
                        if self.composer.interactive && at_end && mark_clear {
                            let remainder = autocomplete_remainder(&shown.draft, name);
                            if !remainder.is_empty() {
                                draft.completion = Some(remainder);
                            }
                        }
                    }
                }
                return ChromeOverlay {
                    panel: Some(panel),
                    draft,
                };
            }
        }
        if let Some(panel) = self.stacked_panel(&draft) {
            draft.omit_top = true;
            return ChromeOverlay {
                panel: Some(panel),
                draft,
            };
        }
        ChromeOverlay { panel: None, draft }
    }

    /// Ask or queue text. The annotation stays on ╭╮ and the chords ride ├┤.
    fn stacked_panel(&self, draft: &ChromeFrame) -> Option<ChromeFrame> {
        let body = self.composer.stacked_body.trim_end();
        if body.is_empty() {
            return None;
        }
        let cols = i64::from(self.cols).max(8);
        let paint = paint_stacked_body(&StackedBodyInput {
            text: body,
            lang: self.composer.stacked_lang.trim(),
            numbered: self.composer.stacked_numbered,
            scroll_offset: self.composer.scroll_offset,
            viewport: self.composer.stacked_viewport,
            text_w: chrome_frame_text_width(cols),
        });
        let mut panel = ChromeFrame::new(cols, "");
        panel.body_seg_rows = paint.body_seg_rows;
        panel.body_glyphs = paint.body_glyphs;
        panel.body_right_coverage = paint.body_right_coverage;
        panel.join_bottom = true;
        panel.plain_bottom = true;
        panel.hotkeys = draft.hotkeys.clone();
        panel.annotation = trimmed_nonempty(&self.composer.annotation);
        panel.join_annotation = trimmed_nonempty(&self.composer.join_annotation);
        panel.contour_role = trimmed_nonempty(&self.composer.contour_role);
        panel.mod_held = self.mod_held;
        Some(panel)
    }

    fn resolved_style(&self, style: &Style) -> Style {
        paint_style(style, &self.theme, self.depth)
    }

    fn recompute_probe(&mut self) {
        if !self.tty {
            self.probe_pending = false;
            return;
        }
        let env = capability_env(&self.env);
        let outcome = settle_probe(SettleInput {
            tty: true,
            batch: true,
            env: &env,
            received: &self.probe_received,
            timeout_ms: self.probe_timeout_ms,
            elapsed_ms: self.probe_elapsed,
            write_failed: false,
        });
        match outcome {
            ProbeOutcome::Pending => self.probe_pending = true,
            ProbeOutcome::Ready(result) => {
                self.probe_pending = false;
                self.absorb_caps(result.caps);
            }
        }
    }

    fn absorb_caps(&mut self, caps: TerminalCaps) {
        if let Some(rgb) = caps.ground_rgb {
            self.stage_ground(ThemeRgb {
                r: rgb.r,
                g: rgb.g,
                b: rgb.b,
            });
        }
        let resolved = resolve_present_config(&ResolvePresentOpts {
            env: &self.env,
            probed_depth: Some(caps.color_depth),
            probed_sync_2026: caps.sync_2026,
        });
        self.stage_depth(resolved.color_depth);
        self.config.color_depth = resolved.color_depth;
        self.config.color_source = resolved.color_source;
        self.config.label = resolved.label;
    }

    fn stage_ground(&mut self, rgb: ThemeRgb) {
        let lightness = ground_from_rgb(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b));
        if self.ground_rgb == Some(rgb) && (self.ground - lightness).abs() <= f64::EPSILON {
            return;
        }
        if !self.entered {
            self.pending_ground = Some(rgb);
            return;
        }
        self.apply_ground(rgb, lightness);
    }

    fn stage_depth(&mut self, depth: ColorDepth) {
        if depth == self.depth {
            return;
        }
        if !self.entered {
            self.pending_depth = Some(depth);
            return;
        }
        self.depth = depth;
        self.cause.theme = true;
    }

    fn apply_ground(&mut self, rgb: ThemeRgb, lightness: f64) {
        self.ground_rgb = Some(rgb);
        self.ground = lightness;
        self.theme = build_theme(&BuildThemeOpts {
            ground: Some(lightness),
            ground_rgb: Some(rgb),
            ..BuildThemeOpts::default()
        });
        self.cause.theme = true;
    }

    fn take_staged_theme(&mut self) -> bool {
        let mut follow = false;
        if let Some(rgb) = self.pending_ground.take() {
            let lightness = ground_from_rgb(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b));
            self.apply_ground(rgb, lightness);
            follow = true;
        }
        if let Some(depth) = self.pending_depth.take() {
            if depth != self.depth {
                self.depth = depth;
                follow = true;
            }
        }
        follow
    }

    fn announce_geometry(&mut self) {
        if self.announced {
            return;
        }
        self.announced = true;
        self.up.push(Up::Resize {
            cols: self.cols,
            rows: self.rows,
        });
    }

    fn open_gate(&mut self) {
        if self.queue.ready() {
            return;
        }
        self.queue = mark_ready(std::mem::take(&mut self.queue));
        self.ready_fires = self.ready_fires.saturating_add(1);
        if let Some((cols, rows)) = self.pending_resize.take() {
            self.up.push(Up::Resize { cols, rows });
        }
        self.drain();
    }

    fn drain(&mut self) {
        let delivery = deliver(std::mem::take(&mut self.queue));
        self.queue = delivery.queue;
        if !delivery.events.is_empty() {
            self.predict_keys(&delivery.events);
            self.up.push(Up::InputEvents {
                events: delivery.events,
            });
        }
    }

    fn predict_keys(&mut self, keys: &[DecodedKey]) {
        if !self.composer.interactive {
            return;
        }
        let mut current = self.shown_draft();
        let mut echo = self.echo.clone();
        for key in keys {
            echo = crate::echo::predict(
                &echo,
                &current,
                crate::echo::EchoKey {
                    key: &key.key,
                    ctrl: key.ctrl,
                    alt: key.alt,
                    shift: key.shift,
                    meta: key.meta,
                },
                i64::from(self.cols),
            );
            if let Some(next) = &echo.predicted {
                current = next.clone();
            }
        }
        if echo != self.echo {
            self.echo = echo;
            self.cause.chrome = true;
        }
    }

    fn note_live_due(&mut self, now_ms: u64) {
        let Some(due) = self.live_due else {
            return;
        };
        if self.live_hz > 0 && now_ms >= due {
            self.cause.live = true;
        }
    }

    fn arm_live(&mut self, now_ms: u64, demand_hz: i64, was_live: bool) {
        let cap = self.config.target_fps.max(1);
        let demand = u32::try_from(demand_hz.max(0)).unwrap_or(u32::MAX);
        let hz = demand.min(cap);
        if hz == 0 {
            self.live_hz = 0;
            self.live_due = None;
            return;
        }
        let reschedule = was_live || self.live_hz != hz || self.live_due.is_none();
        self.live_hz = hz;
        if reschedule {
            self.live_due = Some(now_ms.saturating_add(interval_ms(hz)));
        }
    }

    fn maybe_flush_esc(&mut self, now_ms: u64) {
        if self.pending_keys != "\u{1b}" {
            return;
        }
        if now_ms.saturating_sub(self.last_byte_at) < ESC_QUIET_MS {
            return;
        }
        let flushed = flush_pending_esc(&self.pending_keys);
        self.pending_keys = flushed.pending;
        let _ = self.accept_events(&flushed.events);
    }

    fn accept_events(&mut self, events: &[InputEvent]) -> String {
        let mut immediate = String::new();
        let mut rest: Vec<&InputEvent> = Vec::new();
        let mut pasted: Vec<DecodedKey> = Vec::new();
        let mut quit_now = false;
        for event in events {
            match event {
                InputEvent::ThemeChanged => {
                    immediate.push_str(OSC11_QUERY);
                    continue;
                }
                InputEvent::OscGround { rgb } => {
                    self.stage_ground(ThemeRgb {
                        r: rgb.r,
                        g: rgb.g,
                        b: rgb.b,
                    });
                    continue;
                }
                InputEvent::Mod { down, .. } => {
                    self.set_mod_held(*down);
                    continue;
                }
                InputEvent::CtrlC => {
                    self.notice_toast(ToastNotice::Input);
                    if self.quit_armed {
                        quit_now = true;
                    } else {
                        self.quit_armed = true;
                        self.cause.chrome = true;
                    }
                    continue;
                }
                _ => {}
            }
            if self.quit_armed {
                self.quit_armed = false;
                self.cause.chrome = true;
            }
            match event {
                InputEvent::FocusIn => {
                    immediate.push_str(OSC11_QUERY);
                    self.term_focused = true;
                    self.cause.chrome = true;
                }
                InputEvent::FocusOut => {
                    self.term_focused = false;
                    self.set_mod_held(false);
                    self.clear_ghost_hover();
                    self.cause.chrome = true;
                }
                InputEvent::Mouse {
                    button,
                    col,
                    row,
                    release,
                } => immediate.push_str(&self.on_mouse(*button, *col, *row, *release)),
                InputEvent::PageUp | InputEvent::PageDown => {
                    self.notice_toast(ToastNotice::Scroll);
                    let page = (self.tape_window - 1).max(1);
                    let delta = if matches!(event, InputEvent::PageUp) {
                        -page
                    } else {
                        page
                    };
                    self.scroll_tape(delta);
                }
                // Ctrl+O is tape density on this present. Ctrl+V is the OS clipboard.
                // Neither key is posted. A second owner would see the chord twice.
                InputEvent::CtrlO => {
                    self.notice_toast(ToastNotice::Input);
                    self.tape_expanded = !self.tape_expanded;
                    self.cause.scene = true;
                }
                InputEvent::CtrlV => {
                    self.notice_toast(ToastNotice::Input);
                    let raw = (self.clipboard_read)()
                        .filter(|text| !text.is_empty())
                        .unwrap_or_else(|| self.selection.copied_text());
                    let text = normalize_paste(&raw);
                    if !text.is_empty() {
                        pasted.push(DecodedKey::bare(format!(
                            "{KEY_PASTE_PREFIX}{}",
                            json_string(&text)
                        )));
                    }
                }
                InputEvent::Esc { .. } => {
                    self.notice_toast(ToastNotice::Input);
                    if !self.swallow_esc() {
                        rest.push(event);
                    }
                }
                other => {
                    self.notice_toast(ToastNotice::Input);
                    rest.push(other);
                }
            }
        }
        let mut keys = Vec::new();
        for event in rest {
            keys.extend(to_key_events(event));
        }
        keys.extend(pasted);
        self.retarget_draft_pastes(&mut keys);
        keys = self.with_range_caret(keys);
        self.note_key_mods(&keys);
        if !keys.is_empty() {
            self.queue = offer(std::mem::take(&mut self.queue), keys);
            self.drain();
            self.cause.input = true;
        }
        if quit_now {
            self.quit_count = self.quit_count.saturating_add(1);
        }
        immediate
    }

    fn set_mod_held(&mut self, next: bool) {
        if self.mod_held == next {
            return;
        }
        self.mod_held = next;
        self.cause.chrome = true;
    }

    fn note_key_mods(&mut self, keys: &[DecodedKey]) {
        if keys.iter().any(|key| key.ctrl || key.meta) {
            self.set_mod_held(true);
        }
    }

    fn on_mouse(&mut self, button: i64, col: i64, row: i64, release: bool) -> String {
        self.selection
            .set_viewport(i64::from(self.cols), i64::from(self.rows));
        let t_ms = i64::try_from(self.last_byte_at).unwrap_or(i64::MAX);
        match mouse_to_gesture(button, col, row, release, t_ms) {
            MouseGesture::Ignore => String::new(),
            MouseGesture::Wheel { delta } => {
                self.notice_toast(ToastNotice::Scroll);
                if self.agents_preview {
                    return String::new();
                }
                if self.drawer_open {
                    self.up.push(Up::AgentsScroll { delta });
                    return String::new();
                }
                match self.catalog_nudge(col - 1, row - 1, delta) {
                    CatalogWheel::Miss => self.scroll_tape(delta),
                    CatalogWheel::Hold => {}
                    CatalogWheel::Nudge(delta) => self.up.push(Up::PickerScroll { delta }),
                }
                String::new()
            }
            MouseGesture::Move => {
                self.notice_toast(ToastNotice::Move);
                if self.drawer_open && !self.agents_preview {
                    self.track_agents_hover(col - 1, row - 1);
                    return self.sync_pointer(col - 1, row - 1);
                }
                self.track_ghost_hover(col - 1, row - 1);
                String::new()
            }
            MouseGesture::Event(ev) => self.on_gesture(ev, col, row),
        }
    }

    fn on_gesture(
        &mut self,
        ev: crate::layout_hit::GestureEvent,
        term_col: i64,
        term_row: i64,
    ) -> String {
        if ev.kind == crate::layout_hit::GestureKind::Press {
            self.notice_toast(ToastNotice::Press);
            // One button, one anchor. A second press while it is down must not move it.
            if self.mouse_down {
                return String::new();
            }
            if self.agents_preview || self.drawer_open {
                return self.begin_agents_press(ev.col, ev.row);
            }
            if !matches!(self.catalog_nudge(ev.col, ev.row, 0), CatalogWheel::Miss) {
                self.gesture_owner = GestureOwner::Picker;
                self.mouse_down = true;
                self.mouse_dragged = false;
                self.cause.chrome = true;
                return String::new();
            }
            self.gesture_owner = GestureOwner::Selection;
            self.mouse_down = true;
            self.mouse_dragged = false;
            if !ev.shift {
                self.clear_draft_mark();
            }
        }
        if matches!(self.gesture_owner, GestureOwner::Agents) {
            if ev.kind == crate::layout_hit::GestureKind::Drag {
                self.mouse_dragged = true;
                if !self.agents_preview {
                    self.track_agents_hover(ev.col, ev.row);
                }
                return self.sync_pointer(ev.col, ev.row);
            }
            if ev.kind == crate::layout_hit::GestureKind::Release {
                return self.end_agents_press(ev.col, ev.row);
            }
        }
        if matches!(self.gesture_owner, GestureOwner::Picker) {
            if ev.kind == crate::layout_hit::GestureKind::Drag {
                self.mouse_dragged = true;
                return String::new();
            }
            if ev.kind == crate::layout_hit::GestureKind::Release {
                self.gesture_owner = GestureOwner::None;
                self.mouse_down = false;
                self.mouse_dragged = false;
                self.cause.chrome = true;
                return String::new();
            }
        }
        if ev.kind == crate::layout_hit::GestureKind::Drag {
            // No press in this gesture. `last_press` is the click that parked
            // the caret, and a move would otherwise start the range there.
            if !self.mouse_down {
                if self.agents_preview || self.drawer_open {
                    let bytes = self.begin_agents_press(ev.col, ev.row);
                    self.mouse_dragged = true;
                    return bytes;
                }
                self.selection.clear();
                self.gesture_owner = GestureOwner::Selection;
                self.mouse_down = true;
            }
            self.mouse_dragged = true;
        }
        let kind = ev.kind;
        let shift = ev.shift;
        let (out, osc, end) = self.drive_selection(ev);
        if kind == crate::layout_hit::GestureKind::Release {
            self.gesture_owner = GestureOwner::None;
            self.selection_paint_pending = false;
            let dragged = self.mouse_dragged;
            self.mouse_down = false;
            self.mouse_dragged = false;
            self.cause.chrome = true;
            if let Some(copied) = self.commit_composer_drag() {
                return copied;
            }
            if !osc.is_empty() {
                if let Some(end) = end {
                    let anchor_row = out
                        .selection
                        .as_ref()
                        .map(|sel| sel.anchor.row)
                        .unwrap_or(end.row);
                    self.note_copy(end.col, end.row, anchor_row, self.last_byte_at);
                }
            }
            let bare =
                out.copy_ready != Some(true) && self.selection.selection().is_none() && !dragged;
            if bare {
                self.on_click(term_col, term_row, shift);
            } else {
                self.cause.scene = true;
            }
            return osc;
        }
        if kind == crate::layout_hit::GestureKind::Drag {
            if self.note_selection_paint(self.last_byte_at) {
                self.cause.scene = true;
            }
        } else {
            self.selection_paint_pending = false;
            self.cause.scene = true;
        }
        osc
    }

    fn drive_selection(
        &mut self,
        ev: crate::layout_hit::GestureEvent,
    ) -> (crate::layout_hit::GestureOutput, String, Option<SelCell>) {
        let release = ev.kind == crate::layout_hit::GestureKind::Release;
        let (buf, restore_prev) = if self.selection_snap.is_some() {
            (self.selection_snap.take(), false)
        } else {
            (self.previous.take(), true)
        };
        let hits = self.hit_frame.take();
        let out = self.selection.handle(ev, buf.as_ref(), hits.as_ref());
        let osc = if release {
            self.selection.copy_osc(&out, buf.as_ref(), hits.as_ref())
        } else {
            String::new()
        };
        let end = if release && !osc.is_empty() {
            self.selection.range_end(buf.as_ref(), hits.as_ref())
        } else {
            None
        };
        if restore_prev {
            self.previous = buf;
        } else {
            self.selection_snap = buf;
        }
        self.hit_frame = hits;
        (out, osc, end)
    }

    fn notice_toast(&mut self, notice: ToastNotice) {
        let Some(toast) = &self.copy_toast else {
            return;
        };
        if !copy_toast_dismissed(toast.shown_at, self.last_byte_at, notice) {
            return;
        }
        self.copy_toast = None;
        self.cause.chrome = true;
    }

    /// Arm turns on any-motion so a move can dismiss a toast, hover a drawer row,
    /// or reveal a ghost deletion. Enter never sends this.
    ///
    /// A ghost chip in the frame is enough to arm: without cell motion the
    /// pointer never arrives on that chip. `1003l` drops mouse reporting, so
    /// off puts press-and-drag (`1000` / `1002` / `1006`) back.
    fn motion_bytes(&mut self, now_ms: u64) -> String {
        let toast = self.copy_toast.as_ref().is_some_and(|toast| {
            matches!(
                copy_toast_phase(toast.shown_at, now_ms),
                CopyToastPhase::Shown { armed: true }
            )
        });
        let want = toast || self.drawer_open || !self.ghost_rects.is_empty();
        if want == self.motion_on {
            return String::new();
        }
        self.motion_on = want;
        mouse_any_motion_bytes(want)
    }

    fn sync_ghost_frame(&mut self, frame: &mut Frame) {
        self.ghost_rects = ghost_diff_rects(frame);
        lift_ghost_hover(frame, self.ghost_pointer);
        self.ghost_hot = self
            .ghost_pointer
            .and_then(|(x, y)| rect_at(&self.ghost_rects, x, y));
    }

    fn track_ghost_hover(&mut self, x: i64, y: i64) {
        let cell = (x, y);
        if self.ghost_pointer == Some(cell) {
            return;
        }
        self.ghost_pointer = Some(cell);
        if self.ghost_rects.is_empty() {
            return;
        }
        let hot = rect_at(&self.ghost_rects, x, y);
        if hot == self.ghost_hot {
            return;
        }
        self.ghost_hot = hot;
        self.cause.scene = true;
    }

    fn clear_ghost_hover(&mut self) {
        self.ghost_pointer = None;
        if self.ghost_hot.take().is_some() {
            self.cause.scene = true;
        }
    }

    /// The mouse may not move when the drawer closes. The hand would otherwise stick.
    fn pointer_idle_bytes(&mut self) -> String {
        if self.drawer_open || self.pointer_shape == MousePointer::Default {
            return String::new();
        }
        self.pointer_shape = MousePointer::Default;
        mouse_pointer_bytes(MousePointer::Default).to_string()
    }

    fn clear_draft_mark(&mut self) {
        if !self.composer.interactive {
            return;
        }
        let current = self.shown_draft();
        if current.mark.is_none() {
            return;
        }
        let next = crate::draft::apply_draft_op(
            &current,
            &crate::draft::DraftOp::SetCaret {
                cursor: current.cursor,
                mark: None,
            },
        );
        self.post_draft(next);
    }

    /// A drag that stays inside the draft. Byte offsets, mark then cursor.
    fn composer_gesture_range(&self) -> Option<(usize, usize)> {
        if !self.composer.interactive {
            return None;
        }
        let sel = self.selection.selection()?;
        let body = self.composer_body()?;
        let inside = |cell: SelCell| cell_in(body, cell.col, cell.row);
        if !inside(sel.anchor) || !inside(sel.active) {
            return None;
        }
        let draft = self.shown_draft();
        let text_w = body.w.max(1);
        let before = |cell: SelCell| {
            composer_offset_at_cell(&draft.draft, cell.col, cell.row, body.x, body.y, text_w)
        };
        let after = |cell: SelCell| {
            composer_offset_after_cell(&draft.draft, cell.col, cell.row, body.x, body.y, text_w)
        };
        let anchor_first = sel.anchor.row < sel.active.row
            || (sel.anchor.row == sel.active.row && sel.anchor.col <= sel.active.col);
        let mark = if anchor_first {
            before(sel.anchor)
        } else {
            after(sel.anchor)
        };
        let cursor = if anchor_first {
            after(sel.active)
        } else {
            before(sel.active)
        };
        (mark != cursor).then_some((cursor, mark))
    }

    /// The gesture is not a hit, so the draft highlight is painted onto the chrome cells.
    fn highlight_composer_drag(&self, buf: &mut Buffer) {
        let Some((cursor, mark)) = self.composer_gesture_range() else {
            return;
        };
        let Some(body) = self.composer_body() else {
            return;
        };
        let draft = self.shown_draft();
        let text_w = body.w.max(1);
        let start = cursor.min(mark);
        let stop = cursor.max(mark);
        let width = buf.width();
        let height = buf.height();
        let cells = buf.cells_mut();
        let mut y = body.y;
        while y < body.y.saturating_add(body.h) {
            let mut x = body.x;
            while x < body.x.saturating_add(body.w) {
                let at = composer_offset_at_cell(&draft.draft, x, y, body.x, body.y, text_w);
                let after = composer_offset_after_cell(&draft.draft, x, y, body.x, body.y, text_w);
                if after > at && at < stop && after > start {
                    if let (Ok(col), Ok(row)) = (usize::try_from(x), usize::try_from(y)) {
                        if row < height && col < width {
                            let cell = &mut cells[row * width + col];
                            if !cell.placeholder && !cell.ch.is_empty() {
                                crate::selection_host::recolor_resolved_cell(
                                    &mut cell.style,
                                    self.ground,
                                );
                            }
                        }
                    }
                }
                x += 1;
            }
            y += 1;
        }
    }

    /// Release inside the draft: post the caret, copy the range, drop the overlay.
    /// The clipboard from before the copy stays, so a paste of this slice can put it back.
    fn commit_composer_drag(&mut self) -> Option<String> {
        let (cursor, mark) = self.composer_gesture_range()?;
        let end = self
            .selection
            .selection()
            .map(|sel| (sel.active, sel.anchor.row));
        let draft = self.shown_draft();
        let text = draft_slice(&draft.draft, cursor, mark);
        self.draft_copy = None;
        if !text.is_empty() {
            if let Some(prior) = (self.clipboard_read)() {
                let prior = normalize_paste(&prior);
                if !prior.is_empty() && prior != text {
                    self.draft_copy = Some(DraftCopy {
                        prior,
                        slice: text.clone(),
                    });
                }
            }
        }
        self.selection.clear();
        let next = crate::draft::apply_draft_op(
            &draft,
            &crate::draft::DraftOp::SetCaret {
                cursor,
                mark: Some(mark),
            },
        );
        if !text.is_empty() {
            self.selection.remember_copy(&text);
        }
        self.post_draft(next);
        self.cause.scene = true;
        if text.is_empty() {
            return Some(String::new());
        }
        if let Some((end, anchor_row)) = end {
            self.note_copy(end.col, end.row, anchor_row, self.last_byte_at);
        }
        Some(osc52_set(&text, ClipboardSelect::Both))
    }

    /// A paste of the slice this drag just copied is the earlier clipboard.
    fn retarget_draft_pastes(&self, keys: &mut [DecodedKey]) {
        let Some(held) = &self.draft_copy else {
            return;
        };
        let Some(standing) = self.standing_draft_slice() else {
            return;
        };
        if standing != held.slice {
            return;
        }
        let prior = held.prior.clone();
        let slice = held.slice.clone();
        for key in keys {
            let Some(text) = crate::echo::parse_paste(&key.key) else {
                continue;
            };
            if text != slice {
                continue;
            }
            key.key = format!("{KEY_PASTE_PREFIX}{}", json_string(&prior));
        }
    }

    fn standing_draft_slice(&self) -> Option<String> {
        if !self.composer.interactive {
            return None;
        }
        let shown = self.shown_draft();
        let mark = shown.mark?;
        (mark != shown.cursor).then(|| draft_slice(&shown.draft, shown.cursor, mark))
    }

    /// The host applies this before insert, paste, backspace, delete, and kill.
    fn with_range_caret(&mut self, keys: Vec<DecodedKey>) -> Vec<DecodedKey> {
        if !self.composer.interactive || keys.is_empty() {
            return keys;
        }
        let edits = keys.iter().any(|key| {
            crate::echo::is_range_edit(crate::echo::EchoKey {
                key: &key.key,
                ctrl: key.ctrl,
                alt: key.alt,
                shift: key.shift,
                meta: key.meta,
            })
        });
        if !edits {
            return keys;
        }
        let caret = if let Some((cursor, mark)) = self.composer_gesture_range() {
            let shown = self.shown_draft();
            let next = crate::draft::apply_draft_op(
                &shown,
                &crate::draft::DraftOp::SetCaret {
                    cursor,
                    mark: Some(mark),
                },
            );
            self.selection.clear();
            let key = caret_key(&next);
            self.echo.predicted = Some(next);
            self.echo.misaligned = false;
            key
        } else {
            let shown = self.shown_draft();
            if shown.mark.is_none_or(|mark| mark == shown.cursor) {
                return keys;
            }
            caret_key(&shown)
        };
        let mut batch = Vec::with_capacity(keys.len() + 1);
        batch.push(caret);
        batch.extend(keys);
        batch
    }

    fn post_draft(&mut self, state: crate::draft::DraftState) {
        let key = caret_key(&state);
        self.echo.predicted = Some(state);
        self.echo.misaligned = false;
        self.cause.chrome = true;
        self.queue = offer(std::mem::take(&mut self.queue), vec![key]);
        self.drain();
        self.cause.input = true;
    }

    fn composer_body(&self) -> Option<ChromeRect> {
        if !self.composer.interactive {
            return None;
        }
        let overlay = self.chrome_overlay();
        let cols = i64::from(self.cols);
        let rows = i64::from(self.rows);
        let span = overlay_span(overlay.panel.as_ref(), &overlay.draft, cols, rows);
        let draft_at = ChromeRect::new(0, span.top + span.panel_h, cols, span.draft_h.max(1));
        let body = chrome_frame_paint_ops(&overlay.draft, draft_at).body_hit;
        if body.w <= 0 || body.h <= 0 {
            None
        } else {
            Some(body)
        }
    }

    /// Escape clears a transcript selection or a draft mark and is not delivered.
    fn swallow_esc(&mut self) -> bool {
        let overlay = self.selection.selection().is_some();
        let draft = self.composer.interactive && self.shown_draft().mark.is_some();
        if !overlay && !draft {
            return false;
        }
        if overlay {
            self.selection.clear();
            self.cause.scene = true;
        }
        if draft {
            self.clear_draft_mark();
        }
        true
    }

    /// Wheel over the slash list. `Miss` belongs to the tape.
    fn catalog_nudge(&self, x: i64, y: i64, delta: i64) -> CatalogWheel {
        let (n, scroll) = {
            let Some(picker) = &self.composer.picker else {
                return CatalogWheel::Miss;
            };
            if picker.rows.is_empty() {
                return CatalogWheel::Miss;
            }
            (
                i64::try_from(picker.rows.len()).unwrap_or(i64::MAX),
                picker.scroll_offset,
            )
        };
        let overlay = self.chrome_overlay();
        let Some(panel) = overlay.panel.as_ref() else {
            return CatalogWheel::Miss;
        };
        let cols = i64::from(self.cols);
        let rows = i64::from(self.rows);
        let span = overlay_span(Some(panel), &overlay.draft, cols, rows);
        if !cell_in(ChromeRect::new(0, span.top, cols, span.panel_h), x, y) {
            return CatalogWheel::Miss;
        }
        let max_s = (n - COMPOSER_COMMAND_MAX_VISIBLE).max(0);
        if max_s == 0 {
            return CatalogWheel::Hold;
        }
        let scroll = scroll.clamp(0, max_s);
        if (scroll + delta).clamp(0, max_s) == scroll {
            CatalogWheel::Hold
        } else {
            CatalogWheel::Nudge(delta)
        }
    }

    /// Composer overlay sits on top of the scene. A body cell moves the caret.
    /// A chrome cell (border, mark, progress) does not, and does not fall through.
    fn composer_click(&mut self, x: i64, y: i64, shift: bool) -> bool {
        let overlay = self.chrome_overlay();
        let cols = i64::from(self.cols);
        let rows = i64::from(self.rows);
        let span = overlay_span(overlay.panel.as_ref(), &overlay.draft, cols, rows);
        let place = ChromeRect::new(0, span.top, cols, (span.panel_h + span.draft_h).max(1));
        if !cell_in(place, x, y) {
            return false;
        }
        let draft_at = ChromeRect::new(0, span.top + span.panel_h, cols, span.draft_h.max(1));
        let paint = chrome_frame_paint_ops(&overlay.draft, draft_at);
        if self.composer.interactive && cell_in(paint.body_hit, x, y) {
            let current = self.shown_draft();
            let cursor = composer_offset_at_cell(
                &current.draft,
                x,
                y,
                paint.body_hit.x,
                paint.body_hit.y,
                paint.body_hit.w.max(1),
            );
            let mark = if shift {
                current.mark.or(Some(current.cursor))
            } else {
                None
            };
            let next = crate::draft::apply_draft_op(
                &current,
                &crate::draft::DraftOp::SetCaret { cursor, mark },
            );
            if next.cursor != current.cursor || next.mark != current.mark {
                self.post_draft(next);
            }
        }
        true
    }

    fn begin_agents_press(&mut self, x: i64, y: i64) -> String {
        self.gesture_owner = GestureOwner::Agents;
        self.mouse_down = true;
        self.mouse_dragged = false;
        if self.agents_preview {
            self.agents_press = None;
        } else {
            self.track_agents_hover(x, y);
            self.agents_press = self.agents_hoverable_at(x, y);
        }
        self.sync_pointer(x, y)
    }

    fn end_agents_press(&mut self, x: i64, y: i64) -> String {
        self.gesture_owner = GestureOwner::None;
        self.mouse_down = false;
        let dragged = self.mouse_dragged;
        self.mouse_dragged = false;
        let press = self.agents_press.take();
        if self.agents_preview {
            if !dragged && !self.preview_contains(x, y) {
                self.up.push(Up::Activate {
                    key: "agents:preview-overlay:backdrop".to_string(),
                });
            }
        } else {
            let at = self.agents_hoverable_at(x, y);
            if let Some(key) = press {
                if at.as_deref() == Some(key.as_str()) {
                    self.up.push(Up::Activate { key });
                }
            } else if !dragged && !self.agents_furniture(x, y) {
                self.up.push(Up::Activate {
                    key: "agents:overlay:backdrop".to_string(),
                });
            }
        }
        self.sync_pointer(x, y)
    }

    fn track_agents_hover(&mut self, x: i64, y: i64) {
        let next = self.agents_keep_key(x, y);
        if next == self.agents_hover {
            return;
        }
        self.agents_hover = next.clone();
        self.up.push(Up::AgentsHover { key: next });
    }

    /// Hoverable row, else the last key while the pointer is still on the panel or the plaque.
    fn agents_keep_key(&self, x: i64, y: i64) -> Option<String> {
        if let Some(key) = self.agents_hoverable_at(x, y) {
            return Some(key);
        }
        if self.agents_furniture(x, y) {
            return self.agents_hover.clone();
        }
        None
    }

    fn agents_hoverable_at(&self, x: i64, y: i64) -> Option<String> {
        let frame = self.hit_frame.as_ref()?;
        let path = element_at_path(frame, x, y)?;
        for hit in path.iter().rev() {
            let key = hit.key();
            if key.is_empty() {
                continue;
            }
            let Some(row) = drawers::agents_row_key(key) else {
                continue;
            };
            if row.starts_with("session:") || row.starts_with("call:") {
                return Some(row.to_string());
            }
        }
        None
    }

    fn preview_contains(&self, x: i64, y: i64) -> bool {
        let rect = self
            .hit_frame
            .as_ref()
            .and_then(|frame| frame.get("agents:preview"))
            .map(|hit| hit.rect())
            .unwrap_or_else(|| {
                let place =
                    drawers::agents_preview_rect(i64::from(self.cols), i64::from(self.rows));
                Rect {
                    x: place.x,
                    y: place.y,
                    w: place.w,
                    h: place.h,
                }
            });
        rect_contains(rect, x, y)
    }

    fn agents_furniture(&self, x: i64, y: i64) -> bool {
        let Some(frame) = self.hit_frame.as_ref() else {
            return false;
        };
        let panel = frame.get("agents:panel").map(|hit| hit.rect());
        let peek = frame.get("agents:peek").map(|hit| hit.rect());
        if panel.is_some_and(|rect| rect_contains(rect, x, y)) {
            return true;
        }
        let Some(peek) = peek else {
            return false;
        };
        if rect_contains(peek, x, y) {
            return true;
        }
        let Some(panel) = panel else {
            return false;
        };
        let left = panel.x + panel.w;
        let right = peek.x;
        let top = panel.y.min(peek.y);
        let bottom = (panel.y + panel.h).max(peek.y + peek.h);
        x >= left && x < right && y >= top && y < bottom
    }

    fn sync_pointer(&mut self, x: i64, y: i64) -> String {
        let want = if self.activate_at(x, y) {
            MousePointer::Pointer
        } else {
            MousePointer::Default
        };
        if want == self.pointer_shape {
            return String::new();
        }
        self.pointer_shape = want;
        mouse_pointer_bytes(want).to_string()
    }

    fn activate_at(&self, x: i64, y: i64) -> bool {
        let Some(frame) = self.hit_frame.as_ref() else {
            return false;
        };
        let Some(path) = element_at_path(frame, x, y) else {
            return false;
        };
        path.iter().any(|hit| hit.intent() == Intent::Activate)
    }

    fn on_click(&mut self, col: i64, row: i64, shift: bool) {
        if !self.entered || !self.queue.ready() {
            return;
        }
        let x = col - 1;
        let y = row - 1;
        if self.composer_click(x, y, shift) {
            return;
        }
        let viewport = Viewport {
            w: i64::from(self.cols),
            h: i64::from(self.rows),
        };
        let owned_frame;
        let frame = if let Some(frame) = self.hit_frame.as_ref() {
            frame
        } else {
            let owned;
            let root = if let Some(root) = self.hits.as_ref() {
                root
            } else {
                owned = HitNode::Chrome {
                    key: "composer:frame".to_string(),
                    frame: self.chrome_model(),
                    body_user_select: None,
                    inert: false,
                };
                &owned
            };
            owned_frame = layout_hits(root, viewport);
            &owned_frame
        };
        let Some(path) = element_at_path(frame, x, y) else {
            return;
        };
        for hit in path.iter().rev() {
            if let Some(Click::ToggleCollapsed { block_id }) = hit.click() {
                let open = self.collapsed.get(block_id).copied().unwrap_or(true);
                self.collapsed.insert(block_id.clone(), !open);
                self.cause.scene = true;
                return;
            }
        }
        let mut mention: Option<String> = None;
        for hit in &path {
            if hit.intent() != Intent::Activate {
                continue;
            }
            let key = hit.key();
            if !key.starts_with("mention:") {
                continue;
            }
            mention = Some(match mention {
                Some(prev) if prev.len() <= key.len() => prev,
                _ => key.to_string(),
            });
        }
        if let Some(key) = mention {
            self.up.push(Up::Activate { key });
            return;
        }
        for hit in path.iter().rev() {
            if matches!(hit.intent(), Intent::Activate | Intent::Dismiss) && !hit.key().is_empty() {
                self.up.push(Up::Activate {
                    key: hit.key().to_string(),
                });
                return;
            }
        }
    }
}

fn rect_contains(rect: Rect, x: i64, y: i64) -> bool {
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

fn selection_due(last: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(last) >= selection_paint_interval_ms()
}

struct ChromeOverlay {
    panel: Option<ChromeFrame>,
    draft: ChromeFrame,
}

struct OverlaySpan {
    top: i64,
    panel_h: i64,
    draft_h: i64,
}

/// Where a wheel notch goes. `Hold` is a catalog that cannot move.
enum CatalogWheel {
    Miss,
    Hold,
    Nudge(i64),
}

/// The draft keeps its height. The catalog takes whatever rows remain above it.
fn overlay_span(
    panel: Option<&ChromeFrame>,
    draft: &ChromeFrame,
    cols: i64,
    rows: i64,
) -> OverlaySpan {
    let draft_h = measure_chrome_frame(draft, cols, rows)
        .total_h
        .min(rows.max(1))
        .max(1);
    let room = (rows - draft_h).max(0);
    let panel_h = match panel {
        Some(frame) if room > 0 => measure_chrome_frame(frame, cols, room).total_h.min(room),
        _ => 0,
    };
    OverlaySpan {
        top: (rows - draft_h - panel_h).max(0),
        panel_h,
        draft_h,
    }
}

fn picker_row(choice: &ComposerChoice) -> PickerRow {
    PickerRow {
        key: Some(choice.key.clone()),
        name: choice.name.clone(),
        status: trimmed_nonempty(&choice.status),
        annotation: trimmed_nonempty(&choice.annotation),
        description: trimmed_nonempty(&choice.description),
        href: trimmed_nonempty(&choice.href),
    }
}

fn cell_in(rect: ChromeRect, x: i64, y: i64) -> bool {
    rect.w > 0
        && rect.h > 0
        && x >= rect.x
        && y >= rect.y
        && x < rect.x.saturating_add(rect.w)
        && y < rect.y.saturating_add(rect.h)
}

fn idle_scene() -> Node {
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Column,
            ..FlexStyle::default()
        },
        children: Vec::new(),
        key: Some("root".into()),
        measured: None,
        region_prominence: None,
    }
}

fn is_ghost_deletion(style: &Style) -> bool {
    style.role.as_deref() == Some("diff_del")
        && style
            .prominence
            .is_some_and(|prominence| prominence == crate::theme::FgP::GHOST)
}

fn clip_rect(rect: Rect, clip: Rect) -> Option<Rect> {
    let x0 = rect.x.max(clip.x);
    let y0 = rect.y.max(clip.y);
    let x1 = rect
        .x
        .saturating_add(rect.w)
        .min(clip.x.saturating_add(clip.w));
    let y1 = rect
        .y
        .saturating_add(rect.h)
        .min(clip.y.saturating_add(clip.h));
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some(Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    })
}

fn rect_at(rects: &[Rect], x: i64, y: i64) -> Option<Rect> {
    rects.iter().copied().find(|rect| rect_contains(*rect, x, y))
}

/// Visible ghost-deletion chips. Any-motion stays armed while this is non-empty.
pub fn ghost_diff_rects(frame: &Frame) -> Vec<Rect> {
    let mut rects = Vec::new();
    for positioned in &frame.paint_order {
        for op in &positioned.paint {
            let PaintOp::Text { rect, style, .. } = op else {
                continue;
            };
            if !is_ghost_deletion(style) {
                continue;
            }
            if let Some(visible) = clip_rect(*rect, positioned.clip) {
                rects.push(visible);
            }
        }
    }
    rects
}

/// The ghost chip under `pointer` paints at full prominence. The other chips
/// stay at [`crate::theme::FgP::GHOST`].
pub fn lift_ghost_hover(frame: &mut Frame, pointer: Option<(i64, i64)>) {
    let Some((x, y)) = pointer else {
        return;
    };
    for positioned in &mut frame.paint_order {
        for op in &mut positioned.paint {
            let PaintOp::Text { rect, style, .. } = op else {
                continue;
            };
            if !is_ghost_deletion(style) {
                continue;
            }
            let Some(visible) = clip_rect(*rect, positioned.clip) else {
                continue;
            };
            if rect_contains(visible, x, y) {
                style.prominence = Some(crate::theme::FgP::PRIMARY);
            }
        }
    }
}

/// Paint one laid-out frame. Border glyphs stay inside `Positioned.clip`.
/// Text and fill go through `resolve`. A border style is written as the op stored it.
pub fn paint_frame(
    frame: &Frame,
    buf: &mut Buffer,
    now_ms: f64,
    resolve: impl Fn(&Style) -> Style,
) {
    paint_positioned(&frame.paint_order, buf, now_ms, resolve);
}

fn paint_positioned(
    order: &[Positioned],
    buf: &mut Buffer,
    now_ms: f64,
    resolve: impl Fn(&Style) -> Style,
) {
    for positioned in order {
        let clip = positioned.clip;
        for op in &positioned.paint {
            match op {
                PaintOp::Text { rect, lines, style } => {
                    let paint = resolve(style);
                    for (i, line) in lines.iter().enumerate() {
                        let Some(dy) = i64::try_from(i).ok() else {
                            break;
                        };
                        if dy >= rect.h {
                            break;
                        }
                        let (head, _) = split_at_width(line, rect.w);
                        put_in_clip(buf, rect.x, rect.y + dy, head, &paint, clip);
                    }
                }
                PaintOp::Fill { rect, style } => {
                    let paint = resolve(style);
                    let width = usize::try_from(rect.w).unwrap_or(0).min(buf.width());
                    if width == 0 || rect.h <= 0 {
                        continue;
                    }
                    let line = " ".repeat(width);
                    for dy in 0..rect.h {
                        put_in_clip(buf, rect.x, rect.y + dy, &line, &paint, clip);
                    }
                }
                PaintOp::Live {
                    rect,
                    style,
                    live,
                    content,
                } => {
                    if let LivePaint::Birth { t, offset, .. } = live {
                        paint_birth_line(
                            buf,
                            *rect,
                            style,
                            *t,
                            *offset,
                            content.as_deref(),
                            clip,
                            &resolve,
                        );
                    } else {
                        let paint = resolve(style);
                        let text = live_paint_text(live, content.as_deref(), now_ms);
                        let (head, _) = split_at_width(&text, rect.w.max(1));
                        put_in_clip(buf, rect.x, rect.y, head, &paint, clip);
                    }
                }
                PaintOp::Border { rect, style } => {
                    let paint = resolve(style);
                    paint_border(buf, *rect, &paint, clip);
                }
            }
        }
    }
}

/// Glyph at a cell. Out of range is empty.
pub fn cell_glyph(buf: &Buffer, x: usize, y: usize) -> &str {
    let width = buf.width();
    if x >= width || y >= buf.height() {
        return "";
    }
    buf.cells()[y * width + x].ch.as_str()
}

/// Style written at a cell. Out of range is the blank style.
pub fn cell_placeholder(buf: &Buffer, x: usize, y: usize) -> bool {
    let width = buf.width();
    if x >= width || y >= buf.height() {
        return false;
    }
    buf.cells()[y * width + x].placeholder
}

pub fn cell_style(buf: &Buffer, x: usize, y: usize) -> Style {
    let width = buf.width();
    if x >= width || y >= buf.height() {
        return Style::default();
    }
    buf.cells()[y * width + x].style.clone()
}

/// Rest pose lags the ink tip by [`crate::birth::TIP_WINDOW`]. Each column's
/// prominence is `target · 0.8^(pos − W)` past that edge.
fn paint_birth_line(
    buf: &mut Buffer,
    rect: Rect,
    style: &Style,
    t: i64,
    offset: i64,
    content: Option<&str>,
    clip: Rect,
    resolve: &impl Fn(&Style) -> Style,
) {
    let src = content.unwrap_or("");
    if src.is_empty() || rect.w <= 0 {
        return;
    }
    let t = t as f64;
    let offset = offset as f64;
    let wave = (t - crate::birth::TIP_WINDOW).max(0.0);
    let target = style.prominence.unwrap_or(crate::theme::FgP::SECONDARY);
    let mut col = 0i64;
    let mut rest = src;
    while !rest.is_empty() && col < rect.w {
        let (glyph, tail) = take_grapheme(rest);
        if glyph.is_empty() {
            break;
        }
        let gw = i64::try_from(display_width(glyph)).unwrap_or(1).max(1);
        let mid = offset + (col as f64) + (gw as f64) / 2.0;
        let prominence = crate::birth::wavefront_prominence(mid, wave, t, target);
        if prominence > 1.0 / 255.0 {
            let mut glyph_style = style.clone();
            glyph_style.prominence = Some(prominence);
            let paint = resolve(&glyph_style);
            put_in_clip(buf, rect.x + col, rect.y, glyph, &paint, clip);
        }
        col += gw;
        rest = tail;
    }
}

fn live_paint_text(
    live: &crate::layout_engine::LivePaint,
    content: Option<&str>,
    now_ms: f64,
) -> String {
    use crate::layout_engine::LivePaint;
    match live {
        LivePaint::Birth { .. } => content.unwrap_or("").to_string(),
        LivePaint::Spinner { profile, .. } => {
            let name = match profile {
                crate::layout_engine::SpinnerProfile::Thinking => "thinking",
                crate::layout_engine::SpinnerProfile::Tool => "tool",
                crate::layout_engine::SpinnerProfile::Working => "working",
            };
            resolve_spinner_glyph(name, now_ms)
        }
        LivePaint::Elapsed {
            started_at,
            label,
            prefix,
            ..
        } => resolve_live_text(
            LiveFace::Elapsed {
                started_at: *started_at,
                label: label.as_deref(),
                prefix: prefix.as_deref(),
            },
            now_ms,
        ),
        LivePaint::Countdown { until_ms, .. } => resolve_live_text(
            LiveFace::Countdown {
                until_ms: *until_ms,
            },
            now_ms,
        ),
        LivePaint::Quota {
            windows, prefix, ..
        } => resolve_live_text(
            LiveFace::Quota {
                windows,
                prefix: prefix.as_deref(),
            },
            now_ms,
        ),
    }
}

fn paint_border(buf: &mut Buffer, rect: Rect, style: &Style, clip: Rect) {
    if rect.w <= 0 || rect.h <= 0 {
        return;
    }
    let dashes = usize::try_from(rect.w.saturating_sub(2)).unwrap_or(0);
    let h_line = "─".repeat(dashes);
    if rect.h >= 1 {
        let top = if rect.w >= 2 {
            format!("┌{h_line}┐")
        } else {
            "│".to_string()
        };
        let (slice, _) = split_at_width(&top, rect.w);
        put_in_clip(buf, rect.x, rect.y, slice, style, clip);
    }
    if rect.h >= 2 {
        let bot = if rect.w >= 2 {
            format!("└{h_line}┘")
        } else {
            "│".to_string()
        };
        let (slice, _) = split_at_width(&bot, rect.w);
        put_in_clip(buf, rect.x, rect.y + rect.h - 1, slice, style, clip);
    }
    let mut dy = 1;
    while dy < rect.h - 1 {
        put_in_clip(buf, rect.x, rect.y + dy, "│", style, clip);
        if rect.w >= 2 {
            put_in_clip(buf, rect.x + rect.w - 1, rect.y + dy, "│", style, clip);
        }
        dy += 1;
    }
}

fn in_scissor(clip: Rect, x: i64, y: i64) -> bool {
    x >= clip.x
        && y >= clip.y
        && x < clip.x.saturating_add(clip.w)
        && y < clip.y.saturating_add(clip.h)
}

fn put_in_clip(buf: &mut Buffer, x: i64, y: i64, text: &str, style: &Style, clip: Rect) {
    if y < clip.y || y >= clip.y.saturating_add(clip.h) {
        return;
    }
    let (head, _) = split_at_width(text, 10_000);
    let mut cx = x;
    let mut rest = head;
    while !rest.is_empty() {
        let (glyph, tail) = take_grapheme(rest);
        if glyph.is_empty() {
            break;
        }
        let gw = i64::try_from(display_width(glyph)).unwrap_or(1).max(1);
        let mut ok = true;
        let mut k = 0;
        while k < gw {
            if !in_scissor(clip, cx + k, y) {
                ok = false;
                break;
            }
            k += 1;
        }
        if ok {
            put_at(buf, cx, y, glyph, style);
        }
        cx += gw;
        rest = tail;
    }
}

fn draft_slice(draft: &str, cursor: usize, mark: usize) -> String {
    let (start, stop) = if mark < cursor {
        (mark, cursor)
    } else {
        (cursor, mark)
    };
    draft.get(start..stop).unwrap_or("").to_string()
}

fn scalar_index(text: &str, byte: usize) -> usize {
    let byte = text.floor_char_boundary(byte.min(text.len()));
    text[..byte].chars().count()
}

/// Host caret. The numbers are UTF-16 units, the same ones Tea stores.
fn caret_key(state: &crate::draft::DraftState) -> DecodedKey {
    let cursor = crate::draft::utf16_index(&state.draft, state.cursor);
    let mark = match state.mark {
        Some(mark) if mark != state.cursor => {
            crate::draft::utf16_index(&state.draft, mark).to_string()
        }
        _ => "n".to_string(),
    };
    DecodedKey::bare(format!("ComposerCaret:{cursor}:{mark}"))
}

fn clipboard_unread() -> Option<String> {
    None
}

fn trimmed_nonempty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// `clip_x` drops columns under the agents panel. A grapheme that does not fit stays whole on the rest side.
fn put_chrome_text(
    buf: &mut Buffer,
    x: i64,
    y: i64,
    text: &str,
    style: &Style,
    clip_x: Option<i64>,
) {
    let Some(clip_x) = clip_x else {
        put_at(buf, x, y, text, style);
        return;
    };
    if x >= clip_x {
        put_at(buf, x, y, text, style);
        return;
    }
    let (head, rest) = split_at_width(text, clip_x - x);
    if rest.is_empty() {
        return;
    }
    let advance = i64::try_from(display_width(head)).unwrap_or(0);
    put_at(buf, x + advance, y, rest, style);
}

fn put_at(buf: &mut Buffer, x: i64, y: i64, text: &str, style: &Style) {
    let Ok(x) = isize::try_from(x) else {
        return;
    };
    let Ok(y) = isize::try_from(y) else {
        return;
    };
    put(buf, x, y, text, style);
}

fn interval_ms(hz: u32) -> u64 {
    (1000 / u64::from(hz.max(1))).max(1)
}

/// Resolve one paint style the way [`Present`] does, and keep the role fields on the cell.
pub fn paint_style(style: &Style, theme: &Theme, depth: ColorDepth) -> Style {
    let ctx = ResolveCtx::new(theme, depth);
    intent_to_buffer(&resolve_style(&buffer_to_intent(style), &ctx))
}

fn buffer_to_intent(style: &Style) -> StyleIntent {
    StyleIntent {
        bold: style.bold,
        dim: if style.dim { Some(true) } else { None },
        strike: style.strike,
        italic: style.italic,
        underline: style.underline,
        href: style.href.clone(),
        fg: index_from_f64(style.fg),
        fg_rgb: style.fg_rgb.map(theme_rgb_from_buffer),
        bg: index_from_f64(style.bg),
        bg_rgb: style.bg_rgb.map(theme_rgb_from_buffer),
        bg_fx: style.bg_fx.clone(),
        bg_fx_u: style.bg_fx_u,
        bg_fx_v: style.bg_fx_v,
        role: style.role.as_deref().and_then(Role::parse),
        prominence: style.prominence,
        bg_role: style.bg_role.as_deref().and_then(Role::parse),
        bg_prominence: style.bg_prominence,
        surface_role: style.surface_role.as_deref().and_then(Role::parse),
        surface_rgb: style.surface_rgb.map(theme_rgb_from_buffer),
        surface_prominence: style.surface_prominence,
        fuse_role: style.fuse_role.as_deref().and_then(Role::parse),
        fuse_prominence: style.fuse_prominence,
        tint_role: style.tint_role.as_deref().and_then(Role::parse),
        tint: style.tint,
        region_prominence: style.region_prominence,
        selected: style.selected,
        cast_transparent: style.cast_transparent,
    }
}

fn intent_to_buffer(style: &StyleIntent) -> Style {
    Style {
        bold: style.bold,
        dim: style.dim.unwrap_or(false),
        strike: style.strike,
        italic: style.italic,
        underline: style.underline,
        href: style.href.clone(),
        fg: style.fg.map(f64::from),
        fg_rgb: style.fg_rgb.map(buffer_rgb_from_theme),
        bg: style.bg.map(f64::from),
        bg_rgb: style.bg_rgb.map(buffer_rgb_from_theme),
        cast_transparent: style.cast_transparent,
        role: style.role.map(|role| role.as_str().to_string()),
        prominence: style.prominence,
        bg_role: style.bg_role.map(|role| role.as_str().to_string()),
        bg_prominence: style.bg_prominence,
        region_prominence: style.region_prominence,
        ..Style::default()
    }
}

fn theme_rgb_from_buffer(rgb: crate::Rgb) -> ThemeRgb {
    ThemeRgb {
        r: channel_u8(rgb.r),
        g: channel_u8(rgb.g),
        b: channel_u8(rgb.b),
    }
}

fn buffer_rgb_from_theme(rgb: ThemeRgb) -> crate::Rgb {
    crate::Rgb {
        r: f64::from(rgb.r),
        g: f64::from(rgb.g),
        b: f64::from(rgb.b),
    }
}

fn channel_u8(channel: f64) -> u8 {
    if !channel.is_finite() {
        return 0;
    }
    channel.round().clamp(0.0, 255.0) as u8
}

fn index_from_f64(n: Option<f64>) -> Option<u16> {
    let n = n?;
    if !n.is_finite() || n < 0.0 || n > f64::from(u16::MAX) {
        return None;
    }
    Some(n.floor() as u16)
}

fn to_key_events(event: &InputEvent) -> Vec<DecodedKey> {
    match event {
        InputEvent::Char { ch } => vec![DecodedKey::bare(ch.clone())],
        InputEvent::Enter {
            shift,
            alt,
            ctrl,
            meta,
        } => {
            vec![DecodedKey::mods("Enter", *shift, *alt, *ctrl, *meta)]
        }
        InputEvent::ShiftEnter => vec![DecodedKey::mods("Enter", true, false, false, false)],
        InputEvent::Tab => vec![DecodedKey::bare("Tab")],
        InputEvent::ShiftTab => vec![DecodedKey::mods("Tab", true, false, false, false)],
        InputEvent::Esc {
            shift,
            alt,
            ctrl,
            meta,
        } => {
            vec![DecodedKey::mods("Escape", *shift, *alt, *ctrl, *meta)]
        }
        InputEvent::Backspace => vec![DecodedKey::bare("Backspace")],
        InputEvent::Delete => vec![DecodedKey::bare("Delete")],
        InputEvent::Up { select } => {
            vec![DecodedKey::mods("ArrowUp", *select, false, false, false)]
        }
        InputEvent::Down { select } => {
            vec![DecodedKey::mods("ArrowDown", *select, false, false, false)]
        }
        InputEvent::Left { select } => {
            vec![DecodedKey::mods("ArrowLeft", *select, false, false, false)]
        }
        InputEvent::Right { select } => {
            vec![DecodedKey::mods("ArrowRight", *select, false, false, false)]
        }
        InputEvent::Home { select } => vec![DecodedKey::mods("Home", *select, false, false, false)],
        InputEvent::End { select } => vec![DecodedKey::mods("End", *select, false, false, false)],
        InputEvent::WordLeft { select } => {
            vec![DecodedKey::mods("ArrowLeft", *select, true, false, false)]
        }
        InputEvent::WordRight { select } => {
            vec![DecodedKey::mods("ArrowRight", *select, true, false, false)]
        }
        InputEvent::WordBackspace => vec![DecodedKey::mods("Backspace", false, true, false, false)],
        InputEvent::KillToStart => vec![DecodedKey::bare(KEY_KILL_LINE_START)],
        InputEvent::KillToEnd => vec![DecodedKey::bare(KEY_KILL_LINE_END)],
        InputEvent::PageUp => vec![DecodedKey::bare("PageUp")],
        InputEvent::PageDown => vec![DecodedKey::bare("PageDown")],
        InputEvent::CtrlC => vec![DecodedKey::mods("c", false, false, true, false)],
        InputEvent::CtrlX => vec![DecodedKey::mods("x", false, false, true, false)],
        InputEvent::CtrlO => vec![DecodedKey::mods("o", false, false, true, false)],
        InputEvent::CtrlV
        | InputEvent::FocusIn
        | InputEvent::FocusOut
        | InputEvent::Mouse { .. }
        | InputEvent::Mod { .. }
        | InputEvent::OscGround { .. }
        | InputEvent::ThemeChanged => Vec::new(),
        InputEvent::Undo => vec![DecodedKey::bare(KEY_UNDO)],
        InputEvent::Redo => vec![DecodedKey::bare(KEY_REDO)],
        InputEvent::SelectAll => vec![DecodedKey::bare(KEY_SELECT_ALL)],
        InputEvent::Paste { text } => vec![DecodedKey::bare(format!(
            "{KEY_PASTE_PREFIX}{}",
            json_string(text)
        ))],
    }
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
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", u32::from(ch))),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn capability_env(env: &PresentEnv) -> CapabilityEnv {
    CapabilityEnv {
        no_color: env.no_color.clone(),
        colorterm: env.colorterm.clone(),
        term: env.term.clone(),
        term_program: env.term_program.clone(),
        wt_session: env.wt_session.clone(),
    }
}

fn nonempty(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.is_empty())
}

#[derive(Clone, Copy)]
enum ProfileName {
    Auto,
    Local,
    Ssh,
}

fn parse_profile(env: &PresentEnv) -> ProfileName {
    match env
        .qd_profile
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase()
        .as_str()
    {
        "local" => ProfileName::Local,
        "ssh" => ProfileName::Ssh,
        _ => ProfileName::Auto,
    }
}

fn parse_flourish(env: &PresentEnv, profile: Transport) -> FlourishMode {
    match env
        .qd_flourish
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "full" => FlourishMode::Full,
        "sparse" => FlourishMode::Sparse,
        "off" => FlourishMode::Off,
        _ => {
            if profile == Transport::Local {
                FlourishMode::Full
            } else {
                FlourishMode::Sparse
            }
        }
    }
}

fn parse_color_mode(env: &PresentEnv) -> Option<ColorDepth> {
    match env
        .qd_color
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase()
        .as_str()
    {
        "truecolor" => Some(ColorDepth::Truecolor),
        "ansi256" => Some(ColorDepth::Ansi256),
        "ansi16" => Some(ColorDepth::Ansi16),
        "mono" => Some(ColorDepth::Mono),
        _ => None,
    }
}

fn target_fps(env: &PresentEnv, profile: Transport) -> u32 {
    let fallback = if profile == Transport::Local { 120 } else { 30 };
    let Some(raw) = env.qd_fps.as_deref() else {
        return fallback;
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return fallback;
    }
    let parsed: f64 = raw.parse().unwrap_or(f64::NAN);
    let parsed = if parsed == 0.0 || !parsed.is_finite() {
        f64::from(fallback)
    } else {
        parsed
    };
    parsed.clamp(1.0, 240.0) as u32
}

fn flourish_hz(mode: FlourishMode, profile: Transport) -> u32 {
    match mode {
        FlourishMode::Off => 0,
        FlourishMode::Sparse => {
            if profile == Transport::Ssh {
                15
            } else {
                20
            }
        }
        FlourishMode::Full => {
            if profile == Transport::Local {
                DEFAULT_FLOURISH_HZ
            } else {
                20
            }
        }
    }
}

fn depth_rank(depth: ColorDepth) -> u8 {
    match depth {
        ColorDepth::Truecolor => 3,
        ColorDepth::Ansi256 => 2,
        ColorDepth::Ansi16 => 1,
        ColorDepth::Mono => 0,
    }
}

fn transport_name(profile: Transport) -> &'static str {
    match profile {
        Transport::Local => "local",
        Transport::Ssh => "ssh",
    }
}

fn flourish_name(mode: FlourishMode) -> &'static str {
    match mode {
        FlourishMode::Full => "full",
        FlourishMode::Sparse => "sparse",
        FlourishMode::Off => "off",
    }
}

fn depth_name(depth: ColorDepth) -> &'static str {
    match depth {
        ColorDepth::Truecolor => "truecolor",
        ColorDepth::Ansi256 => "ansi256",
        ColorDepth::Ansi16 => "ansi16",
        ColorDepth::Mono => "mono",
    }
}
