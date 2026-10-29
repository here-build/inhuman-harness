/**
 * Reproduction for: preserve floors unbounded by the window veto hard overflow.
 *
 * `context_need` admits `preserve.rounds` clamped only at 10_000, never
 * relative to the session window. `sliceCompactEat` then yields an empty prefix
 * range, and `compactDecision` vetoes on keep-all BEFORE checking hard
 * overflow — so the model can disable the forced-compaction safety valve.
 * AD-7 (cohort-compaction-wiring README:186): "one dial, no second code path".
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { compactDue, keepFloors, sliceCompactEat, tailCompactCandidate, Transcript } from "../index.js";

/** Completion that stamps the window gauge `contextUsed`/`contextLimit` read from. */
function completion(used: number, total: number): CompletionJob {
  const expectation = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`hi`,
  });
  expectation.totalTokens = used;
  expectation.contextLimit = total;
  expectation.responseText = "ok";
  return new CompletionJob({ expectation });
}

function turnAt(used: number, total: number): SessionTurn {
  resetLocalIDs();
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [completion(used, total)],
    queue: [],
  });
}

function twoRoundEat(): Transcript {
  const t1 = new SystemToolJob({ toolCallId: "t1", name: "shell", argsJson: "{}" });
  const t2 = new SystemToolJob({ toolCallId: "t2", name: "shell", argsJson: "{}" });
  return Transcript.fromCells([t1, t2], 1000);
}

describe("compact keep-all", () => {
  it("oversized preserve floors are bounded; hard overflow still compacts", () => {
    // 95% of the window consumed; hard trigger at 0.9 is well past it.
    const turn = turnAt(950, 1000);
    expect(turn.contextUsed).toBe(950);
    expect(compactDue(turn, 0.9)).toBe(true);

    const eat = twoRoundEat();

    // preserve.rounds far exceeds the actual round count; the admit clamp is
    // 10_000, so this passes validation. Pre-fix this kept EVERYTHING, emptied
    // the prefix, and vetoed hard overflow (AD-7: "one dial").
    const floors = keepFloors({ preserve: { rounds: 10_000 } });
    const sliced = sliceCompactEat(eat, floors);

    // Post-fix: the floor is bounded to the window; one round stays in the prefix.
    expect(sliced.prefix.cells.length).toBeGreaterThan(0);
    expect(tailCompactCandidate(turn, 0.9, sliced)).toBe("overflow");
  });
});
