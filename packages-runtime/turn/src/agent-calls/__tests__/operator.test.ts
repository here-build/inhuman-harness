import { resetLocalIDs } from "@here.build/plexus";
import { AgentCallJob, BotCallJob, FailureOutcome, SuccessfulOutcome } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { cancelAgentCall, inspectAgentCall, listAgentCalls } from "../index.js";
import { operatorCallView } from "../operator.js";
import { botCall, callsCatalog, closedTurn, hostOf, sessionOf } from "./fixtures.js";

describe("operator views and cancel", () => {
  beforeEach(() => resetLocalIDs());

  it("projects admitted/accepted/terminal", () => {
    const catalog = callsCatalog([botCall("offload")]);
    const caller = sessionOf("caller");
    const admitted = new BotCallJob({ name: "offload" });
    const accepted = new BotCallJob({
      name: "offload",
      acceptedAt: Date.now(),
      preparedInputJson: "{}",
      workerSessionId: "w",
    });
    const terminal = new BotCallJob({
      name: "offload",
      completed: true,
      outcome: new SuccessfulOutcome({
        valueJson: JSON.stringify({ ok: true }),
      }),
    });
    caller.root.head = closedTurn(admitted);
    caller.root.head.pushChild(accepted);
    caller.root.head.pushChild(terminal);
    const listed = listAgentCalls(caller.root, catalog);
    const terminalView = operatorCallView(terminal, "caller", catalog);
    expect({
      admitted: operatorCallView(admitted, "caller", catalog).state,
      accepted: operatorCallView(accepted, "caller", catalog).state,
      terminal: {
        state: terminalView.state,
        delivery: terminalView.delivery,
        outcome: terminalView.outcome,
      },
      listed: listed.length,
      inspect: inspectAgentCall(caller.root, admitted.uuid, catalog)?.requestId,
    }).toEqual({
      admitted: "admitted",
      accepted: "accepted",
      terminal: {
        state: "terminal",
        delivery: "delivered",
        outcome: { ok: true, value: { ok: true } },
      },
      listed: 3,
      inspect: admitted.uuid,
    });
  });

  it("lists child calls and bot requests through their shared receipt protocol", () => {
    const catalog = callsCatalog();
    const caller = sessionOf("mixed-caller");
    const child = new AgentCallJob({ name: "agent__ask", orchestrationResult: true, workerSessionId: "child" });
    const bot = new BotCallJob({ name: "bot__send" });
    caller.root.head = closedTurn(child);
    caller.root.head.pushChild(bot);
    expect(
      listAgentCalls(caller.root, catalog).map((view) => ({ requestId: view.requestId, state: view.state })),
    ).toEqual([
      { requestId: child.uuid, state: "running" },
      { requestId: bot.uuid, state: "admitted" },
    ]);
  });
  it("cancelAgentCall exceptionally settles an open Call on acquired replicas", () => {
    const catalog = callsCatalog([botCall("offload")]);
    const caller = sessionOf("caller");
    const worker = sessionOf("worker");
    const call = new BotCallJob({
      name: "offload",
      workerSessionId: "worker",
    });
    caller.root.head = closedTurn(call);
    worker.root.ensureAgentCallback(call.uuid, "caller");
    const ok = cancelAgentCall(hostOf(caller, catalog, [worker]), call.uuid);
    expect({
      ok,
      completed: call.completed,
      code: call.outcome instanceof FailureOutcome ? call.outcome.code : call.outcome,
      row: worker.root.agentCallbacks[call.uuid],
      again: cancelAgentCall(hostOf(caller, catalog, [worker]), call.uuid),
    }).toEqual({
      ok: true,
      completed: true,
      code: "cancelled",
      row: undefined,
      again: false,
    });
  });
});
