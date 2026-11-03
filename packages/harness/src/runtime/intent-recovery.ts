/** Local durable-intent adapter; recovery itself belongs to the shared runtime. */
import type { Job } from "@inhuman.tools/plexus-expectations";

import { documentKeysEqual, type DocumentKey, type DurableReceipt } from "@/protocol/document";

import type { RuntimeDocuments } from "./compose.js";

export { recoverSessionJobs, type RecoveredJob, type JobRecoveryOptions } from "@inhuman.tools/turn/runtime";

export type IntentGateResult =
  | { readonly ok: true; readonly required: false }
  | { readonly ok: true; readonly required: true; readonly receipt: DurableReceipt }
  | { readonly ok: false; readonly reason: "storage-failed" | "disconnected" | "overload" };

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
