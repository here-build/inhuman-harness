import type { DocumentContainer } from "@inhuman.tools/model";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;
export const MESSAGE_SHAPE = 4;

export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeDocUpdate(update: Uint8Array): Uint8Array {
  const frame = new Uint8Array(2 + update.byteLength);
  frame[0] = MESSAGE_SYNC;
  frame[1] = SYNC_UPDATE;
  frame.set(update, 2);
  return frame;
}

export function encodeSyncStep1(doc: DocumentContainer<any, any>): Uint8Array {
  const vector = doc.encodeStateVector();
  const frame = new Uint8Array(2 + vector.byteLength);
  frame[0] = MESSAGE_SYNC;
  frame[1] = SYNC_STEP1;
  frame.set(vector, 2);
  return frame;
}

export function replyLensSyncFrame(frame: Uint8Array, live: DocumentContainer<any, any>): Uint8Array | null {
  if (frame.byteLength < 2 || frame[0] !== MESSAGE_SYNC || frame[1] !== SYNC_STEP1) return null;
  const update = live.encodeStateAsUpdate();
  const reply = new Uint8Array(2 + update.byteLength);
  reply[0] = MESSAGE_SYNC;
  reply[1] = SYNC_STEP2;
  reply.set(update, 2);
  return reply;
}

export function applyPeerSyncFrame(
  frame: Uint8Array,
  live: DocumentContainer<any, any>,
  origin: unknown,
): Uint8Array | null {
  if (frame.byteLength < 2 || frame[0] !== MESSAGE_SYNC) return null;
  const subType = frame[1];
  if (subType === SYNC_STEP1) {
    const update = live.encodeStateAsUpdate();
    const reply = new Uint8Array(2 + update.byteLength);
    reply[0] = MESSAGE_SYNC;
    reply[1] = SYNC_STEP2;
    reply.set(update, 2);
    return reply;
  }
  if (subType === SYNC_STEP2 || subType === SYNC_UPDATE) {
    live.applyUpdate(frame.subarray(2), origin);
    return null;
  }
  return null;
}

export function peekMessageType(frame: Uint8Array): number {
  return frame[0] ?? -1;
}

export function encodeQueryAwareness(): Uint8Array {
  return new Uint8Array([MESSAGE_QUERY_AWARENESS]);
}

export function encodeAwarenessFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + payload.byteLength);
  frame[0] = MESSAGE_AWARENESS;
  frame.set(payload, 1);
  return frame;
}

export function decodeAwarenessPayload(frame: Uint8Array): Uint8Array | null {
  if (frame.byteLength < 1 || frame[0] !== MESSAGE_AWARENESS) return null;
  return frame.subarray(1);
}

export function encodeShapeFrame(payload: unknown): Uint8Array {
  const jsonBytes = textEncoder.encode(JSON.stringify(payload));
  const frame = new Uint8Array(1 + jsonBytes.byteLength);
  frame[0] = MESSAGE_SHAPE;
  frame.set(jsonBytes, 1);
  return frame;
}

export function decodeShapeFrame(frame: Uint8Array): unknown | null {
  if (frame.byteLength < 1 || frame[0] !== MESSAGE_SHAPE) return null;
  try {
    return JSON.parse(textDecoder.decode(frame.subarray(1)));
  } catch {
    return null;
  }
}
