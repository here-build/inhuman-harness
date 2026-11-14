import {
  HARNESS_TABLE_NAMES,
  bootstrapHarnessSqliteSql,
  kernelStateTable,
  pendingAsksTable,
  pluginStateLogsTable,
  projectsTable,
  rowPairId,
  scmResourcesTable,
  scopeNodesTable,
  sessionBlobsTable,
  sessionEffectsTable,
  sessionNodesTable,
  sessionsTable,
  sessionTurnsTable,
  storedModelRowSchema,
  type HarnessTableName,
  type KernelStateRow,
  type KernelStateRowInsert,
  type PendingAskRow,
  type PendingAskRowInsert,
  type PluginStateLogRow,
  type PluginStateLogRowInsert,
  type PluginStateScope,
  type ProjectRow,
  type ProjectRowInsert,
  type ScmResourceKind,
  type ScmResourceRow,
  type ScmResourceRowInsert,
  type ScmResourceScope,
  type ScopeNodeRow,
  type SessionBlobRow,
  type SessionBlobRowInsert,
  type SessionEffectRow,
  type SessionEffectRowInsert,
  type SessionNodeRow,
  type SessionRow,
  type SessionRowInsert,
  type SessionTurnRow,
  type SessionTurnRowInsert,
} from "@inhuman.tools/harness-contract/schema";
import type { SerializedDocument, SerializedModelRow } from "@inhuman.tools/model";
import Database, { type Database as BetterSqliteDatabase, type Options as BetterSqliteOptions } from "better-sqlite3";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { migrateLegacySqliteSchema } from "./sqlite-migration.js";

export { HARNESS_TABLE_NAMES, type HarnessTableName };

export const harnessSchema = {
  kernelStateTable,
  projectsTable,
  scopeNodesTable,
  sessionsTable,
  pendingAsksTable,
  sessionTurnsTable,
  sessionNodesTable,
  sessionEffectsTable,
  sessionBlobsTable,
  scmResourcesTable,
  pluginStateLogsTable,
} as const;

export type HarnessSchema = typeof harnessSchema;

export type HarnessDrizzleTx = Parameters<Parameters<BetterSQLite3Database<HarnessSchema>["transaction"]>[0]>[0];

export interface TableRowDelta<TRow extends Record<string, unknown> = Record<string, unknown>> {
  readonly upserts: readonly TRow[];
  readonly deletes: readonly string[];
  readonly reset?: boolean;
}

export interface DatabaseCommitEvent {
  readonly touchedTables: readonly HarnessTableName[];
  readonly offset: number;
  readonly scopeNodeChanges?: ReadonlyMap<string, TableRowDelta<ScopeNodeRow>>;
  readonly sessionNodeChanges?: ReadonlyMap<string, TableRowDelta<SessionNodeRow>>;
}

export type DatabaseCommitListener = (event: DatabaseCommitEvent) => void;

export type HarnessDatabaseOptions = BetterSqliteOptions & {
  readonly kernelId?: string;
};

interface MutableRowDelta<TRow extends Record<string, unknown>> {
  readonly upserts: Map<string, TRow>;
  readonly deletes: Set<string>;
  reset: boolean;
}

function getOrInitDelta<TRow extends Record<string, unknown>>(
  map: Map<string, MutableRowDelta<TRow>>,
  key: string,
): MutableRowDelta<TRow> {
  let entry = map.get(key);
  if (!entry) {
    entry = { upserts: new Map(), deletes: new Set(), reset: false };
    map.set(key, entry);
  }
  return entry;
}

function scopeRowId(kernelId: string, scopeId: string, nodeId: string): string {
  return kernelId === "local" ? rowPairId(scopeId, nodeId) : rowPairId(`${kernelId}:${scopeId}`, nodeId);
}

function scopeDeltaKey(kernelId: string, scopeId: string): string {
  return `${kernelId}\0${scopeId}`;
}

function sessionDeltaKey(kernelId: string, sessionId: string): string {
  return `${kernelId}\0${sessionId}`;
}

let lastInitialCommitOffset = 0;

function mintInitialCommitOffset(): number {
  const candidate = Date.now() * 1000;
  lastInitialCommitOffset = candidate > lastInitialCommitOffset ? candidate : lastInitialCommitOffset + 1;
  return lastInitialCommitOffset;
}

export class HarnessDatabase implements Disposable {
  readonly #sqlite: BetterSqliteDatabase;
  readonly #drizzle: BetterSQLite3Database<HarnessSchema>;
  readonly #kernelId: string;
  readonly #commitListeners = new Set<DatabaseCommitListener>();
  #commitOffset = mintInitialCommitOffset();
  #txDepth = 0;
  #nestedTouchedTables: HarnessTableName[] = [];
  readonly #txScopeNodeChanges = new Map<string, MutableRowDelta<ScopeNodeRow>>();
  readonly #txSessionNodeChanges = new Map<string, MutableRowDelta<SessionNodeRow>>();

  constructor(path = ":memory:", options?: HarnessDatabaseOptions) {
    const { kernelId = "local", ...sqliteOptions } = options ?? {};
    this.#kernelId = kernelId;
    this.#sqlite = new Database(path, sqliteOptions);
    this.#sqlite.pragma("journal_mode = WAL");
    this.#sqlite.pragma("synchronous = NORMAL");
    this.#sqlite.pragma("foreign_keys = ON");
    this.#sqlite.pragma("busy_timeout = 5000");
    const migratedLegacy = sqliteOptions.readonly !== true && migrateLegacySqliteSchema(this.#sqlite);
    if (sqliteOptions.readonly !== true) {
      this.#sqlite.exec(bootstrapHarnessSqliteSql);
      if (migratedLegacy) {
        this.#sqlite
          .prepare(
            "DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM session_nodes WHERE session_nodes.session_id = sessions.session_id)",
          )
          .run();
      }
    }
    this.#drizzle = drizzle(this.#sqlite, { schema: harnessSchema });
  }

  get kernelId(): string {
    return this.#kernelId;
  }

  get sqlite(): BetterSqliteDatabase {
    return this.#sqlite;
  }

  get drizzle(): BetterSQLite3Database<HarnessSchema> {
    return this.#drizzle;
  }

  get commitOffset(): number {
    return this.#commitOffset;
  }

  get isClosed(): boolean {
    return !this.#sqlite.open;
  }

  onCommit(listener: DatabaseCommitListener): () => void {
    this.#commitListeners.add(listener);
    return () => {
      this.#commitListeners.delete(listener);
    };
  }

  recordScopeNodeUpsert(scopeId: string, row: ScopeNodeRow, kernelId = row.kernelId): void {
    const entry = getOrInitDelta(this.#txScopeNodeChanges, scopeDeltaKey(kernelId, scopeId));
    entry.deletes.delete(row.id);
    entry.upserts.set(row.id, row);
  }

  recordScopeNodeDelete(scopeId: string, id: string, kernelId = this.#kernelId): void {
    const entry = getOrInitDelta(this.#txScopeNodeChanges, scopeDeltaKey(kernelId, scopeId));
    entry.upserts.delete(id);
    entry.deletes.add(id);
  }

  recordSessionNodeUpsert(sessionId: string, row: SessionNodeRow, kernelId = row.kernelId): void {
    const entry = getOrInitDelta(this.#txSessionNodeChanges, sessionDeltaKey(kernelId, sessionId));
    entry.deletes.delete(row.id);
    entry.upserts.set(row.id, row);
  }

  recordSessionNodeDelete(sessionId: string, id: string, kernelId = this.#kernelId): void {
    const entry = getOrInitDelta(this.#txSessionNodeChanges, sessionDeltaKey(kernelId, sessionId));
    entry.upserts.delete(id);
    entry.deletes.add(id);
  }

  writeTransaction<T>(tables: readonly HarnessTableName[], fn: (tx: HarnessDrizzleTx) => T): T {
    if (this.#txDepth > 0) {
      for (const table of tables) {
        if (!this.#nestedTouchedTables.includes(table)) {
          this.#nestedTouchedTables.push(table);
        }
      }
      return this.#drizzle.transaction((tx) => fn(tx));
    }

    this.#txDepth += 1;
    this.#nestedTouchedTables = [...tables];
    this.#txScopeNodeChanges.clear();
    this.#txSessionNodeChanges.clear();

    try {
      const result = this.#drizzle.transaction((tx) => fn(tx));
      this.#commitOffset += 1;

      const scopeNodeChanges =
        this.#txScopeNodeChanges.size > 0
          ? new Map<string, TableRowDelta<ScopeNodeRow>>(
              [...this.#txScopeNodeChanges.entries()].map(([scopeId, delta]) => [
                scopeId,
                {
                  upserts: [...delta.upserts.values()],
                  deletes: [...delta.deletes],
                  ...(delta.reset ? { reset: true } : {}),
                },
              ]),
            )
          : undefined;

      const sessionNodeChanges =
        this.#txSessionNodeChanges.size > 0
          ? new Map<string, TableRowDelta<SessionNodeRow>>(
              [...this.#txSessionNodeChanges.entries()].map(([sessionId, delta]) => [
                sessionId,
                {
                  upserts: [...delta.upserts.values()],
                  deletes: [...delta.deletes],
                  ...(delta.reset ? { reset: true } : {}),
                },
              ]),
            )
          : undefined;

      const event: DatabaseCommitEvent = {
        touchedTables: [...this.#nestedTouchedTables],
        offset: this.#commitOffset,
        ...(scopeNodeChanges ? { scopeNodeChanges } : {}),
        ...(sessionNodeChanges ? { sessionNodeChanges } : {}),
      };
      for (const listener of this.#commitListeners) {
        listener(event);
      }
      return result;
    } finally {
      this.#txDepth -= 1;
      this.#nestedTouchedTables = [];
      this.#txScopeNodeChanges.clear();
      this.#txSessionNodeChanges.clear();
    }
  }

  commitScopeNodesInTx(
    tx: HarnessDrizzleTx,
    scopeId: string,
    delta: {
      readonly rootId: string;
      readonly revision: number;
      readonly upserts: readonly SerializedModelRow[];
      readonly deletes?: readonly string[];
      readonly replaceAll?: boolean;
    },
    kernelId = this.#kernelId,
  ): void {
    const liveIds = delta.replaceAll ? new Set<string>() : null;

    for (const row of delta.upserts) {
      const id = scopeRowId(kernelId, scopeId, row.uuid);
      liveIds?.add(id);
      const dbRow: ScopeNodeRow = {
        id,
        kernelId,
        scopeId,
        nodeId: row.uuid,
        tag: row.tag,
        isRoot: row.uuid === delta.rootId,
        revision: delta.revision,
        rowJson: JSON.stringify(row),
      };
      tx.insert(scopeNodesTable)
        .values(dbRow)
        .onConflictDoUpdate({
          target: scopeNodesTable.id,
          set: {
            kernelId: dbRow.kernelId,
            tag: dbRow.tag,
            isRoot: dbRow.isRoot,
            revision: dbRow.revision,
            rowJson: dbRow.rowJson,
          },
        })
        .run();
      this.recordScopeNodeUpsert(scopeId, dbRow, kernelId);
    }

    if (delta.deletes) {
      for (const rawNodeId of delta.deletes) {
        const id = rawNodeId.startsWith("[") ? rawNodeId : scopeRowId(kernelId, scopeId, rawNodeId);
        const res = tx
          .delete(scopeNodesTable)
          .where(and(eq(scopeNodesTable.id, id), eq(scopeNodesTable.kernelId, kernelId)))
          .run();
        if (res.changes > 0) {
          this.recordScopeNodeDelete(scopeId, id, kernelId);
        }
      }
    }

    if (liveIds) {
      const existing = tx
        .select({ id: scopeNodesTable.id })
        .from(scopeNodesTable)
        .where(and(eq(scopeNodesTable.kernelId, kernelId), eq(scopeNodesTable.scopeId, scopeId)))
        .all();
      for (const row of existing) {
        if (!liveIds.has(row.id)) {
          tx.delete(scopeNodesTable).where(eq(scopeNodesTable.id, row.id)).run();
          this.recordScopeNodeDelete(scopeId, row.id, kernelId);
        }
      }
    }
  }

  commitScopeNodes(
    scopeId: string,
    delta: {
      readonly rootId: string;
      readonly revision: number;
      readonly upserts: readonly SerializedModelRow[];
      readonly deletes?: readonly string[];
      readonly replaceAll?: boolean;
    },
    kernelId = this.#kernelId,
  ): void {
    this.writeTransaction(["scope_nodes"], (tx) => {
      this.commitScopeNodesInTx(tx, scopeId, delta, kernelId);
    });
  }

  listScopeNodeRows(scopeId: string, kernelId = this.#kernelId): ScopeNodeRow[] {
    return this.#drizzle
      .select()
      .from(scopeNodesTable)
      .where(and(eq(scopeNodesTable.kernelId, kernelId), eq(scopeNodesTable.scopeId, scopeId)))
      .all();
  }

  loadScopeNodes(
    scopeId: string,
    kernelId = this.#kernelId,
  ):
    | {
        readonly rootId: string;
        readonly revision: number;
        readonly rows: SerializedModelRow[];
      }
    | undefined {
    const stored = this.listScopeNodeRows(scopeId, kernelId);
    if (stored.length === 0) return undefined;
    let rootId: string | undefined;
    let maxRevision = 0;
    const rows: SerializedModelRow[] = [];
    for (const item of stored) {
      if (item.isRoot) rootId = item.nodeId;
      if (item.revision > maxRevision) maxRevision = item.revision;
      rows.push(storedModelRowSchema.parse(JSON.parse(item.rowJson)));
    }
    if (!rootId) {
      rootId = stored[0]!.nodeId;
    }
    return { rootId, revision: maxRevision, rows };
  }

  deleteScopeNodes(scopeId: string, kernelId = this.#kernelId): boolean {
    return this.writeTransaction(["scope_nodes"], (tx) => {
      const existing = tx
        .select({ id: scopeNodesTable.id })
        .from(scopeNodesTable)
        .where(and(eq(scopeNodesTable.kernelId, kernelId), eq(scopeNodesTable.scopeId, scopeId)))
        .all();
      if (existing.length === 0) return false;
      tx.delete(scopeNodesTable)
        .where(and(eq(scopeNodesTable.kernelId, kernelId), eq(scopeNodesTable.scopeId, scopeId)))
        .run();
      for (const row of existing) {
        this.recordScopeNodeDelete(scopeId, row.id, kernelId);
      }
      return true;
    });
  }

  commitSessionNodesInTx(
    tx: HarnessDrizzleTx,
    sessionId: string,
    delta: {
      readonly rootId: string;
      readonly revision: number;
      readonly upserts: readonly SerializedModelRow[];
      readonly deletes?: readonly string[];
      readonly replaceAll?: boolean;
    },
    kernelId = this.#kernelId,
  ): void {
    const liveIds = delta.replaceAll ? new Set<string>() : null;

    for (const row of delta.upserts) {
      const id = rowPairId(sessionId, row.uuid);
      liveIds?.add(id);
      const dbRow: SessionNodeRow = {
        id,
        kernelId,
        sessionId,
        nodeId: row.uuid,
        tag: row.tag,
        isRoot: row.uuid === delta.rootId,
        revision: delta.revision,
        rowJson: JSON.stringify(row),
      };
      tx.insert(sessionNodesTable)
        .values(dbRow)
        .onConflictDoUpdate({
          target: sessionNodesTable.id,
          set: {
            kernelId: dbRow.kernelId,
            tag: dbRow.tag,
            isRoot: dbRow.isRoot,
            revision: dbRow.revision,
            rowJson: dbRow.rowJson,
          },
        })
        .run();
      this.recordSessionNodeUpsert(sessionId, dbRow, kernelId);
    }

    if (delta.deletes) {
      for (const rawNodeId of delta.deletes) {
        const id = rawNodeId.startsWith("[") ? rawNodeId : rowPairId(sessionId, rawNodeId);
        const res = tx.delete(sessionNodesTable).where(eq(sessionNodesTable.id, id)).run();
        if (res.changes > 0) {
          this.recordSessionNodeDelete(sessionId, id, kernelId);
        }
      }
    }

    if (liveIds) {
      const existing = tx
        .select({ id: sessionNodesTable.id })
        .from(sessionNodesTable)
        .where(eq(sessionNodesTable.sessionId, sessionId))
        .all();
      for (const row of existing) {
        if (!liveIds.has(row.id)) {
          tx.delete(sessionNodesTable).where(eq(sessionNodesTable.id, row.id)).run();
          this.recordSessionNodeDelete(sessionId, row.id, kernelId);
        }
      }
    }
  }

  commitSessionNodes(
    sessionId: string,
    delta: {
      readonly rootId: string;
      readonly revision: number;
      readonly upserts: readonly SerializedModelRow[];
      readonly deletes?: readonly string[];
      readonly replaceAll?: boolean;
    },
    kernelId = this.#kernelId,
  ): void {
    this.writeTransaction(["session_nodes"], (tx) => {
      this.commitSessionNodesInTx(tx, sessionId, delta, kernelId);
    });
  }

  listSessionNodeRows(sessionId: string): SessionNodeRow[] {
    return this.#drizzle.select().from(sessionNodesTable).where(eq(sessionNodesTable.sessionId, sessionId)).all();
  }

  loadSessionNodes(sessionId: string):
    | {
        readonly rootId: string;
        readonly revision: number;
        readonly rows: SerializedModelRow[];
      }
    | undefined {
    const stored = this.listSessionNodeRows(sessionId);
    if (stored.length === 0) return undefined;
    let rootId: string | undefined;
    let maxRevision = 0;
    const rows: SerializedModelRow[] = [];
    for (const item of stored) {
      if (item.isRoot) rootId = item.nodeId;
      if (item.revision > maxRevision) maxRevision = item.revision;
      rows.push(storedModelRowSchema.parse(JSON.parse(item.rowJson)));
    }
    if (!rootId) {
      rootId = stored[0]!.nodeId;
    }
    return { rootId, revision: maxRevision, rows };
  }

  storeSessionDocument(sessionId: string, snapshot: SerializedDocument, nodes: readonly SerializedModelRow[]): void {
    if (!("nodes" in snapshot.root)) throw new TypeError("Session persistence requires a normalized graph");
    const liveNodeIds = new Set(Object.keys(snapshot.root.nodes));
    this.writeTransaction(["session_nodes", "session_turns"], (tx) => {
      this.commitSessionNodesInTx(tx, sessionId, {
        rootId: snapshot.root.uuid,
        revision: snapshot.revision,
        upserts: nodes,
        deletes: [],
        replaceAll: false,
      });

      const existing = tx
        .select({ id: sessionNodesTable.id, nodeId: sessionNodesTable.nodeId })
        .from(sessionNodesTable)
        .where(eq(sessionNodesTable.sessionId, sessionId))
        .all();
      for (const row of existing) {
        if (!liveNodeIds.has(row.nodeId)) {
          tx.delete(sessionNodesTable).where(eq(sessionNodesTable.id, row.id)).run();
          this.recordSessionNodeDelete(sessionId, row.id);
        }
      }

      for (const row of tx
        .select({ turnId: sessionTurnsTable.turnId })
        .from(sessionTurnsTable)
        .where(eq(sessionTurnsTable.sessionId, sessionId))
        .all()) {
        if (!liveNodeIds.has(row.turnId)) {
          tx.delete(sessionTurnsTable).where(eq(sessionTurnsTable.turnId, row.turnId)).run();
        }
      }
    });
  }

  loadSessionDocument(sessionId: string): SerializedDocument | undefined {
    const loaded = this.loadSessionNodes(sessionId);
    if (!loaded) return undefined;
    const nodes: Record<string, SerializedModelRow> = {};
    for (const row of loaded.rows) {
      nodes[row.uuid] = row;
    }
    const rootRow = nodes[loaded.rootId];
    if (!rootRow) return undefined;

    const meta = this.loadSessionRuntimeMeta(sessionId);
    return {
      guid: `harness:session:${sessionId}`,
      revision: loaded.revision,
      root: {
        format: "rows-v1",
        uuid: loaded.rootId,
        tag: rootRow.tag,
        nodes,
      },
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  }

  loadSessionRuntimeMeta(sessionId: string): Record<string, Record<string, unknown>> {
    const effects = this.listSessionEffects(sessionId);
    if (effects.length === 0) return {};
    const commitsMap: Record<string, unknown> = {};
    const commandsMap: Record<string, unknown> = {};
    const effectsMap: Record<string, unknown> = {};

    for (const row of effects) {
      if (row.kind === "commit") {
        commitsMap[row.effectKey] = { format: "input-digest-v1", hash: row.inputHash };
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.outcomeJson);
      } catch {
        continue;
      }
      if (row.kind === "command") {
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "format" in parsed &&
          (parsed as { readonly format?: unknown }).format === "command-digest-v1"
        ) {
          commandsMap[row.effectKey] = parsed;
        } else if (
          typeof parsed === "object" &&
          parsed !== null &&
          "ok" in parsed &&
          typeof (parsed as { readonly ok?: unknown }).ok === "boolean"
        ) {
          commandsMap[row.effectKey] = {
            format: "command-digest-v1",
            inputHash: row.inputHash,
            result: parsed,
          };
        } else {
          commitsMap[row.effectKey] = { format: "input-digest-v1", hash: row.inputHash };
        }
      } else if (row.kind === "effect") {
        if (row.phase === "intent") {
          effectsMap[row.effectKey] = { phase: "intent", request: parsed, inputHash: row.inputHash };
        } else {
          effectsMap[row.effectKey] = { phase: "result", inputHash: row.inputHash, outcome: parsed };
        }
      }
    }

    const meta: Record<string, Record<string, unknown>> = {
      "harness:session-runtime": { version: "2" },
    };
    if (Object.keys(commitsMap).length > 0) meta["harness:session-commits"] = commitsMap;
    if (Object.keys(commandsMap).length > 0) meta["harness:session-commands"] = commandsMap;
    if (Object.keys(effectsMap).length > 0) meta["harness:session-effects"] = effectsMap;
    return meta;
  }

  getKernelState(kernelId = this.#kernelId): KernelStateRow | undefined {
    const row = this.#drizzle.select().from(kernelStateTable).where(eq(kernelStateTable.id, kernelId)).get();
    if (row || kernelId !== "local") {
      return row;
    }
    return this.#drizzle.select().from(kernelStateTable).where(eq(kernelStateTable.id, "singleton")).get();
  }

  upsertKernelState(state: Partial<KernelStateRowInsert> & { readonly updatedAtMs: number }): KernelStateRow {
    return this.writeTransaction(["kernel_state"], (tx) => {
      const targetKernelId = state.kernelId ?? this.#kernelId;
      const targetId = state.id ?? targetKernelId;
      const rowToInsert: KernelStateRowInsert = {
        defaultModel: "",
        permissionMode: "manual",
        enabledPluginsJson: "[]",
        kvsJson: "{}",
        ...state,
        id: targetId,
        kernelId: targetKernelId,
      };
      const updateSet = {
        ...state,
        kernelId: targetKernelId,
      };
      tx.insert(kernelStateTable)
        .values(rowToInsert)
        .onConflictDoUpdate({
          target: kernelStateTable.id,
          set: updateSet,
        })
        .run();
      const updated = tx.select().from(kernelStateTable).where(eq(kernelStateTable.id, targetId)).get();
      if (!updated) {
        throw new Error("Failed to retrieve upserted kernel_state row");
      }
      return updated;
    });
  }

  getProject(projectId: string): ProjectRow | undefined {
    return this.#drizzle.select().from(projectsTable).where(eq(projectsTable.projectId, projectId)).get();
  }

  listProjects(kernelId = this.#kernelId): ProjectRow[] {
    return this.#drizzle.select().from(projectsTable).where(eq(projectsTable.kernelId, kernelId)).all();
  }

  upsertProject(row: ProjectRowInsert): ProjectRow {
    return this.writeTransaction(["projects"], (tx) => {
      const kernelId = row.kernelId ?? this.#kernelId;
      const rowToInsert: ProjectRowInsert = {
        title: "",
        kind: "local",
        workspacePath: null,
        defaultPermissionMode: "manual",
        authorizationJson: "{}",
        kvsJson: "{}",
        lastUsedModelJson: "{}",
        enabledPluginsJson: "[]",
        pluginConfigsJson: "{}",
        botsRosterJson: "{}",
        trusted: false,
        contentHash: null,
        revision: 0,
        ...row,
        kernelId,
      };
      tx.insert(projectsTable)
        .values(rowToInsert)
        .onConflictDoUpdate({
          target: projectsTable.projectId,
          set: rowToInsert,
        })
        .run();
      const updated = tx
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.projectId, row.projectId))
        .get();
      if (!updated) {
        throw new Error(`Failed to retrieve upserted project ${row.projectId}`);
      }
      return updated;
    });
  }

  deleteProject(projectId: string): boolean {
    return this.writeTransaction(["projects"], (tx) => {
      const result = tx.delete(projectsTable).where(eq(projectsTable.projectId, projectId)).run();
      return result.changes > 0;
    });
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.#drizzle.select().from(sessionsTable).where(eq(sessionsTable.sessionId, sessionId)).get();
  }

  listSessions(kernelId?: string): SessionRow[] {
    if (kernelId !== undefined) {
      return this.#drizzle.select().from(sessionsTable).where(eq(sessionsTable.kernelId, kernelId)).all();
    }
    return this.#drizzle.select().from(sessionsTable).all();
  }

  insertSession(session: SessionRowInsert): SessionRow {
    return this.writeTransaction(["sessions"], (tx) => {
      const rowToInsert: SessionRowInsert = {
        ...session,
        kernelId: session.kernelId ?? this.#kernelId,
        projectId: session.projectId ?? "",
        permissionMode: session.permissionMode ?? "manual",
      };
      tx.insert(sessionsTable).values(rowToInsert).run();
      const created = tx.select().from(sessionsTable).where(eq(sessionsTable.sessionId, session.sessionId)).get();
      if (!created) {
        throw new Error(`Failed to retrieve inserted session ${session.sessionId}`);
      }
      return created;
    });
  }

  updateSession(sessionId: string, patch: Partial<SessionRowInsert>): SessionRow | undefined {
    return this.writeTransaction(["sessions"], (tx) => {
      tx.update(sessionsTable).set(patch).where(eq(sessionsTable.sessionId, sessionId)).run();
      return tx.select().from(sessionsTable).where(eq(sessionsTable.sessionId, sessionId)).get();
    });
  }

  deleteSession(sessionId: string): boolean {
    return this.writeTransaction(
      ["sessions", "pending_asks", "session_turns", "session_nodes", "session_effects", "session_blobs"],
      (tx) => {
        const sessionRow = tx
          .select({ kernelId: sessionsTable.kernelId })
          .from(sessionsTable)
          .where(eq(sessionsTable.sessionId, sessionId))
          .get();
        const nodeIds = tx
          .select({ id: sessionNodesTable.id, kernelId: sessionNodesTable.kernelId })
          .from(sessionNodesTable)
          .where(eq(sessionNodesTable.sessionId, sessionId))
          .all();
        const result = tx.delete(sessionsTable).where(eq(sessionsTable.sessionId, sessionId)).run();
        for (const row of nodeIds) {
          this.recordSessionNodeDelete(sessionId, row.id, row.kernelId ?? sessionRow?.kernelId ?? this.#kernelId);
        }
        return result.changes > 0;
      },
    );
  }

  getPendingAsk(jobId: string): PendingAskRow | undefined {
    return this.#drizzle.select().from(pendingAsksTable).where(eq(pendingAsksTable.jobId, jobId)).get();
  }

  listPendingAsks(sessionId?: string): PendingAskRow[] {
    if (sessionId != null) {
      return this.#drizzle
        .select()
        .from(pendingAsksTable)
        .where(eq(pendingAsksTable.sessionId, sessionId))
        .orderBy(asc(pendingAsksTable.createdAtMs))
        .all();
    }
    return this.#drizzle.select().from(pendingAsksTable).orderBy(asc(pendingAsksTable.createdAtMs)).all();
  }

  insertPendingAsk(ask: PendingAskRowInsert): PendingAskRow {
    return this.writeTransaction(["pending_asks"], (tx) => {
      tx.insert(pendingAsksTable)
        .values({ ...ask, kernelId: ask.kernelId ?? this.#kernelId })
        .run();
      const created = tx.select().from(pendingAsksTable).where(eq(pendingAsksTable.jobId, ask.jobId)).get();
      if (!created) {
        throw new Error(`Failed to retrieve inserted pending_ask ${ask.jobId}`);
      }
      return created;
    });
  }

  deletePendingAsk(jobId: string): boolean {
    return this.writeTransaction(["pending_asks"], (tx) => {
      const result = tx.delete(pendingAsksTable).where(eq(pendingAsksTable.jobId, jobId)).run();
      return result.changes > 0;
    });
  }

  getSessionTurn(turnId: string): SessionTurnRow | undefined {
    return this.#drizzle.select().from(sessionTurnsTable).where(eq(sessionTurnsTable.turnId, turnId)).get();
  }

  listSessionTurns(sessionId: string): SessionTurnRow[] {
    return this.#drizzle
      .select()
      .from(sessionTurnsTable)
      .where(eq(sessionTurnsTable.sessionId, sessionId))
      .orderBy(asc(sessionTurnsTable.ordinal))
      .all();
  }

  insertSessionTurn(turn: SessionTurnRowInsert): SessionTurnRow {
    return this.writeTransaction(["session_turns"], (tx) => {
      tx.insert(sessionTurnsTable)
        .values({ ...turn, kernelId: turn.kernelId ?? this.#kernelId })
        .run();
      const created = tx.select().from(sessionTurnsTable).where(eq(sessionTurnsTable.turnId, turn.turnId)).get();
      if (!created) {
        throw new Error(`Failed to retrieve inserted session_turn ${turn.turnId}`);
      }
      return created;
    });
  }

  updateSessionTurn(turnId: string, patch: Partial<SessionTurnRowInsert>): SessionTurnRow | undefined {
    return this.writeTransaction(["session_turns"], (tx) => {
      tx.update(sessionTurnsTable).set(patch).where(eq(sessionTurnsTable.turnId, turnId)).run();
      return tx.select().from(sessionTurnsTable).where(eq(sessionTurnsTable.turnId, turnId)).get();
    });
  }

  getSessionEffect(
    sessionId: string,
    effectKey: string,
    kind?: "commit" | "command" | "effect",
  ): SessionEffectRow | undefined {
    if (kind) {
      const id = rowPairId(sessionId, `${kind}:${effectKey}`);
      return this.#drizzle.select().from(sessionEffectsTable).where(eq(sessionEffectsTable.id, id)).get();
    }
    return this.#drizzle
      .select()
      .from(sessionEffectsTable)
      .where(and(eq(sessionEffectsTable.sessionId, sessionId), eq(sessionEffectsTable.effectKey, effectKey)))
      .get();
  }

  listSessionEffects(sessionId: string): SessionEffectRow[] {
    return this.#drizzle
      .select()
      .from(sessionEffectsTable)
      .where(eq(sessionEffectsTable.sessionId, sessionId))
      .orderBy(asc(sessionEffectsTable.revision))
      .all();
  }

  upsertSessionEffectInTx(
    tx: HarnessDrizzleTx,
    effect: Omit<SessionEffectRowInsert, "id"> & { readonly id?: string },
  ): void {
    const id = effect.id ?? rowPairId(effect.sessionId, `${effect.kind}:${effect.effectKey}`);
    const row: SessionEffectRowInsert = {
      ...effect,
      id,
      kernelId: effect.kernelId ?? this.#kernelId,
      phase: effect.phase ?? "committed",
    };
    tx.insert(sessionEffectsTable)
      .values(row)
      .onConflictDoUpdate({
        target: sessionEffectsTable.id,
        set: {
          phase: row.phase,
          inputHash: row.inputHash,
          outcomeJson: row.outcomeJson,
          revision: row.revision,
        },
      })
      .run();
  }

  insertSessionEffect(effect: Omit<SessionEffectRowInsert, "id"> & { readonly id?: string }): SessionEffectRow {
    const id = effect.id ?? rowPairId(effect.sessionId, `${effect.kind}:${effect.effectKey}`);
    return this.writeTransaction(["session_effects"], (tx) => {
      this.upsertSessionEffectInTx(tx, { ...effect, id });
      const created = tx.select().from(sessionEffectsTable).where(eq(sessionEffectsTable.id, id)).get();
      if (!created) {
        throw new Error(`Failed to retrieve upserted session_effect ${id}`);
      }
      return created;
    });
  }

  listSessionBlobs(sessionId: string): SessionBlobRow[] {
    return this.#drizzle
      .select()
      .from(sessionBlobsTable)
      .where(eq(sessionBlobsTable.sessionId, sessionId))
      .orderBy(asc(sessionBlobsTable.createdAtMs))
      .all();
  }

  insertSessionBlobInTx(tx: HarnessDrizzleTx, blob: Omit<SessionBlobRowInsert, "id"> & { readonly id?: string }): void {
    const id = blob.id ?? rowPairId(blob.sessionId, blob.blobId);
    tx.insert(sessionBlobsTable)
      .values({ ...blob, id, kernelId: blob.kernelId ?? this.#kernelId })
      .onConflictDoNothing()
      .run();
  }

  insertSessionBlob(blob: Omit<SessionBlobRowInsert, "id"> & { readonly id?: string }): SessionBlobRow {
    const id = blob.id ?? rowPairId(blob.sessionId, blob.blobId);
    return this.writeTransaction(["session_blobs"], (tx) => {
      this.insertSessionBlobInTx(tx, { ...blob, id });
      const created = tx.select().from(sessionBlobsTable).where(eq(sessionBlobsTable.id, id)).get();
      if (!created) {
        throw new Error(`Failed to retrieve inserted session_blob ${id}`);
      }
      return created;
    });
  }

  listReferencedBlobIds(kernelId?: string): string[] {
    const query =
      kernelId !== undefined
        ? this.#drizzle
            .selectDistinct({ blobId: sessionBlobsTable.blobId })
            .from(sessionBlobsTable)
            .where(eq(sessionBlobsTable.kernelId, kernelId))
        : this.#drizzle.selectDistinct({ blobId: sessionBlobsTable.blobId }).from(sessionBlobsTable);
    return query.all().map((r) => r.blobId);
  }

  getScmResource(id: string): ScmResourceRow | undefined {
    return this.#drizzle.select().from(scmResourcesTable).where(eq(scmResourcesTable.id, id)).get();
  }

  listScmResources(
    scope?: ScmResourceScope,
    scopeId?: string,
    kind?: ScmResourceKind,
    kernelId = this.#kernelId,
  ): ScmResourceRow[] {
    const conditions = [eq(scmResourcesTable.kernelId, kernelId)];
    if (scope !== undefined) conditions.push(eq(scmResourcesTable.scope, scope));
    if (scopeId !== undefined) conditions.push(eq(scmResourcesTable.scopeId, scopeId));
    if (kind !== undefined) conditions.push(eq(scmResourcesTable.kind, kind));
    return this.#drizzle
      .select()
      .from(scmResourcesTable)
      .where(and(...conditions))
      .all();
  }

  upsertScmResource(row: ScmResourceRowInsert): ScmResourceRow {
    return this.writeTransaction(["scm_resources"], (tx) => {
      const rowToInsert: ScmResourceRowInsert = {
        ...row,
        kernelId: row.kernelId ?? this.#kernelId,
      };
      tx.insert(scmResourcesTable)
        .values(rowToInsert)
        .onConflictDoUpdate({
          target: scmResourcesTable.id,
          set: rowToInsert,
        })
        .run();
      const updated = tx.select().from(scmResourcesTable).where(eq(scmResourcesTable.id, row.id)).get();
      if (!updated) {
        throw new Error(`Failed to retrieve upserted scm_resource ${row.id}`);
      }
      return updated;
    });
  }

  deleteScmResource(id: string): boolean {
    return this.writeTransaction(["scm_resources"], (tx) => {
      const result = tx.delete(scmResourcesTable).where(eq(scmResourcesTable.id, id)).run();
      return result.changes > 0;
    });
  }

  getPluginStateLog(id: string): PluginStateLogRow | undefined {
    return this.#drizzle.select().from(pluginStateLogsTable).where(eq(pluginStateLogsTable.id, id)).get();
  }

  listPluginStateLogs(
    plugin?: string,
    scope?: PluginStateScope,
    scopeId?: string,
    kernelId = this.#kernelId,
  ): PluginStateLogRow[] {
    const conditions = [eq(pluginStateLogsTable.kernelId, kernelId)];
    if (plugin !== undefined) conditions.push(eq(pluginStateLogsTable.plugin, plugin));
    if (scope !== undefined) conditions.push(eq(pluginStateLogsTable.scope, scope));
    if (scopeId !== undefined) conditions.push(eq(pluginStateLogsTable.scopeId, scopeId));
    return this.#drizzle
      .select()
      .from(pluginStateLogsTable)
      .where(and(...conditions))
      .all();
  }

  upsertPluginStateLog(row: PluginStateLogRowInsert): PluginStateLogRow {
    return this.writeTransaction(["plugin_state_logs"], (tx) => {
      const rowToInsert: PluginStateLogRowInsert = {
        namespace: "default",
        logJson: "[]",
        ...row,
        kernelId: row.kernelId ?? this.#kernelId,
      };
      tx.insert(pluginStateLogsTable)
        .values(rowToInsert)
        .onConflictDoUpdate({
          target: pluginStateLogsTable.id,
          set: rowToInsert,
        })
        .run();
      const updated = tx.select().from(pluginStateLogsTable).where(eq(pluginStateLogsTable.id, row.id)).get();
      if (!updated) {
        throw new Error(`Failed to retrieve upserted plugin_state_log ${row.id}`);
      }
      return updated;
    });
  }

  deletePluginStateLog(id: string): boolean {
    return this.writeTransaction(["plugin_state_logs"], (tx) => {
      const result = tx.delete(pluginStateLogsTable).where(eq(pluginStateLogsTable.id, id)).run();
      return result.changes > 0;
    });
  }

  close(): void {
    this.#sqlite.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
