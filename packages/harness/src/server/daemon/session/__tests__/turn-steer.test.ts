/**
 * Steer claim at Prompt/ReACT; 0-tool miss-window extends; compact bounce
 * and cancel demote; park does neither; promptQueue drain + slash at dequeue.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  admitSteer,
  CompletionExpectation,
  reactChunks,
  ReACTChunk,
  tapeCompletion,
  SessionSystemPrompt,
  SessionTurn,
  CompactJob,
  TurnSteerChunk,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { steerMessagesOf } from "@/providers/openai-compat";

import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 2_000;

function completionsOf(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

function steersOf(turn: SessionTurn): TurnSteerChunk[] {
  return reactChunks(turn).filter((chunk): chunk is TurnSteerChunk => chunk instanceof TurnSteerChunk);
}

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-steer-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-steer-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  return session;
}

describe("Steer / promptQueue", () => {
  beforeEach(() => resetLocalIDs());

  it("0-tool extends; compact bounce and cancel demote; promptQueue drain /compact is compact turn", async () => {
    const session = await openSession();
    const root = session.root;

    const live = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hello` });
    root.head = live;
    await when(() => completionsOf(live).length === 1, { timeout: TIMEOUT });
    admitSteer(root, prompt.user`also do this`, live.uuid);
    modelOf(session).reply({ text: "hi" });
    await when(() => completionsOf(live).length === 2, { timeout: TIMEOUT });
    const second = completionsOf(live)[1]!;
    const cells = steersOf(live);
    const extend = {
      react: reactChunks(live).some((chunk) => chunk instanceof ReACTChunk),
      reducerExited: live.reducerExited,
      steerQueue: root.steerQueue.map((row) => row.text),
      texts: cells.map((cell) => cell.steerText()),
      messages: second.messages.filter((cell) => cell instanceof TurnSteerChunk).map((cell) => cell.steerText()),
      wire: steerMessagesOf(second),
    };
    modelOf(session).reply({ text: "done" });
    await when(() => live.reducerExited, { timeout: TIMEOUT });

    const compactTurn = new SessionTurn({
      turnTail: live,
      prompt: prompt.user`keep`,
      queue: [new CompactJob()],
      reloadTools: true,
    });
    admitSteer(root, prompt.user`not on compact`, "");
    root.head = compactTurn;
    await when(() => compactTurn.reducerExited, { timeout: TIMEOUT });
    const compactBounce = {
      claimed: steersOf(compactTurn),
      leftoverSteer: root.steerQueue.map((row) => row.text),
    };
    await when(() => root.head instanceof SessionTurn && root.head !== compactTurn && !root.head.reducerExited, {
      timeout: TIMEOUT,
    });
    // Do not return the turn from `then`: Job is thenable, so the promise would settle to its result.
    const afterCompact = root.head;
    if (!(afterCompact instanceof SessionTurn)) throw new Error("expected an open turn");
    const compactDemoted = afterCompact.prompt;
    await when(() => completionsOf(afterCompact).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "ok" });
    await when(() => afterCompact.reducerExited, { timeout: TIMEOUT });

    const cancellable = new SessionTurn({ turnTail: afterCompact, prompt: prompt.user`run` });
    root.head = cancellable;
    await when(() => completionsOf(cancellable).length === 1, { timeout: TIMEOUT });
    admitSteer(root, prompt.user`after stop`, cancellable.uuid);
    await session.handleRequest("turn/cancel", { turnId: cancellable.uuid });
    await when(() => cancellable.reducerExited, { timeout: TIMEOUT });
    // The steer was demoted to the queue lane, and the queue drain mints it as the next turn.
    await when(() => root.head !== cancellable, { timeout: TIMEOUT });
    const cancelDrop = {
      next: root.head instanceof SessionTurn ? String(root.head.prompt) : null,
      cancelled: cancellable.cancelRequested,
      steers: root.steerQueue.map((row) => row.text),
      prompts: root.promptQueue.map((row) => row.text),
      head: root.head === cancellable,
    };

    const drainFirst = new SessionTurn({ turnTail: cancellable, prompt: prompt.user`hello` });
    root.head = drainFirst;
    await when(() => completionsOf(drainFirst).length === 1, { timeout: TIMEOUT });
    admitQueue(root, prompt.user`/unknown`, drainFirst.uuid);
    admitQueue(root, prompt.user`/compact keep`, drainFirst.uuid);
    admitQueue(root, prompt.user`/Users/foo/bar read this`, drainFirst.uuid);
    modelOf(session).reply({ text: "hi" });
    await when(() => drainFirst.reducerExited, { timeout: TIMEOUT });
    await when(() => root.head instanceof SessionTurn && root.head !== drainFirst && !root.head.reducerExited, {
      timeout: TIMEOUT,
    });
    const compactHead = root.head;
    if (!(compactHead instanceof SessionTurn)) throw new Error("expected an open turn");
    const drainCompact = {
      compact: reactChunks(compactHead).some((chunk) => chunk instanceof CompactJob),
      reload: compactHead.reloadTools,
      leftover: root.promptQueue.map((row) => row.text),
    };
    await when(() => compactHead.reducerExited, { timeout: TIMEOUT });
    await when(() => root.head instanceof SessionTurn && root.head !== compactHead && !root.head.reducerExited, {
      timeout: TIMEOUT,
    });
    const pathHead = root.head;
    if (!(pathHead instanceof SessionTurn)) throw new Error("expected an open turn");
    const drainPath = pathHead.prompt;
    await when(() => completionsOf(pathHead).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "ok" });
    await when(() => pathHead.reducerExited, { timeout: TIMEOUT });
    const drainEmpty = root.promptQueue;

    const parked = new SessionTurn({ turnTail: pathHead, prompt: prompt.user`park me` });
    root.head = parked;
    await when(() => completionsOf(parked).length === 1, { timeout: TIMEOUT });
    admitSteer(root, prompt.user`survive park`, parked.uuid);
    void session.park();
    const park = {
      reducerExited: parked.reducerExited,
      steer: root.steerQueue.map((row) => row.text),
      prompt: root.promptQueue.map((row) => row.text),
    };

    expect({ extend, compactBounce, compactDemoted, cancelDrop, drainCompact, drainPath, drainEmpty, park }).toEqual({
      extend: {
        react: true,
        reducerExited: false,
        steerQueue: [],
        texts: ["also do this"],
        messages: ["also do this"],
        wire: [{ role: "user", content: "also do this" }],
      },
      compactBounce: { claimed: [], leftoverSteer: [] },
      compactDemoted: "not on compact",
      cancelDrop: { next: "after stop", cancelled: true, steers: [], prompts: [], head: false },
      drainCompact: { compact: true, reload: true, leftover: ["/Users/foo/bar read this"] },
      drainPath: "/Users/foo/bar read this",
      drainEmpty: [],
      park: { reducerExited: false, steer: ["survive park"], prompt: [] },
    });
  }, 30_000);
});
