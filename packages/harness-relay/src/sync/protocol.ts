import {
  applyPeerSyncFrame,
  encodeDocUpdate as encodePeerDocUpdate,
  encodeSyncStep1 as encodePeerSyncStep1,
  peekMessageType,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
} from "@inhuman.tools/harness-peer/frames";
import type { DocumentContainer } from "@inhuman.tools/model";

import { MESSAGE_SYNC } from "./constants.js";

export { SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE };

export function handleSyncFrame(
  message: Uint8Array,
  doc: DocumentContainer<any, any>,
  origin: unknown,
): Uint8Array | null {
  return applyPeerSyncFrame(message, doc, origin);
}

export function peekFrame(message: Uint8Array): { type: number; sync: number } {
  if (message.byteLength === 0) return { type: -1, sync: -1 };
  const type = peekMessageType(message);
  const sync = type === MESSAGE_SYNC && message.byteLength >= 2 ? message[1] : -1;
  return { type, sync };
}

export function encodeSyncStep1(doc: DocumentContainer<any, any>): Uint8Array {
  return encodePeerSyncStep1(doc);
}

export function encodeDocUpdate(update: Uint8Array): Uint8Array {
  return encodePeerDocUpdate(update);
}
