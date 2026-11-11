import { rowPairId } from "@inhuman.tools/harness-contract/schema";
import { DocumentContainer, model, Model, state } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import {
  applyNodeShapeDelta,
  decodePlaneFrame,
  encodePlaneFrame,
  encodePresenceQuery,
  encodePresenceState,
  encodePresenceUpdate,
  encodeShapeDelta,
  encodeShapeSubscribe,
  type ShapeDeltaFrame,
} from "../frames.js";

@model("test:frames:root")
class FrameRoot extends Model {
  @state accessor k = "";
}

describe("peer frames roundtrip", () => {
  it("converges separate replicas through SQLite node shape deltas", () => {
    const author = new DocumentContainer(new FrameRoot());
    const replica = new DocumentContainer(new FrameRoot());
    author.root.k = "v";
    const delta = author.takeNodeDelta();
    const wireText = encodeShapeDelta({
      kind: "shape/delta",
      subscriptionId: "room:nodes",
      offset: 1,
      reset: true,
      upserts: delta.upserts.map((row) => ({
        id: rowPairId("s1", row.uuid),
        sessionId: "s1",
        nodeId: row.uuid,
        isRoot: row.uuid === delta.rootId,
        tag: row.tag,
        revision: delta.revision,
        rowJson: JSON.stringify(row),
        updatedAtMs: 1_700_000_000_000,
      })),
      deletes: [],
    });
    const decoded = decodePlaneFrame(wireText);
    expect(decoded?.kind).toBe("shape/delta");
    applyNodeShapeDelta(replica, decoded as ShapeDeltaFrame);
    expect(replica.root.k).toBe("v");
    author.destroy();
    replica.destroy();
  });

  it("presence update, state, and query JSON frames roundtrip", () => {
    const updateFrame = encodePresenceUpdate([[7, { seat: { sessionId: "s1" } }, 2]], "kernel");
    const stateFrame = encodePresenceState([[7, null, 3]], "kernel");
    const queryFrame = encodePresenceQuery("kernel");
    expect(decodePlaneFrame(updateFrame)).toEqual({
      kind: "presence/update",
      room: "kernel",
      entries: [[7, { seat: { sessionId: "s1" } }, 2]],
    });
    expect(decodePlaneFrame(stateFrame)).toEqual({
      kind: "presence/state",
      room: "kernel",
      entries: [[7, null, 3]],
    });
    expect(decodePlaneFrame(queryFrame)).toEqual({
      kind: "presence/query",
      room: "kernel",
    });
  });

  it("shape subscribe and stream delta frames roundtrip", () => {
    const sub = encodeShapeSubscribe({
      kind: "shape/subscribe",
      subscriptionId: "sub-1",
      lane: "kernel_meta",
      params: {},
    });
    expect(decodePlaneFrame(sub)).toEqual({
      kind: "shape/subscribe",
      subscriptionId: "sub-1",
      lane: "kernel_meta",
      params: {},
    });
    const stream = encodePlaneFrame({
      kind: "stream/delta",
      sessionId: "s1",
      channel: "assistant",
      targetId: "c1",
      text: "hello",
    });
    expect(decodePlaneFrame(stream)).toEqual({
      kind: "stream/delta",
      sessionId: "s1",
      channel: "assistant",
      targetId: "c1",
      text: "hello",
    });
    expect(decodePlaneFrame("not-json")).toBeNull();
  });
});
