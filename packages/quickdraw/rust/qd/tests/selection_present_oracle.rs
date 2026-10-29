//! Transcript drag-select copies through OSC 52 and keeps the copy plaque's clock.
//! A draft range copies too. A paste of that slice puts back the clipboard from before the copy.

use std::sync::Mutex;

use qd::capabilities::{osc52_set, ClipboardSelect};
use qd::copy_toast::COPY_TOAST_ARM_MS;
use qd::layout_engine::{BoxStyle, Node};
use qd::layout_text::WhiteSpace;
use qd::present::{ComposerFace, Present, PresentEnv, PresentOpts, Up};
use qd::Style;

static CLIP: Mutex<&'static str> = Mutex::new("ZED");

fn boot() -> Present {
    Present::boot(PresentOpts {
        cols: 40,
        rows: 24,
        tty: false,
        ..PresentOpts::default()
    })
}

fn hello() -> Node {
    Node::Text {
        content: "hello".into(),
        white_space: Some(WhiteSpace::Nowrap),
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key: Some("line".into()),
        live: None,
        region_prominence: None,
    }
}

fn select_hell(session: &mut Present) {
    session.set_retained_scene(hello());
    let first = session.paint_if_needed(0);
    assert!(first.caused);
    assert!(session
        .push_input("\u{1b}[<0;1;1M", 10)
        .immediate
        .is_empty());
    assert!(session
        .push_input("\u{1b}[<32;4;1M", 20)
        .immediate
        .is_empty());
    let release = session.push_input("\u{1b}[<0;4;1m", 30);
    assert_eq!(
        release.immediate,
        osc52_set("hell\n", ClipboardSelect::Both),
        "release bytes {}",
        release.immediate
    );
}

#[test]
fn a_drag_copies_the_text_and_the_plaque_waits_out_its_arm() {
    let mut session = boot();
    select_hell(&mut session);
    let shown = session.paint_if_needed(30);
    assert!(shown.bytes.contains("Copied"), "{}", shown.bytes);
    assert!(!shown.bytes.contains("\u{1b}[?1003h"));

    let early = session.push_input("z", 100);
    assert!(early.immediate.is_empty());
    // A same-size resize is ignored. One extra column drops the diff base, so
    // the next frame is the whole screen and still carries the plaque.
    session.push_resize(41, 24);
    let stayed = session.paint_if_needed(100);
    assert!(
        stayed.bytes.contains("Copied"),
        "a key before the arm keeps the plaque"
    );

    let idle = session.paint_if_needed(30 + COPY_TOAST_ARM_MS - 1);
    assert!(idle.bytes.is_empty(), "{}", idle.bytes);
    let armed = session.paint_if_needed(30 + COPY_TOAST_ARM_MS);
    assert!(armed.bytes.contains("\u{1b}[?1003h"), "{}", armed.bytes);
    assert!(!armed.bytes.contains("\u{1b}[?1003l"));

    session.push_input("y", 30 + COPY_TOAST_ARM_MS);
    let dismissed = session.paint_if_needed(30 + COPY_TOAST_ARM_MS);
    assert!(!dismissed.bytes.contains("Copied"), "{}", dismissed.bytes);
    assert!(
        dismissed.bytes.contains("\u{1b}[?1003l"),
        "{}",
        dismissed.bytes
    );
}

#[test]
fn a_press_dismisses_the_plaque_before_the_arm_and_escape_is_not_delivered() {
    let mut session = boot();
    select_hell(&mut session);
    let shown = session.paint_if_needed(30);
    assert!(shown.bytes.contains("Copied"));

    session.push_input("\u{1b}[<0;1;2M", 40);
    let pressed = session.paint_if_needed(40);
    assert!(!pressed.bytes.contains("Copied"), "{}", pressed.bytes);
    session.push_input("\u{1b}[<0;1;2m", 41);

    select_hell(&mut session);
    session.paint_if_needed(50);
    session.push_input("\u{1b}", 60);
    session.paint_if_needed(100);
    let keys: Vec<String> = session
        .take_posted()
        .into_iter()
        .filter_map(|up| match up {
            qd::present::Up::InputEvents { events } => Some(
                events
                    .into_iter()
                    .map(|event| event.key)
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(keys.iter().all(|key| key != "Escape"), "{keys:?}");
}

fn posted_keys(session: &mut Present) -> Vec<qd::present::DecodedKey> {
    session
        .take_posted()
        .into_iter()
        .filter_map(|up| match up {
            Up::InputEvents { events } => Some(events),
            _ => None,
        })
        .flatten()
        .collect()
}

fn draft_face(text: &str) -> ComposerFace {
    let mut face = ComposerFace::default();
    face.draft = text.to_string();
    face.cursor = text.chars().map(char::len_utf16).sum::<usize>() as i64;
    face
}

/// 1-based SGR column of `hello`, the column of its fifth glyph, and the row.
/// `find` is a byte index: `│` is three bytes and one column.
fn hello_sgr(session: &mut Present) -> (i64, i64, i64) {
    let rows = session.content_rows();
    let row = rows
        .iter()
        .position(|line| line.contains("hello world"))
        .expect("draft row");
    let byte = rows[row].find("hello world").expect("draft column");
    let col = qd::display_width(&rows[row][..byte]) as i64;
    (col + 1, col + 5, row as i64 + 1)
}

/// One tape line above the draft. The line's hit is its own row, so the draft
/// row is not a scene cell. A bare `Text` is placed in the whole viewport and
/// would hide that.
fn tape_above() -> Node {
    Node::Box {
        style: BoxStyle::default(),
        children: vec![hello()],
        key: Some("tape".into()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn boot_draft_above_tape() -> Present {
    let mut session = Present::boot(PresentOpts {
        cols: 40,
        rows: 24,
        tty: false,
        env: PresentEnv {
            colorterm: Some("truecolor".into()),
            ..PresentEnv::default()
        },
        ..PresentOpts::default()
    });
    session.set_composer(draft_face("hello world"));
    session.set_retained_scene(tape_above());
    let first = session.paint_if_needed(0);
    assert!(first.caused);
    assert!(!first.bytes.contains("48;2"), "the draft starts unselected");
    session
}

fn boot_draft() -> Present {
    let mut session = Present::boot(PresentOpts {
        cols: 40,
        rows: 24,
        tty: false,
        env: PresentEnv {
            colorterm: Some("truecolor".into()),
            ..PresentEnv::default()
        },
        ..PresentOpts::default()
    });
    session.set_composer(draft_face("hello world"));
    session.set_retained_scene(hello());
    let first = session.paint_if_needed(0);
    assert!(first.caused);
    assert!(!first.bytes.contains("48;2"), "the draft starts unselected");
    session
}

fn sgr(button: i64, col: i64, row: i64, release: bool) -> String {
    let final_b = if release { 'm' } else { 'M' };
    format!("\u{1b}[<{button};{col};{row}{final_b}")
}

/// 1-based column of the cell after `hello world`, where the caret blinks.
fn caret_col(start_col: i64) -> i64 {
    start_col + "hello world".chars().count() as i64
}

fn select_hello(session: &mut Present) {
    let (start_col, end_col, row) = hello_sgr(session);
    let press = format!("\u{1b}[<{0};{start_col};{row}M", 0);
    let drag = format!("\u{1b}[<{0};{end_col};{row}M", 32);
    let release = format!("\u{1b}[<{0};{end_col};{row}m", 0);
    assert!(session.push_input(&press, 10).immediate.is_empty());
    assert!(session.push_input(&drag, 20).immediate.is_empty());
    let release = session.push_input(&release, 30);
    assert_eq!(
        release.immediate,
        osc52_set("hello", ClipboardSelect::Both),
        "release bytes {:?}",
        release.immediate
    );
}

#[test]
fn a_drag_in_the_composer_posts_the_caret_and_typing_replaces_it() {
    let mut session = boot_draft();
    let (start_col, end_col, row) = hello_sgr(&mut session);
    assert!(session
        .push_input(&format!("\u{1b}[<0;{start_col};{row}M"), 10)
        .immediate
        .is_empty());
    session.push_input(&format!("\u{1b}[<32;{end_col};{row}M"), 20);
    let dragging = session.paint_if_needed(20);
    assert!(
        dragging.bytes.contains("48;2"),
        "the draft highlights while the button is down"
    );
    let hide = dragging.bytes.find("\u{1b}[?25l").expect("hide");
    let erase = dragging.bytes.find("[2K").expect("erase");
    assert!(hide < erase, "the cursor hides before the line erase");
    assert!(
        !dragging.bytes.contains("\u{1b}[?25h"),
        "a blinking caret is not parked on the range"
    );
    let release = session.push_input(&format!("\u{1b}[<0;{end_col};{row}m"), 30);
    assert_eq!(release.immediate, osc52_set("hello", ClipboardSelect::Both));
    let keys = posted_keys(&mut session);
    assert_eq!(
        keys.iter().map(|key| key.key.as_str()).collect::<Vec<_>>(),
        vec!["ComposerCaret:5:0"]
    );
    let shown = session.paint_if_needed(30);
    assert!(shown.bytes.contains("Copied"));
    assert!(shown.bytes.contains("48;2"));
    assert!(!shown.bytes.contains("\u{1b}[?25h"));

    session.push_input("x", 40);
    let keys = posted_keys(&mut session);
    assert_eq!(
        keys.iter().map(|key| key.key.as_str()).collect::<Vec<_>>(),
        vec!["ComposerCaret:5:0", "x"]
    );
    assert_eq!(session.predicted_draft(), Some("x world"));
    let typed = session.paint_if_needed(40);
    assert!(
        typed.bytes.contains("\u{1b}[?25h"),
        "the caret returns once the range is gone"
    );
}

#[test]
fn a_paste_replaces_the_composer_range_and_escape_clears_it() {
    let mut session = boot_draft();
    session.set_clipboard_read(|| Some("ZED".into()));
    select_hello(&mut session);
    let _ = posted_keys(&mut session);

    session.push_input("\u{16}", 40);
    let keys = posted_keys(&mut session);
    assert_eq!(
        keys.iter().map(|key| key.key.as_str()).collect::<Vec<_>>(),
        vec!["ComposerCaret:5:0", "Paste:\"ZED\""]
    );
    assert_eq!(session.predicted_draft(), Some("ZED world"));

    session.set_composer(draft_face("hello world"));
    select_hello(&mut session);
    let _ = posted_keys(&mut session);
    session.push_input("\u{1b}[200~z\u{1b}[201~", 50);
    let keys = posted_keys(&mut session);
    assert_eq!(
        keys.iter().map(|key| key.key.as_str()).collect::<Vec<_>>(),
        vec!["ComposerCaret:5:0", "Paste:\"z\""]
    );
    assert_eq!(session.predicted_draft(), Some("z world"));

    session.set_composer(draft_face("hello world"));
    select_hello(&mut session);
    let _ = posted_keys(&mut session);
    session.push_input("\u{1b}", 60);
    session.paint_if_needed(100);
    let keys = posted_keys(&mut session);
    assert!(
        keys.iter().any(|key| key.key == "ComposerCaret:5:n"),
        "{keys:?}"
    );
    assert!(keys.iter().all(|key| key.key != "Escape"), "{keys:?}");
    assert!(
        session.predicted_draft().is_none() || session.predicted_draft() == Some("hello world")
    );
}

/// After the copy, the pasteboard is the slice. Paste still inserts the earlier clipboard.
#[test]
fn a_draft_selection_copies_and_paste_restores_the_earlier_clipboard() {
    let mut session = boot_draft();
    set_clip("ZED");
    session.set_clipboard_read(clip_read);
    let (start_col, end_col, row) = hello_sgr(&mut session);
    session.push_input(&sgr(0, start_col, row, false), 10);
    session.push_input(&sgr(32, end_col, row, false), 20);
    let release = session.push_input(&sgr(0, end_col, row, true), 30);
    assert_eq!(release.immediate, osc52_set("hello", ClipboardSelect::Both));
    let shown = session.paint_if_needed(30);
    assert!(shown.bytes.contains("Copied"));
    let _ = posted_keys(&mut session);

    set_clip("hello");
    session.push_input("\u{16}", 40);
    let keys = posted_keys(&mut session);
    assert_eq!(
        keys.iter().map(|key| key.key.as_str()).collect::<Vec<_>>(),
        vec!["ComposerCaret:5:0", "Paste:\"ZED\""]
    );
    assert_eq!(session.predicted_draft(), Some("ZED world"));

    session.set_composer(draft_face("hello world"));
    set_clip("ZED");
    select_hello(&mut session);
    let _ = posted_keys(&mut session);
    set_clip("hello");
    session.push_input("\u{1b}[200~hello\u{1b}[201~", 50);
    let keys = posted_keys(&mut session);
    assert_eq!(
        keys.iter().map(|key| key.key.as_str()).collect::<Vec<_>>(),
        vec!["ComposerCaret:5:0", "Paste:\"ZED\""]
    );
    assert_eq!(session.predicted_draft(), Some("ZED world"));
}

fn set_clip(text: &'static str) {
    *CLIP.lock().expect("clip") = text;
}

fn clip_read() -> Option<String> {
    Some((*CLIP.lock().expect("clip")).to_string())
}

#[test]
fn shift_left_extends_a_composer_range_the_host_already_has() {
    let mut session = boot_draft();
    let mut face = draft_face("hello world");
    face.cursor = 5;
    face.mark = Some(0);
    session.set_composer(face);
    let held = session.paint_if_needed(1);
    assert!(
        held.bytes.contains("48;2"),
        "a host mark paints in the draft"
    );
    let hide = held.bytes.find("\u{1b}[?25l").expect("hide");
    let erase = held.bytes.find("[2K").expect("erase");
    assert!(hide < erase);
    assert!(!held.bytes.contains("\u{1b}[?25h"));

    session.push_input("\u{1b}[1;2D", 20);
    let keys = posted_keys(&mut session);
    assert_eq!(
        keys.iter()
            .map(|key| (key.key.as_str(), key.shift))
            .collect::<Vec<_>>(),
        vec![("ArrowLeft", true)]
    );
    assert_eq!(session.predicted_draft(), Some("hello world"));
    assert_eq!(session.shown_cursor(), 4);
}

#[test]
fn a_paint_between_press_and_drag_keeps_the_press_cell() {
    let mut session = boot_draft();
    let (start_col, end_col, row) = hello_sgr(&mut session);
    session.push_input(&sgr(0, start_col, row, false), 10);
    let _ = session.paint_if_needed(10);
    session.push_input(&sgr(32, end_col, row, false), 20);
    let release = session.push_input(&sgr(0, end_col, row, true), 30);
    assert_edit_range(
        &release.immediate,
        &mut session,
        "ComposerCaret:5:0",
        "hello",
        "the press cell",
    );
}

#[test]
fn a_second_drag_after_paint_keeps_the_press_anchor() {
    let mut session = boot_draft();
    let (start_col, end_col, row) = hello_sgr(&mut session);
    let further = start_col + 6;
    session.push_input(&sgr(0, start_col, row, false), 10);
    session.push_input(&sgr(32, end_col, row, false), 20);
    let _ = session.paint_if_needed(20);
    session.push_input(&sgr(32, further, row, false), 40);
    let release = session.push_input(&sgr(0, further, row, true), 50);
    assert_edit_range(
        &release.immediate,
        &mut session,
        "ComposerCaret:7:0",
        "hello w",
        "a later move must keep the button-down cell",
    );
}

#[test]
fn a_drag_in_the_draft_still_selects_when_the_tape_stops_above_it() {
    let mut session = boot_draft_above_tape();
    let (start_col, end_col, row) = hello_sgr(&mut session);
    session.push_input(&sgr(0, start_col, row, false), 10);
    session.push_input(&sgr(32, end_col, row, false), 20);
    let release = session.push_input(&sgr(0, end_col, row, true), 30);
    assert_edit_range(
        &release.immediate,
        &mut session,
        "ComposerCaret:5:0",
        "hello",
        "the draft drag is real before any frame",
    );
}

#[test]
fn a_move_keeps_the_press_cell_when_the_tape_stops_above_the_draft() {
    let mut session = boot_draft_above_tape();
    let (start_col, end_col, row) = hello_sgr(&mut session);
    let further = start_col + 6;
    session.push_input(&sgr(0, start_col, row, false), 10);
    session.push_input(&sgr(32, end_col, row, false), 20);
    let _ = session.paint_if_needed(20);
    session.push_input(&sgr(32, further, row, false), 40);
    let release = session.push_input(&sgr(0, further, row, true), 50);
    assert_edit_range(
        &release.immediate,
        &mut session,
        "ComposerCaret:7:0",
        "hello w",
        "a move after the frame must keep the button-down cell",
    );
}

#[test]
fn a_drag_without_a_press_does_not_anchor_at_the_caret() {
    let mut session = boot_draft();
    let (start_col, end_col, row) = hello_sgr(&mut session);
    let caret = caret_col(start_col);
    session.push_input(&sgr(0, caret, row, false), 10);
    session.push_input(&sgr(0, caret, row, true), 11);
    let _ = session.paint_if_needed(11);
    let _ = posted_keys(&mut session);

    session.push_input(&sgr(32, start_col, row, false), 20);
    session.push_input(&sgr(32, end_col, row, false), 21);
    let release = session.push_input(&sgr(0, end_col, row, true), 30);
    assert_edit_range(
        &release.immediate,
        &mut session,
        "ComposerCaret:5:0",
        "hello",
        "a move with no press in this gesture must not start at the caret",
    );
}

#[test]
fn a_second_press_while_the_button_is_down_does_not_move_the_anchor() {
    let mut session = boot_draft();
    let (start_col, end_col, row) = hello_sgr(&mut session);
    let caret = caret_col(start_col);
    session.push_input(&sgr(0, start_col, row, false), 10);
    session.push_input(&sgr(0, caret, row, false), 12);
    session.push_input(&sgr(32, end_col, row, false), 20);
    let release = session.push_input(&sgr(0, end_col, row, true), 30);
    assert_edit_range(
        &release.immediate,
        &mut session,
        "ComposerCaret:5:0",
        "hello",
        "a second press at the caret must not become the range start",
    );
}

fn assert_edit_range(immediate: &str, session: &mut Present, caret: &str, copied: &str, why: &str) {
    assert_eq!(
        immediate,
        osc52_set(copied, ClipboardSelect::Both),
        "{why}, release bytes {immediate:?}"
    );
    assert_eq!(
        posted_keys(session)
            .into_iter()
            .map(|key| key.key)
            .collect::<Vec<_>>(),
        vec![caret.to_string()],
        "{why}"
    );
}
