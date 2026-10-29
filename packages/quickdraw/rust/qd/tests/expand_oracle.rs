//! Markdown and diff expand.
//!
//! `expand_markdown(text) -> Node` and `expand_diff(...)` turn priors into
//! layout nodes. Fence text stays `role: code`. Cold and warm highlight live
//! in the syntax tests.

use std::time::Instant;

use qd::expand::{
    expand_diff, expand_markdown, expand_markdown_with, DiffContext, DiffExpand, DiffMode,
    MarkdownExpand,
};
use qd::layout_engine::{Gutter, IndentKind, Node};
use qd::theme::FgP;
use qd::Style;

const SPEECH: &str = "hello **world**";

#[derive(Clone, Debug, PartialEq)]
struct Face {
    bold: bool,
    dim: bool,
    strike: bool,
    underline: bool,
    role: Option<String>,
    href: Option<String>,
    prominence: Option<f64>,
}

#[derive(Debug, PartialEq, Eq)]
struct QuoteSeen {
    glyph: String,
    children: usize,
    gap: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct FencePaint {
    key: Option<String>,
    const_code: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct CsiStrip {
    plain: String,
    bold_has_reset: bool,
    bold_has_still: bool,
    bold_keeps_markers: bool,
    bold_keeps_sgr: bool,
    link_href: Option<String>,
    link_text_has_url: bool,
    image_has_url: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct Greet {
    diff: bool,
    old_line: bool,
    new_line: bool,
    path: bool,
    json_in_text: bool,
    del: bool,
    add: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum BodyRow {
    Missing,
    SplitPair,
    Box,
    Other,
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

fn text_list(node: &Node) -> Vec<String> {
    let mut found = Vec::new();
    texts(node, &mut found);
    found
}

fn joined(node: &Node) -> String {
    text_list(node).concat()
}

fn find_text(node: &Node, pred: &mut dyn FnMut(&str, &Style) -> bool) -> bool {
    match node {
        Node::Text { content, style, .. } => pred(content, style),
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            children.iter().any(|child| find_text(child, pred))
        }
        Node::Disclosure {
            summary, children, ..
        } => find_text(summary, pred) || children.iter().any(|child| find_text(child, pred)),
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => false,
    }
}

fn has_bold_world(node: &Node) -> bool {
    find_text(node, &mut |content, style| content == "world" && style.bold)
}

fn face_where(node: &Node, mut pred: impl FnMut(&str) -> bool) -> Option<Face> {
    let mut found = None;
    find_text(node, &mut |content, style| {
        if !pred(content) {
            return false;
        }
        found = Some(Face {
            bold: style.bold,
            dim: style.dim,
            strike: style.strike,
            underline: style.underline,
            role: style.role.clone(),
            href: style.href.clone(),
            prominence: style.prominence,
        });
        true
    });
    found
}

fn quote_seen(node: &Node) -> Option<QuoteSeen> {
    let Node::Box { children, .. } = node else {
        return None;
    };
    let Node::Indication {
        gutter, children, ..
    } = children.first()?
    else {
        return None;
    };
    let Gutter::Rule { glyph } = gutter else {
        return None;
    };
    let mut gap = Vec::new();
    if let Some(mid) = children.get(1) {
        texts(mid, &mut gap);
    }
    Some(QuoteSeen {
        glyph: glyph.clone(),
        children: children.len(),
        gap,
    })
}

fn box_mid(node: &Node) -> Option<(usize, Vec<String>)> {
    let Node::Box { children, .. } = node else {
        return None;
    };
    let mut mid = Vec::new();
    if let Some(child) = children.get(1) {
        texts(child, &mut mid);
    }
    Some((children.len(), mid))
}

fn box_len(node: &Node) -> Option<usize> {
    match node {
        Node::Box { children, .. } => Some(children.len()),
        _ => None,
    }
}

fn fence_paint(node: &Node) -> FencePaint {
    let Node::Box { children, .. } = node else {
        return FencePaint {
            key: None,
            const_code: false,
        };
    };
    let Some(Node::IndentationException { kind, key, .. }) = children.first() else {
        return FencePaint {
            key: None,
            const_code: false,
        };
    };
    if *kind != IndentKind::CodePad {
        return FencePaint {
            key: None,
            const_code: false,
        };
    }
    FencePaint {
        key: key.clone(),
        const_code: find_text(node, &mut |content, style| {
            content.contains("const") && style.role.as_deref() == Some("code")
        }),
    }
}

fn expand_speeches(count: usize) -> std::time::Duration {
    let started = Instant::now();
    for _ in 0..count {
        let node = expand_markdown(SPEECH);
        std::hint::black_box(&node);
    }
    started.elapsed()
}

#[test]
fn markdown_expand_paints_inline_blocks_and_fences() {
    let plain = expand_markdown("**world**");
    assert_eq!(
        (joined(&plain), has_bold_world(&plain)),
        ("world".to_string(), true)
    );

    let mixed = expand_markdown("hello **world**");
    assert_eq!(
        (joined(&mixed), has_bold_world(&mixed)),
        ("hello world".to_string(), true)
    );

    let prose = expand_markdown("hello from **markdown** and `code`");
    let bold_markdown = find_text(&prose, &mut |content, style| {
        content == "markdown" && style.bold
    });
    let code_role = find_text(&prose, &mut |content, style| {
        content == "code" && style.role.as_deref() == Some("code")
    });
    assert_eq!(
        (joined(&prose), bold_markdown, code_role),
        ("hello from markdown and code".to_string(), true, true)
    );

    let mut wrapped = MarkdownExpand::new("hello **world**");
    wrapped.width = Some(8);
    let wrapped = expand_markdown_with(&wrapped);
    assert_eq!(
        (text_list(&wrapped), has_bold_world(&wrapped)),
        (vec!["hello ".to_string(), "world".to_string()], true)
    );

    let package = "so the extra lines describe the actual package.";
    let cut = i64::try_from("so the extra lines describe the a".len()).unwrap_or(1);
    let mut opts = MarkdownExpand::new(package);
    opts.width = Some(cut);
    assert_eq!(
        text_list(&expand_markdown_with(&opts)),
        vec![
            "so the extra lines describe the ".to_string(),
            "actual package.".to_string(),
        ]
    );

    let voiced =
        expand_markdown("# Title\n\n### Sub\n\nhello **bold** and `code` and [link](https://x)\n");
    let title = face_where(&voiced, |content| content.contains("Title"));
    let link = face_where(&voiced, |content| content == "link");
    assert_eq!(
        title.map(|face| (face.role, face.prominence)),
        Some((Some("foreground".to_string()), Some(FgP::PRIMARY)))
    );
    assert_eq!(
        link.map(|face| (face.role, face.underline, face.href)),
        Some((
            Some("accent".to_string()),
            true,
            Some("https://x".to_string())
        ))
    );

    let mut muted = Style::default();
    muted.role = Some("muted".to_string());
    muted.prominence = Some(0.42);
    let mut inherited_opts = MarkdownExpand::new("# Hi\n\npara");
    inherited_opts.style = Some(&muted);
    let inherited = expand_markdown_with(&inherited_opts);
    assert_eq!(
        (
            face_where(&inherited, |content| content.contains("Hi"))
                .map(|face| (face.role, face.prominence)),
            face_where(&inherited, |content| content.contains("para"))
                .map(|face| (face.role, face.prominence)),
        ),
        (
            Some((Some("muted".to_string()), Some(FgP::PRIMARY))),
            Some((Some("muted".to_string()), Some(0.42))),
        )
    );

    let strike = expand_markdown("keep ~~remove~~ keep");
    assert_eq!(
        face_where(&strike, |content| content == "remove").map(|face| (face.strike, face.dim)),
        Some((true, false))
    );

    let quote = expand_markdown("> first\n>\n> second\n");
    assert_eq!(
        quote_seen(&quote),
        Some(QuoteSeen {
            glyph: "\u{2502}".to_string(),
            children: 3,
            gap: vec![" ".to_string()],
        })
    );

    let table = expand_markdown("| check | status |\n|---|---|\n| compile | ok |\n");
    assert_eq!(
        (
            text_list(&table),
            face_where(&table, |content| content == "check")
                .map(|face| (face.bold, face.prominence)),
        ),
        (
            vec![
                "check".to_string(),
                "status".to_string(),
                "compile".to_string(),
                "ok".to_string(),
            ],
            Some((true, Some(FgP::PRIMARY))),
        )
    );

    let plain_csi = joined(&expand_markdown("before\u{001b}[2Jafter"));
    let bold_csi = joined(&expand_markdown("**bold\u{001b}[0mreset** still"));
    let href = expand_markdown("[x](http://a\u{001b}[2Jb)");
    let image = joined(&expand_markdown("![a](http://a\u{001b}[2Jb)"));
    assert_eq!(
        CsiStrip {
            plain: plain_csi,
            bold_has_reset: bold_csi.contains("boldreset"),
            bold_has_still: bold_csi.contains("still"),
            bold_keeps_markers: bold_csi.contains("**"),
            bold_keeps_sgr: bold_csi.contains("0m"),
            link_href: face_where(&href, |content| content == "x").and_then(|face| face.href),
            link_text_has_url: joined(&href).contains("http://"),
            image_has_url: image.contains("http://ab"),
        },
        CsiStrip {
            plain: "beforeafter".to_string(),
            bold_has_reset: true,
            bold_has_still: true,
            bold_keeps_markers: false,
            bold_keeps_sgr: false,
            link_href: Some("http://ab".to_string()),
            link_text_has_url: false,
            image_has_url: true,
        }
    );

    let paras = expand_markdown("first\n\nsecond\n");
    assert_eq!(box_mid(&paras), Some((3, vec![" ".to_string()])));

    let list = expand_markdown("- a\n- b\n");
    assert_eq!(
        (
            box_len(&list),
            joined(&list).contains("\u{2022} a"),
            joined(&list).contains("\u{2022} b"),
        ),
        (Some(2), true, true)
    );

    let fence = expand_markdown("```ts\nconst x = 1\n```\n");
    assert!(joined(&fence).contains("const x = 1"));
    assert_eq!(
        fence_paint(&fence),
        FencePaint {
            key: Some("md:fence-ts-0".to_string()),
            const_code: true,
        }
    );
}

fn greet_face(node: &Node) -> Greet {
    let lines = text_list(node);
    Greet {
        diff: matches!(
            node,
            Node::IndentationException {
                kind: IndentKind::Diff,
                ..
            }
        ),
        old_line: joined(node).contains("return \"hello\""),
        new_line: joined(node).contains("hi, world"),
        path: lines.iter().any(|line| line.contains("src/hello.ts")),
        json_in_text: lines
            .iter()
            .any(|line| line.contains("{\"type\":\"diff\"}")),
        del: find_text(node, &mut |_, style| {
            style.role.as_deref() == Some("diff_del")
        }),
        add: find_text(node, &mut |_, style| {
            style.role.as_deref() == Some("diff_add")
        }),
    }
}

fn first_body_row(node: &Node) -> BodyRow {
    let Node::IndentationException { children, .. } = node else {
        return BodyRow::Missing;
    };
    let Some(Node::Flex { children: rows, .. }) = children.get(1) else {
        return BodyRow::Missing;
    };
    match rows.first() {
        Some(Node::Flex { children, .. }) if children.len() == 2 => BodyRow::SplitPair,
        Some(Node::Box { .. }) => BodyRow::Box,
        Some(_) => BodyRow::Other,
        None => BodyRow::Missing,
    }
}

#[test]
fn diff_expand_paints_greet_and_edge_rows() {
    let mut greet = DiffExpand::new(
        "export function greet() {\n  return \"hello\";\n}",
        "export function greet() {\n  return \"hi, world\";\n}",
        40,
    );
    greet.path = "src/hello.ts";
    assert_eq!(
        greet_face(&expand_diff(&greet)),
        Greet {
            diff: true,
            old_line: true,
            new_line: true,
            path: true,
            json_in_text: false,
            del: true,
            add: true,
        }
    );

    assert_eq!(
        text_list(&expand_diff(&DiffExpand::new("", "", 40))),
        vec!["file \u{00B7} proposed".to_string(), "(empty)".to_string()]
    );

    assert!(
        text_list(&expand_diff(&DiffExpand::new("hello", "hello\n", 40)))
            .iter()
            .any(|text| text == "no changes")
    );

    let crlf = joined(&expand_diff(&DiffExpand::new("old\r\n", "new\r\n", 40)));
    assert_eq!(
        (
            crlf.contains("old"),
            crlf.contains("new"),
            crlf.contains('\r')
        ),
        (true, true, false)
    );

    let mut wide = DiffExpand::new("a\n", "b\n", 80);
    wide.mode = DiffMode::Auto;
    assert_eq!(first_body_row(&expand_diff(&wide)), BodyRow::SplitPair);

    let mut forced = DiffExpand::new("a\n", "b\n", 80);
    forced.mode = DiffMode::Unified;
    assert_eq!(first_body_row(&expand_diff(&forced)), BodyRow::Box);

    assert_eq!(
        first_body_row(&expand_diff(&DiffExpand::new(
            "keep\n",
            "keep\nadded\n",
            80
        ))),
        BodyRow::Box
    );

    let mut numbered = DiffExpand::new("a\n", "b\n", 40);
    numbered.line_start = 10;
    numbered.mode = DiffMode::Unified;
    assert!(joined(&expand_diff(&numbered)).contains("10"));

    let mut elided = DiffExpand::new(
        "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n",
        "l0\nl1\nl2\nl3\nl4\nCHANGED\nl6\nl7\nl8\nl9\n",
        40,
    );
    elided.context = DiffContext::Lines(1);
    elided.mode = DiffMode::Unified;
    assert!(joined(&expand_diff(&elided)).contains("unchanged"));

    let word = expand_diff(&DiffExpand::new("hello world\n", "hello there\n", 80));
    let bold = bold_texts(&word);
    assert!(bold.iter().any(|text| text == "world"), "{bold:?}");
    assert!(bold.iter().any(|text| text == "there"), "{bold:?}");
    assert!(bold.iter().all(|text| !text.starts_with("hello")));

    let mut old = String::new();
    let mut new = String::new();
    for index in 0..600 {
        old.push_str(&format!("same-{index}\n"));
        if index == 300 {
            new.push_str("changed\n");
        } else {
            new.push_str(&format!("same-{index}\n"));
        }
    }
    let mut wide_opts = DiffExpand::new(&old, &new, 80);
    wide_opts.context = DiffContext::All;
    wide_opts.mode = DiffMode::Unified;
    let wide = joined(&expand_diff(&wide_opts));
    assert_eq!(wide.matches("same-0").count(), 1);
    assert_eq!(wide.matches("same-599").count(), 1);
    assert_eq!(wide.matches("changed").count(), 1);

    let patch = [
        "diff --git a/x.ts b/x.ts",
        "index 111..222 100644",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -10,3 +10,3 @@",
        " keep1",
        "-oldLine",
        "+newLine",
        " keep2",
        "",
    ]
    .join("\n");
    let laid = qd::expand::parse_patch_to_layout(&patch, 80);
    let texts = text_list(&laid);
    let old_idx = texts
        .iter()
        .position(|text| text == "oldLine")
        .expect("old");
    assert_eq!(texts[old_idx - 1].trim_end(), "11");
    assert!(joined(&laid).contains("9 unchanged"));

    let mut stream = qd::expand::MarkdownStream::new("m");
    stream.write("hello world");
    assert!(joined(&stream.nodes()).contains("hello world"));
    stream.write(" `code");
    assert!(joined(&stream.nodes()).contains("hello world"));
    assert!(joined(&stream.nodes()).contains("code"));

    qd::expand::install_realize();
    let raw = Node::Markdown {
        text: "hello **world**".into(),
        key: Some("raw".into()),
        width: Some(40),
    };
    let measured = qd::layout_engine::measure_tree(&raw, 40, 20, None);
    assert!(measured.h > 0);
    assert!(joined(&raw).is_empty() || measured.w > 0);
    let laid = qd::layout_engine::layout(
        &raw,
        qd::layout_engine::Viewport { w: 40, h: 20 },
        qd::layout_engine::LayoutOpts::default(),
    );
    assert!(!laid.paint_order.is_empty());
}

fn bold_texts(node: &Node) -> Vec<String> {
    match node {
        Node::Text { content, style, .. } if style.bold => vec![content.clone()],
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => Vec::new(),
        Node::Flex { children, .. }
        | Node::Box { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            children.iter().flat_map(bold_texts).collect()
        }
        Node::Disclosure {
            summary, children, ..
        } => {
            let mut out = bold_texts(summary);
            out.extend(children.iter().flat_map(bold_texts));
            out
        }
    }
}

#[test]
fn patch_hunks_and_a_live_markdown_stream_keep_what_arrived() {
    let patch = [
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -10,3 +10,3 @@",
        " keep1",
        "-oldLine",
        "+newLine",
        " keep2",
        "@@ -50,1 +60,1 @@",
        "-late",
        "+LATER",
        "",
    ]
    .join("\n");
    let texts = text_list(&qd::expand::parse_patch_to_layout(&patch, 80));
    let old_idx = texts
        .iter()
        .position(|text| text == "oldLine")
        .expect("old");
    let late_idx = texts.iter().position(|text| text == "late").expect("late");
    let later_idx = texts
        .iter()
        .position(|text| text == "LATER")
        .expect("later");
    assert_eq!(texts[old_idx - 1].trim_end(), "11");
    assert_eq!(texts[late_idx - 1].trim_end(), "50");
    assert_eq!(texts[later_idx - 1].trim_end(), "60");
    let laid = joined(&qd::expand::parse_patch_to_layout(&patch, 80));
    assert!(laid.contains("9 unchanged"));
    assert!(laid.contains("47 unchanged"));

    let mut stream = qd::expand::MarkdownStream::new("m");
    stream.write("hello `");
    assert_eq!(joined(&stream.nodes()).trim(), "hello `");
    stream.write("string");
    assert_eq!(joined(&stream.nodes()).trim(), "hello string");
    stream.write("`");
    assert_eq!(joined(&stream.nodes()).trim(), "hello string");
    stream.write(" world");
    assert_eq!(joined(&stream.nodes()).trim(), "hello string world");

    let mut heading = qd::expand::MarkdownStream::new("m");
    heading.write("# My Tit");
    assert!(joined(&heading.nodes()).contains("My Tit"));
    heading.write("le");
    assert!(joined(&heading.nodes()).contains("My Title"));

    let mut quote = qd::expand::MarkdownStream::new("m");
    quote.write("> quoted tex");
    assert!(joined(&quote.nodes()).contains("quoted tex"));
    quote.write("t");
    assert!(joined(&quote.nodes()).contains("quoted text"));

    let table = "| check | status |\n|---|---|\n| compile | ok |\n";
    let mut live = qd::expand::MarkdownStream::new("tbl");
    live.write(table);
    assert_eq!(text_list(&live.nodes()), text_list(&expand_markdown(table)));

    qd::expand::install_realize();
    let raw = Node::Diff {
        old: "a\n".into(),
        new: "b\n".into(),
        path: Some("a.ts".into()),
        key: Some("d".into()),
        width: 80,
        mode: Some(DiffMode::Unified),
        context: Some(qd::expand::DiffContext::All),
        line_start: 1,
        new_line_start: None,
        hide_header: false,
    };
    let measured = qd::layout_engine::measure_tree(&raw, 80, 20, None);
    assert!(measured.h > 0, "{measured:?}");
    let laid = qd::layout_engine::layout(
        &raw,
        qd::layout_engine::Viewport { w: 80, h: 20 },
        qd::layout_engine::LayoutOpts::default(),
    );
    let painted = laid.paint_order.iter().any(|pos| {
        pos.paint.iter().any(|op| match op {
            qd::layout_engine::PaintOp::Text { lines, .. } => {
                lines.iter().any(|line| line.contains('b'))
            }
            _ => false,
        })
    });
    assert!(painted);
}

fn any_fg(node: &Node) -> bool {
    match node {
        Node::Text { style, .. } => style.fg_rgb.is_some(),
        Node::Flex { children, .. }
        | Node::Box { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.iter().any(any_fg),
        Node::Disclosure {
            summary, children, ..
        } => any_fg(summary) || children.iter().any(any_fg),
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => false,
    }
}

#[test]
fn warm_fences_and_diffs_color_unless_highlight_is_off() {
    assert!(qd::syntax::warm());
    qd::syntax::set_polarity(qd::syntax::Polarity::Dark);

    let tagged = expand_markdown("```ts\nexport function greet() { return 1 }\n```\n");
    assert!(any_fg(&tagged), "a ts fence stays plain after warm");
    assert!(joined(&tagged).contains("function"));

    let guessed = expand_markdown("```\ndef greet(name):\n    return name\n```\n");
    assert!(any_fg(&guessed), "an untagged python fence stays plain");
    assert!(joined(&guessed).contains("return name"));

    let old_side = "const keep = 1;\nold\n";
    let new_side = "const keep = 1;\nnew\n";
    let mut quiet = DiffExpand::new(old_side, new_side, 80);
    quiet.path = "a.ts";
    quiet.no_highlight = true;
    quiet.hide_header = true;
    quiet.mode = DiffMode::Unified;
    assert!(!any_fg(&expand_diff(&quiet)), "no_highlight still colors");

    let mut loud = DiffExpand::new(old_side, new_side, 80);
    loud.path = "a.ts";
    loud.no_highlight = false;
    loud.hide_header = true;
    loud.mode = DiffMode::Unified;
    assert!(
        any_fg(&expand_diff(&loud)),
        "a ts diff stays plain after warm"
    );

    let quoted = [
        "diff --git \"a/my file.ts\" \"b/my file.ts\"",
        "--- \"a/my file.ts\"",
        "+++ \"b/my file.ts\"",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
    ]
    .join("\n");
    assert!(joined(&qd::expand::parse_patch_to_layout(&quoted, 80)).contains("my file.ts"));

    let renamed = [
        "diff --git a/old.ts b/new.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
    ]
    .join("\n");
    let renamed_text = joined(&qd::expand::parse_patch_to_layout(&renamed, 80));
    assert!(renamed_text.contains("new.ts"));
    assert!(!renamed_text.contains("old.ts ·"));

    let mixed = [
        "diff --git a/blob.bin b/blob.bin",
        "Binary files a/blob.bin and b/blob.bin differ",
        "diff --git a/keep.ts b/keep.ts",
        "--- a/keep.ts",
        "+++ b/keep.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
    ]
    .join("\n");
    let mixed_text = joined(&qd::expand::parse_patch_to_layout(&mixed, 80));
    assert!(mixed_text.contains("keep.ts"));
    assert!(mixed_text.contains("blob.bin"));
    assert!(mixed_text.contains("(empty)"));

    qd::expand::install_realize();
    let hidden = Node::Diff {
        old: "a\n".into(),
        new: "b\n".into(),
        path: Some("secret.ts".into()),
        key: Some("d".into()),
        width: 80,
        mode: Some(DiffMode::Unified),
        context: None,
        line_start: 8,
        new_line_start: None,
        hide_header: true,
    };
    let laid = qd::layout_engine::layout(
        &hidden,
        qd::layout_engine::Viewport { w: 80, h: 20 },
        qd::layout_engine::LayoutOpts::default(),
    );
    let blob = laid
        .paint_order
        .iter()
        .flat_map(|pos| pos.paint.iter())
        .filter_map(|op| match op {
            qd::layout_engine::PaintOp::Text { lines, .. } => Some(lines.join("\n")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!blob.contains("secret.ts"));
    assert!(
        blob.split('\n').any(|line| line.trim_end() == "8"),
        "{blob}"
    );
}

#[test]
fn emphasized_span_keeps_the_grammar_run_and_is_bold() {
    assert!(qd::syntax::warm());
    qd::syntax::set_polarity(qd::syntax::Polarity::Dark);
    let mut opts = DiffExpand::new("const keep = 1;\n", "const keep = 2;\n", 80);
    opts.path = "a.ts";
    opts.hide_header = true;
    opts.mode = DiffMode::Unified;
    let node = expand_diff(&opts);
    let faces = text_faces(&node);
    let keyword = faces.iter().find(|face| face.text.contains("const"));
    let changed = faces.iter().find(|face| face.text == "2");
    let kept = faces.iter().find(|face| face.text == "keep");
    assert!(
        matches!(
            (keyword, changed, kept),
            (
                Some(word),
                Some(digit),
                Some(name),
            ) if word.fg && !word.bold && digit.fg && digit.bold && name.fg && !name.bold
        ),
        "{faces:?}"
    );
}

#[test]
fn two_file_sides_expand_without_patch_text() {
    let mut opts = DiffExpand::new("alpha\nkeep\n", "beta\nkeep\n", 40);
    opts.path = "notes.txt";
    opts.hide_header = true;
    opts.no_highlight = true;
    let text = joined(&expand_diff(&opts));
    assert!(text.contains("alpha"), "{text}");
    assert!(text.contains("beta"), "{text}");
    assert!(text.contains("keep"), "{text}");
    assert!(!text.contains("@@"), "{text}");
    assert!(!text.contains("diff --git"), "{text}");
}

#[derive(Debug)]
struct Ink {
    text: String,
    bold: bool,
    fg: bool,
}

fn text_faces(node: &Node) -> Vec<Ink> {
    let mut out = Vec::new();
    walk_ink(node, &mut out);
    out
}

fn walk_ink(node: &Node, out: &mut Vec<Ink>) {
    match node {
        Node::Text { content, style, .. } => out.push(Ink {
            text: content.clone(),
            bold: style.bold,
            fg: style.fg_rgb.is_some(),
        }),
        Node::Flex { children, .. }
        | Node::Box { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children {
                walk_ink(child, out);
            }
        }
        Node::Disclosure {
            summary, children, ..
        } => {
            walk_ink(summary, out);
            for child in children {
                walk_ink(child, out);
            }
        }
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => {}
    }
}

#[derive(Clone, Debug)]
struct Chip {
    text: String,
    bg_role: Option<String>,
    prominence: Option<f64>,
    bold: bool,
    strike: bool,
}

#[derive(Clone, Debug)]
struct DiffRow {
    split: bool,
    wash: Option<String>,
    gutter: String,
    gutter_role: Option<String>,
    number: String,
    chips: Vec<Chip>,
}

fn diff_rows(node: &Node) -> Vec<DiffRow> {
    let Node::IndentationException { children, .. } = node else {
        return Vec::new();
    };
    let Some(Node::Flex { children, .. }) = children.last() else {
        return Vec::new();
    };
    children.iter().map(read_diff_row).collect()
}

fn read_diff_row(node: &Node) -> DiffRow {
    match node {
        Node::Flex { children, .. } if children.len() == 2 => {
            let mut row = read_box_row(children.first().unwrap_or(node));
            row.split = true;
            row
        }
        other => read_box_row(other),
    }
}

fn read_box_row(node: &Node) -> DiffRow {
    let Node::Box { style, children, .. } = node else {
        return DiffRow {
            split: false,
            wash: None,
            gutter: String::new(),
            gutter_role: None,
            number: String::new(),
            chips: Vec::new(),
        };
    };
    let wash = style
        .background
        .as_ref()
        .and_then(|paint| paint.bg_role.clone());
    let Some(Node::Flex { children: cells, .. }) = children.first() else {
        return DiffRow {
            split: false,
            wash,
            gutter: String::new(),
            gutter_role: None,
            number: String::new(),
            chips: Vec::new(),
        };
    };
    let gutter = text_of(cells.first());
    let gutter_role = style_of(cells.first()).and_then(|paint| paint.role.clone());
    let number = text_of(cells.get(1));
    let chips = cells.get(2).map(chips_of).unwrap_or_default();
    DiffRow {
        split: false,
        wash,
        gutter,
        gutter_role,
        number,
        chips,
    }
}

fn text_of(node: Option<&Node>) -> String {
    match node {
        Some(Node::Text { content, .. }) => content.clone(),
        _ => String::new(),
    }
}

fn style_of(node: Option<&Node>) -> Option<&Style> {
    match node {
        Some(Node::Text { style, .. }) => Some(style),
        _ => None,
    }
}

fn chips_of(node: &Node) -> Vec<Chip> {
    match node {
        Node::Text { content, style, .. } => vec![Chip {
            text: content.clone(),
            bg_role: style.bg_role.clone(),
            prominence: style.prominence,
            bold: style.bold,
            strike: style.strike,
        }],
        Node::Flex { children, .. } | Node::Box { children, .. } => {
            children.iter().flat_map(chips_of).collect()
        }
        _ => Vec::new(),
    }
}

fn paint_diff(old: &str, new: &str, width: i64, mode: DiffMode, path: &str, lang: Option<&str>) -> Vec<DiffRow> {
    let mut opts = DiffExpand::new(old, new, width);
    opts.path = path;
    opts.mode = mode;
    opts.language = lang;
    opts.no_highlight = true;
    diff_rows(&expand_diff(&opts))
}

fn row_dump(rows: &[DiffRow]) -> String {
    rows.iter()
        .map(|row| {
            let chips = row
                .chips
                .iter()
                .map(|chip| {
                    format!(
                        "{:?} bg={:?} p={:?} bold={} strike={}",
                        chip.text, chip.bg_role, chip.prominence, chip.bold, chip.strike
                    )
                })
                .collect::<Vec<_>>()
                .join(" | ");
            format!(
                "split={} wash={:?} gutter={:?}/{:?} num={:?} {chips}",
                row.split, row.wash, row.gutter, row.gutter_role, row.number
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_blue(rows: &[DiffRow]) -> DiffRow {
    assert_eq!(rows.len(), 1, "{}", row_dump(rows));
    let row = &rows[0];
    assert!(!row.split, "{}", row_dump(rows));
    assert_eq!(row.wash.as_deref(), Some("diff_mod"), "{}", row_dump(rows));
    assert_eq!(row.gutter_role.as_deref(), Some("diff_mod"), "{}", row_dump(rows));
    assert_eq!(row.gutter, "\u{258C}", "{}", row_dump(rows));
    assert!(row.chips.iter().all(|chip| !chip.strike), "{}", row_dump(rows));
    assert_eq!(row.number.trim(), "1", "{}", row_dump(rows));
    row.clone()
}

fn bg_texts(row: &DiffRow, role: &str) -> Vec<String> {
    row.chips
        .iter()
        .filter(|chip| chip.bg_role.as_deref() == Some(role))
        .map(|chip| chip.text.clone())
        .collect()
}

fn assert_no_blue(rows: &[DiffRow]) {
    assert!(
        rows.iter().all(|row| row.wash.as_deref() != Some("diff_mod")),
        "{}",
        row_dump(rows)
    );
}

#[test]
fn inline_diff_collapses_one_polarity_edits() {
    let old_427 = "await writeProjection(client, baseId, seen, { ...projection, rows, programs: [], facts: [], attempts: [], corrections: [] });\n";
    let new_427 = "await writeProjection(client, baseId, seen, { ...projection, rows });\n";
    let line = assert_blue(&paint_diff(old_427, new_427, 200, DiffMode::Auto, "grid-apply.ts", None));
    let ghosts = bg_texts(&line, "diff_del");
    assert_eq!(
        ghosts,
        vec![", programs: [], facts: [], attempts: [], corrections: []".to_string()],
        "{}",
        row_dump(std::slice::from_ref(&line))
    );
    assert!(
        ghosts.iter().all(|text| {
            line.chips.iter().any(|chip| {
                chip.text == *text
                    && chip.prominence == Some(FgP::GHOST)
                    && !chip.bold
                    && chip.bg_role.as_deref() == Some("diff_del")
            })
        }),
        "{}",
        row_dump(std::slice::from_ref(&line))
    );

    let rows_line = assert_blue(&paint_diff("rows,\n", "rows\n", 120, DiffMode::Auto, "a.ts", None));
    assert_eq!(bg_texts(&rows_line, "diff_del"), vec![",".to_string()]);

    let args = assert_blue(&paint_diff(
        "foo(a, b, c)\n",
        "foo(b)\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    assert_eq!(
        bg_texts(&args, "diff_del"),
        vec!["a, ".to_string(), ", c".to_string()],
        "{}",
        row_dump(std::slice::from_ref(&args))
    );

    let added = assert_blue(&paint_diff(
        "foo(a)\n",
        "foo(a, b)\n",
        120,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    let greens = bg_texts(&added, "diff_add");
    assert_eq!(greens, vec![", b".to_string()], "{}", row_dump(std::slice::from_ref(&added)));
    assert!(added.chips.iter().any(|chip| {
        chip.text == ", b" && chip.prominence == Some(FgP::PRIMARY) && !chip.bold
    }));

    let semi = assert_blue(&paint_diff("foo()\n", "foo();\n", 80, DiffMode::Auto, "a.ts", None));
    assert_eq!(bg_texts(&semi, "diff_add"), vec![";".to_string()]);

    let second = assert_blue(&paint_diff(
        "foo(a, a)\n",
        "foo(a)\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    assert_eq!(bg_texts(&second, "diff_del"), vec![", a".to_string()]);

    let space = assert_blue(&paint_diff("foo\n", "foo \n", 80, DiffMode::Auto, "a.ts", None));
    assert_eq!(bg_texts(&space, "diff_add"), vec![" ".to_string()]);

    let unwrap = assert_blue(&paint_diff(
        "const foo = compute(input);\n",
        "const foo = input;\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    assert_eq!(
        bg_texts(&unwrap, "diff_del"),
        vec!["compute(".to_string(), ")".to_string()],
        "{}",
        row_dump(std::slice::from_ref(&unwrap))
    );

    let call = assert_blue(&paint_diff(
        "items.push(item)\n",
        "item\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    assert_eq!(
        bg_texts(&call, "diff_del"),
        vec!["items.push(".to_string(), ")".to_string()],
        "{}",
        row_dump(std::slice::from_ref(&call))
    );

    let index = assert_blue(&paint_diff("items[i]\n", "i\n", 80, DiffMode::Auto, "a.ts", None));
    assert_eq!(
        bg_texts(&index, "diff_del"),
        vec!["items[".to_string(), "]".to_string()],
        "{}",
        row_dump(std::slice::from_ref(&index))
    );

    let drop_if = assert_blue(&paint_diff(
        "if (ready) return;\n",
        "return;\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    assert_eq!(
        bg_texts(&drop_if, "diff_del"),
        vec!["if (ready) ".to_string()],
        "{}",
        row_dump(std::slice::from_ref(&drop_if))
    );

    let generic = assert_blue(&paint_diff("Foo<Bar>\n", "Bar\n", 80, DiffMode::Auto, "a.ts", None));
    assert!(
        bg_texts(&generic, "diff_del").join("") .contains("Foo"),
        "{}",
        row_dump(std::slice::from_ref(&generic))
    );
    assert!(generic.chips.iter().any(|chip| chip.text == "Bar" && chip.bg_role.as_deref() != Some("diff_del")));

    let indent = assert_blue(&paint_diff(
        "    return value;\n",
        "  return;\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    assert_eq!(bg_texts(&indent, "diff_del"), vec![" value".to_string()]);

    let scheme = assert_blue(&paint_diff(
        "(foo a b c)\n",
        "(foo b)\n",
        80,
        DiffMode::Auto,
        "a.scm",
        None,
    ));
    assert!(
        !bg_texts(&scheme, "diff_del").is_empty(),
        "{}",
        row_dump(std::slice::from_ref(&scheme))
    );
    let scheme_plain: String = scheme
        .chips
        .iter()
        .filter(|chip| chip.bg_role.as_deref() != Some("diff_del"))
        .map(|chip| chip.text.as_str())
        .collect();
    assert_eq!(scheme_plain, "(foo b)");

    let rust_args = assert_blue(&paint_diff(
        "foo(a, b, c);\n",
        "foo(b);\n",
        80,
        DiffMode::Auto,
        "a.rs",
        None,
    ));
    assert_eq!(bg_texts(&rust_args, "diff_del").len(), 2);

    let py_args = assert_blue(&paint_diff(
        "foo(a, b, c)\n",
        "foo(b)\n",
        80,
        DiffMode::Auto,
        "a.py",
        None,
    ));
    assert_eq!(bg_texts(&py_args, "diff_del").len(), 2);

    let jsx = assert_blue(&paint_diff(
        "<div>{a}{b}</div>\n",
        "<div>{b}</div>\n",
        80,
        DiffMode::Auto,
        "a.tsx",
        Some("typescript"),
    ));
    assert!(!bg_texts(&jsx, "diff_del").is_empty(), "{}", row_dump(std::slice::from_ref(&jsx)));

    let commented = assert_blue(&paint_diff(
        "foo();\n",
        "// foo();\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    ));
    assert_eq!(bg_texts(&commented, "diff_add"), vec!["// ".to_string()]);

    let file_name = assert_blue(&paint_diff(
        "filename\n",
        "file\n",
        80,
        DiffMode::Auto,
        "notes.txt",
        None,
    ));
    assert_eq!(bg_texts(&file_name, "diff_del"), vec!["name".to_string()]);

    assert_no_blue(&paint_diff(
        "(foo a b c)\n",
        "(foo b)\n",
        80,
        DiffMode::Auto,
        "notes.txt",
        Some("arrival"),
    ));
    let ext_wins = assert_blue(&paint_diff(
        "(foo a b c)\n",
        "(foo b)\n",
        80,
        DiffMode::Auto,
        "a.scm",
        Some("arrival"),
    ));
    assert_eq!(
        ext_wins
            .chips
            .iter()
            .filter(|chip| chip.bg_role.as_deref() != Some("diff_del"))
            .map(|chip| chip.text.as_str())
            .collect::<String>(),
        "(foo b)"
    );

    for (old, new) in [
        ("let value = compute(input);\n", "value = input;\n"),
        ("(a + b)\n", "+\n"),
        ("return foo + bar;\n", "+\n"),
        ("function updateUserName(user) {\n", "update(user)\n"),
        ("a_very_long_name\n", "a\n"),
        ("foo(bar)\n", ")\n"),
        ("   hello\n", "   \n"),
        ("oldName\n", "newName\n"),
        ("a, b\n", "b, a\n"),
        ("\n", "hello\n"),
        ("hello\n", "\n"),
    ] {
        assert_no_blue(&paint_diff(old, new, 80, DiffMode::Auto, "a.ts", None));
    }

    let stacked = paint_diff("oldName\n", "newName\n", 80, DiffMode::Unified, "a.ts", None);
    assert_eq!(stacked.len(), 2, "{}", row_dump(&stacked));
    assert!(stacked.iter().all(|row| !row.split), "{}", row_dump(&stacked));
    assert_no_blue(&stacked);

    let forced = paint_diff("rows,\n", "rows\n", 120, DiffMode::Split, "a.ts", None);
    assert!(forced.iter().any(|row| row.split), "{}", row_dump(&forced));
    assert_no_blue(&forced);

    let kept = assert_blue(&paint_diff(
        "rows,\n",
        "rows\n",
        120,
        DiffMode::Unified,
        "a.ts",
        None,
    ));
    assert_eq!(bg_texts(&kept, "diff_del"), vec![",".to_string()]);

    let swapped = paint_diff(
        "return items;\nreturn;\n",
        "return;\nreturn items;\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    );
    assert_no_blue(&swapped);

    let tail = paint_diff("rows,\nextra\n", "rows\n", 80, DiffMode::Auto, "a.ts", None);
    assert_eq!(tail.len(), 2, "{}", row_dump(&tail));
    assert!(!tail[0].split && tail[0].wash.as_deref() == Some("diff_mod"), "{}", row_dump(&tail));
    assert!(!tail[1].split && tail[1].wash.as_deref() == Some("diff_del"), "{}", row_dump(&tail));

    let mixed_then = paint_diff(
        "oldName\nrows,\n",
        "newName\nrows\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    );
    assert_eq!(mixed_then.len(), 2, "{}", row_dump(&mixed_then));
    assert!(mixed_then[0].split, "{}", row_dump(&mixed_then));
    assert_eq!(mixed_then[1].wash.as_deref(), Some("diff_mod"), "{}", row_dump(&mixed_then));

    let mut long_old = "a".repeat(1000);
    long_old.push(',');
    long_old.push('\n');
    let long_new = format!("{}\n", "a".repeat(1000));
    let long_rows = paint_diff(&long_old, &long_new, 120, DiffMode::Auto, "a.ts", None);
    assert_eq!(long_rows.len(), 2, "{}", row_dump(&long_rows));
    assert_no_blue(&long_rows);

    let around = paint_diff(
        "keep\nrows,\nkeep\n",
        "keep\nrows\nkeep\n",
        80,
        DiffMode::Auto,
        "a.ts",
        None,
    );
    assert_eq!(around.len(), 3, "{}", row_dump(&around));
    assert_ne!(around[0].wash.as_deref(), Some("diff_mod"));
    assert_eq!(around[1].wash.as_deref(), Some("diff_mod"));
    assert_ne!(around[2].wash.as_deref(), Some("diff_mod"));
}

/// Release check. Debug timing is not a failure. Run with
/// `cargo test --release -- --ignored eight_hundred_short_speeches_beat_24ms`.
#[test]
#[ignore = "release-minded timing; debug is allowed to be slower than 24ms"]
fn eight_hundred_short_speeches_beat_24ms() {
    let elapsed = expand_speeches(800);
    assert!(
        elapsed.as_secs_f64() < 0.024,
        "800 short speech expands took {elapsed:?}"
    );
}
