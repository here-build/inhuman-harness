import "../register.js";
import { entityClasses } from "@here.build/plexus/internals";
import { asUserPrompt } from "@inhuman.tools/harness-commons";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { TextOnlyContinue } from "../../shared/ReActLoopIntentDetectedTrigger.js";
import {
  BotCallJob,
  CallDelivery,
  CompactJob,
  FileMutateToolJob,
  ProgrammaticJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
} from "../index.js";

test("session registration restores nested work before the aggregate model entry is loaded", async () => {
  expect({
    kernelLoaded: entityClasses.has("harness:kernel:root"),
    legacyRegistered: entityClasses.get("harness:text-only-continue") === TextOnlyContinue,
  }).toEqual({ kernelLoaded: false, legacyRegistered: true });

  const owner = SessionPlexus.create("registered-session");
  const file = new FileMutateToolJob({ toolCallId: "edit", name: "edit_file", priorContent: "before" });
  const program = new ProgrammaticJob({ toolCallId: "program", argsJson: '{"expr":"(edit)"}', children: [file] });
  program.modules["helper.scm"] = "(define helper 1)";
  const call = new BotCallJob({
    toolCallId: "worker",
    botName: "worker",
    delivery: new CallDelivery({ lifetime: "call" }),
  });
  call.settleResult(new SuccessfulOutcome({ valueJson: '{"retained":true}' }));
  owner.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: asUserPrompt("keep this work"),
    queue: [program, call, new CompactJob({ resourceSnapshotJson: '{"revision":"one"}' })],
  });
  const replicaDoc = new Y.Doc({ guid: owner.doc.guid });
  Y.applyUpdate(replicaDoc, Y.encodeStateAsUpdate(owner.doc));
  const replica = SessionPlexus.connect(replicaDoc);
  try {
    const turn = replica.root.head;
    if (!(turn instanceof SessionTurn)) throw new TypeError("restored head is not a turn");
    const restoredProgram = turn.queue.find((node) => node instanceof ProgrammaticJob);
    const restoredCall = turn.queue.find((node) => node instanceof BotCallJob);
    const restoredFile = restoredProgram?.toolCalls.find((node) => node instanceof FileMutateToolJob);
    expect({
      session: replica.root.sessionId,
      path: replica.root.path,
      prompt: turn.prompt,
      source: restoredProgram?.modules["helper.scm"],
      prior: restoredFile?.prior,
      lifetime: restoredCall?.delivery?.lifetime,
      result: restoredCall?.outcome instanceof SuccessfulOutcome ? restoredCall.outcome.value : null,
      resource: turn.queue.find((node) => node instanceof CompactJob)?.resourceSnapshotJson,
    }).toEqual({
      session: "registered-session",
      path: "",
      prompt: "keep this work",
      source: "(define helper 1)",
      prior: { kind: "inline", text: "before" },
      lifetime: "call",
      result: { retained: true },
      resource: '{"revision":"one"}',
    });

    const aggregate = await import("../../index.js");
    expect({
      session: aggregate.SessionPlexus === SessionPlexus,
      turn: aggregate.SessionTurn === SessionTurn,
      file: aggregate.FileMutateToolJob === FileMutateToolJob,
      call: aggregate.BotCallJob === BotCallJob,
    }).toEqual({ session: true, turn: true, file: true, call: true });
  } finally {
    replica.destroy();
    owner.destroy();
  }
});
