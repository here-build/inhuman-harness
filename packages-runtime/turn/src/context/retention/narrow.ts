/**
 * Narrowing algebra. A narrowing layer appends conditions to `keep` ("whichever
 * comes first"), may replace `leave` with a shorter remainder, and may lower
 * `minChars`. It cannot lengthen anything: a source that tries is ignored for
 * that key and reported.
 */
import { horizonList, NONE_FORBIDDEN_KINDS, type Horizon, type Leave, type RuleInput } from "./schema.js";

/** How long a single condition keeps an item, as a comparable number. */
export function horizonRank(h: Horizon): number {
  if (h === "round") return 1;
  if (h === "turn") return 1000;
  if (h === "compaction") return 1_000_000;
  if (h === "forever") return 10_000_000;
  if ("rounds" in h) return h.rounds;
  if ("turns" in h) return 1000 * h.turns;
  return Number.POSITIVE_INFINITY; // `newest` bounds a count, not a span
}

/** Any-of semantics: the shortest condition decides how long an item lives. */
export function keepRank(keep: readonly Horizon[]): number {
  if (keep.length === 0) return 1_000_000;
  return Math.min(...keep.map(horizonRank));
}

/** Canonical form of an any-of condition list: the tightest of each type, in a fixed order. */
export function canonicalKeep(keep: readonly Horizon[]): Horizon[] {
  let turns = Number.POSITIVE_INFINITY;
  let rounds = Number.POSITIVE_INFINITY;
  let newest = Number.POSITIVE_INFINITY;
  let compaction = false;
  let forever = false;
  for (const h of keep) {
    switch (h) {
      case "round": {
        rounds = Math.min(rounds, 1);
        break;
      }
      case "turn": {
        turns = Math.min(turns, 1);
        break;
      }
      case "compaction": {
        compaction = true;
        break;
      }
      case "forever": {
        forever = true;
        break;
      }
      default:
        if ("rounds" in h) rounds = Math.min(rounds, h.rounds);
        else if ("turns" in h) turns = Math.min(turns, h.turns);
        else newest = Math.min(newest, h.newest);
    }
  }
  const out: Horizon[] = [];
  if (Number.isFinite(turns)) out.push(turns === 1 ? "turn" : { turns });
  if (Number.isFinite(rounds)) out.push(rounds === 1 ? "round" : { rounds });
  if (Number.isFinite(newest)) out.push({ newest });
  // `compaction` and `forever` only matter when nothing else bounds the item.
  if (out.every((h): boolean => typeof h === "object" && "newest" in h)) {
    if (compaction) out.push("compaction");
    else if (forever) out.push("forever");
  }
  return out;
}

export function narrowKeep(base: readonly Horizon[], over: readonly Horizon[]): Horizon[] {
  return canonicalKeep([...base, ...over]);
}

/** Remainder size, smallest first: none, a one-line stub, a summary, then `head` by length. */
export function leaveRank(leave: Leave): number {
  if (leave === "none") return 0;
  if (leave === "stub") return 80;
  if (leave === "summary") return 400;
  return leave.head;
}

export function narrowLeave(base: Leave | undefined, over: Leave | undefined, kind: string | null): Leave | undefined {
  if (over === undefined) return base;
  if (over === "none" && kind !== null && NONE_FORBIDDEN_KINDS.has(kind)) return base;
  if (base === undefined) return over;
  return leaveRank(over) < leaveRank(base) ? over : base;
}

/** True when `over` shortens `base` in at least one respect. */
export function narrows(base: RuleInput, over: RuleInput, kind: string | null): boolean {
  const overKeep = horizonList(over.keep);
  if (overKeep.length > 0) {
    const baseKeep = horizonList(base.keep);
    if (baseKeep.length === 0 || keepRank(overKeep) < keepRank(baseKeep)) return true;
    if (overKeep.some((h) => typeof h === "object" && "newest" in h)) return true;
  }
  if (over.leave !== undefined && narrowLeave(base.leave, over.leave, kind) !== base.leave) return true;
  if (over.minChars !== undefined && (base.minChars === undefined || over.minChars < base.minChars)) return true;
  return false;
}

/** `base ∧ over`. The result never lives longer than `base`. */
export function narrowRule(base: RuleInput, over: RuleInput, kind: string | null): RuleInput {
  const keep = narrowKeep(horizonList(base.keep), horizonList(over.keep));
  const leave = narrowLeave(base.leave, over.leave, kind);
  const minChars =
    over.minChars === undefined ? base.minChars : Math.min(base.minChars ?? Number.POSITIVE_INFINITY, over.minChars);
  let onError = base.onError;
  if (over.onError != null) {
    onError =
      base.onError == null
        ? over.onError
        : {
            keep: narrowKeep(horizonList(base.onError.keep), horizonList(over.onError.keep)),
            leave: narrowLeave(base.onError.leave, over.onError.leave, "error") ?? base.onError.leave,
          };
  }
  return {
    ...(keep.length === 0 ? {} : { keep: keep.length === 1 ? keep[0]! : keep }),
    ...(leave === undefined ? {} : { leave }),
    ...(minChars === undefined || !Number.isFinite(minChars) ? {} : { minChars }),
    ...(onError === undefined ? {} : { onError }),
  };
}
