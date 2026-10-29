//! Host overrides on a scene that the snapshot does not own.
//!
//! The tape offset is the viewport scroll. Follow-tail passes a scroll the
//! placer clamps to the bottom. An off-tip `:recap` whose key changed is
//! centered instead (`paint-source.ts` `scrollToShowBlock`). The same key
//! leaves a wheel alone. When that key disappears, the tape follows the
//! tail again. A disclosure key in the override map is open.
//! A missing key keeps the wire value, which is collapsed. A fold that
//! disagrees with that wire value drops the measured stamp on the disclosure
//! and on every node above it. The stamp was taken at the wire fold, and the
//! placer would keep that height. A click uses the rects from that same paint.

use std::collections::{BTreeMap, BTreeSet};

use crate::drawers::{agents_row_key, compact_pin_draft};
use crate::layout_engine::{measure_tree, BoxStyle, Node, OverflowAnchor};
use crate::layout_flex::{FlexDirection, Length, Padding};
use crate::layout_hit::{Click, HitExtra, HitNode, Intent, UserSelect};

const TAPE_ID: &str = "tape";

pub(crate) fn apply_collapsed(node: &mut Node, overrides: &BTreeMap<String, bool>) -> bool {
    if overrides.is_empty() {
        return false;
    }
    match node {
        Node::Disclosure {
            collapsed,
            key,
            summary,
            children,
            measured,
            ..
        } => {
            let mut changed = false;
            if let Some(key) = key {
                if let Some(value) = overrides.get(key) {
                    if *collapsed != *value {
                        *collapsed = *value;
                        changed = true;
                    }
                }
            }
            if apply_collapsed(summary, overrides) {
                changed = true;
            }
            for child in children.iter_mut() {
                if apply_collapsed(child, overrides) {
                    changed = true;
                }
            }
            if changed {
                *measured = None;
            }
            changed
        }
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => false,
        Node::Box {
            children, measured, ..
        }
        | Node::Flex {
            children, measured, ..
        }
        | Node::Grid {
            children, measured, ..
        }
        | Node::Indication {
            children, measured, ..
        }
        | Node::Overlay {
            children, measured, ..
        }
        | Node::Squeeze {
            children, measured, ..
        }
        | Node::Viewport {
            children, measured, ..
        }
        | Node::IndentationException {
            children, measured, ..
        } => {
            let mut changed = false;
            for child in children.iter_mut() {
                if apply_collapsed(child, overrides) {
                    changed = true;
                }
            }
            if changed {
                *measured = None;
            }
            changed
        }
    }
}

/// Window height for the tape, after the composer frame and the screen's other rows.
pub(crate) fn fit_tape(node: &mut Node, rows: i64, chrome_h: i64) -> Option<i64> {
    let reserve = chrome_h + screen_reserve(node);
    let window = (rows - reserve).max(1);
    stamp_height(node, window);
    Some(window)
}

pub(crate) fn tape_max_scroll(node: &Node, window: i64) -> i64 {
    let Some(content) = tape_content_height(node) else {
        return 0;
    };
    (content - window).max(0)
}

/// First `:recap` in the tape. `y` is its top in tape rows. A `:rewind`
/// chrome is not a seat. Pins sit outside the tape, so this `y` stays put
/// while a dropped pin grows the window.
pub(crate) struct RecapSeat {
    pub key: String,
    pub y: i64,
    pub h: i64,
}

pub(crate) fn recap_seat(scene: &Node) -> Option<RecapSeat> {
    let body = tape_body(scene)?;
    let width = tape_width(scene).unwrap_or(80);
    find_recap(body, 0, width)
}

fn find_recap(node: &Node, y: i64, width: i64) -> Option<RecapSeat> {
    if let Node::Chrome { key: Some(key), .. } = node {
        if key.ends_with(":recap") {
            return Some(RecapSeat {
                key: key.clone(),
                y,
                h: block_h(node, width),
            });
        }
    }
    if node_key(node).is_some_and(|k| {
        k.starts_with("speech:")
            || k.starts_with("gap:")
            || k.starts_with("tool:")
            || k.starts_with("thinking:")
            || k.starts_with("scheme:")
            || k.starts_with("recall:")
            || k.starts_with("compact:")
            || k.starts_with("loop:")
    }) {
        return None;
    }
    let stack = vertical_stack(node)?;
    let mut cy = y.saturating_add(stack.lead);
    for (i, child) in stack.children.iter().enumerate() {
        if i > 0 {
            cy = cy.saturating_add(stack.gap);
        }
        if let Some(seat) = find_recap(child, cy, width) {
            return Some(seat);
        }
        cy = cy.saturating_add(block_h(child, width));
    }
    None
}

/// Centers the block. One at least as tall as the window keeps its top.
/// `paint-source.ts` `scrollToShowBlock`. The comment above that call still
/// says to pin the top.
pub(crate) fn scroll_to_show_block(y: i64, height: i64, viewport: i64) -> i64 {
    let h = height.max(1);
    let view = viewport.max(1);
    if h >= view {
        return y.max(0);
    }
    (y - (view - h) / 2).max(0)
}

pub(crate) fn stamp_scroll(node: &mut Node, scroll: i64) {
    match node {
        Node::Viewport {
            id,
            anchor,
            scroll: slot,
            ..
        } if id == TAPE_ID => {
            *anchor = OverflowAnchor::None;
            *slot = scroll;
        }
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => {}
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Disclosure { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children.iter_mut() {
                stamp_scroll(child, scroll);
            }
        }
    }
}

pub(crate) fn hits_of(node: &Node) -> HitNode {
    hits_of_window(node, None)
}

fn hits_of_window(node: &Node, window: Option<(i64, i64, i64)>) -> HitNode {
    if let Some(next) = crate::layout_engine::expand_realized(node) {
        return hits_of_window(&next, window);
    }
    match node {
        Node::Text {
            content,
            key,
            white_space,
            ellipsis,
            line_clamp,
            measured,
            ..
        } => HitNode::Text {
            content: content.clone(),
            key: key.clone(),
            white_space: *white_space,
            ellipsis: *ellipsis,
            line_clamp: *line_clamp,
            measured: *measured,
            extra: text_select(key),
        },
        Node::Disclosure {
            key,
            collapsed,
            summary,
            children,
            ..
        } => {
            if key
                .as_deref()
                .is_some_and(|key| key.starts_with("mention:"))
            {
                let mut summary = hits_of(summary);
                stamp_mention(&mut summary);
                let mut kids: Vec<HitNode> = children.iter().map(hits_of).collect();
                for child in &mut kids {
                    stamp_mention(child);
                }
                return HitNode::Disclosure {
                    key: key.clone(),
                    collapsed: *collapsed,
                    extra: HitExtra {
                        intent: Some(Intent::Activate),
                        user_select: Some(UserSelect::None),
                        ..HitExtra::default()
                    },
                    summary: Box::new(summary),
                    children: kids,
                };
            }
            let block_id = key.clone().unwrap_or_default();
            let click = Click::ToggleCollapsed { block_id };
            let mut summary = hits_of(summary);
            stamp_click(&mut summary, &click);
            HitNode::Disclosure {
                key: key.clone(),
                collapsed: *collapsed,
                extra: HitExtra {
                    click: Some(click),
                    ..HitExtra::default()
                },
                summary: Box::new(summary),
                children: children.iter().map(hits_of).collect(),
            }
        }
        Node::Viewport {
            id,
            key,
            anchor,
            scroll,
            width,
            height,
            children,
            ..
        } => {
            let child_win = match (width, height) {
                (Some(Length::Cells(win_w)), Some(Length::Cells(win_h)))
                    if *win_w > 0 && *win_h > 0 =>
                {
                    let w = *win_w;
                    let h = *win_h;
                    let mut total: i128 = 0;
                    for child in children {
                        total += i128::from(block_h(child, w));
                    }
                    let total = i64::try_from(total).unwrap_or(i64::MAX);
                    let max_scroll = total.saturating_sub(h).max(0);
                    let scroll_y = match anchor {
                        OverflowAnchor::Auto => max_scroll,
                        OverflowAnchor::None => (*scroll).clamp(0, max_scroll),
                    };
                    Some((scroll_y, scroll_y.saturating_add(h), w))
                }
                _ => None,
            };
            let mut cy = 0i64;
            let mut hit_children = Vec::with_capacity(children.len());
            for child in children {
                let next_win = child_win.map(|(top, bottom, w)| {
                    let sub_win = (top.saturating_sub(cy), bottom.saturating_sub(cy), w);
                    cy = cy.saturating_add(block_h(child, w));
                    sub_win
                });
                hit_children.push(hits_of_window(child, next_win));
            }
            HitNode::Viewport {
                id: id.clone(),
                key: key.clone(),
                anchor: *anchor,
                scroll: *scroll,
                children: hit_children,
            }
        }
        Node::Flex {
            key,
            style,
            children,
            measured,
            ..
        } => {
            if let Some((win_top, win_bottom, win_w)) = window {
                if style.direction == FlexDirection::Column {
                    let mut cy = edge_before(style.padding);
                    let gap = style.gap.max(0);
                    let mut hit_children = Vec::with_capacity(children.len());
                    for (i, child) in children.iter().enumerate() {
                        if i > 0 {
                            cy = cy.saturating_add(gap);
                        }
                        if let Node::Flex {
                            key: Some(ck),
                            measured: Some(stamp),
                            ..
                        } = child
                        {
                            if ck.starts_with("turn:") && stamp.at_w == win_w {
                                let ch = stamp.h.max(0);
                                let end_y = cy.saturating_add(ch);
                                if end_y <= win_top || cy >= win_bottom {
                                    hit_children.push(HitNode::Box {
                                        key: Some(ck.clone()),
                                        id: None,
                                        style: BoxStyle::default(),
                                        extra: HitExtra::default(),
                                        measured: Some(*stamp),
                                        children: Vec::new(),
                                    });
                                    cy = end_y;
                                    continue;
                                }
                            }
                        }
                        let ch = block_h(child, win_w);
                        let sub_win = (win_top.saturating_sub(cy), win_bottom.saturating_sub(cy), win_w);
                        hit_children.push(hits_of_window(child, Some(sub_win)));
                        cy = cy.saturating_add(ch);
                    }
                    let extra = agents_row_extra(key.as_deref());
                    return HitNode::Box {
                        key: key.clone(),
                        id: None,
                        style: BoxStyle::default(),
                        extra,
                        measured: *measured,
                        children: hit_children,
                    };
                }
            }
            box_hit(key.clone(), *measured, children)
        }
        Node::Box {
            key,
            children,
            measured,
            ..
        }
        | Node::Grid {
            key,
            children,
            measured,
            ..
        }
        | Node::Indication {
            key,
            children,
            measured,
            ..
        }
        | Node::Overlay {
            key,
            children,
            measured,
            ..
        }
        | Node::Squeeze {
            key,
            children,
            measured,
            ..
        }
        | Node::IndentationException {
            key,
            children,
            measured,
            ..
        } => box_hit(key.clone(), *measured, children),
        Node::Chrome { key, frame } => HitNode::Chrome {
            key: key.clone().unwrap_or_default(),
            frame: frame.clone(),
            body_user_select: None,
            inert: false,
        },
        Node::Markdown { .. } | Node::Diff { .. } | Node::Skipped => box_hit(None, None, &[]),
    }
}

/// A subagent mention activates. The fold stays put, and the text is not a selection.
fn stamp_mention(node: &mut HitNode) {
    match node {
        HitNode::Text { extra, .. }
        | HitNode::Box { extra, .. }
        | HitNode::Raw { extra, .. }
        | HitNode::Overlay { extra, .. }
        | HitNode::Disclosure { extra, .. } => {
            extra.intent = Some(Intent::Activate);
            extra.user_select = Some(UserSelect::None);
            extra.click = None;
        }
        HitNode::Viewport { children, .. } => {
            for child in children {
                stamp_mention(child);
            }
            return;
        }
        HitNode::Chrome { .. } => return,
    }
    match node {
        HitNode::Box { children, .. } | HitNode::Overlay { children, .. } => {
            for child in children {
                stamp_mention(child);
            }
        }
        HitNode::Disclosure {
            summary, children, ..
        } => {
            stamp_mention(summary);
            for child in children {
                stamp_mention(child);
            }
        }
        _ => {}
    }
}

fn stamp_click(node: &mut HitNode, click: &Click) {
    match node {
        HitNode::Text { extra, .. }
        | HitNode::Box { extra, .. }
        | HitNode::Raw { extra, .. }
        | HitNode::Overlay { extra, .. }
        | HitNode::Disclosure { extra, .. } => {
            if extra.click.is_none() {
                extra.click = Some(click.clone());
            }
        }
        HitNode::Viewport { children, .. } => {
            for child in children {
                stamp_click(child, click);
            }
        }
        HitNode::Chrome { .. } => {}
    }
    match node {
        HitNode::Box { children, .. } | HitNode::Overlay { children, .. } => {
            for child in children {
                stamp_click(child, click);
            }
        }
        HitNode::Disclosure {
            summary, children, ..
        } => {
            stamp_click(summary, click);
            for child in children {
                stamp_click(child, click);
            }
        }
        _ => {}
    }
}

/// Transcript text is selectable. The clock, diff gutter, and drawer text are chrome.
fn text_select(key: &Option<String>) -> HitExtra {
    let chrome = key.as_deref().is_some_and(|key| {
        key.ends_with(":stamp-text") || diff_chrome_leaf(key) || drawer_text(key)
    });
    HitExtra::select(if chrome {
        UserSelect::None
    } else {
        UserSelect::Text
    })
}

/// Open-drawer text. The closed meter is `agents:<id>` and stays selectable.
fn drawer_text(key: &str) -> bool {
    if agents_row_key(key).is_some() {
        return true;
    }
    key.starts_with("agents:") && key.bytes().all(|byte| !byte.is_ascii_digit())
}

/// `{line}:g{n}` gutter and `{line}:n{n}` numbers. The code leaf is `:t{n}`.
fn diff_chrome_leaf(key: &str) -> bool {
    let Some((_, tail)) = key.rsplit_once(':') else {
        return false;
    };
    let Some(digits) = tail.strip_prefix('g').or_else(|| tail.strip_prefix('n')) else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn box_hit(
    key: Option<String>,
    measured: Option<crate::layout_text::MeasuredStamp>,
    children: &[Node],
) -> HitNode {
    let extra = agents_row_extra(key.as_deref());
    HitNode::Box {
        key,
        id: None,
        style: BoxStyle::default(),
        extra,
        measured,
        children: children.iter().map(hits_of).collect(),
    }
}

/// Session and call rows activate. Bots do not. Child keys are not the row.
fn agents_row_extra(key: Option<&str>) -> HitExtra {
    let Some(key) = key else {
        return HitExtra::default();
    };
    let Some(row) = agents_row_key(key) else {
        return HitExtra::default();
    };
    if key != row {
        return HitExtra::default();
    }
    if row.starts_with("session:") || row.starts_with("call:") {
        return HitExtra {
            intent: Some(Intent::Activate),
            user_select: Some(UserSelect::None),
            ..HitExtra::default()
        };
    }
    if row.starts_with("bot:") {
        return HitExtra {
            user_select: Some(UserSelect::None),
            ..HitExtra::default()
        };
    }
    HitExtra::default()
}

/// Rows the tape gives up. The status line and the gap stay one row.
/// A wait pin and the rewind seat are measured, so a wrapped failure and a
/// pin stack sit above the composer.
fn screen_reserve(node: &Node) -> i64 {
    let Node::Flex {
        key,
        children,
        style,
        ..
    } = node
    else {
        return 0;
    };
    if key.as_deref() != Some("screen") {
        return 0;
    }
    let width = match style.width {
        Some(Length::Cells(cells)) => cells.max(1),
        _ => 1,
    };
    let mut total = 0i64;
    for child in children {
        if is_tape(child) {
            continue;
        }
        total = total.saturating_add(reserved_rows(child, width));
    }
    total
}

fn reserved_rows(node: &Node, width: i64) -> i64 {
    let measured = matches!(
        node_key(node),
        Some(key) if key.starts_with("work:") || key.starts_with("wait:") || key.starts_with("rewind:")
    );
    if !measured {
        return 1;
    }
    measure_tree(node, width, 10_000, None).h.max(1)
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

fn is_tape(node: &Node) -> bool {
    matches!(node, Node::Viewport { id, .. } if id == TAPE_ID)
}

fn stamp_height(node: &mut Node, window: i64) {
    match node {
        Node::Viewport { id, height, .. } if id == TAPE_ID => {
            *height = Some(Length::Cells(window));
        }
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => {}
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Disclosure { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children.iter_mut() {
                stamp_height(child, window);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint_replica::PaintReplica;

    fn wait_screen(state: &str, object: &str, status: &str) -> Node {
        let mut replica = PaintReplica::new();
        let body = format!(
            r#"{{"kind":"paint_init","epoch":"e","snapshot":{{"kind":"root","children":[{{"kind":"wait","name":"error","object":"{object}","status":"{status}","state":"{state}"}}]}}}}"#
        );
        replica.apply(body.as_bytes()).expect("apply");
        replica.frame(32).expect("frame")
    }

    #[test]
    fn a_failed_wait_pin_reserves_its_rows() {
        let mut failed = wait_screen(
            "fail",
            "completion POST https://cli-chat-proxy.grok.com/v1/chat/completions: HTTP 426 please update via grok update",
            "",
        );
        let mut live = wait_screen("live", "", "waiting for response...");
        let fail_window = fit_tape(&mut failed, 30, 4).expect("fail window");
        let live_window = fit_tape(&mut live, 30, 4).expect("live window");
        assert_eq!(live_window, 25, "a one-line pin still reserves one row");
        assert!(
            fail_window < live_window,
            "wrapped failure {fail_window} live {live_window}",
        );
    }

    #[test]
    fn scroll_to_show_block_centers_and_keeps_a_tall_top() {
        assert_eq!(scroll_to_show_block(0, 3, 10), 0);
        assert_eq!(scroll_to_show_block(20, 4, 10), 17);
        assert_eq!(scroll_to_show_block(20, 30, 10), 20);
        assert_eq!(scroll_to_show_block(5, 1, 5), 3);
    }
}

fn tape_content_height(node: &Node) -> Option<i64> {
    match node {
        Node::Viewport {
            id,
            children,
            width,
            ..
        } if id == TAPE_ID => {
            let width = match width {
                Some(Length::Cells(cells)) => (*cells).max(1),
                _ => 80,
            };
            let mut total = 0i128;
            for child in children {
                total += i128::from(measure_tree(child, width, 10_000, None).h);
            }
            Some(i64::try_from(total).unwrap_or(i64::MAX))
        }
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => None,
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Disclosure { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            children.iter().find_map(tape_content_height)
        }
    }
}

pub(crate) fn tape_node(width: i64, child: Node) -> Node {
    Node::Viewport {
        id: TAPE_ID.to_string(),
        key: Some(TAPE_ID.to_string()),
        children: vec![child],
        anchor: OverflowAnchor::None,
        scroll: 0,
        width: Some(Length::Cells(width.max(1))),
        height: None,
        measured: None,
        region_prominence: None,
    }
}

/// The host's pin stack. `prepare` drops prompts that are already on screen,
/// so the next frame puts this copy back.
pub(crate) fn rewind_seat(node: &Node) -> Option<Node> {
    let screen = screen_node(node)?;
    let Node::Flex { children, .. } = screen else {
        return None;
    };
    children
        .iter()
        .find(|child| node_key(child).is_some_and(|key| key.starts_with("rewind:")))
        .cloned()
}

pub(crate) fn install_rewind_seat(scene: &mut Node, seat: Node) {
    if node_key(scene) == Some("screen") {
        install_in_screen(scene, seat);
        return;
    }
    let Node::Box { children, .. } = scene else {
        return;
    };
    for child in children.iter_mut() {
        if node_key(child) == Some("screen") {
            install_in_screen(child, seat);
            return;
        }
    }
}

fn install_in_screen(screen: &mut Node, seat: Node) {
    let Node::Flex {
        children, measured, ..
    } = screen
    else {
        return;
    };
    if let Some(slot) = children
        .iter_mut()
        .find(|child| node_key(child).is_some_and(|key| key.starts_with("rewind:")))
    {
        *slot = seat;
    } else {
        let at = children.iter().position(is_tape).unwrap_or(children.len());
        children.insert(at, seat);
    }
    *measured = None;
}

/// Drop a pin whose prompt intersects the tape window. An empty set keeps every pin.
pub(crate) fn drop_visible_rewind_pins(scene: &mut Node, scroll: i64, window: i64) -> bool {
    if rewind_seat(scene).is_none() {
        return false;
    }
    let visible = visible_user_drafts(scene, scroll, window);
    if visible.is_empty() {
        return false;
    }
    strip_scene_pins(scene, &visible)
}

fn visible_user_drafts(scene: &Node, scroll: i64, window: i64) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Some(body) = tape_body(scene) else {
        return out;
    };
    let width = tape_width(scene).unwrap_or(80);
    walk_messages(body, 0, width, scroll, window, &mut out);
    out
}

fn tape_body(node: &Node) -> Option<&Node> {
    match node {
        Node::Viewport { id, children, .. } if id == TAPE_ID => children.first(),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => None,
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.iter().find_map(tape_body),
        Node::Disclosure {
            summary, children, ..
        } => tape_body(summary).or_else(|| children.iter().find_map(tape_body)),
    }
}

fn tape_width(node: &Node) -> Option<i64> {
    match node {
        Node::Viewport { id, width, .. } if id == TAPE_ID => Some(match width {
            Some(Length::Cells(cells)) => (*cells).max(1),
            _ => 80,
        }),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => None,
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.iter().find_map(tape_width),
        Node::Disclosure {
            summary, children, ..
        } => tape_width(summary).or_else(|| children.iter().find_map(tape_width)),
    }
}

struct Stack<'a> {
    lead: i64,
    gap: i64,
    children: &'a [Node],
}

fn vertical_stack(node: &Node) -> Option<Stack<'_>> {
    match node {
        Node::Viewport { children, .. } => Some(Stack {
            lead: 0,
            gap: 0,
            children,
        }),
        Node::Flex {
            style, children, ..
        } if style.direction == FlexDirection::Column
            || style.direction == FlexDirection::ColumnReverse =>
        {
            Some(Stack {
                lead: edge_before(style.padding),
                gap: style.gap.max(0),
                children,
            })
        }
        Node::Box {
            style, children, ..
        } => Some(Stack {
            lead: edge_before(style.padding),
            gap: 0,
            children,
        }),
        _ => None,
    }
}

fn edge_before(padding: Option<Padding>) -> i64 {
    match padding {
        Some(Padding::Uniform(n)) => n.max(0),
        Some(Padding::Edges { t, .. }) => t.unwrap_or(0).max(0),
        None => 0,
    }
}

fn walk_messages(
    node: &Node,
    y: i64,
    width: i64,
    scroll: i64,
    window: i64,
    out: &mut BTreeSet<String>,
) {
    if let Node::Chrome {
        key: Some(key),
        frame,
    } = node
    {
        if key.ends_with(":recap") || key.ends_with(":rewind") {
            let h = block_h(node, width);
            if h > 0 && y < scroll.saturating_add(window) && y.saturating_add(h) > scroll {
                out.insert(compact_pin_draft(&frame.draft));
            }
            return;
        }
    }
    let Some(stack) = vertical_stack(node) else {
        return;
    };
    let bottom = scroll.saturating_add(window);
    let mut cy = y.saturating_add(stack.lead);
    for (i, child) in stack.children.iter().enumerate() {
        if i > 0 {
            cy = cy.saturating_add(stack.gap);
        }
        let h = block_h(child, width);
        if cy.saturating_add(h) > scroll && cy < bottom {
            walk_messages(child, cy, width, scroll, window, out);
        }
        cy = cy.saturating_add(h);
    }
}

fn block_h(node: &Node, width: i64) -> i64 {
    measure_tree(node, width.max(1), 10_000, None).h.max(0)
}

fn screen_node(node: &Node) -> Option<&Node> {
    if node_key(node) == Some("screen") {
        return Some(node);
    }
    let Node::Box { children, .. } = node else {
        return None;
    };
    children
        .iter()
        .find(|child| node_key(child) == Some("screen"))
}

fn strip_scene_pins(scene: &mut Node, visible: &BTreeSet<String>) -> bool {
    if node_key(scene) == Some("screen") {
        return strip_screen(scene, visible);
    }
    let Node::Box { children, .. } = scene else {
        return false;
    };
    for child in children.iter_mut() {
        if node_key(child) == Some("screen") {
            return strip_screen(child, visible);
        }
    }
    false
}

fn strip_screen(screen: &mut Node, visible: &BTreeSet<String>) -> bool {
    let Node::Flex {
        children, measured, ..
    } = screen
    else {
        return false;
    };
    let mut removed = false;
    let mut next = Vec::new();
    for mut child in children.drain(..) {
        if node_key(&child).is_some_and(|key| key.starts_with("rewind:")) {
            if strip_rewind(&mut child, visible) {
                removed = true;
            }
            if rewind_empty(&child) {
                removed = true;
                continue;
            }
        }
        next.push(child);
    }
    *children = next;
    if removed {
        *measured = None;
    }
    removed
}

fn strip_rewind(node: &mut Node, visible: &BTreeSet<String>) -> bool {
    let Node::Flex {
        children,
        key,
        measured,
        ..
    } = node
    else {
        return false;
    };
    if !key.as_deref().unwrap_or("").starts_with("rewind:") {
        return false;
    }
    let mut removed = false;
    let mut next = Vec::new();
    for mut child in children.drain(..) {
        if node_key(&child).is_some_and(|key| key.starts_with("rewind:")) {
            if strip_rewind(&mut child, visible) {
                removed = true;
            }
            if rewind_empty(&child) {
                removed = true;
                continue;
            }
            next.push(child);
            continue;
        }
        if pin_visible(&child, visible) {
            removed = true;
            continue;
        }
        next.push(child);
    }
    *children = next;
    if removed {
        *measured = None;
    }
    removed
}

fn rewind_empty(node: &Node) -> bool {
    matches!(node, Node::Flex { children, .. } if children.is_empty())
}

fn pin_visible(node: &Node, visible: &BTreeSet<String>) -> bool {
    let Node::Box { children, .. } = node else {
        return false;
    };
    children.iter().any(|child| match child {
        Node::Chrome { frame, .. } => visible.contains(&frame.draft),
        _ => false,
    })
}
