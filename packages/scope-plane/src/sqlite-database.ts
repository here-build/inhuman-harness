import {
  bootstrapHarnessSqliteSql,
  kernelStateTable,
  pendingAsksTable,
  rowPairId,
  scopeNodesTable,
  sessionBlobsTable,
  sessionEffectsTable,
  sessionNodesTable,
  sessionsTable,
  sessionTurnsTable,
  storedModelRowSchema,
  type KernelStateRow,
  type KernelStateRowInsert,
  type PendingAskRow,
  type PendingAskRowInsert,
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

export const HARNESS_TABLE_NAMES = [
  "kernel_state",
  "scope_nodes",
  "sessions",
  "pending_asks",
  "session_turns",
  "session_nodes",
  "session_effects",
  "session_blobs",
] as const;

export type HarnessTableName = (typeof HARNESS_TABLE_NAMES)[number];

export const harnessSchema = {
  kernelStateTable,
  scopeNodesTable,
  sessionsTable,
  pendingAsksTable,
  sessionTurnsTable,
  sessionNodesTable,
  sessionEffectsTable,
  sessionBlobsTable,
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

export type HarnessDatabaseOptions = BetterSqliteOptions;

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

export class HarnessDatabase implements Disposable {
  readonly #sqlite: BetterSqliteDatabase;
  readonly #drizzle: BetterSQLite3Database<HarnessSchema>;
  readonly #commitListeners = new Set<DatabaseCommitListener>();
  #commitOffset = 0;
  #txDepth = 0;
  #nestedTouchedTables: HarnessTableName[] = [];
  #txScopeNodeChanges = new Map<string, MutableRowDelta<ScopeNodeRow>>();
  #txSessionNodeChanges = new Map<string, MutableRowDelta<SessionNodeRow>>();

  constructor(path = ":memory:", options?: HarnessDatabaseOptions) {
    this.#sqlite = new Database(path, options);
    this.#sqlite.pragma("journal_mode = WAL");
    this.#sqlite.pragma("synchronous = NORMAL");
    this.#sqlite.pragma("foreign_keys = ON");
    this.#sqlite.pragma("busy_timeout = 5000");
    this.#sqlite.exec(bootstrapHarnessSqliteSql);
    this.#drizzle = drizzle(this.#sqlite, { schema: harnessSchema });
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

  recordScopeNodeUpsert(scopeId: string, row: ScopeNodeRow): void {
    const entry = getOrInitDelta(this.#txScopeNodeChanges, scopeId);
    entry.deletes.delete(row.id);
    entry.upserts.set(row.id, row);
  }

  recordScopeNodeDelete(scopeId: string, id: string): void {
    const entry = getOrInitDelta(this.#txScopeNodeChanges, scopeId);
    entry.upserts.delete(id);
    entry.deletes.add(id);
  }

  recordSessionNodeUpsert(sessionId: string, row: SessionNodeRow): void {
    const entry = getOrInitDelta(this.#txSessionNodeChanges, sessionId);
    entry.deletes.delete(row.id);
    entry.upserts.set(row.id, row);
  }

  recordSessionNodeDelete(sessionId: string, id: string): void {
    const entry = getOrInitDelta(this.#txSessionNodeChanges, sessionId);
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
  ): void {
    const liveIds = delta.replaceAll ? new Set<string>() : null;

    for (const row of delta.upserts) {
      const id = rowPairId(scopeId, row.uuid);
      liveIds?.add(id);
      const dbRow: ScopeNodeRow = {
        id,
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
            tag: dbRow.tag,
            isRoot: dbRow.isRoot,
            revision: dbRow.revision,
            rowJson: dbRow.rowJson,
          },
        })
        .run();
      this.recordScopeNodeUpsert(scopeId, dbRow);
    }

    if (delta.deletes) {
      for (const rawNodeId of delta.deletes) {
        const id = rawNodeId.startsWith("[") ? rawNodeId : rowPairId(scopeId, rawNodeId);
        const res = tx.delete(scopeNodesTable).where(eq(scopeNodesTable.id, id)).run();
        if (res.changes > 0) {
          this.recordScopeNodeDelete(scopeId, id);
        }
      }
    }

    if (liveIds) {
      const existing = tx
        .select({ id: scopeNodesTable.id })
        .from(scopeNodesTable)
        .where(eq(scopeNodesTable.scopeId, scopeId))
        .all();
      for (const row of existing) {
        if (!liveIds.has(row.id)) {
          tx.delete(scopeNodesTable).where(eq(scopeNodesTable.id, row.id)).run();
          this.recordScopeNodeDelete(scopeId, row.id);
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
  ): void {
    this.writeTransaction(["scope_nodes"], (tx) => {
      this.commitScopeNodesInTx(tx, scopeId, delta);
    });
  }

  listScopeNodeRows(scopeId: string): ScopeNodeRow[] {
    return this.#drizzle.select().from(scopeNodesTable).where(eq(scopeNodesTable.scopeId, scopeId)).all();
  }

  loadScopeNodes(scopeId: string):
    | {
        readonly rootId: string;
        readonly revision: number;
        readonly rows: SerializedModelRow[];
      }
    | undefined {
    const stored = this.listScopeNodeRows(scopeId);
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

  deleteScopeNodes(scopeId: string): boolean {
    return this.writeTransaction(["scope_nodes"], (tx) => {
      const existing = tx
        .select({ id: scopeNodesTable.id })
        .from(scopeNodesTable)
        .where(eq(scopeNodesTable.scopeId, scopeId))
        .all();
      if (existing.length === 0) return false;
      tx.delete(scopeNodesTable).where(eq(scopeNodesTable.scopeId, scopeId)).run();
      for (const row of existing) {
        this.recordScopeNodeDelete(scopeId, row.id);
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
  ): void {
    const liveIds = delta.replaceAll ? new Set<string>() : null;

    for (const row of delta.upserts) {
      const id = rowPairId(sessionId, row.uuid);
      liveIds?.add(id);
      const dbRow: SessionNodeRow = {
        id,
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
            tag: dbRow.tag,
            isRoot: dbRow.isRoot,
            revision: dbRow.revision,
            rowJson: dbRow.rowJson,
          },
        })
        .run();
      this.recordSessionNodeUpsert(sessionId, dbRow);
    }

    if (delta.deletes) {
      for (const rawNodeId of delta.deletes) {
        const id = rawNodeId.startsWith("[") ? rawNodeId : rowPairId(sessionId, rawNodeId);
        const res = tx.delete(sessionNodesTable).where(eq(sessionNodesTable.id, id)).run();
        if (res.changes > 0) {
          this.recordSessionNodeDelete(sessionId, id);
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
          this.recordSessionNodeDelete(sessionId, row.id);
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
  ): void {
    this.writeTransaction(["session_nodes"], (tx) => {
      this.commitSessionNodesInTx(tx, sessionId, delta);
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

  getKernelState(): KernelStateRow | undefined {
    return this.#drizzle.select().from(kernelStateTable).where(eq(kernelStateTable.id, "singleton")).get();
  }

  upsertKernelState(state: Partial<KernelStateRowInsert> & { readonly updatedAtMs: number }): KernelStateRow {
    return this.writeTransaction(["kernel_state"], (tx) => {
      const rowToInsert: KernelStateRowInsert = {
        id: "singleton",
        defaultModel: "",
        permissionMode: "ask",
        kvsJson: "{}",
        ...state,
      };
      tx.insert(kernelStateTable)
        .values(rowToInsert)
        .onConflictDoUpdate({
          target: kernelStateTable.id,
          set: state,
        })
        .run();
      const updated = tx
        .select()
        .from(kernelStateTable)
        .where(eq(kernelStateTable.id, rowToInsert.id ?? "singleton"))
        .get();
      if (!updated) {
        throw new Error("Failed to retrieve upserted kernel_state row");
      }
      return updated;
    });
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.#drizzle.select().from(sessionsTable).where(eq(sessionsTable.sessionId, sessionId)).get();
  }

  listSessions(): SessionRow[] {
    return this.#drizzle.select().from(sessionsTable).all();
  }

  insertSession(session: SessionRowInsert): SessionRow {
    return this.writeTransaction(["sessions"], (tx) => {
      tx.insert(sessionsTable).values(session).run();
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
      [
        "sessions",
        "pending_asks",
        "session_turns",
        "session_nodes",
        "session_effects",
        "session_blobs",
      ],
      (tx) => {
        const nodeIds = tx
          .select({ id: sessionNodesTable.id })
          .from(sessionNodesTable)
          .where(eq(sessionNodesTable.sessionId, sessionId))
          .all();
        const result = tx.delete(sessionsTable).where(eq(sessionsTable.sessionId, sessionId)).run();
        for (const row of nodeIds) {
          this.recordSessionNodeDelete(sessionId, row.id);
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
      tx.insert(pendingAsksTable).values(ask).run();
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
      tx.insert(sessionTurnsTable).values(turn).run();
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

  getSessionEffect(sessionId: string, effectKey: string, kind?: "commit" | "command" | "effect"): SessionEffectRow | undefined {
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

  insertSessionBlobInTx(
    tx: HarnessDrizzleTx,
    blob: Omit<SessionBlobRowInsert, "id"> & { readonly id?: string },
  ): void {
    const id = blob.id ?? rowPairId(blob.sessionId, blob.blobId);
    tx.insert(sessionBlobsTable)
      .values({ ...blob, id })
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

  listReferencedBlobIds(): string[] {
    const rows = this.#drizzle.selectDistinct({ blobId: sessionBlobsTable.blobId }).from(sessionBlobsTable).all();
    return rows.map((r) => r.blobId);
  }

  close(): void {
    this.#sqlite.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
