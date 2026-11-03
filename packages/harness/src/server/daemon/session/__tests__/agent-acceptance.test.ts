/**
 * Delivery is the enqueue into the worker's document, keyed by the call. Worker
 * ids derive from the call, so a re-run after a crash finds the same worker.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import { asUserPrompt } from "@inhuman.tools/harness-commons";
import {
  AGENT_ASK,
  AgentCallbackJob,
  AgentCallJob,
  BotCallJob,
  SessionAdmission,
  SessionSystemPrompt,
  SessionTurn,
  type ToolCallJob,
} from "@inhuman.tools/harness-model";
import { joinReleased } from "@inhuman.tools/turn/agent-calls";
import { SessionRuntime } from "@inhuman.tools/turn/runtime";
import { mkdtemp, realpath } from "fs-extra";
import { runInAction, when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";

import { catalogRecipe } from "@/tool-catalog";

import { applyPackPlugins } from "../../../toolkit/actor.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

const FIXTURE_PLUGIN = fileURLToPath(
  new URL("../../../toolkit/__tests__/fixtures/plugin-abi-fixture/plugin.js", import.meta.url),
);
const TIMEOUT = 8_000;

async function openPluginHarness() {
  const system = await mkdtemp(join(tmpdir(), "harness-accept-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-accept-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const fixture = await import(FIXTURE_PLUGIN);
  await applyPackPlugins(kernel.catalog, [{ pluginName: "abi-fixture", module: fixture }]);
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("caller");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, project, session };
}

/** Inbound turns for one request across every interned session. */
function requestTurns(kernel: KernelDaemon, requestId: string): number {
  let count = 0;
  for (const replica of kernel.runtime.replicaValues()) {
    const seen = new Set<unknown>();
    for (let unit: unknown = replica.root.head; unit instanceof SessionTurn; unit = unit.turnTail) {
      if (seen.has(unit)) break;
      seen.add(unit);
      if (unit.agentRequestId === requestId) count += 1;
    }
  }
  return count;
}

function closedTurn(child: ToolCallJob) {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    reducerExited: true,
  });
  turn.pushChild(child);
  return turn;
}

describe("agent acceptance step 3", () => {
  beforeEach(() => resetLocalIDs());

  it("replacement while a child session attaches drops the old caller's late delivery", async () => {
    const { project, session } = await openPluginHarness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const attach = project.session;
    vi.spyOn(project, "session").mockImplementation(async (id) => {
      entered.resolve();
      await release.promise;
      try {
        return await attach.call(project, id);
      } finally {
        returned.resolve();
      }
    });
    const call = new AgentCallJob({
      name: AGENT_ASK,
      argsJson: JSON.stringify({ message: "work" }),
      humanApprove: true,
      orchestrationResult: true,
    });
    session.root.head = closedTurn(call);
    await entered.promise;
    const replacement = new SessionRuntime(session.plexus, { kind: "memory" });
    onTestFinished(() => replacement[Symbol.asyncDispose]());
    const before = Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64");
    release.resolve();
    await returned.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({
      worker: call.workerSessionId,
      completed: call.completed,
      state: Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64"),
    }).toEqual({ worker: "", completed: false, state: before });
  });

  it.each(["acknowledged", "exact retry", "changed reply"] as const)(
    "callback retains its worker and parent admission until a covering receipt (%s)",
    async (mode) => {
      const lostAcknowledgement = mode !== "acknowledged";
      const { kernel, project, session } = await openPluginHarness();
      const call = new BotCallJob({
        name: "fixture_offload",
        argsJson: JSON.stringify({ guidance: "review" }),
        humanApprove: true,
        background: true,
      });
      session.root.head = closedTurn(call);
      await when(
        () =>
          call.workerSessionId !== "" &&
          kernel.sessionPlexus(call.workerSessionId)?.root.agentCallbacks[call.uuid] === session.sessionId,
        { timeout: TIMEOUT },
      );
      const worker = await project.session(call.workerSessionId);
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      onTestFinished(() => release.resolve());
      let waiting = false;
      const flush = kernel.flushSession;
      vi.spyOn(kernel, "flushSession").mockImplementation(async (plexus, options) => {
        if (!waiting && plexus.doc === session.plexus.doc && call.completed) {
          waiting = true;
          entered.resolve();
          await release.promise;
          await flush.call(kernel, plexus, options);
          if (lostAcknowledgement) throw new Error("caller receipt acknowledgement lost");
          return;
        }
        await flush.call(kernel, plexus, options);
      });
      const argsJson = JSON.stringify({ requestId: call.uuid });
      const callback = new AgentCallbackJob({ name: "agent__void", argsJson, humanApprove: true });
      worker.root.head = closedTurn(callback);
      await entered.promise;
      const firstReceipt = call.receiptJson;
      const head = session.root.head;
      if (!lostAcknowledgement) {
        session.root.applyKvs([{ form: "kv-set", key: "connection", value: "receipt-test" }]);
        session.root.promptQueue.push(
          new SessionAdmission({ text: asUserPrompt("after the receipt"), composedAtMs: 1 }),
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect({
        held: session.sessionRuntime.admissionHeld,
        successor: session.root.head !== head,
        workerOwned: worker.sessionRuntime.isCurrent,
        callbackCompleted: callback.completed,
        obligation: worker.root.agentCallbacks[call.uuid],
      }).toEqual({
        held: true,
        successor: false,
        workerOwned: true,
        callbackCompleted: false,
        obligation: session.sessionId,
      });
      release.resolve();
      await when(() => callback.completed, { timeout: TIMEOUT });
      if (lostAcknowledgement) {
        expect({
          held: session.sessionRuntime.admissionHeld,
          obligation: worker.root.agentCallbacks[call.uuid],
        }).toEqual({ held: true, obligation: session.sessionId });
        if (mode === "exact retry") await session.handleRequest("turn/retry", {});
        const resumed = await project.session(call.workerSessionId);
        const repeated = new AgentCallbackJob({
          name: mode === "changed reply" ? "agent__respond" : "agent__void",
          argsJson:
            mode === "changed reply"
              ? JSON.stringify({ requestId: call.uuid, response: "a different later reply" })
              : argsJson,
          humanApprove: true,
        });
        resumed.root.head = closedTurn(repeated);
        await when(() => repeated.completed && resumed.root.agentCallbacks[call.uuid] == null, { timeout: TIMEOUT });
        expect({
          held: session.sessionRuntime.admissionHeld,
          receipt: repeated.outcomeSnap,
          parentReceipt: call.receiptJson,
        }).toEqual({
          held: false,
          receipt: { ok: true, text: "caller already settled" },
          parentReceipt: firstReceipt,
        });
      } else {
        await when(() => session.root.head !== head && !session.sessionRuntime.admissionHeld, { timeout: TIMEOUT });
        expect({
          held: session.sessionRuntime.admissionHeld,
          obligation: worker.root.agentCallbacks[call.uuid],
          receipt: callback.outcomeSnap,
        }).toEqual({ held: false, obligation: undefined, receipt: { ok: true } });
      }
    },
  );

  it("a bot request with no response schema is delivered", async () => {
    const { kernel, session } = await openPluginHarness();
    const call = new BotCallJob({
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "review" }),
      humanApprove: true,
      background: true,
      orchestrationResult: true,
    });
    session.root.head = closedTurn(call);
    await when(
      () =>
        call.completed || kernel.sessionPlexus(call.workerSessionId)?.root.findTurnByAgentRequestId(call.uuid) != null,
      { timeout: TIMEOUT },
    );
    expect({
      completed: call.completed,
      outcome: call.outcome,
      delivered: kernel.sessionPlexus(call.workerSessionId)?.root.findTurnByAgentRequestId(call.uuid) != null,
    }).toEqual({ completed: false, outcome: null, delivered: true });
  });

  it("a contribution target stays pinned when its tool alias points to another bot", async () => {
    const { kernel, session } = await openPluginHarness();
    kernel.catalog.replaceRecipes(
      ["original", "replacement"].map((name) =>
        catalogRecipe({
          name,
          category: "internal",
          recipeScope: "session",
          capabilities: [{ name: "run" }],
          invokes: [],
        }),
      ),
    );
    kernel.catalog.botRevisions = new Map([["original", "original-revision"]]);
    kernel.catalog.replacePack([
      {
        wireName: "retargeted_alias",
        description: "alias now points elsewhere",
        parameters: { type: "object", properties: {} },
        class: "effect",
        source: { kind: "pack", pluginName: "behavior-plugin" },
        packMeta: {
          kind: "bot-call",
          pluginName: "behavior-plugin",
          target: "replacement",
          background: true,
          lifetime: "call",
          show: "result",
          supportsNotify: false,
        },
      },
    ]);
    const call = new BotCallJob({
      name: "retargeted_alias",
      argsJson: "{}",
      contributionPluginName: "behavior-plugin",
      contributionBotName: "original",
      contributionRevision: "original-revision",
      humanApprove: true,
      orchestrationResult: true,
    });
    session.root.head = closedTurn(call);
    await when(
      () =>
        call.completed || kernel.sessionPlexus(call.workerSessionId)?.root.findTurnByAgentRequestId(call.uuid) != null,
      { timeout: TIMEOUT },
    );
    const worker = kernel.sessionPlexus(call.workerSessionId);
    expect({
      completed: call.completed,
      target: worker?.root.agent.spec.name,
      originalRoster: session.root.botsRoster.original,
      replacementRoster: session.root.botsRoster.replacement,
    }).toEqual({
      completed: false,
      target: "original",
      originalRoster: call.workerSessionId,
      replacementRoster: undefined,
    });
  });

  it("a bot request is delivered into its worker with no caller write, and the caller does not wait on it", async () => {
    const { kernel, session } = await openPluginHarness();
    const call = new BotCallJob({
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "go" }),
      humanApprove: true,
      background: true,
      orchestrationResult: true,
    });
    const originalFlush = kernel.flushSession.bind(kernel);
    const flushed: string[] = [];
    vi.spyOn(kernel, "flushSession").mockImplementation(async (plexus) => {
      flushed.push(plexus.root.sessionId);
      if (plexus.root.sessionId === "caller") throw new Error("caller persistence unavailable");
      return originalFlush(plexus);
    });
    session.root.head = closedTurn(call);
    await when(() => kernel.sessionPlexus(call.workerSessionId)?.root.findTurnByAgentRequestId(call.uuid) != null, {
      timeout: TIMEOUT,
    });
    await when(() => joinReleased(call, kernel.catalog), { timeout: TIMEOUT });
    const worker = kernel.sessionPlexus(call.workerSessionId)!;
    expect({
      completed: call.completed,
      row: worker.root.agentCallbacks[call.uuid],
      workerFlushed: flushed.includes(call.workerSessionId),
    }).toEqual({ completed: false, row: "caller", workerFlushed: true });
  });

  it("a crash between the worker enqueue and any caller write delivers once, to the same worker", async () => {
    const { kernel, project, session } = await openPluginHarness();
    const call = new BotCallJob({
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "once" }),
      humanApprove: true,
      background: true,
      orchestrationResult: true,
    });
    session.root.head = closedTurn(call);
    await when(() => kernel.sessionPlexus(call.workerSessionId)?.root.findTurnByAgentRequestId(call.uuid) != null, {
      timeout: TIMEOUT,
    });
    const first = call.workerSessionId;
    await session.park();
    // The caller's identity writes never reached storage.
    runInAction(() => {
      call.workerSessionId = "";
      delete session.root.botsRoster.worker;
    });
    await project.session("caller");
    await when(() => call.workerSessionId !== "", { timeout: TIMEOUT });
    await when(() => kernel.sessionPlexus(call.workerSessionId)?.root.agentCallbacks[call.uuid] != null, {
      timeout: TIMEOUT,
    });
    expect({
      same: call.workerSessionId === first,
      roster: session.root.botsRoster.worker === first,
      deliveries: requestTurns(kernel, call.uuid),
    }).toEqual({ same: true, roster: true, deliveries: 1 });
  });

  it("an ask is delivered into its worker with no caller write, and the worker is flushed", async () => {
    const { kernel, session } = await openPluginHarness();
    const ask = new AgentCallJob({
      name: AGENT_ASK,
      argsJson: JSON.stringify({ message: "classify" }),
      humanApprove: true,
      orchestrationResult: true,
    });
    const originalFlush = kernel.flushSession.bind(kernel);
    const flushed: string[] = [];
    vi.spyOn(kernel, "flushSession").mockImplementation(async (plexus) => {
      flushed.push(plexus.root.sessionId);
      if (plexus.root.sessionId === "caller") throw new Error("caller persistence unavailable");
      return originalFlush(plexus);
    });
    session.root.head = closedTurn(ask);
    await vi.waitFor(() => expect(ask.workerSessionId !== "" && flushed.includes(ask.workerSessionId)).toBe(true), {
      timeout: TIMEOUT,
    });
    expect({
      completed: ask.completed,
      delivered: kernel.sessionPlexus(ask.workerSessionId)?.root.findTurnByAgentRequestId(ask.uuid) != null,
      row: kernel.sessionPlexus(ask.workerSessionId)?.root.agentCallbacks[ask.uuid],
    }).toEqual({ completed: false, delivered: true, row: "caller" });
  });

  it("a one-shot ask's worker is derived from the call, so a re-run reattaches it", async () => {
    const { kernel, project, session } = await openPluginHarness();
    const ask = new AgentCallJob({
      name: AGENT_ASK,
      argsJson: JSON.stringify({ message: "classify" }),
      humanApprove: true,
      orchestrationResult: true,
    });
    session.root.head = closedTurn(ask);
    await when(() => kernel.sessionPlexus(ask.workerSessionId)?.root.findTurnByAgentRequestId(ask.uuid) != null, {
      timeout: TIMEOUT,
    });
    const first = ask.workerSessionId;
    await session.park();
    runInAction(() => {
      ask.workerSessionId = "";
    });
    await project.session("caller");
    await when(() => ask.workerSessionId !== "", { timeout: TIMEOUT });
    expect({ same: ask.workerSessionId === first, deliveries: requestTurns(kernel, ask.uuid) }).toEqual({
      same: true,
      deliveries: 1,
    });
  });

  it("a call that names its worker but never reached it is delivered on the next wrap", async () => {
    const system = await realpath(await mkdtemp(join(tmpdir(), "agent-enqueue-k-")));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "agent-enqueue-p-")));
    const restoreKernel = new KernelDaemon(system);
    await restoreKernel.ready;
    restoreKernel.catalog.replaceRecipes([
      catalogRecipe({
        name: "worker",
        category: "internal",
        recipeScope: "session",
        capabilities: [{ name: "run" }],
        invokes: [],
      }),
    ]);
    const project = new ProjectDaemon(restoreKernel, workspace);
    const caller = await project.session("caller");
    onTestFinished(() => {
      project[Symbol.dispose]();
      restoreKernel[Symbol.dispose]();
    });
    const worker = await project.session("partial-worker");
    worker.root.agent.spec.name = "worker";
    const interrupted = new BotCallJob({
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "worker", message: "work" }),
      workerSessionId: worker.sessionId,
      humanApprove: true,
    });
    caller.root.head = closedTurn(interrupted);
    await when(
      () =>
        worker.root.agentCallbacks[interrupted.uuid] === "caller" &&
        worker.root.head?.agentRequestId === interrupted.uuid,
      { timeout: TIMEOUT },
    );
    expect({
      row: worker.root.agentCallbacks[interrupted.uuid],
      requestId: worker.root.head!.agentRequestId,
    }).toEqual({ row: "caller", requestId: interrupted.uuid });
    const head = worker.root.head;
    await caller.park();
    await project.session("caller");
    const liveWorker = await project.session(worker.sessionId);
    await when(() => liveWorker.root.head === head && liveWorker.root.agentCallbacks[interrupted.uuid] === "caller", {
      timeout: TIMEOUT,
    });
    expect({ replay: liveWorker.root.head === head }).toEqual({ replay: true });
  });
});
