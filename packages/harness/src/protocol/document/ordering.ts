/**
 * Private document-addressed envelope. Each direction has a monotonic
 * sequence per connection epoch. Occupancy/control are a schedule-priority
 * class ahead of bulk sync; sequence is still the wire order.
 */
import { createDecoder, createEncoder } from "./codec.js";
import { readDocumentKey, writeDocumentKey, type DocumentKey } from "./keys.js";

export const FRAME_CLASSES = ["occupancy", "control", "barrier", "rpc", "sync"] as const;
export type FrameClass = (typeof FRAME_CLASSES)[number];

/** Lower runs first when the private connection must shed bulk sync. */
export const FRAME_CLASS_PRIORITY: Record<FrameClass, number> = {
  occupancy: 0,
  control: 1,
  barrier: 2,
  rpc: 3,
  sync: 4,
};

export type SequenceRelation = "ok" | "duplicate" | "gap" | "reset";

export type PrivateEnvelope = {
  readonly connectionEpoch: number;
  readonly sequence: number;
  readonly class: FrameClass;
  readonly document?: DocumentKey;
  readonly payload: Uint8Array;
};

export function compareSchedulePriority(a: FrameClass, b: FrameClass): number {
  return FRAME_CLASS_PRIORITY[a] - FRAME_CLASS_PRIORITY[b];
}

export function sequenceRelation(prev: number, next: number): SequenceRelation {
  if (next === prev) return "duplicate";
  if (next === prev + 1) return "ok";
  if (next > prev + 1) return "gap";
  return "reset";
}

export type SequenceState = {
  epoch: number;
  sequence: number;
};

export type EnvelopeAdmission =
  | { readonly action: "apply" }
  | { readonly action: "reset" }
  | { readonly action: "drop"; readonly reason: "duplicate" }
  | {
      readonly action: "reject";
      readonly reason: "gap" | "reset" | "stale-epoch";
    };

/**
 * Admit one inbound envelope. Sequence is the wire order; a newer connection
 * epoch resets the clock at sequence 1. The caller updates `state` only on
 * apply/reset.
 */
export function admitPrivateEnvelope(state: SequenceState, envelope: PrivateEnvelope): EnvelopeAdmission {
  if (envelope.connectionEpoch < state.epoch) {
    return { action: "reject", reason: "stale-epoch" };
  }
  if (envelope.connectionEpoch > state.epoch) {
    if (envelope.sequence !== 1) {
      return { action: "reject", reason: "gap" };
    }
    return { action: "reset" };
  }
  const relation = sequenceRelation(state.sequence, envelope.sequence);
  if (relation === "ok") return { action: "apply" };
  if (relation === "duplicate") return { action: "drop", reason: "duplicate" };
  return { action: "reject", reason: relation };
}

export function advanceSequenceState(state: SequenceState, envelope: PrivateEnvelope): void {
  state.epoch = envelope.connectionEpoch;
  state.sequence = envelope.sequence;
}

export function encodePrivateEnvelope(envelope: PrivateEnvelope): Uint8Array {
  const encoder = createEncoder();
  encoder.writeVarUint(envelope.connectionEpoch);
  encoder.writeVarUint(envelope.sequence);
  encoder.writeVarUint(FRAME_CLASS_PRIORITY[envelope.class]);
  if (envelope.document == null) {
    encoder.writeVarUint(0);
  } else {
    encoder.writeVarUint(1);
    writeDocumentKey(encoder, envelope.document);
  }
  encoder.writeVarUint8Array(envelope.payload);
  return encoder.toUint8Array();
}

export function decodePrivateEnvelope(bytes: Uint8Array): PrivateEnvelope | null {
  try {
    const decoder = createDecoder(bytes);
    const connectionEpoch = decoder.readVarUint();
    const sequence = decoder.readVarUint();
    const classCode = decoder.readVarUint();
    const frameClass = FRAME_CLASSES.at(classCode);
    if (frameClass === undefined) return null;
    const hasDocument = decoder.readVarUint();
    const document = hasDocument === 1 ? readDocumentKey(decoder) : undefined;
    if (hasDocument !== 0 && hasDocument !== 1) return null;
    const payload = decoder.readVarUint8Array();
    return document == null
      ? { connectionEpoch, sequence, class: frameClass, payload }
      : { connectionEpoch, sequence, class: frameClass, document, payload };
  } catch {
    return null;
  }
}

export function peekEnvelopeClass(bytes: Uint8Array): FrameClass | null {
  try {
    const decoder = createDecoder(bytes);
    decoder.readVarUint();
    decoder.readVarUint();
    return FRAME_CLASSES.at(decoder.readVarUint()) ?? null;
  } catch {
    return null;
  }
}
