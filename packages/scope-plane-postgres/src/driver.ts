const PG_IDENT_RE = /^[A-Z_]\w*$/i;

export function assertPgIdentifier(ident: string, label = "PostgreSQL identifier"): string {
  if (!PG_IDENT_RE.test(ident)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(ident)}`);
  }
  return ident;
}

export function quotePgIdent(ident: string): string {
  assertPgIdentifier(ident);
  return `"${ident}"`;
}

export type PgQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> = {
  readonly rows: readonly TRow[];
};

export interface PgExecutor {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>>;
}

export interface PgDriverPort extends PgExecutor {
  transaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(err?: Error | boolean): void;
}

export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

export function pgPoolDriver(pool: PgPoolLike): PgDriverPort {
  return {
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PgQueryResult<TRow>> {
      const result =
        values !== undefined && values.length > 0 ? await pool.query(text, [...values]) : await pool.query(text);
      return { rows: result.rows as readonly TRow[] };
    },

    async transaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let failed = false;
      try {
        await client.query("BEGIN");
        const tx: PgExecutor = {
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ): Promise<PgQueryResult<TRow>> {
            const result =
              values !== undefined && values.length > 0
                ? await client.query(text, [...values])
                : await client.query(text);
            return { rows: result.rows as readonly TRow[] };
          },
        };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (error) {
        failed = true;
        try {
          await client.query("ROLLBACK");
        } catch {
          // Ignore rollback failure so the original transaction error surfaces.
        }
        throw error;
      } finally {
        client.release(failed);
      }
    },

    async close(): Promise<void> {
      if (pool.end !== undefined) {
        await pool.end();
      }
    },
  };
}
