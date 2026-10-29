/**
 * K1 recovery on Y1 DocumentService. Intent receipt before dispatch;
 * failed write is not success. Live daemons bind this from SessionDaemon;
 * RuntimeServer binds it on reconnect.
 */
import {
  CallJob,
  ApprovableJob,
  CompletionJob,
  FailureOutcome,
  MCPToolJob,
  ProgrammaticJob,
  cancelUnstarted,
  SessionRoot,
  SessionTurn,
  ToolCallJob,
  WebExtractToolJob,
  WebSearchToolJob,
} from "@inhuman.tools/harness-model";
import { Job, WorkExpectation } from "@inhuman.tools/plexus-expectations";
import { restorePendingRound, settleCancelledTurn, type CallsCatalog } from "@inhuman.tools/turn/agent-calls";
import { runInAction } from "mobx";

import { documentKeysEqual, type DocumentKey, type DurableReceipt } from "@/protocol/document";

import type { RuntimeDocuments } from "./compose.js";

const UNKNOWN_TEXT = "interrupted by restart; execution outcome unknown";

type JobRecoveryAction = "settled" | "dispatch" | "unknown" | "cancel" | "resume-inner";

export type IntentGateResult =
  | { readonly ok: true; readonly required: false }
  | {
      readonly ok: true;
      readonly required: true;
      readonly receipt: DurableReceipt;
    }
  | {
      readonly ok: false;
      readonly reason: "storage-failed" | "disconnected" | "overload";
    };

export type RecoveredJob = {
  readonly job: Job;
  readonly kind: string;
  readonly action: JobRecoveryAction;
};

export type JobRecoveryOptions = {
  readonly catalog?: CallsCatalog;
  readonly releaseCall?: (call: CallJob) => void;
};

function hasSettlement(job: Job): boolean {
  if (job.completed) return true;
  if (job instanceof ToolCallJob || job instanceof ProgrammaticJob) {
    return job.receiptJson != null && job.receiptJson !== "";
  }
  if (job instanceof CompletionJob) return job.expectation.isDone;
  return false;
}

function leftoverInFlight(job: Job): boolean {
  if (job instanceof MCPToolJob && job.dispatched) return true;
  if (job instanceof MCPToolJob || job instanceof WebSearchToolJob || job instanceof WebExtractToolJob) {
    const attempt = job.expectation;
    return !attempt.isDone && attempt.startedAtMs != null;
  }
  return false;
}

function hasRecordedIntent(job: Job): boolean {
  return job.orchestrated || leftoverInFlight(job);
}

function failOpen(job: Job, code: "crash" | "cancel", text: string): void {
  for (const node of job.work) {
    if (node instanceof WorkExpectation && !node.isDone) node.fail(code, text, "null");
  }
}

function stampUnknown(job: Job): void {
  if (job instanceof CallJob) {
    job.settleResult(new FailureOutcome({ code: "error", message: UNKNOWN_TEXT }));
    return;
  }
  if (job instanceof ToolCallJob || job instanceof ProgrammaticJob) {
    job.outcomeSnap ??= { ok: false, text: UNKNOWN_TEXT };
  }
  failOpen(job, "crash", UNKNOWN_TEXT);
  if (!job.completed) job.markComplete();
}

/** A cancelled job the crash left open closes with a cancel receipt and no open attempt. */
function settleCancelled(job: Job): void {
  if (job instanceof ApprovableJob) cancelUnstarted(job);
  else if (job instanceof ProgrammaticJob) job.outcomeSnap ??= { ok: false, text: "cancelled" };
  failOpen(job, "cancel", "terminated by recovery; outcome unknown");
  if (!job.completed) job.markComplete();
}

/** Classify one job from its effect fields. */
function classifyJobRecovery(job: Job): JobRecoveryAction {
  // A closed turn whose cancel never landed can still hold an open completion.
  if (job instanceof SessionTurn && job.cancelRequested) return "cancel";
  if (job.completed) return "settled";
  if (job.cancelled) return "cancel";
  switch (job.unknownRecovery) {
    case "unknown-no-replay":
      if (hasSettlement(job)) return "settled";
      return hasRecordedIntent(job) ? "unknown" : "dispatch";
    case "resume-inner":
      return "resume-inner";
    case "resume-queued":
      return "dispatch";
    default:
      // A contract-less job is not ours to replay.
      return hasRecordedIntent(job) ? "unknown" : "dispatch";
  }
}

function applyJobRecovery(
  job: Job,
  action: JobRecoveryAction,
  catalog: CallsCatalog | undefined,
  releaseCall?: (call: CallJob) => void,
  session?: SessionRoot,
): void {
  switch (action) {
    case "settled":
    case "dispatch":
      return;
    case "unknown":
      stampUnknown(job);
      return;
    case "cancel":
      if (job instanceof SessionTurn) settleCancelledTurn(job, catalog, releaseCall, session);
      else settleCancelled(job);
      return;
    case "resume-inner":
      if (job instanceof SessionTurn) restorePendingRound(job);
      return;
  }
}

export function recoverSessionJobs(root: SessionRoot, options: JobRecoveryOptions = {}): RecoveredJob[] {
  const nodes: Job[] = [];
  for (const node of root.motionWork()) {
    if (node instanceof Job) nodes.push(node);
  }
  // A turn re-enters before its children are classified: it reads the round
  // the interruption left open, and the child's recovery closes that round.
  nodes.sort((a, b) => Number(b instanceof SessionTurn) - Number(a instanceof SessionTurn));
  const recovered: RecoveredJob[] = [];
  runInAction(() => {
    for (const job of nodes) {
      const action = classifyJobRecovery(job);
      applyJobRecovery(job, action, options.catalog, options.releaseCall, root);
      recovered.push({ job, kind: job.__type__, action });
    }
  });
  return recovered;
}

/**
 * Recorded intent becomes dispatch only after a covering flush.
 * A job with intentRequired false skips the barrier.
 */
export async function persistJobIntent(
  service: RuntimeDocuments,
  key: DocumentKey,
  job: Job,
): Promise<IntentGateResult> {
  if (!job.intentRequired) return { ok: true, required: false };
  const checkpoint = service.checkpoint(key);
  if (checkpoint == null) return { ok: false, reason: "disconnected" };
  if (!documentKeysEqual(checkpoint.key, key) || checkpoint.serverEpoch !== service.serverEpoch) {
    return { ok: false, reason: "disconnected" };
  }
  const result = await service.flush(checkpoint.key, checkpoint);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, required: true, receipt: result.receipt };
}
