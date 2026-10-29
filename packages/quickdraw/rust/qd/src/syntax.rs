//! Shiki's tokenizer, in-process.
//!
//! [`warm`] builds an [`irosashi::Highlighter`]: the vscode-textmate engine
//! Shiki runs, the embedded grammars, `github-dark` / `github-light`, and the
//! Arrival grammar (`scm`, also `scheme` and `arrival`). Grammars are parsed
//! when a line asks for them. Cold calls return one uncolored run per line.
//! The first frame does not call [`warm`]. A bash or shell command is scanned
//! for a heredoc or an inline interpreter, and that body is highlighted again
//! and spliced in by byte offset. The inner call paints a shell body without
//! scanning it again when the slice does not shrink, so a region that covers
//! its own input cannot recurse.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use irosashi::{CodeToTokensOptions, DiagnosticKind, Highlighter, TokensResult};

use crate::{Rgb, Style};

const ARRIVAL: &[u8] = include_bytes!("arrival.tmLanguage.json");
const DARK: &str = "github-dark";
const LIGHT: &str = "github-light";

static WARM: AtomicBool = AtomicBool::new(false);
static POLARITY: AtomicU8 = AtomicU8::new(0);
static ENGINE: OnceLock<Option<Highlighter>> = OnceLock::new();
/// Same bound as `highlightCodeSync`. The key is theme, language, and source.
const HIGHLIGHT_CACHE_LIMIT: usize = 128;
static HIGHLIGHT_CACHE: OnceLock<Mutex<HighlightCache>> = OnceLock::new();

struct HighlightCache {
    order: VecDeque<String>,
    map: HashMap<String, Vec<Vec<TokenRun>>>,
}

fn cache() -> &'static Mutex<HighlightCache> {
    HIGHLIGHT_CACHE.get_or_init(|| {
        Mutex::new(HighlightCache {
            order: VecDeque::new(),
            map: HashMap::new(),
        })
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Polarity {
    Dark,
    Light,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenRun {
    pub text: String,
    pub color: Option<String>,
    pub bold: bool,
    pub italic: bool,
}

pub fn is_warm() -> bool {
    WARM.load(Ordering::Acquire)
}

pub fn polarity() -> Polarity {
    if POLARITY.load(Ordering::Acquire) == 1 {
        Polarity::Light
    } else {
        Polarity::Dark
    }
}

pub fn set_polarity(polarity: Polarity) {
    POLARITY.store(
        match polarity {
            Polarity::Dark => 0,
            Polarity::Light => 1,
        },
        Ordering::Release,
    );
}

/// Load the highlighter and register Arrival. A second call does not reload.
/// Stays cold when the embedded catalog fails to open.
pub fn warm() -> bool {
    let Some(engine) = ENGINE.get_or_init(load_engine).as_ref() else {
        return false;
    };
    let _ = engine;
    WARM.store(true, Ordering::Release);
    true
}

fn load_engine() -> Option<Highlighter> {
    let engine = Highlighter::new().ok()?;
    engine
        .load_language("scm", Arc::<[u8]>::from(ARRIVAL))
        .ok()?;
    engine.register_alias("scheme", "scm");
    engine.register_alias("arrival", "scm");
    engine.register_extension("scm", "scm");
    Some(engine)
}

/// One run per line when cold, unknown, or longer than the highlight cap.
/// A warm result is cached by theme, normalized language, and source. A hit
/// moves to the back. Past 128 entries the oldest entry drops. A poisoned
/// lock skips the cache and still paints.
/// Arrival highlight for serializer text.
///
/// A hard cut is appended on its own line after a character slice, so the
/// marker can land inside a still-open string. That line is highlighted on
/// its own, and the grammar paints `#| … |#` as a comment.
pub fn highlight_scheme(source: &str) -> Vec<Vec<TokenRun>> {
    let Some((body, marker)) = split_hard_cut(source) else {
        return highlight(source, "scm");
    };
    let mut lines = if body.is_empty() {
        Vec::new()
    } else {
        highlight(body, "scm")
    };
    lines.extend(highlight(marker, "scm"));
    lines
}

/// The serializer's last-resort cut. The digits are the budget it applied.
/// Anything after the closer means this line is data, not the cut.
fn split_hard_cut(source: &str) -> Option<(&str, &str)> {
    const MARK: &str = "\n#| … output hard-truncated at ";
    let at = source.rfind(MARK)?;
    let marker = &source[at + 1..];
    let rest = marker.strip_prefix("#| … output hard-truncated at ")?;
    let digits = rest.strip_suffix(" chars |#")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((&source[..at], marker))
}

pub fn highlight(code: &str, lang: &str) -> Vec<Vec<TokenRun>> {
    if !can_paint(code, lang) {
        return plain_lines(code);
    }
    let key = format!("{}\0{}\0{code}", theme_name(), normalize_lang(lang));
    if let Some(hit) = cache_get(&key) {
        return hit;
    }
    let painted = paint(code, lang);
    let painted = if shell_lang(lang) {
        crate::embed::splice_shell(painted, code, |slice, slice_lang| {
            tokenize_embed(slice, slice_lang, code.len())
        })
    } else {
        painted
    };
    cache_put(key, painted.clone());
    painted
}

fn theme_name() -> &'static str {
    match polarity() {
        Polarity::Dark => DARK,
        Polarity::Light => LIGHT,
    }
}

fn cache_get(key: &str) -> Option<Vec<Vec<TokenRun>>> {
    let mut cache = cache().lock().ok()?;
    let hit = cache.map.get(key).cloned()?;
    if let Some(index) = cache.order.iter().position(|item| item == key) {
        if let Some(found) = cache.order.remove(index) {
            cache.order.push_back(found);
        }
    }
    Some(hit)
}

fn cache_put(key: String, lines: Vec<Vec<TokenRun>>) {
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    if cache.map.contains_key(&key) {
        cache.map.insert(key, lines);
        return;
    }
    while cache.order.len() >= HIGHLIGHT_CACHE_LIMIT {
        if let Some(oldest) = cache.order.pop_front() {
            cache.map.remove(&oldest);
        } else {
            break;
        }
    }
    cache.order.push_back(key.clone());
    cache.map.insert(key, lines);
}

fn can_paint(code: &str, lang: &str) -> bool {
    ENGINE.get().and_then(Option::as_ref).is_some()
        && is_warm()
        && !lang.is_empty()
        && code.len() <= 128 * 1024
}

fn shell_lang(lang: &str) -> bool {
    matches!(lang, "sh" | "bash" | "shell" | "zsh")
}

/// Paint `slice` as `lang`. A shell slice is scanned again only when it is
/// shorter than the command it was cut from. An unknown grammar returns
/// colorless lines: its tokens still carry the theme foreground, and splicing
/// those would trade the bash string color for a flat one.
fn tokenize_embed(slice: &str, lang: &str, parent_len: usize) -> Vec<Vec<TokenRun>> {
    if !language_resolves(lang) {
        return plain_lines(slice);
    }
    if shell_lang(lang) && slice.len() < parent_len {
        return highlight(slice, lang);
    }
    paint(slice, lang)
}

fn language_resolves(lang: &str) -> bool {
    let Some(engine) = ENGINE.get().and_then(Option::as_ref) else {
        return false;
    };
    engine
        .registry()
        .resolve_language(&normalize_lang(lang))
        .is_some()
}

fn paint(code: &str, lang: &str) -> Vec<Vec<TokenRun>> {
    let Some(engine) = ENGINE.get().and_then(Option::as_ref) else {
        return plain_lines(code);
    };
    if code.len() > 128 * 1024 {
        return plain_lines(code);
    }
    let options = CodeToTokensOptions::new(&normalize_lang(lang), theme_name());
    let Ok(result) = engine.code_to_tokens(code, &options) else {
        return plain_lines(code);
    };
    if result
        .diagnostics
        .iter()
        .any(|item| item.kind == DiagnosticKind::UnknownLanguage)
    {
        return plain_lines(code);
    }
    map_lines(&result)
}

fn map_lines(result: &TokensResult) -> Vec<Vec<TokenRun>> {
    let mut out = Vec::with_capacity(result.lines.len());
    for line in &result.lines {
        let line_text = result.line_text(line);
        let mut runs = Vec::new();
        for token in &line.tokens {
            let text = token.text(line_text);
            if text.is_empty() {
                continue;
            }
            let color = token.style.color.map(|id| result.color(id).to_string());
            runs.push(TokenRun {
                text: text.to_string(),
                color,
                bold: token.style.font_style.is_bold(),
                italic: token.style.font_style.is_italic(),
            });
        }
        if runs.is_empty() {
            runs.push(plain(line_text));
        }
        out.push(runs);
    }
    if out.is_empty() {
        plain_lines(result.source.as_str())
    } else {
        out
    }
}

pub fn lang_for_path(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "scm" => "scm",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "sh" | "bash" | "zsh" => "bash",
        "json" => "json",
        "md" => "markdown",
        "css" => "css",
        "html" | "htm" => "html",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "ex" | "exs" => "elixir",
        _ => return None,
    })
}

/// Write token color onto a paint style. No color leaves `fg_rgb` alone.
pub fn apply_run(style: &mut Style, run: &TokenRun) {
    if let Some(color) = run.color.as_deref() {
        if let Some(rgb) = parse_hex(color) {
            style.fg_rgb = Some(rgb);
        }
    }
    if run.bold {
        style.bold = true;
    }
    if run.italic {
        style.italic = true;
    }
}

fn normalize_lang(lang: &str) -> String {
    match lang {
        "ts" | "tsx" | "typescript" | "mts" | "cts" => "typescript".to_string(),
        "js" | "jsx" | "javascript" | "mjs" | "cjs" => "javascript".to_string(),
        "scm" | "scheme" | "arrival" => "scm".to_string(),
        "py" | "python" => "python".to_string(),
        "rs" | "rust" => "rust".to_string(),
        "sh" | "bash" | "shell" | "zsh" => "bash".to_string(),
        "yml" | "yaml" => "yaml".to_string(),
        "md" | "markdown" => "markdown".to_string(),
        other => other.to_string(),
    }
}

fn plain_lines(code: &str) -> Vec<Vec<TokenRun>> {
    if code.is_empty() {
        return vec![vec![plain("")]];
    }
    let mut lines: Vec<&str> = code.split('\n').collect();
    if code.ends_with('\n') {
        lines.pop();
    }
    if lines.is_empty() {
        return vec![vec![plain("")]];
    }
    lines.into_iter().map(|line| vec![plain(line)]).collect()
}

fn plain(text: &str) -> TokenRun {
    TokenRun {
        text: text.to_string(),
        color: None,
        bold: false,
        italic: false,
    }
}

fn parse_hex(color: &str) -> Option<Rgb> {
    let hex = color.strip_prefix('#').unwrap_or(color);
    if hex.len() != 6 {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    Some(Rgb {
        r: f64::from((value >> 16) & 0xff),
        g: f64::from((value >> 8) & 0xff),
        b: f64::from(value & 0xff),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "export function greet() {\n  return \"hello\";\n}";
    const ARRIVAL_SAMPLE: &str = "{:key \"hi\" :n 1}\n(define x #null)\n[a b]";

    fn colors(lines: &[Vec<TokenRun>]) -> Vec<String> {
        lines
            .iter()
            .flatten()
            .filter_map(|run| run.color.clone())
            .collect()
    }

    fn joined(lines: &[Vec<TokenRun>]) -> String {
        lines
            .iter()
            .map(|line| line.iter().map(|run| run.text.as_str()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn cold_is_plain_then_warm_palettes_differ() {
        if !is_warm() {
            let lines = highlight(SAMPLE, "typescript");
            assert!(colors(&lines).is_empty());
            assert!(lines
                .iter()
                .any(|line| line.iter().any(|run| run.text.contains("function"))));
            let shell = highlight("python -c \"print(1)\"", "bash");
            assert!(colors(&shell).is_empty());
            assert_eq!(joined(&shell), "python -c \"print(1)\"");
        }
        assert!(warm());
        set_polarity(Polarity::Dark);
        let dark = colors(&highlight(SAMPLE, "typescript"));
        set_polarity(Polarity::Light);
        let light = colors(&highlight(SAMPLE, "typescript"));
        let again = colors(&highlight(SAMPLE, "typescript"));
        assert!(!dark.is_empty(), "darkHasTokens");
        assert!(!light.is_empty());
        assert_ne!(dark, light, "paletteFollowsPolarity");
        assert_eq!(
            light, again,
            "a second warm highlight keeps the cached palette"
        );
    }

    fn runs_between<'a>(line: &'a [TokenRun], from: usize, to: usize) -> Vec<&'a TokenRun> {
        let mut pos = 0usize;
        line.iter()
            .filter(|run| {
                let start = pos;
                pos += run.text.len();
                start >= from && pos <= to
            })
            .collect()
    }

    #[test]
    fn warm_paint_keeps_the_source_and_splits_each_body() {
        assert!(warm());
        set_polarity(Polarity::Dark);

        let command = "python -c \"print(1)\"";
        for lang in ["bash", "shell"] {
            let lines = highlight(command, lang);
            assert_eq!(joined(&lines), command, "inline python source {lang}");
            let open = command.find('"').expect("opening quote") + 1;
            let close = command.rfind('"').expect("closing quote");
            let inside = runs_between(&lines[0], open, close);
            assert!(
                inside.len() > 1,
                "inline python body run count {lang}: {:?}",
                inside
                    .iter()
                    .map(|run| run.text.as_str())
                    .collect::<Vec<_>>()
            );
            assert!(
                inside.iter().all(|run| run.color.is_some()),
                "inline python body color {lang}"
            );
        }

        let heredoc = "cat > hook.scm << EOF\n{:key 1}\nEOF";
        let lines = highlight(heredoc, "bash");
        assert_eq!(joined(&lines), heredoc, "arrival heredoc source");
        assert!(lines[1].len() > 1, "scm body stays one bash string");
        assert!(
            lines[1].iter().any(|run| run.color.is_some()),
            "arrival heredoc body color"
        );
        assert_eq!(
            lines
                .last()
                .and_then(|line| line.first())
                .map(|run| run.text.as_str()),
            Some("EOF"),
            "arrival heredoc terminator"
        );

        let sql = "sqlite3 db << 'EOF'\nSELECT 1;\nEOF";
        let lines = highlight(sql, "bash");
        assert_eq!(joined(&lines), sql, "sql source");
        assert!(lines[1].len() > 1, "sql body was left as one bash run");
        assert!(
            lines[1].iter().any(|run| run.text.contains("SELECT")),
            "sql body keeps SELECT"
        );

        let lines = highlight(ARRIVAL_SAMPLE, "scm");
        assert_eq!(joined(&lines), ARRIVAL_SAMPLE, "arrival source");
        let body = "{:k \"ab";
        let marker = "#| … output hard-truncated at 40 chars |#";
        let cut = format!("{body}\n{marker}");
        let cut_lines = highlight_scheme(&cut);
        assert_eq!(joined(&cut_lines), cut, "hard cut keeps both lines");
        let marker_color = cut_lines
            .last()
            .and_then(|line| line.iter().find(|run| run.text.contains("truncated")))
            .and_then(|run| run.color.clone());
        let comment_color = highlight("#| note |#", "scm")
            .first()
            .and_then(|line| line.iter().find(|run| run.text.contains("note")))
            .and_then(|run| run.color.clone());
        assert_eq!(marker_color, comment_color, "hard cut is a comment");
        assert!(marker_color.is_some(), "hard cut comment has a color");
        let string_color = cut_lines
            .first()
            .and_then(|line| line.iter().find(|run| run.text.contains("ab")))
            .and_then(|run| run.color.clone());
        assert_ne!(
            string_color, marker_color,
            "open string does not paint the cut"
        );
        let quoted = highlight_scheme("\"hello…(+4 chars)\"");
        let quoted_colors: Vec<_> = quoted
            .iter()
            .flatten()
            .filter(|run| run.text.contains("hello") || run.text.contains("…(+4 chars)"))
            .filter_map(|run| run.color.clone())
            .collect();
        assert!(
            quoted_colors.len() >= 1
                && quoted_colors.iter().all(|color| color == &quoted_colors[0]),
            "string ellipsis stays inside the string"
        );
        let palette: std::collections::BTreeSet<_> = colors(&lines).into_iter().collect();
        assert!(palette.len() >= 3, "arrival colors: {}", palette.len());

        let typescript = "const x: number = 1;";
        let lines = highlight(typescript, "typescript");
        assert_eq!(joined(&lines), typescript, "typescript source");
        assert!(
            !lines[0]
                .iter()
                .any(|run| run.text.contains("const x: number")),
            "typescript is not scanned"
        );
    }
}
