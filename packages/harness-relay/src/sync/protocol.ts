/**
 * Copied from plexus/packages/plexus-do/src/protocol.ts (same author; the owner
 * relicenses it MIT here). Lanes and the awareness plane are dropped: one doc per
 * room, awareness never applied here.
 *
 * y-websocket framing: leading varuint message type, then a sync step or an
 * awareness payload. Frames arrive fully reassembled (ChunkedDOTransport).
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

import { MESSAGE_SYNC } from "./constants.js";

export const SYNC_STEP1 = syncProtocol.messageYjsSyncStep1;
export const SYNC_STEP2 = syncProtocol.messageYjsSyncStep2;

/** Apply a sync frame to `doc`. Returns the reply (step1 gets step2) or null. */
export function handleSyncFrame(message: Uint8Array, doc: Y.Doc, origin: unknown): Uint8Array | null {
  const decoder = decoding.createDecoder(message);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

/** The message type, then the sync sub-type when it is a sync frame; -1 when absent. */
export function peekFrame(message: Uint8Array): { type: number; sync: number } {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readVarUint(decoder);
  return { type, sync: type === MESSAGE_SYNC && decoding.hasContent(decoder) ? decoding.readVarUint(decoder) : -1 };
}

export function encodeSyncStep1(doc: Y.Doc, messageType: number = MESSAGE_SYNC): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export function encodeDocUpdate(update: Uint8Array, messageType: number = MESSAGE_SYNC): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}
