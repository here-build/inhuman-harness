/**
 * Ephemeral presence on the plane socket.
 *
 * Local writes go on the wire as structured JSON `presence/update` frames.
 * Frames applied with {@link REMOTE_AWARENESS_ORIGIN} do not echo back onto
 * the wire.
 */
import { ReactiveAwareness, type PresenceEntry } from "@inhuman.tools/model";

import { decodePlaneFrame, encodePresenceUpdate, type PlaneWireFrame } from "./frames.js";

/** Origin stamp for inbound plane frames. Forward skips this origin. */
export const REMOTE_AWARENESS_ORIGIN = "remote";

export type AwarenessUpdate = {
  added: number[];
  updated: number[];
  removed: number[];
};

/** Send local awareness updates over the plane socket as JSON text frames. */
export function forwardAwareness(hub: ReactiveAwareness, send: (frame: string) => void): () => void {
  const onUpdate = (changed: AwarenessUpdate, origin?: unknown): void => {
    if (origin === REMOTE_AWARENESS_ORIGIN) return;
    const clients = [...changed.added, ...changed.updated, ...changed.removed];
    if (clients.length === 0) return;
    const entries = hub.toPresenceEntries(clients);
    if (entries.length === 0) return;
    try {
      send(encodePresenceUpdate(entries));
    } catch {
      /* hub not ready */
    }
  };
  hub.on("update", onUpdate);
  return () => hub.off("update", onUpdate);
}

/** Apply a peer presence JSON frame (or parsed frame) onto an awareness hub. No-op if not a presence frame. */
export function ingestAwareness(hub: ReactiveAwareness, frame: string | PlaneWireFrame): void {
  const parsed = typeof frame === "string" ? decodePlaneFrame(frame) : frame;
  if (parsed === null) return;
  if (parsed.kind !== "presence/update" && parsed.kind !== "presence/state") return;
  try {
    hub.applyPresenceEntries(parsed.entries as readonly PresenceEntry[], REMOTE_AWARENESS_ORIGIN);
  } catch {
    /* malformed peer frame */
  }
}

export type AwarenessPlane = {
  send(frame: string): void;
  subscribe(handler: (frame: string) => void): () => void;
};

/** Bidirectional plane: local writes out, inbound frames onto the hub. */
export function bindAwareness(hub: ReactiveAwareness, plane: AwarenessPlane): () => void {
  const stopForward = forwardAwareness(hub, (frame) => plane.send(frame));
  const stopIngest = plane.subscribe((frame) => ingestAwareness(hub, frame));
  return () => {
    stopForward();
    stopIngest();
  };
}

/** Snapshot of this hub's own channels. Reconnect must re-enter occupancy without a new write. */
export function encodeLocalAwarenessFrame(hub: ReactiveAwareness): string | null {
  const clients = [...hub.getStates().keys()].filter((id) => hub.ownsKey(id));
  if (clients.length === 0) return null;
  const entries = hub.toPresenceEntries(clients);
  if (entries.length === 0) return null;
  return encodePresenceUpdate(entries);
}

export { ReactiveAwareness } from "@inhuman.tools/model";
