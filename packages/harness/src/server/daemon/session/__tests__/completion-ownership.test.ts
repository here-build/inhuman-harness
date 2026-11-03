import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import { connectAdoptOutput } from "@inhuman.tools/harness-contract";
import { CompletionExpectation, CompletionJob, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { SessionRuntime } from "@inhuman.tools/turn/runtime";
import { mkdtemp } from "fs-extra";
import { expect, it, onTestFinished } from "vitest";
import * as Y from "yjs";

import { scopes } from "@/policy-processor/scope";
import { OpenAiCompatChatActor, type RoundAnswer } from "@/providers/openai-compat/actor";
import { OpenAiCompatDriverConnection } from "@/providers/openai-compat/connection";

import { listenCompat } from "../../../testkit/compat-server.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

async function pendingCompletion(caller?: AbortSignal | "scope") {
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<RoundAnswer>();
  const finished = Promise.withResolvers<void>();
  class DeferredActor extends OpenAiCompatChatActor {
    protected override async run(): Promise<void> {
      try {
        await super.run();
      } finally {
        finished.resolve();
      }
    }

    protected override readAnswer(): Promise<RoundAnswer> {
      entered.resolve();
      return answer.promise;
    }
  }
  class DeferredConnection extends OpenAiCompatDriverConnection {
    protected override resolve(expectation: CompletionExpectation): DeferredActor {
      return new DeferredActor(expectation, this);
    }
  }
  const compat = await listenCompat({ reply: () => "delayed answer" });
  const system = await mkdtemp(join(tmpdir(), "harness-completion-owner-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-completion-owner-p-"));
  const kernel = new KernelDaemon(system);
  onTestFinished(async () => {
    answer.resolve({ content: "cleanup", reasoning: "", calls: [] });
    kernel[Symbol.dispose]();
    await compat.close();
  });
  await kernel.ready;
  const load = kernel.runtime.loadDriver.bind(kernel.runtime);
  kernel.runtime.loadDriver = (spec, purpose) =>
    spec.name === "openai-compat" ? DeferredConnection : load(spec, purpose);
  const connection = connectAdoptOutput.parse(
    await kernel.handleRequest("connect/adopt", {
      driver: "openai-compat",
      name: "Deferred",
      settings: { baseUrl: compat.baseUrl },
    }),
  );
  if (!("id" in connection)) throw new Error("completion connection was not adopted");
  const project = new ProjectDaemon(kernel, workspace);
  onTestFinished(() => project[Symbol.dispose]());
  await project.ready;
  const session = await project.session("s1");
  const signal = caller === "scope" ? scopes.get(session.root).signal : caller;
  const round = new CompletionExpectation({
    connectionId: connection.id,
    model: "m1",
    promptText: prompt.user`Keep this request`,
    completionMode: "isolated",
  });
  const job = new CompletionJob({ expectation: round });
  session.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    doneWork: [job],
    queue: [],
    reducerExited: true,
  });
  const pending = session.orchestrator
    .complete({ connectionId: connection.id, model: "m1", round, ...(signal == null ? {} : { signal }) })
    .catch((error: unknown) => error);
  await Promise.race([
    entered.promise,
    pending.then(() => {
      throw new Error("completion ended before its answer parser");
    }),
  ]);
  return { session, round, job, pending, answer, finished };
}

it.each([
  { loss: "replaced", caller: "external" },
  { loss: "disposed", caller: "external" },
  { loss: "replaced", caller: "scope" },
] as const)(
  "$loss completion ownership ($caller caller) leaves the round open until recovery, including after a late body",
  async ({ loss, caller }) => {
    const { session, round, job, pending, answer, finished } = await pendingCompletion(
      caller === "scope" ? "scope" : undefined,
    );
    const before = Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc));
    let replacement: SessionRuntime;
    if (loss === "replaced") replacement = new SessionRuntime(session.plexus, { kind: "memory" });
    else {
      await session.sessionRuntime[Symbol.asyncDispose]();
      replacement = new SessionRuntime(session.plexus, { kind: "memory" });
    }
    onTestFinished(() => replacement[Symbol.asyncDispose]());
    expect({
      done: round.isDone,
      outcome: round.outcome,
      unchanged: before.equals(Y.encodeStateAsUpdate(session.plexus.doc)),
    }).toEqual({
      done: false,
      outcome: null,
      unchanged: true,
    });
    answer.resolve({ content: "late answer", reasoning: "late thought", calls: [], finishReason: "stop" });
    await pending;
    await finished.promise;
    expect({
      done: round.isDone,
      text: round.responseText,
      unchanged: before.equals(Y.encodeStateAsUpdate(session.plexus.doc)),
    }).toEqual({
      done: false,
      text: "",
      unchanged: true,
    });
    const recovered = replacement.recover();
    expect(recovered.find((row) => row.job === job)?.action).toBe("unknown");
    expect({ outcome: round.outcome, cause: round.endCause }).toEqual({ outcome: "failed", cause: "crash" });
  },
);

it("a caller cancellation still settles the owned completion", async () => {
  const caller = new AbortController();
  const { round, pending, answer, finished } = await pendingCompletion(caller.signal);
  caller.abort(new Error("caller cancelled"));
  expect({ done: round.isDone, cause: round.endCause }).toEqual({ done: true, cause: "cancel" });
  answer.resolve({ content: "late answer", reasoning: "", calls: [] });
  await pending;
  await finished.promise;
  expect(round.responseText).toBe("");
});
