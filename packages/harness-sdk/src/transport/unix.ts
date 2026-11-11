import { IncomingMessage } from "node:http";

import {
  destroyRoomConnection,
  detachLocalPresence,
  RoomConnection,
  waitForSync,
} from "@inhuman.tools/harness-peer";
import type { DocumentContainer } from "@inhuman.tools/model";
import { WebSocket } from "ws";

/** HTTP upgrade refused this room (sessionId-only unknown is 404). */
export class RoomNotFound extends Error {
  readonly status: number;
  constructor(room: string, status: number) {
    super(`${room}: not found`);
    this.name = "RoomNotFound";
    this.status = status;
  }
}

function unixSocket(onHttpStatus: (status: number) => void) {
  return function UnixWebSocket(url: string, protocols?: string | string[]) {
    const socket = new WebSocket(url, protocols);
    socket.on("unexpected-response", (_req: IncomingMessage, res: IncomingMessage) => {
      onHttpStatus(res.statusCode ?? 0);
      res.resume();
      socket.terminate();
    });
    return socket;
  };
}

export type OpenUnixRoomOptions = {
  /** Default true. Restore / probe must be false so a 404 does not retry. */
  readonly reconnect?: boolean;
  /** Caps `waitForSync`. Unset + reconnect has no cap; unset + no reconnect is 60s. */
  readonly syncTimeoutMs?: number;
};

/** One reactive room over `ws+unix://`. Caller owns the doc.
 * Spawning the daemon is the caller's `ensure`, not this dial. */
export async function openUnixRoom(
  socketPath: string,
  room: string,
  params: Record<string, string>,
  doc: DocumentContainer<any, any>,
  options?: OpenUnixRoomOptions,
): Promise<RoomConnection> {
  let httpStatus = 0;
  const reconnect = options?.reconnect !== false;
  let rejectNotFound: (error: Error) => void = () => undefined;
  const notFound = new Promise<never>((_resolve, reject) => {
    rejectNotFound = reject;
  });
  const connection = new RoomConnection(`ws+unix://${socketPath}:`, room, doc, {
    WebSocketPolyfill: unixSocket((status) => {
      httpStatus = status;
      if (status === 404) rejectNotFound(new RoomNotFound(room, status));
    }) as unknown as typeof globalThis.WebSocket,
    params,
    shouldReconnect: reconnect ? undefined : () => false,
  });
  detachLocalPresence(connection);
  if (connection.synced) return connection;
  try {
    const syncTimeoutMs = options?.syncTimeoutMs ?? (reconnect ? undefined : 60_000);
    await Promise.race([waitForSync(connection, room, syncTimeoutMs), notFound]);
  } catch (error) {
    destroyRoomConnection(connection);
    if (httpStatus === 404 || error instanceof RoomNotFound) {
      throw error instanceof RoomNotFound ? error : new RoomNotFound(room, httpStatus);
    }
    throw error;
  }
  return connection;
}

export { detachLocalPresence } from "@inhuman.tools/harness-peer";
