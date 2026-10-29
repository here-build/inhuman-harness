use qd::{
    clone_buffer, create_buffer, dirty_rows, display_width, emit_ansi_detailed, guard_content, put,
    EmitAnsiOpts, Rgb, Style,
};

fn style() -> Style {
    Style::default()
}

fn painted(buf: &qd::Buffer) -> String {
    let text: String = buf.cells().iter().map(|c| c.ch.as_str()).collect();
    text.trim_end().to_string()
}

struct Pieces {
    force_full: bool,
    cups: Vec<String>,
    sgr: Vec<String>,
    osc8: Vec<String>,
    text: String,
}

fn ansi_pieces(ansi: &str) -> Pieces {
    let cup = regex::Regex::new(r"\u{001B}\[(\d+);(\d+)H").unwrap();
    let sgr = regex::Regex::new(r"\u{001B}\[([0-9;]*)m").unwrap();
    let osc = regex::Regex::new(r"\u{001B}\]8;;([^\u{001B}]*)\u{001B}\\").unwrap();
    let strip_osc = regex::Regex::new(r"\u{001B}\]8;;[^\u{001B}]*\u{001B}\\").unwrap();
    let strip_csi = regex::Regex::new(r"\u{001B}\[[0-9;?]*[ -/]*[@-~]").unwrap();
    Pieces {
        force_full: ansi.contains("\u{001B}[2J"),
        cups: cup
            .captures_iter(ansi)
            .map(|m| format!("{};{}", &m[1], &m[2]))
            .collect(),
        sgr: sgr.captures_iter(ansi).map(|m| m[1].to_string()).collect(),
        osc8: osc.captures_iter(ansi).map(|m| m[1].to_string()).collect(),
        text: strip_csi
            .replace_all(&strip_osc.replace_all(ansi, ""), "")
            .into_owned(),
    }
}

#[test]
fn content_guard_matches_the_buffer_oracle() {
    let cases = [
        ("hello\u{001B}[2Jworld", "helloworld"),
        ("x\u{001B}[?1049ly", "xy"),
        (
            "click\u{001B}]8;;https://evil.com\u{001B}\\here",
            "clickhere",
        ),
        ("a\u{001B}]0;title\u{0007}b", "ab"),
        ("x\u{001B}]11;rgb:1/2/3\u{001B}\\y", "xy"),
        ("a\u{001B}P1$q\u{001B}\\b", "ab"),
        ("a\u{001B}]0;titleb", "a0;titleb"),
        ("pre\u{001B}]partial", "prepartial"),
        ("a\u{001B}Ppayload", "apayload"),
        ("a\u{001B}Xpayload", "apayload"),
        ("a\u{001B}^payload", "apayload"),
        ("a\u{001B}_payload", "apayload"),
    ];
    for (raw, expected) in cases {
        let mut buf = create_buffer(24, 1);
        put(&mut buf, 0, 0, raw, &style());
        let text = painted(&buf);
        let guarded = guard_content(raw);
        assert_eq!(guarded, expected, "{raw:?}");
        assert_eq!(text, expected, "{raw:?}");
        assert_eq!(display_width(&text), display_width(expected));
        assert!(!guarded.contains('\u{001B}'));
    }
}

#[test]
fn wide_glyph_lifecycle() {
    let mut occupy = create_buffer(4, 1);
    put(&mut occupy, 0, 0, "漢", &style());
    let cells: Vec<_> = occupy
        .cells()
        .iter()
        .map(|c| (c.ch.clone(), c.placeholder))
        .collect();
    assert_eq!(
        cells,
        vec![
            ("漢".into(), false),
            ("".into(), true),
            (" ".into(), false),
            (" ".into(), false)
        ]
    );

    let mut ret = create_buffer(4, 1);
    put(&mut ret, 0, 0, "⏎:", &style());
    let ret_cells: Vec<_> = ret
        .cells()
        .iter()
        .map(|c| (c.ch.clone(), c.placeholder))
        .collect();
    assert_eq!(
        ret_cells,
        vec![
            ("⏎".into(), false),
            (" ".into(), false),
            (":".into(), false),
            (" ".into(), false)
        ]
    );
    assert_eq!(
        ansi_pieces(&emit_ansi_detailed(None, &ret, &EmitAnsiOpts::default()).ansi).text,
        "⏎ : "
    );

    put(&mut occupy, 2, 0, "a", &style());
    let occupy_ansi = emit_ansi_detailed(None, &occupy, &EmitAnsiOpts::default()).ansi;
    let pair: Vec<_> = occupy.cells()[..3]
        .iter()
        .map(|c| (c.ch.clone(), c.placeholder))
        .collect();
    assert_eq!(
        pair,
        vec![("漢".into(), false), ("".into(), true), ("a".into(), false)]
    );
    let pieces = ansi_pieces(&occupy_ansi);
    assert!(pieces.force_full);
    assert_eq!(pieces.cups, vec!["1;1"]);
    assert_eq!(pieces.text, "漢a ");
    assert_eq!(occupy_ansi.matches('漢').count(), 1);

    let mut combining = create_buffer(4, 1);
    put(&mut combining, 0, 0, "\u{0301}x", &style());
    assert_eq!(combining.cells()[0].ch, "x");

    let mut edge = create_buffer(3, 1);
    put(&mut edge, 2, 0, "漢", &style());
    assert_eq!(edge.cells()[2].ch, " ");
    assert!(!edge.cells()[2].placeholder);

    let mut ascii = create_buffer(3, 1);
    put(&mut ascii, 0, 0, "ab", &style());
    let chs: Vec<_> = ascii.cells().iter().map(|c| c.ch.as_str()).collect();
    assert_eq!(chs, vec!["a", "b", " "]);

    let mut orphan = create_buffer(6, 1);
    put(&mut orphan, 0, 0, "漢abc", &style());
    put(&mut orphan, 0, 0, "X", &style());
    let orphan_cells: Vec<_> = orphan
        .cells()
        .iter()
        .map(|c| (c.ch.clone(), c.placeholder))
        .collect();
    assert_eq!(
        orphan_cells,
        vec![
            ("X".into(), false),
            (" ".into(), false),
            ("a".into(), false),
            ("b".into(), false),
            ("c".into(), false),
            (" ".into(), false),
        ]
    );
    assert_eq!(
        ansi_pieces(&emit_ansi_detailed(None, &orphan, &EmitAnsiOpts::default()).ansi).text,
        "X abc "
    );

    let mut c6 = create_buffer(6, 1);
    put(&mut c6, 0, 0, "a漢", &style());
    put(&mut c6, 0, 0, "漢", &style());
    let c6_cells: Vec<_> = c6
        .cells()
        .iter()
        .map(|c| (c.ch.clone(), c.placeholder))
        .collect();
    assert_eq!(
        c6_cells,
        vec![
            ("漢".into(), false),
            ("".into(), true),
            (" ".into(), false),
            (" ".into(), false),
            (" ".into(), false),
            (" ".into(), false),
        ]
    );
}

#[test]
fn dirty_rows_and_merge() {
    assert_eq!(dirty_rows(None, &create_buffer(4, 2)), vec![0, 1]);
    let mut prev = create_buffer(4, 3);
    put(&mut prev, 0, 0, "aaaa", &style());
    put(&mut prev, 0, 1, "bbbb", &style());
    put(&mut prev, 0, 2, "cccc", &style());
    let mut next = clone_buffer(&prev);
    put(&mut next, 0, 1, "xxxx", &style());
    assert_eq!(dirty_rows(Some(&prev), &next), vec![1]);
    assert_eq!(
        dirty_rows(Some(&create_buffer(2, 2)), &create_buffer(3, 2)),
        vec![0, 1]
    );

    let mut clean = create_buffer(2, 1);
    let mut muted = style();
    muted.role = Some("muted".into());
    muted.prominence = Some(0.5);
    put(&mut clean, 0, 0, "ab", &muted);
    assert!(dirty_rows(Some(&clean), &clone_buffer(&clean)).is_empty());

    let mut inherit = create_buffer(3, 1);
    let mut bg = style();
    bg.bg = Some(235.0);
    put(&mut inherit, 0, 0, "   ", &bg);
    let mut fg = style();
    fg.fg = Some(240.0);
    put(&mut inherit, 0, 0, "┌─┐", &fg);
    assert_eq!(inherit.cells()[0].style.bg, Some(235.0));
    assert_eq!(inherit.cells()[0].style.fg, Some(240.0));

    let mut cast = create_buffer(1, 1);
    let mut red = style();
    red.bg = Some(196.0);
    put(&mut cast, 0, 0, "X", &red);
    let mut clear = style();
    clear.cast_transparent = true;
    put(&mut cast, 0, 0, " ", &clear);
    assert_eq!(cast.cells()[0].ch, " ");
    assert_eq!(cast.cells()[0].style.bg, None);
    assert!(cast.cells()[0].style.cast_transparent);
}

#[test]
fn emit_matches_the_force_full_fixture() {
    let mut buf = create_buffer(3, 1);
    let mut paint = style();
    paint.fg_rgb = Some(Rgb {
        r: 189.0,
        g: 65.0,
        b: 63.0,
    });
    paint.bg_rgb = Some(Rgb {
        r: 10.0,
        g: 20.0,
        b: 30.0,
    });
    paint.strike = true;
    paint.underline = true;
    paint.href = Some("https://example".into());
    put(&mut buf, 0, 0, "ab", &paint);
    let prev = clone_buffer(&buf);
    let clean = emit_ansi_detailed(Some(&prev), &buf, &EmitAnsiOpts::default());
    assert_eq!(clean.ansi, "");
    assert_eq!(clean.dirty_rows, 0);

    let dump = emit_ansi_detailed(
        Some(&prev),
        &buf,
        &EmitAnsiOpts {
            sync2026: false,
            force_full: true,
        },
    );
    let pieces = ansi_pieces(&dump.ansi);
    assert!(pieces.force_full);
    assert_eq!(pieces.cups, vec!["1;1"]);
    assert_eq!(
        pieces.sgr,
        vec!["0", "0;4;9;38;2;189;65;63;48;2;10;20;30", "0", "0", "0"]
    );
    assert_eq!(pieces.osc8, vec!["https://example", ""]);
    assert_eq!(pieces.text, "ab ");
    assert_eq!(dump.dirty_rows, 1);
    assert_eq!(dump.bytes, 99);
}

fn check<T, U>(failures: &mut Vec<String>, label: &str, got: T, want: U)
where
    T: PartialEq<U> + std::fmt::Debug,
    U: std::fmt::Debug,
{
    if got != want {
        failures.push(format!("{label}\n  got: {got:?}\n  want: {want:?}"));
    }
}

fn paint_sgr(paint: &Style) -> String {
    let mut buf = create_buffer(1, 1);
    put(&mut buf, 0, 0, "x", paint);
    emit_ansi_detailed(None, &buf, &EmitAnsiOpts::default()).ansi
}

#[test]
fn sgr_color_range_index_and_nan() {
    let mut failures = Vec::new();

    let mut nan = style();
    nan.fg_rgb = Some(Rgb {
        r: f64::NAN,
        g: 65.0,
        b: 63.0,
    });
    let ansi = paint_sgr(&nan);
    check(
        &mut failures,
        "nan fg sgr",
        ansi_pieces(&ansi).sgr,
        vec!["0", "0;38;2;0;65;63", "0"],
    );
    check(&mut failures, "nan fg text", ansi.contains("NaN"), false);

    let mut range = style();
    range.fg_rgb = Some(Rgb {
        r: -5.0,
        g: 999.0,
        b: 0.5,
    });
    check(
        &mut failures,
        "rgb range sgr",
        ansi_pieces(&paint_sgr(&range)).sgr,
        vec!["0", "0;38;2;0;255;1", "0"],
    );

    let mut idx = style();
    idx.fg = Some(999.0);
    let ansi = paint_sgr(&idx);
    check(
        &mut failures,
        "palette index sgr",
        ansi_pieces(&ansi).sgr,
        vec!["0", "0;38;5;255", "0"],
    );
    check(
        &mut failures,
        "palette index selector",
        ansi.contains("38;5;"),
        true,
    );
    check(
        &mut failures,
        "palette index clamps 999",
        ansi.contains("999"),
        false,
    );

    let mut inf = style();
    inf.fg = Some(f64::INFINITY);
    let ansi = paint_sgr(&inf);
    check(
        &mut failures,
        "infinite index sgr",
        ansi_pieces(&ansi).sgr,
        vec!["0", "0", "0"],
    );
    check(
        &mut failures,
        "infinite index text",
        ansi.contains("Infinity"),
        false,
    );

    let mut bg = style();
    bg.bg_rgb = Some(Rgb {
        r: f64::NAN,
        g: 999.0,
        b: -1.0,
    });
    check(
        &mut failures,
        "nan bg sgr",
        ansi_pieces(&paint_sgr(&bg)).sgr,
        vec!["0", "0;48;2;0;255;0", "0"],
    );

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
