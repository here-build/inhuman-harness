/**
 * JSON-RPC id routing on the shared daemon room socket.
 *
 * The daemon sees one socket per room, so two browsers may both send `id: 1`. The relay rewrites
 * each request id to `"<clientTag>:<original id as JSON>"` and undoes it on the way back. The daemon
 * only ever answers (it sends no requests on this channel); notifications carry no id and are
 * broadcast. `clientTag` is hex, so the first ":" always ends it.
 */

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;

const errorReply = (id: unknown, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

export const noDaemonReply = (id: unknown): string => errorReply(id, -32_000, "machine offline");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string | number | null => v === null || typeof v === "string" || typeof v === "number";

export type Outbound =
  /** Send to the daemon. `callId` is the caller's own id; absent for a notification. */
  | { kind: "forward"; text: string; callId?: string | number | null }
  /** Answer the browser here; the daemon never sees it. */
  | { kind: "reply"; text: string }
  | { kind: "drop" };

/** A browser text frame on its way to the daemon. */
export function rewriteRequest(text: string, clientTag: string): Outbound {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "reply", text: errorReply(null, PARSE_ERROR, "Parse error") };
  }
  if (!isObject(raw) || typeof raw.method !== "string" || raw.method === "") {
    // A response (no method) has nothing to answer: the daemon asks nothing on this channel.
    if (isObject(raw) && raw.method === undefined && ("result" in raw || "error" in raw)) return { kind: "drop" };
    return {
      kind: "reply",
      text: errorReply(isObject(raw) && isId(raw.id) ? raw.id : null, INVALID_REQUEST, "Invalid Request"),
    };
  }
  if (!("id" in raw) || raw.id === undefined) return { kind: "forward", text };
  if (!isId(raw.id)) return { kind: "reply", text: errorReply(null, INVALID_REQUEST, "Invalid Request") };
  const id = `${clientTag}:${JSON.stringify(raw.id)}`;
  return { kind: "forward", text: JSON.stringify({ ...raw, id }), callId: raw.id };
}

export type Inbound =
  /** Deliver to the browser that owns `clientTag`, with the id restored. */
  | { kind: "to"; clientTag: string; text: string }
  /** No owner: a notification (or anything id-less). Every browser in the room gets it. */
  | { kind: "broadcast"; text: string }
  | { kind: "drop" };

const TAGGED = /^([\da-f]+):(.*)$/s;

/** A daemon text frame on its way to browsers. */
export function restoreResponse(text: string): Inbound {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "drop" };
  }
  if (!isObject(raw)) return { kind: "drop" };
  // Server-initiated requests and notifications are not tied to a caller.
  if (typeof raw.method === "string" || !("id" in raw)) return { kind: "broadcast", text };
  const m = typeof raw.id === "string" ? TAGGED.exec(raw.id) : null;
  if (m === null) return { kind: "drop" };
  let original: unknown;
  try {
    original = JSON.parse(m[2]!);
  } catch {
    return { kind: "drop" };
  }
  return { kind: "to", clientTag: m[1]!, text: JSON.stringify({ ...raw, id: original }) };
}
