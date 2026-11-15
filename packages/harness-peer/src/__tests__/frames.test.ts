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
import { RoomConnection } from "../provider.js";

@model("test:frames:child")
class FrameChild extends Model {
  @state accessor label = "";
}

@model("test:frames:root")
class FrameRoot extends Model {
  @state accessor k = "";
  @state.child accessor child: FrameChild | null = null;
}

class FakeWebSocket {
  static latest: FakeWebSocket | null = null;
  readyState = 1;
  sent: string[] = [];
  onerror: ((event: Event) => void) | null = null;
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  triggerOpen(): void {
    for (const fn of this.#listeners.get("open") ?? []) fn({});
  }

  deliver(text: string): void {
    for (const fn of this.#listeners.get("message") ?? []) fn({ data: text });
  }
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

  it("resubscribes from offset 0 when an incremental room:nodes delta hits a missing child reference", () => {
    const author = new DocumentContainer(new FrameRoot());
    const replica = new DocumentContainer(new FrameRoot());
    const conn = new RoomConnection("ws://127.0.0.1:9999", "session", replica, {
      params: { sessionId: "s1" },
      WebSocketPolyfill: FakeWebSocket as unknown as typeof WebSocket,
    });
    const ws = FakeWebSocket.latest;
    if (ws == null) throw new Error("expected socket");

    const toWireRows = (rows: ReturnType<DocumentContainer<FrameRoot>["takeNodeDelta"]>["upserts"], revision: number) =>
      rows.map((row) => ({
        id: rowPairId("s1", row.uuid),
        sessionId: "s1",
        nodeId: row.uuid,
        isRoot: row.uuid === author.root.uuid,
        tag: row.tag,
        revision,
        rowJson: JSON.stringify(row),
        updatedAtMs: 1_700_000_000_000,
      }));

    try {
      ws.triggerOpen();
      const initial = author.takeNodeDelta();
      ws.deliver(
        encodeShapeDelta({
          kind: "shape/delta",
          subscriptionId: "room:nodes",
          offset: 5,
          reset: true,
          upserts: toWireRows(initial.upserts, initial.revision),
          deletes: [],
        }),
      );
      expect(conn.synced).toBe(true);

      author.root.child = new FrameChild({ label: "ok" });
      const next = author.takeNodeDelta();
      const rootOnly = next.upserts.filter((row) => row.uuid === author.root.uuid);
      expect(rootOnly).toHaveLength(1);

      const sentBefore = ws.sent.length;
      expect(() =>
        ws.deliver(
          encodeShapeDelta({
            kind: "shape/delta",
            subscriptionId: "room:nodes",
            offset: 6,
            reset: false,
            upserts: toWireRows(rootOnly, next.revision),
            deletes: [],
          }),
        ),
      ).not.toThrow();

      const resubscribeFrames = ws.sent
        .slice(sentBefore)
        .map((raw) => decodePlaneFrame(raw))
        .filter((frame) => frame?.kind === "shape/subscribe");
      expect(resubscribeFrames).toEqual([
        {
          kind: "shape/subscribe",
          subscriptionId: "room:nodes",
          lane: "session_nodes",
          params: { sessionId: "s1" },
        },
      ]);

      const fullRows = author.toNodeRows();
      ws.deliver(
        encodeShapeDelta({
          kind: "shape/delta",
          subscriptionId: "room:nodes",
          offset: 7,
          reset: true,
          upserts: toWireRows(fullRows, author.revision),
          deletes: [],
        }),
      );
      expect(replica.root.child?.label).toBe("ok");
    } finally {
      conn.destroy();
      author.destroy();
      replica.destroy();
    }
  });
});
