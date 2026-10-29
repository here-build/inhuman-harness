import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  admitPrivateEnvelope,
  checkpointOf,
  compareSchedulePriority,
  decodeBarrierReply,
  decodeBarrierRequest,
  decodeDocumentCheckpoint,
  decodeDurableReceipt,
  decodeInventoryWatchEvent,
  decodeOccupancySnapshot,
  decodePrivateControl,
  decodePrivateEnvelope,
  documentKey,
  encodeBarrierReply,
  encodeBarrierRequest,
  encodeDocUpdate,
  encodeDocumentCheckpoint,
  encodeDurableReceipt,
  encodeInventoryWatchEvent,
  encodeOccupancySnapshot,
  encodePrivateControl,
  encodePrivateEnvelope,
  KERNEL_DOCUMENT_KEY,
  occupiedSessionIdsOf,
  peekEnvelopeClass,
  receiptCoversCheckpoint,
  sequenceRelation,
} from "../document/index.js";

describe("checkpoints and receipts", () => {
  it("roundtrips a checkpoint and covers the matching prefix", () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("k", "v");
    const key = documentKey("sessions", "s1");
    const checkpoint = checkpointOf(doc, key, 3, 10);
    const decoded = decodeDocumentCheckpoint(encodeDocumentCheckpoint(checkpoint));
    const receipt = {
      key,
      serverEpoch: 3,
      runtimeGeneration: 2,
      connectionEpoch: 1,
      revision: 11,
      prefix: encodeDocUpdate(Y.encodeStateAsUpdate(doc)),
    };
    const roundtrip = decodeDurableReceipt(encodeDurableReceipt(receipt));
    expect({
      decoded,
      covers: receiptCoversCheckpoint(receipt, checkpoint),
      epoch: receiptCoversCheckpoint({ ...receipt, serverEpoch: 4 }, checkpoint),
      revision: receiptCoversCheckpoint({ ...receipt, revision: 9 }, checkpoint),
      prefix: roundtrip?.prefix.length,
    }).toEqual({
      decoded: checkpoint,
      covers: true,
      epoch: false,
      revision: false,
      prefix: receipt.prefix.length,
    });
    doc.destroy();
  });
});

describe("inventory and occupancy", () => {
  it("encodes invalidations and occupancy snapshots atomically", () => {
    const change = encodeInventoryWatchEvent({
      type: "change",
      key: documentKey("sessions", "s1"),
      revision: 4,
    });
    const gap = encodeInventoryWatchEvent({
      type: "gap",
      reason: "epoch-change",
      serverEpoch: 8,
    });
    const snapshot = encodeOccupancySnapshot({
      serverEpoch: 1,
      sequence: 3,
      seats: [{ sessionId: "s1", clientId: 7 }],
    });
    const decoded = decodeOccupancySnapshot(snapshot);
    expect({
      change: decodeInventoryWatchEvent(change),
      gap: decodeInventoryWatchEvent(gap),
      snapshot: decoded,
      occupied: [...occupiedSessionIdsOf(decoded!)],
    }).toEqual({
      change: {
        type: "change",
        key: { kind: "sessions", id: "s1" },
        revision: 4,
      },
      gap: { type: "gap", reason: "epoch-change", serverEpoch: 8 },
      snapshot: {
        serverEpoch: 1,
        sequence: 3,
        seats: [{ sessionId: "s1", clientId: 7 }],
      },
      occupied: ["s1"],
    });
  });
});

describe("private envelope ordering", () => {
  it("preserves sequence and schedules occupancy ahead of sync", () => {
    const payload = encodeDocUpdate(new Uint8Array([1]));
    const sync = encodePrivateEnvelope({
      connectionEpoch: 1,
      sequence: 4,
      class: "sync",
      document: KERNEL_DOCUMENT_KEY,
      payload,
    });
    const occupancy = encodePrivateEnvelope({
      connectionEpoch: 1,
      sequence: 5,
      class: "occupancy",
      payload: new Uint8Array([2]),
    });
    expect({
      decoded: decodePrivateEnvelope(sync),
      class: peekEnvelopeClass(occupancy),
      priority: compareSchedulePriority("occupancy", "sync") < 0,
      next: sequenceRelation(4, 5),
      gap: sequenceRelation(4, 6),
      duplicate: sequenceRelation(4, 4),
    }).toEqual({
      decoded: {
        connectionEpoch: 1,
        sequence: 4,
        class: "sync",
        document: KERNEL_DOCUMENT_KEY,
        payload,
      },
      class: "occupancy",
      priority: true,
      next: "ok",
      gap: "gap",
      duplicate: "duplicate",
    });
  });

  it("admits the next sequence and rejects stale epochs and gaps", () => {
    const payload = new Uint8Array([1]);
    const state = { epoch: 2, sequence: 4 };
    const next = admitPrivateEnvelope(state, {
      connectionEpoch: 2,
      sequence: 5,
      class: "sync",
      payload,
    });
    const stale = admitPrivateEnvelope(state, {
      connectionEpoch: 1,
      sequence: 6,
      class: "sync",
      payload,
    });
    const gap = admitPrivateEnvelope(state, {
      connectionEpoch: 2,
      sequence: 7,
      class: "barrier",
      payload,
    });
    const reset = admitPrivateEnvelope(state, {
      connectionEpoch: 3,
      sequence: 1,
      class: "control",
      payload,
    });
    expect({ next, stale, gap, reset }).toEqual({
      next: { action: "apply" },
      stale: { action: "reject", reason: "stale-epoch" },
      gap: { action: "reject", reason: "gap" },
      reset: { action: "reset" },
    });
  });
});

describe("private control and barrier payloads", () => {
  it("roundtrips hello, snapshot, and a durable barrier reply", () => {
    const identity = {
      hypervisor: { kind: "hypervisor" as const, id: "hv-1" },
      process: { kind: "runtime" as const, id: "rt-1" },
      serverEpoch: 3,
      runtimeGeneration: 2,
      connectionEpoch: 0,
    };
    const hello = encodePrivateControl({
      op: "hello",
      hello: { capability: "cap", identity },
    });
    const key = documentKey("sessions", "s1");
    const doc = new Y.Doc();
    doc.getMap("root").set("k", "v");
    const checkpoint = checkpointOf(doc, key, 3, 4);
    const request = encodeBarrierRequest({ requestId: 9, checkpoint });
    const receipt = {
      key,
      serverEpoch: 3,
      runtimeGeneration: 2,
      connectionEpoch: 5,
      revision: 4,
      prefix: encodeDocUpdate(Y.encodeStateAsUpdate(doc)),
    };
    const reply = encodeBarrierReply({
      requestId: 9,
      result: { ok: true, receipt },
    });
    const opened = encodePrivateControl({
      op: "opened",
      requestId: 1,
      revision: 4,
      guid: "harness:session:s1",
      image: Y.encodeStateAsUpdate(doc),
    });
    expect({
      hello: decodePrivateControl(hello),
      request: decodeBarrierRequest(request),
      reply: decodeBarrierReply(reply),
      opened: decodePrivateControl(opened)?.op,
    }).toEqual({
      hello: {
        op: "hello",
        hello: { capability: "cap", identity },
      },
      request: { requestId: 9, checkpoint },
      reply: { requestId: 9, result: { ok: true, receipt } },
      opened: "opened",
    });
    doc.destroy();
  });
});
