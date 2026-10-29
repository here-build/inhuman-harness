/** Ask cover. Visible is not armed. Time since the last key does not arm. */

export const WEB_ASK_THROTTLE_MS = 1000;

export type CoverPhase = "inert" | "draft" | "cover_throttled" | "cover_armed";

export type CoverSeat = {
  readonly phase: CoverPhase;
  readonly leafId: string | null;
};

export function throttleMs(kernelThrottleMs: number | undefined): number {
  if (kernelThrottleMs === 0) return 0;
  return WEB_ASK_THROTTLE_MS;
}

/** A new leaf id is a new first ask. The same id does not re-arm. */
export function seatForAsk(previous: CoverSeat, leafId: string | null, draftEmpty: boolean, waitMs: number): CoverSeat {
  if (leafId == null) return { phase: "draft", leafId: null };
  if (previous.leafId === leafId && (previous.phase === "cover_throttled" || previous.phase === "cover_armed")) {
    return previous;
  }
  if (draftEmpty || waitMs === 0) return { phase: "cover_armed", leafId };
  return { phase: "cover_throttled", leafId };
}

export function armCover(seat: CoverSeat): CoverSeat {
  if (seat.phase !== "cover_throttled" || seat.leafId == null) return seat;
  return { phase: "cover_armed", leafId: seat.leafId };
}

/** Enter on a throttled cover does not write. Armed Enter writes only if that leaf is still the head. */
export function confirmCover(seat: CoverSeat, headLeafId: string | null): boolean {
  return seat.phase === "cover_armed" && seat.leafId != null && seat.leafId === headLeafId;
}
