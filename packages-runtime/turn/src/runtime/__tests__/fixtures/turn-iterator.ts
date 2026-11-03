import invariant from "tiny-invariant";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionJob,
  METADATA_SAME_ROUND_NOTE,
  writePluginMeta,
  RegisteredToolsSet,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  type CompletionExpectation,
} from "@inhuman.tools/harness-model/session";
import { contextNeedAdmitSchema } from "@inhuman.tools/harness-model/schemas";
import { onTestFinished, vi } from "vitest";

import { bindSessionCatalog, KernelToolCatalog } from "../../../tool-catalog/catalog.js";
import { NoteLog } from "./notes.js";
import { iterateTurn, type TurnIteratorHost } from "../../turn-iterator.js";
import type { TurnResolvers } from "../../turn-resolvers.js";

export type ModelReply = (completion: CompletionExpectation) => void | Promise<void>;

/** Real document nodes and rules, mock work resolution. No daemon, disk, or polling. */
export function turnFixture(...replies: ModelReply[]) {
  const document = SessionPlexus.create("iterator-test", "/tmp/iterator-test");
  const catalog = new KernelToolCatalog();
  catalog.replacePack(["update_metadata", "context_need"].map((name) => ({
    wireName: name,
    description: name,
    parameters: {},
    source: { kind: "pack", pluginName: "metadata" } as const,
    class: "meta",
    isSideChannel: true,
    continuation: { kind: "auxiliary", note: METADATA_SAME_ROUND_NOTE },
  })));
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
      invariant(reply != null, "Unexpected model round");
      await reply(job.expectation);
      if (!job.expectation.isDone) job.expectation.succeed("settled", "mock", "null");
    }),
    work: vi.fn<TurnResolvers["work"]>(async (job) => {
      job.outcomeSnap = { ok: true, text: "tool result" };
      if (job instanceof SystemToolJob && job.name === "context_need") {
        const parsed = contextNeedAdmitSchema.safeParse(job.args);
        if (parsed.success) writePluginMeta(job, "metadata", { type: "context-need", need: parsed.data });
      }
      job.markComplete();
      return "settled";
    }),
    compact: vi.fn<TurnResolvers["compact"]>(async (job) => {
      job.markComplete();
    }),
  } satisfies TurnResolvers;
  const host = {
    session,
    resolvers,
    notes: new NoteLog(),
    compactKeepTurns: 1,
    hardCompactTrigger: "95%",
    admit: vi.fn<TurnIteratorHost["admit"]>((call) => {
      const entry = catalog.catalogEntry(call.function.name);
      const policy = entry?.continuation ?? { kind: entry?.triggersReactLoop === false ? "none" : "observation" };
      return new SystemToolJob({
        toolCallId: call.id,
        name: call.function.name,
        argsJson: call.function.arguments,
        continuationJson: JSON.stringify(policy),
        triggersReactLoop: policy.kind === "observation",
        tapeHidden: catalog.catalogEntry(call.function.name)?.isSideChannel === true,
        isSideChannel: catalog.catalogEntry(call.function.name)?.isSideChannel === true,
      });
    }),
    waitInbound: vi.fn<TurnIteratorHost["waitInbound"]>(async () => true),
    openRound: vi.fn<TurnIteratorHost["openRound"]>(async () => true),
    closeRound: vi.fn<TurnIteratorHost["closeRound"]>(async () => {}),
    classifyIntent: vi.fn<TurnIteratorHost["classifyIntent"]>(async () => ({
      verdict: "seal",
      status: "judged",
      detail: "",
    })),
    startAmbientCompact: vi.fn<TurnIteratorHost["startAmbientCompact"]>(),
  } satisfies TurnIteratorHost;
  return {
    session,
    turn,
    host,
    resolvers,
    abort,
    run: () => iterateTurn(turn, host, abort.signal),
    completions: () => turn.doneWork.filter((cell): cell is CompletionJob => cell instanceof CompletionJob),
  };
}
