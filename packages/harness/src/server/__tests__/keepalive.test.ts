import { decodePlaneFrame, encodePresenceQuery, encodePresenceUpdate } from "@inhuman.tools/harness-peer";
import { ReactiveAwareness as PlexusAwareness } from "@inhuman.tools/model";
import { describe, expect, it, vi } from "vitest";

import { attachPlane, keepPlaneAlive, PLANE_PING_MS, PresenceRoom, type PlaneSocket } from "../transport/plane.js";
import { classifyPublicUpgrade } from "../transport/routes.js";

function fakeSocket(): {
  socket: PlaneSocket;
  sent: string[];
  deliver: (text: string) => void;
  closeNow: () => void;
} {
  const sent: string[] = [];
  const textHandlers = new Set<(text: string) => void>();
  const closeHandlers = new Set<() => void>();
  const runClose = (): void => {
    for (const handler of [...closeHandlers]) handler();
  };
  const socket: PlaneSocket = {
    sendText: (text) => {
      sent.push(text);
    },
    close: () => {
      runClose();
    },
    onText: (handler) => {
      textHandlers.add(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
    },
  };
  return {
    socket,
    sent,
    deliver: (text) => {
      for (const handler of [...textHandlers]) handler(text);
    },
    closeNow: runClose,
  };
}

describe("plane keep-alive and presence routing", () => {
  it("plane keep-alive: WS ping + JSON ping/pong round-trip, presence relay with no echo to sender", () => {
    vi.useFakeTimers();
    try {
      const outbound: string[] = [];
      let pings = 0;
      let onClose = (): void => undefined;
      keepPlaneAlive(
        {
          readyState: 1,
          ping: () => {
            pings += 1;
          },
          sendText: (text: string) => {
            outbound.push(text);
          },
          on: (_event: "close", listener: () => void) => {
            onClose = listener;
          },
        },
        PLANE_PING_MS,
      );
      vi.advanceTimersByTime(PLANE_PING_MS);

      const peer = fakeSocket();
      const room = new PresenceRoom();
      peer.socket.onText(attachPlane({ socket: peer.socket, connectionId: "peer", room }));
      peer.deliver(outbound[0]!);
      peer.deliver(encodePresenceQuery());
      onClose();
      vi.advanceTimersByTime(PLANE_PING_MS);

      expect({
        pings,
        outbound: outbound.map((text) => decodePlaneFrame(text)?.kind),
        inbound: peer.sent.map((text) => decodePlaneFrame(text)?.kind),
      }).toEqual({
        pings: 1,
        outbound: ["ping"],
        inbound: ["pong", "presence/state"],
      });
      room.close(1000, "done");
    } finally {
      vi.useRealTimers();
    }

    const hub = new PlexusAwareness();
    const room = new PresenceRoom(hub);
    const a = fakeSocket();
    const b = fakeSocket();
    a.socket.onText(attachPlane({ socket: a.socket, connectionId: "a", room }));
    b.socket.onText(attachPlane({ socket: b.socket, connectionId: "b", room }));
    a.sent.length = 0;
    b.sent.length = 0;

    hub.setLocalStateField("role:expectation:live", { text: "stream", thought: "" });
    const peer = new PlexusAwareness();
    peer.setLocalStateField("attention", ["x"]);
    const inbound = encodePresenceUpdate(peer.toPresenceEntries());
    const beforeA = a.sent.length;
    const beforeB = b.sent.length;
    a.deliver(inbound);
    expect({
      hubToA: a.sent.some((text) => decodePlaneFrame(text)?.kind === "presence/update"),
      hubToB: b.sent.some((text) => decodePlaneFrame(text)?.kind === "presence/update"),
      echoToSender: a.sent.length,
      forwardToPeer: b.sent.length > beforeB,
    }).toEqual({
      hubToA: true,
      hubToB: true,
      echoToSender: beforeA,
      forwardToPeer: true,
    });

    a.closeNow();
    expect(
      b.sent.some((text) => {
        const parsed = decodePlaneFrame(text);
        return parsed?.kind === "presence/update" && parsed.entries.some(([, state]) => state === null);
      }),
    ).toBe(true);

    room.close(1000, "test");
    hub.destroy();
    peer.destroy();
  });

  it("classifies public upgrade routes", () => {
    expect({
      kernel: classifyPublicUpgrade("/kernel"),
      project: classifyPublicUpgrade("/project?path=%2Ftmp%2Fp"),
      restore: classifyPublicUpgrade("/session?sessionId=s1"),
      mint: classifyPublicUpgrade("/session?path=%2Ftmp%2Fp&sessionId=s1"),
      missing: classifyPublicUpgrade("/unknown"),
    }).toEqual({
      kernel: { action: "open", key: { kind: "kernel" } },
      project: { action: "open", key: { kind: "projects", id: "/tmp/p" } },
      restore: { action: "open", key: { kind: "sessions", id: "s1" } },
      mint: { action: "create", room: "session", path: "/tmp/p", sessionId: "s1" },
      missing: { action: "refuse", status: 404, reason: "not found" },
    });
  });
});
