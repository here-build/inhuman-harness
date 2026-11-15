/**
 * ProductionRuntime + HarnessDatabase SQLite storage: node rows round-trip
 * through flushSession, and sessionDoc stays memory-only.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  SessionDocument,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { loadSessionNodesFromKv } from "@inhuman.tools/scope-plane";
import { SqliteKvStore } from "@inhuman.tools/scope-plane-sqlite";
import { runInAction } from "mobx";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { KernelDaemon } from "../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";

async function openKernel(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `harness-i1-${label}-`)));
}

describe("local SQLite/runtime integration", () => {
  it("bind/activate still has no catalog observers until activate()", async () => {
    const kernel = new KernelDaemon(await openKernel("bind"));
    onTestFinished(() => kernel[Symbol.dispose]());
    expect({
      activated: kernel.runtime.activated,
      host: kernel.catalog.connectionHost,
    }).toEqual({ activated: false, host: undefined });
    await kernel.ready;
    expect({
      activated: kernel.runtime.activated,
      host: kernel.catalog.connectionHost === undefined ? "missing" : "bound",
    }).toEqual({ activated: true, host: "bound" });
  });

  it("kernel and session documents round-trip through SQLite flush", async () => {
    const system = await openKernel("flush-k");
    const workspace = await openKernel("flush-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("s1");
    await session.park();
    session.root.applyKvs([{ form: "kv-set", key: "mark", value: "hello" }]);
    await kernel.flushSession(session.doc);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect(restored.sessionDoc("s1")).toBeUndefined();
    const acquired = await restored.acquireSession("s1");
    expect({
      mark: acquired?.root.kvs.mark,
      live: restored.liveSession("s1"),
      loaded: restored.sessionDoc("s1") === acquired,
    }).toEqual({ mark: "hello", live: undefined, loaded: true });
  });

  it("failed flush is not success and keeps the dirty nodes uncommitted", async () => {
    const system = await openKernel("fail-k");
    const workspace = await openKernel("fail-p");
    const kernel = new KernelDaemon(system);
    onTestFinished(() => kernel[Symbol.dispose]());
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("s1");
    await kernel.flushSession(session.doc);
    (kernel.db as SqliteKvStore).setReadOnly(true);
    onTestFinished(() => {
      try {
        (kernel.db as SqliteKvStore).setReadOnly(false);
      } catch {}
    });
    session.root.applyKvs([{ form: "kv-set", key: "mark", value: "dirty" }]);
    await expect(kernel.flushSession(session.doc)).rejects.toThrow();
    (kernel.db as SqliteKvStore).setReadOnly(false);
    expect({
      mark: session.root.kvs.mark,
      loaded: kernel.sessionDoc("s1") === session.doc,
      dirty: session.doc.peekNodeDelta().upserts.length > 0,
    }).toEqual({ mark: "dirty", loaded: true, dirty: true });
  });

  it("sessionDoc does not intern a cold session; acquireSession hydrates without SessionDaemon", async () => {
    const system = await openKernel("cold-k");
    const workspace = await openKernel("cold-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("idle");
    await kernel.flushSession(session.doc);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect({
      doc: restored.sessionDoc("idle"),
      live: restored.liveSession("idle"),
    }).toEqual({ doc: undefined, live: undefined });
    const acquired = await restored.acquireSession("idle");
    expect({
      id: acquired?.root.sessionId,
      live: restored.liveSession("idle"),
      loaded: restored.sessionDoc("idle") === acquired,
    }).toEqual({ id: "idle", live: undefined, loaded: true });
  });

  it("kernel overviews survive dispose through SQLite", async () => {
    const system = await openKernel("glance-k");
    const workspace = await openKernel("glance-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("seated");
    session.root.agent.spec.resident = true;
    await kernel.flushSession(session.doc);
    await kernel.flushKernel();
    expect(kernel.doc.root.sessions.seated?.resident).toBe(true);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect({
      resident: restored.doc.root.sessions.seated?.resident,
      ids: Object.keys(restored.doc.root.sessions),
    }).toEqual({
      resident: true,
      ids: ["seated"],
    });
  });

  it("kernel teardown stops awareness and releases pins of a dropped project host", async () => {
    const system = await openKernel("drop-k");
    const workspace = await openKernel("drop-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const awareness = project.doc.awareness;
    const doc = project.doc;
    let stopped = false;
    awareness.on("destroy", () => {
      stopped = true;
    });
    project[Symbol.dispose]();
    expect({
      awarenessDoc: awareness.doc === doc,
      stopped,
    }).toEqual({ awarenessDoc: true, stopped: false });
    kernel[Symbol.dispose]();
    expect(stopped).toBe(true);
  });

  it("two runtime instances stay isolated", async () => {
    const workspace = await openKernel("shared-ws");
    const k1 = new KernelDaemon(await openKernel("iso-a"));
    const k2 = new KernelDaemon(await openKernel("iso-b"));
    onTestFinished(() => {
      k1[Symbol.dispose]();
      k2[Symbol.dispose]();
    });
    await k1.ready;
    await k2.ready;
    const p1 = new ProjectDaemon(k1, workspace);
    const p2 = new ProjectDaemon(k2, workspace);
    await p1.ready;
    await p2.ready;
    const s1 = await p1.session("same");
    const s2 = await p2.session("same");
    s1.root.applyKvs([{ form: "kv-set", key: "mark", value: "left" }]);
    s2.root.applyKvs([{ form: "kv-set", key: "mark", value: "right" }]);
    expect({
      sameDoc: s1.doc === s2.doc,
      k1SeesK2: k1.sessionDoc("same") === s2.doc,
      k2SeesK1: k2.sessionDoc("same") === s1.doc,
      loadedSameDoc: k1.sessionDoc("same") === k2.sessionDoc("same"),
      marks: [s1.root.kvs.mark, s2.root.kvs.mark],
      dbs: k1.db === k2.db,
    }).toEqual({
      sameDoc: false,
      k1SeesK2: false,
      k2SeesK1: false,
      loadedSameDoc: false,
      marks: ["left", "right"],
      dbs: false,
    });
  });

  it("overlapping flushSession and stale checkpoint commit never regress humanApprove or pending_asks", async () => {
    const system = await openKernel("race-k");
    const workspace = await openKernel("race-p");
    const kernel = new KernelDaemon(system);
    onTestFinished(() => kernel[Symbol.dispose]());
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("race");

    const leaf = new SystemToolJob({
      toolCallId: "race-call-1",
      name: "write_file",
      argsJson: JSON.stringify({ path: "src/a.ts", content: "x" }),
    });
    runInAction(() => {
      session.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`go`,
        queue: [leaf],
      });
      leaf.stampPolicy("ask", null, null, {
        classesJson: '["workspace-write"]',
        votesJson: JSON.stringify([
          { disposition: "ask", class: "workspace-write", ruleId: "w", path: { cluster: "write", path: "src/a.ts" } },
        ]),
      });
    });
    await kernel.flushSession(session.doc);

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let gateArmed = true;
    const originalBatch = kernel.db.batch.bind(kernel.db);
    vi.spyOn(kernel.db, "batch").mockImplementation(async (fn) => {
      if (gateArmed) {
        gateArmed = false;
        entered.resolve();
        await release.promise;
      }
      return originalBatch(fn);
    });

    session.root.applyKvs([{ form: "kv-set", key: "step", value: "1" }]);
    const flush1 = kernel.flushSession(session.doc);
    await entered.promise;

    // While flush1 holds the batch gate, queue flush2, capture a pre-approval checkpoint,
    // and then approve the leaf so flush2 sees live state and staleCheckpoint is older.
    session.root.applyKvs([{ form: "kv-set", key: "step", value: "2" }]);
    const flush2 = kernel.flushSession(session.doc);
    const staleCheckpoint = session.sessionRuntime.checkpoint();
    runInAction(() => {
      leaf.humanApprove = true;
    });

    release.resolve();
    await Promise.all([flush1, flush2]);

    await kernel.flushSession(session.doc, { checkpoint: staleCheckpoint });

    const pendingAsks = await kernel.db.scan("pending_asks", { where: { sessionId: "race" } });
    const loaded = await loadSessionNodesFromKv(kernel.db, "race");
    if (loaded === undefined) throw new Error("missing session rows");
    const restored = SessionDocument.fromNodeRows(loaded.rows, {
      rootId: loaded.rootId,
      sessionId: "race",
      revision: loaded.revision,
    });
    onTestFinished(() => restored.destroy());
    const restoredLeaf = restored.getNode(leaf.uuid);
    expect(pendingAsks).toEqual([]);
    expect(restoredLeaf instanceof SystemToolJob ? restoredLeaf.humanApprove : undefined).toBe(true);
    expect(restored.root.findRunningTurn()?.approvalHead ?? null).toBeNull();
  });
});
