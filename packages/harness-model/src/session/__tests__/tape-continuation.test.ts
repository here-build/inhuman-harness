/**
 * CompletionJob / Compact `.turnTail` is continuation, not parent.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";

import { CompletionExpectation, owningTurn } from "../expectations/CompletionExpectation.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { tapeTurn } from "../jobs/tape-continuation.js";
import { SessionPlexus } from "../SessionPlexus.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

function pew(text: string): CompletionExpectation {
  return new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${text}` });
}

describe("tape continuation", () => {
  beforeEach(() => resetLocalIDs());

  it("stamps predecessor on construct and enqueue; intern and remainder stay off-spine", () => {
    const plexus = SessionPlexus.create("tape-tail");
    try {
      const firstPew = pew("first");
      const first = new CompletionJob({ expectation: firstPew });
      const secondPew = pew("second");
      const second = new CompletionJob({ expectation: secondPew });
      const compact = new CompactJob({ reason: "overflow" });
      const thirdPew = pew("third");
      const third = new CompletionJob({ expectation: thirdPew });
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`hi`,
        doneWork: [first, second],
        queue: [],
      });
      plexus.root.head = turn;
      turn.enqueue(compact);
      turn.enqueue(third);

      const intern = new CompletionJob({
        expectation: new CompletionExpectation({
          connectionId: "c1",
          completionMode: "isolated",
          promptText: prompt.user`intern`,
        }),
      });
      turn.pushChild(intern);

      const tool = new SystemToolJob({ toolCallId: "t1", name: "echo" });
      const remainder = new CompletionJob({ expectation: pew("remainder"), turnTail: tool });

      const latePew = pew("late");
      const late = new CompletionJob({ expectation: latePew });
      const lateTurn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`late`,
        queue: [],
      });
      lateTurn.enqueue(late);
      plexus.root.head = lateTurn;

      expect({
        first: first.turnTail === turn,
        second: second.turnTail === first,
        third: third.turnTail === second,
        tape: [tapeTurn(first), tapeTurn(second), tapeTurn(third)].every((cell) => cell === turn),
        intern: { tail: intern.turnTail, turn: tapeTurn(intern) },
        remainder: { tail: remainder.turnTail === tool, turn: tapeTurn(remainder) },
        late: { tail: late.turnTail === lateTurn, turn: tapeTurn(late) === lateTurn },
        owning: owningTurn(thirdPew) === turn,
      }).toEqual({
        first: true,
        second: true,
        third: true,
        tape: true,
        intern: { tail: null, turn: null },
        remainder: { tail: true, turn: null },
        late: { tail: true, turn: true },
        owning: true,
      });
    } finally {
      plexus.destroy();
    }
  });
});
