//! Unified Ratatui Tea application shell (`RatatuiApp`) combining reactive daemon state,
//! declarative `UiDefinition` slash-command & callback evaluation, keyboard dispatch,
//! and full-screen Ratatui widget composition.

use std::collections::BTreeMap;
use serde_json::{Map, Value};

use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::widgets::{StatefulWidget, Widget};

use crate::bridge::{qd_to_ratatui_buffer, ratatui_to_qd_buffer};
use crate::composer_command::{match_composer_command, ComposerCommand};
use crate::state::session::SessionDocumentState;
use crate::state::shapes::{KernelRow, LiveShape, PendingAskRow, SessionSummaryRow};
use crate::state::sync::{RpcRequest, RpcResponse};
use crate::state::ui::{
    eval_ui_surface, fill_params, has_input_hole, parse_ui_form, ui_choice, ui_notice, url_from,
    CommandUiSpec, KernelUiSnapshot, SessionUiSnapshot, UiChoiceInput, UiEvalConfig, UiForm,
    UiHealth, UiNode,
};
use crate::widgets::agents_meter::AgentsMeterWidget;
use crate::widgets::composer::{
    AskPromptState, CallbackOverlayState, ComposerState, ComposerWidget,
};
use crate::widgets::drawer::{DrawerItem, DrawerKind, DrawerState, DrawerWidget};
use crate::widgets::tape::{TapeState, TapeWidget};
use crate::widgets::toast::ToastWidget;

/// Default JSON command bodies matching `packages/harness/src/server/defaults/commands/*.scm`
/// and `plugins/*/tools/inhuman/commands/*.scm`.
pub const DEFAULT_CONNECT_JSON: &str = r#"{"kind":"choice","context":"connect"}"#;
pub const DEFAULT_MODEL_JSON: &str = r#"{"kind":"choice","context":"model","action":[{"kind":"action","op":"kv/set","name":"Set model","params":{"key":"model","value":"","remember":"1"}}]}"#;
pub const DEFAULT_MCP_JSON: &str = r#"{"kind":"choice","context":"mcp","action":[{"kind":"action","op":"mcp-server/adopt","name":"Add MCP","params":{"input":""}}],"alternateActions":[{"kind":"action","op":"mcp-server/adopt","name":"Add MCP","hotkey":"control-n","params":{"input":""}}],"choices":[{"kind":"choice","name":"Add MCP","description":"Paste an https:// URL or a stdio command","action":[{"kind":"action","op":"mcp-server/adopt","name":"Add MCP"}]}]}"#;
pub const DEFAULT_COMPACT_JSON: &str =
    r#"{"kind":"choice","action":[{"kind":"action","op":"compact","params":{"focus":""}}]}"#;
pub const DEFAULT_GOAL_JSON: &str = r#"{"kind":"choice","context":"goal","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"inhuman-plugin-goal","method":"start","input":""}}],"choices":[{"kind":"choice","name":"start","description":"Set a goal for the session","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"inhuman-plugin-goal","method":"start","input":""}}]},{"kind":"choice","name":"status","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"inhuman-plugin-goal","method":"get"}}]},{"kind":"choice","name":"stop","description":"Cancel the active goal","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"inhuman-plugin-goal","method":"stop"}}]}]}"#;
pub const DEFAULT_PLAN_JSON: &str = r#"{"kind":"choice","context":"plan","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"fusion","method":"start","input":""}}],"choices":[{"kind":"choice","name":"start","description":"Draft and track a step-by-step plan","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"fusion","method":"start","input":""}}]},{"kind":"choice","name":"status","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"fusion","method":"get"}}]},{"kind":"choice","name":"done","description":"Advance to the next step","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"fusion","method":"done"}}]},{"kind":"choice","name":"stop","description":"Clear the active plan","action":[{"kind":"action","op":"plugin/method","params":{"plugin":"fusion","method":"stop"}}]}]}"#;

#[derive(Debug, Clone, PartialEq)]
pub struct ParkedCallback {
    pub pending: String,
    pub surface: UiNode,
    pub oauth_waiting: bool,
    pub processing: bool,
    pub saved_draft: String,
    pub saved_cursor: usize,
}

/// Full native Ratatui Tea application shell.
pub struct RatatuiApp {
    pub cwd: String,
    pub session_doc: SessionDocumentState,
    pub active_sessions: LiveShape<String, SessionSummaryRow>,
    pub pending_asks: LiveShape<String, PendingAskRow>,
    pub kernel_meta: LiveShape<String, KernelRow>,
    pub kernel_ui: KernelUiSnapshot,
    pub session_ui: SessionUiSnapshot,
    pub plugin_replies: BTreeMap<String, Value>,
    pub tape_state: TapeState,
    pub composer_state: ComposerState,
    pub drawer_open: Option<DrawerKind>,
    pub drawer_state: DrawerState,
    pub toast: Option<ToastWidget>,
    pub focus_node: Option<UiNode>,
    pub callback: Option<ParkedCallback>,
    pub outbound_rpc: Vec<RpcRequest>,
    pub opened_urls: Vec<String>,
    next_rpc_id: u64,
}

impl RatatuiApp {
    pub fn new(session_id: impl Into<String>, cwd: impl Into<String>) -> Self {
        let sid = session_id.into();
        let mut kernel_ui = KernelUiSnapshot::default();
        for spec in Self::default_commands() {
            kernel_ui.commands.insert(spec.verb.clone(), spec);
        }
        let session_ui = SessionUiSnapshot {
            session_id: sid.clone(),
            ..Default::default()
        };

        Self {
            cwd: cwd.into(),
            session_doc: SessionDocumentState::new(sid),
            active_sessions: LiveShape::new("active_sessions", "sub-sessions"),
            pending_asks: LiveShape::new("pending_asks", "sub-asks"),
            kernel_meta: LiveShape::new("kernel_meta", "sub-kernel"),
            kernel_ui,
            session_ui,
            plugin_replies: BTreeMap::new(),
            tape_state: TapeState::new(),
            composer_state: ComposerState::new(),
            drawer_open: None,
            drawer_state: DrawerState::new(),
            toast: None,
            focus_node: None,
            callback: None,
            outbound_rpc: Vec::new(),
            opened_urls: Vec::new(),
            next_rpc_id: 1,
        }
    }

    pub fn default_commands() -> Vec<CommandUiSpec> {
        vec![
            CommandUiSpec {
                verb: "connect".to_string(),
                description: "Connect or switch model providers".to_string(),
                aliases: Vec::new(),
                body: DEFAULT_CONNECT_JSON.to_string(),
            },
            CommandUiSpec {
                verb: "model".to_string(),
                description: "Select the active model".to_string(),
                aliases: vec!["m".to_string()],
                body: DEFAULT_MODEL_JSON.to_string(),
            },
            CommandUiSpec {
                verb: "mcp".to_string(),
                description: "Manage MCP tool servers".to_string(),
                aliases: Vec::new(),
                body: DEFAULT_MCP_JSON.to_string(),
            },
            CommandUiSpec {
                verb: "compact".to_string(),
                description: "Compact conversation context".to_string(),
                aliases: Vec::new(),
                body: DEFAULT_COMPACT_JSON.to_string(),
            },
            CommandUiSpec {
                verb: "goal".to_string(),
                description: "Manage autonomous session goals".to_string(),
                aliases: Vec::new(),
                body: DEFAULT_GOAL_JSON.to_string(),
            },
            CommandUiSpec {
                verb: "plan".to_string(),
                description: "Draft and track step-by-step plans".to_string(),
                aliases: Vec::new(),
                body: DEFAULT_PLAN_JSON.to_string(),
            },
        ]
    }

    pub fn catalog_commands(&self) -> Vec<ComposerCommand> {
        self.kernel_ui
            .commands
            .values()
            .filter(|spec| !spec.verb.is_empty())
            .map(|spec| ComposerCommand {
                name: spec.verb.clone(),
                description: if spec.description.is_empty() {
                    None
                } else {
                    Some(spec.description.clone())
                },
                aliases: spec.aliases.clone(),
            })
            .collect()
    }

    pub fn slash_verb(&self) -> Option<String> {
        let first = self.composer_state.text.lines().next().unwrap_or("").trim();
        let token = first.split_whitespace().next().unwrap_or("");
        let verb = token.strip_prefix('/')?;
        if verb.is_empty() {
            None
        } else {
            Some(verb.to_string())
        }
    }

    pub fn remainder(&self) -> String {
        let first = self.composer_state.text.lines().next().unwrap_or("").trim();
        if self.callback.is_some() {
            return first.to_string();
        }
        let Some(verb) = self.slash_verb() else {
            return first.to_string();
        };
        if first.len() <= verb.len() + 1 {
            String::new()
        } else {
            first[verb.len() + 1..].trim().to_string()
        }
    }

    pub fn in_command(&self) -> bool {
        let Some(verb) = self.slash_verb() else {
            return false;
        };
        self.kernel_ui.commands.contains_key(&verb)
    }

    pub fn at_catalog(&self) -> bool {
        if self.callback.is_some() || self.focus_node.is_some() || self.in_command() {
            return false;
        }
        self.composer_state
            .text
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .starts_with('/')
    }

    pub fn current_surface(&self) -> Option<UiNode> {
        if let Some(cb) = &self.callback {
            return Some(cb.surface.clone());
        }
        if let Some(focus) = &self.focus_node {
            return Some(focus.clone());
        }
        let verb = self.slash_verb()?;
        let spec = self.kernel_ui.commands.get(&verb)?;
        if spec.body.is_empty() {
            return None;
        }
        let config = UiEvalConfig {
            kernel: Some(&self.kernel_ui),
            session: Some(&self.session_ui),
            pending: None,
            plugin_replies: Some(&self.plugin_replies),
        };
        eval_ui_surface(&spec.body, &config)
    }

    pub fn picker_rows(&self) -> Vec<UiNode> {
        if let Some(focus) = &self.focus_node {
            return focus
                .choices
                .iter()
                .filter(|c| !c.name.is_empty())
                .cloned()
                .collect();
        }
        if let Some(parent) = self.current_surface() {
            let needle = self.remainder().to_lowercase();
            let named: Vec<UiNode> = parent
                .choices
                .into_iter()
                .filter(|c| !c.name.is_empty())
                .collect();
            let exact = named.iter().any(|c| c.name.to_lowercase() == needle);
            return named
                .into_iter()
                .filter(|c| {
                    if needle.is_empty() || exact {
                        return true;
                    }
                    let hay = format!(
                        "{} {} {} {} {}",
                        c.name,
                        c.annotation,
                        c.description,
                        c.health_annotation,
                        c.aliases.join(" ")
                    )
                    .to_lowercase();
                    hay.contains(&needle)
                })
                .collect();
        }
        if self.at_catalog() {
            let cmds = self.catalog_commands();
            let matched = match_composer_command(&self.composer_state.text, &cmds);
            return matched
                .matches
                .into_iter()
                .map(|cmd| {
                    ui_choice(UiChoiceInput {
                        name: format!("/{}", cmd.name.trim_start_matches('/')),
                        description: cmd.description.clone().unwrap_or_default(),
                        alias: cmd.aliases.clone(),
                        health_status: UiHealth::Ok,
                        ..Default::default()
                    })
                })
                .collect();
        }
        Vec::new()
    }

    pub fn sync_composer_ui(&mut self) {
        if let Some(cb) = &self.callback {
            self.composer_state.callback_overlay = Some(CallbackOverlayState {
                pending: cb.pending.clone(),
                surface: cb.surface.clone(),
                oauth_waiting: cb.oauth_waiting,
                processing: cb.processing,
            });
            self.composer_state.ui_choices = cb
                .surface
                .choices
                .iter()
                .filter(|c| !c.name.is_empty())
                .cloned()
                .collect();
            self.composer_state.command_picker_open = !self.composer_state.ui_choices.is_empty();
            return;
        }

        self.composer_state.callback_overlay = None;

        // Sync pending ask cover if any ask is waiting
        if let Some(ask_row) = self.pending_asks.values().next() {
            if self.composer_state.ask_approval_cover.is_none() {
                self.composer_state.ask_approval_cover =
                    Some(AskPromptState::new(ask_row.summary.clone()));
            }
        } else {
            self.composer_state.ask_approval_cover = None;
        }

        let rows = self.picker_rows();
        self.composer_state.command_picker_open = !rows.is_empty();
        if self.composer_state.selected_command_index >= rows.len() {
            self.composer_state.selected_command_index = 0;
        }
        self.composer_state.ui_choices = rows;
    }

    pub fn set_draft(&mut self, text: impl Into<String>) {
        let prev_verb = self.slash_verb();
        self.composer_state.set_text(text);
        if self.slash_verb() != prev_verb {
            self.focus_node = None;
            self.composer_state.selected_command_index = 0;
        }
        self.sync_composer_ui();
    }

    pub fn park_ui_form(&mut self, form: UiForm) -> bool {
        let config = UiEvalConfig {
            kernel: Some(&self.kernel_ui),
            session: Some(&self.session_ui),
            pending: Some(&form.pending),
            plugin_replies: Some(&self.plugin_replies),
        };
        let Some(surface) = eval_ui_surface(&form.body, &config) else {
            return false;
        };
        self.park_surface(form.pending, surface);
        true
    }

    pub fn park_surface(&mut self, pending: impl Into<String>, surface: UiNode) {
        let pending_str = pending.into();
        let saved_draft = self
            .callback
            .as_ref()
            .map(|cb| cb.saved_draft.clone())
            .unwrap_or_else(|| self.composer_state.text.clone());
        let saved_cursor = self
            .callback
            .as_ref()
            .map(|cb| cb.saved_cursor)
            .unwrap_or(self.composer_state.cursor);

        // If `open-url` has no input hole, open the URL immediately upon parking
        if let Some(url) = url_from(&surface) {
            if !has_input_hole(&surface) {
                self.opened_urls.push(url);
            }
        }

        self.focus_node = None;
        self.composer_state.clear();
        self.callback = Some(ParkedCallback {
            pending: pending_str,
            surface,
            oauth_waiting: false,
            processing: false,
            saved_draft,
            saved_cursor,
        });
        self.sync_composer_ui();
    }

    pub fn show_notice(&mut self, message: impl Into<String>) {
        let msg = message.into();
        let surface = ui_notice("", Some(&msg), None, None);
        self.park_surface("", surface);
    }

    pub fn handle_rpc_response(&mut self, response: &RpcResponse) {
        if let Some(result) = &response.result {
            if let Some(form) = parse_ui_form(result) {
                self.park_ui_form(form);
                return;
            }
            // If `connect/adopt` returned `{ id: "..." }`, bind session connection and jump to `/model`
            if let Some(id) = result
                .as_object()
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                self.session_ui
                    .kvs
                    .insert("connection".to_string(), id.to_string());
                self.push_rpc(
                    "kv/set",
                    serde_json::json!({ "key": "connection", "value": id }),
                );
                self.callback = None;
                self.set_draft("/model");
                return;
            }
        }
        // If we were waiting for an OAuth callback to settle, clear the callback
        if self.callback.as_ref().map(|c| c.oauth_waiting) == Some(true) {
            self.finish_callback();
        }
    }

    pub fn take_outbound_rpc(&mut self) -> Vec<RpcRequest> {
        std::mem::take(&mut self.outbound_rpc)
    }

    fn push_rpc(&mut self, method: impl Into<String>, params: Value) {
        let id = self.next_rpc_id;
        self.next_rpc_id += 1;
        self.outbound_rpc.push(RpcRequest::new(id, method, params));
    }

    fn finish_callback(&mut self) {
        if let Some(cb) = self.callback.take() {
            self.composer_state.set_text(cb.saved_draft);
            self.composer_state.cursor = cb.saved_cursor;
        }
        self.sync_composer_ui();
    }

    fn fire_leaves(&mut self, leaves: &[UiNode], dismiss: bool) {
        if leaves.is_empty() {
            return;
        }
        let rem = self.remainder();

        if self.callback.is_some() {
            let leaf = leaves
                .iter()
                .find(|l| l.op.as_deref() == Some("ui/resolve"))
                .or_else(|| leaves.first())
                .cloned();
            if let Some(leaf) = leaf {
                if leaf.op.as_deref() == Some("ui/resolve") {
                    let mut filled = fill_params(leaf.params.clone(), &rem);
                    let surface_url = self
                        .callback
                        .as_ref()
                        .and_then(|cb| url_from(&cb.surface));
                    let is_empty_text = filled.get("kind").and_then(Value::as_str) == Some("text")
                        && filled
                            .get("input")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .is_empty();

                    if let Some(url) = surface_url {
                        if is_empty_text {
                            self.opened_urls.push(url.clone());
                            filled.insert(
                                "kind".to_string(),
                                Value::String("opened".to_string()),
                            );
                            filled.insert("url".to_string(), Value::String(url));
                            filled.remove("input");
                        }
                    }

                    let is_opened = filled.get("kind").and_then(Value::as_str) == Some("opened");
                    let pending_non_empty = filled
                        .get("pending")
                        .and_then(Value::as_str)
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);

                    if pending_non_empty {
                        let obj: Map<String, Value> = filled.into_iter().collect();
                        self.push_rpc("ui/resolve", Value::Object(obj));
                    }

                    if is_opened {
                        if let Some(cb) = &mut self.callback {
                            cb.oauth_waiting = true;
                        }
                        self.sync_composer_ui();
                    } else {
                        self.finish_callback();
                    }
                    return;
                }
            }
        }

        for leaf in leaves {
            let Some(op) = &leaf.op else {
                continue;
            };
            let filled = fill_params(leaf.params.clone(), &rem);
            if op == "kv/set" {
                if let (Some(k), Some(v)) = (
                    filled.get("key").and_then(Value::as_str),
                    filled.get("value").and_then(Value::as_str),
                ) {
                    self.session_ui.kvs.insert(k.to_string(), v.to_string());
                }
            } else if op == "kv/clear" {
                if let Some(k) = filled.get("key").and_then(Value::as_str) {
                    self.session_ui.kvs.remove(k);
                }
            }
            let obj: Map<String, Value> = filled.into_iter().collect();
            self.push_rpc(op.clone(), Value::Object(obj));
        }

        if dismiss {
            self.focus_node = None;
            self.composer_state.clear();
        }
        self.sync_composer_ui();
    }

    fn complete_name(&mut self, node: &UiNode) {
        if self.at_catalog() {
            let verb = node.name.trim_start_matches('/');
            self.composer_state.set_text(format!("/{verb} "));
            return;
        }
        if let Some(verb) = self.slash_verb() {
            self.composer_state
                .set_text(format!("/{verb} {}", node.name));
        }
    }

    fn pick_node(&mut self, node: UiNode, invoke: bool) {
        if self.at_catalog() || !node.choices.is_empty() {
            if !self.at_catalog() {
                self.focus_node = Some(node.clone());
            }
            self.complete_name(&node);
            self.composer_state.selected_command_index = 0;
            self.sync_composer_ui();
            return;
        }
        self.complete_name(&node);
        if invoke && !node.action.is_empty() {
            self.fire_leaves(&node.action, true);
        } else {
            self.sync_composer_ui();
        }
    }

    pub fn handle_key(&mut self, key: &str, ctrl: bool, alt: bool, shift: bool) {
        self.sync_composer_ui();
        let chord = ctrl || alt;

        // 1. Check alternate action hotkeys (e.g. `control-x`, `control-n`)
        if chord {
            let normalized = if ctrl {
                format!("control-{}", key.to_lowercase())
            } else {
                format!("alt-{}", key.to_lowercase())
            };
            let selected = self
                .composer_state
                .ui_choices
                .get(self.composer_state.selected_command_index)
                .cloned();
            let alt_leaf = selected
                .as_ref()
                .and_then(|s| {
                    s.alternate_actions
                        .iter()
                        .find(|a| a.hotkey.as_deref() == Some(normalized.as_str()))
                        .cloned()
                })
                .or_else(|| {
                    self.current_surface().and_then(|surf| {
                        surf.alternate_actions
                            .iter()
                            .find(|a| a.hotkey.as_deref() == Some(normalized.as_str()))
                            .cloned()
                    })
                });
            if let Some(leaf) = alt_leaf {
                self.fire_leaves(&[leaf], false);
                return;
            }
        }

        // 2. Ask approval cover shortcuts
        if self.composer_state.ask_approval_cover.is_some() && self.callback.is_none() {
            let first_ask = self.pending_asks.values().next().cloned();
            if let Some(ask_row) = first_ask {
                match key {
                    "y" | "Y" | "Enter" => {
                        self.push_rpc(
                            "ask/answer",
                            serde_json::json!({
                                "sessionId": ask_row.session_id,
                                "jobId": ask_row.job_id,
                                "allow": true,
                            }),
                        );
                        self.pending_asks.items.remove(&ask_row.job_id);
                        self.sync_composer_ui();
                        return;
                    }
                    "n" | "N" | "Escape" => {
                        self.push_rpc(
                            "ask/answer",
                            serde_json::json!({
                                "sessionId": ask_row.session_id,
                                "jobId": ask_row.job_id,
                                "allow": false,
                            }),
                        );
                        self.pending_asks.items.remove(&ask_row.job_id);
                        self.sync_composer_ui();
                        return;
                    }
                    _ => {}
                }
            }
        }

        // 3. Escape handling
        if key == "Escape" && !chord {
            if let Some(cb) = &self.callback {
                if cb.oauth_waiting {
                    let pending = cb.pending.clone();
                    if !pending.is_empty() {
                        self.push_rpc(
                            "ui/resolve",
                            serde_json::json!({ "pending": pending, "kind": "cancel" }),
                        );
                    }
                    self.finish_callback();
                    return;
                }
                let cancel_leaves = cb.surface.alternate_actions.clone();
                if !cancel_leaves.is_empty() {
                    self.fire_leaves(&cancel_leaves, true);
                } else {
                    self.finish_callback();
                }
                return;
            }
            if self.focus_node.is_some() {
                self.focus_node = None;
                self.composer_state.selected_command_index = 0;
                self.sync_composer_ui();
                return;
            }
            if self.drawer_open.is_some() {
                self.drawer_open = None;
                return;
            }
            if !self.composer_state.text.is_empty() {
                self.composer_state.clear();
                self.sync_composer_ui();
            }
            return;
        }

        // 4. Enter handling
        if key == "Enter" && !chord && !shift {
            if let Some(cb) = &self.callback {
                if cb.oauth_waiting || cb.processing {
                    return;
                }
                if let Some(selected) = self
                    .composer_state
                    .ui_choices
                    .get(self.composer_state.selected_command_index)
                    .cloned()
                {
                    self.pick_node(selected, true);
                    return;
                }
                let actions = cb.surface.action.clone();
                self.fire_leaves(&actions, true);
                return;
            }

            if let Some(selected) = self
                .composer_state
                .ui_choices
                .get(self.composer_state.selected_command_index)
                .cloned()
            {
                self.pick_node(selected, true);
                return;
            }

            if let Some(surface) = self.current_surface() {
                if !surface.action.is_empty() {
                    self.fire_leaves(&surface.action, true);
                    return;
                }
            }

            let prompt = self.composer_state.text.trim().to_string();
            if !prompt.is_empty() {
                self.push_rpc("turn", serde_json::json!({ "prompt": prompt }));
                self.composer_state.clear();
                self.sync_composer_ui();
            }
            return;
        }

        // 5. Navigation & autocomplete keys (`ArrowUp`, `ArrowDown`, `Tab`, `ArrowLeft`, `ArrowRight`, `Backspace`)
        if !chord && !shift {
            match key {
                "ArrowUp" => {
                    let len = self.composer_state.ui_choices.len();
                    if len > 0 {
                        self.composer_state.selected_command_index =
                            (self.composer_state.selected_command_index + len - 1) % len;
                    }
                    return;
                }
                "ArrowDown" => {
                    let len = self.composer_state.ui_choices.len();
                    if len > 0 {
                        self.composer_state.selected_command_index =
                            (self.composer_state.selected_command_index + 1) % len;
                    }
                    return;
                }
                "Tab" => {
                    if let Some(selected) = self
                        .composer_state
                        .ui_choices
                        .get(self.composer_state.selected_command_index)
                        .cloned()
                    {
                        self.pick_node(selected, false);
                    }
                    return;
                }
                "ArrowLeft" => {
                    self.composer_state.move_left();
                    return;
                }
                "ArrowRight" => {
                    self.composer_state.move_right();
                    return;
                }
                "Backspace" => {
                    let prev_verb = self.slash_verb();
                    self.composer_state.delete_backwards();
                    if self.slash_verb() != prev_verb {
                        self.focus_node = None;
                        self.composer_state.selected_command_index = 0;
                    }
                    self.sync_composer_ui();
                    return;
                }
                _ => {}
            }
        }

        // 6. Printable character insertion
        if !chord && key.chars().count() == 1 {
            if let Some(ch) = key.chars().next() {
                let prev_verb = self.slash_verb();
                self.composer_state.insert_char(ch);
                if self.slash_verb() != prev_verb {
                    self.focus_node = None;
                    self.composer_state.selected_command_index = 0;
                }
                self.sync_composer_ui();
            }
        }
    }

    pub fn type_text(&mut self, text: &str) {
        for ch in text.chars() {
            let mut buf = [0u8; 4];
            let s = ch.encode_utf8(&mut buf);
            self.handle_key(s, false, false, false);
        }
    }

    /// Render the complete application layout into a Ratatui `Buffer`.
    pub fn render(&mut self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        self.sync_composer_ui();

        let subagents = self.session_doc.project_to_subagents();
        let has_subagents = !subagents.is_empty();
        let composer_height: u16 = if self.composer_state.callback_overlay.is_some() {
            6
        } else if self.composer_state.ask_approval_cover.is_some() {
            4
        } else {
            3
        };

        let mut constraints = vec![Constraint::Length(1)];
        if has_subagents {
            constraints.push(Constraint::Length(1));
        }
        constraints.push(Constraint::Min(3));
        constraints.push(Constraint::Length(composer_height));

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints(constraints)
            .split(area);

        // 1. Statusline
        let active_model = self
            .session_ui
            .kvs
            .get("model")
            .map(String::as_str)
            .unwrap_or("unconfigured");
        let statusline = self
            .session_doc
            .project_to_statusline(&self.cwd, active_model);
        statusline.render(chunks[0], buf);

        // 2. Optional AgentsMeter + Tape + Composer
        let (tape_area, composer_area) = if has_subagents {
            AgentsMeterWidget::new(subagents).render(chunks[1], buf);
            (chunks[2], chunks[3])
        } else {
            (chunks[1], chunks[2])
        };

        let turns = self.session_doc.project_to_tape_turns();
        TapeWidget::new(turns).render(tape_area, buf, &mut self.tape_state);

        let commands = self.catalog_commands();
        ComposerWidget::new().commands(commands).render(
            composer_area,
            buf,
            &mut self.composer_state,
        );

        // 3. Optional Drawer overlay
        if let Some(kind) = self.drawer_open {
            let items: Vec<DrawerItem> = self
                .active_sessions
                .values()
                .map(|row| {
                    DrawerItem::new(
                        &row.session_id,
                        if row.title.is_empty() {
                            &row.session_id
                        } else {
                            &row.title
                        },
                    )
                    .active(row.session_id == self.session_doc.session_id)
                })
                .collect();
            DrawerWidget::new(kind, items).render(area, buf, &mut self.drawer_state);
        }

        // 4. Optional Toast overlay
        if let Some(toast) = &self.toast {
            toast.clone().render(area, buf);
        }
    }

    /// Render the complete application layout directly into a Quickdraw `Buffer`.
    pub fn render_to_qd(&mut self, qd_buf: &mut crate::Buffer) {
        let mut r_buf = qd_to_ratatui_buffer(qd_buf);
        let area = r_buf.area;
        self.render(area, &mut r_buf);
        *qd_buf = ratatui_to_qd_buffer(&r_buf);
    }
}
