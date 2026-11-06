//! Oracle tests for native Rust `UiDefinition` evaluation, context-aware command projections,
//! parked callback overlays, and the unified `RatatuiApp` Tea shell.

use std::collections::BTreeMap;
use serde_json::json;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

use qd::create_buffer;
use qd::state::session::EntityNode;
use qd::state::shapes::{PendingAskKind, PendingAskRow, ShapeFrame};
use qd::state::sync::RpcResponse;
use qd::state::ui::{
    best_model, eval_ui_surface, paint_account_annotation, ConnectionUiSpec, DriverUiSpec,
    KernelUiSnapshot, SessionUiSnapshot, UiEvalConfig, UiForm, UiHealth,
};
use qd::widgets::app::RatatuiApp;

fn buffer_to_lines(buf: &Buffer) -> Vec<String> {
    let mut lines = Vec::new();
    for y in buf.area.top()..buf.area.bottom() {
        let mut line = String::new();
        for x in buf.area.left()..buf.area.right() {
            line.push_str(buf.get(x, y).symbol());
        }
        lines.push(line);
    }
    lines
}

#[test]
fn test_shipped_scm_command_files_parse_and_evaluate_in_rust() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .expect("workspace root");

    let connect_src = std::fs::read_to_string(
        repo_root.join("packages/harness/src/server/defaults/commands/connect.scm"),
    )
    .expect("read connect.scm");
    let model_src = std::fs::read_to_string(
        repo_root.join("packages/harness/src/server/defaults/commands/model.scm"),
    )
    .expect("read model.scm");
    let mcp_src = std::fs::read_to_string(
        repo_root.join("packages/harness/src/server/defaults/commands/mcp.scm"),
    )
    .expect("read mcp.scm");
    let compact_src = std::fs::read_to_string(
        repo_root.join("packages/harness/src/server/defaults/compact.scm"),
    )
    .expect("read compact.scm");
    let goal_src = std::fs::read_to_string(
        repo_root.join("plugins/inhuman-plugin-goal/tools/inhuman/commands/goal.scm"),
    )
    .expect("read goal.scm");
    let plan_src = std::fs::read_to_string(
        repo_root.join("plugins/inhuman-plugin-fusion/tools/inhuman/commands/plan.scm"),
    )
    .expect("read plan.scm");

    let mut replies = BTreeMap::new();
    replies.insert(
        "inhuman-plugin-goal".to_string(),
        json!({ "ok": true, "value": { "status": "active", "loops": 4, "text": "ship ratatui" } }),
    );
    replies.insert(
        "fusion".to_string(),
        json!({ "ok": true, "value": { "status": "running", "steps": 2, "text": "verify tests" } }),
    );

    let kernel = KernelUiSnapshot::default();
    let cfg = UiEvalConfig {
        kernel: Some(&kernel),
        session: None,
        pending: None,
        plugin_replies: Some(&replies),
    };

    let connect_node = eval_ui_surface(&connect_src, &cfg).expect("eval connect.scm");
    assert_eq!(connect_node.choices.len(), 0);

    let model_node = eval_ui_surface(&model_src, &cfg).expect("eval model.scm");
    assert_eq!(model_node.action[0].op.as_deref(), Some("kv/set"));

    let mcp_node = eval_ui_surface(&mcp_src, &cfg).expect("eval mcp.scm");
    assert_eq!(mcp_node.choices.len(), 1);
    assert_eq!(mcp_node.choices[0].name, "Add MCP");
    assert_eq!(
        mcp_node.alternate_actions[0].hotkey.as_deref(),
        Some("control-n")
    );

    let compact_node = eval_ui_surface(&compact_src, &cfg).expect("eval compact.scm");
    assert_eq!(compact_node.action[0].op.as_deref(), Some("compact"));

    let goal_node = eval_ui_surface(&goal_src, &cfg).expect("eval goal.scm");
    let goal_status = goal_node
        .choices
        .iter()
        .find(|c| c.name == "status")
        .expect("goal status choice");
    assert_eq!(
        goal_status.description,
        "active · 4 loops left · ship ratatui"
    );

    let plan_node = eval_ui_surface(&plan_src, &cfg).expect("eval plan.scm");
    let plan_status = plan_node
        .choices
        .iter()
        .find(|c| c.name == "status")
        .expect("plan status choice");
    assert_eq!(
        plan_status.description,
        "running · 2 steps left · verify tests"
    );
}

#[test]
fn test_context_aware_connect_model_and_mcp_projections() {
    let openai_driver = DriverUiSpec {
        name: "openai-compat".to_string(),
        description: "OpenAI-compatible API".to_string(),
        multiplicity: "many".to_string(),
        ability_claim: vec!["completion".to_string()],
        offers: vec![
            json!({
                "name": "OpenAI",
                "description": "API key",
                "adoptable": true,
                "settings": { "baseUrl": "https://api.openai.com/v1" }
            }),
            json!({
                "name": "Anthropic",
                "description": "Claude API key",
                "adoptable": true,
                "settings": { "baseUrl": "https://api.anthropic.com/v1" }
            }),
        ],
    };

    let codex_driver = DriverUiSpec {
        name: "codex".to_string(),
        description: "ChatGPT subscription".to_string(),
        multiplicity: "add-by-default".to_string(),
        ability_claim: vec!["completion".to_string()],
        offers: Vec::new(),
    };

    let mcp_driver = DriverUiSpec {
        name: "mcp".to_string(),
        description: "Model Context Protocol".to_string(),
        multiplicity: "many".to_string(),
        ability_claim: vec!["mcp".to_string()],
        offers: Vec::new(),
    };

    let active_openai = ConnectionUiSpec {
        id: "openai".to_string(),
        name: "OpenAI".to_string(),
        driver: Some(openai_driver.clone()),
        ready_state: "ready".to_string(),
        issue: String::new(),
        error: String::new(),
        configuration: json!({ "baseUrl": "https://api.openai.com/v1" }),
        live: json!({
            "catalogName": "OpenAI",
            "keyMask": "sk-...1234",
            "models": ["gpt-4.1", "gpt-5.2", "gpt-4.5"],
            "account": {
                "balance": {
                    "balance": 12.5,
                    "currency": { "symbol": "$", "code": "USD" }
                },
                "balanceDetail": {
                    "windows": [
                        { "remainingPercent": 80, "resetInSec": 7200 }
                    ]
                }
            }
        }),
    };

    let refused_conn = ConnectionUiSpec {
        id: "broken".to_string(),
        name: "Broken".to_string(),
        driver: Some(openai_driver.clone()),
        ready_state: "failed".to_string(),
        issue: "failed".to_string(),
        error: "HTTP 401 Unauthorized".to_string(),
        configuration: json!({}),
        live: json!({}),
    };

    let mcp_conn = ConnectionUiSpec {
        id: "github-mcp".to_string(),
        name: "GitHub MCP".to_string(),
        driver: Some(mcp_driver.clone()),
        ready_state: "ready".to_string(),
        issue: String::new(),
        error: String::new(),
        configuration: json!({ "enabled": true }),
        live: json!({
            "tools": [{ "name": "create_issue" }, { "name": "list_prs" }]
        }),
    };

    let kernel = KernelUiSnapshot {
        drivers: vec![openai_driver, codex_driver, mcp_driver],
        connections: vec![active_openai, refused_conn, mcp_conn],
        commands: BTreeMap::new(),
        last_used_connection_model: BTreeMap::new(),
    };

    let mut session = SessionUiSnapshot::default();
    session.kvs.insert("model".to_string(), "gpt-5.2".to_string());

    let cfg = UiEvalConfig {
        kernel: Some(&kernel),
        session: Some(&session),
        pending: None,
        plugin_replies: None,
    };

    // 1. Evaluate /connect
    let connect_surface =
        eval_ui_surface(r#"{"kind":"choice","context":"connect"}"#, &cfg).unwrap();
    // Expect: OpenAI (active), Broken (failed), Anthropic (unadopted offer; OpenAI offer deduplicated!), codex (unused add-by-default driver)
    let names: Vec<&str> = connect_surface
        .choices
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, vec!["OpenAI", "Broken", "Anthropic", "codex"]);

    let openai_choice = &connect_surface.choices[0];
    assert_eq!(openai_choice.health, UiHealth::Ok);
    assert_eq!(openai_choice.description, "sk-...1234");
    assert_eq!(openai_choice.annotation, "$12.50 · 80% left for 2 hours");
    // Best model picked automatically is gpt-5.2
    assert_eq!(
        openai_choice.action[1].params.get("value"),
        Some(&json!("gpt-5.2"))
    );

    let broken_choice = &connect_surface.choices[1];
    assert_eq!(broken_choice.health, UiHealth::Failed);
    assert_eq!(broken_choice.description, "The key was refused. Reconnect.");

    // 2. Evaluate /model
    let model_surface = eval_ui_surface(r#"{"kind":"choice","context":"model"}"#, &cfg).unwrap();
    assert_eq!(model_surface.choices.len(), 3);
    assert_eq!(model_surface.choices[1].name, "gpt-5.2");
    assert_eq!(model_surface.choices[1].description, "openai · current");

    // 3. Evaluate /mcp
    let mcp_surface = eval_ui_surface(
        r#"{"kind":"choice","context":"mcp","choices":[{"kind":"choice","name":"Add MCP"}]}"#,
        &cfg,
    )
    .unwrap();
    assert_eq!(mcp_surface.choices.len(), 2);
    assert_eq!(mcp_surface.choices[0].name, "GitHub MCP");
    assert_eq!(mcp_surface.choices[0].annotation, "2 tools");
    assert_eq!(mcp_surface.choices[1].name, "Add MCP");

    // Verify helper functions directly
    assert_eq!(
        best_model(&["claude-3.5".into(), "claude-3.7".into(), "claude-3.0".into()]),
        "claude-3.7"
    );
    assert_eq!(
        paint_account_annotation(&json!({
            "balance": { "balance": 0.004, "currency": { "symbol": "$" } }
        })),
        "<$0.01"
    );
}

#[test]
fn test_ratatui_app_command_picker_parked_callbacks_and_full_render() {
    let mut app = RatatuiApp::new("sess-1", "~/projects/harness");

    // Seed session document with a user turn and assistant turn
    let mut root = EntityNode::new("root-1", "SessionRoot");
    root.properties
        .insert("permissionMode".to_string(), json!("auto"));
    root.children = vec!["t1".to_string(), "t2".to_string()];
    app.session_doc.insert_entity(root);

    let mut t1 = EntityNode::new("t1", "UserTurn");
    t1.properties
        .insert("prompt".to_string(), json!("Hello Ratatui"));
    app.session_doc.insert_entity(t1);

    let mut t2 = EntityNode::new("t2", "AssistantTurn");
    t2.properties
        .insert("text".to_string(), json!("Ready without Scheme!"));
    app.session_doc.insert_entity(t2);

    // Seed a driver with an adoptable offer
    app.kernel_ui.drivers.push(DriverUiSpec {
        name: "openai-compat".to_string(),
        description: "OpenAI-compatible".to_string(),
        multiplicity: "many".to_string(),
        ability_claim: vec!["completion".to_string()],
        offers: vec![json!({
            "name": "Custom OpenAI",
            "description": "API key",
            "adoptable": true,
            "settings": { "baseUrl": "https://api.openai.com/v1" }
        })],
    });

    // 1. Type `/co` (shows `/compact` and `/connect`), then `n` (`/con`) and Tab-complete to `/connect `
    app.type_text("/co");
    assert!(app.at_catalog());
    assert_eq!(app.composer_state.ui_choices.len(), 2);
    assert_eq!(app.composer_state.ui_choices[0].name, "/compact");
    assert_eq!(app.composer_state.ui_choices[1].name, "/connect");
    app.type_text("n");
    assert_eq!(app.composer_state.ui_choices.len(), 1);
    assert_eq!(app.composer_state.ui_choices[0].name, "/connect");
    app.handle_key("Tab", false, false, false);
    assert_eq!(app.composer_state.text, "/connect ");
    assert_eq!(app.composer_state.ui_choices.len(), 1);
    assert_eq!(app.composer_state.ui_choices[0].name, "Custom OpenAI");

    // 2. Render full RatatuiApp with `/connect ` picker open
    let area = Rect::new(0, 0, 80, 16);
    let mut buf = Buffer::empty(area);
    app.render(area, &mut buf);
    let lines = buffer_to_lines(&buf);
    assert!(lines.iter().any(|l| l.contains("~/projects/harness")));
    assert!(lines.iter().any(|l| l.contains("Hello Ratatui")));
    assert!(lines.iter().any(|l| l.contains("Ready without Scheme!")));
    assert!(lines.iter().any(|l| l.contains("Custom OpenAI")));

    // 3. Press Enter on `Custom OpenAI` -> emits `connect/adopt`
    app.handle_key("Enter", false, false, false);
    let rpcs = app.take_outbound_rpc();
    assert_eq!(rpcs.len(), 1);
    assert_eq!(rpcs[0].method, "connect/adopt");
    assert_eq!(rpcs[0].params["name"], "Custom OpenAI");

    // 4. Daemon replies with a parked secret `input` UI form for the API key
    let secret_form = RpcResponse::ok(
        rpcs[0].id.clone(),
        json!({
            "form": "ui",
            "pending": "p-key-1",
            "body": r#"{"kind":"input","name":"API key","description":"Paste your secret API key","secret":true}"#
        }),
    );
    app.handle_rpc_response(&secret_form);
    assert!(app.callback.is_some());

    // Type secret key and verify it renders masked with `•`
    app.type_text("sk-secret");
    let mut secret_buf = Buffer::empty(area);
    app.render(area, &mut secret_buf);
    let secret_lines = buffer_to_lines(&secret_buf);
    assert!(secret_lines.iter().any(|l| l.contains("Paste your secret API key")));
    assert!(secret_lines.iter().any(|l| l.contains("•••••••••")));
    assert!(!secret_lines.iter().any(|l| l.contains("sk-secret")));

    // Submit the secret input -> emits `ui/resolve` with `{ pending: "p-key-1", kind: "text", input: "sk-secret" }`
    app.handle_key("Enter", false, false, false);
    let resolve_rpcs = app.take_outbound_rpc();
    assert_eq!(resolve_rpcs.len(), 1);
    assert_eq!(resolve_rpcs[0].method, "ui/resolve");
    assert_eq!(resolve_rpcs[0].params["pending"], "p-key-1");
    assert_eq!(resolve_rpcs[0].params["kind"], "text");
    assert_eq!(resolve_rpcs[0].params["input"], "sk-secret");

    // 5. Test `open-url` callback with input hole: empty Enter opens URL and transitions to `oauth_waiting`, Escape cancels
    app.park_ui_form(UiForm {
        form: "ui".to_string(),
        pending: "p-oauth-1".to_string(),
        body: r#"{"kind":"open-url","url":"https://auth.example.com/authorize","name":"Authorize","description":"Sign in with browser","input":"text"}"#.to_string(),
    });
    app.handle_key("Enter", false, false, false);
    assert_eq!(app.opened_urls, vec!["https://auth.example.com/authorize"]);
    assert!(app.callback.as_ref().unwrap().oauth_waiting);
    let oauth_rpcs = app.take_outbound_rpc();
    assert_eq!(oauth_rpcs.len(), 1);
    assert_eq!(oauth_rpcs[0].method, "ui/resolve");
    assert_eq!(oauth_rpcs[0].params["kind"], "opened");

    // Press Escape while waiting for browser -> cancels OAuth wait
    app.handle_key("Escape", false, false, false);
    assert!(app.callback.is_none());
    let cancel_rpcs = app.take_outbound_rpc();
    assert_eq!(cancel_rpcs.len(), 1);
    assert_eq!(cancel_rpcs[0].method, "ui/resolve");
    assert_eq!(cancel_rpcs[0].params["kind"], "cancel");

    // 6. Test `connect/adopt` final response `{ id: "openai" }` jumping to `/model`
    let adopt_done = RpcResponse::ok(99, json!({ "id": "openai" }));
    app.handle_rpc_response(&adopt_done);
    assert_eq!(app.composer_state.text, "/model");
    let kv_rpcs = app.take_outbound_rpc();
    assert_eq!(kv_rpcs.len(), 1);
    assert_eq!(kv_rpcs[0].method, "kv/set");
    assert_eq!(kv_rpcs[0].params["key"], "connection");
    assert_eq!(kv_rpcs[0].params["value"], "openai");

    // 7. Test pending ask approval via LiveShape + `y` key
    app.composer_state.clear();
    app.pending_asks.apply_frame(
        ShapeFrame::Snapshot {
            subscription_id: "sub-asks".to_string(),
            offset: 1,
            items: vec![PendingAskRow {
                job_id: "job-77".to_string(),
                session_id: "sess-1".to_string(),
                turn_id: "t2".to_string(),
                kind: PendingAskKind::Ask,
                object: "shell".to_string(),
                summary: "Run cargo test?".to_string(),
                created_at_ms: 1000,
            }],
        },
        |r| r.job_id.clone(),
    );
    let mut qd_buf = create_buffer(80, 16);
    app.render_to_qd(&mut qd_buf);
    let qd_text: String = qd_buf.cells().iter().map(|c| c.ch.as_str()).collect();
    assert!(qd_text.contains("Run cargo test?"));

    app.handle_key("y", false, false, false);
    let ask_rpcs = app.take_outbound_rpc();
    assert_eq!(ask_rpcs.len(), 1);
    assert_eq!(ask_rpcs[0].method, "ask/answer");
    assert_eq!(ask_rpcs[0].params["jobId"], "job-77");
    assert_eq!(ask_rpcs[0].params["allow"], true);
}

#[test]
fn test_ratatui_app_apply_down_frame_and_paint_ansi_diffing() {
    let mut app = RatatuiApp::new("sess-down-1", "~/projects/quickdraw");
    assert!(app.dirty);

    // 1. Apply `state_init` frame
    let init_frame = serde_json::to_vec(&json!({
        "kind": "state_init",
        "snapshot": {
            "session_id": "sess-down-1",
            "revision": 1,
            "root_id": "root-1",
            "entities": {
                "root-1": {
                    "uuid": "root-1",
                    "tag": "SessionRoot",
                    "properties": { "permissionMode": "auto" },
                    "children": ["turn-1", "turn-2"]
                },
                "turn-1": {
                    "uuid": "turn-1",
                    "tag": "UserTurn",
                    "properties": { "prompt": "Initial user prompt" }
                },
                "turn-2": {
                    "uuid": "turn-2",
                    "tag": "AssistantTurn",
                    "properties": { "text": "Initial assistant response" }
                }
            }
        }
    }))
    .unwrap();

    assert_eq!(app.apply_down_frame(&init_frame), Ok(true));
    assert!(app.dirty);
    assert_eq!(app.session_doc.revision, 1);

    // First paint_ansi emits full ANSI for all 16 rows
    let first_stats = app.paint_ansi(80, 16, true, false);
    assert!(!app.dirty);
    assert_eq!(first_stats.dirty_rows, 16);
    assert!(first_stats.bytes > 0);
    assert!(first_stats.ansi.starts_with("\u{001B}[?2026h\u{001B}[2J"));
    assert!(first_stats.ansi.ends_with("\u{001B}[?2026l"));
    assert!(first_stats.ansi.contains("Initial user prompt"));
    assert!(first_stats.ansi.contains("Initial assistant response"));

    // Second paint_ansi on unchanged state emits 0 dirty rows and 0 bytes
    let second_stats = app.paint_ansi(80, 16, true, false);
    assert_eq!(second_stats.dirty_rows, 0);
    assert_eq!(second_stats.bytes, 0);
    assert!(second_stats.ansi.is_empty());

    // 2. Keystroke marks app dirty and paint_ansi only emits the changed composer row
    app.type_text("hello");
    assert!(app.dirty);
    let key_stats = app.paint_ansi(80, 16, true, false);
    assert!(!app.dirty);
    assert!(key_stats.dirty_rows > 0 && key_stats.dirty_rows < 16);
    assert_eq!(key_stats.dirty_rows, 1);
    assert!(key_stats.ansi.contains("hello"));

    // 3. Apply `state_patch` frame updating assistant turn text
    let patch_frame = serde_json::to_vec(&json!({
        "kind": "state_patch",
        "revision": 2,
        "patches": [
            {
                "op": "set",
                "nodeId": "turn-2",
                "field": "text",
                "value": "Patched assistant response!"
            }
        ]
    }))
    .unwrap();

    assert_eq!(app.apply_down_frame(&patch_frame), Ok(true));
    assert!(app.dirty);
    assert_eq!(app.session_doc.revision, 2);

    let patch_stats = app.paint_ansi(80, 16, true, false);
    assert!(!app.dirty);
    assert!(patch_stats.dirty_rows > 0 && patch_stats.dirty_rows < 16);
    assert!(patch_stats.ansi.contains("Patched assistant response!"));

    // 4. Apply `ui_eval` frame with command and choice definition
    let ui_eval_frame = serde_json::to_vec(&json!({
        "kind": "ui_eval",
        "command": "custom",
        "definition": {
            "kind": "choice",
            "choices": [
                {
                    "kind": "choice",
                    "name": "FastMode",
                    "description": "Enable low-latency mode"
                },
                {
                    "kind": "choice",
                    "name": "DeepMode",
                    "description": "Enable deep verification"
                }
            ]
        }
    }))
    .unwrap();

    assert_eq!(app.apply_down_frame(&ui_eval_frame), Ok(true));
    assert!(app.dirty);
    assert_eq!(app.composer_state.text, "/custom ");
    assert_eq!(app.composer_state.ui_choices.len(), 2);
    assert_eq!(app.composer_state.ui_choices[0].name, "FastMode");

    let ui_stats = app.paint_ansi(80, 16, true, false);
    assert!(!app.dirty);
    assert!(ui_stats.dirty_rows > 0 && ui_stats.dirty_rows < 16);
    assert!(ui_stats.ansi.contains("FastMode"));
    assert!(ui_stats.ansi.contains("DeepMode"));

    // Unknown frame kind returns Ok(false) without marking dirty
    let unknown_frame = br#"{"kind":"paint_init"}"#;
    assert_eq!(app.apply_down_frame(unknown_frame), Ok(false));
    assert!(!app.dirty);
}
