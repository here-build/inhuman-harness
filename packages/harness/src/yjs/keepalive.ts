/**
 * Plane keepalive: WebSocket ping/pong (NAT / load-balancer idle) plus a
 * queryAwareness frame so stock clients refresh their 30s inbound-message
 * watchdog. Same bytes remote clients already speak.
 */
import { encodeQueryAwareness } from "@/protocol/document";

export const PLANE_PING_MS = 10_000;
const OPEN = 1;

export type Pingable = {
  readyState: number;
  ping(): void;
  send(data: Uint8Array, options?: { binary?: boolean }): void;
  on(event: "close", listener: () => void): unknown;
};

export function keepPlaneAlive(socket: Pingable, intervalMs = PLANE_PING_MS): void {
  const tick = (): void => {
    if (socket.readyState !== OPEN) return;
    try {
      socket.ping();
    } catch {
      // TOCTOU: socket can close between the OPEN check and ping.
    }
    if (socket.readyState !== OPEN) return;
    socket.send(encodeQueryAwareness(), { binary: true });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  socket.on("close", () => clearInterval(timer));
}
