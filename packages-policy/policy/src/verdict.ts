/**
 * Votes on the strict lattice. `join` is `lattice` that keeps the rules which decided the tier:
 * the result is the strictest disposition and the union of the votes at exactly that disposition.
 */
import type { ClassId } from "./classes.js";
import type { Disposition, FloorVerdict, FloorVote, UnitIdentity } from "./types.js";

const RANK: Readonly<Record<Disposition, number>> = { policyApprove: 0, ask: 1, deny: 2, block: 3 };

export const APPROVE: FloorVerdict = { disposition: "policyApprove", votes: [] };

export function rank(disposition: Disposition): number {
  return RANK[disposition];
}

/** A single vote. An approve carries no vote: it names no class. */
export function cast(
  disposition: Disposition,
  cls: ClassId,
  ruleId: string,
  extra?: Pick<FloorVote, "unit" | "lift" | "path">,
): FloorVerdict {
  if (disposition === "policyApprove") return APPROVE;
  return { disposition, votes: [{ disposition, class: cls, ruleId, ...extra }] };
}

/** Strictest of the verdicts, with the votes at that tier (deduplicated by rule, class and unit). */
export function join(verdicts: readonly FloorVerdict[]): FloorVerdict {
  const joined = joinVotes(verdicts);
  const seen = mergeSeen(verdicts);
  return seen === undefined ? joined : { ...joined, seen };
}

function mergeSeen(verdicts: readonly FloorVerdict[]): readonly UnitIdentity[] | undefined {
  const out = new Map<string, UnitIdentity>();
  for (const verdict of verdicts) for (const unit of verdict.seen ?? []) out.set(JSON.stringify(unit), unit);
  return out.size === 0 ? undefined : [...out.values()];
}

function joinVotes(verdicts: readonly FloorVerdict[]): FloorVerdict {
  let top: Disposition = "policyApprove";
  for (const verdict of verdicts) if (rank(verdict.disposition) > rank(top)) top = verdict.disposition;
  if (top === "policyApprove") return APPROVE;
  const seen = new Set<string>();
  const votes: FloorVote[] = [];
  for (const verdict of verdicts) {
    if (verdict.disposition !== top) continue;
    for (const vote of verdict.votes) {
      if (vote.disposition !== top) continue;
      const key = JSON.stringify([vote.ruleId, vote.class, vote.unit, vote.lift, vote.path]);
      if (seen.has(key)) continue;
      seen.add(key);
      votes.push(vote);
    }
  }
  return { disposition: top, votes };
}

/** Same verdict with every vote stamped with a unit (shell units only). */
export function withUnit(verdict: FloorVerdict, unit: FloorVote["unit"]): FloorVerdict {
  if (unit === undefined || verdict.votes.length === 0) return verdict;
  return { disposition: verdict.disposition, votes: verdict.votes.map((vote) => ({ unit, ...vote })) };
}
