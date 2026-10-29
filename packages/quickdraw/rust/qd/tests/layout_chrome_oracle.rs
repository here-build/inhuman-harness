//! Chrome-frame measure, paint, and coverage mask.
//!
//! Numbers are from `layout/__tests__/chrome.test.ts` and the chrome arm of
//! `layout/engine.ts`. `containRegionAt`, `userSelect` on a placed frame, and
//! selection clamping stay in the place walk — those expects are BLOCKED at
//! the bottom and are not given a stand-in value. Body height, total height,
//! glyphs, and the mask over the same hit rects are asserted here.

use std::collections::HashSet;

use qd::create_buffer;
use qd::display_width;
use qd::layout_chrome::{
    build_chrome_mask, chrome_frame_body_from_content_segs, chrome_frame_body_lines,
    chrome_frame_bottom_segs, chrome_frame_has_hint, chrome_frame_paint_ops,
    chrome_frame_text_inset, chrome_frame_text_width, chrome_frame_top_segs,
    chrome_frame_total_height, event_matches_chord, format_elapsed_compact, format_hotkey,
    intersect_rects, is_chrome_frame_showing_placeholder, measure_chrome_frame, no_chrome,
    paint_hotkey_chord, paint_picker, paint_stacked_body, parse_chord, progress_fill_segments,
    progress_glow_tint, progress_ramp_prominence, resolve_live_text, resolve_spinner_glyph,
    reveal_hotkeys, ChordMods, ChromeBodyContentOpts, ChromeBottomOpts, ChromeFrame, ChromeHotkey,
    ChromeLive, ChromePaintOp, ChromeQuotaWindow, ChromeSeg, ChromeSegSpec, ChromeStatusItem,
    ChromeTopOpts, LiveFace, MaskFrame, MaskHit, PickerPaintInput, PickerRow, Rect,
    StackedBodyInput, UserSelect, CHROME_FRAME_DEFAULT_GLYPH, CHROME_FRAME_DEFAULT_PROGRESS_ROLE,
    CHROME_FRAME_JOIN,
};
use qd::layout_engine::{layout, measure_tree, LayoutOpts, LivePaint, Node, Viewport};
use qd::present::{cell_glyph, paint_frame};
use qd::theme::FgP;

fn line_of(segs: &[ChromeSeg]) -> String {
    segs.iter().map(|seg| seg.text.as_str()).collect()
}

fn voice(
    segs: &[ChromeSeg],
    pred: impl Fn(&str) -> bool,
) -> Option<(Option<&str>, Option<f64>, bool)> {
    segs.iter().find(|seg| pred(&seg.text)).map(|seg| {
        (
            seg.style.role.as_deref(),
            seg.style.prominence,
            seg.style.bold,
        )
    })
}

fn hue_roles(segs: &[ChromeSeg]) -> Vec<&str> {
    let mut out = Vec::new();
    for seg in segs {
        if let Some(role) = seg.style.role.as_deref() {
            if role != "foreground" && !out.contains(&role) {
                out.push(role);
            }
        }
    }
    out
}

fn text_ops(ops: &[ChromePaintOp]) -> Vec<&ChromePaintOp> {
    ops.iter()
        .filter(|op| matches!(op, ChromePaintOp::Text { .. }))
        .collect()
}

fn op_line(op: &ChromePaintOp) -> &str {
    match op {
        ChromePaintOp::Text { lines, .. } => lines.first().map(String::as_str).unwrap_or(""),
        ChromePaintOp::Live { .. } => "",
    }
}

fn op_y(op: &ChromePaintOp) -> i64 {
    match op {
        ChromePaintOp::Text { rect, .. } | ChromePaintOp::Live { rect, .. } => rect.y,
    }
}

fn op_x(op: &ChromePaintOp) -> i64 {
    match op {
        ChromePaintOp::Text { rect, .. } | ChromePaintOp::Live { rect, .. } => rect.x,
    }
}

fn op_w(op: &ChromePaintOp) -> i64 {
    match op {
        ChromePaintOp::Text { rect, .. } | ChromePaintOp::Live { rect, .. } => rect.w,
    }
}

fn op_prominence(op: &ChromePaintOp) -> Option<f64> {
    match op {
        ChromePaintOp::Text { style, .. } | ChromePaintOp::Live { style, .. } => style.prominence,
    }
}

fn find_text<'a>(
    ops: &'a [ChromePaintOp],
    pred: impl Fn(&str) -> bool,
) -> Option<&'a ChromePaintOp> {
    text_ops(ops).into_iter().find(|op| pred(op_line(op)))
}

fn row_text(ops: &[ChromePaintOp], y: i64) -> String {
    ops.iter().filter(|op| op_y(op) == y).map(op_line).collect()
}

fn round5(n: f64) -> f64 {
    let text = format!("{n:.5}");
    text.parse().expect("rounded fraction is a float")
}

fn hit(key: &str, rect: Rect, user_select: UserSelect, element_kind: Option<&str>) -> MaskHit {
    MaskHit {
        key: key.to_string(),
        hit_rect: rect,
        user_select,
        phantom: false,
        element_kind: element_kind.map(str::to_string),
    }
}

fn note<T, U>(failures: &mut Vec<String>, field: &str, got: T, want: U)
where
    T: PartialEq<U> + std::fmt::Debug,
    U: std::fmt::Debug,
{
    if got != want {
        failures.push(format!("{field}: got {got:?} want {want:?}"));
    }
}

#[derive(Debug, PartialEq)]
enum MaskRow {
    Chrome { x: i64, y: i64, on: bool },
    Selectable { x: i64, y: i64, on: bool },
    Key { x: i64, y: i64, key: String },
}

#[test]
fn chrome_geometry_glyphs_progress_and_edge_voices() {
    let mut failures = Vec::new();
    note(
        &mut failures,
        "empty frame",
        (
            chrome_frame_text_width(40),
            chrome_frame_total_height(1, false),
            chrome_frame_body_lines("", 40, None),
        ),
        (36, 3, vec![" ".to_string()]),
    );
    note(&mut failures, "text inset", chrome_frame_text_inset(), 3);

    let body = chrome_frame_body_from_content_segs(
        &[ChromeSeg::plain("LM Studio")],
        40,
        &ChromeBodyContentOpts {
            glyph: Some("›".to_string()),
            ..ChromeBodyContentOpts::default()
        },
    );
    let counted = chrome_frame_body_from_content_segs(
        &[ChromeSeg::plain("Keep AUTH_SECRET")],
        40,
        &ChromeBodyContentOpts {
            glyph: Some("1".to_string()),
            ..ChromeBodyContentOpts::default()
        },
    );
    note(
        &mut failures,
        "content mark",
        body.iter()
            .take(3)
            .map(|seg| seg.text.as_str())
            .collect::<Vec<_>>(),
        vec!["│", "›", " "],
    );
    note(
        &mut failures,
        "content leads with the draft",
        body[3].text.starts_with("LM Studio"),
        true,
    );
    note(
        &mut failures,
        "content chevron voice",
        voice(&body, |text| text == "›"),
        Some((Some("foreground"), Some(FgP::PRIMARY), true)),
    );
    note(
        &mut failures,
        "counted mark",
        counted
            .iter()
            .take(3)
            .map(|seg| seg.text.as_str())
            .collect::<Vec<_>>(),
        vec!["│", "1", " "],
    );
    note(
        &mut failures,
        "counted digit voice",
        voice(&counted, |text| text == "1"),
        Some((Some("muted"), Some(FgP::GHOST), false)),
    );

    let joined = chrome_frame_bottom_segs(
        20,
        &ChromeBottomOpts {
            plain: true,
            join: true,
            ..ChromeBottomOpts::default()
        },
    );
    let joined_top = chrome_frame_top_segs(
        20,
        &[],
        &ChromeTopOpts {
            join: true,
            ..ChromeTopOpts::default()
        },
    );
    note(
        &mut failures,
        "join corners",
        (
            joined[0].text.as_str(),
            joined.last().expect("join has a corner").text.as_str(),
            joined_top[0].text.as_str(),
            joined_top.last().expect("join has a corner").text.as_str(),
        ),
        (
            CHROME_FRAME_JOIN.left,
            CHROME_FRAME_JOIN.right,
            CHROME_FRAME_JOIN.left,
            CHROME_FRAME_JOIN.right,
        ),
    );

    let half = progress_fill_segments(20.0, 0.5);
    let frac = progress_fill_segments(20.0, 0.525);
    let full = progress_fill_segments(10.0, 1.0);
    note(
        &mut failures,
        "half fill",
        (half.full, half.frac, half.rest, half.total),
        (10, 0.0, 10, 20),
    );
    note(
        &mut failures,
        "fractional fill",
        (frac.full, round5(frac.frac), frac.rest, frac.total),
        (10, 0.5, 9, 20),
    );
    note(
        &mut failures,
        "full fill",
        (full.full, full.frac, full.rest, full.total),
        (10, 0.0, 0, 10),
    );
    note(
        &mut failures,
        "ramp",
        [
            progress_ramp_prominence(0.0),
            progress_ramp_prominence(0.5),
            progress_ramp_prominence(1.0),
        ],
        [0.0, FgP::PRIMARY * 0.5, FgP::PRIMARY],
    );
    note(
        &mut failures,
        "ramp rises",
        progress_ramp_prominence(0.8) > progress_ramp_prominence(0.2),
        true,
    );
    note(
        &mut failures,
        "glow",
        [
            progress_glow_tint(1.0, 0.75),
            progress_glow_tint(0.75, 0.75),
            progress_glow_tint(0.375, 0.75),
            progress_glow_tint(0.0, 0.75),
        ],
        [0.0, 0.0, 0.5, 1.0],
    );

    let omitted = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            status_items: vec![ChromeStatusItem::furniture("act")],
            ..ChromeBottomOpts::default()
        },
    );
    let warning = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            progress: Some(0.5),
            progress_role: Some("warning".to_string()),
            ..ChromeBottomOpts::default()
        },
    );
    let def_fill = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            progress: Some(0.5),
            ..ChromeBottomOpts::default()
        },
    );
    let omitted_roles: Vec<&str> = omitted
        .iter()
        .map(|seg| seg.style.role.as_deref().unwrap_or("foreground"))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    note(
        &mut failures,
        "omitted has foreground",
        omitted_roles.contains(&"foreground"),
        true,
    );
    note(&mut failures, "omitted role count", omitted_roles.len(), 1);
    note(
        &mut failures,
        "omitted hue",
        hue_roles(&omitted),
        Vec::<&str>::new(),
    );
    note(
        &mut failures,
        "warning hue",
        hue_roles(&warning),
        vec!["warning"],
    );
    let unknown = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            progress: Some(0.5),
            progress_role: Some("not-a-role".to_string()),
            ..ChromeBottomOpts::default()
        },
    );
    note(
        &mut failures,
        "default fill hue",
        hue_roles(&def_fill),
        Vec::<&str>::new(),
    );
    note(
        &mut failures,
        "unknown progress role writes no hue",
        hue_roles(&unknown),
        Vec::<&str>::new(),
    );
    note(
        &mut failures,
        "default progress role",
        CHROME_FRAME_DEFAULT_PROGRESS_ROLE,
        "foreground",
    );

    let healthy = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            progress: Some(1.0),
            ..ChromeBottomOpts::default()
        },
    );
    let warming = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            progress: Some(0.35),
            ..ChromeBottomOpts::default()
        },
    );
    let yielded = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            progress: Some(0.35),
            contour_role: Some("emphasis".to_string()),
            ..ChromeBottomOpts::default()
        },
    );
    let tint_of = |segs: &[ChromeSeg]| -> (f64, Option<String>) {
        match segs.iter().find(|seg| seg.style.tint.is_some()) {
            Some(seg) => (seg.style.tint.unwrap_or(0.0), seg.style.tint_role.clone()),
            None => (0.0, None),
        }
    };
    note(&mut failures, "healthy tint", tint_of(&healthy).0, 0.0);
    note(
        &mut failures,
        "healthy hue",
        hue_roles(&healthy),
        Vec::<&str>::new(),
    );
    let (warming_tint, warming_role) = tint_of(&warming);
    note(
        &mut failures,
        "warming tint is hot",
        warming_tint > 0.0,
        true,
    );
    note(
        &mut failures,
        "warming tint role",
        warming_role.as_deref(),
        Some("warning"),
    );
    note(
        &mut failures,
        "warming hue",
        hue_roles(&warming),
        Vec::<&str>::new(),
    );
    note(&mut failures, "yielded tint", tint_of(&yielded).0, 0.0);
    note(
        &mut failures,
        "yielded hue",
        hue_roles(&yielded),
        vec!["emphasis"],
    );

    let top = chrome_frame_top_segs(
        48,
        &[
            ChromeHotkey::new("Enter", "send"),
            ChromeHotkey::new("Esc", "cancel"),
        ],
        &ChromeTopOpts {
            annotation: Some("idle".to_string()),
            ..ChromeTopOpts::default()
        },
    );
    let cover = chrome_frame_top_segs(
        48,
        &[
            ChromeHotkey::new("Enter", "Allow"),
            ChromeHotkey::new("Esc", "Deny"),
        ],
        &ChromeTopOpts {
            annotation: Some("edit **a.ts**".to_string()),
            ..ChromeTopOpts::default()
        },
    );
    let bot = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            status_items: vec![ChromeStatusItem::furniture("act")],
            ..ChromeBottomOpts::default()
        },
    );
    let auto = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            status_items: vec![
                ChromeStatusItem::furniture("llama3"),
                ChromeStatusItem::signal("auto", "auto"),
            ],
            ..ChromeBottomOpts::default()
        },
    );
    let attention = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            status_items: vec![ChromeStatusItem::signal("always approve", "attention")],
            ..ChromeBottomOpts::default()
        },
    );
    let tinted = chrome_frame_bottom_segs(
        40,
        &ChromeBottomOpts {
            contour_role: Some("warning".to_string()),
            ..ChromeBottomOpts::default()
        },
    );
    let fg = Some("foreground");
    let ghost = Some((fg, Some(FgP::GHOST), false));
    let primary = Some((fg, Some(FgP::PRIMARY), false));
    note(
        &mut failures,
        "edge voices",
        vec![
            ("enter", voice(&top, |text| text == "⏎")),
            ("send", voice(&top, |text| text.contains("send"))),
            ("esc", voice(&top, |text| text == "Esc")),
            ("cancel", voice(&top, |text| text.contains("cancel"))),
            ("idle", voice(&top, |text| text.contains("idle"))),
            ("edit", voice(&cover, |text| text.contains("edit"))),
            ("file", voice(&cover, |text| text == "a.ts")),
            ("act", voice(&bot, |text| text.contains("act"))),
            ("auto", voice(&auto, |text| text.contains("auto"))),
            ("auto corner", voice(&auto, |text| text == "╰")),
            ("model", voice(&auto, |text| text.contains("llama3"))),
            (
                "attention",
                voice(&attention, |text| text.contains("always approve")),
            ),
            ("attention corner", voice(&attention, |text| text == "╰")),
            ("tinted corner", voice(&tinted, |text| text == "╰")),
        ],
        vec![
            ("enter", primary),
            ("send", ghost),
            ("esc", primary),
            ("cancel", ghost),
            ("idle", ghost),
            ("edit", ghost),
            ("file", primary),
            ("act", ghost),
            ("auto", Some((Some("auto"), Some(FgP::SECONDARY), false))),
            ("auto corner", ghost),
            ("model", ghost),
            (
                "attention",
                Some((Some("attention"), Some(FgP::SECONDARY), false)),
            ),
            ("attention corner", ghost),
            (
                "tinted corner",
                Some((Some("warning"), Some(FgP::GHOST), false)),
            ),
        ],
    );

    let long_file = "generated-super-califragilistic-expialidocious-component-module.ts";
    let long_ann = chrome_frame_top_segs(
        48,
        &[
            ChromeHotkey::new("Enter", "Allow"),
            ChromeHotkey::new("Esc", "Deny"),
        ],
        &ChromeTopOpts {
            annotation: Some(format!("edit **{long_file}**")),
            ..ChromeTopOpts::default()
        },
    );
    let long_texts: HashSet<&str> = long_ann.iter().map(|seg| seg.text.as_str()).collect();
    note(
        &mut failures,
        "long annotation keeps the chords",
        ["⏎", ": ", "Allow", " · ", "Esc", ": ", "Deny"]
            .iter()
            .all(|text| long_texts.contains(text)),
        true,
    );
    note(
        &mut failures,
        "long annotation ellipsis",
        long_ann
            .iter()
            .rev()
            .find(|seg| seg.text.contains('…'))
            .map(|seg| seg.text.as_str()),
        Some("gen…module.ts"),
    );
    let empty_top = chrome_frame_top_segs(40, &[], &ChromeTopOpts::default());
    let empty_bot = chrome_frame_bottom_segs(40, &ChromeBottomOpts::default());
    note(
        &mut failures,
        "rule tails",
        [
            line_of(&top).ends_with(" ─╮"),
            line_of(&cover).ends_with(" ─╮"),
            line_of(&bot).ends_with(" ─╯"),
            line_of(&empty_top).ends_with("─╮"),
            line_of(&empty_bot).ends_with("─╯"),
        ],
        [true, true, true, true, true],
    );
    note(
        &mut failures,
        "rule widths",
        (
            display_width(&line_of(&top)),
            display_width(&line_of(&empty_top)),
            display_width(&line_of(&empty_bot)),
            display_width(&line_of(&bot)),
        ),
        (48, 40, 40, 40),
    );

    let geom = measure_chrome_frame(&ChromeFrame::new(40, "hi\nthere"), 40, 20);
    let wrapped = chrome_frame_body_lines("hi\nthere", 40, None);
    note(
        &mut failures,
        "geom tracks the wrap",
        (geom.body_h, geom.total_h, geom.glyph.as_str()),
        (
            wrapped.len() as i64,
            chrome_frame_total_height(wrapped.len() as i64, false),
            CHROME_FRAME_DEFAULT_GLYPH,
        ),
    );
    note(
        &mut failures,
        "geom body and total",
        (geom.body_h, geom.total_h),
        (2, 4),
    );
    note(&mut failures, "geom text width", geom.text_w, 36);
    note(&mut failures, "geom outer width", geom.outer_w, 40);
    note(
        &mut failures,
        "geom body lines",
        geom.body_lines,
        vec!["hi".to_string(), "there".to_string()],
    );
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn non_interactive_whispers_the_draft_not_shortcut_keys() {
    let mut frame = ChromeFrame::new(48, "shadowed");
    frame.hotkeys = vec![
        ChromeHotkey::new("Enter", "Allow"),
        ChromeHotkey::new("Esc", "Deny"),
    ];
    frame.interactive = Some(false);
    let paint = chrome_frame_paint_ops(&frame, Rect::new(0, 0, 48, 5));
    let enter = find_text(&paint.ops, |text| text == "⏎").expect("enter chord");
    let allow = find_text(&paint.ops, |text| text.contains("Allow")).expect("allow");
    let body = find_text(&paint.ops, |text| text.contains("shadowed")).expect("draft");
    let colon = find_text(&paint.ops, |text| text == ": ").expect("colon");
    assert_eq!(op_prominence(enter), Some(FgP::PRIMARY));
    assert_eq!(op_y(enter), 0);
    assert_eq!(op_prominence(allow), Some(FgP::GHOST));
    assert_eq!(op_y(allow), 0);
    assert_eq!(op_prominence(body), Some(FgP::WHISPER));
    assert_eq!(op_y(body), 1);
    assert_eq!(op_w(enter), 2);
    assert_eq!(op_x(colon) - op_x(enter), 2);
}

#[test]
fn selected_recap_raises_the_contour_and_read_only_keeps_body_voice() {
    let mut selected = ChromeFrame::new(40, "pin");
    selected.read_only = true;
    selected.selected = true;
    selected.plain_bottom = true;
    let selected = chrome_frame_paint_ops(&selected, Rect::new(0, 0, 40, 4));
    let mut neighbor = ChromeFrame::new(40, "other");
    neighbor.read_only = true;
    neighbor.plain_bottom = true;
    let neighbor = chrome_frame_paint_ops(&neighbor, Rect::new(0, 0, 40, 4));
    let corner_prominence = |ops: &[ChromePaintOp]| {
        op_prominence(
            find_text(ops, |text| text == "╭" || text.starts_with('╭')).expect("top corner"),
        )
    };
    assert_eq!(corner_prominence(&selected.ops), Some(FgP::PRIMARY));
    assert_eq!(corner_prominence(&neighbor.ops), Some(FgP::GHOST));

    let mut recap = ChromeFrame::new(48, "rotate AUTH_SECRET");
    recap.annotation = Some("Auth refactor".to_string());
    recap.interactive = Some(false);
    recap.read_only = true;
    let recap = chrome_frame_paint_ops(&recap, Rect::new(0, 0, 48, 5));
    let body =
        find_text(&recap.ops, |text| text.contains("rotate AUTH_SECRET")).expect("recap body");
    assert_eq!(op_prominence(body), Some(FgP::PRIMARY));

    let roman = chrome_frame_paint_ops(&ChromeFrame::new(40, "hello"), Rect::new(0, 0, 40, 5));
    let hello = find_text(&roman.ops, |text| text.contains("hello")).expect("draft");
    match hello {
        ChromePaintOp::Text { style, .. } => {
            assert_eq!(style.prominence, Some(FgP::PRIMARY));
            assert!(!style.bold);
        }
        ChromePaintOp::Live { .. } => panic!("draft is a text op"),
    }
}

#[test]
fn window_join_and_stacked_rules_keep_their_rows() {
    let mut window = ChromeFrame::new(40, "");
    window.body_seg_rows = vec![
        vec![ChromeSegSpec::plain(" ")],
        vec![ChromeSegSpec::plain(" ")],
    ];
    window.annotation = Some("Explore".to_string());
    window.hotkeys = vec![ChromeHotkey::new("Esc", "close")];
    window.hotkeys_bottom = true;
    let window = chrome_frame_paint_ops(&window, Rect::new(0, 0, 40, 6));
    let row_of = |needle: &str| {
        find_text(&window.ops, |text| text == needle || text.contains(needle)).map(op_y)
    };
    assert_eq!(
        (
            row_of("Explore"),
            row_of("Esc"),
            row_of("close"),
            row_of("╭"),
            row_of("╰")
        ),
        (Some(0), Some(3), Some(3), Some(0), Some(3))
    );

    let mut join_top = ChromeFrame::new(20, "hi");
    join_top.join_top = true;
    join_top.plain_bottom = true;
    let join_top = chrome_frame_paint_ops(&join_top, Rect::new(0, 0, 20, 4));
    let top = row_text(&join_top.ops, 0);
    assert!(top.starts_with(CHROME_FRAME_JOIN.left));
    assert!(top.ends_with(CHROME_FRAME_JOIN.right));

    let mut stacked = ChromeFrame::new(48, "");
    stacked.body_seg_rows = vec![vec![ChromeSegSpec::plain("q  invoices")]];
    stacked.join_bottom = true;
    stacked.plain_bottom = true;
    stacked.hotkeys = vec![
        ChromeHotkey::new("Enter", "Allow"),
        ChromeHotkey::new("Esc", "Deny"),
    ];
    stacked.annotation = Some("Gmail **send email**".to_string());
    assert!(chrome_frame_has_hint(&stacked));
    let stacked_paint = chrome_frame_paint_ops(&stacked, Rect::new(0, 0, 48, 8));
    let row_of = |needle: &str| {
        find_text(&stacked_paint.ops, |text| {
            text == needle || text.contains(needle)
        })
        .map(op_y)
    };
    assert_eq!(
        (
            row_of("Gmail"),
            row_of("send email"),
            row_of("⏎"),
            row_of("Allow"),
            row_of("q  invoices")
        ),
        (Some(0), Some(0), Some(2), Some(2), Some(1))
    );

    let mut titled = ChromeFrame::new(48, "");
    titled.body_seg_rows = vec![vec![ChromeSegSpec::plain("rm file")]];
    titled.join_bottom = true;
    titled.plain_bottom = true;
    titled.hotkeys = vec![
        ChromeHotkey::new("Enter", "Allow"),
        ChromeHotkey::new("Esc", "Deny"),
    ];
    titled.annotation = Some("run command".to_string());
    titled.join_annotation = Some("Auth refactor".to_string());
    let titled = chrome_frame_paint_ops(&titled, Rect::new(0, 0, 48, 8));
    let row_of = |needle: &str| {
        find_text(&titled.ops, |text| text == needle || text.contains(needle)).map(op_y)
    };
    assert_eq!(
        (
            row_of("run command"),
            row_of("Auth refactor"),
            row_of("Allow"),
            row_of("rm file")
        ),
        (Some(0), Some(2), Some(2), Some(1))
    );
}

#[test]
fn persist_mod_swaps_furniture_for_quota_and_keeps_occupancy_when_narrow() {
    let windows = vec![ChromeQuotaWindow {
        remaining_percent: 67.0,
        reset_at: Some(90.0 * 60.0),
    }];
    let status_items = vec![
        ChromeStatusItem::furniture("grok-4"),
        ChromeStatusItem::furniture("grok"),
        ChromeStatusItem::signal("auto", "auto"),
    ];
    let idle = chrome_frame_bottom_segs(
        80,
        &ChromeBottomOpts {
            status_items: status_items.clone(),
            quota_windows: windows.clone(),
            now_ms: Some(0.0),
            ..ChromeBottomOpts::default()
        },
    );
    let held = chrome_frame_bottom_segs(
        80,
        &ChromeBottomOpts {
            status_items: status_items.clone(),
            quota_windows: windows.clone(),
            mod_held: true,
            now_ms: Some(0.0),
            ..ChromeBottomOpts::default()
        },
    );
    let later = chrome_frame_bottom_segs(
        80,
        &ChromeBottomOpts {
            status_items,
            quota_windows: windows,
            mod_held: true,
            now_ms: Some(61_000.0),
            ..ChromeBottomOpts::default()
        },
    );
    assert!(line_of(&idle).contains("grok-4"));
    assert!(!line_of(&idle).contains("67%"));
    assert!(!line_of(&held).contains("grok-4"));
    assert!(line_of(&held).contains("67% left for 1 hour and 30 minutes"));
    assert!(line_of(&held).contains("auto"));
    assert!(held
        .iter()
        .any(|seg| matches!(seg.live, Some(ChromeLive::Quota { .. }))));
    assert!(line_of(&later).contains("1 hour and 29 minutes"));

    let windows = vec![ChromeQuotaWindow {
        remaining_percent: 51.0,
        reset_at: Some(5.0 * 3600.0),
    }];
    let status_items = vec![
        ChromeStatusItem::furniture("grok-4"),
        ChromeStatusItem::signal("auto", "auto"),
    ];
    let held_opts = ChromeBottomOpts {
        status_items: status_items.clone(),
        quota_windows: windows.clone(),
        context_used: Some(10_000.0),
        context_limit: Some(500_000.0),
        mod_held: true,
        now_ms: Some(0.0),
        ..ChromeBottomOpts::default()
    };
    let wide = chrome_frame_bottom_segs(80, &held_opts);
    let narrow = chrome_frame_bottom_segs(24, &held_opts);
    let tighter = chrome_frame_bottom_segs(16, &held_opts);
    assert!(line_of(&wide).contains("10k/500k · 51% left for 5 hours"));
    assert!(line_of(&narrow).contains("10k/500k"));
    assert!(!line_of(&narrow).contains("51%"));
    assert!(!narrow
        .iter()
        .any(|seg| matches!(seg.live, Some(ChromeLive::Quota { .. }))));
    assert!(!line_of(&tighter).contains("10k/500k"));
    assert!(line_of(&narrow).contains("auto"));

    let held = chrome_frame_bottom_segs(
        80,
        &ChromeBottomOpts {
            status_items: vec![
                ChromeStatusItem::furniture("grok-4"),
                ChromeStatusItem::furniture("grok"),
            ],
            quota_windows: windows,
            context_used: Some(10_000.0),
            context_limit: Some(500_000.0),
            mod_held: true,
            now_ms: Some(0.0),
            ..ChromeBottomOpts::default()
        },
    );
    let occupancy_only = chrome_frame_bottom_segs(
        80,
        &ChromeBottomOpts {
            status_items: vec![
                ChromeStatusItem::furniture("grok-4"),
                ChromeStatusItem::furniture("grok"),
            ],
            context_used: Some(10_000.0),
            context_limit: Some(500_000.0),
            mod_held: true,
            now_ms: Some(0.0),
            ..ChromeBottomOpts::default()
        },
    );
    assert!(line_of(&held).contains("10k/500k · 51% left for 5 hours"));
    assert!(line_of(&occupancy_only).contains("10k/500k"));
    assert!(!line_of(&held).contains("grok-4"));
    let live = held
        .iter()
        .find_map(|seg| seg.live.as_ref())
        .expect("quota live");
    match live {
        ChromeLive::Quota { prefix, .. } => assert_eq!(prefix.as_deref(), Some("10k/500k")),
    }
}

#[test]
fn composer_body_hit_and_mask_keep_the_text_column() {
    let paint = chrome_frame_paint_ops(
        &ChromeFrame::new(30, "hello\nworld"),
        Rect::new(0, 0, 30, 10),
    );
    assert_eq!(
        (
            paint.geom.body_h,
            paint.geom.total_h,
            paint.geom.glyph.as_str(),
            paint.geom.outer_w,
            paint.body_hit,
            display_width(&row_text(&paint.ops, 1)) as i64,
        ),
        (
            2,
            4,
            CHROME_FRAME_DEFAULT_GLYPH,
            30,
            Rect::new(3, 1, 26, 2),
            30,
        )
    );

    let place = Rect::new(0, 0, paint.geom.outer_w, paint.geom.total_h);
    let body = hit(
        "composer",
        paint.body_hit,
        UserSelect::Contain,
        Some("chrome_frame"),
    );
    let frame = MaskFrame {
        hit_list: vec![body.clone()],
        by_key: vec![
            hit(
                "composer:chrome",
                place,
                UserSelect::None,
                Some("chrome_frame_chrome"),
            ),
            body,
            hit(
                "composer:progress",
                paint.progress_hit,
                UserSelect::None,
                Some("chrome_frame_progress"),
            ),
        ],
    };
    let mask = build_chrome_mask(&frame, 0, 0, 39, 9, 40, 10);
    let y = paint.body_hit.y;
    let x = paint.body_hit.x;
    assert_eq!(
        vec![
            MaskRow::Chrome {
                x: 0,
                y,
                on: mask.is_chrome(0, y),
            },
            MaskRow::Selectable {
                x: 0,
                y,
                on: mask.is_selectable(0, y),
            },
            MaskRow::Chrome {
                x: 2,
                y,
                on: mask.is_chrome(2, y),
            },
            MaskRow::Chrome {
                x: 29,
                y,
                on: mask.is_chrome(29, y),
            },
            MaskRow::Selectable {
                x,
                y,
                on: mask.is_selectable(x, y),
            },
            MaskRow::Selectable {
                x: x + 1,
                y,
                on: mask.is_selectable(x + 1, y),
            },
            MaskRow::Key {
                x: x + 1,
                y,
                key: mask.selectable_key(x + 1, y).to_string(),
            },
            MaskRow::Chrome {
                x: 0,
                y: 0,
                on: mask.is_chrome(0, 0),
            },
            MaskRow::Chrome {
                x: 0,
                y: 3,
                on: mask.is_chrome(0, 3),
            },
            MaskRow::Chrome {
                x: 39,
                y: 9,
                on: mask.is_chrome(39, 9),
            },
            MaskRow::Selectable {
                x: 39,
                y: 9,
                on: mask.is_selectable(39, 9),
            },
            MaskRow::Key {
                x: 39,
                y: 9,
                key: mask.selectable_key(39, 9).to_string(),
            },
        ],
        vec![
            MaskRow::Chrome { x: 0, y, on: true },
            MaskRow::Selectable { x: 0, y, on: false },
            MaskRow::Chrome { x: 2, y, on: true },
            MaskRow::Chrome { x: 29, y, on: true },
            MaskRow::Selectable { x, y, on: true },
            MaskRow::Selectable {
                x: x + 1,
                y,
                on: true,
            },
            MaskRow::Key {
                x: x + 1,
                y,
                key: "composer".to_string(),
            },
            MaskRow::Chrome {
                x: 0,
                y: 0,
                on: true,
            },
            MaskRow::Chrome {
                x: 0,
                y: 3,
                on: true,
            },
            MaskRow::Chrome {
                x: 39,
                y: 9,
                on: false,
            },
            MaskRow::Selectable {
                x: 39,
                y: 9,
                on: false,
            },
            MaskRow::Key {
                x: 39,
                y: 9,
                key: String::new(),
            },
        ]
    );

    let leaf = MaskFrame {
        hit_list: vec![
            hit(
                "code",
                Rect::new(2, 1, 2, 1),
                UserSelect::Text,
                Some("text"),
            ),
            hit(
                "stage",
                Rect::new(0, 0, 6, 3),
                UserSelect::Text,
                Some("box"),
            ),
        ],
        by_key: vec![hit("half", Rect::new(0, 0, 4, 3), UserSelect::None, None)],
    };
    let leaf_mask = build_chrome_mask(&leaf, 0, 0, 5, 2, 6, 3);
    assert_eq!(
        vec![
            MaskRow::Chrome {
                x: 0,
                y: 0,
                on: leaf_mask.is_chrome(0, 0),
            },
            MaskRow::Selectable {
                x: 0,
                y: 0,
                on: leaf_mask.is_selectable(0, 0),
            },
            MaskRow::Selectable {
                x: 2,
                y: 1,
                on: leaf_mask.is_selectable(2, 1),
            },
            MaskRow::Key {
                x: 2,
                y: 1,
                key: leaf_mask.selectable_key(2, 1).to_string(),
            },
            MaskRow::Chrome {
                x: 1,
                y: 1,
                on: leaf_mask.is_chrome(1, 1),
            },
            MaskRow::Selectable {
                x: 5,
                y: 1,
                on: leaf_mask.is_selectable(5, 1),
            },
            MaskRow::Key {
                x: 5,
                y: 1,
                key: leaf_mask.selectable_key(5, 1).to_string(),
            },
        ],
        vec![
            MaskRow::Chrome {
                x: 0,
                y: 0,
                on: true,
            },
            MaskRow::Selectable {
                x: 0,
                y: 0,
                on: false,
            },
            MaskRow::Selectable {
                x: 2,
                y: 1,
                on: true,
            },
            MaskRow::Key {
                x: 2,
                y: 1,
                key: "code".to_string(),
            },
            MaskRow::Chrome {
                x: 1,
                y: 1,
                on: true,
            },
            MaskRow::Selectable {
                x: 5,
                y: 1,
                on: true,
            },
            MaskRow::Key {
                x: 5,
                y: 1,
                key: "stage".to_string(),
            },
        ]
    );
    let bare = no_chrome();
    assert_eq!(
        (
            bare.is_selectable(3, 1),
            bare.is_chrome(0, 0),
            bare.selectable_key(1, 1),
            intersect_rects(Rect::new(0, 0, 2, 2), Rect::new(3, 3, 1, 1)).is_none(),
        ),
        (false, false, "", true)
    );

    let mut placeholder = ChromeFrame::new(30, "");
    placeholder.placeholder = Some("type here".to_string());
    let placeholder_paint = chrome_frame_paint_ops(&placeholder, Rect::new(0, 0, 30, 10));
    let hint =
        find_text(&placeholder_paint.ops, |text| text.contains("type here")).expect("placeholder");
    let hint_prominence = op_prominence(hint);
    let hint_role = match hint {
        ChromePaintOp::Text { style, .. } => style.role.clone(),
        ChromePaintOp::Live { .. } => panic!("placeholder is text"),
    };
    assert_eq!(
        (
            is_chrome_frame_showing_placeholder(&placeholder),
            chrome_frame_body_lines("", 30, Some("type here")),
            hint_prominence,
            hint_role.as_deref(),
            is_chrome_frame_showing_placeholder(&ChromeFrame::new(30, "")),
        ),
        (
            true,
            vec!["type here".to_string()],
            Some(FgP::GHOST),
            Some("muted"),
            false,
        )
    );
}

// BLOCKED — `layout()` / `containRegionAt` / selection live in the place walk
// (`layout/engine.ts`, `layout/selection.ts`). This module paints the frame and
// masks cells; it does not build `byKey` userSelect or clamp a gesture.
// Assertion text from `layout/__tests__/chrome.test.ts`, not weakened:
//
// userSelect: "contain"
// hit: { x: 3, y: 1, w: 26, h: 2 }
// inside: { key: "composer", rect: { x: 3, y: 1, w: 26, h: 2 } }
// sideBar: null
// rightBar: null
// glyph: null
// userSelect: "contain", region: "composer"          (empty draft)
// userSelect: "none", region: null                   (placeholder)
// containRegionAt(outside box, 5, 2) === null
// active: { col: 29, row: 7 }
// mid: [10, 29]
// above: null
// below: null
// anchor: { col: 10, row: 6 }
// active: { col: 29, row: 6 }
// contain: { x: 10, y: 5, w: 20, h: 3 }
// cols: [10, 29]
// body: "none", chrome: "none"                       (bodyUserSelect: "none")
//
// `body_hit` for the composer case is asserted above as { x: 3, y: 1, w: 26, h: 2 }.
// The containRegionAt / userSelect results are not.

fn chord(key: &str, ctrl: bool, shift: bool) -> ChordMods {
    ChordMods {
        key: key.to_string(),
        ctrl,
        alt: false,
        meta: false,
        shift,
    }
}

#[test]
fn hotkey_glyphs_reveal_and_chord_match() {
    assert_eq!(paint_hotkey_chord("Enter"), "⏎");
    assert_eq!(paint_hotkey_chord("Shift+Enter"), "⇧ ⏎");
    assert_eq!(paint_hotkey_chord("Tab"), "⇥");
    assert_eq!(paint_hotkey_chord("escape"), "Esc");
    assert_eq!(paint_hotkey_chord("Ctrl+Enter"), "⌃ ⏎");
    assert_eq!(paint_hotkey_chord("Ctrl+Shift+Enter"), "⌃ ⇧ ⏎");
    assert_eq!(paint_hotkey_chord("Cmd+Enter"), "⌘ ⏎");
    assert_eq!(paint_hotkey_chord("Ctrl+C"), "⌃ C");
    assert_eq!(paint_hotkey_chord("control-x"), "⌃x");
    assert_eq!(paint_hotkey_chord("C-x"), "⌃x");

    let mixed = vec![
        ChromeHotkey::new("Enter", "Allow"),
        ChromeHotkey::new("Esc", "Deny"),
        ChromeHotkey::new("Ctrl+Enter", "Allow this session"),
        ChromeHotkey::new("Ctrl+Shift+Enter", "Always allow"),
    ];
    let shown: Vec<String> = reveal_hotkeys(&mixed, false)
        .iter()
        .map(format_hotkey)
        .collect();
    assert_eq!(shown, ["Enter: Allow", "Esc: Deny", "Ctrl: More"]);
    let held: Vec<String> = reveal_hotkeys(&mixed, true)
        .iter()
        .map(format_hotkey)
        .collect();
    assert_eq!(
        held,
        [
            "Ctrl+Enter: Allow this session",
            "Ctrl+Shift+Enter: Always allow"
        ],
    );
    let cmd = vec![
        ChromeHotkey::new("Enter", "Allow"),
        ChromeHotkey::new("Cmd+Enter", "Always"),
    ];
    let cmd_shown: Vec<String> = reveal_hotkeys(&cmd, false)
        .iter()
        .map(format_hotkey)
        .collect();
    assert_eq!(cmd_shown, ["Enter: Allow", "Cmd: More"]);

    assert!(event_matches_chord(
        &chord("Enter", true, false),
        "Ctrl+Enter"
    ));
    assert!(!event_matches_chord(
        &chord("Enter", false, false),
        "Ctrl+Enter"
    ));
    assert!(event_matches_chord(
        &chord("Enter", true, true),
        "Ctrl+Shift+Enter"
    ));
    assert!(event_matches_chord(&chord("x", true, false), "control-x"));
    assert!(event_matches_chord(&chord("x", true, false), "C-x"));
    assert!(parse_chord("Ctrl").is_none());
    assert!(parse_chord("").is_none());
}

#[test]
fn live_clock_quota_elapsed_and_countdown_move_with_the_caller_clock() {
    let early = resolve_spinner_glyph("thinking", 0.0);
    let later = resolve_spinner_glyph("thinking", 500.0);
    assert_ne!(early, later);
    assert_eq!(early.chars().count(), 1);
    assert_eq!(
        resolve_live_text(
            LiveFace::Spinner {
                profile: "thinking"
            },
            0.0
        ),
        early,
    );
    assert_eq!(
        resolve_live_text(
            LiveFace::Spinner {
                profile: "thinking"
            },
            500.0
        ),
        later,
    );

    let window = ChromeQuotaWindow {
        remaining_percent: 67.0,
        reset_at: Some(90.0 * 60.0),
    };
    let hours = ChromeQuotaWindow {
        remaining_percent: 67.0,
        reset_at: Some(7200.0),
    };
    assert_eq!(
        resolve_live_text(
            LiveFace::Quota {
                windows: &[hours],
                prefix: None,
            },
            0.0,
        ),
        "67% left for 2 hours",
    );
    let at_start = resolve_live_text(
        LiveFace::Quota {
            windows: &[window.clone()],
            prefix: None,
        },
        0.0,
    );
    let a_minute_later = resolve_live_text(
        LiveFace::Quota {
            windows: &[window],
            prefix: None,
        },
        61_000.0,
    );
    assert_eq!(at_start, "67% left for 1 hour and 30 minutes");
    assert_eq!(a_minute_later, "67% left for 1 hour and 29 minutes");
    assert_ne!(at_start, a_minute_later);
    let occupied = ChromeQuotaWindow {
        remaining_percent: 51.0,
        reset_at: Some(5.0 * 3600.0),
    };
    assert_eq!(
        resolve_live_text(
            LiveFace::Quota {
                windows: &[occupied],
                prefix: Some("10k/500k"),
            },
            0.0,
        ),
        "10k/500k · 51% left for 5 hours",
    );
    let expired = ChromeQuotaWindow {
        remaining_percent: 9.0,
        reset_at: Some(5.0 * 3600.0),
    };
    assert_eq!(
        resolve_live_text(
            LiveFace::Quota {
                windows: &[expired],
                prefix: None,
            },
            5.0 * 3600.0 * 1000.0,
        ),
        "",
    );

    assert_eq!(format_elapsed_compact(3000.0), "3.0s");
    assert_eq!(format_elapsed_compact(3400.0), "3.4s");
    assert_eq!(
        resolve_live_text(
            LiveFace::Elapsed {
                started_at: 0.0,
                label: None,
                prefix: None,
            },
            3000.0,
        ),
        "thinking · 3.0s",
    );
    assert_eq!(
        resolve_live_text(
            LiveFace::Elapsed {
                started_at: 0.0,
                label: Some("waiting for response..."),
                prefix: None,
            },
            3400.0,
        ),
        "waiting for response... · 3.4s",
    );

    assert_eq!(
        resolve_live_text(LiveFace::Countdown { until_ms: 5_000.0 }, 0.0),
        "Failed to request; retrying in 5 seconds",
    );
    assert_eq!(
        resolve_live_text(LiveFace::Countdown { until_ms: 1_000.0 }, 0.0),
        "Failed to request; retrying in 1 second",
    );
    assert_eq!(
        resolve_live_text(LiveFace::Countdown { until_ms: 5_000.0 }, 1_500.0),
        "Failed to request; retrying in 4 seconds",
    );
    assert_eq!(
        resolve_live_text(LiveFace::Countdown { until_ms: 0.0 }, 500.0),
        "Failed to request; retrying in 0 seconds",
    );

    let elapsed = live_text(
        "thinking · 99m 99s",
        LivePaint::Elapsed {
            hz: 2,
            started_at: 0.0,
            label: None,
            prefix: None,
        },
    );
    let elapsed_frame = layout(&elapsed, Viewport { w: 80, h: 2 }, LayoutOpts::default());
    let at_three = painted(&elapsed_frame, 80, 2, 3_000.0);
    let at_three_four = painted(&elapsed_frame, 80, 2, 3_400.0);
    assert!(at_three.contains("thinking · 3.0s"), "{at_three}");
    assert!(at_three_four.contains("thinking · 3.4s"), "{at_three_four}");
    assert_ne!(at_three, at_three_four);
    assert!(!at_three.contains('⠋'), "{at_three}");
    assert!(!at_three.contains("99m"), "{at_three}");

    let countdown = live_text(
        "Failed to request; retrying in 999 seconds",
        LivePaint::Countdown {
            hz: 2,
            until_ms: 5_000.0,
        },
    );
    let countdown_frame = layout(&countdown, Viewport { w: 80, h: 2 }, LayoutOpts::default());
    let five = painted(&countdown_frame, 80, 2, 0.0);
    let four = painted(&countdown_frame, 80, 2, 1_500.0);
    assert!(five.contains("retrying in 5 seconds"), "{five}");
    assert!(four.contains("retrying in 4 seconds"), "{four}");
    assert_ne!(five, four);
    assert!(!five.contains('⠋'), "{five}");
    assert!(!five.contains("999"), "{five}");
}

fn live_text(measure: &str, live: LivePaint) -> Node {
    Node::Text {
        content: measure.to_string(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: qd::Style::default(),
        key: Some("clock".to_string()),
        live: Some(live),
        region_prominence: None,
    }
}

#[test]
fn slash_picker_paints_its_row_and_command_list_on_the_chrome_frame() {
    let mut connect = PickerRow::named("/connect");
    connect.description = Some("Bind a source".to_string());
    let mut model = PickerRow::named("/model");
    model.description = Some("Session model".to_string());
    let rows = [connect, model];
    let paint = paint_picker(&PickerPaintInput {
        rows: &rows,
        selected_key: Some("choice:1:/model"),
        scroll_offset: 0,
        hover_key: None,
        press_key: None,
        viewport: Some(8),
        text_w: Some(chrome_frame_text_width(48)),
    });
    assert_eq!(
        paint
            .body_glyphs
            .iter()
            .map(|glyph| glyph.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        [" ", "›"],
    );
    let mut frame = ChromeFrame::new(48, "");
    frame.body_seg_rows = paint.body_seg_rows;
    frame.body_glyphs = paint.body_glyphs;
    frame.body_right_coverage = paint.body_right_coverage;
    frame.plain_bottom = true;
    frame.join_bottom = true;
    let node = Node::Chrome {
        key: Some("slash-complete".to_string()),
        frame: frame.clone(),
    };
    let measured = measure_tree(&node, 48, 12, None);
    let geom = measure_chrome_frame(&frame, 48, 12);
    assert_eq!(
        (measured.w, measured.h),
        (48.min(geom.outer_w).max(0), 12.min(geom.total_h).max(0)),
    );
    assert!(measured.w > 0 && measured.h > 2, "{measured:?}");
    let laid = layout(&node, Viewport { w: 48, h: 12 }, LayoutOpts::default());
    let mut buf = create_buffer(48, 12);
    paint_frame(&laid, &mut buf, 0.0, |style| style.clone());
    let mut text = String::new();
    for y in 0..buf.height() {
        for x in 0..buf.width() {
            text.push_str(cell_glyph(&buf, x, y));
        }
        text.push('\n');
    }
    assert!(text.contains("/connect"), "{text}");
    assert!(text.contains("/model"), "{text}");
    assert!(text.contains('›'), "{text}");
    assert_eq!(cell_glyph(&buf, 1, 1), " ");
    assert_eq!(cell_glyph(&buf, 1, 2), "›");
}

#[test]
fn quota_live_paints_a_later_clock_through_the_frame() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs_f64()
        * 1000.0;
    let reset_at = now_ms / 1000.0 + 90.0 * 60.0 + 30.0;
    let mut frame = ChromeFrame::new(80, "");
    frame.mod_held = true;
    frame.quota_windows = vec![ChromeQuotaWindow {
        remaining_percent: 67.0,
        reset_at: Some(reset_at),
    }];
    frame.status_items = vec![ChromeStatusItem::furniture("grok-4")];
    let node = Node::Chrome {
        key: Some("quota".to_string()),
        frame,
    };
    let laid = layout(&node, Viewport { w: 80, h: 8 }, LayoutOpts::default());
    let early = painted(&laid, 80, 8, now_ms);
    let later = painted(&laid, 80, 8, now_ms + 61_000.0);
    assert!(early.contains("% left for"), "{early}");
    assert!(later.contains("% left for"), "{later}");
    assert_ne!(early, later, "quota stayed frozen\n{early}\n{later}");
    assert!(!early.contains('⠋'), "{early}");
    assert!(!later.contains('⠋'), "{later}");
}

fn painted(frame: &qd::layout_engine::Frame, cols: usize, rows: usize, now_ms: f64) -> String {
    let mut buf = create_buffer(cols, rows);
    paint_frame(frame, &mut buf, now_ms, |style| style.clone());
    let mut text = String::new();
    for y in 0..buf.height() {
        for x in 0..buf.width() {
            text.push_str(cell_glyph(&buf, x, y));
        }
        text.push('\n');
    }
    text
}

#[test]
fn stacked_body_keeps_the_head_and_numbers_later_rows() {
    let lines: Vec<String> = (0..20).map(|index| format!("line-{index}")).collect();
    let window = paint_stacked_body(&StackedBodyInput {
        text: &lines.join("\n"),
        lang: "",
        numbered: false,
        scroll_offset: 0,
        viewport: 4,
        text_w: 40,
    });
    assert_eq!(window.body_seg_rows.len(), 4);
    assert!(window.body_seg_rows[0][0].text.contains("line-0"));
    assert!(window
        .body_seg_rows
        .iter()
        .all(|row| row.iter().all(|seg| !seg.text.contains("line-10"))));
    let later = paint_stacked_body(&StackedBodyInput {
        text: &lines.join("\n"),
        lang: "",
        numbered: false,
        scroll_offset: 10,
        viewport: 4,
        text_w: 40,
    });
    assert!(later.body_seg_rows[0][0].text.contains("line-10"));
    assert!(later
        .body_seg_rows
        .iter()
        .all(|row| row.iter().all(|seg| !seg.text.contains("line-0"))));

    let numbered = paint_stacked_body(&StackedBodyInput {
        text: "Keep AUTH_SECRET out of the module scope.\nAlso rotate the cookie name on logout.",
        lang: "",
        numbered: true,
        scroll_offset: 0,
        viewport: 0,
        text_w: 80,
    });
    assert_eq!(numbered.body_glyphs[0].as_deref(), Some("1"));
    assert_eq!(numbered.body_seg_rows[0][0].prominence, Some(FgP::PRIMARY));
    assert!(numbered.body_seg_rows[0][0].text.contains("AUTH_SECRET"));
    assert_eq!(numbered.body_glyphs[1].as_deref(), Some("2"));
    assert_eq!(numbered.body_seg_rows[1][0].prominence, Some(FgP::GHOST));
    assert!(numbered.body_seg_rows[1][0]
        .text
        .contains("Also rotate the cookie name on logout."));
}
