import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Canonical Drizzle SQLite schema for the Harness runtime.
 * Backs WAL-mode SQLite storage locally and defines compile-time & runtime
 * schemas for `@inhuman.tools/model` and `@inhuman.tools/turn`.
 */

export const kernelStateTable = sqliteTable("kernel_state", {
  id: text("id").primaryKey().default("singleton"),
  defaultModel: text("default_model").notNull().default(""),
  permissionMode: text("permission_mode").notNull().default("ask"),
  kvsJson: text("kvs_json").notNull().default("{}"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const sessionsTable = sqliteTable(
  "sessions",
  {
    sessionId: text("session_id").primaryKey(),
    title: text("title").notNull().default(""),
    workspacePath: text("workspace_path").notNull().default(""),
    mode: text("mode", { enum: ["assistant", "agentic"] })
      .notNull()
      .default("assistant"),
    permissionMode: text("permission_mode").notNull().default("ask"),
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
    index("idx_sessions_parent").on(t.parentSessionId, t.parentCallId),
    index("idx_sessions_workspace").on(t.workspacePath, t.lastActiveAtMs),
  ],
);

export const pendingAsksTable = sqliteTable(
  "pending_asks",
  {
    jobId: text("job_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    kind: text("kind", { enum: ["ask", "ack"] }).notNull(),
    object: text("object").notNull(),
    summary: text("summary").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [index("idx_pending_asks_session").on(t.sessionId)],
);

export const sessionTurnsTable = sqliteTable(
  "session_turns",
  {
    turnId: text("turn_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: ["running", "completed", "cancelled", "failed", "interrupted"] }).notNull(),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    reducerExited: integer("reducer_exited", { mode: "boolean" }).notNull().default(false),
    snapshotJson: text("snapshot_json").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    endedAtMs: integer("ended_at_ms"),
  },
  (t) => [index("idx_session_turns_order").on(t.sessionId, t.ordinal)],
);

export const sessionUpdatesTable = sqliteTable(
  "session_updates",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    incarnation: text("incarnation").notNull(),
    patchJson: text("patch_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.revision] })],
);

export const sessionEffectsTable = sqliteTable(
  "session_effects",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    effectKey: text("effect_key").notNull(),
    kind: text("kind", { enum: ["command", "effect"] }).notNull(),
    inputHash: text("input_hash").notNull(),
    outcomeJson: text("outcome_json").notNull(),
    revision: integer("revision").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.effectKey] })],
);

export const sessionBlobsTable = sqliteTable(
  "session_blobs",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    blobId: text("blob_id").notNull(),
    turnId: text("turn_id"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.blobId] }), index("idx_session_blobs_blob_id").on(t.blobId)],
);

export type KernelStateRow = InferSelectModel<typeof kernelStateTable>;
export type KernelStateRowInsert = InferInsertModel<typeof kernelStateTable>;

export type SessionRow = InferSelectModel<typeof sessionsTable>;
export type SessionRowInsert = InferInsertModel<typeof sessionsTable>;

export type PendingAskRow = InferSelectModel<typeof pendingAsksTable>;
export type PendingAskRowInsert = InferInsertModel<typeof pendingAsksTable>;

export type SessionTurnRow = InferSelectModel<typeof sessionTurnsTable>;
export type SessionTurnRowInsert = InferInsertModel<typeof sessionTurnsTable>;

export type SessionUpdateRow = InferSelectModel<typeof sessionUpdatesTable>;
export type SessionUpdateRowInsert = InferInsertModel<typeof sessionUpdatesTable>;

export type SessionEffectRow = InferSelectModel<typeof sessionEffectsTable>;
export type SessionEffectRowInsert = InferInsertModel<typeof sessionEffectsTable>;

export type SessionBlobRow = InferSelectModel<typeof sessionBlobsTable>;
export type SessionBlobRowInsert = InferInsertModel<typeof sessionBlobsTable>;

export const HARNESS_SQLITE_DDL = [
  `CREATE TABLE IF NOT EXISTS kernel_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  default_model TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  kvs_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'assistant',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
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
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id, parent_call_id);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions (workspace_path, last_active_at_ms);`,
  `CREATE TABLE IF NOT EXISTS pending_asks (
  job_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_pending_asks_session ON pending_asks (session_id);`,
  `CREATE TABLE IF NOT EXISTS session_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  reducer_exited INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_turns_order ON session_turns (session_id, ordinal);`,
  `CREATE TABLE IF NOT EXISTS session_updates (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  incarnation TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, revision)
);`,
  `CREATE TABLE IF NOT EXISTS session_effects (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  effect_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, effect_key)
);`,
  `CREATE TABLE IF NOT EXISTS session_blobs (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  turn_id TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, blob_id)
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_blobs_blob_id ON session_blobs (blob_id);`,
] as const;

export const bootstrapHarnessSqliteSql = `${HARNESS_SQLITE_DDL.join("\n\n")}\n`;
