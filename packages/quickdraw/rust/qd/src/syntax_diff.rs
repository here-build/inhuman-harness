//! One-polarity inline gate for a paired diff line.
//!
//! Both sides parse. The edit inlines when it stays inside one node and the
//! children are only added or only removed, or when one side is a unique named
//! descendant of the other (an unwrap). A token whose text changed falls
//! through to a single character hole. A parse error, a missing grammar, or a
//! comment standing in for a statement uses that same character hole.
//! `.scm` and the names `scm` / `scheme` select the Scheme grammar. The name
//! `arrival` does not.

use std::ops::Range;

use tree_sitter::{Language, Node, Parser};

/// Byte ranges to paint on one side of a pair. `paint_old` selects the line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InlineEdit {
    pub paint_old: bool,
    pub marks: Vec<Range<usize>>,
}

const MAX_LINE: usize = 1000;

enum Grammar {
    TypeScript,
    Tsx,
    JavaScript,
    Rust,
    Python,
    Scheme,
}

enum Gate {
    Inline(InlineEdit),
    Fallback,
    Refuse,
}

pub(crate) fn inline_edit(old_line: &str, new_line: &str, lang: &str, path: &str) -> Option<InlineEdit> {
    if old_line == new_line || old_line.len() > MAX_LINE || new_line.len() > MAX_LINE {
        return None;
    }
    let edit = match grammar_for(lang, path) {
        Some(grammar) => match ast_edit(old_line, new_line, grammar) {
            Gate::Inline(edit) => Some(edit),
            Gate::Fallback => one_chunk(old_line, new_line),
            Gate::Refuse => None,
        },
        None => one_chunk(old_line, new_line),
    };
    edit.and_then(|edit| finish(edit, old_line, new_line))
}

/// Whitespace that sits on the painted line and not on the other line, and
/// that touches a mark, joins that mark. A shared space, such as the gap
/// before `}`, stays visible.
fn finish(mut edit: InlineEdit, old_line: &str, new_line: &str) -> Option<InlineEdit> {
    let (line, other) = if edit.paint_old {
        (old_line, new_line)
    } else {
        (new_line, old_line)
    };
    absorb_visible_ws(line, &mut edit.marks, other);
    restore_shared_ws(line, &mut edit.marks, other);
    edit.marks.retain(|mark| mark.start < mark.end);
    if edit.marks.is_empty() {
        None
    } else {
        Some(edit)
    }
}

fn absorb_visible_ws(line: &str, marks: &mut Vec<Range<usize>>, other: &str) {
    for _ in 0..line.len() {
        merge_overlap(marks);
        let (visible, map) = erase_map(line, marks);
        if visible == other {
            return;
        }
        let prefix = common_prefix_bytes(&visible, other);
        if prefix >= visible.len() || !visible.is_char_boundary(prefix) {
            return;
        }
        let Some(ch) = visible[prefix..].chars().next() else {
            return;
        };
        if !ch.is_whitespace() {
            return;
        }
        let Some(line_at) = map.get(prefix).copied() else {
            return;
        };
        let mut grew = false;
        for mark in marks.iter_mut() {
            if mark.end == line_at {
                mark.end += ch.len_utf8();
                grew = true;
                break;
            }
        }
        if !grew {
            return;
        }
    }
}

/// A mark that swallowed a space the other line still has gives that space back.
fn restore_shared_ws(line: &str, marks: &mut Vec<Range<usize>>, other: &str) {
    for _ in 0..line.len() {
        let (visible, map) = erase_map(line, marks);
        if visible == other {
            return;
        }
        let prefix = common_prefix_bytes(&visible, other);
        if prefix >= other.len() || !other.is_char_boundary(prefix) {
            return;
        }
        let Some(ch) = other[prefix..].chars().next() else {
            return;
        };
        if !ch.is_whitespace() {
            return;
        }
        let line_at = if prefix < visible.len() {
            map.get(prefix).copied()
        } else {
            Some(line.len())
        };
        let Some(line_at) = line_at else {
            return;
        };
        let mut shrank = false;
        for mark in marks.iter_mut() {
            if mark.end != line_at || mark.start >= line.len() {
                continue;
            }
            if !line.is_char_boundary(mark.start) {
                continue;
            }
            let Some(first) = line[mark.start..].chars().next() else {
                continue;
            };
            let next = mark.start + first.len_utf8();
            if first.is_whitespace() && next < mark.end {
                mark.start = next;
                shrank = true;
                break;
            }
        }
        if !shrank {
            return;
        }
    }
}

fn merge_overlap(marks: &mut Vec<Range<usize>>) {
    marks.sort_by_key(|mark| mark.start);
    let mut merged: Vec<Range<usize>> = Vec::new();
    for mark in marks.drain(..) {
        if let Some(prev) = merged.last_mut() {
            if mark.start <= prev.end {
                prev.end = prev.end.max(mark.end);
                continue;
            }
        }
        merged.push(mark);
    }
    *marks = merged;
}

fn erase_map(line: &str, marks: &[Range<usize>]) -> (String, Vec<usize>) {
    let mut visible = String::new();
    let mut map = Vec::new();
    let mut cursor = 0usize;
    for mark in marks {
        if mark.start > line.len() || mark.start < cursor {
            continue;
        }
        if !line.is_char_boundary(mark.start) || !line.is_char_boundary(cursor) {
            continue;
        }
        push_kept(&mut visible, &mut map, line, cursor, mark.start);
        cursor = mark.end.min(line.len());
    }
    if cursor <= line.len() && line.is_char_boundary(cursor) {
        push_kept(&mut visible, &mut map, line, cursor, line.len());
    }
    (visible, map)
}

fn push_kept(visible: &mut String, map: &mut Vec<usize>, line: &str, from: usize, to: usize) {
    let kept = &line[from..to];
    for (offset, ch) in kept.char_indices() {
        let at = from + offset;
        for byte in 0..ch.len_utf8() {
            map.push(at + byte);
        }
    }
    visible.push_str(kept);
}

fn grammar_for(lang: &str, path: &str) -> Option<Grammar> {
    match extension(path).as_str() {
        "scm" => return Some(Grammar::Scheme),
        "tsx" | "jsx" => return Some(Grammar::Tsx),
        _ => {}
    }
    match lang {
        "scm" | "scheme" => Some(Grammar::Scheme),
        "tsx" | "jsx" => Some(Grammar::Tsx),
        "typescript" | "ts" | "mts" | "cts" => Some(Grammar::TypeScript),
        "javascript" | "js" | "mjs" | "cjs" => Some(Grammar::JavaScript),
        "rust" | "rs" => Some(Grammar::Rust),
        "python" | "py" => Some(Grammar::Python),
        _ => None,
    }
}

fn extension(path: &str) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    file.rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn language_of(grammar: Grammar) -> Language {
    match grammar {
        Grammar::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Grammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Grammar::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
        Grammar::Rust => tree_sitter_rust::LANGUAGE.into(),
        Grammar::Python => tree_sitter_python::LANGUAGE.into(),
        Grammar::Scheme => tree_sitter_scheme::LANGUAGE.into(),
    }
}

fn ast_edit(old_line: &str, new_line: &str, grammar: Grammar) -> Gate {
    let mut parser = Parser::new();
    let language = language_of(grammar);
    if parser.set_language(&language).is_err() {
        return Gate::Fallback;
    }
    let Some(old_tree) = parser.parse(old_line, None) else {
        return Gate::Fallback;
    };
    let Some(new_tree) = parser.parse(new_line, None) else {
        return Gate::Fallback;
    };
    let old_root = old_tree.root_node();
    let new_root = new_tree.root_node();
    if old_root.has_error() || new_root.has_error() {
        return Gate::Fallback;
    }
    match gate(old_root, new_root, old_line, new_line, 0) {
        Gate::Refuse if whitespace_only(old_line, new_line) => Gate::Fallback,
        other => other,
    }
}

fn whitespace_only(left: &str, right: &str) -> bool {
    let solid = |text: &str| text.chars().filter(|ch| !ch.is_whitespace()).collect::<String>();
    solid(left) == solid(right)
}

fn gate(old: Node, new: Node, old_src: &str, new_src: &str, depth: u8) -> Gate {
    if depth > 64 {
        return Gate::Refuse;
    }
    if old.is_error() || new.is_error() || old.is_missing() || new.is_missing() {
        return Gate::Fallback;
    }
    let old_comment = old.kind().contains("comment") || content_is_comment(old, old_src);
    let new_comment = new.kind().contains("comment") || content_is_comment(new, new_src);
    if old_comment != new_comment {
        return Gate::Fallback;
    }
    if old.kind() != new.kind() {
        return lift_pair(old, new, old_src, new_src);
    }
    if node_text(old, old_src) == node_text(new, new_src) {
        return Gate::Refuse;
    }
    let old_kids = significant(old, old_src);
    let new_kids = significant(new, new_src);
    if old_kids.len() == 1 && new_kids.len() == 1 && old_kids[0].kind() == new_kids[0].kind() {
        let child = old_kids[0];
        let same_span = child.start_byte() == old.start_byte()
            && child.end_byte() == old.end_byte()
            && child.kind() == old.kind();
        if !same_span {
            return gate(old_kids[0], new_kids[0], old_src, new_src, depth + 1);
        }
    }
    if old_kids.len() == new_kids.len() && !old_kids.is_empty() {
        if let Some(index) = sole_differ(&old_kids, &new_kids, old_src, new_src) {
            if old_kids[index].kind() == new_kids[index].kind() {
                return gate(
                    old_kids[index],
                    new_kids[index],
                    old_src,
                    new_src,
                    depth + 1,
                );
            }
            return lift_pair(old_kids[index], new_kids[index], old_src, new_src);
        }
        let identical = old_kids
            .iter()
            .zip(&new_kids)
            .all(|(left, right)| child_eq(*left, *right, old_src, new_src));
        if identical {
            return Gate::Fallback;
        }
    }
    if old_kids.is_empty() && new_kids.is_empty() {
        return Gate::Fallback;
    }
    align(&old_kids, &new_kids, old_src, new_src)
}

fn sole_differ(old: &[Node], new: &[Node], old_src: &str, new_src: &str) -> Option<usize> {
    if old.len() != new.len() || old.is_empty() {
        return None;
    }
    let mut found = None;
    for index in 0..old.len() {
        if child_eq(old[index], new[index], old_src, new_src) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(index);
    }
    found
}

fn align(old: &[Node], new: &[Node], old_src: &str, new_src: &str) -> Gate {
    let pairs = matching_pairs(old, new, old_src, new_src);
    if pairs.is_empty() {
        return Gate::Refuse;
    }
    let mut old_hit = vec![false; old.len()];
    let mut new_hit = vec![false; new.len()];
    for (left, right) in pairs {
        old_hit[left] = true;
        new_hit[right] = true;
    }
    let dels: Vec<Node> = old
        .iter()
        .enumerate()
        .filter(|(index, _)| !old_hit[*index])
        .map(|(_, node)| *node)
        .collect();
    let adds: Vec<Node> = new
        .iter()
        .enumerate()
        .filter(|(index, _)| !new_hit[*index])
        .map(|(_, node)| *node)
        .collect();
    if adds.is_empty() && !dels.is_empty() {
        return marks_of(&dels, old_src, true);
    }
    if dels.is_empty() && !adds.is_empty() {
        return marks_of(&adds, new_src, false);
    }
    if dels.len() == 1 && adds.len() == 1 {
        return lift_pair(dels[0], adds[0], old_src, new_src);
    }
    Gate::Refuse
}

fn marks_of(nodes: &[Node], source: &str, paint_old: bool) -> Gate {
    let ranges: Vec<(usize, usize)> = nodes
        .iter()
        .map(|node| (node.start_byte(), node.end_byte()))
        .collect();
    let marks = coalesce(&ranges, source);
    if marks.is_empty() {
        return Gate::Refuse;
    }
    Gate::Inline(InlineEdit { paint_old, marks })
}

fn lift_pair(old: Node, new: Node, old_src: &str, new_src: &str) -> Gate {
    let new_text = node_text(new, new_src);
    if let Some(edit) = lift(old, new_text, old_src, true) {
        return Gate::Inline(edit);
    }
    let old_text = node_text(old, old_src);
    if let Some(edit) = lift(new, old_text, new_src, false) {
        return Gate::Inline(edit);
    }
    let old_leaves = significant(old, old_src);
    let new_leaves = significant(new, new_src);
    if old_leaves.is_empty() && new_leaves.is_empty() {
        return Gate::Fallback;
    }
    Gate::Refuse
}

/// `inner_text` is one named descendant of `outer`. The mark is the outer
/// bytes that are not that descendant.
fn lift(outer: Node, inner_text: &str, source: &str, paint_old: bool) -> Option<InlineEdit> {
    if inner_text.is_empty() {
        return None;
    }
    let mut hits = Vec::new();
    collect_hits(outer, inner_text, source, &mut hits);
    hits.sort_unstable();
    hits.dedup();
    if hits.len() != 1 {
        return None;
    }
    let (start, end) = hits[0];
    let outer_start = outer.start_byte();
    let outer_end = outer.end_byte();
    if start <= outer_start && end >= outer_end {
        return None;
    }
    let mut ranges = Vec::new();
    if outer_start < start {
        ranges.push((outer_start, start));
    }
    if end < outer_end {
        ranges.push((end, outer_end));
    }
    let marks = coalesce(&ranges, source);
    if marks.is_empty() {
        return None;
    }
    Some(InlineEdit { paint_old, marks })
}

fn collect_hits(node: Node, want: &str, source: &str, hits: &mut Vec<(usize, usize)>) {
    let count = node.child_count();
    for index in 0..count {
        let Some(child) = node.child(index) else {
            continue;
        };
        if child.is_extra() {
            continue;
        }
        collect_hits(child, want, source, hits);
        if child.is_named() && node_text(child, source) == want {
            hits.push((child.start_byte(), child.end_byte()));
        }
    }
}

fn matching_pairs(old: &[Node], new: &[Node], old_src: &str, new_src: &str) -> Vec<(usize, usize)> {
    let n = old.len();
    let m = new.len();
    let cols = m + 1;
    let mut dp = vec![0u16; (n + 1) * cols];
    let at = |row: usize, col: usize| row * cols + col;
    for row in (0..n).rev() {
        for col in (0..m).rev() {
            dp[at(row, col)] = if child_eq(old[row], new[col], old_src, new_src) {
                dp[at(row + 1, col + 1)].saturating_add(1)
            } else {
                dp[at(row + 1, col)].max(dp[at(row, col + 1)])
            };
        }
    }
    let mut pairs = Vec::new();
    let mut row = 0;
    let mut col = 0;
    while row < n && col < m {
        if child_eq(old[row], new[col], old_src, new_src) {
            pairs.push((row, col));
            row += 1;
            col += 1;
        } else if dp[at(row + 1, col)] >= dp[at(row, col + 1)] {
            row += 1;
        } else {
            col += 1;
        }
    }
    pairs
}

fn content_is_comment(node: Node, source: &str) -> bool {
    if node.kind().contains("comment") {
        return true;
    }
    let kids = significant(node, source);
    if kids.len() == 1 && kids[0].kind().contains("comment") {
        return true;
    }
    if !kids.is_empty() {
        return false;
    }
    let mut saw_comment = false;
    let count = node.child_count();
    for index in 0..count {
        let Some(child) = node.child(index) else {
            continue;
        };
        if child.kind().contains("comment") {
            saw_comment = true;
            continue;
        }
        if child.is_extra() {
            continue;
        }
        if node_text(child, source).chars().all(char::is_whitespace) {
            continue;
        }
        return false;
    }
    saw_comment
}

fn significant<'a>(node: Node<'a>, source: &str) -> Vec<Node<'a>> {
    let mut out = Vec::new();
    let count = node.child_count();
    for index in 0..count {
        let Some(child) = node.child(index) else {
            continue;
        };
        if child.is_extra() {
            continue;
        }
        if !child.is_named() && node_text(child, source).chars().all(char::is_whitespace) {
            continue;
        }
        out.push(child);
    }
    out
}

fn child_eq(left: Node, right: Node, left_src: &str, right_src: &str) -> bool {
    left.kind() == right.kind() && node_text(left, left_src) == node_text(right, right_src)
}

fn node_text<'a>(node: Node, source: &'a str) -> &'a str {
    node.utf8_text(source.as_bytes()).unwrap_or("")
}

/// Join deleted or added children that are adjacent or split only by
/// whitespace, then pull in the whitespace that sits immediately before each
/// group. Whitespace after the group stays, so a space that also exists on
/// the other side is not eaten.
fn coalesce(ranges: &[(usize, usize)], source: &str) -> Vec<Range<usize>> {
    let mut spans: Vec<(usize, usize)> = ranges
        .iter()
        .copied()
        .filter(|(start, end)| *start < *end && *end <= source.len())
        .filter(|(start, end)| source.is_char_boundary(*start) && source.is_char_boundary(*end))
        .collect();
    if spans.is_empty() {
        return Vec::new();
    }
    spans.sort_by_key(|span| span.0);
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        if let Some(prev) = merged.last_mut() {
            if start >= prev.1 && gap_is_ws(source, prev.1, start) {
                prev.1 = prev.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    let mut out = Vec::with_capacity(merged.len());
    for (start, end) in merged {
        let floor = out.last().map(|range: &Range<usize>| range.end).unwrap_or(0);
        let start = retreat_ws(source, start, floor);
        if start < end {
            out.push(start..end);
        }
    }
    out
}

fn gap_is_ws(source: &str, from: usize, to: usize) -> bool {
    if from > to || !source.is_char_boundary(from) || !source.is_char_boundary(to) {
        return false;
    }
    source[from..to].chars().all(char::is_whitespace)
}

fn retreat_ws(source: &str, start: usize, floor: usize) -> usize {
    let mut at = start;
    while at > floor {
        let Some(ch) = source[..at].chars().next_back() else {
            break;
        };
        let next = at - ch.len_utf8();
        if !ch.is_whitespace() || next < floor {
            break;
        }
        at = next;
    }
    at
}

/// One side's middle, between the longest shared prefix and suffix, is empty.
/// `diffChars` is not the test: it keeps a space as its own island.
/// A hole whose anchor is a single character and that is longer than that
/// anchor stays two rows. So does a shorter line that occurs twice.
fn one_chunk(old: &str, new: &str) -> Option<InlineEdit> {
    if old == new || old.len() > MAX_LINE || new.len() > MAX_LINE {
        return None;
    }
    let prefix = common_prefix_bytes(old, new);
    let suffix = common_suffix_bytes(&old[prefix..], &new[prefix..]);
    let old_end = old.len() - suffix;
    let new_end = new.len() - suffix;
    if prefix > old_end || prefix > new_end {
        return None;
    }
    let old_mid = &old[prefix..old_end];
    let new_mid = &new[prefix..new_end];
    let (paint_old, hole_start, hole_end, shorter, longer, hole) =
        if old_mid.is_empty() && !new_mid.is_empty() {
            (false, prefix, new_end, old, new, new_mid)
        } else if new_mid.is_empty() && !old_mid.is_empty() {
            (true, prefix, old_end, new, old, old_mid)
        } else {
            return None;
        };
    if !shorter.chars().any(|ch| !ch.is_whitespace()) {
        return None;
    }
    let anchor = old[..prefix].chars().count() + old[old_end..].chars().count();
    if anchor < 2 && hole.chars().count() > anchor {
        return None;
    }
    if occurrence_count(longer, shorter) > 1 {
        return None;
    }
    Some(InlineEdit {
        paint_old,
        marks: vec![hole_start..hole_end],
    })
}

fn common_prefix_bytes(left: &str, right: &str) -> usize {
    left.chars()
        .zip(right.chars())
        .take_while(|(left_ch, right_ch)| left_ch == right_ch)
        .map(|(ch, _)| ch.len_utf8())
        .sum()
}

fn common_suffix_bytes(left: &str, right: &str) -> usize {
    left.chars()
        .rev()
        .zip(right.chars().rev())
        .take_while(|(left_ch, right_ch)| left_ch == right_ch)
        .map(|(ch, _)| ch.len_utf8())
        .sum()
}

fn occurrence_count(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0usize;
    let mut from = 0usize;
    while from < haystack.len() {
        let Some(pos) = haystack[from..].find(needle) else {
            break;
        };
        count += 1;
        let next = from + pos + needle.len();
        if next <= from {
            break;
        }
        from = next;
    }
    count
}
