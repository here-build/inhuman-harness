import { WebSocket } from "ws";

import { keepPlaneAlive } from "./keepalive.js";
import type { PlaneSocket } from "./relay.js";

export function wrapWebSocket(ws: WebSocket): PlaneSocket {
  let closed = false;
  keepPlaneAlive({
    get readyState() {
      return closed ? 3 : ws.readyState;
    },
    ping: () => {
      ws.ping();
    },
    send: (data, options) => {
      ws.send(data, { binary: options?.binary ?? true });
    },
    on: (event, listener) => {
      ws.on(event, listener);
    },
  });
  return {
    send: (frame) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(frame, { binary: true });
    },
    sendText: (text) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(text);
    },
    close: (code, reason) => {
      closed = true;
      ws.close(code, reason);
    },
    onBinary: (handler) =>
      ws.on("message", (data, isBinary) => {
        if (closed || !isBinary) return;
        handler(new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])));
      }),
    onText: (handler) =>
      ws.on("message", (data, isBinary) => {
        if (closed || isBinary) return;
        handler(data.toString());
      }),
    onClose: (handler) => ws.on("close", handler),
  };
}
