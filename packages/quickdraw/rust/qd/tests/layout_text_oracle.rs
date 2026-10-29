//! Oracle for text wrap and the display-column measure of a text node.
//!
//! Ported from `packages/quickdraw/src/layout/text.ts`, the `type: "text"` arm of
//! `layout/measure.ts`, `layout/__tests__/frame.test.ts` (the `wrapText` table
//! and the line-clamp paint predicate), `layout/__tests__/overflow-clip.test.ts`
//! (`measured stamp is width-tagged`), `measure/__tests__/grapheme.test.ts`, and
//! the `wrapText` pre-wrap breaks in `widgets/__tests__/markdown.test.ts`.
//!
//! Caret, chrome geometry, viewport scroll, and the wrap identity cache need the
//! layout engine. Those assertions are listed as BLOCKED below and are not weakened.

use qd::layout_text::{
    measure_text_node, split_at_width, take_grapheme, wrap_layout_text, wrap_text, MeasuredStamp,
    TextExtent, TextNode, WhiteSpace, WrapOpts,
};
use qd::{
    display_width, display_width_ambiguous, grapheme_width, is_two_column_symbol, is_unit_width_run,
};

fn opts(width: i64, white_space: WhiteSpace) -> WrapOpts<'static> {
    WrapOpts {
        white_space,
        ..WrapOpts::new(width)
    }
}

fn node(content: &str) -> TextNode<'_> {
    TextNode {
        content,
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
    }
}

// BLOCKED — not ported. Each assertion needs a subsystem this module does not own.
//
// layout/__tests__/frame.test.ts
//   topClip === ["bbbb", "cccc"]
//   Viewport `overflowAnchor: "none"`, scroll 1, height 2. The wrap that feeds it
//   is asserted below (width 4, normal). The painted slice is the layout engine.
//   The rest of that `expect` (row flex, viewport auto tail, border, overlay) is
//   not text wrap.
//
// layout/__tests__/chrome.test.ts
//   wrapText("hi\nthere", { width: chromeFrameTextWidth(40), whiteSpace: "pre-wrap" })
//   is ["hi", "there"] (hard newline, width 36). Asserted only as that wrap.
//   { bodyH: geom.bodyH, totalH: geom.totalH, glyph } ===
//   { bodyH: wrapped.length, totalH: chromeFrameTotalHeight(wrapped.length), glyph: CHROME_FRAME_DEFAULT_GLYPH }
//   needs chrome-frame measure.
//
// layout/__tests__/caret.test.ts
//   lines.map(l => l.text) === wrapText("hello world", { width: 8, whiteSpace: "pre-wrap" })
//   === ["hello ", "world"] is the pre-wrap row in the whitespace table.
//   visualDraftLines / moveVisualDraft / composerOffsetAtCell / parkComposerCaret
//   are caret geometry, not wrap.
//
// layout/__tests__/wrap-cache.test.ts
//   "a later layout reuses the wrap of an unchanged text node":
//     afterFirst > 0, wide === afterFirst, first paint !== second paint,
//     narrow width increases wide, same width does not, content edit increases wide.
//   "viewport totalH uses a stamped tape child without wrapping inner text":
//     { maxScroll: 192, wraps: true }
//   "a clipped column with sticky-top prompts does not wrap rows below the clip":
//     { below: 0, visible: true, later: false, dumped: false }
//   All three drive `layout()`. The WeakMap on the node object is not ported.
//
// layout/__tests__/overflow-clip.test.ts
//   "measured stamp and clipped box children skip wrap":
//     { visible: true, b: false, offscreen: 0 }
//   Viewport clip. The sibling test "measured stamp is width-tagged" is ported.
//
// widgets/__tests__/markdown.test.ts
//   softWrapParts line joins are ported as pre-wrap.
//   mixed[1][0].style.bold === true, and markdownToLayout lines containing
//   "actual package." / not starting with "ctual", need the markdown expander.
//
// layout/__tests__/flex-grid.test.ts, highlight.test.ts, serialize.test.ts
//   mention text nodes. Their assertions are tracks, selection, or structure,
//   not `wrapText` results.

fn push_wrap(
    failures: &mut Vec<String>,
    name: &str,
    input: &str,
    opt: &WrapOpts<'_>,
    lines: &[&str],
) {
    let got = wrap_text(input, opt);
    let want: Vec<String> = lines.iter().map(|line| (*line).to_string()).collect();
    if got != want {
        failures.push(format!("{name}\n  got: {got:?}\n  want: {want:?}"));
    }
}

fn push_eq<T: PartialEq + std::fmt::Debug>(
    failures: &mut Vec<String>,
    name: &str,
    got: T,
    want: T,
) {
    if got != want {
        failures.push(format!("{name}\n  got: {got:?}\n  want: {want:?}"));
    }
}

fn clamped_opts(width: i64, line_clamp: i64, ellipsis: Option<bool>) -> WrapOpts<'static> {
    WrapOpts {
        ellipsis,
        line_clamp: Some(line_clamp),
        ..WrapOpts::new(width)
    }
}

fn nowrap_opts(width: i64, ellipsis: Option<bool>, line_clamp: Option<i64>) -> WrapOpts<'static> {
    WrapOpts {
        white_space: WhiteSpace::Nowrap,
        ellipsis,
        line_clamp,
        ..WrapOpts::new(width)
    }
}

#[test]
fn wrap_lines_match_whitespace_clamp_grapheme_chrome_and_split() {
    // Whitespace, clamp, grapheme split, chrome, and markdown are one wrap story.
    // caret.test.ts "hello world" at width 8 pre-wrap is "pre-wrap prefers last space".
    let mut failures = Vec::new();
    let cut = "so the extra lines describe the a".chars().count() as i64;
    let rows: Vec<(&str, &str, WrapOpts<'static>, Vec<&str>)> = vec![
        (
            "normal hard-newline",
            "hello\nworld",
            opts(40, WhiteSpace::Normal),
            vec!["hello", "world"],
        ),
        (
            "normal blank line",
            "hello\n\nworld",
            opts(40, WhiteSpace::Normal),
            vec!["hello", "", "world"],
        ),
        (
            "normal collapse double space",
            "a  b",
            opts(40, WhiteSpace::Normal),
            vec!["a b"],
        ),
        (
            "normal keeps edge spaces",
            " from ",
            opts(40, WhiteSpace::Normal),
            vec![" from "],
        ),
        (
            "normal keeps trailing word space",
            "hello from ",
            opts(40, WhiteSpace::Normal),
            vec!["hello from "],
        ),
        (
            "pre-wrap preserves spaces",
            "a  b",
            opts(40, WhiteSpace::PreWrap),
            vec!["a  b"],
        ),
        (
            "pre-wrap hard newline",
            "hello\nworld",
            opts(40, WhiteSpace::PreWrap),
            vec!["hello", "world"],
        ),
        (
            "pre-wrap trailing newline",
            "hi\n",
            opts(40, WhiteSpace::PreWrap),
            vec!["hi", ""],
        ),
        (
            "pre-wrap soft-wrap keeps spaces",
            "aa  bb  cc",
            opts(5, WhiteSpace::PreWrap),
            vec!["aa  ", "bb  ", "cc"],
        ),
        (
            "pre-wrap prefers last space",
            "hello world",
            opts(8, WhiteSpace::PreWrap),
            vec!["hello ", "world"],
        ),
        (
            "normal prefers last space",
            "hello world",
            opts(8, WhiteSpace::Normal),
            vec!["hello", "world"],
        ),
        (
            "line clamp ellipsis",
            "one two three four five",
            clamped_opts(8, 2, None),
            vec!["one two", "three…"],
        ),
        (
            "top clip wrap",
            "aaaa bbbb cccc dddd eeee",
            WrapOpts::new(4),
            vec!["aaaa", "bbbb", "cccc", "dddd", "eeee"],
        ),
        (
            "chrome pre-wrap hard newline",
            "hi\nthere",
            opts(36, WhiteSpace::PreWrap),
            vec!["hi", "there"],
        ),
        (
            "markdown pre-wrap last space",
            "so the extra lines describe the actual package.",
            opts(cut, WhiteSpace::PreWrap),
            vec!["so the extra lines describe the ", "actual package."],
        ),
        (
            "wrap width 4 fits 漢字",
            "漢字",
            WrapOpts::new(4),
            vec!["漢字"],
        ),
        (
            "clamp keeps both hard lines",
            "hello\nworld",
            clamped_opts(40, 2, None),
            vec!["hello", "world"],
        ),
        (
            "clamp keeps a short line",
            "one two",
            clamped_opts(40, 2, None),
            vec!["one two"],
        ),
        (
            "clamp ellipsis defaults on",
            "hello world",
            clamped_opts(4, 1, None),
            vec!["hel…"],
        ),
        (
            "ellipsis can be refused",
            "hello world",
            clamped_opts(4, 1, Some(false)),
            vec!["hell"],
        ),
        (
            "refused ellipsis keeps the next line",
            "hello world",
            clamped_opts(4, 2, Some(false)),
            vec!["hell", "o"],
        ),
        (
            "nowrap ignores clamp",
            "hello world",
            nowrap_opts(8, Some(false), Some(1)),
            vec!["hello wo"],
        ),
        (
            "nowrap keeps double space",
            "a  b\nc",
            nowrap_opts(40, None, None),
            vec!["a  b c"],
        ),
        (
            "nowrap ellipsis when asked",
            "hello world",
            nowrap_opts(8, Some(true), None),
            vec!["hello w…"],
        ),
        (
            "nowrap drops a cluster wider than the budget",
            "漢",
            nowrap_opts(1, None, None),
            vec![""],
        ),
        (
            "pre-wrap keeps a cluster wider than the budget",
            "漢",
            opts(1, WhiteSpace::PreWrap),
            vec!["漢"],
        ),
        (
            "pre-wrap splits 漢字 at one column",
            "漢字",
            opts(1, WhiteSpace::PreWrap),
            vec!["漢", "字"],
        ),
        (
            "nowrap ellipsis replaces a wide cluster",
            "漢字",
            nowrap_opts(2, Some(true), None),
            vec!["…"],
        ),
        (
            "nowrap ellipsis keeps one wide cluster",
            "漢字",
            nowrap_opts(3, Some(true), None),
            vec!["漢…"],
        ),
        (
            "normal collapses interior runs and keeps edges",
            "  a   b  ",
            WrapOpts::new(40),
            vec![" a b "],
        ),
        (
            "normal collapses tabs",
            "a\t\tb",
            WrapOpts::new(40),
            vec!["a b"],
        ),
        (
            "tabs alone collapse to one space",
            "\t\t",
            WrapOpts::new(40),
            vec![" "],
        ),
        (
            "pre-line collapses spaces and tabs",
            "a  b\nc\t\td",
            opts(40, WhiteSpace::PreLine),
            vec!["a b", "c d"],
        ),
        (
            "normal matches pre-line on spaces and tabs",
            "a  b\nc\t\td",
            WrapOpts::new(40),
            vec!["a b", "c d"],
        ),
        (
            "pre-wrap keeps a tab",
            "a\tb",
            opts(40, WhiteSpace::PreWrap),
            vec!["a\tb"],
        ),
        (
            "pre-wrap bare newline",
            "\n",
            opts(40, WhiteSpace::PreWrap),
            vec!["", ""],
        ),
        (
            "nowrap bare newline becomes a space",
            "\n",
            nowrap_opts(40, None, None),
            vec![" "],
        ),
        (
            "width below 1 wraps at one column",
            "ab",
            WrapOpts::new(0),
            vec!["a", "b"],
        ),
        (
            "negative width wraps at one column",
            "ab",
            opts(-4, WhiteSpace::PreWrap),
            vec!["a", "b"],
        ),
        ("empty at width 0", "", WrapOpts::new(0), vec![""]),
        (
            "pre-wrap keeps a multibyte cluster with the break space",
            "漢 world",
            opts(4, WhiteSpace::PreWrap),
            vec!["漢 ", "worl", "d"],
        ),
        (
            "pre-wrap does not split a combining cluster",
            "e\u{0301}x",
            opts(1, WhiteSpace::PreWrap),
            vec!["e\u{0301}", "x"],
        ),
    ];
    for (name, input, opt, lines) in &rows {
        push_wrap(&mut failures, name, input, opt, lines);
    }

    let never_fits = |_: &str| usize::MAX;
    let always_fits = |_: &str| 0usize;
    push_wrap(
        &mut failures,
        "never-fit measure pre-wrap uses display columns",
        "abcd",
        &WrapOpts {
            white_space: WhiteSpace::PreWrap,
            measure: Some(&never_fits),
            ..WrapOpts::new(3)
        },
        &["abc", "d"],
    );
    push_wrap(
        &mut failures,
        "never-fit measure pre-wrap keeps the break space",
        "ab cd",
        &WrapOpts {
            white_space: WhiteSpace::PreWrap,
            measure: Some(&never_fits),
            ..WrapOpts::new(3)
        },
        &["ab ", "cd"],
    );
    push_wrap(
        &mut failures,
        "never-fit measure normal uses display columns",
        "abcd",
        &WrapOpts {
            measure: Some(&never_fits),
            ..WrapOpts::new(3)
        },
        &["abc", "d"],
    );
    push_wrap(
        &mut failures,
        "custom measure that always fits does not wrap",
        "hello world",
        &WrapOpts {
            measure: Some(&always_fits),
            ..WrapOpts::new(2)
        },
        &["hello world"],
    );

    let flag = "🇺🇸";
    push_eq(
        &mut failures,
        "flag pair is one grapheme",
        take_grapheme(flag),
        (flag, ""),
    );
    push_wrap(
        &mut failures,
        "flag pair is not split",
        flag,
        &opts(1, WhiteSpace::PreWrap),
        &[flag],
    );

    let wrap_lines = wrap_text("one two three four five", &clamped_opts(8, 2, None));
    push_eq(
        &mut failures,
        "line clamp predicate",
        (
            wrap_lines.len(),
            wrap_lines.get(1).is_some_and(|line| line.ends_with('…')),
        ),
        (2, true),
    );
    let clamped = TextNode {
        line_clamp: Some(2),
        ..node("one two three four five")
    };
    push_eq(
        &mut failures,
        "line clamp measure",
        measure_text_node(&clamped, 8, 5, None),
        TextExtent { w: 7, h: 2 },
    );

    let broken = wrap_text("漢字", &WrapOpts::new(2));
    let widths: Vec<usize> = broken.iter().map(|line| display_width(line)).collect();
    push_eq(
        &mut failures,
        "wrap width 2 hard-breaks 漢字",
        (broken, widths),
        (vec!["漢".to_string(), "字".to_string()], vec![2, 2]),
    );

    let columns: &[(&str, &str, usize)] = &[
        ("ASCII columns", "abc", 3),
        ("CJK columns", "漢字", 4),
        ("combining cluster is 1", "e\u{0301}", 1),
        ("ambiguous narrow default", "\u{00A1}", 1),
    ];
    for &(name, text, width) in columns {
        push_eq(&mut failures, name, display_width(text), width);
    }
    let graphemes: &[(&str, &str, usize)] = &[
        ("grapheme CJK", "漢", 2),
        ("grapheme ASCII", "a", 1),
        ("grapheme combining", "e\u{0301}", 1),
        ("grapheme return symbol", "⏎", 2),
        ("grapheme scheme repl", "\u{24aa}", 2),
        ("grapheme scheme watch", "\u{24b2}", 2),
    ];
    for &(name, text, width) in graphemes {
        push_eq(&mut failures, name, grapheme_width(text), width);
    }
    push_eq(
        &mut failures,
        "hint ⏎ is two columns",
        display_width("⏎: Confirm"),
        display_width(": Confirm") + 2,
    );
    push_eq(
        &mut failures,
        "⏎ is two-column pad",
        is_two_column_symbol("⏎"),
        true,
    );
    push_eq(
        &mut failures,
        "scheme sigils are two-column pads",
        is_two_column_symbol("\u{24aa}") && is_two_column_symbol("\u{24b2}"),
        true,
    );
    push_eq(
        &mut failures,
        "CJK is not two-column pad",
        is_two_column_symbol("漢"),
        false,
    );
    push_eq(&mut failures, "unit ASCII", is_unit_width_run("abc"), true);
    push_eq(&mut failures, "unit box", is_unit_width_run("─┌│"), true);
    push_eq(&mut failures, "unit CJK", is_unit_width_run("漢"), false);
    push_eq(&mut failures, "unit ⏎", is_unit_width_run("⏎"), false);

    let taken: &[(&str, &str, &str, &str)] = &[
        ("take ASCII", "ab", "a", "b"),
        ("take CJK whole", "漢字", "漢", "字"),
        ("take ⏎ whole", "⏎:", "⏎", ":"),
        ("empty grapheme", "", "", ""),
    ];
    for &(name, text, head, tail) in taken {
        push_eq(&mut failures, name, take_grapheme(text), (head, tail));
    }

    let splits: &[(&str, &str, i64, &str, &str)] = &[
        ("split ⏎ at 1 empty", "⏎:", 1, "", "⏎:"),
        ("split ⏎ at 2", "⏎:", 2, "⏎", ":"),
        ("split box", "────", 2, "──", "──"),
        ("split ASCII", "abc", 2, "ab", "c"),
        ("split CJK on full char", "漢字", 2, "漢", "字"),
        ("never half CJK at 3", "漢字", 3, "漢", "字"),
        ("never half CJK at 1", "漢字", 1, "", "漢字"),
        ("empty head at 0", "abc", 0, "", "abc"),
        ("empty head at -1", "abc", -1, "", "abc"),
        ("fits ASCII", "abc", 10, "abc", ""),
        ("fits CJK", "漢字", 4, "漢字", ""),
        (
            "combining cluster not split",
            "e\u{0301}x",
            1,
            "e\u{0301}",
            "x",
        ),
        ("empty split", "", 3, "", ""),
        ("split a漢 at 1", "a漢", 1, "a", "漢"),
        ("split a漢 at 2", "a漢", 2, "a", "漢"),
        ("split a漢 at 3", "a漢", 3, "a漢", ""),
    ];
    for &(name, text, width, head, tail) in splits {
        push_eq(
            &mut failures,
            name,
            split_at_width(text, width),
            (head, tail),
        );
    }

    let fitted = wrap_layout_text(&node("漢字"), 4, None);
    push_eq(
        &mut failures,
        "wrap layout 漢字 width 4 lines",
        fitted.lines,
        vec!["漢字".to_string()],
    );
    push_eq(
        &mut failures,
        "wrap layout 漢字 width 4 max_line",
        fitted.max_line,
        4,
    );
    push_eq(
        &mut failures,
        "measure 漢字 width 4",
        measure_text_node(&node("漢字"), 4, 10, None),
        TextExtent { w: 4, h: 1 },
    );
    let narrow = wrap_layout_text(&node("漢字"), 2, None);
    push_eq(
        &mut failures,
        "wrap layout 漢字 width 2 max_line",
        narrow.max_line,
        2,
    );
    push_eq(
        &mut failures,
        "measure 漢字 width 2",
        measure_text_node(&node("漢字"), 2, 10, None),
        TextExtent { w: 2, h: 2 },
    );
    let wrapped = wrap_layout_text(&node("hello world"), 8, None);
    push_eq(
        &mut failures,
        "wrap layout hello world lines",
        wrapped.lines,
        vec!["hello".to_string(), "world".to_string()],
    );
    push_eq(
        &mut failures,
        "wrap layout hello world max_line",
        wrapped.max_line,
        5,
    );
    let cjk = wrap_layout_text(&node("漢字"), 3, None);
    push_eq(
        &mut failures,
        "wrap layout 漢字 width 3 lines",
        cjk.lines,
        vec!["漢".to_string(), "字".to_string()],
    );
    push_eq(
        &mut failures,
        "wrap layout 漢字 width 3 max_line",
        cjk.max_line,
        2,
    );
    push_eq(
        &mut failures,
        "measure 漢字 width 3",
        measure_text_node(&node("漢字"), 3, 9, None),
        TextExtent { w: 2, h: 2 },
    );
    push_eq(
        &mut failures,
        "empty text measures one cell",
        measure_text_node(&node(""), 10, 10, None),
        TextExtent { w: 1, h: 1 },
    );
    push_eq(
        &mut failures,
        "recompute at width 0",
        measure_text_node(&node("hi"), 0, 100, None),
        TextExtent { w: 0, h: 2 },
    );

    // grapheme.test.ts — splitAtWidth never splits mid-cluster.
    let samples = ["漢字", "日本語", "漢字abc漢", "測試あいう", "e\u{0301}漢字"];
    for text in samples {
        let total = display_width(text) as i64;
        let mut segs = Vec::new();
        let mut rest = text;
        let mut broke = false;
        while !rest.is_empty() {
            let (cluster, next) = take_grapheme(rest);
            if cluster.is_empty() {
                failures.push(format!(
                    "take_grapheme returned an empty cluster\n  text: {text}"
                ));
                broke = true;
                break;
            }
            segs.push(cluster);
            rest = next;
        }
        if broke {
            continue;
        }
        for w in -1..=total + 2 {
            let (head, tail) = split_at_width(text, w);
            let mut rebuilt = String::new();
            let mut used = 0usize;
            for g in &segs {
                let gw = display_width(g);
                if w <= 0 || used + gw > w as usize {
                    break;
                }
                rebuilt.push_str(g);
                used += gw;
            }
            let concat = head.to_string() + tail;
            push_eq(
                &mut failures,
                &format!("{text} @ {w}"),
                (head, tail, concat.as_str(), display_width(head)),
                (rebuilt.as_str(), &text[rebuilt.len()..], text, used),
            );
        }
    }

    let unit_samples = [
        "hello world, this is a unit-width run 012345 ----",
        "────┌┐",
    ];
    for text in unit_samples {
        if !is_unit_width_run(text) {
            failures.push(format!("unit-width run\n  text: {text}"));
            continue;
        }
        let total = text.chars().count() as i64;
        for w in -1..=total + 2 {
            let (head, tail) = split_at_width(text, w);
            let expect_n = if w <= 0 {
                0
            } else {
                (w as usize).min(text.chars().count())
            };
            let mut end = 0;
            for (i, c) in text.chars().enumerate() {
                if i == expect_n {
                    break;
                }
                end += c.len_utf8();
            }
            push_eq(
                &mut failures,
                &format!("unit head {text} @ {w}"),
                head,
                &text[..end],
            );
            push_eq(
                &mut failures,
                &format!("unit tail {text} @ {w}"),
                tail,
                &text[end..],
            );
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn measured_stamp_is_width_tagged() {
    // overflow-clip.test.ts — "measured stamp is width-tagged".
    // hit: measureNode(node, 20, 100) === { w: 20, h: 1 }
    // miss: measureNode(node, 8, 100).h > 1
    let stamped = TextNode {
        measured: Some(MeasuredStamp {
            w: 20,
            h: 1,
            at_w: 20,
        }),
        ..node("hello world hello world")
    };
    let hit = measure_text_node(&stamped, 20, 100, None);
    let miss = measure_text_node(&stamped, 8, 100, None);
    assert_eq!(hit, TextExtent { w: 20, h: 1 });
    assert!(miss.h > 1, "miss.h = {}", miss.h);
    assert_eq!(miss, TextExtent { w: 5, h: 4 });

    // A stamp hit runs through clamp0.
    let negative_stamp = TextNode {
        measured: Some(MeasuredStamp {
            w: -3,
            h: -4,
            at_w: 20,
        }),
        ..node("hi")
    };
    assert_eq!(
        measure_text_node(&negative_stamp, 20, 20, None),
        TextExtent { w: 0, h: 0 }
    );
}

#[test]
fn ambiguous_wide_inverted_exclamation_is_two_columns() {
    assert_eq!(display_width("\u{00A1}"), 1);
    assert_eq!(display_width_ambiguous("\u{00A1}", None), 1);
    assert_eq!(display_width_ambiguous("\u{00A1}", Some(true)), 1);
    assert_eq!(display_width_ambiguous("\u{00A1}", Some(false)), 2);
    assert_eq!(display_width("e\u{0301}"), 1);
    assert_eq!(display_width_ambiguous("e\u{0301}", None), 1);
    assert_eq!(display_width_ambiguous("e\u{0301}", Some(true)), 1);
    assert_eq!(display_width_ambiguous("e\u{0301}", Some(false)), 1);
    assert_eq!(display_width_ambiguous("⏎", Some(false)), 2);
}
