import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database, { type Database as BetterSqliteDatabase, type Statement } from "better-sqlite3";

import type { ConnectionSecrets, SecretsVaultPort } from "./secrets.js";

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;

export class SecretsAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretsAuthError";
  }
}

export type SecretsKeyRing = {
  readonly activeKid: string;
  readonly keys: Readonly<Record<string, Uint8Array>>;
};

export type EncryptedSecretRecord = {
  readonly tenantId: string;
  readonly kernelId: string;
  readonly connectionId: string;
  readonly kid: string;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly updatedAtMs: number;
};

export interface SecretsStoreBackend extends Disposable {
  getRecord(tenantId: string, kernelId: string, connectionId: string): EncryptedSecretRecord | undefined;
  putRecord(record: EncryptedSecretRecord): void;
  deleteRecord(tenantId: string, kernelId: string, connectionId: string): void;
  listConnectionIds(tenantId: string, kernelId: string): string[];
}

function copyRecord(record: EncryptedSecretRecord): EncryptedSecretRecord {
  return {
    tenantId: record.tenantId,
    kernelId: record.kernelId,
    connectionId: record.connectionId,
    kid: record.kid,
    iv: new Uint8Array(record.iv),
    authTag: new Uint8Array(record.authTag),
    ciphertext: new Uint8Array(record.ciphertext),
    updatedAtMs: record.updatedAtMs,
  };
}

function backendKey(tenantId: string, kernelId: string, connectionId: string): string {
  return `${tenantId.length}:${tenantId}${kernelId.length}:${kernelId}${connectionId}`;
}

/** Canonical length-prefixed AAD encoding so tuple boundaries between fields are unambiguous. */
export function encodeCanonicalAad(tenantId: string, kernelId: string, connectionId: string): Uint8Array {
  const parts = [Buffer.from(tenantId, "utf8"), Buffer.from(kernelId, "utf8"), Buffer.from(connectionId, "utf8")];
  const totalBytes = parts.reduce((sum, part) => sum + 4 + part.byteLength, 0);
  const out = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const part of parts) {
    out.writeUInt32BE(part.byteLength, offset);
    offset += 4;
    part.copy(out, offset);
    offset += part.byteLength;
  }
  return out;
}

function cleanSecrets(secrets: ConnectionSecrets): ConnectionSecrets {
  const cleaned: ConnectionSecrets = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === "string" && value.length > 0) cleaned[key] = value;
  }
  return cleaned;
}

function validateKeyRing(keyRing: SecretsKeyRing): void {
  if (keyRing.activeKid.trim() === "") {
    throw new SecretsAuthError("SecretsKeyRing activeKid must not be empty");
  }
  for (const [kid, key] of Object.entries(keyRing.keys)) {
    if (key.byteLength !== AES_256_KEY_BYTES) {
      throw new SecretsAuthError(`Key "${kid}" must be ${AES_256_KEY_BYTES} bytes, got ${key.byteLength}`);
    }
  }
  if (!Object.hasOwn(keyRing.keys, keyRing.activeKid)) {
    throw new SecretsAuthError(`SecretsKeyRing activeKid "${keyRing.activeKid}" is missing from keys`);
  }
}

export class MemorySecretsBackend implements SecretsStoreBackend {
  readonly #records = new Map<string, EncryptedSecretRecord>();
  #disposed = false;

  getRecord(tenantId: string, kernelId: string, connectionId: string): EncryptedSecretRecord | undefined {
    const found = this.#records.get(backendKey(tenantId, kernelId, connectionId));
    return found === undefined ? undefined : copyRecord(found);
  }

  putRecord(record: EncryptedSecretRecord): void {
    if (this.#disposed) throw new Error("MemorySecretsBackend: disposed");
    this.#records.set(backendKey(record.tenantId, record.kernelId, record.connectionId), copyRecord(record));
  }

  deleteRecord(tenantId: string, kernelId: string, connectionId: string): void {
    if (this.#disposed) return;
    this.#records.delete(backendKey(tenantId, kernelId, connectionId));
  }

  listConnectionIds(tenantId: string, kernelId: string): string[] {
    const out: string[] = [];
    for (const record of this.#records.values()) {
      if (record.tenantId === tenantId && record.kernelId === kernelId) {
        out.push(record.connectionId);
      }
    }
    return out;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#records.clear();
  }
}

type SqliteSecretRow = {
  readonly tenant_id: string;
  readonly kernel_id: string;
  readonly connection_id: string;
  readonly kid: string;
  readonly iv: Buffer;
  readonly auth_tag: Buffer;
  readonly ciphertext: Buffer;
  readonly updated_at_ms: number;
};

export class SqliteSecretsBackend implements SecretsStoreBackend {
  readonly #db: BetterSqliteDatabase;
  readonly #getStmt: Statement<[string, string, string], SqliteSecretRow>;
  readonly #putStmt: Statement<[string, string, string, string, Buffer, Buffer, Buffer, number]>;
  readonly #deleteStmt: Statement<[string, string, string]>;
  readonly #listStmt: Statement<[string, string], { readonly connection_id: string }>;
  #disposed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:" && !dbPath.startsWith("file:")) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.#db = new Database(dbPath);
    if (dbPath !== ":memory:") {
      this.#db.pragma("journal_mode = WAL");
    }
    this.#db.exec(`
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
    this.#getStmt = this.#db.prepare(
      `SELECT tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext, updated_at_ms
       FROM encrypted_connection_secrets
       WHERE tenant_id = ? AND kernel_id = ? AND connection_id = ?`,
    );
    this.#putStmt = this.#db.prepare(
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
    this.#deleteStmt = this.#db.prepare(
      `DELETE FROM encrypted_connection_secrets WHERE tenant_id = ? AND kernel_id = ? AND connection_id = ?`,
    );
    this.#listStmt = this.#db.prepare(
      `SELECT connection_id FROM encrypted_connection_secrets WHERE tenant_id = ? AND kernel_id = ?`,
    );
  }

  /** Read-only escape hatch for tests verifying DB state and key rotation. */
  get sqlite(): BetterSqliteDatabase {
    return this.#db;
  }

  getRecord(tenantId: string, kernelId: string, connectionId: string): EncryptedSecretRecord | undefined {
    if (this.#disposed) throw new Error("SqliteSecretsBackend: disposed");
    const row = this.#getStmt.get(tenantId, kernelId, connectionId);
    if (row === undefined) return undefined;
    return {
      tenantId: row.tenant_id,
      kernelId: row.kernel_id,
      connectionId: row.connection_id,
      kid: row.kid,
      iv: new Uint8Array(row.iv),
      authTag: new Uint8Array(row.auth_tag),
      ciphertext: new Uint8Array(row.ciphertext),
      updatedAtMs: row.updated_at_ms,
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
    if (this.#disposed) return;
    this.#deleteStmt.run(tenantId, kernelId, connectionId);
  }

  listConnectionIds(tenantId: string, kernelId: string): string[] {
    if (this.#disposed) throw new Error("SqliteSecretsBackend: disposed");
    return this.#listStmt.all(tenantId, kernelId).map((row) => row.connection_id);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#db.close();
  }
}

export type EncryptedSecretsVaultOptions = {
  readonly backend: SecretsStoreBackend;
  readonly keyRing: SecretsKeyRing;
  readonly tenantId: string;
  readonly kernelId: string;
  readonly ownsBackend?: boolean;
};

export class EncryptedSecretsVault implements SecretsVaultPort {
  readonly #backend: SecretsStoreBackend;
  readonly #keyRing: SecretsKeyRing;
  readonly #tenantId: string;
  readonly #kernelId: string;
  readonly #ownsBackend: boolean;
  #disposed = false;

  constructor(options: EncryptedSecretsVaultOptions) {
    if (options.tenantId.trim() === "") throw new SecretsAuthError("EncryptedSecretsVault requires tenantId");
    if (options.kernelId.trim() === "") throw new SecretsAuthError("EncryptedSecretsVault requires kernelId");
    validateKeyRing(options.keyRing);
    this.#backend = options.backend;
    this.#keyRing = options.keyRing;
    this.#tenantId = options.tenantId;
    this.#kernelId = options.kernelId;
    this.#ownsBackend = options.ownsBackend ?? false;
  }

  readConnectionSecrets(id: string): ConnectionSecrets {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    const record = this.#backend.getRecord(this.#tenantId, this.#kernelId, id);
    if (record === undefined) return {};
    if (record.tenantId !== this.#tenantId || record.kernelId !== this.#kernelId || record.connectionId !== id) {
      throw new SecretsAuthError(`Secret identity mismatch for connection "${id}"`);
    }
    if (record.iv.byteLength !== AES_GCM_IV_BYTES || record.authTag.byteLength !== AES_GCM_TAG_BYTES) {
      throw new SecretsAuthError(`Malformed encrypted secret envelope for connection "${id}"`);
    }
    const key = Object.hasOwn(this.#keyRing.keys, record.kid) ? this.#keyRing.keys[record.kid] : undefined;
    if (key === undefined) {
      throw new SecretsAuthError(`Unknown encryption key id "${record.kid}"`);
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", key, record.iv);
      decipher.setAAD(encodeCanonicalAad(this.#tenantId, this.#kernelId, id));
      decipher.setAuthTag(record.authTag);
      const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
      const parsed: unknown = JSON.parse(plaintext);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SecretsAuthError(`Decrypted payload for "${id}" is not an object`);
      }
      const result: ConnectionSecrets = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) result[k] = v;
      }
      return result;
    } catch (error) {
      if (error instanceof SecretsAuthError) throw error;
      throw new SecretsAuthError(`Failed to authenticate/decrypt secret for "${id}"`, { cause: error });
    }
  }

  writeConnectionSecrets(id: string, secrets: ConnectionSecrets): void {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    const cleaned = cleanSecrets(secrets);
    if (Object.keys(cleaned).length === 0) {
      this.#backend.deleteRecord(this.#tenantId, this.#kernelId, id);
      return;
    }
    validateKeyRing(this.#keyRing);
    const activeKid = this.#keyRing.activeKid;
    const key = this.#keyRing.keys[activeKid];
    if (key === undefined) {
      throw new SecretsAuthError(`Unknown active key id "${activeKid}"`);
    }
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(encodeCanonicalAad(this.#tenantId, this.#kernelId, id));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(cleaned), "utf8")), cipher.final()]);
    const authTag = cipher.getAuthTag();
    this.#backend.putRecord({
      tenantId: this.#tenantId,
      kernelId: this.#kernelId,
      connectionId: id,
      kid: activeKid,
      iv,
      authTag,
      ciphertext,
      updatedAtMs: Date.now(),
    });
  }

  deleteConnectionSecrets(id: string): void {
    if (this.#disposed) return;
    this.#backend.deleteRecord(this.#tenantId, this.#kernelId, id);
  }

  rewrapConnectionSecrets(id: string): boolean {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    const existing = this.#backend.getRecord(this.#tenantId, this.#kernelId, id);
    if (existing === undefined) return false;
    const secrets = this.readConnectionSecrets(id);
    this.writeConnectionSecrets(id, secrets);
    return true;
  }

  rewrapAll(): number {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    const ids = this.#backend.listConnectionIds(this.#tenantId, this.#kernelId);
    let count = 0;
    for (const id of ids) {
      if (this.rewrapConnectionSecrets(id)) count += 1;
    }
    return count;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ownsBackend) {
      this.#backend[Symbol.dispose]();
    }
  }
}
