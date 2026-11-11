import { rowPairId, scopeNodesTable, sessionNodesTable } from "@inhuman.tools/harness-contract/schema";
import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

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
});
