/**
 * Canonical PostgreSQL + ElectricSQL / PGlite DDL matching `HARNESS_SQLITE_DDL`.
 * Sets `REPLICA IDENTITY FULL` on replicated tables so ElectricSQL `/v1/shape`
 * streams carry full row context across single-table `WHERE` predicates.
 */

export const HARNESS_POSTGRES_DDL = [
  `CREATE TABLE IF NOT EXISTS kernel_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  default_model TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  kvs_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms BIGINT NOT NULL
);`,
  `ALTER TABLE kernel_state REPLICA IDENTITY FULL;`,
  `CREATE TABLE IF NOT EXISTS scope_nodes (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  is_root BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL,
  row_json TEXT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_scope_nodes_scope ON scope_nodes (scope_id);`,
  `ALTER TABLE scope_nodes REPLICA IDENTITY FULL;`,
  `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'assistant',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  running BOOLEAN NOT NULL DEFAULT FALSE,
  head_turn_id TEXT,
  parent_session_id TEXT,
  parent_call_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at_ms BIGINT NOT NULL,
  last_active_at_ms BIGINT NOT NULL,
  archived_at_ms BIGINT
);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_active_recent ON sessions (archived_at_ms, running, last_active_at_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id, parent_call_id);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions (workspace_path, last_active_at_ms);`,
  `ALTER TABLE sessions REPLICA IDENTITY FULL;`,
  `CREATE TABLE IF NOT EXISTS pending_asks (
  job_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_pending_asks_session ON pending_asks (session_id);`,
  `ALTER TABLE pending_asks REPLICA IDENTITY FULL;`,
  `CREATE TABLE IF NOT EXISTS session_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  reducer_exited BOOLEAN NOT NULL DEFAULT FALSE,
  started_at_ms BIGINT NOT NULL,
  ended_at_ms BIGINT
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_turns_order ON session_turns (session_id, ordinal);`,
  `ALTER TABLE session_turns REPLICA IDENTITY FULL;`,
  `CREATE TABLE IF NOT EXISTS session_nodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  is_root BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL,
  row_json TEXT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_nodes_session ON session_nodes (session_id);`,
  `ALTER TABLE session_nodes REPLICA IDENTITY FULL;`,
  `CREATE TABLE IF NOT EXISTS session_effects (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  effect_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'committed',
  input_hash TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_effects_session ON session_effects (session_id);`,
  `CREATE TABLE IF NOT EXISTS session_blobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  turn_id TEXT,
  created_at_ms BIGINT NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_session_blobs_session ON session_blobs (session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_blobs_blob_id ON session_blobs (blob_id);`,
] as const;

export const bootstrapHarnessPostgresSql = `${HARNESS_POSTGRES_DDL.join("\n\n")}\n`;
