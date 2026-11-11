import { SkillSpec } from "@inhuman.tools/harness-model";
import { HarnessDatabase } from "@inhuman.tools/scope-plane/sqlite";
import { SessionRuntime } from "@inhuman.tools/turn/session-runtime";
import { expect, it } from "vitest";

it("persists actual checkpoint deltas across delayed acknowledgements and detached-node reattachment", async () => {
  const db = new HarnessDatabase();
  db.insertSession({ sessionId: "sql-delta", createdAtMs: 1, lastActiveAtMs: 1 });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const runtime = SessionRuntime.create("sql-delta", {
    kind: "durable",
    async commit(checkpoint) {
      db.storeSessionDocument(checkpoint.sessionId, checkpoint.snapshot, checkpoint.dirtyNodes);
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return { sessionId: checkpoint.sessionId, incarnation: checkpoint.incarnation, revision: checkpoint.revision };
    },
  });
  runtime.recover();
  runtime.activate();
  try {
    const skill = new SkillSpec({ name: "remembered", description: "versioned definition" });
    runtime.root.skills.push(skill);
    runtime.root.kvs.before = "first";
    const pending = runtime.flush();
    await entered.promise;
    runtime.root.kvs.during = "second";
    release.resolve();
    await pending;
    const snapshot = db.loadSessionDocument("sql-delta");
    if (snapshot === undefined) throw new Error("missing checkpoint");
    const restored = SessionRuntime.restore("sql-delta", snapshot, { kind: "memory" });
    expect(restored.root.kvs.during).toBe("second");
    await restored[Symbol.asyncDispose]();
    restored.session.destroy();
    runtime.root.skills.splice(0);
    await runtime.flush();
    runtime.root.skills.push(skill);
    await runtime.flush();
    const reattached = db.loadSessionDocument("sql-delta");
    if (reattached === undefined || !("nodes" in reattached.root)) throw new Error("missing graph");
    expect(reattached.root.nodes[skill.uuid]?.state.name).toBe("remembered");
  } finally {
    release.resolve();
    await runtime[Symbol.asyncDispose]();
    runtime.session.destroy();
    db.close();
  }
});
