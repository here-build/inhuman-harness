use ratatui::buffer::Buffer as RatatuiBuffer;
use ratatui::layout::Rect as RatatuiRect;

use qd::paint_replica::{PaintError, PaintReplica, PatchTally, ReplicaNote, SyntaxPolarity};

fn buffer_text(buf: &RatatuiBuffer) -> String {
    let mut out = String::new();
    for y in buf.area.top()..buf.area.bottom() {
        for x in buf.area.left()..buf.area.right() {
            out.push_str(buf.get(x, y).symbol());
        }
        out.push('\n');
    }
    out
}

#[test]
fn paint_replica_parses_once_splices_in_place_and_keeps_sibling_nodes() {
    let mut replica = PaintReplica::new();
    let init = br#"{
        "kind": "paint_init",
        "epoch": "e1",
        "snapshot": {
            "kind": "root",
            "children": [
                {
                    "kind": "turn",
                    "children": [
                        {"kind": "speech", "voice": "user", "text": "hello ", "ended": true},
                        {"kind": "speech", "voice": "assistant", "text": "world", "ended": false},
                        {"kind": "thinking", "text": "step one"}
                    ]
                },
                {
                    "kind": "composer",
                    "draft": "/conn",
                    "placeholder": "ask anything",
                    "cursor": 5,
                    "interactive": true,
                    "readOnly": false
                }
            ]
        }
    }"#;
    let root = replica.apply(init).expect("init");
    assert_eq!(replica.epoch(), Some("e1"));
    assert_eq!(replica.seq(), 0);
    assert_eq!(replica.kind(root), Some("root"));
    assert_eq!(replica.child_count(root), Some(2));
    assert_eq!(replica.take_patch_tally(), None);

    let turn = replica.child(root, 0).expect("turn");
    let user = replica.child(turn, 0).expect("user speech");
    let assistant = replica.child(turn, 1).expect("assistant speech");
    let thinking = replica.child(turn, 2).expect("thinking");
    let composer = replica.child(root, 1).expect("composer");
    assert_eq!(replica.expands(user), Some(1));
    assert_eq!(replica.expands(assistant), Some(1));

    // Splice on the assistant speech, including a surrogate pair index.
    let patch_1 = br#"{
        "kind": "paint_patch",
        "epoch": "e1",
        "seq": 1,
        "patches": [
            {"op": "splice", "path": "/children/0/children/1/text", "from": 5, "deleteCount": 0, "insert": " \uD83D\uDE00!"},
            {"op": "splice", "path": "/children/0/children/1/text", "from": 8, "deleteCount": 1, "insert": "?"}
        ]
    }"#;
    replica.apply(patch_1).expect("patch 1");
    replica.note_replica(ReplicaNote::Patch);
    assert_eq!(replica.seq(), 1);
    assert_eq!(replica.child(turn, 0), Some(user));
    assert_eq!(replica.child(turn, 1), Some(assistant));
    assert_eq!(replica.text(assistant), Some("world 😀?"));

    let tally = replica.take_patch_tally().expect("armed");
    assert_eq!(
        tally,
        PatchTally {
            rebuilt: vec!["root", "turn", "speech"],
            cached: vec!["composer", "thinking"],
        }
    );
    assert_eq!(
        tally.line(replica.seq()),
        "seq=1 rebuilt=root,turn,speech cached=composer,thinking"
    );
    assert_eq!(replica.expands(user), Some(1));
    assert_eq!(replica.expands(assistant), Some(2));

    // Structural replace of child 2 allocates a new NodeRef; siblings keep theirs.
    let patch_2 = br#"{
        "kind": "paint_patch",
        "epoch": "e1",
        "seq": 2,
        "patches": [
            {"op": "replace", "path": "/children/0/children/2", "value": {"kind": "thinking", "text": "step two"}},
            {"op": "add", "path": "/children/0/children/-", "value": {"kind": "recall", "text": "3 files"}}
        ]
    }"#;
    replica.apply(patch_2).expect("patch 2");
    assert_eq!(replica.child(turn, 0), Some(user));
    assert_eq!(replica.child(turn, 1), Some(assistant));
    let new_thinking = replica.child(turn, 2).expect("replaced thinking");
    assert_ne!(new_thinking, thinking);
    assert_eq!(replica.text(new_thinking), Some("step two"));
    assert_eq!(replica.child_count(turn), Some(4));
    replica.note_replica(ReplicaNote::Patch);
    let _ = replica.take_patch_tally();

    // Polarity flip dirties speech and composer, not thinking.
    replica.set_syntax_polarity(SyntaxPolarity::Light);
    replica.note_replica(ReplicaNote::Patch);
    let tally = replica.take_patch_tally().expect("polarity tally");
    assert_eq!(
        tally.line(replica.seq()),
        "seq=2 rebuilt=composer,root,turn,speech cached=thinking,recall"
    );
    assert_eq!(replica.child(root, 1), Some(composer));
}

#[test]
fn paint_replica_fails_seq_gap_epoch_mismatch_and_patch_before_init() {
    let mut replica = PaintReplica::new();
    let patch = br#"{"kind":"paint_patch","epoch":"e1","seq":1,"patches":[]}"#;
    assert_eq!(replica.apply(patch), Err(PaintError::PatchBeforeInit));

    let init = br#"{"kind":"paint_init","epoch":"e1","snapshot":{"kind":"root","children":[]}}"#;
    replica.apply(init).expect("init");
    assert_eq!(
        replica.apply(br#"{"kind":"paint_patch","epoch":"e2","seq":1,"patches":[]}"#),
        Err(PaintError::EpochMismatch {
            expected: "e1".into(),
            got: "e2".into(),
        })
    );
    assert_eq!(
        replica.apply(br#"{"kind":"paint_patch","epoch":"e1","seq":3,"patches":[]}"#),
        Err(PaintError::SeqGap {
            expected: 1,
            got: 3,
        })
    );
    assert_eq!(replica.seq(), 0);
}

#[test]
fn paint_replica_renders_ratatui_scene_and_handles_phase_and_flags() {
    let mut replica = PaintReplica::new();
    let init = br#"{
        "kind": "paint_init",
        "epoch": "e1",
        "snapshot": {
            "kind": "root",
            "children": [
                {
                    "kind": "statusline",
                    "left": "claude-sonnet-4-5",
                    "cwd": "~/repo/pkg",
                    "cwdRoot": "~/repo",
                    "note": "main"
                },
                {
                    "kind": "stack",
                    "children": [
                        {
                            "kind": "turn",
                            "children": [
                                {"kind": "speech", "voice": "user", "text": "hello user", "atMs": 52500000},
                                {
                                    "kind": "completion",
                                    "state": "sealed",
                                    "thoughtLive": false,
                                    "durationMs": 4200,
                                    "model": "claude-sonnet-4-5",
                                    "children": [
                                        {"kind": "thinking", "text": "step 1\nstep 2"},
                                        {"kind": "speech", "voice": "assistant", "text": "assistant reply", "ended": true, "atMs": 52560000}
                                    ]
                                },
                                {
                                    "kind": "tool",
                                    "name": "edit_file",
                                    "object": "src/main.rs",
                                    "status": "+1 -1",
                                    "state": "done",
                                    "receiptKind": "diff",
                                    "diffOld": "old line\n",
                                    "diffNew": "new line\n",
                                    "diffPath": "src/main.rs"
                                },
                                {"kind": "recall", "text": "2 memories recalled"},
                                {"kind": "compact", "text": "Compacted 4 turns"},
                                {"kind": "failure", "endDetail": "rate limit exceeded", "failReason": "error"}
                            ]
                        }
                    ]
                },
                {
                    "kind": "wait",
                    "name": "wait",
                    "status": "thinking",
                    "object": "",
                    "state": "live",
                    "startedAt": 1000
                },
                {
                    "kind": "agents",
                    "meterLeft": "2 running",
                    "meterRight": "1Sub",
                    "open": false,
                    "previewKey": ""
                },
                {
                    "kind": "rewind",
                    "atTip": true,
                    "seatRim": true,
                    "past": [{"key": "p1", "text": "previous prompt"}]
                },
                {
                    "kind": "composer",
                    "draft": "hello draft",
                    "placeholder": "Ask anything...",
                    "annotation": "normal",
                    "interactive": true,
                    "readOnly": false,
                    "contextUsed": 12000,
                    "contextLimit": 200000,
                    "statusItems": ["opus 4.6"],
                    "hotkeys": [{"key": "Enter", "action": "send"}]
                }
            ]
        }
    }"#;
    replica.apply(init).expect("init");
    assert!(replica.seat_rim());
    assert!(!replica.agents_preview_open());
    assert!(replica.set_phase("warming caches"));
    assert!(!replica.set_phase("warming caches"));
    replica.note_syntax_warm();

    let area = RatatuiRect::new(0, 0, 100, 40);
    let mut rbuf = RatatuiBuffer::empty(area);
    replica.render_ratatui(area, &mut rbuf, 5000.0);
    let rendered = buffer_text(&rbuf);

    assert!(rendered.contains("claude-sonnet-4-5"), "missing statusline:\n{rendered}");
    assert!(rendered.contains("hello user"), "missing user speech:\n{rendered}");
    assert!(rendered.contains("assistant reply"), "missing assistant speech:\n{rendered}");
    assert!(rendered.contains("src/main.rs"), "missing tool cell:\n{rendered}");
    assert!(rendered.contains("2 memories recalled"), "missing recall:\n{rendered}");
    assert!(rendered.contains("Compacted 4 turns"), "missing compact:\n{rendered}");
    assert!(rendered.contains("rate limit exceeded"), "missing failure:\n{rendered}");
    assert!(rendered.contains("warming caches"), "missing phase wait pin:\n{rendered}");
    assert!(rendered.contains("2 running"), "missing agents meter:\n{rendered}");
    assert!(rendered.contains("previous prompt"), "missing rewind pin:\n{rendered}");
    assert!(rendered.contains("hello draft"), "missing composer draft:\n{rendered}");

    let qd_buf = replica.render_ratatui_to_qd(100, 40, 5000.0);
    assert_eq!(qd_buf.width(), 100);
    assert_eq!(qd_buf.height(), 40);
}
