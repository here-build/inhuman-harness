/**
 * Double-Esc on empty enters history. Arrows then traverse locally.
 * Enter commits `turn/rewind`. Esc cancels the view. Composer stays.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  KernelPlexus,
  KernelRoot,
  reactChunks,
  retractLastQueued,
  tapeCompletion,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import { expect, test } from "vitest";

import type { ComposerPaintInstance, RewindPaintInstance } from "../paint-dom.js";
import { Tea } from "../tea.js";

type RpcCall = { method: string; params: unknown };

function localClient(): Client {
  return new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
}

function closed(tail: SessionSystemPrompt | SessionTurn, text: string): SessionTurn {
  return new SessionTurn({ turnTail: tail, prompt: prompt.user`${text}`, queue: [], reducerExited: true });
}

function attachRewind(client: Client, calls: RpcCall[]): void {
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "turn/rewind" && params != null && typeof params === "object" && "turnId" in params) {
      const id = String((params as { turnId: unknown }).turnId);
      let unit: SessionTurn | SessionSystemPrompt | null = client.sessionRoot.tip ?? client.sessionRoot.head;
      while (unit instanceof SessionTurn) {
        if (unit.uuid === id) {
          client.sessionRoot.head = unit;
          break;
        }
        unit = unit.turnTail;
      }
      return { ok: true, turnId: id };
    }
    if (
      method === "queue/retract-last" &&
      (params as { id?: unknown }).id === client.sessionRoot.promptQueue.at(-1)?.uuid
    ) {
      retractLastQueued(client.sessionRoot);
    }
    return { ok: true };
  };
}

function ackTurnCancel(turn: SessionTurn): void {
  turn.cancelRequested = true;
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null && pew.outcome == null) {
      pew.fail("cancel", "terminate", "null");
    }
  }
  turn.cancelled = true;
  turn.reducerExited = true;
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function rewindFace(tea: Tea) {
  const face = tea.paintRoot.children.find((child) => child.kind === "rewind") as RewindPaintInstance;
  return { atTip: face.atTip, past: [...face.past], future: [...face.future] };
}

test("Esc cancel does not traverse; arrows stay dead until double-Esc; Enter commits", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const one = closed(new SessionSystemPrompt(), "one");
  const two = closed(one, "two");
  const run = new SessionTurn({ turnTail: two, prompt: prompt.user`live` });
  client.sessionRoot.head = run;
  client.sessionRoot.tip = run;
  let now = 1_000;
  using tea = new Tea(client, () => undefined, { now: () => now });
  const hidden = { atTip: true, past: [], future: [] };
  expect(rewindFace(tea)).toEqual(hidden);

  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  expect({ face: rewindFace(tea), armed: tea.escClearArmed, cancel: calls }).toEqual({
    face: hidden,
    armed: true,
    cancel: [],
  });
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  await waitFor(() => calls.some((call) => call.method === "turn/cancel"));
  ackTurnCancel(run);
  expect(client.sessionRoot.head).toBe(run);
  expect(rewindFace(tea)).toEqual(hidden);

  tea.handle({ kind: "input_events", events: [{ key: "ArrowUp" }] });
  expect(rewindFace(tea)).toEqual(hidden);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  expect(calls.filter((call) => call.method === "turn/rewind")).toEqual([]);
  expect(rewindFace(tea)).toEqual(hidden);

  now += 1_001;
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  expect(calls.filter((call) => call.method === "turn/rewind")).toEqual([]);
  expect(client.sessionRoot.head).toBe(run);
  const entered = rewindFace(tea);
  tea.handle({ kind: "input_events", events: [{ key: "ArrowDown" }] });
  const downAtLatest = rewindFace(tea);
  tea.handle({ kind: "input_events", events: [{ key: "ArrowUp" }] });
  expect({
    entered,
    downAtLatest,
    afterUp: rewindFace(tea),
    head: client.sessionRoot.head?.prompt,
  }).toEqual({
    // LATEST_PLACE: the view sits on the live head at the tip, so the empty
    // omnibox seats and the ahead stack drops. ArrowDown is a no-op there —
    // there is no newer pin — which is why entered === downAtLatest.
    entered: {
      atTip: false,
      past: [
        { key: one.uuid, text: "one" },
        { key: two.uuid, text: "two" },
      ],
      future: [],
    },
    downAtLatest: {
      atTip: false,
      past: [
        { key: one.uuid, text: "one" },
        { key: two.uuid, text: "two" },
      ],
      future: [],
    },
    afterUp: {
      atTip: false,
      past: [{ key: one.uuid, text: "one" }],
      future: [{ key: run.uuid, text: "live" }],
    },
    head: "live",
  });

  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => client.sessionRoot.head === one);
  expect(tea.draft.draft).toBe("two");
  expect(calls.filter((call) => call.method === "turn/rewind")).toEqual([
    { method: "turn/rewind", params: { turnId: one.uuid } },
  ]);
});

test("Tea rewind: traverse, type, Esc cancels, Enter commits, /rewind and click stay local", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const one = closed(new SessionSystemPrompt(), "one");
  const two = closed(one, "two");
  client.sessionRoot.head = two;
  client.sessionRoot.tip = two;
  using tea = new Tea(client, () => undefined);
  expect(tea.draft.draft).toBe("");

  tea.handle({ kind: "input_events", events: [{ key: "ArrowUp" }] });
  const arrowsIdle = rewindFace(tea).atTip;
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  const armedIdle = { atTip: rewindFace(tea).atTip, armed: tea.escClearArmed };
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  const afterBack = {
    calls: [...calls],
    head: client.sessionRoot.head?.prompt,
    draft: tea.draft.draft,
    atTip: rewindFace(tea).atTip,
    arrowsIdle,
    armedIdle,
  };

  tea.handle({ kind: "input_events", events: [..."x"].map((key) => ({ key })) });
  const typed = tea.draft.draft;
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  const afterCancelView = {
    head: client.sessionRoot.head?.prompt,
    atTip: rewindFace(tea).atTip,
    calls: calls.filter((call) => call.method === "turn/rewind"),
  };

  tea.handle({ kind: "input_events", events: [..."/rewind"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  const viaSlash = {
    head: client.sessionRoot.head?.prompt,
    rewind: calls.filter((c) => c.method === "turn/rewind").length,
    atTip: rewindFace(tea).atTip,
  };

  tea.handle({ kind: "activate", key: two.uuid });
  const viaClick = {
    head: client.sessionRoot.head?.prompt,
    rewind: calls.filter((c) => c.method === "turn/rewind").length,
    atTip: rewindFace(tea).atTip,
  };

  tea.handle({ kind: "input_events", events: [{ key: "ArrowUp" }] });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  const afterCommit = {
    head: client.sessionRoot.head?.prompt,
    draft: tea.draft.draft,
    rewind: calls.filter((c) => c.method === "turn/rewind"),
  };

  expect({
    afterBack,
    typed,
    afterCancelView,
    viaSlash,
    viaClick,
    afterCommit,
  }).toEqual({
    afterBack: {
      calls: [],
      head: "two",
      draft: "",
      // LATEST_PLACE: double-Esc peels onto the head, which is also the tip —
      // the empty omnibox seats there (atTip) and no ahead stack is painted.
      atTip: false,
      arrowsIdle: true,
      armedIdle: { atTip: true, armed: true },
    },
    typed: "",
    afterCancelView: { head: "two", atTip: true, calls: [] },
    viaSlash: { head: "two", rewind: 0, atTip: false },
    // Clicking the current head lands back on the latest message place.
    viaClick: { head: "two", rewind: 0, atTip: false },
    afterCommit: { head: "two", draft: "one", rewind: [] },
  });
});

test("Tea rewind: queue retract, cancel; extra args do not rewind", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const one = closed(new SessionSystemPrompt(), "one");
  const run = new SessionTurn({ turnTail: one, prompt: prompt.user`live` });
  client.sessionRoot.head = run;
  client.sessionRoot.tip = run;
  using tea = new Tea(client, () => undefined);
  admitQueue(client.sessionRoot, prompt.user`later`, run.uuid);
  admitQueue(client.sessionRoot, prompt.user`also`, run.uuid);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  await waitFor(() => client.sessionRoot.promptQueue.length === 1);
  const afterRetract = client.sessionRoot.promptQueue.map((row) => row.text);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  await waitFor(() => client.sessionRoot.promptQueue.length === 0);
  const afterSecondRetract = client.sessionRoot.promptQueue.map((row) => row.text);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  await waitFor(() => calls.some((call) => call.method === "turn/cancel"));
  ackTurnCancel(run);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  const mash = calls.filter((call) => call.method === "turn/rewind");
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.some((call) => call.method === "turn"));

  const usageCalls: RpcCall[] = [];
  const usage = localClient();
  attachRewind(usage, usageCalls);
  using usageTea = new Tea(usage, () => undefined);
  usageTea.handle({ kind: "input_events", events: [..."/rewind now"].map((key) => ({ key })) });
  usageTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await new Promise((resolve) => setTimeout(resolve, 40));

  expect({
    afterRetract,
    afterSecondRetract,
    retracts: calls.filter((call) => call.method === "queue/retract-last").length,
    cancel: calls.filter((call) => call.method === "turn/cancel"),
    mash,
    continueAtTip: calls.at(-1),
    extraArgs: usageCalls,
  }).toEqual({
    afterRetract: ["later"],
    afterSecondRetract: [],
    retracts: 2,
    cancel: [{ method: "turn/cancel", params: { turnId: run.uuid } }],
    mash: [],
    continueAtTip: { method: "turn", params: { prompt: "", kind: "continue" } },
    extraArgs: [],
  });
});

test("restoration clears navigation chrome and future tape, preserving redo", async () => {
  const client = localClient();
  attachRewind(client, []);
  const one = closed(new SessionSystemPrompt(), "one");
  const two = closed(one, "two");
  const three = closed(two, "three");
  client.sessionRoot.head = three;
  client.sessionRoot.tip = three;
  using tea = new Tea(client, () => undefined);
  const speeches = () => {
    const result: { recap: boolean }[] = [];
    const visit = (node: unknown): void => {
      const value = node as { kind?: string; recap?: boolean; children?: unknown[] };
      if (value.kind === "speech") result.push({ recap: value.recap === true });
      for (const child of value.children ?? []) visit(child);
    };
    visit(tea.paintRoot);
    return result;
  };
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }, { key: "ArrowUp" }] });
  expect(speeches()).toHaveLength(3);
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => rewindFace(tea).atTip);
  expect(client.sessionRoot.head).toBe(one);
  expect(tea.draft.draft).toBe("two");
  expect(client.sessionRoot.tip).toBe(three);
  expect(rewindFace(tea)).toEqual({ atTip: true, past: [], future: [] });
  expect(speeches()).toHaveLength(1);
  expect(speeches().some((speech) => speech.recap)).toBe(false);
  tea.handle({
    kind: "input_events",
    events: [{ key: "Escape" }, { key: "Escape" }, { key: "Escape" }, { key: "Escape" }],
  });
  expect(speeches()).toHaveLength(3);
  expect(rewindFace(tea).future.map((row) => row.text)).toEqual(["two", "three"]);
  tea.handle({
    kind: "input_events",
    events: [{ key: "ArrowDown" }, { key: "ArrowDown" }, { key: "ArrowDown" }, { key: "Enter" }],
  });
  await waitFor(() => rewindFace(tea).atTip);
  expect(client.sessionRoot.head).toBe(two);
  expect(client.sessionRoot.tip).toBe(three);
  expect(tea.draft.draft).toBe("three");
  expect(speeches()).toHaveLength(2);
});

test("restored slash prompt does not steal history traversal; redo reaches a promptless tip", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const one = closed(new SessionSystemPrompt(), "/compact focus");
  const two = closed(one, "two");
  const tip = closed(two, "");
  client.sessionRoot.head = tip;
  client.sessionRoot.tip = tip;
  using tea = new Tea(client, () => undefined);
  tea.handle({
    kind: "input_events",
    events: [{ key: "Escape" }, { key: "Escape" }, { key: "ArrowUp" }, { key: "ArrowUp" }, { key: "Enter" }],
  });
  await waitFor(() => rewindFace(tea).atTip);
  expect(client.sessionRoot.head).toBe(tip);
  expect(tea.draft.draft).toBe("/compact focus");
  tea.handle({
    kind: "input_events",
    events: [
      { key: "Escape" },
      { key: "Escape" },
      { key: "ArrowDown" },
      { key: "ArrowDown" },
      { key: "ArrowDown" },
      { key: "ArrowDown" },
      { key: "Enter" },
    ],
  });
  await waitFor(() => client.sessionRoot.head === tip && rewindFace(tea).atTip);
  expect(tea.draft.draft).toBe("");
  expect(calls.map((call) => call.method)).toEqual(["turn"]);
});

test("a restored prompt warns before clearing and does not open history", () => {
  const client = localClient();
  attachRewind(client, []);
  const one = closed(new SessionSystemPrompt(), "one");
  const two = closed(one, "two");
  client.sessionRoot.head = two;
  client.sessionRoot.tip = two;
  using tea = new Tea(client, () => undefined);
  tea.handle({
    kind: "input_events",
    events: [{ key: "Escape" }, { key: "Escape" }, { key: "ArrowUp" }, { key: "Enter" }],
  });
  expect(tea.draft.draft).toBe("one");
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  const warned = { draft: tea.draft.draft, armed: tea.escClearArmed, atTip: rewindFace(tea).atTip };
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  expect({ warned, cleared: { draft: tea.draft.draft, atTip: rewindFace(tea).atTip } }).toEqual({
    warned: { draft: "one", armed: true, atTip: true },
    cleared: { draft: "", atTip: true },
  });
});

test("editing a restored prompt keeps normal draft-clear behavior", async () => {
  const client = localClient();
  attachRewind(client, []);
  const one = closed(new SessionSystemPrompt(), "one");
  const two = closed(one, "two");
  client.sessionRoot.head = two;
  client.sessionRoot.tip = two;
  using tea = new Tea(client, () => undefined);
  tea.handle({
    kind: "input_events",
    events: [{ key: "Escape" }, { key: "Escape" }, { key: "ArrowUp" }, { key: "Enter" }],
  });
  tea.handle({ kind: "input_events", events: [{ key: "x" }, { key: "Escape" }, { key: "Escape" }] });
  expect(tea.draft.draft).toBe("");
  expect(rewindFace(tea).atTip).toBe(true);
  expect(client.sessionRoot.tip).toBe(two);
});

test.each([false, true])("selecting the latest prompt restores it (single message: %s)", async (single) => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const first = closed(new SessionSystemPrompt(), "first");
  const latest = single ? first : closed(first, "last message\nwith another line");
  const suffix = new SessionTurn({ turnTail: latest, prompt: prompt.user``, reducerExited: true });
  client.sessionRoot.head = suffix;
  client.sessionRoot.tip = suffix;
  using tea = new Tea(client, () => undefined);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }, { key: "Enter" }] });
  const landed = single ? suffix : first;
  if (!single) await waitFor(() => client.sessionRoot.head === first);
  expect(tea.draft.draft).toBe(latest.prompt);
  expect(tea.draft.cursor).toBe(latest.prompt.length);
  expect(client.sessionRoot.head).toBe(landed);
  expect(client.sessionRoot.tip).toBe(suffix);
  expect(rewindFace(tea)).toEqual({ atTip: true, past: [], future: [] });
  expect(calls).toEqual(single ? [] : [{ method: "turn/rewind", params: { turnId: first.uuid } }]);
});

test("Enter on the live head with nothing ahead rewinds to the previous pin", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const first = closed(new SessionSystemPrompt(), "first");
  const latest = closed(first, "last message");
  client.sessionRoot.head = latest;
  client.sessionRoot.tip = latest;
  using tea = new Tea(client, () => undefined);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }, { key: "Enter" }] });
  await waitFor(() => client.sessionRoot.head === first);
  expect(tea.draft.draft).toBe("last message");
  expect(client.sessionRoot.head).toBe(first);
  expect(client.sessionRoot.tip).toBe(latest);
  expect(calls).toEqual([{ method: "turn/rewind", params: { turnId: first.uuid } }]);
});

test("history navigation hides the composer and drops the ahead stack at the ceiling", () => {
  const client = localClient();
  attachRewind(client, []);
  const one = closed(new SessionSystemPrompt(), "one");
  const two = closed(one, "two");
  const latest = closed(two, "three");
  client.sessionRoot.head = latest;
  client.sessionRoot.tip = latest;
  using tea = new Tea(client, () => undefined);

  const seat = () => {
    const rewind = tea.paintRoot.children.find((child) => child.kind === "rewind") as RewindPaintInstance;
    const composer = tea.paintRoot.children.find((child) => child.kind === "composer") as ComposerPaintInstance;
    return {
      atTip: rewind.atTip,
      seatRim: rewind.seatRim,
      future: [...rewind.future],
      draft: composer.draft,
      hotkeys: [...composer.hotkeys],
    };
  };

  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  // The peel lands on the ceiling. Nothing is newer, and the composer stays
  // hidden — the recap block is the input for the whole navigation.
  expect(seat()).toEqual({
    atTip: false,
    seatRim: false,
    future: [],
    draft: "",
    hotkeys: [],
  });

  tea.handle({ kind: "input_events", events: [{ key: "ArrowUp" }] });
  expect(seat()).toEqual({
    atTip: false,
    seatRim: false,
    future: [{ key: latest.uuid, text: "three" }],
    draft: "",
    hotkeys: [],
  });

  tea.handle({ kind: "input_events", events: [{ key: "ArrowDown" }] });
  expect(seat()).toEqual({
    atTip: false,
    seatRim: false,
    future: [],
    draft: "",
    hotkeys: [],
  });

  const recapKeys: string[] = [];
  const visit = (node: unknown): void => {
    const value = node as { kind?: string; recap?: boolean; recapHotkeys?: { key: string }[]; children?: unknown[] };
    if (value.kind === "speech" && value.recap === true) {
      recapKeys.push(...(value.recapHotkeys ?? []).map((hotkey) => hotkey.key));
    }
    for (const child of value.children ?? []) visit(child);
  };
  visit(tea.paintRoot);
  expect(recapKeys).toContain("Esc");
  expect(recapKeys.indexOf("Esc")).toBeGreaterThan(recapKeys.indexOf("Enter"));
});

function recapOn(tea: Tea): boolean {
  let hit = false;
  const visit = (node: unknown): void => {
    const value = node as { kind?: string; recap?: boolean; children?: unknown[] };
    if (value.kind === "speech" && value.recap === true) hit = true;
    for (const child of value.children ?? []) visit(child);
  };
  visit(tea.paintRoot);
  return hit;
}

test("Enter on the episode tip skips the empty turns under the last message", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const kept = closed(new SessionSystemPrompt(), "kept");
  const dot = closed(kept, ".");
  let unit: SessionTurn = dot;
  for (let i = 0; i < 7; i++) unit = closed(unit, "");
  const last = closed(unit, "last message");
  client.sessionRoot.head = kept;
  client.sessionRoot.tip = last;
  using tea = new Tea(client, () => undefined);
  tea.handle({
    kind: "input_events",
    events: [{ key: "Escape" }, { key: "Escape" }, { key: "ArrowDown" }, { key: "ArrowDown" }, { key: "Enter" }],
  });
  await waitFor(() => client.sessionRoot.head === dot);
  expect(tea.draft.draft).toBe("last message");
  expect(calls.filter((call) => call.method === "turn/rewind")).toEqual([
    { method: "turn/rewind", params: { turnId: dot.uuid } },
  ]);
  expect(client.sessionRoot.tip).toBe(last);
});

test("Enter lands on the previous user message when a promptless turn sits between", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  attachRewind(client, calls);
  const one = closed(new SessionSystemPrompt(), "one");
  const blank = closed(one, "");
  const two = closed(blank, "two");
  const three = closed(two, "three");
  client.sessionRoot.head = three;
  client.sessionRoot.tip = three;
  using tea = new Tea(client, () => undefined);
  tea.handle({
    kind: "input_events",
    events: [{ key: "Escape" }, { key: "Escape" }, { key: "ArrowUp" }, { key: "Enter" }],
  });
  await waitFor(() => client.sessionRoot.head === one);
  expect(tea.draft.draft).toBe("two");
  expect(calls.filter((call) => call.method === "turn/rewind")).toEqual([
    { method: "turn/rewind", params: { turnId: one.uuid } },
  ]);
  expect(rewindFace(tea).atTip).toBe(true);
});

test("a refused rewind shows the notice immediately and arrows stay on the pin", async () => {
  const client = localClient();
  client.request = async (method) => {
    if (method === "turn/rewind") throw new Error("not-a-pin");
    return { ok: true };
  };
  const one = closed(new SessionSystemPrompt(), "one");
  const two = closed(one, "two");
  const three = closed(two, "three");
  client.sessionRoot.head = three;
  client.sessionRoot.tip = three;
  using tea = new Tea(client, () => undefined);
  const composer = () => tea.paintRoot.children.find((child) => child.kind === "composer") as ComposerPaintInstance;
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }, { key: "ArrowUp" }] });
  const before = rewindFace(tea);
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => composer().draft === "not-a-pin");
  const noticed = { face: rewindFace(tea), recap: recapOn(tea), draft: composer().draft };
  tea.handle({ kind: "input_events", events: [{ key: "ArrowDown" }] });
  const afterDown = { face: rewindFace(tea), recap: recapOn(tea) };
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  await waitFor(() => composer().draft !== "not-a-pin");
  expect({ before, noticed, afterDown, restored: rewindFace(tea), head: client.sessionRoot.head?.prompt }).toEqual({
    before: {
      atTip: false,
      past: [{ key: one.uuid, text: "one" }],
      future: [{ key: three.uuid, text: "three" }],
    },
    noticed: { face: { atTip: true, past: [], future: [] }, recap: false, draft: "not-a-pin" },
    afterDown: { face: { atTip: true, past: [], future: [] }, recap: false },
    restored: {
      atTip: false,
      past: [{ key: one.uuid, text: "one" }],
      future: [{ key: three.uuid, text: "three" }],
    },
    head: "three",
  });
});
