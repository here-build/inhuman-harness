/**
 * compactDecision on constructed Plexus turns — one occupancy table.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CONTEXT_NEED_TOOL_NAME,
  CompletionExpectation,
  CompletionJob,
  ContextNeedToolJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  CompactJob,
  parseCompactTrigger,
} from "@inhuman.tools/harness-model";
import { beforeEach, expect, test } from "vitest";

import {
  compactDecision,
  compactRejectReason,
  keepFloors,
  needFeasible,
  sliceCompactEat,
  tailCompactCandidate,
  historyBehind,
  Transcript,
} from "@/context";

const HARD = parseCompactTrigger("90%");

beforeEach(() => resetLocalIDs());

function gauge(used: number, limit: number, promptText = "round"): CompletionExpectation {
  const node = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${promptText}` });
  if (used > 0) node.totalTokens = used;
  if (limit > 0) node.contextLimit = limit;
  return node;
}

function need(id: string, args: Record<string, unknown>): ContextNeedToolJob {
  return new ContextNeedToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    toolCallId: id,
    name: CONTEXT_NEED_TOOL_NAME,
    argsJson: JSON.stringify(args),
  });
}

function turnOf(...chunks: Array<SessionTurn["doneWork"][number] | CompletionExpectation>): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: chunks.map((chunk) =>
      chunk instanceof CompletionExpectation ? new CompletionJob({ expectation: chunk }) : chunk,
    ),
    queue: [],
  });
}

/**
 * A single-round eat keep-alls under the non-zero floor — nothing older moves to the prefix.
 * Occupancy decisions need a prior round, linked via `messages` so
 * `historyBehind` keeps both instead of collapsing the newest completion.
 */
function turnOccupied(
  newer: CompletionExpectation,
  ...chunks: Array<SessionTurn["doneWork"][number] | CompletionExpectation>
): SessionTurn {
  const older = gauge(20, 100, "prior");
  newer.messages = [older];
  return turnOf(older, newer, ...chunks);
}

/** Chains a turn onto a tail, linking `messages` so the eat keeps both rounds. */
function chainedTurn(tail: SessionTurn, newer: CompletionExpectation): SessionTurn {
  const last = tail.doneWork.findLast((chunk) => chunk instanceof CompletionJob);
  const anchor = last instanceof CompletionJob ? last.expectation : gauge(20, 100, "prior");
  newer.messages = [anchor];
  return new SessionTurn({
    turnTail: tail,
    prompt: prompt.user`continue`,
    doneWork: [new CompletionJob({ expectation: newer })],
    queue: [],
  });
}

function slicedOf(turn: SessionTurn, kv: Record<string, string> = {}) {
  return sliceCompactEat(Transcript.fromCells(historyBehind(turn)), keepFloors(turn.contextNeed, kv));
}

function keepTokens(turn: SessionTurn, kv: Record<string, string> = {}): number {
  return slicedOf(turn, kv).keep.tokensUsed();
}

/** Tail splice and ambient option are separate. `option` is not a queue chunk. */
function split(turn: SessionTurn, hard = HARD, kv: Record<string, string> = {}) {
  const sliced = slicedOf(turn, kv);
  return { tail: tailCompactCandidate(turn, hard, sliced), option: compactDecision(turn, sliced) };
}

const occupancy = [
  {
    name: "deficit",
    got: () => split(turnOccupied(gauge(80, 100), need("n1", { min_remaining_tokens: 40, focus: "keep the cutoff" }))),
    want: { tail: null, option: { focus: "keep the cutoff" } },
  },
  {
    name: "deficitSettled",
    got: () =>
      split(turnOccupied(gauge(80, 100), need("n1", { min_remaining_tokens: 40, current_phase_settled: true }))),
    want: { tail: null, option: { focus: "" } },
  },
  {
    name: "both",
    got: () => {
      const older = gauge(40, 100, "one");
      const newer = gauge(91, 100, "two");
      newer.messages = [older];
      return split(
        turnOf(
          older,
          newer,
          need("n1", {
            min_remaining_tokens: 40,
            preserve: { user_turns: 1, rounds: 1 },
            focus: "keep the cutoff",
          }),
        ),
      );
    },
    want: { tail: "overflow", option: { focus: "keep the cutoff" } },
  },
  {
    name: "bothFloors",
    got: () => {
      const older = gauge(40, 100, "one");
      const newer = gauge(91, 100, "two");
      newer.messages = [older];
      const both = turnOf(
        older,
        newer,
        need("n1", {
          min_remaining_tokens: 40,
          preserve: { user_turns: 1, rounds: 1 },
          focus: "keep the cutoff",
        }),
      );
      return keepFloors(both.contextNeed, {});
    },
    want: { userTurns: 1, rounds: 1 },
  },
  {
    name: "warmOverflow",
    got: () => {
      const warmOverflow = gauge(91, 100);
      warmOverflow.warmUntilMs = Date.now() + 60_000;
      return {
        warm: warmOverflow.isWarm,
        decision: split(turnOccupied(warmOverflow, need("n1", { min_remaining_tokens: 10 }))),
      };
    },
    want: { warm: true, decision: { tail: "overflow", option: { focus: "" } } },
  },
  {
    name: "warmDeficit",
    got: () => {
      const warmDeficit = gauge(80, 100);
      warmDeficit.warmUntilMs = Date.now() + 60_000;
      return {
        warm: warmDeficit.isWarm,
        decision: split(turnOccupied(warmDeficit, need("n1", { min_remaining_tokens: 40 }))),
      };
    },
    want: { warm: true, decision: { tail: null, option: { focus: "" } } },
  },
  {
    name: "infeasibleHard",
    got: () => {
      const infeasibleHard = turnOccupied(
        gauge(91, 100),
        need("n1", { min_remaining_tokens: 40, preserve: { user_turns: 1 } }),
      );
      return {
        keep: keepTokens(infeasibleHard),
        feasible: needFeasible(infeasibleHard, infeasibleHard.contextNeed, keepTokens(infeasibleHard)),
        decision: split(infeasibleHard),
      };
    },
    want: { keep: 71, feasible: false, decision: { tail: "overflow", option: { focus: "" } } },
  },
  {
    name: "inherited",
    got: () => {
      const tailOk = turnOccupied(gauge(70, 100), need("n1", { min_remaining_tokens: 25 }));
      const inherited = chainedTurn(tailOk, gauge(80, 100));
      return { parent: split(tailOk), used: inherited.contextUsed, decision: split(inherited) };
    },
    want: {
      parent: { tail: null, option: null },
      used: 80,
      decision: { tail: null, option: { focus: "" } },
    },
  },
  {
    name: "liveZero",
    got: () => {
      const prior = turnOccupied(gauge(80, 100), need("n1", { min_remaining_tokens: 40 }));
      const liveZero = chainedTurn(prior, gauge(0, 100));
      return { used: liveZero.contextUsed, decision: split(liveZero) };
    },
    want: { used: 80, decision: { tail: null, option: { focus: "" } } },
  },
  {
    name: "spentLater",
    got: () => {
      const spent = turnOf(
        gauge(80, 100),
        need("n1", { min_remaining_tokens: 40, preserve: { user_turns: 8 }, focus: "spent" }),
        new CompactJob({ completed: true, reason: "need", standIn: "summary" }),
      );
      const laterOverflow = chainedTurn(spent, gauge(91, 100));
      return {
        floors: keepFloors(laterOverflow.contextNeed, {}),
        kvFloors: keepFloors(laterOverflow.contextNeed, { "compact.keep-turns": "2" }),
        decision: split(laterOverflow),
      };
    },
    want: {
      // No preserve and no kv: the mid-turn floor stands in — 0 would orphan
      // the in-flight exchange. The kv dial still raises it above the default.
      // The spent need does not start an ambient option.
      floors: { userTurns: 1, rounds: 1 },
      kvFloors: { userTurns: 2, rounds: 2 },
      decision: { tail: "overflow", option: null },
    },
  },
  {
    name: "raisedDial",
    got: () => {
      const raised = turnOccupied(gauge(91, 100), need("n1", { min_remaining_tokens: 40 }));
      return {
        defaultHard: split(raised, HARD),
        raised: split(raised, parseCompactTrigger("95%")),
        off: split(raised, parseCompactTrigger("")),
        wall: split(raised, parseCompactTrigger("100%")),
      };
    },
    // Hard splices the tail. Below the line the tail stays; the short runway
    // is still an ambient option even when the retain cannot free it.
    want: {
      defaultHard: { tail: "overflow", option: { focus: "" } },
      raised: { tail: null, option: { focus: "" } },
      off: { tail: null, option: { focus: "" } },
      wall: { tail: null, option: { focus: "" } },
    },
  },
  {
    name: "preserveOnly",
    got: () => split(turnOccupied(gauge(40, 100), need("n1", { min_remaining_tokens: 10, preserve: { rounds: 1 } }))),
    want: { tail: null, option: { focus: "" } },
  },
  {
    name: "plenty",
    got: () => split(turnOf(gauge(80, 100), need("n1", { min_remaining_tokens: 10 }))),
    want: { tail: null, option: null },
  },
  {
    name: "eq",
    got: () => split(turnOf(gauge(80, 100), need("n1", { min_remaining_tokens: 20 }))),
    want: { tail: null, option: null },
  },
  {
    name: "zero",
    got: () => split(turnOf(gauge(80, 100), need("n1", { min_remaining_tokens: 0 }))),
    want: { tail: null, option: null },
  },
  {
    name: "none",
    got: () => split(turnOf(need("n1", { min_remaining_tokens: 40 }))),
    want: { tail: null, option: null },
  },
  {
    name: "used0",
    got: () => split(turnOf(gauge(0, 100), need("n1", { min_remaining_tokens: 40 }))),
    want: { tail: null, option: null },
  },
  {
    name: "limit0",
    got: () => split(turnOf(gauge(80, 0), need("n1", { min_remaining_tokens: 40 }))),
    want: { tail: null, option: null },
  },
  {
    name: "settledOnly",
    got: () => split(turnOf(gauge(80, 100), need("n1", { current_phase_settled: true }))),
    want: { tail: null, option: null },
  },
  {
    name: "infeasible",
    got: () => {
      const infeasible = turnOf(gauge(80, 100), need("n1", { min_remaining_tokens: 40, preserve: { user_turns: 1 } }));
      return {
        keep: keepTokens(infeasible),
        feasible: needFeasible(infeasible, infeasible.contextNeed, keepTokens(infeasible)),
        decision: split(infeasible),
      };
    },
    want: { keep: 80, feasible: false, decision: { tail: null, option: null } },
  },
  {
    name: "already",
    got: () => {
      const already = turnOf(
        gauge(80, 100),
        need("n1", { min_remaining_tokens: 40 }),
        new CompactJob({ completed: true, reason: "need", standIn: "summary" }),
        need("n2", { min_remaining_tokens: 40 }),
      );
      return {
        need: already.contextNeed,
        rejected: compactRejectReason(already),
        decision: split(already),
      };
    },
    want: {
      need: { min_remaining_tokens: 40 },
      rejected: "already-compacted",
      decision: { tail: null, option: null },
    },
  },
  {
    name: "unfolded",
    got: () =>
      split(
        turnOccupied(
          gauge(80, 100),
          need("n1", { min_remaining_tokens: 40, focus: "keep" }),
          new CompactJob({ completed: false, reason: "need" }),
        ),
      ),
    want: { tail: null, option: { focus: "keep" } },
  },
  {
    name: "eatName",
    got: () =>
      compactRejectReason(
        turnOf(
          gauge(80, 100),
          new CompactJob({ completed: true, reason: "need", standIn: "summary" }),
          new SystemToolJob({
            triggersReactLoop: false,
            tapeHidden: true,
            toolCallId: "fake",
            name: CONTEXT_NEED_TOOL_NAME,
            argsJson: JSON.stringify({ min_remaining_tokens: 40 }),
          }),
        ),
      ),
    want: "already-compacted",
  },
  {
    name: "overlay",
    got: () => {
      const sliced = sliceCompactEat(Transcript.fromCells([gauge(40, 100, "one"), gauge(80, 100, "two")]), {
        userTurns: 0,
        rounds: 1,
      });
      return { prefixRounds: sliced.prefix.rounds().length, keepRounds: sliced.keep.rounds().length };
    },
    want: { prefixRounds: 1, keepRounds: 1 },
  },
];

test.each(occupancy)("compactDecision occupancy — $name", ({ got, want }) => {
  expect(got()).toEqual(want);
});
