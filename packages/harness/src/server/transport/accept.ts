import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { WebSocketServer } from "ws";

import { type PlaneSocket, wrapWebSocket } from "@/yjs";

import { serveJsonRpc, type RpcApplication } from "./jsonrpc.js";

/**
 * Socket accept and JSON-RPC delivery. `attach` is document-sync, not dispatch.
 * Connection identity is minted here and kept on every delivered envelope.
 */
export function acceptJsonRpc(
  socket: Duplex,
  request: IncomingMessage,
  head: Buffer,
  wss: WebSocketServer,
  application: RpcApplication,
  attach?: (plane: PlaneSocket) => void,
): void {
  if (socket.destroyed) return;
  wss.handleUpgrade(request, socket, head, (ws) => {
    const plane = wrapWebSocket(ws);
    const connectionId = randomUUID();
    attach?.(plane);
    plane.onClose(() => {
      application.onPlaneClose?.(connectionId);
    });
    plane.onText((text) => {
      void serveJsonRpc(plane, application, text, connectionId);
    });
  });
}
