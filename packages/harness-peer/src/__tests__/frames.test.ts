import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  applyPeerSyncFrame,
  decodeAwarenessPayload,
  encodeAwarenessFrame,
  encodeDocUpdate,
  encodeQueryAwareness,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  peekMessageType,
  replyLensSyncFrame,
} from "../frames.js";

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

describe("yjs frame roundtrip", () => {
  it("converges separate replicas through an update frame", () => {
    const author = new Y.Doc();
    const replica = new Y.Doc();
    author.getMap("root").set("k", "v");
    const frame = encodeDocUpdate(Y.encodeStateAsUpdate(author, Y.encodeStateVector(replica)));
    expect(peekMessageType(frame)).toBe(MESSAGE_SYNC);
    const reply = applyPeerSyncFrame(frame, replica, "test");
    expect({ value: replica.getMap("root").get("k"), reply }).toEqual({
      value: "v",
      reply: null,
    });
    author.destroy();
    replica.destroy();
  });

  it("step1/step2 handshake hydrates a cold replica", () => {
    const live = new Y.Doc();
    live.getMap("root").set("k", "v");
    const peer = new Y.Doc();
    const step1 = encodeSyncStep1(peer);
    const step2 = replyLensSyncFrame(step1, live);
    expect(step2).not.toBeNull();
    const leftover = applyPeerSyncFrame(step2!, peer, "live");
    expect({ value: peer.getMap("root").get("k"), leftover }).toEqual({
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
});
