//! Shell commands that carry a second language.
//!
//! The bash grammar does not know that `cat > hook.scm << EOF` or
//! `python -c "…"` contains another language. This scanner finds those
//! bodies and [`splice`] copies a second highlight in by byte offset.
//! A language the highlighter cannot resolve comes back without color and
//! is dropped, so the bash string color stays. A slice that does not
//! reconstruct the text is dropped the same way. Offsets are bytes.

use std::sync::LazyLock;

use regex::Regex;

use crate::syntax::TokenRun;

#[derive(Clone, Copy)]
struct Region {
    start: usize,
    end: usize,
    lang: &'static str,
}

/// A line's byte range in the command. The newline is not included.
#[derive(Clone, Copy)]
struct LineSpan {
    start: usize,
    end: usize,
}

/// Quoted or bare delimiter word. The quote forms are separate arms because
/// this regex engine has no backreference. `\w` here is ASCII, matching the
/// JavaScript class.
static HEREDOC_OPEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)<<\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))"#,
    )
    .expect("heredoc opener is a valid regex")
});
static HEREDOC_TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*(?:['"]\s*)?$"#).expect("heredoc tail is a valid regex"));
static INLINE: LazyLock<Regex> = LazyLock::new(|| {
    // The quote is not in the match. This engine has no lookahead, so the
    // caller checks that the next character is `'` or `"`.
    Regex::new(
        r#"(?:^|[;&|`\s(])(?:sudo\s+)?(?P<bin>[A-Za-z0-9_./-]+)(?:\s+-[A-Za-z]+)*\s+(?:-c|-e|--eval|--exec|-r)\s*"#,
    )
    .expect("inline interpreter is a valid regex")
});
static REDIRECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(>>?)\s*(\S+)"#).expect("redirect is a valid regex"));
static SHEBANG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^#!\s*(?:\S*/)?(?:env\s+)?(bash|sh|zsh|node|python3?|ruby)\b"#)
        .expect("shebang is a valid regex")
});

struct GuessPats {
    html: Regex,
    typescript_strong: Regex,
    typescript_weak: Regex,
    python: Regex,
    rust: Regex,
    go: Regex,
    sql: Regex,
    css: Regex,
    html_tag: Regex,
    yaml: Regex,
    braces: Regex,
    bash: Regex,
}

static GUESS_PATS: LazyLock<GuessPats> = LazyLock::new(|| {
    GuessPats {
    html: Regex::new(r"(?i)^<!doctype\s|^<html\b|^<\?xml\b").expect("html guess is a valid regex"),
    typescript_strong: Regex::new(
        r"\b(interface|type)\s+[A-Za-z0-9_]+\s*(?:=\s*)?[{<]|:\s*(string|number|boolean|void)\b|\bas\s+const\b",
    )
    .expect("typescript guess is a valid regex"),
    typescript_weak: Regex::new(r"\b(const|let|=>|function|import\s.+\sfrom)\b")
        .expect("typescript weak guess is a valid regex"),
    python: Regex::new(r"\bdef\s+[A-Za-z0-9_]+\s*\(|\bself\b|(?m)^\s*(from|import)\s+[A-Za-z0-9_]+(\s+import\s)?")
        .expect("python guess is a valid regex"),
    rust: Regex::new(r"\bfn\s+[A-Za-z0-9_]+|\blet\s+mut\b|::[A-Za-z0-9_]+|#\[[A-Za-z0-9_]+")
        .expect("rust guess is a valid regex"),
    go: Regex::new(r"\bfunc\s+[A-Za-z0-9_]+\(|:=|(?m)\bpackage\s+[A-Za-z0-9_]+$")
        .expect("go guess is a valid regex"),
    sql: Regex::new(r"(?im)^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b")
        .expect("sql guess is a valid regex"),
    css: Regex::new(r"(?m)^[.#]?[\w-]+\s*\{[^:}]*:[^}]*;").expect("css guess is a valid regex"),
    html_tag: Regex::new(r"(?m)^\s*<[a-z][\w-]*(\s|>)").expect("html tag guess is a valid regex"),
    yaml: Regex::new(r"(?m)^\w[\w-]*:\s+\S").expect("yaml guess is a valid regex"),
    braces: Regex::new(r"[{;]").expect("brace guess is a valid regex"),
    bash: Regex::new(r"(?m)^\s*(if|for|while)\s+\[\[|\becho\s|\$\{?[A-Za-z0-9_]+")
        .expect("bash guess is a valid regex"),
}
});

pub(crate) fn splice_shell(
    baseline: Vec<Vec<TokenRun>>,
    code: &str,
    mut tokenize: impl FnMut(&str, &str) -> Vec<Vec<TokenRun>>,
) -> Vec<Vec<TokenRun>> {
    let regions = detect(code);
    if regions.is_empty() {
        return baseline;
    }
    splice(baseline, code, &regions, &mut tokenize)
}

fn detect(command: &str) -> Vec<Region> {
    if !has_embed_shape(command) {
        return Vec::new();
    }
    let mut regions = Vec::new();
    collect_heredocs(command, &mut regions);
    collect_inline(command, &mut regions);
    collapse(regions)
}

fn has_embed_shape(command: &str) -> bool {
    command.contains("<<") || INLINE.is_match(command)
}

fn line_spans(text: &str) -> Vec<LineSpan> {
    let mut out = Vec::new();
    let mut start = 0usize;
    for line in text.split('\n') {
        let end = start + line.len();
        out.push(LineSpan { start, end });
        start = end + 1;
    }
    out
}

fn line_text<'a>(command: &'a str, span: &LineSpan) -> &'a str {
    &command[span.start..span.end]
}

fn collect_heredocs(command: &str, regions: &mut Vec<Region>) {
    let lines = line_spans(command);
    for index in 0..lines.len() {
        let Some(found) = match_heredoc(command, &lines, index) else {
            continue;
        };
        if found.end <= found.start {
            continue;
        }
        let Some(lang) = found.lang else {
            continue;
        };
        regions.push(Region {
            start: found.start,
            end: found.end,
            lang,
        });
    }
}

struct Found {
    start: usize,
    end: usize,
    lang: Option<&'static str>,
}

fn match_heredoc(command: &str, lines: &[LineSpan], index: usize) -> Option<Found> {
    let header = &lines[index];
    let header_text = line_text(command, header);
    let open = HEREDOC_OPEN.captures(header_text)?;
    let delimiter = open
        .get(1)
        .or_else(|| open.get(2))
        .or_else(|| open.get(3))?
        .as_str()
        .to_string();
    let matched = open.get(0)?;
    let tail = &header_text[matched.end()..];
    if !HEREDOC_TAIL.is_match(tail) {
        return None;
    }
    let lead_end = matched.start();
    let terminator = find_terminator(command, lines, index + 1, &delimiter)?;
    let body = body_text(command, lines, index, terminator);
    Some(Found {
        start: header.end + 1,
        end: terminator.start.saturating_sub(1),
        lang: heredoc_lang(&header_text[..lead_end], &body),
    })
}

fn body_text(command: &str, lines: &[LineSpan], header: usize, terminator: &LineSpan) -> String {
    let mut out = String::new();
    for line in lines.iter().skip(header + 1) {
        if line.start == terminator.start {
            break;
        }
        out.push_str(line_text(command, line));
        out.push('\n');
    }
    out
}

fn find_terminator<'a>(
    command: &str,
    lines: &'a [LineSpan],
    from: usize,
    delimiter: &str,
) -> Option<&'a LineSpan> {
    lines
        .iter()
        .skip(from)
        .find(|line| line_text(command, line).trim_end() == delimiter)
}

fn heredoc_lang(lead: &str, body: &str) -> Option<&'static str> {
    if let Some(redirect) = REDIRECT.captures(lead) {
        return lang_for_file(redirect.get(2)?.as_str(), body);
    }
    let bin = lead.trim().split_whitespace().next().unwrap_or("");
    let bin = bin.rsplit('/').next().unwrap_or(bin);
    interpreter_lang(bin)
}

fn lang_for_file(name: &str, body: &str) -> Option<&'static str> {
    let bare = name.rsplit('/').next().unwrap_or(name);
    let ext = bare.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !ext.is_empty() {
        if let Some(lang) = ext_lang(&ext) {
            return Some(lang);
        }
    }
    if let Some(lang) = special_file(&bare.to_ascii_lowercase()) {
        return Some(lang);
    }
    if body.is_empty() {
        None
    } else {
        guess_lang(body)
    }
}

fn ext_lang(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "py" => "python",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "scm" => "scm",
        "rb" => "ruby",
        "go" => "go",
        "rs" => "rust",
        "java" => "java",
        "kt" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "cs" => "csharp",
        "php" => "php",
        "pl" => "perl",
        "lua" => "lua",
        "r" => "r",
        "sh" | "bash" | "zsh" => "bash",
        "sql" => "sql",
        "html" | "htm" => "html",
        "xml" => "xml",
        "css" => "css",
        "scss" => "scss",
        "json" | "jsonc" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "ini" | "env" | "conf" => "ini",
        "md" => "markdown",
        "el" | "lisp" => "lisp",
        "clj" | "cljs" => "clojure",
        "ex" | "exs" => "elixir",
        "erl" => "erlang",
        "hs" => "haskell",
        "scala" => "scala",
        "gql" | "graphql" => "graphql",
        "vim" => "vim",
        "ps1" => "powershell",
        "bat" | "cmd" => "bat",
        "diff" => "diff",
        "text" | "txt" | "log" => "text",
        _ => return None,
    })
}

fn special_file(name: &str) -> Option<&'static str> {
    Some(match name {
        "dockerfile" => "docker",
        "makefile" => "makefile",
        "cmakelists.txt" => "cmake",
        "gemfile" | "rakefile" => "ruby",
        ".env" => "ini",
        ".gitignore" | ".dockerignore" => "ignore",
        _ => return None,
    })
}

fn interpreter_lang(bin: &str) -> Option<&'static str> {
    let stripped = strip_version(bin);
    Some(match bin {
        "python" | "python3" | "py" => "python",
        "node" | "bun" => "javascript",
        "deno" => "typescript",
        "ruby" | "irb" => "ruby",
        "perl" => "perl",
        "php" => "php",
        "R" | "Rscript" => "r",
        "lua" => "lua",
        "jq" => "jq",
        "sqlite3" | "psql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        _ => match stripped {
            "python" | "python3" | "py" => "python",
            "node" | "bun" => "javascript",
            "deno" => "typescript",
            "ruby" | "irb" => "ruby",
            _ => return None,
        },
    })
}

fn strip_version(bin: &str) -> &str {
    let Some(dash) = bin.rfind('-') else {
        return bin;
    };
    let rest = &bin[dash + 1..];
    let mut parts = rest.split('.');
    let Some(major) = parts.next() else {
        return bin;
    };
    if major.is_empty() || !major.bytes().all(|byte| byte.is_ascii_digit()) {
        return bin;
    }
    if let Some(minor) = parts.next() {
        if !minor.is_empty() && !minor.bytes().all(|byte| byte.is_ascii_digit()) {
            return bin;
        }
        if parts.next().is_some() {
            return bin;
        }
    }
    &bin[..dash]
}

fn collect_inline(command: &str, regions: &mut Vec<Region>) {
    for found in INLINE.captures_iter(command) {
        let Some(bin) = found.name("bin") else {
            continue;
        };
        let name = bin.as_str().rsplit('/').next().unwrap_or(bin.as_str());
        let Some(lang) = interpreter_lang(name) else {
            continue;
        };
        let whole = found.get(0).expect("a regex match includes group 0");
        let quote_at = whole.end();
        let Some(quote) = command[quote_at..].chars().next() else {
            continue;
        };
        if quote != '"' && quote != '\'' {
            continue;
        }
        let Some(close) = scan_quoted(command, quote_at + quote.len_utf8(), quote) else {
            continue;
        };
        regions.push(Region {
            start: quote_at + quote.len_utf8(),
            end: close,
            lang,
        });
    }
}

fn scan_quoted(text: &str, from: usize, quote: char) -> Option<usize> {
    let mut index = from;
    while index < text.len() {
        let ch = text[index..].chars().next()?;
        let width = ch.len_utf8();
        if ch == '\\' {
            index += width;
            if let Some(next) = text[index..].chars().next() {
                index += next.len_utf8();
            }
            continue;
        }
        if ch == quote {
            return Some(index);
        }
        index += width;
    }
    None
}

fn collapse(mut regions: Vec<Region>) -> Vec<Region> {
    regions.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut kept: Vec<Region> = Vec::new();
    for region in regions {
        if kept
            .iter()
            .any(|have| region.start < have.end && region.end > have.start)
        {
            continue;
        }
        kept.push(region);
    }
    kept
}

pub(crate) fn guess_lang(code: &str) -> Option<&'static str> {
    let head = head_of(code);
    if let Some(found) = SHEBANG.captures(head) {
        let bin = found.get(1)?.as_str();
        return Some(if bin == "node" {
            "javascript"
        } else if bin.starts_with("python") {
            "python"
        } else if bin == "ruby" {
            "ruby"
        } else {
            "bash"
        });
    }
    let trimmed = head.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        // The whole buffer, not the head: a truncated object must not win.
        if serde_json::from_str::<serde_json::Value>(code).is_ok() {
            return Some("json");
        }
    }
    let pats = &*GUESS_PATS;
    if pats.html.is_match(trimmed) {
        return Some("html");
    }
    // Scores add. A tie keeps the earlier language, which is the order these
    // signals are scored in the TypeScript guesser.
    let mut typescript = 0;
    let mut python = 0;
    let mut rust_score = 0;
    let mut go = 0;
    let mut sql = 0;
    let mut css = 0;
    let mut html = 0;
    let mut yaml = 0;
    let mut bash = 0;
    if pats.typescript_strong.is_match(head) {
        typescript += 2;
    }
    if pats.typescript_weak.is_match(head) {
        typescript += 1;
    }
    if pats.python.is_match(head) {
        python += 2;
    }
    if pats.rust.is_match(head) {
        rust_score += 2;
    }
    if pats.go.is_match(head) {
        go += 2;
    }
    if pats.sql.is_match(head) {
        sql += 2;
    }
    if pats.css.is_match(head) {
        css += 2;
    }
    if pats.html_tag.is_match(head) {
        html += 1;
    }
    if pats.yaml.is_match(head) && !pats.braces.is_match(head) {
        yaml += 2;
    }
    if pats.bash.is_match(head) {
        bash += 1;
    }
    let ranked = [
        ("typescript", typescript),
        ("python", python),
        ("rust", rust_score),
        ("go", go),
        ("sql", sql),
        ("css", css),
        ("html", html),
        ("yaml", yaml),
        ("bash", bash),
    ];
    let mut best: Option<&str> = None;
    let mut best_score = 1;
    for (lang, score) in ranked {
        if score > best_score {
            best = Some(lang);
            best_score = score;
        }
    }
    best
}

fn head_of(code: &str) -> &str {
    let end = code.floor_char_boundary(2000.min(code.len()));
    &code[..end]
}

struct Resolved {
    region: Region,
    lines: Vec<Vec<TokenRun>>,
    first_line: usize,
}

fn splice(
    baseline: Vec<Vec<TokenRun>>,
    code: &str,
    regions: &[Region],
    tokenize: &mut impl FnMut(&str, &str) -> Vec<Vec<TokenRun>>,
) -> Vec<Vec<TokenRun>> {
    let lines = line_spans(code);
    if baseline.len() != lines.len() {
        return baseline;
    }
    let mut usable = Vec::new();
    for region in regions {
        let slice = &code[region.start..region.end];
        let tokens = tokenize(slice, &region.lang);
        if !same_shape(&tokens, slice) {
            continue;
        }
        if !tokens.iter().flatten().any(|run| run.color.is_some()) {
            continue;
        }
        usable.push(Resolved {
            first_line: line_containing(&lines, region.start),
            region: *region,
            lines: tokens,
        });
    }
    if usable.is_empty() {
        return baseline;
    }
    let mut out = Vec::with_capacity(lines.len());
    for (index, span) in lines.iter().enumerate() {
        let line_end = span.end;
        let mut on_line: Vec<&Resolved> = usable
            .iter()
            .filter(|item| item.region.start < line_end && item.region.end > span.start)
            .collect();
        on_line.sort_by_key(|item| item.region.start);
        if on_line.is_empty() {
            out.push(baseline[index].clone());
            continue;
        }
        let mut runs = Vec::new();
        let mut cursor = span.start;
        for item in on_line {
            if item.region.start > cursor {
                push_baseline(
                    &mut runs,
                    &baseline[index],
                    span.start,
                    cursor,
                    item.region.start,
                );
            }
            let embedded_index = index - item.first_line;
            if let Some(embedded) = item.lines.get(embedded_index) {
                runs.extend(embedded.iter().cloned());
            }
            cursor = item.region.end;
        }
        if line_end > cursor {
            push_baseline(&mut runs, &baseline[index], span.start, cursor, line_end);
        }
        if runs.is_empty() {
            out.push(baseline[index].clone());
        } else {
            out.push(runs);
        }
    }
    out
}

fn line_containing(lines: &[LineSpan], offset: usize) -> usize {
    let mut index = 0usize;
    for (at, span) in lines.iter().enumerate() {
        if span.start <= offset {
            index = at;
        } else {
            break;
        }
    }
    index
}

/// `split('\n')` keeps a trailing empty line. The highlighter drops that
/// line, so a slice that ends in a newline fails here and the bash color stays.
fn same_shape(lines: &[Vec<TokenRun>], text: &str) -> bool {
    let want: Vec<&str> = text.split('\n').collect();
    if lines.len() != want.len() {
        return false;
    }
    lines
        .iter()
        .zip(want)
        .all(|(line, want)| line.iter().map(|run| run.text.len()).sum::<usize>() == want.len())
}

fn push_baseline(
    out: &mut Vec<TokenRun>,
    baseline: &[TokenRun],
    line_start: usize,
    from: usize,
    to: usize,
) {
    let mut pos = line_start;
    for run in baseline {
        let run_from = pos;
        let run_to = pos + run.text.len();
        if run_to <= from {
            pos = run_to;
            continue;
        }
        if run_from >= to {
            break;
        }
        let slice_from = from.saturating_sub(run_from);
        let slice_to = to.saturating_sub(run_from).min(run.text.len());
        if slice_to > slice_from {
            out.push(TokenRun {
                text: run.text[slice_from..slice_to].to_string(),
                color: run.color.clone(),
                bold: run.bold,
                italic: run.italic,
            });
        }
        pos = run_to;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, color: Option<&str>) -> TokenRun {
        TokenRun {
            text: text.to_string(),
            color: color.map(str::to_string),
            bold: false,
            italic: false,
        }
    }

    fn joined(lines: &[Vec<TokenRun>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.iter()
                    .map(|item| item.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn scans_shell_shapes_and_splices_the_span() {
        let mut failures = Vec::new();
        let shapes = [
            ("python -c \"print(1)\"", "print(1)", "python"),
            ("node -e 'console.log(1)'", "console.log(1)", "javascript"),
            ("node --eval \"const x = 1\"", "const x = 1", "javascript"),
            ("python3 -c 'import os'", "import os", "python"),
            (
                "cat > app.py << 'EOF'\nx = 1\nprint(x)\nEOF",
                "x = 1\nprint(x)",
                "python",
            ),
            (
                "cat > app.js << EOF\nconsole.log(1)\nEOF",
                "console.log(1)",
                "javascript",
            ),
            (
                "cat > app.mts << EOF\nexport const x: number = 1\nEOF",
                "export const x: number = 1",
                "typescript",
            ),
            (
                "cat > app.cjs << EOF\nmodule.exports = 1\nEOF",
                "module.exports = 1",
                "javascript",
            ),
            ("cat > hook.scm << EOF\n{:key 1}\nEOF", "{:key 1}", "scm"),
            (
                "python - << \"EOF\"\nprint(\"hi\")\nEOF",
                "print(\"hi\")",
                "python",
            ),
            (
                "cat >> conf.yaml << EOF\nname: app\nEOF",
                "name: app",
                "yaml",
            ),
            ("echo hi && python -c \"print(2)\"", "print(2)", "python"),
            ("/usr/bin/python -c \"print(3)\"", "print(3)", "python"),
        ];
        for (command, body, lang) in shapes {
            let regions = detect(command);
            let found = regions
                .first()
                .map(|region| (command[region.start..region.end].to_string(), region.lang));
            let matched = found
                .as_ref()
                .is_some_and(|(text, found_lang)| text == body && *found_lang == lang);
            if !matched || regions.len() != 1 {
                let langs: Vec<_> = regions.iter().map(|region| region.lang).collect();
                failures.push(format!(
                    "shape {command:?}\n  got {found:?} langs {langs:?}\n  want ({body}, {lang}) len 1"
                ));
            }
        }

        for command in [
            "ls -la",
            "git status --short",
            "echo hello world",
            "cat file.txt",
            "npm run build && npm test",
            "cat > app.py << 'EOF'\nx = 1\n",
            "cat > app.py << EOF; ls\nx = 1\nEOF",
            "python -c \"print(1)",
            "frobnicate -c \"print(1)\"",
            "cat > app.xyzzy << EOF\nnothing special\nEOF",
        ] {
            let regions = detect(command);
            if regions.is_empty() {
                continue;
            }
            let first = regions
                .first()
                .map(|region| (command[region.start..region.end].to_string(), region.lang));
            failures.push(format!(
                "no region {command:?}\n  got {first:?} len {}",
                regions.len()
            ));
        }

        let overlap = "python -c \"cat > x << EOF\nbody\nEOF\"\n";
        let regions = detect(overlap);
        if regions.first().map(|region| region.lang) != Some("python") {
            failures.push(format!(
                "overlap first {overlap:?}\n  got {:?}",
                regions.first().map(|region| region.lang)
            ));
        }
        for (index, left) in regions.iter().enumerate() {
            for right in regions.iter().skip(index + 1) {
                if left.start == right.start && left.end == right.end {
                    continue;
                }
                if left.start >= right.end || left.end <= right.start {
                    continue;
                }
                failures.push(format!(
                    "overlap {overlap:?}\n  {}..{} {} hits {}..{} {}",
                    left.start, left.end, left.lang, right.start, right.end, right.lang
                ));
            }
        }

        let guesses = [
            ("def greet(name):\n    return name", Some("python")),
            ("{\"a\": 1, \"b\": [2, 3]}", Some("json")),
            ("some plain prose without code at all", None),
        ];
        for (code, want) in guesses {
            let got = guess_lang(code);
            if got != want {
                failures.push(format!("guess {code:?}\n  got {got:?}\n  want {want:?}"));
            }
        }

        let code = "python -c \"print(1)\"";
        let colorless = vec![vec![run(code, Some("#abc"))]];
        let kept = splice_shell(colorless.clone(), code, |_slice, _lang| {
            vec![vec![run("print(1)", None)]]
        });
        if kept != colorless {
            failures.push(format!(
                "colorless embed\n  got {kept:?}\n  want {colorless:?}"
            ));
        }

        let baseline = vec![vec![run(code, Some("bash"))]];
        let mut painted = None;
        let out = splice_shell(baseline, code, |slice, lang| {
            painted = Some((slice.to_string(), lang.to_string()));
            vec![vec![run("print", Some("py")), run("(1)", Some("py"))]]
        });
        let prefix = out.first().and_then(|line| line.first());
        let paint_ok = painted
            .as_ref()
            .map(|(slice, lang)| (slice.as_str(), lang.as_str()))
            == Some(("print(1)", "python"));
        let text_ok = joined(&out) == code;
        let prefix_text_ok = prefix.is_some_and(|item| item.text == "python -c \"");
        let prefix_color_ok = prefix.is_some_and(|item| item.color.as_deref() == Some("bash"));
        let replaced_ok = out
            .iter()
            .flatten()
            .any(|item| item.color.as_deref() == Some("py"));
        if !paint_ok || !text_ok || !prefix_text_ok || !prefix_color_ok || !replaced_ok {
            failures.push(format!(
                "colored splice\n  painter {painted:?}\n  text {:?}\n  prefix {:?} {:?}\n  py {replaced_ok}",
                joined(&out),
                prefix.map(|item| item.text.as_str()),
                prefix.and_then(|item| item.color.as_deref()),
            ));
        }

        assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    }
}
