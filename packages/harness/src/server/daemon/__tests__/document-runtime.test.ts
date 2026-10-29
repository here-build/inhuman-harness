/**
 * ProductionRuntime + DocumentService: images round-trip through flush
 * receipts, getLoaded stays memory-only.
 */
import { chmodSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { documentKey, receiptCoversCheckpoint } from "@/protocol/document";
import { DocumentService } from "@/yjs";
import { documentImagePath } from "@/yjs/storage";

import { KernelDaemon } from "../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";

async function openKernel(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `harness-i1-${label}-`)));
}

describe("local document/runtime integration", () => {
  beforeEach(() => resetLocalIDs());

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

  it("kernel and session documents round-trip through DocumentService flush receipts", async () => {
    const system = await openKernel("flush-k");
    const workspace = await openKernel("flush-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("s1");
    await session.park();
    session.root.applyKvs([{ form: "kv-set", key: "mark", value: "hello" }]);
    const documents = kernel.runtime.documents!;
    const key = documentKey("sessions", "s1");
    const checkpoint = documents.checkpoint(key)!;
    const result = await documents.flush(key, checkpoint);
    expect({
      ok: result.ok,
      covers: result.ok && receiptCoversCheckpoint(result.receipt, checkpoint),
    }).toEqual({ ok: true, covers: true });
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect(restored.runtime.documents?.getLoaded(key)).toBeUndefined();
    const acquired = await restored.acquireSession("s1");
    expect({
      mark: acquired?.root.kvs.mark,
      live: restored.liveSession("s1"),
      loaded: restored.runtime.documents?.getLoaded(key)?.doc === acquired?.doc,
    }).toEqual({ mark: "hello", live: undefined, loaded: true });
  });

  it("failed flush is not success and keeps the dirty suffix loaded", async () => {
    const system = await openKernel("fail-k");
    const workspace = await openKernel("fail-p");
    const kernel = new KernelDaemon(system);
    onTestFinished(() => kernel[Symbol.dispose]());
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("s1");
    await kernel.flushSession(session.plexus);
    const documents = kernel.runtime.documents!;
    const key = documentKey("sessions", "s1");
    const image = documentImagePath(system, key);
    const dir = dirname(image);
    const mode = 0o755;
    chmodSync(dir, 0o555);
    chmodSync(image, 0o444);
    onTestFinished(() => {
      try {
        chmodSync(image, 0o600);
        chmodSync(dir, mode);
      } catch {}
    });
    session.root.applyKvs([{ form: "kv-set", key: "mark", value: "dirty" }]);
    await expect(kernel.flushSession(session.plexus)).rejects.toThrow(/storage-failed/);
    chmodSync(image, 0o600);
    chmodSync(dir, mode);
    expect({
      mark: session.root.kvs.mark,
      loaded: documents.getLoaded(key)?.doc === session.plexus.doc,
      dirty: documents instanceof DocumentService && documents.memory().dirtyBytes > 0,
    }).toEqual({ mark: "dirty", loaded: true, dirty: true });
  });

  it("getLoaded does not intern a cold image; openExisting hydrates without SessionDaemon", async () => {
    const system = await openKernel("cold-k");
    const workspace = await openKernel("cold-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("idle");
    await kernel.flushSession(session.plexus);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    const key = documentKey("sessions", "idle");
    expect({
      loaded: restored.runtime.documents?.getLoaded(key),
      plexus: restored.sessionPlexus("idle"),
      live: restored.liveSession("idle"),
    }).toEqual({ loaded: undefined, plexus: undefined, live: undefined });
    const acquired = await restored.acquireSession("idle");
    expect({
      id: acquired?.root.sessionId,
      live: restored.liveSession("idle"),
      loaded: restored.runtime.documents?.getLoaded(key)?.doc === acquired?.doc,
    }).toEqual({ id: "idle", live: undefined, loaded: true });
  });

  it("kernel overviews survive dispose through DocumentService", async () => {
    const system = await openKernel("glance-k");
    const workspace = await openKernel("glance-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("seated");
    session.root.agent.spec.resident = true;
    await kernel.flushSession(session.plexus);
    const kernelKey = documentKey("kernel", "kernel");
    const kernelDocs = kernel.runtime.documents!;
    const kernelFlush = await kernelDocs.flush(kernelKey, kernelDocs.checkpoint(kernelKey)!);
    expect(kernelFlush.ok).toBe(true);
    expect(kernel.plexus.root.sessions.seated?.resident).toBe(true);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect({
      resident: restored.plexus.root.sessions.seated?.resident,
      ids: Object.keys(restored.plexus.root.sessions),
      loaded: restored.runtime.documents?.getLoaded(documentKey("kernel", "kernel")) != null,
    }).toEqual({
      resident: true,
      ids: ["seated"],
      loaded: true,
    });
  });

  it("kernel teardown stops awareness and releases pins of a dropped project host", async () => {
    const system = await openKernel("drop-k");
    const workspace = await openKernel("drop-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const key = documentKey("projects", workspace);
    const awareness = project.plexus.awareness;
    const doc = project.plexus.doc;
    let stopped = false;
    awareness.on("destroy", () => {
      stopped = true;
    });
    project[Symbol.dispose]();
    expect({
      loaded: kernel.runtime.documents?.getLoaded(key)?.doc === doc,
      awarenessDoc: awareness.doc === doc,
      stopped,
    }).toEqual({ loaded: true, awarenessDoc: true, stopped: false });
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
      samePlexus: s1.plexus === s2.plexus,
      k1SeesK2: k1.sessionPlexus("same") === s2.plexus,
      k2SeesK1: k2.sessionPlexus("same") === s1.plexus,
      loadedSameDoc:
        k1.runtime.documents?.getLoaded(documentKey("sessions", "same"))?.doc ===
        k2.runtime.documents?.getLoaded(documentKey("sessions", "same"))?.doc,
      marks: [s1.root.kvs.mark, s2.root.kvs.mark],
      documents: k1.runtime.documents === k2.runtime.documents,
    }).toEqual({
      samePlexus: false,
      k1SeesK2: false,
      k2SeesK1: false,
      loadedSameDoc: false,
      marks: ["left", "right"],
      documents: false,
    });
  });
});
