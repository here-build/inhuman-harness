/**
 * Cancel/deny receipts on work results. Executors stamp these onto the leaf;
 * squeeze/paint is a context projection, not this module.
 */
import { cancelOutcomeText } from "./abort-origin.js";
import { ApprovableJob } from "./jobs/ApprovableJob.js";
import { CallJob } from "./jobs/CallJob.js";
import { FailureOutcome } from "./jobs/CallOutcome.js";
import { ToolCallJob } from "./jobs/ToolCallJob.js";

export const POLICY_PROHIBITS =
  "Policy prohibits this tool use. Do not try to bypass it; if this is crucial, ask user to do it";
export const CLASSIFIER_DENIED = "Classifier marked this tool use as dangerous; ask user to confirm this action";
export const USER_REFUSED = "User refused this tool use";
export const INTERACTION_REQUIRED =
  "This needs a person to approve it, and nobody is available to answer in an unattended run. Do not try to bypass it; pick another way to do the task, or stop and report what needs approval.";
export const NOT_REQUESTED =
  "The user did not explicitly ask for this action. Do not try to bypass it; ask the user to request it.";

/** An unattended run reached a call that needs the user's acknowledgement and none is stored. */
export function acknowledgementRequiredText(labels: readonly string[]): string {
  return `Needs acknowledgement: ${labels.join("; ")}. The user asked to confirm this before it runs, and nobody is available to answer in an unattended run. Do not try to bypass it; pick another way to do the task, or stop and report that this needs the user's acknowledgement.`;
}

export function refusalReasonOf(leaf: ApprovableJob): string {
  if (leaf.humanApprove === false) return USER_REFUSED;
  if (leaf.licenseDetail.code === "interaction_required") {
    return leaf.ackPending && leaf.baseLicenseDetail.decision === true
      ? acknowledgementRequiredText(leaf.ackFlags.map((flag) => flag.label)) : INTERACTION_REQUIRED;
  }
  if (leaf.classifierResult === "deny") {
    if (leaf.judgeKind === "soft-deny") return NOT_REQUESTED;
    return CLASSIFIER_DENIED;
  }
  const message = leaf.policyMessage?.trim() ?? "";
  if (message !== "") return message;
  return POLICY_PROHIBITS;
}

function hasReceipt(leaf: ApprovableJob): boolean {
  if (leaf instanceof CallJob) return leaf.outcome != null;
  if (leaf instanceof ToolCallJob) return leaf.receiptJson != null && leaf.receiptJson !== "";
  return true;
}

/** Receipt first so observers never see `completed` with an empty `outcomeJson`. */
export function applyToolOutcomeReceipt(leaf: ApprovableJob, text: "denied" | "cancelled", reason?: unknown): boolean {
  if (hasReceipt(leaf)) return false;
  if (leaf instanceof CallJob) {
    leaf.outcome = new FailureOutcome(
      text === "denied"
        ? {
            code: "denied",
            message: refusalReasonOf(leaf),
          }
        : {
            code: "cancelled",
            message: cancelOutcomeText(reason),
          },
    );
    return true;
  }
  if (leaf instanceof ToolCallJob) {
    leaf.outcomeSnap = text === "denied" ? denialSnap(leaf) : { ok: false, text: cancelOutcomeText(reason) };
    return true;
  } else {
    return false;
  }
}

function denialSnap(leaf: ApprovableJob): {
  ok: false;
  text: string;
  refusalReason: string;
  code?: "policy_denied" | "interaction_required";
} {
  const refusalReason = refusalReasonOf(leaf);
  if (leaf.humanApprove === false) return { ok: false, text: refusalReason, refusalReason };
  const code = leaf.licenseDetail.code === "interaction_required" ? "interaction_required" : "policy_denied";
  return { ok: false, text: refusalReason, refusalReason, code };
}

/**
 * Denial stamp. Machine deny (eval) keeps `code: "policy_denied"`.
 * `refusalReason` is the sentence. `text` repeats it so older readers still show it.
 */
export function applyDenyReceipt(leaf: ApprovableJob): boolean {
  if (hasReceipt(leaf)) return false;
  if (leaf instanceof CallJob) {
    leaf.outcome = new FailureOutcome({
      code: "denied",
      message: refusalReasonOf(leaf),
    });
    return true;
  }
  if (!(leaf instanceof ToolCallJob)) return false;
  leaf.outcomeSnap = denialSnap(leaf);
  return true;
}

export function applyCancelReceipt(leaf: ApprovableJob, reason?: unknown): boolean {
  return applyToolOutcomeReceipt(leaf, "cancelled", reason);
}

/**
 * Unstarted (or allow-side but not yet BODY) cancel. Does not write
 * `approved` or `orchestrationResult`. Squeeze is a later context projection;
 * the executor-facing `cancelUnstartedTool` lives on the server stamp.
 */
export function cancelUnstarted(leaf: ApprovableJob, reason?: unknown): void {
  if (leaf.completed || leaf.cancelled) return;
  applyCancelReceipt(leaf, reason);
  leaf.cancelled = true;
  if (!leaf.orchestrated) leaf.markComplete();
}
