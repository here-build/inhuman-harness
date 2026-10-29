/** The acknowledgement prompt: a `needsAcknowledgement` flag makes an allowed call wait for a person. */

import { prompt } from "@inhuman.tools/harness-commons";
import {
  KernelPlexus,
  KernelRoot,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import type { DecodedKeyEvent } from "@inhuman.tools/quickdraw/runtime";
import { expect, test } from "vitest";

import { answerLikeDaemon } from "./answer-door.js";
import { ackAnnotation, ackChoices, ackPromptModel, ackVariant } from "../ack-prompt.js";
import { askCoverShortcuts } from "../ask-shortcuts.js";
import { Tea } from "../tea.js";

type Call = { method: string; params: Record<string, unknown> };

function localClient(calls: Call[] = []): Client {
  const client = new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
  client.request = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    answerLikeDaemon(client, method, params);
    return { ok: true };
  };
  return client;
}

const FLAG = { label: "tool edit_file", why: "files leave the sandbox", layer: "user", match: { tool: "edit_file" } };

/** `policy` "policyApprove" is an allowed call (ack-only); "ask" / "deny" are combined prompts. */
function flagged(policy: "policyApprove" | "ask" | "deny", id = "c1") {
  const call = new SystemToolJob({
    toolCallId: id,
    name: "edit_file",
    argsJson: '{"path":"a.ts"}',
    policyResult: policy,
  });
  call.stampPolicy(policy, null, null, {
    classesJson: JSON.stringify(["workspace-write"]),
    votesJson: JSON.stringify([
      {
        disposition: policy === "policyApprove" ? "policyApprove" : policy,
        class: "workspace-write",
        ruleId: "write_file:.",
        path: { cluster: "write", path: "src/a.ts" },
      },
    ]),
    ack: { state: "pending", flagsJson: JSON.stringify([FLAG]), ackedBy: null },
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`edit it`,
    doneWork: [call],
    queue: [],
  });
  turn.pushChild(call);
  return { turn, call };
}

function press(tea: Tea, key: string, mods: Omit<DecodedKeyEvent, "key"> = {}): void {
  tea.handle({ kind: "input_events", events: [{ key, ...mods }] });
}

function typeText(tea: Tea, text: string): void {
  tea.handle({ kind: "input_events", events: [...text].map((key) => ({ key })) });
}

const toolSubject = { kind: "tool", name: "edit_file" };

test("the variant follows the license: allowed is ack-only, an ask or soft-deny is combined", () => {
  const v = (policyResult: "policyApprove" | "ask" | "deny" | "block" | null, baseDecision: boolean | null) =>
    ackVariant({ ackPending: true, policyResult, baseDecision });
  expect([v("policyApprove", true), v("ask", null), v("deny", null), v("block", false), v(null, null)]).toEqual([
    "ack",
    "ask+ack",
    "soft-deny+ack",
    null,
    null,
  ]);
  expect(ackVariant({ ackPending: false, policyResult: "policyApprove", baseDecision: true })).toBeNull();
});

test("remember choices are each subject at each scope with the TTL inline; bot only for a bot", () => {
  const options = [{ subject: toolSubject, label: "tool edit_file" }] as never;
  expect(ackChoices(options, { bot: false }).map((c) => c.text)).toEqual([
    "tool edit_file · this session",
    "tool edit_file · this project · 7 days",
    "tool edit_file · everywhere · 7 days",
  ]);
  expect(ackChoices(options, { bot: true }).map((c) => c.scope)).toEqual(["session", "project", "bot", "global"]);
});

test("the prompt model names the flags, quotes the why, and says why the call waits", () => {
  const model = ackPromptModel({
    variant: "ack",
    flags: [FLAG] as never,
    options: [{ subject: toolSubject, label: "tool edit_file" }] as never,
    bot: false,
  });
  expect(model.header).toBe("✉ Acknowledge · tool edit_file");
  expect(ackAnnotation(model)).toBe(
    '✉ Acknowledge · tool edit_file · "files leave the sandbox" · Allowed by policy; you asked to confirm this first.',
  );
});

test("ack-only chords: Enter acknowledges, Esc refuses, remember cycles; a comment keeps the pair", () => {
  const base = { comment: false, ack: { variant: "ack" as const, choice: "X · this project · 7 days", cycle: true } };
  expect(askCoverShortcuts(base).map((h) => [h.key, h.action, h.event])).toEqual([
    ["Enter", "Acknowledge", "allow"],
    ["Ctrl+Enter", "Remember X · this project · 7 days", "ack-remember"],
    ["Ctrl+ArrowLeft", "Previous option", "ack-prev"],
    ["Ctrl+ArrowRight", "Next option", "ack-next"],
    ["Esc", "Refuse", "deny"],
  ]);
  expect(askCoverShortcuts({ ...base, comment: true }).map((h) => h.action)).toEqual(["Acknowledge", "Refuse"]);
});

test("soft-deny + ack offers no grant remember, only the acknowledgement's", () => {
  const keys = askCoverShortcuts({
    comment: false,
    remember: undefined,
    ack: { variant: "soft-deny+ack", choice: "X · this session" },
  }).map((h) => [h.action, h.event]);
  expect(keys).toEqual([
    ["Allow once", "allow"],
    ["Remember X · this session", "ack-remember"],
    ["Deny", "deny"],
  ]);
});

test("ask + ack: grant remember chords also remember the acknowledgement", () => {
  const keys = askCoverShortcuts({
    comment: false,
    remember: "`make docs`",
    ack: { variant: "ask+ack", choice: "X · this project · 7 days" },
  }).map((h) => h.action);
  expect(keys).toContain("Remember `make docs` and the acknowledgement this session");
  expect(keys).not.toContain("Remember X · this project · 7 days");
});

test("Enter acknowledges: one ack/answer RPC, the call is no longer waiting", () => {
  const calls: Call[] = [];
  const client = localClient(calls);
  const { turn, call } = flagged("policyApprove");
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  press(tea, "Enter");
  expect(calls).toEqual([
    { method: "ack/answer", params: { sessionId: "s", jobId: call.uuid, ackId: call.uuid, accept: true } },
  ]);
  expect(call.ackState).toBe("satisfied");
});

test("Esc refuses; a typed reply rides as the comment", () => {
  const calls: Call[] = [];
  const client = localClient(calls);
  const { turn, call } = flagged("policyApprove");
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  typeText(tea, "not to prod");
  press(tea, "Escape", { ctrl: true });
  expect(calls).toEqual([
    {
      method: "ack/answer",
      params: { sessionId: "s", jobId: call.uuid, ackId: call.uuid, accept: false, comment: "not to prod" },
    },
  ]);
  expect(call.ackState).toBe("refused");
});

test("the remember chord sends the picked scope and subject; arrows cycle the option", () => {
  const calls: Call[] = [];
  const client = localClient(calls);
  const { turn, call } = flagged("policyApprove");
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  press(tea, "ArrowRight", { ctrl: true });
  press(tea, "Enter", { ctrl: true });
  expect(calls).toEqual([
    {
      method: "ack/answer",
      params: {
        sessionId: "s",
        jobId: call.uuid,
        ackId: call.uuid,
        accept: true,
        store: { scope: "project", subject: toolSubject },
      },
    },
  ]);
});

test("a combined ask + ack answers over ask/answer; remembering sends ackStore", () => {
  const calls: Call[] = [];
  const client = localClient(calls);
  const { turn, call } = flagged("deny");
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  press(tea, "ArrowRight", { ctrl: true });
  press(tea, "ArrowRight", { ctrl: true });
  press(tea, "Enter", { ctrl: true });
  expect(calls).toEqual([
    {
      method: "ask/answer",
      params: {
        sessionId: "s",
        jobId: call.uuid,
        allow: true,
        ackStore: { scope: "global", subject: toolSubject },
      },
    },
  ]);
  expect(call.humanApprove).toBe(true);
  expect(call.ackState).toBe("satisfied");
});

test("a combined ask + ack: plain Enter is a plain ask/answer allow", () => {
  const calls: Call[] = [];
  const client = localClient(calls);
  const { turn, call } = flagged("ask");
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  press(tea, "Enter");
  expect(calls).toEqual([{ method: "ask/answer", params: { sessionId: "s", jobId: call.uuid, allow: true } }]);
});
