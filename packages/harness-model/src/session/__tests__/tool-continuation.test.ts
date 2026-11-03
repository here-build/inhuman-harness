import { prompt } from "@inhuman.tools/harness-commons";
import { expect, it, onTestFinished } from "vitest";
import * as Y from "yjs";

import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { SessionPlexus } from "../SessionPlexus.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { jobContinuationOf } from "../tool-continuation.js";
import { SessionTurn } from "../turn/session-turn.js";

it("validates stamps and confines name/boolean compatibility to unstamped jobs", () => {
  expect([
    jobContinuationOf({}),
    jobContinuationOf({ triggersReactLoop: false }),
    jobContinuationOf({ triggersReactLoop: false, name: "context_need" }).kind,
    jobContinuationOf({ triggersReactLoop: false, name: "update_metadata", continuationJson: '{"kind":"none"}' }),
    jobContinuationOf({ triggersReactLoop: true, continuationJson: '{"kind":"auxiliary","note":"Resume"}' }),
    jobContinuationOf({ continuationJson: "not json" }),
    jobContinuationOf({ continuationJson: '{"kind":"observation","note":"invalid"}' }),
  ]).toEqual([
    { kind: "observation" },
    { kind: "none" },
    "auxiliary",
    { kind: "none" },
    { kind: "auxiliary", note: "Resume" },
    { kind: "none" },
    { kind: "none" },
  ]);
});

it("retains tool and program policies when the session is reloaded", () => {
  const session = SessionPlexus.create("continuation-stamps");
  const policy = { kind: "auxiliary", note: "Resume after reload" };
  const tool = new SystemToolJob({ name: "custom", continuationJson: JSON.stringify(policy), triggersReactLoop: true });
  const program = new ProgrammaticJob({ continuationJson: JSON.stringify({ kind: "none" }) });
  session.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`task`,
    doneWork: [tool, program],
    queue: [],
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(session.doc));
  const restored = SessionPlexus.connect(doc);
  onTestFinished(() => {
    restored.destroy();
    session.destroy();
  });
  const chunks = restored.root.head?.doneWork ?? [];
  const restoredTool = chunks.find((cell) => cell instanceof SystemToolJob);
  const restoredProgram = chunks.find((cell) => cell instanceof ProgrammaticJob);
  expect(restoredTool && jobContinuationOf(restoredTool)).toEqual(policy);
  expect(restoredProgram && jobContinuationOf(restoredProgram)).toEqual({ kind: "none" });
});

it("applies committed metadata independently of continuation mode", () => {
  const session = SessionPlexus.create("metadata-independent");
  onTestFinished(() => session.destroy());
  const tool = new SystemToolJob({
    name: "custom",
    continuationJson: '{"kind":"observation"}',
    outcomeJson: '{"ok":true}',
    pluginMeta: {
      metadata: JSON.stringify({ action: { type: "metadata-updated", title: "Committed", description: "" } }),
    },
  });
  session.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`task`,
    doneWork: [tool],
    queue: [],
  });
  expect(session.root.title).toBe("Committed");
});
