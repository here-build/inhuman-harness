/**
 * Role occupancy. One awareness lane, keyed by expectation uuid.
 * Schema is append-only (`PlexusAwareness.MAX_LANES` = 64); a lane per
 * expectation exhausts the budget. Retract the uuid on leave — occupancy
 * is presence, not a durable outcome. `""` occupies without a report frame.
 */
import { type PlexusAwareness } from "@here.build/plexus";

import { MapFieldAwareness } from "./map-field-awareness.js";
import { ROLE_EXPECTATIONS_LANE } from "./types.js";

export function reportRole(hub: PlexusAwareness, uuid: string, value: unknown): void {
  const field = lane(hub);
  if (value === null) {
    field.mapDelete(uuid);
    return;
  }
  field.mapSet(uuid, value);
}

export function retractRole(hub: PlexusAwareness, uuid: string): void {
  lane(hub).mapDelete(uuid);
}

/** First value for `uuid` across bases. Missing key is `undefined`. */
export function roleOf(hub: PlexusAwareness, uuid: string): unknown {
  return lane(hub).mapGet(uuid);
}

function lane(hub: PlexusAwareness): MapFieldAwareness {
  return new MapFieldAwareness(hub, ROLE_EXPECTATIONS_LANE);
}
