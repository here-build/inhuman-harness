/**
 * Every claimed job settles: a refused gate, an abort while parked on a wait,
 * and the orchestrator's own teardown. A job that never seals wedges its turn.
 */
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  AGENT_MESSAGE,
  AGENT_NOTIFY,
  AGENT_RESPOND,
  AgentCallbackJob,
  AgentMessageJob,
  AgentNotifyJob,
  CompletionExpectation,
  CompletionJob,
  SessionAdmission,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  type ToolCallJob,
} from "@inhuman.tools/harness-model";
import { SessionRuntime } from "@inhuman.tools/turn/runtime";
import { mkdtemp } from "fs-extra";
import { runInAction, when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";

import { scopes } from "@/policy-processor/scope";
import { behaviorEntriesOf, bindBehaviorEntries } from "@/tool-catalog";

import { attachScriptedModel, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 4_000;

async function openSession(): Promise<{ kernel: KernelDaemon; session: SessionDaemon }> {
  const system = await mkdtemp(join(tmpdir(), "harness-settle-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-settle-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, session };
}

function closedTurn(...children: ToolCallJob[]): SessionTurn {
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
  for (const child of children) turn.pushChild(child);
  return turn;
}

function failIntentPersist(kernel: KernelDaemon): void {
  vi.spyOn(kernel.runtime.documents!, "flush").mockResolvedValue({ ok: false, reason: "storage-failed" });
}

describe("orchestrator settlement", () => {
  beforeEach(() => resetLocalIDs());

  it("a tool whose intent cannot be persisted completes with a failure", async () => {
    const { kernel, session } = await openSession();
    failIntentPersist(kernel);
    const job = new SystemToolJob({ toolCallId: "t1", name: "job_stop", argsJson: "{}" });
    session.root.head = closedTurn(job);
    await when(() => job.completed, { timeout: TIMEOUT });
    expect(JSON.parse(job.receiptJson ?? "null")).toEqual({ ok: false, text: "intent could not be persisted" });
  });

  it("agent callback, notify, and message pass the intent gate before their body", async () => {
    const { kernel, session } = await openSession();
    failIntentPersist(kernel);
    const args = JSON.stringify({ requestId: "r1", response: "x", message: "hi", targetId: "nope" });
    const jobs = [
      new AgentCallbackJob({ toolCallId: "c1", name: AGENT_RESPOND, argsJson: args }),
      new AgentNotifyJob({ toolCallId: "n1", name: AGENT_NOTIFY, argsJson: args }),
      new AgentMessageJob({ toolCallId: "m1", name: AGENT_MESSAGE, argsJson: args }),
    ];
    session.root.head = closedTurn(...jobs);
    await when(() => jobs.every((job) => job.completed), { timeout: TIMEOUT });
    expect(jobs.map((job) => JSON.parse(job.receiptJson ?? "null"))).toEqual(
      jobs.map(() => ({ ok: false, text: "intent could not be persisted" })),
    );
  });

  it("a turn waiting on eval admission ends when it is cancelled", async () => {
    const { session } = await openSession();
    runInAction(() => session.evalAdmissionHeld.set(true));
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`p` });
    session.root.head = turn;
    await when(() => turn.startedAtMs != null, { timeout: TIMEOUT });
    session.orchestrator.cancelOwned(turn);
    await when(() => turn.completed && turn.reducerExited, { timeout: TIMEOUT });
    expect(turn.cancelled).toBe(true);
  });

  it("a completion round releases its hold on the caller's signal when it settles", async () => {
    const { session } = await openSession();
    const turn = new AbortController();
    for (let round = 0; round < 3; round += 1) {
      const next = new CompletionExpectation({ connectionId: "nope" });
      await session.orchestrator
        .complete({ connectionId: "nope", model: "m", round: next, signal: turn.signal })
        .catch(() => undefined);
    }
    expect(getEventListeners(turn.signal, "abort")).toHaveLength(0);
  });

  it("park releases the wrap's plugin behavior", async () => {
    const { session } = await openSession();
    bindBehaviorEntries(session.root, [
      {
        wireName: "plugin_tool",
        description: "declared by a plugin",
        parameters: { type: "object", properties: {} },
        class: "read",
        source: { kind: "pack", pluginName: "p" },
      },
    ]);
    await session.park();
    expect(behaviorEntriesOf(session.root)).toEqual([]);
  });

  it("a replaced wrap does not claim an isolated completion added by the new owner", async () => {
    const { session } = await openSession();
    const turn = closedTurn();
    session.root.head = turn;
    const replacement = new SessionRuntime(session.plexus, { kind: "memory" });
    onTestFinished(() => replacement[Symbol.asyncDispose]());
    const completion = new CompletionJob({
      expectation: new CompletionExpectation({ connectionId: "missing", completionMode: "isolated" }),
    });
    turn.pushChild(completion);
    const before = Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({
      orchestrated: completion.orchestrated,
      done: completion.expectation.isDone,
      state: Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64"),
    }).toEqual({ orchestrated: false, done: false, state: before });
  });

  it("a parked runtime preserves the completion port for work retained by its current wrap", async () => {
    const { kernel, session } = await openSession();
    attachScriptedModel(kernel, session);
    const round = new CompletionExpectation({ connectionId: scriptedConnectionId(), completionMode: "isolated" });
    const turn = closedTurn();
    turn.pushChild(new CompletionJob({ expectation: round }));
    session.root.head = turn;
    session.sessionRuntime.park();
    await session.orchestrator.complete({ connectionId: scriptedConnectionId(), model: "supplied", round });
    expect({
      binding: session.sessionRuntime.isCurrent,
      parked: session.sessionRuntime.signal.aborted,
      ownerAborted: session.sessionRuntime.ownershipSignal.aborted,
      outcome: round.outcome,
    }).toEqual({ binding: true, parked: true, ownerAborted: false, outcome: "successful" });
  });

  it("replacement aborts a pending policy check and old cleanup preserves the new scope", async () => {
    const { session } = await openSession();
    const scope = scopes.get(session.root);
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof scope.checkShell>>>();
    let checkSignal: AbortSignal | undefined;
    scope.checkShell = (_command, options) => {
      checkSignal = options.signal;
      entered.resolve();
      return pending.promise;
    };
    const job = new SystemToolJob({
      toolCallId: "pending-policy",
      name: "shell",
      argsJson: JSON.stringify({ command: "ls" }),
    });
    session.root.head = closedTurn(job);
    await entered.promise;
    const replacement = new SessionRuntime(session.plexus, { kind: "memory" });
    onTestFinished(() => replacement[Symbol.asyncDispose]());
    const nextScope = scopes.get(session.root);
    onTestFinished(() => nextScope.close());
    const before = Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64");
    pending.resolve({ action: "allow", findings: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    session.orchestrator[Symbol.dispose]();
    expect({
      closed: scope.closed,
      aborted: checkSignal?.aborted,
      policy: job.policyResult,
      currentScope: scopes.get(session.root) === nextScope,
      nextClosed: nextScope.closed,
      state: Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64"),
    }).toEqual({ closed: true, aborted: true, policy: null, currentScope: true, nextClosed: false, state: before });
  });

  it("a turn that became unreachable before it ran closes as completed", async () => {
    const { session } = await openSession();
    runInAction(() => session.evalAdmissionHeld.set(true));
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`p` });
    session.root.head = turn;
    await when(() => turn.startedAtMs != null, { timeout: TIMEOUT });
    session.root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
    expect(turn.completed).toBe(true);
  });

  it("a steer still sitting when its turn is cancelled moves to the queue lane and runs after the turn", async () => {
    const { session } = await openSession();
    runInAction(() => session.evalAdmissionHeld.set(true));
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`p` });
    session.root.head = turn;
    await when(() => turn.startedAtMs != null, { timeout: TIMEOUT });
    session.root.steerQueue.push(new SessionAdmission({ text: prompt.user`also this`, composedAtMs: 1 }));
    session.orchestrator.cancelOwned(turn);
    await when(() => turn.completed, { timeout: TIMEOUT });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({
      head: session.root.head === turn,
      prompts: session.root.promptQueue.length,
      steers: session.root.steerQueue.length,
    }).toEqual({ head: true, prompts: 1, steers: 0 });
  });
});
