/**
 * Public-plane sync and awareness. Every client plane is a lens; clients
 * change state through RPC. Room lifetime is independent of execution:
 * park() must not close a room another consumer still holds.
 */
import {
  DocumentContainer,
  encodeAwarenessUpdate,
  ReactiveAwareness as PlexusAwareness,
} from "@inhuman.tools/model";
import type { UpdateLaneHub } from "@inhuman.tools/scope-plane";

import {
  decodeShapeFrame,
  encodeAwarenessFrame,
  encodeDocUpdate,
  encodeQueryAwareness,
  encodeShapeFrame,
  encodeSyncStep1,
  forwardPlexusAwareness,
  ingestPlexusAwareness,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SHAPE,
  MESSAGE_SYNC,
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
  readonly #hub = new PlexusAwareness();

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
export function attachLens(
  doc: DocumentContainer<any, any>,
  socket: PlaneSocket,
  room?: AwarenessRoom,
  hub?: PlexusAwareness,
  laneHub?: UpdateLaneHub,
): void {
  attachSync(doc, socket, room, hub, laneHub, (frame, live) => replyLensSyncFrame(frame, live));
}

function attachSync(
  doc: DocumentContainer<any, any>,
  socket: PlaneSocket,
  room: AwarenessRoom | undefined,
  hub: PlexusAwareness | undefined,
  laneHub: UpdateLaneHub | undefined,
  inbound: (frame: Uint8Array, live: DocumentContainer<any, any>, origin: unknown) => Uint8Array | null,
): void {
  const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === socket) return;
    socket.send(encodeDocUpdate(update));
  };
  const socketUnsubs = new Map<string, () => void>();

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
      if (messageType === MESSAGE_SHAPE) {
        if (laneHub !== undefined) {
          const payload = decodeShapeFrame(frame);
          if (payload && typeof payload === "object") {
            const shapeObj = payload as { kind?: string; subscriptionId?: string };
            if (shapeObj.kind === "shape/subscribe" && typeof shapeObj.subscriptionId === "string") {
              socketUnsubs.get(shapeObj.subscriptionId)?.();
              const unsub = laneHub.subscribe(payload, (delta) => {
                socket.send(encodeShapeFrame(delta));
              });
              socketUnsubs.set(shapeObj.subscriptionId, unsub);
            } else if (shapeObj.kind === "shape/unsubscribe" && typeof shapeObj.subscriptionId === "string") {
              socketUnsubs.get(shapeObj.subscriptionId)?.();
              socketUnsubs.delete(shapeObj.subscriptionId);
              laneHub.unsubscribe(shapeObj.subscriptionId);
            }
          }
        }
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
    for (const unsub of socketUnsubs.values()) {
      unsub();
    }
    socketUnsubs.clear();
  });
  doc.on("update", onDocUpdate);
  socket.send(encodeSyncStep1(doc));
  room?.join(socket);
}
