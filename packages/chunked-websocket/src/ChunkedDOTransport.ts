/**
 * Per-DO chunking transport — a callback-shaped convenience over
 * `ChunkedWebSocket`'s server-wrap mode.
 *
 * Cloudflare's DO Hibernation API delivers WebSocket frames to a DO
 * via `webSocketMessage(ws, msg)` callbacks, not via EventTarget
 * subscriptions. This class hides the per-WebSocket bookkeeping (lazy
 * wrapper creation, `feed(...)` dispatch, `'message'` listener wiring)
 * behind a two-method surface — `onRawMessage` and `send` — so the DO
 * can stay focused on application logic.
 *
 * If you'd rather drive the wrappers directly (one `ChunkedWebSocket`
 * per raw socket, EventTarget API), skip this class and instantiate
 * `new ChunkedWebSocket(rawWs)` per accepted WebSocket. The transport
 * just maintains the `Map<rawWs, ChunkedWebSocket>` for you.
 *
 * Usage:
 *
 *     // In your DO class:
 *     private readonly transport = new ChunkedDOTransport(
 *       (ws, data) => this.processAppMessage(ws, data),
 *     );
 *
 *     async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
 *       this.transport.onRawMessage(ws, msg);
 *     }
 *
 *     async webSocketClose(ws: WebSocket) {
 *       this.transport.detach(ws);
 *     }
 *
 *     // To send (anywhere in the DO):
 *     this.transport.send(ws, anyArrayBuffer);
 */

import { ChunkedWebSocket, type RawWebSocketLike } from "./ChunkedWebSocket.js";

type AppMessageHandler<W = WebSocket> = (ws: W, data: ArrayBuffer | string) => void;

export class ChunkedDOTransport<W = WebSocket> {
  // `Map` rather than `WeakMap` because explicit `detach(ws)` is the
  // documented lifecycle hook (called from `webSocketClose`); we don't
  // want entries lingering until GC, and we want lookups to be cheap
  // even after a hibernation/wake cycle.
  private readonly wrappers = new Map<W, ChunkedWebSocket>();

  constructor(private readonly onAppMessage: AppMessageHandler<W>) {}

  /**
   * Pass every raw WebSocket frame through this. Returns nothing — the
   * `onAppMessage` callback (provided to the constructor) is invoked
   * once per fully-reassembled message.
   */
  onRawMessage(ws: W, msg: ArrayBufferLike | string): void {
    this.wrap(ws).feed(msg);
  }

  /**
   * Send an application message (binary or string) over `ws`. Messages
   * above `CHUNK_MAX_SIZE` bytes are split automatically; smaller ones pass
   * through `ws.send()` directly.
   */
  send(ws: W, data: ArrayBufferLike | string): void {
    this.wrap(ws).send(data);
  }

  /**
   * Drop chunking state for `ws`. Call from `webSocketClose` /
   * `webSocketError` so the per-WS wrapper closure can be GC'd.
   */
  detach(ws: W): void {
    this.wrappers.delete(ws);
  }

  private wrap(ws: W): ChunkedWebSocket {
    let wrapper = this.wrappers.get(ws);
    if (!wrapper) {
      wrapper = new ChunkedWebSocket(ws as RawWebSocketLike);
      // Bridge EventTarget → callback. Single shared callback target
      // for every reassembled message on this socket.
      wrapper.addEventListener("message", (e) => {
        // e is MessageEvent<ArrayBuffer | string> thanks to ChunkedWebSocketEventMap
        this.onAppMessage(ws, e.data);
      });
      this.wrappers.set(ws, wrapper);

      // We're newly aware of this socket. Could be a fresh accept (peer
      // has no in-flight state — reset is a no-op, harmless) OR a
      // post-hibernation wake where the DO's in-memory `wrappers` Map
      // got wiped while the peer might still be mid-batch.
      //
      // Dispatch a reset marker so the peer drops its own in-flight
      // batch state. We deliberately do NOT enter local DRAIN: in the
      // fresh-accept case the peer's first message is a complete
      // unchunked frame (e.g. yjs syncStep1) and DRAIN would silently
      // drop it. In the rare hibernation-mid-batch case orphan binary
      // chunks would arrive at IDLE and be passed to the app layer,
      // which will reject them as malformed (transient noise, not
      // corruption — the resync that follows the peer's reset settles
      // the conversation).
      wrapper.dispatchReset();
    }
    return wrapper;
  }
}
