import { WebSocket } from "ws";

import { harnessUpgradePath, type HarnessTarget, type Transport } from "./transport.js";
import { whenOpen, type WebSocketLike } from "./websocket.js";

export interface UnixSocketOptions {
  /** Absolute path of the daemon socket, `<root>/daemon.sock`. */
  readonly socketPath: string;
  readonly target: HarnessTarget;
}

/**
 * Connect to the daemon's unix socket from Node, using the `ws` package
 * (an optional peer dependency, loaded only from this entry point).
 */
export function connectUnixSocket(options: UnixSocketOptions): Promise<Transport> {
  const socket = new WebSocket(`ws+unix://${options.socketPath}:${harnessUpgradePath(options.target)}`);
  return whenOpen(socket as unknown as WebSocketLike);
}
