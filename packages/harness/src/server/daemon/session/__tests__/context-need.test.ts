/**
 * Live completion-case enqueue and slash mint. compactDecision occupancy
 * is the combinatorial matrix in context-need-decision.test.ts.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitSteer,
  CONTEXT_NEED_TOOL_NAME,
  CompletionExpectation,
  CompletionJob,
  ContextNeedToolJob,
  responseCall,
  reactChunks,
  ReACTChunk,
  SessionSystemPrompt,
  SessionTurn,
  tapeCompletion,
  CompactJob,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { historyBehind } from "@/context";

import {
  useKeepFirstCompact,
  attachScriptedModel,
  modelOf,
  scriptedConnectionId,
} from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

/** Vitest's 15s testTimeout is the outer bound; these guards only poll MobX
 * state, so a generous budget keeps a loaded machine from tripping them. */
const TIMEOUT = 10_000;

function completionsOf(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

function compactOf(turn: SessionTurn): CompactJob | undefined {
  return reactChunks(turn).find((chunk): chunk is CompactJob => chunk instanceof CompactJob);
}

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-need-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-need-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  useKeepFirstCompact(kernel, system);
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

function needCall(id: string, args: Record<string, unknown>) {
  return [responseCall(id, CONTEXT_NEED_TOOL_NAME, JSON.stringify(args))];
}

function mixedCall(needId: string, tokens: number, toolId: string) {
  return [
    responseCall(needId, CONTEXT_NEED_TOOL_NAME, JSON.stringify({ min_remaining_tokens: tokens })),
    responseCall(toolId, "list_dir", JSON.stringify({ path: "." })),
  ];
}

async function runRound(
  session: SessionDaemon,
  promptText: string,
  used: number,
  limit: number,
  calls: ReturnType<typeof needCall>,
): Promise<{ readonly turn: SessionTurn }> {
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`${promptText}` });
  session.root.head = turn;
  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  const first = completionsOf(turn)[0]!;
  first.totalTokens = used;
  first.contextLimit = limit;
  modelOf(session).reply({ calls, text: "" });
  // A Job is thenable. Returning it here would settle to its result, not the turn.
  return { turn };
}

/** An empty context_need keeps the loop. A spoken answer seals it. */
async function sealAfterNeed(session: SessionDaemon, turn: SessionTurn): Promise<void> {
  await when(() => completionsOf(turn).length >= 2, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "done" });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
}

describe("context_need loop", () => {
  beforeEach(() => resetLocalIDs());

  it("text-only overflow compacts and re-enters the loop", async () => {
    const session = await openSession();
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`plan` });
    session.root.head = turn;
    await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({
      text: "looking",
      calls: [responseCall("r1", "list_dir", JSON.stringify({ path: "." }))],
    });
    await when(() => completionsOf(turn).length === 2, { timeout: TIMEOUT });
    const second = completionsOf(turn)[1]!;
    second.totalTokens = 95;
    second.contextLimit = 100;
    modelOf(session).reply({ text: "the head row is gone" });
    await when(() => completionsOf(turn).length === 3, { timeout: TIMEOUT });
    const compact = compactOf(turn);
    const chunks = reactChunks(turn);
    const compactAt = compact == null ? -1 : chunks.indexOf(compact);
    const followed = chunks.slice(compactAt + 1).some((chunk) => tapeCompletion(chunk) != null);
    const third = completionsOf(turn)[2]!;
    third.totalTokens = 10;
    third.contextLimit = 100;
    modelOf(session).reply({ text: "ok" });
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
    expect({
      reason: compact?.reason,
      cutoff: compact?.cutoff === true,
      followed,
      incomplete: turn.lastTurnIncomplete,
    }).toEqual({ reason: "overflow", cutoff: true, followed: true, incomplete: false });
  });

  it("completion case: quiet, mixed ReACT, deficit cutoff, compact-then-ReACT, overflow-only, steer, live dial; slash mint inherits a live need", async () => {
    const session = await openSession();

    const { turn: quiet } = await runRound(session, "plan", 50, 100, needCall("n1", { min_remaining_tokens: 10 }));
    await sealAfterNeed(session, quiet);

    const { turn: mixed } = await runRound(session, "use echo", 50, 100, mixedCall("n2", 10, "r1"));
    await when(() => completionsOf(mixed).length === 2, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    await when(() => mixed.reducerExited, { timeout: TIMEOUT });

    const { turn: deficit } = await runRound(
      session,
      "plan",
      80,
      100,
      needCall("n3", { min_remaining_tokens: 40, focus: "keep the cutoff" }),
    );
    await sealAfterNeed(session, deficit);
    const deficitChunk = compactOf(deficit);

    const { turn: mixedDeficit } = await runRound(session, "use echo", 80, 100, mixedCall("n4", 40, "r2"));
    await when(() => reactChunks(mixedDeficit).some((chunk) => chunk instanceof ReACTChunk), { timeout: TIMEOUT });
    const mixedChunk = compactOf(mixedDeficit);
    await when(() => completionsOf(mixedDeficit).length === 2, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    await when(() => mixedDeficit.reducerExited, { timeout: TIMEOUT });

    const { turn: overflowOnly } = await runRound(
      session,
      "plan",
      91,
      100,
      needCall("n5", { min_remaining_tokens: 40 }),
    );
    await when(() => completionsOf(overflowOnly).length >= 2, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    await when(() => completionsOf(overflowOnly).length >= 3, { timeout: TIMEOUT });
    const overflowContinued = completionsOf(overflowOnly)[2]!;
    overflowContinued.totalTokens = 10;
    overflowContinued.contextLimit = 100;
    modelOf(session).reply({ text: "ok" });
    await when(() => overflowOnly.reducerExited, { timeout: TIMEOUT });
    const overflowChunk = compactOf(overflowOnly);

    const steerTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`plan` });
    session.root.head = steerTurn;
    await when(() => completionsOf(steerTurn).length === 1, { timeout: TIMEOUT });
    admitSteer(session.root, prompt.user`also do this`, steerTurn.uuid);
    const steerFirst = completionsOf(steerTurn)[0]!;
    steerFirst.totalTokens = 80;
    steerFirst.contextLimit = 100;
    modelOf(session).reply({ calls: needCall("n6", { min_remaining_tokens: 40 }) });
    await when(() => reactChunks(steerTurn).some((chunk) => chunk instanceof ReACTChunk), { timeout: TIMEOUT });
    const steerChunk = compactOf(steerTurn);
    await when(() => completionsOf(steerTurn).length === 2, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    await when(() => steerTurn.reducerExited, { timeout: TIMEOUT });

    session.orchestrator.kernel.root.compactTriggers.hard = "95%";
    const { turn: dial } = await runRound(session, "plan", 91, 100, needCall("n7", { min_remaining_tokens: 40 }));
    await sealAfterNeed(session, dial);
    const dialChunk = compactOf(dial);
    session.orchestrator.kernel.root.compactTriggers.hard = "90%";

    const completion = {
      quiet: {
        react: reactChunks(quiet).some((chunk) => chunk instanceof ReACTChunk),
        compact: compactOf(quiet) != null,
        need: quiet.contextNeed,
      },
      mixedReact: reactChunks(mixed).some((chunk) => chunk instanceof ReACTChunk),
      deficitOnly: {
        reason: deficitChunk?.reason,
        cutoff: deficitChunk?.cutoff === true,
        focus: undefined,
        react: reactChunks(deficit).some((chunk) => chunk instanceof ReACTChunk),
        needAfter: deficit.contextNeed,
      },
      mixedDeficit: {
        reason: mixedChunk?.reason,
        compactThenReact:
          mixedChunk != null &&
          reactChunks(mixedDeficit).indexOf(mixedChunk) <
            reactChunks(mixedDeficit).findIndex((chunk) => chunk instanceof ReACTChunk),
      },
      overflowOnly: {
        reason: overflowChunk?.reason,
        react: reactChunks(overflowOnly).some((chunk) => chunk instanceof ReACTChunk),
      },
      steer: {
        reason: steerChunk?.reason,
        compactThenReact:
          steerChunk != null &&
          reactChunks(steerTurn).indexOf(steerChunk) <
            reactChunks(steerTurn).findIndex((chunk) => chunk instanceof ReACTChunk),
      },
      liveDial: dialChunk?.reason,
    };

    const prior = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`one` });
    prior.totalTokens = 40;
    prior.contextLimit = 100;
    const later = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`two` });
    later.totalTokens = 80;
    later.contextLimit = 100;
    later.messages = [prior];
    const tail = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`plan`,
      doneWork: [
        new CompletionJob({ expectation: prior }),
        new CompletionJob({ expectation: later }),
        new ContextNeedToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          toolCallId: "n1",
          name: CONTEXT_NEED_TOOL_NAME,
          argsJson: JSON.stringify({
            min_remaining_tokens: 40,
            preserve: { rounds: 1 },
            focus: "need-focus",
          }),
        }),
      ],
      queue: [],
      reducerExited: true,
    });
    session.root.head = tail;
    const minted = await session.handleRequest("compact", { focus: "user-focus" });
    const head = session.root.head;
    if (!(head instanceof SessionTurn)) throw new Error("expected minted turn");
    const inheritLive = head.contextNeed;
    await when(() => compactOf(head)?.cutoff === true || head.reducerExited, { timeout: TIMEOUT });
    const chunk = compactOf(head);
    await when(() => head.reducerExited, { timeout: TIMEOUT });
    const projected = historyBehind(head, { configFloor: 1, kv: session.root.kvs });
    const slash = {
      minted,
      same: head === tail,
      reason: chunk?.reason,
      reload: head.reloadTools,
      prompt: head.prompt,
      inheritLive,
      inheritAfter: head.contextNeed,
      focus: head.prompt,
      keepAfterCard: projected.includes(later) && projected.indexOf(later) > 0 && !projected.includes(prior),
    };

    expect({ completion, slash }).toEqual({
      completion: {
        quiet: { react: true, compact: false, need: { min_remaining_tokens: 10 } },
        mixedReact: true,
        deficitOnly: {
          reason: undefined,
          cutoff: false,
          focus: undefined,
          react: true,
          needAfter: { min_remaining_tokens: 40, focus: "keep the cutoff" },
        },
        mixedDeficit: { reason: undefined, compactThenReact: false },
        overflowOnly: { reason: "overflow", react: true },
        steer: { reason: undefined, compactThenReact: false },
        liveDial: undefined,
      },
      slash: {
        minted: { ok: true, compacted: false },
        same: false,
        reason: "user",
        reload: true,
        prompt: "user-focus",
        inheritLive: {
          min_remaining_tokens: 40,
          preserve: { rounds: 1 },
          focus: "need-focus",
        },
        inheritAfter: null,
        focus: "user-focus",
        keepAfterCard: true,
      },
    });
  }, 40_000);
});
