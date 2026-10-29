/**
 * Activation follows seats, daemon policy, and admitted calls.
 * Rootless cycles stay inert. Shared workers keep independent grants.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import {
  BotCallJob,
  publishKernelSeat,
  sessionIsOccupied,
  SessionSystemPrompt,
  SessionTurn,
  type SessionRoot,
} from "@inhuman.tools/harness-model";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { collectDelegatedGrants } from "@/runtime";

import { KernelDaemon } from "../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";

const TIMEOUT = 8_000;

async function openKernel(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `harness-l2-${label}-`)));
}

/** Both halves of an admitted call: the caller's job and the worker's callback row. */
function admitCall(caller: { root: SessionRoot }, worker: { root: SessionRoot }): BotCallJob {
  const call = new BotCallJob({
    name: "agent__send",
    argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
    workerSessionId: worker.root.sessionId,
    acceptedAt: Date.now(),
    preparedInputJson: "{}",
    humanApprove: true,
    contributionPluginName: "missing-pack",
    contributionBotName: "shared",
    contributionRevision: "paused",
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
  });
  turn.pushChild(call);
  caller.root.head = turn;
  worker.root.ensureAgentCallback(call.uuid, caller.root.sessionId);
  return call;
}

describe("eligibility and delegated grants", () => {
  beforeEach(() => resetLocalIDs());

  it("rootless cycle of acquired replicas does not activate honor", async () => {
    const system = await openKernel("cycle-k");
    const workspace = await openKernel("cycle-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const a = await project.session("a");
    const b = await project.session("b");
    a.root.agent.spec.recipeScope = "session";
    a.root.agent.spec.name = "alpha";
    b.root.agent.spec.recipeScope = "session";
    b.root.agent.spec.name = "beta";
    admitCall(a, b);
    admitCall(b, a);
    await kernel.flushSession(a.plexus);
    await kernel.flushSession(b.plexus);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    const acquiredA = await restored.acquireSession("a");
    const acquiredB = await restored.acquireSession("b");
    const attached = await restored.attachSession("a");
    expect({
      a: acquiredA?.root.sessionId,
      b: acquiredB?.root.sessionId,
      liveA: restored.liveSession("a"),
      liveB: restored.liveSession("b"),
      honor: attached?.orchestrator.activated === true,
    }).toEqual({ a: "a", b: "b", liveA: undefined, liveB: undefined, honor: false });
  });

  it("shared worker keeps the other caller's grant when one caller parks", async () => {
    const system = await openKernel("share-k");
    const workspace = await openKernel("share-p");
    const kernel = new KernelDaemon(system);
    onTestFinished(() => kernel[Symbol.dispose]());
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const a = await project.session("a");
    const b = await project.session("b");
    const worker = await project.session("w");
    worker.root.agent.spec.recipeScope = "session";
    worker.root.agent.spec.name = "shared";
    await a.park();
    await b.park();
    await worker.park();
    const pinnedA = kernel.sessionPlexus("a")!;
    const pinnedB = kernel.sessionPlexus("b")!;
    pinnedA.root.botsRoster.shared = "w";
    pinnedB.root.botsRoster.shared = "w";
    admitCall(pinnedA, kernel.sessionPlexus("w")!);
    admitCall(pinnedB, kernel.sessionPlexus("w")!);
    expect(
      collectDelegatedGrants({ replica: (id) => kernel.sessionPlexus(id) }, ["a", "b", "w"]).map(
        (row) => `${row.callerSessionId}->${row.workerSessionId}`,
      ),
    ).toEqual(["a->w", "b->w"]);
    kernel.reserveAttachment("a");
    kernel.reserveAttachment("b");
    const liveW = await project.session("w");
    expect(liveW.orchestrator.activated).toBe(true);
    kernel.dropReservation("a");
    expect(kernel.liveSession("w")?.orchestrator.activated).toBe(true);
    kernel.dropReservation("b");
    await when(() => kernel.liveSession("w") == null, { timeout: TIMEOUT });
  });

  it("restored conversation without a seat stays honor-off", async () => {
    const system = await openKernel("idle-k");
    const workspace = await openKernel("idle-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const idle = await project.session("idle");
    await kernel.flushSession(idle.plexus);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    await restored.acquireSession("idle");
    const attached = await restored.attachSession("idle");
    expect({
      honor: attached?.orchestrator.activated === true,
      live: restored.liveSession("idle"),
    }).toEqual({ honor: false, live: undefined });
  });

  it("admitted call plus a caller seat activates the worker", async () => {
    const system = await openKernel("seat-k");
    const workspace = await openKernel("seat-p");
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const caller = await project.session("caller");
    const worker = await project.session("w");
    worker.root.agent.spec.recipeScope = "session";
    worker.root.agent.spec.name = "reviewer";
    await caller.park();
    await worker.park();
    const pinnedCaller = kernel.sessionPlexus("caller")!;
    pinnedCaller.root.botsRoster.reviewer = "w";
    admitCall(pinnedCaller, kernel.sessionPlexus("w")!);
    await kernel.flushSession(pinnedCaller);
    await kernel.flushSession(kernel.sessionPlexus("w")!);
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    const acquiredCaller = await restored.acquireSession("caller");
    const acquiredWorker = await restored.acquireSession("w");
    expect({
      caller: acquiredCaller?.root.sessionId,
      worker: acquiredWorker?.root.sessionId,
      liveCaller: restored.liveSession("caller"),
      liveWorker: restored.liveSession("w"),
    }).toEqual({
      caller: "caller",
      worker: "w",
      liveCaller: undefined,
      liveWorker: undefined,
    });
    expect(
      collectDelegatedGrants({ replica: (id) => restored.sessionPlexus(id) }, ["caller", "w"]).map(
        (row) => row.workerSessionId,
      ),
    ).toEqual(["w"]);

    publishKernelSeat(restored.plexus.awareness, "caller");
    await when(() => sessionIsOccupied(restored.plexus.awareness, "caller"), {
      timeout: TIMEOUT,
    });
    await expect.poll(() => restored.liveSession("w")?.orchestrator.activated, { timeout: TIMEOUT }).toBe(true);
  });
});
