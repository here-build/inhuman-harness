/**
 * Occupancy facts the sync server supplies to runtime. Awareness is
 * ephemeral; unknown occupancy is not a seat grant. Membership changes are
 * stamped with a monotonic sequence and delivered atomically.
 */
import { z } from "zod";

export type OccupancySeat = {
  readonly sessionId: string;
  readonly clientId: number;
};

export type OccupancySnapshot = {
  readonly serverEpoch: number;
  readonly sequence: number;
  readonly seats: readonly OccupancySeat[];
};

const occupancySeatSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    clientId: z.number().int(),
  })
  .strict();

const occupancySnapshotSchema = z
  .object({
    serverEpoch: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    seats: z.array(occupancySeatSchema),
  })
  .strict();

export function occupiedSessionIdsOf(snapshot: OccupancySnapshot): Set<string> {
  const ids = new Set<string>();
  for (const seat of snapshot.seats) ids.add(seat.sessionId);
  return ids;
}

export function encodeOccupancySnapshot(snapshot: OccupancySnapshot): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

export function decodeOccupancySnapshot(bytes: Uint8Array): OccupancySnapshot | null {
  try {
    const parsed = occupancySnapshotSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
