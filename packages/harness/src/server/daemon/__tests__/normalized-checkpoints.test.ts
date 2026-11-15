import { SkillSpec } from "@inhuman.tools/harness-model";
import {
  loadSessionNodesFromKv,
  loadSessionRuntimeMetaFromKv,
  commitSessionNodesInBatch,
} from "@inhuman.tools/scope-plane";
import { SqliteKvStore } from "@inhuman.tools/scope-plane-sqlite";
import { SessionRuntime } from "@inhuman.tools/turn/session-runtime";
import { expect, it } from "vitest";

it("persists actual checkpoint deltas across delayed acknowledgements and detached-node reattachment", async () => {
  const db = new SqliteKvStore();
  await db.set("sessions", {
    sessionId: "sql-delta",
    workspacePath: "",
    createdAtMs: 1,
    lastActiveAtMs: 1,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const runtime = SessionRuntime.create("sql-delta", {
    kind: "durable",
    async commit(checkpoint) {
      await db.batch((tx) => {
        commitSessionNodesInBatch(tx, checkpoint.sessionId, {
          rootId: checkpoint.rootNodeId,
          revision: checkpoint.revision,
          upserts: checkpoint.upsertedNodes,
          deletes: checkpoint.deletedNodeIds,
        });
      });
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
    const loaded = await loadSessionNodesFromKv(db, "sql-delta");
    if (loaded === undefined) throw new Error("missing checkpoint");
    const restored = SessionRuntime.restore(
      "sql-delta",
      {
        rootId: loaded.rootId,
        revision: loaded.revision,
        rows: loaded.rows,
        meta: await loadSessionRuntimeMetaFromKv(db, "sql-delta"),
      },
      { kind: "memory" },
    );
    expect(restored.root.kvs.during).toBe("second");
    await restored[Symbol.asyncDispose]();
    restored.session.destroy();
    runtime.root.skills.splice(0);
    await runtime.flush();
    runtime.root.skills.push(skill);
    await runtime.flush();
    const reattached = await loadSessionNodesFromKv(db, "sql-delta");
    const skillRow = reattached?.rows.find((row) => row.uuid === skill.uuid);
    expect(skillRow?.state.name).toBe("remembered");
  } finally {
    release.resolve();
    await runtime[Symbol.asyncDispose]();
    runtime.session.destroy();
    await db.close();
  }
});
