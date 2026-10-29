import type { PublishedHealth, ReadinessKind, TopologyHealth } from "../schemas/health.js";
import type { SupervisionIdentity } from "../schemas/identity.js";
import type { OwnerEvidence, ReplacementDecision, ShutdownCutoff } from "../schemas/loss.js";

export function isPlaneReady(health: TopologyHealth | PublishedHealth, kind: ReadinessKind): boolean {
  return health[kind]?.state === "ready";
}

export function isSyncReady(health: TopologyHealth | PublishedHealth): boolean {
  return isPlaneReady(health, "sync");
}

export function isStorageReady(health: TopologyHealth | PublishedHealth): boolean {
  return isPlaneReady(health, "storage");
}

export function isExecutionReady(health: TopologyHealth | PublishedHealth): boolean {
  return isPlaneReady(health, "execution");
}

/** Same owner: hypervisor, process, server epoch, and runtime generation match. */
export function isSameExecutionOwner(left: SupervisionIdentity, right: SupervisionIdentity): boolean {
  return (
    left.hypervisor.id === right.hypervisor.id &&
    left.process.kind === right.process.kind &&
    left.process.id === right.process.id &&
    left.serverEpoch === right.serverEpoch &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

/** Live reconnect: same owner, strictly newer connection epoch. */
export function isReconnect(current: SupervisionIdentity, frame: SupervisionIdentity): boolean {
  return isSameExecutionOwner(current, frame) && frame.connectionEpoch > current.connectionEpoch;
}

function compareClocks(left: SupervisionIdentity, right: SupervisionIdentity): number {
  if (left.serverEpoch !== right.serverEpoch) {
    return left.serverEpoch - right.serverEpoch;
  }
  if (left.runtimeGeneration !== right.runtimeGeneration) {
    return left.runtimeGeneration - right.runtimeGeneration;
  }
  return left.connectionEpoch - right.connectionEpoch;
}

/**
 * Stale iff frame clocks are lexicographically behind current.
 * Newer clocks are never stale. Generation fencing rejects messages,
 * not already-dispatched external effects.
 */
export function isStaleSupervisionIdentity(current: SupervisionIdentity, frame: SupervisionIdentity): boolean {
  return compareClocks(frame, current) < 0;
}

export function replacementDecision(evidence: OwnerEvidence): ReplacementDecision {
  if (!evidence.exitConfirmed) {
    if (evidence.heartbeatMissing) {
      return { action: "refuse", reason: "heartbeat-is-not-death" };
    }
    if (evidence.dataDisconnected) {
      return { action: "refuse", reason: "disconnect-is-not-death" };
    }
    if (evidence.parentLost && !evidence.lockReleased) {
      return { action: "refuse", reason: "parent-loss-holds-runtime-lock" };
    }
    return { action: "refuse", reason: "exit-unconfirmed" };
  }
  if (!evidence.lockReleased) {
    return { action: "refuse", reason: "lock-held" };
  }
  return { action: "replace" };
}

export function mayReplaceExecutionOwner(evidence: OwnerEvidence): boolean {
  return replacementDecision(evidence).action === "replace";
}

/**
 * Yjs death still requires the previous runtime to exit and release its lock
 * before a new execution owner starts.
 */
export function mayStartExecutionOwnerAfterYjsLoss(runtime: OwnerEvidence): boolean {
  return mayReplaceExecutionOwner(runtime);
}

export function shutdownIsComplete(cutoff: ShutdownCutoff): boolean {
  return cutoff.drain === "complete" && cutoff.flush !== "pending";
}

/** Failed or forced-pending flush stays visible; it is not rewritten as success. */
export function shutdownFlushFailed(cutoff: ShutdownCutoff): boolean {
  return cutoff.flush === "failed" || (cutoff.forced && cutoff.flush === "pending");
}
