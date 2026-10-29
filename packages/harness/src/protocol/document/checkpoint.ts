/**
 * Flush checkpoints and exact-prefix durable receipts. A state vector alone
 * is not a durability proof; the receipt covers server epoch, runtime
 * generation, connection epoch, and the update prefix.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import { documentKeysEqual, readDocumentKey, writeDocumentKey, type DocumentKey } from "./keys.js";

export type DocumentCheckpoint = {
  readonly key: DocumentKey;
  readonly serverEpoch: number;
  readonly revision: number;
  /** Yjs state vector of the covered prefix — not a durability receipt. */
  readonly stateVector: Uint8Array;
};

export type DurableReceipt = {
  readonly key: DocumentKey;
  readonly serverEpoch: number;
  readonly runtimeGeneration: number;
  readonly connectionEpoch: number;
  readonly revision: number;
  /** Covered update prefix, including deletions. */
  readonly prefix: Uint8Array;
};

export type FlushResult =
  | { readonly ok: true; readonly receipt: DurableReceipt }
  | {
      readonly ok: false;
      readonly reason: "storage-failed" | "disconnected" | "overload";
    };

export function checkpointOf(doc: Y.Doc, key: DocumentKey, serverEpoch: number, revision: number): DocumentCheckpoint {
  return {
    key,
    serverEpoch,
    revision,
    stateVector: Y.encodeStateVector(doc),
  };
}

export function receiptCoversCheckpoint(receipt: DurableReceipt, checkpoint: DocumentCheckpoint): boolean {
  return (
    documentKeysEqual(receipt.key, checkpoint.key) &&
    receipt.serverEpoch === checkpoint.serverEpoch &&
    receipt.revision >= checkpoint.revision
  );
}

export function encodeDocumentCheckpoint(checkpoint: DocumentCheckpoint): Uint8Array {
  const encoder = encoding.createEncoder();
  writeDocumentKey(encoder, checkpoint.key);
  encoding.writeVarUint(encoder, checkpoint.serverEpoch);
  encoding.writeVarUint(encoder, checkpoint.revision);
  encoding.writeVarUint8Array(encoder, checkpoint.stateVector);
  return encoding.toUint8Array(encoder);
}

export function decodeDocumentCheckpoint(bytes: Uint8Array): DocumentCheckpoint | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const key = readDocumentKey(decoder);
    const serverEpoch = decoding.readVarUint(decoder);
    const revision = decoding.readVarUint(decoder);
    const stateVector = decoding.readVarUint8Array(decoder);
    return { key, serverEpoch, revision, stateVector };
  } catch {
    return null;
  }
}

export function encodeDurableReceipt(receipt: DurableReceipt): Uint8Array {
  const encoder = encoding.createEncoder();
  writeDocumentKey(encoder, receipt.key);
  encoding.writeVarUint(encoder, receipt.serverEpoch);
  encoding.writeVarUint(encoder, receipt.runtimeGeneration);
  encoding.writeVarUint(encoder, receipt.connectionEpoch);
  encoding.writeVarUint(encoder, receipt.revision);
  encoding.writeVarUint8Array(encoder, receipt.prefix);
  return encoding.toUint8Array(encoder);
}

export function decodeDurableReceipt(bytes: Uint8Array): DurableReceipt | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const key = readDocumentKey(decoder);
    const serverEpoch = decoding.readVarUint(decoder);
    const runtimeGeneration = decoding.readVarUint(decoder);
    const connectionEpoch = decoding.readVarUint(decoder);
    const revision = decoding.readVarUint(decoder);
    const prefix = decoding.readVarUint8Array(decoder);
    return {
      key,
      serverEpoch,
      runtimeGeneration,
      connectionEpoch,
      revision,
      prefix,
    };
  } catch {
    return null;
  }
}
