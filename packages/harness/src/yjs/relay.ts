/**
 * Public-plane sync and awareness. Every client plane is a lens; clients
 * change state through RPC. Room lifetime is independent of execution:
 * park() must not close a room another consumer still holds.
 */
import { encodeAwarenessUpdate, PlexusAwareness } from "@here.build/plexus";
import * as Y from "yjs";

import {
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  encodeAwarenessFrame,
  encodeDocUpdate,
  encodeQueryAwareness,
  encodeSyncStep1,
  forwardPlexusAwareness,
  ingestPlexusAwareness,
  peekMessageType,
  replyLensSyncFrame,
} from "@/protocol/document";

export interface PlaneSocket {
  send(frame: Uint8Array): void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
  onBinary(handler: (frame: Uint8Array) => void): void;
  onText(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

export class AwarenessReplay {
  readonly #doc = new Y.Doc();
  readonly #hub = new PlexusAwareness(this.#doc);

  apply(frame: Uint8Array): void {
    ingestPlexusAwareness(this.#hub, frame);
  }

  snapshot(): Uint8Array | null {
    const clients = [...this.#hub.meta.keys()];
    if (clients.length === 0) return null;
    return encodeAwarenessFrame(encodeAwarenessUpdate(this.#hub, clients));
  }

  destroy(): void {
    this.#hub.destroy();
    this.#doc.destroy();
  }
}

export class AwarenessRoom {
  readonly #replay = new AwarenessReplay();
  readonly #sockets = new Set<PlaneSocket>();
  readonly #hub: PlexusAwareness | undefined;
  readonly #stopForward: (() => void) | null;

  constructor(hub?: PlexusAwareness) {
    this.#hub = hub;
    // Local actor.report() writes the hub in-process — not a socket frame.
    // Broadcast those writes so TUI replicas see live speech.
    this.#stopForward = hub === undefined ? null : forwardPlexusAwareness(hub, (frame) => this.broadcast(frame));
  }

  join(socket: PlaneSocket): void {
    this.#sockets.add(socket);
    socket.onClose(() => {
      this.#sockets.delete(socket);
    });
    const dump = this.snapshot();
    if (dump !== null) socket.send(dump);
  }

  receive(from: PlaneSocket, frame: Uint8Array): void {
    this.#replay.apply(frame);
    for (const peer of this.#sockets) if (peer !== from) peer.send(frame);
  }

  broadcast(frame: Uint8Array): void {
    this.#replay.apply(frame);
    for (const peer of this.#sockets) peer.send(frame);
  }

  close(code: number, reason: string): void {
    this.#stopForward?.();
    const sockets = [...this.#sockets];
    this.#sockets.clear();
    for (const socket of sockets) socket.close(code, reason);
    this.#replay.destroy();
  }

  snapshot(): Uint8Array | null {
    if (this.#hub !== undefined) {
      const clients = [...this.#hub.meta.keys()];
      if (clients.length === 0) return null;
      try {
        return encodeAwarenessFrame(encodeAwarenessUpdate(this.#hub, clients));
      } catch {
        return null;
      }
    }
    return this.#replay.snapshot();
  }
}

/** Server-authoritative plane: reply STEP1 with our STEP2; drop inbound STEP2/UPDATE. */
export function attachLens(doc: Y.Doc, socket: PlaneSocket, room?: AwarenessRoom, hub?: PlexusAwareness): void {
  attachSync(doc, socket, room, hub, (frame, live) => replyLensSyncFrame(frame, live));
}

function attachSync(
  doc: Y.Doc,
  socket: PlaneSocket,
  room: AwarenessRoom | undefined,
  hub: PlexusAwareness | undefined,
  inbound: (frame: Uint8Array, live: Y.Doc, origin: unknown) => Uint8Array | null,
): void {
  const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === socket) return;
    socket.send(encodeDocUpdate(update));
  };
  socket.onBinary((frame) => {
    try {
      const messageType = peekMessageType(frame);
      if (messageType === MESSAGE_QUERY_AWARENESS) {
        socket.send(room?.snapshot() ?? encodeQueryAwareness());
        return;
      }
      if (messageType === MESSAGE_AWARENESS) {
        if (hub !== undefined) ingestPlexusAwareness(hub, frame);
        room?.receive(socket, frame);
        return;
      }
      if (messageType !== MESSAGE_SYNC) return;
      const reply = inbound(frame, doc, socket);
      if (reply !== null) socket.send(reply);
    } catch {
      /* malformed peer frame */
    }
  });
  socket.onClose(() => {
    doc.off("update", onDocUpdate);
  });
  doc.on("update", onDocUpdate);
  // Say what this replica holds, as y-websocket's own server does. A client that kept
  // a cache compares it to this vector and drops what the replica no longer has.
  // Its STEP2 answer is dropped like any inbound document write.
  socket.send(encodeSyncStep1(doc));
  room?.join(socket);
}
