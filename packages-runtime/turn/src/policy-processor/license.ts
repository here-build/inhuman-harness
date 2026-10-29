/**
 * Monadic license. Admits the leaf onto the session intern, waits until
 * LICENSE WHEN is a boolean, returns process-or-not. Floor and residual
 * kicks live on `LicenseScope`. Does not write `approved`,
 * `orchestrationResult`, or `regenerateable`. Nothing is remembered from a
 * human allow here: a stored grant is a separate, explicit answer
 * (`ask/answer` with `store`), and a soft-deny is licensed per call.
 * Scope close mid-wait is not-process (false), not a throw. A boolean
 * LICENSE WHEN still wins — Allow is a durable vote and must not lose to dispose.
 */
import { JOB_STOP_TOOL_NAME, type SessionRoot, type SessionTurn, type ToolCallJob } from "@inhuman.tools/harness-model";
import { when } from "mobx";

import { scopes } from "./scope.js";
import { noteLicense } from "./unattended-guard.js";

/**
 * A denial the host decided before the license wait (an already-stamped block or deny). It still
 * counts toward the unattended run's ledger.
 */
export async function noteDenied(job: ToolCallJob, root: SessionRoot): Promise<void> {
  await noteLicense(scopes.get(root), job, false);
}

/**
 * A tool's `isSideChannel` skips the floor. `triggersReactLoop: false` is
 * loop control its author chose, not a license. `job_stop` skips too: the
 * body only cancels jobs this session already spawned.
 */
export async function license(job: ToolCallJob, _turn: SessionTurn | null, root: SessionRoot): Promise<boolean> {
  if (job.commFirst || job.isSideChannel || job.name === JOB_STOP_TOOL_NAME) return true;
  const scope = scopes.get(root);
  scope.admit(job);
  try {
    await when(() => scope.closed || job.cancelled || job.completed || job.licenseDecision !== null);
    if (job.cancelled || job.completed) return false;
    const decision = job.licenseDecision;
    if (decision === null) return false;
    // The unattended watch counts the call; a denial may be the one that trips bypass detection.
    await noteLicense(scope, job, decision);
    return decision;
  } finally {
    scope.release(job);
  }
}
