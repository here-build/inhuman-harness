//! Wire frame codec and JSON-RPC 2.0 framing for daemon communication.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MESSAGE_SYNC: u8 = 0;
pub const MESSAGE_AWARENESS: u8 = 1;
pub const MESSAGE_QUERY_AWARENESS: u8 = 3;
pub const MESSAGE_SHAPE: u8 = 4;
pub const TAG_JSON_RPC: u8 = 0x7b; // ASCII '{'

#[derive(Debug, Error)]
pub enum SyncCodecError {
    #[error("Empty wire payload")]
    EmptyPayload,
    #[error("Unknown wire message type: {0:#04x}")]
    UnknownMessageType(u8),
    #[error("Invalid UTF-8 in JSON-RPC frame: {0}")]
    Utf8Error(#[from] std::str::Utf8Error),
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
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
    pub fn new(id: impl Into<serde_json::Value>, method: impl Into<String>, params: serde_json::Value) -> Self {
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

/// Top-level wire frames exchanged across the plane transport.
#[derive(Debug, Clone, PartialEq)]
pub enum WireFrame {
    Sync(Vec<u8>),
    Awareness(Vec<u8>),
    QueryAwareness,
    Shape(Vec<u8>),
    JsonRpc(String),
}

/// Decode raw wire bytes into a WireFrame.
pub fn decode_wire_frame(bytes: &[u8]) -> Result<WireFrame, SyncCodecError> {
    if bytes.is_empty() {
        return Err(SyncCodecError::EmptyPayload);
    }

    match bytes[0] {
        MESSAGE_SYNC => Ok(WireFrame::Sync(bytes[1..].to_vec())),
        MESSAGE_AWARENESS => Ok(WireFrame::Awareness(bytes[1..].to_vec())),
        MESSAGE_QUERY_AWARENESS => Ok(WireFrame::QueryAwareness),
        MESSAGE_SHAPE => Ok(WireFrame::Shape(bytes[1..].to_vec())),
        TAG_JSON_RPC => {
            let json_str = std::str::from_utf8(bytes)?;
            Ok(WireFrame::JsonRpc(json_str.to_string()))
        }
        other => Err(SyncCodecError::UnknownMessageType(other)),
    }
}

/// Encode a WireFrame into wire protocol bytes.
pub fn encode_wire_frame(frame: &WireFrame) -> Vec<u8> {
    match frame {
        WireFrame::Sync(payload) => {
            let mut out = Vec::with_capacity(1 + payload.len());
            out.push(MESSAGE_SYNC);
            out.extend_from_slice(payload);
            out
        }
        WireFrame::Awareness(payload) => {
            let mut out = Vec::with_capacity(1 + payload.len());
            out.push(MESSAGE_AWARENESS);
            out.extend_from_slice(payload);
            out
        }
        WireFrame::QueryAwareness => vec![MESSAGE_QUERY_AWARENESS],
        WireFrame::Shape(payload) => {
            let mut out = Vec::with_capacity(1 + payload.len());
            out.push(MESSAGE_SHAPE);
            out.extend_from_slice(payload);
            out
        }
        WireFrame::JsonRpc(text) => text.as_bytes().to_vec(),
    }
}
