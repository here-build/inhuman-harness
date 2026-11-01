import { CompletionExpectation, CompletionJob, SessionTurn, responseCall } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import {
  internJudgeWire,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  THOUGHT_CONTINUE_NOTE,
  thoughtWithoutAnswer,
} from "../re-act-loop-intent-detected-trigger.js";
import {
  boundaries,
  configureJudge,
  liveSession,
  replicaOf,
  rounds,
  startTurn,
  wait,
} from "./fixtures/live-continuation.js";

const intentDecisions = (turn: SessionTurn) =>
  boundaries(turn).flatMap((cell) => cell.decision?.assessments.filter((item) => item.cause.kind === "intent") ?? []);

test("judge configuration requires an explicit wire and uses that wire's configured model", () => {
  expect([
    internJudgeWire({ connection: "actor", model: "actor-model" }, {}, () => "configured"),
    internJudgeWire({ judgeConnection: "judge" }, {}, () => "configured"),
    internJudgeWire({ judgeConnection: "judge", judgeModel: "fast" }, {}, () => "ignored"),
  ]).toEqual([
    null,
    { connection: "judge", model: "configured", key: "judge\nconfigured" },
    { connection: "judge", model: "fast", key: "judge\nfast" },
  ]);
});

test("all provider reasoning channels require an answer but spoken text ends that condition", () => {
  const samples = [
    { responseThought: "plan" },
    { responseText: "<think>plan</think>" },
    { responseReasoningEncrypted: "encrypted" },
    { reasoningTokens: 128 },
    { responseThoughtKind: "raw" as const },
    { responseText: "Done", responseThought: "plan" },
    {},
  ];
  expect(
    samples.map((fields) =>
      thoughtWithoutAnswer(Object.assign(new CompletionExpectation({ connectionId: "c1" }), fields)),
    ),
  ).toEqual([true, true, true, true, true, false, false]);
});

test("promised work with metadata consumes its persisted intent allowance and then offers continuation", async () => {
  const live = await liveSession();
  await configureJudge(live);
  const { turn } = await startTurn(live);
  for (let index = 0; index < 3; index += 1) {
    live.model.judge({ text: JSON.stringify({ intent: true, awaiting_user: false }) });
    live.model.reply({
      text: "I will inspect the files now.",
      calls: [
        responseCall(`need-${index}`, "context_need", JSON.stringify({ current_phase_settled: index % 2 === 0 })),
      ],
    });
    await wait(() => (index < 2 ? rounds(turn).length === index + 2 : turn.reducerExited));
    expect({
      phase: index,
      assessments: intentDecisions(turn).map(({ disposition, budget }) => ({ disposition, budget })),
      nextNote: rounds(turn)[index + 1]?.expectation.systemNote ?? null,
      exited: turn.reducerExited,
    }).toEqual({
      phase: index,
      assessments: Array.from({ length: index + 1 }, (_, used) => ({
        disposition: used === 2 ? "exhausted" : "eligible",
        budget: { used, limit: 2 },
      })),
      nextNote: index < 2 ? RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE : null,
      exited: index === 2,
    });
  }
  const replica = replicaOf(live.session);
  expect({
    reason: boundaries(replica.root.head as SessionTurn).at(-1)?.decision?.reason,
    incomplete: (replica.root.head as SessionTurn).lastTurnIncomplete,
  }).toEqual({ reason: "trigger-budget", incomplete: true });
});

test("reasoning repairs work without a judge and stop after their persisted allowance", async () => {
  const live = await liveSession();
  live.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = false;
  const { turn } = await startTurn(live);
  for (let index = 0; index < 9; index += 1) {
    live.model.reply(index % 2 === 0 ? { thought: "plan" } : { text: "<think>still planning</think>" });
    await wait(() => (index < 8 ? rounds(turn).length === index + 2 : turn.reducerExited));
  }
  const replica = replicaOf(live.session);
  const restored = replica.root.head as SessionTurn;
  expect({
    rounds: rounds(restored).length,
    notes: rounds(restored)
      .slice(1)
      .map((job) => job.expectation.systemNote.includes(THOUGHT_CONTINUE_NOTE)),
    final: boundaries(restored).at(-1)?.decision,
    judgeChildren: restored.children.filter(
      (job) => job instanceof CompletionJob && job.expectation.completionMode === "isolated",
    ).length,
    incomplete: restored.lastTurnIncomplete,
  }).toMatchObject({
    rounds: 9,
    notes: Array.from({ length: 8 }, () => true),
    final: {
      kind: "halt",
      reason: "trigger-budget",
      assessments: [{ cause: { kind: "thought-repair" }, budget: { used: 8, limit: 8 }, disposition: "exhausted" }],
    },
    judgeChildren: 0,
    incomplete: true,
  });
});
