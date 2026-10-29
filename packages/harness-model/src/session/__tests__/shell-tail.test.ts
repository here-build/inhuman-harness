/**
 * Two live shells share one awareness lane. A lane per job uuid exhausts
 * the 64-cap and crashes the daemon on the 65th announce.
 */
import { applyAwarenessUpdate, encodeAwarenessUpdate, PlexusAwareness, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { SHELL_TAILS_LANE } from "@inhuman.tools/plexus-expectations";
import { reaction } from "mobx";
import { beforeEach, expect, it, onTestFinished } from "vitest";
import * as Y from "yjs";

import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { SessionPlexus } from "../SessionPlexus.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { reportShellTail, retractShellTail, shellTailOf } from "../shell-tail.js";
import { SessionTurn } from "../turn/session-turn.js";

beforeEach(() => resetLocalIDs());

function mount(plexus: SessionPlexus, ...jobs: SystemToolJob[]): void {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: jobs,
    queue: [],
  });
  for (const job of jobs) turn.pushChild(job);
  plexus.root.head = turn;
}

it("two shells share shell-tails; retract drops one uuid", () => {
  const plexus = SessionPlexus.create("shell-tails");
  onTestFinished(() => plexus.destroy());
  const a = new SystemToolJob({ toolCallId: "a", name: "shell", argsJson: "{}" });
  const b = new SystemToolJob({ toolCallId: "b", name: "shell", argsJson: "{}" });
  mount(plexus, a, b);
  reportShellTail(a, { text: "A", totalBytes: 1 });
  reportShellTail(b, { text: "B", totalBytes: 2 });
  retractShellTail(a);
  expect({
    schema: plexus.awareness.getSchema(),
    a: shellTailOf(a),
    b: shellTailOf(b),
    bag: plexus.awareness.getField(SHELL_TAILS_LANE),
  }).toEqual({
    schema: [SHELL_TAILS_LANE],
    a: null,
    b: { text: "B", totalBytes: 2 },
    bag: { [b.uuid]: { text: "B", totalBytes: 2 } },
  });
});

it("a homed tail is MobX-observable through the awareness lane", () => {
  const plexus = SessionPlexus.create("shell-tail-live");
  onTestFinished(() => plexus.destroy());
  const job = new SystemToolJob({ toolCallId: "u", name: "shell", argsJson: "{}" });
  mount(plexus, job);
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
  const plexus = SessionPlexus.create("shell-tail-peer");
  const doc = new Y.Doc();
  const peer = new PlexusAwareness(doc);
  onTestFinished(() => {
    peer.destroy();
    doc.destroy();
    plexus.destroy();
  });
  const job = new SystemToolJob({ toolCallId: "u", name: "shell", argsJson: "{}" });
  mount(plexus, job);
  const seen: Array<string | null> = [];
  const stop = reaction(
    () => shellTailOf(job)?.text ?? null,
    (text) => {
      seen.push(text);
    },
    { fireImmediately: true },
  );
  peer.setField(SHELL_TAILS_LANE, { [job.uuid]: { text: "peer", totalBytes: 4 } });
  applyAwarenessUpdate(plexus.awareness, encodeAwarenessUpdate(peer, [...peer.meta.keys()]), "remote");
  reportShellTail(job, { text: "local", totalBytes: 1 });
  stop();
  expect(seen).toEqual([null, "peer", "local"]);
});

it("an unhomed report is not presence", () => {
  const job = new SystemToolJob({ toolCallId: "u", name: "shell", argsJson: "{}" });
  reportShellTail(job, { text: "out", totalBytes: 3 });
  expect(shellTailOf(job)).toBeNull();
});
