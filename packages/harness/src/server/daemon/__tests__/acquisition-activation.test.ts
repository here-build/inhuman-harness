/**
 * Construction vs acquire/hydrate/activate. getLoaded never I/O.
 * Two kernel instances do not share path-keyed overlays.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { SessionPlexus } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { documentKey } from "@/protocol/document";
import { catalogRecipe } from "@/tool-catalog";

import { KernelDaemon } from "../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";

async function openKernel(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `harness-l1-${label}-`)));
}

describe("acquisition and activation gates", () => {
  beforeEach(() => resetLocalIDs());

  it("getLoaded does not read disk", async () => {
    const system = await openKernel("k");
    const workspace = await openKernel("p");
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

    const open = vi.spyOn(restored.runtime.documents!, "openExisting");
    expect({
      plexus: restored.sessionPlexus("idle"),
      loaded: restored.runtime.documents?.getLoaded(documentKey("sessions", "idle")),
      live: restored.liveSession("idle"),
    }).toEqual({ plexus: undefined, loaded: undefined, live: undefined });
    expect(open).not.toHaveBeenCalled();

    const acquired = await restored.acquireSession("idle");
    expect({
      id: acquired?.root.sessionId,
      loaded: restored.runtime.documents?.getLoaded(documentKey("sessions", "idle"))?.doc === acquired?.doc,
      live: restored.liveSession("idle"),
      openCalls: open.mock.calls.length,
    }).toEqual({
      id: "idle",
      loaded: true,
      live: undefined,
      openCalls: 1,
    });
    open.mockRestore();
  });

  it("acquire pins a replica without activating honor", async () => {
    const system = await openKernel("k2");
    const workspace = await openKernel("p2");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("idle");
    expect(session.orchestrator.activated).toBe(true);
    await kernel.flushSession(session.plexus);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    const acquired = await restored.acquireSession("idle");
    expect({
      pinned: acquired != null && restored.sessionPlexus("idle") === acquired,
      live: restored.liveSession("idle"),
    }).toEqual({ pinned: true, live: undefined });

    const daemon = await restored.attachSession("idle");
    expect({
      live: restored.liveSession("idle"),
      activated: daemon?.orchestrator.activated === true,
      sameDoc: daemon?.plexus.doc === acquired?.doc,
    }).toEqual({ live: undefined, activated: false, sameDoc: true });
  });

  it("overlapping acquireSession connects one plexus", async () => {
    const system = await openKernel("k-acq");
    const workspace = await openKernel("p-acq");
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
    const connect = vi.spyOn(SessionPlexus, "connect");
    const open = vi.spyOn(restored.runtime.documents!, "openExisting");
    const [a, b] = await Promise.all([restored.acquireSession("idle"), restored.acquireSession("idle")]);
    expect({
      same: a === b,
      id: a?.root.sessionId,
      connects: connect.mock.calls.length,
      opens: open.mock.calls.length,
    }).toEqual({ same: true, id: "idle", connects: 1, opens: 1 });
    connect.mockRestore();
    open.mockRestore();
  });

  it("overlapping attach of a restored conversation without a seat stays honor-off", async () => {
    const system = await openKernel("k-att");
    const workspace = await openKernel("p-att");
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
    const [a, b] = await Promise.all([restored.attachSession("idle"), restored.attachSession("idle")]);
    expect({
      same: a === b,
      activated: a?.orchestrator.activated === true,
      live: restored.liveSession("idle"),
      published: a != null && a.project.sessions[a.sessionId] === a,
    }).toEqual({
      same: true,
      activated: false,
      live: undefined,
      published: false,
    });
  });

  it("two kernels with the same workspace path keep separate overlays and intern tables", async () => {
    const workspace = await openKernel("shared-ws");
    const k1 = new KernelDaemon(await openKernel("a"));
    const k2 = new KernelDaemon(await openKernel("b"));
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

    k1.catalog.bindProjectRecipes(workspace, [
      catalogRecipe({
        name: "alpha",
        category: "plugin",
        capabilities: [],
        invokes: [],
      }),
    ]);
    k2.catalog.bindProjectRecipes(workspace, [
      catalogRecipe({
        name: "beta",
        category: "plugin",
        capabilities: [],
        invokes: [],
      }),
    ]);
    expect({
      a: k1.catalog.projectRecipesOf(workspace).map((recipe) => recipe.spec.name),
      b: k2.catalog.projectRecipesOf(workspace).map((recipe) => recipe.spec.name),
    }).toEqual({ a: ["alpha"], b: ["beta"] });

    const s1 = await p1.session("same");
    const s2 = await p2.session("same");
    expect({
      samePlexus: s1.plexus === s2.plexus,
      k1SeesK2: k1.sessionPlexus("same") === s2.plexus,
      k2SeesK1: k2.sessionPlexus("same") === s1.plexus,
      loadedSameDoc:
        k1.runtime.documents?.getLoaded(documentKey("sessions", "same"))?.doc ===
        k2.runtime.documents?.getLoaded(documentKey("sessions", "same"))?.doc,
    }).toEqual({
      samePlexus: false,
      k1SeesK2: false,
      k2SeesK1: false,
      loadedSameDoc: false,
    });
  });
});
