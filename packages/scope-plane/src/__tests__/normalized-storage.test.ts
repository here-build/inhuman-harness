import { sharedPayloadsTable, sessionNodesTable } from "@inhuman.tools/harness-contract/schema";
import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import { HarnessDatabase } from "../sqlite-database.js";

@model("test:sql:normalized-node")
class Node extends Model {
  @state accessor text = "";
  @state.ref accessor tail: Node | null = null;
}

describe("normalized SQL documents", () => {
  it("shares nodes across checkpoints and payloads across sessions, then restores references", () => {
    const db = new HarnessDatabase();
    const text = "shared immutable body ".repeat(500);
    for (const sessionId of ["a", "b"]) {
      db.insertSession({ sessionId, createdAtMs: 1, lastActiveAtMs: 1 });
      let tail: Node | null = null;
      for (let n = 0; n < 10; n++) {
        const node: Node = new Node({ text, tail });
        const doc = new DocumentContainer(node);
        const snapshot = doc.toSnapshot();
        if (!("nodes" in snapshot.root)) throw new Error("missing graph");
        db.storeSessionDocument(sessionId, snapshot, Object.values(snapshot.root.nodes));
        tail = node;
        doc.destroy();
      }
    }
    expect(db.drizzle.select().from(sessionNodesTable).all()).toHaveLength(20);
    expect(db.drizzle.select().from(sharedPayloadsTable).all()).toHaveLength(1);
    const snapshot = db.loadSessionDocument("a");
    if (snapshot === undefined) throw new Error("missing document");
    const restored = DocumentContainer.fromSnapshot(snapshot);
    expect(restored.root.text).toBe(text);
    expect(restored.root.tail?.text).toBe(text);
    expect(restored.registry.size).toBe(10);
    db.deleteSession("a");
    expect(db.drizzle.select().from(sharedPayloadsTable).all()).toHaveLength(1);
    db.deleteSession("b");
    expect(db.drizzle.select().from(sharedPayloadsTable).all()).toHaveLength(0);
    restored.destroy();
    db.close();
  });

  it("prunes detached entities before collecting their bodies", () => {
    const db = new HarnessDatabase();
    db.insertSession({ sessionId: "a", createdAtMs: 1, lastActiveAtMs: 1 });
    const prior = new Node({ text: "old".repeat(1000) });
    const current = new Node({ text: "new".repeat(1000), tail: prior });
    const doc = new DocumentContainer(current);
    const first = doc.toSnapshot();
    if (!("nodes" in first.root)) throw new Error("missing graph");
    db.storeSessionDocument("a", first, Object.values(first.root.nodes));
    current.tail = null;
    const second = doc.toSnapshot();
    if (!("nodes" in second.root)) throw new Error("missing graph");
    db.storeSessionDocument("a", second, Object.values(second.root.nodes));
    expect(db.drizzle.select().from(sessionNodesTable).all()).toHaveLength(1);
    expect(db.collectUnusedContent()).toBe(1);
    expect(db.drizzle.select().from(sharedPayloadsTable).all()).toHaveLength(1);
    doc.destroy();
    db.close();
  });
});
