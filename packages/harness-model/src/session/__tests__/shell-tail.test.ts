/**
 * Two live shells share one awareness lane. A lane per job uuid exhausts
 * the 64-cap and crashes the daemon on the 65th announce.
 */
import { SHELL_TAILS_LANE } from "@inhuman.tools/expectations";
import { prompt } from "@inhuman.tools/harness-commons";
import { reaction } from "mobx";
import { expect, it, onTestFinished } from "vitest";

import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { SessionDocument } from "../SessionDocument.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { reportShellTail, retractShellTail, shellTailOf } from "../shell-tail.js";
import { SessionTurn } from "../turn/session-turn.js";

function mount(doc: SessionDocument, ...jobs: SystemToolJob[]): void {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: jobs,
    queue: [],
  });
  for (const job of jobs) turn.pushChild(job);
  doc.root.head = turn;
}

it("two shells share shell-tails; retract drops one uuid", () => {
  const doc = SessionDocument.create("shell-tails");
  onTestFinished(() => doc.destroy());
  const a = new SystemToolJob({ toolCallId: "a", name: "shell", argsJson: "{}" });
  const b = new SystemToolJob({ toolCallId: "b", name: "shell", argsJson: "{}" });
  mount(doc, a, b);
  reportShellTail(a, { text: "A", totalBytes: 1 });
  reportShellTail(b, { text: "B", totalBytes: 2 });
  retractShellTail(a);
  expect({
    schema: doc.awareness.getSchema(),
    a: shellTailOf(a),
    b: shellTailOf(b),
    bag: doc.awareness.getField(SHELL_TAILS_LANE),
  }).toEqual({
    schema: [SHELL_TAILS_LANE],
    a: null,
    b: { text: "B", totalBytes: 2 },
    bag: { [b.uuid]: { text: "B", totalBytes: 2 } },
  });
});

it("a homed tail is MobX-observable through the awareness lane", () => {
  const doc = SessionDocument.create("shell-tail-live");
  onTestFinished(() => doc.destroy());
  const job = new SystemToolJob({ toolCallId: "u", name: "shell", argsJson: "{}" });
  mount(doc, job);
  const seen: Array<string | null> = [];
  const stop = reaction(
    () => shellTailOf(job)?.text ?? null,
    (text) => {
      seen.push(text);
    },
    { fireImmediately: true },
  );
  reportShellTail(job, { text: "out", totalBytes: 3 });
  reportShellTail(job, { text: "more", totalBytes: 4 });
  retractShellTail(job);
  stop();
  expect(seen).toEqual([null, "out", "more", null]);
});

it("a peer frame is the tail until this base reports", () => {
  const doc = SessionDocument.create("shell-tail-peer");
  onTestFinished(() => {
    doc.destroy();
  });
  const job = new SystemToolJob({ toolCallId: "u", name: "shell", argsJson: "{}" });
  mount(doc, job);
  const seen: Array<string | null> = [];
  const stop = reaction(
    () => shellTailOf(job)?.text ?? null,
    (text) => {
      seen.push(text);
    },
    { fireImmediately: true },
  );
  const peerClientId = 2;
  doc.awareness.setField(SHELL_TAILS_LANE, { [job.uuid]: { text: "peer", totalBytes: 4 } }, peerClientId);
  reportShellTail(job, { text: "local", totalBytes: 1 });
  stop();
  expect(seen).toEqual([null, "peer", "local"]);
});

it("an unhomed report is not presence", () => {
  const job = new SystemToolJob({ toolCallId: "u", name: "shell", argsJson: "{}" });
  reportShellTail(job, { text: "out", totalBytes: 3 });
  expect(shellTailOf(job)).toBeNull();
});
