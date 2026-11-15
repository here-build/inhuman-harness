import type { AsyncSecretsStoreBackend, EncryptedSecretRecord } from "@inhuman.tools/scope-plane";

import { assertPgIdentifier, quotePgIdent, type PgDriverPort } from "./driver.js";

type PgSecretRow = {
  readonly tenant_id: string;
  readonly kernel_id: string;
  readonly connection_id: string;
  readonly kid: string;
  readonly iv: Uint8Array;
  readonly auth_tag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly updated_at_ms: string | number;
};

export type PostgresSecretsBackendOptions = {
  /** PostgreSQL schema containing the secrets table (default `"public"`). */
  readonly schema?: string;
  /** Secrets table name within the schema (default `"harness_connection_secrets"`). */
  readonly table?: string;
  /** Call `driver.close()` when `backend.close()` runs (default `false`). */
  readonly ownsDriver?: boolean;
};

function rowToRecord(row: PgSecretRow): EncryptedSecretRecord {
  return {
    tenantId: String(row.tenant_id),
    kernelId: String(row.kernel_id),
    connectionId: String(row.connection_id),
    kid: String(row.kid),
    iv: new Uint8Array(row.iv),
    authTag: new Uint8Array(row.auth_tag),
    ciphertext: new Uint8Array(row.ciphertext),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class PostgresSecretsBackend implements AsyncSecretsStoreBackend {
  readonly #driver: PgDriverPort;
  readonly #schema: string;
  readonly #table: string;
  readonly #schemaIdent: string;
  readonly #qualTable: string;
  readonly #ownsDriver: boolean;
  #disposed = false;

  constructor(driver: PgDriverPort, options?: PostgresSecretsBackendOptions) {
    this.#driver = driver;
    this.#schema = assertPgIdentifier(options?.schema ?? "public", "PostgreSQL schema");
    this.#table = assertPgIdentifier(options?.table ?? "harness_connection_secrets", "PostgreSQL secrets table");
    this.#schemaIdent = quotePgIdent(this.#schema);
    this.#qualTable = `${this.#schemaIdent}.${quotePgIdent(this.#table)}`;
    this.#ownsDriver = options?.ownsDriver === true;
  }

  get schema(): string {
    return this.#schema;
  }

  get table(): string {
    return this.#table;
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new Error("PostgresSecretsBackend: disposed");
    }
  }

  async bootstrap(): Promise<void> {
    this.#assertOpen();
    await this.#driver.transaction(async (tx) => {
      if (this.#schema !== "public") {
        await tx.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schemaIdent}`);
      }
      await tx.query(`
        CREATE TABLE IF NOT EXISTS ${this.#qualTable} (
          tenant_id TEXT NOT NULL,
          kernel_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          kid TEXT NOT NULL,
          iv BYTEA NOT NULL,
          auth_tag BYTEA NOT NULL,
          ciphertext BYTEA NOT NULL,
          updated_at_ms BIGINT NOT NULL,
          PRIMARY KEY (tenant_id, kernel_id, connection_id)
        );
      `);
    });
  }

  async getRecord(
    tenantId: string,
    kernelId: string,
    connectionId: string,
  ): Promise<EncryptedSecretRecord | undefined> {
    this.#assertOpen();
    const res = await this.#driver.query<PgSecretRow>(
      `SELECT tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext, updated_at_ms
       FROM ${this.#qualTable}
       WHERE tenant_id = $1 AND kernel_id = $2 AND connection_id = $3
       LIMIT 1`,
      [tenantId, kernelId, connectionId],
    );
    const row = res.rows[0];
    return row !== undefined ? rowToRecord(row) : undefined;
  }

  async listRecords(tenantId: string, kernelId: string): Promise<readonly EncryptedSecretRecord[]> {
    this.#assertOpen();
    const res = await this.#driver.query<PgSecretRow>(
      `SELECT tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext, updated_at_ms
       FROM ${this.#qualTable}
       WHERE tenant_id = $1 AND kernel_id = $2
       ORDER BY connection_id ASC`,
      [tenantId, kernelId],
    );
    return res.rows.map(rowToRecord);
  }

  async putRecord(record: EncryptedSecretRecord): Promise<void> {
    this.#assertOpen();
    await this.#driver.query(
      `INSERT INTO ${this.#qualTable}
         (tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, kernel_id, connection_id) DO UPDATE SET
         kid = EXCLUDED.kid,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext,
         updated_at_ms = EXCLUDED.updated_at_ms`,
      [
        record.tenantId,
        record.kernelId,
        record.connectionId,
        record.kid,
        Buffer.from(record.iv),
        Buffer.from(record.authTag),
        Buffer.from(record.ciphertext),
        Math.trunc(record.updatedAtMs),
      ],
    );
  }

  async deleteRecord(tenantId: string, kernelId: string, connectionId: string): Promise<void> {
    this.#assertOpen();
    await this.#driver.query(
      `DELETE FROM ${this.#qualTable} WHERE tenant_id = $1 AND kernel_id = $2 AND connection_id = $3`,
      [tenantId, kernelId, connectionId],
    );
  }

  async listConnectionIds(tenantId: string, kernelId: string): Promise<string[]> {
    this.#assertOpen();
    const res = await this.#driver.query<{ readonly connection_id: string }>(
      `SELECT connection_id FROM ${this.#qualTable}
       WHERE tenant_id = $1 AND kernel_id = $2
       ORDER BY connection_id ASC`,
      [tenantId, kernelId],
    );
    return res.rows.map((row) => String(row.connection_id));
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ownsDriver && this.#driver.close !== undefined) {
      await this.#driver.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
