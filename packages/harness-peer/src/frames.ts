import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
/** y-websocket `messageQueryAwareness`. Inbound counts as traffic for its 30s watchdog. */
export const MESSAGE_QUERY_AWARENESS = 3;

export function encodeDocUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export function replyLensSyncFrame(frame: Uint8Array, live: Y.Doc): Uint8Array | null {
  const decoder = decoding.createDecoder(frame);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null;
  if (decoding.readVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncStep1(decoder, encoder, live);
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

/** Document peer: STEP1 replies STEP2; STEP2/UPDATE apply onto `live` with `origin`. */
export function applyPeerSyncFrame(frame: Uint8Array, live: Y.Doc, origin: unknown): Uint8Array | null {
  const decoder = decoding.createDecoder(frame);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, live, origin);
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

export function peekMessageType(frame: Uint8Array): number {
  return decoding.readVarUint(decoding.createDecoder(frame));
}

export function encodeQueryAwareness(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_QUERY_AWARENESS);
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessFrame(payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

export function decodeAwarenessPayload(frame: Uint8Array): Uint8Array | null {
  try {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_AWARENESS) return null;
    return decoding.readVarUint8Array(decoder);
  } catch {
    return null;
  }
}
