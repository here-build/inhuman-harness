import {
  shapeSubscribeFrameSchema,
  splitRowPairId,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type TableName,
  type UpdateLaneName,
} from "@inhuman.tools/harness-contract/schema";

import { compareOrder, type CommitDiff, type HarnessKvStore, type SpaceDiff } from "./kv-store.js";

export const LANE_SOURCE_TABLES: Record<UpdateLaneName, readonly TableName[]> = {
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

export interface ShapeSource extends Disposable {
  subscribe(frame: unknown, sink: (delta: ShapeDeltaFrame) => void, clientId?: string): () => void;
  unsubscribe(subscriptionId: string, clientId?: string): void;
  unsubscribeClient(clientId: string): void;
  evaluateLane?(frame: ShapeSubscribeFrame): Promise<Record<string, unknown>[]>;
  dispose(): void;
}

export type CommitDiffShapeSourceOptions = {
  readonly defaultKernelId?: string;
  readonly onError?: (error: unknown, subscriptionId: string) => void;
};

type ListEvalResult = Map<string, { readonly row: Record<string, unknown>; readonly json: string }>;

interface ActiveSubscription {
  readonly key: string;
  readonly clientId: string;
  readonly subscriptionId: string;
  readonly frame: ShapeSubscribeFrame;
  readonly sink: (delta: ShapeDeltaFrame) => void;
  readonly lastRows: Map<string, string>;
  readonly bufferedDiffs: CommitDiff[];
  initialized: boolean;
  disposed: boolean;
  refreshing: boolean;
  pendingRefreshOffset: number | null;
}

function subscriptionMapKey(clientId: string, subscriptionId: string): string {
  return `${clientId}\n${subscriptionId}`;
}

function scopeRouteKey(kernelId: string, scopeId: string): string {
  return `${kernelId}\0${scopeId}`;
}

function buildRowMap(rows: readonly Record<string, unknown>[], pkField: string): ListEvalResult {
  const map: ListEvalResult = new Map();
  for (const row of rows) {
    const pk = String(row[pkField]);
    map.set(pk, { row, json: JSON.stringify(row) });
  }
  return map;
}

function extractDirectNodeDelta(
  space: SpaceDiff<"scope_nodes" | "session_nodes">,
  scopeField: "scopeId" | "sessionId",
): {
  readonly byRoute: Map<string, { readonly upserts: Record<string, unknown>[]; readonly deletes: string[] }>;
  readonly unknownDeleteIds: string[];
} {
  const byRoute = new Map<string, { readonly upserts: Record<string, unknown>[]; readonly deletes: string[] }>();
  const ensure = (key: string) => {
    let entry = byRoute.get(key);
    if (entry === undefined) {
      entry = { upserts: [], deletes: [] };
      byRoute.set(key, entry);
    }
    return entry;
  };

  for (const row of space.upserts) {
    const rec = row as Record<string, unknown>;
    ensure(scopeRouteKey(String(rec.kernelId), String(rec[scopeField]))).upserts.push(rec);
  }

  const resolvedDeleteIds = new Set<string>();
  const pkField = "id";
  if (space.deletedRows !== undefined) {
    for (const row of space.deletedRows) {
      const rec = row as Record<string, unknown>;
      const id = String(rec[pkField]);
      resolvedDeleteIds.add(id);
      ensure(scopeRouteKey(String(rec.kernelId), String(rec[scopeField]))).deletes.push(id);
    }
  }

  const unknownDeleteIds: string[] = [];
  for (const id of space.deletes) {
    if (!resolvedDeleteIds.has(id)) {
      unknownDeleteIds.push(id);
    }
  }

  return { byRoute, unknownDeleteIds };
}

export class CommitDiffShapeSource implements ShapeSource {
  readonly #store: HarnessKvStore;
  readonly #defaultKernelId: string;
  readonly #onError?: (error: unknown, subscriptionId: string) => void;
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  readonly #unsubscribeCommit: () => void;
  #disposed = false;

  constructor(store: HarnessKvStore, options?: CommitDiffShapeSourceOptions) {
    this.#store = store;
    this.#defaultKernelId = options?.defaultKernelId ?? "local";
    this.#onError = options?.onError;
    this.#unsubscribeCommit = this.#store.onCommit((diff) => this.#handleCommit(diff));
  }

  get store(): HarnessKvStore {
    return this.#store;
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  hasSubscription(subscriptionId: string, clientId = "local"): boolean {
    return this.#subscriptions.has(subscriptionMapKey(clientId, subscriptionId));
  }

  subscribe(rawFrame: unknown, sink: (delta: ShapeDeltaFrame) => void, clientId = "local"): () => void {
    const frame = shapeSubscribeFrameSchema.parse(rawFrame);
    const key = subscriptionMapKey(clientId, frame.subscriptionId);

    const existing = this.#subscriptions.get(key);
    if (existing !== undefined) {
      existing.disposed = true;
    }

    const sub: ActiveSubscription = {
      key,
      clientId,
      subscriptionId: frame.subscriptionId,
      frame,
      sink,
      lastRows: new Map(),
      bufferedDiffs: [],
      initialized: false,
      disposed: false,
      refreshing: false,
      pendingRefreshOffset: null,
    };
    this.#subscriptions.set(key, sub);

    void this.#initializeSubscription(sub);

    return () => {
      this.unsubscribe(frame.subscriptionId, clientId);
    };
  }

  unsubscribe(subscriptionId: string, clientId = "local"): void {
    const key = subscriptionMapKey(clientId, subscriptionId);
    const sub = this.#subscriptions.get(key);
    if (sub !== undefined) {
      sub.disposed = true;
      this.#subscriptions.delete(key);
    }
  }

  unsubscribeClient(clientId: string): void {
    const prefix = `${clientId}\n`;
    for (const key of [...this.#subscriptions.keys()]) {
      if (key.startsWith(prefix)) {
        const sub = this.#subscriptions.get(key);
        if (sub !== undefined) sub.disposed = true;
        this.#subscriptions.delete(key);
      }
    }
  }

  async evaluateLane(frame: ShapeSubscribeFrame): Promise<Record<string, unknown>[]> {
    const targetKernelId = frame.params.kernelId ?? this.#defaultKernelId;
    switch (frame.lane) {
      case "kernel_meta": {
        const rows = await this.#store.scan("kernel_state", {
          where: { kernelId: targetKernelId },
        });
        if (rows.length === 0 && targetKernelId === "local") {
          return [...(await this.#store.scan("kernel_state", { where: { id: "singleton" } }))];
        }
        return [...rows];
      }

      case "scope_nodes": {
        const rows = await this.#store.scan("scope_nodes", {
          where: {
            kernelId: targetKernelId,
            scopeId: frame.params.scopeId,
          },
        });
        return [...rows];
      }

      case "session_nodes": {
        const rows = await this.#store.scan("session_nodes", {
          where: {
            kernelId: targetKernelId,
            sessionId: frame.params.sessionId,
          },
        });
        return [...rows];
      }

      case "active_sessions": {
        const projectId = frame.params.projectId;
        const workspacePath = frame.params.workspacePath;
        const baseWhere = {
          kernelId: targetKernelId,
          ...(projectId ? { projectId } : {}),
          ...(workspacePath ? { workspacePath } : {}),
        };
        const [runningRows, askRows] = await Promise.all([
          this.#store.scan("sessions", {
            where: { ...baseWhere, running: true },
            orderBy: [{ column: "lastActiveAtMs", direction: "desc" }],
          }),
          this.#store.scan("pending_asks", {
            where: { kernelId: targetKernelId },
          }),
        ]);
        const runningIds = new Set(runningRows.map((row) => row.sessionId));
        const extraIds = [...new Set(askRows.map((row) => row.sessionId).filter((id) => !runningIds.has(id)))];
        if (extraIds.length === 0) {
          return [...runningRows];
        }
        const askSessionRows = await this.#store.scan("sessions", {
          where: { ...baseWhere, sessionId: { in: extraIds } },
        });
        const combined = [...runningRows, ...askSessionRows];
        combined.sort((a, b) => compareOrder(a, b, [{ column: "lastActiveAtMs", direction: "desc" }]));
        return combined;
      }

      case "recent_sessions": {
        const projectId = frame.params.projectId;
        const workspacePath = frame.params.workspacePath;
        const beforeMs = frame.params.beforeMs;
        const rows = await this.#store.scan("sessions", {
          where: {
            kernelId: targetKernelId,
            archivedAtMs: null,
            ...(projectId ? { projectId } : {}),
            ...(workspacePath ? { workspacePath } : {}),
            ...(beforeMs !== undefined ? { lastActiveAtMs: { lt: beforeMs } } : {}),
          },
          orderBy: [{ column: "lastActiveAtMs", direction: "desc" }],
          limit: frame.params.limit,
        });
        return [...rows];
      }

      case "child_sessions": {
        const rows = await this.#store.scan("sessions", {
          where: {
            kernelId: targetKernelId,
            parentSessionId: frame.params.parentSessionId,
          },
          orderBy: [{ column: "createdAtMs", direction: "asc" }],
        });
        return [...rows];
      }

      case "pending_asks": {
        const rows = await this.#store.scan("pending_asks", {
          where: {
            kernelId: targetKernelId,
            ...(frame.params.sessionId ? { sessionId: frame.params.sessionId } : {}),
          },
          orderBy: [{ column: "createdAtMs", direction: "asc" }],
        });
        return [...rows];
      }

      default: {
        const _exhaustive: never = frame;
        throw new Error(`Unhandled lane: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribeCommit();
    for (const sub of this.#subscriptions.values()) {
      sub.disposed = true;
    }
    this.#subscriptions.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  async #initializeSubscription(sub: ActiveSubscription): Promise<void> {
    try {
      const startOffset = this.#store.currentOffset;
      const rows = await this.evaluateLane(sub.frame);
      if (sub.disposed || this.#disposed) return;

      const isDirectNodeLane = sub.frame.lane === "scope_nodes" || sub.frame.lane === "session_nodes";
      if (!isDirectNodeLane) {
        const pkField = LANE_PRIMARY_KEYS[sub.frame.lane];
        for (const row of rows) {
          sub.lastRows.set(String(row[pkField]), JSON.stringify(row));
        }
      }

      const buffered = sub.bufferedDiffs.splice(0);
      const isResumingUnchanged = sub.frame.offset !== undefined && sub.frame.offset === startOffset;
      const latestBufferedOffset = buffered.length > 0 ? Math.max(...buffered.map((diff) => diff.offset)) : startOffset;

      sub.initialized = true;
      sub.sink({
        kind: "shape/delta",
        subscriptionId: sub.subscriptionId,
        offset: startOffset,
        upserts: isResumingUnchanged ? [] : rows,
        deletes: [],
        reset: !isResumingUnchanged,
      });

      if (buffered.length === 0) return;

      if (isDirectNodeLane) {
        for (const diff of buffered) {
          if (sub.disposed || this.#disposed) return;
          this.#applyDirectNodeDiff(sub, diff);
        }
      } else {
        const sourceTables = LANE_SOURCE_TABLES[sub.frame.lane];
        const relevant = buffered.some((diff) => diff.spaces.some((space) => sourceTables.includes(space.table)));
        if (relevant) {
          this.#scheduleListRefresh(sub, latestBufferedOffset);
        }
      }
    } catch (error) {
      if (!sub.disposed && !this.#disposed) {
        this.#onError?.(error, sub.subscriptionId);
      }
    }
  }

  #handleCommit(diff: CommitDiff): void {
    const sharedEval = new Map<string, Promise<ListEvalResult>>();
    const touchedTables = new Set(diff.spaces.map((space) => space.table));

    const scopeSpace = touchedTables.has("scope_nodes")
      ? (diff.spaces.find((s) => s.table === "scope_nodes") as SpaceDiff<"scope_nodes"> | undefined)
      : undefined;
    const sessionSpace = touchedTables.has("session_nodes")
      ? (diff.spaces.find((s) => s.table === "session_nodes") as SpaceDiff<"session_nodes"> | undefined)
      : undefined;

    const scopeDelta = scopeSpace !== undefined ? extractDirectNodeDelta(scopeSpace, "scopeId") : undefined;
    const sessionDelta = sessionSpace !== undefined ? extractDirectNodeDelta(sessionSpace, "sessionId") : undefined;

    for (const sub of this.#subscriptions.values()) {
      if (sub.disposed || this.#disposed) continue;
      if (!sub.initialized) {
        sub.bufferedDiffs.push(diff);
        continue;
      }

      if (sub.frame.lane === "scope_nodes") {
        if (scopeDelta !== undefined) {
          this.#emitDirectNodeDelta(sub, diff.offset, scopeDelta, sub.frame.params.scopeId);
        }
        continue;
      }

      if (sub.frame.lane === "session_nodes") {
        if (sessionDelta !== undefined) {
          this.#emitDirectNodeDelta(sub, diff.offset, sessionDelta, sub.frame.params.sessionId);
        }
        continue;
      }

      const sourceTables = LANE_SOURCE_TABLES[sub.frame.lane];
      const touched = sourceTables.some((table) => touchedTables.has(table));
      if (!touched) continue;

      this.#scheduleListRefresh(sub, diff.offset, sharedEval);
    }
  }

  #applyDirectNodeDiff(sub: ActiveSubscription, diff: CommitDiff): void {
    if (sub.frame.lane === "scope_nodes") {
      const space = diff.spaces.find((s) => s.table === "scope_nodes") as SpaceDiff<"scope_nodes"> | undefined;
      if (space === undefined) return;
      this.#emitDirectNodeDelta(sub, diff.offset, extractDirectNodeDelta(space, "scopeId"), sub.frame.params.scopeId);
      return;
    }
    if (sub.frame.lane === "session_nodes") {
      const space = diff.spaces.find((s) => s.table === "session_nodes") as SpaceDiff<"session_nodes"> | undefined;
      if (space === undefined) return;
      this.#emitDirectNodeDelta(
        sub,
        diff.offset,
        extractDirectNodeDelta(space, "sessionId"),
        sub.frame.params.sessionId,
      );
    }
  }

  #emitDirectNodeDelta(
    sub: ActiveSubscription,
    offset: number,
    extracted: ReturnType<typeof extractDirectNodeDelta>,
    targetScopeOrSessionId: string,
  ): void {
    const targetKernelId = sub.frame.params.kernelId ?? this.#defaultKernelId;
    const direct = extracted.byRoute.get(scopeRouteKey(targetKernelId, targetScopeOrSessionId));

    let extraDeletes: string[] | undefined;
    if (extracted.unknownDeleteIds.length > 0) {
      let needsFullRescan = false;
      const matched: string[] = [];
      for (const rawId of extracted.unknownDeleteIds) {
        const pair = splitRowPairId(rawId);
        if (pair === null) {
          needsFullRescan = true;
          break;
        }
        const pairScope = pair[0];
        const expectedScope =
          sub.frame.lane === "scope_nodes" && targetKernelId !== "local"
            ? `${targetKernelId}:${targetScopeOrSessionId}`
            : targetScopeOrSessionId;
        if (pairScope === expectedScope) {
          matched.push(rawId);
        }
      }
      if (needsFullRescan) {
        this.#scheduleNodeReset(sub, offset);
        return;
      }
      if (matched.length > 0) {
        extraDeletes = matched;
      }
    }

    const upserts = direct?.upserts ?? [];
    const deletes =
      extraDeletes !== undefined ? [...(direct?.deletes ?? []), ...extraDeletes] : (direct?.deletes ?? []);
    if (upserts.length === 0 && deletes.length === 0) return;

    sub.sink({
      kind: "shape/delta",
      subscriptionId: sub.subscriptionId,
      offset,
      upserts: [...upserts],
      deletes: [...deletes],
      reset: false,
    });
  }

  #scheduleNodeReset(sub: ActiveSubscription, offset: number): void {
    if (sub.refreshing) {
      sub.pendingRefreshOffset = Math.max(sub.pendingRefreshOffset ?? offset, offset);
      return;
    }
    sub.refreshing = true;
    void (async () => {
      let currentOffset = offset;
      while (!sub.disposed && !this.#disposed) {
        try {
          const rows = await this.evaluateLane(sub.frame);
          if (sub.disposed || this.#disposed) return;
          sub.sink({
            kind: "shape/delta",
            subscriptionId: sub.subscriptionId,
            offset: currentOffset,
            upserts: rows,
            deletes: [],
            reset: true,
          });
        } catch (error) {
          if (!sub.disposed && !this.#disposed) {
            this.#onError?.(error, sub.subscriptionId);
          }
        }
        const nextOffset = sub.pendingRefreshOffset;
        sub.pendingRefreshOffset = null;
        if (nextOffset === null) break;
        currentOffset = nextOffset;
      }
      sub.refreshing = false;
    })();
  }

  #scheduleListRefresh(
    sub: ActiveSubscription,
    offset: number,
    sharedEval?: Map<string, Promise<ListEvalResult>>,
  ): void {
    if (sub.refreshing) {
      sub.pendingRefreshOffset = Math.max(sub.pendingRefreshOffset ?? offset, offset);
      return;
    }
    sub.refreshing = true;

    const runOne = async (runOffset: number, memoMap?: Map<string, Promise<ListEvalResult>>) => {
      const targetKernelId = sub.frame.params.kernelId ?? this.#defaultKernelId;
      const cacheKey = `${sub.frame.lane}\0${targetKernelId}\0${JSON.stringify(sub.frame.params)}`;
      let evalPromise = memoMap?.get(cacheKey);
      if (evalPromise === undefined) {
        const pkField = LANE_PRIMARY_KEYS[sub.frame.lane];
        evalPromise = this.evaluateLane(sub.frame).then((rows) => buildRowMap(rows, pkField));
        memoMap?.set(cacheKey, evalPromise);
      }
      const newRowMap = await evalPromise;
      if (sub.disposed || this.#disposed) return;

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

      if (upserts.length === 0 && deletes.length === 0) return;

      sub.lastRows.clear();
      for (const [pk, { json }] of newRowMap) {
        sub.lastRows.set(pk, json);
      }

      sub.sink({
        kind: "shape/delta",
        subscriptionId: sub.subscriptionId,
        offset: runOffset,
        upserts,
        deletes,
        reset: false,
      });
    };

    void (async () => {
      let currentOffset = offset;
      let currentMemo = sharedEval;
      while (!sub.disposed && !this.#disposed) {
        try {
          await runOne(currentOffset, currentMemo);
        } catch (error) {
          if (!sub.disposed && !this.#disposed) {
            this.#onError?.(error, sub.subscriptionId);
          }
        }
        currentMemo = undefined;
        const nextOffset = sub.pendingRefreshOffset;
        sub.pendingRefreshOffset = null;
        if (nextOffset === null) break;
        currentOffset = nextOffset;
      }
      sub.refreshing = false;
    })();
  }
}

export { CommitDiffShapeSource as UpdateLaneHub };
