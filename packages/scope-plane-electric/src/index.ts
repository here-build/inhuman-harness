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
  type ScopePlane,
  type TableName,
} from "@inhuman.tools/scope-plane";

/**
 * Writes are ordinary SQL. Electric only wakes `watch` after a commit.
 * `read` goes back to Postgres, so a subscriber never serves a stale shape row.
 */
export type ElectricSql = {
  query(text: string, params: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
};

export type ElectricShapes = {
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
    return `${into} SELECT ${slots} WHERE NOT EXISTS (SELECT 1 FROM ${ident(def.sql)} WHERE ${ident(def.keySql)} = $1) RETURNING ${ident(def.keySql)}`;
  }
  const assignments = def.columns.map((field) => {
    const sql = ident(field.sql);
    return `${sql} = EXCLUDED.${sql}`;
  });
  return `${into} VALUES (${slots}) ON CONFLICT (${ident(def.keySql)}) DO UPDATE SET ${assignments.join(", ")}`;
}

export function createElectricRowPlane(io: ElectricIo): RowPlane {
  return {
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
  };
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
