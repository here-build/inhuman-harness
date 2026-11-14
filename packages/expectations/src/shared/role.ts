/**
 * Role occupancy. One awareness lane, keyed by expectation uuid.
 * Using one lane per expectation would grow the lane schema unboundedly; keep
 * all expectations in one lane and retract the uuid on leave — occupancy
 * is presence, not a durable outcome. `""` occupies without a report frame.
 */
import { type ReactiveAwareness } from "@inhuman.tools/model";

import { MapFieldAwareness } from "./map-field-awareness.js";
import { ROLE_EXPECTATIONS_LANE } from "./types.js";

export function reportRole(hub: ReactiveAwareness, uuid: string, value: unknown): void {
  const field = lane(hub);
  if (value === null) {
    field.mapDelete(uuid);
    return;
  }
  field.mapSet(uuid, value);
}

export function retractRole(hub: ReactiveAwareness, uuid: string): void {
  lane(hub).mapDelete(uuid);
}

/** First value for `uuid` across bases. Missing key is `undefined`. */
export function roleOf(hub: ReactiveAwareness, uuid: string): unknown {
  return lane(hub).mapGet(uuid);
}

function lane(hub: ReactiveAwareness): MapFieldAwareness {
  return new MapFieldAwareness(hub, ROLE_EXPECTATIONS_LANE);
}
