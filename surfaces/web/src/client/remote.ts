import { bindTextFrames, type RoomConnection } from "@inhuman.tools/harness-peer";

import type { Link } from "./dial.js";

/** The edge answers this with `" pong"` without waking the machine's Durable Object. */
export const PING = " ping";
export const PING_MS = 10_000;

/**
 * Wraps the room connection's text-frame stream so relay keepalive frames are observed cleanly.
 */
export function bindRelayFrames(connection: RoomConnection): void {
  bindTextFrames(connection, () => undefined);
}

/** Pings the room's current socket every 10 s; returns the stop. */
export function startPing(connection: RoomConnection): () => void {
  const timer = setInterval(() => {
    const ws = connection.ws;
    if (ws?.readyState === 1) ws.send(PING);
  }, PING_MS);
  return () => clearInterval(timer);
}

/** Relay close codes that end the redial (`4400` not a room, `4404`/`4500` daemon refusals). */
export function isRefusal(code: number): boolean {
  return code === 4400 || code === 4404 || code === 4500;
}

/** What a relay close says about the line; `null` is a close that means nothing special. */
export function linkForClose(code: number, reason: string, redialing: boolean): Link | null {
  if (code === 4503) return { kind: "offline", redialing };
  if (code === 4504) return redialing ? { kind: "reconnecting" } : { kind: "unanswered" };
  if (isRefusal(code)) return { kind: "unavailable", reason };
  return null;
}
