/**
 * Flush checkpoints and exact-prefix durable receipts. A state vector alone
 * is not a durability proof; the receipt covers server epoch, runtime
 * generation, connection epoch, and the update prefix.
 */
import type { DocumentContainer } from "@inhuman.tools/model";

import { createDecoder, createEncoder } from "./codec.js";
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

export function checkpointOf(
  doc: DocumentContainer<any, any> | { encodeStateVector(): Uint8Array },
  key: DocumentKey,
  serverEpoch: number,
  revision: number,
): DocumentCheckpoint {
  return {
    key,
    serverEpoch,
    revision,
    stateVector: doc.encodeStateVector(),
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
  const encoder = createEncoder();
  writeDocumentKey(encoder, checkpoint.key);
  encoder.writeVarUint(checkpoint.serverEpoch);
  encoder.writeVarUint(checkpoint.revision);
  encoder.writeVarUint8Array(checkpoint.stateVector);
  return encoder.toUint8Array();
}

export function decodeDocumentCheckpoint(bytes: Uint8Array): DocumentCheckpoint | null {
  try {
    const decoder = createDecoder(bytes);
    const key = readDocumentKey(decoder);
    const serverEpoch = decoder.readVarUint();
    const revision = decoder.readVarUint();
    const stateVector = decoder.readVarUint8Array();
    return { key, serverEpoch, revision, stateVector };
  } catch {
    return null;
  }
}

export function encodeDurableReceipt(receipt: DurableReceipt): Uint8Array {
  const encoder = createEncoder();
  writeDocumentKey(encoder, receipt.key);
  encoder.writeVarUint(receipt.serverEpoch);
  encoder.writeVarUint(receipt.runtimeGeneration);
  encoder.writeVarUint(receipt.connectionEpoch);
  encoder.writeVarUint(receipt.revision);
  encoder.writeVarUint8Array(receipt.prefix);
  return encoder.toUint8Array();
}

export function decodeDurableReceipt(bytes: Uint8Array): DurableReceipt | null {
  try {
    const decoder = createDecoder(bytes);
    const key = readDocumentKey(decoder);
    const serverEpoch = decoder.readVarUint();
    const runtimeGeneration = decoder.readVarUint();
    const connectionEpoch = decoder.readVarUint();
    const revision = decoder.readVarUint();
    const prefix = decoder.readVarUint8Array();
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
