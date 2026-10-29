//! Hit testing and selection against the TypeScript layout tests.
//!
//! Trees go through [`layout_hits`]. A hit key is whatever that walk records
//! at the cell, not a value copied from the expect.
//!
//! Sources: `layout/__tests__/hit.test.ts`, `layout/__tests__/chrome.test.ts`
//! (contain and selection), `layout/__tests__/frame.test.ts` (btn, backdrop,
//! overlay sibling, plaque, fold), `layout/__tests__/viewport-floor.test.ts`
//! (`elementAt` keys), `layout/__tests__/overflow-clip.test.ts` (y-hidden hit
//! and `visualCaretGeometry`), `layout/__tests__/selection.test.ts` (gesture
//! window, tolerance, confined drag, selection ranges, visual caret).
//!
//! BLOCKED — paint colors or the cell buffer. Assertion text is unchanged.
//!
//! layout/__tests__/frame.test.ts
//!   border.style: { role: "border", prominence: FgP.ghost }
//!   panelFill: { corner: 235, inner: 235 }
//!   gutter: { kind: "rule", role: "border", prominence: FgP.ghost, bold: false }
//!   body: { role: "foreground", prominence: FgP.secondary, x: 3 }
//!   clock: resolveLiveText / paintFrame ch0 / ch1 / waveMoved
//!   spinnerLive: { thinkingHz: 12, workingProfile: "working" }
//!   dim regionProminence and fillBg 236
//!   "quota remaining is painted from resetAt, not a frozen string"
//!   "expired quota percentages disappear until a fresh snapshot arrives"
//!   "elapsed live keeps a tenths place"
//!   "countdown live spells remaining seconds"
//!   "attuneTheme does not mutate ambient and guesses depth from env"
//!   "progress ease identity, snap, and picker skip"
//!
//! layout/__tests__/overflow-clip.test.ts
//!   cellCh(yBuf, 0, 0) === "A"
//!   cellCh(autoBuf, 0, 0) === "X"
//!   cellCh(bBuf, 0, 0) === "┌"
//!   cellCh(bBuf, 0, 1) === "│"
//!   topClip: ["bbbb", "cccc"]
//!
//! layout/__tests__/squeeze.test.ts
//!   tape === "X", peek === "P", voidCh === " ", voidHasBg === false,
//!   voidCast === "transparent", voidIsX === false
//!
//! layout/__tests__/viewport-floor.test.ts
//!   top: "PROMPT" (paintFrame)
//!   exact painted === "A0"
//!
//! layout/__tests__/flex-grid.test.ts
//!   sample: { role: "border", prominence: FgP.ghost, fg: undefined, dim: undefined }
//!   allRoleBorder: every line style is role "border" and prominence FgP.ghost
//!
//! Flex and grid phantoms (`${key}:flex`, grid phantom) are not emitted: the
//! committed frame does not store the container rect `pushHit` used.
//! `composerOffsetAtCell` / `parkComposerCaret` need a composer frame widget.
//! `highlight.test.ts` `lit()` and `serializeSelection` read the cell buffer.

use qd::layout_chrome::{ChromeFrame, ChromeSegSpec};
use qd::layout_engine::{BoxStyle, Overflow, OverflowAnchor, Sticky, Viewport};
use qd::layout_flex::{Length, Padding, Rect};
use qd::layout_hit::{
    clear_selection, contain_region_at, element_at, element_at_path, expand_to_line_at,
    expand_to_word_at, extend_selection, has_copyable_extent, is_collapsed, layout_hits,
    move_visual_draft, row_range, selection_rect, start_selection, stream_endpoints,
    visual_caret_geometry, visual_draft_lines, visual_line_index, word_bounds_on_row, Cell, Click,
    EdgeScroll, ElementKind, GestureEvent, GestureKind, GestureMachine, Granularity, Hit, HitExtra,
    HitFrame, HitNode, Intent, UserSelect, VisualCaret, VisualMotion,
};

fn vp(w: i64, h: i64) -> Viewport {
    Viewport { w, h }
}

fn lay(root: &HitNode, w: i64, h: i64) -> HitFrame {
    layout_hits(root, vp(w, h))
}

fn select(user_select: UserSelect) -> HitExtra {
    HitExtra::select(user_select)
}

fn sized(key: &str, w: i64, h: i64, extra: HitExtra, children: Vec<HitNode>) -> HitNode {
    HitNode::Box {
        key: Some(key.to_string()),
        id: None,
        style: BoxStyle {
            width: Some(Length::Cells(w)),
            height: Some(Length::Cells(h)),
            ..BoxStyle::default()
        },
        extra,
        measured: None,
        children,
    }
}

fn plain_box(key: &str, extra: HitExtra, style: BoxStyle, children: Vec<HitNode>) -> HitNode {
    HitNode::Box {
        key: Some(key.to_string()),
        id: None,
        style,
        extra,
        measured: None,
        children,
    }
}

fn text_node(key: &str, content: &str) -> HitNode {
    HitNode::Text {
        content: content.to_string(),
        key: Some(key.to_string()),
        white_space: None,
        ellipsis: None,
        line_clamp: None,
        measured: None,
        extra: HitExtra::default(),
    }
}

fn chrome(key: &str, frame: ChromeFrame, body_user_select: Option<UserSelect>) -> HitNode {
    HitNode::Chrome {
        key: key.to_string(),
        frame,
        body_user_select,
        inert: false,
    }
}

fn keys_at(
    root: &HitNode,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
) -> (
    Option<String>,
    Option<UserSelect>,
    Option<Vec<String>>,
    bool,
) {
    let frame = lay(root, w, h);
    let at = element_at(&frame, x, y);
    let path = element_at_path(&frame, x, y)
        .map(|hits| hits.iter().map(Hit::key).map(str::to_string).collect());
    let hittable = at.is_some_and(|hit| frame.hit_listed(hit.key()));
    (
        at.map(|hit| hit.key().to_string()),
        at.map(Hit::user_select),
        path,
        hittable,
    )
}

fn hit_key(frame: &HitFrame, x: i64, y: i64) -> String {
    let Some(hit) = element_at(frame, x, y) else {
        let listed: Vec<String> = frame
            .hit_list()
            .iter()
            .map(|hit| {
                let rect = hit.rect();
                format!("{}@{},{} {}x{}", hit.key(), rect.x, rect.y, rect.w, rect.h)
            })
            .collect();
        panic!("no hit at {x},{y}; list={listed:?}");
    };
    hit.key().to_string()
}

fn rect_of(frame: &HitFrame, key: &str) -> Rect {
    frame
        .get(key)
        .unwrap_or_else(|| panic!("missing {key}"))
        .rect()
}

fn scrolling_column(scroll: i64, children: Vec<HitNode>, h: i64) -> HitFrame {
    lay(
        &HitNode::Viewport {
            id: "vp".to_string(),
            key: Some("vp".to_string()),
            anchor: OverflowAnchor::None,
            scroll,
            children: vec![plain_box(
                "col",
                select(UserSelect::Text),
                BoxStyle::default(),
                children,
            )],
        },
        12,
        h,
    )
}

fn row(key: &str, content: &str) -> HitNode {
    text_node(key, content)
}

fn turn_prompt(key: &str, lines: &[&str]) -> HitNode {
    plain_box(
        key,
        HitExtra::default(),
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

fn body(prefix: &str, n: i64) -> Vec<HitNode> {
    (0..n)
        .map(|i| row(&format!("{prefix}{i}"), &format!("{prefix}{i}")))
        .collect()
}

fn cell(col: i64, row: i64) -> Cell {
    Cell { col, row }
}

fn press_at(col: i64, row: i64, t_ms: i64) -> GestureEvent {
    GestureEvent::at(GestureKind::Press, col, row, t_ms)
}

fn drag_at(col: i64, row: i64, t_ms: i64) -> GestureEvent {
    GestureEvent::at(GestureKind::Drag, col, row, t_ms)
}

fn release_at(col: i64, row: i64, t_ms: i64) -> GestureEvent {
    GestureEvent::at(GestureKind::Release, col, row, t_ms)
}

fn miss<T, U>(failures: &mut Vec<String>, row: &str, got: T, want: U)
where
    T: PartialEq<U> + std::fmt::Debug,
    U: std::fmt::Debug,
{
    if got != want {
        failures.push(format!("{row}\n  got: {got:?}\n  want: {want:?}"));
    }
}

#[derive(Debug, PartialEq)]
enum GestureFact {
    None,
    Released {
        output_none: bool,
        copy_ready: Option<bool>,
        machine_none: bool,
    },
    Copied {
        anchor: Cell,
        active: Cell,
        copy_ready: Option<bool>,
    },
    Grain {
        granularity: Granularity,
        anchor: Cell,
        active: Cell,
    },
    GrainOnly(Granularity),
    Ends {
        anchor: Cell,
        active: Cell,
    },
    Contain {
        contain: Option<Rect>,
        anchor: Cell,
        active: Cell,
    },
    Free {
        contain_none: bool,
        active: Cell,
    },
    Active(Cell),
    Scroll(Option<EdgeScroll>),
    CopyReady(Option<bool>),
}

fn absent(selection: Option<qd::layout_hit::Selection>) -> GestureFact {
    match selection {
        None => GestureFact::None,
        Some(sel) => GestureFact::Grain {
            granularity: sel.granularity,
            anchor: sel.anchor,
            active: sel.active,
        },
    }
}

#[test]
fn user_select_gate_and_ancestor_chain() {
    let none = lay(
        &sized("chrome", 20, 3, select(UserSelect::None), vec![]),
        20,
        10,
    );
    assert!(none.hit_list().is_empty());
    assert!(element_at(&none, 5, 1).is_none());
    assert!(element_at_path(&none, 5, 1).is_none());

    assert_eq!(
        keys_at(
            &sized("body", 20, 3, select(UserSelect::Text), vec![]),
            5,
            1,
            20,
            10
        ),
        (
            Some("body".to_string()),
            Some(UserSelect::Text),
            Some(vec!["body".to_string()]),
            true
        )
    );
    assert_eq!(
        keys_at(
            &sized("block", 20, 3, select(UserSelect::All), vec![]),
            5,
            1,
            20,
            10
        ),
        (
            Some("block".to_string()),
            Some(UserSelect::All),
            Some(vec!["block".to_string()]),
            true
        )
    );
    assert_eq!(
        keys_at(
            &sized("composer", 20, 3, select(UserSelect::Contain), vec![]),
            5,
            1,
            20,
            10
        ),
        (
            Some("composer".to_string()),
            Some(UserSelect::Contain),
            Some(vec!["composer".to_string()]),
            true
        )
    );

    let chrome_frame = lay(
        &chrome("composer", ChromeFrame::new(20, "hello"), None),
        20,
        10,
    );
    assert_eq!(
        chrome_frame
            .get("composer")
            .expect("composer")
            .user_select(),
        UserSelect::Contain
    );

    let inherited = lay(
        &sized(
            "outer",
            20,
            5,
            HitExtra::default(),
            vec![sized("inner", 10, 2, HitExtra::default(), vec![])],
        ),
        20,
        10,
    );
    assert_eq!(
        inherited.get("inner").expect("inner").user_select(),
        UserSelect::Auto
    );

    let none_parent = lay(
        &sized(
            "chrome",
            20,
            5,
            select(UserSelect::None),
            vec![sized("chrome-child", 10, 2, HitExtra::default(), vec![])],
        ),
        20,
        10,
    );
    assert_eq!(
        none_parent
            .get("chrome-child")
            .expect("child")
            .user_select(),
        UserSelect::None
    );

    let override_frame = lay(
        &sized(
            "mixed",
            20,
            5,
            select(UserSelect::None),
            vec![sized(
                "selectable-child",
                10,
                2,
                select(UserSelect::Text),
                vec![],
            )],
        ),
        20,
        10,
    );
    assert_eq!(
        override_frame
            .get("selectable-child")
            .expect("child")
            .user_select(),
        UserSelect::Text
    );
    assert!(override_frame.hit_listed("selectable-child"));
    assert_eq!(
        element_at(&override_frame, 1, 1).expect("child").key(),
        "selectable-child"
    );

    let nested = sized(
        "outer",
        30,
        8,
        select(UserSelect::Text),
        vec![sized(
            "inner-a",
            20,
            4,
            select(UserSelect::Text),
            vec![HitNode::Raw {
                key: Some("leaf".to_string()),
                w: 10,
                h: 2,
                extra: HitExtra {
                    intent: Some(Intent::None),
                    ..HitExtra::default()
                },
            }],
        )],
    );
    assert_eq!(
        keys_at(&nested, 2, 1, 30, 12),
        (
            Some("leaf".to_string()),
            Some(UserSelect::Text),
            Some(vec![
                "outer".to_string(),
                "inner-a".to_string(),
                "leaf".to_string()
            ]),
            true
        )
    );
    assert_eq!(
        keys_at(
            &sized("chrome-only", 30, 6, select(UserSelect::None), vec![]),
            5,
            1,
            30,
            12
        ),
        (None, None, None, false)
    );

    let overlay = sized(
        "outer",
        30,
        8,
        select(UserSelect::Text),
        vec![
            sized("base", 20, 4, select(UserSelect::Text), vec![]),
            HitNode::Overlay {
                key: Some("ovl".to_string()),
                center: false,
                origin: None,
                backdrop: true,
                backdrop_style: None,
                extra: HitExtra::default(),
                children: vec![sized("modal", 6, 2, select(UserSelect::Text), vec![])],
            },
        ],
    );
    assert_eq!(
        keys_at(&overlay, 25, 6, 30, 12),
        (
            Some("ovl:backdrop".to_string()),
            Some(UserSelect::Auto),
            Some(vec!["outer".to_string(), "ovl:backdrop".to_string()]),
            true
        )
    );

    let chrome_outer = sized(
        "chrome-outer",
        30,
        6,
        select(UserSelect::None),
        vec![sized("content", 10, 3, select(UserSelect::Text), vec![])],
    );
    assert_eq!(
        keys_at(&chrome_outer, 1, 1, 30, 12).2,
        Some(vec!["content".to_string()])
    );

    let structural = sized(
        "block",
        30,
        6,
        select(UserSelect::All),
        vec![sized("cell", 10, 3, select(UserSelect::Text), vec![])],
    );
    assert_eq!(
        keys_at(&structural, 1, 1, 30, 12).2,
        Some(vec!["block".to_string(), "cell".to_string()])
    );
}

#[test]
fn chrome_body_contain_clamps_selection_and_line_expand() {
    let composer = lay(
        &chrome("composer", ChromeFrame::new(30, "hello\nworld"), None),
        40,
        10,
    );
    let body = composer.get("composer").expect("composer");
    let body_rect = body.rect();
    assert_eq!(body.user_select(), UserSelect::Contain);
    assert_eq!(
        body_rect,
        Rect {
            x: 3,
            y: 1,
            w: 26,
            h: 2
        }
    );
    assert_eq!(
        contain_region_at(&composer, body_rect.x + 1, body_rect.y).expect("inside"),
        qd::layout_hit::ContainRegion {
            key: "composer".to_string(),
            rect: body_rect
        }
    );
    assert!(contain_region_at(&composer, 0, body_rect.y).is_none());
    assert!(contain_region_at(&composer, 29, body_rect.y).is_none());
    assert!(contain_region_at(&composer, 2, body_rect.y).is_none());

    let empty = lay(&chrome("composer", ChromeFrame::new(30, ""), None), 40, 10);
    let empty_body = empty.get("composer").expect("empty");
    assert_eq!(empty_body.user_select(), UserSelect::Contain);
    assert_eq!(
        contain_region_at(&empty, empty_body.rect().x + 1, empty_body.rect().y)
            .expect("empty region")
            .key,
        "composer"
    );

    let placeholder = lay(
        &chrome(
            "composer",
            ChromeFrame {
                placeholder: Some("type here".to_string()),
                ..ChromeFrame::new(30, "")
            },
            None,
        ),
        40,
        10,
    );
    let ph = placeholder.get("composer").expect("placeholder");
    assert_eq!(ph.user_select(), UserSelect::None);
    assert!(contain_region_at(&placeholder, ph.rect().x + 1, ph.rect().y).is_none());

    let outside = lay(
        &sized("outside", 20, 5, select(UserSelect::Text), vec![]),
        20,
        5,
    );
    assert!(contain_region_at(&outside, 5, 2).is_none());

    let contain_box = Rect {
        x: 10,
        y: 5,
        w: 20,
        h: 3,
    };
    let contained = extend_selection(
        Some(start_selection(
            cell(12, 5),
            Granularity::Char,
            Some("composer".to_string()),
            Some(contain_box),
        )),
        cell(50, 20),
    )
    .expect("clamp");
    assert_eq!(contained.active, cell(29, 7));
    assert_eq!(row_range(&contained, 6, 80), Some((10, 29)));
    assert_eq!(row_range(&contained, 0, 80), None);
    assert_eq!(row_range(&contained, 10, 80), None);

    let line = expand_to_line_at(
        cell(15, 6),
        80,
        Some("composer".to_string()),
        Some(contain_box),
    );
    assert_eq!(line.anchor, cell(10, 6));
    assert_eq!(line.active, cell(29, 6));
    assert_eq!(line.contain, Some(contain_box));
    assert_eq!(row_range(&line, 6, 80), Some((10, 29)));

    let listed = lay(
        &chrome(
            "list",
            ChromeFrame {
                body_seg_rows: vec![vec![ChromeSegSpec::plain("/connect")]],
                ..ChromeFrame::new(20, "")
            },
            Some(UserSelect::None),
        ),
        20,
        10,
    );
    assert_eq!(
        listed.get("list").expect("body").user_select(),
        UserSelect::None
    );
    assert_eq!(
        listed.get("list:chrome").expect("chrome").user_select(),
        UserSelect::None
    );
}

#[test]
fn button_backdrop_overlay_sibling_plaque_and_fold() {
    let btn = lay(
        &sized(
            "btn",
            10,
            3,
            HitExtra {
                intent: Some(Intent::Activate),
                click: Some(Click::Press),
                ..HitExtra::default()
            },
            vec![HitNode::Text {
                content: "OK".to_string(),
                key: None,
                white_space: None,
                ellipsis: None,
                line_clamp: None,
                measured: None,
                extra: HitExtra::default(),
            }],
        ),
        20,
        10,
    );
    let hit = element_at(&btn, 1, 1).expect("btn");
    assert_eq!(hit.key(), "btn");
    assert_eq!(hit.intent(), Intent::Activate);

    let dim = lay(
        &HitNode::Box {
            key: None,
            id: None,
            style: BoxStyle::default(),
            extra: HitExtra::default(),
            measured: None,
            children: vec![
                text_node("base", "behind"),
                HitNode::Overlay {
                    key: Some("ovl".to_string()),
                    center: false,
                    origin: None,
                    backdrop: true,
                    backdrop_style: None,
                    extra: HitExtra::default(),
                    children: vec![text_node("modal-body", "modal")],
                },
            ],
        },
        20,
        5,
    );
    assert!(dim.get("ovl:backdrop").is_some());

    let overlay = lay(
        &sized(
            "stage",
            40,
            12,
            HitExtra::default(),
            vec![
                sized(
                    "under",
                    40,
                    12,
                    HitExtra::default(),
                    vec![HitNode::Text {
                        content: "under".to_string(),
                        key: None,
                        white_space: None,
                        ellipsis: None,
                        line_clamp: None,
                        measured: None,
                        extra: HitExtra::default(),
                    }],
                ),
                HitNode::Overlay {
                    key: Some("ovl".to_string()),
                    center: true,
                    origin: None,
                    backdrop: true,
                    backdrop_style: None,
                    extra: HitExtra::default(),
                    children: vec![plain_box(
                        "pick",
                        HitExtra {
                            intent: Some(Intent::Activate),
                            ..HitExtra::default()
                        },
                        BoxStyle {
                            border: true,
                            width: Some(Length::Cells(14)),
                            height: Some(Length::Cells(4)),
                            ..BoxStyle::default()
                        },
                        vec![text_node("pick-body", "Select an LLM")],
                    )],
                },
            ],
        ),
        40,
        12,
    );
    let pick = rect_of(&overlay, "pick");
    assert_eq!(pick.h, 4);
    assert_eq!(hit_key(&overlay, pick.x + 1, pick.y + 1), "pick");

    let plaque = lay(
        &sized(
            "stage",
            20,
            10,
            HitExtra::default(),
            vec![HitNode::Overlay {
                key: Some("ovl".to_string()),
                center: false,
                origin: Some(qd::layout_engine::Origin { x: 5, y: 3 }),
                backdrop: false,
                backdrop_style: None,
                extra: HitExtra::default(),
                children: vec![sized(
                    "plaque",
                    4,
                    2,
                    HitExtra::default(),
                    vec![HitNode::Text {
                        content: "hi".to_string(),
                        key: None,
                        white_space: None,
                        ellipsis: None,
                        line_clamp: None,
                        measured: None,
                        extra: HitExtra::default(),
                    }],
                )],
            }],
        ),
        20,
        10,
    );
    assert_eq!(
        rect_of(&plaque, "plaque"),
        Rect {
            x: 5,
            y: 3,
            w: 4,
            h: 2
        }
    );

    let collapsed = lay(
        &HitNode::Disclosure {
            key: Some("d".to_string()),
            collapsed: true,
            extra: HitExtra {
                intent: Some(Intent::Activate),
                click: Some(Click::ToggleCollapsed {
                    block_id: "d".to_string(),
                }),
                ..HitExtra::default()
            },
            summary: Box::new(text_node("s", "sum")),
            children: vec![text_node("b1", "hidden"), text_node("b2", "body")],
        },
        40,
        8,
    );
    assert!(collapsed.hit_listed("d"));
    assert_eq!(
        collapsed.get("d").expect("fold").click(),
        Some(&Click::ToggleCollapsed {
            block_id: "d".to_string()
        })
    );
}

#[test]
fn sticky_top_element_at_follows_the_pin() {
    let prompt = plain_box(
        "prompt",
        HitExtra::default(),
        BoxStyle {
            sticky: Some(Sticky::Top),
            ..BoxStyle::default()
        },
        vec![row("q", "PROMPT")],
    );
    let mut children = body("a", 4);
    children.push(prompt);
    children.push(row("after", "AFTER"));
    children.extend(body("b", 4));
    let pinned = scrolling_column(5, children.clone(), 5);
    let in_flow = scrolling_column(2, children, 5);
    assert_eq!(hit_key(&in_flow, 0, 0), "a2");
    assert_eq!(hit_key(&pinned, 0, 0), "q");
    assert_eq!(rect_of(&pinned, "q").y, 0);

    let mut turns = vec![turn_prompt("A", &["A0", "A1", "A2"])];
    turns.extend(body("a", 8));
    turns.push(turn_prompt("B", &["B0", "B1"]));
    turns.extend(body("b", 6));
    let just = scrolling_column(1, turns.clone(), 5);
    let riding = scrolling_column(2, turns.clone(), 5);
    let arriving = scrolling_column(8, turns.clone(), 5);
    let taken = scrolling_column(9, turns, 5);
    assert_eq!(hit_key(&just, 0, 0), "A0");
    assert_eq!(rect_of(&just, "A0").y, 0);
    assert_eq!(hit_key(&riding, 0, 0), "A0");
    assert_eq!(hit_key(&riding, 0, 3), "a2");
    assert_eq!(hit_key(&arriving, 0, 0), "A0");
    assert_eq!(hit_key(&taken, 0, 0), "a6");

    let mut tall = vec![turn_prompt(
        "A",
        &["A0", "A1", "A2", "A3", "A4", "A5", "A6"],
    )];
    tall.extend(body("a", 10));
    tall.push(turn_prompt("B", &["B0"]));
    let past_end = scrolling_column(8, tall.clone(), 5);
    let mid_turn = scrolling_column(4, tall, 5);
    assert_eq!(hit_key(&past_end, 0, 0), "A0");
    assert_eq!(rect_of(&past_end, "a1").y, 0);
    assert_eq!(hit_key(&past_end, 0, 1), "a2");
    assert_eq!(hit_key(&mid_turn, 0, 0), "A4");
    assert_eq!(hit_key(&mid_turn, 0, 1), "A5");

    let mut fits = vec![turn_prompt("A", &["A0", "A1"])];
    fits.extend(body("a", 10));
    fits.push(turn_prompt("B", &["B0"]));
    let fits_frame = scrolling_column(4, fits, 5);
    assert_eq!(hit_key(&fits_frame, 0, 0), "A0");
    assert_eq!(rect_of(&fits_frame, "a3").y, 1);

    let mut exact = vec![turn_prompt("A", &["A0", "A1", "A2", "A3", "A4"])];
    exact.extend(body("a", 6));
    let exact_frame = scrolling_column(5, exact, 5);
    assert_eq!(hit_key(&exact_frame, 0, 0), "A0");
    assert_eq!(hit_key(&exact_frame, 0, 1), "a1");
    assert_eq!(rect_of(&exact_frame, "a0").y, 0);
}

#[test]
fn overflow_y_hidden_misses_the_clipped_line_and_caret_parks_on_newline() {
    let y_hidden = lay(
        &plain_box(
            "tight",
            HitExtra::default(),
            BoxStyle {
                height: Some(Length::Cells(1)),
                overflow_y: Some(Overflow::Hidden),
                ..BoxStyle::default()
            },
            vec![text_node("t", "AAAA\nBBBB")],
        ),
        8,
        1,
    );
    assert!(!element_at(&y_hidden, 0, 5).is_some_and(|hit| hit.kind() == ElementKind::Text));
    let text = y_hidden.get("t").expect("clipped text");
    assert_eq!(text.kind(), ElementKind::Text);
    let rect = text.rect();
    assert!(rect.y + rect.h <= 1);
    assert!(!(rect.x <= 0 && 0 < rect.x + rect.w && rect.y <= 5 && 5 < rect.y + rect.h));

    assert_eq!(
        visual_caret_geometry("ab\n", 2, 40),
        VisualCaret {
            line: 0,
            col_in_content: 2,
            total_lines: 2
        }
    );
    assert_eq!(
        visual_caret_geometry("ab\ncd", 2, 40),
        VisualCaret {
            line: 0,
            col_in_content: 2,
            total_lines: 2
        }
    );
    assert_eq!(
        visual_caret_geometry("ab\n", 3, 40),
        VisualCaret {
            line: 1,
            col_in_content: 0,
            total_lines: 2
        }
    );
}

#[test]
fn gesture_window_tolerance_and_confined_composer_drag() {
    let hello: Vec<String> = ["h", "e", "l", "l", "o"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let mut windowed = GestureMachine::new().row_cells(move |_| Some(hello.clone()));
    windowed.handle(press_at(2, 0, 0));
    windowed.handle(press_at(2, 0, 0));
    let mut rows = Vec::new();
    rows.push((
        "double-click word",
        GestureFact::GrainOnly(windowed.selection().expect("word").granularity),
    ));
    rows.push((
        "click after the window",
        absent(windowed.handle(press_at(2, 0, 1000)).selection),
    ));

    let mut no_cells = GestureMachine::new();
    no_cells.handle(press_at(5, 3, 0));
    rows.push((
        "double-click without cells",
        absent(no_cells.handle(press_at(5, 3, 0)).selection),
    ));

    let wide: Vec<String> = ["h", "e", "l", "l", "o", " "]
        .into_iter()
        .map(str::to_string)
        .chain(std::iter::repeat_n("x".to_string(), 16))
        .collect();
    let mut tolerate = GestureMachine::new().row_cells(move |_| Some(wide.clone()));
    tolerate.handle(press_at(2, 0, 0));
    tolerate.handle(press_at(2, 0, 0));
    let reset = tolerate
        .handle(drag_at(20, 0, 0))
        .selection
        .expect("char drag");
    rows.push((
        "drag resets a word to char",
        GestureFact::Grain {
            granularity: reset.granularity,
            anchor: reset.anchor,
            active: reset.active,
        },
    ));

    let mut back = GestureMachine::new();
    back.handle(press_at(8, 4, 0));
    let backward = back.handle(drag_at(2, 1, 0)).selection.expect("back");
    rows.push((
        "backward drag",
        GestureFact::Ends {
            anchor: backward.anchor,
            active: backward.active,
        },
    ));

    let frame = lay(
        &chrome("composer", ChromeFrame::new(30, "aaa\nbbb\nccc"), None),
        40,
        10,
    );
    let body = rect_of(&frame, "composer");
    let probe = frame.clone();
    let mut confined =
        GestureMachine::new().contain_at(move |cell| contain_region_at(&probe, cell.col, cell.row));
    confined.handle(press_at(body.x + 2, body.y, 0));
    let clamped = confined
        .handle(drag_at(50, 20, 0))
        .selection
        .expect("contain");
    rows.push((
        "confined drag",
        GestureFact::Contain {
            contain: clamped.contain,
            anchor: clamped.anchor,
            active: clamped.active,
        },
    ));

    let probe = frame.clone();
    let mut outside =
        GestureMachine::new().contain_at(move |cell| contain_region_at(&probe, cell.col, cell.row));
    outside.handle(press_at(0, 0, 0));
    let free = outside.handle(drag_at(40, 8, 0)).selection.expect("free");
    rows.push((
        "press outside the frame",
        GestureFact::Free {
            contain_none: free.contain.is_none(),
            active: free.active,
        },
    ));

    let narrow = lay(
        &chrome("composer", ChromeFrame::new(12, "abcdefgh"), None),
        20,
        6,
    );
    let machine = || {
        let probe = narrow.clone();
        GestureMachine::new().contain_at(move |cell| contain_region_at(&probe, cell.col, cell.row))
    };
    let mut anchor_col = machine();
    anchor_col.handle(press_at(5, 1, 0));
    anchor_col.handle(drag_at(8, 1, 0));
    let off = anchor_col
        .handle(drag_at(5, 4, 0))
        .selection
        .expect("off anchor");
    rows.push((
        "drag leaves the anchor row",
        GestureFact::Active(off.active),
    ));
    let released = anchor_col.handle(release_at(5, 4, 0));
    let released = released.selection.expect("release");
    rows.push((
        "release stays on the anchor row",
        GestureFact::Ends {
            anchor: released.anchor,
            active: released.active,
        },
    ));

    let mut past_edge = machine();
    past_edge.handle(press_at(5, 1, 0));
    past_edge.handle(drag_at(8, 1, 0));
    let far = past_edge.handle(drag_at(40, 4, 0)).selection.expect("edge");
    rows.push((
        "drag past the body edge",
        GestureFact::Ends {
            anchor: far.anchor,
            active: far.active,
        },
    ));

    let mut click = GestureMachine::new();
    rows.push(("press", absent(click.handle(press_at(5, 3, 0)).selection)));
    let mut tap = GestureMachine::new();
    tap.handle(press_at(5, 3, 0));
    let same = tap.handle(release_at(5, 3, 0));
    rows.push((
        "click release",
        GestureFact::Released {
            output_none: same.selection.is_none(),
            copy_ready: same.copy_ready,
            machine_none: tap.selection().is_none(),
        },
    ));
    let mut zero = GestureMachine::new();
    zero.handle(press_at(2, 1, 0));
    rows.push((
        "drag in place",
        absent(zero.handle(drag_at(2, 1, 0)).selection),
    ));

    let mut dismiss = GestureMachine::new();
    dismiss.handle(press_at(2, 1, 0));
    dismiss.handle(drag_at(8, 4, 0));
    let dragged = dismiss.handle(release_at(8, 4, 0));
    let sel = dragged.selection.expect("drag");
    rows.push((
        "drag release",
        GestureFact::Copied {
            anchor: sel.anchor,
            active: sel.active,
            copy_ready: dragged.copy_ready,
        },
    ));
    rows.push((
        "press elsewhere",
        absent(dismiss.handle(press_at(15, 7, 0)).selection),
    ));
    rows.push((
        "release elsewhere",
        absent(dismiss.handle(release_at(15, 7, 0)).selection),
    ));

    let mut origin = GestureMachine::new();
    origin.handle(press_at(2, 1, 0));
    let origin_drag = origin.handle(drag_at(8, 4, 0)).selection.expect("origin");
    rows.push((
        "drag from the press",
        GestureFact::Grain {
            granularity: origin_drag.granularity,
            anchor: origin_drag.anchor,
            active: origin_drag.active,
        },
    ));

    let word_row: Vec<String> = ["a", " ", "h", "e", "l", "l", "o", " ", "z"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let mut word =
        GestureMachine::new().row_cells(
            move |r| {
                if r == 3 {
                    Some(word_row.clone())
                } else {
                    None
                }
            },
        );
    word.handle(press_at(5, 3, 0));
    rows.push(("first press on a word", absent(word.selection())));
    let snapped = word.handle(press_at(5, 3, 0)).selection.expect("word");
    rows.push((
        "second press snaps the word",
        GestureFact::Grain {
            granularity: snapped.granularity,
            anchor: snapped.anchor,
            active: snapped.active,
        },
    ));
    rows.push((
        "word release copies",
        GestureFact::CopyReady(word.handle(release_at(5, 3, 0)).copy_ready),
    ));

    let mut triple = GestureMachine::new().viewport(Some(20), None);
    triple.handle(press_at(5, 3, 0));
    triple.handle(press_at(5, 3, 0));
    let line = triple.handle(press_at(5, 3, 0)).selection.expect("line");
    rows.push((
        "triple press selects the line",
        GestureFact::Grain {
            granularity: line.granularity,
            anchor: line.anchor,
            active: line.active,
        },
    ));

    let mut alt = GestureMachine::new();
    let mut ev = press_at(2, 1, 0);
    ev.alt = true;
    alt.handle(ev);
    rows.push(("alt press", absent(alt.selection())));
    let block = alt.handle(drag_at(8, 4, 0)).selection.expect("rect");
    rows.push((
        "alt drag is a rect",
        GestureFact::Grain {
            granularity: block.granularity,
            anchor: block.anchor,
            active: block.active,
        },
    ));

    let mut shift = GestureMachine::new();
    shift.handle(press_at(2, 1, 0));
    shift.handle(drag_at(5, 3, 0));
    shift.handle(release_at(5, 3, 0));
    let mut extend = press_at(10, 6, 0);
    extend.shift = true;
    let shifted = shift.handle(extend).selection.expect("shift");
    rows.push((
        "shift extends",
        GestureFact::Ends {
            anchor: shifted.anchor,
            active: shifted.active,
        },
    ));

    let mut edge = GestureMachine::new().viewport(None, Some(10));
    edge.handle(press_at(5, 8, 0));
    rows.push((
        "drag below the viewport",
        GestureFact::Scroll(edge.handle(drag_at(5, 12, 0)).scroll),
    ));
    let mut up = GestureMachine::new().viewport(None, Some(10));
    up.handle(press_at(5, 2, 0));
    rows.push((
        "drag above the viewport",
        GestureFact::Scroll(up.handle(drag_at(5, -2, 0)).scroll),
    ));
    let mut inside = GestureMachine::new().viewport(None, Some(10));
    inside.handle(press_at(5, 3, 0));
    rows.push((
        "drag inside the viewport",
        GestureFact::Scroll(inside.handle(drag_at(5, 7, 0)).scroll),
    ));

    let mut cleared = GestureMachine::new();
    cleared.handle(press_at(5, 3, 0));
    cleared.handle(drag_at(8, 4, 0));
    rows.push(("clear", absent(cleared.clear())));

    assert_eq!(
        rows,
        vec![
            (
                "double-click word",
                GestureFact::GrainOnly(Granularity::Word)
            ),
            ("click after the window", GestureFact::None),
            ("double-click without cells", GestureFact::None),
            (
                "drag resets a word to char",
                GestureFact::Grain {
                    granularity: Granularity::Char,
                    anchor: cell(2, 0),
                    active: cell(20, 0),
                },
            ),
            (
                "backward drag",
                GestureFact::Ends {
                    anchor: cell(8, 4),
                    active: cell(2, 1),
                },
            ),
            (
                "confined drag",
                GestureFact::Contain {
                    contain: Some(body),
                    anchor: cell(body.x + 2, body.y),
                    active: cell(body.x + body.w - 1, body.y + body.h - 1),
                },
            ),
            (
                "press outside the frame",
                GestureFact::Free {
                    contain_none: true,
                    active: cell(40, 8),
                },
            ),
            (
                "drag leaves the anchor row",
                GestureFact::Active(cell(8, 1)),
            ),
            (
                "release stays on the anchor row",
                GestureFact::Ends {
                    anchor: cell(5, 1),
                    active: cell(8, 1),
                },
            ),
            (
                "drag past the body edge",
                GestureFact::Ends {
                    anchor: cell(5, 1),
                    active: cell(10, 1),
                },
            ),
            ("press", GestureFact::None),
            (
                "click release",
                GestureFact::Released {
                    output_none: true,
                    copy_ready: Some(false),
                    machine_none: true,
                },
            ),
            ("drag in place", GestureFact::None),
            (
                "drag release",
                GestureFact::Copied {
                    anchor: cell(2, 1),
                    active: cell(8, 4),
                    copy_ready: Some(true),
                },
            ),
            ("press elsewhere", GestureFact::None),
            ("release elsewhere", GestureFact::None),
            (
                "drag from the press",
                GestureFact::Grain {
                    granularity: Granularity::Char,
                    anchor: cell(2, 1),
                    active: cell(8, 4),
                },
            ),
            ("first press on a word", GestureFact::None),
            (
                "second press snaps the word",
                GestureFact::Grain {
                    granularity: Granularity::Word,
                    anchor: cell(2, 3),
                    active: cell(6, 3),
                },
            ),
            ("word release copies", GestureFact::CopyReady(Some(true)),),
            (
                "triple press selects the line",
                GestureFact::Grain {
                    granularity: Granularity::Line,
                    anchor: cell(0, 3),
                    active: cell(19, 3),
                },
            ),
            ("alt press", GestureFact::None),
            (
                "alt drag is a rect",
                GestureFact::Grain {
                    granularity: Granularity::Rect,
                    anchor: cell(2, 1),
                    active: cell(8, 4),
                },
            ),
            (
                "shift extends",
                GestureFact::Ends {
                    anchor: cell(2, 1),
                    active: cell(10, 6),
                },
            ),
            (
                "drag below the viewport",
                GestureFact::Scroll(Some(EdgeScroll::Down)),
            ),
            (
                "drag above the viewport",
                GestureFact::Scroll(Some(EdgeScroll::Up)),
            ),
            ("drag inside the viewport", GestureFact::Scroll(None)),
            ("clear", GestureFact::None),
        ]
    );
}

#[test]
fn selection_ranges_and_visual_caret_match_the_geometry_table() {
    let mut failures = Vec::new();
    let collapsed = start_selection(cell(5, 3), Granularity::Char, None, None);
    miss(
        &mut failures,
        "collapsed char has no copyable extent",
        (
            is_collapsed(Some(&collapsed)),
            has_copyable_extent(Some(&collapsed)),
        ),
        (true, false),
    );
    miss(
        &mut failures,
        "extend of nothing",
        extend_selection(None, cell(1, 1)).is_none(),
        true,
    );
    miss(&mut failures, "clear", clear_selection().is_none(), true);
    let extended = extend_selection(Some(collapsed), cell(10, 7)).expect("extend");
    miss(
        &mut failures,
        "extend keeps the anchor",
        (
            extended.anchor,
            extended.active,
            is_collapsed(Some(&extended)),
            has_copyable_extent(Some(&extended)),
        ),
        (cell(5, 3), cell(10, 7), false, true),
    );
    let line_sel = start_selection(cell(5, 3), Granularity::Line, None, None);
    miss(
        &mut failures,
        "line granularity is copyable while collapsed",
        (
            is_collapsed(Some(&line_sel)),
            has_copyable_extent(Some(&line_sel)),
        ),
        (true, true),
    );

    let stream = extend_selection(
        Some(start_selection(cell(2, 0), Granularity::Char, None, None)),
        cell(5, 2),
    )
    .expect("stream");
    let backward = extend_selection(
        Some(start_selection(cell(5, 2), Granularity::Char, None, None)),
        cell(2, 0),
    )
    .expect("back");
    let rect = extend_selection(
        Some(start_selection(cell(2, 0), Granularity::Rect, None, None)),
        cell(5, 2),
    )
    .expect("rect");
    let line_span = extend_selection(
        Some(start_selection(cell(2, 1), Granularity::Line, None, None)),
        cell(8, 4),
    )
    .expect("line");
    let single = extend_selection(
        Some(start_selection(cell(2, 1), Granularity::Char, None, None)),
        cell(8, 1),
    )
    .expect("single");
    miss(
        &mut failures,
        "stream row ranges",
        (0..4)
            .map(|r| row_range(&stream, r, 10))
            .collect::<Vec<_>>(),
        vec![Some((2, 9)), Some((0, 9)), Some((0, 5)), None],
    );
    miss(
        &mut failures,
        "backward row ranges",
        (0..3)
            .map(|r| row_range(&backward, r, 10))
            .collect::<Vec<_>>(),
        vec![Some((2, 9)), Some((0, 9)), Some((0, 5))],
    );
    let ends = stream_endpoints(&stream);
    miss(
        &mut failures,
        "stream ends",
        (ends.start, ends.end),
        (cell(2, 0), cell(5, 2)),
    );
    miss(
        &mut failures,
        "stream rect",
        selection_rect(&stream, 10),
        Rect {
            x: 0,
            y: 0,
            w: 10,
            h: 3,
        },
    );
    miss(
        &mut failures,
        "single-row range",
        (
            row_range(&single, 1, 20),
            row_range(&single, 0, 20),
            selection_rect(&single, 20),
        ),
        (
            Some((2, 8)),
            None,
            Rect {
                x: 2,
                y: 1,
                w: 7,
                h: 1,
            },
        ),
    );
    miss(
        &mut failures,
        "rect row ranges",
        (0..3).map(|r| row_range(&rect, r, 10)).collect::<Vec<_>>(),
        vec![Some((2, 5)), Some((2, 5)), Some((2, 5))],
    );
    miss(
        &mut failures,
        "line span rows",
        [0, 2, 4].map(|r| row_range(&line_span, r, 20)),
        [None, Some((0, 19)), Some((0, 19))],
    );

    let letters: Vec<String> = [
        "a", "b", " ", "h", "e", "l", "l", "o", "_", "1", " ", "c", "d",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    let foo: Vec<String> = ["x", " ", "f", "o", "o", " ", "y"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let sep: Vec<String> = ["a", " ", "b"].into_iter().map(str::to_string).collect();
    miss(
        &mut failures,
        "word bounds",
        (
            word_bounds_on_row(&letters, 5),
            word_bounds_on_row(&letters, 3),
            word_bounds_on_row(&letters, 9),
            word_bounds_on_row(&sep, 1),
        ),
        ((3, 9), (3, 9), (3, 9), (1, 1)),
    );
    let word = expand_to_word_at(
        cell(3, 2),
        |r| if r == 2 { Some(foo.clone()) } else { None },
        None,
        None,
    );
    miss(
        &mut failures,
        "expand word",
        (
            word.granularity,
            word.anchor,
            word.active,
            has_copyable_extent(Some(&word)),
        ),
        (Granularity::Word, cell(2, 2), cell(4, 2), true),
    );
    let line = expand_to_line_at(cell(5, 3), 20, None, None);
    miss(
        &mut failures,
        "expand line",
        (line.anchor, line.active, row_range(&line, 3, 20)),
        (cell(0, 3), cell(19, 3), Some((0, 19))),
    );

    let lines = visual_draft_lines("ab\ncd", 40);
    miss(
        &mut failures,
        "newline draft rows",
        (
            lines[0].text.as_str(),
            lines[0].start,
            lines[0].end,
            lines[1].text.as_str(),
            lines[1].start,
            lines[1].end,
        ),
        ("ab", 0, 2, "cd", 3, 5),
    );
    let wrap = visual_draft_lines("0123456789", 5);
    miss(
        &mut failures,
        "wrap at five",
        wrap.iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>(),
        vec!["01234", "56789"],
    );
    miss(
        &mut failures,
        "visual motions",
        (
            move_visual_draft("0123456789", 2, 5, VisualMotion::LineDown),
            move_visual_draft("0123456789", 7, 5, VisualMotion::LineUp),
            move_visual_draft("0123456789", 7, 5, VisualMotion::LineHome),
            move_visual_draft("0123456789", 7, 5, VisualMotion::LineEnd),
            move_visual_draft("hi", 1, 40, VisualMotion::LineUp),
            move_visual_draft("hi", 1, 40, VisualMotion::LineDown),
            move_visual_draft("0123456789", 5, 5, VisualMotion::LineUp),
            move_visual_draft("01234", 5, 5, VisualMotion::LineUp),
        ),
        (7, 2, 5, 10, 1, 1, 0, 0),
    );
    miss(
        &mut failures,
        "wrap boundary line",
        visual_line_index(&wrap, 5, None),
        1,
    );
    // `ab\n` at 2 and 3, and `ab\ncd` at 2, already live on the overflow-clip caret rows.
    miss(
        &mut failures,
        "caret parks",
        [
            visual_caret_geometry("0123456789", 5, 5),
            visual_caret_geometry("01234", 5, 5),
            visual_caret_geometry("ab\ncd", 3, 40),
            visual_caret_geometry("01234\n", 5, 5),
            visual_caret_geometry("01234\n", 6, 5),
        ],
        [
            VisualCaret {
                line: 1,
                col_in_content: 0,
                total_lines: 2,
            },
            VisualCaret {
                line: 1,
                col_in_content: 0,
                total_lines: 2,
            },
            VisualCaret {
                line: 1,
                col_in_content: 0,
                total_lines: 2,
            },
            VisualCaret {
                line: 0,
                col_in_content: 4,
                total_lines: 2,
            },
            VisualCaret {
                line: 1,
                col_in_content: 0,
                total_lines: 2,
            },
        ],
    );
    miss(
        &mut failures,
        "wrap on a space",
        visual_draft_lines("hello world", 8)
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>(),
        vec!["hello ", "world"],
    );
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn nested_chrome_body_is_contain_and_bars_are_not_hits() {
    let stage = sized(
        "stage",
        40,
        10,
        HitExtra::default(),
        vec![chrome(
            "composer",
            ChromeFrame::new(30, "hello\nworld"),
            None,
        )],
    );
    let frame = lay(&stage, 40, 10);
    let body = rect_of(&frame, "composer");
    assert_eq!(
        frame.get("composer").expect("composer").user_select(),
        UserSelect::Contain,
    );
    assert_eq!(
        body,
        Rect {
            x: 3,
            y: 1,
            w: 26,
            h: 2
        }
    );
    assert_eq!(
        frame.get("composer:chrome").expect("chrome").user_select(),
        UserSelect::None,
    );
    assert!(element_at(&frame, 0, body.y).is_none(), "side bar");
    assert!(element_at(&frame, 29, body.y).is_none(), "right bar");
    assert!(element_at(&frame, 2, body.y).is_none(), "mark");
    let inside = contain_region_at(&frame, body.x + 1, body.y).expect("draft");
    assert_eq!(inside.key, "composer");
    assert_eq!(inside.rect, body);

    let offset = plain_box(
        "stage",
        HitExtra::default(),
        BoxStyle {
            width: Some(Length::Cells(40)),
            height: Some(Length::Cells(10)),
            padding: Some(Padding::Edges {
                t: Some(2),
                r: None,
                b: None,
                l: Some(1),
            }),
            ..BoxStyle::default()
        },
        vec![chrome(
            "composer",
            ChromeFrame::new(30, "hello\nworld"),
            None,
        )],
    );
    let shifted = lay(&offset, 40, 10);
    assert_eq!(
        rect_of(&shifted, "composer"),
        Rect {
            x: 4,
            y: 3,
            w: 26,
            h: 2
        },
    );

    let empty = sized(
        "stage",
        40,
        10,
        HitExtra::default(),
        vec![chrome("composer", ChromeFrame::new(30, ""), None)],
    );
    let empty_frame = lay(&empty, 40, 10);
    let empty_body = empty_frame.get("composer").expect("empty");
    assert_eq!(empty_body.user_select(), UserSelect::Contain);
    let region = contain_region_at(&empty_frame, empty_body.rect().x + 1, empty_body.rect().y);
    assert_eq!(region.map(|hit| hit.key), Some("composer".to_string()));

    let placeholder = sized(
        "stage",
        40,
        10,
        HitExtra::default(),
        vec![chrome(
            "composer",
            ChromeFrame {
                placeholder: Some("type here".to_string()),
                ..ChromeFrame::new(30, "")
            },
            None,
        )],
    );
    let placeholder_frame = lay(&placeholder, 40, 10);
    let ph = placeholder_frame.get("composer").expect("placeholder");
    assert_eq!(ph.user_select(), UserSelect::None);
    assert!(contain_region_at(&placeholder_frame, ph.rect().x + 1, ph.rect().y).is_none());

    let listed = sized(
        "stage",
        20,
        10,
        HitExtra::default(),
        vec![chrome(
            "list",
            ChromeFrame {
                body_seg_rows: vec![vec![ChromeSegSpec::plain("/connect")]],
                ..ChromeFrame::new(20, "")
            },
            Some(UserSelect::None),
        )],
    );
    let listed_frame = lay(&listed, 20, 10);
    assert_eq!(
        listed_frame.get("list").expect("list").user_select(),
        UserSelect::None,
    );
    assert_eq!(
        listed_frame
            .get("list:chrome")
            .expect("list chrome")
            .user_select(),
        UserSelect::None,
    );
}
