/**
 * Stop predicate and leftover rejection for a turn. Accepted-work Calls stay.
 * In-flight BODY abort is the caller's `abort`.
 */
import { ApprovableJob, CallJob, SessionTurn } from "@inhuman.tools/harness-model";
import { walkWork } from "@inhuman.tools/plexus-expectations";

import { shouldSkipTurnCancel } from "../agent-calls/acceptance.js";
import { type CallsCatalog } from "../agent-calls/index.js";
import { cancelUnstartedTool } from "../tool-runtime/index.js";

export function turnLoopStopped(turn: SessionTurn, signal: AbortSignal): boolean {
  return signal.aborted || turn.reducerExited || turn.cancelRequested;
}

/**
 * Leftovers settle as cancelled so the turn's join and the session's open
 * tool count release. An orchestrated leaf is also aborted: its executor may
 * be gone, and a cancelled job is never claimed again.
 */
export function failLeftoverApprovables(
  turn: SessionTurn,
  abort: (leaf: ApprovableJob) => void,
  catalog: CallsCatalog,
): void {
  for (const node of walkWork(turn)) {
    if (!(node instanceof ApprovableJob)) continue;
    if (node.completed || node.cancelled) continue;
    if (node instanceof CallJob && shouldSkipTurnCancel(node, catalog)) continue;
    if (node.orchestrated) abort(node);
    cancelUnstartedTool(node);
    if (!node.completed) node.markComplete();
  }
}
