import { randomUUID } from "node:crypto";

import { runHarnessKvComplianceSuite } from "@inhuman.tools/scope-plane/testing";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { pgPoolDriver } from "../driver.js";
import { PostgresKvStore } from "../postgres-kv-store.js";
import { PostgresSecretsBackend } from "../postgres-secrets-backend.js";

const POSTGRES_URL =
  process.env.INHUMAN_TEST_POSTGRES_URL ?? process.env.DATABASE_URL ?? "postgres://kley:kley@127.0.0.1:5432/postgres";

const sharedPool = new Pool({ connectionString: POSTGRES_URL, max: 6 });

afterAll(async () => {
  await sharedPool.end();
});

runHarnessKvComplianceSuite("PostgresKvStore (PostgreSQL 18)", { describe, it }, async () => {
  const schema = `harness_test_${randomUUID().replaceAll("-", "_")}`;
  const driver = pgPoolDriver(sharedPool);
  const store = new PostgresKvStore(driver, { schema });
  await store.bootstrap();

  return {
    store,
    reopen: async () => new PostgresKvStore(pgPoolDriver(sharedPool), { schema }),
    cleanup: async () => {
      await sharedPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    },
  };
});

describe("PostgresSecretsBackend", () => {
  it("stores, lists, updates, and deletes encrypted secret envelopes in an isolated schema", async () => {
    const schema = `vault_test_${randomUUID().replaceAll("-", "_")}`;
    const driver = pgPoolDriver(sharedPool);
    const backend = new PostgresSecretsBackend(driver, { schema });
    try {
      await backend.bootstrap();

      await backend.putRecord({
        tenantId: "t1",
        kernelId: "k1",
        connectionId: "openai",
        kid: "kid-1",
        iv: new Uint8Array([1, 2, 3, 4]),
        authTag: new Uint8Array([5, 6, 7, 8]),
        ciphertext: new Uint8Array([9, 10, 11, 12]),
        updatedAtMs: 1_700_000_000_001,
      });
      await backend.putRecord({
        tenantId: "t1",
        kernelId: "k1",
        connectionId: "anthropic",
        kid: "kid-1",
        iv: new Uint8Array([2, 3]),
        authTag: new Uint8Array([4, 5]),
        ciphertext: new Uint8Array([6, 7]),
        updatedAtMs: 1_700_000_000_002,
      });
      await backend.putRecord({
        tenantId: "t2",
        kernelId: "k1",
        connectionId: "openai",
        kid: "kid-2",
        iv: new Uint8Array([9]),
        authTag: new Uint8Array([8]),
        ciphertext: new Uint8Array([7]),
        updatedAtMs: 1_700_000_000_003,
      });

      const loaded = await backend.getRecord("t1", "k1", "openai");
      expect(loaded).toBeDefined();
      expect(loaded?.kid).toBe("kid-1");
      expect(Array.from(loaded?.iv ?? [])).toEqual([1, 2, 3, 4]);
      expect(Array.from(loaded?.authTag ?? [])).toEqual([5, 6, 7, 8]);
      expect(Array.from(loaded?.ciphertext ?? [])).toEqual([9, 10, 11, 12]);
      expect(loaded?.updatedAtMs).toBe(1_700_000_000_001);

      expect(await backend.listConnectionIds("t1", "k1")).toEqual(["anthropic", "openai"]);
      expect((await backend.listRecords("t1", "k1")).map((r) => r.connectionId)).toEqual(["anthropic", "openai"]);

      // Upsert preserves latest ciphertext and timestamp.
      await backend.putRecord({
        tenantId: "t1",
        kernelId: "k1",
        connectionId: "openai",
        kid: "kid-2",
        iv: new Uint8Array([10]),
        authTag: new Uint8Array([11]),
        ciphertext: new Uint8Array([12]),
        updatedAtMs: 1_700_000_000_999,
      });
      expect((await backend.getRecord("t1", "k1", "openai"))?.kid).toBe("kid-2");

      // Reopen against existing schema reads persisted ciphertext without data loss.
      const reopened = new PostgresSecretsBackend(pgPoolDriver(sharedPool), { schema });
      expect((await reopened.getRecord("t2", "k1", "openai"))?.kid).toBe("kid-2");
      await reopened.close();

      await backend.deleteRecord("t1", "k1", "openai");
      expect(await backend.getRecord("t1", "k1", "openai")).toBeUndefined();
      expect(await backend.listConnectionIds("t1", "k1")).toEqual(["anthropic"]);
    } finally {
      await backend.close();
      await sharedPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});
