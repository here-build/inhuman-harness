import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  SessionAdmission,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { runInAction, when } from "mobx";
import { expect, onTestFinished, test, vi } from "vitest";

import { attachScriptedModel, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

test("cancel during a compact resource checkpoint stays visible before the interpreter unwinds", async () => {
  const system = await mkdtemp(join(tmpdir(), "harness-cancel-compact-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-cancel-compact-p-"));
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

  const seen: CompletionExpectation[] = [];
  const tail = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`prior`,
    queue: [],
    reducerExited: true,
    doneWork: [20, 40, 80].map((used) => {
      const round = new CompletionExpectation({ connectionId: scriptedConnectionId(), messages: [...seen] });
      seen.push(round);
      round.totalTokens = used;
      round.contextLimit = 100;
      round.responseText = "prior evidence ".repeat(100);
      round.succeed("settled", "mock", "null");
      return new CompletionJob({ expectation: round, completed: true });
    }),
  });
  const job = new CompactJob({ reason: "user" });
  const turn = new SessionTurn({ turnTail: tail, prompt: prompt.user`keep`, queue: [job] });
  turn.pushChild(job);
  const enteredFirst = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const enteredSecond = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const flushSession = kernel.flushSession.bind(kernel);
  let checkpoints = 0;
  vi.spyOn(kernel, "flushSession").mockImplementation(async (plexus, options) => {
    if (plexus === session.plexus && job.resourceSnapshotJson !== "") {
      checkpoints += 1;
      if (checkpoints === 1) {
        enteredFirst.resolve();
        await releaseFirst.promise;
      } else if (checkpoints === 2) {
        enteredSecond.resolve();
        await releaseSecond.promise;
      }
    }
    await flushSession(plexus, options);
  });
  runInAction(() => {
    session.root.head = turn;
    session.root.promptQueue.push(new SessionAdmission({ text: prompt.user`queued successor`, composedAtMs: 1 }));
  });
  await enteredFirst.promise;
  const cancelled = session.handleRequest("turn/cancel", { turnId: turn.uuid });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst.resolve();
    await enteredSecond.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({
      requested: turn.cancelRequested,
      exited: turn.reducerExited,
      head: session.root.head === turn,
      queued: session.root.promptQueue.length,
      held: session.sessionRuntime.admissionHeld,
    }).toEqual({ requested: true, exited: false, head: true, queued: 1, held: true });
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await cancelled;
  }
  await when(() => turn.reducerExited, { timeout: 4_000 });
  expect({ requested: turn.cancelRequested, cancelled: turn.cancelled, compactComplete: job.completed }).toEqual({
    requested: true,
    cancelled: true,
    compactComplete: false,
  });
});
