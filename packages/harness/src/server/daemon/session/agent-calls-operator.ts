/**
 * Compatibility shim. Operator views live in harness-agent-calls.
 */
import type { CallJob } from "@inhuman.tools/harness-model";
import { cancelAgentCall as cancelAgentCallOnScope } from "@inhuman.tools/turn/agent-calls";

import { callHost, type AgentRuntimeHost } from "./agent-runtime.js";

export function cancelAgentCall(
  host: AgentRuntimeHost,
  requestId: string,
  load?: (id: string) => CallJob | undefined,
): boolean {
  return cancelAgentCallOnScope(callHost(host), requestId, load);
}
