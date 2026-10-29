/**
 * Turn occupancy: window gauge, soft-compact tokens, remaining-until-compact fill.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, expect, test } from "vitest";

import { CompletionExpectation } from "../expectations/CompletionExpectation.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

function completion(used: number, limit: number): CompletionJob {
  const node = new CompletionExpectation({ connectionId: "c1" });
  node.totalTokens = used;
  node.contextLimit = limit;
  return new CompletionJob({ expectation: node });
}

function completionAs(used: number, limit: number, model: string): CompletionJob {
  const node = new CompletionExpectation({ connectionId: "c1", model });
  node.totalTokens = used;
  node.contextLimit = limit;
  return new CompletionJob({ expectation: node });
}

function turnOf(...chunks: Array<CompletionJob | CompactJob>): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: chunks,
    queue: [],
  });
}

beforeEach(() => resetLocalIDs());

test("Turn occupancy: used, limit, soft-compact tokens, remaining fill", () => {
  const empty = turnOf();
  expect({
    used: empty.contextUsed,
    limit: empty.contextLimit,
    soft: empty.contextSoftCompactAt(),
    remaining: empty.contextRemainingProgress(),
  }).toEqual({ used: 0, limit: 0, soft: 0, remaining: null });

  const mid = turnOf(completion(40, 100));
  expect({
    used: mid.contextUsed,
    limit: mid.contextLimit,
    softDefault: mid.contextSoftCompactAt(),
    softHalf: mid.contextSoftCompactAt("50%"),
    remaining: mid.contextRemainingProgress(),
    remainingHalf: mid.contextRemainingProgress("50%"),
  }).toEqual({
    used: 40,
    limit: 100,
    softDefault: 80,
    softHalf: 50,
    remaining: 0.5,
    remainingHalf: 0.2,
  });

  const live = completion(0, 100);
  const prior = turnOf(completion(60, 100));
  const current = new SessionTurn({
    turnTail: prior,
    prompt: prompt.user`next`,
    doneWork: [live],
    queue: [],
  });
  expect({
    used: current.contextUsed,
    limit: current.contextLimit,
    remaining: current.contextRemainingProgress(),
  }).toEqual({ used: 60, limit: 100, remaining: 0.25 });

  const past = turnOf(completion(90, 100));
  expect(past.contextRemainingProgress()).toBe(0);
});

test("Turn occupancy: a compact cutoff makes the earlier gauge stale (F12)", () => {
  const cutoff = new CompactJob({ reason: "overflow", standIn: "CARD", completed: true });
  const compacted = turnOf(completion(90, 100), cutoff);
  // The 90-token reading describes the context the cutoff replaced.
  expect({ used: compacted.contextUsed, limit: compacted.contextLimit, stale: compacted.contextStale }).toEqual({
    used: 0,
    limit: 100,
    stale: true,
  });
  expect(compacted.contextRemainingProgress()).toBe(1);

  // A failed compact is not a cutoff: the gauge stands.
  const failed = turnOf(
    completion(90, 100),
    new CompactJob({ reason: "overflow", failed: true, completed: true, notice: "n" }),
  );
  expect({ used: failed.contextUsed, stale: failed.contextStale }).toEqual({ used: 90, stale: false });

  // The first round after the cutoff reports a fresh reading, which clears it.
  const after = new SessionTurn({
    turnTail: compacted,
    prompt: prompt.user`next`,
    doneWork: [completion(30, 100)],
    queue: [],
  });
  expect({ used: after.contextUsed, stale: after.contextStale }).toEqual({ used: 30, stale: false });

  // A live round that has not reported yet leaves it stale, not back at 90.
  const pending = new SessionTurn({
    turnTail: compacted,
    prompt: prompt.user`next`,
    doneWork: [completion(0, 100)],
    queue: [],
  });
  expect({ used: pending.contextUsed, stale: pending.contextStale }).toEqual({ used: 0, stale: true });
});

test("Turn occupancy: gauge model names the round that stamped the window", () => {
  expect(turnOf().contextModel).toBe("");

  const named = turnOf(completionAs(40, 100, "grok-4"));
  expect(named.contextModel).toBe("grok-4");

  // A live round that has not reported yet keeps the prior round's gauge.
  const live = completionAs(0, 0, "grok-4-heavy");
  const prior = turnOf(completionAs(60, 100, "grok-4"));
  const current = new SessionTurn({
    turnTail: prior,
    prompt: prompt.user`next`,
    doneWork: [live],
    queue: [],
  });
  expect({ model: current.contextModel, used: current.contextUsed, limit: current.contextLimit }).toEqual({
    model: "grok-4",
    used: 60,
    limit: 100,
  });

  // A host that resolved a window the tape never stamped re-bases the fill
  // without touching the tape.
  expect(current.contextRemainingProgress("80%", 1_000)).toBe(0.925);
  expect(current.contextRemainingProgress("80%", 0)).toBe(null);
});
