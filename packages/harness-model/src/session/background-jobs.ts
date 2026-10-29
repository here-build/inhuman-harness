/**
 * Background work is the job the interpreter already owns. `job_id` is
 * `toolCallId`. No second registry.
 *
 * A program's kind is every host call in the expr ({@link programKind}).
 * `scheme_watch` is a workflow even when those calls are one kind.
 * Listing waits on the reader so the check-in is not the unsettled default.
 */
import type { JobKind } from "@inhuman.tools/plexus-expectations";

import { AgentCallNotification } from "./jobs/AgentCallNotification.js";
import { CallJob } from "./jobs/CallJob.js";
import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import { SystemToolJob } from "./jobs/SystemToolJob.js";
import { programKind } from "./program-kind.js";
import { SCHEME_WATCH_TOOL_NAME } from "./scheme-syntax.js";

export { programKind } from "./program-kind.js";

export type BackgroundJobKind = JobKind;

export type LiveBackgroundJob = {
  readonly jobId: string;
  readonly kind: BackgroundJobKind;
  readonly object: string;
};

/** Host tool that lists or cancels background work. It is not a security decision. */
export const JOB_STOP_TOOL_NAME = "job_stop";

function isTrackedBackground(node: unknown): node is ProgrammaticJob | CallJob | SystemToolJob {
  if (node instanceof ProgrammaticJob || node instanceof CallJob || node instanceof SystemToolJob) {
    return node.isTrackedBackground;
  }
  return false;
}

export async function liveBackgroundJobs(nodes: Iterable<unknown>): Promise<LiveBackgroundJob[]> {
  const tracked: (ProgrammaticJob | CallJob | SystemToolJob)[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!isTrackedBackground(node) || node.completed || node.cancelled) continue;
    if (node.toolCallId === "" || seen.has(node.toolCallId)) continue;
    seen.add(node.toolCallId);
    tracked.push(node);
  }
  return Promise.all(
    tracked.map(async (node) => {
      if (node instanceof ProgrammaticJob && node.toolName !== SCHEME_WATCH_TOOL_NAME) await programKind(node.expr);
      return { jobId: node.toolCallId, kind: node.kind, object: node.object };
    }),
  );
}

export function liveJobsCheckIn(jobs: readonly LiveBackgroundJob[]): string {
  if (jobs.length === 0) return "";
  return `background jobs:\n${jobs.map((job) => `${job.jobId} ${job.kind} ${job.object}`.trim()).join("\n")}`;
}

export function pendingResultNotes(
  nodes: Iterable<unknown>,
  claimed: ReadonlySet<AgentCallNotification>,
): AgentCallNotification[] {
  const out: AgentCallNotification[] = [];
  for (const node of nodes) {
    if (node instanceof CallJob || node instanceof ProgrammaticJob) {
      for (const note of node.notifications) {
        if (!note.result || claimed.has(note) || note.message.trim() === "") continue;
        out.push(note);
      }
      continue;
    }
    if (node instanceof SystemToolJob && node.resultNote != null) {
      const note = node.resultNote;
      if (note.result && !claimed.has(note) && note.message.trim() !== "") out.push(note);
    }
  }
  return out;
}

export type JobStopReport =
  | { readonly ok: true; readonly value: { readonly jobs: readonly LiveBackgroundJob[] } }
  | {
      readonly ok: true;
      readonly value: { readonly job_id: string; readonly status: "cancelled" | "completed" | "absent" };
    }
  | { readonly ok: false; readonly text: string };
