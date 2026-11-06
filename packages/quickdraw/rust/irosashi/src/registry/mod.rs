pub(crate) mod corpus;
mod languages;

use std::collections::{BTreeMap, HashMap};
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::Deserialize;

use crate::Error;
use crate::grammar::{Grammar, GrammarResolver};
use crate::regex::LazyRegex;
use crate::theme::Theme;
use crate::tokenizer::InjectionProvider;

pub use corpus::CorpusEncoder;
pub use languages::{DEFAULT_ALIASES, DEFAULT_EXTENSIONS, DEFAULT_FILENAMES, PLAINTEXT_NAMES};

#[cfg(feature = "embedded-assets")]
static EMBEDDED_CORPUS: &[u8] = include_bytes!("../../assets/corpus.bin");

#[cfg(not(target_arch = "wasm32"))]
const INDEX_FILE: &str = "index.json";
#[cfg(not(target_arch = "wasm32"))]
const INDEX_VERSION: u32 = 1;
const FIRST_LINE_PROBE_LIMIT: usize = 1024;

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrammarMeta {
    #[serde(default)]
    pub scope_name: String,
    #[serde(default)]
    pub file_types: Vec<String>,
    #[serde(default)]
    pub inject_to: Vec<String>,
    #[serde(default)]
    pub first_line_match: Option<String>,
}

impl ThemeColors {
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            kind: theme.kind.clone(),
            foreground: theme.default_foreground().to_owned(),
            background: theme.default_background().to_owned(),
            selection_background: theme.colors.get("editor.selectionBackground").cloned(),
            line_highlight_background: theme.colors.get("editor.lineHighlightBackground").cloned(),
            colors: theme.colors.clone(),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Deserialize)]
struct Index {
    version: u32,
    grammars: BTreeMap<String, GrammarMeta>,
}

/// The `colors` a renderer needs from a theme, plus the whole map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeColors {
    pub kind: String,
    pub foreground: String,
    pub background: String,
    pub selection_background: Option<String>,
    pub line_highlight_background: Option<String>,
    pub colors: BTreeMap<String, String>,
}

/// Where bundled grammar and theme assets come from.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum AssetSource {
    /// `grammars/{name}.json` (plus `grammars/index.json`) and `themes/{name}.json`
    /// under a root directory.
    Dir(PathBuf),
    /// The pre-parsed binary corpus compiled into the crate.
    #[cfg(feature = "embedded-assets")]
    Embedded,
    /// No bundled assets; only registered grammars and themes exist.
    None,
}

struct GrammarEntry {
    meta: GrammarMeta,
    corpus_slice: Option<corpus::CorpusSlice>,
    custom_override: bool,
    parsed: OnceLock<Result<Arc<Grammar>, Error>>,
}

struct ThemeEntry {
    corpus_slice: Option<corpus::CorpusSlice>,
    parsed: OnceLock<Result<Arc<Theme>, Error>>,
}

fn clone_lock<T: Clone>(lock: &OnceLock<T>) -> OnceLock<T> {
    let copy = OnceLock::new();
    if let Some(value) = lock.get() {
        let _ = copy.set(value.clone());
    }
    copy
}

impl Clone for GrammarEntry {
    fn clone(&self) -> Self {
        Self {
            meta: self.meta.clone(),
            corpus_slice: self.corpus_slice,
            custom_override: self.custom_override,
            parsed: clone_lock(&self.parsed),
        }
    }
}

impl Clone for ThemeEntry {
    fn clone(&self) -> Self {
        Self {
            corpus_slice: self.corpus_slice,
            parsed: clone_lock(&self.parsed),
        }
    }
}

/// Configures a `Registry`. Built-in alias, extension and file name tables are applied
/// first; entries added here override them.
#[derive(Debug, Clone)]
pub struct RegistryBuilder {
    source: AssetSource,
    grammars: BTreeMap<String, Arc<[u8]>>,
    themes: BTreeMap<String, Arc<[u8]>>,
    aliases: Vec<(String, String)>,
    extensions: Vec<(String, String)>,
    filenames: Vec<(String, String)>,
    default_tables: bool,
}

impl RegistryBuilder {
    pub fn new(source: AssetSource) -> Self {
        Self {
            source,
            grammars: BTreeMap::new(),
            themes: BTreeMap::new(),
            aliases: Vec::new(),
            extensions: Vec::new(),
            filenames: Vec::new(),
            default_tables: true,
        }
    }

    pub fn from_dir(root: impl Into<PathBuf>) -> Self {
        Self::new(AssetSource::Dir(root.into()))
    }

    #[cfg(feature = "embedded-assets")]
    pub fn embedded() -> Self {
        Self::new(AssetSource::Embedded)
    }

    pub fn without_bundled_assets() -> Self {
        Self::new(AssetSource::None)
    }

    /// Registers grammar JSON under `name`, replacing a bundled grammar of the same
    /// name. Registering the same name twice is an error.
    pub fn grammar(mut self, name: &str, json: impl Into<Arc<[u8]>>) -> Result<Self, Error> {
        if self.grammars.contains_key(name) {
            return Err(Error::GrammarParse(format!(
                "grammar {name:?} registered twice"
            )));
        }
        self.grammars.insert(name.to_owned(), json.into());
        Ok(self)
    }

    pub fn theme(mut self, name: &str, json: impl Into<Arc<[u8]>>) -> Result<Self, Error> {
        if self.themes.contains_key(name) {
            return Err(Error::ThemeParse(format!(
                "theme {name:?} registered twice"
            )));
        }
        self.themes.insert(name.to_owned(), json.into());
        Ok(self)
    }

    pub fn alias(mut self, alias: &str, target: &str) -> Self {
        self.aliases.push((alias.to_owned(), target.to_owned()));
        self
    }

    /// Maps a file extension (without the dot) to a grammar name.
    pub fn extension(mut self, ext: &str, lang: &str) -> Self {
        self.extensions
            .push((ext.to_ascii_lowercase(), lang.to_owned()));
        self
    }

    /// Maps an exact file name to a grammar name.
    pub fn filename(mut self, filename: &str, lang: &str) -> Self {
        self.filenames.push((filename.to_owned(), lang.to_owned()));
        self
    }

    /// Skips the built-in alias, extension and file name tables.
    pub fn without_default_tables(mut self) -> Self {
        self.default_tables = false;
        self
    }

    pub fn build(self) -> Result<Registry, Error> {
        let mut grammars: BTreeMap<String, GrammarEntry> = BTreeMap::new();
        let mut themes: BTreeMap<String, ThemeEntry> = BTreeMap::new();
        let mut corpus_ref: Option<(corpus::CorpusStrings, &'static [u8])> = None;

        match &self.source {
            #[cfg(feature = "embedded-assets")]
            AssetSource::Embedded => {
                let header = corpus::parse_corpus_header(EMBEDDED_CORPUS)?;
                corpus_ref = Some((header.strings, header.payloads));
                for (name, meta, slice) in header.grammars {
                    grammars.insert(
                        name,
                        GrammarEntry {
                            meta,
                            corpus_slice: Some(slice),
                            custom_override: false,
                            parsed: OnceLock::new(),
                        },
                    );
                }
                for (name, slice) in header.themes {
                    themes.insert(
                        name,
                        ThemeEntry {
                            corpus_slice: Some(slice),
                            parsed: OnceLock::new(),
                        },
                    );
                }
            }
            #[cfg(not(target_arch = "wasm32"))]
            AssetSource::Dir(root) => {
                let bytes = fs::read(root.join("grammars").join(INDEX_FILE))
                    .map_err(|_| Error::Io(format!("grammars/{INDEX_FILE} not found")))?;
                let index: Index = serde_json::from_slice(&bytes)
                    .map_err(|err| Error::GrammarParse(format!("{INDEX_FILE}: {err}")))?;
                if index.version != INDEX_VERSION {
                    return Err(Error::GrammarParse(format!(
                        "{INDEX_FILE}: unsupported version {}",
                        index.version
                    )));
                }
                for (name, meta) in index.grammars {
                    grammars.insert(
                        name,
                        GrammarEntry {
                            meta,
                            corpus_slice: None,
                            custom_override: false,
                            parsed: OnceLock::new(),
                        },
                    );
                }
                if let Ok(entries) = fs::read_dir(root.join("themes")) {
                    let mut names: Vec<String> = entries
                        .filter_map(Result::ok)
                        .map(|e| e.path())
                        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
                        .filter_map(|p| p.file_stem()?.to_str().map(str::to_owned))
                        .collect();
                    names.sort();
                    for name in names {
                        themes.insert(
                            name,
                            ThemeEntry {
                                corpus_slice: None,
                                parsed: OnceLock::new(),
                            },
                        );
                    }
                }
            }
            #[cfg(target_arch = "wasm32")]
            AssetSource::Dir(_) => {
                return Err(Error::Io("directory assets unsupported on wasm32".to_owned()));
            }
            AssetSource::None => {}
        }

        for (name, bytes) in self.grammars {
            let meta: GrammarMeta = serde_json::from_slice(&bytes)
                .map_err(|err| Error::GrammarParse(format!("grammar {name:?}: {err}")))?;
            let grammar = Grammar::parse(&bytes).map(Arc::new)?;
            let parsed = OnceLock::new();
            let _ = parsed.set(Ok(grammar));
            grammars.insert(
                name,
                GrammarEntry {
                    meta,
                    corpus_slice: None,
                    custom_override: true,
                    parsed,
                },
            );
        }

        for (name, bytes) in self.themes {
            let theme = Theme::parse(&bytes).map(Arc::new)?;
            let parsed = OnceLock::new();
            let _ = parsed.set(Ok(theme));
            themes.insert(
                name,
                ThemeEntry {
                    corpus_slice: None,
                    parsed,
                },
            );
        }

        let mut registry = Registry {
            source: self.source,
            corpus: corpus_ref,
            grammars: BTreeMap::new(),
            themes,
            aliases: HashMap::new(),
            ext_index: HashMap::new(),
            filename_index: HashMap::new(),
            scope_index: HashMap::new(),
            injection_index: HashMap::new(),
            first_line: Vec::new(),
        };
        for (name, entry) in grammars {
            registry.index_grammar(&name, &entry.meta, entry.custom_override, false);
            registry.grammars.insert(name, entry);
        }

        if self.default_tables {
            for (ext, lang) in DEFAULT_EXTENSIONS {
                registry
                    .ext_index
                    .insert((*ext).to_owned(), (*lang).to_owned());
            }
            for (file, lang) in DEFAULT_FILENAMES {
                registry
                    .filename_index
                    .insert((*file).to_owned(), (*lang).to_owned());
            }
            for (alias, lang) in DEFAULT_ALIASES {
                registry
                    .aliases
                    .insert((*alias).to_owned(), (*lang).to_owned());
            }
        }
        for (ext, lang) in self.extensions {
            registry.ext_index.insert(ext, lang);
        }
        for (file, lang) in self.filenames {
            registry.filename_index.insert(file, lang);
        }
        for (alias, lang) in self.aliases {
            registry.aliases.insert(alias, lang);
        }

        Ok(registry)
    }
}

/// Grammars and themes, parsed lazily and at most once each. Immutable after build,
/// so it is shared freely across threads; the `with_*` methods return an updated
/// copy for callers that need to add assets later.
pub struct Registry {
    source: AssetSource,
    corpus: Option<(corpus::CorpusStrings, &'static [u8])>,
    grammars: BTreeMap<String, GrammarEntry>,
    themes: BTreeMap<String, ThemeEntry>,
    aliases: HashMap<String, String>,
    ext_index: HashMap<String, String>,
    filename_index: HashMap<String, String>,
    scope_index: HashMap<String, String>,
    injection_index: HashMap<String, Vec<String>>,
    first_line: Vec<(String, LazyRegex)>,
}

impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry")
            .field("grammars", &self.grammars.len())
            .field("themes", &self.themes.len())
            .finish()
    }
}

impl Registry {
    pub fn from_dir(root: &Path) -> Result<Self, Error> {
        RegistryBuilder::from_dir(root).build()
    }

    #[cfg(feature = "embedded-assets")]
    pub fn embedded() -> Result<Self, Error> {
        RegistryBuilder::embedded().build()
    }

    /// Grammar names, sorted.
    pub fn languages(&self) -> impl Iterator<Item = &str> {
        self.grammars.keys().map(String::as_str)
    }

    /// Theme names, sorted.
    pub fn themes(&self) -> impl Iterator<Item = &str> {
        self.themes.keys().map(String::as_str)
    }

    /// Names of the grammars parsed so far, sorted. Grows as languages are used.
    pub fn loaded_languages(&self) -> Vec<String> {
        self.grammars
            .iter()
            .filter(|(_, e)| matches!(e.parsed.get(), Some(Ok(_))))
            .map(|(n, _)| n.clone())
            .collect()
    }

    /// Names of the themes parsed so far, sorted.
    pub fn loaded_themes(&self) -> Vec<String> {
        self.themes
            .iter()
            .filter(|(_, e)| matches!(e.parsed.get(), Some(Ok(_))))
            .map(|(n, _)| n.clone())
            .collect()
    }

    fn index_grammar(
        &mut self,
        name: &str,
        meta: &GrammarMeta,
        ext_overrides: bool,
        scope_overrides: bool,
    ) {
        if !meta.scope_name.is_empty() {
            if scope_overrides {
                self.scope_index
                    .insert(meta.scope_name.clone(), name.to_owned());
            } else {
                self.scope_index
                    .entry(meta.scope_name.clone())
                    .or_insert_with(|| name.to_owned());
            }
        }
        for target in &meta.inject_to {
            self.injection_index
                .entry(target.clone())
                .or_default()
                .push(name.to_owned());
        }
        for ext in &meta.file_types {
            let ext = ext.trim_start_matches('.').to_ascii_lowercase();
            if ext.is_empty() {
                continue;
            }
            if ext_overrides {
                self.ext_index.insert(ext, name.to_owned());
            } else {
                self.ext_index.entry(ext).or_insert_with(|| name.to_owned());
            }
        }
        if let Some(pattern) = &meta.first_line_match {
            self.first_line
                .push((name.to_owned(), LazyRegex::new(pattern)));
        }
    }

    fn unindex_grammar(&mut self, name: &str, meta: &GrammarMeta) {
        if self
            .scope_index
            .get(&meta.scope_name)
            .is_some_and(|n| n == name)
        {
            self.scope_index.remove(&meta.scope_name);
        }
        for target in &meta.inject_to {
            if let Some(list) = self.injection_index.get_mut(target) {
                list.retain(|n| n != name);
                if list.is_empty() {
                    self.injection_index.remove(target);
                }
            }
        }
        self.first_line.retain(|(n, _)| n != name);
    }

    fn copy(&self) -> Self {
        Self {
            source: self.source.clone(),
            corpus: self.corpus.clone(),
            grammars: self.grammars.clone(),
            themes: self.themes.clone(),
            aliases: self.aliases.clone(),
            ext_index: self.ext_index.clone(),
            filename_index: self.filename_index.clone(),
            scope_index: self.scope_index.clone(),
            injection_index: self.injection_index.clone(),
            first_line: self
                .first_line
                .iter()
                .map(|(n, r)| (n.clone(), LazyRegex::from_rewritten(r.source().to_owned())))
                .collect(),
        }
    }

    /// A copy with `json` parsed and registered as grammar `name`, replacing a grammar
    /// of that name. Its scope, injections and file types win over existing entries.
    pub fn with_grammar(&self, name: &str, json: impl Into<Arc<[u8]>>) -> Result<Self, Error> {
        let bytes: Arc<[u8]> = json.into();
        let meta: GrammarMeta = serde_json::from_slice(&bytes)
            .map_err(|err| Error::GrammarParse(format!("grammar {name:?}: {err}")))?;
        let grammar = Grammar::parse(&bytes).map(Arc::new)?;
        let mut next = self.copy();
        if let Some(old) = next.grammars.remove(name) {
            next.unindex_grammar(name, &old.meta);
        }
        next.index_grammar(name, &meta, true, true);
        next.first_line.sort_by(|a, b| a.0.cmp(&b.0));
        let parsed = OnceLock::new();
        let _ = parsed.set(Ok(grammar));
        next.grammars.insert(
            name.to_owned(),
            GrammarEntry {
                meta,
                corpus_slice: None,
                custom_override: true,
                parsed,
            },
        );
        Ok(next)
    }

    /// A copy with `json` parsed and registered as theme `name`, replacing a theme of
    /// that name.
    pub fn with_theme(&self, name: &str, json: impl Into<Arc<[u8]>>) -> Result<Self, Error> {
        let bytes: Arc<[u8]> = json.into();
        let theme = Theme::parse(&bytes).map(Arc::new)?;
        let mut next = self.copy();
        let parsed = OnceLock::new();
        let _ = parsed.set(Ok(theme));
        next.themes.insert(
            name.to_owned(),
            ThemeEntry {
                corpus_slice: None,
                parsed,
            },
        );
        Ok(next)
    }

    pub fn with_alias(&self, alias: &str, target: &str) -> Self {
        let mut next = self.copy();
        next.aliases.insert(alias.to_owned(), target.to_owned());
        next
    }

    /// Maps a file extension (without the dot) to a grammar name.
    pub fn with_extension(&self, ext: &str, lang: &str) -> Self {
        let mut next = self.copy();
        next.ext_index
            .insert(ext.to_ascii_lowercase(), lang.to_owned());
        next
    }

    /// Maps an exact file name to a grammar name.
    pub fn with_filename(&self, filename: &str, lang: &str) -> Self {
        let mut next = self.copy();
        next.filename_index
            .insert(filename.to_owned(), lang.to_owned());
        next
    }

    pub fn grammar_meta(&self, name: &str) -> Option<&GrammarMeta> {
        self.grammars.get(name).map(|e| &e.meta)
    }

    /// The grammar name `name` refers to: itself when it is a grammar, otherwise its
    /// alias target (one hop), otherwise nothing.
    pub fn resolve_language(&self, name: &str) -> Option<&str> {
        if let Some((key, _)) = self.grammars.get_key_value(name) {
            return Some(key);
        }
        let target = self.aliases.get(name)?;
        self.grammars
            .get_key_value(target.as_str())
            .map(|(k, _)| k.as_str())
    }

    pub fn grammar(&self, name: &str) -> Result<Arc<Grammar>, Error> {
        let resolved = self
            .resolve_language(name)
            .ok_or_else(|| Error::LanguageNotFound(name.to_owned()))?;
        let entry = &self.grammars[resolved];
        entry
            .parsed
            .get_or_init(|| {
                if let (Some(slice), Some((strings, payloads))) = (entry.corpus_slice, &self.corpus)
                {
                    return corpus::decode_grammar(strings, payloads, slice).map(Arc::new);
                }
                #[cfg(not(target_arch = "wasm32"))]
                if let AssetSource::Dir(root) = &self.source {
                    let bytes = fs::read(root.join("grammars").join(format!("{resolved}.json")))
                        .map_err(|_| Error::Io(format!("grammar {resolved:?} missing")))?;
                    return Grammar::parse(&bytes).map(Arc::new);
                }
                Err(Error::Io(format!("grammar {resolved:?} missing")))
            })
            .clone()
    }

    pub fn grammar_by_scope(&self, scope: &str) -> Result<Arc<Grammar>, Error> {
        match self.scope_index.get(scope) {
            Some(name) => self.grammar(name),
            None => Err(Error::LanguageNotFound(scope.to_owned())),
        }
    }

    pub fn theme(&self, name: &str) -> Result<Arc<Theme>, Error> {
        let entry = self
            .themes
            .get(name)
            .ok_or_else(|| Error::ThemeNotFound(name.to_owned()))?;
        entry
            .parsed
            .get_or_init(|| {
                if let (Some(slice), Some((strings, payloads))) = (entry.corpus_slice, &self.corpus)
                {
                    return corpus::decode_theme(strings, payloads, slice).map(Arc::new);
                }
                #[cfg(not(target_arch = "wasm32"))]
                if let AssetSource::Dir(root) = &self.source {
                    let bytes = fs::read(root.join("themes").join(format!("{name}.json")))
                        .map_err(|_| Error::ThemeNotFound(name.to_owned()))?;
                    return Theme::parse(&bytes).map(Arc::new);
                }
                Err(Error::ThemeNotFound(name.to_owned()))
            })
            .clone()
    }

    pub fn theme_colors(&self, name: &str) -> Result<ThemeColors, Error> {
        let theme = self.theme(name)?;
        Ok(ThemeColors::from_theme(&theme))
    }

    /// Exact file name first, then the lowercased extension.
    pub fn detect_by_filename(&self, filename: &str) -> Option<&str> {
        let path = Path::new(filename);
        let base = path.file_name()?.to_str()?;
        if let Some(lang) = self.filename_index.get(base) {
            return Some(lang);
        }
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        self.ext_index.get(&ext).map(String::as_str)
    }

    /// The first grammar (in name order) whose `firstLineMatch` matches the line.
    pub fn detect_by_first_line(&self, line: &str) -> Option<&str> {
        let line = line.lines().next().unwrap_or("");
        let mut end = line.len().min(FIRST_LINE_PROBE_LIMIT);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        let probe = &line[..end];
        self.first_line
            .iter()
            .find(|(_, regex)| regex.is_match(probe))
            .map(|(name, _)| name.as_str())
    }
}

impl GrammarResolver for Registry {
    fn grammar_by_scope(&self, scope: &str) -> Option<Arc<Grammar>> {
        Registry::grammar_by_scope(self, scope).ok()
    }
}

impl InjectionProvider for Registry {
    fn injectors_for(&self, scope: &str) -> Vec<Arc<Grammar>> {
        self.injection_index
            .get(scope)
            .map(|names| names.iter().filter_map(|n| self.grammar(n).ok()).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_or_verify_corpus() {
        if let Ok(src_dir) = std::env::var("IROSASHI_SOURCE_ASSETS") {
            let root = Path::new(&src_dir);
            let index_bytes = fs::read(root.join("grammars").join("index.json")).unwrap();
            let mut index: Index = serde_json::from_slice(&index_bytes).unwrap();
            index.grammars.remove("emacs-lisp");
            index.grammars.remove("wolfram");

            // Also include Arrival ("scm") so runtime needs zero JSON parsing.
            let arrival_path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../qd/src/arrival.tmLanguage.json");
            let arrival_bytes = fs::read(&arrival_path).unwrap();
            let mut arrival_meta: GrammarMeta = serde_json::from_slice(&arrival_bytes).unwrap();
            if !arrival_meta.file_types.iter().any(|ext| ext == "scm") {
                arrival_meta.file_types.push("scm".to_owned());
            }
            index.grammars.insert("scm".to_owned(), arrival_meta);

            let mut grammars = Vec::with_capacity(index.grammars.len());
            for (name, meta) in index.grammars {
                let bytes = if name == "scm" {
                    arrival_bytes.clone()
                } else {
                    fs::read(root.join("grammars").join(format!("{name}.json"))).unwrap()
                };
                let g = Grammar::parse(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                grammars.push((name, meta, g));
            }

            let theme_names = [
                "github-dark",
                "github-dark-default",
                "github-light",
                "github-light-high-contrast",
            ];
            let mut themes = Vec::with_capacity(theme_names.len());
            for name in theme_names {
                let bytes = fs::read(root.join("themes").join(format!("{name}.json"))).unwrap();
                let t = Theme::parse(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                themes.push((name.to_owned(), t));
            }

            let blob = CorpusEncoder::new().build(&mut grammars, &mut themes);
            let header = corpus::parse_corpus_header(&blob).unwrap();
            assert_eq!(header.grammars.len(), grammars.len());
            assert_eq!(header.themes.len(), themes.len());
            for ((name, orig_meta, orig_g), (dec_name, dec_meta, slice)) in
                grammars.iter().zip(&header.grammars)
            {
                assert_eq!(name, dec_name);
                assert_eq!(orig_meta, dec_meta);
                let dec_g =
                    corpus::decode_grammar(&header.strings, header.payloads, *slice).unwrap();
                assert_eq!(orig_g, &dec_g, "grammar mismatch for {name}");
            }
            for ((name, orig_t), (dec_name, slice)) in themes.iter().zip(&header.themes) {
                assert_eq!(name, dec_name);
                let dec_t =
                    corpus::decode_theme(&header.strings, header.payloads, *slice).unwrap();
                assert_eq!(orig_t.name, dec_t.name);
                assert_eq!(orig_t.colors, dec_t.colors);
                assert_eq!(orig_t.token_colors, dec_t.token_colors);
                assert_eq!(orig_t.color_table, dec_t.color_table);
                assert_eq!(orig_t.default_foreground, dec_t.default_foreground);
                assert_eq!(orig_t.default_background, dec_t.default_background);
            }

            let out_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/corpus.bin");
            fs::write(&out_path, &blob).unwrap();
            eprintln!("Wrote {} bytes to {}", blob.len(), out_path.display());
            return;
        }

        let r = Registry::embedded().unwrap();
        assert_eq!(r.languages().count(), 256);
        assert_eq!(r.themes().count(), 4);
        for lang in r.languages() {
            let g = r.grammar(lang).unwrap_or_else(|e| panic!("{lang}: {e}"));
            let root = crate::grammar::compile_patterns(&g, crate::grammar::ROOT_RULE_ID, &g, &r)
                .unwrap_or_else(|e| panic!("{lang} compile_patterns: {e}"));
            assert!(!root.is_empty(), "{lang} produced empty root patterns");
        }
        assert!(r.theme("github-dark").is_ok());
        assert!(r.theme("github-dark-default").is_ok());
        assert!(r.theme("github-light").is_ok());
        assert!(r.theme("github-light-high-contrast").is_ok());
    }
}
