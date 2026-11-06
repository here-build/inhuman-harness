import { MESSAGE_AWARENESS } from "./constants.js";

/** [clientId, clock] */
export type AwarenessClient = readonly [number, number];

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Clients named by an awareness frame (type byte included) with the state they announced. */
export function readAwarenessFrame(frame: Uint8Array): { id: number; clock: number; removed: boolean }[] {
  if (frame.byteLength < 1 || frame[0] !== MESSAGE_AWARENESS) return [];
  try {
    const jsonStr = textDecoder.decode(frame.subarray(1));
    const parsed = JSON.parse(jsonStr) as {
      entries?: Array<[number, Record<string, unknown> | null, number?]>;
    };
    if (!Array.isArray(parsed.entries)) return [];
    const out: { id: number; clock: number; removed: boolean }[] = [];
    for (const entry of parsed.entries) {
      const id = entry[0];
      const state = entry[1];
      const clock = entry[2] ?? 0;
      out.push({ id, clock, removed: state === null });
    }
    return out;
  } catch {
    return [];
  }
}

/** A frame that removes `clients` (clock + 1, state null). */
export function encodeAwarenessRemoval(clients: readonly AwarenessClient[]): Uint8Array {
  const entries: Array<[number, null, number]> = [];
  for (const [id, clock] of clients) {
    entries.push([id, null, clock + 1]);
  }
  const payload = textEncoder.encode(JSON.stringify({ entries }));
  const frame = new Uint8Array(1 + payload.byteLength);
  frame[0] = MESSAGE_AWARENESS;
  frame.set(payload, 1);
  return frame;
}
