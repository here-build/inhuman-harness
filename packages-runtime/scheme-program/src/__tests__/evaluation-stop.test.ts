/** Evaluation stop: timeout preserves live subagents in background and enriches receipt; non-timeout cancel aborts. */
import {
  AgentCallJob,
  ProgrammaticJob,
  SessionDocument,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { describe, expect, it, vi } from "vitest";

import { cancelLiveInvocations, guardProgram } from "../evaluate.js";
import type { ProgramHost } from "../host.js";

function host(extra: Partial<ProgramHost> = {}): ProgramHost {
  return {
    identity: extra.identity ?? {},
    signal: extra.signal,
    doors: extra.doors ?? new DoorSession(() => {}),
    root: extra.root ?? "/tmp",
    evalProgram: extra.evalProgram,
    moduleRoot: extra.moduleRoot,
    abort: extra.abort,
    canApplyResults: extra.canApplyResults,
    tools: extra.tools ?? (() => new Map()),
    prepare: extra.prepare ?? (() => ({ capabilities: [], config: {} })),
  };
}

function chunk(id = "stop-1"): ProgrammaticJob {
  return new ProgrammaticJob({
    toolCallId: id,
    argsJson: JSON.stringify({ description: "test", expr: "(+ 1 2)" }),
  });
}

function receiptText(job: ProgrammaticJob): string {
  return job.receiptJson ?? "";
}

describe("evaluation stop preserves the abort reason", () => {
  it("guardProgram seals a host abort carrying a timeout reason as timed out, not bare cancelled", async () => {
    const controller = new AbortController();
    const c = chunk("stop-timeout-host");
    controller.abort(new Error("evaluation timed out after 90ms"));
    await guardProgram(c, host({ signal: controller.signal }), async () => {});
    expect({
      completed: c.completed,
      receipt: receiptText(c),
    }).toEqual({
      completed: true,
      receipt: expect.stringContaining("timed out after 90ms"),
    });
    expect(receiptText(c)).not.toContain("Error: Scheme REPL call cancelled");
  });

  it("guardProgram seals a host abort carrying a DOMException TimeoutError as timed out", async () => {
    const controller = new AbortController();
    const c = chunk("stop-timeout-dom");
    controller.abort(new DOMException("timed out", "TimeoutError"));
    await guardProgram(c, host({ signal: controller.signal }), async () => {});
    expect({
      completed: c.completed,
      receipt: receiptText(c),
    }).toEqual({
      completed: true,
      receipt: expect.stringContaining("timed out"),
    });
    expect(receiptText(c)).not.toContain("Error: Scheme REPL call cancelled");
  });

  it("timeout promotes started CallJobs to background without aborting, settles unstarted CallJobs, and aborts non-CallJobs", () => {
    const abort = vi.fn();
    const timeout = new Error("evaluation timed out after 90ms");
    const c = chunk("stop-timeout-mixed");

    const startedWorkerOnly = new AgentCallJob({
      toolCallId: "call-worker",
      name: "agent__ask",
      workerSessionId: "worker-1",
      argsJson: JSON.stringify({ message: "audit" }),
    });
    const startedOrchestrated = new AgentCallJob({
      toolCallId: "call-orch",
      name: "agent__ask",
      orchestrationResult: true,
      argsJson: JSON.stringify({ message: "audit-2" }),
    });
    const unstartedCall = new AgentCallJob({
      toolCallId: "call-unstarted",
      name: "agent__ask",
      argsJson: JSON.stringify({ message: "never-started" }),
    });
    const startedSystem = new SystemToolJob({
      toolCallId: "sys-1",
      name: "shell",
      orchestrationResult: true,
      argsJson: JSON.stringify({ command: "sleep 10" }),
    });
    c.registerJob(startedWorkerOnly);
    c.registerJob(startedOrchestrated);
    c.registerJob(unstartedCall);
    c.registerJob(startedSystem);

    cancelLiveInvocations(c, host({ abort }), timeout);

    expect({
      workerOnly: {
        background: startedWorkerOnly.background,
        walkBoundary: startedWorkerOnly.walkBoundary,
        completed: startedWorkerOnly.completed,
        cancelled: startedWorkerOnly.cancelled,
      },
      orchestratedCall: {
        background: startedOrchestrated.background,
        walkBoundary: startedOrchestrated.walkBoundary,
        completed: startedOrchestrated.completed,
        cancelled: startedOrchestrated.cancelled,
      },
      unstarted: {
        completed: unstartedCall.completed,
        cancelled: unstartedCall.cancelled,
        outcome: JSON.stringify(unstartedCall.outcome ?? {}),
      },
      systemTool: {
        cancelled: startedSystem.cancelled,
        abortedCount: abort.mock.calls.length,
        abortedTarget: abort.mock.calls[0]?.[0],
        abortedReason: abort.mock.calls[0]?.[1],
      },
    }).toEqual({
      workerOnly: { background: true, walkBoundary: true, completed: false, cancelled: false },
      orchestratedCall: { background: true, walkBoundary: true, completed: false, cancelled: false },
      unstarted: {
        completed: true,
        cancelled: true,
        outcome: expect.stringContaining("timed out after 90ms"),
      },
      systemTool: {
        cancelled: true,
        abortedCount: 1,
        abortedTarget: startedSystem,
        abortedReason: timeout,
      },
    });
  });

  it("non-timeout cancel still aborts an orchestrated inner CallJob", () => {
    const c = chunk("stop-inner-cancel");
    const abort = vi.fn();
    const call = new AgentCallJob({
      toolCallId: "call-2",
      name: "agent__ask",
      workerSessionId: "worker-2",
      orchestrationResult: true,
      argsJson: JSON.stringify({ message: "audit" }),
    });
    c.registerJob(call);
    const reason = new Error("cancelled");
    cancelLiveInvocations(c, host({ abort }), reason);
    expect({
      abortedCount: abort.mock.calls.length,
      target: abort.mock.calls[0]?.[0],
      reason: abort.mock.calls[0]?.[1],
      cancelled: call.cancelled,
      background: call.background,
    }).toEqual({
      abortedCount: 1,
      target: call,
      reason,
      cancelled: true,
      background: false,
    });
  });

  it("timeout report summarizes completed and backgrounded CallJobs without leaking raw message briefs", async () => {
    const root = new SessionRoot({ sessionId: "caller", path: "/tmp" });
    const c = chunk("stop-report");
    const completedCall = new AgentCallJob({
      toolCallId: "p1:inner:1",
      name: "agent__ask",
      workerSessionId: "w-done",
      orchestrationResult: true,
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("Explore finished cleanly.") }),
      argsJson: JSON.stringify({
        spec: "explore",
        description: "Map auth modules.",
        message: "SECRET_RAW_BRIEF_SHOULD_NOT_LEAK_DONE",
      }),
    });
    const runningCall = new AgentCallJob({
      toolCallId: "p1:inner:2",
      name: "agent__ask",
      workerSessionId: "w-live",
      orchestrationResult: true,
      argsJson: JSON.stringify({
        spec: "web-research",
        description: "Research admin UI.",
        message: "SECRET_RAW_BRIEF_SHOULD_NOT_LEAK_LIVE",
      }),
    });
    c.registerJob(completedCall);
    c.registerJob(runningCall);
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [c] });
    turn.pushChild(c);
    root.head = turn;
    const doc = SessionDocument.bootstrap(root);
    try {
      const controller = new AbortController();
      controller.abort(new Error("evaluation timed out after 1200000ms"));
      await guardProgram(c, host({ signal: controller.signal }), async () => {});
      const parsed = JSON.parse(receiptText(c)) as { ok: boolean; text: string };
      expect({
        ok: parsed.ok,
        hasTimeout: parsed.text.includes("timed out after 1200000ms"),
        hasHeader: parsed.text.includes("Inner calls at timeout:"),
        hasDoneStatus: parsed.text.includes("status=completed"),
        hasDoneRecall: parsed.text.includes(`job:${completedCall.uuid.slice(0, 8)}`),
        hasDoneResult: parsed.text.includes("Explore finished cleanly."),
        hasDoneDescription: parsed.text.includes("Map auth modules."),
        hasLiveStatus: parsed.text.includes("status=running_in_background"),
        hasLiveWorker: parsed.text.includes("workerSessionId=w-live"),
        hasLiveLogHint: parsed.text.includes('(agent/log "w-live")'),
        hasLiveRecallHint: parsed.text.includes('context_recall {"ref":"agent:w-live"}'),
        hasLiveContinueHint: parsed.text.includes('(agent/continue "w-live")'),
        hasLiveStopHint: parsed.text.includes('(job_stop :job_id "p1:inner:2")'),
        leakedDoneBrief: parsed.text.includes("SECRET_RAW_BRIEF_SHOULD_NOT_LEAK_DONE"),
        leakedLiveBrief: parsed.text.includes("SECRET_RAW_BRIEF_SHOULD_NOT_LEAK_LIVE"),
        runningBackgrounded: runningCall.background,
        runningCompleted: runningCall.completed,
      }).toEqual({
        ok: false,
        hasTimeout: true,
        hasHeader: true,
        hasDoneStatus: true,
        hasDoneRecall: true,
        hasDoneResult: true,
        hasDoneDescription: true,
        hasLiveStatus: true,
        hasLiveWorker: true,
        hasLiveLogHint: true,
        hasLiveRecallHint: true,
        hasLiveContinueHint: true,
        hasLiveStopHint: true,
        leakedDoneBrief: false,
        leakedLiveBrief: false,
        runningBackgrounded: true,
        runningCompleted: false,
      });
    } finally {
      doc.destroy();
    }
  });
});
