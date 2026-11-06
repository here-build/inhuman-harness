//! Oracle tests for LiveShape lanes, session document patch replica, and wire codecs.

use qd::state::session::{EntityNode, ModelPatchOp, SessionDocumentState};
use qd::state::shapes::{
    KernelRow, LiveShape, PendingAskKind, PendingAskRow, SessionSummaryRow, ShapeFrame,
};
use qd::state::sync::{
    decode_wire_frame, encode_wire_frame, RpcNotification, RpcRequest, RpcResponse, WireFrame,
    MESSAGE_AWARENESS, MESSAGE_QUERY_AWARENESS, MESSAGE_SHAPE, MESSAGE_SYNC,
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
    // 1. Sync frame
    let sync_frame = WireFrame::Sync(vec![1, 2, 3, 4]);
    let sync_bytes = encode_wire_frame(&sync_frame);
    assert_eq!(sync_bytes[0], MESSAGE_SYNC);
    let decoded_sync = decode_wire_frame(&sync_bytes).expect("decodes sync");
    assert_eq!(decoded_sync, sync_frame);

    // 2. Awareness frame
    let awareness_frame = WireFrame::Awareness(vec![10, 20]);
    let awareness_bytes = encode_wire_frame(&awareness_frame);
    assert_eq!(awareness_bytes[0], MESSAGE_AWARENESS);
    let decoded_awareness = decode_wire_frame(&awareness_bytes).expect("decodes awareness");
    assert_eq!(decoded_awareness, awareness_frame);

    // 3. Query awareness frame
    let query_frame = WireFrame::QueryAwareness;
    let query_bytes = encode_wire_frame(&query_frame);
    assert_eq!(query_bytes, vec![MESSAGE_QUERY_AWARENESS]);
    let decoded_query = decode_wire_frame(&query_bytes).expect("decodes query awareness");
    assert_eq!(decoded_query, query_frame);

    // 4. Shape frame
    let shape_frame = WireFrame::Shape(vec![0xaa, 0xbb]);
    let shape_bytes = encode_wire_frame(&shape_frame);
    assert_eq!(shape_bytes[0], MESSAGE_SHAPE);
    let decoded_shape = decode_wire_frame(&shape_bytes).expect("decodes shape");
    assert_eq!(decoded_shape, shape_frame);

    // 5. JSON-RPC request frame
    let req = RpcRequest::new(1, "session/ask/answer", serde_json::json!({ "approved": true }));
    let req_json = serde_json::to_string(&req).unwrap();
    let rpc_frame = WireFrame::JsonRpc(req_json.clone());
    let rpc_bytes = encode_wire_frame(&rpc_frame);
    assert_eq!(rpc_bytes[0], b'{');
    let decoded_rpc = decode_wire_frame(&rpc_bytes).expect("decodes json-rpc");
    if let WireFrame::JsonRpc(decoded_json) = decoded_rpc {
        let parsed: RpcRequest = serde_json::from_str(&decoded_json).unwrap();
        assert_eq!(parsed.method, "session/ask/answer");
        assert_eq!(parsed.id, 1);
    } else {
        panic!("Expected JsonRpc frame");
    }

    // 6. JSON-RPC response and notification
    let resp = RpcResponse::ok(1, serde_json::json!({ "status": "ok" }));
    let resp_str = serde_json::to_string(&resp).unwrap();
    assert!(resp_str.contains("\"result\":{\"status\":\"ok\"}"));

    let notif = RpcNotification::new("session/turn/stream", serde_json::json!({ "chunk": "hi" }));
    let notif_str = serde_json::to_string(&notif).unwrap();
    assert!(notif_str.contains("\"method\":\"session/turn/stream\""));
}
