/**
 * Identity inventory: catalog rows, pagination cuts, invalidations, and
 * explicit gaps. Filenames are hashes; overviews are not the catalog.
 */
import { createDecoder, createEncoder } from "./codec.js";
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
  const encoder = createEncoder();
  if (event.type === "change") {
    encoder.writeVarUint(0);
    writeDocumentKey(encoder, event.key);
    encoder.writeVarUint(event.revision);
  } else {
    encoder.writeVarUint(1);
    encoder.writeVarString(event.reason);
    encoder.writeVarUint(event.serverEpoch);
  }
  return encoder.toUint8Array();
}

export function decodeInventoryWatchEvent(bytes: Uint8Array): InventoryWatchEvent | null {
  try {
    const decoder = createDecoder(bytes);
    const type = decoder.readVarUint();
    if (type === 0) {
      const key = readDocumentKey(decoder);
      const revision = decoder.readVarUint();
      return { type: "change", key, revision };
    }
    if (type === 1) {
      const reason = decoder.readVarString();
      if (reason !== "overflow" && reason !== "missing-checkpoint" && reason !== "epoch-change") return null;
      const serverEpoch = decoder.readVarUint();
      return { type: "gap", reason, serverEpoch };
    }
    return null;
  } catch {
    return null;
  }
}
