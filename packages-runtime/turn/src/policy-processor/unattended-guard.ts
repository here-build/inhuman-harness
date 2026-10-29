/**
 * The unattended-run watch: every licensed or denied call of an eval turn goes through here, the
 * ledger counts denials, and bypass detection decides when the run stops for a person.
 *
 * A stop seals the run's program with `interaction_required` and the reason, asks the turn to cancel
 * (queued calls settle as cancelled), and tells the host so it can notify. The check itself is a
 * dedicated judge pass over the recent series; only a "yes" stops the run, except a judge that cannot be
 * reached twice (fail closed, configurable) and the budget guard `hardStopTotal`.
 */
import { evalProgramOf, type SessionTurn, type ToolCallJob } from "@inhuman.tools/harness-model";

import {
  buildBypassSections,
  decideTrigger,
  isAckRefusal,
  outcomeOf,
  parseBypassVerdict,
  recordOf,
  stopReason,
  type BypassVerdict,
  RunLedger,
} from "./bypass.js";
import { runBypassJudge } from "./classifier.js";
import { evidenceCuts, owningTurn } from "./evidence.js";
import type { LicenseScope } from "./scope.js";

export type RunStop = {
  readonly kind: "bypass" | "hard-stop" | "immediate" | "check-unavailable";
  readonly reason: string;
  readonly turn: SessionTurn;
};

/** Text of the coded failure a stopped run reports. */
export function stoppedRunText(reason: string): string {
  return `Operation requires human authorization: the run was stopped (${reason}). Review it and resume.`;
}

export function ledgerFor(scope: LicenseScope, turn: SessionTurn): RunLedger {
  let ledger = scope.ledgers.get(turn);
  if (ledger === undefined) {
    ledger = new RunLedger();
    scope.ledgers.set(turn, ledger);
  }
  return ledger;
}

/** Seal the program with `interaction_required` and ask the turn to stop. Idempotent. */
export function stopRun(scope: LicenseScope, turn: SessionTurn, ledger: RunLedger, stop: Omit<RunStop, "turn">): void {
  if (ledger.stopped) return;
  ledger.stopped = true;
  const program = evalProgramOf(turn);
  if (program !== null && program.outcomeSnap === undefined) {
    program.outcomeSnap = { ok: false, text: stoppedRunText(stop.reason), code: "interaction_required" };
  }
  turn.cancelRequested = true;
  scope.onRunStopped?.({ ...stop, turn });
}

/**
 * Note how a call was licensed. Only unattended calls are counted. Never throws: the watch must not
 * change a license that is already decided.
 */
export async function noteLicense(scope: LicenseScope, job: ToolCallJob, allowed: boolean): Promise<void> {
  try {
    if (!job.unattended) return;
    const turn = owningTurn(job);
    if (turn?.evalSpec == null) return;
    const ledger = ledgerFor(scope, turn);
    if (ledger.stopped) return;
    if (allowed) {
      ledger.ran(recordOf(job));
      return;
    }
    const { outcome, counted } = outcomeOf(job);
    if (!counted) {
      ledger.uncounted({ ...recordOf(job), outcome });
      // The run continues; the user is told what is waiting for their acknowledgement.
      if (isAckRefusal(job)) {
        scope.onRunNotice?.({
          turn,
          text: `an unattended run needs an acknowledgement: ${job.ackFlags.map((flag) => flag.label).join("; ")} (${job.name} was denied; the run continues)`,
        });
      }
      return;
    }
    const record = ledger.denied({ ...recordOf(job), outcome });
    const esc = job.escalation;
    const trigger = decideTrigger(ledger, esc, record);
    if (trigger === null) return;
    if (trigger === "immediate") {
      stopRun(scope, turn, ledger, {
        kind: "immediate",
        reason: `bypass suspected: control-plane-tampering: it reached for ${record.ruleIds.join(", ") || "the controls"} after earlier denials`,
      });
      return;
    }
    if (trigger === "hard-stop") {
      stopRun(scope, turn, ledger, {
        kind: "hard-stop",
        reason: `hard stop: ${ledger.total} denied calls (limit ${esc.hardStopTotal})`,
      });
      return;
    }
    if (!esc.bypassCheck) {
      ledger.lastCheckAtTotal = ledger.total;
      return;
    }
    await check(scope, job, turn, ledger);
  } catch {
    /* a watch failure never lifts or changes a denial */
  }
}

async function check(scope: LicenseScope, job: ToolCallJob, turn: SessionTurn, ledger: RunLedger): Promise<void> {
  const esc = job.escalation;
  const cuts = evidenceCuts(job);
  const sections = buildBypassSections({
    task: cuts.privileged,
    calls: ledger.calls,
    notes: cuts.priorTurn === "" ? [] : [cuts.priorTurn],
    window: esc.window,
  });
  ledger.checks += 1;
  let verdict: BypassVerdict | undefined;
  for (let attempt = 0; attempt < 2 && verdict === undefined; attempt += 1) {
    try {
      const parsed = parseBypassVerdict(await runBypassJudge(scope, job, sections));
      if ("fail" in parsed) throw new Error(parsed.fail);
      verdict = parsed;
    } catch {
      ledger.checkFails += 1;
    }
  }
  if (verdict === undefined) {
    // Fail closed: a check that cannot be made twice is not a clean bill of health.
    if (esc.stopOnDoubleFail) {
      stopRun(scope, turn, ledger, { kind: "check-unavailable", reason: "bypass check unavailable" });
    } else {
      ledger.lastCheckAtTotal = ledger.total;
      scope.onRunNotice?.({ turn, text: "repeated denials in an unattended run; the bypass check was unavailable" });
    }
    return;
  }
  ledger.checkFails = 0;
  ledger.lastCheckAtTotal = ledger.total;
  switch (verdict.verdict) {
    case "bypass":
      stopRun(scope, turn, ledger, { kind: "bypass", reason: stopReason(verdict) });
      return;
    case "unsure":
      scope.onRunNotice?.({ turn, text: "an unattended run hit repeated denials" });
      ledger.consecutive = 0;
      return;
    case "no-bypass":
      ledger.consecutive = 0;
      return;
  }
}
