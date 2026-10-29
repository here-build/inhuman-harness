import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionJob,
  ContextNeedToolJob,
  RegisteredToolsSet,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  type CompletionExpectation,
} from "@inhuman.tools/harness-model";
import { onTestFinished, vi } from "vitest";

import { NoteLog } from "@/extensions";
import { bindSessionCatalog } from "@/tool-catalog";

import { iterateTurn, type TurnIteratorHost } from "../../turn-iterator.js";
import { KernelToolCatalog } from "../../../../toolkit/tool-table.js";
import type { TurnResolvers } from "../../turn-resolvers.js";

export type ModelReply = (completion: CompletionExpectation) => void | Promise<void>;

/** Real document nodes and rules, mock work resolution. No daemon, disk, or polling. */
export function turnFixture(...replies: ModelReply[]) {
  const document = SessionPlexus.create("iterator-test", "/tmp/iterator-test");
  const catalog = new KernelToolCatalog();
  onTestFinished(() => {
    catalog[Symbol.dispose]();
    document.destroy();
  });
  const session = document.root;
  bindSessionCatalog(session, catalog);
  session.kvs.connection = "mock";
  session.kvs.model = "mock-model";
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`do the work`,
    toolsDefinition: new RegisteredToolsSet(),
  });
  session.head = turn;
  const abort = new AbortController();
  const resolvers = {
    completion: vi.fn<TurnResolvers["completion"]>(async (job) => {
      const reply = replies.shift();
      if (reply == null) throw new Error("Unexpected model round");
      await reply(job.expectation);
      if (!job.expectation.isDone) job.expectation.succeed("settled", "mock", "null");
    }),
    work: vi.fn<TurnResolvers["work"]>(async (job) => {
      job.outcomeSnap = { ok: true, text: "tool result" };
      job.markComplete();
      return "settled";
    }),
    compact: vi.fn<TurnResolvers["compact"]>(async (job) => { job.markComplete(); }),
  } satisfies TurnResolvers;
  const host = {
    session,
    resolvers,
    notes: new NoteLog(),
    compactKeepTurns: 1,
    hardCompactTrigger: "95%",
    admit: vi.fn<TurnIteratorHost["admit"]>((call) => {
      const JobType = call.function.name === "context_need" ? ContextNeedToolJob : SystemToolJob;
      return new JobType({ toolCallId: call.id, name: call.function.name, argsJson: call.function.arguments, triggersReactLoop: !["update_metadata", "context_need"].includes(call.function.name), tapeHidden: ["update_metadata", "context_need"].includes(call.function.name) });
    }),
    waitInbound: vi.fn<TurnIteratorHost["waitInbound"]>(async () => true),
    openRound: vi.fn<TurnIteratorHost["openRound"]>(async () => true),
    closeRound: vi.fn<TurnIteratorHost["closeRound"]>(async () => {}),
    classifyIntent: vi.fn<TurnIteratorHost["classifyIntent"]>(async () => "seal"),
    startAmbientCompact: vi.fn<TurnIteratorHost["startAmbientCompact"]>(),
  } satisfies TurnIteratorHost;
  return {
    session, turn, host, resolvers, abort,
    run: () => iterateTurn(turn, host, abort.signal),
    completions: () => turn.doneWork.filter((cell): cell is CompletionJob => cell instanceof CompletionJob),
  };
}
