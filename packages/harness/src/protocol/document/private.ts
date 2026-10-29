/**
 * Authenticated private-peer payloads. Envelopes live in ordering.ts;
 * this module is hello/control/barrier bodies, not public Yjs frames.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import {
  decodeDocumentCheckpoint,
  encodeDocumentCheckpoint,
  encodeDurableReceipt,
  decodeDurableReceipt,
  type DocumentCheckpoint,
  type FlushResult,
} from "./checkpoint.js";
import { readDocumentKey, writeDocumentKey, type DocumentKey } from "./keys.js";
import { supervisionIdentitySchema, type SupervisionIdentity } from "../schemas/identity.js";

const PRIVATE_AUTH_REASONS = ["unauthorized", "busy", "stale"] as const;
export type PrivateAuthReason = (typeof PRIVATE_AUTH_REASONS)[number];

const PRIVATE_REJECT_REASONS = ["stale-epoch", "gap", "reset"] as const;
export type PrivateRejectReason = (typeof PRIVATE_REJECT_REASONS)[number];

const PRIVATE_OPEN_FAIL_REASONS = ["not-found", "overload", "corrupt"] as const;
export type PrivateOpenFailReason = (typeof PRIVATE_OPEN_FAIL_REASONS)[number];

const PRIVATE_CREATE_FAIL_REASONS = ["overload", "storage-failed"] as const;
export type PrivateCreateFailReason = (typeof PRIVATE_CREATE_FAIL_REASONS)[number];

export type PrivateHello = {
  readonly capability: string;
  readonly identity: SupervisionIdentity;
};

export type PrivateHelloAck =
  | {
      readonly ok: true;
      readonly serverEpoch: number;
      readonly runtimeGeneration: number;
      readonly connectionEpoch: number;
    }
  | { readonly ok: false; readonly reason: PrivateAuthReason };

export type PrivateSnapshotAck = {
  readonly requestId: number;
  readonly revision: number;
  readonly guid: string;
  readonly image: Uint8Array;
};

export type PrivateControl =
  | { readonly op: "hello"; readonly hello: PrivateHello }
  | { readonly op: "hello-ack"; readonly ack: PrivateHelloAck }
  | {
      readonly op: "open-existing";
      readonly requestId: number;
      readonly key: DocumentKey;
    }
  | {
      readonly op: "create";
      readonly requestId: number;
      readonly key: DocumentKey;
      readonly initial: Uint8Array;
    }
  | {
      readonly op: "release";
      readonly requestId: number;
      readonly key: DocumentKey;
    }
  | ({ readonly op: "opened" } & PrivateSnapshotAck)
  | ({ readonly op: "created" } & PrivateSnapshotAck)
  | {
      readonly op: "open-failed";
      readonly requestId: number;
      readonly reason: PrivateOpenFailReason;
    }
  | {
      readonly op: "create-failed";
      readonly requestId: number;
      readonly reason: PrivateCreateFailReason;
    }
  | { readonly op: "released"; readonly requestId: number }
  | { readonly op: "reject"; readonly reason: PrivateRejectReason };

export type BarrierRequest = {
  readonly requestId: number;
  readonly checkpoint: DocumentCheckpoint;
};

export type BarrierReply = {
  readonly requestId: number;
  readonly result: FlushResult;
};

const CONTROL_OPS = [
  "hello",
  "hello-ack",
  "open-existing",
  "opened",
  "open-failed",
  "create",
  "created",
  "create-failed",
  "release",
  "released",
  "reject",
] as const;

function writeIdentity(encoder: encoding.Encoder, identity: SupervisionIdentity): void {
  encoding.writeVarString(encoder, identity.hypervisor.kind);
  encoding.writeVarString(encoder, identity.hypervisor.id);
  encoding.writeVarString(encoder, identity.process.kind);
  encoding.writeVarString(encoder, identity.process.id);
  encoding.writeVarUint(encoder, identity.serverEpoch);
  encoding.writeVarUint(encoder, identity.runtimeGeneration);
  encoding.writeVarUint(encoder, identity.connectionEpoch);
}

function readIdentity(decoder: decoding.Decoder): SupervisionIdentity {
  return supervisionIdentitySchema.parse({
    hypervisor: {
      kind: decoding.readVarString(decoder),
      id: decoding.readVarString(decoder),
    },
    process: {
      kind: decoding.readVarString(decoder),
      id: decoding.readVarString(decoder),
    },
    serverEpoch: decoding.readVarUint(decoder),
    runtimeGeneration: decoding.readVarUint(decoder),
    connectionEpoch: decoding.readVarUint(decoder),
  });
}

function writeSnapshot(encoder: encoding.Encoder, snapshot: PrivateSnapshotAck): void {
  encoding.writeVarUint(encoder, snapshot.requestId);
  encoding.writeVarUint(encoder, snapshot.revision);
  encoding.writeVarString(encoder, snapshot.guid);
  encoding.writeVarUint8Array(encoder, snapshot.image);
}

function readSnapshot(decoder: decoding.Decoder): PrivateSnapshotAck {
  return {
    requestId: decoding.readVarUint(decoder),
    revision: decoding.readVarUint(decoder),
    guid: decoding.readVarString(decoder),
    image: decoding.readVarUint8Array(decoder),
  };
}

export function encodePrivateControl(control: PrivateControl): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, CONTROL_OPS.indexOf(control.op));
  switch (control.op) {
    case "hello":
      encoding.writeVarString(encoder, control.hello.capability);
      writeIdentity(encoder, control.hello.identity);
      break;
    case "hello-ack":
      if (control.ack.ok) {
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint(encoder, control.ack.serverEpoch);
        encoding.writeVarUint(encoder, control.ack.runtimeGeneration);
        encoding.writeVarUint(encoder, control.ack.connectionEpoch);
      } else {
        encoding.writeVarUint(encoder, 0);
        encoding.writeVarString(encoder, control.ack.reason);
      }
      break;
    case "open-existing":
    case "release":
      encoding.writeVarUint(encoder, control.requestId);
      writeDocumentKey(encoder, control.key);
      break;
    case "create":
      encoding.writeVarUint(encoder, control.requestId);
      writeDocumentKey(encoder, control.key);
      encoding.writeVarUint8Array(encoder, control.initial);
      break;
    case "opened":
    case "created":
      writeSnapshot(encoder, control);
      break;
    case "open-failed":
    case "create-failed":
      encoding.writeVarUint(encoder, control.requestId);
      encoding.writeVarString(encoder, control.reason);
      break;
    case "released":
      encoding.writeVarUint(encoder, control.requestId);
      break;
    case "reject":
      encoding.writeVarString(encoder, control.reason);
      break;
  }
  return encoding.toUint8Array(encoder);
}

export function decodePrivateControl(bytes: Uint8Array): PrivateControl | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const op = CONTROL_OPS.at(decoding.readVarUint(decoder));
    if (op === undefined) return null;
    switch (op) {
      case "hello":
        return {
          op,
          hello: {
            capability: decoding.readVarString(decoder),
            identity: readIdentity(decoder),
          },
        };
      case "hello-ack": {
        const ok = decoding.readVarUint(decoder);
        if (ok === 1) {
          return {
            op,
            ack: {
              ok: true,
              serverEpoch: decoding.readVarUint(decoder),
              runtimeGeneration: decoding.readVarUint(decoder),
              connectionEpoch: decoding.readVarUint(decoder),
            },
          };
        }
        if (ok !== 0) return null;
        const reason = decoding.readVarString(decoder);
        if (!isAuthReason(reason)) return null;
        return { op, ack: { ok: false, reason } };
      }
      case "open-existing":
      case "release":
        return {
          op,
          requestId: decoding.readVarUint(decoder),
          key: readDocumentKey(decoder),
        };
      case "create":
        return {
          op,
          requestId: decoding.readVarUint(decoder),
          key: readDocumentKey(decoder),
          initial: decoding.readVarUint8Array(decoder),
        };
      case "opened":
      case "created":
        return { op, ...readSnapshot(decoder) };
      case "open-failed": {
        const requestId = decoding.readVarUint(decoder);
        const reason = decoding.readVarString(decoder);
        if (!isOpenFailReason(reason)) return null;
        return { op, requestId, reason };
      }
      case "create-failed": {
        const requestId = decoding.readVarUint(decoder);
        const reason = decoding.readVarString(decoder);
        if (!isCreateFailReason(reason)) return null;
        return { op, requestId, reason };
      }
      case "released":
        return { op, requestId: decoding.readVarUint(decoder) };
      case "reject": {
        const reason = decoding.readVarString(decoder);
        if (!isRejectReason(reason)) return null;
        return { op, reason };
      }
    }
  } catch {
    return null;
  }
}

export function encodeBarrierRequest(request: BarrierRequest): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, request.requestId);
  encoding.writeVarUint8Array(encoder, encodeDocumentCheckpoint(request.checkpoint));
  return encoding.toUint8Array(encoder);
}

export function decodeBarrierRequest(bytes: Uint8Array): BarrierRequest | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const requestId = decoding.readVarUint(decoder);
    const checkpoint = decodeDocumentCheckpoint(decoding.readVarUint8Array(decoder));
    if (checkpoint == null) return null;
    return { requestId, checkpoint };
  } catch {
    return null;
  }
}

export function encodeBarrierReply(reply: BarrierReply): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, reply.requestId);
  if (reply.result.ok) {
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(encoder, encodeDurableReceipt(reply.result.receipt));
  } else {
    encoding.writeVarUint(encoder, 0);
    encoding.writeVarString(encoder, reply.result.reason);
  }
  return encoding.toUint8Array(encoder);
}

export function decodeBarrierReply(bytes: Uint8Array): BarrierReply | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const requestId = decoding.readVarUint(decoder);
    const ok = decoding.readVarUint(decoder);
    if (ok === 1) {
      const receipt = decodeDurableReceipt(decoding.readVarUint8Array(decoder));
      if (receipt == null) return null;
      return { requestId, result: { ok: true, receipt } };
    }
    if (ok !== 0) return null;
    const reason = decoding.readVarString(decoder);
    if (reason !== "storage-failed" && reason !== "disconnected" && reason !== "overload") {
      return null;
    }
    return { requestId, result: { ok: false, reason } };
  } catch {
    return null;
  }
}

function isAuthReason(value: string): value is PrivateAuthReason {
  return (PRIVATE_AUTH_REASONS as readonly string[]).includes(value);
}

function isRejectReason(value: string): value is PrivateRejectReason {
  return (PRIVATE_REJECT_REASONS as readonly string[]).includes(value);
}

function isOpenFailReason(value: string): value is PrivateOpenFailReason {
  return (PRIVATE_OPEN_FAIL_REASONS as readonly string[]).includes(value);
}

function isCreateFailReason(value: string): value is PrivateCreateFailReason {
  return (PRIVATE_CREATE_FAIL_REASONS as readonly string[]).includes(value);
}
