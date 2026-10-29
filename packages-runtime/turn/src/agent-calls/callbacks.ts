/**
 * Callback settlement and caller-call lookup on acquired replicas.
 */
import {
  AGENT_VOID,
  CallJob,
  AgentCallbackJob,
  assertResponseMatchesSchema,
  FailureOutcome,
  SuccessfulOutcome,
  type SessionRoot,
} from "@inhuman.tools/harness-model";

import type { AgentCallScope } from "./types.js";

export function loadCall(scope: AgentCallScope, callerSessionId: string, uuid: string): CallJob | undefined {
  const found = scope.replica(callerSessionId)?.loadEntity(uuid);
  return found instanceof CallJob ? found : undefined;
}

/** Callback-row requestId → caller replica Call. Not every open Call. */
export function loadOpenCall(scope: AgentCallScope, session: SessionRoot, uuid: string): CallJob | undefined {
  const callerId = session.agentCallbacks[uuid] as string | undefined;
  if (callerId == null || callerId === "") return undefined;
  return loadCall(scope, callerId, uuid);
}

/**
 * Worker callback settles the caller Call. Typed output validation is a host
 * hook so this package does not import plugin-sdk.
 */
export function settleCallFromCallback(
  call: CallJob,
  job: AgentCallbackJob,
  validateValue?: (call: CallJob, value: unknown) => unknown | null,
): void {
  if (job.name === AGENT_VOID) {
    const settled = new SuccessfulOutcome();
    settled.value = job.args?.value ?? null;
    call.settleResult(settled);
    return;
  }
  const args = job.args ?? {};
  if ("value" in args) {
    const validated = validateValue?.(call, args.value);
    if (validated != null) {
      const settled = new SuccessfulOutcome();
      settled.value = validated;
      call.settleResult(settled);
      return;
    }
  }
  const response = job.argString("response");
  const schema = call.responseSchema;
  if (schema != null) {
    try {
      assertResponseMatchesSchema(response, JSON.stringify(schema));
    } catch (error) {
      call.settleResult(
        new FailureOutcome({
          code: "response_schema",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    const settled = new SuccessfulOutcome();
    settled.value = JSON.parse(response);
    call.settleResult(settled);
    return;
  }
  const settled = new SuccessfulOutcome();
  settled.value = response;
  call.settleResult(settled);
}
