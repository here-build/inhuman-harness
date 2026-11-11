//! Oracle tests for LiveShape lanes, session document patch replica, and wire codecs.

use qd::state::session::{EntityNode, ModelPatchOp, SessionDocumentState};
use qd::state::shapes::{
    KernelRow, LiveShape, PendingAskKind, PendingAskRow, SessionSummaryRow, ShapeFrame,
};
use qd::state::sync::{
    decode_wire_frame, encode_wire_frame, JsonRpcFrame, PlaneFrame, PresenceEntry, RpcNotification,
    RpcRequest, RpcResponse, StreamChannel, SyncCodecError, WireFrame, EDGE_PING_FRAME,
};

#[test]
fn test_live_shape_delta_and_snapshot() {
    let mut shape: LiveShape<String, SessionSummaryRow> =
        LiveShape::new("active_sessions", "sub-1");

    let row1 = SessionSummaryRow {
        session_id: "s1".into(),
        title: "Feature A".into(),
        workspace_path: "/repo".into(),
        mode: "assistant".into(),
        permission_mode: "auto".into(),
        running: true,
        head_turn_id: None,
        parent_session_id: None,
        parent_call_id: None,
        depth: 0,
        revision: 1,
        created_at_ms: 1000,
        last_active_at_ms: 2000,
        archived_at_ms: None,
    };

    let row2 = SessionSummaryRow {
        session_id: "s2".into(),
        title: "Feature B".into(),
        workspace_path: "/repo".into(),
        mode: "agentic".into(),
        permission_mode: "ask".into(),
        running: false,
        head_turn_id: None,
        parent_session_id: None,
        parent_call_id: None,
        depth: 0,
        revision: 1,
        created_at_ms: 1500,
        last_active_at_ms: 2500,
        archived_at_ms: None,
    };

    // 1. Apply snapshot frame
    let snapshot = ShapeFrame::Snapshot {
        subscription_id: "sub-1".into(),
        offset: 10,
        items: vec![row1.clone(), row2.clone()],
    };
    shape.apply_frame(snapshot, |r| r.session_id.clone());

    assert_eq!(shape.len(), 2);
    assert_eq!(shape.get(&"s1".to_string()).unwrap().title, "Feature A");
    assert_eq!(shape.get(&"s2".to_string()).unwrap().title, "Feature B");
    assert_eq!(shape.offset, 10);

    // 2. Apply delta frame (update s1, delete s2, add s3)
    let mut row1_updated = row1.clone();
    row1_updated.title = "Feature A (renamed)".into();

    let row3 = SessionSummaryRow {
        session_id: "s3".into(),
        title: "Feature C".into(),
        workspace_path: "/repo".into(),
        mode: "assistant".into(),
        permission_mode: "auto".into(),
        running: true,
        head_turn_id: None,
        parent_session_id: None,
        parent_call_id: None,
        depth: 0,
        revision: 2,
        created_at_ms: 3000,
        last_active_at_ms: 3000,
        archived_at_ms: None,
    };

    let delta = ShapeFrame::Delta {
        subscription_id: "sub-1".into(),
        offset: 15,
        upserts: vec![row1_updated, row3],
        deletes: vec!["s2".into()],
        reset: false,
    };
    shape.apply_frame(delta, |r| r.session_id.clone());

    assert_eq!(shape.len(), 2);
    assert_eq!(shape.get(&"s1".to_string()).unwrap().title, "Feature A (renamed)");
    assert!(shape.get(&"s2".to_string()).is_none());
    assert_eq!(shape.get(&"s3".to_string()).unwrap().title, "Feature C");
    assert_eq!(shape.offset, 15);
}

#[test]
fn test_contract_rows_json_deserialization() {
    let json_ask = r#"{
        "jobId": "job-101",
        "sessionId": "s-42",
        "turnId": "t-1",
        "kind": "ask",
        "object": "file_write",
        "summary": "Write src/app.ts",
        "createdAtMs": 1700000000000
    }"#;

    let ask: PendingAskRow = serde_json::from_str(json_ask).expect("deserializes PendingAskRow");
    assert_eq!(ask.job_id, "job-101");
    assert_eq!(ask.session_id, "s-42");
    assert_eq!(ask.kind, PendingAskKind::Ask);
    assert_eq!(ask.summary, "Write src/app.ts");

    let json_kernel = r#"{
        "id": "singleton",
        "defaultModel": "claude-3-7-sonnet",
        "permissionMode": "auto",
        "kvsJson": "{\"theme\":\"dark\"}",
        "updatedAtMs": 1700000001000
    }"#;

    let kernel: KernelRow = serde_json::from_str(json_kernel).expect("deserializes KernelRow");
    assert_eq!(kernel.default_model, "claude-3-7-sonnet");
    assert_eq!(kernel.permission_mode, "auto");
}

#[test]
fn test_session_document_state_patch_application() {
    let mut doc = SessionDocumentState::new("sess-1");

    let mut root = EntityNode::new("root-1", "SessionRoot");
    root.properties.insert("permissionMode".into(), serde_json::json!("auto"));
    doc.insert_entity(root);

    // 1. Splice children (add turn-1)
    let splice_op = ModelPatchOp::Splice {
        node_id: "root-1".into(),
        field: "children".into(),
        index: 0,
        delete_count: 0,
        items: vec![serde_json::json!("turn-1")],
    };
    doc.apply_patch(&splice_op);
    assert_eq!(doc.get_entity("root-1").unwrap().children, vec!["turn-1"]);

    // 2. Set property on turn-1
    let set_op = ModelPatchOp::Set {
        node_id: "turn-1".into(),
        field: "prompt".into(),
        value: serde_json::json!("Fix the login button"),
        key: None,
    };
    doc.apply_patch(&set_op);
    assert_eq!(
        doc.get_entity("turn-1").unwrap().properties.get("prompt").unwrap(),
        "Fix the login button"
    );

    // 3. MapSet record
    let map_set = ModelPatchOp::MapSet {
        node_id: "turn-1".into(),
        field: "metadata".into(),
        key: "client".into(),
        value: serde_json::json!("tui"),
    };
    doc.apply_patch(&map_set);
    assert_eq!(
        doc.get_entity("turn-1").unwrap().records.get("metadata").unwrap().get("client").unwrap(),
        "tui"
    );

    // 4. MapDelete record
    let map_del = ModelPatchOp::MapDelete {
        node_id: "turn-1".into(),
        field: "metadata".into(),
        key: "client".into(),
    };
    doc.apply_patch(&map_del);
    assert!(doc.get_entity("turn-1").unwrap().records.get("metadata").unwrap().get("client").is_none());

    // 5. Project to tape turns
    let turns = doc.project_to_tape_turns();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].id, "turn-1");

    // 6. Project to statusline
    let statusline = doc.project_to_statusline("/cwd", "model-x");
    assert_eq!(statusline.permission_mode, "auto");
    assert_eq!(statusline.cwd, "/cwd");
}

#[test]
fn test_wire_frame_codec() {
    // 1. Shape subscribe & delta frames
    let sub_frame = WireFrame::Plane(PlaneFrame::ShapeSubscribe {
        subscription_id: "sub-1".into(),
        lane: "session_nodes".into(),
        params: serde_json::json!({ "sessionId": "s1" }),
        offset: Some(0),
    });
    let sub_bytes = encode_wire_frame(&sub_frame).expect("encodes shape/subscribe");
    assert_eq!(sub_bytes[0], b'{');
    let decoded_sub = decode_wire_frame(&sub_bytes).expect("decodes shape/subscribe");
    assert_eq!(decoded_sub, sub_frame);

    let mut row = serde_json::Map::new();
    row.insert("id".into(), serde_json::json!("s1:root"));
    row.insert("revision".into(), serde_json::json!(3));
    let delta_frame = WireFrame::Plane(PlaneFrame::ShapeDelta {
        subscription_id: "sub-1".into(),
        offset: 3,
        upserts: vec![row],
        deletes: vec!["s1:old".into()],
        reset: Some(true),
    });
    let delta_bytes = encode_wire_frame(&delta_frame).expect("encodes shape/delta");
    assert_eq!(decode_wire_frame(&delta_bytes).expect("decodes shape/delta"), delta_frame);

    // 2. Presence update, state, and query frames (2-tuple and 3-tuple entries)
    let mut seat = serde_json::Map::new();
    seat.insert("client".into(), serde_json::json!("tui"));
    let presence_frame = WireFrame::Plane(PlaneFrame::PresenceUpdate {
        room: Some("session:s1".into()),
        entries: vec![
            PresenceEntry::new(101, Some(seat), Some(4)),
            PresenceEntry::new(102, None, None),
        ],
    });
    let presence_bytes = encode_wire_frame(&presence_frame).expect("encodes presence/update");
    let presence_str = std::str::from_utf8(&presence_bytes).unwrap();
    assert!(presence_str.contains("[101,{\"client\":\"tui\"},4]"));
    assert!(presence_str.contains("[102,null]"));
    assert_eq!(
        decode_wire_frame(&presence_bytes).expect("decodes presence/update"),
        presence_frame
    );

    let query_frame = WireFrame::Plane(PlaneFrame::PresenceQuery { room: None });
    let query_bytes = encode_wire_frame(&query_frame).expect("encodes presence/query");
    assert_eq!(decode_wire_frame(&query_bytes).expect("decodes presence/query"), query_frame);

    // 3. Ephemeral mid-round stream/delta frame
    let stream_frame = WireFrame::Plane(PlaneFrame::StreamDelta {
        session_id: "s1".into(),
        channel: StreamChannel::Assistant,
        target_id: "msg-1".into(),
        text: Some("hello".into()),
        thought: None,
        tail: None,
        byte_offset: None,
        done: Some(false),
    });
    let stream_bytes = encode_wire_frame(&stream_frame).expect("encodes stream/delta");
    assert_eq!(
        decode_wire_frame(&stream_bytes).expect("decodes stream/delta"),
        stream_frame
    );

    // 4. Edge keepalives (" ping" / " pong") and JSON ping/pong
    let edge_ping = encode_wire_frame(&WireFrame::EdgePing).expect("encodes edge ping");
    assert_eq!(edge_ping, EDGE_PING_FRAME.as_bytes());
    assert_eq!(
        decode_wire_frame(&edge_ping).expect("decodes edge ping"),
        WireFrame::EdgePing
    );

    // 5. JSON-RPC request, response, and notification frames
    let req = RpcRequest::new(1, "session/ask/answer", serde_json::json!({ "approved": true }));
    let rpc_req = WireFrame::JsonRpc(JsonRpcFrame::Request(req));
    let rpc_bytes = encode_wire_frame(&rpc_req).expect("encodes json-rpc request");
    assert_eq!(decode_wire_frame(&rpc_bytes).expect("decodes json-rpc request"), rpc_req);

    let resp = RpcResponse::ok(1, serde_json::json!({ "status": "ok" }));
    let rpc_resp = WireFrame::JsonRpc(JsonRpcFrame::Response(resp));
    let resp_bytes = encode_wire_frame(&rpc_resp).expect("encodes json-rpc response");
    assert_eq!(decode_wire_frame(&resp_bytes).expect("decodes json-rpc response"), rpc_resp);

    let notif = RpcNotification::new("session/turn/stream", serde_json::json!({ "chunk": "hi" }));
    let rpc_notif = WireFrame::JsonRpc(JsonRpcFrame::Notification(notif));
    let notif_bytes = encode_wire_frame(&rpc_notif).expect("encodes json-rpc notification");
    assert_eq!(
        decode_wire_frame(&notif_bytes).expect("decodes json-rpc notification"),
        rpc_notif
    );

    // 6. Error handling on empty / binary / invalid frames
    assert!(matches!(decode_wire_frame(&[]), Err(SyncCodecError::EmptyPayload)));
    assert!(matches!(decode_wire_frame(&[0xff, 0xfe]), Err(SyncCodecError::Utf8Error(_))));
    assert!(matches!(
        decode_wire_frame(b"{\"unrelated\":true}"),
        Err(SyncCodecError::UnrecognizedFrame)
    ));
}
