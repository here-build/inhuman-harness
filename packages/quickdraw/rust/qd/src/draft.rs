//! Caret and selection on a composer draft.
//!
//! A [`DraftState`] stores byte indexes on a char boundary. [`DraftState::new`]
//! takes the host caret, a JavaScript UTF-16 index, and converts it. Motion
//! steps by grapheme. Insert and paste replace a non-empty selection.

use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftState {
    pub draft: String,
    pub cursor: usize,
    pub mark: Option<usize>,
}

impl DraftState {
    pub fn new(draft: impl Into<String>, cursor: i64, mark: Option<i64>) -> Self {
        let draft = draft.into();
        let cursor = clamp_i64(&draft, cursor);
        let mark = mark.map(|mark| clamp_i64(&draft, mark));
        normalize(Self {
            draft,
            cursor,
            mark,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DraftOp {
    Insert { text: String },
    Backspace,
    Delete,
    Kill { mode: KillMode },
    Move { to: Motion, select: bool },
    SelectAll,
    SetCaret { cursor: usize, mark: Option<usize> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KillMode {
    Word,
    ToStart,
    ToEnd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    Left,
    Right,
    Home,
    End,
    WordLeft,
    WordRight,
    LineUp,
    LineDown,
}

pub fn apply_draft_op(state: &DraftState, op: &DraftOp) -> DraftState {
    match op {
        DraftOp::Insert { text } => insert(state, text),
        DraftOp::Backspace => backspace(state),
        DraftOp::Delete => delete(state),
        DraftOp::Kill { mode } => kill(state, *mode),
        DraftOp::Move { to, select } => move_draft(state, *to, *select),
        DraftOp::SelectAll => select_all(state),
        DraftOp::SetCaret { cursor, mark } => {
            let n = normalize(state.clone());
            let cursor = clamp(&n.draft, *cursor);
            let mark = mark.map(|mark| clamp(&n.draft, mark));
            normalize(DraftState {
                draft: n.draft,
                cursor,
                mark,
            })
        }
    }
}

fn normalize(state: DraftState) -> DraftState {
    let cursor = clamp(&state.draft, state.cursor);
    let mark = state.mark.map(|mark| clamp(&state.draft, mark));
    DraftState {
        draft: state.draft,
        cursor,
        mark: mark.filter(|mark| *mark != cursor),
    }
}

fn clamp(draft: &str, cursor: usize) -> usize {
    draft.floor_char_boundary(cursor.min(draft.len()))
}

fn clamp_i64(draft: &str, cursor: i64) -> usize {
    if cursor <= 0 {
        return 0;
    }
    let Ok(cursor) = usize::try_from(cursor) else {
        return draft.len();
    };
    byte_at_utf16(draft, cursor)
}

/// UTF-16 length of `text` up to a byte caret. The host caret is this unit.
pub(crate) fn utf16_index(text: &str, byte: usize) -> usize {
    let byte = text.floor_char_boundary(byte.min(text.len()));
    text[..byte].chars().map(char::len_utf16).sum()
}

/// Byte index of a JavaScript UTF-16 caret. A unit that would split a scalar
/// lands on that scalar.
fn byte_at_utf16(text: &str, index: usize) -> usize {
    let mut seen = 0usize;
    for (byte, ch) in text.char_indices() {
        if index <= seen {
            return byte;
        }
        let next = seen + ch.len_utf16();
        if index < next {
            return byte;
        }
        seen = next;
    }
    text.len()
}

fn selection(state: &DraftState) -> Option<(usize, usize)> {
    let state = normalize(state.clone());
    let mark = state.mark?;
    let (start, end) = if mark < state.cursor {
        (mark, state.cursor)
    } else {
        (state.cursor, mark)
    };
    (start < end).then_some((start, end))
}

fn insert(state: &DraftState, text: &str) -> DraftState {
    let state = normalize(state.clone());
    if let Some((start, end)) = selection(&state) {
        let mut draft = String::new();
        draft.push_str(&state.draft[..start]);
        draft.push_str(text);
        draft.push_str(&state.draft[end..]);
        return DraftState {
            cursor: start + text.len(),
            draft,
            mark: None,
        };
    }
    let mut draft = String::new();
    draft.push_str(&state.draft[..state.cursor]);
    draft.push_str(text);
    draft.push_str(&state.draft[state.cursor..]);
    DraftState {
        cursor: state.cursor + text.len(),
        draft,
        mark: None,
    }
}

fn backspace(state: &DraftState) -> DraftState {
    let state = normalize(state.clone());
    if let Some((start, end)) = selection(&state) {
        return delete_range(&state, start, end);
    }
    if state.cursor == 0 {
        return state;
    }
    let from = move_grapheme(&state.draft, state.cursor, -1);
    delete_range(&state, from, state.cursor)
}

fn delete(state: &DraftState) -> DraftState {
    let state = normalize(state.clone());
    if let Some((start, end)) = selection(&state) {
        return delete_range(&state, start, end);
    }
    if state.cursor >= state.draft.len() {
        return state;
    }
    let to = move_grapheme(&state.draft, state.cursor, 1);
    delete_range(&state, state.cursor, to)
}

fn delete_range(state: &DraftState, start: usize, end: usize) -> DraftState {
    let mut draft = String::new();
    draft.push_str(&state.draft[..start]);
    draft.push_str(&state.draft[end..]);
    DraftState {
        draft,
        cursor: start,
        mark: None,
    }
}

fn kill(state: &DraftState, mode: KillMode) -> DraftState {
    let state = normalize(state.clone());
    if let Some((start, end)) = selection(&state) {
        return delete_range(&state, start, end);
    }
    match mode {
        KillMode::Word => {
            let from = word_left(&state.draft, state.cursor);
            delete_range(&state, from, state.cursor)
        }
        KillMode::ToStart => DraftState {
            draft: state.draft[state.cursor..].to_string(),
            cursor: 0,
            mark: None,
        },
        KillMode::ToEnd => DraftState {
            draft: state.draft[..state.cursor].to_string(),
            cursor: state.cursor,
            mark: None,
        },
    }
}

fn select_all(state: &DraftState) -> DraftState {
    let state = normalize(state.clone());
    if state.draft.is_empty() {
        return state;
    }
    DraftState {
        cursor: state.draft.len(),
        mark: Some(0),
        draft: state.draft,
    }
}

fn move_draft(state: &DraftState, to: Motion, select: bool) -> DraftState {
    let state = normalize(state.clone());
    if !select {
        if let Some((start, end)) = selection(&state) {
            let edge = if toward_start(to) { start } else { end };
            let cursor = if collapse_only(to) {
                edge
            } else {
                apply_motion(&state.draft, edge, to)
            };
            return DraftState {
                draft: state.draft,
                cursor,
                mark: None,
            };
        }
        let cursor = apply_motion(&state.draft, state.cursor, to);
        return DraftState {
            draft: state.draft,
            cursor,
            mark: None,
        };
    }
    let cursor = apply_motion(&state.draft, state.cursor, to);
    normalize(DraftState {
        draft: state.draft,
        cursor,
        mark: Some(state.mark.unwrap_or(state.cursor)),
    })
}

fn toward_start(to: Motion) -> bool {
    matches!(
        to,
        Motion::Left | Motion::WordLeft | Motion::Home | Motion::LineUp
    )
}

fn collapse_only(to: Motion) -> bool {
    matches!(
        to,
        Motion::Left | Motion::Right | Motion::WordLeft | Motion::WordRight
    )
}

fn apply_motion(draft: &str, cursor: usize, to: Motion) -> usize {
    match to {
        Motion::Left => move_grapheme(draft, cursor, -1),
        Motion::Right => move_grapheme(draft, cursor, 1),
        Motion::Home => hard_line(draft, cursor).0,
        Motion::End => hard_line(draft, cursor).1,
        Motion::WordLeft => word_left(draft, cursor),
        Motion::WordRight => word_right(draft, cursor),
        Motion::LineUp => line_up(draft, cursor),
        Motion::LineDown => line_down(draft, cursor),
    }
}

fn move_grapheme(draft: &str, cursor: usize, dir: i32) -> usize {
    let cursor = clamp(draft, cursor);
    let mut bounds: Vec<usize> = draft
        .grapheme_indices(true)
        .map(|(index, _)| index)
        .collect();
    if bounds.is_empty() {
        bounds.push(0);
    }
    bounds.push(draft.len());
    if dir < 0 {
        bounds
            .iter()
            .rev()
            .find(|index| **index < cursor)
            .copied()
            .unwrap_or(0)
    } else {
        bounds
            .iter()
            .find(|index| **index > cursor)
            .copied()
            .unwrap_or(draft.len())
    }
}

fn is_word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn prev_char(draft: &str, index: usize) -> Option<(usize, char)> {
    if index == 0 {
        return None;
    }
    let start = draft.floor_char_boundary(index - 1);
    draft[start..index].chars().next().map(|ch| (start, ch))
}

fn word_left(draft: &str, cursor: usize) -> usize {
    let mut index = clamp(draft, cursor);
    while let Some((start, ch)) = prev_char(draft, index) {
        if is_word(ch) {
            break;
        }
        index = start;
    }
    while let Some((start, ch)) = prev_char(draft, index) {
        if !is_word(ch) {
            break;
        }
        index = start;
    }
    index
}

fn word_right(draft: &str, cursor: usize) -> usize {
    let mut rest = clamp(draft, cursor);
    let tail = &draft[rest..];
    let mut skipped = false;
    for ch in tail.chars() {
        if is_word(ch) {
            skipped = true;
            break;
        }
        rest += ch.len_utf8();
    }
    if !skipped {
        return draft.len();
    }
    for ch in draft[rest..].chars() {
        if !is_word(ch) {
            break;
        }
        rest += ch.len_utf8();
    }
    rest
}

fn hard_line(draft: &str, cursor: usize) -> (usize, usize) {
    let cursor = clamp(draft, cursor);
    let start = draft[..cursor]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let end = draft[cursor..]
        .find('\n')
        .map(|index| cursor + index)
        .unwrap_or(draft.len());
    (start, end)
}

pub fn line_up(draft: &str, cursor: usize) -> usize {
    let (start, _end) = hard_line(draft, cursor);
    let col = cursor - start;
    if start == 0 {
        return clamp(draft, cursor);
    }
    let prev_end = start - 1;
    let prev_start = draft[..prev_end]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    prev_start + col.min(prev_end - prev_start)
}

fn line_down(draft: &str, cursor: usize) -> usize {
    let (start, end) = hard_line(draft, cursor);
    let col = cursor - start;
    if end >= draft.len() {
        return clamp(draft, cursor);
    }
    let next_start = end + 1;
    let next_end = draft[next_start..]
        .find('\n')
        .map(|index| next_start + index)
        .unwrap_or(draft.len());
    next_start + col.min(next_end - next_start)
}
