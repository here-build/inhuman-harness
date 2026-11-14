/** Local durable-intent adapter; recovery itself belongs to the shared runtime. */
import type { Job } from "@inhuman.tools/plexus-expectations";

export { recoverSessionJobs, type RecoveredJob, type JobRecoveryOptions } from "@inhuman.tools/turn/runtime";

export type IntentGateResult =
  | { readonly ok: true; readonly required: false }
  | { readonly ok: true; readonly required: true }
  | { readonly ok: false; readonly reason: "storage-failed" | "disconnected" | "overload" };

/**
 * Recorded intent becomes dispatch only after a covering SQLite flush.
 * A job with intentRequired false skips the barrier.
 */
export async function persistJobIntent(flush: () => void | Promise<void>, job: Job): Promise<IntentGateResult> {
  if (!job.intentRequired) return { ok: true, required: false };
  try {
    await flush();
    return { ok: true, required: true };
  } catch {
    return { ok: false, reason: "storage-failed" };
  }
}
