/**
 * Kernel-plane occupancy. A client attached to a session publishes a seat.
 * Presence is awareness (drops on disconnect / 30s timeout), not KernelRoot.
 * Origin (tui / web / mobile) is a later field on the same object — not a second lane.
 */
import { FieldAwareness, type PlexusAwareness } from "@here.build/plexus";
import type { KernelAwareness as PewKernelAwareness } from "@inhuman.tools/plexus-expectations";

import type { AgentNature } from "../recipe-scope.js";
import { isConversationOverview } from "./SessionOverview.js";

export const KERNEL_SEAT_LANE = "seat";

export type KernelSeat = {
  readonly sessionId: string;
};

/** Seat is SDK; attention lanes are PEW kernel occupancy. */
export type KernelAwareness = PewKernelAwareness & {
  seat?: KernelSeat;
};

export function publishKernelSeat(hub: PlexusAwareness, sessionId: string | null): void {
  const lane = new FieldAwareness(hub, KERNEL_SEAT_LANE);
  const id = sessionId?.trim() ?? "";
  if (id === "") {
    lane.clear();
    return;
  }
  lane.set({ sessionId: id } as never);
}

export function occupiedSessionIds(hub: PlexusAwareness): Set<string> {
  const lane = new FieldAwareness(hub, KERNEL_SEAT_LANE);
  const ids = new Set<string>();
  for (const clientId of lane.clientIds) {
    const seat = asSeat(lane.getOther(clientId));
    if (seat != null) ids.add(seat.sessionId);
  }
  return ids;
}

/**
 * Other windows still attached to `sessionId`. The local seat is excluded —
 * a lone window is 0, so leaving it may cancel the shared turn. A second
 * window is ≥ 1, so `/new` must not stop the loop that window is watching.
 */
export function otherSessionSeatCount(hub: PlexusAwareness, sessionId: string): number {
  const id = sessionId.trim();
  if (id === "") return 0;
  const lane = new FieldAwareness(hub, KERNEL_SEAT_LANE);
  let count = 0;
  for (const seat of lane.getOthers().values()) {
    if (asSeat(seat)?.sessionId === id) count += 1;
  }
  return count;
}

export function sessionIsOccupied(hub: PlexusAwareness, sessionId: string): boolean {
  return occupiedSessionIds(hub).has(sessionId);
}

/** Map value for `unseatedConversationIds`. Workers inhabit this; `isConversationOverview` is the cut. */
export type UnseatedConversationOverview = {
  readonly lastMessageAt: number | null;
  readonly recipeScope?: AgentNature;
  readonly oneShot?: boolean;
};

/** Recency-desc, occupied rows omitted. Glance has no path yet — this list is global. Named workers are not resume targets. */
export function unseatedConversationIds(
  sessions: Record<string, UnseatedConversationOverview | undefined>,
  occupied: ReadonlySet<string>,
): string[] {
  return Object.entries(sessions)
    .filter((entry): entry is [string, UnseatedConversationOverview] => {
      const glance = entry[1];
      return glance != null && isConversationOverview(glance) && !occupied.has(entry[0]);
    })
    .sort((a, b) => (b[1].lastMessageAt ?? 0) - (a[1].lastMessageAt ?? 0))
    .map(([id]) => id);
}

function asSeat(value: unknown): KernelSeat | null {
  if (typeof value !== "object" || value === null) return null;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string") return null;
  const id = sessionId.trim();
  return id === "" ? null : { sessionId: id };
}
