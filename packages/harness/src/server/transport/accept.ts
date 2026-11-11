import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { WebSocketServer } from "ws";

import { serveJsonRpc, type RpcApplication } from "./jsonrpc.js";
import { type PlaneSocket, wrapWebSocket } from "./plane.js";

/**
 * Socket accept and JSON-RPC delivery. `attach` is plane-sync, not dispatch.
 * Connection identity is minted here and kept on every delivered envelope.
 */
export function acceptJsonRpc(
  socket: Duplex,
  request: IncomingMessage,
  head: Buffer,
  wss: WebSocketServer,
  application: RpcApplication,
  attach?: (plane: PlaneSocket, connectionId: string) => ((text: string) => boolean) | void,
): void {
  if (socket.destroyed) return;
  wss.handleUpgrade(request, socket, head, (ws) => {
    const plane = wrapWebSocket(ws);
    const connectionId = randomUUID();
    const remote = request.headers["x-harness-remote"] === "1";
    const consumePlaneText = attach?.(plane, connectionId);
    plane.onClose(() => {
      application.onPlaneClose?.(connectionId);
    });
    plane.onText((text) => {
      if (text === " ping") {
        plane.sendText(" pong");
        return;
      }
      if (text === " pong") {
        return;
      }
      if (consumePlaneText?.(text) === true) {
        return;
      }
      void serveJsonRpc(plane, application, text, connectionId, remote);
    });
  });
}
