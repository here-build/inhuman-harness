/**
 * Copied from here.build/inhuman/saas/reverse-tunnel/src/protocol.ts (the owner
 * relicenses it MIT). Changes: `tunnelId` dropped (the MachineDO is the tunnel),
 * `open` added for room dialing, chunk-size expectation documented.
 *
 * Direction is asymmetric: the relay mints ids and sends `req`/`cancel`/`open`;
 * the node only answers (`head`/`end`/`err` + body chunks).
 *
 * Framing splits by frame type:
 *   - text   = JSON envelopes (`req`/`cancel`/`open` down, `head`/`end`/`err` up)
 *   - binary = response body chunks (`[uint32 BE callId][...bytes]`)
 * The socket also speaks chunked framing, so a frame over 1 MiB is split
 * transparently; nodes should still send body chunks of 256 KiB or less.
 */

/** Request id, relay-minted, unique among in-flight calls. */
export type CallId = number;

/** Largest body chunk a node should send. */
export const NODE_CHUNK_BYTES = 256 * 1024;

// ---- relay -> node ----

/** Start one local fetch. `body` is base64, omitted when there is none. */
export interface ReqFrame {
  t: "req";
  id: CallId;
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

/** The caller went away: abort the fetch for this id. */
export interface CancelFrame {
  t: "cancel";
  id: CallId;
}

/** A browser wants this room and no daemon socket exists: dial it. `room` is the daemon's own upgrade path and query. */
export interface OpenFrame {
  t: "open";
  room: string;
}

export type ServerFrame = ReqFrame | CancelFrame | OpenFrame;

// ---- node -> relay ----

/** Status line and headers arrived; binary body chunks follow. */
export interface HeadFrame {
  t: "head";
  id: CallId;
  status: number;
  statusText: string;
  headers: [string, string][];
}

/** Body complete. */
export interface EndFrame {
  t: "end";
  id: CallId;
}

/** The fetch failed or was refused. No body follows. */
export interface ErrFrame {
  t: "err";
  id: CallId;
  message: string;
}

export type NodeFrame = HeadFrame | EndFrame | ErrFrame;

export const encodeServerFrame = (f: ServerFrame): string => JSON.stringify(f);
export const decodeServerFrame = (s: string): ServerFrame => JSON.parse(s) as ServerFrame;
export const encodeNodeFrame = (f: NodeFrame): string => JSON.stringify(f);
export const decodeNodeFrame = (s: string): NodeFrame => JSON.parse(s) as NodeFrame;

// ---- body chunks (binary): [uint32 BE callId][...body bytes] ----

export function encodeChunk(id: CallId, bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out.buffer;
}

export function decodeChunk(buf: ArrayBuffer): { id: CallId; bytes: Uint8Array } {
  const view = new DataView(buf);
  return { id: view.getUint32(0), bytes: new Uint8Array(buf.slice(4)) };
}

/**
 * Keepalive pair registered as a hibernation auto-response: the edge answers
 * PING with PONG without waking the DO. Leading space keeps them out of the JSON envelope space.
 */
export const PING = " ping";
export const PONG = " pong";
