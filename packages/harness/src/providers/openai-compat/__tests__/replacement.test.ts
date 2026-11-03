import { asUserPrompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model/session";
import { SessionRuntime } from "@inhuman.tools/turn/runtime";
import { expect, it } from "vitest";
import * as Y from "yjs";

import { OpenAiCompatChatActor, type RoundAnswer } from "../actor.js";
import { OpenAiCompatDriverConnection } from "../connection.js";
import { listenCompat } from "./compat-server.js";

it("does not stamp a parsed answer after its runtime is replaced on the same document", async () => {
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
  let actor: DeferredActor | undefined;
  class DeferredConnection extends OpenAiCompatDriverConnection {
    protected override resolve(expectation: CompletionExpectation): DeferredActor {
      actor = new DeferredActor(expectation, this);
      return actor;
    }
  }
  const compat = await listenCompat({ reply: () => "delayed answer" });
  const connection = new DeferredConnection("model", { baseUrl: compat.baseUrl });
  const runtime = SessionRuntime.create("replacement-body", { kind: "memory" });
  let replacement: SessionRuntime | undefined;
  try {
    runtime.recover();
    runtime.activate();
    await connection.ensureBootstrapStarted();
    const round = new CompletionExpectation({
      promptText: asUserPrompt("Keep this request"),
      connectionId: "model",
      model: "m1",
    });
    runtime.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: round.promptText,
      doneWork: [new CompletionJob({ expectation: round })],
      queue: [],
    });
    const pending = connection
      .complete({ model: "m1", round, signal: runtime.signal })
      .catch((error: unknown) => error);
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("Completion ended before answer parser");
      }),
    ]);
    if (actor == null) throw new Error("completion actor did not start");
    replacement = new SessionRuntime(runtime.session, { kind: "memory" });
    replacement.recover();
    replacement.activate();
    const before = Y.encodeStateAsUpdate(runtime.session.doc);
    answer.resolve({ content: "late answer", reasoning: "late thought", calls: [], finishReason: "stop" });
    await pending;
    await finished.promise;
    expect({ text: round.responseText, state: Y.encodeStateAsUpdate(runtime.session.doc) }).toEqual({
      text: "",
      state: before,
    });
  } finally {
    answer.resolve({ content: "cleanup", reasoning: "", calls: [] });
    await runtime[Symbol.asyncDispose]();
    await replacement?.[Symbol.asyncDispose]();
    runtime.session.destroy();
    await connection[Symbol.asyncDispose]();
    await compat.close();
  }
});
