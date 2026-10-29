/**
 * Keep floors. The dial is `compactKeepTurns`; a ContextNeed preserve and the
 * session kv only raise it. Empty is never valid — 0 orphans the in-flight
 * exchange — so the mode default stands in when nothing is set.
 */
import type { CompactJob, ContextNeed } from "@inhuman.tools/harness-model";

/**
 * Minimum recent rounds kept when the floors are otherwise empty. 0 replaces the
 * whole eat — the in-flight exchange is orphaned and the model re-does work.
 * Mid-turn keeps the current round; explicit `/compact` keeps a little more
 * thread when the user opted in. A config dial >= 1 replaces both.
 */
export const DEFAULT_COMPACT_KEEP_TURNS = {
  midTurn: 1,
  explicit: 2,
} as const;

/** Session kv `compact.keep-turns` as a positive integer; 0 when unset or invalid. */
export function kvKeepTurnsOf(kv: Readonly<Record<string, string>> = {}): number {
  const raw = kv["compact.keep-turns"] ?? kv[":compact.keep-turns"];
  const parsed = raw == null ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 0;
}

/**
 * Record on the job the settings its cut is computed from (F8). Call once, when
 * the job is minted. After this the job's boundaries come from these stamped
 * values only: a later change to `compactKeepTurns` or session kv
 * `compact.keep-turns` moves neither this cutoff nor any earlier one, so a
 * round is neither lost nor shown twice. The ContextNeed `preserve` widths are
 * the other input; they are facts on the tape and read from there.
 */
export function stampCompactInputs(
  job: CompactJob,
  configFloor: number,
  kv: Readonly<Record<string, string>> = {},
): void {
  job.keepTurns = Math.max(Number.isInteger(configFloor) ? configFloor : 1, 1);
  job.kvKeepTurns = kvKeepTurnsOf(kv);
}

/**
 * Floors for a job's cut. A stamped job reads only its own stamps; the live
 * `kv` and `configFloor` apply to a job that was never stamped.
 */
export function keepFloorsOfJob(
  job: CompactJob,
  need: ContextNeed | null,
  live: { readonly kv: Readonly<Record<string, string>>; readonly configFloor: number },
): { readonly userTurns: number; readonly rounds: number } {
  if (job.keepTurns == null || job.keepTurns < 1) {
    return keepFloors(need, live.kv, job.reason === "user", live.configFloor);
  }
  const kv: Record<string, string> = job.kvKeepTurns >= 1 ? { "compact.keep-turns": String(job.kvKeepTurns) } : {};
  return keepFloors(need, kv, job.reason === "user", job.keepTurns);
}

export function keepFloors(
  need: ContextNeed | null,
  kv: Readonly<Record<string, string>> = {},
  forced = false,
  configFloor = 0,
): { readonly userTurns: number; readonly rounds: number } {
  const raw = kv["compact.keep-turns"] ?? kv[":compact.keep-turns"];
  const parsed = raw == null ? Number.NaN : Number(raw);
  const fromKv = Number.isInteger(parsed) && parsed >= 1 ? parsed : 0;
  const fromConfig = Number.isInteger(configFloor) && configFloor >= 1 ? configFloor : 0;
  const highest = Math.max(fromKv, fromConfig);
  const floor =
    highest > 0 ? highest : forced ? DEFAULT_COMPACT_KEEP_TURNS.explicit : DEFAULT_COMPACT_KEEP_TURNS.midTurn;
  return {
    userTurns: Math.max(floor, need?.preserve?.user_turns ?? 0),
    rounds: Math.max(floor, need?.preserve?.rounds ?? 0),
  };
}
