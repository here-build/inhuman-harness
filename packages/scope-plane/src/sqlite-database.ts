import {
  bootstrapHarnessSqliteSql,
  kernelStateTable,
  pendingAsksTable,
  sessionBlobsTable,
  sessionEffectsTable,
  sessionsTable,
  sessionTurnsTable,
  sessionUpdatesTable,
  type KernelStateRow,
  type KernelStateRowInsert,
  type PendingAskRow,
  type PendingAskRowInsert,
  type SessionBlobRow,
  type SessionBlobRowInsert,
  type SessionEffectRow,
  type SessionEffectRowInsert,
  type SessionRow,
  type SessionRowInsert,
  type SessionTurnRow,
  type SessionTurnRowInsert,
  type SessionUpdateRow,
  type SessionUpdateRowInsert,
} from "@inhuman.tools/harness-contract/schema";
import Database, { type Database as BetterSqliteDatabase, type Options as BetterSqliteOptions } from "better-sqlite3";
import { and, asc, eq, gte } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export const HARNESS_TABLE_NAMES = [
  "kernel_state",
  "sessions",
  "pending_asks",
  "session_turns",
  "session_updates",
  "session_effects",
  "session_blobs",
] as const;

export type HarnessTableName = (typeof HARNESS_TABLE_NAMES)[number];

export const harnessSchema = {
  kernelStateTable,
  sessionsTable,
  pendingAsksTable,
  sessionTurnsTable,
  sessionUpdatesTable,
  sessionEffectsTable,
  sessionBlobsTable,
} as const;

export type HarnessSchema = typeof harnessSchema;

export type HarnessDrizzleTx = Parameters<Parameters<BetterSQLite3Database<HarnessSchema>["transaction"]>[0]>[0];

export interface DatabaseCommitEvent {
  readonly touchedTables: readonly HarnessTableName[];
  readonly offset: number;
}

export type DatabaseCommitListener = (event: DatabaseCommitEvent) => void;

export type HarnessDatabaseOptions = BetterSqliteOptions;

export class HarnessDatabase {
  readonly #sqlite: BetterSqliteDatabase;
  readonly #drizzle: BetterSQLite3Database<HarnessSchema>;
  readonly #commitListeners = new Set<DatabaseCommitListener>();
  #commitOffset = 0;
  #txDepth = 0;
  #nestedTouchedTables: HarnessTableName[] = [];

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

    try {
      const result = this.#drizzle.transaction((tx) => fn(tx));
      this.#commitOffset += 1;
      const event: DatabaseCommitEvent = {
        touchedTables: [...this.#nestedTouchedTables],
        offset: this.#commitOffset,
      };
      for (const listener of this.#commitListeners) {
        listener(event);
      }
      return result;
    } finally {
      this.#txDepth -= 1;
      this.#nestedTouchedTables = [];
    }
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
      ["sessions", "pending_asks", "session_turns", "session_updates", "session_effects", "session_blobs"],
      (tx) => {
        const result = tx.delete(sessionsTable).where(eq(sessionsTable.sessionId, sessionId)).run();
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

  listSessionUpdates(sessionId: string, fromRevision?: number): SessionUpdateRow[] {
    const conditions = [eq(sessionUpdatesTable.sessionId, sessionId)];
    if (fromRevision != null) {
      conditions.push(gte(sessionUpdatesTable.revision, fromRevision));
    }
    return this.#drizzle
      .select()
      .from(sessionUpdatesTable)
      .where(and(...conditions))
      .orderBy(asc(sessionUpdatesTable.revision))
      .all();
  }

  insertSessionUpdate(update: SessionUpdateRowInsert): SessionUpdateRow {
    return this.writeTransaction(["session_updates"], (tx) => {
      tx.insert(sessionUpdatesTable).values(update).run();
      const created = tx
        .select()
        .from(sessionUpdatesTable)
        .where(
          and(eq(sessionUpdatesTable.sessionId, update.sessionId), eq(sessionUpdatesTable.revision, update.revision)),
        )
        .get();
      if (!created) {
        throw new Error(`Failed to retrieve inserted session_update ${update.sessionId}:${update.revision}`);
      }
      return created;
    });
  }

  getSessionEffect(sessionId: string, effectKey: string): SessionEffectRow | undefined {
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

  insertSessionEffect(effect: SessionEffectRowInsert): SessionEffectRow {
    return this.writeTransaction(["session_effects"], (tx) => {
      tx.insert(sessionEffectsTable).values(effect).run();
      const created = tx
        .select()
        .from(sessionEffectsTable)
        .where(
          and(eq(sessionEffectsTable.sessionId, effect.sessionId), eq(sessionEffectsTable.effectKey, effect.effectKey)),
        )
        .get();
      if (!created) {
        throw new Error(`Failed to retrieve inserted session_effect ${effect.sessionId}:${effect.effectKey}`);
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

  insertSessionBlob(blob: SessionBlobRowInsert): SessionBlobRow {
    return this.writeTransaction(["session_blobs"], (tx) => {
      tx.insert(sessionBlobsTable).values(blob).run();
      const created = tx
        .select()
        .from(sessionBlobsTable)
        .where(and(eq(sessionBlobsTable.sessionId, blob.sessionId), eq(sessionBlobsTable.blobId, blob.blobId)))
        .get();
      if (!created) {
        throw new Error(`Failed to retrieve inserted session_blob ${blob.sessionId}:${blob.blobId}`);
      }
      return created;
    });
  }

  close(): void {
    this.#sqlite.close();
  }
}
