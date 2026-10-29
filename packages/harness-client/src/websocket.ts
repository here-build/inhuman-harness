import { HarnessClosedError } from "./errors.js";
import type { Transport } from "./transport.js";

/**
 * The slice of the WHATWG `WebSocket` the transport uses. Browsers, React
 * Native, Node's global `WebSocket` and the `ws` package all satisfy it.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { readonly reason?: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "open", listener: () => void): void;
}

const OPEN = 1;

/** Wrap an already open socket. Only string (text) frames are delivered; binary frames are ignored. */
export function webSocketTransport(socket: WebSocketLike): Transport {
  const messages = new Set<(text: string) => void>();
  const closes = new Set<(cause?: Error) => void>();
  let ended = false;
  const end = (cause?: Error): void => {
    if (ended) return;
    ended = true;
    for (const listener of closes) listener(cause);
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    for (const listener of messages) listener(event.data);
  });
  socket.addEventListener("close", (event) => {
    end(event.reason === undefined || event.reason === "" ? undefined : new Error(event.reason));
  });
  socket.addEventListener("error", () => {
    end(new Error("websocket error"));
  });
  return {
    send(text) {
      if (ended || socket.readyState !== OPEN) throw new HarnessClosedError("websocket is not open");
      socket.send(text);
    },
    onMessage(listener) {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onClose(listener) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      socket.close();
      end();
    },
  };
}

/** Resolve once an open socket is ready, reject if it fails to open. */
export function whenOpen(socket: WebSocketLike): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    if (socket.readyState === OPEN) {
      resolve(webSocketTransport(socket));
      return;
    }
    socket.addEventListener("open", () => resolve(webSocketTransport(socket)));
    socket.addEventListener("error", () => reject(new HarnessClosedError("websocket failed to open")));
    socket.addEventListener("close", () => reject(new HarnessClosedError("websocket closed before it opened")));
  });
}

/**
 * Connect with the platform `WebSocket` (browser, React Native, Node 22+).
 * `url` is the full upgrade URL, see `harnessUpgradeUrl`.
 */
export function connectWebSocket(url: string): Promise<Transport> {
  return whenOpen(new WebSocket(url) as unknown as WebSocketLike);
}
