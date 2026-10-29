/**
 * Cancel and generic outcome stamps on the leaf. Payload construction lives
 * in harness-model. Cancel writes `cancelled`, not `approved`. Human
 * `approvalComment` is a `TurnApprovalNoteChunk`, not this receipt.
 */
import { ApprovableJob, applyToolOutcomeReceipt, cancelUnstarted } from "@inhuman.tools/harness-model";
import { action } from "mobx";

export function stampToolOutcome(leaf: ApprovableJob, text: "denied" | "cancelled", reason?: unknown): void {
  applyToolOutcomeReceipt(leaf, text, reason);
}

/**
 * Unstarted (or allow-side but not yet BODY) cancel. Does not write
 * `approved` or `orchestrationResult`.
 */
export const cancelUnstartedTool = action((leaf: ApprovableJob, reason?: unknown): void => {
  if (leaf.completed || leaf.cancelled) return;
  cancelUnstarted(leaf, reason);
});
