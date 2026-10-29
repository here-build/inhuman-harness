import { PlexusAwareness, encodeAwarenessUpdate } from "@here.build/plexus";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  encodeAwarenessFrame,
  peekMessageType,
} from "@/protocol/document";
import { keepPlaneAlive, PLANE_PING_MS, AwarenessRoom, attachLens, type PlaneSocket } from "@/yjs";

function fakeSocket(): {
  socket: PlaneSocket;
  sent: Uint8Array[];
  deliver: (frame: Uint8Array) => void;
} {
  const sent: Uint8Array[] = [];
  let onBinary = (_frame: Uint8Array): void => undefined;
  const socket: PlaneSocket = {
    send: (frame) => {
      sent.push(frame);
    },
    sendText: () => undefined,
    close: () => undefined,
    onBinary: (handler) => {
      onBinary = handler;
    },
    onText: () => undefined,
    onClose: () => undefined,
  };
  return {
    socket,
    sent,
    deliver: (frame) => onBinary(frame),
  };
}

describe("plane keep-alive", () => {
  it("plane keep-alive: WS ping + awareness round-trip, no echo to sender", () => {
    vi.useFakeTimers();
    try {
      const outbound: Uint8Array[] = [];
      let pings = 0;
      let onClose = (): void => undefined;
      keepPlaneAlive(
        {
          readyState: 1,
          ping: () => {
            pings += 1;
          },
          send: (frame: Uint8Array) => {
            outbound.push(frame);
          },
          on: (_event: "close", listener: () => void) => {
            onClose = listener;
          },
        },
        PLANE_PING_MS,
      );
      vi.advanceTimersByTime(PLANE_PING_MS);

      const inbound: Uint8Array[] = [];
      let onBinary = (_frame: Uint8Array): void => undefined;
      const socket: PlaneSocket = {
        send: (frame) => {
          inbound.push(frame);
        },
        sendText: () => undefined,
        close: () => undefined,
        onBinary: (handler) => {
          onBinary = handler;
        },
        onText: () => undefined,
        onClose: () => undefined,
      };
      attachLens(new Y.Doc(), socket);
      onBinary(outbound[0]!);
      onClose();
      vi.advanceTimersByTime(PLANE_PING_MS);

      expect({
        pings,
        outbound: outbound.map(peekMessageType),
        // The seat opens with the replica's STEP1; the rest is the awareness answer.
        inbound: inbound.map(peekMessageType).filter((type) => type !== MESSAGE_SYNC),
      }).toEqual({
        pings: 1,
        outbound: [MESSAGE_QUERY_AWARENESS],
        inbound: [MESSAGE_QUERY_AWARENESS],
      });
    } finally {
      vi.useRealTimers();
    }

    const doc = new Y.Doc();
    const hub = new PlexusAwareness(doc);
    const room = new AwarenessRoom(hub);
    const a = fakeSocket();
    const b = fakeSocket();
    attachLens(doc, a.socket, room, hub);
    attachLens(doc, b.socket, room, hub);
    a.sent.length = 0;
    b.sent.length = 0;

    hub.setLocalStateField("role:expectation:live", { text: "stream", thought: "" });
    const peer = new PlexusAwareness(new Y.Doc());
    peer.setLocalStateField("attention", ["x"]);
    const inbound = encodeAwarenessFrame(encodeAwarenessUpdate(peer, [...peer.meta.keys()]));
    const beforeA = a.sent.length;
    const beforeB = b.sent.length;
    a.deliver(inbound);
    expect({
      hubToA: a.sent.some((frame) => peekMessageType(frame) === MESSAGE_AWARENESS),
      hubToB: b.sent.some((frame) => peekMessageType(frame) === MESSAGE_AWARENESS),
      echoToSender: a.sent.length,
      forwardToPeer: b.sent.length > beforeB,
    }).toEqual({
      hubToA: true,
      hubToB: true,
      echoToSender: beforeA,
      forwardToPeer: true,
    });

    room.close(1000, "test");
    hub.destroy();
    peer.destroy();
    doc.destroy();
  });
});
