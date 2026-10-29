//! Oracle for flex free-space and grid tracks.
//!
//! Ported from `packages/quickdraw/src/layout/flex.ts`, `layout/grid.ts`,
//! `layout/length.ts`, the grid arms of `layout/measure.ts`, the flex and grid
//! arms of `place` in `layout/engine.ts`, `layout/__tests__/flex-grid.test.ts`,
//! and the flex child rects in the first `expect` of
//! `layout/__tests__/frame.test.ts`.
//!
//! Paint, hit testing, overlay, sticky, viewport, and chrome are not this
//! module. Those assertions are BLOCKED below and are not weakened.

use qd::layout_flex::{
    cell_pad_xy, distribute_exact, flex_child_rects, flex_main_sizes, grid_cell_rects, is_fr,
    measure_grid_dims, measure_node, resolve_column_tracks, resolve_flex_item, resolve_length,
    track_offsets, tracks_extent, BoxStyle, CellPad, CellRect, Extent, FlexDirection, FlexFactor,
    FlexItemInput, FlexItemStyle, FlexStyle, GridLines, GridStyle, JustifyContent, Length, Node,
    Rect, ResolvedLength,
};
use qd::layout_text::{TextNode, WhiteSpace};

fn text(content: &'static str) -> Node<'static> {
    Node::Text(TextNode {
        content,
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
    })
}

fn text_ws(content: &'static str, white_space: WhiteSpace) -> Node<'static> {
    Node::Text(TextNode {
        content,
        white_space: Some(white_space),
        ellipsis: None,
        line_clamp: None,
        measured: None,
    })
}

fn box_wh(w: i64, h: i64, flex: Option<FlexFactor>, content: &'static str) -> Node<'static> {
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(w)),
            height: Some(Length::Cells(h)),
            flex,
            ..BoxStyle::default()
        },
        children: vec![text(content)],
    }
}

fn sugar_style() -> FlexItemStyle {
    FlexItemStyle {
        flex: Some(FlexFactor::Sugar(1.0)),
        ..FlexItemStyle::default()
    }
}

fn push_fail(buf: &mut Vec<String>, msg: String) {
    if buf.len() < 8 {
        buf.push(msg);
    }
}

fn push_eq<T: PartialEq + std::fmt::Debug>(buf: &mut Vec<String>, name: &str, got: T, want: T) {
    if got != want {
        buf.push(format!("{name}\n  got: {got:?}\n  want: {want:?}"));
    }
}

// BLOCKED — not ported. Each assertion needs paint, hit testing, or the layout
// engine (overlay, sticky, viewport, chrome). The flex and grid numbers in the
// same `expect` are asserted below.
//
// layout/__tests__/flex-grid.test.ts
//   "grid tracks stay finite and default lines are role chrome":
//     emptyTexts: emptyTexts.length > 0
//     emptyGeometry: emptyTexts.every(op =>
//       Number.isFinite(op.rect.x) && Number.isFinite(op.rect.y) &&
//       Number.isFinite(op.rect.w) && Number.isFinite(op.rect.h))
//     hasLines: Math.min(lineOps.length, 1) === 1
//     sample: { role: "border", prominence: FgP.ghost, fg: undefined, dim: undefined }
//     allRoleBorder: lineStyles.every(s =>
//       s.role === "border" && s.prominence === FgP.ghost &&
//       s.fg === undefined && s.dim === undefined)
//   `layout()` paint order. Default grid bars are `{ role: "border", prominence: FgP.ghost }`.
//   The empty grid's measured size and its content rect are asserted below;
//   the paint ops are not.
//
// layout/__tests__/frame.test.ts
//   "frame geometry, wrap, viewport, overlay, and border merge":
//     row.paints: row.paintOrder.length > 0 === true
//     hit: { key: "btn", intent: "activate" }
//     wrap: { n: 2, ellipsis: true }
//     autoTail: { hasLast: true, hasFirst: false }
//     noneScroll: { has2: true, has4: true, has0: false, has9: false }
//     topClip: ["bbbb", "cccc"]
//     border: { n: 1, style: { role: "border", prominence: FgP.ghost } }
//     dim: { fills: 0, baseRegion: [0.4], modalRegion: [undefined], backdropHit: true }
//     painted: { fills: 1, fillBg: 236, baseRegion: [undefined] }
//     overlay: { key: "pick", h: 4, painted: true }
//     panelFill: { corner: 235, inner: 235 }
//   The flex child rects in that expect are asserted below:
//     row.aW === 5, columnPins topY === 0 and botY === 8, rowFlush aX === 0 and lastEnd === 10.
//   "nested backdrop overlays multiply region dim":
//     { tape: [0.4 * 0.4], side: [0.4], modal: [undefined] }
//   "overlay origin seats the child at overlay-local x,y":
//     plaque.hitRect === { x: 5, y: 3, w: 4, h: 2 }

#[test]
fn flex_distribution_is_exact_and_frame_child_rects_match() {
    let mut sum_failures = Vec::new();
    for n in 1..=12 {
        let mut total = 0i64;
        while total <= 100 {
            let weights: Vec<f64> = (0..n)
                .map(|i| ((i as i64 * 3 + total) % 21) as f64)
                .collect();
            let parts = distribute_exact(&weights, total as f64);
            let sum: i64 = parts.iter().sum();
            let expect_sum = if weights.iter().all(|w| *w == 0.0) {
                0
            } else {
                total
            };
            let finite_non_neg = parts.iter().all(|p| *p >= 0);
            if sum != expect_sum || !finite_non_neg || parts.len() != n {
                push_fail(
                    &mut sum_failures,
                    format!("n={n} total={total} weights={weights:?} parts={parts:?}"),
                );
            }
            total += 7;
        }
    }

    let mut size_failures = Vec::new();
    for n in [1i64, 2, 3, 6] {
        for base in [0i64, 10, 40] {
            for min in [0i64, 8, 20] {
                for max in [5i64, 40, 80] {
                    for grow in [0i64, 1, 5] {
                        for shrink in [0i64, 3] {
                            let lo = min.min(base).min(max);
                            let hi = min.max(base).max(max);
                            let item = FlexItemInput {
                                base: lo.max(hi.min(base)),
                                min: lo,
                                max: Some(hi),
                                grow,
                                shrink,
                            };
                            let items = vec![item; n as usize];
                            for container_main in [0i64, 15, 120] {
                                for gap in [0i64, 2, 4] {
                                    let sizes = flex_main_sizes(&items, container_main, gap);
                                    let gaps = gap * (n - 1).max(0);
                                    let total = sizes.iter().sum::<i64>() + gaps;
                                    let min_total =
                                        items.iter().map(|it| it.min).sum::<i64>() + gaps;
                                    let overflow_ok = total <= container_main.max(min_total);
                                    let floors_ok =
                                        sizes.iter().zip(&items).all(|(s, it)| *s >= it.min);
                                    let finite_ok = sizes.iter().all(|s| *s >= 0);
                                    if sizes.len() != n as usize
                                        || !overflow_ok
                                        || !floors_ok
                                        || !finite_ok
                                    {
                                        push_fail(
                                            &mut size_failures,
                                            format!(
                                                "n={n} container={container_main} gap={gap} sizes={sizes:?}"
                                            ),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut spec = Vec::new();
    for (name, parts) in [
        (
            "nan weights finite",
            distribute_exact(&[f64::NAN, 1.0, 1.0], 100.0),
        ),
        (
            "inf weights finite",
            distribute_exact(&[f64::INFINITY, 1.0, 1.0], 100.0),
        ),
        (
            "nan total finite",
            distribute_exact(&[1.0, 1.0, 1.0], f64::NAN),
        ),
        (
            "inf total finite",
            distribute_exact(&[1.0, 1.0, 1.0], f64::INFINITY),
        ),
    ] {
        if parts.iter().any(|part| *part < 0) {
            spec.push(format!("{name}\n  got: {parts:?}"));
        }
    }
    let remainder: &[(&str, &[f64], f64, &[i64])] = &[
        ("empty weights", &[] as &[f64], 10.0, &[] as &[i64]),
        (
            "remainder tie keeps the earlier index",
            &[1.0, 1.0][..],
            1.0,
            &[1, 0][..],
        ),
        ("remainder tie on seven", &[1.0, 1.0][..], 7.0, &[4, 3][..]),
        ("zero weights stay zero", &[0.0, 0.0][..], 10.0, &[0, 0][..]),
        ("nan weight is zero", &[f64::NAN][..], 100.0, &[0][..]),
        (
            "nan weight in the middle",
            &[1.0, f64::NAN, 1.0][..],
            100.0,
            &[50, 0, 50][..],
        ),
        (
            "infinite weight loses the tie",
            &[f64::INFINITY, 1.0, 1.0][..],
            100.0,
            &[0, 50, 50][..],
        ),
    ];
    for &(name, weights, total, parts) in remainder {
        push_eq(
            &mut spec,
            name,
            distribute_exact(weights, total),
            parts.to_vec(),
        );
    }
    push_eq(
        &mut spec,
        "flex: 1 sugar",
        resolve_flex_item(&sugar_style(), 50),
        FlexItemInput {
            base: 0,
            min: 0,
            max: None,
            grow: 1,
            shrink: 1,
        },
    );
    let min_override = resolve_flex_item(
        &FlexItemStyle {
            min_main: Some(10),
            ..sugar_style()
        },
        50,
    );
    push_eq(
        &mut spec,
        "min main overrides sugar min",
        min_override.min,
        10,
    );
    push_eq(
        &mut spec,
        "min main overrides sugar basis",
        min_override.base,
        10,
    );
    let grown = resolve_flex_item(&sugar_style(), 0);
    push_eq(
        &mut spec,
        "sugar grow splits free space",
        flex_main_sizes(&[grown, grown], 10, 0),
        vec![5, 5],
    );
    let clip = FlexItemInput {
        base: 10,
        min: 0,
        max: None,
        grow: 0,
        shrink: 0,
    };
    push_eq(
        &mut spec,
        "overflow clip cuts from the last item",
        flex_main_sizes(&[clip, clip], 10, 0),
        vec![10, 0],
    );

    // layout/__tests__/frame.test.ts — row, column space_between, row flush.
    // Hit rects sit inside the viewport, so they equal these border boxes.
    let row = flex_child_rects(
        &FlexStyle {
            direction: FlexDirection::Row,
            gap: 1,
            ..FlexStyle::default()
        },
        &[
            box_wh(5, 1, None, "hello"),
            box_wh(5, 1, Some(FlexFactor::Sugar(1.0)), "world"),
        ],
        Rect {
            x: 0,
            y: 0,
            w: 20,
            h: 5,
        },
        None,
    );
    push_eq(&mut spec, "aW", row.first().map(|rect| rect.w), Some(5));
    push_eq(
        &mut spec,
        "frame row",
        row,
        vec![
            Rect {
                x: 0,
                y: 0,
                w: 5,
                h: 5,
            },
            Rect {
                x: 6,
                y: 0,
                w: 14,
                h: 5,
            },
        ],
    );

    let column = flex_child_rects(
        &FlexStyle {
            direction: FlexDirection::Column,
            justify_content: JustifyContent::SpaceBetween,
            width: Some(Length::Cells(10)),
            height: Some(Length::Cells(10)),
            ..FlexStyle::default()
        },
        &[box_wh(10, 2, None, "A"), box_wh(10, 2, None, "B")],
        Rect {
            x: 0,
            y: 0,
            w: 10,
            h: 10,
        },
        None,
    );
    push_eq(
        &mut spec,
        "topY",
        column.first().map(|rect| rect.y),
        Some(0),
    );
    push_eq(&mut spec, "botY", column.get(1).map(|rect| rect.y), Some(8));
    push_eq(
        &mut spec,
        "frame column",
        column,
        vec![
            Rect {
                x: 0,
                y: 0,
                w: 10,
                h: 2,
            },
            Rect {
                x: 0,
                y: 8,
                w: 10,
                h: 2,
            },
        ],
    );

    let flush = flex_child_rects(
        &FlexStyle {
            direction: FlexDirection::Row,
            justify_content: JustifyContent::SpaceBetween,
            gap: 0,
            ..FlexStyle::default()
        },
        &[
            box_wh(1, 1, None, "A"),
            box_wh(1, 1, None, "B"),
            box_wh(1, 1, None, "C"),
        ],
        Rect {
            x: 0,
            y: 0,
            w: 10,
            h: 1,
        },
        None,
    );
    push_eq(&mut spec, "aX", flush.first().map(|rect| rect.x), Some(0));
    push_eq(
        &mut spec,
        "lastEnd",
        flush.get(2).map(|rect| rect.x + rect.w),
        Some(10),
    );
    push_eq(
        &mut spec,
        "frame flush",
        flush,
        vec![
            Rect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
            Rect {
                x: 5,
                y: 0,
                w: 1,
                h: 1,
            },
            Rect {
                x: 9,
                y: 0,
                w: 1,
                h: 1,
            },
        ],
    );

    assert!(
        sum_failures.is_empty() && size_failures.is_empty() && spec.is_empty(),
        "sum={sum_failures:?}\n\nsize={size_failures:?}\n\n{}",
        spec.join("\n\n")
    );
}

#[test]
fn grid_tracks_stay_finite_and_measure() {
    let auto = resolve_column_tracks(
        &[Length::Auto, Length::Auto, Length::Auto],
        &[7, 6, 4],
        40,
        1,
        None,
    );
    let fr = resolve_column_tracks(&[Length::Auto, Length::Fr(1.0)], &[5, 3], 20, 1, None);
    let overflow = resolve_column_tracks(&[Length::Auto, Length::Auto], &[20, 20], 10, 1, None);
    assert_eq!(auto, vec![7, 6, 4]);
    assert_eq!(tracks_extent(&auto, 1), 19);
    assert_eq!(fr, vec![5, 14]);
    assert!(
        tracks_extent(&overflow, 1) <= 10 && overflow[0] + overflow[1] + 1 <= 10,
        "overflow fits {overflow:?}"
    );

    let empty_style = GridStyle::columns(vec![]);
    let empty_children = vec![text_ws("x", WhiteSpace::Nowrap)];
    let empty_cells = grid_cell_rects(
        &empty_style,
        &empty_children,
        Rect {
            x: 0,
            y: 0,
            w: 20,
            h: 10,
        },
        None,
    );
    assert_eq!(
        empty_cells,
        vec![CellRect {
            index: 0,
            row: 0,
            col: 0,
            cell: Rect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
            content: Rect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
        }]
    );
    let empty_measure = measure_node(
        &Node::Grid {
            style: empty_style,
            children: empty_children,
        },
        20,
        10,
        None,
    );
    assert!(empty_measure.w > 0 && empty_measure.h > 0);
    assert_eq!(empty_measure, Extent { w: 1, h: 1 });

    let table_style = GridStyle {
        columns: vec![Length::Auto, Length::Auto, Length::Auto],
        lines: GridLines::Inner,
        column_gap: Some(1),
        row_gap: Some(1),
        cell_pad: Some(CellPad::Axes {
            x: Some(1),
            y: None,
        }),
        ..GridStyle::columns(vec![])
    };
    let table_children = vec![
        text_ws("check", WhiteSpace::Nowrap),
        text_ws("status", WhiteSpace::Nowrap),
        text_ws("ms", WhiteSpace::Nowrap),
        text_ws("compile", WhiteSpace::Nowrap),
        text_ws("ok", WhiteSpace::Nowrap),
        text_ws("812", WhiteSpace::Nowrap),
        text_ws("test", WhiteSpace::Nowrap),
        text_ws("ok", WhiteSpace::Nowrap),
        text_ws("4021", WhiteSpace::Nowrap),
    ];
    let dims = measure_grid_dims(&table_style, &table_children, 80, None);
    assert_eq!(dims.col_widths, vec![9, 8, 6]);
    assert_eq!(dims.row_heights, vec![1, 1, 1]);
    assert_eq!((dims.total_w, dims.total_h), (25, 5));
    let cells = grid_cell_rects(
        &table_style,
        &table_children,
        Rect {
            x: 0,
            y: 0,
            w: 80,
            h: 40,
        },
        None,
    );
    assert_eq!(
        cells,
        vec![
            cell(0, 0, 0, 0, 0, 9, 1, 1, 0, 7, 1),
            cell(1, 0, 1, 10, 0, 8, 1, 11, 0, 6, 1),
            cell(2, 0, 2, 19, 0, 6, 1, 20, 0, 4, 1),
            cell(3, 1, 0, 0, 2, 9, 1, 1, 2, 7, 1),
            cell(4, 1, 1, 10, 2, 8, 1, 11, 2, 6, 1),
            cell(5, 1, 2, 19, 2, 6, 1, 20, 2, 4, 1),
            cell(6, 2, 0, 0, 4, 9, 1, 1, 4, 7, 1),
            cell(7, 2, 1, 10, 4, 8, 1, 11, 4, 6, 1),
            cell(8, 2, 2, 19, 4, 6, 1, 20, 4, 4, 1),
        ]
    );
    let table = measure_node(
        &Node::Grid {
            style: table_style,
            children: table_children,
        },
        80,
        40,
        None,
    );
    assert_eq!(table, Extent { w: 25, h: 5 });

    let mut fr_failures = Vec::new();
    for n in 1..=6 {
        for fr_w in [0.0, 1.0, 2.0, 5.0] {
            for container_w in [0i64, 1, 8, 19, 40, 80] {
                for gap in [0i64, 1, 3, 4] {
                    let tracks = vec![Length::Fr(fr_w); n];
                    let zeros = vec![0i64; n];
                    let widths = resolve_column_tracks(&tracks, &zeros, container_w, gap, None);
                    let extent = tracks_extent(&widths, gap);
                    let irreducible = gap * (n as i64 - 1).max(0);
                    let finite = widths.iter().all(|w| *w >= 0);
                    if widths.len() != n || !finite || extent > container_w.max(irreducible) {
                        push_fail(
                            &mut fr_failures,
                            format!("n={n} fr={fr_w} w={container_w} gap={gap} widths={widths:?}"),
                        );
                    }
                }
            }
        }
    }

    let kinds = [
        Length::Auto,
        Length::Cells(0),
        Length::Cells(12),
        Length::Cells(30),
        Length::Fr(0.0),
        Length::Fr(1.0),
        Length::Fr(5.0),
        Length::Pct(0.0),
        Length::Pct(50.0),
        Length::Pct(100.0),
        Length::Ch(0.0),
        Length::Ch(8.0),
        Length::Ch(20.0),
    ];
    let mut mixed_failures = Vec::new();
    for n in 1..=6 {
        for kind in kinds {
            let tracks = vec![kind; n];
            for min in [0i64, 3, 25] {
                for container_w in [0i64, 10, 80] {
                    for gap in [0i64, 1, 4] {
                        let mins = vec![min; n];
                        let widths = resolve_column_tracks(&tracks, &mins, container_w, gap, None);
                        if widths.iter().any(|w| *w < 0) {
                            push_fail(
                                &mut mixed_failures,
                                format!("n={n} kind={kind:?} min={min} w={container_w} gap={gap}"),
                            );
                        }
                    }
                }
            }
        }
    }
    let mixed_row = resolve_column_tracks(
        &[
            Length::Auto,
            Length::Fr(1.0),
            Length::Cells(10),
            Length::Pct(20.0),
            Length::Ch(4.0),
        ],
        &[5, 0, 3, 2, 1],
        40,
        1,
        None,
    );
    let mut spec = Vec::new();
    push_eq(&mut spec, "fr zero is fr", is_fr(Length::Fr(0.0)), true);
    push_eq(&mut spec, "auto is not fr", is_fr(Length::Auto), false);
    push_eq(
        &mut spec,
        "fr resolves auto",
        resolve_length(Some(Length::Fr(1.0)), 40).is_auto(),
        true,
    );
    push_eq(
        &mut spec,
        "pct 50 of 40",
        resolve_length(Some(Length::Pct(50.0)), 40).cells(),
        20,
    );
    push_eq(
        &mut spec,
        "negative cells resolve to zero",
        resolve_length(Some(Length::Cells(-3)), 40).cells(),
        0,
    );
    push_eq(
        &mut spec,
        "ch stays fractional until a track floors it",
        resolve_length(Some(Length::Ch(8.9)), 40),
        ResolvedLength::Cells(8.9),
    );
    push_eq(
        &mut spec,
        "ch track floors",
        resolve_column_tracks(&[Length::Ch(8.9)], &[0], 100, 0, None),
        vec![8],
    );
    push_eq(
        &mut spec,
        "pct track",
        resolve_column_tracks(&[Length::Pct(50.0)], &[0], 40, 0, None),
        vec![20],
    );
    push_eq(
        &mut spec,
        "negative fr weight is zero",
        resolve_column_tracks(&[Length::Fr(-1.0), Length::Fr(1.0)], &[0, 0], 10, 0, None),
        vec![0, 10],
    );
    push_eq(
        &mut spec,
        "no tracks",
        resolve_column_tracks(&[], &[], 10, 0, None),
        Vec::<i64>::new(),
    );
    push_eq(
        &mut spec,
        "negative uniform pad clamps to zero",
        cell_pad_xy(Some(CellPad::Uniform(-2))),
        (0, 0),
    );
    push_eq(
        &mut spec,
        "omitted pad axis is zero",
        cell_pad_xy(Some(CellPad::Axes {
            x: Some(1),
            y: None,
        })),
        (1, 0),
    );
    push_eq(
        &mut spec,
        "track offsets",
        track_offsets(&[2, 3], 1),
        vec![0, 3],
    );
    push_eq(&mut spec, "track extent", tracks_extent(&[2, 3], 1), 6);
    push_eq(
        &mut spec,
        "mixed row",
        mixed_row.clone(),
        vec![5, 10, 10, 7, 4],
    );
    assert!(
        fr_failures.is_empty()
            && mixed_failures.is_empty()
            && mixed_row.iter().all(|w| *w >= 0)
            && spec.is_empty(),
        "fr={fr_failures:?}\n\nmixed={mixed_failures:?}\n\nrow={mixed_row:?}\n\n{}",
        spec.join("\n\n")
    );
}

fn cell(
    index: usize,
    row: usize,
    col: usize,
    cx: i64,
    cy: i64,
    cw: i64,
    ch: i64,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
) -> CellRect {
    CellRect {
        index,
        row,
        col,
        cell: Rect {
            x: cx,
            y: cy,
            w: cw,
            h: ch,
        },
        content: Rect { x, y, w, h },
    }
}

#[test]
fn auto_columns_squeeze_wrap_slack_instead_of_crushing_the_longest_track() {
    let auto3 = [Length::Auto, Length::Auto, Length::Auto];
    let fits = resolve_column_tracks(&auto3, &[7, 6, 4], 40, 1, Some(&[3, 3, 3]));
    let squeezed = resolve_column_tracks(&auto3, &[24, 34, 50], 80, 1, Some(&[8, 8, 8]));
    let equal_overflow =
        resolve_column_tracks(&[Length::Auto, Length::Auto], &[20, 20], 10, 1, None);
    assert_eq!(fits, vec![7, 6, 4]);
    assert_eq!(tracks_extent(&squeezed, 1), 80);
    assert!(squeezed.iter().all(|w| *w >= 8), "{squeezed:?}");
    assert!(
        squeezed[0] <= 24 && squeezed[1] <= 34 && squeezed[2] <= 50,
        "{squeezed:?}"
    );
    assert!(
        squeezed[2] >= squeezed[0] && squeezed[2] >= squeezed[1],
        "{squeezed:?}"
    );
    assert_eq!(squeezed, vec![18, 25, 35]);
    assert_eq!(tracks_extent(&equal_overflow, 1), 10);
    assert!((equal_overflow[0] - equal_overflow[1]).abs() <= 1);
    assert!(equal_overflow[0] > 1 && equal_overflow[1] > 1);
    assert_eq!(equal_overflow, vec![4, 5]);

    let prose_style = GridStyle {
        columns: auto3.to_vec(),
        lines: GridLines::Inner,
        column_gap: Some(1),
        cell_pad: Some(CellPad::Axes {
            x: Some(1),
            y: None,
        }),
        ..GridStyle::columns(vec![])
    };
    let prose_children = [
        text_ws("Pi", WhiteSpace::PreWrap),
        text_ws("short ok", WhiteSpace::PreWrap),
        text_ws(
            "yes, omit when empty (Grok miss if cached)",
            WhiteSpace::PreWrap,
        ),
    ];
    let dims = measure_grid_dims(&prose_style, &prose_children, 40, None);
    let inner: Vec<i64> = dims.col_widths.iter().map(|w| w - dims.pad_x * 2).collect();
    assert!(dims.total_w <= 40, "{dims:?}");
    assert!(inner.iter().all(|w| *w > 1), "{inner:?}");
    assert!(inner[2] >= inner[0] && inner[2] >= inner[1], "{inner:?}");
    assert_eq!(dims.col_widths, vec![4, 8, 26]);
    assert_eq!(inner, vec![2, 6, 24]);
}
