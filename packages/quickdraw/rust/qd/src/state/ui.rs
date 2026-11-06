//! Declarative JSON `UiDefinition` schema, context-aware surface evaluator, and `UiNode` tree.
//!
//! Replaces the legacy embedded Scheme UI interpreter so the Ratatui TUI can evaluate
//! slash commands (`/connect`, `/model`, `/mcp`, `/compact`, `/goal`, `/plan`) and
//! parked RPC callback overlays (`confirm`, `input`, `open-url`, `notice`) natively in Rust.

use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UiHealth {
    #[default]
    Ok,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UiContext {
    Connect,
    Model,
    Mcp,
    Goal,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UiInputKind {
    Text,
    Password,
}

/// Declarative UI surface definition transported as JSON over RPC (`{ form: "ui", pending, body }`)
/// and stored in command `.scm` files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum UiDefinition {
    #[serde(rename = "choice")]
    Choice {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        annotation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alias: Option<Vec<String>>,
        #[serde(rename = "healthStatus", default, skip_serializing_if = "Option::is_none")]
        health_status: Option<UiHealth>,
        #[serde(rename = "healthAnnotation", default, skip_serializing_if = "Option::is_none")]
        health_annotation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hotkey: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<Vec<UiDefinition>>,
        #[serde(rename = "alternateActions", default, skip_serializing_if = "Option::is_none")]
        alternate_actions: Option<Vec<UiDefinition>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choices: Option<Vec<UiDefinition>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<UiContext>,
    },
    #[serde(rename = "action")]
    Action {
        op: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hotkey: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alias: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<BTreeMap<String, Value>>,
    },
    #[serde(rename = "confirm")]
    Confirm {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    #[serde(rename = "input")]
    Input {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret: Option<bool>,
    },
    #[serde(rename = "open-url")]
    OpenUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<UiInputKind>,
    },
    #[serde(rename = "notice")]
    Notice {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

/// Parked RPC envelope `{ form: "ui", pending, body }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiForm {
    pub form: String,
    pub pending: String,
    pub body: String,
}

impl UiForm {
    pub fn is_valid(&self) -> bool {
        self.form == "ui" && !self.pending.is_empty() && !self.body.is_empty()
    }
}

pub fn parse_ui_form(value: &Value) -> Option<UiForm> {
    let form: UiForm = serde_json::from_value(value.clone()).ok()?;
    if form.is_valid() {
        Some(form)
    } else {
        None
    }
}

pub fn parse_ui_definition(source: &str) -> Option<UiDefinition> {
    serde_json::from_str(source).ok()
}

pub fn encode_ui_definition(def: &UiDefinition) -> String {
    serde_json::to_string(def).unwrap_or_default()
}

/// Evaluated interactive UI node. Chrome branches on visible children (`choices`),
/// not on which constructor minted the node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiNode {
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    pub health: UiHealth,
    pub health_annotation: String,
    pub hotkey: Option<String>,
    pub action: Vec<UiNode>,
    pub alternate_actions: Vec<UiNode>,
    pub choices: Vec<UiNode>,
    pub op: Option<String>,
    pub params: BTreeMap<String, Value>,
    pub secret: bool,
    pub annotation: String,
}

impl Default for UiNode {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            aliases: Vec::new(),
            health: UiHealth::Ok,
            health_annotation: String::new(),
            hotkey: None,
            action: Vec::new(),
            alternate_actions: Vec::new(),
            choices: Vec::new(),
            op: None,
            params: BTreeMap::new(),
            secret: false,
            annotation: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UiChoiceInput {
    pub name: String,
    pub description: String,
    pub annotation: String,
    pub alias: Vec<String>,
    pub health_status: UiHealth,
    pub health_annotation: String,
    pub hotkey: Option<String>,
    pub action: Vec<UiNode>,
    pub alternate_actions: Vec<UiNode>,
    pub choices: Vec<UiNode>,
    pub secret: bool,
}

#[derive(Debug, Clone, Default)]
pub struct UiActionInput {
    pub name: Option<String>,
    pub description: String,
    pub hotkey: Option<String>,
    pub alias: Vec<String>,
    pub params: BTreeMap<String, Value>,
}

pub fn ui_choice(input: UiChoiceInput) -> UiNode {
    UiNode {
        name: input.name,
        description: input.description,
        aliases: input.alias,
        health: input.health_status,
        health_annotation: input.health_annotation,
        hotkey: input.hotkey,
        action: input.action,
        alternate_actions: input.alternate_actions,
        choices: input.choices,
        op: None,
        params: BTreeMap::new(),
        secret: input.secret,
        annotation: input.annotation,
    }
}

pub fn ui_action(op: impl Into<String>, input: UiActionInput) -> UiNode {
    let op_str = op.into();
    UiNode {
        name: input.name.unwrap_or_else(|| op_str.clone()),
        description: input.description,
        aliases: input.alias,
        health: UiHealth::Ok,
        health_annotation: String::new(),
        hotkey: input.hotkey,
        action: Vec::new(),
        alternate_actions: Vec::new(),
        choices: Vec::new(),
        op: Some(op_str),
        params: input.params,
        secret: false,
        annotation: String::new(),
    }
}

fn resolve_leaf(
    name: impl Into<String>,
    pending: &str,
    mut params: BTreeMap<String, Value>,
    hotkey: Option<&str>,
) -> UiNode {
    params.insert("pending".to_string(), Value::String(pending.to_string()));
    UiNode {
        name: name.into(),
        description: String::new(),
        aliases: Vec::new(),
        health: UiHealth::Ok,
        health_annotation: String::new(),
        hotkey: hotkey.map(str::to_string),
        action: Vec::new(),
        alternate_actions: Vec::new(),
        choices: Vec::new(),
        op: Some("ui/resolve".to_string()),
        params,
        secret: false,
        annotation: String::new(),
    }
}

pub fn ui_confirm(
    pending: &str,
    title: Option<&str>,
    name: Option<&str>,
    description: Option<&str>,
) -> UiNode {
    let resolved_title = name.or(title).unwrap_or("Confirm").to_string();
    let mut accept_params = BTreeMap::new();
    accept_params.insert("kind".to_string(), Value::String("accept".to_string()));
    let mut cancel_params = BTreeMap::new();
    cancel_params.insert("kind".to_string(), Value::String("cancel".to_string()));

    UiNode {
        name: resolved_title,
        description: description.unwrap_or("").to_string(),
        aliases: Vec::new(),
        health: UiHealth::Ok,
        health_annotation: String::new(),
        hotkey: None,
        action: vec![resolve_leaf("Confirm", pending, accept_params, None)],
        alternate_actions: vec![resolve_leaf("Cancel", pending, cancel_params, Some("escape"))],
        choices: Vec::new(),
        op: None,
        params: BTreeMap::new(),
        secret: false,
        annotation: String::new(),
    }
}

pub fn ui_input(
    pending: &str,
    name: Option<&str>,
    description: Option<&str>,
    secret: bool,
) -> UiNode {
    let resolved_name = name.unwrap_or("Input").to_string();
    let mut text_params = BTreeMap::new();
    text_params.insert("kind".to_string(), Value::String("text".to_string()));
    text_params.insert("input".to_string(), Value::String(String::new()));
    let mut cancel_params = BTreeMap::new();
    cancel_params.insert("kind".to_string(), Value::String("cancel".to_string()));

    UiNode {
        name: resolved_name.clone(),
        description: description.unwrap_or("").to_string(),
        aliases: Vec::new(),
        health: UiHealth::Ok,
        health_annotation: String::new(),
        hotkey: None,
        action: vec![resolve_leaf(resolved_name, pending, text_params, None)],
        alternate_actions: vec![resolve_leaf("Cancel", pending, cancel_params, Some("escape"))],
        choices: Vec::new(),
        op: None,
        params: BTreeMap::new(),
        secret,
        annotation: String::new(),
    }
}

pub fn ui_open_url(
    pending: &str,
    url: &str,
    name: Option<&str>,
    description: Option<&str>,
    input: Option<UiInputKind>,
) -> UiNode {
    let wants_input = input.is_some();
    let mut primary_params = BTreeMap::new();
    if wants_input {
        primary_params.insert("kind".to_string(), Value::String("text".to_string()));
        primary_params.insert("input".to_string(), Value::String(String::new()));
    } else {
        primary_params.insert("kind".to_string(), Value::String("opened".to_string()));
        primary_params.insert("url".to_string(), Value::String(url.to_string()));
    }
    let mut cancel_params = BTreeMap::new();
    cancel_params.insert("kind".to_string(), Value::String("cancel".to_string()));

    let mut node_params = BTreeMap::new();
    node_params.insert("url".to_string(), Value::String(url.to_string()));

    UiNode {
        name: name.unwrap_or("Continue").to_string(),
        description: description.unwrap_or("").to_string(),
        aliases: Vec::new(),
        health: UiHealth::Ok,
        health_annotation: String::new(),
        hotkey: None,
        action: vec![resolve_leaf("Continue", pending, primary_params, None)],
        alternate_actions: vec![resolve_leaf("Cancel", pending, cancel_params, Some("escape"))],
        choices: Vec::new(),
        op: None,
        params: node_params,
        secret: input == Some(UiInputKind::Password),
        annotation: String::new(),
    }
}

pub fn ui_notice(
    pending: &str,
    message: Option<&str>,
    name: Option<&str>,
    description: Option<&str>,
) -> UiNode {
    let msg = message.unwrap_or("");
    let title = match name {
        Some(n) => n.to_string(),
        None => {
            if msg.is_empty() {
                "Notice".to_string()
            } else {
                msg.to_string()
            }
        }
    };
    let desc = description.unwrap_or("");
    let resolved_desc = if desc.is_empty() {
        msg.to_string()
    } else {
        desc.to_string()
    };

    let mut dismiss_params = BTreeMap::new();
    dismiss_params.insert("kind".to_string(), Value::String("dismiss".to_string()));

    UiNode {
        name: title,
        description: resolved_desc,
        aliases: Vec::new(),
        health: UiHealth::Ok,
        health_annotation: String::new(),
        hotkey: None,
        action: vec![resolve_leaf("Dismiss", pending, dismiss_params.clone(), None)],
        alternate_actions: vec![resolve_leaf("Dismiss", pending, dismiss_params, Some("escape"))],
        choices: Vec::new(),
        op: None,
        params: BTreeMap::new(),
        secret: false,
        annotation: String::new(),
    }
}

// ---------------------------------------------------------------------------
// Context-aware state snapshots (/connect, /model, /mcp, /goal, /plan)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DriverUiSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub multiplicity: String,
    #[serde(default)]
    pub ability_claim: Vec<String>,
    #[serde(default)]
    pub offers: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUiSpec {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub driver: Option<DriverUiSpec>,
    #[serde(default)]
    pub ready_state: String,
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub configuration: Value,
    #[serde(default)]
    pub live: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandUiSpec {
    pub verb: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KernelUiSnapshot {
    #[serde(default)]
    pub drivers: Vec<DriverUiSpec>,
    #[serde(default)]
    pub connections: Vec<ConnectionUiSpec>,
    #[serde(default)]
    pub commands: BTreeMap<String, CommandUiSpec>,
    #[serde(default)]
    pub last_used_connection_model: BTreeMap<String, String>,
}

impl KernelUiSnapshot {
    pub fn find_connection(&self, id: &str) -> Option<&ConnectionUiSpec> {
        self.connections.iter().find(|c| c.id == id)
    }

    pub fn find_driver(&self, name: &str) -> Option<&DriverUiSpec> {
        self.drivers.iter().find(|d| d.name == name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionUiSnapshot {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub kvs: BTreeMap<String, String>,
    #[serde(default)]
    pub last_used_connection_model: BTreeMap<String, String>,
}

#[derive(Default)]
pub struct UiEvalConfig<'a> {
    pub kernel: Option<&'a KernelUiSnapshot>,
    pub session: Option<&'a SessionUiSnapshot>,
    pub pending: Option<&'a str>,
    pub plugin_replies: Option<&'a BTreeMap<String, Value>>,
}

fn chatgpt_plan_label(key: &str) -> Option<&'static str> {
    match key {
        "free" => Some("ChatGPT Free"),
        "plus" => Some("ChatGPT Plus"),
        "pro" => Some("ChatGPT Pro"),
        "go" => Some("ChatGPT Go"),
        "team" => Some("ChatGPT Team"),
        "business" => Some("ChatGPT Business"),
        "enterprise" => Some("ChatGPT Enterprise"),
        _ => None,
    }
}

fn grok_plan_label(key: &str) -> Option<&'static str> {
    match key {
        "super_grok" | "supergrok" | "premium" | "premium_plus" | "premiumplus" => Some("SuperGrok"),
        "super_grok_heavy" | "supergrok_heavy" | "grok_heavy" | "heavy" => Some("SuperGrok Heavy"),
        "super_grok_pro" | "supergrokpro" | "grok_pro" | "grokpro" => Some("SuperGrok Pro"),
        "super_grok_plus" | "supergrokplus" => Some("SuperGrok Plus"),
        "super_grok_lite" | "supergroklite" => Some("SuperGrok Lite"),
        "x_premium_plus" | "xpremiumplus" => Some("X Premium Plus"),
        "x_premium" | "xpremium" => Some("X Premium"),
        "x_basic" | "xbasic" => Some("X Basic"),
        "free" => Some("Free"),
        _ => None,
    }
}

fn val_str<'a>(v: &'a Value) -> &'a str {
    v.as_str().unwrap_or("")
}

fn prop_str<'a>(obj: &'a Value, key: &str) -> &'a str {
    obj.as_object()
        .and_then(|m| m.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn driver_can(d: Option<&DriverUiSpec>, capability: &str) -> bool {
    d.map(|spec| spec.ability_claim.iter().any(|c| c == capability))
        .unwrap_or(false)
}

fn models_of(c: &ConnectionUiSpec) -> Vec<String> {
    c.live
        .as_object()
        .and_then(|m| m.get("models"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn extract_version(s: &str) -> String {
    let mut out = String::new();
    let mut in_ver = false;
    let mut last_dot = false;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_ascii_digit() {
            in_ver = true;
            last_dot = false;
            out.push(ch);
        } else if in_ver && ch == '.' && !last_dot && i + 1 < chars.len() && chars[i + 1].is_ascii_digit() {
            last_dot = true;
            out.push(ch);
        } else if in_ver {
            break;
        }
        i += 1;
    }
    out
}

fn version_numbers(v: &str) -> Vec<u64> {
    if v.is_empty() {
        return Vec::new();
    }
    v.split('.')
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn version_greater(a: &[u64], b: &[u64]) -> bool {
    let max_len = a.len().max(b.len());
    for i in 0..max_len {
        if i >= a.len() {
            return false;
        }
        if i >= b.len() {
            return true;
        }
        if a[i] > b[i] {
            return true;
        }
        if a[i] < b[i] {
            return false;
        }
    }
    false
}

pub fn best_model(models: &[String]) -> String {
    let Some(first) = models.first() else {
        return String::new();
    };
    let mut best = first.clone();
    let mut best_ver = version_numbers(&extract_version(&best));
    for candidate in models.iter().skip(1) {
        let ver = version_numbers(&extract_version(candidate));
        if version_greater(&ver, &best_ver) {
            best = candidate.clone();
            best_ver = ver;
        }
    }
    best
}

fn plan_key(raw: &str) -> String {
    let s = raw.to_lowercase();
    let mut acc = String::new();
    let mut pending_us = false;
    for c in s.chars() {
        if c == ' ' || c == '-' {
            pending_us = true;
        } else if pending_us {
            acc.push('_');
            acc.push(c);
            pending_us = false;
        } else {
            acc.push(c);
        }
    }
    acc
}

fn plan_beside_product<'a>(product: &str, plan: &'a str) -> &'a str {
    if plan.is_empty() || plan == product {
        return plan;
    }
    let prefix = format!("{product} ");
    plan.strip_prefix(&prefix).unwrap_or(plan)
}

fn plan_caption(product: &str, identity: &Value) -> String {
    let raw = prop_str(identity, "plan");
    let key = plan_key(raw);
    let hit = if key.is_empty() {
        None
    } else if product == "Grok" {
        grok_plan_label(&key)
    } else {
        chatgpt_plan_label(&key)
    };
    let short = if key.is_empty() {
        ""
    } else {
        hit.unwrap_or(raw)
    };
    let core = plan_beside_product(product, short);
    let label = if !core.is_empty() {
        core
    } else if !short.is_empty() {
        short
    } else {
        product
    };
    if label.is_empty() {
        return String::new();
    }
    if label.to_lowercase().contains("subscription") {
        label.to_string()
    } else {
        format!("{label} subscription")
    }
}

fn fixed2(n: f64) -> String {
    let scaled = (n * 100.0).round() as i64;
    let neg = scaled < 0;
    let s = scaled.unsigned_abs();
    let whole = s / 100;
    let frac = s % 100;
    format!("{}{whole}.{frac:02}", if neg { "-" } else { "" })
}

fn number_or_none(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        if n.is_finite() {
            return Some(n);
        }
    }
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            if let Ok(n) = trimmed.parse::<f64>() {
                if n.is_finite() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn paint_major(raw: &Value, mark: &str) -> String {
    let Some(n) = number_or_none(raw) else {
        return val_str(raw).to_string();
    };
    let scaled = (n.abs() * 100.0).round() as i64;
    if n > 0.0 && scaled == 0 {
        return format!("<{mark}0.01");
    }
    if n < 0.0 {
        return format!("-{mark}{}", fixed2(n.abs()));
    }
    format!("{mark}{}", fixed2(n))
}

fn paint_balance(view: &Value) -> String {
    let Some(v) = view.as_object() else {
        return String::new();
    };
    let currency = v.get("currency").unwrap_or(&Value::Null);
    let mark = prop_str(currency, "symbol");
    let code = prop_str(currency, "code");
    let balance_val = v.get("balance").unwrap_or(&Value::Null);
    let body = paint_major(balance_val, mark);
    if mark.is_empty() {
        if code.is_empty() {
            body
        } else {
            format!("{body} {code}")
        }
    } else {
        body
    }
}

fn remaining_percent(remaining: &Value) -> String {
    let Some(n) = number_or_none(remaining) else {
        return String::new();
    };
    let clamped = n.clamp(0.0, 100.0).round() as i64;
    format!("{clamped}%")
}

fn count_word(n: i64, unit: &str) -> String {
    if n == 1 {
        format!("{n} {unit}")
    } else {
        format!("{n} {unit}s")
    }
}

fn hours_phrase(h: i64) -> String {
    if h >= 24 {
        count_word(h / 24, "day")
    } else {
        count_word(h, "hour")
    }
}

fn paint_reset(sec: &Value) -> String {
    let Some(n) = number_or_none(sec) else {
        return String::new();
    };
    let s = (n.round() as i64).max(0);
    let mins = if s == 0 { 0 } else { ((s + 30) / 60).max(1) };
    if mins == 0 {
        return String::new();
    }
    if mins < 60 {
        return count_word(mins, "minute");
    }
    if mins < 1440 {
        let h = mins / 60;
        let m = mins % 60;
        if m == 0 || m == 1 {
            return hours_phrase(h);
        }
        if m == 59 {
            return hours_phrase(h + 1);
        }
        return format!("{} and {}", count_word(h, "hour"), count_word(m, "minute"));
    }
    let d = mins / 1440;
    let h = (mins % 1440) / 60;
    if h == 0 {
        count_word(d, "day")
    } else {
        format!("{} and {}", count_word(d, "day"), count_word(h, "hour"))
    }
}

fn paint_window(w: &Value) -> String {
    let Some(obj) = w.as_object() else {
        return String::new();
    };
    let left = remaining_percent(obj.get("remainingPercent").unwrap_or(&Value::Null));
    let until = paint_reset(obj.get("resetInSec").unwrap_or(&Value::Null));
    if left.is_empty() {
        return String::new();
    }
    if until.is_empty() {
        left
    } else {
        format!("{left} left for {until}")
    }
}

fn paint_windows(detail: &Value) -> String {
    detail
        .as_object()
        .and_then(|d| d.get("windows"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(paint_window)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ")
        })
        .unwrap_or_default()
}

pub fn paint_account_annotation(account: &Value) -> String {
    let Some(acc) = account.as_object() else {
        return String::new();
    };
    let bal = paint_balance(acc.get("balance").unwrap_or(&Value::Null));
    let win = paint_windows(acc.get("balanceDetail").unwrap_or(&Value::Null));
    [bal, win]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

fn oidc_who(live: &Value) -> String {
    let id = live
        .as_object()
        .and_then(|m| m.get("identity"))
        .unwrap_or(&Value::Null);
    let who = prop_str(id, "displayName");
    if who.is_empty() {
        prop_str(id, "email").to_string()
    } else {
        who.to_string()
    }
}

fn identity_present(live: &Value) -> bool {
    let id = live
        .as_object()
        .and_then(|m| m.get("identity"))
        .unwrap_or(&Value::Null);
    !prop_str(id, "displayName").is_empty()
        || !prop_str(id, "email").is_empty()
        || !prop_str(id, "plan").is_empty()
}

fn connection_url(c: &ConnectionUiSpec) -> &str {
    prop_str(&c.configuration, "baseUrl")
}

fn connection_title(c: &ConnectionUiSpec) -> String {
    let live_name = prop_str(&c.live, "catalogName");
    if !live_name.is_empty() {
        return live_name.to_string();
    }
    if !c.name.is_empty() {
        c.name.clone()
    } else {
        c.id.clone()
    }
}

fn needs_auth(c: &ConnectionUiSpec) -> bool {
    prop_str(&c.live, "auth") == "needs-auth"
}

pub fn auth_line(s: &str) -> bool {
    let bytes = s.as_bytes();
    for i in 0..bytes.len().saturating_sub(2) {
        if bytes[i] == b'4' && bytes[i + 1] == b'0' && (bytes[i + 2] == b'1' || bytes[i + 2] == b'3') {
            let prev_digit = i > 0 && bytes[i - 1].is_ascii_digit();
            let next_digit = i + 3 < bytes.len() && bytes[i + 3].is_ascii_digit();
            if !prev_digit && !next_digit {
                return true;
            }
        }
    }
    false
}

fn last_used_model(
    c: &ConnectionUiSpec,
    kernel: &KernelUiSnapshot,
    session: Option<&SessionUiSnapshot>,
) -> String {
    if let Some(sess) = session {
        if let Some(m) = sess.last_used_connection_model.get(&c.id) {
            return m.clone();
        }
    }
    kernel
        .last_used_connection_model
        .get(&c.id)
        .cloned()
        .unwrap_or_default()
}

pub fn connect_choices(
    kernel: &KernelUiSnapshot,
    session: Option<&SessionUiSnapshot>,
) -> Vec<UiNode> {
    let prompt_drivers: Vec<&DriverUiSpec> = kernel
        .drivers
        .iter()
        .filter(|d| d.ability_claim.iter().any(|a| a == "completion"))
        .collect();
    let used_connections: Vec<&ConnectionUiSpec> = kernel
        .connections
        .iter()
        .filter(|c| driver_can(c.driver.as_ref(), "completion"))
        .collect();
    let used_driver_names: Vec<&str> = used_connections
        .iter()
        .filter_map(|c| c.driver.as_ref().map(|d| d.name.as_str()))
        .collect();

    let mut rows = Vec::new();

    for c in &used_connections {
        let err = c.error.as_str();
        let failed = c.issue == "failed" && !err.is_empty();
        let who = oidc_who(&c.live);
        let key_mask = prop_str(&c.live, "keyMask");
        let description = if failed && auth_line(err) {
            "The key was refused. Reconnect.".to_string()
        } else if failed {
            err.to_string()
        } else if needs_auth(c) {
            "needs auth — reconnect".to_string()
        } else if !who.is_empty() {
            who
        } else if !key_mask.is_empty() {
            key_mask.to_string()
        } else if identity_present(&c.live) {
            let id = c
                .live
                .as_object()
                .and_then(|m| m.get("identity"))
                .unwrap_or(&Value::Null);
            plan_caption(&connection_title(c), id)
        } else {
            String::new()
        };

        let annotation = if c.issue == "failed" || needs_auth(c) {
            String::new()
        } else if let Some(acc) = c.live.as_object().and_then(|m| m.get("account")) {
            paint_account_annotation(acc)
        } else {
            String::new()
        };

        let health = if c.issue == "failed" {
            UiHealth::Failed
        } else if needs_auth(c) {
            UiHealth::Degraded
        } else {
            UiHealth::Ok
        };

        let last = last_used_model(c, kernel, session);
        let pick = if last.is_empty() {
            best_model(&models_of(c))
        } else {
            last
        };

        let mut conn_params = BTreeMap::new();
        conn_params.insert("key".to_string(), Value::String("connection".to_string()));
        conn_params.insert("value".to_string(), Value::String(c.id.clone()));
        conn_params.insert("remember".to_string(), Value::String("1".to_string()));

        let mut action = vec![ui_action(
            "kv/set",
            UiActionInput {
                params: conn_params,
                ..Default::default()
            },
        )];

        if !pick.is_empty() {
            let mut model_params = BTreeMap::new();
            model_params.insert("key".to_string(), Value::String("model".to_string()));
            model_params.insert("value".to_string(), Value::String(pick));
            model_params.insert("remember".to_string(), Value::String("1".to_string()));
            action.push(ui_action(
                "kv/set",
                UiActionInput {
                    params: model_params,
                    ..Default::default()
                },
            ));
        }

        let mut drop_params = BTreeMap::new();
        drop_params.insert("id".to_string(), Value::String(c.id.clone()));

        rows.push(ui_choice(UiChoiceInput {
            name: connection_title(c),
            annotation,
            description,
            health_status: health,
            health_annotation: err.to_string(),
            action,
            alternate_actions: vec![ui_action(
                "connect/drop",
                UiActionInput {
                    name: Some("Remove connection".to_string()),
                    hotkey: Some("control-x".to_string()),
                    params: drop_params,
                    ..Default::default()
                },
            )],
            ..Default::default()
        }));
    }

    let offer_adoptable = |o: &Value| -> bool {
        match o.as_object().and_then(|m| m.get("adoptable")) {
            Some(Value::Bool(true)) => true,
            Some(Value::String(s)) => s == "true",
            _ => false,
        }
    };

    fn offer_url(o: &Value) -> &str {
        o.as_object()
            .and_then(|m| m.get("settings"))
            .map(|s| prop_str(s, "baseUrl"))
            .unwrap_or("")
    }

    let offer_matches_connection = |o: &Value, c: &ConnectionUiSpec| -> bool {
        let oname = prop_str(o, "name");
        let ourl = offer_url(o);
        if ourl.is_empty() {
            return false;
        }
        (!oname.is_empty() && oname == c.name) || ourl == connection_url(c)
    };

    let offer_adopted = |d: &DriverUiSpec, o: &Value| -> bool {
        kernel.connections.iter().any(|c| {
            c.driver.as_ref().map(|cd| cd.name.as_str()) == Some(d.name.as_str())
                && offer_matches_connection(o, c)
        })
    };

    for d in &prompt_drivers {
        for o in &d.offers {
            if offer_adopted(d, o) {
                continue;
            }
            let name = prop_str(o, "name").to_string();
            let description = prop_str(o, "description").to_string();
            if offer_adoptable(o) {
                let settings = o
                    .as_object()
                    .and_then(|m| m.get("settings"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_else(Map::new);
                let mut params = BTreeMap::new();
                params.insert("driver".to_string(), Value::String(d.name.clone()));
                params.insert("name".to_string(), Value::String(name.clone()));
                params.insert("settings".to_string(), Value::Object(settings));
                rows.push(ui_choice(UiChoiceInput {
                    name,
                    description,
                    action: vec![ui_action(
                        "connect/adopt",
                        UiActionInput {
                            params,
                            ..Default::default()
                        },
                    )],
                    ..Default::default()
                }));
            } else {
                rows.push(ui_choice(UiChoiceInput {
                    name,
                    description,
                    ..Default::default()
                }));
            }
        }
    }

    for d in &prompt_drivers {
        if used_driver_names.contains(&d.name.as_str()) || !d.offers.is_empty() {
            continue;
        }
        let name = d.name.clone();
        let description = d.description.clone();
        if d.multiplicity == "add-by-default" {
            let mut params = BTreeMap::new();
            params.insert("driver".to_string(), Value::String(name.clone()));
            params.insert("name".to_string(), Value::String(name.clone()));
            rows.push(ui_choice(UiChoiceInput {
                name,
                description,
                action: vec![ui_action(
                    "connect/adopt",
                    UiActionInput {
                        params,
                        ..Default::default()
                    },
                )],
                ..Default::default()
            }));
        } else {
            rows.push(ui_choice(UiChoiceInput {
                name,
                description,
                ..Default::default()
            }));
        }
    }

    rows
}

pub fn build_connect_surface(
    kernel: &KernelUiSnapshot,
    session: Option<&SessionUiSnapshot>,
) -> UiNode {
    ui_choice(UiChoiceInput {
        choices: connect_choices(kernel, session),
        ..Default::default()
    })
}

pub fn model_choices(
    kernel: &KernelUiSnapshot,
    session: Option<&SessionUiSnapshot>,
) -> Vec<UiNode> {
    let connections: Vec<&ConnectionUiSpec> = kernel
        .connections
        .iter()
        .filter(|c| driver_can(c.driver.as_ref(), "completion"))
        .collect();
    let mut ordered: Vec<&ConnectionUiSpec> = connections
        .iter()
        .copied()
        .filter(|c| models_of(c).len() < 20)
        .collect();
    ordered.extend(
        connections
            .iter()
            .copied()
            .filter(|c| models_of(c).len() >= 20),
    );
    let active_model = session
        .and_then(|s| s.kvs.get("model"))
        .map(String::as_str)
        .unwrap_or("");

    let mut rows = Vec::new();
    for c in ordered {
        for mid in models_of(c) {
            let description = if mid == active_model {
                format!("{} · current", c.id)
            } else {
                c.id.clone()
            };
            let mut conn_params = BTreeMap::new();
            conn_params.insert("key".to_string(), Value::String("connection".to_string()));
            conn_params.insert("value".to_string(), Value::String(c.id.clone()));
            conn_params.insert("remember".to_string(), Value::String("1".to_string()));

            let mut model_params = BTreeMap::new();
            model_params.insert("key".to_string(), Value::String("model".to_string()));
            model_params.insert("value".to_string(), Value::String(mid.clone()));
            model_params.insert("remember".to_string(), Value::String("1".to_string()));

            rows.push(ui_choice(UiChoiceInput {
                name: mid,
                description,
                action: vec![
                    ui_action(
                        "kv/set",
                        UiActionInput {
                            params: conn_params,
                            ..Default::default()
                        },
                    ),
                    ui_action(
                        "kv/set",
                        UiActionInput {
                            params: model_params,
                            ..Default::default()
                        },
                    ),
                ],
                ..Default::default()
            }));
        }
    }
    rows
}

pub fn build_model_surface(
    kernel: &KernelUiSnapshot,
    session: Option<&SessionUiSnapshot>,
) -> UiNode {
    let mut params = BTreeMap::new();
    params.insert("key".to_string(), Value::String("model".to_string()));
    params.insert("value".to_string(), Value::String(String::new()));
    params.insert("remember".to_string(), Value::String("1".to_string()));
    ui_choice(UiChoiceInput {
        action: vec![ui_action(
            "kv/set",
            UiActionInput {
                name: Some("Set model".to_string()),
                params,
                ..Default::default()
            },
        )],
        choices: model_choices(kernel, session),
        ..Default::default()
    })
}

pub fn mcp_connection_choices(
    kernel: &KernelUiSnapshot,
    session: Option<&SessionUiSnapshot>,
) -> Vec<UiNode> {
    let connections: Vec<&ConnectionUiSpec> = kernel
        .connections
        .iter()
        .filter(|c| driver_can(c.driver.as_ref(), "mcp"))
        .collect();

    connections
        .into_iter()
        .map(|c| {
            let n = c
                .live
                .as_object()
                .and_then(|m| m.get("tools"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let session_disabled_key = format!("mcp-disabled:{}", c.id);
            let session_disabled = session
                .and_then(|s| s.kvs.get(&session_disabled_key))
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            let kernel_disabled = c
                .configuration
                .as_object()
                .and_then(|m| m.get("enabled"))
                .and_then(Value::as_bool)
                == Some(false);
            let auth_needed = needs_auth(c);
            let health = if c.issue == "failed" {
                UiHealth::Failed
            } else if auth_needed || (c.ready_state == "ready" && n == 0) {
                UiHealth::Degraded
            } else {
                UiHealth::Ok
            };
            let err = c.error.as_str();
            let description = if c.issue == "failed" && !err.is_empty() {
                err.to_string()
            } else if auth_needed {
                "needs auth".to_string()
            } else if session_disabled {
                "disabled (this session)".to_string()
            } else if kernel_disabled {
                "disabled".to_string()
            } else if c.ready_state == "ready" && n == 0 {
                "ready · 0 tools".to_string()
            } else {
                String::new()
            };
            let annotation = if n == 0
                || c.issue == "failed"
                || auth_needed
                || session_disabled
                || kernel_disabled
            {
                String::new()
            } else if n == 1 {
                "1 tool".to_string()
            } else {
                format!("{n} tools")
            };

            let disable_action = if session_disabled {
                let mut p = BTreeMap::new();
                p.insert("key".to_string(), Value::String(session_disabled_key));
                ui_action(
                    "kv/clear",
                    UiActionInput {
                        name: Some("Enable this session".to_string()),
                        params: p,
                        ..Default::default()
                    },
                )
            } else {
                let mut p = BTreeMap::new();
                p.insert("key".to_string(), Value::String(session_disabled_key));
                p.insert("value".to_string(), Value::String("1".to_string()));
                ui_action(
                    "kv/set",
                    UiActionInput {
                        name: Some("Disable this session".to_string()),
                        params: p,
                        ..Default::default()
                    },
                )
            };

            let mut alternate_actions = vec![disable_action];
            if auth_needed {
                let mut auth_p = BTreeMap::new();
                auth_p.insert("id".to_string(), Value::String(c.id.clone()));
                alternate_actions.push(ui_action(
                    "connect/login",
                    UiActionInput {
                        name: Some("Authenticate".to_string()),
                        params: auth_p.clone(),
                        ..Default::default()
                    },
                ));
                alternate_actions.push(ui_action(
                    "connect/logout",
                    UiActionInput {
                        name: Some("Clear auth".to_string()),
                        params: auth_p,
                        ..Default::default()
                    },
                ));
            }
            let mut drop_p = BTreeMap::new();
            drop_p.insert("id".to_string(), Value::String(c.id.clone()));
            alternate_actions.push(ui_action(
                "connect/drop",
                UiActionInput {
                    name: Some("Remove connection".to_string()),
                    hotkey: Some("control-x".to_string()),
                    params: drop_p,
                    ..Default::default()
                },
            ));

            ui_choice(UiChoiceInput {
                name: if !c.name.is_empty() {
                    c.name.clone()
                } else {
                    c.id.clone()
                },
                annotation,
                description,
                health_status: health,
                health_annotation: err.to_string(),
                alternate_actions,
                ..Default::default()
            })
        })
        .collect()
}

pub fn build_mcp_surface(
    kernel: &KernelUiSnapshot,
    session: Option<&SessionUiSnapshot>,
) -> UiNode {
    let add_row = ui_choice(UiChoiceInput {
        name: "Add MCP".to_string(),
        description: "Paste an https:// URL or a stdio command".to_string(),
        action: vec![ui_action(
            "mcp-server/adopt",
            UiActionInput {
                name: Some("Add MCP".to_string()),
                ..Default::default()
            },
        )],
        ..Default::default()
    });
    let mut choices = mcp_connection_choices(kernel, session);
    choices.push(add_row);

    let mut params = BTreeMap::new();
    params.insert("input".to_string(), Value::String(String::new()));
    ui_choice(UiChoiceInput {
        action: vec![ui_action(
            "mcp-server/adopt",
            UiActionInput {
                name: Some("Add MCP".to_string()),
                params: params.clone(),
                ..Default::default()
            },
        )],
        alternate_actions: vec![ui_action(
            "mcp-server/adopt",
            UiActionInput {
                name: Some("Add MCP".to_string()),
                hotkey: Some("control-n".to_string()),
                params,
                ..Default::default()
            },
        )],
        choices,
        ..Default::default()
    })
}

pub fn build_compact_surface() -> UiNode {
    let mut params = BTreeMap::new();
    params.insert("focus".to_string(), Value::String(String::new()));
    ui_choice(UiChoiceInput {
        action: vec![ui_action(
            "compact",
            UiActionInput {
                params,
                ..Default::default()
            },
        )],
        ..Default::default()
    })
}

pub fn goal_status_line(reply: &Value) -> String {
    let Some(r) = reply.as_object() else {
        return String::new();
    };
    if r.get("ok").and_then(Value::as_bool) != Some(true) {
        return prop_str(reply, "error").to_string();
    }
    let goal = r.get("value").unwrap_or(&Value::Null);
    let status = prop_str(goal, "status");
    if status == "none" {
        return "no goal".to_string();
    }
    let loops = goal
        .as_object()
        .and_then(|g| g.get("loops"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let text = prop_str(goal, "text");
    format!("{status} · {loops} loops left · {text}")
}

pub fn plan_status_line(reply: &Value) -> String {
    let Some(r) = reply.as_object() else {
        return String::new();
    };
    if r.get("ok").and_then(Value::as_bool) != Some(true) {
        return prop_str(reply, "error").to_string();
    }
    let plan = r.get("value").unwrap_or(&Value::Null);
    let status = prop_str(plan, "status");
    if status == "none" {
        return "no plan".to_string();
    }
    let steps = plan
        .as_object()
        .and_then(|p| p.get("steps"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let text = prop_str(plan, "text");
    format!("{status} · {steps} steps left · {text}")
}

fn apply_plugin_status_choice(choices: Vec<UiNode>, description: String) -> Vec<UiNode> {
    choices
        .into_iter()
        .map(|mut choice| {
            if choice.name == "status" {
                choice.description = description.clone();
            }
            choice
        })
        .collect()
}

pub fn eval_ui_def(def: &UiDefinition, config: &UiEvalConfig<'_>) -> UiNode {
    match def {
        UiDefinition::Choice {
            name,
            description,
            annotation,
            alias,
            health_status,
            health_annotation,
            hotkey,
            action,
            alternate_actions,
            choices,
            secret,
            context,
        } => {
            let mut eval_choices: Vec<UiNode> = choices
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|item| eval_ui_def(item, config))
                .collect();

            match context {
                Some(UiContext::Connect) => {
                    if let Some(kernel) = config.kernel {
                        let mut dynamic = connect_choices(kernel, config.session);
                        dynamic.extend(eval_choices);
                        eval_choices = dynamic;
                    }
                }
                Some(UiContext::Model) => {
                    if let Some(kernel) = config.kernel {
                        let mut dynamic = model_choices(kernel, config.session);
                        dynamic.extend(eval_choices);
                        eval_choices = dynamic;
                    }
                }
                Some(UiContext::Mcp) => {
                    if let Some(kernel) = config.kernel {
                        let mut dynamic = mcp_connection_choices(kernel, config.session);
                        dynamic.extend(eval_choices);
                        eval_choices = dynamic;
                    }
                }
                Some(UiContext::Goal) => {
                    let reply = config
                        .plugin_replies
                        .and_then(|m| m.get("inhuman-plugin-goal"))
                        .unwrap_or(&Value::Null);
                    eval_choices =
                        apply_plugin_status_choice(eval_choices, goal_status_line(reply));
                }
                Some(UiContext::Plan) => {
                    let reply = config
                        .plugin_replies
                        .and_then(|m| m.get("fusion"))
                        .unwrap_or(&Value::Null);
                    eval_choices =
                        apply_plugin_status_choice(eval_choices, plan_status_line(reply));
                }
                None => {}
            }

            ui_choice(UiChoiceInput {
                name: name.clone().unwrap_or_default(),
                description: description.clone().unwrap_or_default(),
                annotation: annotation.clone().unwrap_or_default(),
                alias: alias.clone().unwrap_or_default(),
                health_status: health_status.unwrap_or_default(),
                health_annotation: health_annotation.clone().unwrap_or_default(),
                hotkey: hotkey.clone(),
                action: action
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|item| eval_ui_def(item, config))
                    .collect(),
                alternate_actions: alternate_actions
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|item| eval_ui_def(item, config))
                    .collect(),
                choices: eval_choices,
                secret: secret.unwrap_or(false),
            })
        }
        UiDefinition::Action {
            op,
            name,
            description,
            hotkey,
            alias,
            params,
        } => ui_action(
            op.clone(),
            UiActionInput {
                name: name.clone(),
                description: description.clone().unwrap_or_default(),
                hotkey: hotkey.clone(),
                alias: alias.clone().unwrap_or_default(),
                params: params.clone().unwrap_or_default(),
            },
        ),
        UiDefinition::Confirm {
            title,
            name,
            description,
        } => ui_confirm(
            config.pending.unwrap_or(""),
            title.as_deref(),
            name.as_deref(),
            description.as_deref(),
        ),
        UiDefinition::Input {
            name,
            description,
            secret,
        } => ui_input(
            config.pending.unwrap_or(""),
            name.as_deref(),
            description.as_deref(),
            secret.unwrap_or(false),
        ),
        UiDefinition::OpenUrl {
            url,
            name,
            description,
            input,
        } => ui_open_url(
            config.pending.unwrap_or(""),
            url,
            name.as_deref(),
            description.as_deref(),
            *input,
        ),
        UiDefinition::Notice {
            message,
            name,
            description,
        } => ui_notice(
            config.pending.unwrap_or(""),
            message.as_deref(),
            name.as_deref(),
            description.as_deref(),
        ),
    }
}

pub fn eval_ui_surface(source: &str, config: &UiEvalConfig<'_>) -> Option<UiNode> {
    let def = parse_ui_definition(source)?;
    Some(eval_ui_def(&def, config))
}

// ---------------------------------------------------------------------------
// UiNode inspection & parameter helpers for Tea
// ---------------------------------------------------------------------------

pub fn has_input_hole(node: &UiNode) -> bool {
    let iter = std::iter::once(node)
        .chain(node.action.iter())
        .chain(node.alternate_actions.iter())
        .chain(node.choices.iter());
    for item in iter {
        if item.op.is_some() {
            if let Some(val) = item.params.get("input") {
                if val.is_null() || val.as_str() == Some("") {
                    return true;
                }
            }
        }
    }
    false
}

pub fn url_from(node: &UiNode) -> Option<String> {
    let iter = std::iter::once(node)
        .chain(node.action.iter())
        .chain(node.alternate_actions.iter());
    for item in iter {
        if let Some(url) = item.params.get("url").and_then(Value::as_str) {
            let trimmed = url.trim();
            if trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
                || trimmed.to_ascii_lowercase().starts_with("http://")
                || trimmed.to_ascii_lowercase().starts_with("https://")
            {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

pub fn fill_params(
    mut params: BTreeMap<String, Value>,
    remainder: &str,
) -> BTreeMap<String, Value> {
    if remainder.is_empty() {
        return params;
    }
    if let Some(val) = params.get("input") {
        if val.is_null() || val.as_str() == Some("") {
            params.insert("input".to_string(), Value::String(remainder.to_string()));
        }
    }
    if let Some(val) = params.get("value") {
        if val.as_str() == Some("") {
            params.insert("value".to_string(), Value::String(remainder.to_string()));
        }
    }
    params
}

pub fn primary_display_name(node: &UiNode) -> Option<String> {
    let first = node.action.first()?;
    let label = first.name.trim();
    if !label.is_empty() && Some(label) != first.op.as_deref() {
        Some(label.to_string())
    } else {
        Some("select".to_string())
    }
}

pub fn is_activatable(node: &UiNode, catalog: bool) -> bool {
    catalog || !node.choices.is_empty() || !node.action.is_empty()
}
