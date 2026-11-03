/** Red tests: silent agent timeout — evaluation stop must preserve its reason. */
import { AgentCallJob, ProgrammaticJob } from "@inhuman.tools/harness-model";
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
    expect(c.completed).toBe(true);
    expect(receiptText(c)).toContain("timed out after 90ms");
    expect(receiptText(c)).not.toContain("Error: Scheme REPL call cancelled");
  });

  it("guardProgram seals a host abort carrying a DOMException TimeoutError as timed out", async () => {
    const controller = new AbortController();
    const c = chunk("stop-timeout-dom");
    controller.abort(new DOMException("timed out", "TimeoutError"));
    await guardProgram(c, host({ signal: controller.signal }), async () => {});
    expect(c.completed).toBe(true);
    expect(receiptText(c)).toContain("timed out");
    expect(receiptText(c)).not.toContain("Error: Scheme REPL call cancelled");
  });

  it("cancelLiveInvocations settles a started non-orchestrated inner CallJob with the timeout reason", () => {
    const c = chunk("stop-inner-call");
    const call = new AgentCallJob({
      toolCallId: "call-1",
      name: "agent/ask",
      workerSessionId: "worker-1",
      argsJson: JSON.stringify({ message: "audit" }),
    });
    c.registerJob(call);
    cancelLiveInvocations(c, host({}), new Error("evaluation timed out after 90ms"));
    expect(call.completed).toBe(true);
    expect(call.outcome).not.toBeNull();
    expect(JSON.stringify(call.outcome ?? {})).toContain("timed out after 90ms");
  });

  it("cancelLiveInvocations routes an orchestrated inner CallJob through host.abort with the original reason", () => {
    const c = chunk("stop-inner-orchestrated");
    const abort = vi.fn();
    const call = new AgentCallJob({
      toolCallId: "call-2",
      name: "agent/ask",
      workerSessionId: "worker-2",
      orchestrationResult: true,
      argsJson: JSON.stringify({ message: "audit" }),
    });
    c.registerJob(call);
    const reason = new Error("evaluation timed out after 90ms");
    cancelLiveInvocations(c, host({ abort }), reason);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0]?.[0]).toBe(call);
    expect(abort.mock.calls[0]?.[1]).toBe(reason);
  });
});
