//! UTF-8 JSON reactivity plane (`shape/*`, `presence/*`, `stream/delta`, `ping`/`pong`)
//! and JSON-RPC 2.0 wire frame codec for daemon communication.

use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

pub const EDGE_PING_FRAME: &str = " ping";
pub const EDGE_PONG_FRAME: &str = " pong";

#[derive(Debug, Error)]
pub enum SyncCodecError {
    #[error("Empty wire payload")]
    EmptyPayload,
    #[error("Invalid UTF-8 in wire frame: {0}")]
    Utf8Error(#[from] std::str::Utf8Error),
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("Unrecognized wire frame envelope")]
    UnrecognizedFrame,
}

/// JSON-RPC 2.0 Request
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

impl RpcRequest {
    pub fn new(
        id: impl Into<serde_json::Value>,
        method: impl Into<String>,
        params: serde_json::Value,
    ) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// JSON-RPC 2.0 Response
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: impl Into<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: impl Into<serde_json::Value>, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: id.into(),
            result: None,
            error: Some(error),
        }
    }
}

/// JSON-RPC 2.0 Error object
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// JSON-RPC 2.0 Notification
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

impl RpcNotification {
    pub fn new(method: impl Into<String>, params: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.into(),
            params,
        }
    }
}

/// Parsed JSON-RPC 2.0 envelope.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonRpcFrame {
    Request(RpcRequest),
    Response(RpcResponse),
    Notification(RpcNotification),
}

/// Ephemeral presence entry tuple `[clientId, state | null, clock?]`.
#[derive(Debug, Clone, PartialEq)]
pub struct PresenceEntry {
    pub client_id: i64,
    pub state: Option<serde_json::Map<String, serde_json::Value>>,
    pub clock: Option<u64>,
}

impl PresenceEntry {
    pub fn new(
        client_id: i64,
        state: Option<serde_json::Map<String, serde_json::Value>>,
        clock: Option<u64>,
    ) -> Self {
        Self {
            client_id,
            state,
            clock,
        }
    }
}

impl Serialize for PresenceEntry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let len = if self.clock.is_some() { 3 } else { 2 };
        let mut seq = serializer.serialize_seq(Some(len))?;
        seq.serialize_element(&self.client_id)?;
        seq.serialize_element(&self.state)?;
        if let Some(clock) = self.clock {
            seq.serialize_element(&clock)?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for PresenceEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct PresenceVisitor;

        impl<'de> Visitor<'de> for PresenceVisitor {
            type Value = PresenceEntry;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a 2- or 3-element presence tuple [clientId, state, clock?]")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let client_id: i64 = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let state: Option<serde_json::Map<String, serde_json::Value>> = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(1, &self))?;
                let clock: Option<u64> = seq.next_element()?;
                Ok(PresenceEntry {
                    client_id,
                    state,
                    clock,
                })
            }
        }

        deserializer.deserialize_seq(PresenceVisitor)
    }
}

/// Ephemeral mid-round streaming channel.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamChannel {
    Assistant,
    Shell,
}

/// Unified UTF-8 JSON reactivity plane frames (`shape/*`, `presence/*`, `stream/delta`, `ping`/`pong`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum PlaneFrame {
    #[serde(rename = "shape/subscribe")]
    ShapeSubscribe {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
        lane: String,
        #[serde(default = "empty_json_object")]
        params: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        offset: Option<u64>,
    },
    #[serde(rename = "shape/unsubscribe")]
    ShapeUnsubscribe {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
    },
    #[serde(rename = "shape/delta")]
    ShapeDelta {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
        offset: u64,
        #[serde(default)]
        upserts: Vec<serde_json::Map<String, serde_json::Value>>,
        #[serde(default)]
        deletes: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reset: Option<bool>,
    },
    #[serde(rename = "presence/update")]
    PresenceUpdate {
        #[serde(skip_serializing_if = "Option::is_none")]
        room: Option<String>,
        entries: Vec<PresenceEntry>,
    },
    #[serde(rename = "presence/state")]
    PresenceState {
        #[serde(skip_serializing_if = "Option::is_none")]
        room: Option<String>,
        entries: Vec<PresenceEntry>,
    },
    #[serde(rename = "presence/query")]
    PresenceQuery {
        #[serde(skip_serializing_if = "Option::is_none")]
        room: Option<String>,
    },
    #[serde(rename = "stream/delta")]
    StreamDelta {
        #[serde(rename = "sessionId")]
        session_id: String,
        channel: StreamChannel,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thought: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tail: Option<String>,
        #[serde(rename = "byteOffset", skip_serializing_if = "Option::is_none")]
        byte_offset: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        done: Option<bool>,
    },
    #[serde(rename = "ping")]
    Ping {
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<f64>,
    },
    #[serde(rename = "pong")]
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<f64>,
    },
}

fn empty_json_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// Top-level UTF-8 text frames exchanged across the plane transport.
#[derive(Debug, Clone, PartialEq)]
pub enum WireFrame {
    Plane(PlaneFrame),
    JsonRpc(JsonRpcFrame),
    EdgePing,
    EdgePong,
}

/// Decode a UTF-8 text wire payload into a typed [`WireFrame`].
pub fn decode_wire_frame(bytes: &[u8]) -> Result<WireFrame, SyncCodecError> {
    if bytes.is_empty() {
        return Err(SyncCodecError::EmptyPayload);
    }

    let text = std::str::from_utf8(bytes)?;
    if text == EDGE_PING_FRAME || text.trim() == "ping" {
        return Ok(WireFrame::EdgePing);
    }
    if text == EDGE_PONG_FRAME || text.trim() == "pong" {
        return Ok(WireFrame::EdgePong);
    }

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(SyncCodecError::EmptyPayload);
    }

    let value: serde_json::Value = serde_json::from_str(trimmed)?;
    let Some(obj) = value.as_object() else {
        return Err(SyncCodecError::UnrecognizedFrame);
    };

    if obj.contains_key("kind") {
        let plane: PlaneFrame = serde_json::from_value(value)?;
        return Ok(WireFrame::Plane(plane));
    }

    if obj.get("jsonrpc").and_then(serde_json::Value::as_str) == Some("2.0") {
        if obj.contains_key("method") {
            if obj.contains_key("id") {
                let req: RpcRequest = serde_json::from_value(value)?;
                return Ok(WireFrame::JsonRpc(JsonRpcFrame::Request(req)));
            }
            let notif: RpcNotification = serde_json::from_value(value)?;
            return Ok(WireFrame::JsonRpc(JsonRpcFrame::Notification(notif)));
        }
        if obj.contains_key("id") && (obj.contains_key("result") || obj.contains_key("error")) {
            let resp: RpcResponse = serde_json::from_value(value)?;
            return Ok(WireFrame::JsonRpc(JsonRpcFrame::Response(resp)));
        }
    }

    Err(SyncCodecError::UnrecognizedFrame)
}

/// Encode a [`WireFrame`] into UTF-8 wire bytes.
pub fn encode_wire_frame(frame: &WireFrame) -> Result<Vec<u8>, SyncCodecError> {
    let text = encode_wire_text(frame)?;
    Ok(text.into_bytes())
}

/// Encode a [`WireFrame`] into a UTF-8 wire text string.
pub fn encode_wire_text(frame: &WireFrame) -> Result<String, SyncCodecError> {
    match frame {
        WireFrame::Plane(plane) => Ok(serde_json::to_string(plane)?),
        WireFrame::JsonRpc(JsonRpcFrame::Request(req)) => Ok(serde_json::to_string(req)?),
        WireFrame::JsonRpc(JsonRpcFrame::Response(resp)) => Ok(serde_json::to_string(resp)?),
        WireFrame::JsonRpc(JsonRpcFrame::Notification(notif)) => Ok(serde_json::to_string(notif)?),
        WireFrame::EdgePing => Ok(EDGE_PING_FRAME.to_string()),
        WireFrame::EdgePong => Ok(EDGE_PONG_FRAME.to_string()),
    }
}
