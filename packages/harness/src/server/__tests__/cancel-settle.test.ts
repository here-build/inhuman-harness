/**
 * A cancelled turn must not keep a live CompletionExpectation.
 *
 * `turn.openWork` sees an unset `outcome`, so the omnibox stays on the busy face
 * while `findRunningTurn()` is null on a closed head: Esc then advertises
 * "cancel current turn" and no-ops. `lastTurnIncomplete` is blocked by the same open
 * work, so there is no UI escape — the session wedges. This reproduces the
 * "Atria cache-policy auto-detection probe" state: head closed with
 * `cancelRequested`, a steer marooned in `steerQueue`, and a round that never
 * settled.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitSteer,
  CompletionExpectation,
  CompletionJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { settleCancelledTurn } from "@inhuman.tools/turn/agent-calls";
import { beforeEach, describe, expect, it } from "vitest";

import { recoverSessionJobs } from "@/runtime";

describe("cancel settlement", () => {
  beforeEach(() => resetLocalIDs());

  /** Head closed with the cancel requested and a round that never landed. */
  function wedged(): {
    readonly root: SessionRoot;
    readonly turn: SessionTurn;
    readonly round: CompletionExpectation;
  } {
    const root = new SessionRoot({ sessionId: "s-wedge", path: "/tmp/demo" });
    const round = new CompletionExpectation({ connectionId: "atria-asi-ai" });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user``,
      doneWork: [new CompletionJob({ expectation: round })],
      queue: [],
    });
    root.head = turn;
    admitSteer(root, prompt.user`conted`, "");
    turn.cancelRequested = true;
    turn.reducerExited = true;
    return { root, turn, round };
  }

  it("the wedged state has no UI escape", () => {
    const { root, turn } = wedged();
    expect({
      openWork: turn.openWork,
      running: root.findRunningTurn(),
      continue: turn.lastTurnIncomplete,
      steerQueue: root.steerQueue.length,
    }).toEqual({ openWork: true, running: null, continue: false, steerQueue: 1 });
  });

  it("settleCancelledTurn fails a dangling completion", () => {
    const { turn, round } = wedged();

    settleCancelledTurn(turn);

    expect({
      outcome: round.outcome,
      isDone: round.isDone,
      openWork: turn.openWork,
      continue: turn.lastTurnIncomplete,
    }).toEqual({ outcome: "failed", isDone: true, openWork: false, continue: true });
  });

  it.each([false, true])("recovery settles a closed cancelled turn (completed: %s)", (completed) => {
    const { root, turn, round } = wedged();
    if (completed) turn.markComplete();

    // A closed turn is not resumable work, but its cancel still has to land.
    recoverSessionJobs(root);

    expect({
      outcome: round.outcome,
      isDone: round.isDone,
      openWork: turn.openWork,
      continue: turn.lastTurnIncomplete,
    }).toEqual({ outcome: "failed", isDone: true, openWork: false, continue: true });
  });
});
