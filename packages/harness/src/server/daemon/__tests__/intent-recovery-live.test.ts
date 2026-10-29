/**
 * Live KernelDaemon + ProjectDaemon wiring of the K2 intent/recovery adapter.
 * Natural seating. No HTTPServer / HarnessDaemon.
 */
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import {
  BotCallJob,
  CompletionExpectation,
  CompletionJob,
  ContextNeedToolJob,
  FileMutateToolJob,
  MCPToolJob,
  McpToolExpectation,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  WebSearchExpectation,
  WebSearchToolJob,
} from "@inhuman.tools/harness-model";
import { joinReleased } from "@inhuman.tools/turn/agent-calls";
import { observable, runInAction, when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { documentKey } from "@/protocol/document";
import { persistJobIntent } from "@/runtime";
import type { CatalogEntry } from "@/tool-catalog";
import { documentImagePath } from "@/yjs/storage";

import { KernelDaemon } from "../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";

const TIMEOUT = 8_000;

async function openKernel(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `harness-i2-${label}-`)));
}

function botCall(wireName: string): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: "effect",
    source: { kind: "pack", pluginName: "pack" },
    packMeta: {
      kind: "bot-call",
      pluginName: "pack",
      target: "worker",
      background: true,
      lifetime: "call",
      show: "result",
      supportsNotify: false,
    },
  };
}

function closedTurn(
  ...children: Array<SystemToolJob | FileMutateToolJob | BotCallJob | ContextNeedToolJob>
): SessionTurn {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    reducerExited: true,
  });
  for (const child of children) turn.pushChild(child);
  return turn;
}

async function openLive(label: string) {
  const system = await openKernel(`${label}-k`);
  const workspace = await openKernel(`${label}-p`);
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  onTestFinished(() => kernel[Symbol.dispose]());
  return { system, workspace, kernel, project };
}

function lockSessionImages(system: string, sessionId: string): void {
  const dir = dirname(documentImagePath(system, documentKey("sessions", sessionId)));
  const images = readdirSync(dir).map((name) => join(dir, name));
  const mode = 0o755;
  chmodSync(dir, 0o555);
  for (const image of images) chmodSync(image, 0o444);
  onTestFinished(() => {
    try {
      for (const image of images) chmodSync(image, 0o600);
      chmodSync(dir, mode);
    } catch {}
  });
}

describe("live intent receipts and recovery gate", () => {
  beforeEach(() => resetLocalIDs());

  it("intentRequired file-mutate does not run BODY when flush fails, and settles as a failure", async () => {
    const { system, workspace, kernel, project } = await openLive("chmod");
    const session = await project.session("write");
    await kernel.flushSession(session.plexus);
    lockSessionImages(system, "write");
    const target = join(workspace, "blocked.txt");
    const job = new FileMutateToolJob({
      toolCallId: "w1",
      name: "write_file",
      argsJson: JSON.stringify({ path: "blocked.txt", content: "x" }),
      humanApprove: true,
      orchestrationResult: true,
    });
    const documents = kernel.runtime.documents!;
    const originalFlush = documents.flush.bind(documents);
    const gated = observable.box(false);
    vi.spyOn(documents, "flush").mockImplementation(async (flushKey, checkpoint, options) => {
      try {
        return await originalFlush(flushKey, checkpoint, options);
      } finally {
        if (job.startedAtMs != null) runInAction(() => gated.set(true));
      }
    });
    session.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [job],
      permissionMode: "yolo",
    });
    await when(() => gated.get() && job.completed, { timeout: TIMEOUT });
    expect({
      file: existsSync(target),
      outcome: job.receiptJson,
    }).toEqual({ file: false, outcome: JSON.stringify({ ok: false, text: "intent could not be persisted" }) });
  });

  it("covering receipt then cancel does not start BODY", async () => {
    const { workspace, kernel, project } = await openLive("cancel");
    const session = await project.session("write");
    const documents = kernel.runtime.documents!;
    const originalFlush = documents.flush.bind(documents);
    const job = new FileMutateToolJob({
      toolCallId: "w1",
      name: "write_file",
      argsJson: JSON.stringify({ path: "cancelled.txt", content: "x" }),
      humanApprove: true,
      orchestrationResult: true,
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [job],
      permissionMode: "yolo",
    });
    const gated = observable.box(false);
    vi.spyOn(documents, "flush").mockImplementation(async (flushKey, checkpoint, options) => {
      try {
        const result = await originalFlush(flushKey, checkpoint, options);
        if (job.startedAtMs != null) turn.cancelRequested = true;
        return result;
      } finally {
        if (job.startedAtMs != null) runInAction(() => gated.set(true));
      }
    });
    session.root.head = turn;
    await when(() => gated.get() && job.completed, { timeout: TIMEOUT });
    expect({
      file: existsSync(join(workspace, "cancelled.txt")),
      outcome: job.receiptJson,
    }).toEqual({ file: false, outcome: JSON.stringify({ ok: false, text: "cancelled" }) });
  });

  it("persist-fail skips web/MCP BODY and fails a completion PEW without wedging", async () => {
    const { system, kernel, project } = await openLive("gates");
    const tools = await project.session("tools");
    const completeSession = await project.session("complete");
    await kernel.flushSession(tools.plexus);
    await kernel.flushSession(completeSession.plexus);
    lockSessionImages(system, "tools");
    const search = new WebSearchToolJob({
      toolCallId: "s1",
      name: "web_search",
      argsJson: JSON.stringify({ query: "q" }),
      humanApprove: true,
      orchestrationResult: true,
      expectation: new WebSearchExpectation({ connectionId: "c", query: "q" }),
    });
    const mcp = new MCPToolJob({
      toolCallId: "m1",
      name: "mcp__x__t",
      argsJson: "{}",
      humanApprove: true,
      orchestrationResult: true,
      expectation: new McpToolExpectation({
        connectionId: "c",
        serverToolName: "t",
      }),
    });
    const toolTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [search, mcp],
      permissionMode: "yolo",
    });
    tools.root.head = toolTurn;
    await when(() => search.completed && mcp.completed && toolTurn.reducerExited, { timeout: TIMEOUT });
    const refused = JSON.stringify({ ok: false, text: "intent could not be persisted" });
    expect({ search: search.receiptJson, mcp: mcp.receiptJson }).toEqual({ search: refused, mcp: refused });

    const pew = new CompletionExpectation({ connectionId: "c" });
    const completion = new CompletionJob({ expectation: pew });
    const completeTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [completion],
    });
    completeSession.root.head = completeTurn;
    await when(() => pew.isDone && completeTurn.reducerExited, { timeout: TIMEOUT });
    expect({
      pew: pew.outcome,
      reducerExited: completeTurn.reducerExited,
      open: completeSession.root.findRunningTurn(),
    }).toEqual({ pew: "failed", reducerExited: true, open: null });
  });

  it("cold recover via openExisting applies K1 rows and keeps idle honor-off", async () => {
    const { system, kernel, project } = await openLive("cold");
    kernel.catalog.replacePack([botCall("offload")]);
    const session = await project.session("idle");
    await session.park();
    const idleRoot = kernel.sessionPlexus("idle")!.root;
    const sys = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    const need = new ContextNeedToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      toolCallId: "n1",
      name: "context_need",
      argsJson: "{}",
    });
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
      acceptedAt: 1,
      preparedInputJson: JSON.stringify({ prepared: true }),
      workerSessionId: "worker",
    });
    idleRoot.head = closedTurn(sys, need, call);
    const cancelled = await project.session("cancel");
    await cancelled.park();
    const cancelRoot = kernel.sessionPlexus("cancel")!.root;
    const leaf = new SystemToolJob({
      toolCallId: "c2",
      name: "read_file",
      argsJson: "{}",
    });
    const cancelTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
      cancelRequested: true,
    });
    cancelTurn.pushChild(leaf);
    cancelRoot.head = cancelTurn;
    const key = documentKey("sessions", "idle");
    const documents = kernel.runtime.documents!;
    const sysGate = await persistJobIntent(documents, key, sys);
    const callGate = await persistJobIntent(documents, key, call);
    const leafGate = await persistJobIntent(documents, documentKey("sessions", "cancel"), leaf);
    expect({
      sys: sysGate.ok,
      call: callGate.ok,
      leaf: leafGate.ok,
    }).toEqual({ sys: true, call: true, leaf: true });
    kernel[Symbol.dispose]();

    const restored = new KernelDaemon(system);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    restored.catalog.replacePack([botCall("offload")]);
    expect(restored.runtime.documents?.getLoaded(key)).toBeUndefined();
    const open = vi.spyOn(restored.runtime.documents!, "openExisting");
    await restored.acquireSession("idle");
    await restored.acquireSession("cancel");
    const attached = await restored.attachSession("idle");
    const cancelledAttached = await restored.attachSession("cancel");
    expect(open.mock.calls.length).toBeGreaterThan(0);
    const recoveredSys = [...(attached?.plexus.root.motionWork() ?? [])].find(
      (node): node is SystemToolJob => node instanceof SystemToolJob && !(node instanceof FileMutateToolJob),
    );
    const recoveredNeed = [...(attached?.plexus.root.motionWork() ?? [])].find(
      (node): node is ContextNeedToolJob => node instanceof ContextNeedToolJob,
    );
    const recoveredCall = [...(attached?.plexus.root.motionWork() ?? [])].find(
      (node): node is BotCallJob => node instanceof BotCallJob,
    );
    const recoveredTurn = [...(cancelledAttached?.plexus.root.motionWork() ?? [])].find(
      (node): node is SessionTurn => node instanceof SessionTurn,
    );
    const recoveredLeaf = [...(cancelledAttached?.plexus.root.motionWork() ?? [])].find(
      (node): node is SystemToolJob => node instanceof SystemToolJob,
    );
    expect({
      unknown: recoveredSys?.completed,
      outcome: JSON.parse(recoveredSys?.receiptJson ?? "null"),
      need: recoveredNeed?.completed,
      join: recoveredCall != null && joinReleased(recoveredCall, restored.catalog),
      turn: recoveredTurn?.reducerExited,
      leafCompleted: recoveredLeaf?.completed,
      leafCancelled: recoveredLeaf?.cancelled,
      honor: attached?.orchestrator.activated === true,
      live: restored.liveSession("idle"),
      eligible: restored.graphEligibleSessionIds().has("idle"),
    }).toEqual({
      unknown: true,
      outcome: {
        ok: false,
        text: "interrupted by restart; execution outcome unknown",
      },
      need: false,
      // Recovery resumes the bot call; its join waits on the re-run delivery.
      join: false,
      turn: true,
      leafCompleted: true,
      leafCancelled: true,
      honor: false,
      live: undefined,
      eligible: false,
    });
  });

  it("replacement on a hot interned replica does not treat live acceptedAt as durable", async () => {
    const { kernel, project } = await openLive("hot");
    kernel.catalog.replacePack([botCall("offload")]);
    const session = await project.session("hot");
    await session.park();
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
      acceptedAt: 1,
      preparedInputJson: JSON.stringify({ prepared: true }),
      workerSessionId: "worker",
    });
    kernel.sessionPlexus("hot")!.root.head = closedTurn(call);
    expect(kernel.runtime.documents?.getLoaded(documentKey("sessions", "hot"))).toBeDefined();
    const replaced = await project.attachEligible("hot");
    const live = [...replaced.plexus.root.motionWork()].find((node): node is BotCallJob => node instanceof BotCallJob);
    expect({
      same: replaced.plexus === kernel.sessionPlexus("hot"),
      join: live != null && joinReleased(live, kernel.catalog),
      honor: replaced.orchestrator.activated === true,
    }).toEqual({ same: true, join: false, honor: false });
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
      documents: k1.runtime.documents === k2.runtime.documents,
      marks: [s1.root.kvs.mark, s2.root.kvs.mark],
    }).toEqual({ documents: false, marks: ["left", "right"] });
  });
});
