/**
 * Append-only Yjs image.
 *
 * Every update is preceded by its length. A torn final entry is ignored;
 * earlier complete entries remain readable without rewriting the image.
 */
import { Buffer } from "node:buffer";

import * as decoding from "lib0/decoding";
import * as Y from "yjs";

const LENGTH_BYTES = 4;

/** Unchanged state encodes as `[0, 0]`, not a 0-length buffer. */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.byteLength === 0 || (update.byteLength === 2 && update[0] === 0 && update[1] === 0);
}

/**
 * The updates in order. A caller applies them onto one document one after
 * another: a later entry is a delta and does not stand on its own, so
 * merging them into one buffer drops everything after the first.
 *
 * A torn last entry (crash before fsync) is dropped. Earlier entries stay.
 */
export function readUpdateLog(bytes: Uint8Array): Uint8Array[] | null {
  if (bytes.byteLength === 0) return null;

  const prefixed = readPrefixed(bytes, 0);
  if (prefixed != null && prefixed.updates.length > 0) {
    if (!prefixed.updates.every(isOneUpdate)) return null;
    return prefixed.updates;
  }
  // Images saved before the length prefix are one bare update. A length read
  // of those bytes is a torn empty log, which used to report the session missing.
  if (isOneUpdate(bytes)) return [bytes];
  return null;
}

/** Length prefix plus the update. Appending it extends a log. */
export function encodeLogEntry(update: Uint8Array): Uint8Array {
  const entry = new Uint8Array(LENGTH_BYTES + update.byteLength);
  writeLength(entry, update.byteLength);
  entry.set(update, LENGTH_BYTES);
  return entry;
}

type Prefixed = {
  readonly updates: Uint8Array[];
  readonly torn: boolean;
};

/** Length-prefixed entries from `start`. A short final entry is torn, not corrupt. */
function readPrefixed(bytes: Uint8Array, start: number): Prefixed | null {
  if (start > bytes.byteLength) return null;
  const updates: Uint8Array[] = [];
  let offset = start;
  while (offset + LENGTH_BYTES <= bytes.byteLength) {
    const length = readLength(bytes, offset);
    if (length <= 0) return null;
    if (offset + LENGTH_BYTES + length > bytes.byteLength) {
      return { updates, torn: true };
    }
    updates.push(bytes.subarray(offset + LENGTH_BYTES, offset + LENGTH_BYTES + length));
    offset += LENGTH_BYTES + length;
  }
  if (offset !== bytes.byteLength) return { updates, torn: true };
  return { updates, torn: false };
}

/** Bytes of the first Yjs message, or null when the buffer is not one. */
function yjsUpdateEnd(bytes: Uint8Array): number | null {
  const decoder = decoding.createDecoder(bytes);
  const doc = new Y.Doc();
  try {
    Y.readUpdate(decoder, doc);
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
  const end = decoder.pos;
  return end > 0 && end <= bytes.byteLength ? end : null;
}

function isOneUpdate(update: Uint8Array | undefined): update is Uint8Array {
  if (update == null) return false;
  return yjsUpdateEnd(update) === update.byteLength;
}

function readLength(bytes: Uint8Array, offset: number): number {
  return Buffer.from(bytes.buffer, bytes.byteOffset + offset, LENGTH_BYTES).readUInt32BE(0);
}

function writeLength(bytes: Uint8Array, length: number): void {
  Buffer.from(bytes.buffer, bytes.byteOffset, LENGTH_BYTES).writeUInt32BE(length, 0);
}
