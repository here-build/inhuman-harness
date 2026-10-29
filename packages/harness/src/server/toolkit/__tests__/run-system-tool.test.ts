/** update_metadata acks a clamped title; argsJson stays the model write. */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionPlexus, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { beforeEach, expect, it, onTestFinished } from "vitest";

import { bindSessionCatalog } from "@/tool-catalog";
import { executeSystemTool } from "@/tool-runtime";

import { KernelToolCatalog } from "../tool-table.js";

beforeEach(() => resetLocalIDs());

it("update_metadata acks and clamps; argsJson stays the model write", async () => {
  const plexus = SessionPlexus.create("exec-meta", "/tmp/exec-meta");
  onTestFinished(() => plexus.destroy());
  bindSessionCatalog(plexus.root, new KernelToolCatalog());
  const title = `Fix ${"x".repeat(100)}`;
  const job = new SystemToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    toolCallId: "m1",
    name: "update_metadata",
    argsJson: JSON.stringify({
      current_turn_title: title,
      current_turn_description: "patched the handler",
    }),
  });
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  plexus.root.head.pushChild(job);
  await executeSystemTool(job, new AbortController().signal);
  const outcome = JSON.parse(job.receiptJson ?? "null") as { ok: boolean; value: { current_turn_title: string } };
  expect({
    ok: outcome.ok,
    titleLen: outcome.value.current_turn_title.length,
    args: job.args?.current_turn_title,
    session: plexus.root.title,
  }).toEqual({
    ok: true,
    titleLen: 80,
    args: title,
    session: title.slice(0, 80),
  });
});
