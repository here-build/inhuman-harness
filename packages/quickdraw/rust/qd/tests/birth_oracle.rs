use qd::birth::{
    birth_frontier_live, create_birth_frontier, stamp_stream_birth, step_birth_frontier,
    wavefront_prominence,
};
use qd::create_buffer;
use qd::layout_engine::{layout, LayoutOpts, LivePaint, Node, Viewport};
use qd::layout_flex::{FlexDirection, FlexStyle};
use qd::present::{cell_glyph, cell_style, paint_frame};

#[test]
fn thought_birth_clock_advances_with_the_caller_and_then_reaches_the_tip() {
    let t0 = 1_000.0;
    let mut state = step_birth_frontier(&create_birth_frontier(), 4.0, t0, false);
    assert_eq!(state.w, 0.0);
    assert!(birth_frontier_live(&state));
    state = step_birth_frontier(&state, 4.0, t0 + 200.0, false);
    assert!(state.w > 0.0);
    assert!(state.w <= 4.0);

    assert!(wavefront_prominence(40.0, 0.0, 8.0, 0.72) < 1.0 / 255.0);

    let mut wrapped = step_birth_frontier(&create_birth_frontier(), 80.0, t0, false);
    assert!(wrapped.w > 50.0);
    wrapped = step_birth_frontier(&wrapped, 6.0, t0 + 16.0, false);
    assert!(wrapped.w < 6.0);

    let mut coast = step_birth_frontier(&create_birth_frontier(), 80.0, t0, false);
    let parked = coast.w;
    coast = step_birth_frontier(&coast, 80.0, t0 + 100.0, false);
    let d1 = coast.w - parked;
    coast = step_birth_frontier(&coast, 80.0, t0 + 200.0, false);
    let d2 = coast.w - (parked + d1);
    coast = step_birth_frontier(&coast, 80.0, t0 + 400.0, false);
    assert_eq!(parked, 68.0);
    assert!((d1 - d2).abs() < 0.01);
    assert_eq!(coast.w, 80.0);
    assert!(!birth_frontier_live(&coast));
}

fn line(content: &str) -> Node {
    Node::Text {
        content: content.into(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: qd::Style::default(),
        key: None,
        live: None,
        region_prominence: None,
    }
}

fn column(children: Vec<Node>) -> Node {
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Column,
            ..FlexStyle::default()
        },
        children,
        key: None,
        measured: None,
        region_prominence: None,
    }
}

fn text_live(node: &Node, index: usize) -> Option<&LivePaint> {
    let Node::Flex { children, .. } = node else {
        return None;
    };
    match children.get(index)? {
        qd::layout_engine::Node::Text { live, .. } => live.as_ref(),
        _ => None,
    }
}

#[test]
fn stream_birth_marks_the_newest_line_and_leaves_the_older_line() {
    let newest = "second line of the reply";
    let stamped = qd::birth::stamp_stream_birth(
        column(vec![
            line("first line of the reply"),
            line(""),
            line(newest),
        ]),
        "speech",
    );
    assert!(text_live(&stamped, 0).is_none());
    assert!(text_live(&stamped, 1).is_none());
    assert_eq!(
        text_live(&stamped, 2),
        Some(&LivePaint::Birth {
            hz: 0,
            t: newest.len() as i64,
            offset: 0,
            site_id: "speech".into(),
        })
    );

    let stamped = stamp_stream_birth(
        column(vec![line("older line"), line("newest arrival")]),
        "speech",
    );
    let laid = layout(&stamped, Viewport { w: 40, h: 4 }, LayoutOpts::default());
    let mut buf = create_buffer(40, 4);
    paint_frame(&laid, &mut buf, 0.0, |style| style.clone());
    let mut painted = String::new();
    for y in 0..buf.height() {
        for x in 0..buf.width() {
            painted.push_str(cell_glyph(&buf, x, y));
        }
        painted.push('\n');
    }
    assert!(painted.contains("newest arrival"), "{painted}");
    assert!(painted.contains("older line"), "{painted}");
    assert!(!painted.contains('⠋'), "{painted}");

    let long = "a".repeat(40);
    let stamped = stamp_stream_birth(column(vec![line(&long)]), "speech");
    let laid = layout(&stamped, Viewport { w: 40, h: 2 }, LayoutOpts::default());
    let mut buf = create_buffer(40, 2);
    paint_frame(&laid, &mut buf, 0.0, |style| style.clone());
    let (head_x, tail_x, row) = birth_ends(&buf);
    let head = cell_style(&buf, head_x, row)
        .prominence
        .expect("head prominence");
    let tail = cell_style(&buf, tail_x, row)
        .prominence
        .expect("tail prominence");
    assert!(tail < head, "head {head} tail {tail}");
    let dist = (tail_x as f64) + 0.5 - (40.0 - 12.0);
    let expected = head * 0.8_f64.powf(dist);
    assert!(
        (tail - expected).abs() < 1e-9,
        "tail {tail} expected {expected} at dist {dist}"
    );
}

fn birth_ends(buf: &qd::Buffer) -> (usize, usize, usize) {
    let mut head = None;
    let mut tail = None;
    let mut row = 0;
    for y in 0..buf.height() {
        for x in 0..buf.width() {
            if cell_glyph(buf, x, y) == "a" {
                if head.is_none() {
                    head = Some(x);
                    row = y;
                }
                tail = Some(x);
            }
        }
    }
    (head.expect("head glyph"), tail.expect("tail glyph"), row)
}
