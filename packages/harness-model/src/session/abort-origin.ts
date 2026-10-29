/**
 * Abort reason → model-facing cancel receipt. Timeout keeps its origin;
 * every other abort stays the honest `cancelled` token. `AbortSignal.any`
 * often surfaces a generic AbortError (`This operation was aborted`) —
 * that is cancel, not a tool body.
 */
const TIMEOUT_AFTER = /timed out after \d+\s*ms/i;
/** What our timers abort with: `… timed out`, optionally `after Nms`. */
const TIMED_OUT = /\btimed out(?: after \d+\s*ms)?$/i;
const GENERIC_ABORT = /this operation was aborted/i;

export function isAbortError(reason: unknown): boolean {
  if (reason instanceof DOMException && reason.name === "AbortError") return true;
  if (reason instanceof Error && reason.name === "AbortError") return true;
  return reason instanceof Error && GENERIC_ABORT.test(reason.message);
}

export function isTimeoutAbortReason(reason: unknown): boolean {
  if (reason instanceof DOMException && reason.name === "TimeoutError") return true;
  return reason instanceof Error && TIMED_OUT.test(reason.message.trim());
}

/** Receipt `text` for a cancel. Does not write `approved`. */
export function cancelOutcomeText(reason?: unknown): string {
  if (!isTimeoutAbortReason(reason)) return "cancelled";
  if (reason instanceof Error) {
    const message = reason.message.replace(/^Error:\s*/i, "").trim();
    if (TIMEOUT_AFTER.test(message)) return message;
    if (message !== "" && reason.name !== "TimeoutError") return message;
  }
  return "timed out";
}
