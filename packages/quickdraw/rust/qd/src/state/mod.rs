//! Daemon state, LiveShape lanes, session document sync, and wire frame codecs.

pub mod session;
pub mod shapes;
pub mod sync;
pub mod ui;

pub use session::{EntityNode, ModelPatchOp, SessionDocumentState};
pub use shapes::{
    KernelRow, LiveShape, PendingAskKind, PendingAskRow, SessionSummaryRow, ShapeFrame, ShapeOp,
};
pub use sync::{
    decode_wire_frame, encode_wire_frame, RpcError, RpcNotification, RpcRequest, RpcResponse,
    SyncCodecError, WireFrame, MESSAGE_AWARENESS, MESSAGE_QUERY_AWARENESS, MESSAGE_SHAPE,
    MESSAGE_SYNC, TAG_JSON_RPC,
};
pub use ui::{
    auth_line, best_model, build_compact_surface, build_connect_surface, build_mcp_surface,
    build_model_surface, connect_choices, encode_ui_definition, eval_ui_def, eval_ui_surface,
    fill_params, goal_status_line, has_input_hole, is_activatable, mcp_connection_choices,
    model_choices, paint_account_annotation, parse_ui_definition, parse_ui_form, plan_status_line,
    primary_display_name, ui_action, ui_choice, ui_confirm, ui_input, ui_notice, ui_open_url,
    url_from, CommandUiSpec, ConnectionUiSpec, DriverUiSpec, KernelUiSnapshot, SessionUiSnapshot,
    UiActionInput, UiChoiceInput, UiContext, UiDefinition, UiEvalConfig, UiForm, UiHealth,
    UiInputKind, UiNode,
};
