import { resetLocalIDs } from "@here.build/plexus";
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
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { admitCompact, admitTurn, cancelTurnCommand, drainPromptQueue, retryTurn, rewindTurn } from "../index.js";
import { commandHost, sessionOf, user } from "./fixtures.js";

beforeEach(() => resetLocalIDs());

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
    const plexus = sessionOf("turn");
    const host = commandHost(plexus);
    expect(admitTurn(host, { prompt: "   " })).toEqual({
      ok: true,
      action: "noop",
    });
    expect(admitTurn(host, { prompt: "hello" })).toEqual({
      ok: false,
      reason: "connection is required",
      invalid: true,
    });
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    expect(admitTurn(host, { prompt: "hello" })).toEqual({
      ok: true,
      action: "mint",
    });
    const head = plexus.root.head;
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
    expect(plexus.root.steerQueue.map((row) => row.text)).toEqual(["again"]);
    expect(plexus.root.promptQueue.map((row) => row.text)).toEqual(["later"]);
    expect(admitTurn(host, { prompt: "", kind: "continue" })).toEqual({
      ok: true,
      action: "noop",
    });
  });

  it("an empty caption with a picture mints, and a picture does not steer", () => {
    const plexus = sessionOf("pics");
    const host = commandHost(plexus);
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
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    expect(admitTurn(host, { prompt: "  ", visuals: [visual] })).toEqual({ ok: true, action: "mint" });
    const head = plexus.root.head;
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
    const plexus = sessionOf("continue");
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const host = commandHost(plexus);
    const closed = new SessionTurn({
      turnTail: new SessionSystemPrompt({ constitution: HARNESS_CONSTITUTION }),
      prompt: user("hi"),
      queue: [],
      reducerExited: true,
      cancelled: true,
    });
    plexus.root.head = closed;
    plexus.root.tip = closed;
    expect(closed.lastTurnIncomplete).toBe(true);
    expect(admitTurn(host, { prompt: "", kind: "continue" })).toEqual({
      ok: true,
      action: "continue",
    });
    const next = plexus.root.head;
    expect(next instanceof SessionTurn && next !== closed).toBe(true);
    expect(next instanceof SessionTurn && next.queue[0] instanceof ReACTChunk).toBe(true);
  });

  it("retry skipBackoff hits the live completion; compact while running is invalid", () => {
    const plexus = sessionOf("retry");
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const skipped: string[] = [];
    const host = commandHost(plexus, {
      skipBackoff: (completion) => {
        skipped.push(completion.uuid);
      },
    });
    expect(admitTurn(host, { prompt: "hello" })).toEqual({
      ok: true,
      action: "mint",
    });
    const turn = plexus.root.head;
    if (!(turn instanceof SessionTurn)) throw new Error("expected turn");
    const pew = new CompletionExpectation({ connectionId: "c1" });
    turn.doneWork.push(new CompletionJob({ expectation: pew }));
    expect(retryTurn(host)).toEqual({ ok: true });
    expect(skipped).toEqual([pew.uuid]);
    expect(admitCompact(host, "keep")).toEqual({
      ok: false,
      reason: "already running",
      invalid: true,
    });
  });

  it("compact admits a CompactJob; cancel and rewind move head", () => {
    const plexus = sessionOf("compact-cancel");
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const cancelled: string[] = [];
    const host = commandHost(plexus, {
      cancelOwned: (turn) => {
        cancelled.push(turn.uuid);
        turn.cancelRequested = true;
        turn.cancelled = true;
        turn.reducerExited = true;
      },
      loadTurn: (id) => {
        const loaded = plexus.loadEntity(id);
        return loaded instanceof SessionTurn ? loaded : undefined;
      },
    });
    expect(admitCompact(host, "keep")).toEqual({
      ok: false,
      reason: "no-head",
    });
    const work = closedWork();
    plexus.root.head = work;
    plexus.root.tip = work;
    expect(admitCompact(host, "keep")).toEqual({ ok: true, compacted: false });
    const compactHead = plexus.root.head;
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
    plexus.root.head = running;
    plexus.root.tip = running;
    const rewound = rewindTurn(host, pin.uuid);
    expect(rewound).toEqual({ ok: true, turnId: pin.uuid });
    expect(plexus.root.head).toBe(pin);
  });

  it("rewind of a running eval turn records cancelledEvalRequests so the requestId cannot be re-admitted", () => {
    const plexus = sessionOf("rewind-eval");
    const cancelled: string[] = [];
    const host = commandHost(plexus, {
      cancelOwned: (turn) => {
        cancelled.push(turn.uuid);
        turn.cancelRequested = true;
        turn.cancelled = true;
        turn.reducerExited = true;
      },
      loadTurn: (id) => {
        const loaded = plexus.loadEntity(id);
        return loaded instanceof SessionTurn ? loaded : undefined;
      },
    });
    const pin = closedWork();
    plexus.root.head = pin;
    plexus.root.tip = pin;
    const evalTurn = new SessionTurn({
      turnTail: pin,
      prompt: user(""),
      evalSpec: new SessionTurnEvalSpec({
        requestId: "eval-1",
        permissionMode: "auto",
      }),
      queue: [],
    });
    plexus.root.head = evalTurn;
    plexus.root.tip = evalTurn;
    expect(rewindTurn(host, pin.uuid)).toEqual({ ok: true, turnId: pin.uuid });
    expect(plexus.root.head).toBe(pin);
    expect(cancelled).toContain(evalTurn.uuid);
    expect(isEvalRequestCancelled(plexus.root, "eval-1")).toBe(true);
    expect(plexus.root.cancelledEvalRequests["eval-1"]).toBe("1");
  });

  it("no document update lands a minted head off its tip", () => {
    const plexus = sessionOf("mint-update");
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const pin = closedWork();
    plexus.root.head = pin;
    plexus.root.tip = pin;
    const offTip: string[] = [];
    plexus.doc.on("update", () => {
      if (plexus.root.head !== plexus.root.tip) offTip.push(plexus.root.head?.prompt ?? "");
    });
    expect(admitTurn(commandHost(plexus), { prompt: "next" })).toEqual({ ok: true, action: "mint" });
    expect({ minted: plexus.root.head !== pin, offTip }).toEqual({ minted: true, offTip: [] });
  });

  it("rewind under a waiting inbound head cancels the running predecessor too", () => {
    const plexus = sessionOf("rewind-inbound");
    const cancelled: SessionTurn[] = [];
    const host = commandHost(plexus, {
      cancelOwned: (turn) => {
        cancelled.push(turn);
        turn.cancelRequested = true;
      },
    });
    const pin = closedWork();
    plexus.root.head = pin;
    plexus.root.tip = pin;
    const running = new SessionTurn({ turnTail: pin, prompt: user("work"), queue: [] });
    plexus.root.head = running;
    plexus.root.tip = running;
    plexus.root.enqueueAgentRequest("req", "caller", user("from a peer"));
    const inbound = plexus.root.head;
    expect(rewindTurn(host, pin.uuid)).toEqual({ ok: true, turnId: pin.uuid });
    expect({ head: plexus.root.head === pin, cancelled: cancelled.map((turn) => turn.uuid) }).toEqual({
      head: true,
      cancelled: [inbound?.uuid, running.uuid],
    });
  });

  it("rewind drops a steer composed against the abandoned future", () => {
    const plexus = sessionOf("rewind-steer");
    const host = commandHost(plexus);
    const pin = closedWork();
    plexus.root.head = pin;
    plexus.root.tip = pin;
    const running = new SessionTurn({ turnTail: pin, prompt: user("work"), queue: [] });
    plexus.root.head = running;
    plexus.root.tip = running;
    admitSteer(plexus.root, user("also this"), running.uuid);
    admitQueue(plexus.root, user("later"), running.uuid);
    expect(rewindTurn(host, pin.uuid)).toEqual({ ok: true, turnId: pin.uuid });
    demoteSteers(plexus.root);
    expect({
      steer: plexus.root.steerQueue.map((row) => row.text),
      prompt: plexus.root.promptQueue.map((row) => row.text),
    }).toEqual({ steer: [], prompt: [] });
  });

  it("skill slash keeps the typed prompt and stores the injection aside", () => {
    const plexus = sessionOf("skill");
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    plexus.root.replaceSkills([
      new SkillSpec({
        name: "review",
        description: "Review the diff.",
        location: "/tmp/p/.agents/skills/review/SKILL.md",
        invoke: "review",
      }),
    ]);
    const derived = user("<skill>\nRead the diff.\n</skill>\n\nleftover");
    const host = commandHost(plexus, {
      expandSkill: (prompt) => (prompt === "/review leftover" ? { prompt, derived } : { prompt, derived: null }),
    });
    expect(admitTurn(host, { prompt: "/review leftover" })).toEqual({ ok: true, action: "mint" });
    const head = plexus.root.head;
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
    expect(plexus.root.steerQueue.map((row) => ({ text: row.text, derived: row.derivedMessage }))).toEqual([
      { text: "/review leftover", derived },
    ]);
  });

  it("promptQueue drain: /compact mints compact; host verbs drop; user text mints", () => {
    const plexus = sessionOf("queue");
    plexus.root.applyKvs([{ form: "kv-set", key: "connection", value: "c1" }]);
    const renamed: string[] = [];
    const host = commandHost(plexus, {
      queuedVerbs: () => new Set(["quit"]),
      rename: (title) => {
        renamed.push(title);
        return { ok: true, title };
      },
    });
    const work = closedWork();
    plexus.root.head = work;
    plexus.root.tip = work;
    admitQueue(plexus.root, user("/compact keep"), work.uuid);
    drainPromptQueue(host);
    const compactHead = plexus.root.head;
    expect(compactHead instanceof SessionTurn && compactHead !== work).toBe(true);
    expect(compactHead instanceof SessionTurn && compactHead.queue.some((chunk) => chunk instanceof CompactJob)).toBe(
      true,
    );
    expect(plexus.root.promptQueue).toHaveLength(0);

    plexus.root.head = work;
    plexus.root.tip = work;
    admitQueue(plexus.root, user("/quit now"), work.uuid);
    drainPromptQueue(host);
    expect(plexus.root.promptQueue).toHaveLength(0);
    expect(plexus.root.head).toBe(work);

    admitQueue(plexus.root, user("/rename Title"), work.uuid);
    drainPromptQueue(host);
    expect(renamed).toEqual(["Title"]);

    admitQueue(plexus.root, user("next please"), work.uuid);
    drainPromptQueue(host);
    expect(plexus.root.head instanceof SessionTurn && plexus.root.head !== work).toBe(true);
    expect(plexus.root.head instanceof SessionTurn ? plexus.root.head.prompt : "").toBe("next please");
  });
});
