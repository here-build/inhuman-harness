//! Mailbox structure plus box values, as one layout tree.
//!
//! A structure names slots. `box_set` fills a slot. A missing box stays an
//! empty slot so a later value does not jump the layout. A tree that is not
//! `{ root, boxes }` is no scene: the caller paints a blank frame and does
//! not throw. `paintReady` nodes are copied as they are.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::layout_chrome::{
    chrome_frame_paint_ops, measure_chrome_frame, ChromeFrame, ChromePaintOp, Rect as ChromeRect,
};
use crate::layout_engine::{BoxStyle, Node};
use crate::layout_flex::{FlexDirection, FlexStyle, Length};
use crate::layout_text::WhiteSpace;
use crate::present::Mailbox;
use crate::Style;

/// The layout root for `mailbox`, or nothing when the tree is not a structure.
pub(crate) fn scene_from_mailbox(mailbox: &Mailbox, cols: i64) -> Option<Node> {
    let raw = mailbox.tree()?;
    let value: Value = serde_json::from_str(raw).ok()?;
    let root = value.get("root")?;
    let slots = slot_map(value.get("boxes")?)?;
    walk(root, &slots, mailbox.boxes(), cols, true)
}

fn slot_map(value: &Value) -> Option<BTreeMap<String, i64>> {
    let object = value.as_object()?;
    let mut slots = BTreeMap::new();
    for (key, id) in object {
        let Some(id) = id.as_i64() else {
            continue;
        };
        slots.insert(key.clone(), id);
    }
    Some(slots)
}

fn walk(
    value: &Value,
    slots: &BTreeMap<String, i64>,
    boxes: &BTreeMap<i64, String>,
    cols: i64,
    substitute: bool,
) -> Option<Node> {
    let object = value.as_object()?;
    let locked = object.get("paintReady").and_then(Value::as_bool) == Some(true);
    let substitute = substitute && !locked;
    if substitute {
        if let Some(key) = object.get("key").and_then(Value::as_str) {
            if let Some(id) = slots.get(key) {
                let child = boxes.get(id).and_then(|raw| {
                    let parsed: Value = serde_json::from_str(raw).ok()?;
                    walk(&parsed, slots, boxes, cols, true)
                });
                return kind_node(object, child.into_iter().collect(), cols);
            }
        }
    }
    let children = object
        .get("children")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|child| walk(child, slots, boxes, cols, substitute))
                .collect()
        })
        .unwrap_or_default();
    kind_node(object, children, cols)
}

fn kind_node(
    object: &serde_json::Map<String, Value>,
    children: Vec<Node>,
    cols: i64,
) -> Option<Node> {
    let key = object
        .get("key")
        .and_then(Value::as_str)
        .map(str::to_string);
    match object.get("type").and_then(Value::as_str)? {
        "text" => Some(text_node(
            key,
            object.get("content").and_then(Value::as_str).unwrap_or(""),
        )),
        "box" => Some(Node::Box {
            style: BoxStyle::default(),
            children,
            key,
            id: None,
            measured: None,
            region_prominence: None,
        }),
        "flex" => {
            let direction = object
                .get("style")
                .and_then(|style| style.get("direction"))
                .and_then(Value::as_str);
            Some(Node::Flex {
                style: FlexStyle {
                    direction: flex_direction(direction),
                    width: Some(Length::Cells(cols.max(1))),
                    ..FlexStyle::default()
                },
                children,
                key,
                measured: None,
                region_prominence: None,
            })
        }
        "chrome_frame" => {
            let width = object
                .get("width")
                .and_then(Value::as_i64)
                .unwrap_or(cols)
                .max(4);
            let draft = object.get("draft").and_then(Value::as_str).unwrap_or("");
            Some(chrome_lines(key, width, draft))
        }
        _ => None,
    }
}

fn flex_direction(name: Option<&str>) -> FlexDirection {
    match name {
        Some("column") => FlexDirection::Column,
        Some("row-reverse") => FlexDirection::RowReverse,
        Some("column-reverse") => FlexDirection::ColumnReverse,
        _ => FlexDirection::Row,
    }
}

fn text_node(key: Option<String>, content: &str) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space: Some(WhiteSpace::Nowrap),
        ellipsis: None,
        line_clamp: None,
        measured: None,
        style: Style::default(),
        key,
        live: None,
        region_prominence: None,
    }
}

/// The chrome frame's painted rows, as text. The layout walk has no chrome node.
fn chrome_lines(key: Option<String>, width: i64, draft: &str) -> Node {
    let frame = ChromeFrame::new(width, draft);
    let geom = measure_chrome_frame(&frame, width, 10_000);
    let height = usize::try_from(geom.total_h.max(0)).unwrap_or(0);
    let paint = chrome_frame_paint_ops(
        &frame,
        ChromeRect::new(0, 0, geom.outer_w, geom.total_h.max(1)),
    );
    let mut rows = vec![String::new(); height];
    for op in &paint.ops {
        let ChromePaintOp::Text { rect, lines, .. } = op else {
            continue;
        };
        for (index, line) in lines.iter().enumerate() {
            let Some(y) = i64::try_from(index)
                .ok()
                .and_then(|dy| rect.y.checked_add(dy))
            else {
                continue;
            };
            let Ok(y) = usize::try_from(y) else {
                continue;
            };
            let Some(row) = rows.get_mut(y) else {
                continue;
            };
            let at = usize::try_from(rect.x.max(0)).unwrap_or(0);
            overlay(row, at, line);
        }
    }
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Column,
            width: Some(Length::Cells(width)),
            ..FlexStyle::default()
        },
        children: rows
            .into_iter()
            .map(|line| text_node(None, &line))
            .collect(),
        key,
        measured: None,
        region_prominence: None,
    }
}

fn overlay(row: &mut String, at: usize, text: &str) {
    let mut chars: Vec<char> = row.chars().collect();
    if chars.len() < at {
        chars.resize(at, ' ');
    }
    for (index, ch) in text.chars().enumerate() {
        let pos = at + index;
        if pos < chars.len() {
            chars[pos] = ch;
        } else {
            chars.push(ch);
        }
    }
    *row = chars.into_iter().collect();
}
