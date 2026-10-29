/**
 * The positions a retention decision is made against. Everything here is read
 * from recorded facts: the completion order, each turn's R1 stamp, and the
 * tip's R3 clock. Nothing reads config, kv, the catalog or the wall clock, so
 * a restart re-projects byte-identically.
 */
import { CompletionExpectation, owningTurn, SessionTurn } from "@inhuman.tools/harness-model";

import { LEGACY_POLICY, parsePolicy, type ResolvedPolicy } from "./resolve.js";
import type { Horizon } from "./schema.js";

export type ClockReason = "turn" | "every" | "freed" | "cold" | "compaction" | "hold";

export type RetentionClock = {
  /** Uuid of the completion the deep horizons are evaluated against. */
  readonly at: string;
  readonly reason: ClockReason;
  readonly coldByMs?: number;
  readonly freedTokens?: number;
};

const REASONS: ReadonlySet<string> = new Set(["turn", "every", "freed", "cold", "compaction", "hold"]);

export function parseClock(json: string): RetentionClock | null {
  if (json === "") return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.at !== "string" || raw.at === "" || typeof raw.reason !== "string" || !REASONS.has(raw.reason)) {
      return null;
    }
    return {
      at: raw.at,
      reason: raw.reason as ClockReason,
      ...(typeof raw.coldByMs === "number" ? { coldByMs: raw.coldByMs } : {}),
      ...(typeof raw.freedTokens === "number" ? { freedTokens: raw.freedTokens } : {}),
    };
  } catch {
    return null;
  }
}

/** A turn's policy: its own R1 stamp, else the nearest tail's, else the legacy rule set. */
export function policyOfTurn(turn: SessionTurn | null): ResolvedPolicy {
  const seen = new Set<SessionTurn>();
  for (let cell: unknown = turn; cell instanceof SessionTurn && !seen.has(cell); cell = cell.turnTail) {
    seen.add(cell);
    const parsed = parsePolicy(cell.retentionJson);
    if (parsed !== null) return parsed;
  }
  return LEGACY_POLICY;
}

export type RetentionView = {
  readonly tip: CompletionExpectation;
  readonly order: readonly CompletionExpectation[];
  readonly tipPos: number;
  readonly tipTurn: number;
  /** Null: no recorded clock, so deep horizons never expire anything. */
  readonly clockPos: number | null;
  readonly clockTurn: number | null;
  readonly dialect: string | undefined;
  posOf(c: CompletionExpectation): number;
  turnOf(c: CompletionExpectation): number;
  policyOf(c: CompletionExpectation): ResolvedPolicy;
  /** The completion after `c`, which consumes `c`'s tool results. */
  nextOf(c: CompletionExpectation): CompletionExpectation | null;
};

export type ViewOptions = {
  /** Evaluate the deep horizons here instead of at the recorded clock. Used to estimate a step. */
  readonly clockAt?: CompletionExpectation | null;
  readonly dialect?: string;
};

/** `order` is the lead (kept zone) completions, then the spine, ending at the tip. */
export function buildView(
  tip: CompletionExpectation,
  order: readonly CompletionExpectation[],
  options: ViewOptions = {},
): RetentionView {
  const pos = new Map<CompletionExpectation, number>();
  const turnOrd = new Map<CompletionExpectation, number>();
  const turns = new Map<SessionTurn | null, number>();
  order.forEach((c, index) => {
    pos.set(c, index);
    const turn = owningTurn(c);
    if (!turns.has(turn)) turns.set(turn, turns.size);
    turnOrd.set(c, turns.get(turn) ?? 0);
  });
  const posOf = (c: CompletionExpectation): number => pos.get(c) ?? -1;
  const turnOf = (c: CompletionExpectation): number => turnOrd.get(c) ?? 0;
  let clockCompletion: CompletionExpectation | null;
  if (options.clockAt !== undefined) clockCompletion = options.clockAt;
  else {
    const clock = parseClock(tip.retentionClockJson);
    clockCompletion = clock === null ? null : (order.find((c) => c.uuid === clock.at) ?? null);
  }
  const clockPos = clockCompletion === null ? null : posOf(clockCompletion);
  return {
    tip,
    order,
    tipPos: posOf(tip),
    tipTurn: turnOf(tip),
    clockPos: clockPos === null || clockPos < 0 ? null : clockPos,
    clockTurn: clockPos === null || clockPos < 0 || clockCompletion === null ? null : turnOf(clockCompletion),
    dialect: options.dialect,
    posOf,
    turnOf,
    policyOf: (c) => policyOfTurn(owningTurn(c)),
    nextOf: (c) => order[posOf(c) + 1] ?? null,
  };
}

export type ItemPlace = {
  /** The completion whose input first contains the item. */
  readonly consumer: CompletionExpectation;
  /** The completion that produced or claimed the item; its turn is the item's turn. */
  readonly owner: CompletionExpectation;
  /** Evaluate against the tip instead of the clock. Pictures live only within their own turn. */
  readonly againstTip?: boolean;
};

/**
 * Any condition met expires the item. `newest` is decided by the caller,
 * which ranks items of one kind; it is not a span.
 */
export function horizonExpired(keep: readonly Horizon[], view: RetentionView, place: ItemPlace): boolean {
  const consumerPos = view.posOf(place.consumer);
  const ownerTurn = view.turnOf(place.owner);
  if (consumerPos < 0) return false;
  for (const h of keep) {
    if (h === "round") {
      if (view.tipPos - consumerPos >= 1) return true;
      continue;
    }
    if (h === "turn") {
      const ref = place.againstTip === true ? view.tipTurn : view.clockTurn;
      if (ref !== null && ref > ownerTurn) return true;
      continue;
    }
    if (h === "compaction" || h === "forever") continue;
    if ("rounds" in h) {
      const ref = h.rounds === 1 || place.againstTip === true ? view.tipPos : view.clockPos;
      if (ref !== null && ref - consumerPos >= h.rounds) return true;
      continue;
    }
    if ("turns" in h) {
      const ref = place.againstTip === true ? view.tipTurn : view.clockTurn;
      if (ref !== null && ref - ownerTurn >= h.turns) return true;
    }
  }
  return false;
}

export function newestOf(keep: readonly Horizon[]): number | null {
  let out: number | null = null;
  for (const h of keep) {
    if (typeof h === "object" && "newest" in h) out = out === null ? h.newest : Math.min(out, h.newest);
  }
  return out;
}
