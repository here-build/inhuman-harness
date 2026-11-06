//! WebAssembly syntax and embedded-shell highlighter for `surfaces/web`.
//!
//! Shares `irosashi` (`vscode-textmate` + `ferroni`), `arrival.tmLanguage.json`,
//! and `embed.rs` with the native `qd` binary. Exposes a C-ABI linear-memory
//! surface so both browser workers/threads and Node/Vitest can instantiate the
//! single `.wasm` module directly without `wasm-bindgen` glue.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use irosashi::{CodeToTokensOptions, DiagnosticKind, TokensResult};
use serde::Serialize;

use crate::syntax::TokenRun;

const WEB_DARK: &str = "github-dark-default";
const WEB_LIGHT: &str = "github-light-high-contrast";
const MAX_CHARS: usize = 128 * 1024;
const CACHE_LIMIT: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WebTokenRun {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub italic: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WebDiffRun {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WebDiffHighlight {
    #[serde(rename = "oldLines")]
    pub old_lines: Vec<Vec<WebDiffRun>>,
    #[serde(rename = "newLines")]
    pub new_lines: Vec<Vec<WebDiffRun>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WebEmbedRegion {
    pub start: usize,
    pub end: usize,
    pub lang: &'static str,
}

fn is_false(value: &bool) -> bool {
    !*value
}

struct LruCache<V> {
    order: VecDeque<String>,
    map: HashMap<String, V>,
}

impl<V: Clone> LruCache<V> {
    fn new() -> Self {
        Self {
            order: VecDeque::new(),
            map: HashMap::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<V> {
        let hit = self.map.get(key).cloned()?;
        if let Some(index) = self.order.iter().position(|item| item == key) {
            if let Some(found) = self.order.remove(index) {
                self.order.push_back(found);
            }
        }
        Some(hit)
    }

    fn put(&mut self, key: String, value: V) {
        if self.map.contains_key(&key) {
            self.map.insert(key, value);
            return;
        }
        while self.order.len() >= CACHE_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            } else {
                break;
            }
        }
        self.order.push_back(key.clone());
        self.map.insert(key, value);
    }
}

static SINGLE_CACHE: OnceLock<Mutex<LruCache<Vec<Vec<WebTokenRun>>>>> = OnceLock::new();
static DUAL_CACHE: OnceLock<Mutex<LruCache<Vec<Vec<WebDiffRun>>>>> = OnceLock::new();
static DUAL_THEMES: OnceLock<BTreeMap<String, String>> = OnceLock::new();

fn single_cache() -> &'static Mutex<LruCache<Vec<Vec<WebTokenRun>>>> {
    SINGLE_CACHE.get_or_init(|| Mutex::new(LruCache::new()))
}

fn dual_cache() -> &'static Mutex<LruCache<Vec<Vec<WebDiffRun>>>> {
    DUAL_CACHE.get_or_init(|| Mutex::new(LruCache::new()))
}

fn dual_themes() -> &'static BTreeMap<String, String> {
    DUAL_THEMES.get_or_init(|| {
        BTreeMap::from([
            ("dark".to_string(), WEB_DARK.to_string()),
            ("light".to_string(), WEB_LIGHT.to_string()),
        ])
    })
}

pub fn resolve_web_lang(lang: &str) -> String {
    let name = lang.trim().to_ascii_lowercase();
    if name.is_empty() {
        return "text".to_string();
    }
    match name.as_str() {
        "ts" | "mts" | "cts" => "typescript".to_string(),
        "js" | "mjs" | "cjs" => "javascript".to_string(),
        "jsx" => "jsx".to_string(),
        "tsx" => "tsx".to_string(),
        "scheme" | "arrival" => "scm".to_string(),
        "sh" | "shell" | "shellscript" | "zsh" => "bash".to_string(),
        "yml" => "yaml".to_string(),
        "md" | "mdx" => "markdown".to_string(),
        "py" => "python".to_string(),
        "rs" => "rust".to_string(),
        "htm" => "html".to_string(),
        "plaintext" | "txt" | "text" => "text".to_string(),
        _ => name,
    }
}

pub fn lang_from_path(path: &str) -> Option<&'static str> {
    let base = path.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    if base == "dockerfile" {
        return Some("docker");
    }
    if base == "makefile" || base == "gnumakefile" {
        return Some("makefile");
    }
    let dot = base.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(match &base[dot + 1..] {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "scm" => "scm",
        "json" => "json",
        "jsonc" => "jsonc",
        "json5" => "json5",
        "md" | "mdx" => "markdown",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "sh" | "bash" | "zsh" => "bash",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "html" | "htm" => "html",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "ex" | "exs" => "elixir",
        "xml" => "xml",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "lua" => "lua",
        "zig" => "zig",
        "swift" => "swift",
        "scala" => "scala",
        "r" => "r",
        "pl" => "perl",
        "ps1" => "powershell",
        "proto" => "proto",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        "diff" | "patch" => "diff",
        "ini" => "ini",
        "tf" | "hcl" => "hcl",
        "nix" => "nix",
        "dart" => "dart",
        "hs" => "haskell",
        "erl" => "erlang",
        "clj" => "clojure",
        "jl" => "julia",
        _ => return None,
    })
}

pub fn guess_web_lang(code: &str) -> Option<&'static str> {
    crate::embed::guess_lang(code)
}

pub fn detect_web_embeds(command: &str) -> Vec<WebEmbedRegion> {
    crate::embed::detect(command)
        .into_iter()
        .map(|region| WebEmbedRegion {
            start: utf16_offset(command, region.start),
            end: utf16_offset(command, region.end),
            lang: region.lang,
        })
        .collect()
}

fn utf16_offset(text: &str, byte_offset: usize) -> usize {
    text.get(..byte_offset)
        .map_or(0, |prefix| prefix.encode_utf16().count())
}

pub fn highlight_web_lines(code: &str, lang: &str, scheme: &str) -> Option<Vec<Vec<WebTokenRun>>> {
    let resolved = resolve_web_lang(lang);
    if resolved == "text" || code.is_empty() || code.len() > MAX_CHARS {
        return None;
    }
    let theme = if scheme == "dark" { WEB_DARK } else { WEB_LIGHT };
    let key = format!("{theme}\0{resolved}\0{code}");
    if let Ok(mut cache) = single_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return Some(hit);
        }
    }
    let painted = paint_single_with_embeds(code, &resolved, theme)?;
    let out: Vec<Vec<WebTokenRun>> = painted
        .into_iter()
        .map(|line| {
            line.into_iter()
                .map(|run| WebTokenRun {
                    text: run.text,
                    color: run.color,
                    bold: run.bold,
                    italic: run.italic,
                })
                .collect()
        })
        .collect();
    if let Ok(mut cache) = single_cache().lock() {
        cache.put(key, out.clone());
    }
    Some(out)
}

pub fn highlight_web_diff(old_text: &str, new_text: &str, path: &str) -> Option<WebDiffHighlight> {
    let lang = lang_from_path(path)?;
    let resolved = resolve_web_lang(lang);
    if resolved == "text" {
        return None;
    }
    let old_clean = strip_trailing_nl(old_text);
    let new_clean = strip_trailing_nl(new_text);
    if old_clean.len() > MAX_CHARS || new_clean.len() > MAX_CHARS {
        return None;
    }
    let old_lines = if old_clean.is_empty() {
        Vec::new()
    } else {
        highlight_dual_cached(old_clean, &resolved)?
    };
    let new_lines = if new_clean.is_empty() {
        Vec::new()
    } else {
        highlight_dual_cached(new_clean, &resolved)?
    };
    Some(WebDiffHighlight {
        old_lines,
        new_lines,
    })
}

fn strip_trailing_nl(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .or_else(|| text.strip_suffix('\r'))
        .unwrap_or(text)
}

fn highlight_dual_cached(code: &str, resolved: &str) -> Option<Vec<Vec<WebDiffRun>>> {
    let key = format!("{resolved}\0{code}");
    if let Ok(mut cache) = dual_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return Some(hit);
        }
    }
    let painted = paint_dual_with_embeds(code, resolved)?;
    let out: Vec<Vec<WebDiffRun>> = painted
        .into_iter()
        .map(|line| {
            line.into_iter()
                .map(|run| WebDiffRun {
                    text: run.text,
                    color: run.color,
                })
                .collect()
        })
        .collect();
    if let Ok(mut cache) = dual_cache().lock() {
        cache.put(key, out.clone());
    }
    Some(out)
}

fn paint_single_with_embeds(code: &str, resolved: &str, theme: &str) -> Option<Vec<Vec<TokenRun>>> {
    let baseline = paint_single(code, resolved, theme)?;
    if resolved != "bash" {
        return Some(baseline);
    }
    let parent_len = code.len();
    Some(crate::embed::splice_shell(
        baseline,
        code,
        |slice, slice_lang| {
            let inner_lang = resolve_web_lang(slice_lang);
            let inner = if inner_lang == "bash" && slice.len() < parent_len {
                paint_single_with_embeds(slice, &inner_lang, theme)
            } else {
                paint_single(slice, &inner_lang, theme)
            };
            inner.unwrap_or_else(|| plain_runs(slice))
        },
    ))
}

fn paint_single(code: &str, resolved: &str, theme: &str) -> Option<Vec<Vec<TokenRun>>> {
    if code.is_empty() || code.len() > MAX_CHARS {
        return None;
    }
    let engine = crate::syntax::engine()?;
    engine.registry().resolve_language(resolved)?;
    let options = CodeToTokensOptions::new(resolved, theme);
    let result = engine.code_to_tokens(code, &options).ok()?;
    if result
        .diagnostics
        .iter()
        .any(|item| item.kind == DiagnosticKind::UnknownLanguage)
    {
        return None;
    }
    Some(map_single_lines(&result, code))
}

fn map_single_lines(result: &TokensResult, code: &str) -> Vec<Vec<TokenRun>> {
    let mut out = Vec::with_capacity(result.lines.len() + usize::from(code.ends_with('\n')));
    for line in &result.lines {
        let line_text = result.line_text(line);
        let mut runs = Vec::new();
        for token in &line.tokens {
            let text = token.text(line_text);
            if text.is_empty() {
                continue;
            }
            let color = token
                .style
                .color
                .map(|id| result.color(id).to_string())
                .filter(|c| !c.is_empty());
            runs.push(TokenRun {
                text: text.to_string(),
                color,
                bold: token.style.font_style.is_bold(),
                italic: token.style.font_style.is_italic(),
            });
        }
        out.push(runs);
    }
    if code.ends_with('\n') {
        out.push(Vec::new());
    }
    out
}

fn paint_dual_with_embeds(code: &str, resolved: &str) -> Option<Vec<Vec<TokenRun>>> {
    let baseline = paint_dual(code, resolved)?;
    if resolved != "bash" {
        return Some(baseline);
    }
    let parent_len = code.len();
    Some(crate::embed::splice_shell(
        baseline,
        code,
        |slice, slice_lang| {
            let inner_lang = resolve_web_lang(slice_lang);
            let inner = if inner_lang == "bash" && slice.len() < parent_len {
                paint_dual_with_embeds(slice, &inner_lang)
            } else {
                paint_dual(slice, &inner_lang)
            };
            inner.unwrap_or_else(|| plain_runs(slice))
        },
    ))
}

fn paint_dual(code: &str, resolved: &str) -> Option<Vec<Vec<TokenRun>>> {
    if code.is_empty() || code.len() > MAX_CHARS {
        return None;
    }
    let engine = crate::syntax::engine()?;
    engine.registry().resolve_language(resolved)?;
    let options = CodeToTokensOptions::new(resolved, "");
    let result = engine
        .code_to_tokens_multi(code, dual_themes(), &options)
        .ok()?;
    if result
        .diagnostics
        .iter()
        .any(|item| item.kind == DiagnosticKind::UnknownLanguage)
    {
        return None;
    }
    Some(map_dual_lines(&result, code))
}

fn map_dual_lines(result: &TokensResult, code: &str) -> Vec<Vec<TokenRun>> {
    let mut out = Vec::with_capacity(result.lines.len() + usize::from(code.ends_with('\n')));
    for line in &result.lines {
        let line_text = result.line_text(line);
        let mut runs = Vec::new();
        for token in &line.tokens {
            let text = token.text(line_text);
            if text.is_empty() {
                continue;
            }
            // Slot 0 is "dark", slot 1 is "light" (sorted keys in `dual_themes()`).
            let dark = result
                .style_in(token, 0)
                .color
                .map(|id| result.color_in(0, id))
                .filter(|c| !c.is_empty());
            let light = result
                .style_in(token, 1)
                .color
                .map(|id| result.color_in(1, id))
                .filter(|c| !c.is_empty());
            let color = match (light, dark) {
                (Some(l), Some(d)) => Some(format!("--diffs-token-light:{l};--diffs-token-dark:{d}")),
                (Some(l), None) => Some(format!("--diffs-token-light:{l}")),
                (None, Some(d)) => Some(format!("--diffs-token-dark:{d}")),
                (None, None) => None,
            };
            runs.push(TokenRun {
                text: text.to_string(),
                color,
                bold: false,
                italic: false,
            });
        }
        out.push(runs);
    }
    if code.ends_with('\n') {
        out.push(Vec::new());
    }
    out
}

fn plain_runs(code: &str) -> Vec<Vec<TokenRun>> {
    code.split('\n')
        .map(|line| {
            vec![TokenRun {
                text: line.to_string(),
                color: None,
                bold: false,
                italic: false,
            }]
        })
        .collect()
}

// ============================================================================
// Linear-memory FFI surface for WASM
// ============================================================================

thread_local! {
    static RESULT_BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn write_result(bytes: Vec<u8>) -> usize {
    let len = bytes.len();
    RESULT_BUF.with(|cell| {
        *cell.borrow_mut() = bytes;
    });
    len
}

fn write_json<T: Serialize>(value: &T) -> usize {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    write_result(bytes)
}

unsafe fn slice_str<'a>(ptr: *const u8, len: usize) -> &'a str {
    if ptr.is_null() || len == 0 {
        return "";
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    std::str::from_utf8(bytes).unwrap_or("")
}

#[no_mangle]
pub extern "C" fn qd_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn qd_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

#[no_mangle]
pub extern "C" fn qd_result_ptr() -> *const u8 {
    RESULT_BUF.with(|cell| cell.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn qd_result_len() -> usize {
    RESULT_BUF.with(|cell| cell.borrow().len())
}

#[no_mangle]
pub unsafe extern "C" fn qd_highlight_lines(
    code_ptr: *const u8,
    code_len: usize,
    lang_ptr: *const u8,
    lang_len: usize,
    scheme_ptr: *const u8,
    scheme_len: usize,
) -> usize {
    let code = slice_str(code_ptr, code_len);
    let lang = slice_str(lang_ptr, lang_len);
    let scheme = slice_str(scheme_ptr, scheme_len);
    let lines = highlight_web_lines(code, lang, scheme);
    write_json(&lines)
}

#[no_mangle]
pub unsafe extern "C" fn qd_highlight_diff(
    old_ptr: *const u8,
    old_len: usize,
    new_ptr: *const u8,
    new_len: usize,
    path_ptr: *const u8,
    path_len: usize,
) -> usize {
    let old_text = slice_str(old_ptr, old_len);
    let new_text = slice_str(new_ptr, new_len);
    let path = slice_str(path_ptr, path_len);
    let diff = highlight_web_diff(old_text, new_text, path);
    write_json(&diff)
}

#[no_mangle]
pub unsafe extern "C" fn qd_guess_lang(code_ptr: *const u8, code_len: usize) -> usize {
    let code = slice_str(code_ptr, code_len);
    match guess_web_lang(code) {
        Some(lang) => write_result(lang.as_bytes().to_vec()),
        None => write_result(Vec::new()),
    }
}

#[no_mangle]
pub unsafe extern "C" fn qd_detect_embeds(cmd_ptr: *const u8, cmd_len: usize) -> usize {
    let command = slice_str(cmd_ptr, cmd_len);
    let embeds = detect_web_embeds(command);
    write_json(&embeds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_arrival_and_embedded_shell_and_dual_diff() {
        let source = "{:key \"hi\" :n 1}\n(define x #null)\n[a b]";
        let lines = highlight_web_lines(source, "scm", "dark").expect("arrival lines");
        let joined: String = lines
            .iter()
            .map(|l| l.iter().map(|r| r.text.as_str()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(joined, source);

        let shell = "python -c \"print(1)\"";
        let bash_lines = highlight_web_lines(shell, "bash", "light").expect("bash lines");
        let flat: Vec<&WebTokenRun> = bash_lines.iter().flatten().collect();
        let print_run = flat.iter().find(|r| r.text.contains("print")).expect("print run");
        let quote_run = flat.iter().find(|r| r.text.contains('"')).expect("quote run");
        assert_ne!(print_run.color, quote_run.color);

        let diff = highlight_web_diff("const a = 1;\n", "const a = 2;\n", "src/a.ts")
            .expect("diff highlight");
        assert_eq!(diff.old_lines.len(), 1);
        assert_eq!(diff.new_lines.len(), 1);
        assert!(diff.new_lines[0]
            .iter()
            .any(|r| r.color.as_deref().unwrap_or("").contains("--diffs-token-light:")));
    }
}
