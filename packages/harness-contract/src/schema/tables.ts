import { bootstrapHarnessPostgresSql } from "./postgres.js";

/**
 * Pure runtime table and column metadata for the 11 canonical Agent DB tables.
 * Browser-safe and Drizzle-free so `scope-plane`, `scope-plane-electric`, and
 * `scope-plane-tinybase` consume the exact same canonical table surface.
 */
export const HARNESS_TABLE_NAMES = [
  "kernel_state",
  "projects",
  "scope_nodes",
  "sessions",
  "pending_asks",
  "session_turns",
  "session_nodes",
  "session_effects",
  "session_blobs",
  "scm_resources",
  "plugin_state_logs",
] as const;

export type TableName = (typeof HARNESS_TABLE_NAMES)[number];
export type HarnessTableName = TableName;

export type CellKind = "string" | "number" | "boolean";

export type Column = {
  readonly name: string;
  readonly sql: string;
  readonly kind: CellKind;
  readonly required: boolean;
};

export type TableDef = {
  readonly name: TableName;
  readonly sql: string;
  readonly key: string;
  readonly keySql: string;
  readonly columns: readonly Column[];
};

function column(name: string, sql: string, kind: CellKind, required = false): Column {
  return { name, sql, kind, required };
}

export const tables: { readonly [Name in TableName]: TableDef } = {
  kernel_state: {
    name: "kernel_state",
    sql: "kernel_state",
    key: "id",
    keySql: "id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("defaultModel", "default_model", "string", true),
      column("permissionMode", "permission_mode", "string", true),
      column("enabledPluginsJson", "enabled_plugins_json", "string", true),
      column("kvsJson", "kvs_json", "string", true),
      column("updatedAtMs", "updated_at_ms", "number", true),
    ],
  },
  projects: {
    name: "projects",
    sql: "projects",
    key: "projectId",
    keySql: "project_id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("title", "title", "string", true),
      column("kind", "kind", "string", true),
      column("workspacePath", "workspace_path", "string"),
      column("defaultPermissionMode", "default_permission_mode", "string", true),
      column("authorizationJson", "authorization_json", "string", true),
      column("kvsJson", "kvs_json", "string", true),
      column("lastUsedModelJson", "last_used_model_json", "string", true),
      column("enabledPluginsJson", "enabled_plugins_json", "string", true),
      column("pluginConfigsJson", "plugin_configs_json", "string", true),
      column("botsRosterJson", "bots_roster_json", "string", true),
      column("trusted", "trusted", "boolean", true),
      column("contentHash", "content_hash", "string"),
      column("revision", "revision", "number", true),
      column("updatedAtMs", "updated_at_ms", "number", true),
    ],
  },
  scope_nodes: {
    name: "scope_nodes",
    sql: "scope_nodes",
    key: "id",
    keySql: "id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("scopeId", "scope_id", "string", true),
      column("nodeId", "node_id", "string", true),
      column("tag", "tag", "string", true),
      column("isRoot", "is_root", "boolean", true),
      column("revision", "revision", "number", true),
      column("rowJson", "row_json", "string", true),
    ],
  },
  sessions: {
    name: "sessions",
    sql: "sessions",
    key: "sessionId",
    keySql: "session_id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("projectId", "project_id", "string", true),
      column("title", "title", "string", true),
      column("workspacePath", "workspace_path", "string", true),
      column("mode", "mode", "string", true),
      column("permissionMode", "permission_mode", "string", true),
      column("running", "running", "boolean", true),
      column("headTurnId", "head_turn_id", "string"),
      column("parentSessionId", "parent_session_id", "string"),
      column("parentCallId", "parent_call_id", "string"),
      column("depth", "depth", "number", true),
      column("revision", "revision", "number", true),
      column("createdAtMs", "created_at_ms", "number", true),
      column("lastActiveAtMs", "last_active_at_ms", "number", true),
      column("archivedAtMs", "archived_at_ms", "number"),
    ],
  },
  pending_asks: {
    name: "pending_asks",
    sql: "pending_asks",
    key: "jobId",
    keySql: "job_id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("sessionId", "session_id", "string", true),
      column("turnId", "turn_id", "string", true),
      column("kind", "kind", "string", true),
      column("object", "object", "string", true),
      column("summary", "summary", "string", true),
      column("createdAtMs", "created_at_ms", "number", true),
    ],
  },
  session_turns: {
    name: "session_turns",
    sql: "session_turns",
    key: "turnId",
    keySql: "turn_id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("sessionId", "session_id", "string", true),
      column("ordinal", "ordinal", "number", true),
      column("prompt", "prompt", "string", true),
      column("status", "status", "string", true),
      column("cancelRequested", "cancel_requested", "boolean", true),
      column("reducerExited", "reducer_exited", "boolean", true),
      column("startedAtMs", "started_at_ms", "number", true),
      column("endedAtMs", "ended_at_ms", "number"),
    ],
  },
  session_nodes: {
    name: "session_nodes",
    sql: "session_nodes",
    key: "id",
    keySql: "id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("sessionId", "session_id", "string", true),
      column("nodeId", "node_id", "string", true),
      column("tag", "tag", "string", true),
      column("isRoot", "is_root", "boolean", true),
      column("revision", "revision", "number", true),
      column("rowJson", "row_json", "string", true),
    ],
  },
  session_effects: {
    name: "session_effects",
    sql: "session_effects",
    key: "id",
    keySql: "id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("sessionId", "session_id", "string", true),
      column("effectKey", "effect_key", "string", true),
      column("kind", "kind", "string", true),
      column("phase", "phase", "string", true),
      column("inputHash", "input_hash", "string", true),
      column("outcomeJson", "outcome_json", "string", true),
      column("revision", "revision", "number", true),
      column("createdAtMs", "created_at_ms", "number", true),
    ],
  },
  session_blobs: {
    name: "session_blobs",
    sql: "session_blobs",
    key: "id",
    keySql: "id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("sessionId", "session_id", "string", true),
      column("blobId", "blob_id", "string", true),
      column("turnId", "turn_id", "string"),
      column("createdAtMs", "created_at_ms", "number", true),
    ],
  },
  scm_resources: {
    name: "scm_resources",
    sql: "scm_resources",
    key: "id",
    keySql: "id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("scope", "scope", "string", true),
      column("scopeId", "scope_id", "string", true),
      column("kind", "kind", "string", true),
      column("name", "name", "string", true),
      column("source", "source", "string", true),
      column("sha256", "sha256", "string", true),
      column("updatedAtMs", "updated_at_ms", "number", true),
    ],
  },
  plugin_state_logs: {
    name: "plugin_state_logs",
    sql: "plugin_state_logs",
    key: "id",
    keySql: "id",
    columns: [
      column("kernelId", "kernel_id", "string", true),
      column("plugin", "plugin", "string", true),
      column("scope", "scope", "string", true),
      column("scopeId", "scope_id", "string", true),
      column("namespace", "namespace", "string", true),
      column("logJson", "log_json", "string", true),
      column("updatedAtMs", "updated_at_ms", "number", true),
    ],
  },
};

export function columnOf(table: TableName, name: string): Column | undefined {
  return tables[table].columns.find((field) => field.name === name);
}

/** Canonical PostgreSQL DDL for server/cloud Agent DB & ElectricSQL / PGlite runtimes. */
export function schemaSql(): string {
  return bootstrapHarnessPostgresSql;
}
