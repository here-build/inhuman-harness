//! Paint-patch reader and retained speech / thinking / work / composer widgets.
//!
//! Ported from `packages/harness/src/tui/__tests__/paint-replica.test.ts` and
//! the speech-token rows of `packages/harness/src/tui/__visual__/paint-widgets.test.ts`.
//! A fenced block stays plain text. Markdown expand, shiki colors, and diff
//! expand are BLOCKED below and are not given a stand-in that would pass them.

use std::collections::BTreeSet;
use std::rc::Rc;

use qd::layout_engine::{Gutter, Node, SpinnerProfile};
use qd::layout_text::WhiteSpace;
use qd::paint_replica::{stage_scene, PaintReplica, ReplicaNote, SyntaxPolarity};
use qd::present::{Present, PresentOpts};

// BLOCKED — not asserted here. A fenced block stays plain text. These expects
// need markdown expand, shiki, or a diff expander, and a stand-in in this
// replica would pass them for the wrong reason. "actual package.", the diff
// type, and warmHighlighted are already locked by expand_oracle.rs and
// syntax.rs. Do not stub them inside the replica.
//
// widgets/__tests__/markdown.test.ts — "softWrapParts uses wrapText last-space breaks"
//   expect(mixed[1]?.[0]?.style.bold).toBe(true);
//   mixed[1][0].style.bold === true
//   expect(mdLines.some((line) => line.includes("actual package."))).toBe(true);
//   markdownToLayout lines containing "actual package."
//   expect(mdLines.some((line) => line.trimStart().startsWith("ctual"))).toBe(false);
//   mdLines.some((line) => line.trimStart().startsWith("ctual")) === false
//
// packages/harness/src/tui/__visual__/paint-theme-diff.test.ts
//   expect({ coldPlain: cold.length === 0, warmHighlighted: warm.length > 0 }).toEqual({
//     coldPlain: true, warmHighlighted: true,
//   });
//   coldPlain: cold.length === 0, warmHighlighted: warm.length > 0
//   expect({ darkHasTokens: dark.length > 0, paletteFollowsPolarity: JSON.stringify(dark) !== JSON.stringify(light) })
//     .toEqual({ darkHasTokens: true, paletteFollowsPolarity: true });
//   darkHasTokens: true, paletteFollowsPolarity: true
//
// packages/harness/src/tui/__visual__/paint-widgets.test.ts
//   "ask pin prepare expands Diff before paintReady"
//   leftoverDiffType: dumped.includes('"type":"diff"') === false
//   dumped.includes('"type":"diff"') === false
//   leftoverDiffType: false
//   A plain-text receipt has no diff node, so this expect would pass without Diff.

const LIVE: &str = r#"{
  "kind": "paint_init",
  "epoch": "e1",
  "snapshot": {
    "kind": "root",
    "children": [{
      "kind": "turn",
      "children": [{
        "kind": "completion",
        "workerPresent": true,
        "model": "m",
        "children": [
          {"kind": "speech", "text": ""},
          {"kind": "thinking", "text": ""},
          {"kind": "failure", "endDetail": "", "failReason": ""}
        ]
      }]
    }]
  }
}"#;

const REPLICA: &str = r#"{
  "kind": "paint_init",
  "epoch": "e1",
  "snapshot": {
    "kind": "root",
    "children": [
      {
        "kind": "turn",
        "children": [{
          "kind": "completion",
          "workerPresent": true,
          "model": "m",
          "children": [
            {"kind": "speech", "text": ""},
            {"kind": "thinking", "text": ""},
            {"kind": "failure", "endDetail": "", "failReason": ""}
          ]
        }]
      },
      {"kind": "composer"}
    ]
  }
}"#;

fn apply(replica: &mut PaintReplica, bytes: &str) {
    replica.apply(bytes.as_bytes()).expect("apply");
}

fn init_speech(text: &str) -> PaintReplica {
    let mut replica = PaintReplica::new();
    // `text` is a JSON string literal, quotes included.
    apply(
        &mut replica,
        &format!(
            r#"{{"kind":"paint_init","epoch":"e","snapshot":{{"kind":"root","children":[{{"kind":"turn","children":[{{"kind":"completion","children":[{{"kind":"speech","text":{text}}},{{"kind":"thinking","text":"keep"}}]}}]}}]}}}}"#
        ),
    );
    replica
}

fn turn_of(replica: &PaintReplica) -> qd::paint_replica::NodeRef {
    replica
        .child(replica.root().expect("root"), 0)
        .expect("turn")
}

fn completion_of(replica: &PaintReplica) -> qd::paint_replica::NodeRef {
    replica.child(turn_of(replica), 0).expect("completion")
}

fn speech_of(replica: &PaintReplica) -> qd::paint_replica::NodeRef {
    replica.child(completion_of(replica), 0).expect("speech")
}

fn thinking_of(replica: &PaintReplica) -> qd::paint_replica::NodeRef {
    replica.child(completion_of(replica), 1).expect("thinking")
}

fn tool_of(replica: &PaintReplica) -> qd::paint_replica::NodeRef {
    let turn = turn_of(replica);
    let count = replica.child_count(turn).expect("turn children");
    for index in 0..count {
        let child = replica.child(turn, index).expect("child");
        if replica.kind(child) == Some("tool") {
            return child;
        }
    }
    panic!("missing tool");
}

fn composer_of(replica: &PaintReplica) -> qd::paint_replica::NodeRef {
    let root = replica.root().expect("root");
    let count = replica.child_count(root).expect("root children");
    for index in 0..count {
        let child = replica.child(root, index).expect("child");
        if replica.kind(child) == Some("composer") {
            return child;
        }
    }
    panic!("missing composer");
}

fn texts(node: &Node, out: &mut Vec<String>) {
    match node {
        Node::Text { content, .. } => out.push(content.clone()),
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children {
                texts(child, out);
            }
        }
        Node::Disclosure {
            summary, children, ..
        } => {
            texts(summary, out);
            for child in children {
                texts(child, out);
            }
        }
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => {}
    }
}

fn contains_text(node: &Node, needle: &str) -> bool {
    let mut found = Vec::new();
    texts(node, &mut found);
    found.iter().any(|text| text.contains(needle))
}

#[test]
fn unread_model_patch_keeps_the_speech() {
    let mut replica = init_speech(r#""hello""#);
    let speech = speech_of(&replica);
    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[{"op":"replace","path":"/children/0/children/0/model","value":"other"}]}"#,
    );
    assert_eq!(replica.seq(), 1);
    assert_eq!(replica.text(speech), Some("hello"));
    let prepared = replica.prepare(speech, 40).expect("prepare");
    assert!(contains_text(&prepared.root, "hello"));
}

#[test]
fn leaf_splice_keeps_node_identity() {
    let mut replica = PaintReplica::new();
    apply(&mut replica, LIVE);
    let root = replica.root().expect("root");
    let turn = turn_of(&replica);
    let completion = completion_of(&replica);
    let speech = speech_of(&replica);
    let thinking = thinking_of(&replica);

    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e1","seq":1,"patches":[
          {"op":"add","path":"/children/-","value":{"kind":"turn","children":[
            {"kind":"completion","children":[
              {"kind":"speech","text":""},
              {"kind":"thinking","text":""},
              {"kind":"failure"}
            ]}
          ]}}
        ]}"#,
    );
    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e1","seq":2,"patches":[
          {"op":"splice","path":"/children/0/children/0/children/0/text","from":0,"deleteCount":0,"insert":"hello"},
          {"op":"splice","path":"/children/0/children/0/children/1/text","from":0,"deleteCount":0,"insert":"hmm"}
        ]}"#,
    );
    assert_eq!(
        (
            replica.root(),
            turn_of(&replica),
            completion_of(&replica),
            speech_of(&replica),
            thinking_of(&replica),
            replica.child_count(root),
            replica.text(speech),
            replica.text(thinking),
            replica.kind(speech),
            replica.kind(thinking),
            replica.seq(),
        ),
        (
            Some(root),
            turn,
            completion,
            speech,
            thinking,
            Some(2),
            Some("hello"),
            Some("hmm"),
            Some("speech"),
            Some("thinking"),
            2,
        ),
        "added turn keeps the completion and its siblings",
    );

    let mut replica = init_speech(r#""hello""#);
    let root = replica.root().expect("root");
    let turn = turn_of(&replica);
    let completion = completion_of(&replica);
    let speech = speech_of(&replica);
    let thinking = thinking_of(&replica);
    let before = replica.text(speech).map(str::to_string);
    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[{"op":"splice","path":"/children/0/children/0/children/0/text","from":1,"deleteCount":1,"insert":"a"}]}"#,
    );
    assert_eq!(
        (
            before.as_deref(),
            replica.text(speech),
            replica.root(),
            turn_of(&replica),
            completion_of(&replica),
            speech_of(&replica),
            thinking_of(&replica),
            replica.text(thinking),
        ),
        (
            Some("hello"),
            Some("hallo"),
            Some(root),
            turn,
            completion,
            speech,
            thinking,
            Some("keep"),
        ),
        "shorten hello to hallo keeps the sibling",
    );

    let mut replica = init_speech(r#""\uD83D\uDC4D""#);
    let root = replica.root().expect("root");
    let speech = speech_of(&replica);
    let decoded = replica.text(speech).map(str::to_string);
    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[{"op":"splice","path":"/children/0/children/0/children/0/text","from":2,"deleteCount":0,"insert":"!"}]}"#,
    );
    assert_eq!(
        (
            decoded.as_deref(),
            replica.text(speech),
            replica.root(),
            speech_of(&replica),
        ),
        (Some("👍"), Some("👍!"), Some(root), speech),
        "utf-16 emoji splice appends",
    );
}

#[test]
fn protocol_errors_are_an_enum() {
    let mut fresh = PaintReplica::new();
    let before = fresh
        .apply(br#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[]}"#)
        .expect_err("before init");
    assert_eq!(
        (before.code(), before.to_string(), fresh.root()),
        (
            "patch_before_init",
            "paint_patch before paint_init".to_string(),
            None,
        ),
        "patch before init",
    );

    let mut replica = PaintReplica::new();
    apply(&mut replica, LIVE);
    let speech = speech_of(&replica);
    let gap = replica
        .apply(br#"{"kind":"paint_patch","epoch":"e1","seq":2,"patches":[]}"#)
        .expect_err("gap");
    assert_eq!(
        (
            gap.code(),
            gap.to_string(),
            replica.seq(),
            replica.text(speech),
        ),
        ("seq_gap", "paint_patch seq 2 != 1".to_string(), 0, Some("")),
        "seq gap",
    );

    let epoch = replica
        .apply(
            br#"{"kind":"paint_patch","epoch":"other","seq":1,"patches":[
          {"op":"replace","path":"/children/0/children/0/children/0/text","value":"nope"}
        ]}"#,
        )
        .expect_err("epoch");
    assert_eq!(
        (
            epoch.code(),
            epoch.to_string(),
            replica.seq(),
            replica.text(speech),
            replica.epoch(),
        ),
        (
            "epoch_mismatch",
            "paint_patch epoch other != e1".to_string(),
            0,
            Some(""),
            Some("e1"),
        ),
        "epoch mismatch",
    );

    let mut replica = init_speech(r#""hello""#);
    let root = replica.root().expect("root");
    let speech = speech_of(&replica);
    let surrogate = replica
        .apply(br#"{"kind":"paint_init","epoch":"e2","snapshot":{"kind":"root","children":[{"kind":"speech","text":"\uD800"}]}}"#)
        .expect_err("surrogate");
    assert_eq!(
        (
            surrogate.code(),
            replica.root(),
            replica.text(speech),
            replica.epoch(),
        ),
        ("parse", Some(root), Some("hello"), Some("e")),
        "lone surrogate does not clobber",
    );
    let kind = replica
        .apply(br#"{"kind":"paint_init","epoch":"e2","snapshot":{"kind":"root","children":[{"kind":"nope"}]}}"#)
        .expect_err("kind");
    assert_eq!(
        (
            kind.code(),
            replica.root(),
            replica.text(speech),
            replica.epoch()
        ),
        ("apply_failed", Some(root), Some("hello"), Some("e")),
        "unknown kind does not clobber",
    );
    let index = replica
        .apply(br#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[{"op":"remove","path":"/children/9"}]}"#)
        .expect_err("index");
    assert_eq!(
        (
            index.code(),
            replica.seq(),
            replica.root(),
            replica.text(speech),
        ),
        ("apply_failed", 0, Some(root), Some("hello")),
        "bad index does not bump seq",
    );
    replica
        .apply(
            br#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[{"op":"replace","path":"/children/0/children/0/children/0/text","value":"yo"}]}"#,
        )
        .expect("replace");
    assert_eq!(
        (
            replica.seq(),
            replica.text(speech),
            replica.root(),
            speech_of(&replica),
        ),
        (1, Some("yo"), Some(root), speech),
        "replace bumps seq and keeps the node",
    );
}

#[test]
fn prepare_hits_the_cache_at_the_same_offered_width() {
    // paints: 0 in the widget host is requestPaint. prepare does not call Present.
    let mut replica = PaintReplica::new();
    apply(&mut replica, REPLICA);
    let speech = speech_of(&replica);
    let first = replica.prepare(speech, 40).expect("first");
    let second = replica.prepare(speech, 40).expect("second");
    let resized = replica.prepare(speech, 20).expect("resized");
    assert!(Rc::ptr_eq(&first, &second));
    assert!(!Rc::ptr_eq(&resized, &first));
    assert_eq!(replica.expands(speech), Some(2));
    assert_eq!(resized.width, 20);
    assert!(resized.paint_ready);
    assert!(first.paint_ready);
}

#[test]
fn a_token_dirties_speech_and_leaves_thinking_composer_and_a_sealed_tool_cached() {
    let mut replica = PaintReplica::new();
    apply(&mut replica, REPLICA);
    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e1","seq":1,"patches":[
          {"op":"add","path":"/children/0/children/-","value":{
            "kind":"tool",
            "name":"read_file",
            "object":"a.ts",
            "status":"ok",
            "state":"ok",
            "indent":false,
            "receiptKind":"text",
            "receiptText":"done",
            "diffOld":"",
            "diffNew":"",
            "diffPath":""
          }}
        ]}"#,
    );
    let speech = speech_of(&replica);
    let thinking = thinking_of(&replica);
    let tool = tool_of(&replica);
    let composer = composer_of(&replica);
    let thinking_first = replica.prepare(thinking, 48).expect("thinking");
    let tool_first = replica.prepare(tool, 48).expect("tool");
    let composer_first = replica.prepare(composer, 48).expect("composer");
    let speech_first = replica.prepare(speech, 48).expect("speech");
    assert_eq!(
        (
            replica.expands(speech),
            speech_first.paint_ready,
            replica.kind(tool),
            replica.kind(composer),
        ),
        (Some(1), true, Some("tool"), Some("composer")),
        "empty speech expands once",
    );

    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e1","seq":2,"patches":[
          {"op":"splice","path":"/children/0/children/0/children/0/text","from":0,"deleteCount":0,"insert":"hello **world**"}
        ]}"#,
    );
    assert_eq!(
        replica.take_patch_tally(),
        None,
        "splice does not arm a tally",
    );
    replica.note_replica(ReplicaNote::Patch);
    let thinking_next = replica.prepare(thinking, 48).expect("thinking next");
    let tool_next = replica.prepare(tool, 48).expect("tool next");
    let composer_next = replica.prepare(composer, 48).expect("composer next");
    let speech_next = replica.prepare(speech, 48).expect("speech next");
    replica.prepare_scene(48).expect("scene");
    let tally = replica.take_patch_tally().expect("tally");
    let speech_cached = replica.prepare(speech, 48).expect("speech cached");
    assert_eq!(
        (
            replica.expands(speech),
            speech_next.width,
            speech_next.paint_ready,
            contains_text(&speech_next.root, "world"),
            contains_text(&speech_next.root, "**"),
            Rc::ptr_eq(&thinking_next, &thinking_first),
            Rc::ptr_eq(&tool_next, &tool_first),
            Rc::ptr_eq(&composer_next, &composer_first),
        ),
        (Some(2), 48, true, true, false, true, true, true),
        "speech token rebuilds speech and leaves the rest cached",
    );
    assert_eq!(
        (
            Rc::ptr_eq(&speech_next, &speech_first),
            Rc::ptr_eq(&speech_next, &speech_cached),
            tally.line(replica.seq()),
            replica.text(speech),
            speech_of(&replica),
            thinking_of(&replica),
            tool_of(&replica),
            composer_of(&replica),
        ),
        (
            false,
            true,
            "seq=2 rebuilt=speech,completion,turn,root cached=thinking,tool,composer".to_string(),
            Some("hello **world**"),
            speech,
            thinking,
            tool,
            composer,
        ),
        "speech token rebuilds speech and leaves the rest cached",
    );
}

#[test]
fn syntax_polarity_miss_rebuilds_without_a_text_change() {
    let mut replica = PaintReplica::new();
    apply(&mut replica, REPLICA);
    let speech = speech_of(&replica);
    let thinking = thinking_of(&replica);
    replica.prepare(speech, 32).expect("dark");
    let thinking_first = replica.prepare(thinking, 32).expect("thinking");
    assert_eq!(replica.expands(speech), Some(1));
    replica.set_syntax_polarity(SyntaxPolarity::Light);
    let next = replica.prepare(speech, 32).expect("light");
    let thinking_next = replica.prepare(thinking, 32).expect("thinking cached");
    assert_eq!(replica.expands(speech), Some(2));
    assert_eq!(replica.text(speech), Some(""));
    assert!(Rc::ptr_eq(
        &next,
        &replica
            .prepare(speech, 32)
            .expect("same polarity is cached")
    ));
    assert!(Rc::ptr_eq(&thinking_next, &thinking_first));
}

#[test]
fn stage_scene_paints_plain_speech() {
    let mut replica = PaintReplica::new();
    apply(&mut replica, REPLICA);
    let speech = speech_of(&replica);
    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e1","seq":1,"patches":[
          {"op":"splice","path":"/children/0/children/0/children/0/text","from":0,"deleteCount":0,"insert":"hello"}
        ]}"#,
    );
    let prepared = replica.prepare(speech, 48).expect("speech");
    assert!(contains_text(&prepared.root, "hello"));
    let mut present = Present::boot(PresentOpts {
        cols: 80,
        rows: 24,
        tty: false,
        ..PresentOpts::default()
    });
    stage_scene(&mut present, &prepared);
    let paint = present.paint_if_needed(0);
    assert!(paint.caused);
    assert!(!paint.bytes.is_empty());
    let visible = visible_text(&paint.bytes);
    assert!(visible.contains("hello"), "{visible}");
}

/// Drop CSI and OSC so a per-column birth style does not hide the glyphs.
fn visible_text(ansi: &str) -> String {
    let mut out = String::new();
    let mut chars = ansi.chars();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(']') => {
                for next in chars.by_ref() {
                    if next == '\u{7}' || next == '\u{1b}' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

const WAIT_PIN: &str = r#"{
  "kind": "paint_init",
  "epoch": "e1",
  "snapshot": {
    "kind": "root",
    "children": [
      {"kind": "wait", "name": "waiting", "object": "", "status": "waiting for response...", "state": "live"},
      {"kind": "composer"}
    ]
  }
}"#;

fn has_thinking_spinner(node: &Node) -> bool {
    match node {
        Node::Indication {
            gutter, children, ..
        } => {
            matches!(
                gutter,
                Gutter::Spinner {
                    profile: Some(SpinnerProfile::Thinking),
                    ..
                }
            ) || children.iter().any(has_thinking_spinner)
        }
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.iter().any(has_thinking_spinner),
        Node::Disclosure {
            summary, children, ..
        } => has_thinking_spinner(summary) || children.iter().any(has_thinking_spinner),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => false,
    }
}

#[test]
fn phase_sentence_sits_on_the_wait_pin_until_it_clears_and_stays_off_otherwise() {
    let mut replica = PaintReplica::new();
    apply(&mut replica, WAIT_PIN);
    let unchanged = replica.set_phase("");
    let plain = replica.frame(40).expect("no phase");
    let sentence = identity_wrap(&plain, "waiting for response...").expect("wait line");
    assert_eq!(
        (
            unchanged,
            contains_text(&plain, "syncing the kernel..."),
            sentence.content.as_str(),
        ),
        (false, false, "waiting for response..."),
        "a clear phase paints the wait sentence without the machine kind",
    );

    let changed = replica.set_phase("syncing the kernel...");
    let repeat = replica.set_phase("syncing the kernel...");
    let stalled = replica.frame(40).expect("phase");
    assert_eq!(
        (
            changed,
            repeat,
            contains_text(&stalled, "syncing the kernel..."),
            contains_text(&stalled, "waiting for response..."),
            has_thinking_spinner(&stalled),
        ),
        (true, false, true, false, true),
        "sentence sits on the wait pin",
    );

    let cleared = replica.set_phase("");
    let cleared_frame = replica.frame(40).expect("cleared");
    assert_eq!(
        (
            cleared,
            contains_text(&cleared_frame, "syncing the kernel..."),
            contains_text(&cleared_frame, "waiting for response..."),
        ),
        (true, false, true),
        "clearing the phase restores the wait pin status",
    );

    let mut replica = PaintReplica::new();
    apply(&mut replica, REPLICA);
    let opened = replica.set_phase("opening the session...");
    let no_wait = replica.frame(40).expect("no wait");
    assert_eq!(
        (opened, contains_text(&no_wait, "opening the session...")),
        (true, false),
        "stays off with no wait",
    );

    apply(
        &mut replica,
        r#"{
          "kind": "paint_init",
          "epoch": "e1",
          "snapshot": {
            "kind": "root",
            "children": [
              {"kind": "ask", "name": "ask", "status": "", "state": "live"},
              {"kind": "wait", "name": "waiting", "status": "waiting for response...", "state": "live"},
              {"kind": "composer"}
            ]
          }
        }"#,
    );
    let asked = replica.set_phase("syncing the kernel...");
    let asked_frame = replica.frame(40).expect("ask owns the pin");
    assert_eq!(
        (asked, contains_text(&asked_frame, "syncing the kernel..."),),
        (true, false),
        "stays off under an ask",
    );
}

#[test]
fn a_reply_clock_shares_the_user_message_column() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"speech","voice":"user","text":"hey","atMs":0},
                {"kind":"completion","state":"done","children":[
                  {"kind":"speech","text":"hi","atMs":0}
                ]}
              ]
            }]
          }
        }"#,
    );
    let turn = turn_of(&replica);
    let prepared = replica.prepare(turn, 40).expect("turn");
    let painted = painted_cells(&prepared.root, 40, 8);
    let ends: Vec<usize> = painted
        .lines()
        .filter_map(|line| {
            let start = line.find("12:00 AM")?;
            Some(line[..start].chars().count() + "12:00 AM".chars().count())
        })
        .collect();
    assert_eq!(ends.len(), 2, "{painted}");
    assert_eq!(ends[0], ends[1], "{painted}");
    // Page gap plus the floor's own pad: two blank rows above the user text and two before the reply.
    let marks: Vec<char> = painted
        .lines()
        .map(|line| if line.trim().is_empty() { '·' } else { 'T' })
        .collect();
    assert!(
        marks.starts_with(&['·', '·', 'T', '·', '·', 'T']),
        "{painted}"
    );
}

#[test]
fn a_speech_clock_follows_the_framed_column() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"speech","voice":"user","text":"hey","atMs":0},
                {"kind":"completion","state":"done","children":[
                  {"kind":"speech","text":"hi","atMs":0}
                ]}
              ]
            }]
          }
        }"#,
    );
    let narrow = replica.frame(40).expect("narrow");
    let narrow_ends = clock_ends(&painted_cells(&narrow, 40, 12));
    let wide = replica.frame(96).expect("wide");
    let wide_paint = painted_cells(&wide, 96, 12);
    let wide_ends = clock_ends(&wide_paint);
    assert_eq!(narrow_ends, [39, 39], "{narrow_ends:?}");
    assert_eq!(wide_ends, [95, 95], "{wide_paint}");
}

fn clock_ends(painted: &str) -> Vec<usize> {
    painted
        .lines()
        .filter_map(|line| {
            let start = line.find("12:00 AM")?;
            Some(line[..start].chars().count() + "12:00 AM".chars().count())
        })
        .collect()
}

#[test]
fn the_statusline_puts_the_branch_left_and_the_path_right() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[
              {"kind":"statusline","left":"feat/qd-runtime","note":"uncommitted, 2 local commits","cwd":"~/repo/pkg","cwdRoot":"~/repo"},
              {"kind":"recall","text":"marker"}
            ]
          }
        }"#,
    );
    let framed = replica.frame(72).expect("frame");
    let painted = painted_cells(&framed, 72, 4);
    let rows: Vec<&str> = painted.lines().collect();
    let row = rows[0];
    let branch = row.find("feat/qd-runtime").expect("branch");
    let note = row.find("uncommitted, 2 local commits").expect("note");
    let root = row.find("~/repo").expect("root");
    let rest = row.find("/pkg").expect("rest");
    assert_eq!(
        (
            branch,
            note,
            root,
            rest,
            rest + "/pkg".len(),
            rows[1].trim(),
            rows[2].trim(),
        ),
        (3, 19, 61, 67, 71, "", "marker"),
        "{painted}",
    );
    assert_eq!(
        (
            text_prominence(&framed, "feat/qd-runtime"),
            text_prominence(&framed, "uncommitted, 2 local commits"),
            text_prominence(&framed, "~/repo"),
            text_prominence(&framed, "/pkg"),
        ),
        (
            Some(qd::theme::FgP::SECONDARY),
            Some(qd::theme::FgP::RISING),
            Some(qd::theme::FgP::SECONDARY),
            Some(qd::theme::FgP::GHOST),
        ),
    );

    let mut narrow = PaintReplica::new();
    apply(
        &mut narrow,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[
              {"kind":"statusline","left":"feat/qd-runtime","cwd":"~/repo/pkg","cwdRoot":"~/repo"}
            ]
          }
        }"#,
    );
    let tight = painted_cells(&narrow.frame(20).expect("frame"), 20, 2);
    let tight_row = tight.lines().next().unwrap_or("");
    assert_eq!(
        (
            cell_at(tight_row, "…untime"),
            cell_at(tight_row, "…epo/pkg"),
            tight_row.chars().count(),
        ),
        (Some(3), Some(11), 20),
        "{tight}",
    );
}

fn cell_at(line: &str, needle: &str) -> Option<usize> {
    let byte = line.find(needle)?;
    Some(line[..byte].chars().count())
}

fn text_is_colored(node: &Node, needle: &str) -> bool {
    match node {
        Node::Text { content, style, .. } => content.contains(needle) && style.fg_rgb.is_some(),
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            children.iter().any(|child| text_is_colored(child, needle))
        }
        Node::Disclosure {
            summary, children, ..
        } => {
            text_is_colored(summary, needle)
                || children.iter().any(|child| text_is_colored(child, needle))
        }
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => false,
    }
}

fn text_prominence(node: &Node, content: &str) -> Option<f64> {
    match node {
        Node::Text {
            content: text,
            style,
            ..
        } if text == content => style.prominence,
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children
            .iter()
            .find_map(|child| text_prominence(child, content)),
        Node::Disclosure {
            summary, children, ..
        } => text_prominence(summary, content).or_else(|| {
            children
                .iter()
                .find_map(|child| text_prominence(child, content))
        }),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => None,
    }
}

fn painted_cells(node: &Node, cols: i64, rows: i64) -> String {
    let frame = qd::layout_engine::layout(
        node,
        qd::layout_engine::Viewport { w: cols, h: rows },
        qd::layout_engine::LayoutOpts::default(),
    );
    let mut buf = qd::create_buffer(
        usize::try_from(cols).unwrap_or(0),
        usize::try_from(rows).unwrap_or(0),
    );
    qd::present::paint_frame(&frame, &mut buf, 0.0, |style| style.clone());
    let mut out = String::new();
    for y in 0..buf.height() {
        for x in 0..buf.width() {
            out.push_str(qd::present::cell_glyph(&buf, x, y));
        }
        out.push('\n');
    }
    out
}

#[test]
fn speech_recap_paints_hotkeys_and_annotation_around_the_text_body() {
    let mut plain = init_speech(r#""rotate AUTH_SECRET""#);
    let speech = speech_of(&plain);
    let body = plain.prepare(speech, 48).expect("body");
    assert!(contains_text(&body.root, "rotate AUTH_SECRET"));

    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind": "paint_init",
          "epoch": "e",
          "snapshot": {
            "kind": "root",
            "children": [{
              "kind": "turn",
              "children": [{
                "kind": "completion",
                "children": [{
                  "kind": "speech",
                  "voice": "user",
                  "text": "rotate AUTH_SECRET",
                  "recap": true,
                  "annotation": "Auth refactor",
                  "recapHotkeys": [
                    {"key": "Enter", "action": "Rewind"},
                    {"key": "escape", "action": "Dismiss"}
                  ]
                }]
              }]
            }]
          }
        }"#,
    );
    let speech = speech_of(&replica);
    let prepared = replica.prepare(speech, 48).expect("recap");
    match &prepared.root {
        Node::Chrome { frame, .. } => {
            assert_eq!(frame.draft, "rotate AUTH_SECRET");
            assert_eq!(frame.annotation.as_deref(), Some("Auth refactor"));
            assert_eq!(frame.hotkeys.len(), 2);
        }
        other => panic!("recap is a chrome frame, got {other:?}"),
    }
    let painted = painted_cells(&prepared.root, 48, 8);
    assert!(painted.contains("rotate AUTH_SECRET"), "{painted}");
    assert!(painted.contains("Auth refactor"), "{painted}");
    assert!(painted.contains('⏎'), "{painted}");
    assert!(painted.contains("Rewind"), "{painted}");
    assert!(painted.contains("Esc"), "{painted}");
    assert!(!painted.contains("Enter"), "{painted}");
}

#[test]
fn arriving_speech_paints_the_newest_line_at_full_ink() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[{
                "kind":"completion",
                "state":"live",
                "children":[{
                  "kind":"speech",
                  "text":"older sentence.\n\nnewest arrival"
                }]
              }]
            }]
          }
        }"#,
    );
    let speech = speech_of(&replica);
    let prepared = replica.prepare(speech, 48).expect("speech");
    assert!(
        birth_contents(&prepared.root).is_empty(),
        "live speech paints at full ink: {:?}",
        birth_contents(&prepared.root)
    );
    let painted = painted_cells(&prepared.root, 48, 8);
    assert!(painted.contains("newest arrival"), "{painted}");
    assert!(painted.contains("older sentence"), "{painted}");
    assert!(!painted.contains('⠋'), "{painted}");
}

fn birth_contents(node: &Node) -> Vec<String> {
    let mut out = Vec::new();
    walk_birth(node, &mut out);
    out
}

fn walk_birth(node: &Node, out: &mut Vec<String>) {
    match node {
        Node::Text { content, live, .. } => {
            if matches!(live, Some(qd::layout_engine::LivePaint::Birth { .. })) {
                out.push(content.clone());
            }
        }
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children {
                walk_birth(child, out);
            }
        }
        Node::Disclosure {
            summary, children, ..
        } => {
            walk_birth(summary, out);
            for child in children {
                walk_birth(child, out);
            }
        }
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => {}
    }
}

#[test]
fn open_agents_drawer_paints_its_rows_on_the_frame() {
    let mut closed = PaintReplica::new();
    apply(
        &mut closed,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"agents",
              "open":false,
              "meterLeft":"METER_LINE",
              "meterRight":"",
              "rows":[{"key":"c1","kind":"call","name":"reviewer","recap":"","indent":0,"mark":""}]
            }]
          }
        }"#,
    );
    let agents = root_child(&closed, "agents");
    let meter = closed.prepare(agents, 48).expect("meter");
    assert!(contains_text(&meter.root, "METER_LINE"));
    assert!(!contains_text(&meter.root, "Subagents"));
    let closed_paint = painted_cells(&closed.frame(48).expect("closed"), 48, 16);
    assert!(!closed_paint.contains("Subagents"), "{closed_paint}");

    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"agents",
              "open":true,
              "focusKey":"c1",
              "meterLeft":"METER_LINE",
              "rows":[
                {"key":"c1","kind":"call","name":"reviewer","recap":"reading tea","indent":0,"mark":""},
                {"key":"b1","kind":"bot","name":"clerk","recap":"notes","indent":0,"mark":""},
                {"key":"s1","kind":"session","name":"auth","recap":"","indent":0,"mark":"awaiting approval"}
              ]
            }]
          }
        }"#,
    );
    let painted = painted_cells(&replica.frame(80).expect("open"), 80, 16);
    assert!(painted.contains("Subagents"), "{painted}");
    assert!(painted.contains("reviewer"), "{painted}");
    assert!(painted.contains("Collaborators"), "{painted}");
    assert!(painted.contains("clerk"), "{painted}");
    assert!(painted.contains("notes"), "{painted}");
    assert!(painted.contains("Sessions"), "{painted}");
    assert!(painted.contains("auth"), "{painted}");
    assert!(painted.contains("awaiting approval"), "{painted}");
    assert!(!painted.contains("METER_LINE"), "{painted}");
}

#[test]
fn an_open_drawer_pins_the_mark_fills_the_frame_and_seats_the_plaque() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"agents",
              "open":true,
              "focusKey":"session:other",
              "previewKey":"",
              "rows":[
                {
                  "key":"session:long",
                  "kind":"session",
                  "name":"Scratch file test edit that runs well past the trailing mark",
                  "recap":"SHOULD-NOT-PEEK",
                  "indent":0,
                  "mark":"this session",
                  "current":true,
                  "model":"hidden-model"
                },
                {
                  "key":"session:other",
                  "kind":"session",
                  "name":"other session",
                  "recap":"PEEK-RECAP",
                  "indent":0,
                  "mark":"idle",
                  "current":false,
                  "model":"PEEK-MODEL"
                }
              ]
            }]
          }
        }"#,
    );
    let mut node = replica.frame(80).expect("open");
    let placed = qd::layout_engine::layout(
        &node,
        qd::layout_engine::Viewport { w: 80, h: 16 },
        qd::layout_engine::LayoutOpts::default(),
    );
    let panel = placed
        .placed
        .iter()
        .find(|item| item.key == "agents:panel")
        .expect("panel");
    assert_eq!(panel.rect.h, 16, "{:?}", panel.rect);
    assert_eq!(panel.rect.y, 0, "{:?}", panel.rect);
    let painted = painted_cells(&node, 80, 16);
    let mark_line = painted
        .lines()
        .find(|line| line.contains("this session"))
        .expect(&painted);
    assert!(mark_line.contains('…'), "{mark_line}");
    assert!(
        mark_line.trim_end().ends_with("this session"),
        "{mark_line}"
    );
    assert!(!painted.contains("SHOULD-NOT-PEEK"), "{painted}");
    let plaque = replica.agents_plaque().expect("plaque");
    assert_eq!(plaque.focus, "session:other");
    assert!(qd::drawers::attach_agents_peek(
        &mut node,
        &plaque.node,
        &plaque.focus,
        80,
        16
    ));
    let with_plaque = painted_cells(&node, 80, 16);
    assert!(with_plaque.contains("PEEK-RECAP"), "{with_plaque}");
    assert!(with_plaque.contains("PEEK-MODEL"), "{with_plaque}");
    assert!(!with_plaque.contains("SHOULD-NOT-PEEK"), "{with_plaque}");
    assert!(!with_plaque.contains("hidden-model"), "{with_plaque}");

    let current = qd::drawers::AgentRow {
        key: "session:long".into(),
        kind: "session".into(),
        name: "n".into(),
        recap: "SHOULD-NOT-PEEK".into(),
        indent: 0,
        mark: "this session".into(),
        model: "hidden-model".into(),
        ask_line: String::new(),
        unfinished: String::new(),
        notifies: Vec::new(),
        result: String::new(),
        current: true,
    };
    assert!(qd::drawers::agents_peek(&current).is_none());
    let call = qd::drawers::AgentRow {
        key: "call:explore".into(),
        kind: "call".into(),
        name: "explore".into(),
        recap: "reading".into(),
        indent: 0,
        mark: String::new(),
        model: "grok".into(),
        ask_line: "ASK-LINE".into(),
        unfinished: "ask".into(),
        notifies: vec!["NOTIFY-LINE".into()],
        result: "RESULT-LINE".into(),
        current: false,
    };
    let peek = qd::drawers::agents_peek(&call).expect("call plaque");
    assert!(contains_text(&peek, "ASK-LINE"));
    assert!(contains_text(&peek, "NOTIFY-LINE"));
    assert!(contains_text(&peek, "RESULT-LINE"));
    assert!(contains_text(&peek, "grok"));
}

#[test]
fn rewind_paints_the_seat_it_is_given() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"rewind",
              "atTip":false,
              "pastTotal":4,
              "futureTotal":1,
              "past":[{"key":"p","text":"rotate AUTH\nnext"}],
              "future":[{"key":"f","text":"ship the drawer"}]
            }]
          }
        }"#,
    );
    let rewind = root_child(&replica, "rewind");
    let prepared = replica.prepare(rewind, 40).expect("seat");
    let chromes = chrome_frames(&prepared.root);
    assert_eq!(chromes.len(), 2);
    assert!(chromes[0].1.join_top);
    assert!(!chromes[0].1.omit_top);
    assert_eq!(chromes[0].1.draft, "rotate AUTH…");
    assert_eq!(chromes[1].1.draft, "ship the drawer");
    let painted = painted_cells(&replica.frame(40).expect("off tip"), 40, 16);
    assert!(painted.contains("rotate AUTH"), "{painted}");
    assert!(painted.contains("ship the drawer"), "{painted}");
    assert!(!painted.contains("rewound"), "{painted}");

    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[
          {"op":"replace","path":"/children/0/atTip","value":true}
        ]}"#,
    );
    let at_tip = painted_cells(&replica.frame(40).expect("tip"), 40, 16);
    assert!(at_tip.contains("rotate AUTH"), "{at_tip}");
    assert!(!at_tip.contains("ship the drawer"), "{at_tip}");
    assert!(!at_tip.contains("at tip"), "{at_tip}");

    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e","seq":2,"patches":[
          {"op":"replace","path":"/children/0/past","value":[]}
        ]}"#,
    );
    let cleared = painted_cells(&replica.frame(40).expect("cleared"), 40, 16);
    assert!(!cleared.contains("rotate AUTH"), "{cleared}");
    assert!(!cleared.contains("at tip"), "{cleared}");
}

#[test]
fn off_tip_user_speech_takes_the_border_and_the_reply_recedes() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
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
                {"kind":"speech","voice":"user","text":"ACTIVE-PROMPT","recap":true}
              ]},
              {"kind":"rewind","atTip":true,"seatRim":false,"past":[{"key":"p","text":"OLDER-PROMPT"}]}
            ]
          }
        }"#,
    );
    let at_tip = replica.frame(48).expect("tip");
    assert!(chrome_frames(&at_tip).iter().all(|(key, _)| match key {
        Some(key) => !key.ends_with(":rewind"),
        None => true,
    }));
    assert_eq!(region_over_text(&at_tip, "REPLY-BODY"), 1.0);

    apply(
        &mut replica,
        r#"{"kind":"paint_patch","epoch":"e","seq":1,"patches":[
          {"op":"replace","path":"/children/3/atTip","value":false}
        ]}"#,
    );
    let off = replica.frame(48).expect("off tip");
    let chromes = chrome_frames(&off);
    let speech = chromes.iter().find(|(key, _)| match key {
        Some(key) => key.ends_with(":rewind"),
        None => false,
    });
    let (_, frame) = speech.expect("user prompt becomes chrome");
    assert!(frame.selected);
    assert!(frame.hotkeys.is_empty());
    assert_eq!(frame.draft, "OLDER-PROMPT");
    assert_eq!(region_over_text(&off, "REPLY-BODY"), 0.45);
    assert_eq!(region_over_chrome(&off, ":rewind"), 0.45);
    assert_eq!(region_over_chrome(&off, ":recap"), 1.0);
    assert!(chromes.iter().any(|(key, frame)| {
        key.as_deref() == Some("p:chrome") && frame.draft == "OLDER-PROMPT"
    }));
}

#[test]
fn work_cell_paints_caption_and_pretty_block() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"tool",
              "name":"grep",
              "object":"tea.ts",
              "status":"ok",
              "state":"live",
              "caption":"in src/tea.ts",
              "pretty":true,
              "prettyBlock":"check the diff",
              "receiptKind":"text",
              "receiptText":"three matches"
            }]
          }
        }"#,
    );
    let painted = painted_cells(&replica.frame(48).expect("work"), 48, 16);
    assert!(!painted.contains("grep"), "{painted}");
    assert!(painted.contains("tea.ts"), "{painted}");
    assert!(painted.contains("ok"), "{painted}");
    assert!(painted.contains("in src/tea.ts"), "{painted}");
    assert!(painted.contains("check the diff"), "{painted}");
    assert!(painted.contains("three matches"), "{painted}");

    let mut diff = PaintReplica::new();
    apply(
        &mut diff,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"tool",
              "name":"edit",
              "object":"tea.ts",
              "status":"ok",
              "state":"live",
              "prettyBlock":"PRETTY_BLOCK_HIDDEN",
              "receiptKind":"diff",
              "receiptText":"",
              "diffOld":"a\n",
              "diffNew":"b\n",
              "diffPath":"tea.ts"
            }]
          }
        }"#,
    );
    let hidden = painted_cells(&diff.frame(48).expect("diff"), 48, 16);
    assert!(hidden.contains("edit"), "{hidden}");
    assert!(!hidden.contains("PRETTY_BLOCK_HIDDEN"), "{hidden}");
    assert!(hidden.contains("tea.ts"), "{hidden}");
    assert!(hidden.contains('b'), "{hidden}");
}

#[test]
fn work_cell_rows_paint_scheme_diff_and_shell() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"scheme","name":"scheme_repl","object":"(list_dir \".\" :depth 1)","status":"","state":"ok"},
                {"kind":"tool","name":"list_dir","object":"listed **.**","status":"","state":"ok","pretty":true,"indent":true},
                {"kind":"tool","name":"write_file","object":"harness-scratch.txt","status":"","state":"ok","receiptKind":"diff","diffOld":"","diffNew":"hello\n","diffPath":"harness-scratch.txt"},
                {"kind":"tool","name":"edit_file","object":"harness-scratch.txt","status":"","state":"ok","receiptKind":"diff","diffOld":"hello\n","diffNew":"hello\nedited\n","diffPath":"harness-scratch.txt"},
                {"kind":"tool","name":"shell","object":"ls -1","status":"./src","state":"ok","caption":"list the sources"}
              ]
            }]
          }
        }"#,
    );
    let painted = painted_cells(&replica.frame(72).expect("tape"), 72, 40);
    let scheme = painted
        .lines()
        .find(|row| row.contains("(list_dir"))
        .expect(&painted);
    let listed = painted
        .lines()
        .find(|row| row.contains("listed"))
        .expect(&painted);
    assert!(painted.contains('⒪'), "{painted}");
    assert!(!painted.contains("scheme_repl"), "{painted}");
    assert!(!listed.contains("list_dir"), "{listed}");
    assert!(!listed.contains("**"), "{listed}");
    assert!(listed.find("listed").expect(listed) > scheme.find("(list_dir").expect(scheme));
    assert!(!painted.contains("write_file"), "{painted}");
    assert!(!painted.contains("edit_file"), "{painted}");
    assert!(painted.contains("harness-scratch.txt"), "{painted}");
    assert!(painted.contains("hello"), "{painted}");
    assert!(painted.contains("edited"), "{painted}");
    assert!(painted.contains("list the sources"), "{painted}");
    assert!(painted.contains("./src"), "{painted}");
    assert!(painted.contains('$'), "{painted}");
    assert!(!painted.contains("ls -1"), "{painted}");
    assert!(!painted.contains("shell"), "{painted}");
}

#[test]
fn a_scheme_answer_is_boxed_and_its_sigil_starts_in_the_lead_cell() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"scheme","name":"scheme_repl","object":"(list_dir \".\" :depth 1)","status":"","state":"ok","caption":"List the root","receiptKind":"text","receiptText":"SECRET-SCHEME"},
                {"kind":"tool","name":"shell","object":"ls -1","status":"","state":"ok","caption":"list inside scheme","receiptKind":"text","receiptText":"SECRET-SHELL","indent":true},
                {"kind":"scheme","name":"scheme_watch","object":"(+ 1 2)","status":"","state":"ok","caption":"Watch the sum"}
              ]
            }]
          }
        }"#,
    );
    let painted = painted_cells(&replica.frame(64).expect("tape"), 64, 16);
    let rows: Vec<&str> = painted.lines().collect();
    let at = |needle: &str| {
        rows.iter()
            .position(|row| row.contains(needle))
            .expect(needle)
    };
    let repl = rows[at("List the root")];
    let watch = rows[at("Watch the sum")];
    assert_eq!(repl.find('\u{24aa}'), Some(0), "{painted}");
    assert_eq!(watch.find('\u{24b2}'), Some(0), "{painted}");
    assert!(repl.starts_with("\u{24aa}  List"), "{painted}");
    assert!(watch.starts_with("\u{24b2}  Watch"), "{painted}");
    assert!(!painted.contains("SECRET-SCHEME"), "{painted}");
}

#[test]
fn an_open_scheme_answer_paints_the_serializer_text_and_its_cut() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"scheme","name":"scheme_repl","object":"(list 1)","status":"","state":"live","caption":"Show the dict","receiptKind":"syntax","receiptText":"{:k \"ab\n#| … output hard-truncated at 40 chars |#"},
                {"kind":"scheme","name":"scheme_repl","object":"(display \"hi\")","status":"","state":"live","caption":"Show the sentence","receiptKind":"text","receiptText":"hello"}
              ]
            }]
          }
        }"#,
    );
    let painted = painted_cells(&replica.frame(80).expect("tape"), 80, 24);
    assert!(painted.contains("{:k"), "{painted}");
    assert!(painted.contains("hard-truncated"), "{painted}");
    assert!(painted.contains("hello"), "{painted}");
    assert!(!painted.contains("{\"kind\""), "{painted}");
}

#[test]
fn a_long_scheme_list_wraps_and_keeps_its_colors() {
    assert!(qd::syntax::warm());
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"scheme","name":"scheme_repl","object":"(list_dir \".\" :depth 1)","status":"","state":"live","caption":"List the root","receiptKind":"syntax","receiptText":"[\".harness/\" \"node_modules/\" \"package.json\" \"vitest.terminals.config.ts\"]"}
              ]
            }]
          }
        }"#,
    );
    let root = replica.frame(40).expect("tape");
    let painted = painted_cells(&root, 40, 24);
    let rows: Vec<&str> = painted.lines().collect();
    let head = rows
        .iter()
        .position(|row| row.contains(".harness/"))
        .expect(&painted);
    let tail = rows
        .iter()
        .position(|row| row.contains("vitest.terminals.config.ts"))
        .expect(&painted);
    assert_ne!(head, tail, "{painted}");
    assert!(text_is_colored(&root, ".harness/"), "{painted}");
}

#[test]
fn a_file_edit_keeps_a_cell_above_and_below() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"tool","name":"list_dir","object":"listed **src**","status":"","state":"ok","pretty":true},
                {"kind":"tool","name":"write_file","object":"new.txt","status":"","state":"ok","receiptKind":"diff","diffOld":"","diffNew":"created\n","diffPath":"new.txt"},
                {"kind":"tool","name":"edit_file","object":"old.txt","status":"","state":"ok","receiptKind":"diff","diffOld":"one\n","diffNew":"two\n","diffPath":"old.txt"},
                {"kind":"tool","name":"shell","object":"ls","status":"","state":"ok"}
              ]
            }]
          }
        }"#,
    );
    let turn = turn_of(&replica);
    let prepared = replica.prepare(turn, 60).expect("turn");
    let painted = painted_cells(&prepared.root, 60, 32);
    let rows: Vec<&str> = painted.lines().collect();
    let at = |needle: &str| {
        rows.iter()
            .position(|row| row.contains(needle))
            .expect(needle)
    };
    let write_at = at("new.txt");
    let edit_at = at("old.txt");
    let shell_at = at("ls");
    assert!(rows[write_at - 1].trim().is_empty(), "{painted}");
    assert!(rows[write_at - 2].contains("listed"), "{painted}");
    assert!(rows[write_at].contains("created"), "{painted}");
    assert!(rows[write_at + 1].trim().is_empty(), "{painted}");
    assert!(!rows[write_at + 2].trim().is_empty(), "{painted}");
    assert!(rows[edit_at].contains("updated"), "{painted}");
    assert!(rows[edit_at + 1].trim().is_empty(), "{painted}");
    assert!(!rows[edit_at + 2].trim().is_empty(), "{painted}");
    assert_eq!(
        (
            text_prominence(&prepared.root, "created"),
            text_prominence(&prepared.root, "updated"),
            text_prominence(&prepared.root, "new.txt"),
            text_prominence(&prepared.root, "old.txt"),
        ),
        (
            Some(qd::theme::FgP::RISING),
            Some(qd::theme::FgP::RISING),
            Some(qd::theme::FgP::SECONDARY),
            Some(qd::theme::FgP::SECONDARY),
        ),
        "{painted}",
    );
    assert!(rows[edit_at - 1].trim().is_empty(), "{painted}");
    assert!(!rows[edit_at - 2].trim().is_empty(), "{painted}");
    assert!(rows[shell_at - 1].trim().is_empty(), "{painted}");
    assert!(!rows[shell_at - 2].trim().is_empty(), "{painted}");

    let mut leading = PaintReplica::new();
    apply(
        &mut leading,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"tool","name":"edit_file","object":"solo.txt","status":"","state":"ok","receiptKind":"diff","diffOld":"a\n","diffNew":"b\n","diffPath":"solo.txt"}
              ]
            }]
          }
        }"#,
    );
    let solo = painted_cells(
        &leading.prepare(turn_of(&leading), 40).expect("solo").root,
        40,
        12,
    );
    let solo_rows: Vec<&str> = solo.lines().collect();
    let path_at = solo_rows
        .iter()
        .position(|row| row.contains("solo.txt"))
        .expect("path");
    assert_eq!(path_at, 1, "{solo}");
    assert!(solo_rows[0].trim().is_empty(), "{solo}");
    assert!(
        solo_rows
            .iter()
            .skip(path_at + 1)
            .any(|row| row.trim().is_empty()),
        "{solo}"
    );
    assert!(solo_rows[path_at].contains("updated"), "{solo}");
    assert!(solo_rows[path_at + 1].trim().is_empty(), "{solo}");
    assert!(!solo_rows[path_at + 2].trim().is_empty(), "{solo}");

    let mut overwrite = PaintReplica::new();
    apply(
        &mut overwrite,
        r#"{
          "kind":"paint_init","epoch":"e","snapshot":{
            "kind":"root",
            "children":[{
              "kind":"turn",
              "children":[
                {"kind":"tool","name":"write_file","object":"note.txt","status":"","state":"ok","receiptKind":"diff","diffOld":"prior\n","diffNew":"next\n","diffPath":"note.txt"}
              ]
            }]
          }
        }"#,
    );
    let replaced = overwrite
        .prepare(turn_of(&overwrite), 40)
        .expect("overwrite");
    assert_eq!(
        (
            text_prominence(&replaced.root, "created"),
            text_prominence(&replaced.root, "updated"),
            text_prominence(&replaced.root, "note.txt"),
        ),
        (
            None,
            Some(qd::theme::FgP::RISING),
            Some(qd::theme::FgP::SECONDARY)
        ),
    );
}

fn root_child(replica: &PaintReplica, kind: &str) -> qd::paint_replica::NodeRef {
    let root = replica.root().expect("root");
    let count = replica.child_count(root).expect("children");
    for index in 0..count {
        let child = replica.child(root, index).expect("child");
        if replica.kind(child) == Some(kind) {
            return child;
        }
    }
    panic!("missing {kind}");
}

fn node_region(node: &Node) -> Option<f64> {
    match node {
        Node::Text {
            region_prominence, ..
        }
        | Node::Box {
            region_prominence, ..
        }
        | Node::Flex {
            region_prominence, ..
        }
        | Node::Grid {
            region_prominence, ..
        }
        | Node::Indication {
            region_prominence, ..
        }
        | Node::Overlay {
            region_prominence, ..
        }
        | Node::Disclosure {
            region_prominence, ..
        }
        | Node::Squeeze {
            region_prominence, ..
        }
        | Node::Viewport {
            region_prominence, ..
        }
        | Node::IndentationException {
            region_prominence, ..
        } => *region_prominence,
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => None,
    }
}

fn node_children(node: &Node) -> Vec<&Node> {
    match node {
        Node::Disclosure {
            summary, children, ..
        } => {
            let mut out = vec![summary.as_ref()];
            out.extend(children.iter());
            out
        }
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.iter().collect(),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => Vec::new(),
    }
}

fn region_over_text(node: &Node, needle: &str) -> f64 {
    fn walk(node: &Node, needle: &str, acc: f64) -> Option<f64> {
        let acc = acc * node_region(node).unwrap_or(1.0);
        if let Node::Text { content, .. } = node {
            if content.contains(needle) {
                return Some(acc);
            }
        }
        for child in node_children(node) {
            if let Some(found) = walk(child, needle, acc) {
                return Some(found);
            }
        }
        None
    }
    walk(node, needle, 1.0).unwrap_or_else(|| panic!("missing {needle}"))
}

fn region_over_chrome(node: &Node, suffix: &str) -> f64 {
    fn walk(node: &Node, suffix: &str, acc: f64) -> Option<f64> {
        let acc = acc * node_region(node).unwrap_or(1.0);
        if let Node::Chrome { key: Some(key), .. } = node {
            if key.ends_with(suffix) {
                return Some(acc);
            }
        }
        for child in node_children(node) {
            if let Some(found) = walk(child, suffix, acc) {
                return Some(found);
            }
        }
        None
    }
    walk(node, suffix, 1.0).unwrap_or_else(|| panic!("missing chrome {suffix}"))
}

fn chrome_frames(node: &Node) -> Vec<(Option<String>, qd::layout_chrome::ChromeFrame)> {
    let mut out = Vec::new();
    walk_chrome(node, &mut out);
    out
}

fn walk_chrome(node: &Node, out: &mut Vec<(Option<String>, qd::layout_chrome::ChromeFrame)>) {
    match node {
        Node::Chrome { key, frame } => out.push((key.clone(), frame.clone())),
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children {
                walk_chrome(child, out);
            }
        }
        Node::Disclosure {
            summary, children, ..
        } => {
            walk_chrome(summary, out);
            for child in children {
                walk_chrome(child, out);
            }
        }
        Node::Text { .. } | Node::Markdown { .. } | Node::Diff { .. } | Node::Skipped => {}
    }
}

/// One interaction, three paints. `under` is the row after the status line.
/// `draft` is the text inside the bottom chrome, not a second copy of it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct OmniboxShot {
    phase: &'static str,
    under: String,
    draft: String,
}

fn omnibox_shot(phase: &'static str, rows: &[String]) -> OmniboxShot {
    let top = rows.iter().position(|row| row.contains('╭'));
    let body = top
        .and_then(|index| rows.get(index + 1))
        .map(String::as_str)
        .unwrap_or("");
    let inner = body
        .strip_prefix('│')
        .unwrap_or(body)
        .strip_suffix('│')
        .unwrap_or(body);
    OmniboxShot {
        phase,
        under: rows
            .get(1)
            .map(|row| row.trim().to_string())
            .unwrap_or_default(),
        draft: inner.trim().to_string(),
    }
}

#[test]
fn a_typed_draft_stays_inside_the_bottom_chrome() {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        r#"{
          "kind": "paint_init",
          "epoch": "e",
          "snapshot": {
            "kind": "root",
            "children": [
              {"kind": "stack", "children": []},
              {"kind": "composer", "draft": "", "interactive": true},
              {"kind": "statusline", "left": "feat/qd-runtime *", "cwd": "~/harness"}
            ]
          }
        }"#,
    );
    let mut present = qd::present::Present::boot(qd::present::PresentOpts {
        cols: 40,
        rows: 12,
        ..qd::present::PresentOpts::default()
    });
    present.set_retained_scene(replica.frame(40).expect("frame"));
    present.set_composer(replica.composer_face().expect("composer"));
    let empty_rows = present.content_rows();
    let empty = omnibox_shot("empty", &empty_rows);
    assert!(
        empty_rows.iter().any(|row| row.contains("Inhuman")),
        "empty thread paints the home title: {empty_rows:?}",
    );

    present.set_composer(qd::present::ComposerFace {
        draft: "input is here".to_string(),
        cursor: 13,
        ..qd::present::ComposerFace::default()
    });
    let worker = omnibox_shot("worker", &present.content_rows());

    present.push_input("!", 1);
    let echoed = omnibox_shot("echo", &present.content_rows());

    assert_eq!(
        vec![empty, worker, echoed],
        vec![
            OmniboxShot {
                phase: "empty",
                under: String::new(),
                draft: String::new(),
            },
            OmniboxShot {
                phase: "worker",
                under: String::new(),
                draft: "input is here".to_string(),
            },
            OmniboxShot {
                phase: "echo",
                under: String::new(),
                draft: "input is here!".to_string(),
            },
        ],
    );
}

const RAIL_SNAPSHOT: &str = r#"{
  "kind": "paint_init",
  "epoch": "e",
  "snapshot": {
    "kind": "root",
    "children": [
      {
        "kind": "composer",
        "draft": "",
        "interactive": true,
        "annotation": "Auth refactor",
        "hotkeys": [{ "key": "Esc", "action": "Rewind" }],
        "statusItems": ["grok-4", { "text": "act", "role": "success" }],
        "progress": 0.45,
        "progressGlowAt": 0.75
      },
      { "kind": "statusline", "left": "feat/qd-runtime *", "cwd": "~/harness" }
    ]
  }
}"#;

fn truecolor_opts(cols: u16, rows: u16) -> PresentOpts {
    PresentOpts {
        cols,
        rows,
        env: qd::present::PresentEnv {
            colorterm: Some("truecolor".to_string()),
            ..qd::present::PresentEnv::default()
        },
        ..PresentOpts::default()
    }
}

fn row_containing(rows: &[String], mark: char) -> String {
    rows.iter()
        .find(|row| row.contains(mark))
        .cloned()
        .unwrap_or_default()
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
        {
            codes.insert(format!("38;2;{r};{g};{b}"));
        }
        rest = &tail[end..];
    }
    codes
}

/// One omnibox. `keep_progress` is the only difference, so a larger truecolor
/// set is the ramp and not a second coat of the rails.
fn paint_rail_omnibox(keep_progress: bool) -> (qd::present::ComposerFace, Vec<String>, String) {
    let mut replica = PaintReplica::new();
    apply(&mut replica, RAIL_SNAPSHOT);
    let mut face = replica.composer_face().expect("composer");
    if !keep_progress {
        face.progress = None;
    }
    let mut present = Present::boot(truecolor_opts(48, 12));
    present.set_retained_scene(replica.frame(48).expect("frame"));
    present.set_composer(face.clone());
    let rows = present.content_rows();
    let paint = present.paint_if_needed(1);
    assert!(paint.caused, "omnibox paint");
    (face, rows, paint.bytes)
}

#[test]
fn the_omnibox_paints_annotation_rails_and_a_progress_ramp() {
    let (ramp_face, ramp_rows, ramp_bytes) = paint_rail_omnibox(true);
    assert_eq!(ramp_face.progress, Some(0.45));
    assert_eq!(ramp_face.progress_glow_at, Some(0.75));
    let top = row_containing(&ramp_rows, '╭');
    let bottom = row_containing(&ramp_rows, '╰');
    assert!(top.contains("Auth refactor"), "{top}");
    assert!(top.contains("Rewind"), "{top}");
    assert!(bottom.contains("grok-4"), "{bottom}");
    assert!(bottom.contains("act"), "{bottom}");

    let (_flat_face, flat_rows, flat_bytes) = paint_rail_omnibox(false);
    let flat_bottom = row_containing(&flat_rows, '╰');
    assert!(
        flat_bottom.contains("grok-4") && flat_bottom.contains("act"),
        "{flat_bottom}"
    );

    let ramp_colors = truecolor_codes(&ramp_bytes);
    let flat_colors = truecolor_codes(&flat_bytes);
    assert!(
        flat_colors.is_subset(&ramp_colors) && ramp_colors.len() > flat_colors.len(),
        "flat {flat_colors:?}\nramp {ramp_colors:?}"
    );
}

const SLASH_SNAPSHOT: &str = r#"{
  "kind": "paint_init",
  "epoch": "e1",
  "snapshot": {
    "kind": "root",
    "children": [
      {
        "kind": "composer",
        "draft": "/co",
        "cursor": 3,
        "annotation": "Auth refactor",
        "statusItems": ["grok-4"],
        "commandChoices": [
          {
            "key": "catalog:connect",
            "name": "/connect",
            "description": "Bind a source",
            "actions": [{ "name": "select", "displayName": "select", "hotkey": "Enter" }]
          },
          {
            "key": "catalog:model",
            "name": "/model",
            "description": "Session model",
            "actions": [{ "name": "select", "displayName": "select", "hotkey": "Enter" }]
          }
        ],
        "selectedCommandKey": "catalog:connect"
      }
    ]
  }
}"#;

fn slash_rows(bytes: &str) -> (qd::present::ComposerFace, Vec<String>) {
    let mut replica = PaintReplica::new();
    apply(&mut replica, bytes);
    let face = replica.composer_face().expect("composer");
    let mut present = Present::boot(truecolor_opts(48, 16));
    present.set_retained_scene(replica.frame(48).expect("frame"));
    present.set_composer(face.clone());
    let rows = present.content_rows();
    (face, rows)
}

#[test]
fn the_slash_catalog_paints_above_the_draft() {
    let (face, rows) = slash_rows(SLASH_SNAPSHOT);
    let picker = face.picker.expect("choices");
    assert_eq!(picker.rows.len(), 2);
    assert!(!picker.fallback);
    let joined = rows.join("\n");
    let top = row_containing(&rows, '╭');
    let join = row_containing(&rows, '├');
    let bottom = row_containing(&rows, '╰');
    assert_eq!(
        rows.iter().filter(|row| row.contains('╭')).count(),
        1,
        "{joined}"
    );
    assert!(top.contains("Auth refactor"), "{top}");
    assert!(join.contains("select"), "{join}");
    assert!(bottom.contains("grok-4"), "{bottom}");
    assert!(joined.contains('›'), "{joined}");
    assert!(joined.contains("/model"), "{joined}");
    assert!(joined.contains("Bind a source"), "{joined}");
    let draft = rows
        .iter()
        .find(|row| row.contains("nnect") && !row.contains("Bind"))
        .map(String::as_str)
        .unwrap_or("");
    assert!(draft.contains("/co"), "{joined}");
}

#[test]
fn an_empty_choice_list_paints_the_command_action() {
    let (face, rows) = slash_rows(
        r#"{
          "kind": "paint_init",
          "epoch": "e1",
          "snapshot": {
            "kind": "root",
            "children": [{
              "kind": "composer",
              "draft": "/connect ",
              "commandChoices": [],
              "commandAction": {
                "name": "Bind a source",
                "displayName": "Bind a source",
                "actions": [{ "name": "select", "displayName": "select", "hotkey": "Enter" }]
              }
            }]
          }
        }"#,
    );
    let picker = face.picker.expect("action row");
    assert!(picker.fallback);
    assert_eq!(picker.rows.len(), 1);
    let joined = rows.join("\n");
    assert!(joined.contains("Bind a source"), "{joined}");
    assert!(joined.contains('├'), "{joined}");
    assert!(row_containing(&rows, '├').contains("select"), "{joined}");
}

const FAILURE_MESSAGE: &str = "completion POST https://cli-chat-proxy.grok.com/v1/chat/completions: HTTP 426 please update via grok update";

fn wait_frame(name: &str, object: &str, status: &str, state: &str) -> Node {
    let mut replica = PaintReplica::new();
    apply(
        &mut replica,
        &format!(
            r#"{{"kind":"paint_init","epoch":"e","snapshot":{{"kind":"root","children":[{{"kind":"wait","name":"{name}","object":"{object}","status":"{status}","state":"{state}"}}]}}}}"#
        ),
    );
    replica.frame(32).expect("frame")
}

struct IdentityWrap {
    white_space: WhiteSpace,
    line_clamp: Option<i64>,
    content: String,
}

fn identity_wrap(node: &Node, needle: &str) -> Option<IdentityWrap> {
    match node {
        Node::Text {
            content,
            white_space,
            line_clamp,
            ..
        } if content.contains(needle) => Some(IdentityWrap {
            white_space: white_space.unwrap_or(WhiteSpace::Normal),
            line_clamp: *line_clamp,
            content: content.clone(),
        }),
        Node::Text { .. } => None,
        Node::Disclosure {
            summary, children, ..
        } => identity_wrap(summary, needle).or_else(|| {
            children
                .iter()
                .find_map(|child| identity_wrap(child, needle))
        }),
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children
            .iter()
            .find_map(|child| identity_wrap(child, needle)),
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => None,
    }
}

fn pin_with<'a>(node: &'a Node, needle: &str) -> Option<&'a Node> {
    match node {
        Node::Disclosure { summary, .. } if contains_text(summary, needle) => Some(node),
        Node::Disclosure {
            summary, children, ..
        } => pin_with(summary, needle)
            .or_else(|| children.iter().find_map(|child| pin_with(child, needle))),
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            children.iter().find_map(|child| pin_with(child, needle))
        }
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => None,
    }
}

#[test]
fn a_failed_wait_pin_wraps_the_whole_message() {
    let failed = wait_frame("error", FAILURE_MESSAGE, "", "fail");
    let wrap = identity_wrap(&failed, "via grok update").expect("failure text");
    assert_eq!(
        (
            wrap.white_space,
            wrap.line_clamp,
            wrap.content.contains(FAILURE_MESSAGE)
        ),
        (WhiteSpace::PreWrap, None, true),
    );
    let pin = pin_with(&failed, "via grok update").expect("pin");
    let painted = painted_cells(pin, 32, 8);
    let filled: Vec<&str> = painted
        .lines()
        .filter(|row| !row.trim().is_empty())
        .collect();
    let flat = painted.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(filled.len() > 1, "{painted}");
    assert!(flat.contains("via grok update"), "{painted}");
    assert!(!painted.contains('…'), "{painted}");

    let live = wait_frame(
        "connecting",
        "",
        "waiting for response... and then a tail that must stay clamped",
        "live",
    );
    let live_wrap = identity_wrap(&live, "must stay clamped").expect("live text");
    assert_eq!(
        (live_wrap.white_space, live_wrap.line_clamp),
        (WhiteSpace::Nowrap, Some(1)),
    );
    let live_pin = pin_with(&live, "must stay clamped").expect("live pin");
    let live_painted = painted_cells(live_pin, 32, 4);
    assert!(live_painted.contains('…'), "{live_painted}");
    assert!(
        !live_painted.contains("must stay clamped"),
        "{live_painted}"
    );
}
