/**
 * Wire-format primitives for transparent WebSocket message chunking.
 *
 * Application protocols (Yjs binary, JSON-RPC text, anything else) emit
 * normal binary or text messages; this layer transparently splits anything above
 * `CHUNK_MAX_SIZE` into multiple frames and reassembles on the far side.
 * The protocol does not inspect message content — purely a transport
 * concern.
 *
 * Adapted from `partykit/y-partykit/src/chunking.ts` (MIT, © 2023
 * PartyKit, Inc. — see THIRD-PARTY-NOTICES.md).
 * Behaviour preserved verbatim; protocol (sentinel string + JSON markers)
 * is compatible with partykit's for binary messages. The `kind` field in
 * batch markers is an addition; a marker without it means binary.
 *
 * Wire format:
 *   - Messages ≤ `CHUNK_MAX_SIZE` are sent unchunked (passthrough).
 *   - Larger messages are framed as:
 *       1. text frame: `y-pk-batch#{"id","type":"start","size","count","kind"}`
 *       2. N binary frames, each ≤ CHUNK_MAX_SIZE
 *       3. text frame: `y-pk-batch#{"id","type":"end","size","count","kind"}`
 *   - Receivers buffer between start/end markers and pass the reassembled
 *     message to the original receive handler. Mismatched id/size/count
 *     throws.
 *   - `kind` is "binary" (the reassembled buffer is delivered as is) or
 *     "text" (the chunks are UTF-8 bytes of a string; `size` counts
 *     bytes and the result is decoded back to a string). Absent means
 *     "binary".
 *
 * Text frames that are neither a batch marker nor the reset marker are
 * application messages and are delivered as strings.
 */

function invariant(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// Workerd's per-WebSocket-frame size limit is ~1 MiB. PartyKit uses
// 1_000_000 bytes; we match for protocol compatibility. Picking lower
// reduces per-large-message overhead trivially; picking higher will
// crash workerd with a 1009 protocol error.
export const CHUNK_MAX_SIZE = 1_000_000;

const BATCH_SENTINEL = "y-pk-batch";

/**
 * Reset marker — text frame the server dispatches when it observes a
 * WebSocket it has no in-memory state for (fresh accept OR post-
 * hibernation wake). Tells the receiver to discard any in-flight batch
 * state and enter DRAIN mode: silently drop binary frames until the
 * next start marker arrives.
 *
 * Asymmetric in practice: server → client. Browser-side state is tied
 * to the WebSocket lifecycle (close = wrapper GC'd) so clients don't
 * need to notify the server. Mechanism is symmetric though — either
 * side could send it.
 */
export const RESET_SENTINEL = "y-pk-reset";

export type BatchKind = "text" | "binary";

interface BatchMarker {
  id: string;
  type: "start" | "end";
  size: number;
  count: number;
  /** Absent means "binary" (markers from older senders). */
  kind?: BatchKind;
}

/**
 * Minimal `WebSocket.send` shape. Both workerd's and the browser's
 * `WebSocket` are assignable to this. Typed loosely so callers don't
 * need to cast — the receiver only ever passes `Uint8Array` (binary
 * frame, payload) or `string` (sentinel marker), both of which every
 * WebSocket implementation accepts.
 */
export interface SendCapableSocket {
  send(data: any): void;
}

/** Minimal incoming-message shape — `{ data }`, where data is binary or string. */
export type ChunkedMessageData = ArrayBufferLike | string;
export interface ChunkedMessageEvent {
  data: ChunkedMessageData;
}

let warnedAboutLargeMessage = false;

/**
 * Sends a binary or text message, splitting into chunks if it exceeds
 * `CHUNK_MAX_SIZE` bytes (UTF-8 for text). Small messages pass through
 * untouched; short strings go out as plain text frames.
 */
export function sendChunked(data: ArrayBufferLike | string, ws: SendCapableSocket): void {
  let kind: BatchKind = "binary";
  if (typeof data === "string") {
    // UTF-8 takes at most 3 bytes per UTF-16 code unit.
    if (data.length * 3 <= CHUNK_MAX_SIZE) {
      ws.send(data);
      return;
    }
    const bytes = new TextEncoder().encode(data);
    if (bytes.byteLength <= CHUNK_MAX_SIZE) {
      ws.send(data);
      return;
    }
    kind = "text";
    data = bytes.buffer;
  }

  if (data.byteLength <= CHUNK_MAX_SIZE) {
    // Wrap in Uint8Array so SharedArrayBuffer-shaped inputs match
    // `ArrayBufferView` (workerd's WebSocket.send rejects bare
    // SharedArrayBuffer but accepts views over it).
    ws.send(new Uint8Array(data));
    return;
  }

  if (!warnedAboutLargeMessage) {
    console.warn(
      "[chunked-websocket]",
      `Message size exceeds ${CHUNK_MAX_SIZE / 1_000_000} MB — splitting into chunks.`,
      `Message size: ${(data.byteLength / 1000 / 1000).toFixed(1)} MB`,
    );
    warnedAboutLargeMessage = true;
  }

  const id = (Date.now() + Math.random()).toString(36).slice(10);
  const chunks = Math.ceil(data.byteLength / CHUNK_MAX_SIZE);

  ws.send(serializeBatchMarker({ id, type: "start", size: data.byteLength, count: chunks, kind }));

  let sentSize = 0;
  let sentChunks = 0;
  // `data` is ArrayBufferLike; we slice via Uint8Array to handle both
  // ArrayBuffer and SharedArrayBuffer-shaped inputs uniformly.
  const view = new Uint8Array(data);
  for (let i = 0; i < chunks; i++) {
    const start = CHUNK_MAX_SIZE * i;
    const end = Math.min(CHUNK_MAX_SIZE * (i + 1), data.byteLength);
    const chunk = view.slice(start, end);
    ws.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    sentChunks += 1;
    sentSize += chunk.byteLength;
  }

  ws.send(serializeBatchMarker({ id, type: "end", size: sentSize, count: sentChunks, kind }));
}

/**
 * Handler returned by `handleChunked` — callable for each inbound frame,
 * with a `reset()` method that drops in-flight batch state and enters
 * DRAIN mode (silently discards binary frames until the next start
 * marker arrives).
 */
export type ChunkedReceiveHandler = ((event: ChunkedMessageEvent) => void) & {
  reset(): void;
};

/**
 * Wraps a receive callback to handle chunked messages.
 *
 * Returns a stateful handler — keep one per WebSocket. Internal FSM has
 * three states:
 *
 *   - **IDLE**: incoming binary frames are passed through directly as
 *     complete unchunked application messages. A `start` text marker
 *     transitions to BATCH; a `reset` text marker transitions to DRAIN.
 *   - **BATCH**: accumulating chunks from a multi-frame message. An
 *     `end` text marker validates and emits the reassembled buffer,
 *     then transitions back to IDLE. A `reset` clears the partial
 *     batch and transitions to DRAIN.
 *   - **DRAIN**: discards binary frames silently. Used to drop chunks
 *     in flight from a peer that lost its in-memory state mid-batch.
 *     A `start` marker transitions to BATCH (clean recovery); an
 *     orphan `end` marker transitions to IDLE.
 *
 * The DRAIN state is the protocol's recovery mechanism for hibernation
 * / eviction races — see `RESET_SENTINEL` and `ChunkedDOTransport.wrap`.
 */
export function handleChunked(receive: (data: ChunkedMessageData) => void): ChunkedReceiveHandler {
  let batch: ArrayBuffer[] | undefined;
  let start: BatchMarker | undefined;
  let draining = false;

  const reset = () => {
    // Only enter DRAIN if there's an in-flight batch we need to ride
    // out — orphan binary chunks would arrive until the peer's `end`
    // marker. With no batch in progress, RESET is a no-op: the next
    // binary frame is a fresh complete message, not a stray chunk.
    const hadBatch = batch !== undefined;
    batch = undefined;
    start = undefined;
    if (hadBatch) draining = true;
  };

  const handler = (message: ChunkedMessageEvent) => {
    const { data } = message;

    if (typeof data === "string") {
      if (data === RESET_SENTINEL) {
        reset();
        return;
      }
      if (!isBatchSentinel(data)) {
        receive(data); // plain text application message.
        return;
      }

      const marker = parseBatchMarker(data);
      if (marker.type === "start") {
        batch = [];
        start = marker;
        draining = false; // fresh start always exits DRAIN.
        return;
      }

      // marker.type === "end"
      if (draining) {
        // End of an in-flight batch we discarded. Done draining.
        draining = false;
        return;
      }
      if (!batch || !start) return; // orphan end — ignore.

      try {
        assertEquality(start.id, marker.id, "batch id");
        assertEquality(start.count, marker.count, "batch counts");
        assertEquality(start.size, marker.size, "batch size");

        const totalSize = batch.reduce((sum, buf) => sum + buf.byteLength, 0);
        const bytes = new Uint8Array(totalSize);
        let written = 0;
        for (const chunk of batch) {
          bytes.set(new Uint8Array(chunk), written);
          written += chunk.byteLength;
        }

        assertEquality(marker.count, batch.length, "received chunk count");
        assertEquality(marker.size, written, "received chunk size");

        receive(start.kind === "text" ? new TextDecoder().decode(bytes) : bytes.buffer);
      } finally {
        batch = undefined;
        start = undefined;
      }
      return;
    }

    // Binary frame.
    if (draining) return; // discard — the batch this belongs to is stale.
    if (batch) {
      batch.push(toArrayBuffer(data));
      return;
    }
    // Passthrough — unchunked message.
    receive(data);
  };

  (handler as any).reset = reset;
  return handler as ChunkedReceiveHandler;
}

function toArrayBuffer(data: ChunkedMessageData): ArrayBuffer {
  if (typeof data === "string") {
    // Shouldn't happen mid-batch (sentinels are detected first), but
    // defensively encode just in case.
    return new TextEncoder().encode(data).buffer;
  }
  // Workerd / browsers deliver binary frames as ArrayBuffer; this also
  // covers SharedArrayBuffer-shaped inputs.
  if (data instanceof ArrayBuffer) return data;
  // SharedArrayBuffer or other ArrayBufferLike — copy into a fresh
  // ArrayBuffer so downstream `new Uint8Array(buf)` works uniformly.
  const view = new Uint8Array(data);
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

function assertEquality(expected: unknown, actual: unknown, label: string): void {
  invariant(
    expected === actual,
    `chunked-websocket: mismatching ${label} — expected ${String(expected)}, got ${String(actual)}`,
  );
}

function isBatchSentinel(msg: ChunkedMessageData): msg is string {
  return typeof msg === "string" && msg.startsWith(BATCH_SENTINEL);
}

function serializeBatchMarker(batch: BatchMarker): string {
  return `${BATCH_SENTINEL}#${JSON.stringify(batch)}`;
}

export function parseBatchMarker(msg: string): BatchMarker {
  const hashIdx = msg.indexOf("#");
  invariant(
    hashIdx !== -1 && msg.slice(0, hashIdx) === BATCH_SENTINEL,
    `chunked-websocket: unexpected batch marker — ${msg}`,
  );
  const batch = JSON.parse(msg.slice(hashIdx + 1)) as BatchMarker;
  invariant(batch.type === "start" || batch.type === "end", `chunked-websocket: unexpected batch type — ${msg}`);
  return batch;
}
