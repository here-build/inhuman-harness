import type { ElectricShapes, ElectricSql } from "../index.js";

type Rec = Record<string, unknown>;

function bag(db: Map<string, Map<string, Rec>>, table: string): Map<string, Rec> {
  const existing = db.get(table);
  if (existing != null) return existing;
  const created = new Map<string, Rec>();
  db.set(table, created);
  return created;
}

function tableOf(text: string): string {
  const found = /(?:INTO|UPDATE|FROM) ([a-z_]+)/.exec(text);
  const name = found?.[1];
  if (name == null) throw new Error(`no table in ${text}`);
  return name;
}

function columnsOf(text: string): string[] {
  const list = /\(([^)]+)\)/.exec(text)?.[1];
  if (list == null) return [];
  return list.split(",").map((part) => part.trim());
}

function predicates(where: string): Array<{ column: string; index: number }> {
  return [...where.matchAll(/([a-z_]+) = \$(\d+)/g)].map((match) => ({
    column: match[1],
    index: Number(match[2]) - 1,
  }));
}

function matches(record: Rec, where: string, params: readonly unknown[]): boolean {
  return predicates(where).every((predicate) => record[predicate.column] === params[predicate.index]);
}

/**
 * Applies the SQL this package emits. Enough to run the same contract as TinyBase.
 * A write pokes shape subscribers the way Electric's replication stream would.
 */
export function createSqlDouble(): ElectricSql & {
  readonly shapes: ElectricShapes;
  readonly texts: string[];
} {
  const db = new Map<string, Map<string, Rec>>();
  const subs: Array<{ table: string; onChange: () => void }> = [];
  const texts: string[] = [];

  const poke = (table: string): void => {
    for (const sub of subs) {
      if (sub.table === table) sub.onChange();
    }
  };

  return {
    texts,
    shapes: {
      subscribe(table, _where, _params, onChange) {
        const sub = { table, onChange };
        subs.push(sub);
        return () => {
          const index = subs.indexOf(sub);
          if (index !== -1) subs.splice(index, 1);
        };
      },
    },
    async query(text, params) {
      texts.push(text);
      const table = tableOf(text);
      const rows = bag(db, table);
      if (text.startsWith("SELECT")) {
        const where = text.split(" WHERE ")[1] ?? "";
        return [...rows.values()].filter((record) => matches(record, where, params));
      }
      if (text.startsWith("INSERT") && text.includes("WHERE NOT EXISTS")) {
        const id = params[0];
        if (typeof id !== "string" || rows.has(id)) return [];
        const record: Rec = {};
        for (const [index, column] of columnsOf(text).entries()) {
          record[column] = params[index] ?? null;
        }
        rows.set(id, record);
        poke(table);
        return [{ [tableOf(`FROM ${table}`)]: id, id }];
      }
      if (text.startsWith("INSERT")) {
        const id = params[0];
        if (typeof id !== "string") return [];
        const record: Rec = {};
        for (const [index, column] of columnsOf(text).entries()) {
          record[column] = params[index] ?? null;
        }
        rows.set(id, record);
        poke(table);
        return [];
      }
      if (text.startsWith("UPDATE")) {
        const whereAt = text.indexOf(" WHERE ");
        if (whereAt === -1) return [];
        const setPart = text.slice(0, whereAt);
        const wherePart = text.slice(whereAt + " WHERE ".length);
        const id = params[0];
        if (typeof id !== "string") return [];
        const record = rows.get(id);
        if (record == null || !matches(record, wherePart, params)) return [];
        for (const predicate of predicates(setPart)) {
          record[predicate.column] = params[predicate.index] ?? null;
        }
        poke(table);
        return [record];
      }
      if (text.startsWith("DELETE")) {
        const wherePart = text.split(" WHERE ")[1] ?? "";
        const id = params[0];
        if (typeof id !== "string") return [];
        const record = rows.get(id);
        if (record == null || !matches(record, wherePart, params)) return [];
        rows.delete(id);
        poke(table);
        return [record];
      }
      throw new Error(`unhandled sql: ${text}`);
    },
  };
}
