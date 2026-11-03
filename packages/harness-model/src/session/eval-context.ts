/**
 * Locate an admitted programmatic run from the owning turn, never from
 * whichever turn is currently session head. `evalSpec` is the unattended
 * fact; observer policy overlays do not participate.
 *
 * Floor / residual votes: `PolicyResult` / `JudgeResult`. There is no
 * judge `fail` vote — a failed attempt is `classifierAbstain` on the leaf.
 */
import { walkWork, type WorkContainer } from "@inhuman.tools/plexus-expectations";

import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import type { SessionRoot } from "./SessionRoot.js";
import { reactChunks, type SessionTurn } from "./turn/session-turn.js";

/** Floor vote. `null` is unevaluated — not a vote. Dist fallback is `ask`.
 * `block` is unliftable. `deny` holds in all three permission modes. */
export type PolicyResult = "policyApprove" | "deny" | "ask" | "block" | null;

/**
 * Auto residual vote. `null` is unevaluated. No `fail`. No `ask`.
 * A failed attempt is `classifierAbstain` on the leaf, not a third vote.
 */
export type JudgeResult = "allow" | "deny" | null;

export {
  PERMISSION_MODES,
  type PermissionMode,
  isPermissionMode,
  parsePermissionMode,
  sessionMintPermissionMode,
} from "../shared/permission-mode.js";

/** Unattended subset of {@link PERMISSION_MODES}. */
export const EVAL_PERMISSION_MODES = ["auto", "yolo"] as const;
export type EvalPermissionMode = (typeof EVAL_PERMISSION_MODES)[number];

export function isEvalPermissionMode(value: string): value is EvalPermissionMode {
  return value === "auto" || value === "yolo";
}

export function findTurnById(root: SessionRoot, turnId: string): SessionTurn | null {
  for (const turn of root.liveTurns) {
    if (turn.uuid === turnId) return turn;
  }
  return null;
}

export function findEvalTurnByRequestId(root: SessionRoot, requestId: string): SessionTurn | null {
  for (const turn of root.liveTurns) {
    if (turn.evalSpec?.requestId === requestId) return turn;
  }
  return null;
}

export function isEvalRequestCancelled(root: SessionRoot, requestId: string): boolean {
  return requestId !== "" && requestId in root.cancelledEvalRequests;
}

export function evalProgramOf(turn: SessionTurn, programId?: string): ProgrammaticJob | null {
  for (const chunk of reactChunks(turn)) {
    if (!(chunk instanceof ProgrammaticJob)) continue;
    if (programId == null || programId === "" || chunk.uuid === programId) return chunk;
  }
  return null;
}

export function hostingTurnOf(root: SessionRoot, job: WorkContainer): SessionTurn | null {
  for (const turn of root.liveTurns) {
    if (turn === job) return turn;
    for (const node of walkWork(turn)) {
      if (node === job) return turn;
    }
  }
  return null;
}
