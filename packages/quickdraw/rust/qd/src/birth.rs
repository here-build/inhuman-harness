//! Opacity wavefront for a thought that is still arriving.
//!
//! [`stamp_stream_birth`] marks the newest text line. Older lines stay plain.

use crate::display_width;
use crate::layout_engine::{LivePaint, Node};
use crate::layout_flex::FlexDirection;

pub const WAVEFRONT_FALLOFF: f64 = 0.8;
pub const TIP_WINDOW: f64 = 12.0;
pub const BIRTH_FLOOR: f64 = 0.0;
pub const EDGE_WIDTH: f64 = 1.0;
pub const BASE_COLS_PER_SEC: f64 = 8.0;
pub const GAP_GAIN: f64 = 2.4;
pub const MAX_COLS_PER_SEC: f64 = 96.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BirthFrontier {
    pub w: f64,
    pub t: f64,
    pub last_step_ms: Option<f64>,
    pub sealed: bool,
    pub last_advance_ms: Option<f64>,
    pub v: f64,
}

pub fn create_birth_frontier() -> BirthFrontier {
    BirthFrontier {
        w: 0.0,
        t: 0.0,
        last_step_ms: None,
        sealed: false,
        last_advance_ms: None,
        v: 0.0,
    }
}

pub fn birth_frontier_live(state: &BirthFrontier) -> bool {
    state.t > 0.0 && state.w + 1e-6 < state.t
}

pub fn wavefront_speed(gap: f64) -> f64 {
    let g = gap.max(0.0);
    (BASE_COLS_PER_SEC + GAP_GAIN * g).clamp(0.0, MAX_COLS_PER_SEC)
}

pub fn wavefront_prominence(pos: f64, w: f64, t: f64, target_p: f64) -> f64 {
    let target = clamp01(target_p);
    let floor = clamp01(BIRTH_FLOOR);
    if t <= 0.0 {
        return target;
    }
    if w >= t - 1e-9 {
        return target;
    }
    let wave = w.max(0.0);
    let dist = pos - wave;
    if dist <= 0.0 {
        let edge_w = EDGE_WIDTH.max(1e-6);
        if dist <= -edge_w {
            return target;
        }
        let into_solid = -dist / edge_w;
        let blend = smoothstep01(into_solid);
        let at_edge = floor.max(target);
        return target * blend + at_edge * (1.0 - blend);
    }
    let base = 0.999_f64.min(WAVEFRONT_FALLOFF.max(1e-6));
    let raw = target * base.powf(dist);
    floor.max(target.min(raw))
}

pub fn step_birth_frontier(
    state: &BirthFrontier,
    t: f64,
    now_ms: f64,
    sealed: bool,
) -> BirthFrontier {
    let t = t.max(0.0);
    let sealed = sealed || state.sealed;
    let mut w = state.w;
    let mut v = state.v;
    let mut last_advance_ms = state.last_advance_ms;
    let tip_grew = t > state.t + 1e-9;
    let tip_shrunk = t < state.t - 1e-9;
    if tip_grew || last_advance_ms.is_none() {
        last_advance_ms = Some(now_ms);
    }
    if tip_shrunk {
        w = 0.0;
    }
    let frozen = sealed || !tip_grew;
    let lag = if frozen || t <= TIP_WINDOW {
        0.0
    } else {
        TIP_WINDOW
    };
    let aim = (t - lag).max(0.0);
    if state.last_step_ms.is_none() {
        w = if sealed { t } else { (t - TIP_WINDOW).max(0.0) };
        v = wavefront_speed(t - w);
    } else {
        let previous = state.last_step_ms.unwrap_or(now_ms);
        let dt_sec = ((now_ms - previous) / 1000.0).clamp(0.0, 0.25);
        if (!frozen && aim > w) || v <= 0.0 {
            v = wavefront_speed(t - w);
        }
        if dt_sec > 0.0 && aim > w {
            w = aim.min(w + v * dt_sec);
        }
    }
    w = w.clamp(0.0, t);
    let snap = if sealed { 0.5 } else { 0.15 };
    if t - w < snap {
        w = t;
    }
    BirthFrontier {
        w,
        t,
        last_step_ms: Some(now_ms),
        sealed,
        last_advance_ms,
        v,
    }
}

fn smoothstep01(t: f64) -> f64 {
    let x = t.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Birth live on the newest visual row. An empty tree is unchanged.
pub fn stamp_stream_birth(mut node: Node, site_id: &str) -> Node {
    let paths = last_line_paths(&node);
    if paths.is_empty() {
        return node;
    }
    let widths: Vec<i64> = paths
        .iter()
        .map(|path| match node_at(&node, path) {
            Node::Text { content, .. } => display_width(content) as i64,
            _ => 0,
        })
        .collect();
    let t: i64 = widths.iter().sum();
    if t <= 0 {
        return node;
    }
    let mut offset = 0i64;
    for (path, width) in paths.iter().zip(widths) {
        if let Node::Text { live, .. } = node_at_mut(&mut node, path) {
            *live = Some(LivePaint::Birth {
                hz: 0,
                t,
                offset,
                site_id: site_id.to_string(),
            });
        }
        offset += width;
    }
    node
}

fn last_line_paths(node: &Node) -> Vec<Vec<usize>> {
    match node {
        Node::Text { content, .. } => {
            if content.trim().is_empty() {
                Vec::new()
            } else {
                vec![Vec::new()]
            }
        }
        Node::Flex { style, .. } if is_row(style.direction) => row_paths(node),
        _ => {
            let count = child_count(node);
            let mut index = count;
            while index > 0 {
                index -= 1;
                let Some(child) = child_ref(node, index) else {
                    continue;
                };
                let paths = last_line_paths(child);
                if paths.is_empty() {
                    continue;
                }
                return paths
                    .into_iter()
                    .map(|mut path| {
                        path.insert(0, index);
                        path
                    })
                    .collect();
            }
            Vec::new()
        }
    }
}

fn row_paths(node: &Node) -> Vec<Vec<usize>> {
    let mut out = Vec::new();
    let count = child_count(node);
    for index in 0..count {
        let Some(child) = child_ref(node, index) else {
            continue;
        };
        for mut path in all_text_paths(child) {
            path.insert(0, index);
            out.push(path);
        }
    }
    out
}

fn all_text_paths(node: &Node) -> Vec<Vec<usize>> {
    match node {
        Node::Text { content, .. } => {
            if content.trim().is_empty() {
                Vec::new()
            } else {
                vec![Vec::new()]
            }
        }
        _ => {
            let mut out = Vec::new();
            for index in 0..child_count(node) {
                let Some(child) = child_ref(node, index) else {
                    continue;
                };
                for mut path in all_text_paths(child) {
                    path.insert(0, index);
                    out.push(path);
                }
            }
            out
        }
    }
}

fn is_row(direction: FlexDirection) -> bool {
    matches!(direction, FlexDirection::Row | FlexDirection::RowReverse)
}

fn child_count(node: &Node) -> usize {
    match node {
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.len(),
        Node::Disclosure { children, .. } => children.len() + 1,
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => 0,
    }
}

fn child_ref(node: &Node, index: usize) -> Option<&Node> {
    match node {
        Node::Disclosure {
            summary, children, ..
        } => {
            if index == 0 {
                Some(summary)
            } else {
                children.get(index - 1)
            }
        }
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.get(index),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => None,
    }
}

fn child_mut(node: &mut Node, index: usize) -> Option<&mut Node> {
    match node {
        Node::Disclosure {
            summary, children, ..
        } => {
            if index == 0 {
                Some(summary)
            } else {
                children.get_mut(index - 1)
            }
        }
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.get_mut(index),
        Node::Text { .. }
        | Node::Markdown { .. }
        | Node::Diff { .. }
        | Node::Chrome { .. }
        | Node::Skipped => None,
    }
}

fn node_at<'a>(node: &'a Node, path: &[usize]) -> &'a Node {
    let mut cursor = node;
    for index in path {
        cursor = child_ref(cursor, *index).expect("stamp path");
    }
    cursor
}

fn node_at_mut<'a>(node: &'a mut Node, path: &[usize]) -> &'a mut Node {
    let mut cursor = node;
    for index in path {
        cursor = child_mut(cursor, *index).expect("stamp path");
    }
    cursor
}

fn clamp01(n: f64) -> f64 {
    if !n.is_finite() {
        1.0
    } else {
        n.clamp(0.0, 1.0)
    }
}
