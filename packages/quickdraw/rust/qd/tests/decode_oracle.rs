//! Oracle for `qd::decode`, matching `packages/quickdraw/src/input/__tests__/decode.test.ts`
//! plus the `consumeKeys` rows in `layout.test.ts` and `runtime/__tests__/keys.test.ts`.

use std::env;
use std::process::{Command, Stdio};

use qd::decode::{
    consume_keys, flush_pending_esc, layout_table, ConsumeKeysResult, InputEvent, LayoutTable, Rgb,
    MAX_OSC_BODY,
};

fn ch(text: &str) -> InputEvent {
    InputEvent::Char {
        ch: text.to_string(),
    }
}

fn chars(text: &str) -> Vec<InputEvent> {
    text.chars()
        .map(|c| InputEvent::Char { ch: c.to_string() })
        .collect()
}

fn enter(shift: bool, alt: bool, ctrl: bool, meta: bool) -> InputEvent {
    InputEvent::Enter {
        shift,
        alt,
        ctrl,
        meta,
    }
}

fn esc(shift: bool, alt: bool, ctrl: bool, meta: bool) -> InputEvent {
    InputEvent::Esc {
        shift,
        alt,
        ctrl,
        meta,
    }
}

fn ground(r: u8, g: u8, b: u8) -> InputEvent {
    InputEvent::OscGround {
        rgb: Rgb { r, g, b },
    }
}

fn play(chunks: &[&str], flush: bool) -> ConsumeKeysResult {
    let mut pending = String::new();
    let mut result = ConsumeKeysResult {
        events: Vec::new(),
        pending: String::new(),
    };
    for chunk in chunks {
        result = consume_keys(chunk, &pending, LayoutTable::On);
        pending.clone_from(&result.pending);
    }
    if flush {
        result = flush_pending_esc(&result.pending);
    }
    result
}

fn check(
    failures: &mut Vec<String>,
    name: &str,
    chunks: &[&str],
    flush: bool,
    events: Vec<InputEvent>,
    pending: &str,
) {
    let got = play(chunks, flush);
    if got.events != events || got.pending != pending {
        failures.push(format!(
            "{name}\n  got events: {:?}\n  want events: {:?}\n  got pending: {:?}\n  want pending: {pending:?}",
            got.events, events, got.pending
        ));
    }
}

#[test]
fn decode_oracle_matches_typescript() {
    assert_eq!(MAX_OSC_BODY, 512);
    let mut failures = Vec::new();
    let dark = ground(21, 25, 30);
    let black = ground(0, 0, 0);
    let mut hello = vec![dark.clone()];
    hello.extend(chars("hello"));

    check(
        &mut failures,
        "OSC 11 BEL swallow then chars",
        &["\x1b]11;rgb:158e/193a/1e75\x07hello"],
        false,
        hello,
        "",
    );
    check(
        &mut failures,
        "OSC 11 ST swallow",
        &["\x1b]11;rgb:0000/0000/0000\x1b\\"],
        false,
        vec![black],
        "",
    );
    check(
        &mut failures,
        "incomplete OSC held",
        &["\x1b]11;rgb:158e"],
        false,
        vec![],
        "\x1b]11;rgb:158e",
    );
    check(
        &mut failures,
        "incomplete OSC completes across chunks",
        &["\x1b]11;rgb:158e", "/193a/1e75\x07"],
        false,
        vec![dark],
        "",
    );
    let abandon = format!("\x1b]{}hello", "x".repeat(MAX_OSC_BODY));
    check(
        &mut failures,
        "MAX_OSC_BODY abandon (C8)",
        &[&abandon],
        false,
        chars("hello"),
        "",
    );
    let half = MAX_OSC_BODY / 2;
    let first = format!("\x1b]{}", "a".repeat(half));
    let rest = format!("{}z", "b".repeat(MAX_OSC_BODY - half + 10));
    check(
        &mut failures,
        "MAX_OSC_BODY bound across chunks",
        &[&first, &rest],
        false,
        chars(&format!("{}z", "b".repeat(10))),
        "",
    );
    check(
        &mut failures,
        "paste CSI 200~ body",
        &["\x1b[200~hello\nworld\x1b[201~"],
        false,
        vec![InputEvent::Paste {
            text: "hello\nworld".into(),
        }],
        "",
    );
    check(
        &mut failures,
        "paste CRLF dedent",
        &["\x1b[200~  a\r\n  b\r\n\x1b[201~"],
        false,
        vec![InputEvent::Paste {
            text: "a\nb".into(),
        }],
        "",
    );
    check(
        &mut failures,
        "incomplete paste held",
        &["\x1b[200~partial"],
        false,
        vec![],
        "\x1b[200~partial",
    );
    check(
        &mut failures,
        "incomplete paste completes across chunks",
        &["\x1b[200~partial", " more\x1b[201~x"],
        false,
        vec![
            InputEvent::Paste {
                text: "partial more".into(),
            },
            ch("x"),
        ],
        "",
    );
    check(
        &mut failures,
        "stray paste-end swallowed",
        &["\x1b[201~hi"],
        false,
        chars("hi"),
        "",
    );
    check(
        &mut failures,
        "normalizePaste leading blanks",
        &["\x1b[200~\r\n\r\n  x\r\n\x1b[201~"],
        false,
        vec![InputEvent::Paste { text: "x".into() }],
        "",
    );
    check(
        &mut failures,
        "lone ESC held",
        &["\x1b"],
        false,
        vec![],
        "\x1b",
    );
    check(
        &mut failures,
        "incomplete CSI held",
        &["\x1b["],
        false,
        vec![],
        "\x1b[",
    );
    check(
        &mut failures,
        "incomplete CSI params held",
        &["\x1b[1"],
        false,
        vec![],
        "\x1b[1",
    );
    check(
        &mut failures,
        "incomplete SS3 held",
        &["\x1bO"],
        false,
        vec![],
        "\x1bO",
    );
    check(
        &mut failures,
        "split ESC then [C",
        &["\x1b", "[C"],
        false,
        vec![InputEvent::Right { select: false }],
        "",
    );
    check(
        &mut failures,
        "split ESC[ then C",
        &["\x1b[", "C"],
        false,
        vec![InputEvent::Right { select: false }],
        "",
    );
    check(
        &mut failures,
        "split ctrl-right",
        &["\x1b", "[1;5C"],
        false,
        vec![InputEvent::End { select: false }],
        "",
    );
    check(
        &mut failures,
        "flushPendingEsc lone ESC",
        &["\x1b"],
        true,
        vec![esc(false, false, false, false)],
        "",
    );
    check(
        &mut failures,
        "flushPendingEsc incomplete CSI",
        &["\x1b["],
        true,
        vec![],
        "\x1b[",
    );
    check(
        &mut failures,
        "flushPendingEsc empty",
        &[],
        true,
        vec![],
        "",
    );
    check(
        &mut failures,
        "raw Ctrl+Z",
        &["\x1a"],
        false,
        vec![InputEvent::Undo],
        "",
    );
    check(
        &mut failures,
        "raw Ctrl+Y",
        &["\x19"],
        false,
        vec![InputEvent::Redo],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+Z",
        &["\x1b[122;5u"],
        false,
        vec![InputEvent::Undo],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+Shift+Z",
        &["\x1b[122;6u"],
        false,
        vec![InputEvent::Redo],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+Y",
        &["\x1b[121;5u"],
        false,
        vec![InputEvent::Redo],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+Z",
        &["\x1b[122;9u"],
        false,
        vec![InputEvent::Undo],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+Shift+Z",
        &["\x1b[122;10u"],
        false,
        vec![InputEvent::Redo],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+Y",
        &["\x1b[121;9u"],
        false,
        vec![InputEvent::Redo],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+A select all",
        &["\x1b[97;9u"],
        false,
        vec![InputEvent::SelectAll],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+C not ctrl_c",
        &["\x1b[99;9u"],
        false,
        vec![],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+Backspace kill-to-start",
        &["\x1b[127;9u"],
        false,
        vec![InputEvent::KillToStart],
        "",
    );
    check(
        &mut failures,
        "CSI-u Alt+Backspace word",
        &["\x1b[127;3u"],
        false,
        vec![InputEvent::WordBackspace],
        "",
    );
    check(
        &mut failures,
        "CSI-u Backspace",
        &["\x1b[127u"],
        false,
        vec![InputEvent::Backspace],
        "",
    );
    check(
        &mut failures,
        "report-all-keys CSI-u a",
        &["\x1b[97u"],
        false,
        vec![ch("a")],
        "",
    );
    check(
        &mut failures,
        "report-all-keys CSI-u Shift+A",
        &["\x1b[65;2u"],
        false,
        vec![ch("A")],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_ALT not printable",
        &["\x1b[57443u"],
        false,
        vec![],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_ALT+alt not printable",
        &["\x1b[57443;3u"],
        false,
        vec![],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_SHIFT not printable",
        &["\x1b[57441u"],
        false,
        vec![],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_CONTROL persist mod down",
        &["\x1b[57442u"],
        false,
        vec![InputEvent::Mod {
            persist: true,
            down: true,
        }],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_SUPER persist mod down",
        &["\x1b[57444u"],
        false,
        vec![InputEvent::Mod {
            persist: true,
            down: true,
        }],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_SUPER press with super bit (spec)",
        &["\x1b[57444;9u"],
        false,
        vec![InputEvent::Mod {
            persist: true,
            down: true,
        }],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_SUPER press event-typed with super bit",
        &["\x1b[57444;9:1u"],
        false,
        vec![InputEvent::Mod {
            persist: true,
            down: true,
        }],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_SUPER release with super bit",
        &["\x1b[57444;9:3u"],
        false,
        vec![InputEvent::Mod {
            persist: true,
            down: false,
        }],
        "",
    );
    check(
        &mut failures,
        "CSI-u LEFT_CONTROL persist mod up",
        &["\x1b[57442;1:3u"],
        false,
        vec![InputEvent::Mod {
            persist: true,
            down: false,
        }],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+Enter keeps ctrl",
        &["\x1b[13;5u"],
        false,
        vec![enter(false, false, true, false)],
        "",
    );
    check(
        &mut failures,
        "CSI-u Shift+Enter keeps shift",
        &["\x1b[13;2u"],
        false,
        vec![enter(true, false, false, false)],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+Enter keeps meta",
        &["\x1b[13;9u"],
        false,
        vec![enter(false, false, false, true)],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+Esc keeps ctrl",
        &["\x1b[27;5u"],
        false,
        vec![esc(false, false, true, false)],
        "",
    );
    check(
        &mut failures,
        "modifyOtherKeys Ctrl+Enter keeps ctrl",
        &["\x1b[27;5;13~"],
        false,
        vec![enter(false, false, true, false)],
        "",
    );
    check(
        &mut failures,
        "C0 LF stays newline",
        &["\n"],
        false,
        vec![InputEvent::ShiftEnter],
        "",
    );
    check(
        &mut failures,
        "CSI-u Shift+a associated text is A",
        &["\x1b[97;2;65u"],
        false,
        vec![ch("A")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Shift+a shifted subfield is A",
        &["\x1b[97:65;2u"],
        false,
        vec![ch("A")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Shift+a identity-only case-folds A",
        &["\x1b[97;2u"],
        false,
        vec![ch("A")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Caps+a is A",
        &["\x1b[97;65u"],
        false,
        vec![ch("A")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Caps+Shift+a is a",
        &["\x1b[97;66u"],
        false,
        vec![ch("a")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Shift+1 associated text is !",
        &["\x1b[49;2;33u"],
        false,
        vec![ch("!")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Shift+1 shifted subfield is !",
        &["\x1b[49:33;2u"],
        false,
        vec![ch("!")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Shift+1 identity-only stays 1",
        &["\x1b[49;2u"],
        false,
        vec![ch("1")],
        "",
    );
    check(
        &mut failures,
        "CSI-u key 0 associated text is å",
        &["\x1b[0;;229u"],
        false,
        vec![ch("\u{00e5}")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+c is still ctrl_c",
        &["\x1b[99;5u"],
        false,
        vec![InputEvent::CtrlC],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+Shift+c is still ctrl_c not glyph",
        &["\x1b[99;6u"],
        false,
        vec![InputEvent::CtrlC],
        "",
    );
    check(
        &mut failures,
        "modifyOtherKeys Shift+a case-folds A",
        &["\x1b[27;2;97~"],
        false,
        vec![ch("A")],
        "",
    );
    check(
        &mut failures,
        "CSI-u Caps Lock key is not a glyph",
        &["\x1b[57358u"],
        false,
        vec![],
        "",
    );
    check(&mut failures, "plain j", &["j"], false, vec![ch("j")], "");
    check(&mut failures, "plain k", &["k"], false, vec![ch("k")], "");
    check(
        &mut failures,
        "CSI-u letter j",
        &["\x1b[106u"],
        false,
        vec![ch("j")],
        "",
    );
    check(
        &mut failures,
        "arrow CSI down",
        &["\x1b[B"],
        false,
        vec![InputEvent::Down { select: false }],
        "",
    );
    check(
        &mut failures,
        "arrow CSI up",
        &["\x1b[A"],
        false,
        vec![InputEvent::Up { select: false }],
        "",
    );
    check(
        &mut failures,
        "SS3 application down",
        &["\x1bOB"],
        false,
        vec![InputEvent::Down { select: false }],
        "",
    );
    check(
        &mut failures,
        "SGR mouse release",
        &["\x1b[<0;5;10m"],
        false,
        vec![InputEvent::Mouse {
            button: 0,
            col: 5,
            row: 10,
            release: true,
        }],
        "",
    );
    check(
        &mut failures,
        "raw Ctrl+V",
        &["\x16"],
        false,
        vec![InputEvent::CtrlV],
        "",
    );
    check(
        &mut failures,
        "CSI-u Ctrl+V",
        &["\x1b[118;5u"],
        false,
        vec![InputEvent::CtrlV],
        "",
    );
    check(
        &mut failures,
        "modifyOtherKeys Ctrl+V",
        &["\x1b[27;5;118~"],
        false,
        vec![InputEvent::CtrlV],
        "",
    );
    check(
        &mut failures,
        "CSI-u Cmd+V is not paste",
        &["\x1b[118;9u"],
        false,
        vec![],
        "",
    );

    // keys.test.ts consumeKeys rows that decode.test.ts does not already name.
    check(
        &mut failures,
        "keys Tab",
        &["\t"],
        false,
        vec![InputEvent::Tab],
        "",
    );
    check(
        &mut failures,
        "keys CSI Z shift_tab",
        &["\x1b[Z"],
        false,
        vec![InputEvent::ShiftTab],
        "",
    );
    check(
        &mut failures,
        "keys CSI-u Shift+Tab",
        &["\x1b[9;2u"],
        false,
        vec![InputEvent::ShiftTab],
        "",
    );
    check(
        &mut failures,
        "keys modifyOtherKeys Shift+Tab",
        &["\x1b[27;2;9~"],
        false,
        vec![InputEvent::ShiftTab],
        "",
    );
    check(
        &mut failures,
        "keys raw Ctrl+X",
        &["\x18"],
        false,
        vec![InputEvent::CtrlX],
        "",
    );
    check(
        &mut failures,
        "keys CSI-u Ctrl+X",
        &["\x1b[120;5u"],
        false,
        vec![InputEvent::CtrlX],
        "",
    );
    check(
        &mut failures,
        "keys raw Ctrl+O",
        &["\x0f"],
        false,
        vec![InputEvent::CtrlO],
        "",
    );
    check(
        &mut failures,
        "keys CSI-u Ctrl+O",
        &["\x1b[111;5u"],
        false,
        vec![InputEvent::CtrlO],
        "",
    );
    check(
        &mut failures,
        "keys raw Ctrl+A home",
        &["\x01"],
        false,
        vec![InputEvent::Home { select: false }],
        "",
    );

    if env::var("QD_NO_LAYOUT_TABLE").ok().as_deref() == Some("1") {
        failures.push("QD_NO_LAYOUT_TABLE=1 is set; layout oracle expects the ladder on".into());
    } else {
        let es = "\u{0441}";
        check(
            &mut failures,
            "Ctrl+с (CSI 1089;5u) → ctrl_c",
            &["\x1b[1089;5u"],
            false,
            vec![InputEvent::CtrlC],
            "",
        );
        check(
            &mut failures,
            "Ctrl+м (CSI 1084;5u) → ctrl_v",
            &["\x1b[1084;5u"],
            false,
            vec![InputEvent::CtrlV],
            "",
        );
        check(
            &mut failures,
            "bare с is text",
            &[es],
            false,
            vec![ch(es)],
            "",
        );
        check(
            &mut failures,
            "Cyrillic main + Latin base subfield → Latin shortcut",
            &["\x1b[1089:1057:99;5u"],
            false,
            vec![InputEvent::CtrlC],
            "",
        );
        check(
            &mut failures,
            "base subfield ABSENT → static table (iTerm2)",
            &["\x1b[1089;5u"],
            false,
            vec![InputEvent::CtrlC],
            "",
        );
        check(
            &mut failures,
            "main==shifted nonconformant → ignore bogus base",
            &["\x1b[1089:1089:113;5u"],
            false,
            vec![InputEvent::CtrlC],
            "",
        );
        check(
            &mut failures,
            "bare non-Latin typing no mods → text",
            &["\x1b[1089:1057:99u"],
            false,
            vec![ch(es)],
            "",
        );
        check(
            &mut failures,
            "mintty flag-1 lookalike is not flag 4",
            &["\x1b[1089;5u"],
            false,
            vec![InputEvent::CtrlC],
            "",
        );
        check(
            &mut failures,
            "mod-field event-type colon does not collide with key-field colons",
            &["\x1b[1089:1057:99;5:1u"],
            false,
            vec![InputEvent::CtrlC],
            "",
        );
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn theme_reports_survive_every_chunk_boundary() {
    for mode in [1, 2] {
        let report = format!("\x1b[?997;{mode}n");
        let chars: Vec<char> = report.chars().collect();
        for split in 1..chars.len() {
            let left: String = chars[..split].iter().collect();
            let right: String = chars[split..].iter().collect();
            let got = play(&[&left, &right], false);
            assert_eq!(got.pending, "", "mode {mode} split {split}");
            assert_eq!(
                got.events,
                vec![InputEvent::ThemeChanged],
                "mode {mode} split {split}"
            );
        }
    }
}

/// `std::env::set_var` is unsafe on this toolchain. The child is spawned
/// with `QD_NO_LAYOUT_TABLE=1` already in its environment, which is the
/// same toggle layout.test.ts applies around `consumeKeys`.
#[test]
fn qd_no_layout_table_disables_static_and_flag4() {
    if env::var("QD_DECODE_LAYOUT_CHILD").ok().as_deref() == Some("1") {
        let table = layout_table(env::var("QD_NO_LAYOUT_TABLE").ok().as_deref());
        let on = consume_keys("\x1b[1089;5u", "", LayoutTable::On);
        assert_eq!(on.events, vec![InputEvent::CtrlC]);
        let bare = consume_keys("\x1b[1089;5u", "", table);
        assert_eq!(bare.events, Vec::<InputEvent>::new());
        assert_eq!(bare.pending, "");
        let on_flag = consume_keys("\x1b[1089:1057:99;5u", "", LayoutTable::On);
        assert_eq!(on_flag.events, vec![InputEvent::CtrlC]);
        let flag4 = consume_keys("\x1b[1089:1057:99;5u", "", table);
        assert_eq!(flag4.events, Vec::<InputEvent>::new());
        assert_eq!(flag4.pending, "");
        return;
    }
    let name = std::thread::current().name().unwrap_or("").to_string();
    assert!(
        name.contains("qd_no_layout_table_disables_static_and_flag4"),
        "{name}"
    );
    let exe = env::current_exe().expect("test executable path");
    let output = Command::new(exe)
        .env("QD_NO_LAYOUT_TABLE", "1")
        .env("QD_DECODE_LAYOUT_CHILD", "1")
        .arg(&name)
        .arg("--exact")
        .stdin(Stdio::null())
        .output()
        .expect("spawn layout-table child");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "{text}");
    assert!(text.contains("1 passed"), "{text}");
}
