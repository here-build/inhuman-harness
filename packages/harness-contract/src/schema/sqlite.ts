import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
  KernelStateRow,
  KernelStateRowInsert,
  PendingAskRow,
  PendingAskRowInsert,
  PluginStateLogRow,
  PluginStateLogRowInsert,
  ProjectRow,
  ProjectRowInsert,
  ScmResourceRow,
  ScmResourceRowInsert,
  ScopeNodeRow,
  ScopeNodeRowInsert,
  SessionBlobRow,
  SessionBlobRowInsert,
  SessionEffectRow,
  SessionEffectRowInsert,
  SessionNodeRow,
  SessionNodeRowInsert,
  SessionRow,
  SessionRowInsert,
  SessionTurnRow,
  SessionTurnRowInsert,
} from "./rows.js";

export * from "./rows.js";

/**
 * Canonical Drizzle SQLite schema for the Harness Agent DB runtime (11 tables).
 * Every table uses a single-column string primary key without NUL bytes and carries
 * `kernel_id` (default `'local'`) so the exact same row model works over local
 * SQLite WAL (`harness.db`) and multi-tenant PostgreSQL + ElectricSQL / PGlite.
 */

export const kernelStateTable = sqliteTable(
  "kernel_state",
  {
    id: text("id").primaryKey().default("local"),
    kernelId: text("kernel_id").notNull().default("local"),
    defaultModel: text("default_model").notNull().default(""),
    permissionMode: text("permission_mode").notNull().default("manual"),
    enabledPluginsJson: text("enabled_plugins_json").notNull().default("[]"),
    kvsJson: text("kvs_json").notNull().default("{}"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_kernel_state_kernel").on(t.kernelId)],
);

export const projectsTable = sqliteTable(
  "projects",
  {
    projectId: text("project_id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    title: text("title").notNull().default(""),
    kind: text("kind", { enum: ["local", "remote", "virtual"] })
      .notNull()
      .default("local"),
    workspacePath: text("workspace_path"),
    defaultPermissionMode: text("default_permission_mode").notNull().default("manual"),
    authorizationJson: text("authorization_json").notNull().default("{}"),
    kvsJson: text("kvs_json").notNull().default("{}"),
    lastUsedModelJson: text("last_used_model_json").notNull().default("{}"),
    enabledPluginsJson: text("enabled_plugins_json").notNull().default("[]"),
    pluginConfigsJson: text("plugin_configs_json").notNull().default("{}"),
    botsRosterJson: text("bots_roster_json").notNull().default("{}"),
    trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
    contentHash: text("content_hash"),
    revision: integer("revision").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("idx_projects_kernel").on(t.kernelId, t.updatedAtMs),
    index("idx_projects_workspace").on(t.kernelId, t.workspacePath),
  ],
);

export const scopeNodesTable = sqliteTable(
  "scope_nodes",
  {
    id: text("id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    scopeId: text("scope_id").notNull(),
    nodeId: text("node_id").notNull(),
    tag: text("tag").notNull(),
    isRoot: integer("is_root", { mode: "boolean" }).notNull().default(false),
    revision: integer("revision").notNull(),
    rowJson: text("row_json").notNull(),
  },
  (t) => [
    index("idx_scope_nodes_scope").on(t.scopeId),
    index("idx_scope_nodes_kernel_scope").on(t.kernelId, t.scopeId),
  ],
);

export const sessionsTable = sqliteTable(
  "sessions",
  {
    sessionId: text("session_id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    projectId: text("project_id").notNull().default(""),
    title: text("title").notNull().default(""),
    workspacePath: text("workspace_path").notNull().default(""),
    mode: text("mode", { enum: ["assistant", "agentic"] })
      .notNull()
      .default("assistant"),
    permissionMode: text("permission_mode").notNull().default("manual"),
    running: integer("running", { mode: "boolean" }).notNull().default(false),
    headTurnId: text("head_turn_id"),
    parentSessionId: text("parent_session_id"),
    parentCallId: text("parent_call_id"),
    depth: integer("depth").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    createdAtMs: integer("created_at_ms").notNull(),
    lastActiveAtMs: integer("last_active_at_ms").notNull(),
    archivedAtMs: integer("archived_at_ms"),
  },
  (t) => [
    index("idx_sessions_active_recent").on(t.archivedAtMs, t.running, t.lastActiveAtMs),
    index("idx_sessions_kernel_active_recent").on(t.kernelId, t.archivedAtMs, t.running, t.lastActiveAtMs),
    index("idx_sessions_parent").on(t.parentSessionId, t.parentCallId),
    index("idx_sessions_workspace").on(t.workspacePath, t.lastActiveAtMs),
    index("idx_sessions_kernel_project").on(t.kernelId, t.projectId, t.lastActiveAtMs),
  ],
);

export const pendingAsksTable = sqliteTable(
  "pending_asks",
  {
    jobId: text("job_id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    kind: text("kind", { enum: ["ask", "ack"] }).notNull(),
    object: text("object").notNull(),
    summary: text("summary").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("idx_pending_asks_session").on(t.sessionId),
    index("idx_pending_asks_kernel_session").on(t.kernelId, t.sessionId),
  ],
);

export const sessionTurnsTable = sqliteTable(
  "session_turns",
  {
    turnId: text("turn_id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: ["running", "completed", "cancelled", "failed", "interrupted"] }).notNull(),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    reducerExited: integer("reducer_exited", { mode: "boolean" }).notNull().default(false),
    startedAtMs: integer("started_at_ms").notNull(),
    endedAtMs: integer("ended_at_ms"),
  },
  (t) => [
    index("idx_session_turns_order").on(t.sessionId, t.ordinal),
    index("idx_session_turns_kernel_order").on(t.kernelId, t.sessionId, t.ordinal),
  ],
);

export const sessionNodesTable = sqliteTable(
  "session_nodes",
  {
    id: text("id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    tag: text("tag").notNull(),
    isRoot: integer("is_root", { mode: "boolean" }).notNull().default(false),
    revision: integer("revision").notNull(),
    rowJson: text("row_json").notNull(),
  },
  (t) => [
    index("idx_session_nodes_session").on(t.sessionId),
    index("idx_session_nodes_kernel_session").on(t.kernelId, t.sessionId),
  ],
);

export const sessionEffectsTable = sqliteTable(
  "session_effects",
  {
    id: text("id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    effectKey: text("effect_key").notNull(),
    kind: text("kind", { enum: ["commit", "command", "effect"] }).notNull(),
    phase: text("phase", { enum: ["intent", "result", "committed"] })
      .notNull()
      .default("committed"),
    inputHash: text("input_hash").notNull(),
    outcomeJson: text("outcome_json").notNull(),
    revision: integer("revision").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("idx_session_effects_session").on(t.sessionId),
    index("idx_session_effects_kernel_session").on(t.kernelId, t.sessionId),
  ],
);

export const sessionBlobsTable = sqliteTable(
  "session_blobs",
  {
    id: text("id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    blobId: text("blob_id").notNull(),
    turnId: text("turn_id"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("idx_session_blobs_session").on(t.sessionId),
    index("idx_session_blobs_kernel_session").on(t.kernelId, t.sessionId),
    index("idx_session_blobs_blob_id").on(t.blobId),
  ],
);

export const scmResourcesTable = sqliteTable(
  "scm_resources",
  {
    id: text("id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    scope: text("scope", { enum: ["kernel", "project"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    kind: text("kind", { enum: ["policy", "bot", "command", "behavior"] }).notNull(),
    name: text("name").notNull(),
    source: text("source").notNull(),
    sha256: text("sha256").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_scm_resources_kernel_scope").on(t.kernelId, t.scope, t.scopeId, t.kind)],
);

export const pluginStateLogsTable = sqliteTable(
  "plugin_state_logs",
  {
    id: text("id").primaryKey(),
    kernelId: text("kernel_id").notNull().default("local"),
    plugin: text("plugin").notNull(),
    scope: text("scope", { enum: ["global", "project"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    namespace: text("namespace").notNull().default("default"),
    logJson: text("log_json").notNull().default("[]"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_plugin_state_logs_kernel_scope").on(t.kernelId, t.plugin, t.scope, t.scopeId)],
);

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _schemaParity: [
  AssertExact<KernelStateRow, InferSelectModel<typeof kernelStateTable>>,
  AssertExact<KernelStateRowInsert, InferInsertModel<typeof kernelStateTable>>,
  AssertExact<ProjectRow, InferSelectModel<typeof projectsTable>>,
  AssertExact<ProjectRowInsert, InferInsertModel<typeof projectsTable>>,
  AssertExact<ScopeNodeRow, InferSelectModel<typeof scopeNodesTable>>,
  AssertExact<ScopeNodeRowInsert, InferInsertModel<typeof scopeNodesTable>>,
  AssertExact<SessionRow, InferSelectModel<typeof sessionsTable>>,
  AssertExact<SessionRowInsert, InferInsertModel<typeof sessionsTable>>,
  AssertExact<Omit<PendingAskRow, "id">, InferSelectModel<typeof pendingAsksTable>>,
  AssertExact<PendingAskRowInsert, InferInsertModel<typeof pendingAsksTable>>,
  AssertExact<SessionTurnRow, InferSelectModel<typeof sessionTurnsTable>>,
  AssertExact<SessionTurnRowInsert, InferInsertModel<typeof sessionTurnsTable>>,
  AssertExact<SessionNodeRow, InferSelectModel<typeof sessionNodesTable>>,
  AssertExact<SessionNodeRowInsert, InferInsertModel<typeof sessionNodesTable>>,
  AssertExact<SessionEffectRow, InferSelectModel<typeof sessionEffectsTable>>,
  AssertExact<SessionEffectRowInsert, InferInsertModel<typeof sessionEffectsTable>>,
  AssertExact<SessionBlobRow, InferSelectModel<typeof sessionBlobsTable>>,
  AssertExact<SessionBlobRowInsert, InferInsertModel<typeof sessionBlobsTable>>,
  AssertExact<ScmResourceRow, InferSelectModel<typeof scmResourcesTable>>,
  AssertExact<ScmResourceRowInsert, InferInsertModel<typeof scmResourcesTable>>,
  AssertExact<PluginStateLogRow, InferSelectModel<typeof pluginStateLogsTable>>,
  AssertExact<PluginStateLogRowInsert, InferInsertModel<typeof pluginStateLogsTable>>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
void _schemaParity;

export const HARNESS_SQLITE_DDL = [
  `CREATE TABLE IF NOT EXISTS kernel_state (
  id TEXT PRIMARY KEY DEFAULT 'local',
  kernel_id TEXT NOT NULL DEFAULT 'local',
  default_model TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'manual',
  enabled_plugins_json TEXT NOT NULL DEFAULT '[]',
  kvs_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_kernel_state_kernel ON kernel_state (kernel_id);`,
  `CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'local',
  workspace_path TEXT,
  default_permission_mode TEXT NOT NULL DEFAULT 'manual',
  authorization_json TEXT NOT NULL DEFAULT '{}',
  kvs_json TEXT NOT NULL DEFAULT '{}',
  last_used_model_json TEXT NOT NULL DEFAULT '{}',
  enabled_plugins_json TEXT NOT NULL DEFAULT '[]',
  plugin_configs_json TEXT NOT NULL DEFAULT '{}',
  bots_roster_json TEXT NOT NULL DEFAULT '{}',
  trusted INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_projects_kernel ON projects (kernel_id, updated_at_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects (kernel_id, workspace_path);`,
  `CREATE TABLE IF NOT EXISTS scope_nodes (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  scope_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  row_json TEXT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_scope_nodes_scope ON scope_nodes (scope_id);`,
  `CREATE INDEX IF NOT EXISTS idx_scope_nodes_kernel_scope ON scope_nodes (kernel_id, scope_id);`,
  `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  project_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'assistant',
  permission_mode TEXT NOT NULL DEFAULT 'manual',
  running INTEGER NOT NULL DEFAULT 0,
  head_turn_id TEXT,
  parent_session_id TEXT,
  parent_call_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  last_active_at_ms INTEGER NOT NULL,
  archived_at_ms INTEGER
);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_active_recent ON sessions (archived_at_ms, running, last_active_at_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_kernel_active_recent ON sessions (kernel_id, archived_at_ms, running, last_active_at_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id, parent_call_id);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions (workspace_path, last_active_at_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_kernel_project ON sessions (kernel_id, project_id, last_active_at_ms);`,
  `CREATE TABLE IF NOT EXISTS pending_asks (
  job_id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_pending_asks_session ON pending_asks (session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_pending_asks_kernel_session ON pending_asks (kernel_id, session_id);`,
  `CREATE TABLE IF NOT EXISTS session_turns (
  turn_id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  reducer_exited INTEGER NOT NULL DEFAULT 0,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_turns_order ON session_turns (session_id, ordinal);`,
  `CREATE INDEX IF NOT EXISTS idx_session_turns_kernel_order ON session_turns (kernel_id, session_id, ordinal);`,
  `CREATE TABLE IF NOT EXISTS session_nodes (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  row_json TEXT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_nodes_session ON session_nodes (session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_nodes_kernel_session ON session_nodes (kernel_id, session_id);`,
  `CREATE TABLE IF NOT EXISTS session_effects (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  effect_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'committed',
  input_hash TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_effects_session ON session_effects (session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_effects_kernel_session ON session_effects (kernel_id, session_id);`,
  `CREATE TABLE IF NOT EXISTS session_blobs (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  turn_id TEXT,
  created_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_blobs_session ON session_blobs (session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_blobs_kernel_session ON session_blobs (kernel_id, session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_blobs_blob_id ON session_blobs (blob_id);`,
  `CREATE TABLE IF NOT EXISTS scm_resources (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_scm_resources_kernel_scope ON scm_resources (kernel_id, scope, scope_id, kind);`,
  `CREATE TABLE IF NOT EXISTS plugin_state_logs (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL DEFAULT 'local',
  plugin TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  log_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_plugin_state_logs_kernel_scope ON plugin_state_logs (kernel_id, plugin, scope, scope_id);`,
] as const;

export const bootstrapHarnessSqliteSql = `${HARNESS_SQLITE_DDL.join("\n\n")}\n`;
