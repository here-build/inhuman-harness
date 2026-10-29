/**
 * One turn close. Every ending closes what is open under the turn; a finish
 * leaves background work alone; the record of a failure lands on the turn.
 */
import { resetLocalIDs } from "@here.build/plexus";
import {
  CompletionExpectation,
  CompletionJob,
  SessionAdmission,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { closeTurn, forceStopLoop } from "../index.js";
import { sessionOf } from "./fixtures.js";

function openTurn(): { turn: SessionTurn; pew: CompletionExpectation; tool: SystemToolJob } {
  const pew = new CompletionExpectation({ connectionId: "c", model: "m" });
  const tool = new SystemToolJob({ toolCallId: "t1", name: "echo", argsJson: "{}", humanApprove: true });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    doneWork: [new CompletionJob({ expectation: pew }), tool],
  });
  return { turn, pew, tool };
}

function row(against: string): SessionAdmission {
  return new SessionAdmission({ text: "x" as never, composedAtMs: 1, composedAgainst: against });
}

describe("closeTurn", () => {
  beforeEach(() => resetLocalIDs());

  it("a broke ending records the error and closes the open completion and tool", () => {
    const { turn, pew, tool } = openTurn();
    sessionOf("broke").root.head = turn;
    closeTurn(turn, { kind: "broke", detail: "history exploded" });
    expect({
      broke: turn.broke,
      exited: turn.reducerExited,
      completed: turn.completed,
      pewDone: pew.isDone,
      toolCompleted: tool.completed,
    }).toEqual({ broke: "history exploded", exited: true, completed: true, pewDone: true, toolCompleted: true });
  });

  it("a finish leaves open work alone", () => {
    const { turn, pew, tool } = openTurn();
    sessionOf("finish").root.head = turn;
    closeTurn(turn, { kind: "finish" });
    expect({
      exited: turn.reducerExited,
      pewDone: pew.isDone,
      toolCompleted: tool.completed,
      broke: turn.broke,
    }).toEqual({ exited: true, pewDone: false, toolCompleted: false, broke: "" });
  });

  it("a cancel acks with cancelled and moves the steers composed against the turn to the queue lane", () => {
    const { turn } = openTurn();
    const root = sessionOf("cancel").root;
    root.head = turn;
    turn.cancelRequested = true;
    root.steerQueue.push(row(turn.uuid), row("later"));
    closeTurn(turn, { kind: "cancel" }, { session: root });
    expect({
      cancelled: turn.cancelled,
      steers: root.steerQueue.map((steer) => steer.composedAgainst),
      prompts: root.promptQueue.length,
    }).toEqual({ cancelled: true, steers: ["later"], prompts: 1 });
  });

  it("a finish demotes its own steers to the queue lane", () => {
    const { turn } = openTurn();
    const root = sessionOf("demote").root;
    root.head = turn;
    root.steerQueue.push(row(turn.uuid));
    closeTurn(turn, { kind: "finish" }, { session: root });
    expect({ steers: root.steerQueue.length, prompts: root.promptQueue.length }).toEqual({ steers: 0, prompts: 1 });
  });

  it("the close of a turn that is not on the live chain does not touch the inbox", () => {
    const { turn } = openTurn();
    const root = sessionOf("rewound").root;
    root.head = turn;
    const owner = turn.uuid;
    root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [] });
    root.steerQueue.push(row(owner));
    closeTurn(turn, { kind: "rewound" }, { session: root });
    expect({ steers: root.steerQueue.length, prompts: root.promptQueue.length, exited: turn.reducerExited }).toEqual({
      steers: 1,
      prompts: 0,
      exited: true,
    });
  });

  it("forceStopLoop fails the completion it leaves open", () => {
    const { turn, pew } = openTurn();
    const root = sessionOf("forced").root;
    root.head = turn;
    forceStopLoop(root);
    expect({ exited: turn.reducerExited, pewDone: pew.isDone, endCause: pew.endCause }).toEqual({
      exited: true,
      pewDone: true,
      endCause: "cancel",
    });
  });
});
