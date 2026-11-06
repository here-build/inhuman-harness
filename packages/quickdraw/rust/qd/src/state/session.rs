//! Session document replica and ModelPatchOp engine applying `@inhuman.tools/model` patches in Rust.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

use crate::widgets::agents_meter::SubagentStatus;
use crate::widgets::statusline::StatuslineWidget;
use crate::widgets::tape::{TapeRole, TapeTurnItem};
use ratatui::text::Line;

/// Operation matching `@inhuman.tools/model` patch specification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum ModelPatchOp {
    Set {
        #[serde(rename = "nodeId")]
        node_id: String,
        field: String,
        value: serde_json::Value,
        #[serde(default)]
        key: Option<String>,
    },
    #[serde(alias = "del")]
    Delete {
        #[serde(rename = "nodeId")]
        node_id: String,
        field: String,
        key: String,
    },
    Splice {
        #[serde(rename = "nodeId")]
        node_id: String,
        field: String,
        index: usize,
        #[serde(rename = "deleteCount", default)]
        delete_count: usize,
        #[serde(default)]
        items: Vec<serde_json::Value>,
    },
    MapSet {
        #[serde(rename = "nodeId")]
        node_id: String,
        field: String,
        key: String,
        value: serde_json::Value,
    },
    MapDelete {
        #[serde(rename = "nodeId")]
        node_id: String,
        field: String,
        key: String,
    },
}

/// Generic entity node in the replicated session tree (e.g. SessionTurn, SystemToolJob).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EntityNode {
    pub uuid: String,
    pub tag: String,
    #[serde(default)]
    pub properties: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub children: Vec<String>,
    #[serde(default)]
    pub records: HashMap<String, HashMap<String, serde_json::Value>>,
}

impl EntityNode {
    pub fn new(uuid: impl Into<String>, tag: impl Into<String>) -> Self {
        Self {
            uuid: uuid.into(),
            tag: tag.into(),
            properties: HashMap::new(),
            children: Vec::new(),
            records: HashMap::new(),
        }
    }
}

/// Document replica tracking turns, tool jobs, thoughts, and subagent sessions.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SessionDocumentState {
    pub session_id: String,
    pub revision: u64,
    pub root_id: Option<String>,
    pub entities: HashMap<String, EntityNode>,
}

impl SessionDocumentState {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            revision: 0,
            root_id: None,
            entities: HashMap::new(),
        }
    }

    pub fn insert_entity(&mut self, entity: EntityNode) {
        if self.root_id.is_none() {
            self.root_id = Some(entity.uuid.clone());
        }
        self.entities.insert(entity.uuid.clone(), entity);
    }

    pub fn get_entity(&self, id: &str) -> Option<&EntityNode> {
        self.entities.get(id)
    }

    pub fn get_entity_mut(&mut self, id: &str) -> Option<&mut EntityNode> {
        self.entities.get_mut(id)
    }

    /// Apply an incoming ModelPatchOp onto the document replica.
    pub fn apply_patch(&mut self, patch: &ModelPatchOp) {
        match patch {
            ModelPatchOp::Set {
                node_id,
                field,
                value,
                key,
            } => {
                let entity = self
                    .entities
                    .entry(node_id.clone())
                    .or_insert_with(|| EntityNode::new(node_id.clone(), "unknown"));

                if let Some(k) = key {
                    entity
                        .records
                        .entry(field.clone())
                        .or_default()
                        .insert(k.clone(), value.clone());
                } else {
                    entity.properties.insert(field.clone(), value.clone());
                }
            }
            ModelPatchOp::Delete {
                node_id,
                field,
                key,
            } => {
                if let Some(entity) = self.entities.get_mut(node_id) {
                    if let Some(map) = entity.records.get_mut(field) {
                        map.remove(key);
                    }
                }
            }
            ModelPatchOp::Splice {
                node_id,
                field,
                index,
                delete_count,
                items,
            } => {
                let entity = self
                    .entities
                    .entry(node_id.clone())
                    .or_insert_with(|| EntityNode::new(node_id.clone(), "unknown"));

                if field == "children" {
                    let start = (*index).min(entity.children.len());
                    let end = (start + delete_count).min(entity.children.len());
                    entity.children.drain(start..end);

                    for (offset, item) in items.iter().enumerate() {
                        let id_str = match item {
                            serde_json::Value::String(s) => s.clone(),
                            serde_json::Value::Object(map) => map
                                .get("uuid")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            _ => item.to_string(),
                        };
                        entity.children.insert(start + offset, id_str);
                    }
                } else {
                    // Generic array property splice
                    let arr = entity
                        .properties
                        .entry(field.clone())
                        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                    if let serde_json::Value::Array(vec) = arr {
                        let start = (*index).min(vec.len());
                        let end = (start + delete_count).min(vec.len());
                        vec.drain(start..end);
                        for (offset, item) in items.iter().enumerate() {
                            vec.insert(start + offset, item.clone());
                        }
                    }
                }
            }
            ModelPatchOp::MapSet {
                node_id,
                field,
                key,
                value,
            } => {
                let entity = self
                    .entities
                    .entry(node_id.clone())
                    .or_insert_with(|| EntityNode::new(node_id.clone(), "unknown"));
                entity
                    .records
                    .entry(field.clone())
                    .or_default()
                    .insert(key.clone(), value.clone());
            }
            ModelPatchOp::MapDelete {
                node_id,
                field,
                key,
            } => {
                if let Some(entity) = self.entities.get_mut(node_id) {
                    if let Some(map) = entity.records.get_mut(field) {
                        map.remove(key);
                    }
                }
            }
        }
    }

    /// Apply a batch of patches with revision bump.
    pub fn apply_batch(&mut self, revision: u64, patches: &[ModelPatchOp]) {
        for patch in patches {
            self.apply_patch(patch);
        }
        self.revision = revision;
    }

    /// Project the document state into TapeTurnItem list for TapeWidget.
    pub fn project_to_tape_turns(&self) -> Vec<TapeTurnItem> {
        let mut turns = Vec::new();

        if let Some(root_id) = &self.root_id {
            if let Some(root) = self.entities.get(root_id) {
                for child_id in &root.children {
                    if let Some(node) = self.entities.get(child_id) {
                        let role = if node.tag.contains("User") || node.tag == "user" {
                            TapeRole::User
                        } else if node.tag.contains("System") || node.tag == "system" {
                            TapeRole::System
                        } else {
                            TapeRole::Assistant
                        };

                        let text = node
                            .properties
                            .get("text")
                            .and_then(|v| v.as_str())
                            .or_else(|| node.properties.get("prompt").and_then(|v| v.as_str()))
                            .unwrap_or("")
                            .to_string();

                        let lines: Vec<Line<'static>> =
                            text.lines().map(|l| Line::raw(l.to_string())).collect();

                        turns.push(TapeTurnItem::new(&node.uuid, role, lines));
                    }
                }
            }
        }

        turns
    }

    /// Project document state to a StatuslineWidget.
    pub fn project_to_statusline(&self, cwd: &str, model: &str) -> StatuslineWidget {
        let perm_mode = self
            .root_id
            .as_ref()
            .and_then(|r| self.entities.get(r))
            .and_then(|e| e.properties.get("permissionMode"))
            .and_then(|v| v.as_str())
            .unwrap_or("ask")
            .to_string();

        StatuslineWidget::new()
            .cwd(cwd)
            .model(model)
            .permission_mode(perm_mode)
    }

    /// Project document subagents into SubagentStatus list for AgentsMeterWidget.
    pub fn project_to_subagents(&self) -> Vec<SubagentStatus> {
        let mut list = Vec::new();
        for entity in self.entities.values() {
            if entity.tag == "subagent" || entity.tag.contains("Agent") {
                let name = entity
                    .properties
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("worker")
                    .to_string();
                let steps = entity
                    .properties
                    .get("steps")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let active = entity
                    .properties
                    .get("running")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let mut status = SubagentStatus::new(&entity.uuid, name).with_steps(steps);
                if !active {
                    status = status.completed();
                }
                list.push(status);
            }
        }
        list
    }
}
