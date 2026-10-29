/**
 * Kernel caller → worker edges. Snap from an interned tape; write onto
 * {@link KernelRoot.agentCalls}. Listing TUI reads the map.
 */
import { KernelAgentRelation } from "./KernelAgentRelation.js";
import type { KernelRoot } from "./KernelRoot.js";
import { AgentCallJob } from "../session/jobs/AgentCallJob.js";
import { BotCallJob } from "../session/jobs/BotCallJob.js";
import { CallJob } from "../session/jobs/CallJob.js";
import type { SessionRoot } from "../session/SessionRoot.js";

export type AgentRelationSnap = {
  readonly id: string;
  readonly workerSessionId: string;
  readonly spec: string;
  readonly oneShot: boolean;
  readonly completed: boolean;
};

export function outgoingAgentRelations(root: SessionRoot): AgentRelationSnap[] {
  const out: AgentRelationSnap[] = [];
  const seen = new Set<CallJob>();
  for (const node of root.motionWork()) {
    if (!(node instanceof CallJob) || seen.has(node)) continue;
    seen.add(node);
    const workerSessionId = node.workerSessionId.trim();
    const id = node.uuid.trim();
    if (workerSessionId === "" || id === "") continue;
    const specFromArgs = node.args?.spec;
    const spec =
      (typeof specFromArgs === "string" ? specFromArgs.trim() : "") ||
      (node instanceof BotCallJob ? (node.botName ?? "").trim() || (node.contributionBotName ?? "").trim() : "");
    out.push({
      id,
      workerSessionId,
      spec,
      oneShot: node instanceof AgentCallJob,
      completed: node.completed,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

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
