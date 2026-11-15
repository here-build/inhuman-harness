import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHarnessKvComplianceSuite } from "@inhuman.tools/scope-plane/testing";
import { describe, expect, it } from "vitest";

import { SqliteKvStore } from "../sqlite-kv-store.js";
import { SqliteSecretsBackend } from "../sqlite-secrets-backend.js";

runHarnessKvComplianceSuite("SqliteKvStore (:memory:)", { describe, it }, async () => {
  const store = new SqliteKvStore(":memory:");
  return {
    store,
    cleanup: async () => {},
  };
});

runHarnessKvComplianceSuite("SqliteKvStore (file + reopen)", { describe, it }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-plane-sqlite-kv-"));
  const dbPath = join(dir, "harness.db");
  const store = new SqliteKvStore(dbPath);
  return {
    store,
    reopen: async () => new SqliteKvStore(dbPath),
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

runHarnessKvComplianceSuite("SqliteKvStore (node:sqlite fallback + reopen)", { describe, it }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-plane-node-sqlite-"));
  const dbPath = join(dir, "harness.db");
  const store = new SqliteKvStore(dbPath, { preferNodeSqlite: true });
  return {
    store,
    reopen: async () => new SqliteKvStore(dbPath, { preferNodeSqlite: true }),
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe("SqliteSecretsBackend driver selection and CRUD", () => {
  it("stores and retrieves encrypted secret envelopes across both better-sqlite3 and node:sqlite", () => {
    for (const preferNodeSqlite of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "scope-plane-sqlite-sec-"));
      try {
        const dbPath = join(dir, "secrets.db");
        const b1 = new SqliteSecretsBackend(dbPath, { preferNodeSqlite });
        expect(b1.sqlite.kind).toBe(preferNodeSqlite ? "node:sqlite" : "better-sqlite3");
        b1.putRecord({
          tenantId: "t1",
          kernelId: "k1",
          connectionId: "openai",
          kid: "kid-1",
          iv: new Uint8Array([1, 2, 3]),
          authTag: new Uint8Array([4, 5, 6]),
          ciphertext: new Uint8Array([7, 8, 9]),
          updatedAtMs: 1000,
        });
        b1.close();

        const b2 = new SqliteSecretsBackend(dbPath, { preferNodeSqlite });
        expect(b2.listConnectionIds("t1", "k1")).toEqual(["openai"]);
        const rec = b2.getRecord("t1", "k1", "openai");
        expect(rec).toEqual({
          tenantId: "t1",
          kernelId: "k1",
          connectionId: "openai",
          kid: "kid-1",
          iv: new Uint8Array([1, 2, 3]),
          authTag: new Uint8Array([4, 5, 6]),
          ciphertext: new Uint8Array([7, 8, 9]),
          updatedAtMs: 1000,
        });
        b2.deleteRecord("t1", "k1", "openai");
        expect(b2.getRecord("t1", "k1", "openai")).toBeUndefined();
        b2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
