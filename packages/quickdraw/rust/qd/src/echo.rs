//! Speculative composer echo.
//!
//! A printable key rewrites the draft on screen. Enter, Escape, and Tab drop
//! a standing prediction: those keys belong to the worker. A backspace or
//! delete that changes nothing leaves the prediction alone. The worker's
//! draft clears the prediction; a mismatch snaps, it does not replay.

use serde_json::Value;

use unicode_segmentation::UnicodeSegmentation;

use crate::display_width;
use crate::draft::{apply_draft_op, DraftOp, DraftState, KillMode, Motion};
use crate::layout_chrome::chrome_frame_text_width;
use crate::layout_text::{wrap_text, WhiteSpace, WrapOpts};

#[derive(Clone, Copy)]
pub struct EchoKey<'a> {
    pub key: &'a str,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EchoState {
    pub predicted: Option<DraftState>,
    pub misaligned: bool,
}

impl EchoState {
    pub fn empty() -> Self {
        Self {
            predicted: None,
            misaligned: false,
        }
    }
}

pub fn predict(
    echo: &EchoState,
    current: &DraftState,
    key: EchoKey<'_>,
    outer_width: i64,
) -> EchoState {
    if let Some((cursor, mark)) = parse_composer_caret(key.key) {
        let base = echo.predicted.clone().unwrap_or_else(|| current.clone());
        let cursor = i64::try_from(cursor).unwrap_or(i64::MAX);
        let mark = mark.and_then(|mark| i64::try_from(mark).ok());
        return EchoState {
            predicted: Some(DraftState::new(base.draft, cursor, mark)),
            misaligned: false,
        };
    }
    let mapped = key_to_op(key);
    if mapped.is_none() {
        if echo.predicted.is_none() && !echo.misaligned {
            return echo.clone();
        }
        return EchoState {
            predicted: None,
            misaligned: false,
        };
    }
    let Some(op) = mapped else {
        return echo.clone();
    };
    let base = echo.predicted.clone().unwrap_or_else(|| current.clone());
    let op = visual_motion(&op, &base, outer_width);
    let next = apply_draft_op(&base, &op);
    if matches!(op, DraftOp::Backspace | DraftOp::Delete)
        && next.draft == base.draft
        && next.cursor == base.cursor
        && next.mark == base.mark
    {
        return echo.clone();
    }
    EchoState {
        predicted: Some(next),
        misaligned: false,
    }
}

pub fn reconcile(echo: &EchoState, incoming: &DraftState) -> EchoState {
    let Some(predicted) = &echo.predicted else {
        return if echo.misaligned {
            EchoState::empty()
        } else {
            echo.clone()
        };
    };
    let misaligned = predicted.draft != incoming.draft
        || predicted.cursor != incoming.cursor
        || predicted.mark != incoming.mark;
    EchoState {
        predicted: None,
        misaligned,
    }
}

fn key_to_op(key: EchoKey<'_>) -> Option<DraftOp> {
    if key.meta {
        return None;
    }
    if key.key == "Undo" || key.key == "Redo" {
        return None;
    }
    if key.key == "SelectAll" {
        return Some(DraftOp::SelectAll);
    }
    if let Some(text) = parse_paste(&key.key) {
        if text.is_empty() {
            return None;
        }
        return Some(DraftOp::Insert { text });
    }
    if key.key == "Backspace" && key.alt {
        return Some(DraftOp::Kill {
            mode: KillMode::Word,
        });
    }
    if key.key == "KillLineStart" || (key.ctrl && key.key == "u") {
        return Some(DraftOp::Kill {
            mode: KillMode::ToStart,
        });
    }
    if key.key == "KillLineEnd" || (key.ctrl && key.key == "k") {
        return Some(DraftOp::Kill {
            mode: KillMode::ToEnd,
        });
    }
    if key.key == "Backspace" && !key.ctrl {
        return Some(DraftOp::Backspace);
    }
    if key.key == "Delete" && !key.ctrl {
        return Some(DraftOp::Delete);
    }
    let select = key.shift;
    if key.key == "ArrowLeft" {
        let to = if key.alt || key.ctrl {
            Motion::WordLeft
        } else {
            Motion::Left
        };
        return Some(DraftOp::Move { to, select });
    }
    if key.key == "ArrowRight" {
        let to = if key.alt || key.ctrl {
            Motion::WordRight
        } else {
            Motion::Right
        };
        return Some(DraftOp::Move { to, select });
    }
    if key.key == "ArrowUp" {
        return Some(DraftOp::Move {
            to: Motion::LineUp,
            select,
        });
    }
    if key.key == "ArrowDown" {
        return Some(DraftOp::Move {
            to: Motion::LineDown,
            select,
        });
    }
    if key.key == "Home" && !key.ctrl {
        return Some(DraftOp::Move {
            to: Motion::Home,
            select,
        });
    }
    if key.key == "End" && !key.ctrl {
        return Some(DraftOp::Move {
            to: Motion::End,
            select,
        });
    }
    if key.key == "Enter" && key.shift && !key.ctrl {
        return Some(DraftOp::Insert {
            text: "\n".to_string(),
        });
    }
    if key.ctrl || key.key == "Tab" || key.key == "Enter" || key.key == "Escape" {
        return None;
    }
    if is_printable(&key.key) {
        return Some(DraftOp::Insert {
            text: key.key.to_string(),
        });
    }
    None
}

/// Insert, paste, backspace, delete, and kill replace a standing range.
pub(crate) fn is_range_edit(key: EchoKey<'_>) -> bool {
    matches!(
        key_to_op(key),
        Some(DraftOp::Insert { .. } | DraftOp::Backspace | DraftOp::Delete | DraftOp::Kill { .. })
    )
}

/// `ComposerCaret:<utf16 cursor>:<utf16 mark or n>`. The host applies this
/// before a range edit, so the numbers are JavaScript caret units.
fn parse_composer_caret(key: &str) -> Option<(usize, Option<usize>)> {
    let rest = key.strip_prefix("ComposerCaret:")?;
    let (cursor, mark) = rest.split_once(':')?;
    if mark.contains(':') {
        return None;
    }
    let cursor = cursor.parse().ok()?;
    let mark = if mark == "n" {
        None
    } else {
        Some(mark.parse().ok()?)
    };
    Some((cursor, mark))
}

fn is_printable(key: &str) -> bool {
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) => ch >= ' ',
        _ => false,
    }
}

pub(crate) fn parse_paste(key: &str) -> Option<String> {
    let rest = key.strip_prefix("Paste:")?;
    match serde_json::from_str::<Value>(rest).ok()? {
        Value::String(text) => Some(text),
        _ => None,
    }
}

fn visual_motion(op: &DraftOp, state: &DraftState, outer_width: i64) -> DraftOp {
    let DraftOp::Move { to, select } = op else {
        return op.clone();
    };
    let text_w = chrome_frame_text_width(outer_width);
    if text_w <= 0 {
        return op.clone();
    }
    let visual = match to {
        Motion::LineUp => "line_up",
        Motion::LineDown => "line_down",
        Motion::Home => "line_home",
        Motion::End => "line_end",
        _ => return op.clone(),
    };
    let from = if *select {
        state.cursor
    } else if let Some(mark) = state.mark {
        let (start, end) = if mark < state.cursor {
            (mark, state.cursor)
        } else {
            (state.cursor, mark)
        };
        if visual == "line_up" || visual == "line_home" {
            start
        } else {
            end
        }
    } else {
        state.cursor
    };
    let cursor = move_visual(&state.draft, from, text_w, visual);
    DraftOp::SetCaret {
        cursor,
        mark: if *select {
            Some(state.mark.unwrap_or(state.cursor))
        } else {
            None
        },
    }
}

struct Line {
    start: usize,
    end: usize,
    text: String,
}

fn visual_lines(draft: &str, text_w: i64) -> Vec<Line> {
    if draft.is_empty() {
        return vec![Line {
            start: 0,
            end: 0,
            text: String::new(),
        }];
    }
    let mut out = Vec::new();
    let mut pos = 0usize;
    let hard: Vec<&str> = draft.split('\n').collect();
    for (index, hard_line) in hard.iter().enumerate() {
        let mut opts = WrapOpts::new(text_w);
        opts.white_space = WhiteSpace::PreWrap;
        opts.ellipsis = Some(false);
        let soft = wrap_text(hard_line, &opts);
        let mut hard_pos = 0usize;
        if soft.is_empty() {
            out.push(Line {
                start: pos,
                end: pos,
                text: String::new(),
            });
        }
        for line in soft {
            let start = pos + hard_pos;
            hard_pos += line.len();
            out.push(Line {
                start,
                end: start + line.len(),
                text: line,
            });
        }
        pos += hard_line.len();
        if index + 1 < hard.len() {
            pos += 1;
        }
    }
    if out.is_empty() {
        out.push(Line {
            start: 0,
            end: 0,
            text: String::new(),
        });
    }
    out
}

fn move_visual(draft: &str, cursor: usize, text_w: i64, motion: &str) -> usize {
    let lines = visual_lines(draft, text_w);
    let cursor = cursor.min(draft.len());
    let index = visual_index(&lines, cursor, text_w);
    if index >= lines.len() {
        return match motion {
            "line_up" => lines.last().map(|line| line.start).unwrap_or(cursor),
            _ => cursor,
        };
    }
    let line = &lines[index];
    match motion {
        "line_home" => line.start,
        "line_end" => line.end,
        "line_up" => {
            if index == 0 {
                return cursor;
            }
            let col = display_width(&draft[line.start..cursor.min(line.end)]);
            offset_at_col(draft, &lines[index - 1], col)
        }
        "line_down" => {
            if index + 1 >= lines.len() {
                return cursor;
            }
            let col = display_width(&draft[line.start..cursor.min(line.end)]);
            offset_at_col(draft, &lines[index + 1], col)
        }
        _ => cursor,
    }
}

fn visual_index(lines: &[Line], cursor: usize, text_w: i64) -> usize {
    for (index, line) in lines.iter().enumerate() {
        if cursor >= line.start && cursor <= line.end {
            if cursor == line.end {
                if let Some(next) = lines.get(index + 1) {
                    if next.start == cursor {
                        continue;
                    }
                }
                if index + 1 == lines.len()
                    && display_width(&line.text) >= usize::try_from(text_w.max(0)).unwrap_or(0)
                {
                    return lines.len();
                }
            }
            return index;
        }
    }
    lines.len().saturating_sub(1)
}

fn offset_at_col(draft: &str, line: &Line, target: usize) -> usize {
    if target == 0 {
        return line.start;
    }
    let mut col = 0usize;
    let mut offset = line.start;
    for grapheme in draft[line.start..line.end].graphemes(true) {
        let width = display_width(grapheme);
        if col + width > target {
            return offset;
        }
        col += width;
        offset += grapheme.len();
        if col >= target {
            return offset;
        }
    }
    line.end
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft::line_up;

    fn bare<'a>(key: &'a str) -> EchoKey<'a> {
        EchoKey {
            key,
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        }
    }

    fn draft(text: &str) -> DraftState {
        DraftState::new(text, text.len() as i64, None)
    }

    fn predicted(echo: &EchoState) -> Option<DraftState> {
        echo.predicted.clone()
    }

    #[test]
    fn predict_matches_the_echo_table() {
        let base = EchoState::empty();
        assert_eq!(
            predicted(&predict(&base, &draft(""), bare("a"), 40)),
            Some(draft("a"))
        );
        let chained = predict(
            &predict(&base, &draft(""), bare("a"), 40),
            &draft(""),
            bare("b"),
            40,
        );
        assert_eq!(predicted(&chained), Some(draft("ab")));
        assert_eq!(
            predicted(&predict(&base, &draft("hi"), bare("Backspace"), 40)),
            Some(draft("h"))
        );
        assert_eq!(
            predicted(&predict(&base, &draft("hi"), bare("Enter"), 40)),
            None
        );
        let standing = predict(&base, &draft(""), bare("a"), 40);
        assert_eq!(
            predicted(&predict(&standing, &draft("a"), bare("Tab"), 40)),
            None
        );
        assert_eq!(
            predicted(&predict(&standing, &draft("a"), bare("Enter"), 40)),
            None
        );
        assert_eq!(
            predicted(&predict(&base, &draft("hi"), bare("Escape"), 40)),
            None
        );
        let ctrl = EchoKey {
            key: "c",
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
        };
        assert_eq!(predicted(&predict(&base, &draft("hi"), ctrl, 40)), None);
        assert_eq!(
            predicted(&predict(&base, &draft("hi"), bare("Undo"), 40)),
            None
        );
        assert_eq!(
            predicted(&predict(&base, &draft("hi"), bare("Redo"), 40)),
            None
        );
        let paste = bare("Paste:\"ab\\nc\"");
        assert_eq!(
            predicted(&predict(&base, &draft(""), paste, 40)),
            Some(draft("ab\nc"))
        );
        assert_eq!(
            predicted(&predict(&base, &draft(""), bare("Backspace"), 40)),
            None
        );
        let selected = DraftState::new("hello", 5, Some(0));
        assert_eq!(
            predicted(&predict(&base, &selected, bare("x"), 40))
                .as_ref()
                .map(|s| s.draft.as_str()),
            Some("x")
        );
        assert_eq!(
            predicted(&predict(&base, &selected, bare("Backspace"), 40))
                .as_ref()
                .map(|s| s.draft.as_str()),
            Some("")
        );
        assert_eq!(
            predicted(&predict(&base, &selected, bare("Delete"), 40))
                .as_ref()
                .map(|s| s.draft.as_str()),
            Some("")
        );
        let paste_over = bare("Paste:\"z\"");
        assert_eq!(
            predicted(&predict(&base, &selected, paste_over, 40))
                .as_ref()
                .map(|s| s.draft.as_str()),
            Some("z")
        );
        let arrows =
            predicted(&predict(&base, &draft("ab"), bare("ArrowLeft"), 40)).expect("arrow");
        assert_eq!(
            (arrows.draft.as_str(), arrows.cursor, arrows.mark),
            ("ab", 1, None)
        );
        let collapse =
            predicted(&predict(&base, &selected, bare("ArrowLeft"), 40)).expect("collapse");
        assert_eq!((collapse.cursor, collapse.mark), (0, None));
        let collapse_right =
            predicted(&predict(&base, &selected, bare("ArrowRight"), 40)).expect("right");
        assert_eq!((collapse_right.cursor, collapse_right.mark), (5, None));
        let all = predicted(&predict(&base, &draft("hello"), bare("SelectAll"), 40)).expect("all");
        assert_eq!(
            (all.draft.as_str(), all.cursor, all.mark),
            ("hello", 5, Some(0))
        );
        let caret = bare("ComposerCaret:5:0");
        let marked = predicted(&predict(&base, &draft("hello"), caret, 40)).expect("caret");
        assert_eq!((marked.cursor, marked.mark), (5, Some(0)));
        let cleared =
            predicted(&predict(&base, &marked, bare("ComposerCaret:5:n"), 40)).expect("clear");
        assert_eq!((cleared.cursor, cleared.mark), (5, None));
        let wide = DraftState::new("йц", 2, None);
        let head = predicted(&predict(&base, &wide, bare("ComposerCaret:1:0"), 40)).expect("wide");
        assert_eq!(head.draft.as_str(), "йц");
        assert_eq!((head.mark, head.cursor), (Some(0), "й".len()));
    }

    #[test]
    fn reconcile_snaps_when_the_worker_disagrees() {
        let speculated = predict(&EchoState::empty(), &draft(""), bare("z"), 40);
        let disagree = reconcile(&speculated, &draft("a"));
        assert!(disagree.predicted.is_none() && disagree.misaligned);
        let matched = reconcile(&speculated, &draft("z"));
        assert!(matched.predicted.is_none() && !matched.misaligned);
    }

    #[test]
    fn wrapped_arrow_up_stays_on_the_long_line() {
        let text = format!("short\n{}", "x".repeat(80));
        let state = draft(&text);
        let visual =
            predicted(&predict(&EchoState::empty(), &state, bare("ArrowUp"), 40)).expect("visual");
        let hard = line_up(&state.draft, state.cursor);
        let boundary = "short\n".len();
        assert!(visual.cursor > boundary);
        assert!(hard <= boundary);
    }
}
