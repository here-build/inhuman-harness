/**
 * Recovery pins peer replicas. A peer that cannot open never blocks the
 * session that names it from attaching.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { mkdtemp } from "fs-extra";
import { runInAction } from "mobx";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

beforeEach(() => resetLocalIDs());

it("a corrupt peer is skipped and the session still attaches", async () => {
  const system = await mkdtemp(join(tmpdir(), "harness-recover-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-recover-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  onTestFinished(() => {
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  const session = await project.session("s1");
  runInAction(() => session.root.ensureAgentCallback("r1", "corrupt-caller"));
  await session.park();
  // Recovery is the first reader of the peer; ProjectDaemon's named reattach is not under test here.
  const acquire = kernel.acquireSession.bind(kernel);
  let corrupt = true;
  vi.spyOn(kernel, "acquireSession").mockImplementation(async (id) => {
    if (id === "corrupt-caller" && corrupt) {
      corrupt = false;
      throw new Error("corrupt session image");
    }
    return acquire(id);
  });
  const again = await project.session("s1");
  onTestFinished(() => again[Symbol.dispose]());
  expect({ root: again.root === session.root, read: !corrupt }).toEqual({ root: true, read: true });
});
