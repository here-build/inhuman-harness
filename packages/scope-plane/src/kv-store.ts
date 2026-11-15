import {
  HARNESS_TABLE_NAMES,
  tables,
  type KernelStateRow,
  type KernelStateRowInsert,
  type PendingAskRow,
  type PendingAskRowInsert,
  type PluginStateLogRow,
  type PluginStateLogRowInsert,
  type ProjectRow,
  type ProjectRowInsert,
  type ScmResourceRow,
  type ScmResourceRowInsert,
  type ScopeNodeRow,
  type ScopeNodeRowInsert,
  type SessionBlobRow,
  type SessionBlobRowInsert,
  type SessionEffectRow,
  type SessionEffectRowInsert,
  type SessionNodeRow,
  type SessionNodeRowInsert,
  type SessionRow,
  type SessionRowInsert,
  type SessionTurnRow,
  type SessionTurnRowInsert,
  type TableDef,
  type TableName,
} from "@inhuman.tools/harness-contract/schema";

export type HarnessRowMap = {
  readonly kernel_state: KernelStateRow;
  readonly projects: ProjectRow;
  readonly scope_nodes: ScopeNodeRow;
  readonly sessions: SessionRow;
  readonly pending_asks: PendingAskRow;
  readonly session_turns: SessionTurnRow;
  readonly session_nodes: SessionNodeRow;
  readonly session_effects: SessionEffectRow;
  readonly session_blobs: SessionBlobRow;
  readonly scm_resources: ScmResourceRow;
  readonly plugin_state_logs: PluginStateLogRow;
};

export type HarnessRowInsertMap = {
  readonly kernel_state: KernelStateRowInsert;
  readonly projects: ProjectRowInsert;
  readonly scope_nodes: ScopeNodeRowInsert;
  readonly sessions: SessionRowInsert;
  readonly pending_asks: PendingAskRowInsert;
  readonly session_turns: SessionTurnRowInsert;
  readonly session_nodes: SessionNodeRowInsert;
  readonly session_effects: SessionEffectRowInsert;
  readonly session_blobs: SessionBlobRowInsert;
  readonly scm_resources: ScmResourceRowInsert;
  readonly plugin_state_logs: PluginStateLogRowInsert;
};

export type ColumnFilter<V> =
  | V
  | {
      readonly eq?: V;
      readonly in?: readonly Exclude<V, null>[];
      readonly lt?: Exclude<V, null>;
      readonly lte?: Exclude<V, null>;
      readonly gt?: Exclude<V, null>;
      readonly gte?: Exclude<V, null>;
      readonly isNull?: boolean;
    };

export type ScanWhere<TRow extends Record<string, unknown>> = {
  readonly [K in keyof TRow]?: ColumnFilter<TRow[K]>;
};

export type ScanOrder<TRow extends Record<string, unknown>> = readonly {
  readonly column: keyof TRow & string;
  readonly direction: "asc" | "desc";
}[];

export type ScanQuery<TRow extends Record<string, unknown>> = {
  readonly where?: ScanWhere<TRow>;
  readonly orderBy?: ScanOrder<TRow>;
  readonly limit?: number;
};

export type SetOptions = {
  /** Skip update if existing row already has `revision > incoming.revision`. */
  readonly monotonicRevision?: boolean;
  /** Insert only when the primary key does not already exist. */
  readonly ifAbsent?: boolean;
};

export type SpaceDiff<T extends TableName = TableName> = {
  readonly table: T;
  readonly upserts: readonly HarnessRowMap[T][];
  readonly deletes: readonly string[];
  readonly deletedRows?: readonly HarnessRowMap[T][];
};

export type CommitDiff = {
  readonly offset: number;
  readonly spaces: readonly SpaceDiff[];
};

export interface ReadonlyKeySpace {
  get<T extends TableName>(table: T, key: string): Promise<HarnessRowMap[T] | undefined>;
  scan<T extends TableName>(table: T, query?: ScanQuery<HarnessRowMap[T]>): Promise<readonly HarnessRowMap[T][]>;
  keys<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<readonly string[]>;
  count<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<number>;
}

export interface BatchKeySpace {
  set<T extends TableName>(table: T, row: HarnessRowInsertMap[T], options?: SetOptions): void;
  setMany<T extends TableName>(table: T, rows: readonly HarnessRowInsertMap[T][], options?: SetOptions): void;
  delete(table: TableName, key: string): void;
  deleteMany(table: TableName, keys: readonly string[]): void;
  deleteWhere<T extends TableName>(table: T, where: ScanWhere<HarnessRowMap[T]>): void;
  retainOnly<T extends TableName>(table: T, where: ScanWhere<HarnessRowMap[T]>, keepKeys: readonly string[]): void;
}

export interface HarnessKvStore extends ReadonlyKeySpace, AsyncDisposable {
  set<T extends TableName>(table: T, row: HarnessRowInsertMap[T], options?: SetOptions): Promise<CommitDiff>;
  setMany<T extends TableName>(
    table: T,
    rows: readonly HarnessRowInsertMap[T][],
    options?: SetOptions,
  ): Promise<CommitDiff>;
  delete(table: TableName, key: string): Promise<CommitDiff>;
  deleteWhere<T extends TableName>(table: TableName, where: ScanWhere<HarnessRowMap[T]>): Promise<CommitDiff>;
  batch(fn: (tx: BatchKeySpace) => void): Promise<CommitDiff>;
  readonly currentOffset: number;
  onCommit(listener: (diff: CommitDiff) => void): () => void;
  close(): Promise<void>;
}

export const SESSION_CASCADE_TABLES = [
  "pending_asks",
  "session_turns",
  "session_nodes",
  "session_effects",
  "session_blobs",
] as const satisfies readonly TableName[];

let lastInitialCommitOffset = 0;

export function mintInitialCommitOffset(): number {
  const candidate = Date.now() * 1000;
  lastInitialCommitOffset = candidate > lastInitialCommitOffset ? candidate : lastInitialCommitOffset + 1;
  return lastInitialCommitOffset;
}

const HARNESS_ROW_DEFAULTS: Record<TableName, Readonly<Record<string, unknown>>> = {
  kernel_state: {
    id: "local",
    kernelId: "local",
    defaultModel: "",
    permissionMode: "manual",
    enabledPluginsJson: "[]",
    kvsJson: "{}",
  },
  projects: {
    kernelId: "local",
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
  },
  scope_nodes: {
    kernelId: "local",
    isRoot: false,
  },
  sessions: {
    kernelId: "local",
    projectId: "",
    title: "",
    workspacePath: "",
    mode: "assistant",
    permissionMode: "manual",
    running: false,
    headTurnId: null,
    parentSessionId: null,
    parentCallId: null,
    depth: 0,
    revision: 0,
    archivedAtMs: null,
  },
  pending_asks: {
    kernelId: "local",
  },
  session_turns: {
    kernelId: "local",
    cancelRequested: false,
    reducerExited: false,
    endedAtMs: null,
  },
  session_nodes: {
    kernelId: "local",
    isRoot: false,
  },
  session_effects: {
    kernelId: "local",
    phase: "committed",
  },
  session_blobs: {
    kernelId: "local",
    turnId: null,
  },
  scm_resources: {
    kernelId: "local",
  },
  plugin_state_logs: {
    kernelId: "local",
    namespace: "default",
    logJson: "[]",
  },
};

export function normalizeHarnessRow<T extends TableName>(table: T, input: HarnessRowInsertMap[T]): HarnessRowMap[T] {
  const def: TableDef = tables[table];
  const defaults = HARNESS_ROW_DEFAULTS[table];
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const rawKey = source[def.key] ?? defaults[def.key];
  if (rawKey === undefined || rawKey === null) {
    throw new TypeError(`Missing required primary key ${table}.${def.key}`);
  }
  out[def.key] = rawKey;

  for (const col of def.columns) {
    const rawVal = source[col.name];
    if (rawVal !== undefined) {
      out[col.name] = rawVal;
    } else if (col.name in defaults) {
      out[col.name] = defaults[col.name];
    } else if (!col.required) {
      out[col.name] = null;
    } else {
      throw new TypeError(`Missing required column ${table}.${col.name}`);
    }
  }

  return out as HarnessRowMap[T];
}

export function getRowPrimaryKey<T extends TableName>(table: T, row: Readonly<Record<string, unknown>>): string {
  const keyField = tables[table].key;
  const val = row[keyField];
  if (val === undefined || val === null) {
    throw new TypeError(`Missing primary key ${table}.${keyField}`);
  }
  return String(val);
}

function isFilterObject(value: unknown): value is {
  readonly eq?: unknown;
  readonly in?: readonly unknown[];
  readonly lt?: unknown;
  readonly lte?: unknown;
  readonly gt?: unknown;
  readonly gte?: unknown;
  readonly isNull?: boolean;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function matchesWhere<TRow extends Record<string, unknown>>(row: TRow, where?: ScanWhere<TRow>): boolean {
  if (where === undefined) return true;
  for (const [col, filter] of Object.entries(where)) {
    if (filter === undefined) continue;
    const val = row[col];
    if (!isFilterObject(filter)) {
      if (val !== filter) return false;
      continue;
    }
    if (filter.isNull !== undefined) {
      if (filter.isNull && val !== null) return false;
      if (!filter.isNull && (val === null || val === undefined)) return false;
    }
    if (filter.eq !== undefined && val !== filter.eq) return false;
    if (filter.in !== undefined && !filter.in.includes(val)) return false;
    if (
      filter.lt !== undefined &&
      (val === null || val === undefined || (val as number | string) >= (filter.lt as number | string))
    ) {
      return false;
    }
    if (
      filter.lte !== undefined &&
      (val === null || val === undefined || (val as number | string) > (filter.lte as number | string))
    ) {
      return false;
    }
    if (
      filter.gt !== undefined &&
      (val === null || val === undefined || (val as number | string) <= (filter.gt as number | string))
    ) {
      return false;
    }
    if (
      filter.gte !== undefined &&
      (val === null || val === undefined || (val as number | string) < (filter.gte as number | string))
    ) {
      return false;
    }
  }
  return true;
}

export function compareOrder<TRow extends Record<string, unknown>>(
  a: TRow,
  b: TRow,
  orderBy?: ScanOrder<TRow>,
): number {
  if (orderBy === undefined || orderBy.length === 0) return 0;
  for (const clause of orderBy) {
    const va = a[clause.column];
    const vb = b[clause.column];
    if (va === vb) continue;
    const mult = clause.direction === "asc" ? 1 : -1;
    if (va == null) return -1 * mult;
    if (vb == null) return 1 * mult;
    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * mult;
    }
    if (typeof va === "boolean" && typeof vb === "boolean") {
      return ((va ? 1 : 0) - (vb ? 1 : 0)) * mult;
    }
    const sa = String(va);
    const sb = String(vb);
    if (sa < sb) return -1 * mult;
    if (sa > sb) return 1 * mult;
  }
  return 0;
}

export function deduplicateBatchUpserts<T extends TableName>(
  table: T,
  rows: readonly HarnessRowInsertMap[T][],
  options?: SetOptions,
): HarnessRowMap[T][] {
  const byKey = new Map<string, HarnessRowMap[T]>();
  for (const raw of rows) {
    const normalized = normalizeHarnessRow(table, raw);
    const key = getRowPrimaryKey(table, normalized);
    const prev = byKey.get(key);
    if (prev === undefined) {
      byKey.set(key, normalized);
      continue;
    }
    if (options?.ifAbsent === true) {
      continue;
    }
    if (options?.monotonicRevision === true) {
      const prevRev = (prev as Record<string, unknown>).revision;
      const nextRev = (normalized as Record<string, unknown>).revision;
      if (typeof prevRev === "number" && typeof nextRev === "number" && prevRev > nextRev) {
        continue;
      }
    }
    byKey.set(key, normalized);
  }
  return [...byKey.values()];
}

export type BatchOp =
  | {
      readonly kind: "setMany";
      readonly table: TableName;
      readonly rows: readonly HarnessRowInsertMap[TableName][];
      readonly options?: SetOptions;
    }
  | {
      readonly kind: "deleteMany";
      readonly table: TableName;
      readonly keys: readonly string[];
    }
  | {
      readonly kind: "deleteWhere";
      readonly table: TableName;
      readonly where: ScanWhere<Record<string, unknown>>;
    }
  | {
      readonly kind: "retainOnly";
      readonly table: TableName;
      readonly where: ScanWhere<Record<string, unknown>>;
      readonly keepKeys: readonly string[];
    };

export function collectBatchOps(fn: (tx: BatchKeySpace) => void): BatchOp[] {
  const ops: BatchOp[] = [];
  const collector: BatchKeySpace = {
    set(table, row, options) {
      ops.push({ kind: "setMany", table, rows: [row], options });
    },
    setMany(table, rows, options) {
      if (rows.length > 0) {
        ops.push({ kind: "setMany", table, rows: [...rows], options });
      }
    },
    delete(table, key) {
      ops.push({ kind: "deleteMany", table, keys: [key] });
    },
    deleteMany(table, keys) {
      if (keys.length > 0) {
        ops.push({ kind: "deleteMany", table, keys: [...keys] });
      }
    },
    deleteWhere(table, where) {
      ops.push({
        kind: "deleteWhere",
        table,
        where: where as ScanWhere<Record<string, unknown>>,
      });
    },
    retainOnly(table, where, keepKeys) {
      ops.push({
        kind: "retainOnly",
        table,
        where: where as ScanWhere<Record<string, unknown>>,
        keepKeys: [...keepKeys],
      });
    },
  };
  fn(collector);
  return ops;
}

export class MutableCommitAccumulator {
  readonly #spaces = new Map<
    TableName,
    {
      readonly upserts: Map<string, Record<string, unknown>>;
      readonly deletes: Map<string, Record<string, unknown>>;
    }
  >();

  #entry(table: TableName) {
    let entry = this.#spaces.get(table);
    if (entry === undefined) {
      entry = { upserts: new Map(), deletes: new Map() };
      this.#spaces.set(table, entry);
    }
    return entry;
  }

  recordUpsert(table: TableName, row: Record<string, unknown>): void {
    const key = getRowPrimaryKey(table, row);
    const entry = this.#entry(table);
    entry.deletes.delete(key);
    entry.upserts.set(key, row);
  }

  recordDelete(table: TableName, row: Record<string, unknown>): void {
    const key = getRowPrimaryKey(table, row);
    const entry = this.#entry(table);
    entry.upserts.delete(key);
    entry.deletes.set(key, row);
  }

  hasChanges(): boolean {
    for (const entry of this.#spaces.values()) {
      if (entry.upserts.size > 0 || entry.deletes.size > 0) return true;
    }
    return false;
  }

  buildDiff(offset: number): CommitDiff {
    const spaces: SpaceDiff[] = [];
    for (const [table, entry] of this.#spaces) {
      if (entry.upserts.size === 0 && entry.deletes.size === 0) continue;
      const deletedRows = [...entry.deletes.values()];
      spaces.push({
        table,
        upserts: [...entry.upserts.values()] as HarnessRowMap[typeof table][],
        deletes: [...entry.deletes.keys()],
        ...(deletedRows.length > 0 ? { deletedRows: deletedRows as HarnessRowMap[typeof table][] } : {}),
      });
    }
    return { offset, spaces };
  }
}

export type MemoryKvStoreOptions = {
  readonly readOnly?: boolean;
};

export class MemoryKvStore implements HarnessKvStore {
  readonly #tables = new Map<TableName, Map<string, Record<string, unknown>>>();
  readonly #listeners = new Set<(diff: CommitDiff) => void>();
  #offset = mintInitialCommitOffset();
  #readOnly: boolean;
  #closed = false;

  constructor(options?: MemoryKvStoreOptions) {
    this.#readOnly = options?.readOnly ?? false;
    for (const table of HARNESS_TABLE_NAMES) {
      this.#tables.set(table, new Map());
    }
  }

  get currentOffset(): number {
    return this.#offset;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  setReadOnly(readOnly: boolean): void {
    this.#readOnly = readOnly;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("MemoryKvStore is closed");
    }
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (this.#readOnly) {
      throw new Error("MemoryKvStore is read-only");
    }
  }

  #tableMap(table: TableName): Map<string, Record<string, unknown>> {
    const map = this.#tables.get(table);
    if (map === undefined) {
      throw new Error(`Unknown harness table: ${table}`);
    }
    return map;
  }

  async get<T extends TableName>(table: T, key: string): Promise<HarnessRowMap[T] | undefined> {
    this.#assertOpen();
    const row = this.#tableMap(table).get(key);
    return row !== undefined ? ({ ...row } as HarnessRowMap[T]) : undefined;
  }

  async scan<T extends TableName>(table: T, query?: ScanQuery<HarnessRowMap[T]>): Promise<readonly HarnessRowMap[T][]> {
    this.#assertOpen();
    const rows: HarnessRowMap[T][] = [];
    for (const raw of this.#tableMap(table).values()) {
      const row = raw as HarnessRowMap[T];
      if (matchesWhere(row, query?.where)) {
        rows.push({ ...row });
      }
    }
    if (query?.orderBy !== undefined && query.orderBy.length > 0) {
      rows.sort((a, b) => compareOrder(a, b, query.orderBy));
    }
    if (query?.limit !== undefined) {
      return rows.slice(0, Math.max(0, query.limit));
    }
    return rows;
  }

  async keys<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<readonly string[]> {
    this.#assertOpen();
    const out: string[] = [];
    for (const [key, raw] of this.#tableMap(table)) {
      if (matchesWhere(raw as HarnessRowMap[T], where)) {
        out.push(key);
      }
    }
    return out;
  }

  async count<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<number> {
    this.#assertOpen();
    if (where === undefined) {
      return this.#tableMap(table).size;
    }
    let total = 0;
    for (const raw of this.#tableMap(table).values()) {
      if (matchesWhere(raw as HarnessRowMap[T], where)) {
        total += 1;
      }
    }
    return total;
  }

  async set<T extends TableName>(table: T, row: HarnessRowInsertMap[T], options?: SetOptions): Promise<CommitDiff> {
    return this.batch((tx) => tx.set(table, row, options));
  }

  async setMany<T extends TableName>(
    table: T,
    rows: readonly HarnessRowInsertMap[T][],
    options?: SetOptions,
  ): Promise<CommitDiff> {
    return this.batch((tx) => tx.setMany(table, rows, options));
  }

  async delete(table: TableName, key: string): Promise<CommitDiff> {
    return this.batch((tx) => tx.delete(table, key));
  }

  async deleteWhere<T extends TableName>(table: T, where: ScanWhere<HarnessRowMap[T]>): Promise<CommitDiff> {
    return this.batch((tx) => tx.deleteWhere(table, where));
  }

  async batch(fn: (tx: BatchKeySpace) => void): Promise<CommitDiff> {
    this.#assertWritable();
    const ops = collectBatchOps(fn);
    if (ops.length === 0) {
      return { offset: this.#offset, spaces: [] };
    }

    // Snapshot before mutating so any thrown error rolls back atomically.
    const backup = new Map<TableName, Map<string, Record<string, unknown>>>();
    for (const [name, map] of this.#tables) {
      backup.set(name, new Map(map));
    }

    const acc = new MutableCommitAccumulator();
    try {
      for (const op of ops) {
        this.#applyOp(op, acc);
      }
    } catch (error) {
      for (const [name, prevMap] of backup) {
        this.#tables.set(name, prevMap);
      }
      throw error;
    }

    if (!acc.hasChanges()) {
      return { offset: this.#offset, spaces: [] };
    }

    this.#offset += 1;
    const diff = acc.buildDiff(this.#offset);
    for (const listener of this.#listeners) {
      listener(diff);
    }
    return diff;
  }

  #applyOp(op: BatchOp, acc: MutableCommitAccumulator): void {
    const map = this.#tableMap(op.table);
    switch (op.kind) {
      case "setMany": {
        const rows = deduplicateBatchUpserts(op.table, op.rows, op.options);
        for (const row of rows) {
          const key = getRowPrimaryKey(op.table, row);
          const existing = map.get(key);
          if (existing !== undefined && op.options?.ifAbsent === true) {
            continue;
          }
          if (existing !== undefined && op.options?.monotonicRevision === true) {
            const existingRev = existing.revision;
            const nextRev = (row as Record<string, unknown>).revision;
            if (typeof existingRev === "number" && typeof nextRev === "number" && existingRev > nextRev) {
              continue;
            }
          }
          const copy = { ...row } as Record<string, unknown>;
          map.set(key, copy);
          acc.recordUpsert(op.table, copy);
        }
        return;
      }

      case "deleteMany": {
        const deletedSessionIds: string[] = [];
        for (const key of op.keys) {
          const existing = map.get(key);
          if (existing === undefined) continue;
          map.delete(key);
          acc.recordDelete(op.table, existing);
          if (op.table === "sessions") {
            deletedSessionIds.push(key);
          }
        }
        this.#cascadeSessionDeletes(deletedSessionIds, acc);
        return;
      }

      case "deleteWhere": {
        const deletedSessionIds: string[] = [];
        for (const [key, row] of [...map.entries()]) {
          if (!matchesWhere(row, op.where)) continue;
          map.delete(key);
          acc.recordDelete(op.table, row);
          if (op.table === "sessions") {
            deletedSessionIds.push(key);
          }
        }
        this.#cascadeSessionDeletes(deletedSessionIds, acc);
        return;
      }

      case "retainOnly": {
        const keep = new Set(op.keepKeys);
        const deletedSessionIds: string[] = [];
        for (const [key, row] of [...map.entries()]) {
          if (keep.has(key) || !matchesWhere(row, op.where)) continue;
          map.delete(key);
          acc.recordDelete(op.table, row);
          if (op.table === "sessions") {
            deletedSessionIds.push(key);
          }
        }
        this.#cascadeSessionDeletes(deletedSessionIds, acc);
        return;
      }
    }
  }

  #cascadeSessionDeletes(deletedSessionIds: readonly string[], acc: MutableCommitAccumulator): void {
    if (deletedSessionIds.length === 0) return;
    const victimSessions = new Set(deletedSessionIds);
    for (const childTable of SESSION_CASCADE_TABLES) {
      const childMap = this.#tableMap(childTable);
      for (const [key, row] of [...childMap.entries()]) {
        if (typeof row.sessionId === "string" && victimSessions.has(row.sessionId)) {
          childMap.delete(key);
          acc.recordDelete(childTable, row);
        }
      }
    }
  }

  onCommit(listener: (diff: CommitDiff) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
