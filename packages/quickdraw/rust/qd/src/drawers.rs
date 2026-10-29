//! Open agents drawer, rewind seat, and the work-cell caption line.
//!
//! The host owns the row list, the pin list, and history. This module paints
//! the snapshot it is given. A later snapshot replaces the seat. Nothing here
//! keeps the previous rows.

use crate::layout_chrome::{
    chrome_frame_text_width, thumb_coverage, ChromeFrame, ChromeHotkey, ChromeSegSpec,
    CHROME_FRAME_CHROME_ROWS,
};
use crate::layout_engine::{
    layout, measure_tree, BoxStyle, Gutter, LayoutOpts, Node, Origin, Overflow, OverflowAnchor,
    Viewport, INDICATION_CONTENT_INSET,
};
use crate::layout_flex::{FlexDirection, FlexFactor, FlexStyle, Length, Padding, Rect};
use crate::layout_text::WhiteSpace;
use crate::measure::display_width;
use crate::paint_replica::Json;
use crate::theme::{BgP, FgP};
use crate::Style;

/// Gap between the drawer panel and the peek.
const AGENTS_PEEK_GAP: i64 = 1;
/// Gap between the peek's right edge and the viewport.
const AGENTS_PEEK_RIGHT_MARGIN: i64 = 1;
/// Plaque height including pad.
pub const AGENTS_PEEK_MAX_HEIGHT: i64 = 9;

/// One drawer row. `kind` is `call`, `bot`, or `session`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRow {
    pub key: String,
    pub kind: String,
    pub name: String,
    pub recap: String,
    pub indent: i64,
    pub mark: String,
    pub model: String,
    pub ask_line: String,
    pub unfinished: String,
    pub notifies: Vec<String>,
    pub result: String,
    pub current: bool,
}

/// Focused row's plaque. The host chooses the row. This paints it.
#[derive(Clone, Debug)]
pub struct AgentsPlaque {
    pub focus: String,
    pub node: Node,
}

/// Where the plaque sits. `x` and `y` are cells in the frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentsPeekPlace {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// Where the sneak-peek sits. `x` and `y` are cells in the frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentsPreviewRect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// One rewind neighbor the host already chose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewindPin {
    pub key: String,
    pub text: String,
}

/// First line, collapsed spaces. A multiline prompt keeps an ellipsis.
pub fn compact_pin_draft(prompt: &str) -> String {
    let first = prompt.split('\n').next().unwrap_or("");
    let mut collapsed = String::new();
    let mut gap = false;
    for ch in first.chars() {
        if ch.is_whitespace() {
            gap = !collapsed.is_empty();
            continue;
        }
        if gap {
            collapsed.push(' ');
            gap = false;
        }
        collapsed.push(ch);
    }
    if prompt.contains('\n') {
        collapsed.push('…');
    }
    collapsed
}

pub fn parse_agent_rows(value: Option<&Json>) -> Vec<AgentRow> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for item in items {
        let Json::Object(map) = item else {
            continue;
        };
        rows.push(AgentRow {
            key: json_string(map, "key"),
            kind: json_string(map, "kind"),
            name: json_string(map, "name"),
            recap: json_string(map, "recap"),
            indent: json_i64(map, "indent"),
            mark: json_string(map, "mark"),
            model: json_string(map, "model"),
            ask_line: json_string(map, "askLine"),
            unfinished: json_string(map, "unfinished"),
            notifies: json_strings(map, "notifies"),
            result: json_string(map, "result"),
            current: json_bool(map, "current"),
        });
    }
    rows
}

pub fn parse_rewind_pins(value: Option<&Json>) -> Vec<RewindPin> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut pins = Vec::new();
    for item in items {
        let Json::Object(map) = item else {
            continue;
        };
        pins.push(RewindPin {
            key: json_string(map, "key"),
            text: json_string(map, "text"),
        });
    }
    pins
}

/// Drawer body. Band headers follow the kinds that are present.
/// The meter line is not this node.
pub fn agents_drawer(rows: &[AgentRow], focus_key: &str, width: i64) -> Node {
    let width = width.max(8);
    let mut children = Vec::new();
    push_band(
        &mut children,
        rows,
        "call",
        "agents:subagents",
        "Subagents",
        focus_key,
        width,
    );
    push_band(
        &mut children,
        rows,
        "bot",
        "agents:bots",
        "Collaborators",
        focus_key,
        width,
    );
    push_band(
        &mut children,
        rows,
        "session",
        "agents:sessions",
        "Sessions",
        focus_key,
        width,
    );
    box_w("agents:body", width, children)
}

/// Read-only chrome stack for the pins the host sent. Empty is `None`.
pub fn rewind_neighbors(
    rows: &[RewindPin],
    width: i64,
    key: &str,
    behind: bool,
    more_outer: bool,
) -> Option<Node> {
    if rows.is_empty() {
        return None;
    }
    let width = width.max(8);
    let n = rows.len();
    let mut children = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let first = i == 0;
        let last = i + 1 == n;
        let mut frame = ChromeFrame::new(width, compact_pin_draft(&row.text));
        frame.interactive = Some(false);
        frame.read_only = true;
        frame.plain_bottom = true;
        frame.omit_top = !first;
        frame.join_top = first && behind && more_outer;
        frame.join_bottom = if behind { !last } else { !last || more_outer };
        children.push(Node::Box {
            style: BoxStyle::default(),
            children: vec![Node::Chrome {
                key: Some(format!("{}:chrome", row.key)),
                frame,
            }],
            key: Some(row.key.clone()),
            id: None,
            measured: None,
            region_prominence: Some(0.45),
        });
    }
    Some(Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Column,
            width: Some(Length::Cells(width)),
            ..FlexStyle::default()
        },
        children,
        key: Some(key.to_string()),
        measured: None,
        region_prominence: Some(0.45),
    })
}

/// Overlay that seats the open drawer on the frame. Closed drawers do not call this.
/// The body scrolls inside the panel. `scroll` is the host's row offset.
pub fn agents_overlay(body: Node, width: i64, scroll: i64) -> Node {
    let panel_w = (width / 2).max(16);
    Node::Overlay {
        center: false,
        origin: Some(Origin { x: 0, y: 0 }),
        backdrop: true,
        backdrop_style: None,
        children: vec![Node::Box {
            style: BoxStyle {
                width: Some(Length::Cells(panel_w)),
                padding: Some(Padding::Edges {
                    t: Some(1),
                    r: Some(1),
                    b: None,
                    l: Some(1),
                }),
                background: Some(Style {
                    bg_role: Some("surface".to_string()),
                    bg_prominence: Some(BgP::PANEL),
                    ..Style::default()
                }),
                ..BoxStyle::default()
            },
            children: vec![Node::Viewport {
                id: "agents".to_string(),
                key: Some("agents:viewport".to_string()),
                children: vec![body],
                anchor: OverflowAnchor::None,
                scroll,
                width: None,
                height: None,
                measured: None,
                region_prominence: None,
            }],
            key: Some("agents:panel".to_string()),
            id: None,
            measured: None,
            region_prominence: None,
        }],
        key: Some("agents:overlay".to_string()),
        measured: None,
        region_prominence: None,
    }
}

/// Cell rect of the sneak-peek. 90% of the frame, at least 8×4, centered.
pub fn agents_preview_rect(cols: i64, rows: i64) -> AgentsPreviewRect {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let w = (cols * 9 / 10).max(8).min(cols);
    let h = (rows * 9 / 10).max(4).min(rows);
    AgentsPreviewRect {
        x: (cols - w) / 2,
        y: (rows - h) / 2,
        w,
        h,
    }
}

/// Width the peeked tape is prepared at. The chrome frame keeps four cells.
pub fn agents_preview_inner_width(cols: i64) -> i64 {
    chrome_frame_text_width(agents_preview_rect(cols, cols.max(1)).w).max(1)
}

/// Centered sneak-peek. Backdrop compounds with the drawer already in the scene.
/// The tape sits inset from the contour; Esc rides the bottom rule.
pub fn agents_preview_overlay(tape: Node, cols: i64, rows: i64, title: &str) -> Node {
    let place = agents_preview_rect(cols, rows);
    let inner_w = chrome_frame_text_width(place.w).max(1);
    let inner_h = (place.h - CHROME_FRAME_CHROME_ROWS).max(1);
    let tape_h = measure_tree(&tape, inner_w, 10_000, None).h.max(1);
    let max_scroll = (tape_h - inner_h).max(0);
    let title = title.trim();
    let mut frame = ChromeFrame::new(place.w, "");
    frame.interactive = Some(false);
    frame.read_only = true;
    frame.hotkeys_bottom = true;
    frame.hotkeys = vec![ChromeHotkey::new("Esc", "close")];
    if !title.is_empty() {
        frame.top_segs = vec![
            ChromeSegSpec {
                role: Some("foreground".to_string()),
                prominence: Some(FgP::GHOST),
                ..ChromeSegSpec::plain("─ ")
            },
            ChromeSegSpec {
                role: Some("foreground".to_string()),
                prominence: Some(FgP::PRIMARY),
                ..ChromeSegSpec::plain(title)
            },
            ChromeSegSpec::plain(" "),
        ];
    }
    let blank = vec![ChromeSegSpec::plain(" ")];
    let rows_n = usize::try_from(inner_h).unwrap_or(0);
    frame.body_seg_rows = vec![blank; rows_n];
    frame.body_right_coverage = thumb_coverage(tape_h, inner_h, max_scroll)
        .into_iter()
        .map(Some)
        .collect();
    Node::Overlay {
        center: false,
        origin: Some(Origin {
            x: place.x,
            y: place.y,
        }),
        backdrop: true,
        backdrop_style: None,
        children: vec![Node::Box {
            style: BoxStyle {
                width: Some(Length::Cells(place.w)),
                height: Some(Length::Cells(place.h)),
                overflow: Some(Overflow::Hidden),
                background: Some(panel_fill()),
                ..BoxStyle::default()
            },
            children: vec![
                Node::Chrome {
                    key: Some("agents:preview:chrome".to_string()),
                    frame,
                },
                Node::Overlay {
                    center: false,
                    origin: Some(Origin { x: 2, y: 1 }),
                    backdrop: false,
                    backdrop_style: None,
                    children: vec![Node::Viewport {
                        id: "agents:preview:tape".to_string(),
                        key: Some("agents:preview:viewport".to_string()),
                        children: vec![tape],
                        anchor: OverflowAnchor::None,
                        scroll: i64::MAX,
                        width: Some(Length::Cells(inner_w)),
                        height: Some(Length::Cells(inner_h)),
                        measured: None,
                        region_prominence: None,
                    }],
                    key: Some("agents:preview:body".to_string()),
                    measured: None,
                    region_prominence: None,
                },
            ],
            key: Some("agents:preview".to_string()),
            id: None,
            measured: None,
            region_prominence: None,
        }],
        key: Some("agents:preview-overlay".to_string()),
        measured: None,
        region_prominence: None,
    }
}

/// Seat the sneak-peek on the frame box. A scene without that box is wrapped.
pub fn with_agents_preview(mut scene: Node, preview: Node) -> Node {
    if let Node::Box { children, key, .. } = &mut scene {
        if key.as_deref() == Some("frame") {
            children.push(preview);
            return scene;
        }
    }
    Node::Box {
        style: BoxStyle::default(),
        children: vec![scene, preview],
        key: Some("frame".to_string()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

/// Plaque for one focused row. Bots and the current session have none.
pub fn agents_peek(row: &AgentRow) -> Option<Node> {
    if row.kind == "bot" || (row.kind == "session" && row.current) {
        return None;
    }
    let mut children = Vec::new();
    if !row.recap.is_empty() {
        children.push(text_clamp(
            "agents:peek:status",
            &row.recap,
            WhiteSpace::Normal,
            if row.kind == "call" { 3 } else { 5 },
            loud(false),
        ));
    }
    if row.kind == "call"
        && (row.unfinished == "ask" || row.unfinished == "question")
        && !row.ask_line.is_empty()
    {
        children.push(text_clamp(
            "agents:peek:ask",
            &row.ask_line,
            WhiteSpace::Nowrap,
            1,
            attention(),
        ));
    }
    let notify = if row.kind == "call" {
        row.notifies.iter().find(|line| !line.trim().is_empty())
    } else {
        None
    };
    if let Some(line) = notify {
        children.push(text_clamp(
            "agents:peek:notify",
            line,
            WhiteSpace::Normal,
            2,
            ghost(),
        ));
    }
    if row.kind == "call" && !row.result.is_empty() {
        children.push(text_clamp(
            "agents:peek:result",
            &row.result,
            WhiteSpace::Normal,
            3,
            loud(false),
        ));
    }
    if !row.model.is_empty() {
        if !children.is_empty() {
            children.push(Node::Box {
                style: BoxStyle {
                    height: Some(Length::Cells(1)),
                    ..BoxStyle::default()
                },
                children: Vec::new(),
                key: Some("agents:peek:gap".to_string()),
                id: None,
                measured: None,
                region_prominence: None,
            });
        }
        children.push(text_clamp(
            "agents:peek:model",
            &row.model,
            WhiteSpace::Nowrap,
            1,
            ghost(),
        ));
    }
    if children.is_empty() {
        return None;
    }
    Some(Node::Box {
        style: BoxStyle {
            padding: Some(Padding::Uniform(1)),
            background: Some(panel_fill()),
            ..BoxStyle::default()
        },
        children,
        key: Some("agents:peek".to_string()),
        id: None,
        measured: None,
        region_prominence: None,
    })
}

/// Top-aligned to the row, flipped up when that hangs off, then clamped.
pub fn place_agents_peek(
    anchor: Rect,
    panel: Rect,
    cols: i64,
    rows: i64,
    size_w: i64,
    size_h: i64,
) -> Option<AgentsPeekPlace> {
    let right = panel.x + panel.w + AGENTS_PEEK_GAP;
    let max_w = (cols - right - AGENTS_PEEK_RIGHT_MARGIN).max(0);
    if max_w < 1 || rows < 1 {
        return None;
    }
    let w = size_w.max(1).min(max_w);
    let h = size_h.max(1).min(rows);
    let x = clamp_i64(right, 0, (cols - w - AGENTS_PEEK_RIGHT_MARGIN).max(0));
    let down_y = anchor.y;
    let up_y = anchor.y + anchor.h - h;
    let down_fits = down_y >= 0 && down_y + h <= rows;
    let up_fits = up_y >= 0 && up_y + h <= rows;
    let y = if down_fits {
        down_y
    } else if up_fits {
        up_y
    } else {
        clamp_i64(down_y, 0, (rows - h).max(0))
    };
    Some(AgentsPeekPlace { x, y, w, h })
}

/// Drop a plaque seated by the previous paint. The next seat reads fresh rects.
pub fn strip_agents_peek(root: &mut Node) {
    let Node::Box { children, .. } = root else {
        return;
    };
    children.retain(|child| node_key(child) != Some("agents:peek-overlay"));
}

/// Lay the frame out, then seat the plaque beside the focused row.
/// Returns whether `root` gained the overlay. A miss leaves `root` alone.
pub fn attach_agents_peek(
    root: &mut Node,
    plaque: &Node,
    focus: &str,
    cols: i64,
    rows: i64,
) -> bool {
    let frame = layout(root, Viewport { w: cols, h: rows }, LayoutOpts::default());
    let panel = placed_rect(&frame.placed, "agents:panel");
    let anchor = placed_rect(&frame.placed, focus);
    let (Some(panel), Some(anchor)) = (panel, anchor) else {
        return false;
    };
    if anchor.w < 1 || anchor.h < 1 || !rects_cross(anchor, panel) {
        return false;
    }
    let room = cols - (panel.x + panel.w) - AGENTS_PEEK_GAP - AGENTS_PEEK_RIGHT_MARGIN;
    if room < 1 {
        return false;
    }
    let measured = measure_tree(plaque, room, rows, None);
    let size_h = measured.h.max(1).min(AGENTS_PEEK_MAX_HEIGHT).min(rows);
    let Some(place) = place_agents_peek(anchor, panel, cols, rows, measured.w.max(1), size_h)
    else {
        return false;
    };
    let Node::Box { children, .. } = root else {
        return false;
    };
    children.push(Node::Overlay {
        center: false,
        origin: Some(Origin {
            x: place.x,
            y: place.y,
        }),
        backdrop: false,
        backdrop_style: None,
        children: vec![sized_peek(plaque, place.w, place.h)],
        key: Some("agents:peek-overlay".to_string()),
        measured: None,
        region_prominence: None,
    });
    true
}

/// True when any node in `root` carries `key`.
pub fn scene_has_key(node: &Node, key: &str) -> bool {
    any_node(node, &mut |node| node_key(node) == Some(key))
}

fn placed_rect(placed: &[crate::layout_engine::Placed], key: &str) -> Option<Rect> {
    placed
        .iter()
        .find(|item| item.key == key)
        .map(|item| item.rect)
}

fn rects_cross(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

fn sized_peek(node: &Node, w: i64, h: i64) -> Node {
    let mut peek = node.clone();
    if let Node::Box { style, .. } = &mut peek {
        style.width = Some(Length::Cells(w));
        style.height = Some(Length::Cells(h));
        style.overflow = Some(Overflow::Hidden);
    }
    peek
}

fn any_node(node: &Node, f: &mut impl FnMut(&Node) -> bool) -> bool {
    if f(node) {
        return true;
    }
    match node {
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            children.iter().any(|child| any_node(child, f))
        }
        Node::Disclosure {
            summary, children, ..
        } => any_node(summary, f) || children.iter().any(|child| any_node(child, f)),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => false,
    }
}

fn node_key(node: &Node) -> Option<&str> {
    match node {
        Node::Text { key, .. }
        | Node::Box { key, .. }
        | Node::Flex { key, .. }
        | Node::Grid { key, .. }
        | Node::Indication { key, .. }
        | Node::Overlay { key, .. }
        | Node::Disclosure { key, .. }
        | Node::Squeeze { key, .. }
        | Node::Viewport { key, .. }
        | Node::IndentationException { key, .. }
        | Node::Markdown { key, .. }
        | Node::Diff { key, .. }
        | Node::Chrome { key, .. } => key.as_deref(),
        Node::Skipped => None,
    }
}

/// Drawer row key inside a paint key. `session:a:name` is `session:a`.
pub fn agents_row_key(key: &str) -> Option<&str> {
    if key.contains(":gap:") {
        return None;
    }
    if !(key.starts_with("session:") || key.starts_with("call:") || key.starts_with("bot:")) {
        return None;
    }
    let mut cur = key;
    loop {
        let next = strip_row_child(cur);
        if next == cur {
            break;
        }
        cur = next;
    }
    if cur == "session:" || cur == "call:" || cur == "bot:" {
        None
    } else {
        Some(cur)
    }
}

fn strip_row_child(key: &str) -> &str {
    const SUFFIXES: &[&str] = &[
        ":name", ":id-line", ":id-row", ":title", ":mark", ":status", ":recap", ":indent", ":id",
    ];
    for suffix in SUFFIXES {
        if let Some(stripped) = key.strip_suffix(suffix) {
            return stripped;
        }
    }
    if let Some((head, tail)) = key.rsplit_once(":dive:") {
        if !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()) {
            return head;
        }
    }
    key
}

fn clamp_i64(n: i64, lo: i64, hi: i64) -> i64 {
    n.max(lo).min(hi)
}

fn push_band(
    children: &mut Vec<Node>,
    rows: &[AgentRow],
    kind: &str,
    key: &str,
    label: &str,
    focus_key: &str,
    width: i64,
) {
    let band: Vec<&AgentRow> = rows.iter().filter(|row| row.kind == kind).collect();
    if band.is_empty() {
        return;
    }
    children.push(text_node(key, label, ghost()));
    for row in band {
        children.push(row_node(row, focus_key, width));
    }
}

fn row_node(row: &AgentRow, focus_key: &str, width: i64) -> Node {
    let indent = row.indent.clamp(0, 6);
    let pad = indent * 2;
    let alloc_w = (width - pad).max(8);
    let focused = row.key == focus_key;
    let body = if row.kind == "bot" {
        bot_line(row, focused, alloc_w)
    } else {
        session_line(row, focused, alloc_w)
    };
    let block = Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(alloc_w)),
            ..BoxStyle::default()
        },
        children: vec![Node::Indication {
            gutter: Gutter::Top {
                glyph: " ".to_string(),
            },
            children: vec![body],
            style: loud(focused),
            key: Some(format!("{}:id", row.key)),
            measured: None,
            region_prominence: None,
        }],
        key: Some(row.key.clone()),
        id: None,
        measured: None,
        region_prominence: None,
    };
    if indent == 0 {
        return block;
    }
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width)),
            padding: Some(Padding::Edges {
                t: None,
                r: None,
                b: None,
                l: Some(pad),
            }),
            ..BoxStyle::default()
        },
        children: vec![block],
        key: Some(format!("{}:indent", row.key)),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn session_line(row: &AgentRow, focused: bool, width: i64) -> Node {
    // The indication keeps three cells. The mark sits in what remains.
    let line_w = (width - INDICATION_CONTENT_INSET).max(1);
    let mark_w = if row.mark.is_empty() {
        0
    } else {
        i64::try_from(display_width(&row.mark)).unwrap_or(i64::MAX)
    };
    let mut children = Vec::new();
    // Two gaps sit around the spacer. A wider mark keeps the row to itself.
    if mark_w == 0 || mark_w + 2 >= line_w {
        let text = if mark_w == 0 {
            elide_head(&row.name, line_w)
        } else {
            elide_head(&row.mark, line_w)
        };
        let key = if mark_w == 0 {
            format!("{}:name", row.key)
        } else {
            format!("{}:mark", row.key)
        };
        let style = if mark_w == 0 {
            loud(focused)
        } else {
            mark_style(&row.mark)
        };
        children.push(text_node(&key, &text, style));
    } else {
        let name_w = (line_w - mark_w - 2).max(0);
        children.push(text_node(
            &format!("{}:name", row.key),
            &elide_head(&row.name, name_w),
            loud(focused),
        ));
        children.push(Node::Box {
            style: BoxStyle {
                flex: Some(FlexFactor::Sugar(1.0)),
                height: Some(Length::Cells(1)),
                ..BoxStyle::default()
            },
            children: Vec::new(),
            key: Some(format!("{}:title", row.key)),
            id: None,
            measured: None,
            region_prominence: None,
        });
        children.push(text_node(
            &format!("{}:mark", row.key),
            &row.mark,
            mark_style(&row.mark),
        ));
    }
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Row,
            gap: 1,
            width: Some(Length::Cells(line_w)),
            height: Some(Length::Cells(1)),
            ..FlexStyle::default()
        },
        children,
        key: Some(format!("{}:id-row", row.key)),
        measured: None,
        region_prominence: None,
    }
}

fn mark_style(mark: &str) -> Style {
    if mark == "awaiting approval" {
        attention()
    } else {
        ghost()
    }
}

/// Keep the head. `…` is one cell.
fn elide_head(text: &str, width: i64) -> String {
    if width <= 0 {
        return String::new();
    }
    if i64::try_from(display_width(text)).unwrap_or(i64::MAX) <= width {
        return text.to_string();
    }
    if width == 1 {
        return "…".to_string();
    }
    let mut out = String::new();
    let mut used = 0i64;
    let budget = width - 1;
    for ch in text.chars() {
        let cell = i64::try_from(display_width(&ch.to_string())).unwrap_or(1);
        if used + cell > budget {
            break;
        }
        out.push(ch);
        used += cell;
    }
    out.push('…');
    out
}

fn bot_line(row: &AgentRow, focused: bool, width: i64) -> Node {
    let width = (width - INDICATION_CONTENT_INSET).max(1);
    if row.recap.is_empty() {
        return text_node(&format!("{}:name", row.key), &row.name, loud(focused));
    }
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Row,
            width: Some(Length::Cells(width)),
            ..FlexStyle::default()
        },
        children: vec![
            text_node(
                &format!("{}:name", row.key),
                &format!("{} ", row.name),
                loud(focused),
            ),
            text_node(&format!("{}:recap", row.key), &row.recap, ghost()),
        ],
        key: Some(format!("{}:id-line", row.key)),
        measured: None,
        region_prominence: None,
    }
}

fn box_w(key: &str, width: i64, children: Vec<Node>) -> Node {
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width.max(0))),
            ..BoxStyle::default()
        },
        children,
        key: Some(key.to_string()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn text_node(key: &str, content: &str, style: Style) -> Node {
    text_clamp(key, content, WhiteSpace::Nowrap, 1, style)
}

fn text_clamp(key: &str, content: &str, white_space: WhiteSpace, lines: i64, style: Style) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space: Some(white_space),
        ellipsis: Some(true),
        line_clamp: Some(lines),
        measured: None,
        style,
        key: Some(key.to_string()),
        live: None,
        region_prominence: None,
    }
}

fn panel_fill() -> Style {
    Style {
        bg_role: Some("surface".to_string()),
        bg_prominence: Some(BgP::PANEL),
        ..Style::default()
    }
}

fn loud(focused: bool) -> Style {
    fg(
        "foreground",
        if focused { FgP::PRIMARY } else { FgP::RISING },
    )
}

fn ghost() -> Style {
    fg("foreground", FgP::GHOST)
}

fn attention() -> Style {
    fg("attention", FgP::SECONDARY)
}

fn fg(role_name: &str, prominence: f64) -> Style {
    Style {
        role: Some(role_name.to_string()),
        prominence: Some(prominence),
        ..Style::default()
    }
}

fn json_bool(map: &std::collections::BTreeMap<String, Json>, key: &str) -> bool {
    matches!(map.get(key), Some(Json::Bool(true)))
}

fn json_strings(map: &std::collections::BTreeMap<String, Json>, key: &str) -> Vec<String> {
    let Some(Json::Array(items)) = map.get(key) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            Json::String(text) => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn json_string(map: &std::collections::BTreeMap<String, Json>, key: &str) -> String {
    match map.get(key) {
        Some(Json::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn json_i64(map: &std::collections::BTreeMap<String, Json>, key: &str) -> i64 {
    match map.get(key) {
        Some(Json::Number(number)) if number.is_finite() => {
            let value = number.floor();
            if value >= i64::MAX as f64 {
                i64::MAX
            } else if value <= i64::MIN as f64 {
                i64::MIN
            } else {
                value as i64
            }
        }
        _ => 0,
    }
}
