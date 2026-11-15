import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { AsyncSecretsStoreBackend, EncryptedSecretRecord, SecretsStoreBackend } from "@inhuman.tools/scope-plane";

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

export type EncryptedSecretsVaultOptions = {
  readonly backend: SecretsStoreBackend | AsyncSecretsStoreBackend;
  readonly keyRing: SecretsKeyRing;
  readonly tenantId: string;
  readonly kernelId: string;
  readonly ownsBackend?: boolean;
};

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAsyncBackend(backend: SecretsStoreBackend | AsyncSecretsStoreBackend): backend is AsyncSecretsStoreBackend {
  return Symbol.asyncDispose in backend && !(Symbol.dispose in backend);
}

export class EncryptedSecretsVault implements SecretsVaultPort {
  readonly #backend: SecretsStoreBackend | AsyncSecretsStoreBackend;
  readonly #isAsyncBackend: boolean;
  readonly #keyRing: SecretsKeyRing;
  readonly #tenantId: string;
  readonly #kernelId: string;
  readonly #ownsBackend: boolean;
  #warmedCache: Map<string, EncryptedSecretRecord> | null = null;
  #writeQueue: Promise<void> = Promise.resolve();
  #pendingWrites = 0;
  #disposed = false;

  constructor(options: EncryptedSecretsVaultOptions) {
    if (options.tenantId.trim() === "") throw new SecretsAuthError("EncryptedSecretsVault requires tenantId");
    if (options.kernelId.trim() === "") throw new SecretsAuthError("EncryptedSecretsVault requires kernelId");
    validateKeyRing(options.keyRing);
    this.#backend = options.backend;
    this.#isAsyncBackend = isAsyncBackend(options.backend);
    this.#keyRing = options.keyRing;
    this.#tenantId = options.tenantId;
    this.#kernelId = options.kernelId;
    this.#ownsBackend = options.ownsBackend ?? false;
  }

  async warm(): Promise<void> {
    if (this.#disposed) return;
    await this.flush();
    const cache = new Map<string, EncryptedSecretRecord>();
    const asyncBackend = this.#backend as AsyncSecretsStoreBackend;
    if (typeof asyncBackend.listRecords === "function") {
      const records = await asyncBackend.listRecords(this.#tenantId, this.#kernelId);
      for (const rec of records) {
        cache.set(rec.connectionId, copyRecord(rec));
      }
    } else {
      const ids = await this.#backend.listConnectionIds(this.#tenantId, this.#kernelId);
      for (const id of ids) {
        const rec = await this.#backend.getRecord(this.#tenantId, this.#kernelId, id);
        if (rec !== undefined) {
          cache.set(id, copyRecord(rec));
        }
      }
    }
    this.#warmedCache = cache;
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  #enqueueAsyncWrite(op: () => Promise<void> | void): void {
    const run = async (): Promise<void> => {
      await op();
    };
    const next = this.#pendingWrites === 0 ? run() : this.#writeQueue.then(run);
    this.#pendingWrites += 1;
    const tracked = next.finally(() => {
      this.#pendingWrites -= 1;
    });
    this.#writeQueue = tracked.catch(() => {});
  }

  #getRecordSync(id: string): EncryptedSecretRecord | undefined {
    if (this.#warmedCache !== null) {
      return this.#warmedCache.get(id);
    }
    if (this.#isAsyncBackend) {
      throw new SecretsAuthError(
        `EncryptedSecretsVault with async backend must be warmed via warm() before reading "${id}"`,
      );
    }
    const raw = (this.#backend as SecretsStoreBackend).getRecord(this.#tenantId, this.#kernelId, id);
    if (isPromiseLike(raw)) {
      throw new SecretsAuthError(
        `EncryptedSecretsVault with async backend must be warmed via warm() before reading "${id}"`,
      );
    }
    return raw;
  }

  #decryptRecord(id: string, record: EncryptedSecretRecord): ConnectionSecrets {
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

  readConnectionSecrets(id: string): ConnectionSecrets {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    const record = this.#getRecordSync(id);
    if (record === undefined) return {};
    return this.#decryptRecord(id, record);
  }

  writeConnectionSecrets(id: string, secrets: ConnectionSecrets): void {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    const cleaned = cleanSecrets(secrets);
    if (Object.keys(cleaned).length === 0) {
      this.deleteConnectionSecrets(id);
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
    const record: EncryptedSecretRecord = {
      tenantId: this.#tenantId,
      kernelId: this.#kernelId,
      connectionId: id,
      kid: activeKid,
      iv,
      authTag,
      ciphertext,
      updatedAtMs: Date.now(),
    };

    if (this.#warmedCache !== null) {
      this.#warmedCache.set(id, copyRecord(record));
    }

    if (this.#isAsyncBackend) {
      this.#enqueueAsyncWrite(() => (this.#backend as AsyncSecretsStoreBackend).putRecord(record));
      return;
    }

    const res = (this.#backend as SecretsStoreBackend).putRecord(record) as unknown;
    if (isPromiseLike(res)) {
      this.#enqueueAsyncWrite(() => res.then(() => undefined));
    }
  }

  deleteConnectionSecrets(id: string): void {
    if (this.#disposed) return;
    this.#warmedCache?.delete(id);
    if (this.#isAsyncBackend) {
      this.#enqueueAsyncWrite(() =>
        (this.#backend as AsyncSecretsStoreBackend).deleteRecord(this.#tenantId, this.#kernelId, id),
      );
      return;
    }
    const res = (this.#backend as SecretsStoreBackend).deleteRecord(this.#tenantId, this.#kernelId, id) as unknown;
    if (isPromiseLike(res)) {
      this.#enqueueAsyncWrite(() => res.then(() => undefined));
    }
  }

  rewrapConnectionSecrets(id: string): boolean {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    const existing = this.#getRecordSync(id);
    if (existing === undefined) return false;
    const secrets = this.#decryptRecord(id, existing);
    this.writeConnectionSecrets(id, secrets);
    return true;
  }

  rewrapAll(): number {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    let ids: string[];
    if (this.#warmedCache !== null) {
      ids = [...this.#warmedCache.keys()];
    } else if (this.#isAsyncBackend) {
      throw new SecretsAuthError("EncryptedSecretsVault: warm() must run before synchronous rewrapAll()");
    } else {
      const raw = (this.#backend as SecretsStoreBackend).listConnectionIds(this.#tenantId, this.#kernelId);
      if (isPromiseLike(raw)) {
        throw new SecretsAuthError("EncryptedSecretsVault: use rewrapAllAsync() or call warm() first");
      }
      ids = raw;
    }
    let count = 0;
    for (const id of ids) {
      if (this.rewrapConnectionSecrets(id)) count += 1;
    }
    return count;
  }

  async rewrapAllAsync(): Promise<number> {
    if (this.#disposed) throw new Error("EncryptedSecretsVault: disposed");
    if (this.#warmedCache === null) {
      await this.warm();
    }
    const count = this.rewrapAll();
    await this.flush();
    return count;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#warmedCache?.clear();
    this.#warmedCache = null;
    if (!this.#ownsBackend) return;
    if (Symbol.dispose in this.#backend) {
      (this.#backend as SecretsStoreBackend)[Symbol.dispose]();
    } else {
      const asyncBackend = this.#backend as AsyncSecretsStoreBackend;
      void Promise.resolve(asyncBackend.close?.() ?? asyncBackend[Symbol.asyncDispose]?.()).catch(() => undefined);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) {
      await this.#writeQueue.catch(() => {});
      return;
    }
    await this.#writeQueue.catch(() => {});
    this.#disposed = true;
    this.#warmedCache?.clear();
    this.#warmedCache = null;
    if (!this.#ownsBackend) return;
    if (Symbol.asyncDispose in this.#backend) {
      await (this.#backend as AsyncSecretsStoreBackend)[Symbol.asyncDispose]();
    } else if (Symbol.dispose in this.#backend) {
      (this.#backend as SecretsStoreBackend)[Symbol.dispose]();
    }
  }
}

export { SqliteSecretsBackend } from "@inhuman.tools/scope-plane-sqlite";

export {
  type AsyncSecretsStoreBackend,
  type SecretsStoreBackend,
  type EncryptedSecretRecord,
} from "@inhuman.tools/scope-plane";
