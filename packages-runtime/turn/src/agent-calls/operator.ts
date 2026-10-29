/**
 * Operator views over child invocations and bot requests. Same Calls as the graph — no telemetry DB.
 */
import { CallJob, FailureOutcome, SessionRoot, SuccessfulOutcome, BotCallJob } from "@inhuman.tools/harness-model";

import { isCallPaused } from "./acceptance.js";
import { completeCallExceptionally } from "./runtime.js";
import type { AgentRuntimeHost, CallsCatalog } from "./types.js";

export type OperatorCallView = {
  readonly requestId: string;
  readonly callerSessionId: string;
  readonly tool: string;
  readonly workerSessionId: string;
  readonly contributionRevision: string;
  readonly state: "admitted" | "accepted" | "running" | "paused" | "terminal";
  readonly blocker: string | null;
  readonly delivery: "pending" | "delivered";
  readonly outcome: unknown | null;
};

function operatorDelivery(call: CallJob): OperatorCallView["delivery"] {
  return call.completed ? "delivered" : "pending";
}

function operatorState(call: CallJob, catalog: CallsCatalog): OperatorCallView["state"] {
  if (call.completed) return "terminal";
  if (isCallPaused(call, catalog)) return "paused";
  if (call instanceof BotCallJob && call.acceptedAt != null) return call.orchestrated ? "running" : "accepted";
  return call.orchestrated ? "running" : "admitted";
}

function operatorBlocker(call: CallJob, catalog: CallsCatalog): string | null {
  if (isCallPaused(call, catalog)) return "disabled";
  if (!(call instanceof BotCallJob) || call.diagnostic == null) return null;
  return call.diagnostic.message;
}

export function operatorCallView(call: CallJob, callerSessionId: string, catalog: CallsCatalog): OperatorCallView {
  const stamped = call.outcome;
  const terminal =
    stamped instanceof SuccessfulOutcome
      ? { ok: true as const, value: stamped.value }
      : stamped instanceof FailureOutcome
        ? { ok: false as const, code: stamped.code, message: stamped.message }
        : null;
  return {
    requestId: call.uuid,
    callerSessionId,
    tool: call.name,
    workerSessionId: call.workerSessionId,
    contributionRevision: call instanceof BotCallJob ? call.contributionRevision : "",
    state: operatorState(call, catalog),
    blocker: operatorBlocker(call, catalog),
    delivery: operatorDelivery(call),
    outcome: terminal,
  };
}

export function listAgentCalls(root: SessionRoot, catalog: CallsCatalog): OperatorCallView[] {
  const out: OperatorCallView[] = [];
  for (const node of root.motionWork()) {
    if (node instanceof CallJob) out.push(operatorCallView(node, root.sessionId, catalog));
  }
  return out;
}

export function inspectAgentCall(
  root: SessionRoot,
  requestId: string,
  catalog: CallsCatalog,
  load?: (id: string) => CallJob | undefined,
): OperatorCallView | undefined {
  const found = load?.(requestId);
  if (found instanceof CallJob) return operatorCallView(found, root.sessionId, catalog);
  for (const view of listAgentCalls(root, catalog)) {
    if (view.requestId === requestId) return view;
  }
  return undefined;
}

export function cancelAgentCall(
  host: AgentRuntimeHost,
  requestId: string,
  load?: (id: string) => CallJob | undefined,
): boolean {
  let call = load?.(requestId);
  if (call == null) {
    for (const node of host.caller.motionWork()) {
      if (node instanceof CallJob && node.uuid === requestId) {
        call = node;
        break;
      }
    }
  }
  if (!(call instanceof CallJob) || call.completed) return false;
  completeCallExceptionally(call, host, "cancelled");
  return true;
}
