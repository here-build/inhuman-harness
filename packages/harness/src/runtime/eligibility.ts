/**
 * Least-fixpoint eligibility from seats, the resident bit, mint reservations,
 * and admitted-call grants. A cycle with no root outside itself is never
 * reached, so it cannot keep itself alive.
 */
import { AskAgentSpec, type SessionRoot } from "@inhuman.tools/harness-model";

import type { EligibilitySnapshot } from "./types.js";

/** A mint reservation roots a conversation; workers and one-shots are not conversations. */
export function isConversationSession(root: SessionRoot): boolean {
  const spec = root.agent.spec;
  return spec.recipeScope === "" && !(spec instanceof AskAgentSpec);
}

function reservationRoot(sessionId: string, snap: EligibilitySnapshot): boolean {
  return snap.reserved.has(sessionId) && snap.conversations.has(sessionId);
}

function eligibilityRoots(snap: EligibilitySnapshot): Set<string> {
  const roots = new Set<string>();
  for (const id of snap.acquired) {
    if (snap.occupied.has(id) || snap.resident.has(id) || reservationRoot(id, snap)) {
      roots.add(id);
    }
  }
  return roots;
}

/**
 * Sessions that may honor. Unacquired workers are skipped even when a
 * grant names them — no replica, no observers or honor.
 */
export function graphEligibleSessionIds(snap: EligibilitySnapshot): Set<string> {
  const eligible = eligibilityRoots(snap);
  let grew = true;
  while (grew) {
    grew = false;
    for (const grant of snap.grants) {
      if (!eligible.has(grant.callerSessionId)) continue;
      if (!snap.acquired.has(grant.workerSessionId)) continue;
      if (eligible.has(grant.workerSessionId)) continue;
      eligible.add(grant.workerSessionId);
      grew = true;
    }
  }
  return eligible;
}
