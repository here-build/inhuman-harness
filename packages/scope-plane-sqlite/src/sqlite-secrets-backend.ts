import type { EncryptedSecretRecord, SecretsStoreBackend } from "@inhuman.tools/scope-plane";

import { openSqliteDriver, type SqliteDriverOptions, type SqliteStatement, type SqliteSyncDriver } from "./driver.js";

type SqliteSecretRow = {
  readonly tenant_id: string;
  readonly kernel_id: string;
  readonly connection_id: string;
  readonly kid: string;
  readonly iv: Uint8Array;
  readonly auth_tag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly updated_at_ms: number;
};

export class SqliteSecretsBackend implements SecretsStoreBackend {
  readonly #driver: SqliteSyncDriver;
  readonly #getStmt: SqliteStatement;
  readonly #putStmt: SqliteStatement;
  readonly #deleteStmt: SqliteStatement;
  readonly #listStmt: SqliteStatement;
  #disposed = false;

  constructor(dbPath = ":memory:", options?: SqliteDriverOptions) {
    this.#driver = openSqliteDriver(dbPath, options);
    if (options?.readonly !== true) {
      this.#driver.exec(`
        CREATE TABLE IF NOT EXISTS encrypted_connection_secrets (
          tenant_id TEXT NOT NULL,
          kernel_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          kid TEXT NOT NULL,
          iv BLOB NOT NULL,
          auth_tag BLOB NOT NULL,
          ciphertext BLOB NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, kernel_id, connection_id)
        );
      `);
    }
    this.#getStmt = this.#driver.prepare(
      `SELECT tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext, updated_at_ms
       FROM encrypted_connection_secrets
       WHERE tenant_id = ? AND kernel_id = ? AND connection_id = ?`,
    );
    this.#putStmt = this.#driver.prepare(
      `INSERT INTO encrypted_connection_secrets
         (tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, kernel_id, connection_id) DO UPDATE SET
         kid = excluded.kid,
         iv = excluded.iv,
         auth_tag = excluded.auth_tag,
         ciphertext = excluded.ciphertext,
         updated_at_ms = excluded.updated_at_ms`,
    );
    this.#deleteStmt = this.#driver.prepare(
      `DELETE FROM encrypted_connection_secrets WHERE tenant_id = ? AND kernel_id = ? AND connection_id = ?`,
    );
    this.#listStmt = this.#driver.prepare(
      `SELECT connection_id FROM encrypted_connection_secrets WHERE tenant_id = ? AND kernel_id = ?`,
    );
  }

  /** Escape hatch for diagnostics and tests verifying ciphertext at rest and key rotation. */
  get sqlite(): SqliteSyncDriver {
    return this.#driver;
  }

  getRecord(tenantId: string, kernelId: string, connectionId: string): EncryptedSecretRecord | undefined {
    if (this.#disposed) throw new Error("SqliteSecretsBackend: disposed");
    const row = this.#getStmt.get(tenantId, kernelId, connectionId) as SqliteSecretRow | undefined;
    if (row === undefined) return undefined;
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

  putRecord(record: EncryptedSecretRecord): void {
    if (this.#disposed) throw new Error("SqliteSecretsBackend: disposed");
    this.#putStmt.run(
      record.tenantId,
      record.kernelId,
      record.connectionId,
      record.kid,
      Buffer.from(record.iv),
      Buffer.from(record.authTag),
      Buffer.from(record.ciphertext),
      record.updatedAtMs,
    );
  }

  deleteRecord(tenantId: string, kernelId: string, connectionId: string): void {
    if (this.#disposed) throw new Error("SqliteSecretsBackend: disposed");
    this.#deleteStmt.run(tenantId, kernelId, connectionId);
  }

  listConnectionIds(tenantId: string, kernelId: string): string[] {
    if (this.#disposed) throw new Error("SqliteSecretsBackend: disposed");
    return this.#listStmt
      .all(tenantId, kernelId)
      .map((row) => String((row as { readonly connection_id: unknown }).connection_id));
  }

  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#driver.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
