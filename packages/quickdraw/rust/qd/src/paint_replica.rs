//! Paint-patch reader and retained speech, thinking, work, and composer widgets.
//!
//! Down-messages are the worker's `paint_init` / `paint_patch` bytes
//! (`packages/harness/src/tui/paint-transport.ts`). [`PaintReplica::apply`]
//! parses those bytes once into [`Down`] and a list of [`Action`]s. Later
//! code does not re-scan the JSON. `paint_init` replaces the tree and sets
//! `seq` back to 0. `paint_patch` needs a prior init, the same epoch, and
//! `seq == last + 1`. A gap or a mismatch is a [`PaintError`], not a panic.
//! One failed op in a batch leaves `seq` unchanged (the TypeScript reader
//! does not commit `seq` either, and does not roll the batch back).
//!
//! A splice is an edit of the node's existing [`String`] (UTF-16 indexes,
//! matching JavaScript). A shortening or in-capacity edit does not allocate
//! a second string. There is no replicated id. [`NodeRef`] is the local
//! object: an in-place field replace keeps it; a structural replace of that
//! child allocates a new one. A one-field replace does not clone the tree.

use std::collections::BTreeMap;

use crate::paint_widget::{parse as parse_widget, FieldMut, Kind, Widget};
use crate::syntax::{self, Polarity};
use crate::widgets::{AgentRow, RewindPin};

/// Local object identity. Not a wire id. Equal across an in-place field replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NodeRef {
    index: u32,
    generation: u32,
}

/// Kinds recorded while a patch tally is armed. First-seen order.
/// A kind listed in `rebuilt` is omitted from `cached`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchTally {
    pub rebuilt: Vec<&'static str>,
    pub cached: Vec<&'static str>,
}

impl PatchTally {
    /// `seq=<n> rebuilt=<kinds> cached=<kinds>`. Empty side is `-`.
    pub fn line(&self, seq: u64) -> String {
        format!(
            "seq={seq} rebuilt={} cached={}",
            kind_list(&self.rebuilt),
            kind_list(&self.cached)
        )
    }
}

/// `noteReplica`. `Init` drops the tally. `Patch` arms one, and a second
/// arm while one is open does not reset it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplicaNote {
    Init,
    Patch,
}

/// Speech expand-cache polarity. Not a grammar and not a theme solve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyntaxPolarity {
    Dark,
    Light,
}

/// Protocol and apply faults. Display text for the three transport faults
/// matches `PaintProtocolError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaintError {
    Parse { detail: String },
    PatchBeforeInit,
    SeqGap { expected: u64, got: u64 },
    EpochMismatch { expected: String, got: String },
    ApplyFailed { detail: String },
}

impl PaintError {
    pub fn code(&self) -> &'static str {
        match self {
            PaintError::Parse { .. } => "parse",
            PaintError::PatchBeforeInit => "patch_before_init",
            PaintError::SeqGap { .. } => "seq_gap",
            PaintError::EpochMismatch { .. } => "epoch_mismatch",
            PaintError::ApplyFailed { .. } => "apply_failed",
        }
    }
}

impl std::fmt::Display for PaintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PaintError::Parse { detail } => write!(f, "{detail}"),
            PaintError::PatchBeforeInit => write!(f, "paint_patch before paint_init"),
            PaintError::SeqGap { expected, got } => {
                write!(f, "paint_patch seq {got} != {expected}")
            }
            PaintError::EpochMismatch { expected, got } => {
                write!(f, "paint_patch epoch {got} != {expected}")
            }
            PaintError::ApplyFailed { detail } => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for PaintError {}

/// Parsed down-message. Produced once from the bytes; apply does not parse again.
#[derive(Clone, Debug, PartialEq)]
pub enum Down {
    Init {
        epoch: String,
        snapshot: Json,
    },
    Patch {
        epoch: String,
        seq: u64,
        patches: Vec<Patch>,
    },
}

/// One patch after the JSON object has been read.
#[derive(Clone, Debug, PartialEq)]
pub struct Patch {
    pub steps: Vec<String>,
    pub action: Action,
}

/// Patch operation. `Splice` is the transport op; the others are MST JSON patch.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Add(Json),
    Replace(Json),
    Remove,
    Splice {
        from: usize,
        delete: usize,
        insert: String,
    },
}

/// JSON value kept on a node field. Strings are edited in place.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

/// Reader plus retained widgets. One owner. No lock.
#[derive(Debug)]
pub struct PaintReplica {
    arena: Arena,
    clock: u32,
    root: Option<u32>,
    epoch: Option<String>,
    seq: u64,
    open_tally: Option<OpenTally>,
    polarity: SyntaxPolarity,
    /// Stall copy for the root wait pin. `None` means the label is off.
    phase: Option<String>,
}

#[derive(Debug)]
struct OpenTally {
    rebuilt: Vec<&'static str>,
    cached: Vec<&'static str>,
}

impl Default for PaintReplica {
    fn default() -> Self {
        Self::new()
    }
}

impl PaintReplica {
    pub fn new() -> Self {
        Self {
            arena: Arena::default(),
            clock: 1,
            root: None,
            epoch: None,
            seq: 0,
            open_tally: None,
            polarity: SyntaxPolarity::Dark,
            phase: None,
        }
    }

    pub fn epoch(&self) -> Option<&str> {
        self.epoch.as_deref()
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn root(&self) -> Option<NodeRef> {
        let index = self.root?;
        self.arena.node_ref(index)
    }

    pub fn child(&self, node: NodeRef, index: usize) -> Option<NodeRef> {
        let data = self.arena.get(node)?;
        let child = *data.children.get(index)?;
        self.arena.node_ref(child)
    }

    pub fn child_count(&self, node: NodeRef) -> Option<usize> {
        Some(self.arena.get(node)?.children.len())
    }

    /// Paint discriminant (`speech`, `thinking`, `turn`, …).
    pub fn kind(&self, node: NodeRef) -> Option<&'static str> {
        Some(self.arena.get(node)?.widget.kind().as_str())
    }

    /// `text` on speech, thinking, recall, and compact. `None` on any other kind.
    pub fn text(&self, node: NodeRef) -> Option<&str> {
        self.arena.get(node)?.widget.text()
    }

    /// Speech body expansions. Other kinds stay at 0 until a speech rebuild.
    pub fn expands(&self, node: NodeRef) -> Option<u32> {
        Some(self.arena.get(node)?.expands)
    }

    /// Parse `bytes` once and apply. Returns the root after a successful apply.
    pub fn apply(&mut self, bytes: &[u8]) -> Result<NodeRef, PaintError> {
        let value = parse_json(bytes)?;
        let message = decode_message(value)?;
        match message {
            Down::Init { epoch, snapshot } => self.remount(epoch, snapshot),
            Down::Patch {
                epoch,
                seq,
                patches,
            } => self.patch(epoch, seq, patches),
        }
    }

    pub fn note_replica(&mut self, note: ReplicaNote) {
        match note {
            ReplicaNote::Init => self.open_tally = None,
            ReplicaNote::Patch => {
                if self.open_tally.is_none() {
                    self.open_tally = Some(OpenTally {
                        rebuilt: Vec::new(),
                        cached: Vec::new(),
                    });
                }
            }
        }
    }

    /// Take the armed tally. `None` when nothing is armed.
    pub fn take_patch_tally(&mut self) -> Option<PatchTally> {
        if self.open_tally.is_some() {
            if let Some(root) = self.root {
                if let Some(composer) = self.child_kind(root, Kind::Composer) {
                    self.record_tally_node(composer, false);
                }
                self.record_tally_node(root, true);
            }
        }
        let raw = self.open_tally.take()?;
        let rebuilt = unique(&raw.rebuilt);
        let cached = unique(&raw.cached)
            .into_iter()
            .filter(|kind| !rebuilt.contains(kind))
            .collect();
        Some(PatchTally { rebuilt, cached })
    }

    fn record_tally_node(&mut self, id: u32, skip_chrome: bool) {
        let Ok((kind, dirty, children)) = self.arena.data_mut(id).map(|node| {
            let k = node.widget.kind();
            let d = node.dirty;
            if d && k == Kind::Speech {
                node.expands = node.expands.saturating_add(1);
            }
            node.dirty = false;
            (k, d, node.children.clone())
        }) else {
            return;
        };
        if let Some(tally) = &mut self.open_tally {
            if dirty {
                tally.rebuilt.push(kind.as_str());
            } else {
                tally.cached.push(kind.as_str());
            }
        }
        for child in children {
            if skip_chrome
                && self
                    .arena
                    .kind_of(child)
                    .is_ok_and(is_root_chrome)
            {
                continue;
            }
            self.record_tally_node(child, false);
        }
    }

    /// Marks every speech, work cell, and composer dirty, and their ancestors.
    /// Thinking does not read polarity. Does not load a grammar.
    pub fn set_syntax_polarity(&mut self, polarity: SyntaxPolarity) {
        syntax::set_polarity(match polarity {
            SyntaxPolarity::Dark => Polarity::Dark,
            SyntaxPolarity::Light => Polarity::Light,
        });
        if self.polarity == polarity {
            return;
        }
        self.polarity = polarity;
        self.taint_syntax_readers();
    }

    /// Stall sentence for the root wait pin. Empty clears it.
    /// Returns whether the sentence changed.
    pub fn set_phase(&mut self, text: &str) -> bool {
        if self.phase.as_deref() == Some(text) || (text.is_empty() && self.phase.is_none()) {
            return false;
        }
        self.phase = if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        };
        true
    }

    /// Drop retained speech, work, and composer layouts after the highlighter warms.
    pub fn note_syntax_warm(&mut self) {
        self.taint_syntax_readers();
    }

    fn taint_user_speeches(&mut self) {
        let Some(root) = self.root else {
            return;
        };
        let mut stack = vec![root];
        let mut hit = Vec::new();
        while let Some(id) = stack.pop() {
            let Ok(node) = self.arena.data(id) else {
                continue;
            };
            let user = node
                .widget
                .speech()
                .is_some_and(|speech| speech.voice == "user");
            let children = node.children.clone();
            if user {
                hit.push(id);
            }
            stack.extend(children);
        }
        for id in hit {
            self.taint_chain(id);
        }
    }

    fn taint_syntax_readers(&mut self) {
        let Some(root) = self.root else {
            return;
        };
        let mut stack = vec![root];
        let mut hit = Vec::new();
        while let Some(id) = stack.pop() {
            let Ok(node) = self.arena.data(id) else {
                continue;
            };
            let kind = node.widget.kind();
            let children = node.children.clone();
            if matches!(
                kind,
                Kind::Speech
                    | Kind::Tool
                    | Kind::Scheme
                    | Kind::Loop
                    | Kind::Ask
                    | Kind::Wait
                    | Kind::Composer
            ) {
                hit.push(id);
            }
            stack.extend(children);
        }
        for id in hit {
            self.taint_chain(id);
        }
    }

    fn remount(&mut self, epoch: String, snapshot: Json) -> Result<NodeRef, PaintError> {
        let mut arena = Arena::default();
        let root = arena.ingest(&mut self.clock, snapshot, None, false)?;
        let node_ref = arena.node_ref(root).ok_or_else(|| fail("missing root"))?;
        if arena.kind_of(root)? != Kind::Root {
            return Err(fail("paint root kind"));
        }
        self.arena = arena;
        self.root = Some(root);
        self.epoch = Some(epoch);
        self.seq = 0;
        self.open_tally = None;
        Ok(node_ref)
    }

    fn patch(
        &mut self,
        epoch: String,
        seq: u64,
        patches: Vec<Patch>,
    ) -> Result<NodeRef, PaintError> {
        let Some(root) = self.root else {
            return Err(PaintError::PatchBeforeInit);
        };
        let Some(have) = self.epoch.clone() else {
            return Err(PaintError::PatchBeforeInit);
        };
        if epoch != have {
            return Err(PaintError::EpochMismatch {
                expected: have,
                got: epoch,
            });
        }
        let expected = self.seq.saturating_add(1);
        if seq != expected {
            return Err(PaintError::SeqGap { expected, got: seq });
        }
        for patch in patches {
            self.apply_patch(root, patch)?;
        }
        self.seq = seq;
        self.arena
            .node_ref(root)
            .ok_or_else(|| fail("missing root"))
    }

    fn apply_patch(&mut self, root: u32, patch: Patch) -> Result<(), PaintError> {
        if patch.steps.is_empty() {
            return Err(fail("empty path"));
        }
        self.apply_at(root, &patch.steps, patch.action)
    }

    fn apply_at(&mut self, id: u32, steps: &[String], action: Action) -> Result<(), PaintError> {
        let Some((key, rest)) = steps.split_first() else {
            return Err(fail("empty path"));
        };
        if key == "children" {
            return self.apply_children(id, rest, action);
        }
        self.apply_field(id, key, rest, action)
    }

    fn apply_children(
        &mut self,
        parent: u32,
        steps: &[String],
        action: Action,
    ) -> Result<(), PaintError> {
        if steps.is_empty() {
            return match action {
                Action::Replace(Json::Array(items)) => self.replace_children(parent, items),
                _ => Err(fail("children path")),
            };
        }
        let Some((key, rest)) = steps.split_first() else {
            return Err(fail("children path"));
        };
        let len = self.arena.data(parent)?.children.len();
        let index = pointer_index(key, len, &action)?;
        if rest.is_empty() {
            return match action {
                Action::Add(value) => self.insert_child(parent, index, value),
                Action::Replace(value) => self.replace_child(parent, index, value),
                Action::Remove => self.remove_child(parent, index),
                Action::Splice { .. } => Err(fail("splice on child")),
            };
        }
        if index >= len {
            return Err(fail("child index"));
        }
        let child = self.arena.data(parent)?.children[index];
        self.apply_at(child, rest, action)
    }

    fn replace_children(&mut self, parent: u32, items: Vec<Json>) -> Result<(), PaintError> {
        let mut new_ids = Vec::with_capacity(items.len());
        for item in items {
            match self.ingest_node(item, Some(parent)) {
                Ok(id) => new_ids.push(id),
                Err(err) => {
                    for id in new_ids {
                        self.arena.free_tree(id);
                    }
                    return Err(err);
                }
            }
        }
        let old = std::mem::replace(&mut self.arena.data_mut(parent)?.children, new_ids);
        for id in old {
            self.arena.free_tree(id);
        }
        self.taint_chain(parent);
        Ok(())
    }

    fn insert_child(&mut self, parent: u32, index: usize, value: Json) -> Result<(), PaintError> {
        let len = self.arena.data(parent)?.children.len();
        if index > len {
            return Err(fail("child index"));
        }
        let child = self.ingest_node(value, Some(parent))?;
        self.arena.data_mut(parent)?.children.insert(index, child);
        self.taint_chain(parent);
        Ok(())
    }

    fn replace_child(&mut self, parent: u32, index: usize, value: Json) -> Result<(), PaintError> {
        let len = self.arena.data(parent)?.children.len();
        if index >= len {
            return Err(fail("child index"));
        }
        let child = self.ingest_node(value, Some(parent))?;
        let old = self.arena.data_mut(parent)?.children[index];
        self.arena.data_mut(parent)?.children[index] = child;
        self.arena.free_tree(old);
        self.taint_chain(parent);
        Ok(())
    }

    fn remove_child(&mut self, parent: u32, index: usize) -> Result<(), PaintError> {
        let len = self.arena.data(parent)?.children.len();
        if index >= len {
            return Err(fail("child index"));
        }
        let old = self.arena.data_mut(parent)?.children.remove(index);
        self.arena.free_tree(old);
        self.taint_chain(parent);
        Ok(())
    }

    fn apply_field(
        &mut self,
        id: u32,
        key: &str,
        rest: &[String],
        action: Action,
    ) -> Result<(), PaintError> {
        if key == "kind" && rest.is_empty() {
            if let Action::Replace(value) | Action::Add(value) = &action {
                let name = match value {
                    Json::String(name) => name.clone(),
                    _ => return Err(fail("paint kind")),
                };
                let node = self.arena.data_mut(id)?;
                node.widget
                    .rekind(&mut node.tail, &name)
                    .map_err(|name| fail(format!("unknown paint kind {name}")))?;
                return self.taint_after_field(id, key);
            }
        }
        let known = self.arena.data(id)?.widget.is_known(key);
        if known && !rest.is_empty() {
            return Err(fail("path"));
        }
        if known {
            match action {
                Action::Splice {
                    from,
                    delete,
                    insert,
                } => {
                    let node = self.arena.data_mut(id)?;
                    match node.widget.field_mut(key) {
                        FieldMut::Str(text) => splice_string(text, from, delete, &insert),
                        FieldMut::Tail => return Err(fail("splice target is not a string")),
                        FieldMut::Bool(_, _) | FieldMut::Num(_) => {
                            return Err(fail("splice target is not a string"));
                        }
                    }
                }
                Action::Replace(value) | Action::Add(value) => {
                    assign_widget(&mut self.arena.data_mut(id)?.widget, key, Some(value))?;
                }
                Action::Remove => {
                    assign_widget(&mut self.arena.data_mut(id)?.widget, key, None)?;
                }
            }
        } else {
            let node = self.arena.data_mut(id)?;
            edit_tail(&mut node.tail, key, rest, action)?;
        }
        self.taint_after_field(id, key)
    }

    fn taint_after_field(&mut self, id: u32, key: &str) -> Result<(), PaintError> {
        let kind = self.arena.kind_of(id)?;
        let parent = self.arena.data(id)?.parent;
        self.taint_chain(id);
        if kind == Kind::Completion {
            let children = self.arena.child_ids(id);
            for child in children {
                let child_kind = self.arena.kind_of(child)?;
                if child_kind == Kind::Speech || child_kind == Kind::Thinking {
                    self.taint_chain(child);
                }
            }
        }
        if kind == Kind::Speech && key == "atMs" {
            if let Some(parent) = parent {
                let children = self.arena.child_ids(parent);
                for child in children {
                    if self.arena.kind_of(child)? == Kind::Failure {
                        self.taint_chain(child);
                    }
                }
            }
        }
        if kind == Kind::Rewind && key == "atTip" {
            self.taint_user_speeches();
        }
        Ok(())
    }

    /// Dirty this node and ancestors. Does not walk siblings or children.
    fn taint_chain(&mut self, mut index: u32) {
        loop {
            let (kind, parent) = {
                let Ok(node) = self.arena.data_mut(index) else {
                    return;
                };
                node.dirty = true;
                (node.widget.kind(), node.parent)
            };
            match parent {
                Some(next) => {
                    if is_root_chrome(kind) && self.arena.kind_of(next) == Ok(Kind::Root) {
                        return;
                    }
                    index = next;
                }
                None => return,
            }
        }
    }

    /// History navigation is open. `atTip` false is that state. No rewind widget is the live tape.
    fn browsing(&self) -> bool {
        let Some(root) = self.root else {
            return false;
        };
        let Some(id) = self.child_kind(root, Kind::Rewind) else {
            return false;
        };
        match self.arena.data(id) {
            Ok(node) => !node.widget.at_tip().unwrap_or(true),
            Err(_) => false,
        }
    }

    /// No turn, no ask, no wait. The screen centers a title instead of a blank tape.
    fn fresh_home(&self, root: u32) -> bool {
        if self.child_kind(root, Kind::Ask).is_some() || self.child_kind(root, Kind::Wait).is_some()
        {
            return false;
        }
        let Some(stack) = self.child_kind(root, Kind::Stack) else {
            return false;
        };
        self.arena.child_ids(stack).is_empty()
    }

    /// Composer rim. Off-tip hides it unless ask, overlay, or auth stole the seat.
    pub fn seat_rim(&self) -> bool {
        let Some(root) = self.root else {
            return true;
        };
        let Some(id) = self.child_kind(root, Kind::Rewind) else {
            return true;
        };
        self.tail_bool(id, "seatRim", true)
    }

    /// Sneak-peek is open. The drawer may stay closed.
    pub fn agents_preview_open(&self) -> bool {
        let Some(root) = self.root else {
            return false;
        };
        let Some(id) = self.child_kind(root, Kind::Agents) else {
            return false;
        };
        !self.tail_str(id, "previewKey").is_empty()
    }

    fn tail_json(&self, id: u32, key: &str) -> Option<Json> {
        self.arena.data(id).ok()?.tail.get(key).cloned()
    }

    fn tail_str(&self, id: u32, key: &str) -> String {
        match self.tail_json(id, key) {
            Some(Json::String(text)) => text,
            _ => String::new(),
        }
    }

    fn tail_bool(&self, id: u32, key: &str, default: bool) -> bool {
        match self.tail_json(id, key) {
            Some(Json::Bool(value)) => value,
            _ => default,
        }
    }

    fn tail_f64(&self, id: u32, key: &str) -> Option<f64> {
        match self.tail_json(id, key) {
            Some(Json::Number(number)) if number.is_finite() => Some(number),
            _ => None,
        }
    }

    fn tail_i64(&self, id: u32, key: &str, default: i64) -> i64 {
        match self.tail_json(id, key) {
            Some(Json::Number(number)) if number.is_finite() => {
                let value = number.floor();
                if value >= i64::MAX as f64 {
                    i64::MAX
                } else if value <= i64::MIN as f64 {
                    i64::MIN
                } else {
                    value as i64
                }
            }
            _ => default,
        }
    }

    fn ingest_node(&mut self, value: Json, parent: Option<u32>) -> Result<u32, PaintError> {
        self.arena.ingest(&mut self.clock, value, parent, true)
    }

    fn child_kind(&self, parent: u32, kind: Kind) -> Option<u32> {
        self.arena
            .child_ids(parent)
            .into_iter()
            .find(|&id| self.arena.kind_of(id).ok() == Some(kind))
    }

    /// Render the replicated paint tree into a Ratatui [`ratatui::buffer::Buffer`]
    /// using the native Ratatui custom widgets in [`crate::widgets`].
    pub fn render_ratatui(
        &self,
        area: ratatui::layout::Rect,
        buf: &mut ratatui::buffer::Buffer,
        now_ms: f64,
    ) {
        use ratatui::layout::Rect as RRect;
        use ratatui::style::{Color, Modifier, Style as RStyle};
        use ratatui::text::{Line, Span};
        use ratatui::widgets::{Block, BorderType, Borders, Clear, Widget as RWidget};

        use crate::widgets::{
            AgentsMeterReplicaWidget, AgentsPeekWidget, AgentsReplicaDrawerWidget,
            ComposerReplicaWidget, ReplicaWorkCellWidget, RewindPinsWidget,
            StatuslineReplicaWidget, WaitPinWidget,
        };

        if area.is_empty() {
            return;
        }
        let Some(root) = self.root else {
            return;
        };

        let mut top_y = area.top();
        let mut bot_y = area.bottom();

        // 1. Statusline at top
        if let Some(st_id) = self.child_kind(root, Kind::Statusline) {
            if top_y < bot_y {
                let (left, cwd) = self
                    .arena
                    .data(st_id)
                    .ok()
                    .and_then(|d| d.widget.statusline())
                    .map(|(l, c)| (l.to_string(), c.to_string()))
                    .unwrap_or_default();
                let cwd_root = self.tail_str(st_id, "cwdRoot");
                let note = self.tail_str(st_id, "note");
                let st_rect = RRect::new(area.left(), top_y, area.width, 1);
                StatuslineReplicaWidget::new(&left, &note, &cwd, &cwd_root).render(st_rect, buf);
                top_y = top_y.saturating_add(1);
            }
        }

        // 2. Composer at bottom (when seat_rim is true)
        if self.seat_rim() {
            if let Some(comp_id) = self.child_kind(root, Kind::Composer) {
                let face = self.extract_composer_replica_face(comp_id);
                let comp_widget = ComposerReplicaWidget::new(&face);
                let comp_h = comp_widget.height().min(bot_y.saturating_sub(top_y));
                if comp_h >= 2 {
                    bot_y = bot_y.saturating_sub(comp_h);
                    let comp_rect = RRect::new(area.left(), bot_y, area.width, comp_h);
                    comp_widget.render(comp_rect, buf);
                }
            }
        }

        // 3. Closed agents meter above composer
        if let Some(ag_id) = self.child_kind(root, Kind::Agents) {
            if !self.tail_bool(ag_id, "open", false) && top_y < bot_y {
                if let Some((left, right)) = self
                    .arena
                    .data(ag_id)
                    .ok()
                    .and_then(|d| d.widget.agents())
                    .map(|(l, r)| (l.to_string(), r.to_string()))
                {
                    if !left.is_empty() || !right.is_empty() {
                        bot_y = bot_y.saturating_sub(1);
                        let meter_rect = RRect::new(area.left(), bot_y, area.width, 1);
                        AgentsMeterReplicaWidget::new(&left, &right).render(meter_rect, buf);
                    }
                }
            }
        }

        // 4. Ask pin or Wait pin above agents meter / composer
        let has_ask = self.child_kind(root, Kind::Ask).is_some();
        if let Some(ask_id) = self.child_kind(root, Kind::Ask) {
            if let Some(cell) = self.extract_work_cell_item(ask_id, false) {
                if cell.receipt_kind != "none" && top_y < bot_y {
                    let w = ReplicaWorkCellWidget::new(&cell);
                    let h = w.height().min(bot_y.saturating_sub(top_y));
                    if h > 0 {
                        bot_y = bot_y.saturating_sub(h);
                        let ask_rect = RRect::new(area.left(), bot_y, area.width, h);
                        w.render(ask_rect, buf);
                    }
                }
            }
        } else if let Some(wait_id) = self.child_kind(root, Kind::Wait) {
            if !has_ask && top_y < bot_y {
                let (status, error) = self
                    .arena
                    .data(wait_id)
                    .ok()
                    .and_then(|d| d.widget.work())
                    .map(|w| (w.status.clone(), w.object.clone()))
                    .unwrap_or_default();
                let effective_status = self.phase.as_deref().unwrap_or(status.as_str());
                let started_at = self.tail_f64(wait_id, "startedAt");
                let retry_until_ms = self.tail_f64(wait_id, "retryUntilMs");
                bot_y = bot_y.saturating_sub(1);
                let wait_rect = RRect::new(area.left(), bot_y, area.width, 1);
                WaitPinWidget::new(
                    effective_status,
                    &error,
                    started_at,
                    retry_until_ms,
                    now_ms,
                )
                .render(wait_rect, buf);
            }
        }

        // 5. Rewind past & future pins
        if let Some(rw_id) = self.child_kind(root, Kind::Rewind) {
            let past = parse_rewind_pins(self.tail_json(rw_id, "past").as_ref());
            if !past.is_empty() && top_y < bot_y {
                let pw = RewindPinsWidget::new(&past);
                let ph = pw.height().min(bot_y.saturating_sub(top_y));
                if ph > 0 {
                    let prect = RRect::new(area.left(), top_y, area.width, ph);
                    pw.render(prect, buf);
                    top_y = top_y.saturating_add(ph);
                }
            }
            let at_tip = self
                .arena
                .data(rw_id)
                .ok()
                .and_then(|d| d.widget.at_tip())
                .unwrap_or(true);
            if !at_tip {
                let future = parse_rewind_pins(self.tail_json(rw_id, "future").as_ref());
                if !future.is_empty() && top_y < bot_y {
                    let fw = RewindPinsWidget::new(&future);
                    let fh = fw.height().min(bot_y.saturating_sub(top_y));
                    if fh > 0 {
                        bot_y = bot_y.saturating_sub(fh);
                        let frect = RRect::new(area.left(), bot_y, area.width, fh);
                        fw.render(frect, buf);
                    }
                }
            }
        }

        // 6. Main tape stack
        if top_y < bot_y {
            let tape_rect = RRect::new(area.left(), top_y, area.width, bot_y - top_y);
            if self.fresh_home(root) {
                let mid_y = tape_rect.top() + tape_rect.height / 2;
                let banner = Line::from(vec![
                    Span::styled(
                        " ◈ Harness ",
                        RStyle::default()
                            .fg(Color::Rgb(120, 190, 255))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        "— ready for your prompt",
                        RStyle::default()
                            .fg(Color::Rgb(140, 148, 168))
                            .add_modifier(Modifier::DIM),
                    ),
                ]);
                buf.set_line(
                    tape_rect.left().saturating_add(2),
                    mid_y,
                    &banner,
                    tape_rect.width.saturating_sub(2),
                );
            } else {
                let container = self.child_kind(root, Kind::Stack).unwrap_or(root);
                self.render_ratatui_nodes_in_area(container, tape_rect, buf, now_ms);
            }
        }

        // 7. Open Agents Drawer + Peek Plaque overlay
        if let Some(ag_id) = self.child_kind(root, Kind::Agents) {
            if self.tail_bool(ag_id, "open", false) {
                let (left, right) = self
                    .arena
                    .data(ag_id)
                    .ok()
                    .and_then(|d| d.widget.agents())
                    .map(|(l, r)| (l.to_string(), r.to_string()))
                    .unwrap_or_default();
                let focus_key = self.tail_str(ag_id, "focusKey");
                let scroll = self.tail_i64(ag_id, "scroll", 0).max(0) as usize;
                let rows = parse_agent_rows(self.tail_json(ag_id, "rows").as_ref());
                let panel_w = (area.width / 2).max(24).min(area.width);
                let panel_h = area.height.saturating_sub(2).max(4).min(area.height);
                let drawer_rect = RRect::new(area.left(), area.top() + 1, panel_w, panel_h);
                Clear.render(drawer_rect, buf);
                AgentsReplicaDrawerWidget::new(&left, &right, &rows, &focus_key, scroll)
                    .render(drawer_rect, buf);

                if !focus_key.is_empty() && drawer_rect.right() + 12 < area.right() {
                    if let Some(focused_row) = rows.iter().find(|r| r.key == focus_key) {
                        if !focused_row.ask_line.is_empty()
                            || !focused_row.unfinished.is_empty()
                            || !focused_row.result.is_empty()
                            || !focused_row.recap.is_empty()
                        {
                            let peek_w = area.right().saturating_sub(drawer_rect.right() + 2);
                            let peek_h = 9u16.min(panel_h);
                            let peek_rect = RRect::new(
                                drawer_rect.right() + 1,
                                drawer_rect.top(),
                                peek_w,
                                peek_h,
                            );
                            Clear.render(peek_rect, buf);
                            AgentsPeekWidget::new(focused_row).render(peek_rect, buf);
                        }
                    }
                }
            }
        }

        // 8. Agents Preview modal overlay
        if let Some(ag_id) = self.child_kind(root, Kind::Agents) {
            let preview_key = self.tail_str(ag_id, "previewKey");
            if !preview_key.is_empty() {
                if let Some(prev_id) = self.child_kind(root, Kind::Preview) {
                    let rows = parse_agent_rows(self.tail_json(ag_id, "rows").as_ref());
                    let title = rows
                        .into_iter()
                        .find(|r| r.key == preview_key)
                        .map(|r| r.name)
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| preview_key.clone());
                    let modal_w = area.width.saturating_sub(6).max(20).min(area.width);
                    let modal_h = area.height.saturating_sub(4).max(6).min(area.height);
                    let modal_x = area.left() + (area.width.saturating_sub(modal_w)) / 2;
                    let modal_y = area.top() + (area.height.saturating_sub(modal_h)) / 2;
                    let modal_rect = RRect::new(modal_x, modal_y, modal_w, modal_h);
                    Clear.render(modal_rect, buf);
                    let block = Block::default()
                        .title(Line::from(Span::styled(
                            format!(" {title} "),
                            RStyle::default()
                                .fg(Color::Rgb(130, 215, 200))
                                .add_modifier(Modifier::BOLD),
                        )))
                        .borders(Borders::ALL)
                        .border_type(BorderType::Rounded)
                        .border_style(RStyle::default().fg(Color::Rgb(95, 110, 140)))
                        .style(RStyle::default().bg(Color::Rgb(16, 18, 24)));
                    let inner = block.inner(modal_rect);
                    block.render(modal_rect, buf);
                    if !inner.is_empty() {
                        self.render_ratatui_nodes_in_area(prev_id, inner, buf, now_ms);
                    }
                }
            }
        }
    }

    /// Render the replicated paint tree through Ratatui custom widgets and convert
    /// the resulting grid into a [`crate::Buffer`].
    pub fn render_ratatui_to_qd(&self, cols: u16, rows: u16, now_ms: f64) -> crate::Buffer {
        let area = ratatui::layout::Rect::new(0, 0, cols, rows);
        let mut rbuf = ratatui::buffer::Buffer::empty(area);
        self.render_ratatui(area, &mut rbuf, now_ms);
        crate::bridge::ratatui_to_qd_buffer(&rbuf)
    }

    fn render_ratatui_nodes_in_area(
        &self,
        container_id: u32,
        area: ratatui::layout::Rect,
        buf: &mut ratatui::buffer::Buffer,
        now_ms: f64,
    ) {
        use ratatui::layout::Rect as RRect;
        use ratatui::widgets::Widget as RWidget;

        use crate::widgets::{
            CompactBlock, CompactWidget, FailureBlock, FailureWidget, ReplicaRecallWidget,
            ReplicaThinkingBlock, ReplicaThinkingWidget, ReplicaWorkCellWidget, SpeechWidget,
        };

        let mut y = area.top();
        let mut walk_ids = Vec::new();
        for child in self.arena.child_ids(container_id) {
            match self.arena.kind_of(child).ok() {
                Some(Kind::Turn | Kind::Stack) => {
                    walk_ids.extend(self.arena.child_ids(child));
                }
                Some(k) if !is_root_chrome(k) => {
                    walk_ids.push(child);
                }
                _ => {}
            }
        }

        for id in walk_ids {
            if y >= area.bottom() {
                break;
            }
            let Some(kind) = self.arena.kind_of(id).ok() else {
                continue;
            };
            match kind {
                Kind::Speech => {
                    if let Some(sp) = self.arena.data(id).ok().and_then(|d| d.widget.speech()) {
                        let hotkeys = self
                            .arena
                            .data(id)
                            .ok()
                            .and_then(|d| d.tail.get("recapHotkeys"))
                            .map(|j| chrome_hotkeys_of(Some(j)))
                            .unwrap_or_default();
                        let w = if sp.voice == "user" {
                            SpeechWidget::user(&sp.text)
                                .with_at_ms(sp.at_ms)
                                .with_recap(sp.recap || self.browsing(), &sp.annotation, hotkeys)
                        } else {
                            SpeechWidget::assistant(&sp.text).with_at_ms(sp.at_ms)
                        };
                        let h = w.height().min(area.bottom().saturating_sub(y));
                        if h > 0 {
                            w.render(RRect::new(area.left(), y, area.width, h), buf);
                            y = y.saturating_add(h);
                        }
                    }
                }
                Kind::Thinking => {
                    let text = self.arena.widget_text(id).unwrap_or_default();
                    if !text.trim().is_empty() {
                        let block = ReplicaThinkingBlock::new(text)
                            .collapsed(true)
                            .sealed(true)
                            .with_timing(None, None, None, Some(now_ms));
                        let w = ReplicaThinkingWidget::new(&block);
                        let h = w.height().min(area.bottom().saturating_sub(y));
                        if h > 0 {
                            w.render(RRect::new(area.left(), y, area.width, h), buf);
                            y = y.saturating_add(h);
                        }
                    }
                }
                Kind::Recall => {
                    let text = self.arena.widget_text(id).unwrap_or_default();
                    ReplicaRecallWidget::new(&text)
                        .render(RRect::new(area.left(), y, area.width, 1), buf);
                    y = y.saturating_add(1);
                }
                Kind::Compact => {
                    let text = self.arena.widget_text(id).unwrap_or_default();
                    let block = CompactBlock { summary: text };
                    CompactWidget::new(&block)
                        .render(RRect::new(area.left(), y, area.width, 1), buf);
                    y = y.saturating_add(1);
                }
                Kind::Failure => {
                    if let Some((detail, reason)) =
                        self.arena.data(id).ok().and_then(|d| d.widget.failure())
                    {
                        let block = FailureBlock::new(detail, reason);
                        FailureWidget::new(&block)
                            .render(RRect::new(area.left(), y, area.width, 1), buf);
                        y = y.saturating_add(1);
                    }
                }
                Kind::Completion => {
                    let comp_data = self
                        .arena
                        .data(id)
                        .ok()
                        .and_then(|d| d.widget.completion())
                        .cloned();
                    let started_at = self.tail_f64(id, "startedAt");
                    let duration_ms = self.tail_f64(id, "durationMs");
                    let model = self.tail_str(id, "model");
                    let thought_kind = self.tail_str(id, "thoughtKind");
                    let live = comp_data.as_ref().is_some_and(|c| c.state == "live");
                    let failed = comp_data.as_ref().is_some_and(|c| c.state == "failed");
                    let thought_live = comp_data.as_ref().is_some_and(|c| c.thought_live);

                    if let Some(th_id) = self.child_kind(id, Kind::Thinking) {
                        let t_text = self.arena.widget_text(th_id).unwrap_or_default();
                        if !t_text.trim().is_empty() || thought_live {
                            let t_block = ReplicaThinkingBlock::new(t_text)
                                .collapsed(true)
                                .sealed(!thought_live)
                                .with_timing(started_at, None, duration_ms, Some(now_ms))
                                .with_model(model)
                                .with_thought_kind(thought_kind);
                            let tw = ReplicaThinkingWidget::new(&t_block);
                            let th = tw.height().min(area.bottom().saturating_sub(y));
                            if th > 0 {
                                tw.render(RRect::new(area.left(), y, area.width, th), buf);
                                y = y.saturating_add(th);
                            }
                        }
                    }

                    if y >= area.bottom() {
                        break;
                    }

                    if let Some(sp_id) = self.child_kind(id, Kind::Speech) {
                        if let Some(sp) =
                            self.arena.data(sp_id).ok().and_then(|d| d.widget.speech())
                        {
                            if !sp.text.is_empty() {
                                let sw = SpeechWidget::assistant(&sp.text)
                                    .live(live)
                                    .failed(failed)
                                    .with_at_ms(sp.at_ms);
                                let sh = sw.height().min(area.bottom().saturating_sub(y));
                                if sh > 0 {
                                    sw.render(RRect::new(area.left(), y, area.width, sh), buf);
                                    y = y.saturating_add(sh);
                                }
                            } else if failed {
                                if let Some(f_id) = self.child_kind(id, Kind::Failure) {
                                    if let Some((detail, reason)) =
                                        self.arena.data(f_id).ok().and_then(|d| d.widget.failure())
                                    {
                                        let f_block =
                                            FailureBlock::new(detail, reason).with_at_ms(sp.at_ms);
                                        FailureWidget::new(&f_block).render(
                                            RRect::new(area.left(), y, area.width, 1),
                                            buf,
                                        );
                                        y = y.saturating_add(1);
                                    }
                                }
                            }
                        }
                    }
                }
                Kind::Tool | Kind::Scheme | Kind::Loop => {
                    let fused = self
                        .arena
                        .data(id)
                        .ok()
                        .and_then(|d| d.widget.work())
                        .is_some_and(|w| w.fuse);
                    if !fused {
                        if let Some(cell) = self.extract_work_cell_item(id, false) {
                            let w = ReplicaWorkCellWidget::new(&cell);
                            let h = w.height().min(area.bottom().saturating_sub(y));
                            if h > 0 {
                                w.render(RRect::new(area.left(), y, area.width, h), buf);
                                y = y.saturating_add(h);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn extract_work_cell_item(
        &self,
        id: u32,
        collapsed: bool,
    ) -> Option<crate::widgets::ReplicaWorkCellItem> {
        let data = self.arena.data(id).ok()?;
        let work = data.widget.work()?;
        let kind_str = data.widget.kind().as_str();
        let caption = self.tail_str(id, "caption");
        let indent = usize::from(self.tail_bool(id, "indent", false));
        let agent = self.tail_bool(id, "agent", false);
        let pretty_block = self.tail_str(id, "prettyBlock");
        let line_start = self.tail_i64(id, "diffLineStart", 1).max(1) as usize;

        Some(crate::widgets::ReplicaWorkCellItem::from_replica_fields(
            id,
            kind_str,
            &work.name,
            &work.object,
            &work.status,
            &caption,
            &work.state,
            indent,
            agent,
            &pretty_block,
            &work.receipt_kind,
            &work.receipt_text,
            &work.diff_old,
            &work.diff_new,
            &work.diff_path,
            line_start,
            collapsed,
        ))
    }

    fn extract_composer_replica_face(&self, id: u32) -> crate::widgets::ComposerReplicaFace {
        use crate::widgets::{ComposerReplicaChoice, ComposerReplicaFace};

        let Some(data) = self.arena.data(id).ok() else {
            return ComposerReplicaFace::default();
        };
        let Some(comp) = data.widget.composer() else {
            return ComposerReplicaFace::default();
        };

        let hotkeys = chrome_hotkeys_of(data.tail.get("hotkeys"));
        let stacked_hotkeys = chrome_hotkeys_of(data.tail.get("stackedHotkeys"));

        let stacked_glyphs: Vec<String> = match data.tail.get("stackedGlyphs") {
            Some(Json::Array(items)) => items
                .iter()
                .map(|v| match v {
                    Json::String(s) => s.clone(),
                    _ => String::new(),
                })
                .collect(),
            _ => Vec::new(),
        };
        let mut stacked_rows = Vec::new();
        if let Some(Json::Array(rows)) = data.tail.get("stackedBodyRows") {
            for (idx, row) in rows.iter().enumerate() {
                let text = match row {
                    Json::String(s) => s.clone(),
                    Json::Array(segs) => segs
                        .iter()
                        .filter_map(|seg| match seg {
                            Json::String(s) => Some(s.as_str()),
                            Json::Object(map) => match map.get("text") {
                                Some(Json::String(s)) => Some(s.as_str()),
                                _ => None,
                            },
                            _ => None,
                        })
                        .collect::<String>(),
                    _ => String::new(),
                };
                let glyph = stacked_glyphs.get(idx).cloned().unwrap_or_default();
                stacked_rows.push((glyph, text));
            }
        }

        let mut choices = Vec::new();
        if let Some(Json::Array(items)) = data.tail.get("commandChoices") {
            for item in items {
                if let Json::Object(map) = item {
                    let get_s = |k: &str| match map.get(k) {
                        Some(Json::String(s)) => s.clone(),
                        _ => String::new(),
                    };
                    choices.push(ComposerReplicaChoice {
                        key: get_s("key"),
                        name: get_s("name"),
                        annotation: get_s("annotation"),
                        description: get_s("description"),
                    });
                }
            }
        }

        let mut status_items = Vec::new();
        if let Some(Json::Array(items)) = data.tail.get("statusItems") {
            for item in items {
                match item {
                    Json::String(s) if !s.trim().is_empty() => status_items.push(s.clone()),
                    Json::Object(map) => {
                        if let Some(Json::String(s)) = map.get("text") {
                            if !s.trim().is_empty() {
                                status_items.push(s.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        ComposerReplicaFace {
            draft: comp.draft.clone(),
            placeholder: comp.placeholder.clone(),
            annotation: comp.annotation.clone(),
            join_annotation: self.tail_str(id, "joinAnnotation"),
            error_message: self.tail_str(id, "errorMessage"),
            completion: self.tail_str(id, "completion"),
            interactive: comp.interactive,
            read_only: comp.read_only,
            hotkeys,
            stacked_rows,
            stacked_hotkeys,
            choices,
            selected_command_key: self.tail_str(id, "selectedCommandKey"),
            status_items,
            context_used: self.tail_f64(id, "contextUsed").unwrap_or(0.0),
            context_limit: self.tail_f64(id, "contextLimit").unwrap_or(0.0),
        }
    }
}

pub fn parse_agent_rows(value: Option<&Json>) -> Vec<AgentRow> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for item in items {
        let Json::Object(map) = item else {
            continue;
        };
        rows.push(AgentRow {
            key: json_string(map, "key"),
            kind: json_string(map, "kind"),
            name: json_string(map, "name"),
            recap: json_string(map, "recap"),
            indent: json_i64(map, "indent"),
            mark: json_string(map, "mark"),
            model: json_string(map, "model"),
            ask_line: json_string(map, "askLine"),
            unfinished: json_string(map, "unfinished"),
            notifies: json_strings(map, "notifies"),
            result: json_string(map, "result"),
            current: json_bool(map, "current"),
        });
    }
    rows
}

pub fn parse_rewind_pins(value: Option<&Json>) -> Vec<RewindPin> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut pins = Vec::new();
    for item in items {
        let Json::Object(map) = item else {
            continue;
        };
        pins.push(RewindPin {
            key: json_string(map, "key"),
            text: json_string(map, "text"),
        });
    }
    pins
}

fn json_bool(map: &BTreeMap<String, Json>, key: &str) -> bool {
    matches!(map.get(key), Some(Json::Bool(true)))
}

fn json_strings(map: &BTreeMap<String, Json>, key: &str) -> Vec<String> {
    let Some(Json::Array(items)) = map.get(key) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            Json::String(text) => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn json_string(map: &BTreeMap<String, Json>, key: &str) -> String {
    match map.get(key) {
        Some(Json::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn json_i64(map: &BTreeMap<String, Json>, key: &str) -> i64 {
    match map.get(key) {
        Some(Json::Number(number)) if number.is_finite() => {
            let value = number.floor();
            if value >= i64::MAX as f64 {
                i64::MAX
            } else if value <= i64::MIN as f64 {
                i64::MIN
            } else {
                value as i64
            }
        }
        _ => 0,
    }
}

fn is_root_chrome(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::Composer
            | Kind::Ask
            | Kind::Wait
            | Kind::Statusline
            | Kind::Agents
            | Kind::Preview
            | Kind::Rewind
    )
}

struct NodeData {
    /// Keys layout reads. `tail` is every other snapshot key, including `kind`.
    widget: Widget,
    tail: BTreeMap<String, Json>,
    parent: Option<u32>,
    children: Vec<u32>,
    dirty: bool,
    expands: u32,
}

struct Slot {
    generation: u32,
    data: Option<NodeData>,
}

#[derive(Default)]
struct Arena {
    slots: Vec<Slot>,
    free: Vec<u32>,
}

impl std::fmt::Debug for Arena {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Arena")
            .field("slots", &self.slots.len())
            .field("free", &self.free.len())
            .finish()
    }
}

impl Arena {
    fn ingest(
        &mut self,
        clock: &mut u32,
        value: Json,
        parent: Option<u32>,
        dirty: bool,
    ) -> Result<u32, PaintError> {
        let Json::Object(mut fields) = value else {
            return Err(fail("paint node"));
        };
        let kind_name = match fields.get("kind") {
            Some(Json::String(kind)) => kind.clone(),
            _ => return Err(fail("unknown paint kind <missing>")),
        };
        let children_json = match fields.remove("children") {
            Some(Json::Array(items)) => items,
            Some(_) => return Err(fail("children")),
            None => Vec::new(),
        };
        let mut parsed = parse_widget(&kind_name, fields)
            .map_err(|name| fail(format!("unknown paint kind {name}")))?;
        let is_speech = parsed.widget.kind() == Kind::Speech;
        parsed
            .tail
            .insert("kind".to_string(), Json::String(kind_name));
        let index = self.alloc(
            clock,
            NodeData {
                widget: parsed.widget,
                tail: parsed.tail,
                parent,
                children: Vec::new(),
                dirty,
                expands: u32::from(is_speech && !dirty),
            },
        );
        let mut children = Vec::with_capacity(children_json.len());
        for child in children_json {
            match self.ingest(clock, child, Some(index), dirty) {
                Ok(id) => children.push(id),
                Err(err) => {
                    self.free_tree(index);
                    return Err(err);
                }
            }
        }
        self.data_mut(index)?.children = children;
        Ok(index)
    }

    fn alloc(&mut self, clock: &mut u32, data: NodeData) -> u32 {
        let generation = *clock;
        *clock = clock.wrapping_add(1);
        if *clock == 0 {
            *clock = 1;
        }
        if let Some(index) = self.free.pop() {
            let slot = &mut self.slots[index as usize];
            slot.generation = generation;
            slot.data = Some(data);
            index
        } else {
            let index = self.slots.len() as u32;
            self.slots.push(Slot {
                generation,
                data: Some(data),
            });
            index
        }
    }

    fn free_tree(&mut self, index: u32) {
        let children = match self
            .slots
            .get_mut(index as usize)
            .and_then(|slot| slot.data.as_mut())
        {
            Some(data) => std::mem::take(&mut data.children),
            None => return,
        };
        for child in children {
            self.free_tree(child);
        }
        let Some(slot) = self.slots.get_mut(index as usize) else {
            return;
        };
        slot.data = None;
        slot.generation = slot.generation.wrapping_add(1);
        if slot.generation == 0 {
            slot.generation = 1;
        }
        self.free.push(index);
    }

    fn data(&self, index: u32) -> Result<&NodeData, PaintError> {
        self.slots
            .get(index as usize)
            .and_then(|slot| slot.data.as_ref())
            .ok_or_else(|| fail("missing paint node"))
    }

    fn data_mut(&mut self, index: u32) -> Result<&mut NodeData, PaintError> {
        self.slots
            .get_mut(index as usize)
            .and_then(|slot| slot.data.as_mut())
            .ok_or_else(|| fail("missing paint node"))
    }

    fn get(&self, node: NodeRef) -> Option<&NodeData> {
        let slot = self.slots.get(node.index as usize)?;
        if slot.generation != node.generation {
            return None;
        }
        slot.data.as_ref()
    }

    fn node_ref(&self, index: u32) -> Option<NodeRef> {
        let slot = self.slots.get(index as usize)?;
        if slot.data.is_none() {
            return None;
        }
        Some(NodeRef {
            index,
            generation: slot.generation,
        })
    }

    fn kind_of(&self, index: u32) -> Result<Kind, PaintError> {
        Ok(self.data(index)?.widget.kind())
    }

    fn widget_text(&self, id: u32) -> Result<String, PaintError> {
        Ok(self.data(id)?.widget.text().unwrap_or("").to_string())
    }

    fn child_ids(&self, index: u32) -> Vec<u32> {
        self.data(index)
            .map(|node| node.children.clone())
            .unwrap_or_default()
    }
}

fn assign_widget(widget: &mut Widget, key: &str, value: Option<Json>) -> Result<(), PaintError> {
    match widget.field_mut(key) {
        FieldMut::Str(slot) => {
            *slot = match value {
                Some(Json::String(text)) => text,
                _ => String::new(),
            };
        }
        FieldMut::Bool(slot, default) => {
            *slot = match value {
                Some(Json::Bool(bit)) => bit,
                _ => default,
            };
        }
        FieldMut::Num(slot) => {
            *slot = match value {
                Some(Json::Number(number)) if number.is_finite() => Some(number),
                _ => None,
            };
        }
        FieldMut::Tail => return Err(fail("missing field")),
    }
    Ok(())
}

fn edit_tail(
    tail: &mut BTreeMap<String, Json>,
    key: &str,
    rest: &[String],
    action: Action,
) -> Result<(), PaintError> {
    if rest.is_empty() {
        apply_object_key(tail, key, action)
    } else {
        let child = tail.get_mut(key).ok_or_else(|| fail("missing field"))?;
        update_in(child, rest, action)
    }
}

fn update_in(value: &mut Json, steps: &[String], action: Action) -> Result<(), PaintError> {
    let Some((key, rest)) = steps.split_first() else {
        return apply_leaf(value, action);
    };
    match value {
        Json::Object(map) => {
            if rest.is_empty() {
                apply_object_key(map, key, action)
            } else {
                let child = map.get_mut(key).ok_or_else(|| fail("missing field"))?;
                update_in(child, rest, action)
            }
        }
        Json::Array(items) => {
            let index = pointer_index(key, items.len(), &action)?;
            if rest.is_empty() {
                apply_array_index(items, index, action)
            } else if index >= items.len() {
                Err(fail("child index"))
            } else {
                update_in(&mut items[index], rest, action)
            }
        }
        _ => Err(fail("path")),
    }
}

fn apply_leaf(value: &mut Json, action: Action) -> Result<(), PaintError> {
    match action {
        Action::Replace(next) | Action::Add(next) => {
            *value = next;
            Ok(())
        }
        Action::Remove => Err(fail("remove value")),
        Action::Splice {
            from,
            delete,
            insert,
        } => {
            let Json::String(text) = value else {
                return Err(fail("splice target is not a string"));
            };
            splice_string(text, from, delete, &insert);
            Ok(())
        }
    }
}

fn apply_object_key(
    map: &mut BTreeMap<String, Json>,
    key: &str,
    action: Action,
) -> Result<(), PaintError> {
    match action {
        Action::Replace(value) | Action::Add(value) => {
            map.insert(key.to_string(), value);
            Ok(())
        }
        Action::Remove => {
            if map.remove(key).is_none() {
                return Err(fail("missing field"));
            }
            Ok(())
        }
        Action::Splice {
            from,
            delete,
            insert,
        } => {
            let slot = map
                .entry(key.to_string())
                .or_insert_with(|| Json::String(String::new()));
            let Json::String(text) = slot else {
                return Err(fail("splice target is not a string"));
            };
            splice_string(text, from, delete, &insert);
            Ok(())
        }
    }
}

fn apply_array_index(
    items: &mut Vec<Json>,
    index: usize,
    action: Action,
) -> Result<(), PaintError> {
    match action {
        Action::Add(value) => {
            if index > items.len() {
                return Err(fail("child index"));
            }
            items.insert(index, value);
            Ok(())
        }
        Action::Replace(value) => {
            if index >= items.len() {
                return Err(fail("child index"));
            }
            items[index] = value;
            Ok(())
        }
        Action::Remove => {
            if index >= items.len() {
                return Err(fail("child index"));
            }
            items.remove(index);
            Ok(())
        }
        Action::Splice { .. } => Err(fail("splice on array")),
    }
}

fn pointer_index(key: &str, len: usize, action: &Action) -> Result<usize, PaintError> {
    if key == "-" {
        return match action {
            Action::Add(_) => Ok(len),
            _ => Err(fail("pointer '-'")),
        };
    }
    if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(fail("pointer index"));
    }
    key.parse::<usize>().map_err(|_| fail("pointer index"))
}

/// UTF-16 code-unit edit of `text`. A unit that would split a scalar clamps
/// to that scalar. Append with no delete uses [`String::push_str`]; every
/// other edit uses [`String::replace_range`] on this allocation.
fn splice_string(text: &mut String, from: usize, delete: usize, insert: &str) {
    let start = byte_at_utf16(text, from);
    let end = byte_at_utf16(text, from.saturating_add(delete));
    let end = end.max(start);
    if start == text.len() && end == text.len() {
        text.push_str(insert);
        return;
    }
    text.replace_range(start..end, insert);
}

fn byte_at_utf16(text: &str, index: usize) -> usize {
    let mut seen = 0usize;
    for (byte, ch) in text.char_indices() {
        let next = seen + ch.len_utf16();
        if index <= seen {
            return byte;
        }
        if index < next {
            return byte;
        }
        seen = next;
    }
    text.len()
}

fn decode_message(value: Json) -> Result<Down, PaintError> {
    let Json::Object(mut map) = value else {
        return Err(fail("paint message"));
    };
    let kind = take_string(&mut map, "kind")?;
    match kind.as_str() {
        "paint_init" => Ok(Down::Init {
            epoch: take_string(&mut map, "epoch")?,
            snapshot: take_field(&mut map, "snapshot")?,
        }),
        "paint_patch" => {
            let epoch = take_string(&mut map, "epoch")?;
            let seq = take_u64(&mut map, "seq")?;
            let patches = match take_field(&mut map, "patches")? {
                Json::Array(items) => items,
                _ => return Err(fail("patches")),
            };
            let mut decoded = Vec::with_capacity(patches.len());
            for patch in patches {
                decoded.push(decode_patch(patch)?);
            }
            Ok(Down::Patch {
                epoch,
                seq,
                patches: decoded,
            })
        }
        _ => Err(fail("unknown paint message")),
    }
}

fn decode_patch(value: Json) -> Result<Patch, PaintError> {
    let Json::Object(mut map) = value else {
        return Err(fail("patch"));
    };
    let op = take_string(&mut map, "op")?;
    let path = take_string(&mut map, "path")?;
    let steps = pointer_steps(&path)?;
    let action = match op.as_str() {
        "add" => Action::Add(take_field(&mut map, "value")?),
        "replace" => Action::Replace(take_field(&mut map, "value")?),
        "remove" => Action::Remove,
        "splice" => Action::Splice {
            from: json_usize(map.get("from"))?,
            delete: json_usize(map.get("deleteCount"))?,
            insert: match map.get("insert") {
                Some(Json::String(text)) => text.clone(),
                _ => return Err(fail("splice insert")),
            },
        },
        _ => return Err(fail("patch op")),
    };
    Ok(Patch { steps, action })
}

fn pointer_steps(path: &str) -> Result<Vec<String>, PaintError> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    if !path.starts_with('/') {
        return Err(fail("patch path"));
    }
    let mut steps = Vec::new();
    for raw in path.split('/').skip(1) {
        steps.push(unescape_pointer(raw)?);
    }
    Ok(steps)
}

fn unescape_pointer(raw: &str) -> Result<String, PaintError> {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'~' {
            let Some(next) = bytes.get(index + 1) else {
                return Err(fail("bad pointer"));
            };
            match next {
                b'0' => out.push('~'),
                b'1' => out.push('/'),
                _ => return Err(fail("bad pointer")),
            }
            index += 2;
            continue;
        }
        let Some(ch) = raw[index..].chars().next() else {
            return Err(fail("bad pointer"));
        };
        out.push(ch);
        index += ch.len_utf8();
    }
    Ok(out)
}

fn take_field(map: &mut BTreeMap<String, Json>, key: &str) -> Result<Json, PaintError> {
    map.remove(key)
        .ok_or_else(|| fail(format!("missing {key}")))
}

fn take_string(map: &mut BTreeMap<String, Json>, key: &str) -> Result<String, PaintError> {
    match take_field(map, key)? {
        Json::String(text) => Ok(text),
        _ => Err(fail(format!("{key} type"))),
    }
}

fn take_u64(map: &mut BTreeMap<String, Json>, key: &str) -> Result<u64, PaintError> {
    match take_field(map, key)? {
        Json::Number(number) => json_u64(number).ok_or_else(|| fail(format!("{key} type"))),
        _ => Err(fail(format!("{key} type"))),
    }
}

fn json_usize(value: Option<&Json>) -> Result<usize, PaintError> {
    let Some(Json::Number(number)) = value else {
        return Err(fail("splice index"));
    };
    let number = json_u64(*number).ok_or_else(|| fail("splice index"))?;
    usize::try_from(number).map_err(|_| fail("splice index"))
}

fn json_u64(number: f64) -> Option<u64> {
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 {
        return None;
    }
    if number > (1u64 << 53) as f64 {
        return None;
    }
    Some(number as u64)
}

fn parse_json(bytes: &[u8]) -> Result<Json, PaintError> {
    if bytes.iter().all(|b| matches!(b, b' ' | b'\n' | b'\r' | b'\t')) {
        return Err(parse_err("empty paint message"));
    }
    let val: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| parse_err(e.to_string()))?;
    json_from_value(val)
}

fn json_from_value(val: serde_json::Value) -> Result<Json, PaintError> {
    match val {
        serde_json::Value::Null => Ok(Json::Null),
        serde_json::Value::Bool(b) => Ok(Json::Bool(b)),
        serde_json::Value::Number(n) => Ok(Json::Number(
            n.as_f64().ok_or_else(|| parse_err("number"))?,
        )),
        serde_json::Value::String(s) => Ok(Json::String(s)),
        serde_json::Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(json_from_value(item)?);
            }
            Ok(Json::Array(out))
        }
        serde_json::Value::Object(map) => {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                out.insert(k, json_from_value(v)?);
            }
            Ok(Json::Object(out))
        }
    }
}

fn chrome_hotkeys_of(value: Option<&Json>) -> Vec<(String, String)> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut hotkeys = Vec::new();
    for item in items {
        let Json::Object(map) = item else {
            continue;
        };
        let Some(Json::String(key)) = map.get("key") else {
            continue;
        };
        if key.is_empty() {
            continue;
        }
        let action = match map.get("action") {
            Some(Json::String(action)) => action.clone(),
            _ => String::new(),
        };
        hotkeys.push((key.clone(), action));
    }
    hotkeys
}

fn unique(kinds: &[&'static str]) -> Vec<&'static str> {
    let mut out = Vec::new();
    for kind in kinds {
        if !out.contains(kind) {
            out.push(*kind);
        }
    }
    out
}

fn kind_list(kinds: &[&str]) -> String {
    if kinds.is_empty() {
        "-".to_string()
    } else {
        kinds.join(",")
    }
}

fn fail(detail: impl Into<String>) -> PaintError {
    PaintError::ApplyFailed {
        detail: detail.into(),
    }
}

fn parse_err(detail: impl Into<String>) -> PaintError {
    PaintError::Parse {
        detail: detail.into(),
    }
}
