/**
 * What the client needs from a connection: JSON-RPC text frames in and out.
 * Binary frames (Yjs sync on the same socket) are not the client's business;
 * a transport must not deliver them to `onMessage`.
 */
export interface Transport {
  /** Send one JSON-RPC text frame. Throws if the connection is not open. */
  send(text: string): void;
  /** Subscribe to text frames. Returns the unsubscribe function. */
  onMessage(listener: (text: string) => void): () => void;
  /** Subscribe to the connection ending, with the cause when known. Returns the unsubscribe function. */
  onClose(listener: (cause?: Error) => void): () => void;
  /** Close the connection. Calls in flight reject with {@link HarnessClosedError}. */
  close(): void;
}

/** Which daemon an upgrade reaches. See `packages/harness-contract/spec/README.md` for routing and fall-through. */
export type HarnessTarget =
  | { readonly host: "kernel" }
  | { readonly host: "project"; readonly path: string }
  | { readonly host: "session"; readonly sessionId: string; readonly path?: string }
  | { readonly host: "session"; readonly path: string; readonly sessionId?: string };

/** The WebSocket upgrade path (with query) for a target, e.g. `/session?sessionId=s1`. */
export function harnessUpgradePath(target: HarnessTarget): string {
  if (target.host === "kernel") return "/kernel";
  const query = new URLSearchParams();
  if (target.path !== undefined) query.set("path", target.path);
  if (target.host === "session" && target.sessionId !== undefined) query.set("sessionId", target.sessionId);
  return `/${target.host}?${query.toString()}`;
}

/** Full upgrade URL on a base such as `ws://localhost:8080`, for bridges that expose the daemon over TCP. */
export function harnessUpgradeUrl(base: string, target: HarnessTarget): string {
  return `${base.replace(/\/+$/, "")}${harnessUpgradePath(target)}`;
}
