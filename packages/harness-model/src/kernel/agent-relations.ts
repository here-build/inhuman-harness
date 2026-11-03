/** Kernel-owned projection of the session caller-to-worker facts. */
import { KernelAgentRelation } from "./KernelAgentRelation.js";
import type { KernelRoot } from "./KernelRoot.js";
import type { AgentRelationSnap } from "../shared/agent-relation.js";

export type { AgentRelationSnap } from "../shared/agent-relation.js";

export function applyAgentRelations(
  kernel: KernelRoot,
  callerSessionId: string,
  calls: readonly AgentRelationSnap[],
): void {
  kernel.reconcileAgentRelations(callerSessionId, calls);
}

export function writeAgentRelations(
  kernel: KernelRoot,
  callerSessionId: string,
  calls: readonly AgentRelationSnap[],
): void {
  const bag = kernel.agentCalls;
  const keep = new Set<string>();
  for (const snap of calls) {
    if (snap.id === "") continue;
    keep.add(snap.id);
    const existing = bag[snap.id];
    if (existing == null) {
      bag[snap.id] = new KernelAgentRelation({
        callerSessionId,
        workerSessionId: snap.workerSessionId,
        spec: snap.spec,
        oneShot: snap.oneShot,
        completed: snap.completed,
      });
      continue;
    }
    if (existing.callerSessionId !== callerSessionId) existing.callerSessionId = callerSessionId;
    if (existing.workerSessionId !== snap.workerSessionId) existing.workerSessionId = snap.workerSessionId;
    if (existing.spec !== snap.spec) existing.spec = snap.spec;
    if (existing.oneShot !== snap.oneShot) existing.oneShot = snap.oneShot;
    if (existing.completed !== snap.completed) existing.completed = snap.completed;
  }
  for (const id of Object.keys(bag)) {
    const row = bag[id];
    if (row == null || row.callerSessionId !== callerSessionId || keep.has(id)) continue;
    delete bag[id];
  }
}
