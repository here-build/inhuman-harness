import { IncomingMessage } from "node:http";

import { detachProtocolAwareness, destroyProvider, waitForSync } from "@inhuman.tools/harness-peer";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";

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
  /** Caps `waitForSync`. Unset + reconnect follows y-websocket (no cap). Unset + no reconnect is 8s. */
  readonly syncTimeoutMs?: number;
};

/** One y-websocket room over `ws+unix://`. Caller owns the doc.
 * Transient close reconnects (y-websocket default: 4400-4499 is permanent).
 * Spawning the daemon is the caller's `ensure`, not this dial. */
export async function openUnixRoom(
  socketPath: string,
  room: string,
  params: Record<string, string>,
  doc: Y.Doc,
  options?: OpenUnixRoomOptions,
): Promise<WebsocketProvider> {
  let httpStatus = 0;
  const reconnect = options?.reconnect !== false;
  let rejectNotFound: (error: Error) => void = () => undefined;
  const notFound = new Promise<never>((_resolve, reject) => {
    rejectNotFound = reject;
  });
  const provider = new WebsocketProvider(`ws+unix://${socketPath}:`, room, doc, {
    // @ts-expect-error Node `ws` is the unix dial; y-websocket types a DOM WebSocket
    WebSocketPolyfill: unixSocket((status) => {
      httpStatus = status;
      if (status === 404) rejectNotFound(new RoomNotFound(room, status));
    }),
    params,
    disableBc: true,
    shouldReconnect: reconnect ? undefined : () => false,
  });
  // disableBc skips broadcast-channel subscribe; disconnect() still runs
  // disconnectBc, which encodes awareness against an empty Map and throws
  // `Cannot read properties of undefined (reading 'clock')`.
  provider.disconnectBc = () => undefined;
  detachProtocolAwareness(provider);
  if (provider.synced) return provider;
  try {
    // A cold open replays a long append log once (then the image is compacted).
    // 8s expired while that replay still held the daemon, before the socket opened.
    const syncTimeoutMs = options?.syncTimeoutMs ?? (reconnect ? undefined : 60_000);
    await Promise.race([waitForSync(provider, room, syncTimeoutMs), notFound]);
  } catch (error) {
    destroyProvider(provider);
    if (httpStatus === 404 || error instanceof RoomNotFound) {
      throw error instanceof RoomNotFound ? error : new RoomNotFound(room, httpStatus);
    }
    throw error;
  }
  return provider;
}

export { detachProtocolAwareness } from "@inhuman.tools/harness-peer";
