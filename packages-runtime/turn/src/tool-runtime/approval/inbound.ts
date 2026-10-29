/**
 * LICENSE WHEN is the Approvable guard. Sequences typically return true;
 * inbound Turn waits predecessors without returning false (false is deny).
 */
import { FieldAwareness } from "@here.build/plexus";
import {
  ApprovableJob,
  applyDenyReceipt,
  SessionTurn,
  type PermissionMode,
  type SessionPlexus,
} from "@inhuman.tools/harness-model";
import { when } from "mobx";

function inboundPredecessorClosed(turn: SessionTurn): boolean {
  if (!turn.inbound) return true;
  const seen = new Set<SessionTurn>([turn]);
  let prior = turn.turnTail;
  while (prior instanceof SessionTurn && !seen.has(prior)) {
    seen.add(prior);
    if (!prior.reducerExited) return false;
    if (!prior.inbound) break;
    prior = prior.turnTail;
  }
  return true;
}

/** Sequence guard: wait, then true. Never false — that would deny BODY. */
export function inboundTurnGuard(turn: SessionTurn): boolean | Promise<true> {
  if (inboundPredecessorClosed(turn)) return true;
  return (async () => {
    await when(() => inboundPredecessorClosed(turn) || turn.cancelled || turn.completed);
    return true as const;
  })();
}

export function publishPolicyError(session: SessionPlexus, text: string | null): void {
  try {
    const lane = new FieldAwareness(session.awareness, "policyError");
    if (text == null || text === "") lane.clear();
    else lane.set(text);
  } catch {
    /* presence must not block the floor vote */
  }
}

/** Floor produce is policy-processor `license`. `_policy` is unused — writing it would fork the receipt. */
export function stampLicenseDeny(leaf: ApprovableJob, _policy: PermissionMode): void {
  applyDenyReceipt(leaf);
}
