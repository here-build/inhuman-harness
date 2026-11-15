import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export type SqliteDriverKind = "better-sqlite3" | "node:sqlite";

export interface SqliteStatement {
  run(...params: unknown[]): { readonly changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteSyncDriver extends Disposable {
  readonly kind: SqliteDriverKind;
  exec(sql: string): void;
  pragma(statement: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export type SqliteDriverOptions = {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly preferNodeSqlite?: boolean;
};

type BetterSqliteInstance = {
  exec(sql: string): unknown;
  pragma(statement: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { readonly changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
  close(): void;
};

type NodeSqliteStatement = {
  run(...params: unknown[]): { readonly changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};

type NodeSqliteInstance = {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
};

const require = createRequire(import.meta.url);

function normalizeRowPrototype(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v;
  }
  return out;
}

function tryOpenBetterSqlite(path: string, options?: SqliteDriverOptions): SqliteSyncDriver | null {
  try {
    const BetterSqlite = require("better-sqlite3") as new (
      filename: string,
      opts?: { readonly?: boolean; fileMustExist?: boolean },
    ) => BetterSqliteInstance;
    const db = new BetterSqlite(path, {
      ...(options?.readonly !== undefined ? { readonly: options.readonly } : {}),
      ...(options?.fileMustExist !== undefined ? { fileMustExist: options.fileMustExist } : {}),
    });
    return {
      kind: "better-sqlite3",
      exec(sql) {
        db.exec(sql);
      },
      pragma(statement) {
        return db.pragma(statement);
      },
      prepare(sql) {
        const stmt = db.prepare(sql);
        return {
          run: (...params) => stmt.run(...params),
          get: (...params) => stmt.get(...params) as Record<string, unknown> | undefined,
          all: (...params) => stmt.all(...params) as Record<string, unknown>[],
        };
      },
      transaction(fn) {
        return db.transaction(fn);
      },
      close() {
        db.close();
      },
      [Symbol.dispose]() {
        db.close();
      },
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    if (
      code === "MODULE_NOT_FOUND" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      (error instanceof Error && error.message.includes("Could not locate the bindings file"))
    ) {
      return null;
    }
    throw error;
  }
}

function openNodeSqlite(path: string, options?: SqliteDriverOptions): SqliteSyncDriver {
  if (options?.fileMustExist === true && path !== ":memory:" && !path.startsWith("file:") && !existsSync(path)) {
    throw new Error(`SQLite database file does not exist: ${path}`);
  }
  const { DatabaseSync } = require("node:sqlite") as {
    readonly DatabaseSync: new (filename: string, opts?: { readOnly?: boolean }) => NodeSqliteInstance;
  };
  const db =
    options?.readonly !== undefined ? new DatabaseSync(path, { readOnly: options.readonly }) : new DatabaseSync(path);

  let txDepth = 0;
  let savepointSeq = 0;

  return {
    kind: "node:sqlite",
    exec(sql) {
      db.exec(sql);
    },
    pragma(statement) {
      const trimmed = statement.trim();
      if (trimmed.includes("=")) {
        db.exec(`PRAGMA ${trimmed};`);
        return undefined;
      }
      return db
        .prepare(`PRAGMA ${trimmed}`)
        .all()
        .map((row) => normalizeRowPrototype(row));
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => {
          const res = stmt.run(...params);
          return { changes: Number(res.changes) };
        },
        get: (...params) => {
          const row = stmt.get(...params);
          return row !== undefined ? normalizeRowPrototype(row) : undefined;
        },
        all: (...params) => stmt.all(...params).map((row) => normalizeRowPrototype(row)),
      };
    },
    transaction(fn) {
      return () => {
        const isOuter = txDepth === 0;
        const spName = isOuter ? "" : `sp_${++savepointSeq}`;
        db.exec(isOuter ? "BEGIN IMMEDIATE" : `SAVEPOINT ${spName}`);
        txDepth += 1;
        try {
          const result = fn();
          txDepth -= 1;
          db.exec(isOuter ? "COMMIT" : `RELEASE SAVEPOINT ${spName}`);
          return result;
        } catch (error) {
          txDepth -= 1;
          try {
            db.exec(isOuter ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${spName}`);
            if (!isOuter) {
              db.exec(`RELEASE SAVEPOINT ${spName}`);
            }
          } catch {
            // Ignore rollback failures when transaction already aborted.
          }
          throw error;
        }
      };
    },
    close() {
      db.close();
    },
    [Symbol.dispose]() {
      db.close();
    },
  };
}

export function openSqliteDriver(path = ":memory:", options?: SqliteDriverOptions): SqliteSyncDriver {
  if (options?.readonly !== true && path !== ":memory:" && !path.startsWith("file:")) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const driver =
    options?.preferNodeSqlite === true
      ? openNodeSqlite(path, options)
      : (tryOpenBetterSqlite(path, options) ?? openNodeSqlite(path, options));

  if (options?.readonly !== true) {
    driver.pragma("journal_mode = WAL");
    driver.pragma("synchronous = NORMAL");
  }
  driver.pragma("foreign_keys = ON");
  driver.pragma("busy_timeout = 5000");
  return driver;
}
