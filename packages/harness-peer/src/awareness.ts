/**
 * Plexus awareness on the plane socket.
 *
 * This module is the only MESSAGE_AWARENESS speaker. y-websocket still
 * constructs a stock Awareness — `detachProtocolAwareness` at the unix dial
 * mutes it. Passing `plexus.awareness` as `opts.awareness` is rejected:
 * y-websocket would encode/apply through y-protocols, not this hub.
 *
 * Local writes go on the wire. Frames applied with {@link REMOTE_AWARENESS_ORIGIN}
 * do not — ingesting a replica frame and forwarding it loops the plane, and the
 * TUI never sees actor.report() (live speech stays empty until settle).
 */
import { applyAwarenessUpdate, encodeAwarenessUpdate, type PlexusAwareness } from "@here.build/plexus";

import { decodeAwarenessPayload, encodeAwarenessFrame } from "./frames.js";

/** Origin stamp for inbound plane frames. Forward skips this origin. */
export const REMOTE_AWARENESS_ORIGIN = "remote";

export type AwarenessUpdate = {
  added: number[];
  updated: number[];
  removed: number[];
};

/** Send local Plexus awareness updates over the plane socket. */
export function forwardPlexusAwareness(hub: PlexusAwareness, send: (frame: Uint8Array) => void): () => void {
  const onUpdate = (changed: AwarenessUpdate, origin?: unknown): void => {
    if (origin === REMOTE_AWARENESS_ORIGIN) return;
    const clients = [...changed.added, ...changed.updated, ...changed.removed];
    if (clients.length === 0) return;
    try {
      send(encodeAwarenessFrame(encodeAwarenessUpdate(hub, clients)));
    } catch {
      /* hub not ready */
    }
  };
  hub.on("update", onUpdate);
  return () => hub.off("update", onUpdate);
}

/** Apply a peer awareness frame onto a Plexus hub. No-op if not an awareness frame. */
export function ingestPlexusAwareness(hub: PlexusAwareness, frame: Uint8Array): void {
  const payload = decodeAwarenessPayload(frame);
  if (payload === null) return;
  try {
    applyAwarenessUpdate(hub, payload, REMOTE_AWARENESS_ORIGIN);
  } catch {
    /* malformed peer frame */
  }
}

export type AwarenessPlane = {
  send(frame: Uint8Array): void;
  subscribe(handler: (frame: Uint8Array) => void): () => void;
};

/** Bidirectional plane: local writes out, inbound frames onto the hub. */
export function bindPlexusAwareness(hub: PlexusAwareness, plane: AwarenessPlane): () => void {
  const stopForward = forwardPlexusAwareness(hub, (frame) => plane.send(frame));
  const stopIngest = plane.subscribe((frame) => ingestPlexusAwareness(hub, frame));
  return () => {
    stopForward();
    stopIngest();
  };
}

/** Snapshot of this hub's own channels. Reconnect must re-enter occupancy without a new write. */
export function encodeLocalAwarenessFrame(hub: PlexusAwareness): Uint8Array | null {
  const clients = [...hub.getStates().keys()].filter((id) => hub.ownsKey(id));
  if (clients.length === 0) return null;
  try {
    return encodeAwarenessFrame(encodeAwarenessUpdate(hub, clients));
  } catch {
    return null;
  }
}
