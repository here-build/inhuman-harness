/**
 * Ask episode: leftover ⏎ must not cascade when the head blinks or the
 * last confirm has no next leaf. Unique failure is a parked draft
 * becoming `turn` / compact / steer. Leftover Esc after the cover is
 * down arms `turn/cancel`.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  CommandSpec,
  KernelPlexus,
  KernelRoot,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import { expect, test } from "vitest";

import { answerLikeDaemon } from "./answer-door.js";
import { dumpPaint } from "../__visual__/_helpers.js";
import { Tea } from "../tea.js";

type RpcCall = { method: string; params: unknown };

function localClient(): Client {
  const client = new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
  client.request = async (method, params) => {
    answerLikeDaemon(client, method, params);
    return { ok: true };
  };
  return client;
}

function askLeaf(id: string, path: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name: "edit_file",
    argsJson: JSON.stringify({ path }),
    policyResult: "ask",
  });
}

function twoAskTurn(): { turn: SessionTurn; a: SystemToolJob; b: SystemToolJob } {
  const a = askLeaf("a", "a.ts");
  const b = askLeaf("b", "b.ts");
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`edit both`,
    doneWork: [a, b],
    queue: [],
  });
  turn.pushChild(a);
  turn.pushChild(b);
  return { turn, a, b };
}

function oneAskTurn(id = "a"): { turn: SessionTurn; leaf: SystemToolJob } {
  const leaf = askLeaf(id, "a.ts");
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`edit it`,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  return { turn, leaf };
}

/** Records every RPC but the answer itself; answers show up as `humanApprove`. */
function spy(client: Client): RpcCall[] {
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    answerLikeDaemon(client, method, params);
    if (method !== "ask/answer") calls.push({ method, params });
    return { ok: true };
  };
  return calls;
}

function press(tea: Tea, ...keys: Array<string | { key: string; ctrl?: boolean; shift?: boolean }>): void {
  tea.handle({
    kind: "input_events",
    events: keys.map((key) => (typeof key === "string" ? { key } : key)),
  });
}

function typeText(tea: Tea, text: string): void {
  press(tea, ...text);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

test("ask episode swallows leftover Enter until the hold releases", async () => {
  const twoClient = localClient();
  const twoCalls = spy(twoClient);
  const two = twoAskTurn();
  using twoTea = new Tea(twoClient, () => undefined);
  typeText(twoTea, "keep me");
  twoClient.sessionRoot.head = two.turn;
  press(twoTea, "Enter", "Enter");
  await pause();
  expect({
    a: two.a.humanApprove,
    b: two.b.humanApprove,
    draft: twoTea.draft.draft,
    calls: twoCalls,
  }).toEqual({ a: true, b: true, draft: "keep me", calls: [] });
  press(twoTea, "Enter");
  await pause();
  expect({ draft: twoTea.draft.draft, calls: twoCalls }).toEqual({ draft: "keep me", calls: [] });

  const gapClient = localClient();
  const gapCalls = spy(gapClient);
  const gap = oneAskTurn("a");
  using gapTea = new Tea(gapClient, () => undefined);
  typeText(gapTea, "keep me");
  gapClient.sessionRoot.head = gap.turn;
  press(gapTea, "Enter", "Enter");
  await pause();
  expect({
    humanApprove: gap.leaf.humanApprove,
    draft: gapTea.draft.draft,
    calls: gapCalls,
  }).toEqual({ humanApprove: true, draft: "keep me", calls: [] });

  const slashClient = localClient();
  const slashCalls = spy(slashClient);
  const slash = oneAskTurn();
  using slashTea = new Tea(slashClient, () => undefined);
  typeText(slashTea, "/compact");
  slashClient.sessionRoot.head = slash.turn;
  press(slashTea, "Enter", "Enter");
  await pause();
  expect({
    humanApprove: slash.leaf.humanApprove,
    draft: slashTea.draft.draft,
    calls: slashCalls,
  }).toEqual({ humanApprove: true, draft: "/compact", calls: [] });

  const steerClient = localClient();
  const steerAsk = oneAskTurn();
  steerClient.sessionRoot.head = steerAsk.turn;
  admitQueue(steerClient.sessionRoot, prompt.user`later`, steerAsk.turn.uuid);
  using steerTea = new Tea(steerClient, () => undefined);
  press(steerTea, "Enter", "Enter");
  expect({
    humanApprove: steerAsk.leaf.humanApprove,
    steer: steerClient.sessionRoot.steerQueue.map((row) => row.text),
    queue: steerClient.sessionRoot.promptQueue.map((row) => row.text),
  }).toEqual({ humanApprove: true, steer: [], queue: ["later"] });

  const yoloClient = localClient();
  const yoloCalls = spy(yoloClient);
  const yoloRequest = yoloClient.request.bind(yoloClient);
  yoloClient.request = async (method, params) => {
    answerLikeDaemon(yoloClient, method, params);
    // Stand in for the daemon: policy/set is the only writer of the mode.
    if (method === "policy/set") yoloClient.sessionRoot.permissionMode = (params as { policy: "yolo" }).policy;
    return yoloRequest(method, params);
  };
  const yolo = oneAskTurn();
  using yoloTea = new Tea(yoloClient, () => undefined);
  typeText(yoloTea, "keep me");
  yoloClient.sessionRoot.head = yolo.turn;
  press(yoloTea, { key: "Tab", shift: true }, { key: "Tab", shift: true }, "Enter");
  await pause();
  expect({
    policy: yoloClient.sessionRoot.permissionMode,
    humanApprove: yolo.leaf.humanApprove,
    draft: yoloTea.draft.draft,
    calls: yoloCalls,
  }).toEqual({
    policy: "yolo",
    humanApprove: null,
    draft: "keep me",
    calls: [
      { method: "policy/set", params: { policy: "auto" } },
      { method: "policy/set", params: { policy: "yolo" } },
    ],
  });

  const releaseClient = localClient();
  const releaseCalls = spy(releaseClient);
  const release = oneAskTurn();
  using releaseTea = new Tea(releaseClient, () => undefined);
  typeText(releaseTea, "keep me");
  releaseClient.sessionRoot.head = release.turn;
  press(releaseTea, "Enter", "x", "Enter");
  await pause();
  expect({
    humanApprove: release.leaf.humanApprove,
    draft: releaseTea.draft.draft,
    calls: releaseCalls,
  }).toEqual({
    humanApprove: true,
    draft: "",
    calls: [{ method: "turn", params: { prompt: "keep mex", kind: "queue" } }],
  });
});

test("gap then second ask: episode does not re-throttle a nonempty draft", () => {
  let now = 1_000;
  const client = localClient();
  client.kernelRoot.approvalAskThrottleMs = 2_000;
  const first = oneAskTurn("a");
  using tea = new Tea(client, () => undefined, { now: () => now });
  typeText(tea, "keep me");
  client.sessionRoot.head = first.turn;
  now = 4_000;
  press(tea, "Enter");
  const second = askLeaf("b", "b.ts");
  first.turn.doneWork = [...first.turn.doneWork, second];
  first.turn.pushChild(second);
  press(tea, "Enter");
  expect({
    a: first.leaf.humanApprove,
    b: second.humanApprove,
    draft: tea.draft.draft,
  }).toEqual({
    a: true,
    b: true,
    draft: "keep me",
  });
});

test("last deny then Esc does not retract a sitting queue", () => {
  const client = localClient();
  const { turn, leaf } = oneAskTurn();
  client.sessionRoot.head = turn;
  admitQueue(client.sessionRoot, prompt.user`later`, turn.uuid);
  using tea = new Tea(client, () => undefined);
  press(tea, "Escape");
  press(tea, "Escape");
  expect({
    humanApprove: leaf.humanApprove,
    queue: client.sessionRoot.promptQueue.map((row) => row.text),
    draft: tea.draft.draft,
  }).toEqual({
    humanApprove: false,
    queue: ["later"],
    draft: "",
  });
});

test("after last allow, empty leftover Esc arms then cancels the turn", async () => {
  const client = localClient();
  const calls = spy(client);
  const { turn, leaf } = oneAskTurn();
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  press(tea, "Enter");
  expect({ humanApprove: leaf.humanApprove, calls: [...calls] }).toEqual({ humanApprove: true, calls: [] });
  press(tea, "Escape");
  expect(calls).toEqual([]);
  press(tea, "Escape");
  await pause();
  expect(calls).toEqual([{ method: "turn/cancel", params: { turnId: turn.uuid } }]);
});

test("overlay Esc then Enter in one batch does not accept; park restores the slash draft", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    answerLikeDaemon(client, method, params);
    calls.push({ method, params });
    if (method === "connect/drop") {
      return { form: "ui", pending: "p1", body: '(harness/confirm :title "Remove work?")' };
    }
    return { ok: true };
  };
  client.kernelRoot.commands = {
    go: new CommandSpec({
      verb: "go",
      body: `(harness/choice :choices (list
               (harness/choice :name "row"
                 :action (list (harness/action 'connect/drop :params (dict :id "work"))))))`,
    }),
  };
  using tea = new Tea(client, () => undefined);
  typeText(tea, "/go");
  const deadline = Date.now() + 5_000;
  while (!dumpPaint(tea).composer.picker.rows.some((row) => row.name === "row")) {
    if (Date.now() > deadline) throw new Error("picker");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  press(tea, "Enter");
  while (!calls.some((call) => call.method === "connect/drop")) {
    if (Date.now() > deadline) throw new Error(`park ${JSON.stringify(calls)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await pause();
  press(tea, "Escape", "Enter");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect({ calls, draft: tea.draft.draft }).toEqual({
    calls: [
      { method: "connect/drop", params: { id: "work" } },
      { method: "ui/resolve", params: { pending: "p1", kind: "cancel" } },
    ],
    draft: "/go row",
  });
});
