import {
  HARNESS_POSTGRES_DDL,
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

import { assertPgIdentifier, quotePgIdent, type PgDriverPort, type PgExecutor } from "./driver.js";

type PgColumnType = "text" | "integer" | "bigint" | "boolean";

const INTEGER_FIELDS = new Set(["revision", "depth", "ordinal"]);

type FieldSpec = {
  readonly jsName: string;
  readonly sqlName: string;
  readonly kind: CellKind;
  readonly pgType: PgColumnType;
};

type TableMeta = {
  readonly def: TableDef;
  readonly pkJs: string;
  readonly pkSql: string;
  readonly fields: readonly FieldSpec[];
  readonly byJs: ReadonlyMap<string, FieldSpec>;
  readonly hasRevision: boolean;
};

function pgTypeForField(jsName: string, kind: CellKind): PgColumnType {
  if (kind === "boolean") return "boolean";
  if (kind === "number") return INTEGER_FIELDS.has(jsName) ? "integer" : "bigint";
  return "text";
}

const TABLE_META = new Map<TableName, TableMeta>();
for (const name of HARNESS_TABLE_NAMES) {
  const def = tables[name];
  const fields: FieldSpec[] = [
    { jsName: def.key, sqlName: def.keySql, kind: "string", pgType: "text" },
    ...def.columns.map((col) => ({
      jsName: col.name,
      sqlName: col.sql,
      kind: col.kind,
      pgType: pgTypeForField(col.name, col.kind),
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

function toPgParam(field: FieldSpec, value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (field.kind === "boolean") {
    return value === true || value === "true" || value === "t" || value === 1;
  }
  if (field.kind === "number") {
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : 0;
  }
  return typeof value === "string" ? value : String(value);
}

function pgRowToJs<T extends TableName>(meta: TableMeta, raw: Record<string, unknown>): HarnessRowMap[T] {
  const out: Record<string, unknown> = {};
  for (const field of meta.fields) {
    const val = raw[field.sqlName];
    if (val === undefined || val === null) {
      out[field.jsName] = null;
    } else if (field.kind === "boolean") {
      out[field.jsName] = val === true || val === "true" || val === "t" || val === 1;
    } else if (field.kind === "number") {
      out[field.jsName] = Number(val);
    } else {
      out[field.jsName] = typeof val === "string" ? val : String(val);
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

function buildPgWhereClause(
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
        params.push(toPgParam(field, filter));
        clauses.push(`${colSql} = $${params.length}`);
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
        params.push(toPgParam(field, filter.eq));
        clauses.push(`${colSql} = $${params.length}`);
      }
    }

    if (filter.in !== undefined) {
      if (filter.in.length === 0) {
        clauses.push("FALSE");
      } else {
        params.push(filter.in.map((item) => toPgParam(field, item)));
        clauses.push(`${colSql} = ANY($${params.length}::${field.pgType}[])`);
      }
    }

    if (filter.lt !== undefined) {
      params.push(toPgParam(field, filter.lt));
      clauses.push(`${colSql} < $${params.length}`);
    }
    if (filter.lte !== undefined) {
      params.push(toPgParam(field, filter.lte));
      clauses.push(`${colSql} <= $${params.length}`);
    }
    if (filter.gt !== undefined) {
      params.push(toPgParam(field, filter.gt));
      clauses.push(`${colSql} > $${params.length}`);
    }
    if (filter.gte !== undefined) {
      params.push(toPgParam(field, filter.gte));
      clauses.push(`${colSql} >= $${params.length}`);
    }
  }

  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function buildPgOrderClause(meta: TableMeta, orderBy: ScanOrder<Record<string, unknown>> | undefined): string {
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

export type PostgresKvStoreOptions = {
  /** PostgreSQL schema containing harness tables (default `"public"`). */
  readonly schema?: string;
  /** Call `driver.close()` when `store.close()` runs (default `false`). */
  readonly ownsDriver?: boolean;
};

export class PostgresKvStore implements HarnessKvStore {
  readonly #driver: PgDriverPort;
  readonly #schema: string;
  readonly #schemaIdent: string;
  readonly #ownsDriver: boolean;
  readonly #listeners = new Set<(diff: CommitDiff) => void>();
  readonly #upsertSqlCache = new Map<string, string>();
  #offset = mintInitialCommitOffset();
  #writeChain: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(driver: PgDriverPort, options?: PostgresKvStoreOptions) {
    this.#driver = driver;
    this.#schema = assertPgIdentifier(options?.schema ?? "public", "PostgreSQL schema");
    this.#schemaIdent = quotePgIdent(this.#schema);
    this.#ownsDriver = options?.ownsDriver === true;
  }

  get schema(): string {
    return this.#schema;
  }

  get driver(): PgDriverPort {
    return this.#driver;
  }

  get currentOffset(): number {
    return this.#offset;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("PostgresKvStore is closed");
    }
  }

  #qualTable(tableSql: string): string {
    return `${this.#schemaIdent}.${quotePgIdent(tableSql)}`;
  }

  /** Idempotently create the target schema and all 11 canonical harness tables. */
  async bootstrap(): Promise<void> {
    this.#assertOpen();
    await this.#driver.transaction(async (tx) => {
      if (this.#schema !== "public") {
        await tx.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schemaIdent}`);
      }
      await tx.query(`SET LOCAL search_path TO ${this.#schemaIdent}`);
      for (const stmt of HARNESS_POSTGRES_DDL) {
        await tx.query(stmt);
      }
    });
  }

  async get<T extends TableName>(table: T, key: string): Promise<HarnessRowMap[T] | undefined> {
    this.#assertOpen();
    const meta = metaOf(table);
    const result = await this.#driver.query(
      `SELECT * FROM ${this.#qualTable(meta.def.sql)} WHERE "${meta.pkSql}" = $1 LIMIT 1`,
      [key],
    );
    const raw = result.rows[0];
    return raw !== undefined ? pgRowToJs<T>(meta, raw) : undefined;
  }

  async scan<T extends TableName>(table: T, query?: ScanQuery<HarnessRowMap[T]>): Promise<readonly HarnessRowMap[T][]> {
    this.#assertOpen();
    const meta = metaOf(table);
    const params: unknown[] = [];
    const whereSql = buildPgWhereClause(meta, query?.where as ScanWhere<Record<string, unknown>> | undefined, params);
    const orderSql = buildPgOrderClause(meta, query?.orderBy as ScanOrder<Record<string, unknown>> | undefined);
    let limitSql = "";
    if (query?.limit !== undefined) {
      params.push(Math.max(0, Math.floor(query.limit)));
      limitSql = ` LIMIT $${params.length}`;
    }
    const result = await this.#driver.query(
      `SELECT * FROM ${this.#qualTable(meta.def.sql)}${whereSql}${orderSql}${limitSql}`,
      params,
    );
    return result.rows.map((raw) => pgRowToJs<T>(meta, raw));
  }

  async keys<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<readonly string[]> {
    this.#assertOpen();
    const meta = metaOf(table);
    const params: unknown[] = [];
    const whereSql = buildPgWhereClause(meta, where as ScanWhere<Record<string, unknown>> | undefined, params);
    const result = await this.#driver.query<{ readonly pk: string }>(
      `SELECT "${meta.pkSql}" AS pk FROM ${this.#qualTable(meta.def.sql)}${whereSql}`,
      params,
    );
    return result.rows.map((row) => String(row.pk));
  }

  async count<T extends TableName>(table: T, where?: ScanWhere<HarnessRowMap[T]>): Promise<number> {
    this.#assertOpen();
    const meta = metaOf(table);
    const params: unknown[] = [];
    const whereSql = buildPgWhereClause(meta, where as ScanWhere<Record<string, unknown>> | undefined, params);
    const result = await this.#driver.query<{ readonly cnt: string | number }>(
      `SELECT COUNT(*) AS cnt FROM ${this.#qualTable(meta.def.sql)}${whereSql}`,
      params,
    );
    return Number(result.rows[0]?.cnt ?? 0);
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

    const run = this.#writeChain.then(() => this.#executeBatch(ops));
    this.#writeChain = run.catch(() => {});
    return run;
  }

  async #executeBatch(ops: readonly BatchOp[]): Promise<CommitDiff> {
    this.#assertOpen();
    const acc = new MutableCommitAccumulator();
    await this.#driver.transaction(async (tx) => {
      for (const op of ops) {
        await this.#applyOp(tx, op, acc);
      }
    });

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

  #getUpsertSql(table: TableName, meta: TableMeta, options?: SetOptions): string {
    const mode =
      options?.ifAbsent === true
        ? "ifAbsent"
        : options?.monotonicRevision === true && meta.hasRevision
          ? "monotonic"
          : "upsert";
    const cacheKey = `${table}:${mode}`;
    const cached = this.#upsertSqlCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const qualTable = this.#qualTable(meta.def.sql);
    const cols = meta.fields.map((f) => `"${f.sqlName}"`).join(", ");
    const unnestArgs = meta.fields.map((f, idx) => `$${idx + 1}::${f.pgType}[]`).join(", ");
    const updateCols = meta.fields
      .filter((f) => f.jsName !== meta.pkJs)
      .map((f) => `"${f.sqlName}" = EXCLUDED."${f.sqlName}"`)
      .join(", ");

    let sql: string;
    if (mode === "ifAbsent") {
      sql =
        `INSERT INTO ${qualTable} (${cols}) ` +
        `SELECT * FROM UNNEST(${unnestArgs}) AS _u(${cols}) ` +
        `ON CONFLICT ("${meta.pkSql}") DO NOTHING RETURNING *`;
    } else if (mode === "monotonic") {
      sql =
        `INSERT INTO ${qualTable} (${cols}) ` +
        `SELECT * FROM UNNEST(${unnestArgs}) AS _u(${cols}) ` +
        `ON CONFLICT ("${meta.pkSql}") DO UPDATE SET ${updateCols} ` +
        `WHERE ${qualTable}."revision" <= EXCLUDED."revision" RETURNING *`;
    } else {
      sql =
        `INSERT INTO ${qualTable} (${cols}) ` +
        `SELECT * FROM UNNEST(${unnestArgs}) AS _u(${cols}) ` +
        `ON CONFLICT ("${meta.pkSql}") DO UPDATE SET ${updateCols} RETURNING *`;
    }

    this.#upsertSqlCache.set(cacheKey, sql);
    return sql;
  }

  async #applyOp(tx: PgExecutor, op: BatchOp, acc: MutableCommitAccumulator): Promise<void> {
    const meta = metaOf(op.table);
    switch (op.kind) {
      case "setMany": {
        const rows = deduplicateBatchUpserts(op.table, op.rows, op.options);
        if (rows.length === 0) return;
        const columnArrays = meta.fields.map((field) =>
          rows.map((row) => toPgParam(field, (row as Record<string, unknown>)[field.jsName])),
        );
        const sql = this.#getUpsertSql(op.table, meta, op.options);
        const result = await tx.query(sql, columnArrays);
        for (const raw of result.rows) {
          acc.recordUpsert(op.table, pgRowToJs(meta, raw));
        }
        return;
      }

      case "deleteMany": {
        await this.#deleteByKeys(tx, op.table, meta, op.keys, acc);
        return;
      }

      case "deleteWhere": {
        const params: unknown[] = [];
        const whereSql = buildPgWhereClause(meta, op.where, params);
        await this.#deleteWhereSql(tx, op.table, meta, whereSql, params, acc);
        return;
      }

      case "retainOnly": {
        const params: unknown[] = [];
        const whereSql = buildPgWhereClause(meta, op.where, params);
        if (op.keepKeys.length === 0) {
          await this.#deleteWhereSql(tx, op.table, meta, whereSql, params, acc);
          return;
        }
        const prefix = whereSql === "" ? " WHERE " : `${whereSql} AND `;
        params.push([...op.keepKeys]);
        const fullWhere = `${prefix}NOT ("${meta.pkSql}" = ANY($${params.length}::text[]))`;
        await this.#deleteWhereSql(tx, op.table, meta, fullWhere, params, acc);
        return;
      }
    }
  }

  async #deleteByKeys(
    tx: PgExecutor,
    table: TableName,
    meta: TableMeta,
    keys: readonly string[],
    acc: MutableCommitAccumulator,
  ): Promise<void> {
    if (keys.length === 0) return;
    if (table === "sessions") {
      await this.#cascadeDeleteSessionsByIds(tx, keys, acc);
    }
    const result = await tx.query(
      `DELETE FROM ${this.#qualTable(meta.def.sql)} WHERE "${meta.pkSql}" = ANY($1::text[]) RETURNING *`,
      [[...keys]],
    );
    for (const raw of result.rows) {
      acc.recordDelete(table, pgRowToJs(meta, raw));
    }
  }

  async #deleteWhereSql(
    tx: PgExecutor,
    table: TableName,
    meta: TableMeta,
    whereSql: string,
    params: readonly unknown[],
    acc: MutableCommitAccumulator,
  ): Promise<void> {
    if (table === "sessions") {
      const sessionRows = await tx.query<{ readonly session_id: string }>(
        `SELECT "session_id" AS session_id FROM ${this.#qualTable("sessions")}${whereSql}`,
        params,
      );
      if (sessionRows.rows.length === 0) return;
      await this.#cascadeDeleteSessionsByIds(
        tx,
        sessionRows.rows.map((row) => String(row.session_id)),
        acc,
      );
    }
    const result = await tx.query(`DELETE FROM ${this.#qualTable(meta.def.sql)}${whereSql} RETURNING *`, params);
    for (const raw of result.rows) {
      acc.recordDelete(table, pgRowToJs(meta, raw));
    }
  }

  async #cascadeDeleteSessionsByIds(
    tx: PgExecutor,
    sessionIds: readonly string[],
    acc: MutableCommitAccumulator,
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    const ids = [...sessionIds];
    for (const childTable of SESSION_CASCADE_TABLES) {
      const childMeta = metaOf(childTable);
      const result = await tx.query(
        `DELETE FROM ${this.#qualTable(childMeta.def.sql)} WHERE "session_id" = ANY($1::text[]) RETURNING *`,
        [ids],
      );
      for (const raw of result.rows) {
        acc.recordDelete(childTable, pgRowToJs(childMeta, raw));
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
    await this.#writeChain.catch(() => {});
    this.#listeners.clear();
    this.#upsertSqlCache.clear();
    if (this.#ownsDriver && this.#driver.close !== undefined) {
      await this.#driver.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
