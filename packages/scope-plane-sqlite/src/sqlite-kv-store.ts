import {
  bootstrapHarnessSqliteSql,
  HARNESS_TABLE_NAMES,
  tables,
  type CellKind,
  type TableDef,
  type TableName,
} from "@inhuman.tools/harness-contract/schema";
import {
  collectBatchOps,
  deduplicateBatchUpserts,
  mintInitialCommitOffset,
  MutableCommitAccumulator,
  SESSION_CASCADE_TABLES,
  type BatchKeySpace,
  type BatchOp,
  type CommitDiff,
  type HarnessKvStore,
  type HarnessRowInsertMap,
  type HarnessRowMap,
  type ScanOrder,
  type ScanQuery,
  type ScanWhere,
  type SetOptions,
} from "@inhuman.tools/scope-plane";

import { openSqliteDriver, type SqliteDriverOptions, type SqliteStatement, type SqliteSyncDriver } from "./driver.js";

const SQLITE_PARAM_CHUNK = 400;

type FieldSpec = {
  readonly jsName: string;
  readonly sqlName: string;
  readonly kind: CellKind;
};

type TableMeta = {
  readonly def: TableDef;
  readonly pkJs: string;
  readonly pkSql: string;
  readonly fields: readonly FieldSpec[];
  readonly byJs: ReadonlyMap<string, FieldSpec>;
  readonly hasRevision: boolean;
};

const TABLE_META = new Map<TableName, TableMeta>();
for (const name of HARNESS_TABLE_NAMES) {
  const def = tables[name];
  const fields: FieldSpec[] = [
    { jsName: def.key, sqlName: def.keySql, kind: "string" },
    ...def.columns.map((col) => ({
      jsName: col.name,
      sqlName: col.sql,
      kind: col.kind,
    })),
  ];
  const byJs = new Map<string, FieldSpec>();
  for (const field of fields) {
    byJs.set(field.jsName, field);
  }
  TABLE_META.set(name, {
    def,
    pkJs: def.key,
    pkSql: def.keySql,
    fields,
    byJs,
    hasRevision: byJs.has("revision"),
  });
}

function metaOf(table: TableName): TableMeta {
  const meta = TABLE_META.get(table);
  if (meta === undefined) {
    throw new Error(`Unknown harness table: ${table}`);
  }
  return meta;
}

function toSqliteParam(value: unknown): string | number | Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || value instanceof Uint8Array) {
    return value;
  }
  return String(value);
}

function sqliteRowToJs<T extends TableName>(meta: TableMeta, raw: Record<string, unknown>): HarnessRowMap[T] {
  const out: Record<string, unknown> = {};
  for (const field of meta.fields) {
    const val = raw[field.sqlName];
    if (val === undefined || val === null) {
      out[field.jsName] = null;
    } else if (field.kind === "boolean") {
      out[field.jsName] = val === true || val === 1;
    } else if (field.kind === "number") {
      out[field.jsName] = Number(val);
    } else {
      out[field.jsName] = String(val);
    }
  }
  return out as HarnessRowMap[T];
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

function buildWhereClause(
  meta: TableMeta,
  where: ScanWhere<Record<string, unknown>> | undefined,
  params: unknown[],
): string {
  if (where === undefined) return "";
  const clauses: string[] = [];

  for (const [jsName, filter] of Object.entries(where)) {
    if (filter === undefined) continue;
    const field = meta.byJs.get(jsName);
    if (field === undefined) {
      throw new Error(`Unknown column ${meta.def.sql}.${jsName}`);
    }
    const colSql = `"${field.sqlName}"`;

    if (!isFilterObject(filter)) {
      if (filter === null) {
        clauses.push(`${colSql} IS NULL`);
      } else {
        clauses.push(`${colSql} = ?`);
        params.push(toSqliteParam(filter));
      }
      continue;
    }

    if (filter.isNull === true) {
      clauses.push(`${colSql} IS NULL`);
    } else if (filter.isNull === false) {
      clauses.push(`${colSql} IS NOT NULL`);
    }

    if (filter.eq !== undefined) {
      if (filter.eq === null) {
        clauses.push(`${colSql} IS NULL`);
      } else {
        clauses.push(`${colSql} = ?`);
        params.push(toSqliteParam(filter.eq));
      }
    }

    if (filter.in !== undefined) {
      if (filter.in.length === 0) {
        clauses.push("1 = 0");
      } else {
        const placeholders = filter.in.map(() => "?").join(", ");
        clauses.push(`${colSql} IN (${placeholders})`);
        for (const item of filter.in) {
          params.push(toSqliteParam(item));
        }
      }
    }

    if (filter.lt !== undefined) {
      clauses.push(`${colSql} < ?`);
      params.push(toSqliteParam(filter.lt));
    }
    if (filter.lte !== undefined) {
      clauses.push(`${colSql} <= ?`);
      params.push(toSqliteParam(filter.lte));
    }
    if (filter.gt !== undefined) {
      clauses.push(`${colSql} > ?`);
      params.push(toSqliteParam(filter.gt));
    }
    if (filter.gte !== undefined) {
      clauses.push(`${colSql} >= ?`);
      params.push(toSqliteParam(filter.gte));
    }
  }

  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function buildOrderClause(meta: TableMeta, orderBy: ScanOrder<Record<string, unknown>> | undefined): string {
  if (orderBy === undefined || orderBy.length === 0) return "";
  const parts = orderBy.map((clause) => {
    const field = meta.byJs.get(clause.column);
    if (field === undefined) {
      throw new Error(`Unknown order column ${meta.def.sql}.${clause.column}`);
    }
    const dir = clause.direction === "desc" ? "DESC" : "ASC";
    return `"${field.sqlName}" ${dir}`;
  });
  return ` ORDER BY ${parts.join(", ")}`;
}

export type SqliteKvStoreOptions = SqliteDriverOptions;

export class SqliteKvStore implements HarnessKvStore {
  readonly #driver: SqliteSyncDriver;
  readonly #listeners = new Set<(diff: CommitDiff) => void>();
  readonly #upsertStmtCache = new Map<string, SqliteStatement>();
  #offset = mintInitialCommitOffset();
  #closed = false;

  constructor(path = ":memory:", options?: SqliteKvStoreOptions) {
    this.#driver = openSqliteDriver(path, options);
    if (options?.readonly !== true) {
      this.#driver.exec(bootstrapHarnessSqliteSql);
    }
  }

  get driver(): SqliteSyncDriver {
    return this.#driver;
  }

  get currentOffset(): number {
    return this.#offset;
  }

  setReadOnly(readOnly: boolean): void {
    this.#assertOpen();
    this.#driver.pragma(`query_only = ${readOnly ? "ON" : "OFF"}`);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("SqliteKvStore is closed");
    }
  }

  async get<T extends TableName>(table: T, key: string): Promise<HarnessRowMap[T] | undefined> {
    this.#assertOpen();
    const meta = metaOf(table);
    const raw = this.#driver.prepare(`SELECT * FROM "${meta.def.sql}" WHERE "${meta.pkSql}" = ? LIMIT 1`).get(key);
    return raw !== undefined ? sqliteRowToJs<T>(meta, raw) : undefined;
  }

  async scan<T extends TableName>(table: T, query?: ScanQuery<HarnessRowMap[T]>): Promise<readonly HarnessRowMap[T][]> {
    this.#assertOpen();
    const meta = metaOf(table);
    const params: unknown[] = [];
    const whereSql = buildWhereClause(meta, query?.where as ScanWhere<Record<string, unknown>> | undefined, params);
    const orderSql = buildOrderClause(meta, query?.orderBy as ScanOrder<Record<string, unknown>> | undefined);
    const limitSql = query?.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : "";
    const rows = this.#driver
      .prepare(`SELECT * FROM "${meta.def.sql}"${whereSql}${orderSql}${limitSql}`)
      .all(...params);
    return rows.map((raw) => sqliteRowToJs<T>(meta, raw));
  }

  async keys<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<readonly string[]> {
    this.#assertOpen();
    const meta = metaOf(table);
    const params: unknown[] = [];
    const whereSql = buildWhereClause(meta, where as ScanWhere<Record<string, unknown>> | undefined, params);
    const rows = this.#driver.prepare(`SELECT "${meta.pkSql}" AS pk FROM "${meta.def.sql}"${whereSql}`).all(...params);
    return rows.map((row) => String(row.pk));
  }

  async count<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<number> {
    this.#assertOpen();
    const meta = metaOf(table);
    const params: unknown[] = [];
    const whereSql = buildWhereClause(meta, where as ScanWhere<Record<string, unknown>> | undefined, params);
    const row = this.#driver.prepare(`SELECT COUNT(*) AS cnt FROM "${meta.def.sql}"${whereSql}`).get(...params);
    return Number(row?.cnt ?? 0);
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
    this.#assertOpen();
    const ops = collectBatchOps(fn);
    if (ops.length === 0) {
      return { offset: this.#offset, spaces: [] };
    }

    const acc = new MutableCommitAccumulator();
    const runTx = this.#driver.transaction(() => {
      for (const op of ops) {
        this.#applyOp(op, acc);
      }
    });
    runTx();

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

  #getUpsertStatement(table: TableName, meta: TableMeta, options?: SetOptions): SqliteStatement {
    const mode =
      options?.ifAbsent === true
        ? "ifAbsent"
        : options?.monotonicRevision === true && meta.hasRevision
          ? "monotonic"
          : "upsert";
    const cacheKey = `${table}:${mode}`;
    const cached = this.#upsertStmtCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const cols = meta.fields.map((f) => `"${f.sqlName}"`).join(", ");
    const placeholders = meta.fields.map(() => "?").join(", ");
    const updateCols = meta.fields
      .filter((f) => f.jsName !== meta.pkJs)
      .map((f) => `"${f.sqlName}" = excluded."${f.sqlName}"`)
      .join(", ");

    let sql: string;
    if (mode === "ifAbsent") {
      sql = `INSERT INTO "${meta.def.sql}" (${cols}) VALUES (${placeholders}) ON CONFLICT("${meta.pkSql}") DO NOTHING RETURNING *`;
    } else if (mode === "monotonic") {
      sql = `INSERT INTO "${meta.def.sql}" (${cols}) VALUES (${placeholders}) ON CONFLICT("${meta.pkSql}") DO UPDATE SET ${updateCols} WHERE "${meta.def.sql}"."revision" <= excluded."revision" RETURNING *`;
    } else {
      sql = `INSERT INTO "${meta.def.sql}" (${cols}) VALUES (${placeholders}) ON CONFLICT("${meta.pkSql}") DO UPDATE SET ${updateCols} RETURNING *`;
    }

    const stmt = this.#driver.prepare(sql);
    this.#upsertStmtCache.set(cacheKey, stmt);
    return stmt;
  }

  #applyOp(op: BatchOp, acc: MutableCommitAccumulator): void {
    const meta = metaOf(op.table);
    switch (op.kind) {
      case "setMany": {
        const rows = deduplicateBatchUpserts(op.table, op.rows, op.options);
        const stmt = this.#getUpsertStatement(op.table, meta, op.options);
        for (const row of rows) {
          const rec = row as Record<string, unknown>;
          const params = meta.fields.map((f) => toSqliteParam(rec[f.jsName]));
          const returned = stmt.get(...params);
          if (returned !== undefined) {
            acc.recordUpsert(op.table, sqliteRowToJs(meta, returned));
          }
        }
        return;
      }

      case "deleteMany": {
        this.#deleteByKeys(op.table, meta, op.keys, acc);
        return;
      }

      case "deleteWhere": {
        const params: unknown[] = [];
        const whereSql = buildWhereClause(meta, op.where, params);
        this.#deleteWhereSql(op.table, meta, whereSql, params, acc);
        return;
      }

      case "retainOnly": {
        if (op.keepKeys.length === 0) {
          const params: unknown[] = [];
          const whereSql = buildWhereClause(meta, op.where, params);
          this.#deleteWhereSql(op.table, meta, whereSql, params, acc);
          return;
        }
        if (op.keepKeys.length <= SQLITE_PARAM_CHUNK) {
          const params: unknown[] = [];
          const whereSql = buildWhereClause(meta, op.where, params);
          const prefix = whereSql === "" ? " WHERE " : `${whereSql} AND `;
          const notIn = op.keepKeys.map(() => "?").join(", ");
          this.#deleteWhereSql(
            op.table,
            meta,
            `${prefix}"${meta.pkSql}" NOT IN (${notIn})`,
            [...params, ...op.keepKeys],
            acc,
          );
          return;
        }
        const params: unknown[] = [];
        const whereSql = buildWhereClause(meta, op.where, params);
        const keepSet = new Set(op.keepKeys);
        const toDelete = this.#driver
          .prepare(`SELECT "${meta.pkSql}" AS pk FROM "${meta.def.sql}"${whereSql}`)
          .all(...params)
          .map((row) => String(row.pk))
          .filter((pk) => !keepSet.has(pk));
        if (toDelete.length > 0) {
          this.#deleteByKeys(op.table, meta, toDelete, acc);
        }
        return;
      }
    }
  }

  #deleteByKeys(table: TableName, meta: TableMeta, keys: readonly string[], acc: MutableCommitAccumulator): void {
    if (keys.length === 0) return;
    if (table === "sessions") {
      this.#cascadeDeleteSessionsByIds(keys, acc);
    }
    for (let i = 0; i < keys.length; i += SQLITE_PARAM_CHUNK) {
      const chunk = keys.slice(i, i + SQLITE_PARAM_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const deleted = this.#driver
        .prepare(`DELETE FROM "${meta.def.sql}" WHERE "${meta.pkSql}" IN (${placeholders}) RETURNING *`)
        .all(...chunk);
      for (const raw of deleted) {
        acc.recordDelete(table, sqliteRowToJs(meta, raw));
      }
    }
  }

  #deleteWhereSql(
    table: TableName,
    meta: TableMeta,
    whereSql: string,
    params: readonly unknown[],
    acc: MutableCommitAccumulator,
  ): void {
    if (table === "sessions") {
      const sessionRows = this.#driver
        .prepare(`SELECT "session_id" AS session_id FROM "sessions"${whereSql}`)
        .all(...params);
      if (sessionRows.length === 0) return;
      this.#cascadeDeleteSessionsByIds(
        sessionRows.map((row) => String(row.session_id)),
        acc,
      );
    }
    const deleted = this.#driver.prepare(`DELETE FROM "${meta.def.sql}"${whereSql} RETURNING *`).all(...params);
    for (const raw of deleted) {
      acc.recordDelete(table, sqliteRowToJs(meta, raw));
    }
  }

  #cascadeDeleteSessionsByIds(sessionIds: readonly string[], acc: MutableCommitAccumulator): void {
    if (sessionIds.length === 0) return;
    for (let i = 0; i < sessionIds.length; i += SQLITE_PARAM_CHUNK) {
      const chunk = sessionIds.slice(i, i + SQLITE_PARAM_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      for (const childTable of SESSION_CASCADE_TABLES) {
        const childMeta = metaOf(childTable);
        const deleted = this.#driver
          .prepare(`DELETE FROM "${childMeta.def.sql}" WHERE "session_id" IN (${placeholders}) RETURNING *`)
          .all(...chunk);
        for (const raw of deleted) {
          acc.recordDelete(childTable, sqliteRowToJs(childMeta, raw));
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
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#upsertStmtCache.clear();
    this.#driver.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
