import {
  admitQueue,
  admitSteer,
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  demoteSteers,
  HARNESS_CONSTITUTION,
  isEvalRequestCancelled,
  ReACTChunk,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnEvalSpec,
  SkillSpec,
  TurnPromptChunk,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { admitCompact, admitTurn, cancelTurnCommand, drainPromptQueue, retryTurn, rewindTurn } from "../index.js";
import { commandHost, sessionOf, user } from "./fixtures.js";

function closedWork(): SessionTurn {
  const prior = new CompletionExpectation({ connectionId: "c1" });
  prior.totalTokens = 80;
  prior.contextLimit = 100;
  prior.responseText = "hello";
  return new SessionTurn({
    turnTail: new SessionSystemPrompt({ constitution: HARNESS_CONSTITUTION }),
    prompt: user("hi"),
    doneWork: [new CompletionJob({ expectation: prior })],
    queue: [],
    reducerExited: true,
  });
}

describe("session commands", () => {
  it("turn: empty is noop; no connection is invalid; mint then steer/queue", () => {
    const doc = sessionOf("turn");
    const host = commandHost(doc);
    expect(admitTurn(host, { prompt: "   " })).toEqual({
      ok: true,
      action: "noop",
    });
    expect(admitTurn(host, { prompt: "hello" })).toEqual({
      ok: false,
      reason: "connection is required",
      invalid: true,
    });
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    expect(admitTurn(host, { prompt: "hello" })).toEqual({
      ok: true,
      action: "mint",
    });
    const head = doc.root.head;
    expect(head instanceof SessionTurn && head.prompt).toBe("hello");
    expect(head instanceof SessionTurn && head.derivedMessage).toBeNull();
    expect(head instanceof SessionTurn && head.completionMessage).toBe("hello");
    expect(admitTurn(host, { prompt: "again" })).toEqual({
      ok: true,
      action: "steer",
    });
    expect(admitTurn(host, { prompt: "later", kind: "queue" })).toEqual({
      ok: true,
      action: "queue",
    });
    expect(doc.root.steerQueue.map((row) => row.text)).toEqual(["again"]);
    expect(doc.root.promptQueue.map((row) => row.text)).toEqual(["later"]);
    expect(admitTurn(host, { prompt: "", kind: "continue" })).toEqual({
      ok: true,
      action: "noop",
    });
  });

  it("an empty caption with a picture mints, and a picture does not steer", () => {
    const doc = sessionOf("pics");
    const host = commandHost(doc);
    const visual = {
      id: "pic-1",
      mime: "image/png",
      width: 2,
      height: 3,
      resizedFrom: null,
      sourcePath: null,
    };
    expect(admitTurn(host, { prompt: "", visuals: [] })).toEqual({ ok: true, action: "noop" });
    expect(admitTurn(host, { prompt: "  ", visuals: [visual] })).toEqual({
      ok: false,
      reason: "connection is required",
      invalid: true,
    });
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    expect(admitTurn(host, { prompt: "  ", visuals: [visual] })).toEqual({ ok: true, action: "mint" });
    const head = doc.root.head;
    expect(head instanceof SessionTurn && head.prompt).toBe("");
    expect(head instanceof SessionTurn && [...head.visuals]).toEqual([visual]);
    expect(admitTurn(host, { prompt: "later", visuals: [visual] })).toEqual({
      ok: false,
      reason: "an image can't be sent with that",
      invalid: true,
    });
    expect(admitTurn(host, { prompt: "", kind: "queue", visuals: [visual] })).toEqual({
      ok: false,
      reason: "an image can't be sent with that",
      invalid: true,
    });
  });

  it("continue mints ReACT at tip after a failed-or-cancel closed turn", () => {
    const doc = sessionOf("continue");
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const host = commandHost(doc);
    const closed = new SessionTurn({
      turnTail: new SessionSystemPrompt({ constitution: HARNESS_CONSTITUTION }),
      prompt: user("hi"),
      queue: [],
      reducerExited: true,
      cancelled: true,
    });
    doc.root.head = closed;
    doc.root.tip = closed;
    expect(closed.lastTurnIncomplete).toBe(true);
    expect(admitTurn(host, { prompt: "", kind: "continue" })).toEqual({
      ok: true,
      action: "continue",
    });
    const next = doc.root.head;
    expect(next instanceof SessionTurn && next !== closed).toBe(true);
    expect(next instanceof SessionTurn && next.queue[0] instanceof ReACTChunk).toBe(true);
  });

  it("retry skipBackoff hits the live completion; compact while running is invalid", () => {
    const doc = sessionOf("retry");
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const skipped: string[] = [];
    const host = commandHost(doc, {
      skipBackoff: (completion) => {
        skipped.push(completion.uuid);
      },
    });
    expect(admitTurn(host, { prompt: "hello" })).toEqual({
      ok: true,
      action: "mint",
    });
    const turn = doc.root.head;
    if (!(turn instanceof SessionTurn)) throw new TypeError("expected turn");
    const completion = new CompletionExpectation({ connectionId: "c1" });
    turn.doneWork.push(new CompletionJob({ expectation: completion }));
    expect(retryTurn(host)).toEqual({ ok: true });
    expect(skipped).toEqual([completion.uuid]);
    expect(admitCompact(host, "keep")).toEqual({
      ok: false,
      reason: "already running",
      invalid: true,
    });
  });

  it("compact admits a CompactJob; cancel and rewind move head", () => {
    const doc = sessionOf("compact-cancel");
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const cancelled: string[] = [];
    const host = commandHost(doc, {
      cancelOwned: (turn) => {
        cancelled.push(turn.uuid);
        turn.cancelRequested = true;
        turn.cancelled = true;
        turn.reducerExited = true;
      },
      loadTurn: (id) => {
        const loaded = doc.loadEntity(id);
        return loaded instanceof SessionTurn ? loaded : undefined;
      },
    });
    expect(admitCompact(host, "keep")).toEqual({
      ok: false,
      reason: "no-head",
    });
    const work = closedWork();
    doc.root.head = work;
    doc.root.tip = work;
    expect(admitCompact(host, "keep")).toEqual({ ok: true, compacted: false });
    const compactHead = doc.root.head;
    expect(compactHead instanceof SessionTurn && compactHead !== work).toBe(true);
    expect(compactHead instanceof SessionTurn && compactHead.queue.some((chunk) => chunk instanceof CompactJob)).toBe(
      true,
    );
    expect(compactHead instanceof SessionTurn ? compactHead.prompt : "").toBe("keep");

    const running = compactHead as SessionTurn;
    expect(cancelTurnCommand(host, { turnId: running.uuid })).toEqual({
      ok: true,
    });
    expect(running.cancelRequested).toBe(true);
    expect(cancelled).toContain(running.uuid);

    const pin = work;
    running.reducerExited = true;
    doc.root.head = running;
    doc.root.tip = running;
    const rewound = rewindTurn(host, pin.uuid);
    expect(rewound).toEqual({ ok: true, turnId: pin.uuid });
    expect(doc.root.head).toBe(pin);
  });

  it("rewind of a running eval turn records cancelledEvalRequests so the requestId cannot be re-admitted", () => {
    const doc = sessionOf("rewind-eval");
    const cancelled: string[] = [];
    const host = commandHost(doc, {
      cancelOwned: (turn) => {
        cancelled.push(turn.uuid);
        turn.cancelRequested = true;
        turn.cancelled = true;
        turn.reducerExited = true;
      },
      loadTurn: (id) => {
        const loaded = doc.loadEntity(id);
        return loaded instanceof SessionTurn ? loaded : undefined;
      },
    });
    const pin = closedWork();
    doc.root.head = pin;
    doc.root.tip = pin;
    const evalTurn = new SessionTurn({
      turnTail: pin,
      prompt: user(""),
      evalSpec: new SessionTurnEvalSpec({
        requestId: "eval-1",
        permissionMode: "auto",
      }),
      queue: [new TurnPromptChunk()],
    });
    doc.root.head = evalTurn;
    doc.root.tip = evalTurn;
    expect(rewindTurn(host, pin.uuid)).toEqual({ ok: true, turnId: pin.uuid });
    expect(doc.root.head).toBe(pin);
    expect(cancelled).toContain(evalTurn.uuid);
    expect(isEvalRequestCancelled(doc.root, "eval-1")).toBe(true);
    expect(doc.root.cancelledEvalRequests["eval-1"]).toBe("1");
  });

  it("no document update lands a minted head off its tip", () => {
    const doc = sessionOf("mint-update");
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const pin = closedWork();
    doc.root.head = pin;
    doc.root.tip = pin;
    const offTip: string[] = [];
    doc.onPatch(() => {
      if (doc.root.head !== doc.root.tip) offTip.push(doc.root.head?.prompt ?? "");
    });
    expect(admitTurn(commandHost(doc), { prompt: "next" })).toEqual({ ok: true, action: "mint" });
    expect({ minted: doc.root.head !== pin, offTip }).toEqual({ minted: true, offTip: [] });
  });

  it("rewind under a waiting inbound head cancels the running predecessor too", () => {
    const doc = sessionOf("rewind-inbound");
    const cancelled: SessionTurn[] = [];
    const host = commandHost(doc, {
      cancelOwned: (turn) => {
        cancelled.push(turn);
        turn.cancelRequested = true;
      },
    });
    const pin = closedWork();
    doc.root.head = pin;
    doc.root.tip = pin;
    const running = new SessionTurn({ turnTail: pin, prompt: user("work"), queue: [new TurnPromptChunk()] });
    doc.root.head = running;
    doc.root.tip = running;
    doc.root.enqueueAgentRequest("req", "caller", user("from a peer"));
    const inbound = doc.root.head;
    expect(rewindTurn(host, pin.uuid)).toEqual({ ok: true, turnId: pin.uuid });
    expect({ head: doc.root.head === pin, cancelled: cancelled.map((turn) => turn.uuid) }).toEqual({
      head: true,
      cancelled: [inbound?.uuid, running.uuid],
    });
  });

  it("rewind drops a steer composed against the abandoned future", () => {
    const doc = sessionOf("rewind-steer");
    const host = commandHost(doc);
    const pin = closedWork();
    doc.root.head = pin;
    doc.root.tip = pin;
    const running = new SessionTurn({ turnTail: pin, prompt: user("work"), queue: [] });
    doc.root.head = running;
    doc.root.tip = running;
    admitSteer(doc.root, user("also this"), running.uuid);
    admitQueue(doc.root, user("later"), running.uuid);
    expect(rewindTurn(host, pin.uuid)).toEqual({ ok: true, turnId: pin.uuid });
    demoteSteers(doc.root);
    expect({
      steer: doc.root.steerQueue.map((row) => row.text),
      prompt: doc.root.promptQueue.map((row) => row.text),
    }).toEqual({ steer: [], prompt: [] });
  });

  it("skill slash keeps the typed prompt and stores the injection aside", () => {
    const doc = sessionOf("skill");
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    doc.root.replaceSkills([
      new SkillSpec({
        name: "review",
        description: "Review the diff.",
        location: "/tmp/p/.agents/skills/review/SKILL.md",
        invoke: "review",
      }),
    ]);
    const derived = user("<skill>\nRead the diff.\n</skill>\n\nleftover");
    const host = commandHost(doc, {
      expandSkill: (prompt) => (prompt === "/review leftover" ? { prompt, derived } : { prompt, derived: null }),
    });
    expect(admitTurn(host, { prompt: "/review leftover" })).toEqual({ ok: true, action: "mint" });
    const head = doc.root.head;
    expect(
      head instanceof SessionTurn && {
        prompt: head.prompt,
        derived: head.derivedMessage,
        model: head.completionMessage,
      },
    ).toEqual({
      prompt: "/review leftover",
      derived,
      model: derived,
    });
    expect(admitTurn(host, { prompt: "/review leftover" })).toEqual({ ok: true, action: "steer" });
    expect(doc.root.steerQueue.map((row) => ({ text: row.text, derived: row.derivedMessage }))).toEqual([
      { text: "/review leftover", derived },
    ]);
  });

  it("promptQueue drain: /compact mints compact; host verbs drop; user text mints", () => {
    const doc = sessionOf("queue");
    doc.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const renamed: string[] = [];
    const host = commandHost(doc, {
      queuedVerbs: () => new Set(["quit"]),
      rename: (title) => {
        renamed.push(title);
        return { ok: true, title };
      },
    });
    const work = closedWork();
    doc.root.head = work;
    doc.root.tip = work;
    admitQueue(doc.root, user("/compact keep"), work.uuid);
    drainPromptQueue(host);
    const compactHead = doc.root.head;
    expect(compactHead instanceof SessionTurn && compactHead !== work).toBe(true);
    expect(compactHead instanceof SessionTurn && compactHead.queue.some((chunk) => chunk instanceof CompactJob)).toBe(
      true,
    );
    expect(doc.root.promptQueue).toHaveLength(0);

    doc.root.head = work;
    doc.root.tip = work;
    admitQueue(doc.root, user("/quit now"), work.uuid);
    drainPromptQueue(host);
    expect(doc.root.promptQueue).toHaveLength(0);
    expect(doc.root.head).toBe(work);

    admitQueue(doc.root, user("/rename Title"), work.uuid);
    drainPromptQueue(host);
    expect(renamed).toEqual(["Title"]);

    admitQueue(doc.root, user("next please"), work.uuid);
    drainPromptQueue(host);
    expect(doc.root.head instanceof SessionTurn && doc.root.head !== work).toBe(true);
    expect(doc.root.head instanceof SessionTurn ? doc.root.head.prompt : "").toBe("next please");
  });
});
