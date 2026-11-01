import { CompletionJob, SessionPlexus, SessionTurn } from "@inhuman.tools/harness-model";
import { expect, onTestFinished, test } from "vitest";

import { assessTextOnlyContinueIntern } from "../re-act-loop-intent-detected-trigger.js";
import {
  boundaries,
  configureJudge,
  liveSession,
  replicaOf,
  rounds,
  startTurn,
  wait,
} from "./fixtures/live-continuation.js";

const vote = (intent: boolean, awaiting_user = false) => JSON.stringify({ intent, awaiting_user });

// The provider port is controlled; assessment, expansion, reducer exit and replica projection are real.
test.each([
  {
    name: "final answer",
    reply: { text: vote(false) },
    status: "judged",
    verdict: "seal",
    incomplete: false,
    unfinished: "",
  },
  {
    name: "question",
    reply: { text: vote(true, true) },
    status: "judged",
    verdict: "question",
    incomplete: false,
    unfinished: "question",
  },
  {
    name: "failed judge",
    reply: { fail: "judge unavailable" },
    status: "failed",
    verdict: null,
    incomplete: true,
    unfinished: "",
  },
  {
    name: "invalid vote",
    reply: { text: '{"intent":true}' },
    status: "invalid",
    verdict: null,
    incomplete: true,
    unfinished: "",
  },
  {
    name: "unsupported schema",
    reply: { fail: "json_schema unsupported: judge" },
    status: "unsupported",
    verdict: null,
    incomplete: true,
    unfinished: "",
  },
])("persists $name independently of final-answer semantics", async (row) => {
  const live = await liveSession();
  await configureJudge(live);
  live.model.judge(row.reply);
  const { turn } = await startTurn(live);
  live.model.reply({ text: "Which files should I edit?" });
  await wait(() => turn.reducerExited);
  const replica = replicaOf(live.session);
  const restored = replica.root.head as SessionTurn;
  const assessment = boundaries(restored).at(-1)?.decision;
  expect({
    decision: assessment?.kind,
    reason: assessment?.reason,
    intent: assessment?.intent && { status: assessment.intent.status, verdict: assessment.intent.verdict },
    rounds: rounds(restored).length,
    incomplete: restored.lastTurnIncomplete,
    unfinished: replica.root.unfinished,
    question: restored.questionLine,
    judge: restored.children
      .filter((child) => child instanceof CompletionJob && child.expectation.completionMode === "isolated")
      .map((job) => ({ completed: job.completed, mode: (job as CompletionJob).expectation.completionMode })),
  }).toEqual({
    decision: "halt",
    reason: row.verdict === "question" ? "awaiting-user" : "no-trigger",
    intent: { status: row.status, verdict: row.verdict },
    rounds: 1,
    incomplete: row.incomplete,
    unfinished: row.unfinished,
    question: row.verdict === "question" ? "Which files should I edit?" : "",
    judge: [{ completed: true, mode: "isolated" }],
  });
});

test("caches unsupported schema only for that configured judge wire", async () => {
  const live = await liveSession();
  await configureJudge(live);
  live.model.judge({ fail: "json_schema unsupported: judge" });
  for (const expectedChildren of [1, 0]) {
    const { turn } = await startTurn(live);
    live.model.reply({ text: "I will edit now." });
    await wait(() => turn.reducerExited);
    expect({
      status: boundaries(turn).at(-1)?.decision?.intent?.status,
      children: turn.children.filter(
        (job) => job instanceof CompletionJob && job.expectation.completionMode === "isolated",
      ).length,
    }).toEqual({ status: "unsupported", children: expectedChildren });
  }
  await live.session.handleRequest("kv/set", { key: "judgeModel", value: "another-model" });
  const { turn } = await startTurn(live);
  live.model.judge({ text: vote(false) });
  live.model.reply({ text: "Done." });
  await wait(() => turn.reducerExited);
  expect({
    intent: boundaries(turn).at(-1)?.decision?.intent,
    children: turn.children.filter(
      (job) => job instanceof CompletionJob && job.expectation.completionMode === "isolated",
    ).length,
  }).toEqual({ intent: { status: "judged", verdict: "seal", detail: "" }, children: 1 });
});

test("the production judge deadline bounds a provider that ignores abort, and its late vote cannot resume the turn", async () => {
  const live = await liveSession();
  await configureJudge(live);
  let release!: () => void;
  live.model.judge({
    text: '{"intent":true,"awaiting_user":false}',
    ignoreAbort: true,
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  onTestFinished(() => release());
  const { turn } = await startTurn(live);
  live.model.reply({ text: "I will edit now." });
  await import("mobx").then(({ when }) => when(() => turn.reducerExited, { timeout: 35_000 }));
  const before = boundaries(turn).at(-1)?.decision;
  expect({ status: before?.intent?.status, rounds: rounds(turn).length, incomplete: turn.lastTurnIncomplete }).toEqual({
    status: "failed",
    rounds: 1,
    incomplete: true,
  });
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect({ decision: boundaries(turn).at(-1)?.decision, rounds: rounds(turn).length }).toEqual({
    decision: before,
    rounds: 1,
  });
}, 40_000);

test("an already-aborted assessment settles without dispatching the provider", async () => {
  const plexus = SessionPlexus.create("cancelled-assessment", "");
  onTestFinished(() => plexus.destroy());
  const turn = new SessionTurn({ queue: [] });
  plexus.root.head = turn;
  let dispatches = 0;
  const result = await assessTextOnlyContinueIntern({
    speech: "I will edit now.",
    wire: { connection: "judge", model: "fast", key: "judge\nfast" },
    haltKeys: new Set(),
    home: turn,
    signal: AbortSignal.abort(new Error("already cancelled")),
    complete: async () => {
      dispatches += 1;
      return { text: "" };
    },
  });
  const judge = turn.children[0] as CompletionJob;
  expect({ result, dispatches, completed: judge.completed, outcome: judge.expectation.outcome }).toEqual({
    result: { verdict: null, status: "failed", detail: "already cancelled" },
    dispatches: 0,
    completed: true,
    outcome: "failed",
  });
});
