/**
 * CompletionJob / Compact `.turnTail` is continuation, not parent.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import { describe, expect, it } from "vitest";

import { CompletionExpectation, owningTurn } from "../expectations/CompletionExpectation.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { tapeTurn } from "../jobs/tape-continuation.js";
import { SessionDocument } from "../SessionDocument.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

function completion(text: string): CompletionExpectation {
  return new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${text}` });
}

describe("tape continuation", () => {
  it("stamps predecessor on construct and enqueue; intern and remainder stay off-spine", () => {
    const doc = SessionDocument.create("tape-tail");
    try {
      const firstExpectation = completion("first");
      const first = new CompletionJob({ expectation: firstExpectation });
      const secondExpectation = completion("second");
      const second = new CompletionJob({ expectation: secondExpectation });
      const compact = new CompactJob({ reason: "overflow" });
      const thirdExpectation = completion("third");
      const third = new CompletionJob({ expectation: thirdExpectation });
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`hi`,
        doneWork: [first, second],
        queue: [],
      });
      doc.root.head = turn;
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
      const remainder = new CompletionJob({ expectation: completion("remainder"), turnTail: tool });

      const lateExpectation = completion("late");
      const late = new CompletionJob({ expectation: lateExpectation });
      const lateTurn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`late`,
        queue: [],
      });
      lateTurn.enqueue(late);
      doc.root.head = lateTurn;

      expect({
        first: first.turnTail === turn,
        second: second.turnTail === first,
        third: third.turnTail === second,
        tape: [tapeTurn(first), tapeTurn(second), tapeTurn(third)].every((cell) => cell === turn),
        intern: { tail: intern.turnTail, turn: tapeTurn(intern) },
        remainder: { tail: remainder.turnTail === tool, turn: tapeTurn(remainder) },
        late: { tail: late.turnTail === lateTurn, turn: tapeTurn(late) === lateTurn },
        owning: owningTurn(thirdExpectation) === turn,
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
      doc.destroy();
    }
  });
});
