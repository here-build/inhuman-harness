//! Twin of `packages/quickdraw/src/capabilities/__tests__/probe.test.ts`.
//! The probe is fed bytes the test already has. Nothing waits on a clock.

use qd::capabilities::{
    extract_osc11_from_buffer, guess_color_depth, has_da1_reply, osc52_set, parse_decrqm_2026,
    parse_osc11_payload, parse_osc_color_payload, parse_probe_replies, probe_query, settle_probe,
    strip_probe_replies, terminal_caps, CapabilityEnv, ClipboardSelect, ColorDepth, DetectResult,
    ProbeOutcome, Rgb, SettleInput, TerminalCaps, DA1_QUERY, DECRQM_2026, DEFAULT_PROBE_TIMEOUT_MS,
    OSC10_QUERY, OSC11_QUERY, PROBE_BATCH, THEME_REPORT_DISABLE, THEME_REPORT_ENABLE,
    XTVERSION_QUERY,
};

fn check<T, U>(failures: &mut Vec<String>, label: &str, got: T, want: U)
where
    T: PartialEq<U> + std::fmt::Debug,
    U: std::fmt::Debug,
{
    if got != want {
        failures.push(format!("{label}\n  got: {got:?}\n  want: {want:?}"));
    }
}

fn settle<'a>(
    env: &'a CapabilityEnv,
    received: &'a str,
    elapsed_ms: u64,
    timeout_ms: u64,
    batch: bool,
    tty: bool,
    write_failed: bool,
) -> ProbeOutcome {
    settle_probe(SettleInput {
        tty,
        batch,
        env,
        received,
        timeout_ms,
        elapsed_ms,
        write_failed,
    })
}

fn as_ready(
    failures: &mut Vec<String>,
    label: &str,
    outcome: ProbeOutcome,
) -> Option<DetectResult> {
    match outcome {
        ProbeOutcome::Ready(result) => Some(result),
        ProbeOutcome::Pending => {
            failures.push(format!("{label}: probe still open"));
            None
        }
    }
}

fn feed(
    failures: &mut Vec<String>,
    label: &str,
    env: &CapabilityEnv,
    timeout_ms: u64,
    chunks: &[&str],
    expect_wait: bool,
) -> Option<DetectResult> {
    let mut received = String::new();
    for chunk in chunks {
        received.push_str(chunk);
        if let ProbeOutcome::Ready(result) =
            settle(env, &received, 0, timeout_ms, true, true, false)
        {
            if expect_wait {
                failures.push(format!(
                    "{label}: probe settled before the timeout\n  got: {result:?}"
                ));
            }
            return Some(result);
        }
    }
    if !expect_wait {
        failures.push(format!(
            "{label}: probe stayed open; this fixture should have settled before the timeout"
        ));
    }
    as_ready(
        failures,
        label,
        settle(env, &received, timeout_ms, timeout_ms, true, true, false),
    )
}

#[test]
fn probe_leftover_keys_fused_with_osc11_da1_parse_and_env_depth() {
    let mut failures = Vec::new();

    let osc11 = [
        ("rgb:0000/0000/0000", Some(Rgb { r: 0, g: 0, b: 0 })),
        (
            "rgb:ffff/ffff/ffff",
            Some(Rgb {
                r: 255,
                g: 255,
                b: 255,
            }),
        ),
        (
            "#1e1e1e",
            Some(Rgb {
                r: 30,
                g: 30,
                b: 30,
            }),
        ),
        ("nope", None),
    ];
    for (payload, want) in osc11 {
        check(
            &mut failures,
            &format!("parse_osc11_payload {payload:?}"),
            parse_osc11_payload(payload),
            want,
        );
    }

    let scaled = [
        ("rgb:ff/00/00", Some(Rgb { r: 255, g: 0, b: 0 })),
        ("rgb:F/0/0", Some(Rgb { r: 255, g: 0, b: 0 })),
        (
            "rgb:80/80/80",
            Some(Rgb {
                r: 128,
                g: 128,
                b: 128,
            }),
        ),
        (
            "rgb:158e/193a/1e75",
            Some(Rgb {
                r: 21,
                g: 25,
                b: 30,
            }),
        ),
        (
            "rgb:7fff/8000/0000",
            Some(Rgb {
                r: 127,
                g: 128,
                b: 0,
            }),
        ),
        (
            "  #AbCdEf\n",
            Some(Rgb {
                r: 171,
                g: 205,
                b: 239,
            }),
        ),
        (
            "1e1e1e",
            Some(Rgb {
                r: 30,
                g: 30,
                b: 30,
            }),
        ),
        (" rgb:ff/00/00 ", Some(Rgb { r: 255, g: 0, b: 0 })),
        ("rgb:1234/0/0", Some(Rgb { r: 18, g: 0, b: 0 })),
    ];
    for (payload, want) in scaled {
        check(
            &mut failures,
            &format!("parse_osc_color_payload {payload:?}"),
            parse_osc_color_payload(payload),
            want,
        );
    }
    for garbage in [
        "",
        "rgb:",
        "rgb:ff/00",
        "rgb:ff/00/00/11",
        "rgb:gg/00/00",
        "RGB:ff/00/00",
        "#abc",
        "#1122334",
        "not-a-color",
        "bogus",
    ] {
        check(
            &mut failures,
            &format!("parse_osc_color_payload {garbage:?}"),
            parse_osc_color_payload(garbage),
            None::<Rgb>,
        );
    }

    let extracted = [
        (
            "noise\u{001B}]11;rgb:1111/2222/3333\u{0007}more",
            Some("rgb:1111/2222/3333"),
        ),
        ("\u{001B}]11;rgb:aa/bb/cc\u{001B}\\", Some("rgb:aa/bb/cc")),
        ("\u{001B}]11;rgb:1", None),
        ("\u{001B}]11;rgb:1234/0/0", None),
        ("", None),
        ("garbage no osc", None),
    ];
    for (buf, want) in extracted {
        check(
            &mut failures,
            &format!("extract_osc11_from_buffer {buf:?}"),
            extract_osc11_from_buffer(buf),
            want,
        );
    }

    let decrqm = [
        ("\u{001B}[?2026;1$y", Some(true)),
        ("\u{001B}[?2026;2$y", Some(false)),
        ("nothing", None),
        ("\u{001B}[?2026;3$y", Some(true)),
        ("\u{001B}[?2026;4$y", Some(false)),
        ("\u{001B}[?2026;0$y", None),
        ("\u{001B}[?2026;5$y", None),
        ("\u{001B}[?2026;01$y", Some(true)),
        ("\u{001B}[?2026;1$y\u{001B}[?2026;2$y", Some(true)),
        ("\u{001B}[?2026;0$y\u{001B}[?2026;1$y", None),
    ];
    for (buf, want) in decrqm {
        check(
            &mut failures,
            &format!("parse_decrqm_2026 {buf:?}"),
            parse_decrqm_2026(buf),
            want,
        );
    }

    let da1 = [
        ("\u{001B}[?62;c", true),
        ("plain", false),
        ("\u{001B}[?c", true),
        ("\u{001B}[?62;1;2;c", true),
        ("\u{001B}[c", false),
        ("\u{001B}[?62", false),
    ];
    for (buf, want) in da1 {
        check(
            &mut failures,
            &format!("has_da1_reply {buf:?}"),
            has_da1_reply(buf),
            want,
        );
    }

    let strips = [
        (
            "\u{001B}]11;rgb:8080/8080/8080\u{0007}\u{001B}[?2026;1$y\u{001B}[?62;c",
            "",
        ),
        (
            "h\u{001B}]11;rgb:ff/ff/ff\u{0007}e\u{001B}[?2026;2$yll\u{001B}[?62;1;2;co",
            "hello",
        ),
        ("ab\u{001B}]11;rgb:0/0/0\u{001B}\\cd", "abcd"),
        ("\u{001B}]11;rgb:1", "\u{001B}]11;rgb:1"),
        ("q\u{0003}", "q\u{0003}"),
        ("\u{001B}[?2026;0$y", ""),
        ("\u{001B}[?2026;1$", "\u{001B}[?2026;1$"),
    ];
    for (buf, want) in strips {
        check(
            &mut failures,
            &format!("strip_probe_replies {buf:?}"),
            strip_probe_replies(buf),
            want,
        );
    }

    let split_da1 = parse_probe_replies("\u{001B}[?62\u{001B}]11;rgb:ff/00/00\u{0007}c");
    check(
        &mut failures,
        "split da1 osc11",
        split_da1.osc11_payload,
        Some("rgb:ff/00/00"),
    );
    check(
        &mut failures,
        "split da1 ground",
        split_da1.ground_rgb,
        Some(Rgb { r: 255, g: 0, b: 0 }),
    );
    check(&mut failures, "split da1 seen", split_da1.da1, false);
    check(
        &mut failures,
        "split da1 leftover",
        split_da1.leftover.as_str(),
        "",
    );

    let split_sync = parse_probe_replies("\u{001B}[?2026;\u{001B}]11;rgb:0/0/0\u{0007}2$y");
    check(
        &mut failures,
        "split sync report",
        split_sync.sync_2026,
        None::<bool>,
    );
    check(
        &mut failures,
        "split sync leftover",
        split_sync.leftover.as_str(),
        "",
    );

    let hidden = parse_probe_replies("\u{001B}]11;nope\u{0007}\u{001B}]11;rgb:ff/00/00\u{0007}");
    check(
        &mut failures,
        "first osc hides later color payload",
        hidden.osc11_payload,
        Some("nope"),
    );
    check(
        &mut failures,
        "first osc hides later color ground",
        hidden.ground_rgb,
        None::<Rgb>,
    );
    check(
        &mut failures,
        "first osc hides later color leftover",
        hidden.leftover.as_str(),
        "",
    );

    let env_rows = [
        (
            CapabilityEnv {
                colorterm: Some("truecolor".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Truecolor,
        ),
        (
            CapabilityEnv {
                colorterm: Some("24bit".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Truecolor,
        ),
        (
            CapabilityEnv {
                term: Some("xterm-256color".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi256,
        ),
        (
            CapabilityEnv {
                term: Some("vt100".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi16,
        ),
        (CapabilityEnv::default(), ColorDepth::Ansi16),
        (
            CapabilityEnv {
                wt_session: Some("1".to_owned()),
                term: Some("xterm".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Truecolor,
        ),
        (
            CapabilityEnv {
                no_color: Some("1".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Mono,
        ),
        (
            CapabilityEnv {
                no_color: Some(String::new()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Mono,
        ),
        (
            CapabilityEnv {
                no_color: Some("1".to_owned()),
                colorterm: Some("truecolor".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Mono,
        ),
        (
            CapabilityEnv {
                no_color: Some("1".to_owned()),
                wt_session: Some("1".to_owned()),
                term: Some("xterm".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Mono,
        ),
        (
            CapabilityEnv {
                term_program: Some("iTerm.app".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Truecolor,
        ),
        (
            CapabilityEnv {
                term_program: Some("iterm.app".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi16,
        ),
        (
            CapabilityEnv {
                term_program: Some("Apple_Terminal".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi16,
        ),
        (
            CapabilityEnv {
                term: Some("xterm-direct".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Truecolor,
        ),
        (
            CapabilityEnv {
                term: Some("XTERM-256COLOR".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi256,
        ),
        (
            CapabilityEnv {
                term: Some("xterm-256color".to_owned()),
                term_program: Some("iTerm.app".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi256,
        ),
        (
            CapabilityEnv {
                colorterm: Some("TrueColor".to_owned()),
                term: Some("xterm-256color".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Truecolor,
        ),
        (
            CapabilityEnv {
                wt_session: Some(String::new()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi16,
        ),
        (
            CapabilityEnv {
                no_color: Some(String::new()),
                term_program: Some("iTerm.app".to_owned()),
                colorterm: Some("truecolor".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Mono,
        ),
        (
            CapabilityEnv {
                term: Some("dumb".to_owned()),
                ..CapabilityEnv::default()
            },
            ColorDepth::Ansi16,
        ),
    ];
    for (env, depth) in &env_rows {
        check(
            &mut failures,
            &format!("guess_color_depth {env:?}"),
            guess_color_depth(env),
            *depth,
        );
    }

    check(
        &mut failures,
        "DEFAULT_PROBE_TIMEOUT_MS",
        DEFAULT_PROBE_TIMEOUT_MS,
        100u64,
    );
    check(
        &mut failures,
        "OSC11_QUERY",
        OSC11_QUERY,
        "\u{001B}]11;?\u{0007}",
    );
    check(
        &mut failures,
        "OSC10_QUERY",
        OSC10_QUERY,
        "\u{001B}]10;?\u{0007}",
    );
    check(
        &mut failures,
        "DECRQM_2026",
        DECRQM_2026,
        "\u{001B}[?2026$p",
    );
    check(&mut failures, "DA1_QUERY", DA1_QUERY, "\u{001B}[c");
    check(
        &mut failures,
        "XTVERSION_QUERY",
        XTVERSION_QUERY,
        "\u{001B}[>0q",
    );
    check(
        &mut failures,
        "THEME_REPORT_ENABLE",
        THEME_REPORT_ENABLE,
        "\u{001B}[?2031h",
    );
    check(
        &mut failures,
        "THEME_REPORT_DISABLE",
        THEME_REPORT_DISABLE,
        "\u{001B}[?2031l",
    );
    check(
        &mut failures,
        "PROBE_BATCH",
        PROBE_BATCH,
        "\u{001B}]11;?\u{0007}\u{001B}[?2026$p\u{001B}[c",
    );
    check(
        &mut failures,
        "probe_query(false, true)",
        probe_query(false, true),
        "",
    );
    check(
        &mut failures,
        "probe_query(true, false)",
        probe_query(true, false),
        OSC11_QUERY,
    );
    check(
        &mut failures,
        "probe_query(true, true)",
        probe_query(true, true),
        PROBE_BATCH,
    );

    let ansi256 = CapabilityEnv {
        term: Some("xterm-256color".to_owned()),
        ..CapabilityEnv::default()
    };
    check(
        &mut failures,
        "terminal_caps first frame",
        terminal_caps(true, &ansi256),
        TerminalCaps {
            tty: true,
            color_depth: ColorDepth::Ansi256,
            ground_rgb: None,
            sync_2026: None,
        },
    );
    check(
        &mut failures,
        "partial probe stays open on the first frame",
        settle(
            &ansi256,
            "\u{001B}]11;rgb:1",
            0,
            DEFAULT_PROBE_TIMEOUT_MS,
            true,
            true,
            false,
        ),
        ProbeOutcome::Pending,
    );

    if let Some(not_tty) = as_ready(
        &mut failures,
        "not tty",
        settle(&ansi256, "", 0, 20, true, false, false),
    ) {
        check(&mut failures, "not tty flag", not_tty.caps.tty, false);
        check(
            &mut failures,
            "not tty depth",
            not_tty.caps.color_depth,
            ColorDepth::Ansi256,
        );
        check(
            &mut failures,
            "not tty leftover",
            not_tty.leftover.as_str(),
            "",
        );
    }

    if let Some(batch) = feed(
        &mut failures,
        "batch",
        &ansi256,
        300,
        &["\u{001B}]11;rgb:8080/8080/8080\u{0007}", "\u{001B}[?62;c"],
        false,
    ) {
        check(&mut failures, "batch tty", batch.caps.tty, true);
        check(
            &mut failures,
            "batch depth",
            batch.caps.color_depth,
            ColorDepth::Ansi256,
        );
        check(
            &mut failures,
            "batch ground",
            batch.caps.ground_rgb,
            Some(Rgb {
                r: 128,
                g: 128,
                b: 128,
            }),
        );
        check(
            &mut failures,
            "batch sync",
            batch.caps.sync_2026,
            None::<bool>,
        );
        check(&mut failures, "batch leftover", batch.leftover.as_str(), "");
    }

    if let Some(interleaved) = feed(
        &mut failures,
        "interleaved",
        &ansi256,
        300,
        &[
            "hi",
            "\u{001B}]11;rgb:8080/8080/8080\u{0007}",
            "!",
            "\u{001B}[?62;c",
        ],
        false,
    ) {
        check(
            &mut failures,
            "interleaved ground",
            interleaved.caps.ground_rgb,
            Some(Rgb {
                r: 128,
                g: 128,
                b: 128,
            }),
        );
        check(
            &mut failures,
            "interleaved leftover",
            interleaved.leftover.as_str(),
            "hi!",
        );
    }

    let empty = CapabilityEnv::default();
    if let Some(timeout_ground) = feed(
        &mut failures,
        "timeout ground",
        &empty,
        40,
        &["\u{001B}]11;rgb:ff/ff/ff\u{0007}"],
        true,
    ) {
        check(
            &mut failures,
            "timeout ground rgb",
            timeout_ground.caps.ground_rgb,
            Some(Rgb {
                r: 255,
                g: 255,
                b: 255,
            }),
        );
        check(
            &mut failures,
            "timeout ground depth",
            timeout_ground.caps.color_depth,
            ColorDepth::Ansi16,
        );
        check(
            &mut failures,
            "timeout ground leftover",
            timeout_ground.leftover.as_str(),
            "",
        );
    }

    if let Some(timeout_keys) = feed(&mut failures, "timeout keys", &empty, 40, &["xy"], true) {
        check(
            &mut failures,
            "timeout keys leftover",
            timeout_keys.leftover.as_str(),
            "xy",
        );
        check(
            &mut failures,
            "timeout keys ground",
            timeout_keys.caps.ground_rgb,
            None::<Rgb>,
        );
    }

    if let Some(partial) = feed(
        &mut failures,
        "partial osc",
        &empty,
        40,
        &["\u{001B}]11;rgb:1"],
        true,
    ) {
        check(
            &mut failures,
            "partial osc ground",
            partial.caps.ground_rgb,
            None::<Rgb>,
        );
        check(
            &mut failures,
            "partial osc leftover",
            partial.leftover.as_str(),
            "\u{001B}]11;rgb:1",
        );
    }

    let ground = "\u{001B}]11;rgb:ff/ff/ff\u{0007}";
    check(
        &mut failures,
        "ground one millisecond before timeout",
        settle(&empty, ground, 39, 40, true, true, false),
        ProbeOutcome::Pending,
    );
    check(
        &mut failures,
        "decrqm alone stays open",
        settle(&empty, "\u{001B}[?2026;1$y", 0, 40, true, true, false),
        ProbeOutcome::Pending,
    );
    let da1_only = "\u{001B}[?62;c";
    check(
        &mut failures,
        "da1 alone stays open",
        settle(&empty, da1_only, 0, 40, true, true, false),
        ProbeOutcome::Pending,
    );

    if let Some(ground_only) = as_ready(
        &mut failures,
        "ground-only probe stayed open",
        settle(&empty, ground, 0, 40, false, true, false),
    ) {
        check(
            &mut failures,
            "ground-only rgb",
            ground_only.caps.ground_rgb,
            Some(Rgb {
                r: 255,
                g: 255,
                b: 255,
            }),
        );
        check(
            &mut failures,
            "ground-only leftover",
            ground_only.leftover.as_str(),
            "",
        );
    }

    if let Some(full) = as_ready(
        &mut failures,
        "terminated ground plus DA1 stayed open",
        settle(
            &empty,
            "\u{001B}]11;nope\u{0007}\u{001B}[?2026;1$y\u{001B}[?64;c",
            0,
            300,
            true,
            true,
            false,
        ),
    ) {
        check(
            &mut failures,
            "full ground",
            full.caps.ground_rgb,
            None::<Rgb>,
        );
        check(&mut failures, "full sync", full.caps.sync_2026, Some(true));
        check(
            &mut failures,
            "full depth",
            full.caps.color_depth,
            ColorDepth::Ansi16,
        );
        check(&mut failures, "full leftover", full.leftover.as_str(), "");
    }

    if let Some(timed_out) = as_ready(
        &mut failures,
        "timeout did not settle",
        settle(&empty, da1_only, 40, 40, true, true, false),
    ) {
        check(
            &mut failures,
            "da1 timeout ground",
            timed_out.caps.ground_rgb,
            None::<Rgb>,
        );
        check(
            &mut failures,
            "da1 timeout sync",
            timed_out.caps.sync_2026,
            None::<bool>,
        );
        check(
            &mut failures,
            "da1 timeout leftover",
            timed_out.leftover.as_str(),
            "",
        );
    }

    let vt100 = CapabilityEnv {
        term: Some("vt100".to_owned()),
        ..CapabilityEnv::default()
    };
    let received = "hi\u{001B}]11;rgb:ff/00/00\u{0007}\u{001B}[?62;c";
    if let Some(failed) = as_ready(
        &mut failures,
        "write failure stayed open",
        settle(&vt100, received, 0, 100, true, true, true),
    ) {
        check(
            &mut failures,
            "write failure ground",
            failed.caps.ground_rgb,
            None::<Rgb>,
        );
        check(
            &mut failures,
            "write failure sync",
            failed.caps.sync_2026,
            None::<bool>,
        );
        check(
            &mut failures,
            "write failure depth",
            failed.caps.color_depth,
            ColorDepth::Ansi16,
        );
        check(&mut failures, "write failure tty", failed.caps.tty, true);
        check(
            &mut failures,
            "write failure leftover",
            failed.leftover.as_str(),
            "hi",
        );
    }
    if let Some(ignored) = as_ready(
        &mut failures,
        "non-tty probe stayed open",
        settle(&vt100, received, 0, 20, true, false, true),
    ) {
        check(
            &mut failures,
            "non-tty with bytes flag",
            ignored.caps.tty,
            false,
        );
        check(
            &mut failures,
            "non-tty with bytes ground",
            ignored.caps.ground_rgb,
            None::<Rgb>,
        );
        check(
            &mut failures,
            "non-tty with bytes leftover",
            ignored.leftover.as_str(),
            "",
        );
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn osc52_clipboard_writes() {
    let cases = [
        (
            "hello",
            ClipboardSelect::Clipboard,
            "\u{001B}]52;c;aGVsbG8=\u{0007}",
        ),
        ("x", ClipboardSelect::Primary, "\u{001B}]52;p;eA==\u{0007}"),
        ("ab", ClipboardSelect::Both, "\u{001B}]52;cp;YWI=\u{0007}"),
        (
            "→",
            ClipboardSelect::Clipboard,
            "\u{001B}]52;c;4oaS\u{0007}",
        ),
        ("", ClipboardSelect::Clipboard, "\u{001B}]52;c;\u{0007}"),
    ];
    for (text, select, want) in cases {
        assert_eq!(osc52_set(text, select), want, "{text:?} {select:?}");
    }
    assert_eq!(
        osc52_set("ab", ClipboardSelect::default()),
        "\u{001B}]52;cp;YWI=\u{0007}"
    );
}
