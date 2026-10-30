/**
 * Awareness payload helpers. The DO never applies awareness; it only reads which
 * client ids a browser announced so it can tell the daemon when that browser is gone.
 *
 * Payload (y-protocols layout, same as the plexus hub's): varuint count, then per client
 * varuint id, varuint clock, varstring JSON state.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import { MESSAGE_AWARENESS } from "./constants.js";

/** [clientId, clock] */
export type AwarenessClient = readonly [number, number];

/** Clients named by an awareness frame (type byte included) with the state they announced. */
export function readAwarenessFrame(frame: Uint8Array): { id: number; clock: number; removed: boolean }[] {
  const decoder = decoding.createDecoder(frame);
  if (decoding.readVarUint(decoder) !== MESSAGE_AWARENESS) return [];
  const payload = decoding.createDecoder(decoding.readVarUint8Array(decoder));
  const count = decoding.readVarUint(payload);
  const out: { id: number; clock: number; removed: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(payload);
    const clock = decoding.readVarUint(payload);
    const state = decoding.readVarString(payload);
    out.push({ id, clock, removed: state === "null" });
  }
  return out;
}

/** A frame that removes `clients` (clock + 1, state null), as the y-websocket server sends on close. */
export function encodeAwarenessRemoval(clients: readonly AwarenessClient[]): Uint8Array {
  const payload = encoding.createEncoder();
  encoding.writeVarUint(payload, clients.length);
  for (const [id, clock] of clients) {
    encoding.writeVarUint(payload, id);
    encoding.writeVarUint(payload, clock + 1);
    encoding.writeVarString(payload, "null");
  }
  const frame = encoding.createEncoder();
  encoding.writeVarUint(frame, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(frame, encoding.toUint8Array(payload));
  return encoding.toUint8Array(frame);
}
