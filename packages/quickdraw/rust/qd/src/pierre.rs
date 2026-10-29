//! Unified and git patch walker.
//!
//! This is the parse half of `parsePatchFiles`: commit split, file split,
//! header names, and hunk blocks. Line text is owned. The JavaScript walker
//! copies slices out of a large rope so the rope can be collected; a Rust
//! `String` already owns the line, so that copy is not repeated here.
//!
//! A file with a header and no `@@` is kept. A pure rename and a binary
//! section are that shape. `collapsed_before` is the new-side lines the patch
//! omitted before a hunk, including before the first hunk when it starts
//! past line 1.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChangeKind {
    Change,
    RenamePure,
    RenameChanged,
    New,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HunkBlock {
    Context {
        lines: Vec<String>,
    },
    Change {
        deletions: Vec<String>,
        additions: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hunk {
    pub addition_start: i64,
    pub addition_count: i64,
    pub deletion_start: i64,
    pub deletion_count: i64,
    pub collapsed_before: i64,
    pub blocks: Vec<HunkBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PatchFileMeta {
    pub name: String,
    pub prev_name: Option<String>,
    pub kind: ChangeKind,
    pub hunks: Vec<Hunk>,
}

struct HunkHeader {
    addition_start: i64,
    addition_count: i64,
    deletion_start: i64,
    deletion_count: i64,
}

/// Every file the walker accepted. Invalid hunk lines are skipped.
pub(crate) fn parse_patch_files(data: &str) -> Vec<PatchFileMeta> {
    let mut files = Vec::new();
    for patch in split_commits(data) {
        files.extend(process_patch(patch));
    }
    files
}

fn process_patch(data: &str) -> Vec<PatchFileMeta> {
    let git = is_git_diff(data);
    let raw = if git {
        split_at_line_prefix(data, "diff --git")
    } else {
        split_unified_diff_files(data)
    };
    let mut files = Vec::new();
    for segment in raw {
        if git && !is_git_diff(segment) {
            continue;
        }
        if !git && !is_unified_file_header_at(segment, 0) {
            continue;
        }
        if let Some(file) = process_file(segment, git) {
            files.push(file);
        }
    }
    files
}

fn process_file(file_diff: &str, git: bool) -> Option<PatchFileMeta> {
    if file_diff.trim().is_empty() {
        return None;
    }
    let parts = split_at_line_prefix(file_diff, "@@ ");
    let mut name = String::new();
    let mut prev_name: Option<String> = None;
    let mut kind = ChangeKind::Change;
    let mut saw_header = false;
    let mut hunks = Vec::new();
    let mut last_hunk_end = 0i64;
    for part in parts {
        let mut lines = split_with_newlines(part);
        let first = lines.first().copied().unwrap_or("");
        let header = parse_hunk_header(first);
        if header.is_none() || !saw_header {
            if saw_header {
                continue;
            }
            saw_header = true;
            for line in &lines {
                read_header_line(line, git, &mut name, &mut prev_name, &mut kind);
            }
            continue;
        }
        let header = header?;
        while lines.last().is_some_and(|line| {
            *line == "\n" || *line == "\r" || *line == "\r\n" || line.is_empty()
        }) {
            lines.pop();
        }
        let mut blocks: Vec<HunkBlock> = Vec::new();
        let mut parsed_add = 0i64;
        let mut parsed_del = 0i64;
        for raw in lines.iter().skip(1) {
            if parsed_add >= header.addition_count
                && parsed_del >= header.deletion_count
                && !raw.starts_with('\\')
            {
                break;
            }
            let marker = raw.chars().next();
            match marker {
                Some('+') => {
                    push_change(&mut blocks, true, line_body(raw));
                    parsed_add += 1;
                }
                Some('-') => {
                    push_change(&mut blocks, false, line_body(raw));
                    parsed_del += 1;
                }
                Some(' ') => {
                    push_context(&mut blocks, line_body(raw));
                    parsed_add += 1;
                    parsed_del += 1;
                }
                Some('\\') => {}
                _ => {}
            }
        }
        let collapsed = (header.addition_start - 1 - last_hunk_end).max(0);
        last_hunk_end = header
            .addition_start
            .saturating_add(header.addition_count)
            .saturating_sub(1);
        hunks.push(Hunk {
            addition_start: header.addition_start,
            addition_count: header.addition_count,
            deletion_start: header.deletion_start,
            deletion_count: header.deletion_count,
            collapsed_before: collapsed,
            blocks,
        });
    }
    if !saw_header {
        return None;
    }
    if name.is_empty() && hunks.is_empty() {
        return None;
    }
    if !git {
        if prev_name.as_deref().is_some_and(|prev| prev != name) {
            kind = if hunks.is_empty() {
                ChangeKind::RenamePure
            } else {
                ChangeKind::RenameChanged
            };
        }
    }
    if !matches!(kind, ChangeKind::RenamePure | ChangeKind::RenameChanged) {
        prev_name = None;
    }
    Some(PatchFileMeta {
        name,
        prev_name,
        kind,
        hunks,
    })
}

fn read_header_line(
    raw: &str,
    git: bool,
    name: &mut String,
    prev_name: &mut Option<String>,
    kind: &mut ChangeKind,
) {
    let line = raw.trim_end_matches(['\n', '\r']);
    if let Some(rest) = line.strip_prefix("diff --git ") {
        if let Some((prev, next)) = git_pair(rest.trim()) {
            *name = next;
            if prev != *name {
                *prev_name = Some(prev);
            }
        }
        return;
    }
    if let Some((marker, file_name)) = file_header_name(line, git) {
        if marker == "---" {
            *prev_name = Some(file_name.clone());
            *name = file_name;
        } else {
            *name = file_name;
        }
        return;
    }
    if !git {
        return;
    }
    if let Some(rest) = line.strip_prefix("new file mode") {
        *kind = ChangeKind::New;
        let _mode = rest.trim();
        return;
    }
    if line.starts_with("deleted file mode") {
        *kind = ChangeKind::Deleted;
        return;
    }
    if let Some(rest) = line.strip_prefix("similarity index") {
        *kind = if rest.trim_start().starts_with("100%") {
            ChangeKind::RenamePure
        } else {
            ChangeKind::RenameChanged
        };
        return;
    }
    if let Some(rest) = line.strip_prefix("rename from ") {
        let prev = rest.trim();
        if !prev.is_empty() {
            *prev_name = Some(prev.to_string());
        }
        return;
    }
    if let Some(rest) = line.strip_prefix("rename to ") {
        let next = rest.trim();
        if !next.is_empty() {
            *name = next.to_string();
        }
    }
}

fn push_context(blocks: &mut Vec<HunkBlock>, line: String) {
    if let Some(HunkBlock::Context { lines }) = blocks.last_mut() {
        lines.push(line);
        return;
    }
    blocks.push(HunkBlock::Context { lines: vec![line] });
}

fn push_change(blocks: &mut Vec<HunkBlock>, addition: bool, line: String) {
    if let Some(HunkBlock::Change {
        deletions,
        additions,
    }) = blocks.last_mut()
    {
        if addition {
            additions.push(line);
        } else {
            deletions.push(line);
        }
        return;
    }
    if addition {
        blocks.push(HunkBlock::Change {
            deletions: Vec::new(),
            additions: vec![line],
        });
    } else {
        blocks.push(HunkBlock::Change {
            deletions: vec![line],
            additions: Vec::new(),
        });
    }
}

fn line_body(raw: &str) -> String {
    let body = raw.get(1..).unwrap_or("");
    let body = body.strip_suffix("\r\n").unwrap_or(body);
    let body = body.strip_suffix('\n').unwrap_or(body);
    let body = body.strip_suffix('\r').unwrap_or(body);
    body.to_string()
}

fn file_header_name(line: &str, git: bool) -> Option<(&'static str, String)> {
    let (marker, rest) = if let Some(rest) = line.strip_prefix("---") {
        ("---", rest)
    } else if let Some(rest) = line.strip_prefix("+++") {
        ("+++", rest)
    } else {
        return None;
    };
    let rest = match rest.chars().next() {
        Some(' ' | '\t') => rest.trim_start(),
        _ => return None,
    };
    if rest.is_empty() {
        return None;
    }
    let rest = if git {
        rest.strip_prefix("a/")
            .or_else(|| rest.strip_prefix("b/"))?
    } else {
        rest
    };
    let name = rest.split(['\t', '\r']).next()?.trim();
    if name.is_empty() || name == "/dev/null" {
        return None;
    }
    Some((marker, name.to_string()))
}

fn git_pair(rest: &str) -> Option<(String, String)> {
    let (prev, next) = if rest.starts_with('"') {
        let end_a = rest[1..].find('"')?;
        let after = rest[end_a + 2..].trim_start();
        if !after.starts_with('"') {
            return None;
        }
        let end_b = after[1..].find('"')?;
        (
            rest[1..1 + end_a].to_string(),
            after[1..1 + end_b].to_string(),
        )
    } else {
        let mut parts = rest.split_whitespace();
        (parts.next()?.to_string(), parts.next()?.to_string())
    };
    Some((strip_side(&prev, "a/"), strip_side(&next, "b/")))
}

fn strip_side(path: &str, prefix: &str) -> String {
    path.trim_matches('"')
        .strip_prefix(prefix)
        .unwrap_or(path.trim_matches('"'))
        .to_string()
}

fn parse_hunk_header(line: &str) -> Option<HunkHeader> {
    if !line.starts_with("@@ -") {
        return None;
    }
    let bytes = line.as_bytes();
    let mut index = 4usize;
    let (deletion_start, next) = read_i64(bytes, index)?;
    index = next;
    let mut deletion_count = 1i64;
    if bytes.get(index) == Some(&b',') {
        let (count, next) = read_i64(bytes, index + 1)?;
        deletion_count = count;
        index = next;
    }
    if bytes.get(index) != Some(&b' ') || bytes.get(index + 1) != Some(&b'+') {
        return None;
    }
    index += 2;
    let (addition_start, next) = read_i64(bytes, index)?;
    index = next;
    let mut addition_count = 1i64;
    if bytes.get(index) == Some(&b',') {
        let (count, next) = read_i64(bytes, index + 1)?;
        addition_count = count;
        index = next;
    }
    if bytes.get(index) != Some(&b' ')
        || bytes.get(index + 1) != Some(&b'@')
        || bytes.get(index + 2) != Some(&b'@')
    {
        return None;
    }
    Some(HunkHeader {
        addition_start,
        addition_count,
        deletion_start,
        deletion_count,
    })
}

fn read_i64(bytes: &[u8], start: usize) -> Option<(i64, usize)> {
    let mut index = start;
    let mut value = 0i64;
    while index < bytes.len() {
        let digit = bytes[index].wrapping_sub(b'0');
        if digit > 9 {
            break;
        }
        value = value.checked_mul(10)?.checked_add(i64::from(digit))?;
        index += 1;
    }
    if index == start {
        None
    } else {
        Some((value, index))
    }
}

fn is_git_diff(data: &str) -> bool {
    data.starts_with("diff --git") || data.contains("\ndiff --git")
}

fn split_commits(data: &str) -> Vec<&str> {
    if !(data.starts_with("From ") || data.contains("\nFrom ")) {
        return vec![data];
    }
    let mut bounds = Vec::new();
    let mut offset = 0usize;
    for line in data.split_inclusive('\n') {
        if is_from_line(line.trim_end_matches(['\n', '\r'])) {
            bounds.push(offset);
        }
        offset += line.len();
    }
    if bounds.is_empty() {
        return vec![data];
    }
    let mut out = Vec::new();
    if bounds[0] > 0 {
        out.push(&data[..bounds[0]]);
    }
    for index in 0..bounds.len() {
        let end = bounds.get(index + 1).copied().unwrap_or(data.len());
        out.push(&data[bounds[index]..end]);
    }
    out
}

fn is_from_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("From ") else {
        return false;
    };
    let mut parts = rest.splitn(2, ' ');
    let hex = parts.next().unwrap_or("");
    let tail = parts.next().unwrap_or("");
    !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) && !tail.is_empty()
}

fn split_at_line_prefix<'a>(contents: &'a str, prefix: &str) -> Vec<&'a str> {
    if contents.is_empty() {
        return vec![""];
    }
    let newline_prefix = format!("\n{prefix}");
    let first = if contents.starts_with(prefix) {
        0
    } else {
        match contents.find(&newline_prefix) {
            Some(index) => index + 1,
            None => return vec![contents],
        }
    };
    let mut parts = Vec::new();
    if first > 0 {
        parts.push(&contents[..first]);
    }
    let mut start = first;
    loop {
        let from = start.saturating_add(1);
        if from >= contents.len() {
            break;
        }
        let Some(rel) = contents[from..].find(&newline_prefix) else {
            break;
        };
        let boundary = from + rel + 1;
        parts.push(&contents[start..boundary]);
        start = boundary;
    }
    parts.push(&contents[start..]);
    parts
}

fn split_with_newlines(contents: &str) -> Vec<&str> {
    if contents.is_empty() {
        return vec![""];
    }
    let mut lines = Vec::new();
    let mut start = 0usize;
    while let Some(rel) = contents[start..].find('\n') {
        let newline = start + rel;
        lines.push(&contents[start..newline + 1]);
        start = newline + 1;
    }
    if start < contents.len() {
        lines.push(&contents[start..]);
    }
    lines
}

fn split_unified_diff_files(contents: &str) -> Vec<&str> {
    if contents.is_empty() {
        return vec![""];
    }
    let bytes = contents.as_bytes();
    let mut parts = Vec::new();
    let mut part_start = 0usize;
    let mut line_start = 0usize;
    let mut rem_del = 0i64;
    let mut rem_add = 0i64;
    let mut opened = false;
    while line_start < contents.len() {
        let next = next_line_start(contents, line_start);
        if rem_del <= 0 && rem_add <= 0 {
            if is_unified_file_header_at(contents, line_start) {
                if line_start > part_start {
                    parts.push(&contents[part_start..line_start]);
                }
                part_start = line_start;
                opened = true;
                line_start = next_line_start(contents, next);
                continue;
            }
            if opened && contents[line_start..].starts_with("@@ -") {
                if let Some(header) = parse_hunk_header(&contents[line_start..next]) {
                    rem_del = header.deletion_count;
                    rem_add = header.addition_count;
                }
            }
            line_start = next;
            continue;
        }
        match bytes.get(line_start).copied() {
            Some(b'\\') => {}
            Some(b' ') => {
                rem_del = (rem_del - 1).max(0);
                rem_add = (rem_add - 1).max(0);
            }
            Some(b'-') => {
                rem_del = (rem_del - 1).max(0);
            }
            Some(b'+') => {
                rem_add = (rem_add - 1).max(0);
            }
            _ => {}
        }
        line_start = next;
    }
    parts.push(&contents[part_start..]);
    parts
}

fn is_unified_file_header_at(contents: &str, line_start: usize) -> bool {
    if line_start > contents.len() {
        return false;
    }
    let next = next_line_start(contents, line_start);
    is_header_prefix_at(contents, line_start, "---") && is_header_prefix_at(contents, next, "+++")
}

fn is_header_prefix_at(contents: &str, line_start: usize, prefix: &str) -> bool {
    let Some(rest) = contents.get(line_start..) else {
        return false;
    };
    let Some(after) = rest.strip_prefix(prefix) else {
        return false;
    };
    let mut chars = after.chars();
    match chars.next() {
        Some(' ' | '\t') => {}
        _ => return false,
    }
    for ch in chars {
        if ch == '\n' || ch == '\r' {
            break;
        }
        if ch != ' ' && ch != '\t' {
            return true;
        }
    }
    false
}

fn next_line_start(contents: &str, line_start: usize) -> usize {
    let Some(rest) = contents.get(line_start..) else {
        return contents.len();
    };
    match rest.find('\n') {
        Some(index) => line_start + index + 1,
        None => contents.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunk_gap_rename_and_binary_keep_pierres_shape() {
        let files = parse_patch_files(
            "\
diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,3 +10,3 @@
 keep1
-oldLine
+newLine
 keep2
@@ -50,1 +60,1 @@
-late
+LATER
",
        );
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "x.ts");
        assert_eq!(files[0].hunks.len(), 2);
        assert_eq!(files[0].hunks[0].collapsed_before, 9);
        assert_eq!(files[0].hunks[1].collapsed_before, 47);
        assert_eq!(files[0].hunks[1].deletion_start, 50);
        assert_eq!(files[0].hunks[1].addition_start, 60);

        let quoted = parse_patch_files(
            "\
diff --git \"a/my file.ts\" \"b/my file.ts\"
--- \"a/my file.ts\"
+++ \"b/my file.ts\"
@@ -1 +1 @@
-a
+b
",
        );
        assert_eq!(quoted[0].name, "my file.ts");

        let renamed = parse_patch_files(
            "\
diff --git a/old.ts b/old.ts
similarity index 90%
rename from old.ts
rename to new.ts
",
        );
        assert_eq!(renamed[0].name, "new.ts");
        assert_eq!(renamed[0].prev_name.as_deref(), Some("old.ts"));
        assert_eq!(renamed[0].kind, ChangeKind::RenameChanged);
        assert!(renamed[0].hunks.is_empty());

        let mixed = parse_patch_files(
            "\
diff --git a/blob.bin b/blob.bin
Binary files a/blob.bin and b/blob.bin differ
diff --git a/keep.ts b/keep.ts
--- a/keep.ts
+++ b/keep.ts
@@ -1 +1 @@
-a
+b
",
        );
        assert_eq!(mixed.len(), 2);
        assert_eq!(mixed[0].name, "blob.bin");
        assert!(mixed[0].hunks.is_empty());
        assert_eq!(mixed[1].name, "keep.ts");
        assert_eq!(mixed[1].hunks.len(), 1);
    }
}
