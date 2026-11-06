use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::Error;
use crate::grammar::{
    Capture, Captures, Composite, Expression, Grammar, Include, Injection, Priority, Repository,
    Rule, RuleId, Selector, Term,
};
use crate::regex::LazyRegex;
use crate::registry::GrammarMeta;
use crate::theme::matcher::CompiledSelector;
use crate::theme::{ColorId, FontStyle, Theme, TokenColor, TokenSettings};

const MAGIC: &[u8; 5] = b"IROC\x02";

#[derive(Clone, Copy)]
pub(crate) struct CorpusSlice {
    pub offset: usize,
    pub len: usize,
}

#[derive(Clone)]
pub(crate) struct CorpusStrings {
    table: Arc<[Box<str>]>,
}

impl CorpusStrings {
    pub fn get_owned(&self, id: u32) -> Result<String, Error> {
        self.table
            .get(id as usize)
            .map(|s| (**s).to_owned())
            .ok_or_else(|| Error::GrammarParse(format!("corpus string id {id} out of bounds")))
    }

    pub fn get_opt_owned(&self, raw: u32) -> Result<Option<String>, Error> {
        if raw == 0 {
            Ok(None)
        } else {
            self.get_owned(raw - 1).map(Some)
        }
    }
}

pub(crate) struct CorpusHeader<'a> {
    pub strings: CorpusStrings,
    pub payloads: &'a [u8],
    pub grammars: Vec<(String, GrammarMeta, CorpusSlice)>,
    pub themes: Vec<(String, CorpusSlice)>,
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn u8(&mut self) -> Result<u8, Error> {
        let b = *self
            .buf
            .get(self.pos)
            .ok_or_else(|| Error::GrammarParse("corpus unexpected EOF".to_owned()))?;
        self.pos += 1;
        Ok(b)
    }

    fn slice(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or_else(|| Error::GrammarParse("corpus slice overflow".to_owned()))?;
        let out = self
            .buf
            .get(self.pos..end)
            .ok_or_else(|| Error::GrammarParse("corpus unexpected EOF in slice".to_owned()))?;
        self.pos = end;
        Ok(out)
    }

    fn varint(&mut self) -> Result<u32, Error> {
        let mut out = 0u32;
        let mut shift = 0u32;
        loop {
            let b = self.u8()?;
            out |= u32::from(b & 0x7f)
                .checked_shl(shift)
                .ok_or_else(|| Error::GrammarParse("corpus varint overflow".to_owned()))?;
            if b & 0x80 == 0 {
                return Ok(out);
            }
            shift += 7;
        }
    }

    fn str_owned(&mut self, strings: &CorpusStrings) -> Result<String, Error> {
        let id = self.varint()?;
        strings.get_owned(id)
    }

    fn opt_str_owned(&mut self, strings: &CorpusStrings) -> Result<Option<String>, Error> {
        let raw = self.varint()?;
        strings.get_opt_owned(raw)
    }

    fn str_vec(&mut self, strings: &CorpusStrings) -> Result<Vec<String>, Error> {
        let len = self.varint()? as usize;
        let mut out = Vec::with_capacity(len);
        for _ in 0..len {
            out.push(self.str_owned(strings)?);
        }
        Ok(out)
    }

    fn rule_id_vec(&mut self) -> Result<Vec<RuleId>, Error> {
        let len = self.varint()? as usize;
        let mut out = Vec::with_capacity(len);
        for _ in 0..len {
            out.push(RuleId(self.varint()?));
        }
        Ok(out)
    }

    fn opt_rule_id(&mut self) -> Result<Option<RuleId>, Error> {
        let raw = self.varint()?;
        if raw == 0 {
            Ok(None)
        } else {
            Ok(Some(RuleId(raw - 1)))
        }
    }

    fn repository(&mut self, strings: &CorpusStrings) -> Result<Repository, Error> {
        let len = self.varint()? as usize;
        let mut map = HashMap::with_capacity(len);
        for _ in 0..len {
            let key = self.str_owned(strings)?;
            let id = RuleId(self.varint()?);
            map.insert(key, id);
        }
        Ok(Repository(map))
    }

    fn captures(&mut self, strings: &CorpusStrings) -> Result<Captures, Error> {
        let total_len = self.varint()? as usize;
        if total_len == 0 {
            return Ok(Captures::default());
        }
        let present = self.varint()? as usize;
        let mut list = vec![None; total_len];
        for _ in 0..present {
            let idx = self.varint()? as usize;
            let name = self.opt_str_owned(strings)?;
            let patterns = self.opt_rule_id()?;
            if idx < list.len() {
                list[idx] = Some(Capture { name, patterns });
            }
        }
        Ok(Captures(list))
    }

    fn selector(&mut self, strings: &CorpusStrings) -> Result<Selector, Error> {
        let composites = self.composites(strings)?;
        Ok(Selector { composites })
    }

    fn composites(&mut self, strings: &CorpusStrings) -> Result<Vec<Composite>, Error> {
        let len = self.varint()? as usize;
        let mut out = Vec::with_capacity(len);
        for _ in 0..len {
            let priority = match self.u8()? {
                0 => Priority::Left,
                1 => Priority::None,
                _ => Priority::Right,
            };
            let expr_len = self.varint()? as usize;
            let mut expressions = Vec::with_capacity(expr_len);
            for _ in 0..expr_len {
                let flags = self.u8()?;
                let negate = (flags & 1) != 0;
                let term = if (flags & 2) != 0 {
                    Term::Group(self.composites(strings)?)
                } else {
                    Term::Path(self.str_owned(strings)?)
                };
                expressions.push(Expression { negate, term });
            }
            out.push(Composite {
                priority,
                expressions,
            });
        }
        Ok(out)
    }
}

pub(crate) fn parse_corpus_header(blob: &[u8]) -> Result<CorpusHeader<'_>, Error> {
    if blob.len() < 5 || &blob[..5] != MAGIC {
        return Err(Error::GrammarParse("invalid corpus magic".to_owned()));
    }
    let mut r = Reader::new(&blob[5..]);
    let string_count = r.varint()? as usize;
    let mut table = Vec::with_capacity(string_count);
    let mut prev = Vec::<u8>::new();
    for _ in 0..string_count {
        let common = r.varint()? as usize;
        let suffix_len = r.varint()? as usize;
        let suffix = r.slice(suffix_len)?;
        if common > prev.len() {
            return Err(Error::GrammarParse("corpus prefix overflow".to_owned()));
        }
        prev.truncate(common);
        prev.extend_from_slice(suffix);
        let s = std::str::from_utf8(&prev)
            .map_err(|err| Error::GrammarParse(format!("corpus utf8: {err}")))?;
        table.push(s.to_owned().into_boxed_str());
    }
    let strings = CorpusStrings {
        table: Arc::from(table.into_boxed_slice()),
    };

    let grammar_count = r.varint()? as usize;
    let mut grammars = Vec::with_capacity(grammar_count);
    for _ in 0..grammar_count {
        let name = r.str_owned(&strings)?;
        let scope_name = r.str_owned(&strings)?;
        let file_types = r.str_vec(&strings)?;
        let inject_to = r.str_vec(&strings)?;
        let first_line_match = r.opt_str_owned(&strings)?;
        let offset = r.varint()? as usize;
        let len = r.varint()? as usize;
        grammars.push((
            name,
            GrammarMeta {
                scope_name,
                file_types,
                inject_to,
                first_line_match,
            },
            CorpusSlice { offset, len },
        ));
    }

    let theme_count = r.varint()? as usize;
    let mut themes = Vec::with_capacity(theme_count);
    for _ in 0..theme_count {
        let name = r.str_owned(&strings)?;
        let offset = r.varint()? as usize;
        let len = r.varint()? as usize;
        themes.push((name, CorpusSlice { offset, len }));
    }

    let payloads = &blob[5 + r.pos..];
    Ok(CorpusHeader {
        strings,
        payloads,
        grammars,
        themes,
    })
}

pub(crate) fn decode_grammar(
    strings: &CorpusStrings,
    payloads: &[u8],
    slice: CorpusSlice,
) -> Result<Grammar, Error> {
    let bytes = payloads
        .get(slice.offset..slice.offset + slice.len)
        .ok_or_else(|| Error::GrammarParse("grammar payload slice out of bounds".to_owned()))?;
    let mut r = Reader::new(bytes);
    let scope_name = r.str_owned(strings)?;
    let name = r.opt_str_owned(strings)?;
    let rules_len = r.varint()? as usize;
    let mut rules = Vec::with_capacity(rules_len);
    let mut enclosing = Vec::with_capacity(rules_len);
    for _ in 0..rules_len {
        enclosing.push(r.opt_rule_id()?);
        let tag = r.u8()?;
        let rule = match tag {
            0 => Rule::Noop,
            1 => {
                let inc = match r.u8()? {
                    0 => Include::SelfRef,
                    1 => Include::Base,
                    2 => Include::Local(r.str_owned(strings)?),
                    3 => Include::Scope(r.str_owned(strings)?),
                    _ => Include::ScopeKey(r.str_owned(strings)?, r.str_owned(strings)?),
                };
                Rule::Include(inc)
            }
            2 => {
                let name = r.opt_str_owned(strings)?;
                let regex = LazyRegex::from_rewritten(r.str_owned(strings)?);
                let captures = r.captures(strings)?;
                Rule::Match {
                    name,
                    regex,
                    captures,
                }
            }
            3 => {
                let flags = r.u8()?;
                let name = r.opt_str_owned(strings)?;
                let content_name = r.opt_str_owned(strings)?;
                let begin = LazyRegex::from_rewritten(r.str_owned(strings)?);
                let end = LazyRegex::from_rewritten(r.str_owned(strings)?);
                let begin_captures = r.captures(strings)?;
                let end_captures = r.captures(strings)?;
                let patterns = r.rule_id_vec()?;
                Rule::BeginEnd {
                    name,
                    content_name,
                    begin,
                    end,
                    end_has_backrefs: (flags & 1) != 0,
                    begin_captures,
                    end_captures,
                    patterns,
                    apply_end_pattern_last: (flags & 2) != 0,
                    needs_begin_capture_texts: (flags & 4) != 0,
                }
            }
            4 => {
                let flags = r.u8()?;
                let name = r.opt_str_owned(strings)?;
                let content_name = r.opt_str_owned(strings)?;
                let begin = LazyRegex::from_rewritten(r.str_owned(strings)?);
                let while_ = LazyRegex::from_rewritten(r.str_owned(strings)?);
                let begin_captures = r.captures(strings)?;
                let while_captures = r.captures(strings)?;
                let patterns = r.rule_id_vec()?;
                Rule::BeginWhile {
                    name,
                    content_name,
                    begin,
                    while_,
                    while_has_backrefs: (flags & 1) != 0,
                    begin_captures,
                    while_captures,
                    patterns,
                    needs_begin_capture_texts: (flags & 2) != 0,
                }
            }
            _ => {
                let patterns = r.rule_id_vec()?;
                let has_repo = r.u8()? != 0;
                let repository = if has_repo {
                    Some(r.repository(strings)?)
                } else {
                    None
                };
                Rule::Collection {
                    patterns,
                    repository,
                }
            }
        };
        rules.push(rule);
    }
    let repository = r.repository(strings)?;
    let inj_len = r.varint()? as usize;
    let mut injections = Vec::with_capacity(inj_len);
    for _ in 0..inj_len {
        let raw_selector = r.str_owned(strings)?;
        let selector = r.selector(strings)?;
        let rule = RuleId(r.varint()?);
        injections.push(Injection {
            raw_selector,
            selector,
            rule,
        });
    }
    let injection_selector = if r.u8()? != 0 {
        Some(r.selector(strings)?)
    } else {
        None
    };
    let inject_to = r.str_vec(strings)?;

    Ok(Grammar {
        scope_name,
        name,
        rules,
        enclosing,
        repository,
        injections,
        injection_selector,
        inject_to,
    })
}

pub(crate) fn decode_theme(
    strings: &CorpusStrings,
    payloads: &[u8],
    slice: CorpusSlice,
) -> Result<Theme, Error> {
    let bytes = payloads
        .get(slice.offset..slice.offset + slice.len)
        .ok_or_else(|| Error::ThemeParse("theme payload slice out of bounds".to_owned()))?;
    let mut r = Reader::new(bytes);
    let name = r.str_owned(strings)?;
    let display_name = r.str_owned(strings)?;
    let kind = r.str_owned(strings)?;
    let colors_len = r.varint()? as usize;
    let mut colors = BTreeMap::new();
    for _ in 0..colors_len {
        let k = r.str_owned(strings)?;
        let v = r.str_owned(strings)?;
        colors.insert(k, v);
    }
    let color_table = r.str_vec(strings)?;
    let mut color_ids = HashMap::with_capacity(color_table.len());
    for (idx, color) in color_table.iter().enumerate() {
        color_ids.insert(color.clone(), ColorId(idx as u32));
    }
    let default_foreground = ColorId(r.varint()?);
    let default_background = ColorId(r.varint()?);
    let tc_len = r.varint()? as usize;
    let mut token_colors = Vec::with_capacity(tc_len);
    for _ in 0..tc_len {
        let scopes = r.str_vec(strings)?;
        let fg_raw = r.varint()?;
        let bg_raw = r.varint()?;
        let fs_raw = r.u8()?;
        let settings = TokenSettings {
            foreground: if fg_raw == 0 {
                None
            } else {
                Some(ColorId(fg_raw - 1))
            },
            background: if bg_raw == 0 {
                None
            } else {
                Some(ColorId(bg_raw - 1))
            },
            font_style: if fs_raw == 0 {
                None
            } else {
                Some(FontStyle::from_bits_truncate(fs_raw - 1))
            },
        };
        let sel_len = r.varint()? as usize;
        let mut selectors = Vec::with_capacity(sel_len);
        for _ in 0..sel_len {
            let parts = r.str_vec(strings)?;
            let scope_depth = r.varint()? as usize;
            selectors.push(CompiledSelector { parts, scope_depth });
        }
        token_colors.push(TokenColor {
            scopes,
            settings,
            selectors,
        });
    }

    Ok(Theme {
        id: Theme::next_id(),
        name,
        display_name,
        kind,
        colors,
        token_colors,
        color_table,
        color_ids,
        default_foreground,
        default_background,
    })
}

pub struct CorpusEncoder {
    map: HashMap<String, u32>,
    strings: Vec<String>,
}

impl Default for CorpusEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl CorpusEncoder {
    pub fn new() -> Self {
        let mut map = HashMap::new();
        map.insert(String::new(), 0);
        Self {
            map,
            strings: vec![String::new()],
        }
    }

    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.map.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        let owned = s.to_owned();
        self.map.insert(owned.clone(), id);
        self.strings.push(owned);
        id
    }

    fn write_varint(out: &mut Vec<u8>, mut n: u32) {
        while n >= 0x80 {
            out.push(((n & 0x7f) as u8) | 0x80);
            n >>= 7;
        }
        out.push(n as u8);
    }

    fn write_str(&mut self, out: &mut Vec<u8>, s: &str) {
        let id = self.intern(s);
        Self::write_varint(out, id);
    }

    fn write_opt_str(&mut self, out: &mut Vec<u8>, opt: Option<&str>) {
        match opt {
            None => Self::write_varint(out, 0),
            Some(s) => {
                let id = self.intern(s);
                Self::write_varint(out, id + 1);
            }
        }
    }

    fn write_str_vec(&mut self, out: &mut Vec<u8>, list: &[String]) {
        Self::write_varint(out, list.len() as u32);
        for s in list {
            self.write_str(out, s);
        }
    }

    fn write_rule_id_vec(out: &mut Vec<u8>, list: &[RuleId]) {
        Self::write_varint(out, list.len() as u32);
        for id in list {
            Self::write_varint(out, id.0);
        }
    }

    fn write_opt_rule_id(out: &mut Vec<u8>, opt: Option<RuleId>) {
        match opt {
            None => Self::write_varint(out, 0),
            Some(id) => Self::write_varint(out, id.0 + 1),
        }
    }

    fn write_repository(&mut self, out: &mut Vec<u8>, repo: &Repository) {
        let mut pairs: Vec<(&String, &RuleId)> = repo.0.iter().collect();
        pairs.sort_by(|a, b| a.0.cmp(b.0));
        Self::write_varint(out, pairs.len() as u32);
        for (k, id) in pairs {
            self.write_str(out, k);
            Self::write_varint(out, id.0);
        }
    }

    fn write_captures(&mut self, out: &mut Vec<u8>, captures: &Captures) {
        Self::write_varint(out, captures.0.len() as u32);
        if captures.0.is_empty() {
            return;
        }
        let present = captures.0.iter().filter(|c| c.is_some()).count();
        Self::write_varint(out, present as u32);
        for (idx, cap) in captures.0.iter().enumerate() {
            if let Some(c) = cap {
                Self::write_varint(out, idx as u32);
                self.write_opt_str(out, c.name.as_deref());
                Self::write_opt_rule_id(out, c.patterns);
            }
        }
    }

    fn write_selector(&mut self, out: &mut Vec<u8>, selector: &Selector) {
        self.write_composites(out, &selector.composites);
    }

    fn write_composites(&mut self, out: &mut Vec<u8>, composites: &[Composite]) {
        Self::write_varint(out, composites.len() as u32);
        for comp in composites {
            out.push(match comp.priority {
                Priority::Left => 0,
                Priority::None => 1,
                Priority::Right => 2,
            });
            Self::write_varint(out, comp.expressions.len() as u32);
            for expr in &comp.expressions {
                match &expr.term {
                    Term::Path(p) => {
                        out.push(u8::from(expr.negate));
                        self.write_str(out, p);
                    }
                    Term::Group(alts) => {
                        out.push(u8::from(expr.negate) | 2);
                        self.write_composites(out, alts);
                    }
                }
            }
        }
    }

    fn encode_grammar(&mut self, g: &Grammar) -> Vec<u8> {
        let mut out = Vec::new();
        self.write_str(&mut out, &g.scope_name);
        self.write_opt_str(&mut out, g.name.as_deref());
        Self::write_varint(&mut out, g.rules.len() as u32);
        for (idx, rule) in g.rules.iter().enumerate() {
            Self::write_opt_rule_id(&mut out, g.enclosing[idx]);
            match rule {
                Rule::Noop => out.push(0),
                Rule::Include(inc) => {
                    out.push(1);
                    match inc {
                        Include::SelfRef => out.push(0),
                        Include::Base => out.push(1),
                        Include::Local(k) => {
                            out.push(2);
                            self.write_str(&mut out, k);
                        }
                        Include::Scope(s) => {
                            out.push(3);
                            self.write_str(&mut out, s);
                        }
                        Include::ScopeKey(s, k) => {
                            out.push(4);
                            self.write_str(&mut out, s);
                            self.write_str(&mut out, k);
                        }
                    }
                }
                Rule::Match {
                    name,
                    regex,
                    captures,
                } => {
                    out.push(2);
                    self.write_opt_str(&mut out, name.as_deref());
                    self.write_str(&mut out, regex.source());
                    self.write_captures(&mut out, captures);
                }
                Rule::BeginEnd {
                    name,
                    content_name,
                    begin,
                    end,
                    end_has_backrefs,
                    begin_captures,
                    end_captures,
                    patterns,
                    apply_end_pattern_last,
                    needs_begin_capture_texts,
                } => {
                    out.push(3);
                    let flags = u8::from(*end_has_backrefs)
                        | (u8::from(*apply_end_pattern_last) << 1)
                        | (u8::from(*needs_begin_capture_texts) << 2);
                    out.push(flags);
                    self.write_opt_str(&mut out, name.as_deref());
                    self.write_opt_str(&mut out, content_name.as_deref());
                    self.write_str(&mut out, begin.source());
                    self.write_str(&mut out, end.source());
                    self.write_captures(&mut out, begin_captures);
                    self.write_captures(&mut out, end_captures);
                    Self::write_rule_id_vec(&mut out, patterns);
                }
                Rule::BeginWhile {
                    name,
                    content_name,
                    begin,
                    while_,
                    while_has_backrefs,
                    begin_captures,
                    while_captures,
                    patterns,
                    needs_begin_capture_texts,
                } => {
                    out.push(4);
                    let flags =
                        u8::from(*while_has_backrefs) | (u8::from(*needs_begin_capture_texts) << 1);
                    out.push(flags);
                    self.write_opt_str(&mut out, name.as_deref());
                    self.write_opt_str(&mut out, content_name.as_deref());
                    self.write_str(&mut out, begin.source());
                    self.write_str(&mut out, while_.source());
                    self.write_captures(&mut out, begin_captures);
                    self.write_captures(&mut out, while_captures);
                    Self::write_rule_id_vec(&mut out, patterns);
                }
                Rule::Collection {
                    patterns,
                    repository,
                } => {
                    out.push(5);
                    Self::write_rule_id_vec(&mut out, patterns);
                    if let Some(repo) = repository {
                        out.push(1);
                        self.write_repository(&mut out, repo);
                    } else {
                        out.push(0);
                    }
                }
            }
        }
        self.write_repository(&mut out, &g.repository);
        Self::write_varint(&mut out, g.injections.len() as u32);
        for inj in &g.injections {
            self.write_str(&mut out, &inj.raw_selector);
            self.write_selector(&mut out, &inj.selector);
            Self::write_varint(&mut out, inj.rule.0);
        }
        if let Some(sel) = &g.injection_selector {
            out.push(1);
            self.write_selector(&mut out, sel);
        } else {
            out.push(0);
        }
        self.write_str_vec(&mut out, &g.inject_to);
        out
    }

    fn encode_theme(&mut self, t: &Theme) -> Vec<u8> {
        let mut out = Vec::new();
        self.write_str(&mut out, &t.name);
        self.write_str(&mut out, &t.display_name);
        self.write_str(&mut out, &t.kind);
        Self::write_varint(&mut out, t.colors.len() as u32);
        for (k, v) in &t.colors {
            self.write_str(&mut out, k);
            self.write_str(&mut out, v);
        }
        self.write_str_vec(&mut out, &t.color_table);
        Self::write_varint(&mut out, t.default_foreground.0);
        Self::write_varint(&mut out, t.default_background.0);
        Self::write_varint(&mut out, t.token_colors.len() as u32);
        for tc in &t.token_colors {
            self.write_str_vec(&mut out, &tc.scopes);
            match tc.settings.foreground {
                None => Self::write_varint(&mut out, 0),
                Some(id) => Self::write_varint(&mut out, id.0 + 1),
            }
            match tc.settings.background {
                None => Self::write_varint(&mut out, 0),
                Some(id) => Self::write_varint(&mut out, id.0 + 1),
            }
            match tc.settings.font_style {
                None => out.push(0),
                Some(fs) => out.push(1 + fs.bits()),
            }
            Self::write_varint(&mut out, tc.selectors.len() as u32);
            for sel in &tc.selectors {
                self.write_str_vec(&mut out, &sel.parts);
                Self::write_varint(&mut out, sel.scope_depth as u32);
            }
        }
        out
    }

    fn encode_sections(
        &mut self,
        grammars: &[(String, GrammarMeta, Grammar)],
        themes: &[(String, Theme)],
    ) -> (Vec<u8>, Vec<u8>) {
        let mut payloads = Vec::new();
        let mut g_slices = Vec::with_capacity(grammars.len());
        for (_, _, grammar) in grammars {
            let encoded = self.encode_grammar(grammar);
            let offset = payloads.len() as u32;
            let len = encoded.len() as u32;
            payloads.extend_from_slice(&encoded);
            g_slices.push((offset, len));
        }

        let mut t_slices = Vec::with_capacity(themes.len());
        for (_, theme) in themes {
            let encoded = self.encode_theme(theme);
            let offset = payloads.len() as u32;
            let len = encoded.len() as u32;
            payloads.extend_from_slice(&encoded);
            t_slices.push((offset, len));
        }

        let mut index = Vec::new();
        Self::write_varint(&mut index, grammars.len() as u32);
        for ((name, meta, _), (offset, len)) in grammars.iter().zip(g_slices) {
            self.write_str(&mut index, name);
            self.write_str(&mut index, &meta.scope_name);
            self.write_str_vec(&mut index, &meta.file_types);
            self.write_str_vec(&mut index, &meta.inject_to);
            self.write_opt_str(&mut index, meta.first_line_match.as_deref());
            Self::write_varint(&mut index, offset);
            Self::write_varint(&mut index, len);
        }

        Self::write_varint(&mut index, themes.len() as u32);
        for ((name, _), (offset, len)) in themes.iter().zip(t_slices) {
            self.write_str(&mut index, name);
            Self::write_varint(&mut index, offset);
            Self::write_varint(&mut index, len);
        }
        (index, payloads)
    }

    pub fn build(
        mut self,
        grammars: &[(String, GrammarMeta, Grammar)],
        themes: &[(String, Theme)],
    ) -> Vec<u8> {
        // Pass 1: collect all unique strings, then sort lexicographically for front-coding.
        let _ = self.encode_sections(grammars, themes);
        self.strings[1..].sort();
        self.map.clear();
        for (idx, s) in self.strings.iter().enumerate() {
            self.map.insert(s.clone(), idx as u32);
        }

        // Pass 2: encode index and payloads with sorted string IDs.
        let (index, payloads) = self.encode_sections(grammars, themes);

        let mut str_blob = Vec::new();
        Self::write_varint(&mut str_blob, self.strings.len() as u32);
        let mut prev: &[u8] = b"";
        for s in &self.strings {
            let bytes = s.as_bytes();
            let common = prev
                .iter()
                .zip(bytes.iter())
                .take_while(|(a, b)| a == b)
                .count();
            let suffix = &bytes[common..];
            Self::write_varint(&mut str_blob, common as u32);
            Self::write_varint(&mut str_blob, suffix.len() as u32);
            str_blob.extend_from_slice(suffix);
            prev = bytes;
        }

        let mut blob = Vec::with_capacity(5 + str_blob.len() + index.len() + payloads.len());
        blob.extend_from_slice(MAGIC);
        blob.extend_from_slice(&str_blob);
        blob.extend_from_slice(&index);
        blob.extend_from_slice(&payloads);
        blob
    }
}
