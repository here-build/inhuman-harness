import type { PresenceEntryTuple } from "@inhuman.tools/harness-contract/schema";
import {
  decodePlaneFrame,
  encodePlaneFrame,
  encodePresenceState,
  encodePresenceUpdate,
} from "@inhuman.tools/harness-peer";
import { ReactiveAwareness as PlexusAwareness, type PresenceEntry } from "@inhuman.tools/model";
import type { UpdateLaneHub } from "@inhuman.tools/scope-plane";
import { WebSocket } from "ws";

export const PLANE_PING_MS = 10_000;
const OPEN = 1;
const REMOTE_PRESENCE_ORIGIN = { kind: "remote-presence" } as const;

export interface PlaneSocket {
  sendText(text: string): void;
  close(code: number, reason: string): void;
  onText(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

export type Pingable = {
  readyState: number;
  ping(): void;
  sendText(text: string): void;
  on(event: "close", listener: () => void): unknown;
};

export function keepPlaneAlive(socket: Pingable, intervalMs = PLANE_PING_MS): void {
  const pingFrame = encodePlaneFrame({ kind: "ping" });
  const tick = (): void => {
    if (socket.readyState !== OPEN) return;
    try {
      socket.ping();
    } catch {
      // TOCTOU: socket can close between the OPEN check and ping.
    }
    if (socket.readyState !== OPEN) return;
    socket.sendText(pingFrame);
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  socket.on("close", () => clearInterval(timer));
}

export function wrapWebSocket(ws: WebSocket): PlaneSocket {
  let closed = false;
  keepPlaneAlive({
    get readyState() {
      return closed ? 3 : ws.readyState;
    },
    ping: () => {
      ws.ping();
    },
    sendText: (text) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(text);
    },
    on: (event, listener) => {
      ws.on(event, listener);
    },
  });
  return {
    sendText: (text) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(text);
    },
    close: (code, reason) => {
      closed = true;
      ws.close(code, reason);
    },
    onText: (handler) =>
      ws.on("message", (data, isBinary) => {
        if (closed || isBinary) return;
        handler(data.toString());
      }),
    onClose: (handler) => ws.on("close", handler),
  };
}

export class PresenceRoom {
  readonly #hub: PlexusAwareness;
  readonly #ownsHub: boolean;
  readonly #sockets = new Set<PlaneSocket>();
  readonly #ownedClients = new Map<PlaneSocket, Set<number>>();
  readonly #stopForward: () => void;

  constructor(hub?: PlexusAwareness) {
    this.#ownsHub = hub === undefined;
    this.#hub = hub ?? new PlexusAwareness();
    const onLocalUpdate = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === REMOTE_PRESENCE_ORIGIN) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0 || this.#sockets.size === 0) return;
      const entries = this.#hub.toPresenceEntries(changed);
      if (entries.length === 0) return;
      const frame = encodePresenceUpdate(entries);
      for (const peer of this.#sockets) {
        peer.sendText(frame);
      }
    };
    this.#hub.on("update", onLocalUpdate);
    this.#stopForward = () => {
      this.#hub.off("update", onLocalUpdate);
    };
  }

  get hub(): PlexusAwareness {
    return this.#hub;
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  join(socket: PlaneSocket): void {
    this.#sockets.add(socket);
    const owned = new Set<number>();
    this.#ownedClients.set(socket, owned);
    socket.onClose(() => {
      this.#sockets.delete(socket);
      this.#ownedClients.delete(socket);
      if (owned.size === 0) return;
      const removals: PresenceEntry[] = [];
      const states = this.#hub.getStates();
      for (const clientId of owned) {
        const meta = this.#hub.meta.get(clientId);
        if (!meta || !states.has(clientId)) continue;
        removals.push([clientId, null, meta.clock + 1]);
      }
      owned.clear();
      if (removals.length === 0) return;
      this.#hub.applyPresenceEntries(removals, REMOTE_PRESENCE_ORIGIN);
      if (this.#sockets.size === 0) return;
      const frame = encodePresenceUpdate(removals);
      for (const peer of this.#sockets) {
        peer.sendText(frame);
      }
    });
    const initial = this.#hub.toPresenceEntries();
    if (initial.length > 0) {
      socket.sendText(encodePresenceState(initial));
    }
  }

  replyState(socket: PlaneSocket): void {
    socket.sendText(encodePresenceState(this.#hub.toPresenceEntries()));
  }

  receiveUpdate(from: PlaneSocket, entries: readonly PresenceEntryTuple[]): void {
    if (entries.length === 0) return;
    const owned = this.#ownedClients.get(from);
    if (owned !== undefined) {
      for (const [clientId, state] of entries) {
        if (state === null) {
          owned.delete(clientId);
        } else {
          owned.add(clientId);
        }
      }
    }
    this.#hub.applyPresenceEntries(entries, REMOTE_PRESENCE_ORIGIN);
    const frame = encodePresenceUpdate(entries);
    for (const peer of this.#sockets) {
      if (peer !== from) {
        peer.sendText(frame);
      }
    }
  }

  broadcastText(text: string): void {
    for (const peer of this.#sockets) {
      peer.sendText(text);
    }
  }

  close(code = 1001, reason = "room closed"): void {
    this.#stopForward();
    const sockets = [...this.#sockets];
    this.#sockets.clear();
    this.#ownedClients.clear();
    for (const socket of sockets) {
      socket.close(code, reason);
    }
    if (this.#ownsHub) {
      this.#hub.destroy();
    }
  }
}

export interface AttachPlaneOptions {
  readonly socket: PlaneSocket;
  readonly connectionId: string;
  readonly laneHub?: UpdateLaneHub;
  readonly room?: PresenceRoom;
}

export function attachPlane(options: AttachPlaneOptions): (text: string) => boolean {
  const { socket, connectionId, laneHub, room } = options;
  room?.join(socket);
  socket.onClose(() => {
    laneHub?.unsubscribeClient(connectionId);
  });

  return (text: string): boolean => {
    const frame = decodePlaneFrame(text);
    if (frame === null) return false;

    switch (frame.kind) {
      case "ping":
        socket.sendText(encodePlaneFrame({ kind: "pong" }));
        return true;
      case "pong":
        return true;
      case "shape/subscribe":
        if (laneHub !== undefined) {
          laneHub.subscribe(
            frame,
            (delta) => {
              socket.sendText(encodePlaneFrame(delta));
            },
            connectionId,
          );
        }
        return true;
      case "shape/unsubscribe":
        laneHub?.unsubscribe(frame.subscriptionId, connectionId);
        return true;
      case "presence/query":
        if (room !== undefined) {
          room.replyState(socket);
        } else {
          socket.sendText(encodePresenceState([]));
        }
        return true;
      case "presence/update":
        room?.receiveUpdate(socket, frame.entries);
        return true;
      case "shape/delta":
      case "presence/state":
      case "stream/delta":
        return true;
    }
  };
}
