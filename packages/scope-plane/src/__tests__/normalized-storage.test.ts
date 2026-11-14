import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rowPairId, scopeNodesTable, sessionNodesTable } from "@inhuman.tools/harness-contract/schema";
import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";

import { UpdateLaneHub } from "../lane-server.js";
import { applyNodeShapeDelta, createLocalShapeTransport, LiveShape } from "../live-shape.js";
import { HarnessDatabase } from "../sqlite-database.js";

@model("test:sql:normalized-node")
class Node extends Model {
  @state accessor text = "";
  @state.ref accessor tail: Node | null = null;
}

describe("normalized SQL documents, Electric message folding, and O(delta) lanes", () => {
  it("stores self-contained session_nodes without shared_payloads and restores graph + runtime meta", () => {
    const db = new HarnessDatabase();
    const text = "self-contained body ".repeat(100);
    for (const sessionId of ["a", "b"]) {
      db.insertSession({ sessionId, createdAtMs: 1, lastActiveAtMs: 1 });
      let tail: Node | null = null;
      let rootNode: Node | null = null;
      for (let n = 0; n < 10; n++) {
        rootNode = new Node({ text, tail });
        tail = rootNode;
      }
      const doc = new DocumentContainer(rootNode!);
      const delta = doc.takeNodeDelta();
      db.commitSessionNodes(sessionId, { ...delta, replaceAll: true });
      doc.destroy();
    }

    expect(db.drizzle.select().from(sessionNodesTable).all()).toHaveLength(20);
    db.insertSessionEffect({
      sessionId: "a",
      effectKey: "cmd-1",
      kind: "command",
      phase: "committed",
      inputHash: "sha256:abc",
      outcomeJson: JSON.stringify({ ok: true, action: "mint", turnId: "t-1" }),
      revision: 1,
      createdAtMs: 2,
    });

    const snapshot = db.loadSessionDocument("a");
    if (snapshot === undefined) throw new Error("missing document");
    const restored = DocumentContainer.fromSnapshot<Node>(snapshot);
    expect(restored.root.text).toBe(text);
    expect(restored.root.tail?.text).toBe(text);
    expect(restored.registry.size).toBe(10);
    expect(restored.getMetaMap("harness:session-commands").get("cmd-1")).toMatchObject({
      inputHash: "sha256:abc",
    });

    db.deleteSession("a");
    expect(db.drizzle.select().from(sessionNodesTable).all()).toHaveLength(10);
    db.deleteSession("b");
    expect(db.drizzle.select().from(sessionNodesTable).all()).toHaveLength(0);
    restored.destroy();
    db.close();
  });

  it("prunes detached entities from session_nodes and scope_nodes in O(delta)", () => {
    const db = new HarnessDatabase();
    const hub = new UpdateLaneHub(db);
    db.insertSession({ sessionId: "s1", createdAtMs: 1, lastActiveAtMs: 1 });

    const prior = new Node({ text: "old" });
    const current = new Node({ text: "new", tail: prior });
    const doc = new DocumentContainer(current);
    db.commitSessionNodes("s1", doc.takeNodeDelta());
    expect(db.drizzle.select().from(sessionNodesTable).all()).toHaveLength(2);

    // Subscribe replica DocumentContainer via LiveShape + UpdateLaneHub
    const replica = new DocumentContainer(new Node());
    const replicaShell = replica.root;
    const shape = new LiveShape(
      "session_nodes",
      { sessionId: "s1" },
      "id",
      undefined,
      createLocalShapeTransport(hub, "client-1"),
      {
        onDelta: (delta) => applyNodeShapeDelta(replica, delta),
      },
    );
    void shape.rows; // observe to connect

    expect(replica.root).toBe(replicaShell);
    expect(replica.root.text).toBe("new");
    expect(replica.root.tail?.text).toBe("old");

    // Two clients using the exact same subscriptionId do not collide
    const clientAEvents: number[] = [];
    const clientBEvents: number[] = [];
    const unsubA = hub.subscribe(
      { kind: "shape/subscribe", subscriptionId: "shared-sub-id", lane: "scope_nodes", params: { scopeId: "kernel" } },
      (d) => clientAEvents.push(d.upserts.length),
      "client-a",
    );
    const unsubB = hub.subscribe(
      { kind: "shape/subscribe", subscriptionId: "shared-sub-id", lane: "scope_nodes", params: { scopeId: "kernel" } },
      (d) => clientBEvents.push(d.upserts.length),
      "client-b",
    );
    expect(hub.subscriptionCount).toBe(3);

    const kernelDoc = new DocumentContainer(new Node({ text: "kernel-root" }));
    db.commitScopeNodes("kernel", kernelDoc.takeNodeDelta());
    expect(db.drizzle.select().from(scopeNodesTable).all()).toHaveLength(1);
    expect(clientAEvents).toEqual([0, 1]);
    expect(clientBEvents).toEqual([0, 1]);

    // Detach `prior` on session doc -> deleted in SQLite & replica in O(delta)
    current.tail = null;
    db.commitSessionNodes("s1", doc.takeNodeDelta());
    expect(db.drizzle.select().from(sessionNodesTable).all()).toHaveLength(1);
    expect(replica.root.tail).toBeNull();
    expect(replica.registry.size).toBe(1);

    unsubA();
    unsubB();
    shape.dispose();
    replica.destroy();
    kernelDoc.destroy();
    doc.destroy();
    hub.dispose();
    db.close();
  });

  it("folds ElectricSQL /v1/shape snake_case messages with must-refetch double-buffering into LiveShape & DocumentContainer", async () => {
    const source = new DocumentContainer(new Node({ text: "electric-v1", tail: new Node({ text: "child-v1" }) }));
    const initial = source.takeNodeDelta();

    const replica = new DocumentContainer(new Node());
    const shape = new LiveShape<string, Record<string, unknown>>((row) => row.id, {
      onDelta: (delta) => applyNodeShapeDelta(replica, delta),
    });

    const readyPromise = shape.ready();
    expect(shape.upToDate).toBe(false);

    shape.applyElectricMessages([
      ...initial.upserts.map((row) => ({
        headers: { operation: "insert" as const },
        key: rowPairId("sess-e", row.uuid),
        value: {
          id: rowPairId("sess-e", row.uuid),
          session_id: "sess-e",
          node_id: row.uuid,
          tag: row.tag,
          is_root: row.uuid === initial.rootId,
          revision: initial.revision,
          row_json: JSON.stringify(row),
        },
      })),
      { headers: { control: "up-to-date" as const } },
    ]);

    await readyPromise;
    expect(shape.upToDate).toBe(true);
    expect(replica.root.text).toBe("electric-v1");
    expect(replica.root.tail?.text).toBe("child-v1");

    // Simulate Electric `must-refetch` followed by new snapshot (tail removed, text updated):
    // During refetch before `up-to-date`, existing rows stay visible (double-buffered).
    source.root.tail = null;
    source.root.text = "electric-v2";
    const updated = source.takeNodeDelta();

    shape.applyElectricMessages([{ headers: { control: "must-refetch" } }]);
    expect(shape.rows.size).toBe(2); // Not flashed empty!

    shape.applyElectricMessages([
      {
        headers: { operation: "insert" },
        key: rowPairId("sess-e", updated.upserts[0]!.uuid),
        value: {
          id: rowPairId("sess-e", updated.upserts[0]!.uuid),
          session_id: "sess-e",
          node_id: updated.upserts[0]!.uuid,
          tag: updated.upserts[0]!.tag,
          is_root: true,
          revision: updated.revision,
          row_json: JSON.stringify(updated.upserts[0]!),
        },
      },
      { headers: { control: "up-to-date" } },
    ]);

    expect(shape.rows.size).toBe(1);
    expect(replica.root.text).toBe("electric-v2");
    expect(replica.root.tail).toBeNull();
    expect(replica.registry.size).toBe(1);

    shape.dispose();
    replica.destroy();
    source.destroy();
  });

  it("migrates legacy pre-cutover harness.db schemas in-place while preserving scope_nodes and valid sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-legacy-sqlite-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "harness.db");

    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE kernel_state (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        default_model TEXT NOT NULL DEFAULT '',
        permission_mode TEXT NOT NULL DEFAULT 'ask',
        kvs_json TEXT NOT NULL DEFAULT '{}',
        updated_at_ms INTEGER NOT NULL
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
      CREATE TABLE session_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        reducer_exited INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER
      );
      CREATE TABLE session_updates (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        incarnation TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, revision)
      );
      CREATE TABLE session_effects (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        effect_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        outcome_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, effect_key)
      );
      CREATE TABLE session_blobs (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        blob_id TEXT NOT NULL,
        turn_id TEXT,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, blob_id)
      );
      CREATE TABLE shared_payloads (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE session_nodes (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        row_json TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id)
      );
      CREATE TABLE session_documents (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        header_json TEXT NOT NULL
      );
    `);

    const kernelNode = new Node({ text: "preserved-kernel-setting" });
    const kernelDoc = new DocumentContainer(kernelNode);
    const kernelRow = kernelDoc.takeNodeDelta().upserts[0]!;
    raw
      .prepare(
        "INSERT INTO scope_nodes (id, scope_id, node_id, tag, is_root, revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        rowPairId("kernel", kernelRow.uuid),
        "kernel",
        kernelRow.uuid,
        kernelRow.tag,
        1,
        3,
        JSON.stringify(kernelRow),
      );
    kernelDoc.destroy();

    raw
      .prepare("INSERT INTO sessions (session_id, title, created_at_ms, last_active_at_ms) VALUES (?, ?, ?, ?)")
      .run("s-orphan", "Retired Yjs Session", 10, 20);
    raw
      .prepare(
        "INSERT INTO pending_asks (job_id, session_id, turn_id, kind, object, summary, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("ask-orphan", "s-orphan", "t-orphan", "ask", "shell", "rm", 21);

    raw
      .prepare("INSERT INTO sessions (session_id, title, created_at_ms, last_active_at_ms) VALUES (?, ?, ?, ?)")
      .run("s-valid", "Valid Stored Session", 30, 40);

    const longBody = "migrated-packed-body-".repeat(10);
    const bodyJson = JSON.stringify(longBody);
    const bodyHash = createHash("sha256").update(bodyJson).digest("hex");
    raw.prepare("INSERT INTO shared_payloads (hash, body) VALUES (?, ?)").run(bodyHash, bodyJson);

    const validNode = new Node({ text: "" });
    const validDoc = new DocumentContainer(validNode);
    const validRow = validDoc.takeNodeDelta().upserts[0]!;
    validDoc.destroy();

    raw
      .prepare(
        "INSERT INTO kernel_state (id, default_model, permission_mode, kvs_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run("singleton", "gpt-4o", "auto", '{"theme":"dark"}', 99);

    const packedRow = {
      format: "content-v1",
      value: { ...validRow, state: { ...validRow.state, text: null } },
      texts: [{ path: ["state", "text"], hash: bodyHash }],
    };
    raw.prepare("INSERT INTO session_documents (session_id, revision, header_json) VALUES (?, ?, ?)").run(
      "s-valid",
      5,
      JSON.stringify({
        guid: "harness:session:s-valid",
        revision: 5,
        root: { format: "rows-v1", uuid: validRow.uuid, tag: validRow.tag, nodes: {} },
      }),
    );
    raw
      .prepare("INSERT INTO session_nodes (session_id, node_id, revision, row_json) VALUES (?, ?, ?, ?)")
      .run("s-valid", validRow.uuid, 5, JSON.stringify(packedRow));
    raw
      .prepare(
        "INSERT INTO session_turns (turn_id, session_id, ordinal, prompt, status, cancel_requested, reducer_exited, snapshot_json, started_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("turn-1", "s-valid", 0, "hello", "completed", 0, 1, "{}", 31, 39);
    raw
      .prepare(
        "INSERT INTO session_effects (session_id, effect_key, kind, input_hash, outcome_json, revision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("s-valid", "cmd-legacy", "command", "sha256:legacy", JSON.stringify({ ok: true }), 5, 35);
    raw
      .prepare("INSERT INTO session_blobs (session_id, blob_id, turn_id, created_at_ms) VALUES (?, ?, ?, ?)")
      .run("s-valid", "blob-1", "turn-1", 36);
    raw.close();

    const db = new HarnessDatabase(dbPath);
    const loadedKernel = db.loadScopeNodes("kernel");
    expect(loadedKernel?.rows).toHaveLength(1);
    expect(loadedKernel?.rows[0]?.state["text"]).toBe("preserved-kernel-setting");

    expect(db.getSession("s-orphan")).toBeUndefined();
    expect(db.getPendingAsk("ask-orphan")).toBeUndefined();
    expect(db.getSession("s-valid")?.title).toBe("Valid Stored Session");

    const snapshot = db.loadSessionDocument("s-valid");
    if (snapshot === undefined) throw new Error("expected migrated session document");
    const hydrated = DocumentContainer.fromSnapshot<Node>(snapshot);
    expect(hydrated.root.text).toBe(longBody);
    expect(hydrated.getMetaMap("harness:session-commands").get("cmd-legacy")).toMatchObject({
      inputHash: "sha256:legacy",
    });
    hydrated.destroy();

    expect(db.listSessionTurns("s-valid")).toHaveLength(1);
    expect(db.listSessionBlobs("s-valid")).toHaveLength(1);

    // Verify new writes against migrated tables succeed without snapshot_json or missing id columns.
    db.insertSessionTurn({
      turnId: "turn-2",
      sessionId: "s-valid",
      ordinal: 1,
      prompt: "next",
      status: "running",
      startedAtMs: 50,
    });
    db.insertSessionEffect({
      sessionId: "s-valid",
      effectKey: "cmd-new",
      kind: "command",
      inputHash: "sha256:new",
      outcomeJson: JSON.stringify({ ok: true }),
      revision: 6,
      createdAtMs: 51,
    });
    db.insertSessionBlob({
      sessionId: "s-valid",
      blobId: "blob-2",
      turnId: "turn-2",
      createdAtMs: 52,
    });

    const tableNames = new Set(
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { readonly name: string }).name),
    );
    expect(tableNames.has("session_updates")).toBe(false);
    expect(tableNames.has("session_documents")).toBe(false);
    expect(tableNames.has("shared_payloads")).toBe(false);
    expect(tableNames.has("projects")).toBe(true);
    expect(tableNames.has("scm_resources")).toBe(true);
    expect(tableNames.has("plugin_state_logs")).toBe(true);

    const migratedKernel = db.getKernelState();
    expect(migratedKernel).toEqual({
      id: "local",
      kernelId: "local",
      defaultModel: "gpt-4o",
      permissionMode: "auto",
      enabledPluginsJson: "[]",
      kvsJson: '{"theme":"dark"}',
      updatedAtMs: 99,
    });
    db.close();

    // Reopening an already-migrated DB is idempotent.
    const reopened = new HarnessDatabase(dbPath);
    expect(reopened.listSessionTurns("s-valid")).toHaveLength(2);
    expect(reopened.loadScopeNodes("kernel")?.rows[0]?.state["text"]).toBe("preserved-kernel-setting");
    reopened.close();
  });
});
