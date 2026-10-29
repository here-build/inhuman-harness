/**
 * Plexus awareness on a y-websocket provider. Binary frames only.
 * String payloads are JSON-RPC (`bindTextFrames`). No `node:`, no `ws`.
 */
import type { PlexusAwareness } from "@here.build/plexus";
import { WebsocketProvider } from "y-websocket";

import { bindPlexusAwareness, encodeLocalAwarenessFrame } from "./awareness.js";

export function awarenessBytes(data: unknown): Uint8Array | null {
  if (typeof data === "string") return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/** y-websocket plane: binary frames only. String payloads are JSON-RPC (bindTextFrames). */
export function bindProviderAwareness(hub: PlexusAwareness, provider: WebsocketProvider): () => void {
  return bindPlexusAwareness(hub, {
    send(frame) {
      const ws = provider.ws;
      if (ws != null && ws.readyState === ws.OPEN) ws.send(new Uint8Array(frame));
    },
    subscribe(handler) {
      let bound: unknown = null;
      const listen = (): void => {
        const ws = provider.ws;
        if (ws == null || ws === bound) return;
        bound = ws;
        ws.addEventListener("message", (event: { data: unknown }) => {
          const bytes = awarenessBytes(event.data);
          if (bytes !== null) handler(bytes);
        });
      };
      listen();
      const onStatus = (event: { status: string }): void => {
        if (event.status === "connected") {
          listen();
          republishLocalAwareness(hub, provider);
        }
      };
      provider.on("status", onStatus);
      return () => {
        provider.off("status", onStatus);
      };
    },
  });
}

/** Local occupancy (seat / attention) must re-enter after a plane reconnect. */
function republishLocalAwareness(hub: PlexusAwareness, provider: WebsocketProvider): void {
  const ws = provider.ws;
  if (ws == null || ws.readyState !== ws.OPEN) return;
  const frame = encodeLocalAwarenessFrame(hub);
  if (frame == null) return;
  ws.send(new Uint8Array(frame));
}
