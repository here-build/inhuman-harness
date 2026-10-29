import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  ReACTChunk,
  responseCall,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  tapeCompletion,
  type TurnChunk,
} from "@inhuman.tools/harness-model";
import { RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_STREAK_MAX } from "@inhuman.tools/harness-model/shared";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { expect, onTestFinished, test, vi } from "vitest";

import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import {
  internContinueStreak,
  internJudgeWire,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  THOUGHT_CONTINUE_NOTE,
  THOUGHT_WITHOUT_ANSWER_STREAK_MAX,
  thoughtWithoutAnswer,
  thoughtWithoutAnswerCapped,
  verdictOf,
} from "../re-act-loop-intent-detected-trigger.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 4_000;

test("internJudgeWire does not fall through to the actor", () => {
  expect(internJudgeWire({ connection: "c1", model: "grok-4.6" }, {}, () => "configured")).toBeNull();
  expect(internJudgeWire({ judgeConnection: "j" }, {}, () => "m")).toEqual({
    connection: "j",
    model: "m",
    key: "j\nm",
  });
  expect(internJudgeWire({ judgeConnection: "j", judgeModel: "fast" }, {}, () => "ignored")).toEqual({
    connection: "j",
    model: "fast",
    key: "j\nfast",
  });
});

test("verdictOf: ask wins, intent continues, else seal", () => {
  expect(verdictOf({ intent: true, awaiting_user: true })).toBe("question");
  expect(verdictOf({ intent: false, awaiting_user: true })).toBe("question");
  expect(verdictOf({ intent: true, awaiting_user: false })).toBe("continue");
  expect(verdictOf({ intent: false, awaiting_user: false })).toBe("seal");
});

test("thoughtWithoutAnswer: a thinking channel with no spoken answer is still working", () => {
  const pew = (
    text: string,
    extra?: { thought?: string; encrypted?: string; tokens?: number; kind?: "raw" | "summary" },
  ): CompletionExpectation => {
    const node = new CompletionExpectation({ connectionId: "c1" });
    node.responseText = text;
    node.responseThought = extra?.thought ?? "";
    node.responseReasoningEncrypted = extra?.encrypted ?? "";
    node.reasoningTokens = extra?.tokens ?? null;
    node.responseThoughtKind = extra?.kind ?? null;
    return node;
  };
  expect({
    thought: thoughtWithoutAnswer(pew("", { thought: "I should plan the edit." })),
    thinkTag: thoughtWithoutAnswer(pew("<think>plan the edit</think>")),
    encrypted: thoughtWithoutAnswer(pew("", { encrypted: "enc-blob" })),
    tokens: thoughtWithoutAnswer(pew("", { tokens: 128 })),
    kind: thoughtWithoutAnswer(pew("", { kind: "raw" })),
    spoken: thoughtWithoutAnswer(pew("Done.", { thought: "I should plan the edit." })),
    empty: thoughtWithoutAnswer(pew("")),
  }).toEqual({
    thought: true,
    thinkTag: true,
    encrypted: true,
    tokens: true,
    kind: true,
    spoken: false,
    empty: false,
  });
});

test("thoughtWithoutAnswerCapped counts consecutive thought-only rounds", () => {
  const thought = (text: string): CompletionJob => {
    const node = new CompletionExpectation({ connectionId: "c1" });
    node.responseText = "";
    node.responseThought = text;
    return new CompletionJob({ expectation: node });
  };
  const speech = (): CompletionJob => {
    const node = new CompletionExpectation({ connectionId: "c1" });
    node.responseText = "Done.";
    return new CompletionJob({ expectation: node });
  };
  const onlyThoughts = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`implement it`,
    doneWork: Array.from({ length: THOUGHT_WITHOUT_ANSWER_STREAK_MAX }, (_, index) => thought(`plan ${index}`)),
  });
  const oneOver = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`implement it`,
    doneWork: Array.from({ length: THOUGHT_WITHOUT_ANSWER_STREAK_MAX + 1 }, (_, index) => thought(`plan ${index}`)),
  });
  const broken = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`implement it`,
    doneWork: [thought("plan"), new SystemToolJob({ name: "echo", toolCallId: "call_1" }), thought("plan again")],
  });
  const answered = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`implement it`,
    doneWork: [thought("plan"), speech(), thought("plan again")],
  });
  expect({
    atCap: thoughtWithoutAnswerCapped(onlyThoughts),
    over: thoughtWithoutAnswerCapped(oneOver),
    afterTool: thoughtWithoutAnswerCapped(broken),
    afterSpeech: thoughtWithoutAnswerCapped(answered),
  }).toEqual({ atCap: false, over: true, afterTool: false, afterSpeech: false });
});

test("internContinueStreak counts intern continues since the last work tool, not thought-only ones", () => {
  const said = (text: string, thought = ""): CompletionJob => {
    const node = new CompletionExpectation({ connectionId: "c1" });
    node.responseText = text;
    node.responseThought = thought;
    return new CompletionJob({ expectation: node });
  };
  const nudge = (): ReACTChunk => new ReACTChunk({ intentContinue: true });
  const tape = (...doneWork: TurnChunk[]) =>
    internContinueStreak(
      new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`go`, doneWork, queue: [] }),
    );
  expect({
    two: tape(said("I'll edit."), nudge(), said("I'll write."), nudge(), said("Really.")),
    thought: tape(said("", "plan"), nudge(), said("<think>plan</think>"), nudge(), said("I'll edit."), nudge()),
    afterWork: tape(said("I'll edit."), nudge(), new SystemToolJob({ name: "echo", toolCallId: "t" }), said("Done.")),
    sideChannel: tape(
      said("I'll edit."),
      new SystemToolJob({ name: "update_metadata", toolCallId: "m", triggersReactLoop: false }),
      nudge(),
    ),
  }).toEqual({ two: 2, thought: 1, afterWork: 0, sideChannel: 1 });
});

test("text-only intern continue, question, disabled flag, streak cap", async () => {
  resetLocalIDs();
  const session = await openSession();
  session.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = true;
  await session.handleRequest("kv/set", { key: "judgeConnection", value: "c1" });
  await session.handleRequest("kv/set", { key: "judgeModel", value: "fast" });

  const votes: Array<{ intent: boolean; awaiting_user: boolean } | "throw"> = [
    { intent: true, awaiting_user: false },
    { intent: true, awaiting_user: false },
    { intent: true, awaiting_user: false },
  ];
  stubIntern(session, () => votes.shift() ?? { intent: false, awaiting_user: false });

  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`implement it` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "I'll edit foo.ts now." });
  await when(() => actorPews(turn).length === 2, { timeout: TIMEOUT });
  const afterFirst = {
    streak: internContinueStreak(turn),
    note: actorPews(turn)[1]!.systemNote,
    reducerExited: turn.reducerExited,
  };
  modelOf(session).reply({ text: "I'll write it next." });
  await when(() => actorPews(turn).length === 3, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "I'll really do it." });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
  const capped = {
    streak: internContinueStreak(turn),
    reducerExited: turn.reducerExited,
    internCalls: 3 - votes.length,
    question: turn.questionLine,
  };

  const ask = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`maybe later` });
  votes.length = 0;
  votes.push({ intent: true, awaiting_user: true });
  session.root.head = ask;
  await when(() => actorPews(ask).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "Want me to proceed?" });
  await when(() => ask.reducerExited, { timeout: TIMEOUT });
  const questioned = {
    reducerExited: ask.reducerExited,
    line: ask.questionLine,
    unfinished: session.root.unfinished,
  };

  session.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = false;
  const off = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hello` });
  session.root.head = off;
  await when(() => actorPews(off).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "I'll edit anyway." });
  await when(() => off.reducerExited, { timeout: TIMEOUT });

  expect({
    afterFirst,
    capped,
    questioned,
    off: { reducerExited: off.reducerExited, streak: internContinueStreak(off) },
    max: RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_STREAK_MAX,
  }).toEqual({
    afterFirst: {
      streak: 1,
      note: RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
      reducerExited: false,
    },
    capped: { streak: 2, reducerExited: true, internCalls: 2, question: "" },
    questioned: {
      reducerExited: true,
      line: "Want me to proceed?",
      unfinished: "question",
    },
    off: { reducerExited: true, streak: 0 },
    max: 2,
  });
}, 20_000);

test("speech with only context_need seals without asking the intern", async () => {
  const session = await openSession();
  await session.handleRequest("kv/set", { key: "judgeConnection", value: "c1" });
  await session.handleRequest("kv/set", { key: "judgeModel", value: "fast" });
  const vote = vi.fn(() => ({ intent: true, awaiting_user: false }));
  stubIntern(session, vote);

  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`how does copy work` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({
    calls: [responseCall("call_need", "context_need")],
    text: "The array is the document. One question remains: what the clipboard holds.",
  });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
  expect({
    vote: vote.mock.calls.length,
    streak: internContinueStreak(turn),
    rounds: actorPews(turn).length,
    reducerExited: turn.reducerExited,
  }).toEqual({ vote: 0, streak: 0, rounds: 1, reducerExited: true });
}, 20_000);

test("intent speech with update_metadata continues and resolves judgeConnection model from kvs/live when judgeModel is unset", async () => {
  resetLocalIDs();
  const session = await openSession();
  session.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = true;
  await session.handleRequest("kv/set", { key: "judgeConnection", value: scriptedConnectionId() });
  const vote = vi.fn(() => ({ intent: true, awaiting_user: false }));
  stubIntern(session, vote);

  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`inspect files` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({
    calls: [
      responseCall(
        "call_meta",
        "update_metadata",
        JSON.stringify({
          title: "Inspect files",
          turn_description: "inspecting",
        }),
      ),
    ],
    text: "I will inspect the files now.",
  });
  await when(() => actorPews(turn).length === 2, { timeout: TIMEOUT });
  expect({
    voteCalls: vote.mock.calls.length,
    streak: internContinueStreak(turn),
    note: actorPews(turn)[1]!.systemNote,
    reducerExited: turn.reducerExited,
  }).toEqual({
    voteCalls: 1,
    streak: 1,
    note: RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
    reducerExited: false,
  });
  vote.mockReturnValue({ intent: false, awaiting_user: false });
  modelOf(session).reply({ text: "All files inspected." });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
}, 20_000);

test("inline <think> tags in responseText do not seal context_need or titled-only rounds", async () => {
  resetLocalIDs();
  const session = await openSession();
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`check context` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({
    calls: [responseCall("call_need", "context_need", JSON.stringify({ tokens: 1000, reason: "more" }))],
    text: "<think>Need more context before answering.</think>",
  });
  await when(() => actorPews(turn).length === 2, { timeout: TIMEOUT });
  expect(turn.reducerExited).toBe(false);
  modelOf(session).reply({ text: "Here is the answer." });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
}, 20_000);

test.each(["promise", "question", "finished"] as const)("classifies %s after work tools", async (kind) => {
  const session = await openSession();
  await session.handleRequest("kv/set", { key: "judgeConnection", value: "c1" });
  await session.handleRequest("kv/set", { key: "judgeModel", value: "fast" });
  const vote = vi.fn(() => ({ intent: kind === "promise", awaiting_user: kind === "question" }));
  stubIntern(session, vote);

  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`implement and test it` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ calls: [responseCall("call_1", "echo")] });
  await when(() => turn.work.some((chunk) => chunk instanceof SystemToolJob), { timeout: TIMEOUT });
  const tool = turn.work.find((chunk) => chunk instanceof SystemToolJob)!;
  tool.receiptJson = JSON.stringify({ ok: true, text: "ok" });
  tool.humanApprove = false;
  await when(() => actorPews(turn).length === 2, { timeout: TIMEOUT });
  expect(internContinueStreak(turn)).toBe(0);
  const text =
    kind === "promise" ? "I will write tests now." : kind === "question" ? "Which tests should I run?" : "Done.";
  modelOf(session).reply({ text });
  await when(() => turn.reducerExited || actorPews(turn).length === 3, { timeout: TIMEOUT });
  expect(vote).toHaveBeenCalledTimes(1);
  if (kind === "promise") {
    expect(turn.reducerExited).toBe(false);
    expect(internContinueStreak(turn)).toBe(1);
    expect(actorPews(turn)[2]!.systemNote).toBe(RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE);
    vote.mockReturnValue({ intent: false, awaiting_user: false });
    modelOf(session).reply({ text: "Done." });
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
  }
  expect(turn.questionLine).toBe(kind === "question" ? text : "");
});

test("thought without an answer continues without a judge, the intern flag, or the intern streak", async () => {
  resetLocalIDs();
  const session = await openSession();
  session.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = false;

  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`implement it` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "", thought: "I should plan the edit." });
  await when(() => actorPews(turn).length === 2, { timeout: TIMEOUT });
  const afterFirst = {
    streak: internContinueStreak(turn),
    note: actorPews(turn)[1]!.systemNote,
    reducerExited: turn.reducerExited,
  };
  modelOf(session).reply({ text: "<think>still planning</think>" });
  await when(() => actorPews(turn).length === 3, { timeout: TIMEOUT });
  const afterSecond = { streak: internContinueStreak(turn), reducerExited: turn.reducerExited };
  modelOf(session).reply({ text: "Done." });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });

  expect({
    afterFirst,
    afterSecond,
    sealed: { streak: internContinueStreak(turn), reducerExited: turn.reducerExited },
  }).toEqual({
    afterFirst: {
      streak: 0,
      note: THOUGHT_CONTINUE_NOTE,
      reducerExited: false,
    },
    afterSecond: { streak: 0, reducerExited: false },
    sealed: { streak: 0, reducerExited: true },
  });
}, 20_000);

test("encrypted reasoning without speech continues without a judge", async () => {
  resetLocalIDs();
  const session = await openSession();
  session.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = false;

  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`implement it` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  const first = actorPews(turn)[0]!;
  first.responseReasoningEncrypted = "enc-blob";
  modelOf(session).reply({ text: "" });
  await when(() => actorPews(turn).length === 2, { timeout: TIMEOUT });
  const continued = {
    reducerExited: turn.reducerExited,
    note: actorPews(turn)[1]!.systemNote,
    streak: internContinueStreak(turn),
  };
  modelOf(session).reply({ text: "Done." });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });

  expect({ ...continued, sealed: turn.reducerExited }).toEqual({
    reducerExited: false,
    note: THOUGHT_CONTINUE_NOTE,
    streak: 0,
    sealed: true,
  });
}, 20_000);

test("thought after a work tool continues", async () => {
  resetLocalIDs();
  const session = await openSession();
  session.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = false;

  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`use echo` });
  session.root.head = turn;
  await when(() => actorPews(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ calls: [responseCall("call_1", "echo")] });
  await when(() => turn.work.some((chunk) => chunk instanceof SystemToolJob), { timeout: TIMEOUT });
  const tool = turn.work.find((chunk) => chunk instanceof SystemToolJob)!;
  tool.receiptJson = JSON.stringify({ ok: true, text: "ok" });
  tool.humanApprove = false;
  await when(() => actorPews(turn).length === 2, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "", thought: "The echo landed. Next I edit." });
  await when(() => actorPews(turn).length === 3, { timeout: TIMEOUT });
  const continued = {
    reducerExited: turn.reducerExited,
    note: actorPews(turn)[2]!.systemNote,
    streak: internContinueStreak(turn),
  };
  modelOf(session).reply({ text: "Done." });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });

  expect(continued).toEqual({
    reducerExited: false,
    note: THOUGHT_CONTINUE_NOTE,
    streak: 0,
  });
}, 20_000);

function actorPews(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of turn.doneWork) {
    if (chunk instanceof ReACTChunk) continue;
    const pew = tapeCompletion(chunk);
    if (pew != null && pew.completionMode !== "isolated") out.push(pew);
  }
  for (const chunk of turn.queue) {
    const pew = tapeCompletion(chunk);
    if (pew != null && pew.completionMode !== "isolated") out.push(pew);
  }
  return out;
}

function stubIntern(session: SessionDaemon, next: () => { intent: boolean; awaiting_user: boolean } | "throw"): void {
  const flights = new Map<CompletionExpectation, Promise<{ text: string }>>();
  const complete = session.orchestrator.complete.bind(session.orchestrator);
  vi.spyOn(session.orchestrator, "complete").mockImplementation((req) => {
    if (req.round.completionMode !== "isolated") return complete(req);
    const pending = flights.get(req.round);
    if (pending !== undefined) return pending;
    const flight = (async () => {
      const vote = next();
      if (vote === "throw") throw new Error("intern boom");
      const text = JSON.stringify(vote);
      req.round.succeed("settled", "", "null", { result: { text } });
      return { text };
    })();
    flights.set(req.round, flight);
    return flight;
  });
}

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-toc-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-toc-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  return session;
}
