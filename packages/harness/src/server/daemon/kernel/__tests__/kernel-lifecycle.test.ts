/**
 * Kernel lifetime edges: shutdown persists the last write, a failed boot or
 * project load is retried instead of cached, an unopenable session is not
 * "not found", and dispose during boot stops the boot.
 */
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishKernelSeat, sessionIsOccupied } from "@inhuman.tools/harness-model";
import { runInAction, when } from "mobx";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { HarnessDaemon } from "../../server/HarnessDaemon.js";
import { KernelDaemon } from "../KernelDaemon.js";

async function scratch(label: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `harness-life-${label}-`)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("kernel lifetime", () => {
  
  it("async dispose persists a write made just before it and releases every document", async () => {
    const system = await scratch("k");
    const workspace = await scratch("p");
    const daemon = new HarnessDaemon(system);
    const kernel = await daemon.kernel();
    const session = await (await daemon.project(workspace)).session("s");
    kernel.plexus.root.termContinue.k = "last";
    session.root.mode = "plan";
    await daemon[Symbol.asyncDispose]();
    expect(kernel.runtime.documents?.loaded()).toEqual([]);

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect({
      kernel: restored.plexus.root.termContinue.k,
      session: (await restored.acquireSession("s"))?.root.mode,
    }).toEqual({ kernel: "last", session: "plan" });
  });

  it("a failed kernel boot is retried, not cached", async () => {
    const parent = await scratch("boot");
    const system = join(parent, "kernel");
    writeFileSync(system, "not a directory");
    const daemon = new HarnessDaemon(system);
    onTestFinished(() => daemon[Symbol.asyncDispose]());
    await expect(daemon.kernel()).rejects.toThrow();
    rmSync(system);
    await mkdir(system);
    const kernel = await daemon.kernel();
    expect(kernel.plexus.root).toBeDefined();
  });

  it("a failed project load is retried, and a concurrent caller waits for ready", async () => {
    const system = await scratch("k");
    const workspace = await scratch("p");
    const daemon = new HarnessDaemon(system);
    onTestFinished(() => daemon[Symbol.asyncDispose]());
    const kernel = await daemon.kernel();
    vi.spyOn(kernel, "loadProjectDoc").mockRejectedValueOnce(new Error("project document create failed: overload"));
    await expect(daemon.project(workspace)).rejects.toThrow(/overload/);

    const first = daemon.project(workspace);
    const second = await daemon.project(workspace);
    expect({ plexus: second.plexus != null, same: second === (await first) }).toEqual({ plexus: true, same: true });
  });

  it("an unopenable session reports why instead of not found", async () => {
    const system = await scratch("k");
    const workspace = await scratch("p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = kernel.project(workspace);
    await project.ready;
    await kernel.flushSession((await project.session("s")).plexus);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    vi.spyOn(restored.runtime.documents!, "openExisting").mockResolvedValueOnce({ ok: false, reason: "overload" });
    await expect(restored.acquireSession("s")).rejects.toThrow(/overload/);
    expect({
      found: (await restored.acquireSession("s"))?.root.sessionId,
      missing: await restored.acquireSession("never"),
    }).toEqual({ found: "s", missing: undefined });
  });

  it("dispose during boot stops the boot", async () => {
    const system = await scratch("k");
    const kernel = new KernelDaemon(system);
    const load = vi.spyOn(kernel, "loadProjectDoc");
    kernel[Symbol.dispose]();
    await kernel.ready;
    expect(load).not.toHaveBeenCalled();
  });

  it("project/pick registers a directory chosen locally and refuses remote callers", async () => {
    const system = await scratch("k");
    const workspace = await scratch("picked");
    const kernel = new KernelDaemon(system);
    onTestFinished(() => kernel[Symbol.dispose]());
    await kernel.ready;

    kernel.setDirectoryPicker(async () => workspace);
    const picked = await kernel.handleRequest("project/pick", {}, { requestId: 1, connectionId: "local-1" });
    expect(picked).toEqual({ ok: true, path: workspace });
    expect(kernel.hasProject(workspace)).toBe(true);
    expect(Object.keys(kernel.plexus.root.projects)).toContain(workspace);

    kernel.setDirectoryPicker(async () => null);
    const cancelled = await kernel.handleRequest("project/pick", {}, { requestId: 2, connectionId: "local-1" });
    expect(cancelled).toEqual({ ok: false });

    await expect(
      kernel.handleRequest("project/pick", {}, { requestId: 3, connectionId: "remote-1", remote: true }),
    ).rejects.toThrow(/only available locally/);

    // Persist and restore even when the picked project has zero sessions.
    kernel[Symbol.dispose]();
    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect(restored.hasProject(workspace)).toBe(true);
    expect(Object.keys(restored.plexus.root.projects)).toContain(workspace);
    expect(restored.project(workspace).root.path).toBe(workspace);
    expect(restored.project(workspace).root.sessions).toEqual({});
  });

  it("flush writes the document face onto the sessions row", async () => {
    const system = await scratch("k");
    const workspace = await scratch("p");
    const kernel = new KernelDaemon(system);
    onTestFinished(() => kernel[Symbol.dispose]());
    await kernel.ready;
    const project = kernel.project(workspace);
    await project.ready;
    const session = await project.session("s");
    runInAction(() => {
      session.root.mode = "act";
      session.root.standingPermissionMode = "yolo";
      session.root.manualTitle = "Kept";
    });
    publishKernelSeat(kernel.plexus.awareness, "s");
    await when(() => sessionIsOccupied(kernel.plexus.awareness, "s"), { timeout: 2_000 });

    // `running` is openTurn. A seat leaves it false.
    await kernel.flushSession(session.plexus);
    expect({
      occupied: sessionIsOccupied(kernel.plexus.awareness, "s"),
      row: kernel.db.getSession("s"),
    }).toMatchObject({
      occupied: true,
      row: {
        title: "Kept",
        workspacePath: workspace,
        mode: "agentic",
        permissionMode: "yolo",
        running: false,
        headTurnId: null,
      },
    });
  });
});
