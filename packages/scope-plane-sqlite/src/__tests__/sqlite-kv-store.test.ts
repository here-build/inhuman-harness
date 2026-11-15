import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHarnessKvComplianceSuite } from "@inhuman.tools/scope-plane/testing";
import { describe, expect, it } from "vitest";

import { openSqliteDriver } from "../driver.js";
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

describe("SqliteKvStore legacy SQLite migration", () => {
  it("upgrades 0.3.0 single-kernel tables, migrates retired expectations tags only on node tags, and is idempotent", async () => {
    for (const preferNodeSqlite of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "scope-plane-sqlite-mig-v03-"));
      try {
        const dbPath = join(dir, "harness.db");
        const seed = openSqliteDriver(dbPath, { preferNodeSqlite });
        seed.exec(`
          CREATE TABLE kernel_state (
            id TEXT PRIMARY KEY DEFAULT 'singleton',
            default_model TEXT NOT NULL DEFAULT '',
            permission_mode TEXT NOT NULL DEFAULT 'ask',
            kvs_json TEXT NOT NULL DEFAULT '{}',
            updated_at_ms INTEGER NOT NULL
          );
          CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            workspace_path TEXT NOT NULL DEFAULT '',
            mode TEXT NOT NULL DEFAULT 'assistant',
            permission_mode TEXT NOT NULL DEFAULT 'ask',
            running INTEGER NOT NULL DEFAULT 0,
            head_turn_id TEXT,
            parent_session_id TEXT,
            parent_call_id TEXT,
            depth INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            last_active_at_ms INTEGER NOT NULL,
            archived_at_ms INTEGER
          );
          CREATE TABLE pending_asks (
            job_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            object TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
          );
          CREATE TABLE scope_nodes (
            id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            is_root INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL,
            row_json TEXT NOT NULL
          );
          CREATE TABLE session_nodes (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            is_root INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL,
            row_json TEXT NOT NULL
          );
          CREATE TABLE session_turns (
            turn_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            status TEXT NOT NULL,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            reducer_exited INTEGER NOT NULL DEFAULT 0,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER
          );
          CREATE TABLE session_effects (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            effect_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            phase TEXT NOT NULL DEFAULT 'committed',
            input_hash TEXT NOT NULL,
            outcome_json TEXT NOT NULL,
            revision INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL
          );
          CREATE TABLE session_blobs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            blob_id TEXT NOT NULL,
            turn_id TEXT,
            created_at_ms INTEGER NOT NULL
          );
        `);
        seed
          .prepare(
            "INSERT INTO kernel_state (id, default_model, permission_mode, kvs_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
          )
          .run("singleton", "anthropic:claude", "ask", '{"theme":"dark"}', 1234);
        seed
          .prepare(
            "INSERT INTO sessions (session_id, title, workspace_path, created_at_ms, last_active_at_ms) VALUES (?, ?, ?, ?, ?)",
          )
          .run("s1", "First session", "/tmp/ws", 1000, 2000);
        seed
          .prepare(
            "INSERT INTO scope_nodes (id, scope_id, node_id, tag, is_root, revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "kernel:drv-1",
            "kernel",
            "drv-1",
            "@inhuman.tools/plexus-expectations:DriverSpec",
            0,
            3,
            JSON.stringify({
              id: "drv-1",
              tag: "@inhuman.tools/plexus-expectations:DriverSpec",
              state: { name: "legacy-driver" },
            }),
          );
        seed
          .prepare(
            "INSERT INTO session_nodes (id, session_id, node_id, tag, is_root, revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "s1:msg-1",
            "s1",
            "msg-1",
            "harness:message",
            0,
            1,
            JSON.stringify({
              id: "msg-1",
              tag: "harness:message",
              state: { text: "Please keep @inhuman.tools/plexus-expectations:DriverSpec intact in user prose." },
            }),
          );
        seed
          .prepare(
            "INSERT INTO session_turns (turn_id, session_id, ordinal, prompt, status, started_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("t1", "s1", 1, "hello", "completed", 1500);
        seed.close();

        const store = new SqliteKvStore(dbPath, { preferNodeSqlite });
        const kernelState = await store.get("kernel_state", "local");
        expect(kernelState).toMatchObject({
          id: "local",
          kernelId: "local",
          defaultModel: "anthropic:claude",
          enabledPluginsJson: "[]",
          kvsJson: '{"theme":"dark"}',
        });
        expect(await store.get("kernel_state", "singleton")).toBeUndefined();

        const session = await store.get("sessions", "s1");
        expect(session).toMatchObject({ sessionId: "s1", kernelId: "local", projectId: "" });

        const scopeNode = await store.get("scope_nodes", "kernel:drv-1");
        expect(scopeNode?.kernelId).toBe("local");
        expect(scopeNode?.tag).toBe("@inhuman.tools/expectations:DriverSpec");
        expect(JSON.parse(scopeNode?.rowJson ?? "{}")).toMatchObject({
          id: "drv-1",
          tag: "@inhuman.tools/expectations:DriverSpec",
          state: { name: "legacy-driver" },
        });

        const msgNode = await store.get("session_nodes", "s1:msg-1");
        expect(msgNode?.kernelId).toBe("local");
        expect(msgNode?.tag).toBe("harness:message");
        expect(JSON.parse(msgNode?.rowJson ?? "{}")).toMatchObject({
          tag: "harness:message",
          state: { text: "Please keep @inhuman.tools/plexus-expectations:DriverSpec intact in user prose." },
        });

        const turn = await store.get("session_turns", "t1");
        expect(turn?.kernelId).toBe("local");
        await store.close();

        const reopened = new SqliteKvStore(dbPath, { preferNodeSqlite });
        expect((await reopened.get("scope_nodes", "kernel:drv-1"))?.tag).toBe(
          "@inhuman.tools/expectations:DriverSpec",
        );
        expect(await reopened.get("sessions", "s1")).toMatchObject({ kernelId: "local", projectId: "" });
        await reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rebuilds pre-normalized shared_payloads/snapshot_json schemas and prunes orphan sessions", async () => {
    for (const preferNodeSqlite of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "scope-plane-sqlite-mig-legacy-"));
      try {
        const dbPath = join(dir, "harness.db");
        const seed = openSqliteDriver(dbPath, { preferNodeSqlite });
        seed.exec(`
          CREATE TABLE kernel_state (
            id TEXT PRIMARY KEY DEFAULT 'singleton',
            default_model TEXT NOT NULL DEFAULT '',
            permission_mode TEXT NOT NULL DEFAULT 'ask',
            kvs_json TEXT NOT NULL DEFAULT '{}',
            updated_at_ms INTEGER NOT NULL
          );
          CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            workspace_path TEXT NOT NULL DEFAULT '',
            mode TEXT NOT NULL DEFAULT 'assistant',
            permission_mode TEXT NOT NULL DEFAULT 'ask',
            running INTEGER NOT NULL DEFAULT 0,
            head_turn_id TEXT,
            parent_session_id TEXT,
            parent_call_id TEXT,
            depth INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            last_active_at_ms INTEGER NOT NULL,
            archived_at_ms INTEGER
          );
          CREATE TABLE shared_payloads (
            hash TEXT PRIMARY KEY,
            body TEXT NOT NULL
          );
          CREATE TABLE session_documents (
            session_id TEXT PRIMARY KEY,
            header_json TEXT NOT NULL
          );
          CREATE TABLE session_updates (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL
          );
          CREATE TABLE scope_nodes (
            scope_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            row_json TEXT NOT NULL,
            PRIMARY KEY (scope_id, node_id)
          );
          CREATE TABLE session_nodes (
            session_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            row_json TEXT NOT NULL,
            PRIMARY KEY (session_id, node_id)
          );
          CREATE TABLE session_turns (
            turn_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            status TEXT NOT NULL,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            reducer_exited INTEGER NOT NULL DEFAULT 0,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            snapshot_json TEXT
          );
          CREATE TABLE session_effects (
            session_id TEXT NOT NULL,
            effect_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            outcome_json TEXT NOT NULL,
            revision INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL
          );
          CREATE TABLE session_blobs (
            session_id TEXT NOT NULL,
            blob_id TEXT NOT NULL,
            turn_id TEXT,
            created_at_ms INTEGER NOT NULL
          );
        `);
        seed
          .prepare("INSERT INTO kernel_state (id, updated_at_ms) VALUES (?, ?)")
          .run("singleton", 500);
        seed
          .prepare(
            "INSERT INTO sessions (session_id, title, created_at_ms, last_active_at_ms) VALUES (?, ?, ?, ?)",
          )
          .run("s-keep", "Kept session", 100, 200);
        seed
          .prepare(
            "INSERT INTO sessions (session_id, title, created_at_ms, last_active_at_ms) VALUES (?, ?, ?, ?)",
          )
          .run("s-orphan", "Orphan session", 100, 200);
        seed
          .prepare("INSERT INTO shared_payloads (hash, body) VALUES (?, ?)")
          .run("h1", JSON.stringify("unpacked content body"));
        seed
          .prepare("INSERT INTO session_documents (session_id, header_json) VALUES (?, ?)")
          .run("s-keep", JSON.stringify({ rootId: "root-node" }));
        seed
          .prepare("INSERT INTO scope_nodes (scope_id, node_id, revision, row_json) VALUES (?, ?, ?, ?)")
          .run("kernel", "k-root", 1, JSON.stringify({ tag: "harness:kernel:root", state: {} }));
        seed
          .prepare("INSERT INTO scope_nodes (scope_id, node_id, revision, row_json) VALUES (?, ?, ?, ?)")
          .run(
            "kernel",
            "conn-1",
            2,
            JSON.stringify({ tag: "@inhuman.tools/plexus-expectations:ConnectionSpec", state: { label: "c1" } }),
          );
        seed
          .prepare("INSERT INTO session_nodes (session_id, node_id, revision, row_json) VALUES (?, ?, ?, ?)")
          .run("s-keep", "root-node", 1, JSON.stringify({ tag: "custom:root", state: {} }));
        seed
          .prepare("INSERT INTO session_nodes (session_id, node_id, revision, row_json) VALUES (?, ?, ?, ?)")
          .run(
            "s-keep",
            "m1",
            2,
            JSON.stringify({
              format: "content-v1",
              value: { tag: "harness:message", state: { text: "" } },
              texts: [{ path: ["state", "text"], hash: "h1" }],
            }),
          );
        seed
          .prepare(
            "INSERT INTO session_turns (turn_id, session_id, ordinal, prompt, status, started_at_ms, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("t1", "s-keep", 1, "hi", "completed", 110, "{}");
        seed
          .prepare(
            "INSERT INTO session_effects (session_id, effect_key, kind, input_hash, outcome_json, revision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "s-keep",
            "eff-1",
            "effect",
            "ih1",
            JSON.stringify({
              format: "content-v1",
              value: { text: "" },
              texts: [{ path: ["text"], hash: "h1" }],
            }),
            1,
            120,
          );
        seed
          .prepare("INSERT INTO session_blobs (session_id, blob_id, turn_id, created_at_ms) VALUES (?, ?, ?, ?)")
          .run("s-keep", "blob-1", "t1", 130);
        seed.close();

        const store = new SqliteKvStore(dbPath, { preferNodeSqlite });
        expect(await store.get("sessions", "s-keep")).toMatchObject({ sessionId: "s-keep", kernelId: "local" });
        expect(await store.get("sessions", "s-orphan")).toBeUndefined();

        const scopeRows = await store.scan("scope_nodes");
        const kRoot = scopeRows.find((r) => r.nodeId === "k-root");
        const conn1 = scopeRows.find((r) => r.nodeId === "conn-1");
        expect(kRoot?.isRoot).toBe(true);
        expect(conn1?.tag).toBe("@inhuman.tools/expectations:ConnectionSpec");

        const sessionRows = await store.scan("session_nodes");
        const sRoot = sessionRows.find((r) => r.nodeId === "root-node");
        const m1 = sessionRows.find((r) => r.nodeId === "m1");
        expect(sRoot?.isRoot).toBe(true);
        expect(JSON.parse(m1?.rowJson ?? "{}")).toMatchObject({
          tag: "harness:message",
          state: { text: "unpacked content body" },
        });

        const effects = await store.scan("session_effects");
        expect(effects).toHaveLength(1);
        expect(effects[0]?.phase).toBe("committed");
        expect(JSON.parse(effects[0]?.outcomeJson ?? "{}")).toEqual({ text: "unpacked content body" });

        expect(await store.scan("session_blobs")).toHaveLength(1);
        expect(await store.scan("session_turns")).toHaveLength(1);
        await store.close();

        const inspect = openSqliteDriver(dbPath, { preferNodeSqlite });
        const tablesAfter = inspect
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((r) => String(r["name"]));
        inspect.close();
        expect(tablesAfter).not.toContain("session_updates");
        expect(tablesAfter).not.toContain("session_documents");
        expect(tablesAfter).not.toContain("shared_payloads");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
