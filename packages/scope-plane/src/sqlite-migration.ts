import { rowPairId } from "@inhuman.tools/harness-contract/schema";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";

type InspectableTable = "scope_nodes" | "session_nodes" | "session_turns" | "session_effects" | "session_blobs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTableColumns(sqlite: BetterSqliteDatabase, table: InspectableTable): Set<string> {
  const cols = new Set<string>();
  for (const row of sqlite.prepare(`PRAGMA table_info(${table})`).all()) {
    if (isRecord(row) && typeof row["name"] === "string") {
      cols.add(row["name"]);
    }
  }
  return cols;
}

function unpackLegacyContent(rawJson: string, payloads: ReadonlyMap<string, string>): string {
  if (payloads.size === 0) return rawJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return rawJson;
  }
  if (!isRecord(parsed) || parsed["format"] !== "content-v1" || !Array.isArray(parsed["texts"])) {
    return rawJson;
  }
  let value: unknown = parsed["value"];
  for (const ref of parsed["texts"]) {
    if (!isRecord(ref) || !Array.isArray(ref["path"]) || typeof ref["hash"] !== "string") continue;
    const text = payloads.get(ref["hash"]);
    if (text === undefined) continue;
    const path = ref["path"];
    if (path.length === 0) {
      value = text;
      continue;
    }
    let cursor: unknown = value;
    let valid = true;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if ((typeof seg !== "string" && typeof seg !== "number") || cursor === null || typeof cursor !== "object") {
        valid = false;
        break;
      }
      cursor = Reflect.get(cursor, seg);
    }
    const leaf = path[path.length - 1];
    if (
      valid &&
      (typeof leaf === "string" || typeof leaf === "number") &&
      cursor !== null &&
      typeof cursor === "object"
    ) {
      Reflect.set(cursor, leaf, text);
    }
  }
  return JSON.stringify(value);
}

function extractModelTag(rowJson: string): string {
  try {
    const parsed: unknown = JSON.parse(rowJson);
    if (isRecord(parsed) && typeof parsed["tag"] === "string") {
      return parsed["tag"];
    }
  } catch {
    // Keep empty tag fallback on malformed legacy rows.
  }
  return "";
}

/**
 * Upgrades pre-cutover SQLite tables in-place before `bootstrapHarnessSqliteSql` runs.
 * Preserves `scope_nodes`, `kernel_state`, and normalized `session_*` rows while dropping
 * retired Yjs/shared-payload tables. Returns `true` when a legacy migration was applied.
 */
export function migrateLegacySqliteSchema(sqlite: BetterSqliteDatabase): boolean {
  const existingTables = new Set<string>();
  for (const row of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (isRecord(row) && typeof row["name"] === "string") {
      existingTables.add(row["name"]);
    }
  }
  if (existingTables.size === 0) return false;

  const scopeNodesCols = existingTables.has("scope_nodes")
    ? readTableColumns(sqlite, "scope_nodes")
    : new Set<string>();
  const sessionNodesCols = existingTables.has("session_nodes")
    ? readTableColumns(sqlite, "session_nodes")
    : new Set<string>();
  const sessionTurnsCols = existingTables.has("session_turns")
    ? readTableColumns(sqlite, "session_turns")
    : new Set<string>();
  const sessionEffectsCols = existingTables.has("session_effects")
    ? readTableColumns(sqlite, "session_effects")
    : new Set<string>();
  const sessionBlobsCols = existingTables.has("session_blobs")
    ? readTableColumns(sqlite, "session_blobs")
    : new Set<string>();

  const migrateScopeNodes =
    scopeNodesCols.size > 0 &&
    (!scopeNodesCols.has("id") || !scopeNodesCols.has("tag") || !scopeNodesCols.has("is_root"));
  const migrateSessionNodes =
    sessionNodesCols.size > 0 &&
    (!sessionNodesCols.has("id") || !sessionNodesCols.has("tag") || !sessionNodesCols.has("is_root"));
  const migrateSessionTurns = sessionTurnsCols.size > 0 && sessionTurnsCols.has("snapshot_json");
  const migrateSessionEffects =
    sessionEffectsCols.size > 0 && (!sessionEffectsCols.has("id") || !sessionEffectsCols.has("phase"));
  const migrateSessionBlobs = sessionBlobsCols.size > 0 && !sessionBlobsCols.has("id");
  const hasSessionUpdates = existingTables.has("session_updates");
  const hasSessionDocuments = existingTables.has("session_documents");
  const hasSharedPayloads = existingTables.has("shared_payloads");

  if (
    !migrateScopeNodes &&
    !migrateSessionNodes &&
    !migrateSessionTurns &&
    !migrateSessionEffects &&
    !migrateSessionBlobs &&
    !hasSessionUpdates &&
    !hasSessionDocuments &&
    !hasSharedPayloads
  ) {
    return false;
  }

  sqlite.pragma("foreign_keys = OFF");
  try {
    const migrate = sqlite.transaction(() => {
      const payloads = new Map<string, string>();
      if (hasSharedPayloads) {
        for (const row of sqlite.prepare("SELECT hash, body FROM shared_payloads").all()) {
          if (!isRecord(row) || typeof row["hash"] !== "string" || typeof row["body"] !== "string") continue;
          try {
            const parsed: unknown = JSON.parse(row["body"]);
            payloads.set(row["hash"], typeof parsed === "string" ? parsed : row["body"]);
          } catch {
            payloads.set(row["hash"], row["body"]);
          }
        }
      }

      const sessionRootIds = new Map<string, string>();
      if (hasSessionDocuments) {
        for (const row of sqlite.prepare("SELECT session_id, header_json FROM session_documents").all()) {
          if (!isRecord(row) || typeof row["session_id"] !== "string" || typeof row["header_json"] !== "string") {
            continue;
          }
          const unpacked = unpackLegacyContent(row["header_json"], payloads);
          try {
            const header: unknown = JSON.parse(unpacked);
            if (!isRecord(header)) continue;
            if (isRecord(header["root"]) && typeof header["root"]["uuid"] === "string") {
              sessionRootIds.set(row["session_id"], header["root"]["uuid"]);
            } else if (typeof header["rootId"] === "string") {
              sessionRootIds.set(row["session_id"], header["rootId"]);
            }
          } catch {
            // Fall back to tag inspection on session_nodes.
          }
        }
      }

      if (migrateScopeNodes) {
        const legacyRows = sqlite.prepare("SELECT scope_id, node_id, revision, row_json FROM scope_nodes").all();
        sqlite.exec(`
          DROP TABLE scope_nodes;
          CREATE TABLE scope_nodes (
            id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            is_root INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL,
            row_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_scope_nodes_scope ON scope_nodes (scope_id);
        `);
        const insertScopeNode = sqlite.prepare(
          "INSERT INTO scope_nodes (id, scope_id, node_id, tag, is_root, revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        for (const row of legacyRows) {
          if (
            !isRecord(row) ||
            typeof row["scope_id"] !== "string" ||
            typeof row["node_id"] !== "string" ||
            typeof row["revision"] !== "number" ||
            typeof row["row_json"] !== "string"
          ) {
            continue;
          }
          const rowJson = unpackLegacyContent(row["row_json"], payloads);
          const tag = extractModelTag(rowJson);
          const isRoot = tag === "harness:kernel:root" || tag === "harness:project:root" ? 1 : 0;
          insertScopeNode.run(
            rowPairId(row["scope_id"], row["node_id"]),
            row["scope_id"],
            row["node_id"],
            tag,
            isRoot,
            row["revision"],
            rowJson,
          );
        }
      }

      if (migrateSessionNodes) {
        const legacyRows = sqlite.prepare("SELECT session_id, node_id, revision, row_json FROM session_nodes").all();
        sqlite.exec(`
          DROP TABLE session_nodes;
          CREATE TABLE session_nodes (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            is_root INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL,
            row_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_session_nodes_session ON session_nodes (session_id);
        `);
        const insertSessionNode = sqlite.prepare(
          "INSERT INTO session_nodes (id, session_id, node_id, tag, is_root, revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        for (const row of legacyRows) {
          if (
            !isRecord(row) ||
            typeof row["session_id"] !== "string" ||
            typeof row["node_id"] !== "string" ||
            typeof row["revision"] !== "number" ||
            typeof row["row_json"] !== "string"
          ) {
            continue;
          }
          const rowJson = unpackLegacyContent(row["row_json"], payloads);
          const tag = extractModelTag(rowJson);
          const isRoot =
            sessionRootIds.get(row["session_id"]) === row["node_id"] || tag === "harness:session:root" ? 1 : 0;
          insertSessionNode.run(
            rowPairId(row["session_id"], row["node_id"]),
            row["session_id"],
            row["node_id"],
            tag,
            isRoot,
            row["revision"],
            rowJson,
          );
        }
      }

      if (migrateSessionTurns) {
        const legacyRows = sqlite
          .prepare(
            "SELECT turn_id, session_id, ordinal, prompt, status, cancel_requested, reducer_exited, started_at_ms, ended_at_ms FROM session_turns",
          )
          .all();
        sqlite.exec(`
          DROP TABLE session_turns;
          CREATE TABLE session_turns (
            turn_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            status TEXT NOT NULL,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            reducer_exited INTEGER NOT NULL DEFAULT 0,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_session_turns_order ON session_turns (session_id, ordinal);
        `);
        const insertTurn = sqlite.prepare(
          "INSERT INTO session_turns (turn_id, session_id, ordinal, prompt, status, cancel_requested, reducer_exited, started_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const row of legacyRows) {
          if (
            !isRecord(row) ||
            typeof row["turn_id"] !== "string" ||
            typeof row["session_id"] !== "string" ||
            typeof row["ordinal"] !== "number" ||
            typeof row["prompt"] !== "string" ||
            typeof row["status"] !== "string" ||
            typeof row["cancel_requested"] !== "number" ||
            typeof row["reducer_exited"] !== "number" ||
            typeof row["started_at_ms"] !== "number"
          ) {
            continue;
          }
          const endedAtMs = typeof row["ended_at_ms"] === "number" ? row["ended_at_ms"] : null;
          insertTurn.run(
            row["turn_id"],
            row["session_id"],
            row["ordinal"],
            row["prompt"],
            row["status"],
            row["cancel_requested"],
            row["reducer_exited"],
            row["started_at_ms"],
            endedAtMs,
          );
        }
      }

      if (migrateSessionEffects) {
        const legacyRows = sqlite
          .prepare(
            "SELECT session_id, effect_key, kind, input_hash, outcome_json, revision, created_at_ms FROM session_effects",
          )
          .all();
        sqlite.exec(`
          DROP TABLE session_effects;
          CREATE TABLE session_effects (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            effect_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            phase TEXT NOT NULL DEFAULT 'committed',
            input_hash TEXT NOT NULL,
            outcome_json TEXT NOT NULL,
            revision INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_session_effects_session ON session_effects (session_id);
        `);
        const insertEffect = sqlite.prepare(
          "INSERT INTO session_effects (id, session_id, effect_key, kind, phase, input_hash, outcome_json, revision, created_at_ms) VALUES (?, ?, ?, ?, 'committed', ?, ?, ?, ?)",
        );
        for (const row of legacyRows) {
          if (
            !isRecord(row) ||
            typeof row["session_id"] !== "string" ||
            typeof row["effect_key"] !== "string" ||
            typeof row["kind"] !== "string" ||
            typeof row["input_hash"] !== "string" ||
            typeof row["outcome_json"] !== "string" ||
            typeof row["revision"] !== "number" ||
            typeof row["created_at_ms"] !== "number"
          ) {
            continue;
          }
          const outcomeJson = unpackLegacyContent(row["outcome_json"], payloads);
          insertEffect.run(
            rowPairId(row["session_id"], `${row["kind"]}:${row["effect_key"]}`),
            row["session_id"],
            row["effect_key"],
            row["kind"],
            row["input_hash"],
            outcomeJson,
            row["revision"],
            row["created_at_ms"],
          );
        }
      }

      if (migrateSessionBlobs) {
        const legacyRows = sqlite
          .prepare("SELECT session_id, blob_id, turn_id, created_at_ms FROM session_blobs")
          .all();
        sqlite.exec(`
          DROP TABLE session_blobs;
          CREATE TABLE session_blobs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            blob_id TEXT NOT NULL,
            turn_id TEXT,
            created_at_ms INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_session_blobs_session ON session_blobs (session_id);
          CREATE INDEX IF NOT EXISTS idx_session_blobs_blob_id ON session_blobs (blob_id);
        `);
        const insertBlob = sqlite.prepare(
          "INSERT INTO session_blobs (id, session_id, blob_id, turn_id, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        );
        for (const row of legacyRows) {
          if (
            !isRecord(row) ||
            typeof row["session_id"] !== "string" ||
            typeof row["blob_id"] !== "string" ||
            typeof row["created_at_ms"] !== "number"
          ) {
            continue;
          }
          const turnId = typeof row["turn_id"] === "string" ? row["turn_id"] : null;
          insertBlob.run(
            rowPairId(row["session_id"], row["blob_id"]),
            row["session_id"],
            row["blob_id"],
            turnId,
            row["created_at_ms"],
          );
        }
      }

      sqlite.exec(`
        DROP TABLE IF EXISTS session_updates;
        DROP TABLE IF EXISTS session_documents;
        DROP TABLE IF EXISTS shared_payloads;
      `);
    });
    migrate.immediate();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  return true;
}
