/**
 * agent__message enqueues an inbound turn on the target, like a call does,
 * but opens no callback: a message has no reply. The target is flushed.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { AGENT_MESSAGE, AgentMessageJob, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

beforeEach(() => resetLocalIDs());

it("a message lands as one inbound turn on the target, with no callback, and the target is flushed", async () => {
  const system = await mkdtemp(join(tmpdir(), "harness-message-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-message-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const caller = await project.session("caller");
  const target = await project.session("target");
  onTestFinished(() => {
    caller[Symbol.dispose]();
    target[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  const flushed = vi.spyOn(kernel, "flushSession");
  const job = new AgentMessageJob({
    toolCallId: "m1",
    name: AGENT_MESSAGE,
    argsJson: JSON.stringify({ targetId: "target", message: "hello" }),
  });
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
  turn.pushChild(job);
  caller.root.head = turn;
  await when(() => job.completed, { timeout: 4_000 });
  const inbound = target.root.findTurnByAgentRequestId(job.uuid);
  expect({
    receipt: JSON.parse(job.receiptJson ?? "null"),
    prompt: inbound?.prompt,
    inbound: inbound?.inbound,
    head: target.root.head === inbound,
    callbacks: { ...target.root.agentCallbacks },
    flushed: flushed.mock.calls.some(([plexus]) => plexus === target.plexus),
  }).toEqual({
    receipt: { ok: true },
    prompt: "message from caller: hello",
    inbound: true,
    head: true,
    callbacks: {},
    flushed: true,
  });
});
