//! LiveShape lane sync and contract row models for Harness daemon state.

use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};

/// Session summary row matching sessions table and `active_sessions` / `recent_sessions` lanes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummaryRow {
    #[serde(alias = "session_id")]
    pub session_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, alias = "workspace_path")]
    pub workspace_path: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default, alias = "permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub running: bool,
    #[serde(default, alias = "head_turn_id")]
    pub head_turn_id: Option<String>,
    #[serde(default, alias = "parent_session_id")]
    pub parent_session_id: Option<String>,
    #[serde(default, alias = "parent_call_id")]
    pub parent_call_id: Option<String>,
    #[serde(default)]
    pub depth: i64,
    #[serde(default)]
    pub revision: i64,
    #[serde(default, alias = "created_at_ms")]
    pub created_at_ms: i64,
    #[serde(default, alias = "last_active_at_ms")]
    pub last_active_at_ms: i64,
    #[serde(default, alias = "archived_at_ms")]
    pub archived_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PendingAskKind {
    #[default]
    Ask,
    Ack,
}

/// Pending ask row matching `pending_asks` lane and table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAskRow {
    #[serde(alias = "job_id")]
    pub job_id: String,
    #[serde(alias = "session_id")]
    pub session_id: String,
    #[serde(alias = "turn_id")]
    pub turn_id: String,
    pub kind: PendingAskKind,
    pub object: String,
    pub summary: String,
    #[serde(default, alias = "created_at_ms")]
    pub created_at_ms: i64,
}

/// Kernel state singleton row matching `kernel_meta` lane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KernelRow {
    pub id: String,
    #[serde(default, alias = "default_model")]
    pub default_model: String,
    #[serde(default, alias = "permission_mode")]
    pub permission_mode: String,
    #[serde(default, alias = "kvs_json")]
    pub kvs_json: String,
    #[serde(default, alias = "updated_at_ms")]
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ShapeOp<T> {
    Upsert(T),
    Delete(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum ShapeFrame<T> {
    #[serde(rename = "shape/delta")]
    Delta {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
        offset: u64,
        #[serde(default)]
        upserts: Vec<T>,
        #[serde(default)]
        deletes: Vec<String>,
        #[serde(default)]
        reset: bool,
    },
    #[serde(rename = "shape/snapshot")]
    Snapshot {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
        offset: u64,
        items: Vec<T>,
    },
    #[serde(rename = "shape/reset")]
    Reset {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
    },
}

/// In-memory table synced reactively from LiveShape lane frames.
#[derive(Debug, Clone)]
pub struct LiveShape<K, V> {
    pub lane: String,
    pub subscription_id: String,
    pub offset: u64,
    pub items: BTreeMap<K, V>,
}

impl<K: Ord + Clone, V> Default for LiveShape<K, V> {
    fn default() -> Self {
        Self {
            lane: String::new(),
            subscription_id: String::new(),
            offset: 0,
            items: BTreeMap::new(),
        }
    }
}

impl<K: Ord + Clone, V> LiveShape<K, V> {
    pub fn new(lane: impl Into<String>, subscription_id: impl Into<String>) -> Self {
        Self {
            lane: lane.into(),
            subscription_id: subscription_id.into(),
            offset: 0,
            items: BTreeMap::new(),
        }
    }

    pub fn apply_frame<F>(&mut self, frame: ShapeFrame<V>, key_extractor: F)
    where
        F: Fn(&V) -> K,
        K: From<String>,
    {
        match frame {
            ShapeFrame::Delta {
                offset,
                upserts,
                deletes,
                reset,
                ..
            } => {
                self.offset = offset;
                if reset {
                    self.items.clear();
                }
                for item in upserts {
                    let key = key_extractor(&item);
                    self.items.insert(key, item);
                }
                for del_key_str in deletes {
                    let key = K::from(del_key_str);
                    self.items.remove(&key);
                }
            }
            ShapeFrame::Snapshot { offset, items, .. } => {
                self.offset = offset;
                self.items.clear();
                for item in items {
                    let key = key_extractor(&item);
                    self.items.insert(key, item);
                }
            }
            ShapeFrame::Reset { .. } => {
                self.items.clear();
                self.offset = 0;
            }
        }
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.items.get(key)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.items.values()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}
