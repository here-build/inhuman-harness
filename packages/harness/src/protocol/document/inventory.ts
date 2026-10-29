/**
 * Identity inventory: catalog rows, pagination cuts, invalidations, and
 * explicit gaps. Filenames are hashes; overviews are not the catalog.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import { readDocumentKey, writeDocumentKey, type DocumentKey, type DocumentKind } from "./keys.js";

export type InventoryEntry = {
  readonly key: DocumentKey;
  readonly durableRevision: number;
  readonly storagePath: string;
};

export type InventoryCheckpoint = {
  readonly serverEpoch: number;
  readonly cut: number;
};

export type InventoryPage = {
  readonly entries: readonly InventoryEntry[];
  readonly cursor: string | null;
  readonly checkpoint: InventoryCheckpoint;
};

export type InventoryListQuery = {
  readonly kind: DocumentKind;
  readonly cursor: string | null;
};

export type InventoryGapReason = "overflow" | "missing-checkpoint" | "epoch-change";

export type InventoryWatchEvent =
  | {
      readonly type: "change";
      readonly key: DocumentKey;
      readonly revision: number;
    }
  | {
      readonly type: "gap";
      readonly reason: InventoryGapReason;
      readonly serverEpoch: number;
    };

export type InventoryErrorReason = "mismatch" | "corrupt" | "empty" | "decode-failure";

export type InventoryError = {
  readonly storagePath: string;
  readonly reason: InventoryErrorReason;
};

export function encodeInventoryWatchEvent(event: InventoryWatchEvent): Uint8Array {
  const encoder = encoding.createEncoder();
  if (event.type === "change") {
    encoding.writeVarUint(encoder, 0);
    writeDocumentKey(encoder, event.key);
    encoding.writeVarUint(encoder, event.revision);
  } else {
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarString(encoder, event.reason);
    encoding.writeVarUint(encoder, event.serverEpoch);
  }
  return encoding.toUint8Array(encoder);
}

export function decodeInventoryWatchEvent(bytes: Uint8Array): InventoryWatchEvent | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === 0) {
      const key = readDocumentKey(decoder);
      const revision = decoding.readVarUint(decoder);
      return { type: "change", key, revision };
    }
    if (type === 1) {
      const reason = decoding.readVarString(decoder);
      if (reason !== "overflow" && reason !== "missing-checkpoint" && reason !== "epoch-change") return null;
      const serverEpoch = decoding.readVarUint(decoder);
      return { type: "gap", reason, serverEpoch };
    }
    return null;
  } catch {
    return null;
  }
}
