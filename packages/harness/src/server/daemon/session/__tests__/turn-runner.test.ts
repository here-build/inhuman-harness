import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  McpToolExpectation,
  MCPToolJob,
  reactChunks,
  tapeCompletion,
  responseCall,
  ProgrammaticJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
  TurnPromptChunk,
} from "@inhuman.tools/harness-model";
import { walkWork } from "@inhuman.tools/plexus-expectations";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 2_000;

const cancelled = {
  humanApprove: null,
  completed: true,
  outcomeJson: JSON.stringify({ ok: false, text: "cancelled" }),
};

function completionsOf(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

function echo(id: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name: "echo",
    argsJson: "{}",
  });
}

function sealOf(node: ToolCallJob) {
  return {
    humanApprove: node.humanApprove,
    completed: node.completed,
    outcomeJson: node.receiptJson,
  };
}

function parked(): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`park`,
    queue: [],
    reducerExited: true,
  });
}

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-runner-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-runner-p-"));
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

describe("Turn interpret", () => {
  beforeEach(() => resetLocalIDs());

  it("licensed MCP with a missing or empty connection fails closed", async () => {
    const session = await openSession();
    const root = session.root;
    const gone = new MCPToolJob({
      toolCallId: "m1",
      name: "mcp__gone__search",
      argsJson: "{}",
      connectionKey: "gone",
      serverToolName: "search",
      expectation: new McpToolExpectation({
        connectionId: "gone",
        serverToolName: "search",
        argsJson: "{}",
      }),
    });
    const empty = new MCPToolJob({
      toolCallId: "m2",
      name: "mcp__search",
      argsJson: "{}",
      serverToolName: "search",
      expectation: new McpToolExpectation({
        connectionId: "mcp",
        serverToolName: "search",
        argsJson: "{}",
      }),
    });
    gone.humanApprove = true;
    empty.humanApprove = true;
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: [gone, empty],
      queue: [],
    });
    root.head = turn;
    await when(
      () =>
        gone.receiptJson != null && gone.receiptJson !== "" && empty.receiptJson != null && empty.receiptJson !== "",
      { timeout: TIMEOUT },
    );
    expect({
      gone: {
        outcome: gone.receiptJson,
        pewDone: gone.expectation.isDone,
        orchestrated: gone.orchestrated,
        completed: gone.completed,
      },
      empty: {
        outcome: empty.receiptJson,
        pewDone: empty.expectation.isDone,
        orchestrated: empty.orchestrated,
        completed: empty.completed,
      },
    }).toEqual({
      gone: {
        outcome: JSON.stringify({ ok: false, text: "gone: missing MCP connection" }),
        pewDone: true,
        orchestrated: true,
        completed: true,
      },
      empty: {
        outcome: JSON.stringify({ ok: false, text: "search: missing MCP connection" }),
        pewDone: true,
        orchestrated: true,
        completed: true,
      },
    });
  });

  it("ReACT join waits for claim; nested keeps running after parent empty-queue", async () => {
    const session = await openSession();
    const root = session.root;

    const held = echo("bg");
    held.background = true;
    const heldTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hold`,
      queue: [held],
    });
    root.head = heldTurn;
    await when(() => heldTurn.orchestrated, { timeout: TIMEOUT });
    await Promise.resolve();
    const joinHeld = {
      reducerExited: heldTurn.reducerExited,
      orchestrated: held.orchestrated,
      completed: held.completed,
    };
    held.humanApprove = false;
    await when(() => heldTurn.reducerExited, { timeout: TIMEOUT });
    const joinReleased = {
      completed: held.completed,
      orchestrated: held.orchestrated,
      outcome: held.receiptJson,
    };

    const sitting = new ProgrammaticJob({
      toolCallId: "r1",
      argsJson: JSON.stringify({ expr: '(shell "echo sit")', description: "background sit" }),
      background: true,
    });
    const sitTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`sit`,
      queue: [sitting],
    });
    root.head = sitTurn;
    await when(() => sitTurn.reducerExited && sitting.orchestrated, { timeout: TIMEOUT });
    const joinSit = {
      reducerExited: sitTurn.reducerExited,
      completed: sitting.completed,
      orchestrated: sitting.orchestrated,
    };

    const nested = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`child`,
    });
    nested.walkBoundary = true;
    const parent = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`parent`,
      queue: [],
    });
    parent.children.push(nested);
    root.head = parent;
    await when(() => parent.reducerExited, { timeout: TIMEOUT });
    await when(() => completionsOf(nested).length === 1, { timeout: TIMEOUT });
    const nestedEmptyQueue = {
      parentClosed: parent.reducerExited,
      nestedClosed: nested.reducerExited,
      nestedOrchestrated: nested.orchestrated,
    };
    modelOf(session).reply({ text: "child-hi" });
    await when(() => nested.reducerExited, { timeout: TIMEOUT });

    const bgNested = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`bg-child`,
    });
    bgNested.walkBoundary = true;
    bgNested.background = true;
    const bgParent = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`bg-parent`,
      queue: [],
    });
    bgParent.children.push(bgNested);
    root.head = bgParent;
    await when(() => bgParent.reducerExited, { timeout: TIMEOUT });
    await when(() => completionsOf(bgNested).length === 1, { timeout: TIMEOUT });
    const nestedBackground = {
      parentClosed: bgParent.reducerExited,
      reducerExited: bgNested.reducerExited,
      orchestrated: bgNested.orchestrated,
    };
    modelOf(session).reply({ text: "bg-child" });
    await when(() => bgNested.reducerExited, { timeout: TIMEOUT });

    expect({
      join: { held: joinHeld, released: joinReleased, sit: joinSit },
      nested: { emptyQueue: nestedEmptyQueue, background: nestedBackground },
    }).toEqual({
      join: {
        held: { reducerExited: false, orchestrated: false, completed: false },
        released: {
          completed: true,
          orchestrated: true,
          outcome: JSON.stringify({
            ok: false,
            text: "User refused this tool use",
            refusalReason: "User refused this tool use",
          }),
        },
        sit: { reducerExited: true, completed: false, orchestrated: true },
      },
      nested: {
        emptyQueue: { parentClosed: true, nestedClosed: false, nestedOrchestrated: true },
        background: { parentClosed: true, reducerExited: false, orchestrated: true },
      },
    });
  }, 30_000);

  it("Abandon/abort: hanging tool, live completion, leftovers, nested child", async () => {
    const session = await openSession();
    const root = session.root;

    const hangTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`use echo` });
    root.head = hangTurn;
    await when(() => completionsOf(hangTurn).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ calls: [responseCall("call_1", "echo")] });
    await when(() => hangTurn.work.some((chunk) => chunk instanceof ToolCallJob), { timeout: TIMEOUT });
    const hangEcho = hangTurn.work.find((chunk) => chunk instanceof ToolCallJob)!;
    await session.handleRequest("turn/cancel", { turnId: hangTurn.uuid });
    await when(() => hangTurn.reducerExited, { timeout: TIMEOUT });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hanging = {
      reducerExited: hangTurn.reducerExited,
      cancelRequested: hangTurn.cancelRequested,
      cancelled: hangTurn.cancelled,
      running: root.findRunningTurn(),
      continue: hangTurn.lastTurnIncomplete,
      completions: completionsOf(hangTurn).length,
      outcomes: completionsOf(hangTurn).map((chunk) => ({
        outcome: chunk.outcome,
        endCause: chunk.endCause,
        endDetail: chunk.endDetail,
      })),
      echo: {
        cancelled: hangEcho.cancelled,
        completed: hangEcho.completed,
        outcomeJson: hangEcho.receiptJson,
      },
    };

    const liveTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`run` });
    root.head = liveTurn;
    await when(() => completionsOf(liveTurn).length === 1, { timeout: TIMEOUT });
    const live = completionsOf(liveTurn)[0]!;
    await session.handleRequest("turn/cancel", { turnId: liveTurn.uuid });
    await when(() => liveTurn.reducerExited, { timeout: TIMEOUT });
    const liveFirst = {
      outcome: live.outcome,
      endCause: live.endCause,
      endDetail: live.endDetail,
      cancelled: liveTurn.cancelled,
      continue: liveTurn.lastTurnIncomplete,
      running: root.findRunningTurn()?.uuid ?? null,
    };

    const toolTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`use echo` });
    root.head = toolTurn;
    await when(() => completionsOf(toolTurn).length === 1, { timeout: TIMEOUT });
    const toolFirst = completionsOf(toolTurn)[0]!;
    modelOf(session).reply({ calls: [responseCall("call_1", "echo")] });
    await when(() => toolTurn.work.some((chunk) => chunk instanceof ToolCallJob), { timeout: TIMEOUT });
    const toolEcho = toolTurn.work.find((chunk) => chunk instanceof ToolCallJob)!;
    toolEcho.receiptJson = JSON.stringify({ ok: true, text: "ok" });
    toolEcho.humanApprove = false;
    await when(() => completionsOf(toolTurn).length === 2, { timeout: TIMEOUT });
    const toolSecond = completionsOf(toolTurn)[1]!;
    await session.handleRequest("turn/cancel", { turnId: toolTurn.uuid });
    await when(() => toolTurn.reducerExited, { timeout: TIMEOUT });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const livePostTool = {
      completions: completionsOf(toolTurn).length,
      first: { outcome: toolFirst.outcome, endCause: toolFirst.endCause },
      second: { outcome: toolSecond.outcome, endCause: toolSecond.endCause, endDetail: toolSecond.endDetail },
      cancelled: toolTurn.cancelled,
      continue: toolTurn.lastTurnIncomplete,
      running: root.findRunningTurn()?.uuid ?? null,
      reducerExited: toolTurn.reducerExited,
    };

    const queued = [echo("a"), echo("b")];
    const unstarted = echo("done");
    const inner = echo("inner");
    const repl = new ProgrammaticJob({
      toolCallId: "r1",
      argsJson: JSON.stringify({ expr: "(+ 1 2)", description: "add one and two" }),
    });
    repl.pushInvocation(inner);
    const leftoversTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
      doneWork: [unstarted, repl],
      queue: queued,
    });
    root.head = leftoversTurn;
    await when(() => leftoversTurn.orchestrated, { timeout: TIMEOUT });
    root.head = parked();
    await when(() => leftoversTurn.reducerExited, { timeout: TIMEOUT });

    const already = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
    });
    root.head = already;
    root.head = parked();
    await when(() => already.reducerExited, { timeout: TIMEOUT });

    const inFlight = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
    });
    root.head = inFlight;
    await when(() => completionsOf(inFlight).length === 1, { timeout: TIMEOUT });
    const pendingInFlight = completionsOf(inFlight)[0]!;
    root.head = parked();
    await when(() => inFlight.reducerExited, { timeout: TIMEOUT });
    pendingInFlight.succeed("settled", "", "null", { result: { text: "late" } });
    await Promise.resolve();
    const leftovers = {
      queued: queued.map(sealOf),
      unstarted: sealOf(unstarted),
      inner: sealOf(inner),
      already: {
        reducerExited: already.reducerExited,
        queue: already.queue,
        doneWork: already.doneWork,
        completions: completionsOf(already),
      },
      inFlight: {
        reducerExited: inFlight.reducerExited,
        completions: completionsOf(inFlight).length,
        inDone: inFlight.doneWork.some((chunk) => tapeCompletion(chunk) === pendingInFlight),
        inQueue: inFlight.queue.some((chunk) => tapeCompletion(chunk) === pendingInFlight),
        outcome: pendingInFlight.outcome,
        mintedTool: inFlight.work.some((chunk) => chunk instanceof ToolCallJob),
      },
    };

    const earlier = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`old`,
    });
    const nested = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`child`,
    });
    nested.walkBoundary = true;
    const abandoned = new SessionTurn({ turnTail: earlier, prompt: prompt.user`new` });
    abandoned.children.push(nested);
    root.head = abandoned;
    const nestedBefore = {
      abandonedWalk: [...walkWork(root)].includes(abandoned),
      abandonedLive: root.liveTurns.has(abandoned),
      earlierLive: root.liveTurns.has(earlier),
    };
    await when(() => completionsOf(abandoned).length === 1 && completionsOf(nested).length === 1, { timeout: TIMEOUT });
    const pendingAbandoned = completionsOf(abandoned)[0]!;
    root.head = earlier;
    const nestedAfterRepoint = {
      abandonedWalk: [...walkWork(root)].includes(abandoned),
      abandonedLive: root.liveTurns.has(abandoned),
      earlierLive: root.liveTurns.has(earlier),
    };
    await when(() => nested.reducerExited, { timeout: TIMEOUT });
    await when(() => abandoned.reducerExited, { timeout: TIMEOUT });
    await when(() => completionsOf(earlier).length === 1, { timeout: TIMEOUT });
    pendingAbandoned.succeed("settled", "", "null", { result: { text: "late" } });
    await Promise.resolve();
    await Promise.resolve();
    const nestedChild = {
      before: nestedBefore,
      afterRepoint: nestedAfterRepoint,
      abandonedClosed: abandoned.reducerExited,
      abandonedCompletions: completionsOf(abandoned).length,
      nestedCompletions: completionsOf(nested).length,
      pendingOutcome: pendingAbandoned.outcome,
      earlierCompletions: completionsOf(earlier).length,
      sameHead: completionsOf(earlier)[0] === pendingAbandoned,
      mintedTool: abandoned.work.some((chunk) => chunk instanceof ToolCallJob),
    };

    expect({ hanging, live: { first: liveFirst, postTool: livePostTool }, leftovers, nested: nestedChild }).toEqual({
      hanging: {
        reducerExited: true,
        cancelRequested: true,
        cancelled: true,
        running: null,
        continue: true,
        completions: 1,
        outcomes: [{ outcome: "successful", endCause: "settled", endDetail: "" }],
        echo: {
          cancelled: true,
          completed: true,
          outcomeJson: JSON.stringify({ ok: false, text: "cancelled" }),
        },
      },
      live: {
        first: {
          outcome: "failed",
          endCause: "cancel",
          endDetail: "terminate",
          cancelled: true,
          continue: true,
          running: null,
        },
        postTool: {
          completions: 2,
          first: { outcome: "successful", endCause: "settled" },
          second: { outcome: "failed", endCause: "cancel", endDetail: "terminate" },
          cancelled: true,
          continue: true,
          running: null,
          reducerExited: true,
        },
      },
      leftovers: {
        queued: [cancelled, cancelled],
        unstarted: cancelled,
        inner: cancelled,
        already: {
          reducerExited: true,
          queue: [expect.any(TurnPromptChunk)],
          doneWork: [],
          completions: [],
        },
        inFlight: {
          reducerExited: true,
          completions: 1,
          inDone: true,
          inQueue: false,
          outcome: "successful",
          mintedTool: false,
        },
      },
      nested: {
        before: { abandonedWalk: true, abandonedLive: true, earlierLive: true },
        afterRepoint: { abandonedWalk: false, abandonedLive: false, earlierLive: true },
        abandonedClosed: true,
        abandonedCompletions: 1,
        nestedCompletions: 1,
        pendingOutcome: "successful",
        earlierCompletions: 1,
        sameHead: false,
        mintedTool: false,
      },
    });
  }, 40_000);

  it("inbound turn queued at session.head mid-turn waits for the running turn to finish its ReACT follow-up", async () => {
    const session = await openSession();
    const root = session.root;

    const firstTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`first turn`,
    });
    root.head = firstTurn;
    await when(() => completionsOf(firstTurn).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ calls: [responseCall("call_1", "echo")] });
    await when(() => firstTurn.work.some((chunk) => chunk instanceof ToolCallJob), { timeout: TIMEOUT });

    // Queue an inbound turn at root.head while firstTurn's tool is still running.
    root.enqueueAgentRequest("req_inbound", "caller_1", prompt.user`inbound follow-up`);
    const inboundTurn = root.head!;
    expect(inboundTurn).not.toBe(firstTurn);
    expect(inboundTurn.inbound).toBe(true);
    expect(inboundTurn.turnTail).toBe(firstTurn);

    // Finish firstTurn's tool; firstTurn must continue into its ReACT completion rather than exiting early.
    const toolEcho = firstTurn.work.find((chunk) => chunk instanceof ToolCallJob)!;
    toolEcho.receiptJson = JSON.stringify({ ok: true, text: "ok" });
    toolEcho.humanApprove = false;

    await when(() => completionsOf(firstTurn).length === 2, { timeout: TIMEOUT });
    expect(firstTurn.reducerExited).toBe(false);
    expect(completionsOf(inboundTurn).length).toBe(0);

    // Complete firstTurn; inboundTurn should now open its first completion.
    modelOf(session).reply({ text: "first turn done" });
    await when(() => firstTurn.reducerExited && completionsOf(inboundTurn).length === 1, { timeout: TIMEOUT });
    delete root.agentCallbacks.req_inbound;
    modelOf(session).reply({ text: "inbound turn done" });
    await when(() => inboundTurn.reducerExited, { timeout: TIMEOUT });
  });
});
