import {
  shapeSubscribeFrameSchema,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type UpdateLaneName,
} from "@inhuman.tools/harness-contract";
import {
  kernelStateTable,
  pendingAsksTable,
  scopeNodesTable,
  sessionNodesTable,
  sessionsTable,
} from "@inhuman.tools/harness-contract/schema";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";

import type { DatabaseCommitEvent, HarnessDatabase, HarnessTableName } from "./sqlite-database.js";

export const LANE_SOURCE_TABLES: Record<UpdateLaneName, readonly HarnessTableName[]> = {
  kernel_meta: ["kernel_state"],
  scope_nodes: ["scope_nodes"],
  session_nodes: ["session_nodes"],
  active_sessions: ["sessions", "pending_asks"],
  recent_sessions: ["sessions"],
  child_sessions: ["sessions"],
  pending_asks: ["pending_asks"],
};

export const LANE_PRIMARY_KEYS: Record<UpdateLaneName, string> = {
  kernel_meta: "id",
  scope_nodes: "id",
  session_nodes: "id",
  active_sessions: "sessionId",
  recent_sessions: "sessionId",
  child_sessions: "sessionId",
  pending_asks: "jobId",
};

interface ActiveSubscription {
  readonly key: string;
  readonly clientId: string;
  readonly subscriptionId: string;
  readonly frame: ShapeSubscribeFrame;
  readonly sink: (delta: ShapeDeltaFrame) => void;
  readonly lastRows: Map<string, string>;
}

function subscriptionMapKey(clientId: string, subscriptionId: string): string {
  return `${clientId}\n${subscriptionId}`;
}

export class UpdateLaneHub {
  readonly #database: HarnessDatabase;
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  readonly #unsubscribeCommit: () => void;

  constructor(database: HarnessDatabase) {
    this.#database = database;
    this.#unsubscribeCommit = this.#database.onCommit((event) => this.#handleCommit(event));
  }

  get database(): HarnessDatabase {
    return this.#database;
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  hasSubscription(subscriptionId: string, clientId = "local"): boolean {
    return this.#subscriptions.has(subscriptionMapKey(clientId, subscriptionId));
  }

  subscribe(rawFrame: unknown, sink: (delta: ShapeDeltaFrame) => void, clientId = "local"): () => void {
    const frame = shapeSubscribeFrameSchema.parse(rawFrame);
    const rows = this.evaluateLane(frame);
    const pkField = LANE_PRIMARY_KEYS[frame.lane];
    const lastRows = new Map<string, string>();

    const isDirectNodeLane = frame.lane === "scope_nodes" || frame.lane === "session_nodes";
    if (!isDirectNodeLane) {
      for (const row of rows) {
        const pk = String(row[pkField]);
        lastRows.set(pk, JSON.stringify(row));
      }
    }

    const key = subscriptionMapKey(clientId, frame.subscriptionId);
    const sub: ActiveSubscription = {
      key,
      clientId,
      subscriptionId: frame.subscriptionId,
      frame,
      sink,
      lastRows,
    };
    this.#subscriptions.set(key, sub);

    const isResumingUnchanged = frame.offset !== undefined && frame.offset === this.#database.commitOffset;

    const initialDelta: ShapeDeltaFrame = {
      kind: "shape/delta",
      subscriptionId: frame.subscriptionId,
      offset: this.#database.commitOffset,
      upserts: isResumingUnchanged ? [] : rows,
      deletes: [],
      reset: !isResumingUnchanged,
    };

    sink(initialDelta);

    return () => {
      this.unsubscribe(frame.subscriptionId, clientId);
    };
  }

  unsubscribe(subscriptionId: string, clientId = "local"): void {
    this.#subscriptions.delete(subscriptionMapKey(clientId, subscriptionId));
  }

  unsubscribeClient(clientId: string): void {
    const prefix = `${clientId}\n`;
    for (const key of [...this.#subscriptions.keys()]) {
      if (key.startsWith(prefix)) {
        this.#subscriptions.delete(key);
      }
    }
  }

  evaluateLane(frame: ShapeSubscribeFrame): Record<string, unknown>[] {
    switch (frame.lane) {
      case "kernel_meta": {
        return this.#database.drizzle.select().from(kernelStateTable).where(eq(kernelStateTable.id, "singleton")).all();
      }

      case "scope_nodes": {
        return this.#database.drizzle
          .select()
          .from(scopeNodesTable)
          .where(eq(scopeNodesTable.scopeId, frame.params.scopeId))
          .all();
      }

      case "session_nodes": {
        return this.#database.drizzle
          .select()
          .from(sessionNodesTable)
          .where(eq(sessionNodesTable.sessionId, frame.params.sessionId))
          .all();
      }

      case "active_sessions": {
        const activeCondition = sql`(${sessionsTable.running} = 1 OR ${sessionsTable.sessionId} IN (SELECT ${pendingAsksTable.sessionId} FROM ${pendingAsksTable}))`;
        const whereCondition = frame.params.workspacePath
          ? and(activeCondition, eq(sessionsTable.workspacePath, frame.params.workspacePath))
          : activeCondition;

        return this.#database.drizzle
          .select()
          .from(sessionsTable)
          .where(whereCondition)
          .orderBy(desc(sessionsTable.lastActiveAtMs))
          .all();
      }

      case "recent_sessions": {
        const conditions = [isNull(sessionsTable.archivedAtMs)];
        if (frame.params.workspacePath) {
          conditions.push(eq(sessionsTable.workspacePath, frame.params.workspacePath));
        }
        if (frame.params.beforeMs !== undefined) {
          conditions.push(lt(sessionsTable.lastActiveAtMs, frame.params.beforeMs));
        }

        return this.#database.drizzle
          .select()
          .from(sessionsTable)
          .where(and(...conditions))
          .orderBy(desc(sessionsTable.lastActiveAtMs))
          .limit(frame.params.limit)
          .all();
      }

      case "child_sessions": {
        return this.#database.drizzle
          .select()
          .from(sessionsTable)
          .where(eq(sessionsTable.parentSessionId, frame.params.parentSessionId))
          .orderBy(asc(sessionsTable.createdAtMs))
          .all();
      }

      case "pending_asks": {
        const base = this.#database.drizzle.select().from(pendingAsksTable);
        if (frame.params.sessionId) {
          return base
            .where(eq(pendingAsksTable.sessionId, frame.params.sessionId))
            .orderBy(asc(pendingAsksTable.createdAtMs))
            .all();
        }
        return base.orderBy(asc(pendingAsksTable.createdAtMs)).all();
      }

      default: {
        const _exhaustive: never = frame;
        throw new Error(`Unhandled lane: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  dispose(): void {
    this.#unsubscribeCommit();
    this.#subscriptions.clear();
  }

  #handleCommit(event: DatabaseCommitEvent): void {
    for (const sub of this.#subscriptions.values()) {
      // Fast O(delta) path for scope_nodes and session_nodes
      if (sub.frame.lane === "scope_nodes") {
        if (!event.touchedTables.includes("scope_nodes")) continue;
        const direct = event.scopeNodeChanges?.get(sub.frame.params.scopeId);
        if (direct) {
          if (direct.upserts.length === 0 && direct.deletes.length === 0 && !direct.reset) continue;
          sub.sink({
            kind: "shape/delta",
            subscriptionId: sub.subscriptionId,
            offset: event.offset,
            upserts: [...direct.upserts],
            deletes: [...direct.deletes],
            reset: direct.reset ?? false,
          });
        }
        continue;
      }

      if (sub.frame.lane === "session_nodes") {
        if (!event.touchedTables.includes("session_nodes")) continue;
        const direct = event.sessionNodeChanges?.get(sub.frame.params.sessionId);
        if (direct) {
          if (direct.upserts.length === 0 && direct.deletes.length === 0 && !direct.reset) continue;
          sub.sink({
            kind: "shape/delta",
            subscriptionId: sub.subscriptionId,
            offset: event.offset,
            upserts: [...direct.upserts],
            deletes: [...direct.deletes],
            reset: direct.reset ?? false,
          });
        }
        continue;
      }

      const sourceTables = LANE_SOURCE_TABLES[sub.frame.lane];
      const touched = sourceTables.some((table) => event.touchedTables.includes(table));
      if (!touched) {
        continue;
      }

      const newRows = this.evaluateLane(sub.frame);
      const pkField = LANE_PRIMARY_KEYS[sub.frame.lane];

      const newRowMap = new Map<string, { readonly row: Record<string, unknown>; readonly json: string }>();
      for (const row of newRows) {
        const pk = String(row[pkField]);
        const json = JSON.stringify(row);
        newRowMap.set(pk, { row, json });
      }

      const upserts: Record<string, unknown>[] = [];
      const deletes: string[] = [];

      for (const [pk, { row, json }] of newRowMap) {
        const prevJson = sub.lastRows.get(pk);
        if (prevJson === undefined || prevJson !== json) {
          upserts.push(row);
        }
      }

      for (const pk of sub.lastRows.keys()) {
        if (!newRowMap.has(pk)) {
          deletes.push(pk);
        }
      }

      if (upserts.length === 0 && deletes.length === 0) {
        continue;
      }

      sub.lastRows.clear();
      for (const [pk, { json }] of newRowMap) {
        sub.lastRows.set(pk, json);
      }

      sub.sink({
        kind: "shape/delta",
        subscriptionId: sub.subscriptionId,
        offset: event.offset,
        upserts,
        deletes,
        reset: false,
      });
    }
  }
}
