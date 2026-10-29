//! Oracle for the place/measure walk.
//!
//! Ported from `packages/quickdraw/src/layout/engine.ts`, `indication.ts`,
//! `squeeze.ts`, `children.ts`, and the geometry / paint-order expects in
//! `layout/__tests__/frame.test.ts`, `overflow-clip.test.ts`,
//! `squeeze.test.ts`, `viewport-floor.test.ts`, and the grid paint arm of
//! `flex-grid.test.ts`.
//!
//! Hit testing, chrome frames, theme-role colors, and markdown expand are
//! BLOCKED below. Those expects are not given a stand-in value.

use std::cell::Cell;

use qd::layout_chrome::{measure_chrome_frame, ChromeFrame};
use qd::layout_engine::{
    collect_live_demand, collect_progress_sites, indication_gutter_lines, layout, measure_tree,
    omitted_label, plan_squeeze, squeeze_overlay, BoxStyle, Frame, Gutter, IndentKind, LayoutOpts,
    LiveDemand, LivePaint, Node, Origin, Overflow, OverflowAnchor, PaintOp, Positioned,
    SpinnerProfile, SqueezePins, SqueezeSlot, Sticky, Viewport,
};
use qd::layout_flex::{
    CellPad, Extent, FlexDirection, FlexFactor, FlexStyle, GridLines, GridStyle, JustifyContent,
    Length, Padding, Rect,
};
use qd::layout_hit::{layout_hits, ElementKind, HitExtra, HitNode};
use qd::layout_text::{MeasuredStamp, WhiteSpace, WrapMemo};
use qd::Style;

fn opts() -> LayoutOpts<'static> {
    LayoutOpts::default()
}

fn lay(root: &Node, w: i64, h: i64) -> Frame {
    layout(root, Viewport { w, h }, opts())
}

fn text(content: &str) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key: None,
        live: None,
        region_prominence: None,
    }
}

fn tk(key: &str, content: &str) -> Node {
    text_full(Some(key), content, None, None, None, None)
}

fn text_full(
    key: Option<&str>,
    content: &str,
    white_space: Option<WhiteSpace>,
    line_clamp: Option<i64>,
    measured: Option<MeasuredStamp>,
    live: Option<LivePaint>,
) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space,
        ellipsis: None,
        line_clamp,
        measured,
        style: Style::default(),
        key: key.map(str::to_string),
        live,
        region_prominence: None,
    }
}

fn box_of(key: Option<&str>, style: BoxStyle, children: Vec<Node>) -> Node {
    Node::Box {
        style,
        children,
        key: key.map(str::to_string),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn sized(w: i64, h: i64, flex: Option<FlexFactor>, children: Vec<Node>, key: Option<&str>) -> Node {
    box_of(
        key,
        BoxStyle {
            width: Some(Length::Cells(w)),
            height: Some(Length::Cells(h)),
            flex,
            ..BoxStyle::default()
        },
        children,
    )
}

fn viewport(anchor: OverflowAnchor, scroll: i64, children: Vec<Node>) -> Node {
    Node::Viewport {
        id: "vp".to_string(),
        key: None,
        children,
        anchor,
        scroll,
        width: None,
        height: None,
        measured: None,
        region_prominence: None,
    }
}

fn lines_of(n: i64, prefix: &str) -> Vec<Node> {
    (0..n)
        .map(|i| tk(&format!("l{i}"), &format!("{prefix}{i:02}")))
        .collect()
}

fn text_lines(frame: &Frame) -> Vec<String> {
    frame
        .paint_order
        .iter()
        .flat_map(|pos| &pos.paint)
        .filter_map(|op| match op {
            PaintOp::Text { lines, .. } => Some(lines.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn placed<'a>(frame: &'a Frame, key: &str) -> Option<&'a Rect> {
    frame
        .placed
        .iter()
        .rev()
        .find(|hit| hit.key == key)
        .map(|hit| &hit.rect)
}

fn placed_y(frame: &Frame, key: &str) -> Option<i64> {
    placed(frame, key).map(|rect| rect.y)
}

fn regions(frame: &Frame, key: &str) -> Vec<Option<f64>> {
    frame
        .paint_order
        .iter()
        .filter(|pos| pos.key == key)
        .flat_map(|pos| pos.paint.iter().map(|op| op.style().region_prominence))
        .collect()
}

fn fills(frame: &Frame) -> Vec<&PaintOp> {
    frame
        .paint_order
        .iter()
        .flat_map(|pos| &pos.paint)
        .filter(|op| matches!(op, PaintOp::Fill { .. }))
        .collect()
}

fn paint_key(frame: &Frame, key: &str) -> bool {
    frame.paint_order.iter().any(|pos| pos.key == key)
}

fn visible_squeeze_keys(frame: &Frame) -> Vec<String> {
    let mut keys: Vec<(i64, String)> = frame
        .placed
        .iter()
        .filter(|hit| hit.key.starts_with('l') || hit.key.contains("omit-"))
        .map(|hit| (hit.rect.y, hit.key.clone()))
        .collect();
    keys.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    keys.into_iter().map(|(_, key)| key).collect()
}

fn face(slots: &[SqueezeSlot]) -> Vec<String> {
    slots
        .iter()
        .map(|slot| match slot {
            SqueezeSlot::Child { index, .. } => format!("#{index}"),
            SqueezeSlot::Omit { count, .. } => format!("omit:{count}"),
        })
        .collect()
}

fn ones(n: usize) -> Vec<i64> {
    vec![1; n]
}

// BLOCKED — not ported. Each assertion needs hit testing, a theme role, a
// painted buffer cell, chrome, or markdown. Geometry from the same `expect`
// is asserted below and is not weakened.
//
// layout/__tests__/frame.test.ts
//   "frame geometry, wrap, viewport, overlay, and border merge":
//     hit: { key: "btn", intent: "activate" }
//     border.style: { role: "border", prominence: FgP.ghost }
//     dim.backdropHit: dimBackdrop.byKey.has("ovl:backdrop") === true
//     overlay.key: elementAt(overlaySibling, pick.hitRect.x + 1, pick.hitRect.y + 1)?.key === "pick"
//     panelFill: { corner: 235, inner: 235 }
//   "indication furniture is not body":
//     gutter: { kind: "rule", role: "border", prominence: FgP.ghost, bold: false }
//     body: { role: "foreground", prominence: FgP.secondary, x: 3 }
//     Role and prominence stay blocked. body.x, rule rows, top glyph, corners,
//     and exception x are asserted below.
//   "live demand, spinner clock, fold, and birth W":
//     clock: resolveLiveText / paintFrame ch0 / ch1 / waveMoved
//     spinnerLive: { thinkingHz: 12, workingProfile: "working" } as a formatter
//     fold.click: { type: "toggle_collapsed", blockId: "d" }
//     fold.hit: collapsed.hitList.some(h => h.key === "d") === true
//   "quota remaining is painted from resetAt, not a frozen string"
//   "expired quota percentages disappear until a fresh snapshot arrives"
//   "elapsed live keeps a tenths place"
//   "countdown live spells remaining seconds"
//   "attuneTheme does not mutate ambient and guesses depth from env"
//   "progress ease identity, snap, and picker skip"
//
// layout/__tests__/overflow-clip.test.ts
//   cellCh(yBuf, 0, 0) === "A"
//   cellCh(autoBuf, 0, 0) === "X"
//   cellCh(bBuf, 0, 0) === "┌"
//   cellCh(bBuf, 0, 1) === "│"
//   elementAt(yHidden, 0, 5)?.meta.element?.kind === "text" === false
//   visualCaretGeometry("ab\n", 2, 40) === { line: 0, colInContent: 2, totalLines: 2 }
//   visualCaretGeometry("ab\ncd", 2, 40) === { line: 0, colInContent: 2, totalLines: 2 }
//   visualCaretGeometry("ab\n", 3, 40) === { line: 1, colInContent: 0, totalLines: 2 }
//
// layout/__tests__/squeeze.test.ts
//   "squeeze overlay floors void cells over scrolled tape":
//     tape === "X", peek === "P", voidCh === " ", voidHasBg === false,
//     voidCast === "transparent", voidIsX === false
//   The void fill op (key `:void`, cast_transparent) is asserted below.
//   Buffer cells are not.
//
// layout/__tests__/viewport-floor.test.ts
//   inFlow: elementAt === "a2"
//   pin: elementAt === "q"
//   top: "PROMPT" (paintFrame)
//   just / riding / ridingAnswer / arriving / taken elementAt keys
//   pastEndTop / pastEndA1 / midTurnTop / midTurnAnswer elementAt keys
//   fits pin elementAt === "A0"
//   exact top / next elementAt and painted === "A0"
//   The byKey y values in those expects are asserted below.
//
// layout/__tests__/flex-grid.test.ts
//   sample: { role: "border", prominence: FgP.ghost, fg: undefined, dim: undefined }
//   allRoleBorder: every line style is role "border" and prominence FgP.ghost
//   hasLines and the bar glyphs/positions are asserted below. Roles are not.
//
// chrome_frame measure/paint (chrome_frame arm, chrome.test.ts) — not this walk.
// markdown expand — a raw Node::Markdown expands in the walk; see expand_oracle.
// theme role resolution to colors — not this walk.

#[test]
fn plan_squeeze_overview_grows_the_head_and_tour_keeps_both_pins() {
    let tight = plan_squeeze(&ones(20), 0, 9, 0, 20, 4, 4);
    let wide = plan_squeeze(&ones(20), 0, 15, 0, 20, 4, 4);
    let tour_top = plan_squeeze(&ones(100), 0, 20, 0, 20, 4, 4);
    let tour_mid = plan_squeeze(&ones(100), 40, 20, 0, 20, 4, 4);
    let tour_end = plan_squeeze(&ones(100), 80, 20, 0, 20, 4, 4);
    let fits = plan_squeeze(&ones(6), 0, 10, 0, 10, 4, 4);
    let tiny = plan_squeeze(&ones(20), 0, 5, 0, 20, 4, 4);
    assert_eq!(omitted_label(12), "·· 12 lines omitted ··");
    assert_eq!(omitted_label(1), "·· 1 line omitted ··");
    assert_eq!(
        face(&tight),
        ["#0", "#1", "#2", "#3", "omit:12", "#16", "#17", "#18", "#19"]
    );
    assert_eq!(
        face(&wide),
        [
            "#0", "#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "omit:6", "#16", "#17",
            "#18", "#19",
        ]
    );
    assert_eq!(
        face(&tour_top),
        [
            "#0", "#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11", "#12", "#13",
            "#14", "omit:81", "#96", "#97", "#98", "#99",
        ]
    );
    assert_eq!(
        face(&tour_mid),
        [
            "#0", "#1", "#2", "#3", "omit:40", "#44", "#45", "#46", "#47", "#48", "#49", "#50",
            "#51", "#52", "#53", "omit:42", "#96", "#97", "#98", "#99",
        ]
    );
    assert_eq!(
        face(&tour_end),
        [
            "#0", "#1", "#2", "#3", "omit:81", "#85", "#86", "#87", "#88", "#89", "#90", "#91",
            "#92", "#93", "#94", "#95", "#96", "#97", "#98", "#99",
        ]
    );
    assert_eq!(face(&fits), ["#0", "#1", "#2", "#3", "#4", "#5"]);
    assert_eq!(face(&tiny), ["#0", "#1", "omit:16", "#18", "#19"]);
    assert!(tight.iter().any(|slot| matches!(
        slot,
        SqueezeSlot::Omit {
            edge: qd::layout_engine::OmitEdge::Mid,
            count: 12,
            ..
        }
    )));
}

#[test]
fn viewport_squeeze_peeks_when_the_last_child_is_below() {
    let lines = lines_of(20, "L");
    let tree = |scroll: i64| {
        viewport(
            OverflowAnchor::None,
            scroll,
            vec![
                box_of(
                    Some("tape"),
                    BoxStyle::default(),
                    (0..10)
                        .map(|i| tk(&format!("t{i}"), &format!("T{i}")))
                        .collect(),
                ),
                box_of(
                    Some("diff"),
                    BoxStyle {
                        squeeze: Some(SqueezePins { head: 4, tail: 4 }),
                        ..BoxStyle::default()
                    },
                    lines.clone(),
                ),
            ],
        )
    };
    let peek = squeeze_overlay(
        Rect {
            x: 0,
            y: 10,
            w: 24,
            h: 20,
        },
        Rect {
            x: 0,
            y: 0,
            w: 24,
            h: 10,
        },
        20,
        9,
    );
    assert_eq!(
        peek,
        Some(Rect {
            x: 0,
            y: 1,
            w: 24,
            h: 9,
        })
    );
    let below = lay(&tree(0), 24, 10);
    let filled = lay(&tree(10), 24, 10);
    assert_eq!(
        visible_squeeze_keys(&below),
        [
            "l0",
            "l1",
            "l2",
            "l3",
            "diff:omit-mid",
            "l16",
            "l17",
            "l18",
            "l19"
        ]
    );
    assert_eq!(placed_y(&below, "l0"), Some(1));
    assert_eq!(placed_y(&below, "l19"), Some(9));
    assert!(placed(&below, "l4").is_none());
    assert!(placed(&below, "l15").is_none());
    assert_eq!(
        visible_squeeze_keys(&filled),
        [
            "l0",
            "l1",
            "l2",
            "l3",
            "l4",
            "diff:omit-below",
            "l16",
            "l17",
            "l18",
            "l19"
        ]
    );
    assert!(placed(&filled, "l5").is_none());
    assert!(placed(&filled, "l15").is_none());
}

#[test]
fn squeeze_void_fill_covers_the_overlay_with_a_transparent_cast() {
    let tree = viewport(
        OverflowAnchor::None,
        0,
        vec![
            box_of(
                Some("tape"),
                BoxStyle::default(),
                (0..10)
                    .map(|i| tk(&format!("t{i}"), "XXXXXXXXXXXXXXXXXXXXXXXX"))
                    .collect(),
            ),
            box_of(
                Some("diff"),
                BoxStyle {
                    squeeze: Some(SqueezePins { head: 4, tail: 4 }),
                    ..BoxStyle::default()
                },
                (0..20).map(|i| tk(&format!("l{i}"), "PEEK")).collect(),
            ),
        ],
    );
    let frame = lay(&tree, 24, 10);
    let void_paint = frame
        .paint_order
        .iter()
        .find(|pos| pos.key == "diff:void")
        .expect("void fill is painted before the peek");
    assert_eq!(
        void_paint.rect,
        Rect {
            x: 0,
            y: 1,
            w: 24,
            h: 9,
        }
    );
    match void_paint.paint.as_slice() {
        [PaintOp::Fill { rect, style }] => {
            assert_eq!(
                *rect,
                Rect {
                    x: 0,
                    y: 1,
                    w: 24,
                    h: 9,
                }
            );
            assert!(style.cast_transparent);
        }
        other => panic!("void paint is one transparent fill, got {other:?}"),
    }
}

#[test]
fn nested_squeeze_still_peeks_below_the_clip() {
    let tree = viewport(
        OverflowAnchor::None,
        0,
        vec![
            box_of(
                Some("tape"),
                BoxStyle::default(),
                (0..10)
                    .map(|i| tk(&format!("t{i}"), &format!("T{i}")))
                    .collect(),
            ),
            box_of(
                Some("ask:diff"),
                BoxStyle::default(),
                vec![box_of(
                    Some("ask:body"),
                    BoxStyle {
                        padding: Some(Padding::Edges {
                            t: Some(1),
                            r: None,
                            b: None,
                            l: None,
                        }),
                        ..BoxStyle::default()
                    },
                    vec![
                        tk("ask:id", "? edit_file a.ts"),
                        Node::IndentationException {
                            kind: IndentKind::Diff,
                            children: vec![box_of(
                                Some("ask:squeeze"),
                                BoxStyle {
                                    squeeze: Some(SqueezePins { head: 4, tail: 4 }),
                                    ..BoxStyle::default()
                                },
                                lines_of(20, "L"),
                            )],
                            key: Some("ask:diff-body".to_string()),
                            measured: None,
                            region_prominence: None,
                        },
                    ],
                )],
            ),
        ],
    );
    let frame = lay(&tree, 24, 10);
    assert_eq!(
        visible_squeeze_keys(&frame),
        [
            "l0",
            "l1",
            "l2",
            "l3",
            "ask:squeeze:omit-mid",
            "l16",
            "l17",
            "l18",
            "l19",
        ]
    );
    assert_eq!(placed_y(&frame, "l0"), Some(1));
    assert_eq!(placed_y(&frame, "l19"), Some(9));
}

#[test]
fn frame_geometry_wrap_viewport_overlay_and_border_count() {
    let row = lay(
        &Node::Flex {
            style: FlexStyle {
                direction: FlexDirection::Row,
                gap: 1,
                ..FlexStyle::default()
            },
            children: vec![
                sized(5, 1, None, vec![text("hello")], Some("a")),
                sized(
                    5,
                    1,
                    Some(FlexFactor::Sugar(1.0)),
                    vec![text("world")],
                    Some("b"),
                ),
            ],
            key: None,
            measured: None,
            region_prominence: None,
        },
        20,
        5,
    );
    assert_eq!(placed(&row, "a").map(|rect| rect.w), Some(5));
    assert!(!row.paint_order.is_empty());

    let column = lay(
        &Node::Flex {
            style: FlexStyle {
                direction: FlexDirection::Column,
                justify_content: JustifyContent::SpaceBetween,
                width: Some(Length::Cells(10)),
                height: Some(Length::Cells(10)),
                ..FlexStyle::default()
            },
            children: vec![
                sized(10, 2, None, vec![text("A")], Some("top")),
                sized(10, 2, None, vec![text("B")], Some("bot")),
            ],
            key: None,
            measured: None,
            region_prominence: None,
        },
        10,
        10,
    );
    assert_eq!(placed_y(&column, "top"), Some(0));
    assert_eq!(placed_y(&column, "bot"), Some(8));

    let row_flush = lay(
        &Node::Flex {
            style: FlexStyle {
                direction: FlexDirection::Row,
                justify_content: JustifyContent::SpaceBetween,
                gap: 0,
                ..FlexStyle::default()
            },
            children: vec![
                sized(1, 1, None, vec![text("A")], Some("a")),
                sized(1, 1, None, vec![text("B")], Some("b")),
                sized(1, 1, None, vec![text("C")], Some("c")),
            ],
            key: None,
            measured: None,
            region_prominence: None,
        },
        10,
        1,
    );
    let flush_c = placed(&row_flush, "c").expect("c is placed");
    assert_eq!(placed(&row_flush, "a").map(|rect| rect.x), Some(0));
    assert_eq!(flush_c.x + flush_c.w, 10);

    let wrap = lay(
        &text_full(
            Some("clamp"),
            "one two three four five",
            None,
            Some(2),
            None,
            None,
        ),
        8,
        5,
    );
    let wrap_lines = text_lines(&wrap);
    assert_eq!(wrap_lines.len(), 2);
    assert!(wrap_lines[1].ends_with('…'));

    let vp_children: Vec<Node> = (0..10)
        .map(|i| tk(&format!("l{i}"), &format!("line-{i}")))
        .collect();
    let auto_tail = text_lines(&lay(
        &viewport(OverflowAnchor::Auto, 0, vp_children.clone()),
        20,
        3,
    ));
    assert!(auto_tail.iter().any(|line| line == "line-9"));
    assert!(!auto_tail.iter().any(|line| line == "line-0"));
    let none_scroll = text_lines(&lay(&viewport(OverflowAnchor::None, 2, vp_children), 20, 3));
    assert!(none_scroll.iter().any(|line| line == "line-2"));
    assert!(none_scroll.iter().any(|line| line == "line-4"));
    assert!(!none_scroll.iter().any(|line| line == "line-0"));
    assert!(!none_scroll.iter().any(|line| line == "line-9"));

    let top_clip = text_lines(&lay(
        &viewport(
            OverflowAnchor::None,
            1,
            vec![tk("tall", "aaaa bbbb cccc dddd eeee")],
        ),
        4,
        2,
    ));
    assert_eq!(top_clip, ["bbbb", "cccc"]);

    let border = lay(
        &box_of(
            None,
            BoxStyle {
                border: true,
                width: Some(Length::Cells(6)),
                height: Some(Length::Cells(3)),
                ..BoxStyle::default()
            },
            vec![],
        ),
        10,
        5,
    );
    let border_n = border
        .paint_order
        .iter()
        .flat_map(|pos| &pos.paint)
        .filter(|op| matches!(op, PaintOp::Border { .. }))
        .count();
    assert_eq!(border_n, 1);

    let dim = lay(
        &box_of(
            None,
            BoxStyle::default(),
            vec![
                tk("base", "behind"),
                Node::Overlay {
                    center: false,
                    origin: None,
                    backdrop: true,
                    backdrop_style: None,
                    children: vec![tk("modal-body", "modal")],
                    key: Some("ovl".to_string()),
                    measured: None,
                    region_prominence: None,
                },
            ],
        ),
        20,
        5,
    );
    assert!(fills(&dim).is_empty());
    assert_eq!(regions(&dim, "base"), vec![Some(0.4)]);
    assert_eq!(regions(&dim, "modal-body"), vec![None]);

    let painted = lay(
        &box_of(
            None,
            BoxStyle::default(),
            vec![
                tk("base", "behind"),
                Node::Overlay {
                    center: false,
                    origin: None,
                    backdrop: true,
                    backdrop_style: Some(Style {
                        bg: Some(236.0),
                        ..Style::default()
                    }),
                    children: vec![text("modal")],
                    key: Some("ovl".to_string()),
                    measured: None,
                    region_prominence: None,
                },
            ],
        ),
        20,
        5,
    );
    let painted_fills = fills(&painted);
    assert_eq!(painted_fills.len(), 1);
    assert_eq!(painted_fills[0].style().bg, Some(236.0));
    assert_eq!(regions(&painted, "base"), vec![None]);

    let overlay = lay(
        &box_of(
            None,
            BoxStyle {
                width: Some(Length::Cells(40)),
                height: Some(Length::Cells(12)),
                ..BoxStyle::default()
            },
            vec![
                sized(40, 12, None, vec![text("under")], Some("under")),
                Node::Overlay {
                    center: true,
                    origin: None,
                    backdrop: true,
                    backdrop_style: Some(Style {
                        bg: Some(236.0),
                        ..Style::default()
                    }),
                    children: vec![box_of(
                        Some("pick"),
                        BoxStyle {
                            border: true,
                            width: Some(Length::Cells(14)),
                            height: Some(Length::Cells(4)),
                            background: Some(Style {
                                bg: Some(235.0),
                                ..Style::default()
                            }),
                            ..BoxStyle::default()
                        },
                        vec![tk("pick-body", "Select an LLM")],
                    )],
                    key: Some("ovl".to_string()),
                    measured: None,
                    region_prominence: None,
                },
            ],
        ),
        40,
        12,
    );
    assert_eq!(placed(&overlay, "pick").map(|rect| rect.h), Some(4));
    assert!(paint_key(&overlay, "pick-body"));
}

#[test]
fn nested_backdrop_overlays_multiply_region_dim() {
    let frame = lay(
        &box_of(
            None,
            BoxStyle::default(),
            vec![
                tk("tape", "tape"),
                Node::Overlay {
                    center: false,
                    origin: None,
                    backdrop: true,
                    backdrop_style: None,
                    children: vec![
                        tk("side", "side"),
                        Node::Overlay {
                            center: false,
                            origin: None,
                            backdrop: true,
                            backdrop_style: None,
                            children: vec![tk("modal", "modal")],
                            key: Some("peek".to_string()),
                            measured: None,
                            region_prominence: None,
                        },
                    ],
                    key: Some("drawer".to_string()),
                    measured: None,
                    region_prominence: None,
                },
            ],
        ),
        20,
        5,
    );
    assert_eq!(regions(&frame, "tape"), vec![Some(0.4 * 0.4)]);
    assert_eq!(regions(&frame, "side"), vec![Some(0.4)]);
    assert_eq!(regions(&frame, "modal"), vec![None]);
}

#[test]
fn overlay_origin_seats_the_child_at_overlay_local_xy() {
    let frame = lay(
        &box_of(
            None,
            BoxStyle {
                width: Some(Length::Cells(20)),
                height: Some(Length::Cells(10)),
                ..BoxStyle::default()
            },
            vec![Node::Overlay {
                center: false,
                origin: Some(Origin { x: 5, y: 3 }),
                backdrop: false,
                backdrop_style: None,
                children: vec![sized(4, 2, None, vec![text("hi")], Some("plaque"))],
                key: Some("ovl".to_string()),
                measured: None,
                region_prominence: None,
            }],
        ),
        20,
        10,
    );
    assert_eq!(
        placed(&frame, "plaque").copied(),
        Some(Rect {
            x: 5,
            y: 3,
            w: 4,
            h: 2,
        })
    );
}

#[test]
fn indication_furniture_geometry_is_not_the_body() {
    let quoted = lay(
        &Node::Indication {
            gutter: Gutter::Rule {
                glyph: "|".to_string(),
            },
            children: vec![tk("q", "quoted")],
            style: Style::default(),
            key: Some("bq".to_string()),
            measured: None,
            region_prominence: None,
        },
        20,
        2,
    );
    let body = quoted
        .paint_order
        .iter()
        .find(|pos| pos.key == "q")
        .and_then(|pos| pos.paint.first());
    assert_eq!(body.map(PaintOp::rect).map(|rect| rect.x), Some(3));

    let rule = lay(
        &Node::Indication {
            gutter: Gutter::Rule {
                glyph: "|".to_string(),
            },
            children: vec![tk("a", "first"), tk("b", "second"), tk("c", "third")],
            style: Style::default(),
            key: Some("bq".to_string()),
            measured: None,
            region_prominence: None,
        },
        20,
        5,
    );
    let rule_lines = glyph_lines(&rule, "bq:glyph");
    assert_eq!(
        rule_lines
            .iter()
            .map(|line| !line.trim().is_empty())
            .collect::<Vec<_>>(),
        vec![true, true, true]
    );
    assert_eq!(body_x(&rule, "a"), Some(3));

    let top = lay(
        &Node::Indication {
            gutter: Gutter::Top {
                glyph: ">".to_string(),
            },
            children: vec![text_full(
                Some("body"),
                "hi\nworld",
                Some(WhiteSpace::PreWrap),
                None,
                None,
                None,
            )],
            style: Style::default(),
            key: Some("composer".to_string()),
            measured: None,
            region_prominence: None,
        },
        20,
        4,
    );
    let top_lines = glyph_lines(&top, "composer:glyph");
    assert!(!top_lines
        .first()
        .unwrap_or(&String::new())
        .trim()
        .is_empty());
    assert!(top_lines.iter().skip(1).all(|line| line.trim().is_empty()));
    assert_eq!(body_x(&top, "body"), Some(3));

    let closed = indication_gutter_lines(
        &Gutter::Corners {
            top: "T".to_string(),
            mid: Some("M".to_string()),
            bottom: Some("B".to_string()),
        },
        3,
    );
    let open = indication_gutter_lines(
        &Gutter::Corners {
            top: "T".to_string(),
            mid: Some("M".to_string()),
            bottom: None,
        },
        3,
    );
    assert_ne!(closed[2], closed[1]);
    assert_eq!(open[2], open[1]);

    let bleed = lay(
        &Node::IndentationException {
            kind: IndentKind::Diff,
            children: vec![tk("diff-line", "+line")],
            key: Some("d1".to_string()),
            measured: None,
            region_prominence: None,
        },
        20,
        2,
    );
    assert_eq!(body_x(&bleed, "diff-line"), Some(0));
}

fn glyph_lines(frame: &Frame, key: &str) -> Vec<String> {
    frame
        .paint_order
        .iter()
        .find(|pos| pos.key == key)
        .and_then(|pos| pos.paint.first())
        .and_then(|op| match op {
            PaintOp::Text { lines, .. } => Some(lines.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn body_x(frame: &Frame, key: &str) -> Option<i64> {
    frame
        .paint_order
        .iter()
        .find(|pos| pos.key == key)
        .and_then(|pos| pos.paint.first())
        .map(|op| op.rect().x)
}

#[test]
fn live_demand_fold_and_birth_counts() {
    let spinner = Node::Indication {
        gutter: Gutter::Spinner {
            profile: Some(SpinnerProfile::Thinking),
            rows: None,
        },
        children: vec![tk("b", "thinking")],
        style: Style::default(),
        key: Some("t".to_string()),
        measured: None,
        region_prominence: None,
    };
    let spinner_frame = lay(&spinner, 40, 5);
    assert_eq!(spinner_frame.live_demand.max_hz, 12);
    assert_eq!(spinner_frame.live_demand.spinners, 1);
    assert_eq!(collect_live_demand(&spinner_frame.paint_order).spinners, 1);

    let summary = text_full(Some("s"), "sum", None, None, None, None);
    let disclosure = |collapsed: bool| Node::Disclosure {
        collapsed,
        summary: Box::new(summary.clone()),
        children: vec![tk("b1", "hidden"), tk("b2", "body")],
        key: Some("d".to_string()),
        measured: None,
        region_prominence: None,
    };
    let collapsed = lay(&disclosure(true), 40, 8);
    let open = lay(&disclosure(false), 40, 8);
    assert!(paint_key(&collapsed, "s"));
    assert!(!paint_key(&collapsed, "b1"));
    assert!(!paint_key(&collapsed, "b2"));
    assert!(paint_key(&open, "b1"));
    assert_eq!(
        measure_tree(&disclosure(true), 40, 8, None),
        Extent { w: 3, h: 1 }
    );
    assert_eq!(
        measure_tree(&disclosure(false), 40, 8, None),
        Extent { w: 6, h: 2 }
    );

    let birth = text_full(
        Some("tip"),
        "abcdefghij",
        None,
        None,
        None,
        Some(LivePaint::Birth {
            hz: 0,
            t: 10,
            offset: 0,
            site_id: "tip".into(),
        }),
    );
    let birth_frame = lay(&birth, 20, 2);
    assert_eq!(
        birth_frame.live_demand,
        LiveDemand {
            max_hz: 0,
            spinners: 0,
            elapsed: 0,
            quota: 0,
            birth: 1,
        }
    );
    assert_eq!(collect_live_demand(&birth_frame.paint_order).birth, 1);
    let live_content = birth_frame.paint_order.iter().find_map(|pos| {
        pos.paint.iter().find_map(|op| match op {
            PaintOp::Live {
                live: LivePaint::Birth { .. },
                content,
                ..
            } => content.clone(),
            _ => None,
        })
    });
    assert_eq!(live_content.as_deref(), Some("abcdefghij"));
    assert!(text_lines(&birth_frame).is_empty());
}

#[test]
fn overflow_clip_hides_padded_and_sliced_lines() {
    let top_clip = text_lines(&lay(
        &viewport(
            OverflowAnchor::None,
            1,
            vec![text_full(
                Some("tall"),
                "aaaa bbbb cccc dddd eeee",
                None,
                None,
                None,
                None,
            )],
        ),
        4,
        2,
    ));
    assert_eq!(top_clip, ["bbbb", "cccc"]);

    let pad_leak = lay(
        &box_of(
            None,
            BoxStyle {
                height: Some(Length::Cells(3)),
                padding: Some(Padding::Edges {
                    t: Some(2),
                    r: None,
                    b: None,
                    l: None,
                }),
                overflow: Some(Overflow::Hidden),
                ..BoxStyle::default()
            },
            vec![tk("s", "SECRET")],
        ),
        10,
        1,
    );
    assert!(!text_lines(&pad_leak).join("").contains("SECRET"));

    let y_hidden = text_lines(&lay(
        &box_of(
            Some("tight"),
            BoxStyle {
                height: Some(Length::Cells(1)),
                overflow_y: Some(Overflow::Hidden),
                ..BoxStyle::default()
            },
            vec![tk("t", "AAAA\nBBBB")],
        ),
        8,
        1,
    ));
    assert!(y_hidden.iter().any(|line| line.contains("AAAA")));
    assert!(!y_hidden.iter().any(|line| line.contains("BBBB")));

    let auto_box = text_lines(&lay(
        &box_of(
            None,
            BoxStyle {
                height: Some(Length::Cells(1)),
                overflow: Some(Overflow::Auto),
                ..BoxStyle::default()
            },
            vec![tk("a", "XXXX\nYYYY")],
        ),
        8,
        1,
    ));
    assert!(auto_box.iter().any(|line| line.contains("XXXX")));
    assert!(!auto_box.iter().any(|line| line.contains("YYYY")));
}

#[test]
fn measured_stamp_skips_offscreen_wrap_and_is_width_tagged() {
    let offscreen = Cell::new(0i64);
    let measure = |text: &str| {
        if text.contains("BBBB") || text.contains("CCCC") {
            offscreen.set(offscreen.get() + 1);
        }
        text.chars().count()
    };
    let unit = |key: &str, mark: &str| Node::Box {
        style: BoxStyle::default(),
        children: vec![tk(&format!("{key}:t"), &format!("{mark}\n").repeat(20))],
        key: Some(key.to_string()),
        id: None,
        measured: Some(MeasuredStamp {
            w: 8,
            h: 20,
            at_w: 8,
        }),
        region_prominence: None,
    };
    let frame = layout(
        &viewport(
            OverflowAnchor::None,
            0,
            vec![box_of(
                Some("tape"),
                BoxStyle::default(),
                vec![unit("a", "AAAA"), unit("b", "BBBB"), unit("c", "CCCC")],
            )],
        ),
        Viewport { w: 8, h: 4 },
        LayoutOpts {
            measure: Some(&measure),
            frame_version: None,
            wrap_memo: None,
            measure_token: None,
        },
    );
    assert!(text_lines(&frame).iter().any(|line| line.contains("AAAA")));
    assert!(placed(&frame, "b").is_none());
    assert_eq!(offscreen.get(), 0);

    let stamped = text_full(
        None,
        "hello world hello world",
        None,
        None,
        Some(MeasuredStamp {
            w: 20,
            h: 1,
            at_w: 20,
        }),
        None,
    );
    assert_eq!(
        measure_tree(&stamped, 20, 100, None),
        Extent { w: 20, h: 1 }
    );
    assert!(measure_tree(&stamped, 8, 100, None).h > 1);
}

#[test]
fn grid_bars_are_finite_and_the_table_measures_25_by_5() {
    let empty = Node::Grid {
        style: GridStyle {
            lines: GridLines::None,
            ..GridStyle::columns(vec![])
        },
        line_style: None,
        children: vec![Node::Text {
            content: "x".to_string(),
            white_space: Some(WhiteSpace::Nowrap),
            ellipsis: None,
            line_clamp: None,
            measured: None,
            style: Style::default(),
            key: None,
            live: None,
            region_prominence: None,
        }],
        key: Some("empty-cols".to_string()),
        measured: None,
        region_prominence: None,
    };
    let empty_measure = measure_tree(&empty, 20, 10, None);
    assert!(empty_measure.w > 0 && empty_measure.h > 0);
    let empty_frame = lay(&empty, 20, 10);
    let empty_texts: Vec<&PaintOp> = empty_frame
        .paint_order
        .iter()
        .flat_map(|pos| &pos.paint)
        .filter(|op| matches!(op, PaintOp::Text { .. }))
        .collect();
    assert!(!empty_texts.is_empty());
    // Rect coordinates are i64, so they are finite by type.
    for op in empty_texts {
        let rect = op.rect();
        assert!(rect.w >= 0 && rect.h >= 0);
    }

    let nowrap = |content: &str| Node::Text {
        content: content.to_string(),
        white_space: Some(WhiteSpace::Nowrap),
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key: None,
        live: None,
        region_prominence: None,
    };
    let table = Node::Grid {
        style: GridStyle {
            columns: vec![Length::Auto, Length::Auto, Length::Auto],
            column_gap: Some(1),
            row_gap: Some(1),
            lines: GridLines::Inner,
            cell_pad: Some(CellPad::Axes {
                x: Some(1),
                y: None,
            }),
            width: None,
            height: None,
        },
        line_style: Some(Style {
            dim: true,
            fg: Some(240.0),
            ..Style::default()
        }),
        children: [
            "check", "status", "ms", "compile", "ok", "812", "test", "ok", "4021",
        ]
        .into_iter()
        .map(nowrap)
        .collect(),
        key: Some("t".to_string()),
        measured: None,
        region_prominence: None,
    };
    assert_eq!(measure_tree(&table, 80, 40, None), Extent { w: 25, h: 5 });

    let inner = Node::Grid {
        style: GridStyle {
            columns: vec![Length::Auto, Length::Auto],
            column_gap: Some(1),
            row_gap: Some(1),
            lines: GridLines::Inner,
            cell_pad: Some(CellPad::Uniform(0)),
            width: None,
            height: None,
        },
        line_style: None,
        children: ["a", "b", "c", "d"].into_iter().map(nowrap).collect(),
        key: None,
        measured: None,
        region_prominence: None,
    };
    let frame = lay(&inner, 20, 5);
    let line_ops: Vec<&PaintOp> = frame
        .paint_order
        .iter()
        .filter(|pos| pos.key.ends_with(":lines"))
        .flat_map(|pos| &pos.paint)
        .collect();
    assert!(!line_ops.is_empty());
    let horizontal = line_ops.iter().find_map(|op| match op {
        PaintOp::Text { rect, lines, .. } if lines.iter().any(|line| line.contains('┼')) => {
            Some((*rect, lines.clone()))
        }
        _ => None,
    });
    let (horizontal_rect, horizontal_lines) = horizontal.expect("inner horizontal bar");
    assert_eq!(horizontal_rect.y, 1);
    assert_eq!(horizontal_lines, vec!["─┼─".to_string()]);
    let verticals: Vec<Rect> = line_ops
        .iter()
        .filter_map(|op| match op {
            PaintOp::Text { rect, lines, .. } if lines.iter().any(|line| line == "│") => {
                Some(*rect)
            }
            _ => None,
        })
        .collect();
    assert!(verticals.iter().any(|rect| rect.x == 1 && rect.y == 0));
    assert!(verticals.iter().any(|rect| rect.x == 1 && rect.y == 2));
}

#[test]
fn viewport_floors_the_last_child_and_sticky_bottom_stays_in_clip() {
    let short = lay(
        &viewport(
            OverflowAnchor::None,
            0,
            vec![tk("top", "TOP"), tk("bot", "BOT")],
        ),
        8,
        6,
    );
    assert_eq!(placed_y(&short, "top"), Some(0));
    assert_eq!(placed_y(&short, "bot"), Some(5));

    let tall = lay(
        &viewport(
            OverflowAnchor::None,
            0,
            vec![
                box_of(
                    Some("head"),
                    BoxStyle::default(),
                    (0..10)
                        .map(|i| tk(&format!("l{i}"), &format!("L{i}")))
                        .collect(),
                ),
                box_of(
                    Some("tail"),
                    BoxStyle {
                        sticky: Some(Sticky::Bottom),
                        ..BoxStyle::default()
                    },
                    vec![tk("stick", "STICK")],
                ),
            ],
        ),
        8,
        5,
    );
    assert_eq!(placed_y(&tall, "stick"), Some(4));
}

fn row(key: &str, content: &str) -> Node {
    tk(key, content)
}

fn scrolling_column(scroll: i64, children: Vec<Node>, h: i64) -> Frame {
    lay(
        &Node::Viewport {
            id: "vp".to_string(),
            key: Some("vp".to_string()),
            children: vec![box_of(Some("col"), BoxStyle::default(), children)],
            anchor: OverflowAnchor::None,
            scroll,
            width: None,
            height: None,
            measured: None,
            region_prominence: None,
        },
        12,
        h,
    )
}

fn turn_prompt(key: &str, lines: &[&str]) -> Node {
    box_of(
        Some(key),
        BoxStyle {
            sticky: Some(Sticky::Top),
            ..BoxStyle::default()
        },
        lines
            .iter()
            .enumerate()
            .map(|(i, content)| row(&format!("{key}{i}"), content))
            .collect(),
    )
}

#[test]
fn sticky_top_geometry_follows_the_clip() {
    let prompt = box_of(
        Some("prompt"),
        BoxStyle {
            sticky: Some(Sticky::Top),
            ..BoxStyle::default()
        },
        vec![row("q", "PROMPT")],
    );
    let children = vec![
        row("a0", "a0"),
        row("a1", "a1"),
        row("a2", "a2"),
        row("a3", "a3"),
        prompt,
        row("after", "AFTER"),
        row("b0", "b0"),
        row("b1", "b1"),
        row("b2", "b2"),
        row("b3", "b3"),
    ];
    let pinned = scrolling_column(5, children, 5);
    assert_eq!(placed_y(&pinned, "q"), Some(0));

    let body = |prefix: &str, n: i64| -> Vec<Node> {
        (0..n)
            .map(|i| row(&format!("{prefix}{i}"), &format!("{prefix}{i}")))
            .collect()
    };
    let mut turns = vec![turn_prompt("A", &["A0", "A1", "A2"])];
    turns.extend(body("a", 8));
    turns.push(turn_prompt("B", &["B0", "B1"]));
    turns.extend(body("b", 6));
    let just = scrolling_column(1, turns, 5);
    assert_eq!(placed_y(&just, "A0"), Some(0));

    let mut tall = vec![turn_prompt(
        "A",
        &["A0", "A1", "A2", "A3", "A4", "A5", "A6"],
    )];
    tall.extend(body("a", 10));
    tall.push(turn_prompt("B", &["B0"]));
    let past_end = scrolling_column(8, tall, 5);
    assert_eq!(placed_y(&past_end, "A0"), Some(0));
    assert_eq!(placed_y(&past_end, "a1"), Some(0));

    let mut fits = vec![turn_prompt("A", &["A0", "A1"])];
    fits.extend(body("a", 10));
    fits.push(turn_prompt("B", &["B0"]));
    let fits_frame = scrolling_column(4, fits, 5);
    assert_eq!(placed_y(&fits_frame, "a3"), Some(1));

    let mut exact = vec![turn_prompt("A", &["A0", "A1", "A2", "A3", "A4"])];
    exact.extend(body("a", 6));
    let exact_frame = scrolling_column(5, exact, 5);
    assert_eq!(placed_y(&exact_frame, "a0"), Some(0));
}

#[test]
fn positioned_clip_is_the_parent_intersection() {
    let frame = lay(&tk("only", "hi"), 4, 2);
    let pos: &Positioned = frame.paint_order.first().expect("text paints");
    assert_eq!(
        pos.clip,
        Rect {
            x: 0,
            y: 0,
            w: 4,
            h: 2,
        }
    );
}

fn pre_text(key: &str, content: &str) -> Node {
    text_full(
        Some(key),
        content,
        Some(WhiteSpace::PreWrap),
        None,
        None,
        None,
    )
}

fn scrolled(scroll: i64, w: i64, child: Node) -> Node {
    Node::Viewport {
        id: "vp".into(),
        key: Some("vp".into()),
        children: vec![child],
        anchor: OverflowAnchor::None,
        scroll,
        width: Some(Length::Cells(w)),
        height: Some(Length::Cells(8)),
        measured: None,
        region_prominence: None,
    }
}

fn with_memo<'a>(measure: &'a dyn Fn(&str) -> usize, memo: &'a mut WrapMemo) -> LayoutOpts<'a> {
    LayoutOpts {
        measure: Some(measure),
        frame_version: None,
        wrap_memo: Some(memo),
        measure_token: Some(1),
    }
}

#[test]
fn wrap_memo_reuses_a_width_and_remeasures_when_it_changes() {
    let wide = Cell::new(0u32);
    let measure = |text: &str| {
        if text.len() > 40 {
            wide.set(wide.get() + 1);
        }
        text.len()
    };
    let blob = (0..80)
        .map(|i| format!("L{i} {}", "x".repeat(50)))
        .collect::<Vec<_>>()
        .join("\n");
    let mut memo = WrapMemo::default();
    let first = layout(
        &scrolled(80, 40, pre_text("big", &blob)),
        Viewport { w: 40, h: 8 },
        with_memo(&measure, &mut memo),
    );
    let after_first = wide.get();
    assert!(after_first > 0);
    let second = layout(
        &scrolled(160, 40, pre_text("big", &blob)),
        Viewport { w: 40, h: 8 },
        with_memo(&measure, &mut memo),
    );
    assert_eq!(wide.get(), after_first);
    assert_ne!(
        text_lines(&first).join("\n"),
        text_lines(&second).join("\n")
    );

    let narrow = layout(
        &scrolled(0, 20, pre_text("big", &blob)),
        Viewport { w: 20, h: 8 },
        with_memo(&measure, &mut memo),
    );
    assert!(wide.get() > after_first);
    assert!(text_lines(&narrow).iter().all(|line| line.len() <= 20));
    let after_narrow = wide.get();
    let _ = layout(
        &scrolled(12, 20, pre_text("big", &blob)),
        Viewport { w: 20, h: 8 },
        with_memo(&measure, &mut memo),
    );
    assert_eq!(wide.get(), after_narrow);

    let changed = format!("{blob}\nTAIL {}", "y".repeat(50));
    let _ = layout(
        &scrolled(0, 40, pre_text("big", &changed)),
        Viewport { w: 40, h: 8 },
        with_memo(&measure, &mut memo),
    );
    assert!(wide.get() > after_narrow);
}

#[test]
fn stamped_viewport_scroll_is_192_and_the_inner_text_still_wraps() {
    let wraps = Cell::new(0u32);
    let measure = |text: &str| {
        if text.contains("INNER") {
            wraps.set(wraps.get() + 1);
        }
        text.len()
    };
    let blob = format!("INNER {}", "x".repeat(80));
    let tape = Node::Box {
        style: BoxStyle::default(),
        children: vec![pre_text("t", &blob)],
        key: Some("tape".into()),
        id: None,
        measured: Some(MeasuredStamp {
            w: 40,
            h: 200,
            at_w: 40,
        }),
        region_prominence: None,
    };
    let _ = layout(
        &scrolled(0, 40, tape),
        Viewport { w: 40, h: 8 },
        LayoutOpts {
            measure: Some(&measure),
            frame_version: None,
            wrap_memo: None,
            measure_token: None,
        },
    );
    assert!(wraps.get() > 0);
    let hits = layout_hits(
        &HitNode::Viewport {
            id: "vp".into(),
            key: Some("vp".into()),
            anchor: OverflowAnchor::None,
            scroll: 0,
            children: vec![HitNode::Box {
                key: Some("tape".into()),
                id: None,
                style: BoxStyle::default(),
                extra: HitExtra::default(),
                measured: Some(MeasuredStamp {
                    w: 40,
                    h: 200,
                    at_w: 40,
                }),
                children: vec![HitNode::Text {
                    content: blob,
                    key: Some("t".into()),
                    white_space: Some(WhiteSpace::PreWrap),
                    ellipsis: None,
                    line_clamp: None,
                    measured: None,
                    extra: HitExtra::default(),
                }],
            }],
        },
        Viewport { w: 40, h: 8 },
    );
    let ElementKind::Viewport { max_scroll, .. } = hits.get("vp").expect("vp").kind() else {
        panic!("viewport kind");
    };
    assert_eq!(max_scroll, 192);
}

#[test]
fn a_clip_does_not_measure_the_blob_below_it() {
    let below = Cell::new(0u32);
    let measure = |text: &str| {
        if text.contains("BELOW_CLIP") {
            below.set(below.get() + 1);
        }
        text.len()
    };
    let blob = (0..40)
        .map(|i| format!("BELOW_CLIP {i} {}", "x".repeat(40)))
        .collect::<Vec<_>>()
        .join("\n");
    let mut children = vec![n_sticky("p1", "PROMPT"), tk("vis", "VISIBLE LINE")];
    children.extend((0..12).map(|i| tk(&format!("fill{i}"), &format!("row {i}"))));
    children.push(n_sticky("p2", "LATER"));
    children.push(pre_text("low", &blob));
    let frame = layout(
        &box_of(
            Some("col"),
            BoxStyle {
                width: Some(Length::Cells(40)),
                height: Some(Length::Cells(6)),
                overflow: Some(Overflow::Hidden),
                ..BoxStyle::default()
            },
            children,
        ),
        Viewport { w: 40, h: 6 },
        LayoutOpts {
            measure: Some(&measure),
            frame_version: None,
            wrap_memo: None,
            measure_token: None,
        },
    );
    let painted = text_lines(&frame).join("\n");
    assert_eq!(below.get(), 0);
    assert!(painted.contains("VISIBLE"));
    assert!(!painted.contains("LATER"));
    assert!(!painted.contains("BELOW_CLIP"));
}

fn n_sticky(key: &str, label: &str) -> Node {
    box_of(
        Some(key),
        BoxStyle {
            sticky: Some(Sticky::Top),
            ..BoxStyle::default()
        },
        vec![tk(&format!("{key}:t"), label)],
    )
}

fn chrome_node(key: &str, frame: ChromeFrame) -> Node {
    Node::Chrome {
        key: Some(key.to_string()),
        frame,
    }
}

fn painted_text(frame: &Frame) -> String {
    let mut out = String::new();
    for pos in &frame.paint_order {
        for op in &pos.paint {
            if let PaintOp::Text { lines, .. } = op {
                for line in lines {
                    out.push_str(line);
                }
            }
        }
    }
    out
}

#[test]
fn nested_chrome_frame_measures_and_paints_the_draft() {
    let frame = ChromeFrame::new(30, "hello\nworld");
    let node = chrome_node("composer", frame.clone());
    let measured = measure_tree(&node, 40, 10, None);
    let geom = measure_chrome_frame(&frame, 40, 10);
    assert!(measured.w > 0 && measured.h > 0, "{measured:?}");
    assert_eq!(
        (measured.w, measured.h),
        (40.min(geom.outer_w).max(0), 10.min(geom.total_h).max(0)),
    );
    let laid = lay(&node, 40, 10);
    let text = painted_text(&laid);
    assert!(text.contains("hello"), "{text}");
    assert!(text.contains("world"), "{text}");
}

#[test]
fn collect_progress_sites_keeps_composer_frame_and_skips_plain_bottom() {
    let tree = box_of(
        None,
        BoxStyle::default(),
        vec![
            Node::Chrome {
                key: Some("slash-complete".to_string()),
                frame: ChromeFrame {
                    plain_bottom: true,
                    progress: Some(0.9),
                    ..ChromeFrame::new(40, "")
                },
            },
            chrome_node(
                "composer:frame",
                ChromeFrame {
                    progress: Some(0.3),
                    ..ChromeFrame::new(40, "")
                },
            ),
        ],
    );
    let sites = collect_progress_sites(&tree);
    assert_eq!(sites.len(), 1);
    assert_eq!(sites[0].key, "composer:frame");
    assert_eq!(sites[0].progress, 0.3);
}
