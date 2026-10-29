import { resetLocalIDs } from "@here.build/plexus";
import {
  AGENT_VOID,
  AgentCallJob,
  BotCallJob,
  AgentCallbackJob,
  FailureOutcome,
  SuccessfulOutcome,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { loadOpenCall, settleCallFromCallback } from "../index.js";
import { closedTurn, scopeOf, sessionOf } from "./fixtures.js";

describe.each([
  { name: "child agent", CallType: AgentCallJob },
  { name: "bot request", CallType: BotCallJob },
])("callbacks for $name", ({ CallType }) => {
  beforeEach(() => resetLocalIDs());

  it("loadOpenCall reads the caller Call from an acquired replica", () => {
    const caller = sessionOf("caller");
    const worker = sessionOf("worker");
    const call = new CallType({
      name: "offload",
      workerSessionId: "worker",
    });
    caller.root.head = closedTurn(call);
    worker.root.ensureAgentCallback(call.uuid, "caller");
    const found = loadOpenCall(scopeOf(caller, worker), worker.root, call.uuid);
    expect({
      found: found === call,
      missing: loadOpenCall(scopeOf(worker), worker.root, call.uuid) == null,
    }).toEqual({ found: true, missing: true });
  });

  it("void without value settles null; value settles success", () => {
    const caller = sessionOf("void-caller");
    const voided = new CallType({ name: "offload" });
    const valued = new CallType({ name: "offload" });
    caller.root.head = closedTurn(voided);
    caller.root.head.pushChild(valued);
    settleCallFromCallback(
      voided,
      new AgentCallbackJob({
        name: AGENT_VOID,
        argsJson: JSON.stringify({ requestId: voided.uuid }),
      }),
    );
    settleCallFromCallback(
      valued,
      new AgentCallbackJob({
        name: AGENT_VOID,
        argsJson: JSON.stringify({
          requestId: valued.uuid,
          value: { ok: true },
        }),
      }),
    );
    expect({
      voided: {
        completed: voided.completed,
        value: voided.outcome instanceof SuccessfulOutcome ? voided.outcome.value : "unsettled",
      },
      valued: valued.outcome instanceof SuccessfulOutcome ? valued.outcome.value : valued.outcome,
    }).toEqual({
      voided: { completed: true, value: null },
      valued: { ok: true },
    });
  });

  it("a void reply settles a background Call and posts its result", async () => {
    const caller = sessionOf("void-background");
    const call = new CallType({ name: "offload", toolCallId: "job-void", background: true });
    caller.root.head = closedTurn(call);
    settleCallFromCallback(
      call,
      new AgentCallbackJob({ name: AGENT_VOID, argsJson: JSON.stringify({ requestId: call.uuid }) }),
    );
    expect({
      sealed: call.sealedOutcomeJson(),
      notes: call.notifications.map((note) => [note.message, note.result]),
    }).toEqual({
      sealed: JSON.stringify({ ok: true, value: null }),
      notes: [["job job-void finished", true]],
    });
    await expect(call).resolves.not.toBeUndefined();
  });

  it("respond settles the response string; schema mismatch is a failure", () => {
    const caller = sessionOf("respond-caller");
    const plain = new CallType({ name: "ask" });
    const typed = new CallType({
      name: "ask",
      responseSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
    });
    const ok = new CallType({
      name: "ask",
      responseSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
    });
    caller.root.head = closedTurn(plain);
    caller.root.head.pushChild(typed);
    caller.root.head.pushChild(ok);
    settleCallFromCallback(
      plain,
      new AgentCallbackJob({
        name: "agent__respond",
        argsJson: JSON.stringify({ requestId: plain.uuid, response: "done" }),
      }),
    );
    settleCallFromCallback(
      typed,
      new AgentCallbackJob({
        name: "agent__respond",
        argsJson: JSON.stringify({
          requestId: typed.uuid,
          response: JSON.stringify({ answer: "no" }),
        }),
      }),
    );
    settleCallFromCallback(
      ok,
      new AgentCallbackJob({
        name: "agent__respond",
        argsJson: JSON.stringify({
          requestId: ok.uuid,
          response: JSON.stringify({ answer: 1 }),
        }),
      }),
    );
    expect({
      plain: plain.outcome instanceof SuccessfulOutcome ? plain.outcome.value : plain.outcome,
      typed: typed.outcome instanceof FailureOutcome ? typed.outcome.code : typed.outcome,
      ok: ok.outcome instanceof SuccessfulOutcome ? ok.outcome.value : ok.outcome,
    }).toEqual({
      plain: "done",
      typed: "response_schema",
      ok: { answer: 1 },
    });
  });

  it("typed validateValue hook wins over the response string", () => {
    const caller = sessionOf("typed-caller");
    const call = new CallType({ name: "offload" });
    caller.root.head = closedTurn(call);
    settleCallFromCallback(
      call,
      new AgentCallbackJob({
        name: "agent__respond",
        argsJson: JSON.stringify({
          requestId: call.uuid,
          value: { n: 1 },
          response: "ignored",
        }),
      }),
      (_call, value) => (typeof value === "object" && value != null ? value : null),
    );
    expect(call.outcome instanceof SuccessfulOutcome ? call.outcome.value : call.outcome).toEqual({ n: 1 });
  });
});
