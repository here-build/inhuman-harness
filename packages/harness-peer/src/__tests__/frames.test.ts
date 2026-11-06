import { DocumentContainer, model, Model, state } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import {
  applyPeerSyncFrame,
  decodeAwarenessPayload,
  decodeShapeFrame,
  encodeAwarenessFrame,
  encodeDocUpdate,
  encodeQueryAwareness,
  encodeShapeFrame,
  encodeSyncStep1,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SHAPE,
  MESSAGE_SYNC,
  peekMessageType,
  replyLensSyncFrame,
} from "../frames.js";

@model("test:frames:root")
class FrameRoot extends Model {
  @state accessor k = "";
}

describe("peer frames roundtrip", () => {
  it("converges separate replicas through an update frame", () => {
    const author = new DocumentContainer(new FrameRoot());
    const replica = new DocumentContainer(new FrameRoot());
    author.root.k = "v";
    const update = author.encodeStateAsUpdate();
    const frame = encodeDocUpdate(update);
    expect(peekMessageType(frame)).toBe(MESSAGE_SYNC);
    const reply = applyPeerSyncFrame(frame, replica, "test");
    expect({ value: replica.root.k, reply }).toEqual({
      value: "v",
      reply: null,
    });
    author.destroy();
    replica.destroy();
  });

  it("step1/step2 handshake hydrates a cold replica", () => {
    const live = new DocumentContainer(new FrameRoot());
    live.root.k = "v";
    const peer = new DocumentContainer(new FrameRoot());
    const step1 = encodeSyncStep1(peer);
    const step2 = replyLensSyncFrame(step1, live);
    expect(step2).not.toBeNull();
    const leftover = applyPeerSyncFrame(step2!, peer, "live");
    expect({ value: peer.root.k, leftover }).toEqual({
      value: "v",
      leftover: null,
    });
    live.destroy();
    peer.destroy();
  });

  it("awareness payload and query frames roundtrip", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeAwarenessFrame(payload);
    expect({
      type: peekMessageType(frame),
      payload: [...(decodeAwarenessPayload(frame) ?? [])],
      missing: decodeAwarenessPayload(encodeQueryAwareness()),
      query: peekMessageType(encodeQueryAwareness()),
    }).toEqual({
      type: MESSAGE_AWARENESS,
      payload: [1, 2, 3],
      missing: null,
      query: MESSAGE_QUERY_AWARENESS,
    });
  });

  it("shape frames roundtrip arbitrary JSON payloads", () => {
    const payload = { kind: "shape/subscribe", lane: "kernel_meta", id: "sub-1" };
    const frame = encodeShapeFrame(payload);
    expect(peekMessageType(frame)).toBe(MESSAGE_SHAPE);
    expect(decodeShapeFrame(frame)).toEqual(payload);
    expect(decodeShapeFrame(new Uint8Array([0, 1, 2]))).toBeNull();
  });
});
