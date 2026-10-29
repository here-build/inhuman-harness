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
//!
//! Retained prepare follows `paint-widgets.ts`. A dirty node rebuilds and
//! dirties ancestors so they reassemble. Siblings stay cached. The same
//! offered width and a clean node returns the same [`Prepared`] allocation.
//! [`PaintReplica::note_replica`] arms one tally for prepares after a
//! `paint_patch`. [`PatchTally::line`] is
//! `seq=<n> rebuilt=<kinds> cached=<kinds>` (`-` when empty). A kind that
//! rebuilt is not also cached. `paint_init` drops the tally and does not
//! emit one. Kinds are the paint discriminants (`speech`, `thinking`,
//! `turn`, …).
//!
//! Assistant speech is markdown. A diff receipt is an `IndentKind::Diff`
//! node. Fences and diff lines stay plain until [`crate::syntax::warm`]
//! (irosashi, including the Arrival grammar). [`PaintReplica::note_syntax_warm`]
//! drops the retained layout so the next prepare colors them. Polarity selects
//! `github-dark` or `github-light`. A host phase sentence is not a snapshot
//! field. [`PaintReplica::set_phase`] keeps it, and [`PaintReplica::frame`]
//! seats it on the root wait pin. A root ask owns that pin, so the sentence
//! stays off. A diff ask is the last child of the tape viewport, so follow-tail
//! keeps the change on screen. Any other seated ask is the pin above the
//! composer. A receipt of `none` is not seated: that text is the composer stack.
//! The caller clears the phase sentence when a snapshot arrives.
//! [`stage_scene`] clones the layout node into the present owner.
//! It does not clone the paint tree.

use std::collections::BTreeMap;
use std::rc::Rc;

use crate::drawers::{
    self, agents_overlay, agents_peek, parse_agent_rows, parse_rewind_pins, rewind_neighbors,
    AgentsPlaque,
};
use crate::expand::{expand_diff, expand_markdown_with, DiffExpand, MarkdownExpand};
use crate::layout_chrome::{
    chrome_frame_paint_ops, measure_chrome_frame, ChromeFrame, ChromeQuotaWindow, ChromeStatusItem,
    Rect as ChromeRect,
};
use crate::layout_engine::{
    measure_tree, BoxStyle, Gutter, Node, SpinnerProfile, SpinnerRows, INDICATION_CONTENT_INSET,
};
use crate::layout_flex::{
    AlignItems, FlexDirection, FlexFactor, FlexStyle, JustifyContent, Length, Padding,
};
use crate::layout_text::{
    measure_text_node, wrap_text, MeasuredStamp, TextNode, WhiteSpace, WrapOpts,
};
use crate::paint_widget::{parse as parse_widget, FieldMut, Kind, Widget};
use crate::present::Present;
use crate::syntax::{self, Polarity};
use crate::theme::{BgP, FgP};
use crate::Style;

const UNBOUNDED_H: i64 = 10_000;
const SPEECH_STAMP_CELLS: i64 = 8;
const SPEECH_STAMP_GAP: i64 = 1;
const SPEECH_STAMP_RESERVE: i64 = SPEECH_STAMP_CELLS + SPEECH_STAMP_GAP;
const USER_BLOCK_PAD: i64 = 1;
const USER_MARK_GAP: i64 = 1;
/// Draft column: `│` + mark + gap. The trailing `│` is the right pad.
const STATUSLINE_PAD_L: i64 = 3;
const STATUSLINE_PAD_R: i64 = 1;

/// Indication inset, then the user floor's right pad, so both clocks share a column.
fn reply_rail_width(column_w: i64) -> i64 {
    column_w
        .saturating_sub(INDICATION_CONTENT_INSET + USER_BLOCK_PAD)
        .max(8)
}

/// Local object identity. Not a wire id. Equal across an in-place field replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NodeRef {
    index: u32,
    generation: u32,
}

/// One prepare. `width` is the offered width. The same allocation is reused
/// when the node is clean and the width matches.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub width: i64,
    pub root: Node,
    pub paint_ready: bool,
    pub measured: MeasuredStamp,
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

    /// Layout `node` at `width`. A clean node at the same width returns the
    /// cached [`Prepared`]. Records the kind when a tally is armed.
    pub fn prepare(&mut self, node: NodeRef, width: i64) -> Result<Rc<Prepared>, PaintError> {
        let index = self.index_of(node)?;
        self.prepare_id(index, width)
    }

    /// Composer (when the root has one) and then the root column.
    /// Same order as the paint source: composer, then the tape.
    pub fn prepare_scene(&mut self, width: i64) -> Result<Rc<Prepared>, PaintError> {
        let root = self.root.ok_or_else(|| fail("no paint root"))?;
        if let Some(composer) = self.child_kind(root, Kind::Composer) {
            let composer_ref = self
                .arena
                .node_ref(composer)
                .ok_or_else(|| fail("missing composer"))?;
            self.prepare(composer_ref, width)?;
        }
        let root_ref = self
            .arena
            .node_ref(root)
            .ok_or_else(|| fail("missing root"))?;
        self.prepare(root_ref, width)
    }

    /// Status line, tape, then the phase label. The composer is the present
    /// chrome frame, not a second node in this column.
    pub fn frame(&mut self, width: i64) -> Result<Node, PaintError> {
        let root = self.root.ok_or_else(|| fail("no paint root"))?;
        let _ = self.prepare_scene(width)?;
        let mut children = Vec::new();
        if let Some(id) = self.child_kind(root, Kind::Statusline) {
            let node_ref = self.arena.node_ref(id).ok_or_else(|| fail("statusline"))?;
            children.push(self.prepare(node_ref, width)?.root.clone());
            children.push(gap_row("statusline:gap", width));
        }
        let root_ref = self
            .arena
            .node_ref(root)
            .ok_or_else(|| fail("missing root"))?;
        if let Some(id) = self.child_kind(root, Kind::Rewind) {
            if let Some(seat) = self.layout_rewind(id, width)? {
                children.push(seat);
            }
        }
        let mut tape = self.prepare(root_ref, width)?.root.clone();
        if self.browsing() {
            dim_outside_recap(&mut tape);
        }
        let mut ask = self.root_ask(root, width);
        let mut viewport = crate::host_overlay::tape_node(width, tape);
        if let Some(RootAsk::Diff(diff)) = ask.take() {
            if let crate::layout_engine::Node::Viewport { children, .. } = &mut viewport {
                children.push(diff);
            }
        }
        if self.fresh_home(root) {
            children.push(home_column(width));
        } else {
            children.push(viewport);
            if let Some(RootAsk::Pin(pin)) = ask {
                children.push(pin);
            }
            if let Some(pin) = self.wait_pin(root, width) {
                children.push(pin);
            }
        }
        let screen = column("screen".to_string(), width, children);
        if let Some(overlay) = self.open_agents_overlay(root, width)? {
            return Ok(Node::Box {
                style: BoxStyle {
                    width: Some(crate::layout_flex::Length::Cells(width.max(0))),
                    ..BoxStyle::default()
                },
                children: vec![screen, overlay],
                key: Some("frame".to_string()),
                id: None,
                measured: None,
                region_prominence: None,
            });
        }
        Ok(screen)
    }

    /// The root composer, when the snapshot has one.
    pub fn composer_face(&self) -> Option<crate::present::ComposerFace> {
        let root = self.root?;
        let id = self.child_kind(root, Kind::Composer)?;
        let node = self.arena.data(id).ok()?;
        let composer = node.widget.composer()?;
        let draft = composer.draft.clone();
        let cursor = composer
            .cursor
            .map(number_cursor)
            .unwrap_or_else(|| i64::try_from(draft.len()).unwrap_or(0));
        let mark = composer.mark.map(number_cursor);
        let interactive = composer.interactive && !composer.read_only;
        let annotation = composer.annotation.clone();
        let tail = &node.tail;
        Some(crate::present::ComposerFace {
            draft,
            cursor,
            mark,
            interactive,
            annotation,
            join_annotation: string_field(tail, "joinAnnotation"),
            hotkeys: chrome_hotkeys_of(tail.get("hotkeys")),
            status_items: status_items_of(tail.get("statusItems")),
            quota_windows: quota_windows_of(tail.get("quotaWindows")),
            context_used: finite_number(tail.get("contextUsed")),
            context_limit: finite_number(tail.get("contextLimit")),
            contour_role: string_field(tail, "contourRole"),
            progress: finite_number(tail.get("progress")),
            progress_role: string_field(tail, "progressColor"),
            progress_glow_at: finite_number(tail.get("progressGlowAt")),
            picker: picker_of(tail),
            stacked_body: string_field(tail, "stackedBody"),
            stacked_viewport: finite_number(tail.get("stackedViewport"))
                .map(number_cursor)
                .unwrap_or(0),
            stacked_numbered: matches!(tail.get("stackedNumbered"), Some(Json::Bool(true))),
            stacked_lang: string_field(tail, "stackedLang"),
            scroll_offset: finite_number(tail.get("scrollOffset"))
                .map(number_cursor)
                .unwrap_or(0),
        })
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
        let raw = self.open_tally.take()?;
        let rebuilt = unique(&raw.rebuilt);
        let cached = unique(&raw.cached)
            .into_iter()
            .filter(|kind| !rebuilt.contains(kind))
            .collect();
        Some(PatchTally { rebuilt, cached })
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
    ///
    /// The snapshot is not edited. The next [`Self::frame`] paints the
    /// sentence when a root wait exists and no root ask owns the pin.
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
        let root = arena.ingest(&mut self.clock, snapshot, None)?;
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
        // User prompts switch between the mist floor and the rewind border on this flag.
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
                node.prepared = None;
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

    fn prepare_id(&mut self, index: u32, width: i64) -> Result<Rc<Prepared>, PaintError> {
        if let Some(hit) = self.cache_hit(index, width) {
            self.record(index, true)?;
            return Ok(hit);
        }
        let mut root = self.layout_dispatch(index, width)?;
        let extent = measure_tree(&root, width, UNBOUNDED_H, None);
        let measured = MeasuredStamp {
            w: extent.w,
            h: extent.h,
            at_w: width,
        };
        set_measured(&mut root, measured);
        let prepared = Rc::new(Prepared {
            width,
            root,
            paint_ready: true,
            measured,
        });
        {
            let node = self.arena.data_mut(index)?;
            node.dirty = false;
            node.prepared_width = width;
            node.prepared = Some(Rc::clone(&prepared));
        }
        self.record(index, false)?;
        Ok(prepared)
    }

    fn cache_hit(&self, index: u32, width: i64) -> Option<Rc<Prepared>> {
        let node = self.arena.data(index).ok()?;
        if node.dirty {
            return None;
        }
        let prepared = node.prepared.as_ref()?;
        if node.prepared_width != width {
            return None;
        }
        Some(Rc::clone(prepared))
    }

    fn record(&mut self, index: u32, cached: bool) -> Result<(), PaintError> {
        let kind = self.arena.kind_of(index)?.as_str();
        if let Some(tally) = &mut self.open_tally {
            if cached {
                tally.cached.push(kind);
            } else {
                tally.rebuilt.push(kind);
            }
        }
        Ok(())
    }

    fn layout_dispatch(&mut self, index: u32, width: i64) -> Result<Node, PaintError> {
        match self.arena.kind_of(index)? {
            Kind::Root | Kind::Stack => self.layout_children(index, width, true),
            Kind::Preview => self.layout_children(index, width, false),
            Kind::Turn => self.layout_turn(index, width),
            Kind::Completion => self.layout_completion(index, width),
            Kind::Speech => self.layout_speech(index, width),
            Kind::Thinking => self.layout_thinking(index, width),
            Kind::Failure => self.layout_failure(index, width),
            Kind::Recall | Kind::Compact => self.layout_recall(index, width),
            Kind::Tool | Kind::Scheme | Kind::Loop | Kind::Ask | Kind::Wait => {
                self.layout_work(index, width)
            }
            Kind::Composer => self.layout_composer(index, width),
            Kind::Statusline => self.layout_statusline(index, width),
            Kind::Agents => self.layout_agents(index, width),
            Kind::Rewind => Ok(self
                .layout_rewind(index, width)?
                .unwrap_or_else(|| empty_box(format!("rewind:{index}")))),
        }
    }

    fn layout_children(
        &mut self,
        id: u32,
        width: i64,
        skip_chrome: bool,
    ) -> Result<Node, PaintError> {
        let children = self.arena.child_ids(id);
        let label = self.arena.kind_of(id)?.as_str();
        let mut nodes = Vec::new();
        for child in children {
            if skip_chrome && is_root_chrome(self.arena.kind_of(child)?) {
                continue;
            }
            nodes.push(self.prepare_id(child, width)?.root.clone());
        }
        Ok(column(format!("{label}:{id}"), width, nodes))
    }

    fn layout_turn(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let children = self.arena.child_ids(id);
        let mut nodes = Vec::new();
        for child in children {
            match self.arena.kind_of(child)? {
                Kind::Composer | Kind::Ask | Kind::Wait | Kind::Agents => continue,
                Kind::Tool | Kind::Scheme => {
                    let (fuse, mutate) = match self.arena.data(child)?.widget.work() {
                        Some(work) => (work.fuse, is_mutate(&work.name)),
                        None => (false, false),
                    };
                    if fuse {
                        continue;
                    }
                    // One page cell above and below a file edit. A gap already
                    // above it is not doubled.
                    if mutate {
                        let preceded_by_gap = match nodes.last() {
                            Some(Node::Box { key: Some(key), .. }) => key.starts_with("gap:"),
                            _ => false,
                        };
                        if !preceded_by_gap {
                            nodes.push(gap_row(&format!("gap:before-edit:{child}"), width));
                        }
                    }
                    nodes.push(self.prepare_id(child, width)?.root.clone());
                    if mutate {
                        nodes.push(gap_row(&format!("gap:after-edit:{child}"), width));
                    }
                }
                Kind::Loop | Kind::Recall | Kind::Compact => {
                    nodes.push(self.prepare_id(child, width)?.root.clone());
                }
                Kind::Speech => {
                    let user = self
                        .arena
                        .data(child)?
                        .widget
                        .speech()
                        .is_some_and(|speech| speech.voice == "user");
                    if user {
                        // One page cell outside the mist floor. A thicker floor pad would also shift the clock.
                        let preceded_by_gap = match nodes.last() {
                            Some(Node::Box { key: Some(key), .. }) => key.starts_with("gap:"),
                            _ => false,
                        };
                        if !preceded_by_gap {
                            nodes.push(gap_row(&format!("gap:before-user:{child}"), width));
                        }
                        nodes.push(self.prepare_id(child, width)?.root.clone());
                        nodes.push(gap_row(&format!("gap:after-user:{child}"), width));
                    }
                }
                Kind::Completion => {
                    if let Some(node) = self.turn_completion(child, width)? {
                        nodes.push(node);
                    }
                }
                _ => {}
            }
        }
        Ok(column(format!("turn:{id}"), width, nodes))
    }

    fn turn_completion(&mut self, id: u32, width: i64) -> Result<Option<Node>, PaintError> {
        let speech = self.child_kind(id, Kind::Speech);
        let thinking = self.child_kind(id, Kind::Thinking);
        let speech_text = match speech {
            Some(speech) => self.arena.widget_text(speech)?,
            None => String::new(),
        };
        let thought = match thinking {
            Some(thinking) => self.arena.widget_text(thinking)?,
            None => String::new(),
        };
        let (state, show_debug) = match self.arena.data(id)?.widget.completion() {
            Some(body) => (body.state.clone(), !body.debug_note.trim().is_empty()),
            None => (String::new(), false),
        };
        let show_speech = !speech_text.is_empty();
        let show_failure = state == "failed" && speech_text.is_empty();
        let show_thought = !thought.trim().is_empty();
        if show_speech || show_failure || show_debug {
            let completion = self.prepare_id(id, width)?.root.clone();
            if show_thought {
                if let Some(thinking_id) = thinking {
                    let thought_node = self.prepare_id(thinking_id, width)?.root.clone();
                    return Ok(Some(column(
                        format!("completion:{id}:with-thought"),
                        width,
                        vec![
                            thought_node,
                            gap_row(&format!("gap:{id}"), width),
                            completion,
                        ],
                    )));
                }
            }
            return Ok(Some(completion));
        }
        if show_thought {
            if let Some(thinking_id) = thinking {
                return Ok(Some(self.prepare_id(thinking_id, width)?.root.clone()));
            }
        }
        Ok(None)
    }

    fn layout_completion(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let speech = self.child_kind(id, Kind::Speech);
        let failure = self.child_kind(id, Kind::Failure);
        let speech_text = match speech {
            Some(speech) => self.arena.widget_text(speech)?,
            None => String::new(),
        };
        let (state, debug) = match self.arena.data(id)?.widget.completion() {
            Some(body) => (body.state.clone(), body.debug_note.clone()),
            None => (String::new(), String::new()),
        };
        if state == "failed" && speech_text.is_empty() {
            if let Some(failure_id) = failure {
                return Ok(self.prepare_id(failure_id, width)?.root.clone());
            }
        }
        if !speech_text.is_empty() {
            if let Some(speech_id) = speech {
                return Ok(self.prepare_id(speech_id, width)?.root.clone());
            }
        }
        if !debug.trim().is_empty() {
            return Ok(text_node(
                format!("completion:{id}:cache"),
                debug.trim(),
                WhiteSpace::PreWrap,
                fg("muted", FgP::GHOST),
                None,
                None,
            ));
        }
        Ok(empty_box(format!("completion:{id}")))
    }

    fn layout_speech(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let (text, user, recap, at_ms, annotation) = match self.arena.data(id)?.widget.speech() {
            Some(speech) => (
                speech.text.clone(),
                speech.voice == "user",
                speech.recap,
                speech.at_ms,
                speech.annotation.clone(),
            ),
            None => (String::new(), false, false, None, String::new()),
        };
        let key = format!("speech:{id}");
        // Off-tip, every user prompt takes the seat's border. Only the seat carries the hotkeys.
        if user && (recap || self.browsing()) {
            let hotkeys = if recap {
                chrome_hotkeys_of(self.arena.data(id)?.tail.get("recapHotkeys"))
            } else {
                Vec::new()
            };
            let note = if recap { annotation } else { String::new() };
            let suffix = if recap { "recap" } else { "rewind" };
            return Ok(Node::Chrome {
                key: Some(format!("{key}:{suffix}")),
                frame: crate::layout_chrome::speech_recap_frame(width, text, &note, hotkeys),
            });
        }
        let state = match self.completion_ancestor(id) {
            Some(completion) => match self.arena.data(completion)?.widget.completion() {
                Some(body) => body.state.clone(),
                None => String::new(),
            },
            None => "live".to_string(),
        };
        let live = state == "live";
        let failed = state == "failed";
        let content_w = if user {
            width
                .saturating_sub(USER_BLOCK_PAD * 2 + 1 + USER_MARK_GAP)
                .max(8)
        } else {
            reply_rail_width(width)
        };
        let text_w = content_w.saturating_sub(SPEECH_STAMP_RESERVE).max(8);
        if !failed {
            self.note_expand(id, &text, text_w, !live)?;
        }
        let body_voice = if failed {
            fg("error", FgP::PRIMARY)
        } else if user {
            fg_bold("foreground", FgP::PRIMARY)
        } else {
            fg("foreground", FgP::PRIMARY)
        };
        let body = if user {
            stamped_text(
                &format!("{key}:body-text"),
                &text,
                text_w,
                WhiteSpace::PreWrap,
                body_voice,
            )
        } else {
            let md_key = format!("{key}:md");
            let mut opts = MarkdownExpand::new(&text);
            opts.key = &md_key;
            opts.width = Some(text_w);
            opts.style = Some(&body_voice);
            expand_markdown_with(&opts)
        };
        let rail = stamp_rail(&key, content_w, text_w, at_ms, body);
        if user {
            return Ok(user_block(&key, rail));
        }
        let gutter_style = if failed {
            fg("error", FgP::PRIMARY)
        } else if live {
            fg("foreground", FgP::RISING)
        } else {
            fg("foreground", FgP::PRIMARY)
        };
        Ok(indication(
            format!("{key}:speech"),
            Gutter::Top {
                glyph: " ".to_string(),
            },
            gutter_style,
            vec![rail],
        ))
    }

    fn note_expand(
        &mut self,
        id: u32,
        text: &str,
        text_w: i64,
        ended: bool,
    ) -> Result<(), PaintError> {
        let polarity = self.polarity;
        let miss = match &self.arena.data(id)?.expanded {
            None => true,
            Some(prev) => {
                prev.text != text
                    || prev.width != text_w
                    || prev.ended != ended
                    || prev.polarity != polarity
            }
        };
        if !miss {
            return Ok(());
        }
        let node = self.arena.data_mut(id)?;
        node.expands = node.expands.saturating_add(1);
        node.expanded = Some(ExpandCache {
            text: text.to_string(),
            width: text_w,
            ended,
            polarity,
        });
        Ok(())
    }

    fn layout_thinking(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let text = self.arena.widget_text(id)?;
        let raw = text.trim().to_string();
        let key = format!("thinking:{id}");
        let live = match self.completion_ancestor(id) {
            Some(completion) => self
                .arena
                .data(completion)?
                .widget
                .completion()
                .is_some_and(|body| body.thought_live),
            None => false,
        };
        let style = fg("foreground", FgP::SECONDARY);
        let content_w = width.saturating_sub(INDICATION_CONTENT_INSET).max(8);
        if raw.is_empty() && !live {
            return Ok(indication(
                key.clone(),
                Gutter::Top {
                    glyph: "⁖".to_string(),
                },
                fg("foreground", FgP::GHOST),
                vec![text_node(
                    format!("{key}:t"),
                    "thought",
                    WhiteSpace::Normal,
                    style,
                    Some(true),
                    Some(1),
                )],
            ));
        }
        let mut lines = raw.lines();
        let summary_text = if raw.is_empty() {
            "thinking".to_string()
        } else {
            lines.next().unwrap_or("").to_string()
        };
        let rest = lines.collect::<Vec<_>>().join("\n");
        // Peek is plain text. Markdown expand is not this module.
        // `place_disclosure` paints the summary or the children, so the open list repeats the peek.
        let summary = thinking_header(&key, "sum", &summary_text, content_w, live, style.clone());
        let mut children = Vec::new();
        if !raw.is_empty() {
            children.push(thinking_header(
                &key,
                "hdr",
                &summary_text,
                content_w,
                live,
                style.clone(),
            ));
            if !rest.is_empty() {
                children.push(indication(
                    format!("{key}:bar"),
                    Gutter::Rule {
                        glyph: "┃".to_string(),
                    },
                    fg("foreground", FgP::GHOST),
                    vec![stamped_text(
                        &format!("{key}:md"),
                        &rest,
                        content_w,
                        WhiteSpace::PreWrap,
                        style,
                    )],
                ));
            }
        }
        Ok(Node::Disclosure {
            collapsed: true,
            summary: Box::new(summary),
            children,
            key: Some(key),
            measured: None,
            region_prominence: None,
        })
    }

    fn layout_failure(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let (detail, reason) = match self.arena.data(id)?.widget.failure() {
            Some((detail, reason)) => (detail.to_string(), reason.to_string()),
            None => (String::new(), String::new()),
        };
        let text = if !detail.trim().is_empty() {
            detail.trim().to_string()
        } else if !reason.trim().is_empty() {
            reason.trim().to_string()
        } else {
            "turn failed".to_string()
        };
        let key = format!("failure:{id}");
        let content_w = reply_rail_width(width);
        let text_w = content_w.saturating_sub(SPEECH_STAMP_RESERVE).max(8);
        let at_ms = match self
            .completion_ancestor(id)
            .and_then(|completion| self.child_kind(completion, Kind::Speech))
        {
            Some(speech) => self
                .arena
                .data(speech)?
                .widget
                .speech()
                .and_then(|body| body.at_ms),
            None => None,
        };
        let body = stamped_text(
            &format!("{key}:text"),
            &text,
            text_w,
            WhiteSpace::PreWrap,
            fg("error", FgP::PRIMARY),
        );
        let rail = stamp_rail(&key, content_w, text_w, at_ms, body);
        Ok(indication(
            format!("{key}:speech"),
            Gutter::Top {
                glyph: " ".to_string(),
            },
            fg("error", FgP::PRIMARY),
            vec![rail],
        ))
    }

    fn layout_recall(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let text = self.arena.widget_text(id)?;
        Ok(box_w(
            format!("recall:{id}"),
            width,
            vec![text_node(
                format!("recall:{id}:text"),
                &text,
                WhiteSpace::PreWrap,
                fg("muted", FgP::GHOST),
                None,
                None,
            )],
        ))
    }

    fn layout_work(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        if self.arena.kind_of(id)? == Kind::Wait {
            return self.layout_wait_pin(id, width);
        }
        let face = self.read_work(id)?;
        if self.arena.kind_of(id)? == Kind::Ask {
            return Ok(ask_pin(id, &face, width));
        }
        Ok(tape_work(id, &face, width))
    }

    /// Root wait pin. A live pin paints the status sentence. `name` is the
    /// machine kind (`waiting`, `connecting`) and stays off the row. A failure
    /// wraps the whole message.
    fn layout_wait_pin(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let (name, object, status, state, receipt_kind, receipt, diff_path, diff_old, diff_new) =
            match self.arena.data(id)?.widget.work() {
                Some(work) => (
                    work.name.clone(),
                    work.object.clone(),
                    work.status.clone(),
                    work.state.clone(),
                    work.receipt_kind.clone(),
                    work.receipt_text.clone(),
                    work.diff_path.clone(),
                    work.diff_old.clone(),
                    work.diff_new.clone(),
                ),
                None => (
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                ),
            };
        let key = format!("work:{id}");
        let text_w = width.saturating_sub(INDICATION_CONTENT_INSET).max(8);
        let voice = if state == "fail" {
            fg("error", FgP::PRIMARY)
        } else {
            fg("foreground", FgP::PRIMARY)
        };
        let gutter = if state == "live" {
            Gutter::Spinner {
                profile: Some(SpinnerProfile::Tool),
                rows: Some(SpinnerRows::Top),
            }
        } else {
            Gutter::Top {
                glyph: "·".to_string(),
            }
        };
        let failed = state == "fail";
        let line = if !failed && self.arena.kind_of(id)? == Kind::Wait {
            match (status.is_empty(), object.is_empty()) {
                (false, true) => status,
                (true, false) => object,
                (false, false) => format!("{status}  {object}"),
                (true, true) => String::new(),
            }
        } else {
            identity_line(&name, &object, &status)
        };
        let identity = indication(
            format!("{key}:id"),
            gutter,
            voice.clone(),
            vec![text_node(
                format!("{key}:text"),
                &line,
                if failed {
                    WhiteSpace::PreWrap
                } else {
                    WhiteSpace::Nowrap
                },
                voice,
                if failed { None } else { Some(true) },
                if failed { None } else { Some(1) },
            )],
        );
        if name == "read_file" {
            return Ok(box_w(key, width, vec![identity]));
        }
        let caption = self.tail_str(id, "caption");
        let pretty_block = self.tail_str(id, "prettyBlock");
        // Open paints `children` only. The identity stays on that face and on the collapsed summary.
        let mut extra = vec![identity.clone()];
        if !caption.is_empty() {
            extra.push(text_node(
                format!("{key}:caption"),
                &caption,
                WhiteSpace::PreWrap,
                fg("foreground", FgP::GHOST),
                None,
                None,
            ));
        }
        if receipt_kind != "diff" && !pretty_block.is_empty() {
            let pretty_key = format!("{key}:pretty-md");
            let meta = fg("foreground", FgP::GHOST);
            let mut opts = MarkdownExpand::new(&pretty_block);
            opts.key = &pretty_key;
            opts.width = Some(text_w);
            opts.style = Some(&meta);
            extra.push(expand_markdown_with(&opts));
        }
        if receipt_kind != "none" && receipt_kind != "diff" && !receipt.is_empty() {
            extra.push(stamped_text(
                &format!("{key}:receipt"),
                &receipt,
                text_w,
                WhiteSpace::PreWrap,
                fg("foreground", FgP::SECONDARY),
            ));
        }
        if receipt_kind == "diff" {
            let path = diff_path;
            let old = diff_old;
            let new_text = diff_new;
            let diff_key = format!("{key}:diff");
            let mut opts = DiffExpand::new(&old, &new_text, text_w);
            opts.path = &path;
            opts.key = &diff_key;
            opts.language = syntax::lang_for_path(&path);
            extra.push(expand_diff(&opts));
        }
        if extra.is_empty() {
            return Ok(box_w(key, width, vec![identity]));
        }
        Ok(Node::Disclosure {
            collapsed: state != "live",
            summary: Box::new(identity),
            children: extra,
            key: Some(key),
            measured: None,
            region_prominence: None,
        })
    }

    fn read_work(&self, id: u32) -> Result<WorkFace, PaintError> {
        let (name, object, status, state, receipt_kind, receipt, diff_path, diff_old, diff_new) =
            match self.arena.data(id)?.widget.work() {
                Some(work) => (
                    work.name.clone(),
                    work.object.clone(),
                    work.status.clone(),
                    work.state.clone(),
                    work.receipt_kind.clone(),
                    work.receipt_text.clone(),
                    work.diff_path.clone(),
                    work.diff_old.clone(),
                    work.diff_new.clone(),
                ),
                None => (
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                ),
            };
        Ok(WorkFace {
            name,
            object,
            status,
            state,
            caption: self.tail_str(id, "caption"),
            pretty_block: self.tail_str(id, "prettyBlock"),
            receipt_kind,
            receipt,
            diff_path,
            diff_old,
            diff_new,
            indent: self.tail_bool(id, "indent", false),
            split: self.tail_bool(id, "split", false),
            agent: self.tail_bool(id, "agent", false),
            pretty: self.tail_bool(id, "pretty", false),
            line_start: self.tail_i64(id, "diffLineStart", 0),
            tool_call_id: self.tail_str(id, "toolCallId"),
        })
    }

    fn layout_composer(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let (draft, placeholder, annotation, cursor, mark, interactive, read_only) =
            match self.arena.data(id)?.widget.composer() {
                Some(composer) => {
                    let read_only = composer.read_only;
                    let interactive = composer.interactive && !read_only;
                    (
                        composer.draft.clone(),
                        composer.placeholder.clone(),
                        composer.annotation.clone(),
                        composer.cursor,
                        composer.mark,
                        interactive,
                        read_only,
                    )
                }
                None => (
                    String::new(),
                    String::new(),
                    String::new(),
                    None,
                    None,
                    true,
                    false,
                ),
            };
        Ok(chrome_box(
            "composer:frame",
            width,
            &ChromeParts {
                draft,
                placeholder,
                annotation,
                cursor: if interactive {
                    cursor.map(|cursor| cursor as i64)
                } else {
                    None
                },
                mark: if interactive {
                    mark.map(|mark| mark as i64)
                } else {
                    None
                },
                interactive,
                read_only,
                plain_bottom: false,
                selected: false,
            },
        ))
    }

    fn layout_statusline(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        let (left, cwd) = match self.arena.data(id)?.widget.statusline() {
            Some((left, cwd)) => (left.to_string(), cwd.to_string()),
            None => (String::new(), String::new()),
        };
        let cwd_root = self.tail_str(id, "cwdRoot");
        let note = self.tail_str(id, "note");
        Ok(statusline_row(id, width, &left, &note, &cwd, &cwd_root))
    }

    fn layout_agents(&mut self, id: u32, width: i64) -> Result<Node, PaintError> {
        if self.tail_bool(id, "open", false) {
            let focus = self.tail_str(id, "focusKey");
            let rows = parse_agent_rows(self.tail_json(id, "rows").as_ref());
            return Ok(drawers::agents_drawer(&rows, &focus, width));
        }
        let (left, right) = match self.arena.data(id)?.widget.agents() {
            Some((left, right)) => (left.to_string(), right.to_string()),
            None => (String::new(), String::new()),
        };
        Ok(box_w(
            format!("agents:{id}"),
            width,
            vec![text_node(
                format!("agents:{id}:meter"),
                &format!("{left} {right}"),
                WhiteSpace::Nowrap,
                fg("foreground", FgP::SECONDARY),
                Some(true),
                Some(1),
            )],
        ))
    }

    /// Pins the host sent. `atTip` hides the future stack. It is not a caption.
    fn layout_rewind(&mut self, id: u32, width: i64) -> Result<Option<Node>, PaintError> {
        let mut children = Vec::new();
        if let Some(past) = self.rewind_past(id, width)? {
            children.push(past);
        }
        if let Some(future) = self.rewind_future(id, width)? {
            children.push(future);
        }
        if children.is_empty() {
            return Ok(None);
        }
        Ok(Some(column(format!("rewind:{id}"), width, children)))
    }

    /// Past pins on the snapshot. The previous seat is not kept.
    fn rewind_past(&mut self, id: u32, width: i64) -> Result<Option<Node>, PaintError> {
        let past = parse_rewind_pins(self.tail_json(id, "past").as_ref());
        let total = self.tail_i64(id, "pastTotal", past.len() as i64);
        Ok(rewind_neighbors(
            &past,
            width,
            "rewind:behind",
            true,
            total > past.len() as i64,
        ))
    }

    /// Future pins. At the tip the host's ahead stack is not painted.
    fn rewind_future(&mut self, id: u32, width: i64) -> Result<Option<Node>, PaintError> {
        if self.arena.data(id)?.widget.at_tip().unwrap_or(true) {
            return Ok(None);
        }
        let future = parse_rewind_pins(self.tail_json(id, "future").as_ref());
        let total = self.tail_i64(id, "futureTotal", future.len() as i64);
        Ok(rewind_neighbors(
            &future,
            width,
            "rewind:ahead",
            false,
            total > future.len() as i64,
        ))
    }

    fn open_agents_overlay(&mut self, root: u32, width: i64) -> Result<Option<Node>, PaintError> {
        let Some(id) = self.child_kind(root, Kind::Agents) else {
            return Ok(None);
        };
        if !self.tail_bool(id, "open", false) {
            return Ok(None);
        }
        let scroll = self.tail_i64(id, "scroll", 0);
        // Panel padding is one cell on each side. The body is prepared at that inner width.
        let panel_w = (width / 2).max(16);
        let inner = (panel_w - 2).max(8);
        let node_ref = self.arena.node_ref(id).ok_or_else(|| fail("agents"))?;
        let body = self.prepare(node_ref, inner)?.root.clone();
        Ok(Some(agents_overlay(body, width, scroll)))
    }

    /// Plaque for the focused row. Bots, the current session, and an open preview have none.
    pub fn agents_plaque(&self) -> Option<AgentsPlaque> {
        let root = self.root?;
        let id = self.child_kind(root, Kind::Agents)?;
        if !self.tail_bool(id, "open", false) || !self.tail_str(id, "previewKey").is_empty() {
            return None;
        }
        let focus = self.tail_str(id, "focusKey");
        if focus.is_empty() {
            return None;
        }
        let rows = parse_agent_rows(self.tail_json(id, "rows").as_ref());
        let row = rows.iter().find(|row| row.key == focus)?;
        let node = agents_peek(row)?;
        Some(AgentsPlaque { focus, node })
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
        if self.child_kind(root, Kind::Ask).is_some() || self.child_kind(root, Kind::Wait).is_some() {
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

    /// Sneak-peek is open. The drawer may stay closed. [`Self::preview_overlay`] is the modal.
    pub fn agents_preview_open(&self) -> bool {
        let Some(root) = self.root else {
            return false;
        };
        let Some(id) = self.child_kind(root, Kind::Agents) else {
            return false;
        };
        !self.tail_str(id, "previewKey").is_empty()
    }

    /// Sneak-peek modal for the current frame size. `None` when the preview
    /// key is empty or the host sent no preview tape. A settled mention keeps
    /// the drawer closed; the title then comes from that tape cell.
    pub fn preview_overlay(&mut self, cols: i64, rows: i64) -> Option<Node> {
        let root = self.root?;
        let agents = self.child_kind(root, Kind::Agents)?;
        let preview_key = self.tail_str(agents, "previewKey");
        if preview_key.is_empty() {
            return None;
        }
        let title = parse_agent_rows(self.tail_json(agents, "rows").as_ref())
            .into_iter()
            .find(|row| row.key == preview_key)
            .map(|row| row.name)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| {
                preview_key
                    .strip_prefix("call:")
                    .map(|id| self.agent_name(id))
                    .unwrap_or_default()
            });
        let preview = self.child_kind(root, Kind::Preview)?;
        let inner = drawers::agents_preview_inner_width(cols);
        let node_ref = self.arena.node_ref(preview)?;
        let tape = self.prepare(node_ref, inner).ok()?.root.clone();
        Some(drawers::agents_preview_overlay(tape, cols, rows, &title))
    }

    /// Spec painted on the tape cell for this tool call. Empty when the cell is gone.
    fn agent_name(&self, tool_call_id: &str) -> String {
        let Some(root) = self.root else {
            return String::new();
        };
        self.agent_name_at(root, tool_call_id).unwrap_or_default()
    }

    fn agent_name_at(&self, id: u32, tool_call_id: &str) -> Option<String> {
        if self.tail_bool(id, "agent", false) && self.tail_str(id, "toolCallId") == tool_call_id {
            let name = self
                .arena
                .data(id)
                .ok()?
                .widget
                .work()
                .map(|work| work.name.clone())
                .unwrap_or_default();
            if !name.is_empty() {
                return Some(name);
            }
        }
        for child in self.arena.child_ids(id) {
            if let Some(name) = self.agent_name_at(child, tool_call_id) {
                return Some(name);
            }
        }
        None
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
        self.arena.ingest(&mut self.clock, value, parent)
    }

    fn index_of(&self, node: NodeRef) -> Result<u32, PaintError> {
        if self.arena.get(node).is_none() {
            return Err(fail("missing paint node"));
        }
        Ok(node.index)
    }

    /// Diff ask joins the tape. Any other receipt is the pin above the composer.
    /// `none` stays off: the composer stack already carries that text.
    fn root_ask(&self, root: u32, width: i64) -> Option<RootAsk> {
        let id = self.child_kind(root, Kind::Ask)?;
        let face = self.read_work(id).ok()?;
        if face.split || face.receipt_kind == "none" {
            return None;
        }
        let pin = ask_pin(id, &face, width);
        let empty = match &pin {
            Node::Box { children, .. } => children.is_empty(),
            _ => false,
        };
        if empty {
            return None;
        }
        if face.receipt_kind == "diff" {
            Some(RootAsk::Diff(box_w("ask:diff", width, vec![pin])))
        } else {
            Some(RootAsk::Pin(pin))
        }
    }

    /// Root wait pin. A phase sentence replaces the worker status until it clears.
    /// Ask hides the pin. The sentence is not written into the snapshot status.
    fn wait_pin(&mut self, root: u32, width: i64) -> Option<Node> {
        if self.child_kind(root, Kind::Ask).is_some() {
            return None;
        }
        let wait = self.child_kind(root, Kind::Wait)?;
        if let Some(phase) = self.phase.clone() {
            let style = fg("foreground", FgP::SECONDARY);
            return Some(indication(
                "wait:phase",
                Gutter::Spinner {
                    profile: Some(SpinnerProfile::Thinking),
                    rows: Some(SpinnerRows::Top),
                },
                style.clone(),
                vec![text_node(
                    "wait:phase:label",
                    &phase,
                    WhiteSpace::Nowrap,
                    style,
                    Some(true),
                    Some(1),
                )],
            ));
        }
        self.layout_work(wait, width).ok()
    }

    fn child_kind(&self, parent: u32, kind: Kind) -> Option<u32> {
        self.arena
            .child_ids(parent)
            .into_iter()
            .find(|&id| self.arena.kind_of(id).ok() == Some(kind))
    }

    fn completion_ancestor(&self, id: u32) -> Option<u32> {
        let mut cur = self.arena.data(id).ok()?.parent;
        for _ in 0..4 {
            let id = cur?;
            if self.arena.kind_of(id).ok()? == Kind::Completion {
                return Some(id);
            }
            cur = self.arena.data(id).ok()?.parent;
        }
        None
    }
}

fn number_cursor(value: f64) -> i64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    let value = value.floor();
    if value >= i64::MAX as f64 {
        return i64::MAX;
    }
    value as i64
}

/// Put `prepared.root` on the present process. Clones the layout node only.
pub fn stage_scene(present: &mut Present, prepared: &Prepared) {
    present.set_scene(prepared.root.clone());
}

enum RootAsk {
    Diff(Node),
    Pin(Node),
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

struct ExpandCache {
    text: String,
    width: i64,
    ended: bool,
    polarity: SyntaxPolarity,
}

struct NodeData {
    /// Keys layout reads. `tail` is every other snapshot key, including `kind`.
    widget: Widget,
    tail: BTreeMap<String, Json>,
    parent: Option<u32>,
    children: Vec<u32>,
    dirty: bool,
    prepared: Option<Rc<Prepared>>,
    prepared_width: i64,
    expands: u32,
    expanded: Option<ExpandCache>,
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
                dirty: true,
                prepared: None,
                prepared_width: 0,
                expands: 0,
                expanded: None,
            },
        );
        let mut children = Vec::with_capacity(children_json.len());
        for child in children_json {
            match self.ingest(clock, child, Some(index)) {
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
    let mut parser = Parser {
        buf: bytes,
        index: 0,
    };
    parser.skip();
    if parser.eof() {
        return Err(parse_err("empty paint message"));
    }
    let value = parser.value()?;
    parser.skip();
    if !parser.eof() {
        return Err(parse_err("trailing paint message"));
    }
    Ok(value)
}

struct Parser<'a> {
    buf: &'a [u8],
    index: usize,
}

impl<'a> Parser<'a> {
    fn value(&mut self) -> Result<Json, PaintError> {
        let byte = self.peek().ok_or_else(|| parse_err("truncated json"))?;
        match byte {
            b'"' => Ok(Json::String(self.string()?)),
            b'{' => self.object(),
            b'[' => self.array(),
            b't' => self.keyword(b"true", Json::Bool(true)),
            b'f' => self.keyword(b"false", Json::Bool(false)),
            b'n' => self.keyword(b"null", Json::Null),
            b'-' | b'0'..=b'9' => Ok(Json::Number(self.number()?)),
            _ => Err(parse_err("json value")),
        }
    }

    fn object(&mut self) -> Result<Json, PaintError> {
        self.bump(b'{')?;
        let mut map = BTreeMap::new();
        self.skip();
        if self.peek() == Some(b'}') {
            self.index += 1;
            return Ok(Json::Object(map));
        }
        loop {
            self.skip();
            if self.peek() != Some(b'"') {
                return Err(parse_err("object key"));
            }
            let key = self.string()?;
            self.skip();
            self.bump(b':')?;
            self.skip();
            let value = self.value()?;
            map.insert(key, value);
            self.skip();
            match self.peek() {
                Some(b',') => self.index += 1,
                Some(b'}') => {
                    self.index += 1;
                    break;
                }
                _ => return Err(parse_err("object")),
            }
        }
        Ok(Json::Object(map))
    }

    fn array(&mut self) -> Result<Json, PaintError> {
        self.bump(b'[')?;
        let mut items = Vec::new();
        self.skip();
        if self.peek() == Some(b']') {
            self.index += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.skip();
            items.push(self.value()?);
            self.skip();
            match self.peek() {
                Some(b',') => self.index += 1,
                Some(b']') => {
                    self.index += 1;
                    break;
                }
                _ => return Err(parse_err("array")),
            }
        }
        Ok(Json::Array(items))
    }

    fn string(&mut self) -> Result<String, PaintError> {
        self.bump(b'"')?;
        let mut out = Vec::new();
        loop {
            let byte = self.next().ok_or_else(|| parse_err("truncated string"))?;
            match byte {
                b'"' => break,
                b'\\' => {
                    let escaped = self.next().ok_or_else(|| parse_err("truncated escape"))?;
                    match escaped {
                        b'"' | b'\\' | b'/' => out.push(escaped),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0c),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => self.push_unicode(&mut out)?,
                        _ => return Err(parse_err("bad escape")),
                    }
                }
                0x00..=0x1f => return Err(parse_err("control in string")),
                _ => out.push(byte),
            }
        }
        String::from_utf8(out).map_err(|_| parse_err("string utf-8"))
    }

    fn push_unicode(&mut self, out: &mut Vec<u8>) -> Result<(), PaintError> {
        let mut code = self.hex4()?;
        if (0xD800..=0xDBFF).contains(&code) {
            if self.next() != Some(b'\\') || self.next() != Some(b'u') {
                return Err(parse_err("lone surrogate"));
            }
            let low = self.hex4()?;
            if !(0xDC00..=0xDFFF).contains(&low) {
                return Err(parse_err("bad surrogate"));
            }
            code = 0x10000 + (((code - 0xD800) << 10) | (low - 0xDC00));
        } else if (0xDC00..=0xDFFF).contains(&code) {
            return Err(parse_err("lone surrogate"));
        }
        let ch = char::from_u32(code).ok_or_else(|| parse_err("bad unicode"))?;
        let mut buf = [0u8; 4];
        out.extend(ch.encode_utf8(&mut buf).as_bytes());
        Ok(())
    }

    fn hex4(&mut self) -> Result<u32, PaintError> {
        let mut code = 0u32;
        for _ in 0..4 {
            let byte = self.next().ok_or_else(|| parse_err("bad unicode"))?;
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(parse_err("bad unicode")),
            };
            code = (code << 4) | u32::from(digit);
        }
        Ok(code)
    }

    fn number(&mut self) -> Result<f64, PaintError> {
        let start = self.index;
        if self.peek() == Some(b'-') {
            self.index += 1;
        }
        if self.peek() == Some(b'0') {
            self.index += 1;
        } else if self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.index += 1;
            }
        } else {
            return Err(parse_err("number"));
        }
        if self.peek() == Some(b'.') {
            self.index += 1;
            if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                return Err(parse_err("number"));
            }
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.index += 1;
            }
        }
        if self.peek().is_some_and(|byte| byte == b'e' || byte == b'E') {
            self.index += 1;
            if self.peek().is_some_and(|byte| byte == b'+' || byte == b'-') {
                self.index += 1;
            }
            if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                return Err(parse_err("number"));
            }
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.index += 1;
            }
        }
        let token =
            std::str::from_utf8(&self.buf[start..self.index]).map_err(|_| parse_err("number"))?;
        token.parse::<f64>().map_err(|_| parse_err("number"))
    }

    fn keyword(&mut self, literal: &[u8], value: Json) -> Result<Json, PaintError> {
        if self.buf.get(self.index..self.index + literal.len()) != Some(literal) {
            return Err(parse_err("json literal"));
        }
        let after = self.index + literal.len();
        if self
            .buf
            .get(after)
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(parse_err("json literal"));
        }
        self.index = after;
        Ok(value)
    }

    fn skip(&mut self) {
        while self
            .peek()
            .is_some_and(|byte| byte == b' ' || byte == b'\n' || byte == b'\r' || byte == b'\t')
        {
            self.index += 1;
        }
    }

    fn bump(&mut self, expected: u8) -> Result<(), PaintError> {
        if self.next() != Some(expected) {
            return Err(parse_err("json"));
        }
        Ok(())
    }

    fn peek(&self) -> Option<u8> {
        self.buf.get(self.index).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.index += 1;
        Some(byte)
    }

    fn eof(&self) -> bool {
        self.index >= self.buf.len()
    }
}

fn string_field(tail: &BTreeMap<String, Json>, key: &str) -> String {
    match tail.get(key) {
        Some(Json::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn finite_number(value: Option<&Json>) -> Option<f64> {
    match value {
        Some(Json::Number(number)) if number.is_finite() => Some(*number),
        _ => None,
    }
}

fn object_string<'a>(map: &'a BTreeMap<String, Json>, key: &str) -> Option<&'a str> {
    match map.get(key) {
        Some(Json::String(text)) => Some(text.as_str()),
        _ => None,
    }
}

fn status_items_of(value: Option<&Json>) -> Vec<ChromeStatusItem> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        match item {
            Json::String(text) => {
                let text = text.trim();
                if !text.is_empty() {
                    out.push(ChromeStatusItem::furniture(text));
                }
            }
            Json::Object(map) => {
                let Some(text) = object_string(map, "text") else {
                    continue;
                };
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let role = object_string(map, "role")
                    .map(str::trim)
                    .filter(|role| !role.is_empty())
                    .map(str::to_string);
                out.push(ChromeStatusItem::Signal {
                    text: text.to_string(),
                    role,
                    prominence: finite_number(map.get("prominence")),
                });
            }
            _ => {}
        }
    }
    out
}

fn quota_windows_of(value: Option<&Json>) -> Vec<ChromeQuotaWindow> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Json::Object(map) = item else {
            continue;
        };
        let Some(remaining_percent) = finite_number(map.get("remainingPercent")) else {
            continue;
        };
        out.push(ChromeQuotaWindow {
            remaining_percent,
            reset_at: finite_number(map.get("resetAt")),
        });
    }
    out
}

/// `null` and a missing key are a closed catalog. An empty array paints
/// `commandAction` as one row, and paints nothing when that action is absent.
fn picker_of(tail: &BTreeMap<String, Json>) -> Option<crate::present::ComposerPicker> {
    let Some(Json::Array(items)) = tail.get("commandChoices") else {
        return None;
    };
    let mut rows = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if let Some(choice) = choice_of(item, index) {
            rows.push(choice);
        }
    }
    let fallback = rows.is_empty();
    if fallback {
        rows.push(fallback_choice(tail.get("commandAction"))?);
    }
    Some(crate::present::ComposerPicker {
        rows,
        fallback,
        selected_key: optional_string(tail.get("selectedCommandKey")),
        scroll_offset: finite_number(tail.get("scrollOffset"))
            .map(number_cursor)
            .unwrap_or(0),
    })
}

fn choice_of(value: &Json, index: usize) -> Option<crate::present::ComposerChoice> {
    let Json::Object(map) = value else {
        return None;
    };
    let name = object_string(map, "name")?.trim();
    if name.is_empty() {
        return None;
    }
    let key = optional_string(map.get("key")).unwrap_or_else(|| format!("choice:{index}:{name}"));
    Some(crate::present::ComposerChoice {
        key,
        name: name.to_string(),
        status: optional_string(map.get("status")).unwrap_or_default(),
        annotation: optional_string(map.get("annotation")).unwrap_or_default(),
        description: optional_string(map.get("description")).unwrap_or_default(),
        href: optional_string(map.get("href")).unwrap_or_default(),
        actions: action_hotkeys(map.get("actions")),
    })
}

fn fallback_choice(value: Option<&Json>) -> Option<crate::present::ComposerChoice> {
    let Json::Object(map) = value? else {
        return None;
    };
    let name = optional_string(map.get("name")).unwrap_or_default();
    let display = optional_string(map.get("displayName")).unwrap_or_default();
    let shown = if display.is_empty() {
        name.clone()
    } else {
        display
    };
    if shown.is_empty() {
        return None;
    }
    Some(crate::present::ComposerChoice {
        key: format!("choice:0:{shown}"),
        name: shown,
        status: String::new(),
        annotation: String::new(),
        description: name,
        href: optional_string(map.get("href")).unwrap_or_default(),
        actions: action_hotkeys(map.get("actions")),
    })
}

fn action_hotkeys(value: Option<&Json>) -> Vec<crate::layout_chrome::ChromeHotkey> {
    let Some(Json::Array(items)) = value else {
        return Vec::new();
    };
    let mut hotkeys = Vec::new();
    for item in items {
        let Json::Object(map) = item else {
            continue;
        };
        let Some(key) = optional_string(map.get("hotkey")) else {
            continue;
        };
        let label = optional_string(map.get("displayName"))
            .or_else(|| optional_string(map.get("name")))
            .unwrap_or_default();
        if label.is_empty() {
            continue;
        }
        hotkeys.push(crate::layout_chrome::ChromeHotkey::new(key, label));
    }
    hotkeys
}

fn optional_string(value: Option<&Json>) -> Option<String> {
    match value {
        Some(Json::String(text)) => {
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        _ => None,
    }
}

fn chrome_hotkeys_of(value: Option<&Json>) -> Vec<crate::layout_chrome::ChromeHotkey> {
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
        hotkeys.push(crate::layout_chrome::ChromeHotkey::new(key.clone(), action));
    }
    hotkeys
}

struct ChromeParts {
    draft: String,
    placeholder: String,
    annotation: String,
    cursor: Option<i64>,
    mark: Option<i64>,
    interactive: bool,
    read_only: bool,
    plain_bottom: bool,
    selected: bool,
}

fn chrome_box(key: &str, width: i64, parts: &ChromeParts) -> Node {
    let outer = width.max(8);
    let mut frame = ChromeFrame::new(outer, parts.draft.clone());
    frame.interactive = Some(parts.interactive);
    frame.read_only = parts.read_only;
    frame.plain_bottom = parts.plain_bottom;
    frame.selected = parts.selected;
    frame.cursor = parts.cursor;
    frame.mark = parts.mark;
    if !parts.placeholder.is_empty() {
        frame.placeholder = Some(parts.placeholder.clone());
    }
    if !parts.annotation.is_empty() {
        frame.annotation = Some(parts.annotation.clone());
    }
    let geom = measure_chrome_frame(&frame, outer, UNBOUNDED_H);
    let paint = chrome_frame_paint_ops(&frame, ChromeRect::new(0, 0, geom.outer_w, geom.total_h));
    let shown = if parts.draft.is_empty() {
        parts.placeholder.clone()
    } else {
        parts.draft.clone()
    };
    let body = text_node(
        format!("{key}:draft"),
        &shown,
        WhiteSpace::PreWrap,
        fg("foreground", FgP::PRIMARY),
        None,
        None,
    );
    box_wh(key, paint.geom.outer_w, paint.geom.total_h, vec![body])
}

fn stamp_rail(key: &str, content_w: i64, text_w: i64, at_ms: Option<f64>, body: Node) -> Node {
    let stamp = text_node(
        format!("{key}:stamp-text"),
        &stamp_face(at_ms),
        WhiteSpace::Nowrap,
        fg("foreground", FgP::GHOST),
        None,
        None,
    );
    let cols = Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Row,
            gap: SPEECH_STAMP_GAP,
            align_items: AlignItems::FlexStart,
            ..FlexStyle::default()
        },
        children: vec![
            box_w(format!("{key}:body"), text_w, vec![body]),
            Node::Box {
                style: BoxStyle {
                    width: Some(Length::Cells(SPEECH_STAMP_CELLS)),
                    height: Some(Length::Cells(1)),
                    ..BoxStyle::default()
                },
                children: vec![stamp],
                key: Some(format!("{key}:stamp")),
                id: None,
                measured: None,
                region_prominence: None,
            },
        ],
        key: Some(format!("{key}:cols")),
        measured: None,
        region_prominence: None,
    };
    box_w(format!("{key}:rail"), content_w, vec![cols])
}

/// JS `dimOutsideRecap`. Off-tip the tape fades. Only the active recap stays bright.
const REWIND_CONTENT_PROMINENCE: f64 = 0.45;

fn is_pin_recap(node: &Node) -> bool {
    match node {
        Node::Chrome { key: Some(key), .. } => key.ends_with(":recap"),
        _ => false,
    }
}

fn contains_pin_recap(node: &Node) -> bool {
    if is_pin_recap(node) {
        return true;
    }
    match node {
        Node::Disclosure {
            summary, children, ..
        } => contains_pin_recap(summary) || children.iter().any(contains_pin_recap),
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => children.iter().any(contains_pin_recap),
        _ => false,
    }
}

fn dim_outside_recap(node: &mut Node) {
    if is_pin_recap(node) {
        return;
    }
    if !contains_pin_recap(node) {
        if let Some(slot) = region_slot(node) {
            *slot = Some(REWIND_CONTENT_PROMINENCE);
        }
        return;
    }
    match node {
        Node::Disclosure {
            summary, children, ..
        } => {
            dim_outside_recap(summary);
            for child in children.iter_mut() {
                dim_outside_recap(child);
            }
        }
        Node::Box { children, .. }
        | Node::Flex { children, .. }
        | Node::Grid { children, .. }
        | Node::Indication { children, .. }
        | Node::Overlay { children, .. }
        | Node::Squeeze { children, .. }
        | Node::Viewport { children, .. }
        | Node::IndentationException { children, .. } => {
            for child in children.iter_mut() {
                dim_outside_recap(child);
            }
        }
        _ => {}
    }
}

fn region_slot(node: &mut Node) -> Option<&mut Option<f64>> {
    match node {
        Node::Text {
            region_prominence, ..
        }
        | Node::Box {
            region_prominence, ..
        }
        | Node::Flex {
            region_prominence, ..
        }
        | Node::Grid {
            region_prominence, ..
        }
        | Node::Indication {
            region_prominence, ..
        }
        | Node::Overlay {
            region_prominence, ..
        }
        | Node::Disclosure {
            region_prominence, ..
        }
        | Node::Squeeze {
            region_prominence, ..
        }
        | Node::Viewport {
            region_prominence, ..
        }
        | Node::IndentationException {
            region_prominence, ..
        } => Some(region_prominence),
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => None,
    }
}

fn user_block(key: &str, rail: Node) -> Node {
    let chevron = text_node(
        format!("{key}:chevron"),
        "❯",
        WhiteSpace::Nowrap,
        fg_bold("foreground", FgP::PRIMARY),
        None,
        None,
    );
    let row = Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Row,
            gap: USER_MARK_GAP,
            align_items: AlignItems::FlexStart,
            ..FlexStyle::default()
        },
        children: vec![chevron, rail],
        key: Some(format!("{key}:user-line")),
        measured: None,
        region_prominence: None,
    };
    Node::Box {
        style: BoxStyle {
            padding: Some(Padding::Uniform(USER_BLOCK_PAD)),
            background: Some(Style {
                bg_role: Some("surface".to_string()),
                bg_prominence: Some(BgP::MIST),
                ..Style::default()
            }),
            ..BoxStyle::default()
        },
        children: vec![row],
        key: Some(format!("{key}:speech-user")),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn stamped_text(
    key: &str,
    content: &str,
    width: i64,
    white_space: WhiteSpace,
    style: Style,
) -> Node {
    let at_w = width.max(1);
    let measured = measure_text_node(
        &TextNode {
            content,
            white_space: Some(white_space),
            ellipsis: None,
            line_clamp: None,
            measured: None,
        },
        at_w,
        UNBOUNDED_H,
        None,
    );
    let mut node = text_node(key, content, white_space, style, None, None);
    set_measured(
        &mut node,
        MeasuredStamp {
            w: measured.w,
            h: measured.h,
            at_w,
        },
    );
    node
}

fn text_node(
    key: impl Into<String>,
    content: &str,
    white_space: WhiteSpace,
    style: Style,
    ellipsis: Option<bool>,
    line_clamp: Option<i64>,
) -> Node {
    Node::Text {
        content: content.to_string(),
        white_space: Some(white_space),
        ellipsis,
        line_clamp,
        measured: None,
        style,
        key: Some(key.into()),
        live: None,
        region_prominence: None,
    }
}

fn indication(key: impl Into<String>, gutter: Gutter, style: Style, children: Vec<Node>) -> Node {
    Node::Indication {
        gutter,
        children,
        style,
        key: Some(key.into()),
        measured: None,
        region_prominence: None,
    }
}

/// Title in the free rows above the docked composer. The prompt itself
/// stays the present overlay: this column only fills the blank tape.
fn home_column(width: i64) -> Node {
    let column = Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Column,
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
            width: Some(Length::Cells(width.max(0))),
            ..FlexStyle::default()
        },
        children: vec![
            text_node(
                "home:title",
                "Inhuman",
                WhiteSpace::Nowrap,
                fg("accent", FgP::SECONDARY),
                Some(true),
                Some(1),
            ),
            text_node(
                "home:tip",
                "/ for commands",
                WhiteSpace::Nowrap,
                fg("muted", FgP::GHOST),
                Some(true),
                Some(1),
            ),
            // The docked composer covers the bottom of this block and is not
            // a child of it. Two blank rows, about that chrome, put the title
            // in the rows the operator can see.
            text_node("home:lift", "", WhiteSpace::Nowrap, Style::default(), None, None),
            text_node("home:lift-2", "", WhiteSpace::Nowrap, Style::default(), None, None),
        ],
        key: Some("home:column".into()),
        measured: None,
        region_prominence: None,
    };
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Column,
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
            width: Some(Length::Cells(width.max(0))),
            height: Some(Length::Pct(100.0)),
            ..FlexStyle::default()
        },
        children: vec![column],
        key: Some("home".into()),
        measured: None,
        region_prominence: None,
    }
}

fn column(key: impl Into<String>, width: i64, children: Vec<Node>) -> Node {
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Column,
            width: Some(Length::Cells(width.max(0))),
            ..FlexStyle::default()
        },
        children,
        key: Some(key.into()),
        measured: None,
        region_prominence: None,
    }
}

fn box_w(key: impl Into<String>, width: i64, children: Vec<Node>) -> Node {
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width.max(0))),
            ..BoxStyle::default()
        },
        children,
        key: Some(key.into()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn box_wh(key: impl Into<String>, width: i64, height: i64, children: Vec<Node>) -> Node {
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width.max(0))),
            height: Some(Length::Cells(height.max(0))),
            ..BoxStyle::default()
        },
        children,
        key: Some(key.into()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn empty_box(key: impl Into<String>) -> Node {
    Node::Box {
        style: BoxStyle::default(),
        children: Vec::new(),
        key: Some(key.into()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

/// Branch on the left, path on the right. The git root stays secondary; the
/// path inside it is ghost. The checkout clause is rising: the third step,
/// quieter than the branch. A missing root paints `cwd` as one span.
fn statusline_row(id: u32, width: i64, left: &str, note: &str, cwd: &str, cwd_root: &str) -> Node {
    let inner = (width - STATUSLINE_PAD_L - STATUSLINE_PAD_R).max(0);
    let (root, rest) = cwd_spans(cwd, cwd_root);
    let full = char_len(&root) + char_len(&rest);
    let cwd_budget = full.min(if cwd.is_empty() { 0 } else { 8.max(inner / 2) });
    let (root, rest) = elide_cwd_parts(&root, &rest, cwd_budget);
    let cwd_width = char_len(&root) + char_len(&rest);
    let gap = if (!left.is_empty() || !note.is_empty()) && cwd_width > 0 {
        1
    } else {
        0
    };
    let (branch, clause) = fit_clause(left, note, (inner - cwd_width - gap).max(0));
    let mut children = Vec::new();
    let mut clause_children = Vec::new();
    if !branch.is_empty() {
        clause_children.push(text_node(
            format!("statusline:{id}:left:text"),
            &branch,
            WhiteSpace::Nowrap,
            fg("foreground", FgP::SECONDARY),
            Some(true),
            Some(1),
        ));
    }
    if !clause.is_empty() {
        clause_children.push(text_node(
            format!("statusline:{id}:note"),
            &clause,
            WhiteSpace::Nowrap,
            fg("foreground", FgP::RISING),
            Some(true),
            Some(1),
        ));
    }
    let mut left_children = Vec::new();
    if !clause_children.is_empty() {
        left_children.push(Node::Flex {
            style: FlexStyle {
                direction: FlexDirection::Row,
                gap: 1,
                ..FlexStyle::default()
            },
            children: clause_children,
            key: Some(format!("statusline:{id}:clause")),
            measured: None,
            region_prominence: None,
        });
    }
    children.push(Node::Box {
        style: BoxStyle {
            flex: Some(FlexFactor::Sugar(1.0)),
            ..BoxStyle::default()
        },
        children: left_children,
        key: Some(format!("statusline:{id}:left")),
        id: None,
        measured: None,
        region_prominence: None,
    });
    let mut path = Vec::new();
    if !root.is_empty() {
        path.push(text_node(
            format!("statusline:{id}:cwd"),
            &root,
            WhiteSpace::Nowrap,
            fg("foreground", FgP::SECONDARY),
            None,
            None,
        ));
    }
    if !rest.is_empty() {
        path.push(text_node(
            format!("statusline:{id}:cwd:rest"),
            &rest,
            WhiteSpace::Nowrap,
            fg("foreground", FgP::GHOST),
            None,
            None,
        ));
    }
    if !path.is_empty() {
        children.push(Node::Flex {
            style: FlexStyle {
                direction: FlexDirection::Row,
                ..FlexStyle::default()
            },
            children: path,
            key: Some(format!("statusline:{id}:path")),
            measured: None,
            region_prominence: None,
        });
    }
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Row,
            gap: 1,
            padding: Some(Padding::Edges {
                t: Some(0),
                r: Some(STATUSLINE_PAD_R),
                b: Some(0),
                l: Some(STATUSLINE_PAD_L),
            }),
            width: Some(Length::Cells(width.max(0))),
            ..FlexStyle::default()
        },
        children,
        key: Some(format!("statusline:{id}")),
        measured: None,
        region_prominence: None,
    }
}

fn cwd_spans(cwd: &str, cwd_root: &str) -> (String, String) {
    if !cwd_root.is_empty() && cwd == cwd_root {
        return (cwd_root.to_string(), String::new());
    }
    if let Some(rest) = cwd.strip_prefix(cwd_root) {
        if !cwd_root.is_empty() && rest.starts_with('/') {
            return (cwd_root.to_string(), rest.to_string());
        }
    }
    (cwd.to_string(), String::new())
}

fn elide_cwd_parts(root: &str, rest: &str, budget: i64) -> (String, String) {
    let total = format!("{root}{rest}");
    if char_len(&total) <= budget {
        return (root.to_string(), rest.to_string());
    }
    if char_len(rest) + 1 >= budget {
        return (String::new(), elide_path_left(&total, budget));
    }
    (
        elide_path_left(root, budget - char_len(rest)),
        rest.to_string(),
    )
}

/// Branch keeps the budget. The clause keeps its head.
fn fit_clause(branch: &str, note: &str, budget: i64) -> (String, String) {
    let branch_len = char_len(branch);
    let note_len = char_len(note);
    let gap = if branch_len > 0 && note_len > 0 { 1 } else { 0 };
    if branch_len + gap + note_len <= budget {
        return (branch.to_string(), note.to_string());
    }
    if branch_len >= budget {
        return (elide_path_left(branch, budget), String::new());
    }
    let note_budget = budget - branch_len - gap;
    if note_budget <= 0 {
        return (branch.to_string(), String::new());
    }
    (branch.to_string(), elide_head(note, note_budget))
}

/// Keep the head of a clause. `…` is one cell.
fn elide_head(text: &str, width: i64) -> String {
    let width = width.max(0) as usize;
    if width == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= width {
        return text.to_string();
    }
    if width == 1 {
        return "…".to_string();
    }
    let head: String = text.chars().take(width - 1).collect();
    format!("{head}…")
}

/// Keep the tail of a path. `…` is one cell.
fn elide_path_left(path: &str, width: i64) -> String {
    let width = width.max(0) as usize;
    if width == 0 {
        return String::new();
    }
    let count = path.chars().count();
    if count <= width {
        return path.to_string();
    }
    if width == 1 {
        return "…".to_string();
    }
    let tail: String = path.chars().skip(count - (width - 1)).collect();
    format!("…{tail}")
}

fn char_len(text: &str) -> i64 {
    i64::try_from(text.chars().count()).unwrap_or(i64::MAX)
}

fn thinking_header(
    key: &str,
    slot: &str,
    text: &str,
    content_w: i64,
    live: bool,
    style: Style,
) -> Node {
    indication(
        format!("{key}:{slot}"),
        Gutter::Top {
            glyph: "⁖".to_string(),
        },
        if live {
            fg("foreground", FgP::RISING)
        } else {
            fg("foreground", FgP::GHOST)
        },
        vec![stamped_text(
            &format!("{key}:{slot}-text"),
            text,
            content_w,
            WhiteSpace::Normal,
            style,
        )],
    )
}

fn gap_row(key: &str, width: i64) -> Node {
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width.max(0))),
            height: Some(Length::Cells(1)),
            ..BoxStyle::default()
        },
        children: Vec::new(),
        key: Some(key.to_string()),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn set_measured(node: &mut Node, stamp: MeasuredStamp) {
    match node {
        Node::Text { measured, .. }
        | Node::Box { measured, .. }
        | Node::Flex { measured, .. }
        | Node::Grid { measured, .. }
        | Node::Indication { measured, .. }
        | Node::Overlay { measured, .. }
        | Node::Disclosure { measured, .. }
        | Node::Squeeze { measured, .. }
        | Node::Viewport { measured, .. }
        | Node::IndentationException { measured, .. } => *measured = Some(stamp),
        Node::Markdown { .. } | Node::Diff { .. } | Node::Chrome { .. } | Node::Skipped => {}
    }
}

fn fg(role_name: &str, prominence: f64) -> Style {
    Style {
        role: Some(role_name.to_string()),
        prominence: Some(prominence),
        ..Style::default()
    }
}

fn fg_bold(role_name: &str, prominence: f64) -> Style {
    Style {
        bold: true,
        ..fg(role_name, prominence)
    }
}

struct WorkFace {
    name: String,
    object: String,
    status: String,
    state: String,
    caption: String,
    pretty_block: String,
    receipt_kind: String,
    receipt: String,
    diff_path: String,
    diff_old: String,
    diff_new: String,
    indent: bool,
    split: bool,
    agent: bool,
    pretty: bool,
    line_start: i64,
    tool_call_id: String,
}

fn tape_work(id: u32, face: &WorkFace, width: i64) -> Node {
    let alloc_w = if face.indent {
        width.saturating_sub(2).max(8)
    } else {
        width.max(8)
    };
    let text_w = alloc_w.saturating_sub(INDICATION_CONTENT_INSET).max(8);
    // A mention opens the sneak-peek. The arena id would only toggle the fold.
    let key = if face.agent && !face.tool_call_id.is_empty() {
        format!("mention:{}", face.tool_call_id)
    } else {
        format!("work:{id}")
    };
    let identity = work_identity(&key, face, text_w, false);
    let node = if face.name == "read_file" {
        box_w(key, alloc_w, vec![identity])
    } else if is_mutate(&face.name) {
        // A disclosure would hide the change behind a click.
        mutate_block(&key, face, alloc_w, text_w, identity)
    } else {
        tool_disclosure(&key, face, text_w, identity)
    };
    if face.indent {
        pad_left(format!("work:{id}:indent"), width, node)
    } else {
        node
    }
}

fn mutate_block(key: &str, face: &WorkFace, alloc_w: i64, text_w: i64, identity: Node) -> Node {
    let mut body = Vec::new();
    if face.receipt_kind != "diff" && !face.pretty_block.is_empty() {
        body.push(ghost_markdown(
            &format!("{key}:pretty-md"),
            &face.pretty_block,
            text_w,
        ));
    }
    if let Some(diff) = work_diff(key, face, alloc_w, 0) {
        body.push(diff);
    }
    let mut children = vec![identity];
    if !body.is_empty() {
        children.push(gap_row(&format!("{key}:body-gap"), alloc_w));
        children.extend(body);
    }
    box_w(format!("{key}:mutate"), alloc_w, children)
}

fn tool_disclosure(key: &str, face: &WorkFace, text_w: i64, identity: Node) -> Node {
    let open = work_identity(&format!("{key}:open"), face, text_w, true);
    let mut extra = Vec::new();
    if !face.caption.is_empty() && (face.name == "shell" || is_scheme(&face.name)) {
        extra.push(script_node(
            &format!("{key}:script"),
            &face.name,
            &face.object,
            text_w,
            face.name == "shell",
            &work_voice(&face.state),
        ));
    }
    if face.name == "shell" && !face.caption.is_empty() && !face.status.is_empty() {
        extra.push(clamped_text(
            &format!("{key}:cwd"),
            &face.status,
            &work_meta(),
            false,
        ));
    }
    if face.receipt_kind != "diff" && !face.pretty_block.is_empty() {
        extra.push(ghost_markdown(
            &format!("{key}:pretty-md"),
            &face.pretty_block,
            text_w,
        ));
    }
    push_receipt(&mut extra, key, face, text_w);
    let mut children = vec![open];
    if !extra.is_empty() {
        let bar = if face.state == "fail" {
            fg("error", FgP::GHOST)
        } else {
            fg("foreground", FgP::GHOST)
        };
        children.push(indication(
            format!("{key}:bar"),
            Gutter::Rule {
                glyph: "┃".to_string(),
            },
            bar,
            extra,
        ));
    }
    Node::Disclosure {
        collapsed: face.state != "live",
        summary: Box::new(identity),
        children,
        key: Some(key.to_string()),
        measured: None,
        region_prominence: None,
    }
}

fn ask_pin(id: u32, face: &WorkFace, width: i64) -> Node {
    let key = format!("work:{id}");
    let text_w = width.saturating_sub(INDICATION_CONTENT_INSET).max(8);
    let mut children = Vec::new();
    if !rim_named(face) {
        children.push(indication(
            format!("{key}:id"),
            Gutter::Top {
                glyph: " ".to_string(),
            },
            work_voice(&face.state),
            vec![identity_body(&key, face, text_w, false)],
        ));
    }
    if face.receipt_kind == "diff" {
        if let Some(diff) = work_diff(&key, face, width, 4) {
            children.push(diff);
        }
    } else if face.receipt_kind != "none" && !face.receipt.is_empty() {
        if face.receipt_kind == "markdown" {
            children.push(ghost_markdown(&format!("{key}:md"), &face.receipt, text_w));
        } else {
            children.push(clamped_text(
                &format!("{key}:receipt"),
                &face.receipt,
                &work_meta(),
                true,
            ));
        }
    }
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width.max(0))),
            padding: Some(Padding::Edges {
                t: Some(1),
                r: Some(0),
                b: Some(0),
                l: Some(0),
            }),
            ..BoxStyle::default()
        },
        children,
        key: Some(key),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn push_receipt(kids: &mut Vec<Node>, key: &str, face: &WorkFace, text_w: i64) {
    if face.receipt_kind == "none" {
        return;
    }
    if face.receipt_kind == "diff" {
        if let Some(diff) = work_diff(key, face, text_w, 0) {
            kids.push(diff);
        }
        return;
    }
    if face.receipt.is_empty() {
        return;
    }
    if face.name == "shell" && face.receipt_kind == "text" {
        kids.push(shell_box(key, &face.receipt, text_w));
        return;
    }
    // The answer only. A shell inside the program is its own cell and already has this box.
    if is_scheme(&face.name) {
        kids.push(scheme_answer(key, face, text_w));
        return;
    }
    if face.receipt_kind == "markdown" {
        kids.push(ghost_markdown(&format!("{key}:md"), &face.receipt, text_w));
        return;
    }
    kids.push(clamped_text(
        &format!("{key}:receipt"),
        &face.receipt,
        &work_meta(),
        true,
    ));
}

fn work_diff(key: &str, face: &WorkFace, width: i64, sticky: i64) -> Option<Node> {
    if face.receipt_kind != "diff" || (face.diff_old.is_empty() && face.diff_new.is_empty()) {
        return None;
    }
    let diff_key = format!("{key}:diff");
    let mut opts = DiffExpand::new(&face.diff_old, &face.diff_new, width);
    opts.path = &face.diff_path;
    opts.key = &diff_key;
    opts.language = syntax::lang_for_path(&face.diff_path);
    opts.hide_header = true;
    opts.sticky_bottom = sticky;
    if face.line_start > 1 {
        opts.line_start = face.line_start;
    }
    Some(expand_diff(&opts))
}

fn shell_box(key: &str, text: &str, width: i64) -> Node {
    bordered_box(
        key,
        width,
        clamped_text(&format!("{key}:out"), text, &work_meta(), true),
    )
}

fn scheme_answer(key: &str, face: &WorkFace, width: i64) -> Node {
    let child = if face.receipt_kind == "markdown" {
        ghost_markdown(
            &format!("{key}:md"),
            &face.receipt,
            width.saturating_sub(2).max(1),
        )
    } else if face.receipt_kind == "parts" {
        scheme_parts(&format!("{key}:out"), &face.receipt, width)
    } else if scheme_code_kind(&face.receipt_kind) {
        scheme_code(&format!("{key}:out"), &face.receipt, width)
    } else {
        clamped_text(&format!("{key}:out"), &face.receipt, &work_meta(), true)
    };
    bordered_box(key, width, child)
}

fn scheme_code_kind(kind: &str) -> bool {
    matches!(kind, "syntax" | "number" | "boolean")
}

fn scheme_parts(key: &str, raw: &str, width: i64) -> Node {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return clamped_text(key, raw, &work_meta(), true);
    };
    let Some(parts) = value.as_array() else {
        return clamped_text(key, raw, &work_meta(), true);
    };
    let mut kids = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let text = part
            .get("text")
            .and_then(|item| item.as_str())
            .unwrap_or("");
        if text.is_empty() {
            continue;
        }
        let kind = part
            .get("kind")
            .and_then(|item| item.as_str())
            .unwrap_or("text");
        kids.push(scheme_part_node(
            &format!("{key}:{index}"),
            kind,
            text,
            width,
        ));
    }
    if kids.is_empty() {
        return clamped_text(key, raw, &work_meta(), true);
    }
    if kids.len() == 1 {
        return kids.remove(0);
    }
    column(format!("{key}:parts"), width, kids)
}

fn scheme_part_node(key: &str, kind: &str, text: &str, width: i64) -> Node {
    if kind == "markdown" {
        return ghost_markdown(&format!("{key}:md"), text, width.saturating_sub(2).max(1));
    }
    if scheme_code_kind(kind) {
        return scheme_code(key, text, width);
    }
    clamped_text(key, text, &work_meta(), true)
}

fn scheme_code(key: &str, source: &str, width: i64) -> Node {
    let voice = work_meta();
    // The border takes the two edge cells. A token row is nowrap, so a line
    // wider than the inside clips. `wrap_text` keeps the break space on the
    // first piece, and the slices below concatenate back to that line.
    let inner = width.saturating_sub(2).max(1);
    let painted = syntax::highlight_scheme(source);
    let mut rows = Vec::new();
    for (index, runs) in painted.iter().enumerate() {
        let joined: String = runs.iter().map(|run| run.text.as_str()).collect();
        let mut opts = WrapOpts::new(inner);
        opts.white_space = WhiteSpace::PreWrap;
        let lines = wrap_text(&joined, &opts);
        let base = if painted.len() == 1 {
            key.to_string()
        } else {
            format!("{key}:{index}")
        };
        let mut offset = 0usize;
        for (row, line) in lines.iter().enumerate() {
            let end = offset + line.len();
            let slice = slice_runs(runs, offset, end);
            let row_key = if lines.len() == 1 {
                base.clone()
            } else {
                format!("{base}:{row}")
            };
            let fallback = if line.is_empty() { " " } else { line.as_str() };
            rows.push(run_line(&row_key, fallback, &slice, &voice, false));
            offset = end;
        }
    }
    match rows.len() {
        0 => run_line(key, source, &[], &voice, true),
        1 => rows.remove(0),
        _ => column(format!("{key}:lines"), inner, rows),
    }
}

fn slice_runs(runs: &[syntax::TokenRun], start: usize, end: usize) -> Vec<syntax::TokenRun> {
    if end <= start {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for run in runs {
        let run_end = cursor + run.text.len();
        if run_end <= start {
            cursor = run_end;
            continue;
        }
        if cursor >= end {
            break;
        }
        let from = floor_char(&run.text, start.saturating_sub(cursor));
        let to = floor_char(&run.text, end.saturating_sub(cursor).min(run.text.len()));
        if to > from {
            let mut piece = run.clone();
            piece.text = run.text[from..to].to_string();
            out.push(piece);
        }
        cursor = run_end;
    }
    out
}

fn floor_char(text: &str, mut index: usize) -> usize {
    if index > text.len() {
        return text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn bordered_box(key: &str, width: i64, child: Node) -> Node {
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width.max(0))),
            border: true,
            ..BoxStyle::default()
        },
        children: vec![child],
        key: Some(format!("{key}:out-box")),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn work_identity(key: &str, face: &WorkFace, text_w: i64, wrap_script: bool) -> Node {
    let voice = work_voice(&face.state);
    let gutter_style = if face.state == "fail" {
        fg("error", FgP::PRIMARY)
    } else {
        voice
    };
    indication(
        format!("{key}:id"),
        work_gutter(&face.state, &face.name),
        gutter_style,
        vec![identity_body(key, face, text_w, wrap_script)],
    )
}

fn identity_body(key: &str, face: &WorkFace, text_w: i64, wrap_script: bool) -> Node {
    let voice = work_voice(&face.state);
    let failed = face.state == "fail";
    if face.agent {
        return agent_line(key, face, text_w, &voice, failed);
    }
    if is_scheme(&face.name) || face.name == "shell" {
        return command_line(key, face, text_w, wrap_script, &voice, failed);
    }
    if face.pretty {
        return pretty_line(key, face, text_w, &voice);
    }
    if is_mutate(&face.name) {
        return mutate_line(key, face, text_w, failed);
    }
    if face.split {
        return split_line(key, face, text_w, &voice, failed);
    }
    let line = format_identity(
        &face.name,
        &face.object,
        &face.status,
        text_w,
        is_path_shaped(&face.name),
    );
    clamped_text(&format!("{key}:text"), &line, &voice, failed)
}

fn agent_line(key: &str, face: &WorkFace, text_w: i64, voice: &Style, failed: bool) -> Node {
    if face.object.is_empty() {
        return clamped_text(&format!("{key}:name"), &face.name, voice, failed);
    }
    if failed {
        return clamped_text(
            &format!("{key}:text"),
            &format!("{} {}", face.name, face.object),
            voice,
            true,
        );
    }
    flex_row(
        &format!("{key}:id-line"),
        Some(text_w),
        0,
        JustifyContent::FlexStart,
        vec![
            clamped_text(
                &format!("{key}:name"),
                &format!("{} ", face.name),
                voice,
                false,
            ),
            clamped_text(&format!("{key}:title"), &face.object, &work_meta(), false),
        ],
    )
}

fn command_line(
    key: &str,
    face: &WorkFace,
    text_w: i64,
    wrap_script: bool,
    voice: &Style,
    failed: bool,
) -> Node {
    let body = if face.caption.is_empty() {
        script_node(
            &format!("{key}:cmd"),
            &face.name,
            &face.object,
            text_w,
            wrap_script || failed,
            voice,
        )
    } else {
        clamped_text(&format!("{key}:caption"), &face.caption, voice, failed)
    };
    let show_cwd = face.name == "shell"
        && !face.status.is_empty()
        && !(wrap_script && !face.caption.is_empty());
    if !show_cwd {
        return body;
    }
    column(
        format!("{key}:id-stack"),
        text_w,
        vec![
            body,
            clamped_text(&format!("{key}:status"), &face.status, &work_meta(), false),
        ],
    )
}

fn pretty_line(key: &str, face: &WorkFace, text_w: i64, voice: &Style) -> Node {
    let headline = if face.status.is_empty() {
        face.object.clone()
    } else {
        format!("{}  {}", face.object, face.status)
    };
    let line_key = format!("{key}:text");
    let mut opts = MarkdownExpand::new(&headline);
    opts.key = &line_key;
    opts.width = Some(text_w);
    opts.style = Some(voice);
    let line = expand_markdown_with(&opts);
    if face.caption.is_empty() {
        return line;
    }
    column(
        format!("{key}:id-stack"),
        text_w,
        vec![
            line,
            clamped_text(
                &format!("{key}:subtitle"),
                &face.caption,
                &work_meta(),
                true,
            ),
        ],
    )
}

fn mutate_line(key: &str, face: &WorkFace, text_w: i64, failed: bool) -> Node {
    let verb = mutate_verb(face);
    // The ladder has no tertiary step. Rising is the one under secondary.
    let verb_node = clamped_text(
        &format!("{key}:verb"),
        verb,
        &fg("foreground", FgP::RISING),
        false,
    );
    let path_voice = fg("foreground", FgP::SECONDARY);
    let path_budget = (text_w - char_len(verb) - 1).max(4);
    if face.caption.is_empty() {
        let path = clamped_text(
            &format!("{key}:text"),
            &format_mutate(&face.object, &face.status, path_budget),
            &path_voice,
            failed,
        );
        return flex_row(
            &format!("{key}:id-line"),
            Some(text_w),
            1,
            JustifyContent::FlexStart,
            vec![verb_node, path],
        );
    }
    let path_bare = if face.status.is_empty() {
        face.object.clone()
    } else {
        format!("{}  {}", face.object, face.status)
    };
    let left = char_len(verb) + 1 + char_len(&path_bare);
    let fits = !failed && left + 2 + char_len(&face.caption) <= text_w;
    let path_text = if fits {
        path_bare
    } else {
        format_mutate(&face.object, &face.status, path_budget)
    };
    let path = clamped_text(
        &format!("{key}:path"),
        &path_text,
        &path_voice,
        failed && !fits,
    );
    let caption = clamped_text(
        &format!("{key}:caption"),
        &face.caption,
        &work_meta(),
        !fits,
    );
    let lead = flex_row(
        &format!("{key}:lead"),
        None,
        1,
        JustifyContent::FlexStart,
        vec![verb_node, path],
    );
    if fits {
        return flex_row(
            &format!("{key}:id-line"),
            Some(text_w),
            2,
            JustifyContent::SpaceBetween,
            vec![lead, caption],
        );
    }
    column(format!("{key}:id-line"), text_w, vec![lead, caption])
}

/// A write with an empty old side is a new file. An edit, or a write that
/// already had content, is an update.
fn mutate_verb(face: &WorkFace) -> &'static str {
    if face.name == "edit_file" || !face.diff_old.is_empty() {
        "updated"
    } else {
        "created"
    }
}

fn split_line(key: &str, face: &WorkFace, text_w: i64, voice: &Style, failed: bool) -> Node {
    if failed {
        let line = if face.status.is_empty() {
            format!("{} {}", face.name, face.object)
        } else {
            format!("{} {}  {}", face.name, face.object, face.status)
        };
        return clamped_text(&format!("{key}:text"), &line, voice, true);
    }
    let mut children = vec![
        clamped_text(
            &format!("{key}:server"),
            &format!("{} ", face.name),
            &work_meta(),
            false,
        ),
        clamped_text(&format!("{key}:action"), &face.object, voice, false),
    ];
    if !face.status.is_empty() {
        children.push(clamped_text(
            &format!("{key}:status"),
            &format!("  {}", face.status),
            &work_meta(),
            false,
        ));
    }
    flex_row(
        &format!("{key}:id-line"),
        Some(text_w),
        0,
        JustifyContent::FlexStart,
        children,
    )
}

fn script_node(
    key: &str,
    name: &str,
    source: &str,
    text_w: i64,
    wrap: bool,
    voice: &Style,
) -> Node {
    let lang = if name == "shell" { "bash" } else { "scheme" };
    let painted = syntax::highlight(source, lang);
    if !source.contains('\n') {
        let runs = painted.first().map(Vec::as_slice).unwrap_or(&[]);
        return run_line(key, source, runs, voice, wrap);
    }
    let mut kids = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let runs = painted.get(index).map(Vec::as_slice).unwrap_or(&[]);
        kids.push(run_line(&format!("{key}:{index}"), line, runs, voice, true));
    }
    if kids.is_empty() {
        return run_line(key, source, &[], voice, true);
    }
    column(key, text_w, kids)
}

fn run_line(
    key: &str,
    fallback: &str,
    runs: &[syntax::TokenRun],
    voice: &Style,
    wrap: bool,
) -> Node {
    let kept: Vec<&syntax::TokenRun> = runs.iter().filter(|run| !run.text.is_empty()).collect();
    if kept.len() <= 1 {
        let mut style = voice.clone();
        let text = if let Some(run) = kept.first() {
            syntax::apply_run(&mut style, run);
            run.text.clone()
        } else {
            fallback.to_string()
        };
        return clamped_text(key, &text, &style, wrap);
    }
    let children = kept
        .iter()
        .enumerate()
        .map(|(index, run)| {
            let mut style = voice.clone();
            syntax::apply_run(&mut style, run);
            text_node(
                format!("{key}:{index}"),
                &run.text,
                WhiteSpace::Nowrap,
                style,
                None,
                None,
            )
        })
        .collect();
    flex_row(key, None, 0, JustifyContent::FlexStart, children)
}

fn clamped_text(key: &str, content: &str, style: &Style, wrap: bool) -> Node {
    text_node(
        key,
        content,
        if wrap {
            WhiteSpace::PreWrap
        } else {
            WhiteSpace::Nowrap
        },
        style.clone(),
        if wrap { None } else { Some(true) },
        if wrap { None } else { Some(1) },
    )
}

fn ghost_markdown(key: &str, text: &str, width: i64) -> Node {
    let meta = work_meta();
    let mut opts = MarkdownExpand::new(text);
    opts.key = key;
    opts.width = Some(width);
    opts.style = Some(&meta);
    expand_markdown_with(&opts)
}

fn flex_row(
    key: &str,
    width: Option<i64>,
    gap: i64,
    justify: JustifyContent,
    children: Vec<Node>,
) -> Node {
    Node::Flex {
        style: FlexStyle {
            direction: FlexDirection::Row,
            gap,
            justify_content: justify,
            align_items: AlignItems::FlexStart,
            width: width.map(Length::Cells),
            ..FlexStyle::default()
        },
        children,
        key: Some(key.to_string()),
        measured: None,
        region_prominence: None,
    }
}

fn pad_left(key: String, width: i64, child: Node) -> Node {
    Node::Box {
        style: BoxStyle {
            width: Some(Length::Cells(width.max(0))),
            padding: Some(Padding::Edges {
                t: Some(0),
                r: Some(0),
                b: Some(0),
                l: Some(2),
            }),
            ..BoxStyle::default()
        },
        children: vec![child],
        key: Some(key),
        id: None,
        measured: None,
        region_prominence: None,
    }
}

fn work_gutter(state: &str, name: &str) -> Gutter {
    if state == "ask" || state == "judging" {
        return Gutter::Top {
            glyph: "?".to_string(),
        };
    }
    if state == "live" {
        return Gutter::Spinner {
            profile: Some(SpinnerProfile::Tool),
            rows: Some(SpinnerRows::Top),
        };
    }
    Gutter::Top {
        glyph: sealed_glyph(name).to_string(),
    }
}

fn sealed_glyph(name: &str) -> &'static str {
    if name == "shell" {
        "$"
    } else if name == "scheme_repl" {
        "⒪"
    } else if name == "scheme_watch" {
        "⒲"
    } else {
        "·"
    }
}

fn work_voice(state: &str) -> Style {
    if state == "ask" {
        fg("foreground", FgP::PRIMARY)
    } else {
        fg("foreground", FgP::RISING)
    }
}

fn work_meta() -> Style {
    fg("foreground", FgP::GHOST)
}

fn rim_named(face: &WorkFace) -> bool {
    face.split
        || face.agent
        || matches!(
            face.name.as_str(),
            "edit_file" | "write_file" | "read_file" | "list_dir" | "grep" | "glob" | "fff_search"
        )
}

fn is_scheme(name: &str) -> bool {
    name == "scheme_repl" || name == "scheme_watch"
}

fn is_mutate(name: &str) -> bool {
    name == "edit_file" || name == "write_file"
}

fn is_path_shaped(name: &str) -> bool {
    matches!(name, "read_file" | "list_dir" | "write_file" | "edit_file")
}

fn format_identity(
    name: &str,
    object: &str,
    status: &str,
    width: i64,
    path_shaped: bool,
) -> String {
    let gap = format!("{name}  ");
    let suffix = if status.is_empty() {
        String::new()
    } else {
        format!("  {status}")
    };
    let budget = (width - char_len(&gap) - char_len(&suffix)).max(4);
    let object = if path_shaped {
        elide_path_left(object, budget)
    } else {
        object.to_string()
    };
    format!("{gap}{object}{suffix}")
}

fn format_mutate(object: &str, status: &str, width: i64) -> String {
    let suffix = if status.is_empty() {
        String::new()
    } else {
        format!("  {status}")
    };
    let budget = (width - char_len(&suffix)).max(4);
    format!("{}{suffix}", elide_path_left(object, budget))
}

fn identity_line(name: &str, object: &str, status: &str) -> String {
    if status.is_empty() {
        format!("{name}  {object}")
    } else {
        format!("{name}  {object}  {status}")
    }
}

fn stamp_face(at_ms: Option<f64>) -> String {
    let face = match at_ms {
        Some(ms) if ms.is_finite() => format_clock_utc(ms),
        _ => String::new(),
    };
    let width = SPEECH_STAMP_CELLS as usize;
    if face.chars().count() >= width {
        face
    } else {
        format!("{face:>width$}")
    }
}

/// UTC `H:MM AM/PM`. The runtime has no timezone crate; local wall time stays
/// in TypeScript. `null` atMs still paints an empty 8-cell rail.
fn format_clock_utc(ms: f64) -> String {
    if !ms.is_finite() {
        return String::new();
    }
    let secs_f = (ms / 1000.0).floor();
    if secs_f < i64::MIN as f64 || secs_f > i64::MAX as f64 {
        return String::new();
    }
    let day = (secs_f as i64).rem_euclid(86_400);
    let minutes = (day / 60) % 60;
    let mut hour = (day / 3600) % 24;
    let suffix = if hour >= 12 { "PM" } else { "AM" };
    hour %= 12;
    if hour == 0 {
        hour = 12;
    }
    format!("{hour}:{minutes:02} {suffix}")
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
