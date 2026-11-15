import { rowPairId } from "@inhuman.tools/harness-contract/schema";
import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";

import {
  commitScopeNodesInBatch,
  commitSessionNodesInBatch,
  loadScopeNodesFromKv,
  loadSessionDocumentFromKv,
  upsertSessionEffectInBatch,
} from "../document-kv.js";
import { MemoryKvStore } from "../kv-store.js";
import { applyNodeShapeDelta, createLocalShapeTransport, LiveShape } from "../live-shape.js";
import { CommitDiffShapeSource } from "../shape-source.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

@model("test:kv:normalized-node")
class Node extends Model {
  @state accessor text = "";
  @state.ref accessor tail: Node | null = null;
}

@model("test:kv:session")
class SessionModel extends Model {
  @state accessor sessionId = "";
  @state accessor kernelId = "local";
  @state accessor projectId = "";
  @state accessor title = "";
  @state accessor running = false;
  @state accessor lastActiveAtMs = 0;

  applyRow(row: Record<string, unknown>): void {
    this.sessionId = String(row["sessionId"] ?? "");
    this.kernelId = String(row["kernelId"] ?? "local");
    this.projectId = String(row["projectId"] ?? "");
    this.title = String(row["title"] ?? "");
    this.running = row["running"] === true;
    this.lastActiveAtMs = Number(row["lastActiveAtMs"] ?? 0);
  }
}

describe("normalized KV documents, Electric folding, and CommitDiffShapeSource", () => {
  it("stores self-contained session_nodes and restores graph + runtime meta", async () => {
    const store = new MemoryKvStore();
    const text = "self-contained body ".repeat(50);

    for (const sessionId of ["a", "b"]) {
      let tail: Node | null = null;
      let rootNode: Node | null = null;
      for (let n = 0; n < 10; n++) {
        rootNode = new Node({ text, tail });
        tail = rootNode;
      }
      const doc = new DocumentContainer(rootNode!);
      const delta = doc.takeNodeDelta();
      await store.batch((tx) => {
        tx.set("sessions", { sessionId, createdAtMs: 1, lastActiveAtMs: 1 });
        commitSessionNodesInBatch(tx, sessionId, { ...delta, replaceAll: true });
      });
      doc.destroy();
    }

    expect(await store.count("session_nodes")).toBe(20);
    await store.batch((tx) => {
      upsertSessionEffectInBatch(tx, {
        sessionId: "a",
        effectKey: "cmd-1",
        kind: "command",
        phase: "committed",
        inputHash: "sha256:abc",
        outcomeJson: JSON.stringify({ ok: true, action: "mint", turnId: "t-1" }),
        revision: 1,
        createdAtMs: 2,
      });
    });

    const snapshot = await loadSessionDocumentFromKv(store, "a");
    if (snapshot === undefined) throw new Error("missing document");
    const restored = DocumentContainer.fromSnapshot<Node>(snapshot);
    expect(restored.root.text).toBe(text);
    expect(restored.root.tail?.text).toBe(text);
    expect(restored.registry.size).toBe(10);
    expect(restored.getMetaMap("harness:session-commands").get("cmd-1")).toMatchObject({
      inputHash: "sha256:abc",
    });

    await store.delete("sessions", "a");
    expect(await store.count("session_nodes")).toBe(10);
    await store.delete("sessions", "b");
    expect(await store.count("session_nodes")).toBe(0);

    restored.destroy();
    await store.close();
  });

  it("prunes detached entities in O(delta) and isolates client subscriptionIds", async () => {
    const store = new MemoryKvStore();
    const hub = new CommitDiffShapeSource(store);

    const prior = new Node({ text: "old" });
    const current = new Node({ text: "new", tail: prior });
    const doc = new DocumentContainer(current);
    await store.batch((tx) => {
      tx.set("sessions", { sessionId: "s1", createdAtMs: 1, lastActiveAtMs: 1 });
      commitSessionNodesInBatch(tx, "s1", doc.takeNodeDelta());
    });
    expect(await store.count("session_nodes")).toBe(2);

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
    await shape.ready();

    expect(replica.root).toBe(replicaShell);
    expect(replica.root.text).toBe("new");
    expect(replica.root.tail?.text).toBe("old");

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
    await waitFor(() => clientAEvents.length === 1 && clientBEvents.length === 1);
    expect(hub.subscriptionCount).toBe(3);

    const kernelDoc = new DocumentContainer(new Node({ text: "kernel-root" }));
    await store.batch((tx) => commitScopeNodesInBatch(tx, "kernel", kernelDoc.takeNodeDelta()));
    await waitFor(() => clientAEvents.length === 2 && clientBEvents.length === 2);
    expect(await store.count("scope_nodes")).toBe(1);
    expect(clientAEvents).toEqual([0, 1]);
    expect(clientBEvents).toEqual([0, 1]);

    current.tail = null;
    await store.batch((tx) => commitSessionNodesInBatch(tx, "s1", doc.takeNodeDelta()));
    await waitFor(() => replica.root.tail === null);
    expect(await store.count("session_nodes")).toBe(1);
    expect(replica.registry.size).toBe(1);

    unsubA();
    unsubB();
    shape.dispose();
    replica.destroy();
    kernelDoc.destroy();
    doc.destroy();
    hub.dispose();
    await store.close();
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

    source.root.tail = null;
    source.root.text = "electric-v2";
    const updated = source.takeNodeDelta();

    shape.applyElectricMessages([{ headers: { control: "must-refetch" } }]);
    expect(shape.rows.size).toBe(2);

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

  it("isolates multi-tenant list and scope_nodes lanes via CommitDiffShapeSource + LiveShape", async () => {
    const store = new MemoryKvStore();
    const hub = new CommitDiffShapeSource(store);
    const transport = createLocalShapeTransport(hub);

    await store.batch((tx) => {
      tx.set("sessions", {
        sessionId: "ta-p1",
        kernelId: "tenant-a",
        projectId: "proj-1",
        running: true,
        createdAtMs: 1,
        lastActiveAtMs: 100,
      });
      tx.set("sessions", {
        sessionId: "tb-p1",
        kernelId: "tenant-b",
        projectId: "proj-1",
        running: true,
        createdAtMs: 1,
        lastActiveAtMs: 100,
      });
      commitScopeNodesInBatch(
        tx,
        "kernel",
        {
          rootId: "r-a",
          revision: 1,
          upserts: [
            {
              uuid: "r-a",
              tag: "KernelRoot",
              columns: {},
              state: { model: "alpha" },
              refs: {},
              refLists: {},
              children: {},
              childLists: {},
              childRecords: {},
            },
          ],
          replaceAll: true,
        },
        "tenant-a",
      );
    });

    const shape = new LiveShape(
      "active_sessions",
      { kernelId: "tenant-a", projectId: "proj-1" },
      "sessionId",
      SessionModel,
      transport,
    );
    const stop = autorun(() => {
      void shape.list;
    });
    await shape.ready();
    expect(shape.list.map((s) => s.sessionId)).toEqual(["ta-p1"]);

    await store.set("sessions", {
      sessionId: "ta-p1-ask",
      kernelId: "tenant-a",
      projectId: "proj-1",
      running: false,
      createdAtMs: 2,
      lastActiveAtMs: 200,
    });
    await store.set("pending_asks", {
      jobId: "ask-1",
      kernelId: "tenant-a",
      sessionId: "ta-p1-ask",
      turnId: "t1",
      kind: "ask",
      object: "tool",
      summary: "approve",
      createdAtMs: 201,
    });

    await waitFor(() => shape.rows.has("ta-p1-ask"));
    expect(shape.rows.has("tb-p1")).toBe(false);
    expect((await loadScopeNodesFromKv(store, "kernel", "tenant-a"))?.rootId).toBe("r-a");
    expect(await loadScopeNodesFromKv(store, "kernel", "tenant-b")).toBeUndefined();

    stop();
    shape.dispose();
    hub.dispose();
    await store.close();
  });
});
