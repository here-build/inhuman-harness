/**
 * Presence binding on a {@link RoomConnection}.
 * No `node:`, no `ws`.
 */
import type { ReactiveAwareness } from "@inhuman.tools/model";

import { bindAwareness, encodeLocalAwarenessFrame } from "./awareness.js";
import type { PlaneWireFrame } from "./frames.js";
import type { RoomConnection } from "./provider.js";

export function bindRoomAwareness(hub: ReactiveAwareness, connection: RoomConnection): () => void {
  if (hub === connection.awareness) {
    if (connection.wsconnected) {
      const localFrame = encodeLocalAwarenessFrame(hub);
      if (localFrame != null) {
        connection.sendText(localFrame);
      }
    }
    return () => undefined;
  }

  return bindAwareness(hub, {
    send(frame) {
      connection.sendText(frame);
    },
    subscribe(handler) {
      const onPresence = (frame: PlaneWireFrame): void => {
        handler(JSON.stringify(frame));
      };
      const onStatus = (event: { status: string }): void => {
        if (event.status === "connected") {
          const localFrame = encodeLocalAwarenessFrame(hub);
          if (localFrame != null) {
            connection.sendText(localFrame);
          }
        }
      };
      connection.on("presence", onPresence);
      connection.on("status", onStatus);
      return () => {
        connection.off("presence", onPresence);
        connection.off("status", onStatus);
      };
    },
  });
}
