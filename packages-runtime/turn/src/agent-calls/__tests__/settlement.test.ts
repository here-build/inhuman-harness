import { resetLocalIDs } from "@here.build/plexus";
import {
  AgentCallJob,
  BotCallJob,
  AgentCallbackJob,
  CallDelivery,
  FailureOutcome,
  ProgrammaticJob,
  type SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import {
  completeCallExceptionally,
  forceStopLoop,
  namedWorkerIds,
  schemeDeskReadonly,
  settleCancelledTurn,
} from "../index.js";
import { botCall, callsCatalog, closedTurn, hostOf, sessionOf } from "./fixtures.js";

describe("settlement and reclaim", () => {
  beforeEach(() => resetLocalIDs());

  it("completeCallExceptionally settles the caller Call and drops the worker callback", () => {
    const catalog = callsCatalog([botCall("offload")]);
    const caller = sessionOf("caller");
    const worker = sessionOf("worker");
    const call = new BotCallJob({
      name: "offload",
      workerSessionId: "worker",
      humanApprove: true,
    });
    caller.root.head = closedTurn(call);
    worker.root.ensureAgentCallback(call.uuid, "caller");
    completeCallExceptionally(call, hostOf(caller, catalog, [worker]), "cancelled");
    expect({
      completed: call.completed,
      code: call.outcome instanceof FailureOutcome ? call.outcome.code : call.outcome,
      row: worker.root.agentCallbacks[call.uuid],
    }).toEqual({ completed: true, code: "cancelled", row: undefined });
  });

  it.each([
    {
      name: "child agent",
      makeCall: (workerSessionId: string) => new AgentCallJob({ workerSessionId }),
      stopsWorker: true,
    },
    {
      name: "bot request",
      makeCall: (workerSessionId: string) => new BotCallJob({ workerSessionId }),
      stopsWorker: false,
    },
  ])("cancelling $name respects worker ownership", ({ makeCall, stopsWorker }) => {
    const caller = sessionOf("owner");
    const worker = sessionOf("owned-or-independent");
    worker.root.agent.spec.keepAlive = false;
    const call = makeCall(worker.root.sessionId);
    caller.root.head = closedTurn(call);
    const pending = new SystemToolJob({ name: "echo", humanApprove: true });
    const running = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: false });
    running.pushChild(pending);
    worker.root.head = running;
    worker.root.ensureAgentCallback(call.uuid, caller.root.sessionId);
    completeCallExceptionally(call, hostOf(caller, callsCatalog(), [worker]), "cancelled");

    expect({
      receiptComplete: call.completed,
      callback: worker.root.agentCallbacks[call.uuid],
      workerTurnClosed: running.reducerExited,
      workerWorkCancelled: pending.cancelled,
      workerWorkComplete: pending.completed,
    }).toEqual({
      receiptComplete: true,
      callback: undefined,
      workerTurnClosed: stopsWorker,
      workerWorkCancelled: stopsWorker,
      workerWorkComplete: stopsWorker,
    });
  });

  it("force-stop rejects leftovers on the originating turn; keepAlive and open rows stretch", () => {
    const leftoverRoot = sessionOf("leftover").root;
    leftoverRoot.agent.spec.keepAlive = false;
    const leftover = new SystemToolJob({
      toolCallId: "left",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
    });
    const leftoverTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    leftoverTurn.pushChild(leftover);
    leftoverRoot.head = leftoverTurn;
    forceStopLoop(leftoverRoot);
    expect({
      completed: leftover.completed,
      cancelled: leftover.cancelled,
      humanApprove: leftover.humanApprove,
      outcome: leftover.receiptJson,
    }).toEqual({
      completed: true,
      cancelled: true,
      humanApprove: true,
      outcome: JSON.stringify({ ok: false, text: "rejected" }),
    });

    const stretch = sessionOf("stretch").root;
    const stretchLeft = new SystemToolJob({
      toolCallId: "left",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
    });
    const stretchTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    stretchTurn.pushChild(stretchLeft);
    stretch.head = stretchTurn;
    stretch.agentCallbacks.one = "caller";
    forceStopLoop(stretch);
    expect(stretchLeft.completed).toBe(false);
    delete stretch.agentCallbacks.one;
    stretch.agent.spec.keepAlive = true;
    forceStopLoop(stretch);
    expect(stretchLeft.completed).toBe(false);
  });

  it("settleCancelledTurn skips call-lifetime Calls and rejects turn-lifetime Calls", () => {
    const catalog = callsCatalog([botCall("work", { lifetime: "call" }), botCall("turn", { lifetime: "turn" })]);
    const work = new BotCallJob({
      name: "work",
      delivery: new CallDelivery({ lifetime: "call" }),
      workerSessionId: "w1",
    });
    const turnCall = new BotCallJob({
      name: "turn",
      delivery: new CallDelivery({ lifetime: "turn" }),
      workerSessionId: "w2",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    turn.pushChild(work);
    turn.pushChild(turnCall);
    settleCancelledTurn(turn, catalog);
    expect({
      work: work.completed,
      turn: turnCall.completed,
      reducerExited: turn.reducerExited,
      turnCode: turnCall.outcome instanceof FailureOutcome ? turnCall.outcome.code : turnCall.outcome,
    }).toEqual({
      work: false,
      turn: true,
      reducerExited: true,
      turnCode: "cancelled",
    });
  });

  it.each([
    ["settleCancelledTurn", (turn: SessionTurn) => settleCancelledTurn(turn)],
    ["forceStopLoop", (turn: SessionTurn) => forceStopLoop(turn.rootAncestor as SessionRoot)],
  ] as const)("%s posts a cancelled background program's and shell's result", (_name, stop) => {
    const ack = (id: string) => JSON.stringify({ ok: true, value: { job_id: id, background: true } });
    const program = new ProgrammaticJob({
      toolCallId: "job-p",
      background: true,
      orchestrationResult: true,
      outcomeJson: ack("job-p"),
    });
    const shell = new SystemToolJob({
      toolCallId: "job-s",
      name: "shell",
      background: true,
      orchestrationResult: true,
      outcomeJson: ack("job-s"),
    });
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: false });
    turn.pushChild(program);
    turn.pushChild(shell);
    sessionOf(`stop-${_name}`).root.head = turn;
    stop(turn);
    expect({
      program: program.notifications.map((note) => note.message),
      shell: shell.resultNote?.message,
    }).toEqual({ program: ["job job-p finished: cancelled"], shell: "job job-s finished: cancelled" });
  });

  it("settleCancelledTurn skips call-lifetime Calls from delivery without a catalog", () => {
    const work = new BotCallJob({
      name: "work",
      delivery: new CallDelivery({ lifetime: "call" }),
      workerSessionId: "w1",
    });
    const turnCall = new BotCallJob({
      name: "turn",
      delivery: new CallDelivery({ lifetime: "turn" }),
      workerSessionId: "w2",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    turn.pushChild(work);
    turn.pushChild(turnCall);
    settleCancelledTurn(turn);
    expect({
      work: work.completed,
      turn: turnCall.completed,
    }).toEqual({ work: false, turn: true });
  });

  it("a live call names its worker; its desk is not readonly", () => {
    const caller = sessionOf("caller");
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
      acceptedAt: Date.now(),
      preparedInputJson: JSON.stringify({ prepared: true }),
      workerSessionId: "worker",
    });
    caller.root.head = closedTurn(call);
    expect({
      accepted: call.acceptedAt != null,
      workers: namedWorkerIds(caller.root),
      readonly: schemeDeskReadonly(caller.root, call),
    }).toEqual({
      accepted: true,
      workers: ["worker"],
      readonly: false,
    });
  });

  it("force-stop preserves a successor head that did not originate the except callback", () => {
    const root = sessionOf("successor").root;
    const callback = new AgentCallbackJob({
      toolCallId: "cb",
      name: "agent__respond",
      argsJson: "{}",
      humanApprove: true,
    });
    const prior = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    prior.pushChild(callback);
    const leftover = new SystemToolJob({
      toolCallId: "next",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
    });
    const successor = new SessionTurn({
      turnTail: prior,
      queue: [],
      reducerExited: false,
    });
    successor.pushChild(leftover);
    root.head = successor;
    forceStopLoop(root, undefined, callback);
    expect({
      leftover: leftover.completed,
      successorClosed: successor.reducerExited,
    }).toEqual({
      leftover: false,
      successorClosed: false,
    });
  });
});
