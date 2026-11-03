import { Shape, ShapeStream } from "@electric-sql/client";
import {
  coerceCell,
  columnOf,
  createScopePlane,
  tables,
  type Cell,
  type Row,
  type RowMatch,
  type RowPlane,
  type RowReader,
  type ScopePlane,
  type TableName,
} from "@inhuman.tools/scope-plane";

/**
 * Queries must resolve after their transaction commits. Electric provides
 * invalidation; reads use SQL. Atomic read snapshots require the optional port.
 */
export type ElectricSql = {
  query(text: string, params: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** Run every callback query in one repeatable-read (or stronger) transaction. */
  snapshot?<T>(read: (sql: ElectricSql) => Promise<T>): Promise<T>;
};

export type ElectricShapes = {
  /** Wake on initial catch-up and reconnect, as well as subsequent commits. */
  subscribe(table: string, where: string, params: readonly unknown[], onChange: () => void): () => void;
};

export type ElectricIo = {
  readonly sql: ElectricSql;
  readonly shapes: ElectricShapes;
};

function ident(sql: string): string {
  if (!/^[a-z_]+$/.test(sql)) throw new Error(`refused sql identifier ${sql}`);
  return sql;
}

function columnSql(table: TableName, name: string): string {
  if (name === tables[table].key) return ident(tables[table].keySql);
  const field = columnOf(table, name);
  if (field == null) throw new Error(`unknown column ${table}.${name}`);
  return ident(field.sql);
}

function rowValues(table: TableName, row: Row): unknown[] {
  return tables[table].columns.map((field) => {
    if (!Object.hasOwn(row, field.name)) {
      if (field.required) throw new Error(`missing ${table}.${field.name}`);
      return null;
    }
    return row[field.name];
  });
}

function fromRecord(table: TableName, record: Record<string, unknown>): Row {
  const row: Record<string, Cell> = {};
  for (const field of tables[table].columns) {
    const value = coerceCell(field.kind, record[field.sql]);
    if (value !== undefined) row[field.name] = value;
  }
  return row;
}

function idOf(table: TableName, record: Record<string, unknown>): string {
  const value = record[tables[table].keySql];
  if (typeof value !== "string" || value === "") throw new Error(`missing ${table} id`);
  return value;
}

function insertSql(table: TableName, conflict: "update" | "absent"): string {
  const def = tables[table];
  const names = [ident(def.keySql), ...def.columns.map((field) => ident(field.sql))];
  const slots = names.map((_, index) => `$${index + 1}`).join(", ");
  const into = `INSERT INTO ${ident(def.sql)} (${names.join(", ")})`;
  if (conflict === "absent") {
    return `${into} VALUES (${slots}) ON CONFLICT (${ident(def.keySql)}) DO NOTHING RETURNING ${ident(def.keySql)}`;
  }
  const assignments = def.columns.map((field) => {
    const sql = ident(field.sql);
    return `${sql} = EXCLUDED.${sql}`;
  });
  return `${into} VALUES (${slots}) ON CONFLICT (${ident(def.keySql)}) DO UPDATE SET ${assignments.join(", ")}`;
}

export function createElectricRowPlane(io: ElectricIo): RowPlane {
  const rows: RowPlane = {
    async get(table, id) {
      const records = await io.sql.query(
        `SELECT * FROM ${ident(tables[table].sql)} WHERE ${ident(tables[table].keySql)} = $1`,
        [id],
      );
      if (records.length === 0) return undefined;
      return fromRecord(table, records[0]);
    },
    async list(table, column, equals) {
      const records = await io.sql.query(
        `SELECT * FROM ${ident(tables[table].sql)} WHERE ${columnSql(table, column)} = $1`,
        [equals],
      );
      return records.map((record) => ({ id: idOf(table, record), row: fromRecord(table, record) }));
    },
    async put(table, id, row) {
      await io.sql.query(insertSql(table, "update"), [id, ...rowValues(table, row)]);
    },
    async remove(table, id) {
      await io.sql.query(`DELETE FROM ${ident(tables[table].sql)} WHERE ${ident(tables[table].keySql)} = $1`, [id]);
    },
    async replaceIf(table, id, column, expected, row) {
      if (expected === undefined) {
        const records = await io.sql.query(insertSql(table, "absent"), [id, ...rowValues(table, row)]);
        return records.length > 0;
      }
      const assignments = tables[table].columns.map((field, index) => `${ident(field.sql)} = $${index + 2}`);
      const expectSlot = tables[table].columns.length + 2;
      const records = await io.sql.query(
        `UPDATE ${ident(tables[table].sql)} SET ${assignments.join(", ")} WHERE ${ident(tables[table].keySql)} = $1 AND ${columnSql(table, column)} = $${expectSlot} RETURNING ${ident(tables[table].keySql)}`,
        [id, ...rowValues(table, row), expected],
      );
      return records.length > 0;
    },
    async insertIfAbsent(table, id, row) {
      const records = await io.sql.query(insertSql(table, "absent"), [id, ...rowValues(table, row)]);
      return records.length > 0;
    },
    async replaceIfMatch(table, id, expected, row) {
      const def = tables[table];
      const assignments = def.columns.map((field, index) => `${ident(field.sql)} = $${index + 2}`);
      const keys = Object.keys(expected).sort();
      const start = def.columns.length + 2;
      const clauses = keys.map((key, index) => `${columnSql(table, key)} = $${start + index}`);
      const where = clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`;
      const records = await io.sql.query(
        `UPDATE ${ident(def.sql)} SET ${assignments.join(", ")} WHERE ${ident(def.keySql)} = $1${where} RETURNING ${ident(def.keySql)}`,
        [id, ...rowValues(table, row), ...keys.map((key) => expected[key])],
      );
      return records.length > 0;
    },
    async removeIf(table, id, expected) {
      const keys = Object.keys(expected).sort();
      const clauses = keys.map((key, index) => `${columnSql(table, key)} = $${index + 2}`);
      const where = clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`;
      const records = await io.sql.query(
        `DELETE FROM ${ident(tables[table].sql)} WHERE ${ident(tables[table].keySql)} = $1${where} RETURNING ${ident(tables[table].keySql)}`,
        [id, ...keys.map((key) => expected[key])],
      );
      return records.length > 0;
    },
    watch(table, match: RowMatch, onChange) {
      if ("id" in match) {
        return io.shapes.subscribe(
          ident(tables[table].sql),
          `${ident(tables[table].keySql)} = $1`,
          [match.id],
          onChange,
        );
      }
      return io.shapes.subscribe(
        ident(tables[table].sql),
        `${columnSql(table, match.column)} = $1`,
        [match.equals],
        onChange,
      );
    },
    async commitOwned(claim, mutation) {
      if (claim.holder === "") return false;
      const def = tables[mutation.table];
      const table = ident(def.sql);
      const key = ident(def.keySql);
      const params: unknown[] = [claim.sessionId, claim.scopeId, claim.generation, claim.holder, mutation.id];
      const ownership =
        "WITH ownership AS MATERIALIZED (SELECT session_id FROM generations WHERE session_id = $1 AND scope_id = $2 AND generation = $3 AND holder = $4 FOR UPDATE)";
      const expected = Object.entries(mutation.existing).sort(([a], [b]) => a.localeCompare(b));
      let sql: string;
      if (mutation.row == null) {
        const clauses = expected.map(([column, value]) => {
          params.push(value);
          return `${table}.${columnSql(mutation.table, column)} = $${params.length}`;
        });
        sql = `${ownership} DELETE FROM ${table} WHERE ${key} = $5 AND EXISTS (SELECT 1 FROM ownership)${clauses.map((clause) => ` AND ${clause}`).join("")} RETURNING ${key}`;
      } else {
        params.push(...rowValues(mutation.table, mutation.row));
        const names = [key, ...def.columns.map((column) => ident(column.sql))];
        const slots = names.map((_, index) => `$${index + 5}`);
        const assignments = def.columns.map((column) => `${ident(column.sql)} = EXCLUDED.${ident(column.sql)}`);
        const clauses = expected.map(([column, value]) => {
          params.push(value);
          return `${table}.${columnSql(mutation.table, column)} = $${params.length}`;
        });
        const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
        sql = `${ownership} INSERT INTO ${table} (${names.join(", ")}) SELECT ${slots.join(", ")} FROM ownership WHERE true ON CONFLICT (${key}) DO UPDATE SET ${assignments.join(", ")}${where} RETURNING ${key}`;
      }
      return (await io.sql.query(sql, params)).length > 0;
    },
  };
  const snapshot = io.sql.snapshot;
  if (snapshot) {
    rows.snapshot = <T>(read: (reader: RowReader) => Promise<T>): Promise<T> =>
      snapshot((sql) => read(createElectricRowPlane({ ...io, sql })));
  }
  return rows;
}

export function createElectricScopePlane(io: ElectricIo): ScopePlane {
  return createScopePlane(createElectricRowPlane(io));
}

/** Live shape stream. The server product depends on `@electric-sql/client`. */
export function electricShapeFromUrl(url: string): ElectricShapes {
  const root = url.replace(/\/$/, "");
  return {
    subscribe(table, where, params, onChange) {
      const stream = new ShapeStream({
        url: `${root}/v1/shape`,
        params: {
          table,
          where,
          params: params.map(String),
        },
      });
      const shape = new Shape(stream);
      return shape.subscribe(() => {
        onChange();
      });
    },
  };
}
