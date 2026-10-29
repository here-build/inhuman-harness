//! Present process against `runtime/tty.ts`, `present_profile.ts`, and the
//! parts of `cadence.test.ts` that do not need the widget tree.
//! Bytes are fed in. Nothing opens a terminal.

use std::collections::BTreeSet;

use qd::capabilities::{ColorDepth, OSC11_QUERY, THEME_REPORT_DISABLE, THEME_REPORT_ENABLE};
use qd::expand::{expand_diff, DiffExpand};
use qd::decode::{consume_keys, InputEvent};
use qd::create_buffer;
use qd::layout_chrome::ChromeHotkey;
use qd::layout_engine::{
    layout, BoxStyle, Gutter, LayoutOpts, LivePaint, Node, Overflow, OverflowAnchor, SpinnerProfile,
    SqueezePins, Sticky, Viewport,
};
use qd::layout_flex::{FlexDirection, FlexStyle, Length};
use qd::layout_hit::{layout_hits, Click, HitExtra, HitNode, Intent, UserSelect};
use qd::paint_replica::PaintReplica;
use qd::present::{
    cell_glyph, cell_placeholder, cell_style, demote_depth, detect_transport, enter_bytes, exit_bytes,
    paint_style,
    ghost_diff_rects, lift_ghost_hover, mouse_any_motion_bytes,
    mouse_pointer_bytes, paint_frame, park_cursor, resolve_present_config, ColorSource, DecodedKey,
    Down,
    FlourishMode, MousePointer, Paint, Present, PresentEnv, PresentOpts, ResolvePresentOpts,
    Transport, TtyOptions, Up, ESC_QUIET_MS, present_env_from,
};
use qd::theme::{default_theme, FgP, REFERENCE_GROUND};
use qd::Style;

const WHITE_PROBE: &str = "\u{1b}]11;rgb:ffff/ffff/ffff\u{0007}\u{1b}[?62;c";
const QUIT_ACTION: &str = "exit the UI and keep session running in background";

// Not ported, do not stub:
// Cadence rows that need the widget tree, a real timer, or a PTY.
// spinner gutter armed from a box value
// live spinner reusedFrame / paintFrame identity
// live tick does not pull prepare()
// bgFx field arms flourish hz and sync brackets from that field
// thought birth, stderr hold, PTY
// thought birth collects sites and advances W

fn boot(cols: u16, rows: u16) -> Present {
    Present::boot(PresentOpts {
        cols,
        rows,
        ..PresentOpts::default()
    })
}

fn boot_env(cols: u16, rows: u16, env: PresentEnv) -> Present {
    Present::boot(PresentOpts {
        cols,
        rows,
        env,
        ..PresentOpts::default()
    })
}

fn truecolor() -> PresentEnv {
    PresentEnv {
        colorterm: Some("truecolor".into()),
        ..PresentEnv::default()
    }
}

fn idle_flex() -> Node {
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

fn spinner(hz: i64) -> Node {
    Node::Text {
        content: "x".into(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key: Some("spin".into()),
        live: Some(LivePaint::Spinner {
            profile: SpinnerProfile::Thinking,
            hz,
        }),
        region_prominence: None,
    }
}

fn activate_box(key: &str, click: Option<Click>) -> HitNode {
    HitNode::Box {
        key: Some(key.into()),
        id: None,
        style: BoxStyle {
            width: Some(Length::Cells(40)),
            height: Some(Length::Cells(12)),
            ..BoxStyle::default()
        },
        extra: HitExtra {
            intent: Some(Intent::Activate),
            user_select: Some(UserSelect::None),
            click,
            ..HitExtra::default()
        },
        measured: None,
        children: vec![HitNode::Text {
            content: "CLICK".into(),
            key: Some(format!("{key}:t")),
            white_space: None,
            ellipsis: None,
            line_clamp: None,
            measured: None,
            extra: HitExtra::default(),
        }],
    }
}

fn modes(bytes: &str) -> (Vec<u32>, Vec<u32>) {
    let mut on = Vec::new();
    let mut off = Vec::new();
    let chars: Vec<char> = bytes.chars().collect();
    let mut i = 0;
    while i + 3 < chars.len() {
        if chars[i] == '\u{1b}' && chars[i + 1] == '[' && chars[i + 2] == '?' {
            let mut j = i + 3;
            let start = j;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j > start && j < chars.len() && (chars[j] == 'h' || chars[j] == 'l') {
                let code: u32 = chars[start..j]
                    .iter()
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0);
                if chars[j] == 'h' {
                    on.push(code);
                } else {
                    off.push(code);
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    if !on.contains(&1003) && !off.contains(&1003) {
        off.push(1003);
    }
    (on, off)
}

fn keys_of(posted: &[Up]) -> Vec<String> {
    posted
        .iter()
        .filter_map(|message| match message {
            Up::InputEvents { events } => Some(
                events
                    .iter()
                    .map(|event| event.key.clone())
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .flatten()
        .collect()
}

fn activates(posted: &[Up]) -> Vec<String> {
    posted
        .iter()
        .filter_map(|message| match message {
            Up::Activate { key } => Some(key.clone()),
            _ => None,
        })
        .collect()
}

fn open(present: &mut Present) -> Paint {
    let frame = present.paint_if_needed(0);
    present.push_down(vec![Down::PaintInit]);
    frame
}

#[test]
fn tty_enter_exit_matches_the_session_bytes() {
    let sync = TtyOptions {
        sync2026: true,
        ..TtyOptions::default()
    };
    let enter = enter_bytes(&sync);
    assert_eq!(
        enter,
        "\u{1b}[?1049h\u{1b}[2J\u{1b}[H\u{1b}[?25l\u{1b}[?7l\u{1b}[?2026h\u{1b}[>4;2m\u{1b}[>31u\u{1b}[=31;1u\u{1b}[?2004h\u{1b}[?1004h\u{1b}[?1000h\u{1b}[?1002h\u{1b}[?1006h\u{1b}[?1007h",
    );
    assert_eq!(
        modes(&enter),
        (
            vec![1049, 2026, 2004, 1004, 1000, 1002, 1006, 1007],
            vec![25, 7, 1003],
        )
    );
    assert_eq!(
        modes(&enter_bytes(&TtyOptions::default())),
        (
            vec![1049, 2004, 1004, 1000, 1002, 1006, 1007],
            vec![25, 7, 1003]
        )
    );
    let exit = exit_bytes();
    assert!(exit.ends_with("\u{1b}[?1049l"));
    assert!(exit.contains("\u{1b}[?2026l"));
    assert!(exit.contains("\u{1b}[r"));
    assert!(exit.contains("\u{1b}[?7h"));
    assert!(exit.contains("\u{1b}[?25h"));
    assert!(exit.contains("\u{1b}[?1002l"));
    assert!(exit.find("\u{1b}[?2026l").unwrap() < exit.find("\u{1b}[?1049l").unwrap());
    assert!(exit.contains("\u{1b}]22;default\u{0007}"));
    assert_eq!(mouse_any_motion_bytes(true), "\u{1b}[?1003h");
    assert_eq!(
        mouse_any_motion_bytes(false),
        "\u{1b}[?1003l\u{1b}[?1000h\u{1b}[?1002h\u{1b}[?1006h"
    );
    assert_eq!(
        mouse_pointer_bytes(MousePointer::Pointer),
        "\u{1b}]22;pointer\u{0007}"
    );
    assert_eq!(
        mouse_pointer_bytes(MousePointer::Default),
        "\u{1b}]22;default\u{0007}"
    );
    assert_eq!(park_cursor(2, 4), "\u{1b}[2;4H");
    assert_eq!(park_cursor(0, -3), "\u{1b}[1;1H");
}

#[test]
fn present_profile_rows() {
    let local = resolve_present_config(&ResolvePresentOpts {
        env: &PresentEnv::default(),
        probed_depth: Some(ColorDepth::Truecolor),
        probed_sync_2026: Some(true),
    });
    assert_eq!(local.profile, Transport::Local);
    assert_eq!(local.target_fps, 120);
    assert_eq!(local.color_depth, ColorDepth::Truecolor);
    assert_eq!(local.flourish, FlourishMode::Full);
    assert_eq!(local.flourish_hz, 30);
    assert_eq!(local.color_source, ColorSource::Probe);
    assert!(local.prefer_sync_2026);
    assert_eq!(local.label, "local@120fps truecolor flourish=full");

    let ssh_env = PresentEnv {
        ssh_connection: Some("10.0.0.1 1 2 3".into()),
        ..PresentEnv::default()
    };
    assert_eq!(detect_transport(&ssh_env), Transport::Ssh);
    let ssh = resolve_present_config(&ResolvePresentOpts {
        env: &ssh_env,
        probed_depth: Some(ColorDepth::Truecolor),
        probed_sync_2026: None,
    });
    assert_eq!(ssh.profile, Transport::Ssh);
    assert_eq!(ssh.target_fps, 30);
    assert_eq!(ssh.color_depth, ColorDepth::Ansi256);
    assert_eq!(ssh.flourish, FlourishMode::Sparse);
    assert_eq!(ssh.flourish_hz, 15);
    assert_eq!(ssh.color_source, ColorSource::Probe);
    assert_eq!(ssh.label, "ssh@30fps ansi256 flourish=sparse");

    let forced_ssh = PresentEnv {
        qd_profile: Some("ssh".into()),
        ssh_connection: Some(String::new()),
        ..PresentEnv::default()
    };
    assert_eq!(detect_transport(&forced_ssh), Transport::Ssh);
    let forced_local = PresentEnv {
        qd_profile: Some("local".into()),
        ssh_connection: Some("1 2 3 4".into()),
        ..PresentEnv::default()
    };
    assert_eq!(detect_transport(&forced_local), Transport::Local);

    let tuned = PresentEnv {
        qd_fps: Some("60".into()),
        qd_color: Some("ansi16".into()),
        qd_flourish: Some("off".into()),
        ..PresentEnv::default()
    };
    let tuned_config = resolve_present_config(&ResolvePresentOpts {
        env: &tuned,
        probed_depth: Some(ColorDepth::Truecolor),
        probed_sync_2026: None,
    });
    assert_eq!(tuned_config.target_fps, 60);
    assert_eq!(tuned_config.color_depth, ColorDepth::Ansi16);
    assert_eq!(tuned_config.flourish_hz, 0);
    assert_eq!(tuned_config.color_source, ColorSource::Forced);

    let mono = resolve_present_config(&ResolvePresentOpts {
        env: &PresentEnv {
            no_color: Some("1".into()),
            ..PresentEnv::default()
        },
        probed_depth: None,
        probed_sync_2026: None,
    });
    assert_eq!(mono.color_depth, ColorDepth::Mono);
    assert_eq!(mono.color_source, ColorSource::Default);

    let mono_ssh = resolve_present_config(&ResolvePresentOpts {
        env: &PresentEnv {
            no_color: Some("1".into()),
            ssh_connection: Some("10.0.0.1 1 2 3".into()),
            ..PresentEnv::default()
        },
        probed_depth: None,
        probed_sync_2026: None,
    });
    assert_eq!(mono_ssh.color_depth, ColorDepth::Mono);
    assert_eq!(mono_ssh.color_source, ColorSource::Profile);

    assert_eq!(
        demote_depth(ColorDepth::Truecolor, ColorDepth::Ansi256),
        ColorDepth::Ansi256
    );
    assert_eq!(
        demote_depth(ColorDepth::Ansi16, ColorDepth::Ansi256),
        ColorDepth::Ansi16
    );
    assert_eq!(
        demote_depth(ColorDepth::Truecolor, ColorDepth::Truecolor),
        ColorDepth::Truecolor
    );
    assert_eq!(
        demote_depth(ColorDepth::Mono, ColorDepth::Ansi256),
        ColorDepth::Mono
    );
    assert_eq!(
        demote_depth(ColorDepth::Mono, ColorDepth::Truecolor),
        ColorDepth::Mono
    );

    assert_eq!(
        detect_transport(&PresentEnv {
            ssh_connection: Some(String::new()),
            ..PresentEnv::default()
        }),
        Transport::Local
    );
    let sync_off = PresentEnv {
        qd_sync: Some("0".into()),
        ..PresentEnv::default()
    };
    assert!(
        !resolve_present_config(&ResolvePresentOpts {
            env: &sync_off,
            probed_depth: None,
            probed_sync_2026: Some(true),
        })
        .prefer_sync_2026
    );
    let sync_on = PresentEnv {
        qd_sync: Some("1".into()),
        ..PresentEnv::default()
    };
    assert!(
        resolve_present_config(&ResolvePresentOpts {
            env: &sync_on,
            probed_depth: None,
            probed_sync_2026: Some(false),
        })
        .prefer_sync_2026
    );
    assert!(
        !resolve_present_config(&ResolvePresentOpts {
            env: &PresentEnv::default(),
            probed_depth: None,
            probed_sync_2026: Some(false),
        })
        .prefer_sync_2026
    );
}

fn truecolor_codes(bytes: &str) -> BTreeSet<String> {
    let mut codes = BTreeSet::new();
    let mut rest = bytes;
    while let Some(index) = rest.find("38;2;") {
        let tail = &rest[index + "38;2;".len()..];
        let end = tail.find('m').unwrap_or(tail.len());
        let mut parts = tail[..end].split(';');
        let r = parts.next().unwrap_or("");
        let g = parts.next().unwrap_or("");
        let b = parts.next().unwrap_or("");
        if !r.is_empty()
            && !g.is_empty()
            && !b.is_empty()
            && r.bytes().all(|byte| byte.is_ascii_digit())
            && g.bytes().all(|byte| byte.is_ascii_digit())
            && b.bytes().all(|byte| byte.is_ascii_digit())
        {
            codes.insert(format!("38;2;{r};{g};{b}"));
        }
        rest = &tail[end..];
    }
    codes
}

fn ramp_face(progress: Option<f64>) -> qd::present::ComposerFace {
    qd::present::ComposerFace {
        progress,
        progress_glow_at: Some(0.75),
        ..qd::present::ComposerFace::default()
    }
}

fn paint_ramp(env: PresentEnv, progress: Option<f64>) -> (ColorDepth, BTreeSet<String>) {
    let mut session = boot_env(80, 8, env);
    let depth = session.color_depth();
    session.set_composer(ramp_face(progress));
    let paint = session.paint_if_needed(1);
    assert!(paint.caused, "ramp paint");
    (depth, truecolor_codes(&paint.bytes))
}

/// Ansi16 keeps three foreground bands and drops the solved RGB. A truecolor
/// boot keeps the one-hue fade as `38;2` steps. `NO_COLOR=` stays mono.
#[test]
fn a_truecolor_env_paints_the_ramp_in_more_than_three_steps() {
    let smooth = present_env_from(|key| {
        if key == "COLORTERM" {
            Some("truecolor".into())
        } else {
            None
        }
    });
    let blank = present_env_from(|_| None);
    let mono = present_env_from(|key| match key {
        "NO_COLOR" => Some(String::new()),
        "COLORTERM" => Some("truecolor".into()),
        _ => None,
    });
    let depth_of = |env: &PresentEnv| {
        resolve_present_config(&ResolvePresentOpts {
            env,
            probed_depth: None,
            probed_sync_2026: None,
        })
        .color_depth
    };
    assert_eq!(
        (
            depth_of(&smooth),
            depth_of(&blank),
            depth_of(&mono),
            mono.no_color.as_deref(),
            blank.colorterm.as_deref(),
            smooth.colorterm.as_deref(),
        ),
        (
            ColorDepth::Truecolor,
            ColorDepth::Ansi16,
            ColorDepth::Mono,
            Some(""),
            None,
            Some("truecolor"),
        )
    );

    let (stepped_depth, stepped) = paint_ramp(blank, Some(0.9));
    let (smooth_depth, smooth_codes) = paint_ramp(smooth.clone(), Some(0.9));
    let (_flat_depth, flat_codes) = paint_ramp(smooth, None);
    let ramp_only: BTreeSet<_> = smooth_codes.difference(&flat_codes).cloned().collect();
    assert_eq!((stepped_depth, stepped.len()), (ColorDepth::Ansi16, 0));
    assert_eq!(smooth_depth, ColorDepth::Truecolor);
    assert!(
        ramp_only.len() > 3,
        "ramp steps {}\n{ramp_only:?}",
        ramp_only.len()
    );
}

#[test]
fn probe_paints_default_while_pending_then_retints_without_reenter() {
    // first_frame_is_enter_plus_default_theme_while_the_probe_is_pending
    let phase = "first_frame_is_enter_plus_default_theme_while_the_probe_is_pending";
    let mut session = boot(40, 8);
    assert!(session.probe_pending(), "{phase}");
    session.feed_probe("\u{1b}]11;rgb:ff", 0);
    assert!(session.probe_pending(), "{phase}");
    let first = session.paint_if_needed(0);
    assert!(session.probe_pending(), "{phase}");
    assert!(first.caused, "{phase}");
    assert!(
        first.bytes.starts_with(&enter_bytes(&TtyOptions {
            sync2026: true,
            hide_cursor: true,
            no_wrap: true,
        })),
        "{phase}"
    );
    let glyph = first.bytes.find('╭');
    let subscribe = first.bytes.find(THEME_REPORT_ENABLE);
    let query = first.bytes.find(OSC11_QUERY);
    assert_eq!(
        (
            matches!(
                (glyph, subscribe, query),
                (Some(glyph), Some(subscribe), Some(query))
                    if glyph < subscribe && subscribe < query
            ),
            glyph,
            subscribe,
            query,
        ),
        (true, glyph, subscribe, query),
        "{phase}",
    );
    assert_eq!(session.theme_ground(), REFERENCE_GROUND, "{phase}");
    assert_eq!(session.live_hz(), 0, "{phase}");
    assert_eq!(
        session.posted(),
        &[Up::Resize { cols: 40, rows: 8 }],
        "{phase}"
    );
    let idle = session.paint_if_needed(1);
    assert!(!idle.caused, "{phase}");
    assert!(idle.bytes.is_empty(), "{phase}");

    // a_settled_probe_retints_the_same_present_and_does_not_reenter
    let phase = "a_settled_probe_retints_the_same_present_and_does_not_reenter";
    let mut cold = boot_env(40, 8, truecolor());
    let cold_frame = cold.paint_if_needed(0);
    let mut session = boot_env(40, 8, truecolor());
    session.feed_probe(WHITE_PROBE, 0);
    assert!(!session.probe_pending(), "{phase}");
    assert_eq!(session.theme_ground(), REFERENCE_GROUND, "{phase}");
    let first = session.paint_if_needed(0);
    assert_eq!(first.bytes, cold_frame.bytes, "{phase}");
    assert!(first.bytes.starts_with("\u{1b}[?1049h"), "{phase}");
    assert!(session.theme_ground() > 0.9, "{phase}");
    assert!(session.entered(), "{phase}");
    let retint = session.paint_if_needed(1);
    assert!(retint.caused, "{phase}");
    assert!(!retint.bytes.starts_with("\u{1b}[?1049h"), "{phase}");
    assert!(retint.dirty_rows > 0, "{phase}");
    let posted = session.posted().len();
    let again = session.push_input("\u{1b}]11;rgb:ffff/ffff/ffff\u{0007}", 2);
    assert!(again.immediate.is_empty(), "{phase}");
    assert!(
        matches!(again.decoded.as_slice(), [InputEvent::OscGround { .. }]),
        "{phase}"
    );
    assert_eq!(session.posted().len(), posted, "{phase}");
    assert!(keys_of(session.posted()).is_empty(), "{phase}");
    let idle = session.paint_if_needed(2);
    assert!(!idle.caused, "{phase}");
    assert!(idle.bytes.is_empty(), "{phase}");

    // a_later_probe_on_the_same_owner_only_changes_theme
    let phase = "a_later_probe_on_the_same_owner_only_changes_theme";
    let mut session = boot_env(40, 8, truecolor());
    let first = session.paint_if_needed(0);
    assert!(session.probe_pending(), "{phase}");
    assert!(first.bytes.contains('╭'), "{phase}");
    session.feed_probe(WHITE_PROBE, 50);
    assert!(!session.probe_pending(), "{phase}");
    assert!(session.theme_ground() > 0.9, "{phase}");
    assert!(session.entered(), "{phase}");
    let retint = session.paint_if_needed(51);
    assert!(retint.caused, "{phase}");
    assert!(!retint.bytes.starts_with("\u{1b}[?1049h"), "{phase}");
    assert!(retint.dirty_rows > 0, "{phase}");
}

#[test]
fn input_bytes_are_consume_keys_and_wait_for_paint_init() {
    let mut session = boot(40, 8);
    let raw = "hj";
    let decoded = consume_keys(raw, "", qd::decode::LayoutTable::On);
    let push = session.push_input(raw, 0);
    assert_eq!(push.decoded, decoded.events);
    assert_eq!(decoded.pending, "");
    assert_eq!(
        session.held_keys(),
        &[
            DecodedKey {
                key: "h".into(),
                ctrl: false,
                alt: false,
                shift: false,
                meta: false,
            },
            DecodedKey {
                key: "j".into(),
                ctrl: false,
                alt: false,
                shift: false,
                meta: false,
            }
        ]
    );
    let first = session.paint_if_needed(0);
    assert!(first.bytes.starts_with("\u{1b}[?1049h"));
    assert!(keys_of(session.posted()).is_empty());
    session.push_down(vec![Down::PaintInit]);
    assert_eq!(session.ready_fires(), 1);
    assert!(session.ready());
    assert!(session.held_keys().is_empty());
    assert_eq!(
        keys_of(session.posted()),
        vec!["h".to_string(), "j".to_string()]
    );
    session.push_down(vec![Down::PaintInit]);
    assert_eq!(session.ready_fires(), 1);
    let kitty = session.push_input("\u{1b}[57444u", 1);
    assert_eq!(
        kitty.decoded,
        consume_keys("\u{1b}[57444u", "", qd::decode::LayoutTable::On).events
    );
    assert!(matches!(
        kitty.decoded.as_slice(),
        [InputEvent::Mod { down: true, .. }]
    ));
    let mouse = "\u{1b}[<0;2;2M";
    let mouse_push = session.push_input(mouse, 1);
    assert_eq!(
        mouse_push.decoded,
        consume_keys(mouse, "", qd::decode::LayoutTable::On).events
    );
}

#[test]
fn resize_is_latest_wins_until_the_gate_and_does_not_reenter() {
    let mut session = boot(40, 8);
    let first = session.paint_if_needed(0);
    assert!(first.bytes.starts_with("\u{1b}[?1049h"));
    session.push_resize(50, 14);
    session.push_resize(60, 10);
    assert_eq!(session.posted(), &[Up::Resize { cols: 40, rows: 8 }]);
    let frame = session.paint_if_needed(1);
    assert!(frame.caused);
    assert!(!frame.bytes.is_empty());
    assert!(!frame.bytes.starts_with("\u{1b}[?1049h"));
    assert_eq!(session.cols(), 60);
    assert_eq!(session.rows(), 10);
    session.push_down(vec![Down::PaintInit]);
    assert!(session
        .posted()
        .contains(&Up::Resize { cols: 60, rows: 10 }));
}

#[test]
fn live_demand_arms_a_caller_clock_and_idle_clears_it() {
    let mut session = boot(40, 8);
    let _ = session.paint_if_needed(0);
    session.set_scene(spinner(12));
    let armed = session.paint_if_needed(0);
    assert!(armed.caused);
    assert_eq!(session.live_hz(), 12);
    let early = session.paint_if_needed(82);
    assert!(!early.caused);
    assert!(early.bytes.is_empty());
    let tick = session.paint_if_needed(83);
    assert!(tick.caused);
    assert!(!tick.bytes.is_empty());
    assert_ne!(tick.bytes, armed.bytes);
    session.set_scene(idle_flex());
    let _ = session.paint_if_needed(84);
    assert_eq!(session.live_hz(), 0);
    let idle = session.paint_if_needed(10_000);
    assert!(!idle.caused);
    assert!(idle.bytes.is_empty());
}

#[test]
fn live_hz_uses_the_caller_cap_not_a_hidden_60() {
    let mut fast = boot(40, 8);
    fast.set_scene(spinner(90));
    let _ = fast.paint_if_needed(0);
    assert_eq!(fast.live_hz(), 90);
    let mut capped = Present::boot(PresentOpts {
        cols: 40,
        rows: 8,
        target_fps: Some(60),
        ..PresentOpts::default()
    });
    capped.set_scene(spinner(90));
    let _ = capped.paint_if_needed(0);
    assert_eq!(capped.live_hz(), 60);
}

#[test]
fn ctrl_c_arms_a_hint_then_counts_a_quit_without_posting_c() {
    let mut session = Present::boot(PresentOpts {
        cols: 40,
        rows: 8,
        quit_action: Some(QUIT_ACTION.into()),
        ..PresentOpts::default()
    });
    let _ = open(&mut session);
    session.push_input("\u{03}", 1);
    assert!(session.quit_armed());
    assert_eq!(session.quit_count(), 0);
    let hint = session.paint_if_needed(1);
    assert!(hint.caused);
    assert_eq!(session.quit_actions(), &[QUIT_ACTION]);
    session.push_input("\u{03}", 2);
    assert_eq!(session.quit_count(), 1);
    let idle = session.paint_if_needed(2);
    assert!(!idle.caused);
    assert!(idle.bytes.is_empty());
    assert!(!keys_of(session.posted()).iter().any(|key| key == "c"));
}

fn quota_face(now: u64) -> qd::present::ComposerFace {
    let mut face = qd::present::ComposerFace::default();
    face.context_used = Some(11_000.0);
    face.context_limit = Some(500_000.0);
    face.quota_windows = vec![qd::layout_chrome::ChromeQuotaWindow {
        remaining_percent: 99.0,
        reset_at: Some(now as f64 / 1000.0 + 5.0 * 3600.0 + 20.0 * 60.0),
    }];
    face.status_items = vec![qd::layout_chrome::ChromeStatusItem::signal("auto write", "auto")];
    face
}

fn held_quota_text(now_ms: u64, reset_clock: u64) -> String {
    let mut session = boot(120, 8);
    let _ = open(&mut session);
    session.push_input("\u{1b}[57444u", now_ms);
    session.set_composer(quota_face(reset_clock));
    let paint = session.paint_if_needed(now_ms);
    paint.bytes
}

#[test]
fn persist_mod_quota_spells_an_absolute_reset_from_the_caller_clock() {
    let now = qd::layout_chrome::unix_now_ms();
    let held = held_quota_text(now, now);
    assert!(held.contains("99% left for 5 hours and 20 minutes"), "{held}");
    assert!(!held.contains("days"), "{held}");
    let epoch = held_quota_text(0, now);
    assert!(epoch.contains("days"), "a zero clock spells resetAt as days since 1970: {epoch}");
}

#[test]
fn mod_latch_survives_a_glyph_and_clears_on_release_or_focus_out() {
    let mut session = boot(40, 12);
    let _ = open(&mut session);
    session.push_input("\u{1b}[57444u", 1);
    assert!(session.mod_held());
    session.push_input("j", 2);
    assert!(session.mod_held());
    assert!(keys_of(session.posted()).contains(&"j".to_string()));
    session.push_input("\u{1b}[57444;1:3u", 3);
    assert!(!session.mod_held());
    session.push_input("\u{1b}[57444;9u", 4);
    assert!(session.mod_held());
    session.push_input("\u{1b}[57444;9:3u", 5);
    assert!(!session.mod_held());
    session.push_input("\u{1b}[57444u", 6);
    session.push_input("\u{1b}[O", 7);
    assert!(!session.mod_held());
    let focus = session.push_input("\u{1b}[I", 8);
    assert!(focus.immediate.contains(OSC11_QUERY));
}

#[test]
fn theme_report_queries_ground_and_does_not_paint_or_post_a_key() {
    let mut session = boot(40, 8);
    let _ = open(&mut session);
    let posted = session.posted().len();
    let head = session.push_input("\u{1b}[?997;", 1);
    assert!(head.immediate.is_empty());
    assert!(head.decoded.is_empty());
    let tail = session.push_input("2n", 2);
    assert_eq!(tail.immediate, OSC11_QUERY);
    assert_eq!(tail.decoded, vec![InputEvent::ThemeChanged]);
    assert_eq!(session.posted().len(), posted);
    let idle = session.paint_if_needed(2);
    assert!(!idle.caused);
    assert!(idle.bytes.is_empty());
}

#[test]
fn quiet_escape_is_delivered_without_arming_a_live_loop() {
    let mut session = boot(40, 8);
    let _ = open(&mut session);
    let posted = session.posted().len();
    session.push_input("\u{1b}", 100);
    let early = session.paint_if_needed(100 + ESC_QUIET_MS - 1);
    assert!(!keys_of(&session.posted()[posted..])
        .iter()
        .any(|key| key == "Escape"));
    assert!(!early.caused || early.bytes.is_empty());
    let _ = session.paint_if_needed(100 + ESC_QUIET_MS);
    assert!(keys_of(&session.posted()[posted..])
        .iter()
        .any(|key| key == "Escape"));
    assert_eq!(session.live_hz(), 0);
}

#[test]
fn mailbox_coalesces_and_does_not_paint_its_strings() {
    let mut session = boot(40, 8);
    let _ = session.paint_if_needed(0);
    session.push_down(vec![
        Down::BoxSet {
            box_id: 1,
            value: "a".into(),
        },
        Down::BoxSet {
            box_id: 1,
            value: "b".into(),
        },
        Down::BoxSet {
            box_id: 1,
            value: "c".into(),
        },
        Down::BoxSet {
            box_id: 2,
            value: "x".into(),
        },
        Down::Structure {
            gen: 3,
            tree: "v=3".into(),
        },
        Down::Structure {
            gen: 2,
            tree: "stale".into(),
        },
        Down::Structure {
            gen: 5,
            tree: "v=5".into(),
        },
        Down::Structure {
            gen: 5,
            tree: "duplicate".into(),
        },
        Down::BoxFree {
            box_ids: vec![1, 3],
        },
        Down::BoxFree { box_ids: vec![] },
        Down::BoxFree { box_ids: vec![999] },
        Down::Structure {
            gen: 6,
            tree: "not a tree".into(),
        },
        Down::BoxSet {
            box_id: 7,
            value: "hello world".into(),
        },
    ]);
    assert_eq!(session.mailbox().structure_gen(), Some(6));
    assert_eq!(session.mailbox().tree(), Some("not a tree"));
    assert_eq!(session.mailbox().boxes().get(&1), None);
    assert_eq!(
        session.mailbox().boxes().get(&2).map(String::as_str),
        Some("x")
    );
    assert_eq!(
        session.mailbox().boxes().get(&7).map(String::as_str),
        Some("hello world")
    );
    assert!(session.ready());
    assert_eq!(session.ready_fires(), 1);
    let paint = session.paint_if_needed(1);
    assert!(paint.caused);
    assert!(!paint.bytes.contains("hello world"));
    assert!(!paint.bytes.contains("not a tree"));
    assert!(!paint.bytes.starts_with("\u{1b}[?1049h"));
}

#[test]
fn bare_click_activates_or_toggles_only_after_the_gate() {
    let mut session = boot(40, 12);
    let _ = session.paint_if_needed(0);
    session.set_hits(activate_box("s-foo", None));
    session.push_input("\u{1b}[<0;2;2M", 1);
    session.push_input("\u{1b}[<0;2;2m", 1);
    assert!(activates(session.posted()).is_empty());
    session.push_down(vec![Down::PaintInit]);
    session.push_input("\u{1b}[<0;2;2M", 2);
    session.push_input("\u{1b}[<0;2;2m", 2);
    assert_eq!(activates(session.posted()), vec!["s-foo".to_string()]);

    let mut collapse = boot(40, 12);
    let _ = open(&mut collapse);
    collapse.set_hits(activate_box(
        "paint:1",
        Some(Click::ToggleCollapsed {
            block_id: "paint:1".into(),
        }),
    ));
    collapse.push_input("\u{1b}[<0;2;2M", 3);
    collapse.push_input("\u{1b}[<0;2;2m", 3);
    assert_eq!(collapse.toggled_collapsed(), vec!["paint:1".to_string()]);
    assert!(activates(collapse.posted()).is_empty());
}

#[test]
fn swallowed_chords_are_not_queued_and_sync_off_still_exits_2026() {
    let mut session = boot(40, 8);
    let _ = open(&mut session);
    let before = keys_of(session.posted());
    session.push_input("\u{0f}", 1);
    session.push_input("\u{16}", 1);
    assert_eq!(keys_of(session.posted()), before);
    assert!(session.tape_expanded());

    let mut unsynced = Present::boot(PresentOpts {
        cols: 40,
        rows: 8,
        env: PresentEnv {
            qd_sync: Some("0".into()),
            ..PresentEnv::default()
        },
        ..PresentOpts::default()
    });
    let first = unsynced.paint_if_needed(0);
    assert!(first.bytes.starts_with("\u{1b}[?1049h"));
    assert!(!first.bytes.contains("\u{1b}[?2026h"));
    assert!(exit_bytes().contains("\u{1b}[?2026l"));
    let stopped = unsynced.stop();
    assert_eq!(stopped, THEME_REPORT_DISABLE);
    assert!(unsynced.stop().is_empty());
    let idle = unsynced.paint_if_needed(1);
    assert!(!idle.caused);
    assert!(idle.bytes.is_empty());
    let pushed = unsynced.push_input("h", 2);
    assert!(pushed.decoded.is_empty());
    assert!(pushed.immediate.is_empty());
}

#[test]
fn ctrl_o_toggles_tape_density_and_does_not_post_the_key() {
    let mut session = boot(40, 12);
    let _ = open(&mut session);
    let _ = session.take_posted();
    assert!(!session.tape_expanded());
    session.push_input("\u{0f}", 1);
    assert!(session.tape_expanded());
    let paint = session.paint_if_needed(1);
    assert!(paint.caused);
    assert!(keys_of(&session.take_posted()).is_empty());
    session.push_input("\u{0f}", 2);
    assert!(!session.tape_expanded());
    assert!(keys_of(&session.take_posted()).is_empty());
    session.push_input("\u{16}", 3);
    assert!(!session.tape_expanded());
}

#[test]
fn a_drag_burst_paints_once_per_30fps_window() {
    let mut session = boot(40, 12);
    let _ = open(&mut session);
    let _ = session.paint_if_needed(0);
    session.push_input("\u{1b}[<0;1;1M", 0);
    assert!(session.paint_if_needed(0).caused);
    let mut caused = 0u32;
    for col in 2..22 {
        session.push_input(&format!("\u{1b}[<32;{col};1M"), 0);
        if session.paint_if_needed(0).caused {
            caused += 1;
        }
    }
    assert_eq!(caused, 1);
    let interval = qd::present::selection_paint_interval_ms();
    assert_eq!(interval, 1000_u64.div_ceil(30));
    assert!(!session.paint_if_needed(interval - 1).caused);
    assert!(session.paint_if_needed(interval).caused);
    assert!(!session.paint_if_needed(interval).caused);
}

fn text_box(content: &str, key: &str) -> Down {
    Down::BoxSet {
        box_id: if key.starts_with("b2") { 3 } else { 2 },
        value: format!(r#"{{"type":"text","key":"{key}","content":"{content}"}}"#),
    }
}

fn composer_box() -> Down {
    Down::BoxSet {
        box_id: 1,
        value: r#"{"type":"chrome_frame","key":"composer:frame","width":40,"draft":""}"#.into(),
    }
}

fn structure(gen: i64, second: bool) -> Down {
    let children = if second {
        r#"[{"type":"box","key":"block:m1","children":[]},{"type":"box","key":"block:m2","children":[]},{"type":"box","key":"composer","children":[]}]"#
    } else {
        r#"[{"type":"box","key":"block:m1","children":[]},{"type":"box","key":"composer","children":[]}]"#
    };
    let boxes = if second {
        r#"{"block:m1":2,"block:m2":3,"composer":1}"#
    } else {
        r#"{"block:m1":2,"composer":1}"#
    };
    Down::Structure {
        gen,
        tree: format!(
            r#"{{"root":{{"type":"flex","key":"root","style":{{"direction":"column"}},"children":{children}}},"boxes":{boxes}}}"#
        ),
    }
}

fn retained_text(content: &str) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key: Some("retained".into()),
        live: None,
        region_prominence: None,
    }
}

#[test]
fn mailbox_rows_follow_the_structure_and_a_stale_gen_keeps_them() {
    let mut session = boot(40, 8);
    session.push_down(vec![
        text_box("hello world", "b1:body"),
        composer_box(),
        structure(1, false),
    ]);
    let first = session.content_rows();
    assert_eq!(first[0], "hello world");
    session.push_down(vec![text_box("draft two", "b1:body")]);
    let second = session.content_rows();
    assert_eq!(second[0], "draft two");
    assert_eq!(second[1..], first[1..]);

    session.push_down(vec![
        text_box("first", "b1:body"),
        text_box("second", "b2:body"),
        structure(2, true),
    ]);
    let swapped = session.content_rows();
    assert_eq!(swapped[0], "first");
    assert_eq!(swapped[1], "second");
    session.push_down(vec![structure(1, false)]);
    assert_eq!(session.content_rows(), swapped);
}

#[test]
fn box_free_drops_the_transcript_and_keeps_the_composer_corner() {
    let mut session = boot(40, 8);
    session.push_down(vec![
        text_box("transient", "b1:body"),
        composer_box(),
        structure(1, false),
    ]);
    let filled = session.content_rows();
    assert!(filled.iter().any(|row| row.contains("transient")));
    session.push_down(vec![Down::BoxFree { box_ids: vec![2] }]);
    let freed = session.content_rows();
    assert!(!freed.iter().any(|row| row.contains("transient")));
    assert!(freed.iter().any(|row| row.contains('╭')));
    assert_eq!(session.mailbox().structure_gen(), Some(1));
    assert!(
        freed.iter().filter(|row| row.contains('╭')).count() >= 2,
        "the composer box still paints a corner above the overlay"
    );
}

#[test]
fn opaque_structure_paints_a_blank_scene() {
    let mut session = boot(40, 8);
    session.push_down(vec![Down::Structure {
        gen: 1,
        tree: "\"not a tree\"".into(),
    }]);
    let rows = session.content_rows();
    assert!(rows.iter().all(|row| !row.contains("not a tree")));
    assert!(rows.iter().take(5).all(|row| row.is_empty()));
}

#[test]
fn retained_root_wins_and_a_missing_root_paints_the_mailbox() {
    let mut retained = boot(40, 8);
    retained.set_retained_scene(retained_text("RETAINED"));
    retained.push_down(vec![
        Down::BoxSet {
            box_id: 2,
            value: r#"{"type":"text","key":"mailbox","content":"MAILBOX"}"#.into(),
        },
        structure(1, false),
    ]);
    let rows = retained.content_rows();
    assert!(rows.iter().any(|row| row.contains("RETAINED")));
    assert!(rows.iter().all(|row| !row.contains("MAILBOX")));

    let mut open = boot(40, 8);
    open.push_down(vec![
        Down::BoxSet {
            box_id: 2,
            value: r#"{"type":"text","key":"mailbox","content":"MAILBOX"}"#.into(),
        },
        structure(1, false),
    ]);
    assert!(open.content_rows().iter().any(|row| row.contains("MAILBOX")));
}

#[test]
fn retained_scene_opens_the_gate_without_paint_init() {
    let mut session = boot(40, 8);
    assert!(!session.ready());
    session.push_input("j", 1);
    assert!(session.held_keys().iter().any(|key| key.key == "j"));
    session.set_retained_scene(retained_text("HI"));
    assert!(session.ready());
    assert_eq!(session.ready_fires(), 1);
    session.set_retained_scene(retained_text("HI"));
    assert_eq!(session.ready_fires(), 1);
    assert!(keys_of(session.posted()).contains(&"j".to_string()));
}

#[test]
fn typed_h_is_echoed_into_the_composer() {
    let mut session = boot(40, 8);
    session.push_down(vec![Down::PaintInit]);
    session.set_composer(qd::present::ComposerFace {
        draft: String::new(),
        ..qd::present::ComposerFace::default()
    });
    session.push_input("h", 1);
    assert_eq!(session.predicted_draft(), Some("h"));
    assert!(session.content_rows().iter().any(|row| row.contains('h')));
    session.set_composer(qd::present::ComposerFace {
        draft: "h".into(),
        cursor: 1,
        ..qd::present::ComposerFace::default()
    });
    assert_eq!(session.predicted_draft(), None);
    assert!(session.content_rows().iter().any(|row| row.contains('h')));
}

#[test]
fn a_cyrillic_letter_keeps_its_cell_and_appends() {
    let mut session = boot(40, 8);
    session.push_down(vec![Down::PaintInit]);
    session.set_composer(qd::present::ComposerFace::default());
    session.push_input("й", 1);
    assert_eq!(session.predicted_draft(), Some("й"));
    let paint = session.paint_if_needed(1);
    let col = qd::layout_chrome::chrome_frame_text_inset() + 1;
    assert!(
        paint.bytes.ends_with(&format!("\u{1b}[7;{}H\u{1b}[?25h", col + 1)),
        "{}",
        paint.bytes.chars().rev().take(24).collect::<String>()
    );
    session.set_composer(qd::present::ComposerFace {
        draft: "й".into(),
        cursor: 1,
        ..qd::present::ComposerFace::default()
    });
    assert_eq!(session.predicted_draft(), None);
    session.push_input("ц", 2);
    assert_eq!(session.predicted_draft(), Some("йц"));
}

#[test]
fn non_interactive_composer_does_not_predict() {
    let mut session = boot(40, 8);
    session.push_down(vec![Down::PaintInit]);
    session.set_composer(qd::present::ComposerFace {
        interactive: false,
        ..qd::present::ComposerFace::default()
    });
    session.push_input("j", 1);
    assert_eq!(session.predicted_draft(), None);
    assert!(session.content_rows().iter().all(|row| !row.contains('j')));
    assert!(keys_of(session.posted()).contains(&"j".to_string()));
}

fn wash_line() -> Node {
    let mut style = Style::default();
    style.role = Some("diff_add".into());
    style.bg_role = Some("diff_add".into());
    style.bg_prominence = Some(1.0);
    style.prominence = Some(1.0);
    Node::Text {
        content: "add".into(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style,
        key: Some("wash".into()),
        live: None,
        region_prominence: None,
    }
}

#[test]
fn attune_dark_to_light_dirties_the_wash_and_ansi256_emits_48_5() {
    let mut session = boot(40, 8);
    session.set_scene(wash_line());
    session.attune(qd::present::AttuneOpts {
        ground: Some(0.2),
        ..qd::present::AttuneOpts::default()
    });
    let dark = session.paint_if_needed(0);
    session.attune(qd::present::AttuneOpts {
        ground: Some(0.85),
        ..qd::present::AttuneOpts::default()
    });
    let light = session.paint_if_needed(1);
    assert!(light.caused);
    assert!(light.dirty_rows > 0);
    assert_ne!(dark.bytes, light.bytes);
    session.attune(qd::present::AttuneOpts {
        depth: Some(ColorDepth::Ansi256),
        ..qd::present::AttuneOpts::default()
    });
    let indexed = session.paint_if_needed(2);
    assert!(indexed.bytes.contains("48;5"), "{}", indexed.bytes);
}

#[test]
fn the_same_ground_and_depth_do_not_paint_again() {
    let mut session = boot(40, 8);
    let first = session.paint_if_needed(0);
    assert!(first.caused);
    let depth = session.color_depth();
    session.attune(qd::present::AttuneOpts {
        ground: Some(qd::theme::REFERENCE_GROUND),
        depth: Some(depth),
        ..qd::present::AttuneOpts::default()
    });
    let again = session.paint_if_needed(1);
    assert!(!again.caused);
    assert!(again.bytes.is_empty());
}

#[test]
fn osc_11_attunes_without_typing_into_the_draft() {
    let mut session = boot(40, 8);
    session.set_composer(qd::present::ComposerFace {
        draft: "stay".into(),
        cursor: 4,
        ..qd::present::ComposerFace::default()
    });
    let _ = session.paint_if_needed(0);
    session.push_input("\u{1b}]11;rgb:ffff/ffff/ffff\u{0007}", 1);
    assert_eq!(session.predicted_draft(), None);
    let paint = session.paint_if_needed(2);
    assert!(paint.caused);
    assert!(paint.dirty_rows > 0);
    assert_eq!(session.predicted_draft(), None);
    assert!(session.content_rows().iter().any(|row| row.contains("stay")));
    assert!(session.content_rows().iter().all(|row| !row.contains("rgb:")));
}

#[test]
fn focus_out_hides_the_caret_and_focus_in_parks_it() {
    let mut session = boot(40, 8);
    let first = session.paint_if_needed(0);
    assert!(first.bytes.contains("\u{1b}[?25h"));
    session.push_input("\u{1b}[O", 1);
    let blur = session.paint_if_needed(1);
    assert!(blur.caused);
    assert!(blur.bytes.contains("\u{1b}[?25l"));
    assert!(!blur.bytes.contains("\u{1b}[?25h"));
    session.push_input("\u{1b}[I", 2);
    let focus = session.paint_if_needed(2);
    assert!(focus.caused);
    assert!(focus.bytes.contains("\u{1b}[?25h"));
    assert!(focus.bytes.contains('H'));
}

fn text_line(content: &str) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key: None,
        live: None,
        region_prominence: None,
    }
}

fn tape(lines: &[Node]) -> Node {
    Node::Viewport {
        id: "tape".into(),
        key: Some("tape".into()),
        children: vec![Node::Flex {
            style: FlexStyle {
                direction: FlexDirection::Column,
                ..FlexStyle::default()
            },
            children: lines.to_vec(),
            key: Some("rows".into()),
            measured: None,
            region_prominence: None,
        }],
        anchor: OverflowAnchor::None,
        scroll: 0,
        width: Some(Length::Cells(40)),
        height: None,
        measured: None,
        region_prominence: None,
    }
}

#[test]
fn tape_follows_the_tail_until_a_page_moves_it() {
    let mut session = boot(40, 8);
    let _ = open(&mut session);
    let lines: Vec<Node> = (0..30).map(|index| text_line(&format!("row-{index}"))).collect();
    session.set_scene(tape(&lines));
    let pinned = session.content_rows();
    assert!(pinned.iter().any(|row| row.contains("row-24")));
    assert!(pinned.iter().all(|row| !row.contains("row-0")));
    session.push_input("\u{1b}[5~", 2);
    let paged = session.content_rows();
    assert_ne!(pinned, paged);
}

fn model_choice(index: usize) -> qd::present::ComposerChoice {
    let name = format!("m-{index:02}");
    qd::present::ComposerChoice {
        key: format!("choice:{index}:{name}"),
        name,
        status: String::new(),
        annotation: String::new(),
        description: String::new(),
        href: String::new(),
        actions: Vec::new(),
    }
}

fn model_face(count: usize, scroll: i64) -> qd::present::ComposerFace {
    let selected = usize::try_from(scroll.max(0)).unwrap_or(0).min(count.saturating_sub(1));
    let name = format!("m-{selected:02}");
    qd::present::ComposerFace {
        draft: "/model".into(),
        cursor: 6,
        picker: Some(qd::present::ComposerPicker {
            rows: (0..count).map(model_choice).collect(),
            fallback: false,
            selected_key: Some(format!("choice:{selected}:{name}")),
            scroll_offset: scroll,
        }),
        ..qd::present::ComposerFace::default()
    }
}

fn row_with(rows: &[String], needle: &str) -> usize {
    rows.iter()
        .position(|row| row.contains(needle))
        .unwrap_or_else(|| panic!("{needle} missing in {rows:?}"))
}

fn wheel_at(session: &mut Present, button: i64, row: usize) {
    session.push_input(&format!("\u{1b}[<{button};4;{}M", row + 1), 2);
}

fn picker_deltas(posted: &[Up]) -> Vec<i64> {
    posted
        .iter()
        .filter_map(|message| match message {
            Up::PickerScroll { delta } => Some(*delta),
            _ => None,
        })
        .collect()
}

#[test]
fn a_wheel_on_the_model_list_scrolls_the_list() {
    let mut session = boot(48, 24);
    let _ = open(&mut session);
    let lines: Vec<Node> = (0..40).map(|index| text_line(&format!("tape-{index}"))).collect();
    session.set_scene(tape(&lines));
    session.set_composer(model_face(12, 0));

    let tail = session.content_rows();
    assert!(tail.iter().any(|row| row.contains("m-00")));
    assert!(tail.iter().all(|row| !row.contains("m-11")));
    // The catalog paints over the tape, so a notch at the tail can stay on
    // the same cells. Page up until a tape wheel actually moves a row.
    let mut nudged = None;
    for _ in 0..8 {
        session.push_input("\u{1b}[5~", 2);
        let paged = session.content_rows();
        let Some(tape_row) = paged.iter().position(|row| row.contains("tape-")) else {
            continue;
        };
        wheel_at(&mut session, 65, tape_row);
        let next = session.content_rows();
        if next != paged {
            assert_eq!(picker_deltas(session.posted()), Vec::<i64>::new());
            nudged = Some(next);
            break;
        }
    }
    let nudged = nudged.expect("tape wheel did not move a row");

    let list_row = row_with(&nudged, "m-00");
    wheel_at(&mut session, 65, list_row);
    assert_eq!(picker_deltas(session.posted()), vec![1]);
    assert_eq!(session.content_rows(), nudged);
    let _ = session.take_posted();
    wheel_at(&mut session, 64, list_row);
    assert_eq!(picker_deltas(session.posted()), Vec::<i64>::new());
    assert_eq!(session.content_rows(), nudged);

    session.set_composer(model_face(3, 0));
    let short = session.content_rows();
    wheel_at(&mut session, 64, row_with(&short, "m-00"));
    assert_eq!(picker_deltas(session.posted()), Vec::<i64>::new());
    assert_eq!(session.content_rows(), short);

    session.set_composer(model_face(12, 4));
    let end = session.content_rows();
    assert!(end.iter().all(|row| !row.contains("m-00")));
    assert!(end.iter().any(|row| row.contains("m-11")));
    wheel_at(&mut session, 65, row_with(&end, "m-04"));
    assert_eq!(picker_deltas(session.posted()), Vec::<i64>::new());
    assert_eq!(session.content_rows(), end);
}

#[test]
fn a_click_opens_a_folded_disclosure_and_the_next_click_shuts_it() {
    let mut session = boot(40, 8);
    let _ = open(&mut session);
    session.set_scene(Node::Disclosure {
        collapsed: true,
        summary: Box::new(text_line("summary")),
        children: vec![text_line("SECRET")],
        key: Some("thinking:1".into()),
        measured: None,
        region_prominence: None,
    });
    let collapsed = session.content_rows();
    assert!(collapsed.iter().any(|row| row.contains("summary")));
    assert!(collapsed.iter().all(|row| !row.contains("SECRET")));
    session.push_input("\u{1b}[<0;1;1M", 3);
    session.push_input("\u{1b}[<0;1;1m", 3);
    let open_rows = session.content_rows();
    assert!(open_rows.iter().any(|row| row.contains("SECRET")), "{open_rows:?}");
    assert_eq!(session.toggled_collapsed(), vec!["thinking:1".to_string()]);
    session.push_input("\u{1b}[<0;1;1M", 4);
    session.push_input("\u{1b}[<0;1;1m", 4);
    let shut = session.content_rows();
    assert!(shut.iter().all(|row| !row.contains("SECRET")));
    assert!(session.toggled_collapsed().is_empty());
}

fn hover_keys(posted: &[Up]) -> Vec<Option<String>> {
    posted
        .iter()
        .filter_map(|message| match message {
            Up::AgentsHover { key } => Some(key.clone()),
            _ => None,
        })
        .collect()
}

fn scroll_deltas(posted: &[Up]) -> Vec<i64> {
    posted
        .iter()
        .filter_map(|message| match message {
            Up::AgentsScroll { delta } => Some(*delta),
            _ => None,
        })
        .collect()
}

#[test]
fn an_open_drawer_hovers_activates_and_does_not_scroll_the_tape() {
    let mut session = boot(80, 24);
    let _ = open(&mut session);
    // The panel covers the left half, so the token sits past that edge.
    let span = "x".repeat(48);
    let mut tape = format!("{span}TAPE-HEAD");
    for index in 1..48 {
        tape.push_str(&format!("\\n{span}tape-line-{index}"));
    }
    tape.push_str(&format!("\\n{span}TAPE-TAIL"));
    let bytes = format!(
        r#"{{
          "kind":"paint_init","epoch":"e","snapshot":{{
            "kind":"root",
            "children":[
              {{
                "kind":"agents",
                "open":true,
                "focusKey":"session:s-auth",
                "previewKey":"",
                "rows":[{{
                  "key":"session:s-auth",
                  "kind":"session",
                  "name":"AUTH-ROW",
                  "recap":"",
                  "indent":0,
                  "mark":"idle",
                  "current":false
                }}]
              }},
              {{"kind":"turn","children":[{{"kind":"completion","children":[{{
                "kind":"speech","voice":"user","text":"{tape}"
              }}]}}]}}
            ]
          }}
        }}"#
    );
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    session.set_retained_scene(replica.frame(80).expect("frame"));
    session.set_agents_plaque(replica.agents_plaque());
    let painted = session.paint_if_needed(1);
    assert!(
        painted.bytes.contains("\u{1b}[?1003h"),
        "drawer paint did not arm any-motion"
    );
    let rows = session.content_rows();
    assert!(rows.iter().any(|row| row.contains("TAPE-TAIL")), "{rows:?}");
    assert!(rows.iter().all(|row| !row.contains("TAPE-HEAD")), "{rows:?}");
    let row = row_with(&rows, "AUTH-ROW");
    let onto = session.push_input(&format!("\u{1b}[<35;8;{}M", row + 1), 2);
    assert!(
        onto.immediate.contains("\u{1b}]22;pointer\u{0007}"),
        "{}",
        onto.immediate
    );
    assert_eq!(
        hover_keys(&session.take_posted()),
        vec![Some("session:s-auth".to_string())]
    );
    // A header inside the panel keeps the row. Leaving is what clears it.
    session.push_input(&format!("\u{1b}[<35;8;{row}M"), 3);
    assert!(hover_keys(&session.take_posted()).is_empty(), "header cleared the hover");
    session.push_input(&format!("\u{1b}[<0;8;{}M", row + 1), 4);
    session.push_input(&format!("\u{1b}[<0;70;{}m", row + 1), 4);
    assert!(activates(&session.take_posted()).is_empty(), "a release off the row activated");
    session.push_input(&format!("\u{1b}[<0;8;{}M", row + 1), 5);
    session.push_input(&format!("\u{1b}[<0;8;{}m", row + 1), 5);
    assert_eq!(activates(&session.take_posted()), vec!["session:s-auth".to_string()]);
    session.push_input(&format!("\u{1b}[<35;70;{}M", row + 1), 4);
    assert_eq!(hover_keys(&session.take_posted()), vec![None]);
    session.push_input(&format!("\u{1b}[<0;70;{}M", row + 1), 5);
    session.push_input(&format!("\u{1b}[<0;70;{}m", row + 1), 5);
    assert_eq!(
        activates(&session.take_posted()),
        vec!["agents:overlay:backdrop".to_string()]
    );
    let before = session.content_rows();
    session.push_input(&format!("\u{1b}[<64;70;{}M", row + 1), 6);
    assert_eq!(scroll_deltas(&session.take_posted()), vec![-1]);
    assert_eq!(session.content_rows(), before);
}

fn click_painted_row(session: &mut Present, rows: &[String], needle: &str, now: u64) {
    let row = i64::try_from(row_with(rows, needle) + 1).unwrap_or(1);
    session.push_input(&format!("\u{1b}[<0;4;{row}M"), now);
    session.push_input(&format!("\u{1b}[<0;4;{row}m"), now);
}

#[test]
fn an_open_drawer_covers_the_composer_and_dims_what_remains() {
    let draft = "OMNIBOX-TOKEN";
    let face = qd::present::ComposerFace {
        draft: draft.to_string(),
        cursor: i64::try_from(draft.len()).unwrap_or(0),
        ..qd::present::ComposerFace::default()
    };
    let bytes = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {
            "kind":"agents",
            "open":true,
            "focusKey":"session:s-auth",
            "previewKey":"",
            "rows":[{
              "key":"session:s-auth",
              "kind":"session",
              "name":"AUTH-ROW",
              "recap":"",
              "indent":0,
              "mark":"idle",
              "current":false
            }]
          }
        ]
      }
    }"#;
    let mut closed = boot_env(80, 24, truecolor());
    let _ = open(&mut closed);
    closed.set_composer(face.clone());
    let bare = closed.content_rows();
    assert!(bare.iter().any(|row| row.contains(draft)), "{bare:?}");
    let bare_sum = dash_luma(&mut closed);

    let mut session = boot_env(80, 24, truecolor());
    let _ = open(&mut session);
    session.set_composer(face);
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    seat_published(&mut session, &mut replica, 80);
    let rows = session.content_rows();
    assert!(rows.iter().any(|row| row.contains("AUTH-ROW")), "{rows:?}");
    assert!(rows.iter().all(|row| !row.contains(draft)), "{rows:?}");
    assert!(rows.iter().all(|row| !row.starts_with('╭')), "{rows:?}");
    let covered = dash_luma(&mut session);
    assert!(
        covered < bare_sum,
        "drawer did not dim the composer border: covered {covered} bare {bare_sum}"
    );
}

fn dash_luma(session: &mut Present) -> f64 {
    let rows = session.content_rows();
    let mut found = None;
    for (y, row) in rows.iter().enumerate() {
        let mut x = 0usize;
        for ch in row.chars() {
            if x >= 76 && ch == '─' {
                found = Some((x, y));
            }
            x += 1;
        }
    }
    let (x, y) = found.unwrap_or_else(|| panic!("no composer dash past the modal\n{rows:?}"));
    let style = session.content_style(x, y);
    let rgb = style.fg_rgb.unwrap_or_else(|| panic!("truecolor fg missing at {x},{y}"));
    rgb.r + rgb.g + rgb.b
}

#[test]
fn a_subagent_preview_paints_the_modal_and_an_outside_click_closes_it() {
    let mut session = boot(80, 24);
    let _ = open(&mut session);
    let bytes = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {
            "kind":"agents",
            "open":true,
            "focusKey":"call:explore",
            "previewKey":"call:explore",
            "rows":[{
              "key":"call:explore",
              "kind":"call",
              "name":"PEEK-TITLE",
              "recap":"PLAQUE-SECRET",
              "indent":0,
              "mark":"idle",
              "current":false
            }]
          },
          {
            "kind":"preview",
            "children":[
              {"kind":"turn","children":[
                {"kind":"completion","children":[
                  {"kind":"speech","voice":"user","text":"PEEK-SECRET"}
                ]}
              ]}
            ]
          }
        ]
      }
    }"#;
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    seat_published(&mut session, &mut replica, 80);
    let rows = session.content_rows();
    assert!(rows.iter().any(|row| row.contains("PEEK-SECRET")), "{rows:?}");
    assert!(rows.iter().any(|row| row.contains("PEEK-TITLE")), "{rows:?}");
    assert!(rows.iter().any(|row| row.contains("Esc")), "{rows:?}");
    assert!(rows.iter().all(|row| !row.contains("PLAQUE-SECRET")), "{rows:?}");
    let _ = session.take_posted();
    session.push_input("\u{1b}[<0;41;12M", 2);
    session.push_input("\u{1b}[<0;41;12m", 2);
    let inside = session.take_posted();
    assert!(inside.is_empty(), "a click inside the modal posted {inside:?}");
    session.push_input("\u{1b}[<0;2;24M", 3);
    session.push_input("\u{1b}[<0;2;24m", 3);
    assert_eq!(
        activates(&session.take_posted()),
        vec!["agents:preview-overlay:backdrop".to_string()]
    );
}

#[test]
fn a_click_on_a_finished_subagent_opens_the_modal_without_the_drawer() {
    let mut session = boot(80, 24);
    let _ = open(&mut session);
    let bytes = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {"kind":"turn","children":[
            {"kind":"tool","name":"qa","object":"","status":"","state":"ok","agent":true,"toolCallId":"call-done","prettyBlock":"SPAWN-SECRET"}
          ]}
        ]
      }
    }"#;
    seat_replica(&mut session, bytes, 80);
    let folded = session.content_rows();
    assert!(folded.iter().any(|row| row.contains("qa")), "{folded:?}");
    assert!(folded.iter().all(|row| !row.contains("SPAWN-SECRET")), "{folded:?}");
    let _ = session.take_posted();
    click_painted_row(&mut session, &folded, "qa", 2);
    assert_eq!(
        activates(&session.take_posted()),
        vec!["mention:call-done".to_string()]
    );
    assert!(
        session.content_rows().iter().all(|row| !row.contains("SPAWN-SECRET")),
        "the mention click unfolded the cell"
    );
    let peeked = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {"kind":"turn","children":[
            {"kind":"tool","name":"qa","object":"","status":"","state":"ok","agent":true,"toolCallId":"call-done","prettyBlock":"SPAWN-SECRET"}
          ]},
          {"kind":"agents","open":false,"previewKey":"call:call-done","rows":[]},
          {"kind":"preview","children":[
            {"kind":"turn","children":[
              {"kind":"completion","children":[
                {"kind":"speech","voice":"user","text":"PEEK-SECRET"}
              ]}
            ]}
          ]}
        ]
      }
    }"#;
    let mut replica = PaintReplica::new();
    replica.apply(peeked.as_bytes()).expect("apply");
    seat_published(&mut session, &mut replica, 80);
    let rows = session.content_rows();
    assert!(rows.iter().any(|row| row.contains("PEEK-SECRET")), "{rows:?}");
    assert!(rows.iter().any(|row| row.contains("qa")), "{rows:?}");
    assert!(rows.iter().any(|row| row.contains("Esc")), "{rows:?}");
    let _ = session.take_posted();
    session.push_input("\u{1b}[<0;2;24M", 3);
    session.push_input("\u{1b}[<0;2;24m", 3);
    assert_eq!(
        activates(&session.take_posted()),
        vec!["agents:preview-overlay:backdrop".to_string()]
    );
}

fn seat_published(session: &mut Present, replica: &mut PaintReplica, width: i64) {
    session.set_retained_scene(replica.frame(width).expect("frame"));
    session.set_seat_rim(replica.seat_rim());
    session.set_agents_plaque(replica.agents_plaque());
    session.set_agents_preview(replica.agents_preview_open());
    session.set_preview_overlay(replica.preview_overlay(width, i64::from(session.rows())));
}

fn seat_replica(session: &mut Present, bytes: &str, width: i64) {
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    session.set_retained_scene(replica.frame(width).expect("frame"));
    session.set_seat_rim(replica.seat_rim());
}

#[test]
fn a_click_on_a_sealed_thought_and_shell_shows_the_folded_body() {
    let mut session = boot(60, 24);
    let _ = open(&mut session);
    seat_replica(
        &mut session,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[
              {"kind":"statusline","left":"main","cwd":"/repo/harness"},
              {"kind":"turn","children":[
                {"kind":"completion","children":[
                  {"kind":"thinking","text":"first line of the thought\nSECRET-THOUGHT-BODY"}
                ]},
                {"kind":"tool","name":"shell","object":"ls -1","status":"","state":"ok","caption":"list the sources","receiptKind":"text","receiptText":"SECRET-OUTPUT"}
              ]}
            ]
          }
        }"#,
        60,
    );
    let closed = session.content_rows();
    assert!(closed.iter().all(|row| !row.contains("SECRET-THOUGHT-BODY")));
    assert!(closed.iter().all(|row| !row.contains("ls -1")));
    assert!(closed.iter().all(|row| !row.contains("SECRET-OUTPUT")));
    let closed_head = row_with(&closed, "first line of the thought");
    let closed_cmd = row_with(&closed, "list the sources");
    assert_eq!(closed_cmd, closed_head + 1, "{closed:?}");
    assert!(closed[closed_head].contains("⁖"), "{closed:?}");
    click_painted_row(&mut session, &closed, "first line of the thought", 3);
    let thought = session.content_rows();
    let head = row_with(&thought, "first line of the thought");
    let body = row_with(&thought, "SECRET-THOUGHT-BODY");
    let cmd = row_with(&thought, "list the sources");
    assert_eq!(body, head + 1, "{thought:?}");
    assert_eq!(cmd, body + 1, "{thought:?}");
    assert!(thought[head].contains("⁖"), "{thought:?}");
    assert!(thought[body].contains("┃"), "{thought:?}");
    click_painted_row(&mut session, &thought, "list the sources", 4);
    let both = session.content_rows();
    assert!(both.iter().any(|row| row.contains("ls -1")), "{both:?}");
    assert!(both.iter().any(|row| row.contains("SECRET-OUTPUT")), "{both:?}");
    assert!(both.iter().any(|row| row.contains("SECRET-THOUGHT-BODY")), "{both:?}");
    click_painted_row(&mut session, &both, "first line of the thought", 5);
    let shell_stays = session.content_rows();
    assert!(shell_stays.iter().all(|row| !row.contains("SECRET-THOUGHT-BODY")));
    assert!(shell_stays.iter().any(|row| row.contains("ls -1")), "{shell_stays:?}");
    assert!(shell_stays.iter().any(|row| row.contains("SECRET-OUTPUT")));
}

#[test]
fn a_click_on_a_scrolled_shell_shows_its_output() {
    let mut fillers = String::new();
    for index in 0..18 {
        fillers.push_str(&format!(
            r#"{{"kind":"tool","name":"shell","object":"echo {index}","status":"","state":"ok","caption":"cmd {index}"}},"#
        ));
    }
    let bytes = format!(
        r#"{{"kind":"paint_init","epoch":"e2","snapshot":{{"kind":"root","children":[
          {{"kind":"statusline","left":"main","cwd":"/repo/harness"}},
          {{"kind":"turn","children":[{fillers}
            {{"kind":"tool","name":"shell","object":"ls -1","status":"","state":"ok","caption":"list the sources","receiptKind":"text","receiptText":"SECRET-OUTPUT"}}
          ]}}
        ]}}}}"#
    );
    let mut session = boot(60, 16);
    let _ = open(&mut session);
    seat_replica(&mut session, &bytes, 60);
    let closed = session.content_rows();
    assert!(closed.iter().any(|row| row.contains("list the sources")), "{closed:?}");
    assert!(closed.iter().all(|row| !row.contains("SECRET-OUTPUT")));
    click_painted_row(&mut session, &closed, "list the sources", 3);
    let opened = session.content_rows();
    assert!(opened.iter().any(|row| row.contains("ls -1")), "{opened:?}");
    assert!(opened.iter().any(|row| row.contains("SECRET-OUTPUT")), "{opened:?}");
}

#[test]
fn a_scheme_answer_box_stays_outside_the_inner_shell_box() {
    let mut session = boot(64, 28);
    let _ = open(&mut session);
    seat_replica(
        &mut session,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[
              {"kind":"statusline","left":"main","cwd":"/repo/harness"},
              {"kind":"turn","children":[
                {"kind":"scheme","name":"scheme_repl","object":"(list_dir \".\" :depth 1)","status":"","state":"ok","caption":"List the root","receiptKind":"text","receiptText":"SECRET-SCHEME"},
                {"kind":"tool","name":"shell","object":"ls -1","status":"","state":"ok","caption":"list inside scheme","receiptKind":"text","receiptText":"SECRET-SHELL","indent":true}
              ]}
            ]
          }
        }"#,
        64,
    );
    let closed = session.content_rows();
    assert!(closed.iter().all(|row| !row.contains("SECRET-SCHEME")));
    assert!(closed.iter().all(|row| !row.contains("SECRET-SHELL")));
    click_painted_row(&mut session, &closed, "List the root", 3);
    let scheme = session.content_rows();
    let script = row_with(&scheme, "(list_dir");
    let answer = row_with(&scheme, "SECRET-SCHEME");
    assert!(scheme[script].contains('┃'), "{scheme:?}");
    assert!(!scheme[script].contains('┌'), "{scheme:?}");
    assert_eq!(scheme[answer - 1].matches('┌').count(), 1, "{scheme:?}");
    assert!(scheme[answer + 1].contains('└'), "{scheme:?}");
    click_painted_row(&mut session, &scheme, "list inside scheme", 4);
    let both = session.content_rows();
    let shell = row_with(&both, "SECRET-SHELL");
    assert_eq!(both[shell - 1].matches('┌').count(), 1, "{both:?}");
    assert!(both[shell + 1].contains('└'), "{both:?}");
    assert!(both.iter().any(|row| row.contains("SECRET-SCHEME")), "{both:?}");
}

fn paint_of(root: &Node, w: i64, h: i64, buf_h: usize) -> qd::Buffer {
    let frame = layout(root, Viewport { w, h }, LayoutOpts::default());
    let mut buf = create_buffer(usize::try_from(w).unwrap_or(0), buf_h);
    paint_frame(&frame, &mut buf, 0.0, |style| style.clone());
    buf
}

#[test]
fn overflow_clip_paints_the_visible_glyph_inside_the_scissor() {
    let hidden = Node::Box {
        style: BoxStyle {
            height: Some(Length::Cells(1)),
            overflow_y: Some(Overflow::Hidden),
            ..BoxStyle::default()
        },
        children: vec![text_line("AAAA\nBBBB")],
        key: Some("tight".into()),
        id: None,
        measured: None,
        region_prominence: None,
    };
    let y_buf = paint_of(&hidden, 8, 1, 8);
    assert_eq!(cell_glyph(&y_buf, 0, 0), "A");
    assert_eq!(cell_glyph(&y_buf, 0, 1), " ");

    let auto = Node::Box {
        style: BoxStyle {
            height: Some(Length::Cells(1)),
            overflow: Some(Overflow::Auto),
            ..BoxStyle::default()
        },
        children: vec![text_line("XXXX\nYYYY")],
        key: None,
        id: None,
        measured: None,
        region_prominence: None,
    };
    let auto_buf = paint_of(&auto, 8, 1, 8);
    assert_eq!(cell_glyph(&auto_buf, 0, 0), "X");

    let bordered = Node::Viewport {
        id: "vp".into(),
        key: None,
        children: vec![Node::Box {
            style: BoxStyle {
                border: true,
                width: Some(Length::Cells(6)),
                height: Some(Length::Cells(5)),
                ..BoxStyle::default()
            },
            children: Vec::new(),
            key: Some("b".into()),
            id: None,
            measured: None,
            region_prominence: None,
        }],
        anchor: OverflowAnchor::None,
        scroll: 0,
        width: None,
        height: None,
        measured: None,
        region_prominence: None,
    };
    let border_buf = paint_of(&bordered, 8, 2, 8);
    assert_eq!(cell_glyph(&border_buf, 0, 0), "┌");
    assert_eq!(cell_glyph(&border_buf, 0, 1), "│");
    assert_eq!(cell_glyph(&border_buf, 0, 4), " ");
}

fn ntext(key: &str, content: &str) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key: Some(key.to_string()),
        live: None,
        region_prominence: None,
    }
}

fn nbox(key: &str, style: BoxStyle, children: Vec<Node>) -> Node {
    Node::Box {
        style,
        children,
        key: Some(key.to_string()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn htext(key: &str, content: &str) -> HitNode {
    HitNode::Text {
        content: content.to_string(),
        key: Some(key.to_string()),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        extra: HitExtra::default(),
    }
}

fn hbox(key: &str, style: BoxStyle, children: Vec<HitNode>) -> HitNode {
    HitNode::Box {
        key: Some(key.to_string()),
        id: None,
        style,
        extra: HitExtra::default(),
        measured: None,
        children,
    }
}

fn sticky_top() -> BoxStyle {
    BoxStyle {
        sticky: Some(Sticky::Top),
        ..BoxStyle::default()
    }
}

fn painted_row(buf: &qd::Buffer, y: usize, w: usize) -> String {
    let mut out = String::new();
    for x in 0..w {
        out.push_str(cell_glyph(buf, x, y));
    }
    out.trim_end().to_string()
}

fn column(scroll: i64, children: Vec<Node>, _h: i64) -> Node {
    Node::Viewport {
        id: "vp".into(),
        key: Some("vp".into()),
        children: vec![nbox("col", BoxStyle::default(), children)],
        anchor: OverflowAnchor::None,
        scroll,
        width: None,
        height: None,
        measured: None,
        region_prominence: None,
    }
}

fn hit_column(scroll: i64, children: Vec<HitNode>, _h: i64) -> HitNode {
    HitNode::Viewport {
        id: "vp".into(),
        key: Some("vp".into()),
        anchor: OverflowAnchor::None,
        scroll,
        children: vec![HitNode::Box {
            key: Some("col".into()),
            id: None,
            style: BoxStyle::default(),
            extra: HitExtra::select(UserSelect::Text),
            measured: None,
            children,
        }],
    }
}

#[test]
fn sticky_pin_and_top_clip_paint_the_hit_row() {
    let prompt = nbox("prompt", sticky_top(), vec![ntext("q", "PROMPT")]);
    let mut rows = vec![ntext("a0", "a0"), ntext("a1", "a1"), ntext("a2", "a2"), ntext("a3", "a3")];
    rows.push(prompt);
    rows.push(ntext("after", "AFTER"));
    rows.extend(["b0", "b1", "b2", "b3"].into_iter().map(|key| ntext(key, key)));
    let pinned = paint_of(&column(5, rows, 5), 12, 5, 5);
    let mut hit_rows = vec![htext("a0", "a0"), htext("a1", "a1"), htext("a2", "a2"), htext("a3", "a3")];
    hit_rows.push(hbox("prompt", sticky_top(), vec![htext("q", "PROMPT")]));
    hit_rows.push(htext("after", "AFTER"));
    hit_rows.extend(["b0", "b1", "b2", "b3"].into_iter().map(|key| htext(key, key)));
    let hits = layout_hits(&hit_column(5, hit_rows, 5), Viewport { w: 12, h: 5 });
    assert_eq!(hits.get("q").map(|hit| hit.key()), Some("q"));
    assert_eq!(
        element_key(&hits, 0, 0),
        "q",
    );
    assert_eq!(painted_row(&pinned, 0, 12), "PROMPT");

    let mut exact = vec![nbox(
        "A",
        sticky_top(),
        ["A0", "A1", "A2", "A3", "A4"]
            .into_iter()
            .enumerate()
            .map(|(i, line)| ntext(&format!("A{i}"), line))
            .collect(),
    )];
    exact.extend((0..6).map(|i| ntext(&format!("a{i}"), &format!("a{i}"))));
    let exact_buf = paint_of(&column(5, exact, 5), 12, 5, 5);
    let mut exact_hits = vec![hbox(
        "A",
        sticky_top(),
        ["A0", "A1", "A2", "A3", "A4"]
            .into_iter()
            .enumerate()
            .map(|(i, line)| htext(&format!("A{i}"), line))
            .collect(),
    )];
    exact_hits.extend((0..6).map(|i| htext(&format!("a{i}"), &format!("a{i}"))));
    let exact_frame = layout_hits(&hit_column(5, exact_hits, 5), Viewport { w: 12, h: 5 });
    assert_eq!(element_key(&exact_frame, 0, 0), "A0");
    assert_eq!(element_key(&exact_frame, 0, 1), "a1");
    assert_eq!(painted_row(&exact_buf, 0, 12), "A0");

    let tall = Node::Viewport {
        id: "vp".into(),
        key: None,
        children: vec![ntext("tall", "aaaa bbbb cccc dddd eeee")],
        anchor: OverflowAnchor::None,
        scroll: 1,
        width: None,
        height: None,
        measured: None,
        region_prominence: None,
    };
    let clip = paint_of(&tall, 4, 2, 4);
    assert_eq!(painted_row(&clip, 0, 4), "bbbb");
    assert_eq!(painted_row(&clip, 1, 4), "cccc");
    assert!(!painted_row(&clip, 0, 4).contains("aaaa"));
    assert!(!painted_row(&clip, 1, 4).contains("aaaa"));
}

#[test]
fn squeeze_void_cell_is_a_transparent_space() {
    let tape_style = Style {
        bg_role: Some("diff_del".to_string()),
        ..Style::default()
    };
    let tape_rows: Vec<Node> = (0..10)
        .map(|i| Node::Text {
            content: "XXXXXXXXXXXXXXXXXXXXXXXX".to_string(),
            white_space: None,
            ellipsis: None,
            line_clamp: None,
            measured: None,
            style: tape_style.clone(),
            key: Some(format!("t{i}")),
            live: None,
            region_prominence: None,
        })
        .collect();
    let peek_rows: Vec<Node> = (0..20).map(|i| ntext(&format!("l{i}"), "PEEK")).collect();
    let tree = Node::Viewport {
        id: "vp".into(),
        key: None,
        children: vec![
            nbox("tape", BoxStyle::default(), tape_rows),
            nbox(
                "diff",
                BoxStyle {
                    squeeze: Some(SqueezePins { head: 4, tail: 4 }),
                    ..BoxStyle::default()
                },
                peek_rows,
            ),
        ],
        anchor: OverflowAnchor::None,
        scroll: 0,
        width: None,
        height: None,
        measured: None,
        region_prominence: None,
    };
    let buf = paint_of(&tree, 24, 10, 10);
    let void_style = cell_style(&buf, 10, 1);
    assert_eq!(cell_glyph(&buf, 0, 0), "X");
    assert_eq!(cell_glyph(&buf, 0, 1), "P");
    assert_eq!(cell_glyph(&buf, 10, 1), " ");
    assert!(void_style.bg.is_none());
    assert!(void_style.bg_rgb.is_none());
    assert!(void_style.bg_role.is_none());
    assert!(void_style.cast_transparent);
    assert_ne!(cell_glyph(&buf, 10, 1), "X");
    let resolved = paint_resolved(&tree, 24, 10);
    let resolved_void = cell_style(&resolved, 10, 1);
    assert_eq!(cell_glyph(&resolved, 10, 1), " ");
    assert!(resolved_void.bg.is_none());
    assert!(resolved_void.bg_rgb.is_none());
    assert!(resolved_void.bg_role.is_none());
    assert!(resolved_void.cast_transparent);
}

fn paint_resolved(root: &Node, w: i64, h: i64) -> qd::Buffer {
    let frame = layout(root, Viewport { w, h }, LayoutOpts::default());
    let mut buf = create_buffer(usize::try_from(w).unwrap_or(0), usize::try_from(h).unwrap_or(0));
    let theme = default_theme();
    paint_frame(&frame, &mut buf, 0.0, |style| {
        paint_style(style, &theme, ColorDepth::Truecolor)
    });
    buf
}

#[test]
fn resolved_panel_keeps_index_235_and_border_role() {
    let panel = nbox(
        "panel",
        BoxStyle {
            border: true,
            width: Some(Length::Cells(12)),
            height: Some(Length::Cells(5)),
            background: Some(Style {
                bg: Some(235.0),
                ..Style::default()
            }),
            ..BoxStyle::default()
        },
        vec![ntext("ok", "ok")],
    );
    let overlay = Node::Overlay {
        center: true,
        origin: None,
        backdrop: true,
        backdrop_style: Some(Style {
            bg: Some(236.0),
            ..Style::default()
        }),
        children: vec![panel],
        key: None,
        measured: None,
        region_prominence: None,
    };
    let frame = layout(&overlay, Viewport { w: 40, h: 12 }, LayoutOpts::default());
    let placed = frame
        .placed
        .iter()
        .find(|hit| hit.key == "panel")
        .expect("panel");
    let mut buf = create_buffer(40, 12);
    let theme = default_theme();
    paint_frame(&frame, &mut buf, 0.0, |style| {
        paint_style(style, &theme, ColorDepth::Truecolor)
    });
    let x = usize::try_from(placed.rect.x).unwrap_or(0);
    let y = usize::try_from(placed.rect.y).unwrap_or(0);
    let corner = cell_style(&buf, x, y);
    let inner = cell_style(&buf, x + 1, y + 1);
    assert_eq!(cell_glyph(&buf, x, y), "┌");
    assert_eq!(corner.bg, Some(235.0));
    assert_eq!(inner.bg, Some(235.0));
    assert!(corner.bg_rgb.is_none());
    assert!(inner.bg_rgb.is_none());
    assert_eq!(corner.role.as_deref(), Some("border"));
    assert_eq!(corner.prominence, Some(FgP::GHOST));

    let quoted = Node::Indication {
        gutter: Gutter::Rule {
            glyph: "|".to_string(),
        },
        children: vec![Node::Text {
            content: "quoted".to_string(),
            white_space: None,
            ellipsis: None,
            line_clamp: None,
            measured: None,
            style: Style {
                role: Some("foreground".to_string()),
                prominence: Some(FgP::SECONDARY),
                ..Style::default()
            },
            key: Some("q".to_string()),
            live: None,
            region_prominence: None,
        }],
        style: Style {
            role: Some("border".to_string()),
            prominence: Some(FgP::GHOST),
            ..Style::default()
        },
        key: Some("bq".to_string()),
        measured: None,
        region_prominence: None,
    };
    let gutter_buf = paint_resolved(&quoted, 20, 2);
    let gutter = cell_style(&gutter_buf, 1, 0);
    assert_eq!(cell_glyph(&gutter_buf, 1, 0), "|");
    let body = cell_style(&gutter_buf, 3, 0);
    assert_eq!(gutter.role.as_deref(), Some("border"));
    assert_eq!(gutter.prominence, Some(FgP::GHOST));
    assert!(!gutter.bold);
    assert_eq!(body.role.as_deref(), Some("foreground"));
    assert_eq!(body.prominence, Some(FgP::SECONDARY));
}

#[test]
fn hotkey_paint_writes_return_and_a_real_space_mate() {
    let frame = Node::Chrome {
        key: Some("cover".into()),
        frame: qd::layout_chrome::ChromeFrame {
            hotkeys: vec![
                ChromeHotkey::new("Enter", "Allow"),
                ChromeHotkey::new("Esc", "Deny"),
            ],
            ..qd::layout_chrome::ChromeFrame::new(48, "shadowed")
        },
    };
    let buf = paint_of(&frame, 48, 5, 5);
    let mut row = String::new();
    let mut return_at = None;
    for x in 0..buf.width() {
        let glyph = cell_glyph(&buf, x, 0);
        if glyph == "⏎" && return_at.is_none() {
            return_at = Some(x);
        }
        row.push_str(glyph);
        assert_ne!(glyph, "Enter");
    }
    let x = return_at.expect("return glyph");
    assert_eq!(cell_glyph(&buf, x + 1, 0), " ");
    assert!(!cell_placeholder(&buf, x + 1, 0));
    assert!(row.contains('⏎'));
    assert!(!row.contains("Enter"));
}

#[test]
fn a_live_tick_changes_only_the_gutter_glyph() {
    for profile in [SpinnerProfile::Thinking, SpinnerProfile::Tool] {
        assert_gutter_tick(profile);
    }
}

fn assert_gutter_tick(profile: SpinnerProfile) {
    let thinking = Node::Indication {
        gutter: Gutter::Spinner {
            profile: Some(profile),
            rows: None,
        },
        children: vec![ntext("b", "thinking")],
        style: Style::default(),
        key: Some("t".into()),
        measured: None,
        region_prominence: None,
    };
    let frame = layout(&thinking, Viewport { w: 20, h: 3 }, LayoutOpts::default());
    let mut first = create_buffer(20, 3);
    let mut second = create_buffer(20, 3);
    paint_frame(&frame, &mut first, 0.0, |style| style.clone());
    paint_frame(&frame, &mut second, 500.0, |style| style.clone());
    let mut changed = Vec::new();
    for y in 0..3 {
        for x in 0..20 {
            if cell_glyph(&first, x, y) != cell_glyph(&second, x, y) {
                changed.push((x, y, cell_glyph(&first, x, y), cell_glyph(&second, x, y)));
            }
        }
    }
    assert_eq!(changed.len(), 1, "{changed:?}");
    assert_eq!(changed[0].0, 1);
    assert_eq!(changed[0].1, 0);
    assert_ne!(changed[0].2, changed[0].3);
    assert_eq!(cell_glyph(&first, 3, 0), "t");
    assert_eq!(cell_glyph(&second, 3, 0), "t");
}

fn element_key(frame: &qd::layout_hit::HitFrame, x: i64, y: i64) -> String {
    qd::layout_hit::element_at(frame, x, y)
        .map(|hit| hit.key().to_string())
        .unwrap_or_default()
}

fn click_cell(session: &mut Present, x: i64, y: i64, now: u64) {
    session.push_input(&format!("\u{1b}[<0;{};{}M", x + 1, y + 1), now);
    session.push_input(&format!("\u{1b}[<0;{};{}m", x + 1, y + 1), now);
}

#[test]
fn a_click_in_the_draft_moves_the_cursor_and_chrome_does_not() {
    let cjk = "a漢b";
    assert_eq!(qd::layout_hit::composer_offset_at_cell(cjk, 1, 0, 0, 0, 8), 1);
    assert_eq!(qd::layout_hit::composer_offset_at_cell(cjk, 2, 0, 0, 0, 8), 1);
    assert_eq!(qd::layout_hit::composer_offset_at_cell(cjk, 3, 0, 0, 0, 8), "a漢".len());
    assert_eq!(qd::layout_hit::composer_offset_at_cell("hello world", 2, 1, 5, 3, 8), 0);

    let draft = "hello world";
    let mut session = boot(12, 10);
    let _ = open(&mut session);
    session.set_composer(qd::present::ComposerFace {
        draft: draft.into(),
        ..qd::present::ComposerFace::default()
    });
    let _ = session.paint_if_needed(1);
    assert_eq!(session.shown_cursor(), 0);

    let frame = qd::layout_chrome::ChromeFrame::new(12, draft);
    let geom = qd::layout_chrome::measure_chrome_frame(&frame, 12, 10);
    let top = (10 - geom.total_h).max(0);
    let paint = qd::layout_chrome::chrome_frame_paint_ops(
        &frame,
        qd::layout_chrome::Rect::new(0, top, 12, geom.total_h.max(1)),
    );
    let body = paint.body_hit;
    assert!(body.h >= 2, "wrapped draft body {body:?}");
    click_cell(&mut session, body.x, body.y + 1, 2);
    assert_eq!(session.shown_cursor(), 6);
    assert_eq!(&draft[session.shown_cursor()..], "world");
    assert!(session.content_rows().iter().any(|row| row.contains("world")));

    click_cell(&mut session, 0, body.y + 1, 3);
    assert_eq!(session.shown_cursor(), 6);
    click_cell(&mut session, 1, body.y + 1, 4);
    assert_eq!(session.shown_cursor(), 6);

    click_cell(&mut session, body.x, body.y, 5);
    assert_eq!(session.shown_cursor(), 0);
}

fn glyph_luma(session: &mut Present, needle: &str) -> f64 {
    let rows = session.content_rows();
    for (y, row) in rows.iter().enumerate() {
        let Some(index) = row.find(needle) else {
            continue;
        };
        let x = row[..index].chars().count();
        let style = session.content_style(x, y);
        let rgb = style
            .fg_rgb
            .unwrap_or_else(|| panic!("truecolor fg missing at {x},{y} for {needle}"));
        return rgb.r + rgb.g + rgb.b;
    }
    panic!("missing {needle}\n{rows:?}");
}

#[test]
fn rewind_hides_the_omnibox_dims_the_reply_and_drops_a_visible_pin() {
    let draft = "OMNIBOX-TOKEN";
    let face = qd::present::ComposerFace {
        draft: draft.to_string(),
        cursor: i64::try_from(draft.len()).unwrap_or(0),
        ..qd::present::ComposerFace::default()
    };
    let bytes = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {"kind":"turn","children":[
            {"kind":"speech","voice":"user","text":"OLDER-PROMPT"}
          ]},
          {"kind":"turn","children":[
            {"kind":"completion","children":[
              {"kind":"speech","text":"REPLY-BODY"}
            ]}
          ]},
          {"kind":"turn","children":[
            {"kind":"speech","voice":"user","text":"ACTIVE-PROMPT","recap":true,"recapHotkeys":[
              {"key":"Enter","action":"Rollback here"}
            ]}
          ]},
          {"kind":"rewind","atTip":false,"seatRim":false,"past":[{"key":"older","text":"OLDER-PROMPT"}]}
        ]
      }
    }"#;
    let mut session = boot_env(80, 30, truecolor());
    let _ = open(&mut session);
    session.set_composer(face);
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    seat_published(&mut session, &mut replica, 80);
    let rows = session.content_rows();
    assert!(rows.iter().all(|row| !row.contains(draft)), "{rows:?}");
    assert_eq!(
        rows.iter().filter(|row| row.contains("OLDER-PROMPT")).count(),
        1,
        "{rows:?}"
    );
    assert_eq!(rows.iter().filter(|row| row.contains('╭')).count(), 2, "{rows:?}");
    assert_eq!(
        rows.iter().filter(|row| row.contains("Rollback here")).count(),
        1,
        "{rows:?}"
    );
    let reply = glyph_luma(&mut session, "REPLY-BODY");
    let older = glyph_luma(&mut session, "OLDER-PROMPT");
    let active = glyph_luma(&mut session, "ACTIVE-PROMPT");
    assert!(older < active, "inactive message {older} active {active}");
    assert!(reply < active, "reply {reply} active {active}");
}

#[test]
fn rewind_keeps_a_pin_whose_prompt_is_above_the_window() {
    let reply = "LINE\\n".repeat(36);
    let bytes = format!(
        r#"{{
          "kind":"paint_init","epoch":"e","snapshot":{{
            "kind":"root",
            "children":[
              {{"kind":"turn","children":[
                {{"kind":"speech","voice":"user","text":"FIRST-PROMPT"}}
              ]}},
              {{"kind":"turn","children":[
                {{"kind":"completion","children":[
                  {{"kind":"speech","text":"{reply}TAIL-LINE"}}
                ]}}
              ]}},
              {{"kind":"turn","children":[
                {{"kind":"speech","voice":"user","text":"ACTIVE-PROMPT","recap":true}}
              ]}},
              {{"kind":"rewind","atTip":false,"seatRim":false,"past":[{{"key":"first","text":"FIRST-PROMPT"}}]}}
            ]
          }}
        }}"#
    );
    let mut session = boot_env(80, 16, truecolor());
    let _ = open(&mut session);
    session.set_composer(qd::present::ComposerFace {
        draft: "OMNIBOX-TOKEN".into(),
        cursor: 13,
        ..qd::present::ComposerFace::default()
    });
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    seat_published(&mut session, &mut replica, 80);
    let rows = session.content_rows();
    assert!(rows.iter().all(|row| !row.contains("OMNIBOX-TOKEN")), "{rows:?}");
    assert_eq!(
        rows.iter().filter(|row| row.contains("FIRST-PROMPT")).count(),
        1,
        "{rows:?}"
    );
    let first = row_with(&rows, "FIRST-PROMPT");
    let active = row_with(&rows, "ACTIVE-PROMPT");
    assert!(first < 4, "{rows:?}");
    assert!(first < active, "{rows:?}");
}

#[test]
fn an_ask_stack_paints_the_command_above_the_draft() {
    let bytes = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {"kind":"composer","draft":"","annotation":"run command","interactive":true,
           "stackedBody":"git status --short","stackedLang":"bash","stackedViewport":8,
           "hotkeys":[{"key":"Enter","action":"Allow"},{"key":"Escape","action":"Deny"}]}
        ]
      }
    }"#;
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    let face = replica.composer_face().expect("composer");
    assert_eq!(face.stacked_body, "git status --short");
    assert_eq!(face.stacked_lang, "bash");
    assert_eq!(face.stacked_viewport, 8);
    assert!(!face.stacked_numbered);
    let mut session = boot(80, 24);
    let _ = open(&mut session);
    session.set_composer(face);
    let rows = session.content_rows();
    assert!(
        rows.iter().any(|row| row.contains("git status --short")),
        "{rows:?}"
    );
    assert!(rows.iter().any(|row| row.contains("run command")), "{rows:?}");
    assert!(rows.iter().any(|row| row.contains("Allow")), "{rows:?}");
}

#[test]
fn a_diff_ask_stays_on_screen_above_the_composer() {
    let bytes = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {"kind":"turn","children":[
            {"kind":"speech","voice":"user","text":"Patch a.ts"}
          ]},
          {"kind":"ask","name":"edit_file","object":"a.ts","status":"","state":"ask",
           "receiptKind":"diff","diffPath":"a.ts","diffOld":"OLD-TOKEN\n","diffNew":"NEW-TOKEN\n"}
        ]
      }
    }"#;
    let mut session = boot(80, 30);
    let _ = open(&mut session);
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    seat_published(&mut session, &mut replica, 80);
    let rows = session.content_rows();
    assert!(rows.iter().any(|row| row.contains("OLD-TOKEN")), "{rows:?}");
    assert!(rows.iter().any(|row| row.contains("NEW-TOKEN")), "{rows:?}");
    assert!(rows.iter().any(|row| row.contains("Patch a.ts")), "{rows:?}");
}

#[test]
fn a_receipt_none_ask_is_not_a_tape_pin() {
    let bytes = r#"{
      "kind":"paint_init","epoch":"e","snapshot":{
        "kind":"root",
        "children":[
          {"kind":"turn","children":[
            {"kind":"speech","voice":"user","text":"Run the status"}
          ]},
          {"kind":"ask","name":"shell","object":"SHOULD-NOT-PIN","status":"","state":"ask",
           "receiptKind":"none"}
        ]
      }
    }"#;
    let mut session = boot(80, 24);
    let _ = open(&mut session);
    let mut replica = PaintReplica::new();
    replica.apply(bytes.as_bytes()).expect("apply");
    seat_published(&mut session, &mut replica, 80);
    let rows = session.content_rows();
    assert!(
        rows.iter().all(|row| !row.contains("SHOULD-NOT-PIN")),
        "{rows:?}"
    );
}

fn ghost_unwrap() -> Node {
    let mut opts = DiffExpand::new(
        "const foo = compute(input);\n",
        "const foo = input;\n",
        80,
    );
    opts.path = "a.ts";
    opts.language = Some("typescript");
    opts.no_highlight = true;
    expand_diff(&opts)
}

fn laid_ghosts(node: &Node) -> (qd::layout_engine::Frame, Vec<qd::layout_flex::Rect>) {
    let frame = layout(node, Viewport { w: 80, h: 24 }, LayoutOpts::default());
    let rects = ghost_diff_rects(&frame);
    (frame, rects)
}

#[test]
fn a_ghost_chip_lifts_to_full_ink_under_the_pointer() {
    let node = ghost_unwrap();
    let (frame, rects) = laid_ghosts(&node);
    let wide = rects
        .iter()
        .copied()
        .find(|rect| rect.w >= 2)
        .expect("wide ghost");
    let other = rects
        .iter()
        .copied()
        .find(|rect| *rect != wide)
        .expect("second ghost");
    let mut dim_buf = create_buffer(80, 24);
    paint_frame(&frame, &mut dim_buf, 0.0, |style| style.clone());
    let dim = cell_style(&dim_buf, wide.x as usize, wide.y as usize);
    assert_eq!(dim.role.as_deref(), Some("diff_del"));
    assert_eq!(dim.prominence, Some(FgP::GHOST));

    let mut lifted = frame.clone();
    lift_ghost_hover(&mut lifted, Some((wide.x, wide.y)));
    let mut bright_buf = create_buffer(80, 24);
    paint_frame(&lifted, &mut bright_buf, 0.0, |style| style.clone());
    let on = cell_style(&bright_buf, wide.x as usize, wide.y as usize);
    assert_eq!(on.prominence, Some(FgP::PRIMARY));
    let still = cell_style(&bright_buf, other.x as usize, other.y as usize);
    assert_eq!(still.prominence, Some(FgP::GHOST), "the other chip stays dim");
    let theme = default_theme();
    assert_ne!(
        paint_style(&dim, theme, ColorDepth::Truecolor).fg_rgb,
        paint_style(&on, theme, ColorDepth::Truecolor).fg_rgb,
        "full prominence is a different ink"
    );
}

#[test]
fn a_ghost_diff_arms_any_motion_until_the_chips_leave() {
    let mut session = boot(80, 24);
    let _ = open(&mut session);
    let node = ghost_unwrap();
    let (_, rects) = laid_ghosts(&node);
    let wide = rects
        .iter()
        .copied()
        .find(|rect| rect.w >= 2)
        .expect("wide ghost");
    assert!(
        rects.iter().all(|rect| !rect_holds(*rect, 0, wide.y)),
        "the gutter is not a ghost chip: {rects:?}"
    );
    session.set_scene(node);
    let painted = session.paint_if_needed(1);
    assert!(
        painted.bytes.contains("\u{1b}[?1003h"),
        "a ghost chip arms any-motion: {}",
        painted.bytes
    );
    let idle = session.paint_if_needed(2);
    assert!(!idle.caused, "the arm itself does not repaint again");

    session.push_input(&format!("\u{1b}[<35;1;{}M", wide.y + 1), 3);
    let miss = session.paint_if_needed(3);
    assert!(!miss.caused, "a move off the chip does not repaint");

    session.push_input(&format!("\u{1b}[<35;{};{}M", wide.x + 1, wide.y + 1), 4);
    let hit = session.paint_if_needed(4);
    assert!(hit.caused, "entering the chip repaints");

    session.push_input(&format!("\u{1b}[<35;{};{}M", wide.x + 2, wide.y + 1), 5);
    let slide = session.paint_if_needed(5);
    assert!(!slide.caused, "sliding inside the chip does not repaint");

    session.push_input(&format!("\u{1b}[<35;1;{}M", wide.y + 1), 6);
    let leave = session.paint_if_needed(6);
    assert!(leave.caused, "leaving the chip restores the ghost");

    session.set_scene(idle_flex());
    let dropped = session.paint_if_needed(7);
    assert!(
        dropped.bytes.contains("\u{1b}[?1003l"),
        "no ghost chip disarms any-motion: {}",
        dropped.bytes
    );
    assert!(
        dropped.bytes.contains("\u{1b}[?1002h"),
        "off restores drag tracking"
    );
}

fn rect_holds(rect: qd::layout_flex::Rect, x: i64, y: i64) -> bool {
    x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
}
