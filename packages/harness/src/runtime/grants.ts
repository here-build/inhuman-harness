/**
 * Live delegated grants from admitted, unsettled calls on acquired replicas.
 * A grant needs both ends: the caller's CallJob and the worker's callback row
 * naming that caller. Settlement removes the grant; it does not erase the call.
 */
import { CallJob, type SessionRoot } from "@inhuman.tools/harness-model";

import type { DelegatedGrant } from "./types.js";

export function collectDelegatedGrants(
  scope: {
    replica(sessionId: string): { readonly root: SessionRoot } | undefined;
  },
  acquired: Iterable<string>,
): DelegatedGrant[] {
  const grants: DelegatedGrant[] = [];
  const seen = new Set<string>();
  for (const callerSessionId of acquired) {
    const replica = scope.replica(callerSessionId);
    if (replica == null) continue;
    for (const node of replica.root.motionWork()) {
      if (!(node instanceof CallJob) || node.completed || node.cancelled) continue;
      try {
        const callId = node.uuid.trim();
        const workerSessionId = node.workerSessionId.trim();
        if (callId === "" || workerSessionId === "") continue;
        // Session docs are peer-writable; the worker's own row is the other half of the edge.
        if (scope.replica(workerSessionId)?.root.agentCallbacks[callId] !== callerSessionId) continue;
        if (seen.has(callId)) continue;
        seen.add(callId);
        grants.push({ callId, callerSessionId, workerSessionId });
      } catch {
        // Unhomed jobs throw on uuid; they are not yet admitted grants.
      }
    }
  }
  return grants;
}
