/**
 * R3: the retention clock. Deep horizons expire against `at`, which only moves
 * at a step, so between steps the projected prefix is byte-stable and only the
 * tail grows. The live inputs (wall clock, prior `warmUntilMs`, estimated
 * savings) are read once here and recorded; the projection reads only `at`.
 */
import { CompletionExpectation, latestCompactCutoff, owningTurn } from "@inhuman.tools/harness-model";

import { projectHistory } from "../history.js";
import type { StepConfig } from "./schema.js";
import { parseClock, policyOfTurn, type ClockReason, type RetentionClock } from "./view.js";

export type StepFacts = {
  readonly self: string;
  readonly step: StepConfig;
  /** Prior completion on the spine: its recorded clock target, and when its cache lapses. */
  readonly prior: { readonly at: string | null; readonly warmUntilMs: number | null } | null;
  readonly turnFirstRound: boolean;
  readonly afterCutoff: boolean;
  /** Rounds between the prior clock target and this completion. */
  readonly roundsSinceAt: number;
  readonly now: number;
  /** Estimated tokens a step would free. Lazy: walks the spine. */
  readonly freedTokens: () => number;
};

/** Pure: the order is compaction, turn, cold, every, freed, else hold. */
export function decideRetentionStep(f: StepFacts): RetentionClock {
  const step = (reason: ClockReason, extra: Partial<RetentionClock> = {}): RetentionClock => ({
    at: f.self,
    reason,
    ...extra,
  });
  if (f.afterCutoff && f.step.atCompaction) return step("compaction");
  const priorAt = f.prior?.at ?? null;
  if (priorAt === null) return step("turn");
  if (f.turnFirstRound && f.step.turnBoundary) return step("turn");
  const warm = f.prior?.warmUntilMs ?? null;
  if (f.step.whenCacheCold && warm !== null && f.now > warm) return step("cold", { coldByMs: f.now - warm });
  if (f.step.everyRounds !== null && f.roundsSinceAt >= f.step.everyRounds) return step("every");
  if (f.step.minFreedTokens > 0) {
    const freed = f.freedTokens();
    if (freed >= f.step.minFreedTokens) return step("freed", { freedTokens: freed });
  }
  return { at: priorAt, reason: "hold" };
}

function tokensOf(rows: Iterable<unknown>): number {
  let chars = 0;
  for (const row of rows)
    chars += JSON.stringify(row, (_key, value) => (value instanceof Uint8Array ? value.length : value)).length;
  return Math.ceil(chars / 4);
}

/**
 * Stamp `tip.retentionClockJson` when its round opens. Call once the
 * completion is on its turn's tape (it must be reachable from its turn).
 */
export function stampRetentionClock(tip: CompletionExpectation, now: number = Date.now()): RetentionClock {
  const turn = owningTurn(tip);
  const policy = policyOfTurn(turn);
  const spine = tip.spine();
  const index = spine.indexOf(tip);
  const prior = index > 0 ? spine[index - 1]! : null;
  const priorAt = prior === null ? null : (parseClock(prior.retentionClockJson)?.at ?? null);
  const priorPos = priorAt === null ? -1 : spine.findIndex((c) => c.uuid === priorAt);
  const clock = decideRetentionStep({
    self: tip.uuid,
    step: policy.step,
    prior: prior === null ? null : { at: priorPos < 0 ? null : priorAt, warmUntilMs: prior.warmUntilMs },
    turnFirstRound: prior === null || owningTurn(prior) !== turn,
    afterCutoff: prior === null && turn !== null && latestCompactCutoff(turn) !== null,
    roundsSinceAt: priorPos < 0 ? 0 : index - priorPos,
    now,
    freedTokens: () => {
      const held = spine[priorPos];
      if (held === undefined) return 0;
      const before = tokensOf(projectHistory(tip, { clockAt: held }));
      const after = tokensOf(projectHistory(tip, { clockAt: tip }));
      return Math.max(0, before - after);
    },
  });
  tip.retentionClockJson = JSON.stringify(clock);
  return clock;
}
