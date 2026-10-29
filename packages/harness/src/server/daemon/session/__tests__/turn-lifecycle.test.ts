/**
 * Turn lifecycle: a prompt sent after Stop runs, park pauses the round it
 * interrupts and the resumed turn opens a fresh one, and a hung plugin hook
 * does not hold a turn open.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  reactChunks,
  SessionSystemPrompt,
  SessionTurn,
  tapeCompletion,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 4_000;

function completionsOf(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

async function openSession(): Promise<{ session: SessionDaemon; project: ProjectDaemon }> {
  const system = await mkdtemp(join(tmpdir(), "harness-life-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-life-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  onTestFinished(() => {
    void session.park();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  return { session, project };
}

describe("Turn lifecycle", () => {
  beforeEach(() => resetLocalIDs());

  it("a prompt sent right after Stop runs as the next turn instead of vanishing", async () => {
    const { session } = await openSession();
    const root = session.root;
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`first` });
    root.head = turn;
    await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
    session.orchestrator.cancelOwned(turn);
    // The executor is still unwinding: the turn is running but cannot take a steer.
    const reply = await session.handleRequest("turn", { prompt: "after stop" });
    expect(reply).toMatchObject({ ok: true });
    // Not a steer nobody will claim: a row of the queue lane, minted once the turn exits.
    expect({
      steers: root.steerQueue.length,
      wasQueued: root.promptQueue.length + (root.head === turn ? 0 : 1),
    }).toEqual({
      steers: 0,
      wasQueued: 1,
    });
    await when(() => root.head instanceof SessionTurn && root.head !== turn, { timeout: TIMEOUT });
    const next = root.head;
    if (!(next instanceof SessionTurn)) throw new Error("expected the next turn");
    expect({ prompt: String(next.prompt), queued: root.promptQueue.length, steers: root.steerQueue.length }).toEqual({
      prompt: "after stop",
      queued: 0,
      steers: 0,
    });
    await when(() => completionsOf(next).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    await when(() => next.reducerExited, { timeout: TIMEOUT });
    expect(completionsOf(next)[0]?.responseText).toBe("done");
  });

  it("a steer on a live turn is still a steer", async () => {
    const { session } = await openSession();
    const root = session.root;
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`first` });
    root.head = turn;
    await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
    await session.handleRequest("turn", { prompt: "also this" });
    expect({ steers: root.steerQueue.length, queued: root.promptQueue.length }).toEqual({ steers: 1, queued: 0 });
  });

  it("a turn that ended in a failed round says why on the turn", async () => {
    const { session } = await openSession();
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`first` });
    session.root.head = turn;
    await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ fail: "provider exploded" });
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
    expect(turn.broke).toContain("provider exploded");
  });

  it("park pauses the round in flight, and the resumed turn opens a fresh one", async () => {
    const { session, project } = await openSession();
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`first` });
    session.root.head = turn;
    await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
    const interrupted = completionsOf(turn)[0]!;
    await session.park();
    // Park writes no ending on the round.
    expect({ outcome: interrupted.outcome, cancelRequested: turn.cancelRequested, exited: turn.reducerExited }).toEqual(
      {
        outcome: null,
        cancelRequested: false,
        exited: false,
      },
    );

    const again = await project.session("s1");
    onTestFinished(() => void again.park());
    modelOf(session).reply({ text: "resumed" });
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
    const rounds = completionsOf(turn);
    expect({
      rounds: rounds.length,
      last: rounds.at(-1)?.responseText,
      lastOutcome: rounds.at(-1)?.outcome,
      broke: turn.broke,
    }).toEqual({ rounds: 2, last: "resumed", lastOutcome: "successful", broke: "" });
  });
});
